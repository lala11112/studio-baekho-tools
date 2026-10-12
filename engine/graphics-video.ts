import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import type { GraphicsNativeArgs, GraphicsNativeResult } from "./graphics-native";
import type { GraphicsFile, GraphicsTask } from "../shared/graphics";
import { isGraphicsClipName } from "../shared/graphics";
import type { Workbench, WorkbenchArtifact, WorkbenchExecutionContext, WorkbenchJob, WorkbenchRequest } from "../shared/workbench";
import { RUNWAY_RATE, runwayEstimate } from "../shared/runway";
import { runwayFrameLayout } from "../shared/runway-framing";
import { RunwayWorkbenchRunner } from "./runway-workbench-runner";

export type GraphicsVideoApproval = { requestHash: string; provider: string; credits: number; approvedAt: string };
type VideoTask = GraphicsTask & { paidApproval?: GraphicsVideoApproval };
type PrepareArgs = Pick<GraphicsNativeArgs, "projectRoot" | "object" | "task" | "inputs">;
export type GraphicsVideoDependencies = Pick<ConstructorParameters<typeof RunwayWorkbenchRunner>[0],
  "ffmpegPath" | "encrypt" | "decrypt" | "connection" | "fetch" | "wait">;
type SavedResult = { requestHash: string; packetHash: string; result: GraphicsNativeResult; files: GraphicsFile[] };

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (file: string) => digest(fs.readFileSync(file));
const read = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8"));
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
const contained = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};
function ownedDirectory(root: string, directory: string) {
  if (!contained(root, directory)) throw Error("영상 작업 경로가 프로젝트 밖입니다.");
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const real = fs.realpathSync(ancestor);
  if (real !== root && !contained(root, real)) throw Error("영상 작업 경로 연결이 프로젝트 밖입니다.");
  fs.mkdirSync(directory, { recursive: true });
  if (!contained(root, fs.realpathSync(directory))) throw Error("영상 작업 경로가 프로젝트 밖입니다.");
}
function verifiedFile(root: string, file: GraphicsFile) {
  const resolved = path.resolve(root, file.path);
  if (!contained(root, resolved) || !fs.existsSync(resolved) || !contained(root, fs.realpathSync(resolved)) || !fs.statSync(resolved).isFile())
    throw Error("영상 입력·결과가 프로젝트 내부의 일반 파일이 아닙니다.");
  if (fs.statSync(resolved).size !== file.bytes || hashFile(resolved) !== file.sha256)
    throw Error("영상 입력·결과의 원본 크기 또는 해시가 변경됐습니다.");
  return resolved;
}
function immutable(file: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== bytes) throw Error("고정된 영상 요청 또는 결과가 변경됐습니다. 원본을 덮어쓰지 않습니다.");
    return;
  }
  const fd = fs.openSync(file, "wx");
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Local validation and published estimate only. No account calls, upload, or generation. */
export function prepareGraphicsVideo(args: PrepareArgs) {
  const { task, object, inputs } = args;
  if (task.taskId !== "N02" || task.objectId !== object.id) throw Error("AI 동작 영상 N02 요청과 대상이 다릅니다.");
  const clipName = String(task.settings.clipName ?? "");
  if (!isGraphicsClipName(clipName)) throw Error("동작 영상의 정확한 클립 이름을 지정하세요. 경로 구분자와 제어 문자는 사용할 수 없습니다.");
  if (!task.instruction.trim()) throw Error("영상으로 만들 동작을 입력하세요.");
  const duration = Number(task.settings.duration ?? 2), credits = runwayEstimate(duration);
  const fps = Number(task.settings.fps ?? 30);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw Error("참조 프레임 속도는 1–60 정수입니다.");
  const loop = task.settings.loop === true;
  const sourceView = task.settings.motionSourceView;
  if (sourceView !== "left" && sourceView !== "right") throw Error("영상에 사용할 왼쪽 또는 오른쪽 측면을 명시하세요.");
  if (Number(task.settings.count ?? 1) !== 1) throw Error("동작 영상은 요청당 한 클립만 생성합니다.");
  if (new Set(task.inputVersionIds).size !== task.inputVersionIds.length || new Set(inputs.map(version => version.id)).size !== inputs.length || inputs.length !== task.inputVersionIds.length ||
    inputs.some(version => !task.inputVersionIds.includes(version.id))) throw Error("고정된 영상 입력 목록이 다릅니다.");
  const source = inputs.find(version => version.id === task.settings.motionSourceVersionId);
  const accepted = task.objectSnapshot?.accepted;
  if (!source || source.objectId !== object.id || !["design", "model", "rig"].includes(source.role) ||
    !accepted || accepted[`${source.role}:${source.slot}`] !== source.id)
    throw Error("현재 대상에서 채택하고 요청에 고정한 디자인 또는 모델·리그 측면 렌더를 선택하세요.");
  const images = source.files.filter(file => file.kind === "image" && /\.png$/i.test(file.path));
  const selected = task.settings.motionSourcePath;
  const sourceFile = typeof selected === "string" && selected ? images.find(file => file.path === selected) : images.length === 1 ? images[0] : undefined;
  if (!sourceFile) throw Error("채택 버전에서 영상에 사용할 측면 PNG 원본을 하나 지정하세요.");
  const root = fs.realpathSync(args.projectRoot);
  for (const version of inputs) for (const file of version.files) verifiedFile(root, file);
  const sourcePath = verifiedFile(root, sourceFile), bytes = fs.readFileSync(sourcePath);
  if (bytes.length < 33 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") throw Error("측면 원본은 실제 PNG여야 합니다.");
  runwayFrameLayout(bytes.readUInt32BE(16), bytes.readUInt32BE(20), loop);
  PNG.sync.read(bytes, { checkCRC: true });
  return {
    clipName, duration, fps, loop, sourceView: sourceView as "left" | "right", source, sourceFile, sourcePath,
    cost: { provider: "Runway", credits, basis: `${RUNWAY_RATE.model} · 720p · 16:9 · ${duration}초 · 영상 1개. 공식 공개 요율 ${RUNWAY_RATE.creditsPerSecond}크레딧/초 (${RUNWAY_RATE.checkedAt}) 기준 예상 ${credits}크레딧이며 실시간 견적이 아닙니다. 새 입력 업로드는 Codex 도구 호출 1회가 필요할 수 있고 상태 확인·다운로드·프레임 추출은 GPT 요청 없이 처리합니다. ${RUNWAY_RATE.source}` },
  };
}

function paidApproval(task: VideoTask, credits: number) {
  const approval = task.paidApproval;
  if (!approval || approval.requestHash !== task.requestHash || approval.provider !== "Runway" || approval.credits !== credits ||
    !Number.isFinite(Date.parse(approval.approvedAt))) throw Error("이 영상 요청과 비용에 대한 앱의 저장된 실행 승인이 필요합니다. 업로드·생성하지 않았습니다.");
  return approval;
}

/** Adapter over the existing MotionVideoLedger: no browser, no second payment ledger. */
export function createGraphicsVideoExecutor(dependencies: GraphicsVideoDependencies) {
  const active = new Set<string>();
  return async (args: GraphicsNativeArgs): Promise<GraphicsNativeResult> => {
    args.signal.throwIfAborted();
    const prepared = prepareGraphicsVideo(args), approval = paidApproval(args.task as VideoTask, prepared.cost.credits);
    const root = fs.realpathSync(args.projectRoot), task = args.task;
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(task.id) || !/^[a-zA-Z0-9_-]{1,160}$/.test(args.object.id)) throw Error("영상 작업 식별자가 올바르지 않습니다.");
    const work = path.join(root, "graphics/jobs", task.id), journalRoot = path.join(root, "graphics/video-journal");
    const key = work.toLowerCase();
    if (active.has(key)) throw Error("같은 영상 작업이 이미 실행 중입니다.");
    active.add(key);
    try {
      ownedDirectory(root, work); ownedDirectory(root, journalRoot);
      for (const directory of [path.join(work, "inputs"), path.join(work, "outputs/video-reference"), path.join(journalRoot, args.object.id)]) ownedDirectory(root, directory);
      const request: WorkbenchRequest = { step: "reference", prompt: task.instruction, motion: prepared.clipName,
        duration: prepared.duration, fps: prepared.fps, loop: prepared.loop, referenceFrameCount: 3,
        referenceTimes: [0, prepared.duration / 2, prepared.duration], motionVideo: { backend: "runway-mcp", mode: "side",
          serviceUrl: "https://app.runwayml.com", model: RUNWAY_RATE.model, resolution: "720p", nativeDuration: prepared.duration,
          sourceView: prepared.sourceView, sourceSlot: "motion-source", framing: "full-body-v1" } };
      const packet = { jobId: task.id, request, approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 },
        graphics: { requestHash: task.requestHash, objectId: args.object.id, sourceVersionId: prepared.source.id,
          sourceFile: prepared.sourceFile, accepted: task.objectSnapshot!.accepted, paidApproval: approval } };
      const packetFile = path.join(work, "external-request.json"), existed = fs.existsSync(packetFile);
      if (args.recoveryOnly && !existed) throw Error("저장된 영상 실행 기록이 없습니다. 복구에서 첫 업로드·유료 제출을 시작하지 않습니다.");
      immutable(packetFile, packet);
      const packetHash = hashFile(packetFile);
      const artifact: WorkbenchArtifact = { ...prepared.sourceFile, kind: "image", role: "motion-source", view: prepared.sourceView };
      const job: WorkbenchJob = { id: task.id, step: "reference", slot: `reference:${prepared.clipName}`, request, approval: packet.approval,
        status: "running", createdAt: task.createdAt, updatedAt: task.updatedAt, summary: "", candidates: [], checks: [],
        externalExecution: { state: "reserved", requestHash: packetHash }, dependencies: { "motion-source": { jobId: "source", candidateId: prepared.source.id } } };
      const sourceJob: WorkbenchJob = { ...job, id: "source", candidates: [{ id: prepared.source.id, label: prepared.source.label, artifacts: [artifact] }] };
      const workbench: Workbench = { schemaVersion: 1, id: args.object.id, projectId: args.object.id, createdAt: task.createdAt,
        updatedAt: task.updatedAt, jobs: [sourceJob, job], selections: {}, message: "" };
      const ctx: WorkbenchExecutionContext = { workbench, job, workspace: work, inputs: [artifact], signal: args.signal };
      const runner = new RunwayWorkbenchRunner({ ...dependencies, projectRoot: () => root, journalRoot });
      const resultFile = path.join(work, "graphics-video-result.json"), receiptFile = path.join(work, "external-result.json");
      const checkReceipt = () => {
        const receipt = read(receiptFile);
        if (receipt.jobId !== task.id || receipt.requestHash !== packetHash) throw Error("저장된 영상 결과가 고정 요청과 다릅니다.");
        runner.verifyReceipt(ctx);
        for (const file of receipt.files ?? []) {
          const resolved = path.resolve(work, file.path);
          if (!contained(work, resolved) || !fs.existsSync(resolved) || !contained(fs.realpathSync(work), fs.realpathSync(resolved)) || hashFile(resolved) !== file.sha256)
            throw Error("저장된 영상·프레임 원본 해시가 변경됐습니다. 새 생성하지 않습니다.");
        }
        return receipt;
      };
      if (fs.existsSync(resultFile)) {
        checkReceipt();
        const saved = read(resultFile) as SavedResult;
        if (saved.requestHash !== task.requestHash || saved.packetHash !== packetHash) throw Error("그래픽 영상 결과가 고정 요청과 다릅니다.");
        for (const file of saved.files) verifiedFile(root, file);
        if (JSON.stringify(saved.result.files) !== JSON.stringify(saved.files.map(({ path, kind }) => ({ path, kind })))) throw Error("그래픽 영상 파일 목록이 변경됐습니다.");
        return saved.result;
      }
      // Existing dispatched packet never authorizes a fresh submit on a recovery click.
      const stateFile = path.join(journalRoot, args.object.id, task.id + "-state.json");
      if (existed && !fs.existsSync(receiptFile) && (!fs.existsSync(stateFile) || !read(stateFile).taskId))
        throw Error("기존 영상 요청의 제출 결과 ID를 확인하지 못했습니다. 복구에서 업로드·유료 제출을 반복하지 않습니다.");
      const result = await runner.run({ ...ctx, requestApproval: async request => {
        // The exact host cost callback consumes the already durable app approval. Other permission requests fail closed.
        if (request.id !== `runway-cost-${task.id}` || request.fields.length) return { accepted: false, values: {} };
        prepareGraphicsVideo(args); paidApproval(args.task as VideoTask, prepared.cost.credits); args.signal.throwIfAborted();
        return { accepted: true, values: {} };
      } }, args.onProgress);
      const usageFile = path.join(work, "usage.json");
      if (result.usage !== undefined && !fs.existsSync(usageFile)) immutable(usageFile, result.usage);
      if (result.status !== "completed") {
        const error = Error(result.summary) as Error & { code?: string };
        error.code = result.status === "submission_unknown" ? "submission_unknown" : "video_pending_or_failed";
        throw error;
      }
      prepareGraphicsVideo(args);
      const receipt = checkReceipt(), rawManifest = read(path.join(work, "outputs/video-reference/frames.json"));
      const local = (rel: string) => relative(root, path.resolve(work, rel));
      const fileData = (rel: string, kind: string): GraphicsFile => {
        const file = path.resolve(work, rel);
        if (!contained(work, file) || !contained(fs.realpathSync(work), fs.realpathSync(file))) throw Error("영상 결과 경로가 작업 밖입니다.");
        return { path: local(rel), kind, sha256: hashFile(file), bytes: fs.statSync(file).size };
      };
      const video = fileData(rawManifest.videos.side.path, "video");
      const manifestPath = "outputs/video-reference/motion-reference.json";
      immutable(path.join(work, manifestPath), { ...rawManifest, clipName: prepared.clipName,
        videos: { side: { ...rawManifest.videos.side, path: video.path, sha256: video.sha256, bytes: video.bytes } },
        frames: rawManifest.frames.map((frame: { time: number; side: string }) => {
          const image = fileData(frame.side, "image"); return { time: frame.time, side: image.path, sha256: image.sha256 };
        }), source: "video-ai", sourceVersionId: prepared.source.id, sourceFile: prepared.sourceFile,
        requestHash: task.requestHash, remoteTaskId: receipt.videos[0].resultId, visualReview: "pending" });
      const artifacts: { path: string; kind: string }[] = receipt.result.candidates.flatMap((candidate: any) => candidate.artifacts);
      const files = artifacts.filter(file => file.kind !== "frames").map(file => fileData(file.path, file.kind));
      files.push(fileData(manifestPath, "frames"));
      const native: GraphicsNativeResult = { files: files.map(({ path, kind }) => ({ path, kind })), role: "motion-reference", slot: prepared.clipName,
        label: `${prepared.clipName} · 측면 동작 참조`, warnings: receipt.result.checks.filter((check: any) => !check.passed).map((check: any) => check.detail), usage: fs.existsSync(usageFile) ? read(usageFile) : result.usage };
      immutable(resultFile, { requestHash: task.requestHash, packetHash, result: native, files } satisfies SavedResult);
      return native;
    } finally { active.delete(key); }
  };
}
