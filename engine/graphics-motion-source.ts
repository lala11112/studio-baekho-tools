import { isGraphicsProductionFile } from '../shared/graphics';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";
import type { GraphicsNativeArgs, GraphicsNativeResult } from "./graphics-native";
import type { GraphicsFile } from "../shared/graphics";

type Args = Pick<GraphicsNativeArgs, "projectRoot" | "object" | "task" | "inputs">;
type RunBlender = (binary: string, args: string[], signal: AbortSignal) => Promise<void>;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (file: string) => hash(fs.readFileSync(file));
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};
function verified(root: string, file: GraphicsFile) {
  const actual = path.resolve(root, file.path);
  if (!inside(root, actual) || !fs.existsSync(actual) || !inside(root, fs.realpathSync(actual)) || !fs.statSync(actual).isFile() ||
    file.bytes !== fs.statSync(actual).size || file.sha256 !== fileHash(actual)) throw Error("측면 렌더 원본의 경로·크기·해시가 다릅니다.");
  return actual;
}
function directory(root: string, output: string) {
  if (!inside(root, output)) throw Error("측면 렌더 출력이 프로젝트 밖입니다.");
  let ancestor = output;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = fs.realpathSync(ancestor);
  if (actual !== root && !inside(root, actual)) throw Error("측면 렌더 출력 경로 연결이 프로젝트 밖입니다.");
  fs.mkdirSync(output, { recursive: true });
  if (!inside(root, fs.realpathSync(output))) throw Error("측면 렌더 출력 경로가 프로젝트 밖입니다.");
}

/** Verifies frozen acceptance and bytes without opening Blender or invoking an AI/service. */
export function prepareGraphicsMotionSource(args: Args) {
  if (args.task.taskId !== "N01" || args.task.objectId !== args.object.id) throw Error("측면 입력 준비 N01의 대상이 다릅니다.");
  const accepted = args.task.objectSnapshot?.accepted;
  const id = args.task.settings.motionModelVersionId || accepted?.["rig:main"] || accepted?.["model:main"];
  const version = args.inputs.find(input => input.id === id);
  if (!version || version.objectId !== args.object.id || !["model", "rig"].includes(version.role) || accepted?.[`${version.role}:${version.slot}`] !== version.id)
    throw Error("이 대상에서 채택한 모델 또는 리그 원본이 필요합니다.");
  if (new Set(args.task.inputVersionIds).size !== args.task.inputVersionIds.length || new Set(args.inputs.map(input => input.id)).size !== args.inputs.length ||
    args.inputs.length !== args.task.inputVersionIds.length || args.inputs.some(input => !args.task.inputVersionIds.includes(input.id))) throw Error("고정된 측면 입력 목록이 다릅니다.");
  const root = fs.realpathSync(args.projectRoot);
  for (const input of args.inputs) for (const file of input.files) verified(root, file);
  const source = ["blend", "glb", "fbx"].map(ext => version.files.find(file => isGraphicsProductionFile(file) && file.path.toLowerCase().endsWith("." + ext))).find(Boolean);
  if (!source) throw Error("측면 렌더에는 BLEND·GLB·FBX 원본이 필요합니다.");
  const axis = String(args.task.settings.motionSourceAxis ?? "X");
  if (!["X", "Y"].includes(axis)) throw Error("측면 촬영 축은 X 또는 Y입니다.");
  return { root, version, source, axis };
}

const runBlender: RunBlender = async (binary, args, signal) => {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "", done = false;
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const abort = () => { child.kill(); finish(Error("측면 렌더를 중지했습니다.")); };
    const timer = setTimeout(() => { child.kill(); finish(Error("측면 렌더 시간이 초과됐습니다.")); }, 10 * 60_000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { tail = (tail + chunk).slice(-4000); });
    child.stderr.on("data", chunk => { tail = (tail + chunk).slice(-4000); });
    child.on("error", finish); child.on("close", code => finish(code === 0 ? undefined : Error(`측면 Blender 렌더 실패: ${tail}`)));
    if (signal.aborted) abort();
  });
};

