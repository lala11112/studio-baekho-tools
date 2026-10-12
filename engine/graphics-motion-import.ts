import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";
import type { GraphicsFile } from "../shared/graphics";
import { isGraphicsClipName } from "../shared/graphics";

export type GraphicsMotionImportArgs = {
  projectRoot: string; source: GraphicsFile; versionId: string; clipName: string;
  ffmpegPath: string; signal: AbortSignal;
};
export type GraphicsMotionImportResult = {
  files: GraphicsFile[]; slot: string; label: string; preview: string; warnings: string[];
  metadata: { duration: number; fps: number; width: number; height: number; decodedFrames: number };
};
const active = new Set<string>();
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
const contained = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};
async function hashFile(file: string) {
  const digest = createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
}
function ownedDirectory(root: string, folder: string) {
  if (!contained(root, folder)) throw Error("가져온 영상의 파생 경로가 프로젝트 밖입니다.");
  let ancestor = folder;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const real = fs.realpathSync(ancestor);
  if (real !== root && !contained(root, real)) throw Error("영상 파생 폴더 연결이 프로젝트 밖입니다.");
  fs.mkdirSync(folder, { recursive: true });
  if (!contained(root, fs.realpathSync(folder))) throw Error("영상 파생 폴더가 프로젝트 밖입니다.");
}
async function verifiedFile(root: string, file: GraphicsFile) {
  const absolute = path.resolve(root, file.path);
  if (!contained(root, absolute) || !fs.existsSync(absolute) || !contained(root, fs.realpathSync(absolute)) || !fs.statSync(absolute).isFile() ||
    fs.statSync(absolute).size !== file.bytes || await hashFile(absolute) !== file.sha256) throw Error("가져온 영상·프레임의 원본 경로·크기·해시가 변경됐습니다. 원본을 덮어쓰지 않습니다.");
  return absolute;
}
function immutable(file: string, value: unknown) {
  const fd = fs.openSync(file, "wx");
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function ffmpeg(binary: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, ["-hide_banner", "-nostdin", "-nostats", ...args], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) { if (child.exitCode === null) child.kill(); reject(error); } else resolve({ stdout, stderr });
    };
    const abort = () => finish(Error("가져온 영상 검사를 중지했습니다. 저장된 원본과 파생 파일은 보존합니다."));
    const timer = setTimeout(() => finish(Error("가져온 영상 해독 시간이 초과됐습니다. 원본을 보존합니다.")), 120_000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", bytes => { stdout = (stdout + bytes.toString()).slice(-64_000); });
    child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-64_000); });
    child.on("error", error => finish(error));
    child.on("close", code => finish(code === 0 ? undefined : Error("가져온 영상 해독 실패: " + stderr.slice(-1800))));
    if (signal.aborted) abort();
  });
}

