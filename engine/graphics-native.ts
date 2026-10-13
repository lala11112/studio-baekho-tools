import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";
import { CodexWorker, type ProductionWorker } from "./codex-worker";
import type { ProductionRun, ProductionStage } from "../shared/production";
import type { AssetVersion, GraphicsObject, GraphicsRole, GraphicsTask } from "../shared/graphics";
import type { WorkbenchRuntimeApproval, WorkbenchRuntimeAnswer } from "../shared/workbench";
import { normalizePhysicalSize } from "../shared/graphics-size";

export type GraphicsNativeArgs = {
  projectRoot: string;
  workspacePath: string;
  object: GraphicsObject;
  task: GraphicsTask;
  inputs: AssetVersion[];
  blenderPath: string;
  resources: string;
  signal: AbortSignal;
  /** Explicit saved-output recovery: never start a first native/service dispatch. */
  recoveryOnly?: boolean;
  /** Revalidate a completed partition locally when the exporter version changed. */
  refreshDerivatives?: boolean;
  /** Runtime tool permission is answered in the app; paid approval does not grant it. */
  requestApproval?: (request: WorkbenchRuntimeApproval) => Promise<WorkbenchRuntimeAnswer>;
  onProgress: (message: string) => void;
};
export type GraphicsNativeResult = {
  files: { path: string; kind: string }[];
  label: string;
  role: GraphicsRole;
  slot: string;
  warnings: string[];
  usage?: unknown;
  candidates?: { slot: string; label: string; files: { path: string; kind: string }[]; role: GraphicsRole; warnings: string[] }[];
  /** Native image identity survives separate per-image version registration. */
  imageCandidates?: { path: string; label: string; view?: "front" | "back" | "left" | "right"; variant: number }[];
};
type Dependencies = {
  workerFactory?: () => ProductionWorker;
  runBlender?: (executable: string, args: string[], signal: AbortSignal) => Promise<void>;
  /** Read-only native rollout metadata; never a model turn or a generation endpoint. */
  readNativeThread?: (threadId: string, signal: AbortSignal) => Promise<unknown>;
};
type VerifiedInput = { path: string; sha256: string; bytes: number; kind: string; role: GraphicsRole; versionId: string; localPath: string };
type ImageResult = { status: "completed" | "needs_input"; summary: string; images: { path: string; nativePath: string; view: string }[]; warnings: string[] };

