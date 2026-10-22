import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { motionVideoViews, type MotionVideoManifest } from "../shared/motion-video";
import type { WorkbenchRequest, WorkbenchResult } from "../shared/workbench";
import type { MotionVideoLedger } from "./motion-video-ledger";

const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function ffmpeg(binary: string, args: string[], signal: AbortSignal) {
  if (signal.aborted) throw Error("영상 처리가 취소되었습니다.");
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ["-hide_banner", "-nostdin", ...args], { windowsHide: true, signal });
    let text = "";
    child.stderr.on("data", data => { text = (text + data).slice(-64000); });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(Error(`원본 영상 해독 실패: ${text.slice(-1600)}`)); });
  });
}

/** Deterministic original-resolution decoding. No generative model, resizing or invented poses. */
export async function prepareMotionVideoFrames(binary: string, workspace: string, request: WorkbenchRequest,
  entries: ReturnType<MotionVideoLedger["read"]>["entries"], signal: AbortSignal) {
  if (!fs.existsSync(binary)) throw Error("원본 영상 프레임 추출 도구가 없습니다.");
  const folder = "outputs/video-reference";
  fs.mkdirSync(path.join(workspace, folder), { recursive: true });
  const count = request.referenceFrameCount!, duration = request.duration!;
  const times = request.referenceTimes ?? Array.from({ length: count }, (_, index) => duration * index / (count - 1));
  const views = motionVideoViews(request.motionVideo?.mode);
  const manifest: MotionVideoManifest = { schemaVersion: 1, source: "video-ai", motion: request.motion!, duration, fps: request.fps!, camera: "fixed", mode: request.motionVideo?.mode, loop: request.loop, videos: {} as MotionVideoManifest["videos"], frames: times.map(time => ({ time })) };
  const artifacts: WorkbenchResult["candidates"][number]["artifacts"] = [];
  const metadata: Record<string, unknown> = {};
  for (const view of views) {
    const entry = entries.find(e => e.phase === view && e.state === "completed");
    if (!entry?.download || !entry.resultId) throw Error("요청한 방향의 완료된 원본이 필요합니다.");
    const source = path.resolve(workspace, entry.download.path);
    if (!source.startsWith(path.resolve(workspace) + path.sep) || !fs.realpathSync(source).startsWith(fs.realpathSync(workspace) + path.sep) ||
        hash(source) !== entry.download.sha256) throw Error("영상 원본 경로·해시가 일치하지 않습니다.");
    // Decode the complete review window, confirming a real video stream and duration.
    const probe = await ffmpeg(binary, ["-i", source, "-map", "0:v:0", "-t", String(duration + 0.1), "-an", "-f", "null", "-"], signal);
    const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe);
    const nativeDuration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
    if (!Number.isFinite(nativeDuration) || nativeDuration + 0.05 < duration) throw Error(`${view} 원본이 요청한 동작 길이보다 짧습니다.`);
    manifest.videos[view] = { path: entry.download.path, startTime: 0 };
    artifacts.push({ path: entry.download.path, kind: "video", role: view });
    let width = 0, height = 0;
    for (let index = 0; index < times.length; index++) {
      const relative = `${folder}/${view}-${index}.png`, file = path.join(workspace, relative);
      // Container endpoint has no frame; decode at most one source-frame earlier at its end.
      const sourceFps = Number(/,\s*([\d.]+) fps/.exec(probe)?.[1] ?? 30);
      const decodedTime = Math.min(times[index], Math.max(0, nativeDuration - 1 / sourceFps));
      await ffmpeg(binary, ["-y", "-i", source, "-ss", String(decodedTime), "-map", "0:v:0", "-frames:v", "1", "-an", file], signal);
      if (!fs.existsSync(file)) throw Error(`${view} ${times[index]}초 원본 프레임이 없습니다.`);
      const png = fs.readFileSync(file);
      if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") throw Error("원본 프레임 해독 실패");
      width = png.readUInt32BE(16); height = png.readUInt32BE(20);
      manifest.frames[index][view] = relative;
      artifacts.push({ path: relative, kind: "image", role: `reference-${view}` });
      metadata[`${view}:${times[index]}`] = { sourceSha256: entry.download.sha256, decodedTime, width, height, sha256: hash(file) };
    }
    metadata[view] = { resultId: entry.resultId, url: entry.resultUrl, nativeDuration, width, height, reviewedStart: 0, reviewedDuration: duration };
  }
  if (new Set(entries.map(e => e.download?.sha256)).size !== views.length) throw Error("요청한 방향의 서로 다른 원본 영상이 필요합니다.");
  const manifestPath = `${folder}/frames.json`, reportPath = `${folder}/decode-report.json`;
  fs.writeFileSync(path.join(workspace, manifestPath), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(workspace, reportPath), JSON.stringify({ source: "native-video-decode", metadata }, null, 2));
  artifacts.push({ path: manifestPath, kind: "frames" }, { path: reportPath, kind: "report" });
  return { artifacts, manifestPath, framePaths: manifest.frames, summary: "실제 원본에서 프레임을 추출했습니다. 동작·시점 일치 여부는 아직 시각 검토가 필요합니다." };
}