/** Import one already copied, hash-bound native video. Local decode only; no model/service calls. */
export async function prepareGraphicsMotionImport(args: GraphicsMotionImportArgs): Promise<GraphicsMotionImportResult> {
  args.signal.throwIfAborted();
  if (!isGraphicsClipName(args.clipName)) throw Error("가져온 동작 영상의 정확한 클립 이름을 지정하세요.");
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(args.versionId)) throw Error("가져온 영상 버전 ID가 잘못됐습니다.");
  if (!/\.(mp4|webm)$/i.test(args.source.path) || args.source.kind !== "video" || args.source.bytes <= 0 || args.source.bytes > 2 * 1024 ** 3) throw Error("동작 참조는 2 GiB 이하의 MP4·WebM 원본 영상 한 개를 지원합니다.");
  const root = fs.realpathSync(args.projectRoot), source = await verifiedFile(root, args.source);
  if (!fs.existsSync(args.ffmpegPath)) throw Error("로컬 영상 해독 도구 ffmpeg가 없습니다.");
  const header = Buffer.alloc(12), fd = fs.openSync(source, "r");
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (!(header.toString("ascii", 4, 8) === "ftyp" || header.readUInt32BE(0) === 0x1a45dfa3)) throw Error("실제 MP4·WebM 컨테이너가 아닙니다.");
  const folder = path.join(root, "graphics/motion-imports", args.versionId), key = folder.toLowerCase();
  if (active.has(key)) throw Error("같은 영상 버전의 로컬 검사가 이미 실행 중입니다.");
  active.add(key);
  try {
    ownedDirectory(root, folder);
    const identity = createHash("sha256").update(JSON.stringify({ schemaVersion: 1, versionId: args.versionId, clipName: args.clipName, source: args.source })).digest("hex");
    const checkpoint = path.join(folder, "checkpoint.json");
    if (fs.existsSync(checkpoint)) {
      const saved = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
      if (saved.identity !== identity || !Array.isArray(saved.result?.files) || saved.result.slot !== args.clipName) throw Error("저장된 영상 가져오기 요청이 다릅니다. 기존 결과를 덮어쓰지 않습니다.");
      for (const file of saved.result.files) await verifiedFile(root, file);
      if (!saved.result.files.some((file: GraphicsFile) => file.path === args.source.path && file.sha256 === args.source.sha256 && file.bytes === args.source.bytes)) throw Error("저장된 영상 가져오기 원본 연결이 다릅니다.");
      return saved.result;
    }
    // A failed local attempt can retain frames. Each later attempt uses a new folder.
    const output = path.join(folder, "decoded-" + identity.slice(0, 12) + "-" + randomUUID().slice(0, 8));
    ownedDirectory(root, output);
    const input = ["-protocol_whitelist", "file,pipe", "-i", source];
    const decoded = await ffmpeg(args.ffmpegPath, ["-xerror", ...input, "-map", "0:v:0", "-t", "121", "-an", "-progress", "pipe:1", "-f", "null", "-"], args.signal);
    const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(decoded.stderr);
    const containerDuration = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : NaN;
    // Audio may outlast the video. The decoded video clock, not container/audio
    // duration, defines the review window and valid final frame.
    const lastFrameTime = Number([...decoded.stdout.matchAll(/^out_time_us=(\d+)/gm)].at(-1)?.[1]) / 1_000_000;
    const stream = decoded.stderr.split(/\r?\n/).find(line => /Stream #0:\d.*Video:/.test(line));
    const fps = Number(/,\s*([\d.]+) fps/.exec(stream ?? "")?.[1]);
    // Null-video output reports the last frame's timestamp. Include its nominal
    // display interval, bounded by the container, and retain this basis below.
    const duration = Number(Math.min(containerDuration, lastFrameTime + 1 / fps).toFixed(6));
    const decodedFrames = Number([...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]);
    if (!stream || /attached pic/.test(stream) || !Number.isFinite(containerDuration) || !Number.isFinite(duration) || duration <= 0 || duration > 120 || !Number.isFinite(fps) || fps <= 0 || fps > 240 || !Number.isInteger(decodedFrames) || decodedFrames < 2)
      throw Error("실제 동작 영상 스트림·길이·프레임 속도를 확인하지 못했습니다. 0–120초, 240 fps 이하의 두 프레임 이상 영상이 필요합니다.");
    const files: GraphicsFile[] = [{ ...args.source }], frames: { time: number; decodedTime: number; side: string; sha256: string }[] = [];
    let width = 0, height = 0;
    for (let index = 0; index < 5; index++) {
      const time = Number((duration * index / 4).toFixed(6)), decodedTime = Math.min(time, Math.max(0, duration - 1 / fps));
      const target = path.join(output, `side-${index}.png`);
      await ffmpeg(args.ffmpegPath, ["-n", ...input, "-ss", String(decodedTime), "-map", "0:v:0", "-frames:v", "1", "-an", target], args.signal);
      if (!fs.existsSync(target)) throw Error("원본 영상에서 요청한 시점의 프레임을 해독하지 못했습니다.");
      const png = PNG.sync.read(fs.readFileSync(target), { checkCRC: true });
      if (png.width < 1 || png.height < 1 || index > 0 && (png.width !== width || png.height !== height)) throw Error("원본 프레임 해상도가 유효하지 않거나 영상 내에서 변경됩니다.");
      width = png.width; height = png.height;
      const file = { path: relative(root, target), kind: "image", bytes: fs.statSync(target).size, sha256: await hashFile(target) };
      files.push(file); frames.push({ time, decodedTime, side: file.path, sha256: file.sha256 });
    }
    await verifiedFile(root, args.source); args.signal.throwIfAborted();
    const metadata = { duration, fps, width, height, decodedFrames };
    const manifestPath = path.join(output, "motion-reference.json");
    immutable(manifestPath, { schemaVersion: 1, source: "video-import", clipName: args.clipName, motion: args.clipName,
      duration, fps, camera: "unknown", mode: "side", visualReview: "pending", sourceVersionId: args.versionId,
      sourceFile: args.source, videos: { side: { path: args.source.path, sha256: args.source.sha256, bytes: args.source.bytes, startTime: 0 } },
      frames, metadata, containerDuration, lastFrameTime, durationBasis: "last decoded video frame timestamp plus nominal frame interval, bounded by container duration",
      decoder: "ffmpeg-local-original-resolution", sampling: "Five original frames; final sample seeks one nominal source frame before decoded video end" });
    files.push({ path: relative(root, manifestPath), kind: "frames", bytes: fs.statSync(manifestPath).size, sha256: await hashFile(manifestPath) });
    const result: GraphicsMotionImportResult = { files, slot: args.clipName, label: `${args.clipName} · 가져온 동작 영상`, preview: args.source.path, metadata,
      warnings: ["가져온 원본 영상에서 로컬로 프레임 5개를 추출했습니다. AI 영상 생성·원본 재인코딩은 하지 않았습니다.", "단일 영상 입력입니다. 측면 여부·카메라 고정·전신 노출·접지·동작 품질은 검증하지 않았으므로 채택 전에 직접 확인하세요."] };
    immutable(checkpoint, { schemaVersion: 1, identity, result });
    return result;
  } finally { active.delete(key); }
}