export function createGraphicsMotionSourceExecutor(dependencies: { runBlender?: RunBlender } = {}) {
  const active = new Set<string>();
  return async (args: GraphicsNativeArgs): Promise<GraphicsNativeResult> => {
    args.signal.throwIfAborted();
    const { root, version, source, axis } = prepareGraphicsMotionSource(args);
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(args.task.id)) throw Error("측면 렌더 작업 식별자가 잘못됐습니다.");
    const output = path.join(root, "graphics/jobs", args.task.id, "motion-source"), checkpoint = path.join(output, "checkpoint.json");
    const identity = hash(JSON.stringify({ requestHash: args.task.requestHash, sourceVersionId: version.id, files: version.files, axis, accepted: args.task.objectSnapshot!.accepted }));
    const key = output.toLowerCase();
    if (active.has(key)) throw Error("이 측면 렌더가 이미 실행 중입니다.");
    active.add(key);
    let staging: string | undefined;
    try {
      if (args.recoveryOnly && !fs.existsSync(checkpoint)) throw Error("완료 기록 없는 측면 렌더는 복구에서 새로 실행하지 않습니다. 기존 원본과 출력을 보존합니다.");
      directory(root, output);
      if (fs.existsSync(checkpoint)) {
        const saved = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
        if (saved.identity !== identity || !Array.isArray(saved.files)) throw Error("저장된 측면 렌더 요청이 다릅니다. 덮어쓰지 않습니다.");
        for (const file of saved.files) verified(root, file);
        if (JSON.stringify(saved.result.files) !== JSON.stringify(saved.files.map(({ path, kind }: GraphicsFile) => ({ path, kind })))) throw Error("저장된 측면 렌더 파일 목록이 다릅니다.");
        return saved.result;
      }
      if (args.recoveryOnly) throw Error("완료 기록 없는 측면 렌더는 복구에서 새로 실행하지 않습니다. 기존 원본과 출력을 보존합니다.");
      if (fs.readdirSync(output).length) throw Error("완료 기록 없는 기존 측면 출력이 있습니다. 덮어쓰지 않고 보존합니다.");
      if (!fs.existsSync(args.blenderPath)) throw Error("설정된 Blender 실행 파일이 없습니다.");
      const script = path.join(args.resources, "blender/graphics_motion_source.py");
      if (!fs.existsSync(script)) throw Error("측면 렌더 스크립트가 없습니다.");
      // Short private paths avoid Blender's native Windows path limit and isolate FBX embedded texture extraction.
      staging = fs.mkdtempSync(path.join(os.tmpdir(), "ps-gms-"));
      const input = path.join(staging, "input"), out = path.join(staging, "output"); fs.mkdirSync(input); fs.mkdirSync(out);
      const files = version.files.filter(isGraphicsProductionFile).map((file, index) => {
        const target = path.join(input, `${index}-${path.basename(file.path)}`);
        fs.copyFileSync(verified(root, file), target, fs.constants.COPYFILE_EXCL);
        return { ...file, original: path.resolve(root, file.path), local: target };
      });
      const specPath = path.join(staging, "request.json");
      fs.writeFileSync(specPath, JSON.stringify({ schemaVersion: 1, identity, axis, source: files.find(file => file.path === source.path)!.local,
        sourceSha256: source.sha256, inputRoot: input, output: out, files }));
      args.onProgress("채택한 모델의 양쪽 측면을 2048px로 촬영합니다. GPT 호출·유료 서비스 사용은 없습니다.");
      await (dependencies.runBlender ?? runBlender)(args.blenderPath, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", script, "--", specPath], args.signal);
      args.signal.throwIfAborted(); prepareGraphicsMotionSource(args);
      const reportPath = path.join(out, "render.json"), report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      if (report.identity !== identity || report.sourceSha256 !== source.sha256 || report.axis !== axis || report.originalPreserved !== true ||
        report.fullBodyInFrame !== true || report.missingImages?.length || JSON.stringify(report.resolution) !== JSON.stringify([2048, 2048]) || report.views?.length !== 2)
        throw Error("측면 렌더의 원본·전신 구도·해상도 검증이 실패했습니다.");
      for (const view of ["left", "right"]) {
        const check = report.views.find((item: any) => item.view === view), bounds = check?.projectedBounds;
        if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] < 0.09 || bounds[1] > 0.91 || bounds[2] < 0.09 || bounds[3] > 0.91)
          throw Error("측면 렌더의 전신 여백이 부족합니다.");
        const bytes = fs.readFileSync(path.join(out, view + ".png"));
        if (bytes.length < 33 || bytes.readUInt32BE(16) !== 2048 || bytes.readUInt32BE(20) !== 2048) throw Error("실제 측면 PNG 크기가 2048px이 아닙니다.");
        PNG.sync.read(bytes, { checkCRC: true });
      }
      const names = ["left.png", "right.png", "render.json"];
      for (const name of names) fs.copyFileSync(path.join(out, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
      const filesOut: GraphicsFile[] = names.map(name => ({ path: relative(root, path.join(output, name)), kind: name.endsWith(".png") ? "image" : "report",
        sha256: fileHash(path.join(output, name)), bytes: fs.statSync(path.join(output, name)).size }));
      const result: GraphicsNativeResult = { files: filesOut.map(({ path, kind }) => ({ path, kind })), role: "design", slot: "motion-source", label: "모델 측면 입력 · 왼쪽/오른쪽",
        warnings: ["로컬 정지 렌더입니다. 왼쪽·오른쪽 방향과 재질을 확인하고 채택한 후 영상 입력을 선택하세요. AI 동작·변형 품질은 검증하지 않았습니다."], usage: { localOnly: true, modelTurns: 0, paidSubmissions: 0 } };
      const fd = fs.openSync(checkpoint, "wx");
      try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, identity, files: filesOut, result }, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return result;
    } finally {
      active.delete(key);
      if (staging && path.dirname(staging) === path.resolve(os.tmpdir()) && path.basename(staging).startsWith("ps-gms-")) fs.rmSync(staging, { recursive: true, force: true });
    }
  };
}

export const executeGraphicsMotionSource = createGraphicsMotionSourceExecutor();
