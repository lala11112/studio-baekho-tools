import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

type FrozenFile = { path: string; sha256: string; bytes: number };
type ResultFile = FrozenFile & { kind: string };
type RunBlender = (executable: string, args: string[], signal: AbortSignal) => Promise<void>;
export type TripoPartSourceArgs = {
  projectRoot: string;
  source: FrozenFile;
  sourceVersionId: string;
  objectId: string;
  slot: string;
  blenderPath: string;
  resources: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
};
export type TripoPartSourceResult = { files: ResultFile[]; report: any; cached: boolean };

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const fileHash = (file: string) => hash(fs.readFileSync(file));
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};
const checks = ["staticOnly", "finiteNondegenerateGeometry", "sourceGeometry", "sourceUV", "sourceMaterials", "stablePartIdentity", "selfContainedTextures", "restorationCompatible"] as const;
const active = new Set<string>();

/** Reject every existing link/junction, including one that points back inside the root. */
function guardedPath(root: string, supplied: string, allowMissing = false): string {
  if (typeof supplied !== "string" || !supplied || supplied.includes("\0")) throw Error("파트 원본 파일 경로가 잘못됐습니다.");
  const actual = path.resolve(root, supplied);
  if (!inside(root, actual)) throw Error("파트 원본 파일 경로가 허용된 폴더 밖입니다.");
  const parts = path.relative(root, actual).split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    if (parts[index].includes(":")) throw Error("파트 원본 파일 경로에 허용하지 않는 문자가 있습니다.");
    current = path.join(current, parts[index]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || path.relative(current, fs.realpathSync(current)) !== "" ||
      !inside(root, fs.realpathSync(current)) || (index < parts.length - 1 && !stat.isDirectory()))
      throw Error("파트 원본 파일 경로에 링크 또는 잘못된 상위 폴더가 있습니다.");
  }
  return actual;
}

function directory(root: string, supplied: string): string {
  const actual = guardedPath(root, supplied, true);
  let current = root;
  for (const component of path.relative(root, actual).split(path.sep)) {
    current = path.join(current, component);
    guardedPath(root, current, true);
    try { fs.mkdirSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    guardedPath(root, current);
    if (!fs.lstatSync(current).isDirectory()) throw Error("파트 원본 출력 폴더가 일반 폴더가 아닙니다.");
  }
  return actual;
}

function verified(root: string, file: FrozenFile): string {
  if (!file || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0)
    throw Error("파트 원본 파일의 고정 크기·해시가 잘못됐습니다.");
  const actual = guardedPath(root, file.path), stat = fs.lstatSync(actual);
  if (!stat.isFile() || stat.size !== file.bytes || fileHash(actual) !== file.sha256)
    throw Error("파트 원본 입력 또는 결과의 크기·해시가 변경됐습니다.");
  return actual;
}

function readJson(root: string, file: string): any {
  const actual = guardedPath(root, file), stat = fs.lstatSync(actual);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) throw Error("파트 원본 검증 기록의 크기 또는 형식이 잘못됐습니다.");
  return JSON.parse(fs.readFileSync(actual, "utf8").replace(/^\uFEFF/, ""));
}

function validReport(report: any, expected: Record<string, string>) {
  if (!report || report.passed !== true || Object.entries(expected).some(([key, value]) => report[key] !== value) ||
    checks.some(key => report.checks?.[key] !== true))
    throw Error("파트의 형상 대응·원래 배치·식별자·UV·재질 보존 검증을 통과하지 못했습니다.");
}

const runBlender: RunBlender = async (executable, args, signal) => {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "", failure: Error | undefined, finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    // Wait for process exit after cancellation so an output can never be published while Blender writes it.
    const stop = (message: string) => { failure ??= Error(message); child.kill(); };
    const abort = () => stop("파트 원본 준비·검사를 중지했습니다.");
    const timer = setTimeout(() => stop("파트 원본 준비·검사 시간이 초과됐습니다."), 10 * 60_000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", value => { tail = (tail + value.toString()).slice(-4000); });
    child.stderr.on("data", value => { tail = (tail + value.toString()).slice(-4000); });
    child.on("error", error => finish(failure ?? error));
    child.on("close", code => finish(failure ?? (code === 0 ? undefined : Error(`Blender 파트 원본 준비·검사 실패: ${tail}`))));
    if (signal.aborted) abort();
  });
};

