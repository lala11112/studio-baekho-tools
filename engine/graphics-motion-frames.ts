import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { GraphicsFile } from "../shared/graphics";

type Rational = { numerator: number; denominator: number };
export type GraphicsMotionFrame = GraphicsFile & {
  index: number; pts: number; time: number; relativeTime: number; duration: number | null;
  width: number; height: number;
};
export type GraphicsMotionFramesResult = {
  source: GraphicsFile; manifest: GraphicsFile; frames: GraphicsMotionFrame[];
  timeBase: Rational; nativeFrameRate: Rational | null; durationSeconds: number; framePaths: string[];
};
export type GraphicsMotionFramesArgs = {
  projectRoot: string; source: GraphicsFile; outputDirectory: string; resources?: string;
  ffmpegPath?: string; signal: AbortSignal; maxFrames?: number; maxDurationSeconds?: number;
  onProgress?: (message: string) => void;
};
const active = new Set<string>();
const MAX_BYTES = 2 * 1024 ** 3;
const slash = (value: string) => value.split(path.sep).join("/");
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
async function hashFile(file: string, signal: AbortSignal) {
  const digest = createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) { signal.throwIfAborted(); digest.update(bytes); }
  return digest.digest("hex");
}
function directory(root: string, folder: string) {
  if (!inside(root, folder)) throw Error("동작 프레임 폴더가 프로젝트 밖입니다.");
  let ancestor = folder;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (ancestor !== root && !inside(root, fs.realpathSync(ancestor))) throw Error("동작 프레임 폴더 연결이 프로젝트 밖입니다.");
  fs.mkdirSync(folder, { recursive: true });
  if (!inside(root, fs.realpathSync(folder))) throw Error("동작 프레임 폴더가 프로젝트 밖입니다.");
}
async function verified(root: string, file: GraphicsFile, signal: AbortSignal, scope = root) {
  if (!file || typeof file.path !== "string" || !/^[a-f\d]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw Error("동작 프레임 파일 명세가 잘못됐습니다.");
  const absolute = path.resolve(root, file.path);
  if (!inside(scope, absolute) || !fs.existsSync(absolute) || !inside(scope, fs.realpathSync(absolute)) || !fs.statSync(absolute).isFile() ||
      fs.statSync(absolute).size !== file.bytes || await hashFile(absolute, signal) !== file.sha256) throw Error("동작 영상·프레임의 경로·크기·해시가 변경됐습니다. 기존 파일은 보존합니다.");
  return absolute;
}
function immutable(file: string, value: unknown) {
  const fd = fs.openSync(file, "wx");
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function resolveFfmpeg(args: GraphicsMotionFramesArgs) {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = args.ffmpegPath ? [args.ffmpegPath] : [
    ...(args.resources ? [path.resolve(args.resources, "../media", name), path.resolve(args.resources, "../node_modules/ffmpeg-static", name)] : []),
    path.resolve("node_modules/ffmpeg-static", name),
  ];
  const binary = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!binary) throw Error("원본 동작의 모든 프레임을 해독할 로컬 ffmpeg가 없습니다.");
  return binary;
}
type Decoded = { index: number; pts: number; durationTicks: number | null; width: number; height: number };
type DecodeResult = { frames: Decoded[]; timeBase: Rational; nativeFrameRate: Rational | null };
function decode(binary: string, source: string, output: string, signal: AbortSignal, maxFrames: number, maxSeconds: number): Promise<DecodeResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // No -r, fps filter, scale, trimming or duplicate/drop sync. showinfo records
    // each decoder PTS before PNG encoding; copyts preserves nonzero start times.
    const child = spawn(binary, ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-n", "-xerror",
      "-copyts", "-noautorotate", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", source,
      "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "showinfo", "-fps_mode", "passthrough", "-c:v", "png", "-threads", "1",
      "-frames:v", String(maxFrames + 1), "-start_number", "0", path.join(output, "frame-%06d.png")],
      { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    const frames: Decoded[] = [];
    let pending = "", tail = "", timeBase: Rational | undefined, nativeFrameRate: Rational | null = null, failure: Error | undefined, settled = false;
    const stop = (error: Error) => { if (!failure) failure = error; if (child.exitCode === null) child.kill(); };
    const abort = () => stop(Error("원본 동작 프레임 해독을 중지했습니다. 부분 파일은 보존하며 재사용하지 않습니다."));
    const timer = setTimeout(() => stop(Error("원본 동작 프레임 해독이 120초를 초과했습니다. 부분 파일은 완료 결과가 아닙니다.")), 120_000);
    const diskTimer = setInterval(() => {
      try {
        const bytes = fs.readdirSync(output).reduce((sum, name) => sum + fs.statSync(path.join(output, name)).size, 0);
        if (bytes > MAX_BYTES) stop(Error("원본 전체 PNG가 로컬 분석 한도 2 GiB를 넘습니다. 축소하거나 일부만 사용하지 않습니다."));
      } catch (error) { stop(error instanceof Error ? error : Error(String(error))); }
    }, 250);
    signal.addEventListener("abort", abort, { once: true });
    const line = (value: string) => {
      if (failure) return;
      if (/attached pic/.test(value)) { stop(Error("동작 영상 대신 표지 이미지 스트림입니다.")); return; }
      const config = /config in time_base:\s*(\d+)\/(\d+), frame_rate:\s*(\d+)\/(\d+)/.exec(value);
      if (config) {
        const next = { numerator: Number(config[1]), denominator: Number(config[2]) };
        if (!next.numerator || !next.denominator || timeBase && JSON.stringify(timeBase) !== JSON.stringify(next)) { stop(Error("원본 영상의 시간 기준이 없거나 중간에 바뀝니다.")); return; }
        timeBase = next;
        nativeFrameRate = Number(config[3]) > 0 && Number(config[4]) > 0 ? { numerator: Number(config[3]), denominator: Number(config[4]) } : null;
      }
      const frame = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:[^\s]+(?:\s+duration:\s*(-?\d+)\s+duration_time:[^\s]+)?\s+fmt:.*?\bs:(\d+)x(\d+)\b/.exec(value);
      if (!frame) return;
      const item: Decoded = { index: Number(frame[1]), pts: Number(frame[2]), durationTicks: frame[3] === undefined || Number(frame[3]) === 0 ? null : Number(frame[3]), width: Number(frame[4]), height: Number(frame[5]) };
      if (!timeBase || item.index !== frames.length || !Number.isSafeInteger(item.pts) || item.width < 1 || item.height < 1 || item.width * item.height > 64_000_000 || item.durationTicks !== null && (!Number.isSafeInteger(item.durationTicks) || item.durationTicks < 0)) {
        stop(Error("원본 프레임 순서·PTS·해상도가 유효하지 않습니다. 최대 6400만 화소를 지원합니다.")); return;
      }
      if (frames.length && (item.pts <= frames.at(-1)!.pts || item.width !== frames[0].width || item.height !== frames[0].height)) { stop(Error("원본 프레임 PTS가 증가하지 않거나 영상 해상도가 중간에 바뀝니다.")); return; }
      frames.push(item);
      const span = (item.pts - frames[0].pts + (item.durationTicks ?? 0)) * timeBase.numerator / timeBase.denominator;
      if (frames.length > maxFrames || span > maxSeconds + 1e-7) stop(Error(`원본 전체 동작이 로컬 분석 한도 ${maxFrames}프레임·${maxSeconds}초를 넘습니다. 일부 프레임만 사용하거나 축소하지 않습니다.`));
    };
    child.stderr.on("data", bytes => {
      const text = bytes.toString(); tail = (tail + text).slice(-6000); pending += text;
      const lines = pending.split(/[\r\n]/); pending = lines.pop() ?? "";
      for (const value of lines) line(value);
      if (pending.length > 64_000) stop(Error("영상 해독 진단이 허용된 크기를 넘습니다."));
    });
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); clearInterval(diskTimer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else if (!timeBase || frames.length < 2) reject(Error("실제 PTS가 있는 동작 프레임 두 개 이상을 확인하지 못했습니다."));
      else resolve({ frames, timeBase, nativeFrameRate });
    };
    child.on("error", error => finish(failure ?? error));
    child.on("close", code => { line(pending); finish(failure ?? (code === 0 ? undefined : Error("원본 동작 전체 해독 실패: " + tail.slice(-1800)))); });
    if (signal.aborted) abort();
  });
}
function pngDimensions(file: string) {
  const header = Buffer.alloc(33), fd = fs.openSync(file, "r");
  try { if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || header.toString("ascii", 12, 16) !== "IHDR") throw Error("해독한 원본 프레임이 PNG가 아닙니다."); }
  finally { fs.closeSync(fd); }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** Decode every native frame into lossless, unscaled PNGs. No inference/service call. */