export type GraphicsNativeProbe = {
  available: boolean;
  imageGeneration: boolean;
  authenticated: boolean;
  message: string;
};
/** Reads CLI authentication and provider capability metadata. Never opens a thread or a model turn. */
export async function probeGraphicsNative(options: { cliPath?: string; signal?: AbortSignal } = {}): Promise<GraphicsNativeProbe> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_ACCESS_TOKEN", "ELECTRON_RUN_AS_NODE"]) delete env[name];
  const capture = (executable: string, args: string[]) => new Promise<{ code: number; output: string }>(resolve => {
    if (options.signal?.aborted) { resolve({ code: -1, output: "" }); return; }
    const child = spawn(executable, args, { env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", settled = false;
    const finish = (code: number) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (child.exitCode === null) child.kill();
      resolve({ code, output });
    };
    const abort = () => finish(-1), timer = setTimeout(abort, 10_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-8000); });
    child.stderr.on("data", chunk => { output = (output + chunk.toString()).slice(-8000); });
    child.on("error", () => finish(-1)); child.on("close", code => finish(code ?? -1));
    if (options.signal?.aborted) abort();
  });
  let cli = options.cliPath;
  if (!cli && process.env.LOCALAPPDATA) {
    const candidate = path.join(process.env.LOCALAPPDATA, "Programs/OpenAI/Codex/bin/codex.exe");
    if (fs.existsSync(candidate)) cli = candidate;
  }
  if (!cli) {
    const located = await capture(process.platform === "win32" ? "where.exe" : "which", [process.platform === "win32" ? "codex.exe" : "codex"]);
    cli = located.output.split(/\r?\n/).map(value => value.trim()).find(value => fs.existsSync(value) && fs.statSync(value).isFile());
  }
  const unavailable = { available: false, imageGeneration: false, authenticated: false, message: "Codex CLI를 확인하지 못했습니다. 이미지 생성·GPT 요청은 실행하지 않았습니다." };
  if (!cli || !fs.existsSync(cli) || !fs.statSync(cli).isFile() || options.signal?.aborted) return unavailable;
  const [version, login] = await Promise.all([capture(cli, ["--version"]), capture(cli, ["login", "status"])]);
  if (version.code !== 0) return unavailable;
  const authenticated = login.code === 0 && /Logged in using ChatGPT/i.test(login.output);
  const capability = await new Promise<{ imageGeneration?: boolean; error?: string }>(resolve => {
    if (options.signal?.aborted) { resolve({ error: "기능 확인을 중지했습니다." }); return; }
    const child = spawn(cli!, ["app-server", "--stdio"], { env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "", settled = false;
    const write = (value: unknown) => { if (child.stdin.writable && !settled) child.stdin.write(JSON.stringify(value) + "\n"); };
    const finish = (result: { imageGeneration?: boolean; error?: string }) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      child.stdin.end(); if (child.exitCode === null) child.kill(); resolve(result);
    };
    const abort = () => finish({ error: "Codex 기능 응답을 확인하지 못했습니다." });
    const timer = setTimeout(abort, 20_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", () => {}); // Never expose service credentials or authentication URLs.
    child.stdin.on("error", () => {});
    child.on("error", () => finish({ error: "Codex 기능 조회 프로세스를 시작하지 못했습니다." }));
    child.on("close", () => { if (!settled) finish({ error: "Codex 기능 조회 연결이 종료됐습니다." }); });
    child.stdout.on("data", chunk => {
      pending += chunk.toString();
      if (pending.length > 1_000_000) { finish({ error: "Codex 기능 응답 형식을 확인하지 못했습니다." }); return; }
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let message: any; try { message = JSON.parse(line); } catch { continue; }
        if (message.method && message.id !== undefined) {
          write({ id: message.id, error: { code: -32601, message: "Read-only capability query does not grant tool permissions" } }); continue;
        }
        if (message.id === 1) {
          if (message.error) { finish({ error: "Codex 기능 조회 초기화가 거절됐습니다." }); return; }
          write({ method: "initialized" });
          write({ id: 2, method: "modelProvider/capabilities/read", params: {} });
        } else if (message.id === 2) {
          if (message.error || typeof message.result?.imageGeneration !== "boolean") finish({ error: "이 Codex 버전에서 이미지 기능 조회 응답을 확인하지 못했습니다." });
          else finish({ imageGeneration: message.result.imageGeneration });
          return;
        }
      }
    });
    write({ id: 1, method: "initialize", params: { clientInfo: { name: "partsmith-native-capability", version: "1.0.0" }, capabilities: { experimentalApi: true } } });
    if (options.signal?.aborted) abort();
  });
  return {
    available: true,
    authenticated,
    imageGeneration: capability.imageGeneration === true,
    message: capability.error
      ? `${capability.error} 이미지 생성·GPT 요청은 실행하지 않았습니다.`
      : !authenticated
        ? "Codex ChatGPT 계정 로그인이 필요합니다. 이미지 생성·GPT 요청은 실행하지 않았습니다."
        : capability.imageGeneration
          ? "Codex 계정 로그인과 이미지 기능 지원을 확인했습니다. 이 진단에서는 GPT 요청이나 이미지 생성을 실행하지 않았습니다."
          : "현재 Codex 제공자가 이미지 생성 기능을 지원하지 않습니다. GPT 요청은 실행하지 않았습니다.",
  };
}

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const fileHash = (file: string) => digest(fs.readFileSync(file));
const read = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  fs.renameSync(file + ".tmp", file);
};
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
};
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
function ownedDirectory(root: string, directory: string) {
  if (!inside(root, directory)) throw Error("그래픽 작업 경로가 프로젝트 밖입니다.");
  // Check every existing ancestor before creating directories through a junction.
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (ancestor !== root && !inside(root, fs.realpathSync(ancestor))) throw Error("그래픽 작업 경로 연결이 프로젝트 밖입니다.");
  fs.mkdirSync(directory, { recursive: true });
  if (!inside(root, fs.realpathSync(directory))) throw Error("그래픽 작업 경로가 프로젝트 밖입니다.");
}
function verifiedFile(root: string, file: string) {
  const resolved = path.resolve(root, file);
  if (!inside(root, resolved) || !inside(root, fs.realpathSync(resolved)) || !fs.statSync(resolved).isFile())
    throw Error("그래픽 파일이 프로젝트 내부의 일반 파일이 아닙니다.");
  return resolved;
}
function verifyInputs(args: GraphicsNativeArgs, root: string): VerifiedInput[] {
  if (args.task.objectId !== args.object.id) throw Error("그래픽 작업과 오브젝트가 다릅니다.");
  const expected = new Set(args.task.inputVersionIds);
  if (expected.size !== args.task.inputVersionIds.length || args.inputs.length !== expected.size)
    throw Error("고정한 그래픽 입력 목록이 다릅니다.");
  const files: VerifiedInput[] = [];
  for (const version of args.inputs) {
    if (!expected.delete(version.id)) throw Error("고정한 그래픽 입력 버전이 다릅니다.");
    for (const file of version.files) {
      const localPath = verifiedFile(root, file.path);
      if (fs.statSync(localPath).size !== file.bytes || fileHash(localPath) !== file.sha256)
        throw Error("그래픽 입력 원본의 크기 또는 해시가 변경됐습니다.");
      files.push({ ...file, role: version.role, versionId: version.id, localPath });
    }
  }
  return files;
}
function assertInputsUnchanged(inputs: VerifiedInput[]) {
  for (const file of inputs)
    if (!fs.existsSync(file.localPath) || fileHash(file.localPath) !== file.sha256)
      throw Error("작업 도중 그래픽 입력 원본이 변경됐습니다.");
}