/** Local-only preparation/preflight. Neither mode submits, adopts, or changes its source. */
function createProcessor(dependencies: { runBlender?: RunBlender } = {}) {
  return async (args: TripoPartSourceArgs, mode: "prepare" | "preflight"): Promise<TripoPartSourceResult> => {
    args.signal.throwIfAborted();
    const outputNames = mode === "prepare" ? ["asset.blend", "asset.fbx", "asset.glb", "report.json"] : ["report.json"];
    const outputKinds = mode === "prepare" ? ["blend", "model", "model", "report"] : ["report"];
    if (typeof args.sourceVersionId !== "string" || !args.sourceVersionId.trim() || typeof args.objectId !== "string" || !args.objectId.trim() ||
      typeof args.slot !== "string" || !/^part-[A-Za-z0-9_-]+$/.test(args.slot))
      throw Error("파트 원본 준비·검사에는 정확한 원본 버전·오브젝트·파트 슬롯이 필요합니다.");
    if (path.extname(args.source.path).toLowerCase() !== ".fbx")
      throw Error("파트 원본 준비·검사에는 원본 FBX 파일이 필요합니다.");
    const root = fs.realpathSync(args.projectRoot);
    if (!fs.lstatSync(root).isDirectory()) throw Error("파트 원본 프로젝트 폴더가 잘못됐습니다.");
    const source = verified(root, args.source);
    const resources = fs.realpathSync(args.resources);
    const dependencyFiles = ["tripo_part_source.py", "tripo_part_preservation.py", "graphics_glb.py"].map(name => {
      const actual = guardedPath(resources, path.join("blender", name)), stat = fs.lstatSync(actual);
      if (!stat.isFile() || !stat.size) throw Error("파트 원본 검증 도구가 없습니다.");
      return { name, path: actual, bytes: stat.size, sha256: fileHash(actual) };
    });
    const validatorFingerprint = hash(JSON.stringify({ schemaVersion: 1, contract: "tripo-part-source-v1", files: dependencyFiles.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }));
    const identity = hash(JSON.stringify({ schemaVersion: 1, mode, sourceVersionId: args.sourceVersionId, objectId: args.objectId, slot: args.slot,
      source: { sha256: args.source.sha256, bytes: args.source.bytes }, validatorFingerprint }));
    const stableMeshId = "partsmith-" + hash(JSON.stringify({ objectId: args.objectId, slot: args.slot, sourceSha256: args.source.sha256 })).slice(0, 32);
    const expected = { identity, sourceSha256: args.source.sha256, validatorFingerprint, mode, objectId: args.objectId, slot: args.slot, sourceVersionId: args.sourceVersionId };
    const folder = path.join(root, "graphics", "part-source", identity.slice(0, 24)), manifestPath = path.join(folder, "manifest.json");
    const key = process.platform === "win32" ? folder.toLowerCase() : folder;
    if (active.has(key)) throw Error("같은 파트 원본 준비·검사가 이미 실행 중입니다.");
    active.add(key);
    let staging: string | undefined, completed = false;
    const recheck = () => {
      args.signal.throwIfAborted();
      verified(root, args.source);
      for (const file of dependencyFiles) verified(resources, file);
    };
    try {
      guardedPath(root, manifestPath, true);
      if (fs.existsSync(manifestPath)) {
        const saved = readJson(root, manifestPath);
        if (saved.schemaVersion !== 1 || Object.entries(expected).some(([field, value]) => saved[field] !== value) ||
          !/^attempt-[a-f0-9-]{36}$/.test(saved.attempt ?? "") || !Array.isArray(saved.files) || saved.files.length !== outputNames.length)
          throw Error("저장된 파트 원본 기록이 현재 입력과 다릅니다. 덮어쓰지 않습니다.");
        const files: ResultFile[] = saved.files;
        for (let index = 0; index < outputNames.length; index++) {
          const expectedPath = relative(root, path.join(folder, saved.attempt, outputNames[index]));
          if (files[index]?.path !== expectedPath || files[index]?.kind !== outputKinds[index])
            throw Error("저장된 파트 원본 파일 목록 또는 순서가 다릅니다.");
          verified(root, files[index]);
        }
        const report = readJson(root, path.resolve(root, files[files.length - 1].path)); validReport(report, expected); recheck();
        args.onProgress?.("검증된 파트 원본 결과의 원본·도구·출력 해시를 다시 확인했습니다.");
        return { files, report, cached: true };
      }
      if (!args.blenderPath || !fs.statSync(args.blenderPath).isFile()) throw Error("설정된 Blender 실행 파일을 확인하세요.");
      const tempRoot = fs.realpathSync(os.tmpdir());
      staging = fs.mkdtempSync(path.join(tempRoot, "ps-tps-"));
      const input = directory(staging, "input"), output = directory(staging, "output"), scripts = directory(staging, "tools");
      const localSource = path.join(input, "source.fbx");
      fs.copyFileSync(source, localSource, fs.constants.COPYFILE_EXCL);
      verified(staging, { ...args.source, path: localSource });
      for (const file of dependencyFiles) {
        const destination = path.join(scripts, file.name);
        fs.copyFileSync(file.path, destination, fs.constants.COPYFILE_EXCL); verified(staging, { ...file, path: destination });
      }
      const specPath = path.join(staging, "request.json");
      fs.writeFileSync(specPath, JSON.stringify({ schemaVersion: 1, ...expected,
        source: localSource, stableMeshId, output, report: path.join(output, "report.json") }), { flag: "wx" });
      args.onProgress?.("파트 원본의 구조를 로컬에서 검사하고 원래 형상·UV·재질을 보존합니다.");
      await (dependencies.runBlender ?? runBlender)(args.blenderPath,
        ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", path.join(scripts, "tripo_part_source.py"), "--", specPath], args.signal);
      recheck();
      verified(staging, { ...args.source, path: localSource });
      for (const file of dependencyFiles) verified(staging, { ...file, path: path.join(scripts, file.name) });
      const report = readJson(staging, path.join(output, "report.json")); validReport(report, expected);
      const stagedFiles = outputNames.map((name, index) => {
        const actual = guardedPath(staging!, path.join(output, name)), stat = fs.lstatSync(actual);
        if (!stat.isFile() || !stat.size) throw Error("검증된 파트 원본 결과 파일이 없습니다.");
        return { path: actual, kind: outputKinds[index], sha256: fileHash(actual), bytes: stat.size };
      });
      // Preserve incomplete earlier attempts and never replace their output files.
      const attempt = "attempt-" + randomUUID(), destination = directory(root, path.join(folder, attempt));
      const files = stagedFiles.map((file, index) => {
        args.signal.throwIfAborted();
        const target = guardedPath(root, path.join(destination, outputNames[index]), true);
        fs.copyFileSync(verified(staging!, file), target, fs.constants.COPYFILE_EXCL);
        const copied = { ...file, path: relative(root, target) }; verified(root, copied); return copied;
      });
      recheck();
      validReport(readJson(root, path.resolve(root, files[files.length - 1].path)), expected);
      const manifest = guardedPath(root, path.join(folder, "manifest-" + randomUUID() + ".tmp"), true);
      const fd = fs.openSync(manifest, "wx");
      try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, ...expected, attempt, files }, null, 2)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      guardedPath(root, manifestPath, true);
      if (fs.existsSync(manifestPath)) throw Error("다른 파트 원본 완료 기록이 생겼습니다. 기존 결과를 덮어쓰지 않습니다.");
      fs.renameSync(manifest, manifestPath);
      completed = true;
      return { files, report, cached: false };
    } finally {
      active.delete(key);
      // Keep failed native attempts for diagnosis; remove only this exact successful private temp folder.
      if (completed && staging) {
        const tempRoot = fs.realpathSync(os.tmpdir());
        guardedPath(tempRoot, staging);
        if (path.dirname(staging) === tempRoot && /^ps-tps-[A-Za-z0-9]+$/.test(path.basename(staging))) fs.rmSync(staging, { recursive: true, force: true });
      }
    }
  };
}

export function createTripoPartSourceTools(dependencies: { runBlender?: RunBlender } = {}) {
  const process = createProcessor(dependencies);
  return {
    prepare: (args: TripoPartSourceArgs) => process(args, "prepare"),
    preflight: (args: TripoPartSourceArgs) => process(args, "preflight"),
  };
}
const localTools = createTripoPartSourceTools();
export const prepareTripoPartSource = localTools.prepare;
export const preflightTripoPartSource = localTools.preflight;