export async function prepareGraphicsMotionFrames(args: GraphicsMotionFramesArgs): Promise<GraphicsMotionFramesResult> {
  args.signal.throwIfAborted();
  const maxFrames = args.maxFrames ?? 240, maxSeconds = args.maxDurationSeconds ?? 120;
  if (!Number.isInteger(maxFrames) || maxFrames < 2 || maxFrames > 14400 || !Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 120) throw Error("원본 프레임 분석 한도는 2–14400프레임, 0초 초과 120초 이하입니다.");
  if (!/\.(mp4|mov|webm)$/i.test(args.source.path) || args.source.kind !== "video" || args.source.bytes > MAX_BYTES) throw Error("원본 동작은 2 GiB 이하 MP4·MOV·WebM 영상이어야 합니다.");
  const root = fs.realpathSync(args.projectRoot), source = await verified(root, args.source, args.signal);
  const folder = path.resolve(root, args.outputDirectory), key = folder.toLowerCase();
  if (active.has(key)) throw Error("같은 원본 동작 프레임 검사가 이미 실행 중입니다.");
  active.add(key);
  try {
    directory(root, folder);
    const identity = createHash("sha256").update(JSON.stringify({ schemaVersion: 1, source: args.source, maxFrames, maxSeconds, decode: "all-native-pts-png-noautorotate-v1" })).digest("hex");
    const checkpoint = path.join(folder, "checkpoint.json");
    if (fs.existsSync(checkpoint)) {
      if (!inside(folder, fs.realpathSync(checkpoint))) throw Error("저장된 프레임 검사 경로가 작업 폴더 밖입니다.");
      const cached = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
      if (cached.identity !== identity || !cached.result || !Array.isArray(cached.result.frames) || cached.result.frames.length < 2 || cached.result.frames.length > maxFrames) throw Error("저장된 전체 프레임 검사 요청이 다릅니다.");
      const result = cached.result as GraphicsMotionFramesResult;
      const manifestPath = await verified(root, result.manifest, args.signal, folder);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.identity !== identity || manifest.complete !== true || JSON.stringify(manifest.source) !== JSON.stringify(args.source) ||
          JSON.stringify(manifest.frames) !== JSON.stringify(result.frames) || JSON.stringify(manifest.timeBase) !== JSON.stringify(result.timeBase) ||
          JSON.stringify(manifest.nativeFrameRate) !== JSON.stringify(result.nativeFrameRate) || manifest.durationSeconds !== result.durationSeconds || JSON.stringify(result.source) !== JSON.stringify(args.source)) throw Error("전체 프레임 완료 명세와 저장된 검사 결과가 다릅니다.");
      const framePaths: string[] = [];
      for (const frame of result.frames) framePaths.push(await verified(root, frame, args.signal, folder));
      if (JSON.stringify(framePaths) !== JSON.stringify(result.framePaths)) throw Error("저장된 원본 프레임 경로가 다릅니다.");
      await verified(root, args.source, args.signal);
      args.onProgress?.(`원본 전체 ${result.frames.length}프레임의 저장 해시를 검증했습니다. 재해독·새 영상 생성 없음.`);
      return result;
    }
    const binary = resolveFfmpeg(args), attempt = path.join(folder, "decoded-" + randomUUID());
    directory(root, attempt);
    args.onProgress?.("원본 영상의 모든 프레임과 실제 PTS를 해독합니다. 샘플링·축소·새 영상 생성 없음.");
    const decoded = await decode(binary, source, attempt, args.signal, maxFrames, maxSeconds);
    args.signal.throwIfAborted();
    const outputNames = fs.readdirSync(attempt).sort();
    if (outputNames.length !== decoded.frames.length || outputNames.some((name, index) => name !== `frame-${String(index).padStart(6, "0")}.png`)) throw Error("원본 프레임 PTS와 저장된 PNG 목록이 일치하지 않습니다.");
    const frames: GraphicsMotionFrame[] = [], framePaths: string[] = [];
    const factor = decoded.timeBase.numerator / decoded.timeBase.denominator;
    let totalBytes = 0;
    for (const item of decoded.frames) {
      args.signal.throwIfAborted();
      const file = path.join(attempt, `frame-${String(item.index).padStart(6, "0")}.png`), dimensions = pngDimensions(file);
      if (dimensions.width !== item.width || dimensions.height !== item.height) throw Error("저장된 PNG가 원본 프레임 해상도와 다릅니다.");
      const bytes = fs.statSync(file).size; totalBytes += bytes;
      if (totalBytes > MAX_BYTES) throw Error("원본 전체 PNG가 로컬 분석 한도 2 GiB를 넘습니다. 축소하거나 일부만 사용하지 않습니다.");
      frames.push({ path: slash(path.relative(root, file)), kind: "image", bytes, sha256: await hashFile(file, args.signal), index: item.index,
        pts: item.pts, time: item.pts * factor, relativeTime: (item.pts - decoded.frames[0].pts) * factor,
        duration: item.durationTicks === null ? null : item.durationTicks * factor, ...dimensions });
      framePaths.push(file);
    }
    await verified(root, args.source, args.signal);
    const last = frames.at(-1)!, durationSeconds = last.relativeTime + (last.duration ?? 0);
    const manifestPath = path.join(attempt, "native-frames.json");
    immutable(manifestPath, { schemaVersion: 1, identity, complete: true, source: args.source, frames, timeBase: decoded.timeBase, nativeFrameRate: decoded.nativeFrameRate,
      durationSeconds, durationBasis: last.duration === null ? "first-to-last decoded PTS; final display duration unavailable" : "first-to-last decoded PTS plus final native frame duration",
      decoder: "ffmpeg-showinfo-copyts-passthrough", rotationApplied: false, resampled: false, scaled: false, frameCount: frames.length,
      visualReview: "pending", maxFrames, maxDurationSeconds: maxSeconds });
    const result: GraphicsMotionFramesResult = { source: { ...args.source }, manifest: { path: slash(path.relative(root, manifestPath)), kind: "frames", bytes: fs.statSync(manifestPath).size, sha256: await hashFile(manifestPath, args.signal) },
      frames, timeBase: decoded.timeBase, nativeFrameRate: decoded.nativeFrameRate, durationSeconds, framePaths };
    args.signal.throwIfAborted();
    immutable(checkpoint, { schemaVersion: 1, identity, result });
    return result;
  } finally { active.delete(key); }
}