/** Native output only: decode PNG, or inspect JPEG/WebP dimensions without altering pixels. */
function imageDimensions(bytes: Buffer): { width: number; height: number; suffix: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 33 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 67_108_864) throw Error("PNG 크기를 안전하게 확인할 수 없습니다.");
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    if (!decoded.width || !decoded.height) throw Error("빈 이미지입니다.");
    return { width: decoded.width, height: decoded.height, suffix: ".png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) throw Error("JPEG 헤더가 손상됐습니다.");
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) throw Error("JPEG 길이가 손상됐습니다.");
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        const height = bytes.readUInt16BE(offset + 5), width = bytes.readUInt16BE(offset + 7);
        if (!width || !height || width * height > 67_108_864 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw Error("JPEG 원본을 확인할 수 없습니다.");
        return { width, height, suffix: ".jpg" };
      }
      offset += length + 2;
    }
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length) {
    const format = bytes.toString("ascii", 12, 16);
    let width = 0, height = 0;
    if (format === "VP8X") { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (format === "VP8 " && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (format === "VP8L" && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    if (width && height && width * height <= 67_108_864) return { width, height, suffix: ".webp" };
  }
  throw Error("실제 PNG/JPEG/WebP 이미지 원본을 확인하지 못했습니다.");
}

/** The exec JSON stream can omit native image items. Read its exact existing rollout without inference. */
async function readNativeThread(threadId: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const candidate = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs/OpenAI/Codex/bin/codex.exe") : "";
  const cli = candidate && fs.existsSync(candidate) ? candidate : process.platform === "win32" ? "codex.exe" : "codex";
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_ACCESS_TOKEN", "ELECTRON_RUN_AS_NODE"]) delete env[name];
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ["app-server", "--stdio"], { env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "", receivedBytes = 0, settled = false;
    const write = (value: unknown) => { if (!settled && child.stdin.writable) child.stdin.write(JSON.stringify(value) + "\n"); };
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      pending = ""; child.stdin.end(); if (child.exitCode === null) child.kill();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(Error("저장된 네이티브 실행 기록 조회를 중지했습니다."));
    const timer = setTimeout(() => finish(Error("저장된 네이티브 실행 기록 조회 시간 초과 · 새 생성 없음")), 20_000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {}); // Never log native base64, credentials or URLs.
    child.on("error", () => finish(Error("Codex 저장 실행 기록 연결을 시작하지 못했습니다.")));
    child.on("close", () => { if (!settled) finish(Error("Codex 저장 실행 기록 연결이 종료됐습니다.")); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (settled) return;
      receivedBytes += Buffer.byteLength(chunk, "utf8");
      if (receivedBytes > 64 * 1024 * 1024) { finish(Error("저장된 네이티브 실행 기록이 64 MiB 조회 한도를 넘었습니다. 원본은 보존합니다.")); return; }
      pending += chunk.toString();
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let message: any; try { message = JSON.parse(line); } catch { continue; }
        if (message.method && message.id !== undefined) {
          write({ id: message.id, error: { code: -32601, message: "Read-only native evidence query does not grant permissions" } }); continue;
        }
        if (message.id === 1) {
          if (message.error) { finish(Error("Codex 저장 실행 기록 조회 초기화가 거절됐습니다.")); return; }
          write({ method: "initialized" });
          write({ id: 2, method: "thread/read", params: { threadId, includeTurns: true } });
        } else if (message.id === 2) {
          if (message.error) finish(Error("Codex 저장 실행 기록을 읽지 못했습니다. 새 생성 요청은 보내지 않습니다."));
          else finish(undefined, message.result);
          return;
        }
      }
    });
    write({ id: 1, method: "initialize", params: { clientInfo: { name: "partsmith-native-evidence", version: "1.0.0" }, capabilities: { experimentalApi: true } } });
    if (signal.aborted) abort();
  });
}

// Evidence comes from CLI native events or the exact native rollout, never an agent's final claim.
async function nativeImageEvidence(file: string, work: string, signal: AbortSignal, readThread: (threadId: string, signal: AbortSignal) => Promise<unknown>) {
  if (!fs.existsSync(file)) throw Error("네이티브 이미지 도구 실행 기록이 없습니다. 자동 재생성하지 않습니다.");
  const paths = new Set<string>();
  const threadIds = new Set<string>();
  const nativeHashes = new Map<string, string>();
  let completed = 0;
  function visit(value: unknown, key = "") {
    if (typeof value === "string") {
      if (/^(?:path|file|file_path|filepath|output_path|output_file|image_path|native_path|local_path|saved_path)$/.test(key) && path.isAbsolute(value))
        paths.add(path.resolve(value));
      if ((value.startsWith("{") || value.startsWith("[")) && value.length < 1_000_000) {
        try { visit(JSON.parse(value)); } catch { /* Not structured output. */ }
      }
    } else if (Array.isArray(value)) for (const item of value) visit(item, key);
    else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) {
      // A requested destination in tool arguments is not evidence of a tool result.
      if (!["arguments", "args", "input", "inputs", "request", "prompt", "referenced_image_paths"].includes(name)) visit(item, name);
    }
  }
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "thread.started" && typeof event.thread_id === "string") threadIds.add(event.thread_id);
    const item = event?.item;
    const native = item?.type === "image_generation";
    const imagegen = item?.type === "mcp_tool_call" && /^(?:image_gen|imagegen)$/.test(String(item.server ?? "")) && /^(?:imagegen|image_gen|generate_image)$/.test(String(item.tool ?? item.tool_name ?? ""));
    if (event.type !== "item.completed" || !item || (!native && !imagegen) || item.error || item.result?.isError || ["failed", "cancelled", "in_progress"].includes(item.status)) continue;
    completed++;
    visit(item);
  }
  if (completed) return { paths, completed, nativeHashes, proof: undefined };
  if (threadIds.size !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test([...threadIds][0]))
    throw Error("성공한 네이티브 이미지 도구 이벤트가 없습니다. 텍스트 완료 응답만으로 결과를 등록하지 않습니다.");
  const threadId = [...threadIds][0];
  signal.throwIfAborted();
  const response = await readThread(threadId, signal) as any;
  signal.throwIfAborted();
  const thread = response?.thread;
  if (thread?.id !== threadId || typeof thread.cwd !== "string" || !fs.existsSync(thread.cwd) || fs.realpathSync(thread.cwd) !== fs.realpathSync(work) || !Array.isArray(thread.turns))
    throw Error("네이티브 실행 기록의 thread ID 또는 작업 폴더가 현재 요청과 다릅니다.");
  const images: { itemId: string; savedPath: string; sha256: string; bytes: number }[] = [];
  for (const turn of thread.turns) for (const item of Array.isArray(turn?.items) ? turn.items : []) {
    if (item?.type !== "imageGeneration" || item.status !== "completed" || item.failure != null) continue;
    if (typeof item.id !== "string" || typeof item.savedPath !== "string" || !path.isAbsolute(item.savedPath) || typeof item.result !== "string" || !item.result.length || item.result.length > 64 * 1024 * 1024 || item.result.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.result))
      throw Error("완료된 네이티브 이미지의 원본 경로 또는 응답 바이트를 검증하지 못했습니다.");
    const nativePath = path.resolve(item.savedPath), bytes = Buffer.from(item.result, "base64");
    const sha256 = digest(bytes);
    if (!fs.existsSync(nativePath) || !fs.statSync(nativePath).isFile() || fileHash(nativePath) !== sha256)
      throw Error("저장된 네이티브 이미지가 실제 생성 응답의 SHA256과 다릅니다.");
    if (nativeHashes.has(nativePath) && nativeHashes.get(nativePath) !== sha256) throw Error("네이티브 원본 경로에 서로 다른 응답이 있습니다.");
    paths.add(nativePath); nativeHashes.set(nativePath, sha256);
    images.push({ itemId: item.id, savedPath: nativePath, sha256, bytes: bytes.length }); completed++;
  }
  if (!completed) throw Error("저장 실행 기록에 성공한 네이티브 이미지가 없습니다. 새 생성 요청은 보내지 않습니다.");
  return { paths, completed, nativeHashes, proof: { source: "codex-app-server-thread-read", threadId, cwd: thread.cwd, images, modelTurns: 0 } };
}

function expectedImageViews(task: GraphicsTask) {
  const count = Number(task.settings.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 4)
    throw Error("이미지 후보 수는 1–4개여야 합니다.");
  if (task.taskId === "I07" || task.settings.multiview === true) {
    const directions = (["front", "back", "left", "right"] as const).filter(view => {
      const selected = task.settings[`view${view[0].toUpperCase()}${view.slice(1)}`];
      if (selected !== undefined && typeof selected !== "boolean") throw Error("방향 선택은 켜기/끄기로 지정하세요.");
      return selected !== false;
    });
    if (!directions.length) throw Error("생성할 방향을 하나 이상 선택하세요.");
    return directions.flatMap(view => Array.from({ length: count }, (_, index) => `${view}-${index + 1}`));
  }
  return Array.from({ length: count }, (_, index) => `image-${index + 1}`);
}
const imageSchema = {
  type: "object", additionalProperties: false, required: ["status", "summary", "images", "warnings"], properties: {
    status: { type: "string", enum: ["completed", "needs_input"] }, summary: { type: "string" },
    images: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "nativePath", "view"], properties: {
      path: { type: "string" }, nativePath: { type: "string" }, view: { type: "string" },
    } } }, warnings: { type: "array", items: { type: "string" } },
  },
};

async function runBlender(executable: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", settled = false;
    const terminate = () => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else child.kill();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => { terminate(); finish(Error("로컬 그래픽 작업을 중지했습니다.")); };
    const timer = setTimeout(() => { terminate(); finish(Error("Blender 로컬 작업 시간 초과")); }, 10 * 60_000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", data => { output = (output + data).slice(-12_000); });
    child.stderr.on("data", data => { output = (output + data).slice(-12_000); });
    child.on("error", error => finish(error));
    child.on("close", code => finish(code === 0 ? undefined : Error(`Blender 로컬 작업 실패 (${code ?? "signal"}): ${output.slice(-3000)}`)));
    if (signal.aborted) abort();
  });
}

export function createGraphicsNativeExecutor(dependencies: Dependencies = {}) {
  return async function execute(args: GraphicsNativeArgs): Promise<GraphicsNativeResult> {
    args.signal.throwIfAborted();
    const root = fs.realpathSync(args.projectRoot), task = args.task;
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(task.id)) throw Error("그래픽 작업 ID가 잘못됐습니다.");
    if (!["I01", "I02", "I03", "I05", "I06", "I07", "I08", "A05", "X04"].includes(task.taskId)) throw Error("이 그래픽 작업의 실행기는 아직 연결되지 않았습니다.");
    const inputs = verifyInputs(args, root);
    const folder = path.join(root, "graphics", "jobs", task.id), work = path.join(folder, "work"), output = path.join(folder, "outputs");
    ownedDirectory(root, work); ownedDirectory(root, output);
    const checkpointFile = path.join(folder, "checkpoint.json"), dispatchFile = path.join(folder, "dispatch.json");
    const identity = digest(JSON.stringify({ taskId: task.taskId, requestHash: task.requestHash, objectId: task.objectId, instruction: task.instruction, settings: task.settings, inputs: inputs.map(file => ({ path: file.path, sha256: file.sha256, versionId: file.versionId })), ...(["I05", "I06", "I07"].includes(task.taskId) ? { objectSnapshot: task.objectSnapshot } : {}) }));
    if (fs.existsSync(checkpointFile)) {
      const cached = read(checkpointFile);
      if (cached.identity !== identity || !Array.isArray(cached.files)) throw Error("저장된 그래픽 결과의 요청 정보가 다릅니다. 자동 재실행하지 않습니다.");
      for (const file of cached.files) {
        const localPath = verifiedFile(root, file.path);
        if (fileHash(localPath) !== file.sha256 || fs.statSync(localPath).size !== file.bytes) throw Error("저장된 그래픽 결과가 변경됐습니다. 자동 재생성하지 않습니다.");
      }
      args.onProgress("검증된 저장 결과를 재사용합니다. 새 생성 요청 없음.");
      return cached.result;
    }
    if (args.recoveryOnly && !["A05", "X04"].includes(task.taskId) && !fs.existsSync(dispatchFile)) throw Error("저장된 네이티브 실행 기록이 없습니다. 복구에서 새 이미지 요청을 시작하지 않습니다.");
    const finish = (result: GraphicsNativeResult) => {
      assertInputsUnchanged(inputs);
      const files = result.files.map(file => { const localPath = verifiedFile(root, file.path); return { ...file, sha256: fileHash(localPath), bytes: fs.statSync(localPath).size }; });
      if (!files.length) throw Error("그래픽 결과 파일이 없습니다.");
      write(checkpointFile, { schemaVersion: 1, identity, createdAt: new Date().toISOString(), files, result });
      return result;
    };
    if (task.taskId === "A05" || task.taskId === "X04") {
      const modelFiles = inputs.filter(file => [".blend", ".fbx", ".glb"].includes(path.extname(file.localPath).toLowerCase()));
      const sources = [...new Set(modelFiles.map(file => file.versionId))];
      if (sources.length !== 1) throw Error("로컬 변환에는 단일 3D 모델 버전을 선택하세요.");
      const source = modelFiles.find(file => /\.blend$/i.test(file.localPath)) ?? modelFiles.find(file => /\.glb$/i.test(file.localPath)) ?? modelFiles[0];
      if (!source) throw Error("Blender/GLB/FBX 원본이 필요합니다.");
      const scale = task.taskId === "A05" ? Number(task.settings.scale ?? 1) : 1;
      const pivot = task.taskId === "A05" ? String(task.settings.pivot ?? "keep") : "keep";
      const format = task.taskId === "X04" ? String(task.settings.exportFormat ?? "both") : "both";
      const physicalSize = task.settings.physicalSize === undefined ? undefined : normalizePhysicalSize(task.settings.physicalSize);
      if (!Number.isFinite(scale) || scale <= 0 || scale > 1e6 || !["keep", "center", "bottom"].includes(pivot) || !["fbx", "glb", "both"].includes(format)) throw Error("크기·피벗·내보내기 설정을 확인하세요.");
      if (!args.blenderPath || !fs.existsSync(args.blenderPath)) throw Error("설정된 Blender 실행 파일을 확인하세요.");
      const script = path.join(args.resources, "blender", "graphics_local.py");
      if (!fs.existsSync(script)) throw Error("로컬 그래픽 변환 스크립트가 없습니다.");
      const reportPath = path.join(output, "report.json"), specPath = path.join(work, "local-request.json");
      write(specPath, { schemaVersion: 1, identity, source: source.localPath, output, operation: task.taskId, scale, pivot, format, physicalSize });
      // Local work may be repeated after failure, but never silently overwrite a completed output.
      if (!fs.existsSync(reportPath)) {
        args.onProgress(task.taskId === "A05" ? "Blender에서 원본을 보존하며 크기·피벗을 새 버전에 적용합니다." : "Blender에서 새 FBX/GLB 내보내기 파일을 만듭니다.");
        await (dependencies.runBlender ?? runBlender)(args.blenderPath, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", script, "--", specPath], args.signal);
      }
      args.signal.throwIfAborted();
      const report = read(reportPath);
      if (report.identity !== identity || report.operation !== task.taskId || report.originalPreserved !== true || report.sourceSha256 !== source.sha256 || !Array.isArray(report.files) || !report.files.length) throw Error("로컬 그래픽 변환 결과 검증에 실패했습니다.");
      if (physicalSize && (report.physicalSize?.sourceSha256 !== source.sha256 || JSON.stringify(normalizePhysicalSize(report.physicalSize?.settings)) !== JSON.stringify(physicalSize))) throw Error("실제 크기 검사와 고정한 원본·설정이 다릅니다.");
      const expected = ["asset.blend", ...(format !== "fbx" ? ["asset.glb"] : []), ...(format !== "glb" ? ["asset.fbx"] : [])];
      if (!expected.every(file => report.files.includes(file))) throw Error("요청한 그래픽 내보내기 파일이 없습니다.");
      const files = report.files.map((file: string) => {
        if (typeof file !== "string" || !inside(output, path.resolve(output, file))) throw Error("로컬 출력 경로가 잘못됐습니다.");
        const absolute = verifiedFile(root, path.join(output, file));
        const extension = path.extname(absolute).toLowerCase();
        if (!fs.statSync(absolute).size || ![".blend", ".glb", ".fbx", ".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw Error("로컬 출력 파일 형식이 잘못됐습니다.");
        return { path: relative(root, absolute), kind: extension === ".blend" ? "blend" : extension === ".fbx" ? "fbx" : extension === ".glb" ? "model" : "image" };
      });
      files.push({ path: relative(root, reportPath), kind: "report" });
      return finish({ files, label: task.taskId === "A05" ? "크기·피벗 보정" : "Unity용 모델 내보내기", role: source.role === "rig" || source.role === "animation" ? source.role : "model", slot: args.inputs.find(v=>v.id===source.versionId)?.slot ?? "main", warnings: ["Unity 에디터 가져오기·재생 검증은 아직 실행하지 않았습니다.", ...(Array.isArray(report.warnings) ? report.warnings.filter((item: unknown) => typeof item === "string") : [])] });
    }

    const views = expectedImageViews(task);
    const imageInputs = inputs.filter(file => file.kind === "image" || /\.(?:png|jpe?g|webp)$/i.test(file.localPath));
    if (task.taskId !== "I01" && !imageInputs.length) throw Error("이 이미지 작업에는 선택한 이미지 원본이 필요합니다.");
    const frozenReferences = task.objectSnapshot?.references ?? args.object.references;
    let imageTarget: VerifiedInput | undefined;
    if (["I05", "I07", "I08"].includes(task.taskId)) {
      const slot = task.taskId !== 'I08' && task.settings.partId ? `part-${task.settings.partId}` : 'main';
      const targetId = task.objectSnapshot?.accepted[`design:${slot}`];
      const targetVersion = args.inputs.find(version => version.id === targetId && version.objectId === args.object.id && version.role === "design");
      const targets = imageInputs.filter(file => file.versionId === targetVersion?.id);
      if (targets.length !== 1) throw Error("이 작업에는 현재 대상에서 채택하고 요청에 고정한 디자인 원본 이미지 한 개가 필요합니다.");
      imageTarget = targets[0];
    }
    if (task.taskId === 'I08' && (!task.settings.partId || !task.settings.partLabel)) throw Error('분리해서 제작할 파츠를 선택하세요.');
    const equipmentOutput = task.settings.equipmentOutput ?? "standalone";
    if (task.taskId === "I06") {
      if (!["standalone", "worn"].includes(String(equipmentOutput))) throw Error("장비 출력은 단독 디자인 또는 착용 참고를 선택하세요.");
      if (!task.objectSnapshot || !imageInputs.some(file => frozenReferences.some(reference => reference.versionId === file.versionId && reference.role === "appearance")))
        throw Error("장비 디자인에는 외형 참조로 연결하고 요청에 고정한 캐릭터 이미지가 필요합니다.");
    }
    if (["I05", "I06"].includes(task.taskId) && !task.instruction.trim()) throw Error("변형할 범위 또는 만들 장비를 입력하세요.");
    const schemaPath = path.join(work, "result.schema.json"), resultPath = path.join(work, "result.json"), eventPath = path.join(work, "codex-events.jsonl");
    const finalizeImages = async (): Promise<GraphicsNativeResult> => {
      const result = read(resultPath) as ImageResult;
      if (!result || result.status !== "completed" || !Array.isArray(result.images) || !Array.isArray(result.warnings))
        throw Error(typeof result?.summary === "string" ? result.summary : "이미지 원본이 모두 완료되지 않았습니다. 저장된 부분 결과를 보존하며 자동 재생성하지 않습니다.");
      if (result.images.length !== views.length) throw Error(`고정 요청은 독립 이미지 원본 ${views.length}개이지만 완료 기록은 ${result.images.length}개입니다. 부분 결과를 보존하며 자동 재생성하지 않습니다.`);
      const evidence = await nativeImageEvidence(eventPath, work, args.signal, dependencies.readNativeThread ?? readNativeThread), seenViews = new Set<string>(), seenHashes = new Set<string>();
      const files: GraphicsNativeResult["files"] = [];
      const candidates: NonNullable<GraphicsNativeResult["imageCandidates"]> = [];
      for (const image of result.images) {
        if (!image || typeof image.path !== "string" || typeof image.nativePath !== "string" || !views.includes(image.view) || seenViews.has(image.view)) throw Error("이미지 원본의 방향 또는 경로가 잘못됐습니다.");
        const supplied = path.resolve(work, image.path);
        if (!inside(work, supplied) || !inside(work, fs.realpathSync(supplied))) throw Error("이미지 결과는 작업 폴더 내부에 저장해야 합니다.");
        const bytes = fs.readFileSync(supplied), hash = digest(bytes), dimensions = imageDimensions(bytes);
        const native = path.resolve(image.nativePath);
        if (!path.isAbsolute(image.nativePath) || !evidence.paths.has(native) || !fs.existsSync(native) || !fs.statSync(native).isFile() || fileHash(native) !== hash)
          throw Error("실제 네이티브 이미지 도구의 원본 경로·해시를 확인하지 못했습니다. 자동 재생성하지 않습니다.");
        if (evidence.nativeHashes.size && evidence.nativeHashes.get(native) !== hash)
          throw Error("작업 폴더의 이미지 사본이 실제 네이티브 생성 응답의 SHA256과 다릅니다.");
        if (seenHashes.has(hash) || imageInputs.some(file => file.sha256 === hash)) throw Error("다른 방향 또는 입력 이미지를 복제한 결과는 새 이미지 원본으로 등록할 수 없습니다.");
        seenViews.add(image.view); seenHashes.add(hash);
        const destination = path.join(output, image.view + dimensions.suffix);
        if (fs.existsSync(destination) && fileHash(destination) !== hash) throw Error("저장된 원본을 다른 결과로 덮어쓸 수 없습니다.");
        if (!fs.existsSync(destination)) fs.copyFileSync(supplied, destination, fs.constants.COPYFILE_EXCL);
        const imagePath = relative(root, destination);
        files.push({ path: imagePath, kind: "image" });
        const parts = /^(front|back|left|right)-(\d+)$/.exec(image.view);
        const view = parts?.[1] as "front" | "back" | "left" | "right" | undefined;
        const variant = Number(parts?.[2] ?? /^image-(\d+)$/.exec(image.view)![1]);
        const names = { front: "정면", back: "후면", left: "왼쪽", right: "오른쪽" };
        candidates.push({ path: imagePath, label: view ? `${names[view]} · 변형 ${variant}` : `${task.taskId === "I05" ? "색상·재질·스타일 변형" : task.taskId === "I06" ? equipmentOutput === "worn" ? "장비 착용 참고" : "장비 단독 디자인" : "디자인"} ${variant}`, ...(view ? { view } : {}), variant });
      }
      if (evidence.proof) write(path.join(folder, "native-provenance.json"), { schemaVersion: 1, identity, verifiedAt: new Date().toISOString(), ...evidence.proof });
      const usagePath = path.join(folder, "usage.json");
      const label = task.taskId === "I01" ? "새 디자인 원본" : task.taskId === "I02" ? "참조 기반 디자인 원본" : task.taskId === "I05" ? "색상·재질·스타일 변형" : task.taskId === "I06" ? equipmentOutput === "worn" ? "장비 착용 참고" : "장비 단독 디자인" : task.taskId === "I07" ? "방향별 디자인 원본" : "이미지 수정 원본";
      const limitations = task.taskId === "I05" ? ["AI 이미지 변형입니다. 형태·비변경 영역의 픽셀 보존이나 실제 PBR 재질 성능은 자동 검증되지 않았습니다."]
        : task.taskId === "I06" ? [equipmentOutput === "worn" ? "착용 참고 이미지입니다. 실제 모델의 장비 크기·접합·변형 적합성은 검증되지 않았습니다." : "장비 디자인 참고 이미지입니다. 실제 제작 치수나 모델의 장착 적합성은 검증되지 않았습니다."]
        : task.taskId === "I07" || task.settings.multiview === true ? ["원본에서 보이지 않는 면은 AI가 해석한 참고 이미지입니다. 방향 간 형태·재질 일치와 좌우 구분을 직접 검토하세요."] : task.taskId === 'I08' ? ['파츠용 AI 참고 원본입니다. 접합면·가려진 부위는 해석이며 실제 모델 접합은 별도 검토합니다.'] : [];
      const lockWarnings = Object.keys(task.settings).some(k => k.startsWith('lock.') && task.settings[k] === true) ? ['유지 잠금은 이미지 생성 지시에 반영했습니다. 외형 보존은 원본과 비교해서 확인해야 합니다.'] : [];
      return finish({ files, label, role: "design", slot: task.settings.partId ? `part-${task.settings.partId}` : "main", imageCandidates: candidates, warnings: [...limitations, ...lockWarnings, ...result.warnings.filter(value => typeof value === "string").slice(0, 30)], ...(fs.existsSync(usagePath) ? { usage: read(usagePath) } : {}) });
    };
    // A dispatched native request is never replayed, even when it produced only partial originals.
    if (fs.existsSync(dispatchFile)) {
      const dispatched = read(dispatchFile);
      if (dispatched.identity !== identity) throw Error("이미 실행한 이미지 요청의 내용이 다릅니다. 자동 재제출하지 않습니다.");
      if (!fs.existsSync(resultPath)) throw Error("기존 네이티브 이미지 요청의 완료가 확인되지 않았습니다. 새 요청을 보내지 않습니다.");
      args.onProgress("기존 이미지 요청의 저장 원본과 네이티브 기록만 확인합니다.");
      return finalizeImages();
    }
    write(schemaPath, imageSchema);
    const inputDirectory = path.join(work, "inputs"); ownedDirectory(root, inputDirectory);
    const originals = imageInputs.map((file, index) => {
      imageDimensions(fs.readFileSync(file.localPath));
      const destination = path.join(inputDirectory, `${index + 1}${path.extname(file.localPath).toLowerCase()}`);
      if (fs.existsSync(destination)) {
        if (fileHash(destination) !== file.sha256) throw Error("준비 중인 이미지 입력의 해시가 다릅니다.");
      } else fs.copyFileSync(file.localPath, destination, fs.constants.COPYFILE_EXCL);
      return destination;
    });
    const referenceManifest = imageInputs.map((file, index) => ({
      path: originals[index],
      versionId: file.versionId,
      use: task.taskId === "I03" || task.taskId === "I05" && file === imageTarget ? "edit-target" : task.taskId === "I07" && file === imageTarget ? "turnaround-target" : task.taskId === 'I08' && file === imageTarget ? 'whole-subject-part-source' : "reference",
      referenceRoles: frozenReferences.filter(reference => reference.versionId === file.versionId).map(reference => reference.role),
    }));
    const stage: ProductionStage = { id: task.id, kind: "view-reference", title: task.taskId, status: "running", dependsOn: [], attempt: 1, charged: false, requiredChecks: [], artifacts: [] };
    const run: ProductionRun = { schemaVersion: 1, id: task.id, projectId: args.object.id, projectRevision: 1, workspace: work, status: "running", createdAt: task.createdAt, updatedAt: task.updatedAt, config: { sourceId: task.objectId, brief: task.instruction, motions: [], maxIterations: 1, studioCreditLimit: 0, videoCreditLimit: 0, mode: "studio" }, source: { path: originals[0] ?? "", sha256: imageInputs[0]?.sha256 ?? "", label: args.object.name }, stages: [stage], message: "Native graphics image execution" };
    const prompt = [
      "You are Partsmith's native graphics image worker. Execute this one frozen user request with the configured BUILT-IN native image generation capability and imagegen skill only. Preserve the user's configured Codex model, reasoning effort and useful native output resolution.",
      "Do not use a browser, ChatGPT web UI, API key, external generation provider, MCP image provider, payment tool, or fallback. Do not change Codex configuration or MCP connection settings. If the native tool is unavailable or approval is required, return needs_input honestly. Do not draw, crop, resize, composite, mirror or synthesize substitute images in Python, SVG, Pillow or any other code.",
      "Inspect every supplied original before editing. Input files are immutable. Create ONE genuine separate native original per requested candidate ID, preserving the requested object type and required transparency. Do not force weapons/props into character layouts. Never create or crop a contact sheet. Do not invent unsupported tool arguments. Use the tool's documented local file result; immediately copy its bytes unchanged into this work folder.",
      views.length > 1 ? "PARALLEL GENERATION: the user explicitly requests simultaneous candidates rather than waiting for one image before starting the next. Use ONE native worker and one shared reference inspection. Prefer a documented batch call that returns independent originals; otherwise dispatch up to FOUR independent native image-generation calls concurrently through the available parallel tool-call/async orchestration interface, then collect their results. For more than four originals use bounded waves. Do NOT launch additional Codex agents/threads or repeat repository scans. Keep each candidate ID and native path distinct. Only the coordinator writes result.json after a completion, preserving all previously completed entries; parallel calls must not race to overwrite that manifest. Never invent n/count parameters. If the native runtime serializes tool calls, state that limitation in warnings instead of claiming concurrent generation or retrying via another provider." : '',
      task.taskId === "I02" ? "REFERENCE-BASED NEW DESIGN: references provide appearance/style/identity cues. The requested target can be a different object, such as a greatsword matching a character. Create that requested target, never replace the reference object or constrain output to a full-body character."
        : task.taskId === "I03" ? "EDIT EXISTING IMAGE: apply the user's correction to the selected original. Keep all features the user asks to preserve. Save a new native version without changing the original. This is an image edit, not a turnaround request."
        : task.taskId === "I05" ? "COLOR / MATERIAL / STYLE VARIATIONS: edit only the single edit-target original. Produce the requested color, material or rendering-style variants while preserving its silhouette, geometry, proportions, pose, composition and details except changes expressly requested by the user. Extra references guide only their declared roles. Keep the full native resolution and transparency; no reduced-size comparison sheet. This is semantic image editing: do not claim pixel-exact preservation, exact masked editing or physically validated PBR materials. Flag unintended shape changes for human review."
        : task.taskId === "I06" ? `EQUIPMENT DESIGN FROM CHARACTER REFERENCE: appearance references are the existing character, while the output target is the requested clothing, weapon or equipment. Preserve the reference character files unchanged and use their palette, proportions and design language. ${equipmentOutput === "worn" ? "WORN REFERENCE OUTPUT: show the character wearing or holding the requested equipment, visibly retaining character identity and attachment/scale relationships. Label these as wearing references, not isolated equipment or validated fitting assets." : "STANDALONE EQUIPMENT OUTPUT: show only the requested equipment as a complete isolated object; do not redraw the reference character as the output subject or force a full-body character layout. Retain thin parts, handles, blade tips and requested transparency."} Create independent variants, never overwrite the character or auto-link/adopt a new object.`
        : task.taskId === "I07" ? "INDEPENDENT DIRECTION ORIGINALS: create exactly the requested directions and variants of the single turnaround-target. Front/back/left/right refer to the SUBJECT'S OWN sides, never the viewer's sides. Each variant number is a consistent identity set across its requested directions. Use consistent orthographic camera height, scale, proportions, materials, background and transparency. Preserve asymmetry from the original; never mirror or duplicate a direction. Keep the full subject and all thin/extremity parts inside each frame. The count is variants PER selected direction; every direction-variant ID requires its own genuine native original. Never crop a sheet, collage or multi-view composite. Unseen surfaces are AI interpretation, not observed ground truth; include that limitation and any inconsistency as warnings."
        : task.taskId === 'I08' ? `PART DESIGN: depict ONLY the selected part ${JSON.stringify(task.settings.partLabel)} (${task.settings.partId}) from the adopted whole-subject-part-source. Preserve its character identity, scale cues, colors and shape. Remove other parts from the new output while leaving the original file unchanged. Create genuine native part originals, not crops or cut-out substitutes. Hidden attachment surfaces are interpretation; report limitations. Do not draw a new full character in place of the requested part.`
        : "NEW DESIGN: create the requested object using the brief and any supplied references.",
      task.settings.multiview === true ? 'MULTIVIEW: each requested direction-variant ID is an independent full-resolution original. Subject-relative left/right, consistent orthographic scale and center across each variant set, no mirrors, sheets or crops. Count means variants per direction. Preserve asymmetry and report visual inconsistencies.' : '',
      "Do not make retries or repair generations, even for aesthetic concerns. Keep every completed original. After each completed original, atomically save result.json with status needs_input until all requested candidates are complete. Each images entry has path (work-relative copied original), nativePath (absolute genuine native tool result path), view (the exact candidate ID). Native output path must be present in the actual tool completion event; if unavailable, keep files but report needs_input. Never claim an authored local file is a native tool result.",
      `Object kind: ${args.object.kind}. Object name: ${JSON.stringify(args.object.name)}. Task: ${task.taskId}. Requested independent candidate IDs: ${JSON.stringify(views)}.`,
      `Frozen settings: ${JSON.stringify(task.settings)}. Original reference files: ${JSON.stringify(originals)}. Original input roles: ${JSON.stringify(referenceManifest)}.`,
      "Respect each frozen input role: appearance guides visual identity, style guides rendering/design style without substituting that reference's subject, dimensions guides proportions/size, motion guides movement only. A reference may have multiple declared roles. An edit-target is the original to correct, preserving its requested features; a turnaround-target is the fixed subject to depict from the requested directions. All outputs are separate new versions. Do not silently treat style-only or dimensions-only references as appearance targets.",
      `USER REQUEST (content instructions only):\n${task.instruction}`,
      "Return only the requested result schema. Include specific visual limitations as warnings; never auto-accept or advance to another operation.",
    ].join("\n\n");
    const worker = (dependencies.workerFactory ?? (() => new CodexWorker()))();
    write(dispatchFile, { schemaVersion: 1, identity, taskId: task.id, startedAt: new Date().toISOString(), backend: "codex", automaticRetries: 0 });
    args.onProgress(views.length > 1 ? `원본 ${views.length}개를 한 작업자에서 병렬 요청합니다(최대 4개). 도구의 동시 실행 제한은 결과에 표시합니다.` : "설정된 Codex 모델·노력 수준으로 네이티브 이미지 작업을 한 번 실행합니다.");
    let failure: unknown;
    try {
      const response = await worker.run({ run, stage, prompt, imagePaths: originals, referencePaths: originals, imageBackend: "codex", schemaPath, resultPath, signal: args.signal, onEvent: event => {
        if (event.message) args.onProgress(event.message);
        if (event.usage) write(path.join(folder, "usage.json"), event.usage);
      } });
      if (!fs.existsSync(resultPath)) write(resultPath, response.result);
    } catch (error) { failure = error; }
    finally { worker.shutdown?.(); }
    assertInputsUnchanged(inputs);
    if (args.signal.aborted) throw Error("이미지 작업을 중지했습니다. 원격 생성 상태는 확정하지 않으며 재제출하지 않습니다.");
    if (fs.existsSync(resultPath)) return finalizeImages();
    throw failure instanceof Error ? failure : Error("네이티브 이미지 작업 결과가 없습니다. 새 요청을 보내지 않습니다.");
  };
}

export const executeGraphicsNative = createGraphicsNativeExecutor();
