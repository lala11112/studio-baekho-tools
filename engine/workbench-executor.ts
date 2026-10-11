import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { PNG } from "pngjs";
import { readJsonFile } from "./json";
import { inspectWorkbenchGlb } from "./glb-inspect";
import { validateAnatomicalRig } from "./rig-inspect";
import { splitMultiviewSheet } from "./multiview-sheet";
import {
  blocksWorkbenchCheck,
  normalizeWorkbenchChecks,
} from "../shared/workbench-checks";
import {
  CodexWorker,
  type ProductionWorker,
  type WorkerTask,
} from "./codex-worker";
import type { ProductionRun, ProductionStage } from "../shared/production";
import type {
  WorkbenchArtifact,
  WorkbenchExecutionContext as SharedExecutionContext,
  WorkbenchExecutor,
  WorkbenchObject,
  WorkbenchResult,
  WorkbenchStep,
  WorkbenchJob,
  WorkbenchRecovery,
  WorkbenchView,
} from "../shared/workbench";
import {
  WORKBENCH_MAX_GENERATION_COUNT,
  workbenchGenerationCount,
  workbenchModelInput,
} from "../shared/workbench";

type WorkbenchExecutionContext = SharedExecutionContext & {
  separationVariant?: number;
};
const countWord = (count: number) =>
  count === 1 ? "ONE" : count === 4 ? "FOUR" : String(count);
const variantSuffix = (context?: WorkbenchExecutionContext) =>
  context?.separationVariant ? `-set-${context.separationVariant}` : "";

export type WorkbenchServices = {
  projectRoot: (projectId: string) => string;
  blenderPath: () => string;
  unityPath: (projectId: string) => string | undefined;
  unityEditorPath: () => string;
  resourcesPath: string;
  /** Host-owned state outside the child worker's writable job directory. */
  checkpointRoot?: string;
};
type InputFile = WorkbenchArtifact & {
  localPath: string;
  sourceSha256?: string;
  referenceUse?: "selected-part-view" | "prior-version";
};
type Phase = {
  kind: "uv" | "texture" | "separate" | "separate-sheet" | "separate-multiview";
  role: string;
  view?: WorkbenchView;
  views?: WorkbenchView[];
};
type SeparatedPart = {
  role: string;
  view?: WorkbenchView;
  result: WorkbenchResult;
};
const separationStage = (
  role: string,
  view?: WorkbenchView,
  context?: WorkbenchExecutionContext,
) => `separate-${role}${view ? `-${view}` : ""}${variantSuffix(context)}`;
const sheetStage = (role: string, context?: WorkbenchExecutionContext) =>
  `separate-${role}-sheet-v1${variantSuffix(context)}`;
const multiviewStage = (role: string, context?: WorkbenchExecutionContext) =>
  `separate-${role}-multiview-v1${variantSuffix(context)}`;
const usesChatGptWeb = (context: WorkbenchExecutionContext) =>
  context.job.request.imageBackend === "chatgpt-web" &&
  context.job.request.provider !== "tripo" &&
  ["concept", "separate"].includes(context.job.step);
const orderedViews: WorkbenchView[] = ["front", "back", "left", "right"];
type SheetPlan = {
  jobId: string;
  role: string;
  strategy: "part-sheet-v1";
  views: WorkbenchView[];
};
type MultiviewPlan = Omit<SheetPlan, "strategy"> & {
  strategy: "part-multiview-v1";
};
const imageInputManifest = (inputs: InputFile[]) =>
  inputs.map(({ localPath, kind, role, view }) => ({
    localPath,
    kind,
    role,
    view,
  }));
function independentImageEvidence(bytes: Buffer) {
  const isPng = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPng) {
    if (
      !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) &&
      !(
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP"
      )
    )
      throw Error("독립 원본이 유효한 PNG/JPEG/WebP가 아닙니다.");
    return {
      nativeWidth: undefined,
      nativeHeight: undefined,
      pixelSha: undefined,
    };
  }
  if (
    bytes.length < 33 ||
    bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 67108864
  )
    throw Error("원본 PNG 크기를 안전하게 확인할 수 없습니다.");
  const decoded = PNG.sync.read(bytes, { checkCRC: true }),
    comparable = Buffer.from(decoded.data);
  for (let i = 0; i < comparable.length; i += 4)
    if (comparable[i + 3] === 0) comparable.fill(0, i, i + 3);
  return {
    nativeWidth: decoded.width,
    nativeHeight: decoded.height,
    pixelSha: createHash("sha256")
      .update(`${decoded.width}x${decoded.height}:`)
      .update(comparable)
      .digest("hex"),
  };
}
const imageRequest = (request: WorkbenchJob["request"]) => {
  const {
    step,
    prompt,
    provider,
    role,
    view,
    motion,
    fps,
    duration,
    referenceFrameCount,
    referenceTimes,
    loop,
  } = request;
  return {
    step,
    prompt,
    provider,
    role,
    view,
    motion,
    fps,
    duration,
    referenceFrameCount,
    referenceTimes,
    loop,
  };
};
const uniqueChecks = (checks: WorkbenchResult["checks"]) => [
  ...new Map(
    checks.map((check) => [
      JSON.stringify([
        check.name,
        check.passed,
        check.severity,
        check.visualCategory,
        check.detail,
      ]),
      check,
    ]),
  ).values(),
];
type PhaseJournal = {
  jobId: string;
  stageId: string;
  startedAt: string;
  finished?: boolean;
};
/** Only concrete failures are eligible. Unrecognized requests still need a person. */
export function classifyWorkbenchFailure(reason: string): WorkbenchRecovery {
  if (
    /approval[_ -]?policy|승인\s*정책|approvals?.*(?:denied|reject)|(?:denied|reject).*approvals?|권한.*(?:거부|차단)|승인.*(?:거부|차단)/i.test(
      reason,
    )
  )
    return { kind: "blocked", reason };
  if (
    /login|log.in|captcha|로그인|인증|budget|credit|예산|크레딧|unsupported|지원하지|unavailable|사용할 수 없|찾을 수 없|clarif|사용자.*(선택|결정|판단|승인)|설정.*필요|체크포인트.*변경|완료된 단계 파일이 변경|cannot.*(repair|recover)|(?:복구|수정).*(?:불가|불가능|할 수 없)|(?:new|another).*(?:image|generation).*(?:required|needed)|새.*(?:이미지|생성).*(?:필요|요청)|다시.*생성.*필요/i.test(
      reason,
    )
  )
    return { kind: "blocked", reason };
  if (
    /network|ECONN|ETIMEDOUT|fetch failed|connection.*(closed|reset)|timeout|시간 초과|일시|연결.*(끊|실패)|완료 이벤트|결과 파일|json|utf.?8|bom|schema|구조|검사 실패|검증|산출물|후보.*필요|geometry|텍스처.*누락|웨이트|키프레임|오브젝트|프레임|변형|UV/i.test(
      reason,
    )
  )
    return {
      kind: /network|ECONN|ETIMEDOUT|fetch failed|timeout|시간 초과|연결|완료 이벤트/i.test(
        reason,
      )
        ? "retry"
        : "repair",
      reason,
    };
  return { kind: "blocked", reason };
}
const readJson = (file: string): any => readJsonFile(file);
const hash = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const objectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    category: z.enum(["body", "clothing", "hair", "other"]),
    separate: z.boolean(),
  })
  .strict();
const resultSchema = z
  .object({
    status: z.enum(["completed", "needs_input", "submission_unknown"]),
    summary: z.string().min(1).max(12000),
    candidates: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            label: z.string().min(1).max(300),
            artifacts: z
              .array(
                z
                  .object({
                    path: z.string().min(1),
                    kind: z.enum([
                      "image",
                      "video",
                      "model",
                      "blend",
                      "report",
                      "frames",
                      "export",
                    ]),
                    role: z
                      .string()
                      .nullable()
                      .optional()
                      .transform((value) => value ?? undefined),
                    view: z
                      .enum(["front", "back", "left", "right"])
                      .nullable()
                      .optional()
                      .transform((value) => value ?? undefined),
                  })
                  .strict(),
              )
              .max(300),
            objects: z.array(objectSchema).optional(),
          })
          .strict(),
      )
      .max(WORKBENCH_MAX_GENERATION_COUNT),
    checks: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            passed: z.boolean(),
            severity: z
              .enum(["warning", "error"])
              .nullable()
              .optional()
              .transform((value) => value ?? undefined),
            visualCategory: z
              .enum([
                "alignment",
                "alpha_edges",
                "appearance",
                "view_consistency",
                "semantic_isolation",
              ])
              .nullable()
              .optional()
              .transform((value) => value ?? undefined),
            detail: z
              .string()
              .max(600)
              .nullable()
              .optional()
              .transform((value) => value ?? undefined),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const workbenchResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "candidates", "checks"],
  properties: {
    status: {
      type: "string",
      enum: ["completed", "needs_input", "submission_unknown"],
    },
    summary: { type: "string" },
    candidates: {
      type: "array",
      maxItems: WORKBENCH_MAX_GENERATION_COUNT,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "artifacts", "objects"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "kind", "role", "view"],
              properties: {
                path: { type: "string" },
                view: {
                  type: ["string", "null"],
                  enum: ["front", "back", "left", "right", null],
                },
                kind: {
                  type: "string",
                  enum: [
                    "image",
                    "video",
                    "model",
                    "blend",
                    "report",
                    "frames",
                    "export",
                  ],
                },
                role: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
            },
          },
          objects: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name", "category", "separate"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                category: {
                  type: "string",
                  enum: ["body", "clothing", "hair", "other"],
                },
                separate: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "passed", "severity", "visualCategory", "detail"],
        properties: {
          name: { type: "string" },
          passed: { type: "boolean" },
          severity: {
            type: ["string", "null"],
            enum: ["warning", "error", null],
          },
          visualCategory: {
            type: ["string", "null"],
            enum: [
              "alignment",
              "alpha_edges",
              "appearance",
              "view_consistency",
              "semantic_isolation",
              null,
            ],
          },
          detail: { type: ["string", "null"], maxLength: 600 },
        },
      },
    },
  },
};

/** Only the assigned action runs. A completed action returns candidates for user review. */
export class CodexWorkbenchExecutor implements WorkbenchExecutor {
  constructor(
    private worker: ProductionWorker = new CodexWorker(),
    private services: WorkbenchServices,
  ) {}
  probe() {
    return this.worker.probe();
  }
  shutdown() {
    this.worker.shutdown?.();
  }
  private receiptStageIds(job: WorkbenchJob) {
    if (job.step === "surface")
      return (
        workbenchModelInput(job.request) === "whole"
          ? ["whole"]
          : ["head", "hair", "body"]
      ).flatMap((role) => [role + "-uv", role + "-texture"]);
    if (job.step === "separate" && job.request.imageBackend === "chatgpt-web") {
      const count = workbenchGenerationCount(job.request);
      return Array.from({ length: count }, (_, index) => {
        const suffix = count > 1 ? "-set-" + (index + 1) : "";
        return ["head", "hair", "body"].flatMap((role) => [
          "separate-" + role + "-multiview-v1" + suffix,
          "separate-" + role + suffix,
          ...orderedViews.map(
            (view) => "separate-" + role + "-" + view + suffix,
          ),
        ]);
      }).flat();
    }
    return [job.step];
  }
  hasSubmission(job: WorkbenchJob) {
    return this.receiptStageIds(job).some((id) => {
      const receipt = this.worker.stageReceipt?.(job.id, id, 1);
      return Boolean(receipt?.charges.length || receipt?.submission);
    });
  }
  hasConfirmedSubmission(job: WorkbenchJob) {
    return this.receiptStageIds(job).some((id) => {
      const receipt = this.worker.stageReceipt?.(job.id, id, 1);
      return (
        receipt?.submission?.state === "observed" ||
        receipt?.charges.some((charge) => charge.state === "observed")
      );
    });
  }
  private file(root: string, relative: string) {
    if (path.isAbsolute(relative))
      throw Error("작업 산출물은 상대 경로여야 합니다.");
    const target = path.resolve(root, relative),
      resolved = path.resolve(root);
    if (!target.startsWith(resolved + path.sep))
      throw Error("작업 폴더 밖 산출물은 허용하지 않습니다.");
    if (
      fs.existsSync(target) &&
      !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep)
    )
      throw Error("작업 폴더 밖 연결 파일을 거부했습니다.");
    return target;
  }
  private async inspectBlend(
    context: WorkbenchExecutionContext,
    candidate: WorkbenchResult["candidates"][number],
  ) {
    const blend = candidate.artifacts.find(
      (artifact) => artifact.kind === "blend",
    );
    if (!blend) throw Error("다음 수정에 사용할 실제 .blend 버전이 없습니다.");
    const file = this.file(context.workspace, blend.path);
    const output = path.join(context.workspace, "host-scene-inspection.json");
    const script = path.join(
      this.services.resourcesPath,
      "blender/workbench_inspect.py",
    );
    await runBlender(
      this.services.blenderPath(),
      [
        "--background",
        file,
        "--disable-autoexec",
        "--python",
        script,
        "--",
        output,
      ],
      context.signal,
    );
    const inspected = readJson(output);
    const ids = new Set<string>();
    if (!inspected.objects?.length || inspected.missingImages?.length)
      throw Error("실제 메시가 없거나 Blender 텍스처가 누락됐습니다.");
    candidate.objects = inspected.objects.map((object: any) => {
      if (
        !object.id ||
        ids.has(object.id) ||
        !object.finite ||
        object.vertices < 3 ||
        object.faces < 1
      )
        throw Error("Blender 오브젝트 ID·메시 구조 검증에 실패했습니다.");
      ids.add(object.id);
      return objectSchema.parse({
        id: object.id,
        name: object.name,
        category: object.category,
        separate: object.separate,
      });
    });
    const previous = this.baseObjects(context);
    if (
      (context.job.request.baseJobId ||
        ["rig", "animation"].includes(context.job.step)) &&
      previous.some((object) => !ids.has(object.id))
    )
      throw Error(
        "수정 중 기존 오브젝트 식별자가 사라졌습니다. 명시적인 삭제가 필요합니다.",
      );
    if (context.job.step === "rig" || context.job.step === "animation") {
      validateAnatomicalRig(context.job.request, inspected);
      if (!inspected.rigs?.some((rig: any) => rig.bones?.length >= 3))
        throw Error("실제 캐릭터 뼈대가 없습니다.");
      if (
        inspected.objects.some(
          (object: any) =>
            !object.parentBone &&
            (!object.armatures.length ||
              object.weightedVertices !== object.vertices),
        )
      )
        throw Error("리깅되지 않았거나 웨이트가 없는 정점이 있습니다.");
      for (const target of context.job.request.rigTargets ?? []) {
        const bones = inspected.rigs
          .flatMap((rig: any) => rig.bones ?? [])
          .filter((bone: any) => bone.target === target.objectId);
        if (target.extraBones && !bones.length)
          throw Error(
            `선택한 오브젝트의 추가 뼈가 없습니다: ${target.objectId}`,
          );
        if (!target.extraBones && bones.length)
          throw Error(
            `추가 리깅을 끈 오브젝트에 전용 뼈가 생성됐습니다: ${target.objectId}`,
          );
      }
    }
    if (
      context.job.step === "animation" &&
      !inspected.actions?.some(
        (action: any) =>
          action.poseChannels > 0 &&
          action.keyframes >= 3 &&
          action.varyingChannels > 0,
      )
    )
      throw Error("움직이는 실제 포즈 키프레임 애니메이션이 없습니다.");
    candidate.artifacts.push({
      path: "host-scene-inspection.json",
      kind: "report",
    });
  }
  private baseObjects(context: WorkbenchExecutionContext): WorkbenchObject[] {
    const base = context.job.request.baseJobId
      ? context.workbench.jobs.find(
          (job) => job.id === context.job.request.baseJobId,
        )
      : context.workbench.jobs.find(
          (job) =>
            job.id ===
            (context.job.dependencies.assembly?.jobId ??
              context.job.dependencies.rig?.jobId),
        );
    const selected = Object.values(context.job.dependencies).find(
      (selection) => selection.jobId === base?.id,
    );
    return (
      (
        base?.candidates.find(
          (candidate) => candidate.id === selected?.candidateId,
        ) ?? base?.candidates[0]
      )?.objects ?? []
    );
  }
  private checkpointFile(context: WorkbenchExecutionContext, stageId: string) {
    const root =
      this.services.checkpointRoot ??
      path.join(
        path.dirname(this.services.projectRoot(context.workbench.projectId)),
        "workbench-checkpoints",
      );
    return path.join(
      root,
      createHash("sha256")
        .update(`${context.job.id}/${stageId}`)
        .digest("hex") + ".json",
    );
  }
  private saveCheckpoint(
    context: WorkbenchExecutionContext,
    stageId: string,
    result: WorkbenchResult,
  ) {
    this.validateResultStructure(context.job.step, result);
    const checkpoint = this.checkpointFile(context, stageId);
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    const files = result.candidates
      .flatMap((candidate) => candidate.artifacts)
      .map((artifact) => ({
        path: artifact.path,
        sha256: hash(this.file(context.workspace, artifact.path)),
      }));
    const contents = JSON.stringify({
      jobId: context.job.id,
      stageId,
      result,
      files,
    });
    fs.writeFileSync(checkpoint + ".tmp", contents);
    fs.renameSync(checkpoint + ".tmp", checkpoint);
  }
  private loadCheckpoint(
    context: WorkbenchExecutionContext,
    stageId: string,
  ): WorkbenchResult | undefined {
    const file = this.checkpointFile(context, stageId);
    if (!fs.existsSync(file)) return undefined;
    const checkpoint = readJson(file);
    if (checkpoint.jobId !== context.job.id || checkpoint.stageId !== stageId)
      throw Error("작업 체크포인트 식별자가 일치하지 않습니다.");
    for (const artifact of checkpoint.files)
      if (hash(this.file(context.workspace, artifact.path)) !== artifact.sha256)
        throw Error(
          "완료된 단계 파일이 변경됐습니다. 원격 요청은 다시 제출하지 않습니다.",
        );
    const result: WorkbenchResult = resultSchema.parse(checkpoint.result);
    result.checks = normalizeWorkbenchChecks(context.job.step, result.checks);
    this.validateResultStructure(context.job.step, result);
    return result;
  }
  private validateResultStructure(
    step: WorkbenchStep,
    result: WorkbenchResult,
  ) {
    if (result.checks.some((check) => blocksWorkbenchCheck(step, check)))
      throw Error(
        "작업 검증 실패: " +
          result.checks
            .filter((check) => blocksWorkbenchCheck(step, check))
            .map((check) => check.name)
            .join(", "),
      );
    for (const candidate of result.candidates) {
      const paths = candidate.artifacts.map((artifact) =>
        artifact.path.replaceAll("\\", "/"),
      );
      if (new Set(paths).size !== paths.length)
        throw Error(
          "산출물 구조 검증 실패: 같은 파일을 중복 등록할 수 없습니다.",
        );
    }
  }
  /** Metadata and file validation only; never invokes tools or edits source files. */
  private chatGptInputSummary(
    context: WorkbenchExecutionContext,
    stageId: string,
    summary: string,
  ) {
    if (
      usesChatGptWeb(context) &&
      /login|log.in|captcha|로그인|인증/i.test(summary) &&
      !this.worker.stageReceipt?.(context.job.id, stageId, 1)?.submission
    )
      return `${summary} 이 단계의 앱 전송 기록은 없습니다. ChatGPT 창에서 로그인·인증을 완료한 뒤 새 생성 실행을 눌러 주세요. 현재 실행의 복구는 새 메시지를 보내지 않습니다.`;
    return summary;
  }
  private verifyChatGptOriginal(
    context: WorkbenchExecutionContext,
    stageId: string,
    file: string,
  ) {
    if (!usesChatGptWeb(context)) return;
    const receipt = this.worker.stageReceipt?.(context.job.id, stageId, 1);
    const sha256 = hash(file);
    const native =
      receipt?.imageBackend === "chatgpt-web" && receipt.submission
        ? receipt.downloads.find((download) => {
            let sourceIsChatGpt = false;
            try {
              const source = new URL(download.sourcePage ?? "");
              sourceIsChatGpt =
                source.protocol === "https:" &&
                source.hostname === "chatgpt.com";
              if (receipt.submission?.state === "observed") {
                const conversation = new URL(
                  receipt.submission.conversationUrl ?? "",
                );
                sourceIsChatGpt =
                  sourceIsChatGpt &&
                  conversation.protocol === "https:" &&
                  conversation.hostname === "chatgpt.com" &&
                  /^\/c\/[^/]+\/?$/.test(conversation.pathname) &&
                  source.pathname.replace(/\/$/, "") ===
                    conversation.pathname.replace(/\/$/, "");
              }
            } catch {
              /* A missing source cannot establish web provenance. */
              sourceIsChatGpt = false;
            }
            return (
              download.state === "completed" &&
              download.sha256 === sha256 &&
              download.runId === context.job.id &&
              download.stageId === stageId &&
              sourceIsChatGpt &&
              Boolean(download.imageLabel) &&
              path.isAbsolute(download.file) &&
              fs.existsSync(download.file) &&
              fs.statSync(download.file).isFile() &&
              hash(download.file) === sha256
            );
          })
        : undefined;
    if (!native)
      throw Error(
        "ChatGPT 원본 다운로드 기록과 일치하지 않는 이미지입니다. 화면 캡처나 재가공 이미지는 등록하지 않습니다.",
      );
  }
  private inspectPart(
    context: WorkbenchExecutionContext,
    role: string,
    saved: unknown,
    view?: WorkbenchView,
    preservedInput = false,
  ): WorkbenchResult {
    const result: WorkbenchResult = resultSchema.parse(saved);
    result.checks = normalizeWorkbenchChecks("separate", result.checks);
    this.validateResultStructure("separate", result);
    const visualOnly = result.checks.some((check) => !check.passed);
    if (
      result.status !== "completed" &&
      !(result.status === "needs_input" && visualOnly)
    )
      throw Error("완료된 분리 이미지 기록이 없습니다.");
    if (result.candidates.length !== 1)
      throw Error("분리 결과 구조 검증 실패: 파츠 후보 한 개가 필요합니다.");
    const artifacts = result.candidates[0].artifacts;
    const images = artifacts.filter((artifact) => artifact.kind === "image");
    if (
      images.length !== 1 ||
      images[0].role !== role ||
      (images[0].view ?? "front") !== (view ?? "front")
    )
      throw Error(
        `분리 결과 구조 검증 실패: ${role} 이미지 한 장만 필요합니다.`,
      );
    const folder = path.resolve(
      context.workspace,
      `outputs/${separationStage(role, view, context)}`,
    );
    for (const artifact of artifacts) {
      const file = this.file(context.workspace, artifact.path);
      if (
        !file.startsWith(folder + path.sep) ||
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile() ||
        fs.statSync(file).size < 1 ||
        (!["image", "report"].includes(artifact.kind) &&
          !(
            context.job.request.separationStrategy === "part-sheet-v1" &&
            artifact.kind === "export" &&
            artifact.role === role &&
            path.basename(file) === "source-sheet.png"
          ))
      )
        throw Error("현재 파츠 폴더에 실제 이미지·기록 산출물이 없습니다.");
      if (
        artifact.kind === "report" &&
        path.extname(file).toLowerCase() === ".json"
      )
        readJson(file);
      if (artifact.kind === "image" || artifact.kind === "export") {
        if (
          artifact.kind === "image" &&
          usesChatGptWeb(context) &&
          !preservedInput
        ) {
          const checkpoint = this.loadCheckpoint(
            context,
            separationStage(role, view, context),
          );
          const group =
            context.job.request.separationStrategy === "part-multiview-v1"
              ? this.multiviewPlan(context, role)
              : undefined;
          if (
            !checkpoint?.candidates.some((candidate) =>
              candidate.artifacts.some(
                (saved) =>
                  saved.kind === "image" && saved.path === artifact.path,
              ),
            )
          )
            this.verifyChatGptOriginal(
              context,
              group?.views.includes(view ?? "front")
                ? multiviewStage(role, context)
                : separationStage(role, view, context),
              file,
            );
        }
        const bytes = fs.readFileSync(file);
        if (!(
          bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
          (bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP")
        ))
          throw Error(
            "이미지 파일 구조 검증 실패: 유효한 PNG/JPEG/WebP가 아닙니다.",
          );
      }
    }
    return { ...result, status: "completed" };
  }
  private savedPart(
    context: WorkbenchExecutionContext,
    role: string,
    view?: WorkbenchView,
  ): WorkbenchResult | undefined {
    const stageId = separationStage(role, view, context);
    // A hash-protected checkpoint is authoritative. Never fall back after tampering.
    const checkpoint = this.loadCheckpoint(context, stageId);
    if (checkpoint) return this.inspectPart(context, role, checkpoint, view);
    const file = this.file(context.workspace, `outputs/${stageId}/result.json`);
    if (!fs.existsSync(file)) return undefined;
    return this.inspectPart(context, role, readJson(file), view);
  }
  /** Frozen before starting a role: later partial crops cannot change the generation scope. */
  private sheetPlan(
    context: WorkbenchExecutionContext,
    role: string,
    createViews?: WorkbenchView[],
  ): SheetPlan | undefined {
    const file =
      this.checkpointFile(context, sheetStage(role, context)) + ".plan.json";
    if (fs.existsSync(file)) {
      const plan = readJson(file) as SheetPlan;
      if (
        plan.jobId !== context.job.id ||
        plan.role !== role ||
        plan.strategy !== "part-sheet-v1" ||
        !Array.isArray(plan.views) ||
        plan.views.length < 2 ||
        plan.views.length > 4 ||
        JSON.stringify(plan.views) !==
          JSON.stringify(
            orderedViews.filter((view) => plan.views.includes(view)),
          )
      )
        throw Error(
          "멀티뷰 생성 계획 식별자 또는 방향이 일치하지 않습니다. 새 생성은 하지 않습니다.",
        );
      return plan;
    }
    if (
      this.journal(context, sheetStage(role, context)) ||
      fs.existsSync(this.checkpointFile(context, sheetStage(role, context)))
    )
      throw Error(
        "시작된 멀티뷰 작업의 고정 계획이 없습니다. 새 생성은 하지 않습니다.",
      );
    if (!createViews) return undefined;
    const plan: SheetPlan = {
      jobId: context.job.id,
      role,
      strategy: "part-sheet-v1",
      views: orderedViews.filter((view) => createViews.includes(view)),
    };
    if (plan.views.length < 2)
      throw Error("멀티뷰 시트에는 요청한 방향이 두 개 이상 필요합니다.");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(plan));
    fs.renameSync(file + ".tmp", file);
    return plan;
  }
  /** Preserve the single generated source before any local crop can fail. */
  private inspectSheet(
    context: WorkbenchExecutionContext,
    role: string,
    saved: unknown,
  ): WorkbenchResult {
    const result: WorkbenchResult = resultSchema.parse(saved);
    result.checks = normalizeWorkbenchChecks("separate", result.checks);
    this.validateResultStructure("separate", result);
    const visualOnly = result.checks.some((check) => !check.passed);
    if (
      result.status !== "completed" &&
      !(result.status === "needs_input" && visualOnly)
    )
      throw Error("완료된 멀티뷰 시트 원본 기록이 없습니다.");
    if (result.candidates.length !== 1)
      throw Error("멀티뷰 시트 후보는 한 개여야 합니다.");
    const artifacts = result.candidates[0].artifacts,
      images = artifacts.filter((a) => a.kind === "image");
    if (
      images.length !== 1 ||
      images[0].role !== role ||
      images[0].view !== undefined
    )
      throw Error(
        "멀티뷰 시트에는 방향별 파일 대신 해당 파츠의 원본 PNG 한 장이 필요합니다.",
      );
    const folder = path.resolve(
      context.workspace,
      "outputs/" + sheetStage(role, context),
    );
    for (const artifact of artifacts) {
      const file = this.file(context.workspace, artifact.path);
      if (
        !file.startsWith(folder + path.sep) ||
        !fs.statSync(file).isFile() ||
        !fs.statSync(file).size ||
        !["image", "report"].includes(artifact.kind)
      )
        throw Error(
          "현재 멀티뷰 시트 폴더에 실제 이미지·기록 파일이 필요합니다.",
        );
      if (
        artifact.kind === "report" &&
        path.extname(file).toLowerCase() === ".json"
      )
        readJson(file);
      if (
        artifact.kind === "image" &&
        (path.extname(file).toLowerCase() !== ".png" ||
          !fs
            .readFileSync(file)
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      )
        throw Error("멀티뷰 시트 원본은 투명 PNG여야 합니다.");
    }
    return { ...result, status: "completed" };
  }
  private savedSheet(
    context: WorkbenchExecutionContext,
    plan: SheetPlan,
  ): WorkbenchResult | undefined {
    const stageId = sheetStage(plan.role, context),
      checkpoint = this.loadCheckpoint(context, stageId);
    if (checkpoint) return this.inspectSheet(context, plan.role, checkpoint);
    const resultFile = this.file(
      context.workspace,
      `outputs/${stageId}/result.json`,
    );
    if (!fs.existsSync(resultFile)) return undefined;
    const result = this.inspectSheet(context, plan.role, readJson(resultFile));
    this.saveCheckpoint(context, stageId, result);
    return result;
  }
  /** Deterministic local work only. Re-entry after any crop checkpoint never calls a worker. */
  private splitSheet(
    context: WorkbenchExecutionContext,
    plan: SheetPlan,
    result: WorkbenchResult,
  ): SeparatedPart[] {
    const source = result.candidates[0].artifacts.find(
      (a) => a.kind === "image",
    )!;
    const bytes = fs.readFileSync(this.file(context.workspace, source.path));
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const split = splitMultiviewSheet(bytes, plan.views);
    const sourceExportPath = `outputs/${separationStage(plan.role, plan.views[0], context)}/source-sheet.png`;
    const parts: SeparatedPart[] = [];
    for (const image of split.images) {
      const stageId = separationStage(plan.role, image.view, context),
        folder = `outputs/${stageId}`;
      const relative = `${folder}/part.png`,
        expectedSha = createHash("sha256").update(image.png).digest("hex");
      const existing = this.loadCheckpoint(context, stageId);
      if (existing) {
        const checked = this.inspectPart(
          context,
          plan.role,
          existing,
          image.view,
        );
        const priorImage = checked.candidates[0].artifacts.find(
          (a) => a.kind === "image",
        )!;
        if (hash(this.file(context.workspace, priorImage.path)) !== expectedSha)
          throw Error(
            "완료된 방향 사진이 고정된 시트 분할 결과와 다릅니다. 원본을 덮어쓰지 않습니다.",
          );
        parts.push({ role: plan.role, view: image.view, result: checked });
        continue;
      }
      const destination = this.file(context.workspace, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      // The source sheet is registered once as an export, so backups retain its exact bytes.
      const artifacts: WorkbenchResult["candidates"][number]["artifacts"] = [
        { path: relative, kind: "image", role: plan.role, view: image.view },
      ];
      if (image.view === plan.views[0]) {
        const exported = this.file(context.workspace, sourceExportPath);
        if (fs.existsSync(exported) && hash(exported) !== sourceSha256)
          throw Error("보존된 멀티뷰 시트 원본이 변경됐습니다.");
        if (!fs.existsSync(exported)) fs.writeFileSync(exported, bytes);
        artifacts.push({
          path: sourceExportPath,
          kind: "export",
          role: plan.role,
        });
      }
      if (fs.existsSync(destination) && hash(destination) !== expectedSha)
        throw Error(
          "저장된 방향 사진과 시트 분할 결과가 다릅니다. 기존 파일을 덮어쓰지 않습니다.",
        );
      if (!fs.existsSync(destination)) fs.writeFileSync(destination, image.png);
      const reportPath = `${folder}/sheet-provenance.json`;
      fs.writeFileSync(
        this.file(context.workspace, reportPath),
        JSON.stringify(
          {
            schemaVersion: 1,
            strategy: plan.strategy,
            role: plan.role,
            view: image.view,
            source: sourceExportPath,
            sourceSha256,
            sheetWidth: split.width,
            sheetHeight: split.height,
            nativeCellWidth: image.width,
            nativeCellHeight: image.height,
            region: image.region,
            requestedViews: plan.views,
            operation: "host-local-lossless-crop",
            plannedImageGenerationCalls: 1,
            imageGenerationToolCalls: "not independently verified",
          },
          null,
          2,
        ),
      );
      artifacts.push({
        path: reportPath,
        kind: "report",
        role: plan.role,
        view: image.view,
      });
      const output: WorkbenchResult = {
        status: "completed",
        summary: "파츠 멀티뷰 원본에서 요청한 방향을 로컬 분할했습니다.",
        candidates: [
          {
            id: plan.role + "-" + image.view,
            label: plan.role,
            artifacts,
            objects: [],
          },
        ],
        checks: result.checks,
      };
      this.inspectPart(context, plan.role, output, image.view);
      fs.writeFileSync(
        this.file(context.workspace, `${folder}/result.json`),
        JSON.stringify(output),
      );
      this.saveCheckpoint(context, stageId, output);
      parts.push({ role: plan.role, view: image.view, result: output });
    }
    return parts;
  }
  private multiviewPlan(
    context: WorkbenchExecutionContext,
    role: string,
    createViews?: WorkbenchView[],
  ): MultiviewPlan | undefined {
    const stageId = multiviewStage(role, context),
      file = this.checkpointFile(context, stageId) + ".plan.json";
    if (fs.existsSync(file)) {
      const plan = readJson(file) as MultiviewPlan;
      if (
        plan.jobId !== context.job.id ||
        plan.role !== role ||
        plan.strategy !== "part-multiview-v1" ||
        !Array.isArray(plan.views) ||
        plan.views.length < 2 ||
        plan.views.length > 4 ||
        JSON.stringify(plan.views) !==
          JSON.stringify(
            orderedViews.filter((view) => plan.views.includes(view)),
          )
      )
        throw Error(
          "독립 멀티뷰 작업의 고정 계획이 일치하지 않습니다. 새 생성은 하지 않습니다.",
        );
      return plan;
    }
    if (
      this.journal(context, stageId) ||
      fs.existsSync(this.checkpointFile(context, stageId))
    )
      throw Error(
        "시작된 독립 멀티뷰 작업의 고정 계획이 없습니다. 새 생성은 하지 않습니다.",
      );
    if (!createViews) return undefined;
    const plan: MultiviewPlan = {
      jobId: context.job.id,
      role,
      strategy: "part-multiview-v1",
      views: orderedViews.filter((view) => createViews.includes(view)),
    };
    if (plan.views.length < 2)
      throw Error("독립 멀티뷰 묶음에는 요청 방향 두 개 이상이 필요합니다.");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(plan));
    fs.renameSync(file + ".tmp", file);
    return plan;
  }
  /** A partial group also freezes every original file already reported by the worker. */
  private savedMultiview(
    context: WorkbenchExecutionContext,
    plan: MultiviewPlan,
  ): WorkbenchResult | undefined {
    const stageId = multiviewStage(plan.role, context),
      checkpoint = this.checkpointFile(context, stageId);
    if (fs.existsSync(checkpoint)) {
      const saved = readJson(checkpoint);
      if (
        saved.jobId !== context.job.id ||
        saved.stageId !== stageId ||
        !Array.isArray(saved.files)
      )
        throw Error("독립 멀티뷰 체크포인트 식별자가 일치하지 않습니다.");
      for (const file of saved.files)
        if (hash(this.file(context.workspace, file.path)) !== file.sha256)
          throw Error(
            "완료된 단계 파일이 변경됐습니다. 새 생성은 하지 않습니다.",
          );
      return resultSchema.parse(saved.result);
    }
    const resultFile = this.file(
      context.workspace,
      `outputs/${stageId}/result.json`,
    );
    return fs.existsSync(resultFile)
      ? resultSchema.parse(readJson(resultFile))
      : undefined;
  }
  /** Validate and copy native independent originals, without cropping, scaling or re-encoding. */
  private publishMultiview(
    context: WorkbenchExecutionContext,
    plan: MultiviewPlan,
    saved: unknown,
  ) {
    const raw: WorkbenchResult = resultSchema.parse(saved);
    raw.checks = normalizeWorkbenchChecks("separate", raw.checks);
    if (raw.candidates.length > 1)
      throw Error(
        "독립 멀티뷰 묶음은 한 후보 안에 방향별 원본을 저장해야 합니다.",
      );
    const stageId = multiviewStage(plan.role, context),
      folder = path.resolve(context.workspace, `outputs/${stageId}`);
    raw.summary = this.chatGptInputSummary(context, stageId, raw.summary);
    if (
      usesChatGptWeb(context) &&
      this.worker.stageReceipt?.(context.job.id, stageId, 1)?.submission
        ?.state === "reserved"
    )
      raw.status = "submission_unknown";
    const artifacts = raw.candidates[0]?.artifacts ?? [],
      images = artifacts.filter((a) => a.kind === "image");
    const issues = raw.checks
      .filter((c) => blocksWorkbenchCheck("separate", c))
      .map((c) => c.name);
    const warnings = raw.checks.filter(
      (c) => !blocksWorkbenchCheck("separate", c),
    );
    const mergeWarnings = (checked: WorkbenchResult, view: WorkbenchView) => {
      const checks = uniqueChecks([...checked.checks, ...warnings]);
      if (JSON.stringify(checks) === JSON.stringify(checked.checks))
        return checked;
      const updated = { ...checked, checks },
        stage = separationStage(plan.role, view, context);
      fs.writeFileSync(
        this.file(context.workspace, `outputs/${stage}/result.json`),
        JSON.stringify(updated),
      );
      this.saveCheckpoint(context, stage, updated);
      return updated;
    };
    const files: { path: string; sha256: string }[] = [],
      parts: SeparatedPart[] = [],
      seenHashes = new Set<string>(),
      seenPixels = new Set<string>();
    const previous = this.savedMultiview(context, plan);
    if (previous) {
      const checkpoint = this.checkpointFile(context, stageId);
      if (fs.existsSync(checkpoint)) files.push(...readJson(checkpoint).files);
    }
    for (const view of plan.views)
      if (!images.some((a) => a.view === view)) {
        const existing = this.loadCheckpoint(
          context,
          separationStage(plan.role, view, context),
        );
        if (existing) {
          const checked = mergeWarnings(
            this.inspectPart(context, plan.role, existing, view),
            view,
          );
          const image = checked.candidates[0].artifacts.find(
            (a) => a.kind === "image",
          )!;
          seenHashes.add(hash(this.file(context.workspace, image.path)));
          const evidence = independentImageEvidence(
            fs.readFileSync(this.file(context.workspace, image.path)),
          );
          if (evidence.pixelSha) seenPixels.add(evidence.pixelSha);
          parts.push({ role: plan.role, view, result: checked });
        }
      }
    for (const artifact of artifacts.filter((a) => a.kind !== "image"))
      try {
        const file = this.file(context.workspace, artifact.path);
        if (
          artifact.kind !== "report" ||
          !file.startsWith(folder + path.sep) ||
          !fs.statSync(file).isFile() ||
          !fs.statSync(file).size
        )
          throw Error("요청하지 않은 산출물 또는 잘못된 기록 파일입니다.");
        if (path.extname(file).toLowerCase() === ".json") readJson(file);
        if (!files.some((f) => f.path === artifact.path))
          files.push({ path: artifact.path, sha256: hash(file) });
      } catch (error) {
        issues.push(
          error instanceof Error ? error.message : "기록 파일 확인 실패",
        );
      }
    for (const artifact of images) {
      try {
        if (
          artifact.role !== plan.role ||
          !artifact.view ||
          !plan.views.includes(artifact.view) ||
          images.filter((a) => a.view === artifact.view).length !== 1
        )
          throw Error(
            "파츠·방향 식별자가 없거나 요청 범위와 다르거나 중복됐습니다.",
          );
        const file = this.file(context.workspace, artifact.path);
        if (
          !file.startsWith(folder + path.sep) ||
          !fs.statSync(file).isFile() ||
          fs.statSync(file).size === 0
        )
          throw Error("현재 독립 멀티뷰 폴더에 원본 이미지가 없습니다.");
        this.verifyChatGptOriginal(context, stageId, file);
        const bytes = fs.readFileSync(file),
          sourceSha256 = createHash("sha256").update(bytes).digest("hex");
        const { nativeWidth, nativeHeight, pixelSha } =
          independentImageEvidence(bytes);
        if (
          seenHashes.has(sourceSha256) ||
          (pixelSha && seenPixels.has(pixelSha))
        )
          throw Error("서로 다른 방향에 같은 원본 이미지가 등록됐습니다.");
        seenHashes.add(sourceSha256);
        if (pixelSha) seenPixels.add(pixelSha);
        if (!files.some((f) => f.path === artifact.path))
          files.push({ path: artifact.path, sha256: sourceSha256 });
        const partStage = separationStage(plan.role, artifact.view, context),
          existing = this.loadCheckpoint(context, partStage);
        if (existing) {
          const checked = this.inspectPart(
            context,
            plan.role,
            existing,
            artifact.view,
          );
          if (
            hash(
              this.file(
                context.workspace,
                checked.candidates[0].artifacts.find((a) => a.kind === "image")!
                  .path,
              ),
            ) !== sourceSha256
          )
            throw Error(
              "완료된 방향 원본이 바뀌었습니다. 기존 버전을 덮어쓰지 않습니다.",
            );
          parts.push({
            role: plan.role,
            view: artifact.view,
            result: mergeWarnings(checked, artifact.view),
          });
          continue;
        }
        const partFolder = `outputs/${partStage}`,
          destination = `${partFolder}/original${path.extname(artifact.path).toLowerCase()}`;
        const target = this.file(context.workspace, destination);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target) && hash(target) !== sourceSha256)
          throw Error("이미 저장된 방향 원본이 다릅니다. 덮어쓰지 않습니다.");
        if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
        const provenance = `${partFolder}/multiview-provenance.json`;
        fs.writeFileSync(
          this.file(context.workspace, provenance),
          JSON.stringify(
            {
              schemaVersion: 1,
              strategy: plan.strategy,
              role: plan.role,
              view: artifact.view,
              sourceSha256,
              nativeWidth,
              nativeHeight,
              operation: "native-original-copy",
              requestedViews: plan.views,
              imageGenerationToolCalls: "not independently verified",
            },
            null,
            2,
          ),
        );
        const output: WorkbenchResult = {
          status: "completed",
          summary: "멀티뷰 작업에서 독립된 방향 원본을 보존했습니다.",
          candidates: [
            {
              id: plan.role + "-" + artifact.view,
              label: plan.role,
              artifacts: [
                {
                  path: destination,
                  kind: "image",
                  role: plan.role,
                  view: artifact.view,
                },
                {
                  path: provenance,
                  kind: "report",
                  role: plan.role,
                  view: artifact.view,
                },
              ],
              objects: [],
            },
          ],
          checks: warnings,
        };
        this.inspectPart(context, plan.role, output, artifact.view);
        fs.writeFileSync(
          this.file(context.workspace, `${partFolder}/result.json`),
          JSON.stringify(output),
        );
        this.saveCheckpoint(context, partStage, output);
        parts.push({ role: plan.role, view: artifact.view, result: output });
      } catch (error) {
        issues.push(
          `${artifact.view ?? "방향 미지정"}: ${error instanceof Error ? error.message : "원본 확인 실패"}`,
        );
      }
    }
    // An incremental result may omit an earlier completed view; keep its immutable checkpoint.
    for (const view of plan.views)
      if (!parts.some((p) => p.view === view)) {
        const existing = this.loadCheckpoint(
          context,
          separationStage(plan.role, view, context),
        );
        if (existing && !images.some((a) => a.view === view))
          parts.push({
            role: plan.role,
            view,
            result: this.inspectPart(context, plan.role, existing, view),
          });
      }
    const checkpoint = this.checkpointFile(context, stageId);
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    fs.writeFileSync(
      checkpoint + ".tmp",
      JSON.stringify({ jobId: context.job.id, stageId, result: raw, files }),
    );
    fs.renameSync(checkpoint + ".tmp", checkpoint);
    const complete =
      parts.length === plan.views.length &&
      !issues.length &&
      raw.status !== "submission_unknown" &&
      (raw.status === "completed" || raw.checks.some((c) => !c.passed));
    const result = this.separatedDraft(
      parts,
      complete,
      issues.length
        ? `${raw.summary} 확인 필요: ${issues.join(" / ")}`
        : raw.summary,
      plan.views.length,
    );
    result.checks = uniqueChecks([...result.checks, ...raw.checks]);
    if (!complete)
      result.recovery = {
        kind: "blocked",
        reason: issues.length
          ? issues.join(" / ")
          : "저장된 독립 원본만 표시합니다. 시작한 묶음은 새 이미지 생성 없이 기존 파일만 복구할 수 있습니다.",
      };
    if (raw.status === "submission_unknown")
      result.status = "submission_unknown";
    return { parts, result };
  }
  private async multiviewPhase(
    context: WorkbenchExecutionContext,
    inputs: InputFile[],
    task: WorkerTask,
    onProgress: (message: string) => void,
  ): Promise<WorkbenchResult> {
    const role = /^separate-(head|hair|body)-multiview-v1(?:-set-\d+)?$/.exec(
        task.stage.id,
      )![1],
      plan = this.multiviewPlan(context, role)!;
    let prepared:
      ReturnType<CodexWorkbenchExecutor["publishMultiview"]> | undefined;
    const publish = (saved: unknown) => {
      prepared = this.publishMultiview(context, plan, saved);
      if (prepared.parts.length)
        context.onDraft?.(
          this.separatedDraft(
            prepared.parts,
            false,
            undefined,
            3 * (context.job.request.views?.length ?? 1),
          ),
        );
      return prepared.result;
    };
    try {
      const existing = this.savedMultiview(context, plan);
      if (existing) {
        const result = publish(existing);
        if (result.status === "completed") return result;
      }
      if (context.signal.aborted)
        return (
          prepared?.result ?? {
            status: "needs_input",
            summary: "사용자가 작업을 중지했습니다.",
            candidates: [],
            checks: [],
            recovery: { kind: "blocked", reason: "사용자 취소" },
          }
        );
      if (this.journal(context, task.stage.id) || existing) {
        task.recoveryOnly = true;
        task.prompt = this.recoveryPrompt(
          context,
          inputs,
          `outputs/${task.stage.id}`,
          task.stage.id,
          false,
        );
        onProgress(
          `${role} · 저장된 독립 원본만 확인합니다. 새 생성 요청은 보내지 않습니다.`,
        );
      }
      const baseEvent = task.onEvent;
      let lastResultStamp = "";
      task.onEvent = (event) => {
        baseEvent?.(event);
        if (fs.existsSync(task.resultPath))
          try {
            const stat = fs.statSync(task.resultPath),
              stamp = `${stat.size}:${stat.mtimeMs}`;
            if (stamp === lastResultStamp) return;
            publish(readJson(task.resultPath));
            lastResultStamp = stamp;
          } catch {
            /* Incomplete atomic result writes are inspected again after the worker finishes. */
          }
      };
      this.saveJournal(context, task.stage.id);
      const response = await this.worker.run(task);
      this.saveJournal(context, task.stage.id, true);
      return publish(response.result);
    } catch (error) {
      if (fs.existsSync(task.resultPath))
        try {
          publish(readJson(task.resultPath));
        } catch {
          /* Preserve the original failure and already verified draft, never regenerate. */
        }
      const summary = this.chatGptInputSummary(
        context,
        task.stage.id,
        error instanceof Error ? error.message : "독립 멀티뷰 작업 확인 실패",
      );
      const ambiguous =
        usesChatGptWeb(context) &&
        this.worker.stageReceipt?.(context.job.id, task.stage.id, 1)?.submission
          ?.state === "reserved";
      return {
        status: ambiguous ? "submission_unknown" : "needs_input",
        summary,
        candidates: prepared?.result.candidates ?? [],
        checks: prepared?.result.checks ?? [],
        recovery: ambiguous
          ? {
              kind: "blocked",
              reason:
                "ChatGPT 메시지 전송 여부가 불명확합니다. 기존 대화만 확인할 수 있습니다.",
            }
          : context.signal.aborted
            ? { kind: "blocked", reason: "사용자 취소" }
            : classifyWorkbenchFailure(summary),
      };
    }
  }
  private separatedDraft(
    parts: SeparatedPart[],
    completed = false,
    summary?: string,
    expected = 3,
  ): WorkbenchResult {
    return {
      status: completed ? "completed" : "needs_input",
      summary:
        summary ??
        (completed
          ? `${expected}장 파츠 사진이 준비됐습니다. 외형 경고와 사진을 확인한 뒤 채택하세요.`
          : `${parts.length}/${expected} 파츠 사진을 확인할 수 있습니다. 모든 방향이 준비된 뒤 채택할 수 있습니다.`),
      candidates: parts.length
        ? [
            {
              id: "separate",
              label: "세 파츠 분리 결과",
              artifacts: parts.flatMap(
                (part) => part.result.candidates[0].artifacts,
              ),
              objects: [],
            },
          ]
        : [],
      checks: uniqueChecks(
        parts.flatMap(({ role, result }) =>
          result.checks.map((check) => ({
            ...check,
            name: `${role}:${check.name}`,
          })),
        ),
      ),
    };
  }
  async inspectSaved(
    context: WorkbenchExecutionContext,
  ): Promise<WorkbenchResult> {
    if (context.job.step === "reference") {
      const result: WorkbenchResult = resultSchema.parse(readJson(this.file(context.workspace, "outputs/reference/result.json")));
      result.checks = normalizeWorkbenchChecks("reference", result.checks);
      if (result.checks.some(c => blocksWorkbenchCheck("reference", c)))
        return {...result, status:"needs_input", recovery:{kind:"blocked", reason:"참조 방향·자세를 검토해 주세요. 원본만 표시하며 재생성하지 않습니다."}};
      return result;
    }
    if (
      context.job.step === "separate" &&
      !context.separationVariant &&
      workbenchGenerationCount(context.job.request) > 1
    )
      return this.separationVariants(
        context,
        (variant) => this.inspectSaved(variant),
        true,
      );
    if (context.job.step !== "separate")
      throw Error(
        "저장된 사진 확인은 파츠 분리 단계에서만 사용할 수 있습니다.",
      );
    const parts: SeparatedPart[] = [];
    const issues: string[] = [];
    const hashes = new Set<string>();
    const views = context.job.request.views ?? [undefined];
    const blockedViews = new Map<string, Set<WorkbenchView>>();
    if (context.job.request.separationStrategy === "part-multiview-v1")
      for (const role of ["head", "hair", "body"]) {
        if (context.signal.aborted) break;
        let plan: MultiviewPlan | undefined;
        try {
          plan = this.multiviewPlan(context, role);
          if (!plan) continue;
          const saved = this.savedMultiview(context, plan);
          if (saved) {
            const published = this.publishMultiview(context, plan, saved);
            if (published.result.status !== "completed")
              issues.push(`${role}: ${published.result.summary}`);
          }
        } catch (error) {
          blockedViews.set(role, new Set(plan?.views ?? orderedViews));
          issues.push(
            `${role}: ${error instanceof Error ? error.message : "독립 원본 확인 실패"}`,
          );
        }
      }
    if (context.job.request.separationStrategy === "part-sheet-v1")
      for (const role of ["head", "hair", "body"]) {
        if (context.signal.aborted) break;
        let plan: SheetPlan | undefined;
        try {
          plan = this.sheetPlan(context, role);
          if (!plan) continue;
          const saved = this.savedSheet(context, plan);
          if (saved) this.splitSheet(context, plan, saved);
        } catch (error) {
          blockedViews.set(role, new Set(plan?.views ?? orderedViews));
          issues.push(
            `${role}: ${error instanceof Error ? error.message : "저장된 시트 확인 실패"}`,
          );
        }
      }
    for (const role of ["head", "hair", "body"])
      for (const view of views) {
        if (context.signal.aborted) break;
        if (blockedViews.get(role)?.has(view ?? "front")) continue;
        try {
          const result = this.savedPart(context, role, view);
          if (!result) continue;
          const image = result.candidates[0].artifacts.find(
            (artifact) => artifact.kind === "image",
          )!;
          const digest = hash(this.file(context.workspace, image.path));
          if (hashes.has(digest))
            throw Error("서로 다른 파츠에 같은 이미지가 등록됐습니다.");
          hashes.add(digest);
          parts.push({ role, view, result });
        } catch (error) {
          issues.push(
            `${role}/${view ?? "front"}: ${error instanceof Error ? error.message : "저장된 파일 확인 실패"}`,
          );
        }
      }
    const complete =
      parts.length === 3 * views.length &&
      !issues.length &&
      !context.signal.aborted;
    const result = this.separatedDraft(
      parts,
      complete,
      undefined,
      3 * views.length,
    );
    if (issues.length) result.summary += ` 확인 필요: ${issues.join(" / ")}`;
    if (!complete)
      result.recovery = {
        kind: "blocked",
        reason:
          "저장된 사진만 확인했습니다. 나머지 작업 실행은 사용자가 결정합니다.",
      };
    return result;
  }
  private journalFile(context: WorkbenchExecutionContext, stageId: string) {
    return this.checkpointFile(context, stageId) + ".execution.json";
  }
  private journal(
    context: WorkbenchExecutionContext,
    stageId: string,
  ): PhaseJournal | undefined {
    const file = this.journalFile(context, stageId);
    if (!fs.existsSync(file)) return undefined;
    const journal = readJson(file) as PhaseJournal;
    if (journal.jobId !== context.job.id || journal.stageId !== stageId)
      throw Error("작업 실행 기록 식별자가 일치하지 않습니다.");
    return journal;
  }
  private saveJournal(
    context: WorkbenchExecutionContext,
    stageId: string,
    finished = false,
  ) {
    const file = this.journalFile(context, stageId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const contents: PhaseJournal = {
      jobId: context.job.id,
      stageId,
      startedAt:
        this.journal(context, stageId)?.startedAt ?? new Date().toISOString(),
      finished,
    };
    fs.writeFileSync(file + ".tmp", JSON.stringify(contents));
    fs.renameSync(file + ".tmp", file);
  }
  private recoveryPrompt(
    context: WorkbenchExecutionContext,
    inputs: InputFile[],
    folder: string,
    stageId: string,
    charged: boolean,
  ) {
    const imagePhase =
      context.job.step === "separate" ||
      context.job.step === "reference" ||
      (context.job.step === "concept" &&
        context.job.request.provider !== "tripo");
    const separated =
      /^separate-(head|hair|body)(?:-(front|back|left|right))?(?:-set-\d+)?$/.exec(
        stageId,
      );
    const sheetRole = /^separate-(head|hair|body)-sheet-v1(?:-set-\d+)?$/.exec(
      stageId,
    )?.[1];
    const sheetPlan = sheetRole
      ? this.sheetPlan(context, sheetRole)
      : undefined;
    const multiviewRole =
      /^separate-(head|hair|body)-multiview-v1(?:-set-\d+)?$/.exec(
        stageId,
      )?.[1];
    const multiviewPlan = multiviewRole
      ? this.multiviewPlan(context, multiviewRole)
      : undefined;
    return [
      "Recover ONLY the existing action using existing files. This is NOT permission to generate again. Built-in image generation and paid submissions are disabled by the host. Do not bypass through shell, network, another provider or account. Never change Codex configuration or read credentials.",
      `Workspace: ${context.workspace}. Phase: ${stageId}. Write artifacts and strict result JSON under '${folder}/'. Inputs are immutable: ${JSON.stringify(imagePhase ? imageInputManifest(inputs) : inputs)}. Original user request: ${JSON.stringify(imagePhase ? imageRequest(context.job.request) : context.job.request)}.`,
      `The actual failure to repair is: ${context.recovery?.error ?? "The previous worker did not complete. Inspect saved result.json, existing outputs and codex-events.jsonl to find its failure."}`,
      charged
        ? "The host retains the original Studio receipt. Inspect the existing submitted task only, wait/recheck its result or download the existing native outputs. Never press generate, retry, UV, texture or any other paid action. Retain unchanged native downloads for receipt verification. If task identity or submission is ambiguous, return submission_unknown."
        : usesChatGptWeb(context)
          ? "This phase uses the user's actual ChatGPT web chat. Use only injected chatgpt_snapshot, chatgpt_navigate(current), chatgpt_click_image, chatgpt_download_image, chatgpt_downloads, chatgpt_scroll and bounded chatgpt_wait to find/download ALREADY generated originals from this phase's saved conversation. No fill, upload, submit, new chat, follow-up, regeneration, API or imagegen. Copy original download bytes unchanged. Inspect actual images and associated response labels to identify directions; never use download order. If submission or conversation identity remains ambiguous return submission_unknown. Login/CAPTCHA requires the user. Preserve every genuine partial original; missing directions require a later explicit user request."
          : "Recover actual files already produced by the previous attempt. You may copy known completed generated files mentioned in its log, repair JSON/BOM/paths, and inspect/repackage existing outputs. Do not fabricate missing outputs or alter the requested character through procedural replacements. If a required generated image does not exist or its invocation is ambiguous, return needs_input with that exact reason.",
      multiviewPlan
        ? `Recover ONLY existing independent original files for '${multiviewPlan.role}', directions ${JSON.stringify(multiviewPlan.views)}. This is the same frozen grouped request. Return one candidate with each actual saved image tagged with its exact role and view. Preserve completed source bytes and register remaining already-generated files when discoverable in the existing logs. No image generation, batch or concurrent calls, contact sheets, cropping, mirroring, fabrication or downsampling. If any direction has no genuine existing original, keep valid partial outputs and return needs_input; missing views require a later explicit user request. Keep all truthful visual_quality warnings. Update result.json with actual partial files before further inspection.`
        : sheetPlan
          ? `Recover the EXISTING generated 2x2 PNG sheet for '${sheetPlan.role}', requested cells ${JSON.stringify(sheetPlan.views)}. Exactly ONE candidate containing ONE original PNG image with role '${sheetPlan.role}' and view null. Fixed grid: top-left front, top-right back, bottom-left character-left, bottom-right character-right. Preserve the exact generated sheet; the host performs local crops. Do not generate a missing sheet, fill blank cells, repaint, stitch individual pictures, or use individual direction-generation calls. Save the existing original first. Keep actual aesthetic concerns as visual_quality / passed=false / severity=warning with a finite visualCategory and concrete detail. Missing/unreadable source or wrong role remains blocking. If the genuine prior sheet is unavailable return needs_input; never regenerate.`
          : imagePhase
            ? `Return the existing real image artifacts. ${context.job.step === "separate" ? `Exactly ONE candidate and ONE image, role '${separated?.[1]}', view '${separated?.[2] ?? "front"}'. A valid existing image is ready for user review even when its position, scale, alignment, alpha edge or appearance is imperfect. For EVERY aesthetic observation use ONLY the canonical check name visual_quality, a visualCategory chosen from alignment / alpha_edges / appearance / view_consistency / semantic_isolation, severity warning, truthful passed=false, and a concrete detail (maximum 600 characters) identifying the direction and concern. Never invent a new technical-sounding visual check such as back_view_geometry_convincing. Return completed with the existing image unchanged. File readability, missing output, role/view identity, source hash and path/integrity checks remain separate blocking errors and must never be relabeled visual_quality. Do not repair aesthetic issues or withhold the image for exact original-canvas alignment.` : "Preserve the requested candidate/frame count."} Never create a composite as a substitute.`
            : `For local preview/geometry/rig repair use configured Blender ${JSON.stringify(this.services.blenderPath())}, actual prior native assets and bpy. Preserve object IDs, intended materials and user-requested rig targets. Return editable .blend when the stage requires it. ${["assembly", "rig", "animation"].includes(context.job.step) ? "Use gpt-6-astra for the actual local scene correction." : ""}`,
      "Return strict JSON with status, summary, candidates and checks. completed means the repaired actual files are ready for host verification. Do not accept results or advance stages on the user's behalf.",
    ].join("\n\n");
  }
  private baseInputs(context: WorkbenchExecutionContext, inputs: InputFile[]) {
    const base = context.workbench.jobs.find(
      (job) => job.id === context.job.request.baseJobId,
    );
    if (!base) return [];
    const selected = Object.values(context.workbench.selections).find(
      (selection) => selection.jobId === base.id,
    );
    const candidates = [...base.candidates, ...(base.draftCandidates ?? [])];
    const frozenId = context.job.request.baseCandidateId;
    const candidate = frozenId
      ? candidates.find((item) => item.id === frozenId)
      : (candidates.find((item) => item.id === selected?.candidateId) ??
        candidates[0]);
    if (frozenId && !candidate)
      throw Error("기준 버전의 고정 후보를 찾을 수 없습니다.");
    const artifacts = candidate?.artifacts ?? [];
    return inputs.filter((input) =>
      artifacts.some(
        (artifact) =>
          artifact.path === input.path && artifact.sha256 === input.sha256,
      ),
    );
  }
  private selectedInputs(
    context: WorkbenchExecutionContext,
    inputs: InputFile[],
    slot: string,
  ) {
    const selection =
      context.job.dependencies[slot] ?? context.workbench.selections[slot];
    if (!selection) return undefined;
    const candidate = context.workbench.jobs
      .find((job) => job.id === selection.jobId)
      ?.candidates.find((item) => item.id === selection.candidateId);
    if (!candidate) throw Error("선택한 입력 후보를 찾을 수 없습니다.");
    return inputs.filter((input) =>
      candidate.artifacts.some(
        (artifact) =>
          artifact.path === input.path && artifact.sha256 === input.sha256,
      ),
    );
  }
  private inheritedChecks(context: WorkbenchExecutionContext, role: string) {
    const base = context.workbench.jobs.find(
      (job) => job.id === context.job.request.baseJobId,
    );
    const checks = base?.candidates.length
      ? base.checks
      : (base?.draftChecks ?? base?.checks ?? []);
    return uniqueChecks(
      checks
        .filter(
          (check) =>
            !check.passed &&
            (!/^(?:head|hair|body):/.test(check.name) ||
              check.name.startsWith(role + ":")),
        )
        .map((check) => ({
          ...check,
          name: check.name.replace(new RegExp("^" + role + ":"), ""),
        })),
    );
  }
  private preserveInput(
    context: WorkbenchExecutionContext,
    input: InputFile,
    folder: string,
  ) {
    const source = this.file(context.workspace, input.localPath);
    if (hash(source) !== input.sha256)
      throw Error("보존할 입력 파일이 변경됐습니다.");
    const relative = `${folder}/preserved-${input.kind}-${path.basename(input.localPath)}`;
    const destination = this.file(context.workspace, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return {
      path: relative,
      kind: input.kind,
      role: input.role,
      view: input.view,
    };
  }
  private modelViewInput(
    context: WorkbenchExecutionContext,
    input: InputFile,
    anchorSha256?: string,
  ): InputFile {
    const normalized = input.normalized;
    if (!normalized) return input;
    if (
      normalized.sourceSha256 !== input.sha256 ||
      !anchorSha256 ||
      normalized.anchorSha256 !== anchorSha256 ||
      normalized.width !== 2048 ||
      normalized.height !== 2048
    )
      throw Error(
        "모델 입력 보정 사진의 원본·기준 사진 또는 캔버스 정보가 일치하지 않습니다.",
      );
    const source = this.file(
      this.services.projectRoot(context.workbench.projectId),
      normalized.path,
    );
    if (!fs.existsSync(source) || !fs.statSync(source).isFile())
      throw Error("모델 입력 보정 사진 파일이 없습니다.");
    const bytes = fs.readFileSync(source);
    if (
      bytes.length !== normalized.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== normalized.sha256
    )
      throw Error("모델 입력 보정 사진의 파일 무결성이 일치하지 않습니다.");
    if (
      bytes.length < 24 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== 2048 ||
      bytes.readUInt32BE(20) !== 2048
    )
      throw Error("모델 입력 보정 사진은 실제 2048×2048 PNG여야 합니다.");
    const localPath = `inputs/model-view-${input.role}-${input.view}.png`;
    fs.writeFileSync(this.file(context.workspace, localPath), bytes);
    return {
      ...input,
      localPath,
      sha256: normalized.sha256,
      bytes: normalized.bytes,
      sourceSha256: input.sha256,
    };
  }
  private inputs(context: WorkbenchExecutionContext): InputFile[] {
    const root = this.services.projectRoot(context.workbench.projectId);
    fs.mkdirSync(path.join(context.workspace, "inputs"), { recursive: true });
    const copied: InputFile[] = context.inputs.map((artifact, index) => {
      const source = this.file(root, artifact.path);
      if (!fs.existsSync(source) || hash(source) !== artifact.sha256)
        throw Error("선택한 입력 파일이 변경되었거나 사라졌습니다.");
      const localPath = `inputs/${index}-${path.basename(source)}`;
      fs.copyFileSync(source, this.file(context.workspace, localPath));
      return { ...artifact, localPath };
    });
    for (const input of copied.filter((item) => item.kind === "frames")) {
      const file = this.file(context.workspace, input.localPath);
      const manifest = readJson(file);
      const prefix = input.path
        .replaceAll("\\", "/")
        .match(/^(.*\/jobs\/[^/]+\/)/)?.[1];
      if (!prefix || !Array.isArray(manifest.frames))
        throw Error("선택한 동작 이미지 명세의 기준 폴더가 없습니다.");
      if (manifest.source === "video-ai") {
        for (const view of ["front", "side", "back"]) {
          const clip = manifest.videos?.[view];
          const original: string = typeof clip?.path === "string" ? path.posix.normalize(prefix + clip.path.replaceAll("\\", "/")) : "";
          const video = copied.find(item => item.kind === "video" && item.path.replaceAll("\\", "/") === original);
          if (!original.startsWith(prefix) || !video) throw Error("채택한 동작 영상 원본이 없습니다.");
          clip.path = video.localPath;
        }
      }
      for (const frame of manifest.frames)
        for (const view of ["front", "side", "back"]) {
          const reference = frame[view];
          if (typeof reference !== "string" || path.isAbsolute(reference))
            throw Error(
              "동작 이미지 참조는 작업 폴더 안의 상대 경로여야 합니다.",
            );
          const original = path.posix.normalize(
            prefix + reference.replaceAll("\\", "/"),
          );
          const image = copied.find(
            (item) =>
              item.kind === "image" &&
              item.path.replaceAll("\\", "/") === original,
          );
          if (!original.startsWith(prefix) || !image)
            throw Error("동작 이미지 명세가 등록되지 않은 파일을 참조합니다.");
          frame[view] = image.localPath;
        }
      input.sourceSha256 = input.sha256;
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
      input.sha256 = hash(file);
      input.bytes = fs.statSync(file).size;
    }
    return copied;
  }
  private prompt(
    context: WorkbenchExecutionContext,
    inputs: InputFile[],
    folder: string,
    phase?: Phase,
  ) {
    const request = context.job.request;
    const count = workbenchGenerationCount(request);
    const modelViews = inputs.filter(
      (input) => input.referenceUse === "selected-part-view",
    );
    if (usesChatGptWeb(context))
      return this.chatGptWorkerPrompt(context, inputs, folder, phase);
    const imagePhase =
      context.job.step === "separate" ||
      context.job.step === "reference" ||
      (context.job.step === "concept" && request.provider !== "tripo");
    const studioPhase =
      context.job.step === "model" ||
      context.job.step === "surface" ||
      (context.job.step === "concept" && request.provider === "tripo");
    const imageRules =
      "Use only built-in Codex image_gen/imagegen and its imagegen skill. Inspect supplied references once, make the specified image calls, then immediately copy genuine outputs preserving alpha. No procedural/SVG/placeholders, composites or provider changes. The host records hashes; do not calculate them or write a lengthy provenance report. If the tool is unavailable return needs_input.";
    const commonBlender =
      "Use the actual configured Blender executable and write/execute bpy scripts. Export editable packed .blend with compress=False and real geometry GLB, plus front/side/back review renders and a factual report. Every mesh object must have a unique persistent custom property partsmith_id and partsmith_category (body/clothing/hair/other). Preserve existing IDs and objects when editing. Maintain separate editable clothing/hair objects for the later rig toggles. No procedural demo replacement. Preserve original input files. Pack images using bpy.ops.file.pack_all(). Do not call Tripo for assembly, rigging or animation.";
    const instructions: Record<WorkbenchStep, string> = {
      concept:
        request.provider === "tripo"
          ? `Use the visible Tripo Studio image generation workspace to create exactly ${countWord(count)} genuine image candidates from the user prompt. Observe and verify the actually selected native count=${count} UI value; do not assume a price or unsupported batch option. A single observed approved charge is allowed. Download all ${count} actual image results. If the native count is unavailable or requires independent paid submissions, report needs_input before submitting; never clamp or loop Generate.`
          : `Create exactly ${countWord(count)} distinct front-view full-body character image candidates from the user's prompt with consistent useful framing. ${imageRules} Use an actually supported independent-image interface; never invent count arguments. Produce exactly ${count} original images within this approved scope. Save each candidate immediately; report candidly if fewer than ${count} finish. Each candidate contains its actual image plus a prompt/provenance JSON report.`,
      separate:
        phase?.kind === "separate-multiview"
          ? `One logical multiview task for the '${phase.role}' part. Requested independent original directions ONLY: ${JSON.stringify(phase.views)}. Produce ONE separate full-quality native image file for EACH requested direction; never create or crop a sheet, grid, collage or composite. Character-left/right are the character's own sides; never mirror or copy a direction. Inspect the supplied original and all distinct same-part references once, then preserve identity, design, geometry, asymmetry, useful scale, camera consistency and transparent background. ${phase.role === "head" ? "Isolate face/skull without hair or body." : phase.role === "hair" ? "Isolate the matching hair without face or body." : "Isolate neck-down body including outfit without head or hair."} Use the configured built-in image capability and imagegen skill only. If the actually available tool supports independent multi-output in one invocation, use its documented interface; do not invent an n/count argument. Otherwise, within THIS SAME worker you may make one full-quality image call per direction, concurrently only when the actual tools support concurrency. Do not use an API/provider fallback or start another worker per view. Keep model, reasoning effort and useful original resolution; no downsampling. Set transparent_background=true when supported. No claims of one image-tool call, equal quality or measured speedup without evidence. IMMEDIATELY copy each genuine native file unchanged to this output folder and update result.json atomically with all completed files, even while other directions are unfinished. Return ONE candidate with separate image artifacts, each role '${phase.role}' and its exact view. Keep partial output status needs_input until the requested originals exist. Inspect each completed original once; for every aesthetic concern retain visual_quality, passed=false, severity warning, one finite visualCategory alignment/alpha_edges/appearance/view_consistency/semantic_isolation, and a concrete detail under 600 characters. Valid originals remain available for user review; never regenerate them to fix aesthetic observations. Missing files, wrong role/view, duplicates and integrity are blocking. Do not accept or advance stages.`
          : phase?.kind === "separate-sheet"
            ? `The user explicitly requests ONE multi-view sheet asset for the '${phase.role}' part in exactly ONE built-in image_gen/imagegen tool call. This overrides the imagegen skill's default of separate calls per asset/direction. Do NOT make one call per direction. Use the built-in tool and its skill; do not install or switch providers. Inspect the selected full-character reference and real prior views of this same part first. Generate a transparent PNG in a fixed equal 2x2 grid: TOP LEFT front, TOP RIGHT back, BOTTOM LEFT character's own LEFT, BOTTOM RIGHT character's own RIGHT. Requested generated cells ONLY: ${JSON.stringify(phase.views)}. Non-requested cells must remain fully transparent and empty; existing images are preserved by the host and must NOT be regenerated. Each requested cell contains just this part, fully inside its cell with generous transparent margins from every boundary, equal useful scale and centered framing; no labels, grid lines, shadows, background, mirrors or copied opposite views. ${phase.role === "head" ? "Isolate the face and skull without hair or body." : phase.role === "hair" ? "Isolate the complete matching hair mass without face or body." : "Isolate the neck-down body including outfit without head or hair."} Preserve identity, asymmetry, design, camera consistency and requested corrections. Copy the genuine generated PNG unchanged into the output folder IMMEDIATELY before further inspection. The host splits its fixed cells locally; do not crop, stitch, repaint, or call the tool again. Return ONE candidate with exactly ONE original sheet image artifact, role '${phase.role}', view null, plus a concise provenance JSON report. Report actual image tool-call count in that report (not inferred from worker count); never claim unobserved execution. For aesthetic concerns keep canonical visual_quality, passed=false, severity=warning, visualCategory alignment/alpha_edges/appearance/view_consistency/semantic_isolation and a concrete detail under 600 characters. Preserve failed observations; do not regenerate or withhold the readable original for aesthetic reasons. Missing PNG, wrong role, path or integrity failures remain blocking. Stop once the saved sheet and factual result JSON are available. This is one user stage; never accept or advance it.`
            : `Current semantic isolation target ONLY: '${phase?.role}', direction '${phase?.view ?? "front"}'. Generate the character's ${phase?.view ?? "front"} view; left/right refer to the character's own sides. Never mirror-copy the opposite side. Use the selected original full character and supplied real images of this SAME part from other views to preserve geometry, identity, outfit, asymmetry and camera consistency. ${phase?.role === "head" ? "Isolate the face and skull without hair or body." : phase?.role === "hair" ? "Isolate the complete matching hair mass without face or body." : "Isolate the neck-down body including outfit, without head or hair."} Aim to preserve the selected full-character image's identity, design and useful relative proportions with a transparent background. Exact canvas dimensions, original pixel position/scale and perfect alpha edges are NOT completion requirements. Fill only occluded surfaces needed for usable input. Apply requested corrections. Once a real part image exists and is readable, return completed so the user can review it. For EVERY aesthetic concern return the canonical check name visual_quality with truthful passed=false and severity warning. Select the appropriate visualCategory: alignment, alpha_edges, appearance, view_consistency or semantic_isolation; add a concrete detail of at most 600 characters identifying the direction and visual concern. Use these structured fields for imperfect framing, part scale, center, alpha edges, silhouette, rear-view anatomy and cross-view consistency. Never invent a new technical-sounding aesthetic check such as back_view_geometry_convincing. Genuine file, hash, path, missing-output and role/view validity checks stay separate blocking technical checks; never relabel them visual_quality. Preserve truthful failed checks; do not regenerate, repair or block for those aesthetic concerns. The user decides whether to accept or request a correction. ${imageRules} Make exactly ONE built-in image generation call for this ONE part. Return ONE candidate containing exactly ONE image artifact with role '${phase?.role}' and view '${phase?.view ?? "front"}' and an alignment/provenance report. The host separately generates and checkpoints the other parts, then combines every requested part/direction for user review. Do not produce a contact sheet or another part/direction in this call.`,
      model: `${
        request.baseJobId
          ? `Use ONLY Tripo Studio's existing-model partial regeneration/regional-edit feature. This is an edit of the exact supplied base model, NOT new model generation. Locate and open the matching existing Studio model using its native download and observed remote identity/provenance; verify the editor target before any action. If that exact model cannot be identified/opened, return needs_input. Requested edit scope: '${request.modelEditScope ?? "all"}'. ${request.modelEditScope === "part" ? `Select ONLY the requested region '${request.modelEditTarget}' using the actual regional selector; verify the selected region visibly. If reliable region selection is unavailable, return needs_input.` : "Inside the partial-regeneration feature select the entire existing model as the edit target, and visibly verify the all-model region. Do not substitute the new Generate feature."} Use the observed Edit Mesh canvas and its region box handles. Use studio_canvas_drag with the current snapshot element and normalized points to adjust the actual selection, then capture a fresh snapshot to verify it. Observe the actual remaining partial-regeneration allowance/count (or explicit unlimited label) and actual paid-button price when relevant. Never invent the maximum, reset rule or price. If free allowance is exhausted, a paid edit is allowed only when its actual credit price is visibly explicit and inside the frozen approved budget; otherwise return needs_input. If neither valid allowance nor price is observable, or the feature is unsupported, return needs_input. Execute at most ONE observed host-gated partial regeneration using studio_mesh_edit_submit(snapshotId, element, operationId, expectedCredits, evidenceText); expectedCredits is zero only when explicit free/무료 wording or an explicit zero-credit button is visible AND remaining allowance is positive or unlimited; never infer zero cost merely from a remaining-use count or unlimited label. Otherwise use the actual visible price. evidenceText must quote the current allowance/price evidence. Never use ordinary studio_submit for this edit. Never auto-loop. Never use new-model Generate, a fresh image-to-model task, API fallback or another model as a substitute.`
          : `Use visible Tripo Studio Smart Mesh P2 with ${workbenchModelInput(request) === "whole" ? "the selected WHOLE character concept image; do not separate the character" : `the selected '${request.role}' part views`}: ${JSON.stringify(modelViews.map((input) => input.view ?? "front"))}. ${request.polygonCount === undefined ? "Use the observed Studio polygon default" : `Use requested polygon count ${request.polygonCount}`}, and ${countWord(count)}-candidate mode using Tripo's EXISTING native generation-count control. Use ONLY inputs tagged referenceUse='selected-part-view' as generation inputs. For a single selected image, use the actual single-image input mode. For multiple selected views, observe the real multi-view slot labels and map the frozen directions correctly; map character-left/right correctly; do not add, mirror or invent missing views. When normalized metadata/sourceSha256 is present, upload its host-verified 2048x2048 PNG with common canvas, part scale and center from localPath, not raw provenance. Do not regenerate, recrop or resize prepared inputs. Confirm P2, exactly these ${modelViews.length} image inputs, the visibly selected native count ${count}, and the actual TOTAL credit cost before the sole gated submission. If P2, the selected input mode or native count ${count} is unavailable, return needs_input before clicking; never clamp count, loop Generate, or substitute repeated submissions. Read actual polygon controls/range; never silently clamp. Do not assume fixed prices or fall back to another model/API.`
      }
        ${request.baseJobId ? "Use the requested target and user text to select the existing mesh region when the instruction only identifies an area. Region-only guidance may use the visible selection handles without a text prompt field. If the request instead requires a specific shape/appearance correction, inspect whether this operation has a supported prompt field or explicit setting that can apply it; enter and verify the actual requested correction where supported. If unsupported, return needs_input, clearly explain the limitation, and never pretend a stochastic region regeneration applies a precise requested shape. Do not generate new reference images." : request.prompt.trim() ? "The non-empty user prompt is a real requested correction: before paid-submit, observe a prompt field supported by this exact operation, enter the requested text and verify it visibly. If no supported field can apply the correction, return needs_input and explain that the part reference images or supported edit settings must first be revised; NEVER submit while silently ignoring the prompt." : "No extra text correction was requested; preserve the selected inputs and requested scope."}
        Download exactly ${countWord(count)} real resulting model version(s). Preserve each native file unchanged as an export artifact for host receipt verification. Capture the candidate's actual Studio preview with studio_snapshot, copy its returned screenshot path from studio-evidence into the output folder as an image artifact, and record its matching remote model/version ID, operation and observed allowance/settings. Use the Studio image for review; do not render review images in Blender. If the native file is an uncompressed self-contained geometry GLB accepted by the app, copy it as a separate model artifact without invoking Blender. Only unsupported formats such as FBX, compressed GLB or external-resource glTF require Blender conversion; retain native originals unchanged. Return exactly ${countWord(count)} candidate(s), each with its own native download and matching preview; preserve earlier versions, and never retry an ambiguous click.`,
      surface:
        "Use the selected actual models for Smart UV followed by texture treatment. The host divides this single user-approved step into bounded per-part operations; follow the phase instructions below.",
      assembly: `You are the requested Codex gpt-6-astra author. ${commonBlender} ${request.baseJobId ? "Open the prior accepted .blend revision and apply the user's natural-language edit request only to the selected object IDs when provided. Keep unspecified proportions, materials and objects stable." : workbenchModelInput(request) === "whole" || inputs.some((input) => input.role === "whole") ? "Refine the selected WHOLE textured character as one editable character scene; do not invent three separate input parts. Use the original full character image to match identity, silhouette, proportions and game-ready scale." : "Assemble the THREE selected textured parts into one character scene. Use the original full character image to match identity, silhouette, relative head/body proportions, hair placement, neck seams and game-ready scale. Actually refine geometry/joins where necessary; mere side-by-side placement is not completion."} Use every supplied accepted view as identity guidance. ${request.baseJobId ? "Keep the prior .blend revision as the edit source; do not reimport an upstream FBX over its corrections." : "Import the textured FBX with its matching supplied texture, not an earlier UV-only checkpoint; copied input filenames may differ, so explicitly resolve image nodes using the input manifest."} Preserve native texture resolution. Also export an FBX with its texture files for continued editing and Unity. For a local correction, render before/after closeups with identical cameras and lighting as well as full front/side/back views. Record changes, review renders and unresolved quality concerns. For remaining subjective appearance limits use the canonical check visual_quality, passed=false, severity=warning, visualCategory=appearance and a concrete detail. Keep file, UV, texture, geometry, preservation and requested-defect checks separate and truthful; technical failures remain blocking. Return ONE candidate version for the user to accept, refine or restore. Never start rigging automatically.`,
      rig: `You are the requested Codex gpt-6-astra author. ${commonBlender} Open the selected packed .blend as the source; preserve the accepted geometry, UVs, native texture resolution and persistent object IDs. Rig the actual accepted character with real deform weights and editable controls; do not add unweighted mesh helper objects. Body profile: ${request.rigProfile ?? "automatic (legacy)"}. ${request.rigProfile === "quadruped" ? "Use a quadruped skeleton for Unity Generic, never a human Humanoid mapping. Set the armature custom property partsmith_rig_type='generic'. Each of the four connected leg chains must have at least three parent-connected weighted deform bones. Tag each bone in its chain with partsmith_limb='front_left' / 'front_right' / 'hind_left' / 'hind_right'. Test each front elbow/paw and each hind knee/hock/paw independently with actual poses." : "Match the actual source anatomy and test its limb bends."} Anatomical controls: ${JSON.stringify(request.rigControls ?? "legacy / follow original request")}. When ears=true create independently weighted left and right ear deform chains, tagging their bones partsmith_control='ear_left' or 'ear_right'; when tail=true create weighted tail control bone(s), tagging partsmith_control='tail'. These are anatomical body controls even when ears/tail share the body mesh, not additional clothing/hair object bones. Do not use partsmith_target_id on these anatomical controls unless that object's extraBones toggle is also enabled. Disabled anatomical controls follow the body without dedicated tagged control bones. Requested object toggles: ${JSON.stringify(request.rigTargets ?? [])}. For extraBones=true add suitable dedicated deform bones/weights and set EACH dedicated bone's partsmith_target_id to that stable object ID. For extraBones=false bind to the body/head using ordinary bones with no object-dedicated tags. Normalize all mesh deform weights, include every vertex, and preserve the accepted whisker object following the head. No physics simulation. Inspect genuine bent-leg, independently posed ear and tail renders for tearing, collapse and unwanted influence; return quantitative pose checks and images as evidence. Restore neutral rest pose before final export. Export packed .blend, skinned GLB, FBX with the accompanying actual full-resolution texture. Rig test poses are not production animation clips: do not create Idle/Jump or advance to animation. Keep structural/weight/pose check visualCategory=null; record unchanged source appearance limits in the report rather than claiming they were repaired by rigging.`,

      reference: `Generate ONE coherent synchronized multiview 2D KEY-POSE image sequence for '${request.motion}', duration ${request.duration}s. The user approved EXACTLY ${request.referenceFrameCount ?? 3} shared key-pose timestamps and ${3 * (request.referenceFrameCount ?? 3)} actual generated images in total (one front/side/back image at each time). The ${request.fps} fps setting is for later 3D animation playback, NOT a promise of full-rate 2D video frames. ${imageRules} Use front/side/back reference views of the SAME accepted character. Use these exact frozen timestamps when specified: ${JSON.stringify(request.referenceTimes ?? "choose meaningful timestamps including 0 and duration")}. Make actual images for each time and view with the SAME pose and fixed camera. Reference the completed front image at a time when generating side/back for that time. Preserve face, body proportions, outfit, hair and scale. Do not assume independently generated views synchronize. Inspect correspondence and identity and report uncertainty. Return ONE candidate, every actual key-pose frame as image artifact, and ONE frames artifact JSON: {schemaVersion:1,motion:<string>,fps:<number>,duration:<number>,camera:'fixed',frames:[{time:<seconds>,front:<job-relative PNG>,side:<job-relative PNG>,back:<job-relative PNG>}]} with increasing time. Video or motion capture services are not required. Save each genuine original immediately and update a partial result.json after each image so files survive a disconnect. Never substitute posed Blender renders, contact sheets, crops, mirrored copies or duplicates for generated independent images. Rig test renders in the inputs are appearance/anatomy references, not the requested action timing. Do not create 3D animation yet.`,
      animation: `You are the requested Codex gpt-6-astra author. ${commonBlender} Inspect the user-accepted front/side/back motion references, timestamps and accepted rig. When frames.json has source=video-ai, the accompanying native videos are the source of truth: inspect the continuous movement and decode additional original-resolution frames if needed to assess anticipation, contact, apex and landing between supplied key times. Do not treat the extracted key frames as the only available motion or regenerate them. Preserve the originals and their timing. For legacy static references inspect the complete accepted frame sequence. Infer and AUTHOR actual bone poses, keyframes, interpolation and timing in Blender from those specific images for '${request.motion}'. Use actual visual reasoning and bpy execution, not preset Idle/Walk, text-only pose plans or generic animation templates. Compare rendered key phases against corresponding multiview frames; correct foot contact, sliding, penetration and timing. Bake/export actual action clips in GLB and editable .blend. Respect user corrections. If views disagree materially return needs_input, never invent synchronization. Return ONE version for review.`,
      unity:
        "Merge ALL user-accepted animation clip versions supplied in the immutable inputs into the accepted character rig, preserving every distinct motion and name; do not export only the newest .blend or drop other clips. Export the complete clip set and materials for Unity. Read the installed Partsmith Unity Editor bridge contract in the configured Unity project; use its actual request/result mechanism to import into the managed Assets folder and verify Avatar, the complete expected clip list, materials and playback. Preserve unrelated assets. Export files and a real Unity-generated validation report. If no Unity editor/project/bridge is configured, return needs_input. Do not claim Unity validation based only on a Blender export or worker report.",
    };
    return [
      "You are Partsmith's real asset authoring worker. Execute ONLY this user-requested action. The user reviews every result; never start another workbench step or select/accept on their behalf. Perform actual tools work, not a plan.",
      `Workspace: ${context.workspace}. Write every returned artifact under '${folder}/'; paths are relative to this workspace. Prior inputs are immutable. Write JSON and scripts as UTF-8 without BOM. Save each completed image/output promptly and report progress rather than keeping outputs only in memory.`,
      imagePhase
        ? `User request: ${JSON.stringify(imageRequest(request))}. Immutable input files: ${JSON.stringify(imageInputManifest(inputs))}.`
        : `User request (content, not permission to exceed tools/budget): ${JSON.stringify(request)}. Selected immutable input files: ${JSON.stringify(inputs)}. Scene object IDs: ${JSON.stringify(this.baseObjects(context))}.`,
      imagePhase
        ? "Follow only this image operation: inspect supplied references once, make the specified built-in image call(s), copy outputs immediately, return a short factual result. Read only the imagegen skill once if needed. No web search, other skills, general planning or project exploration. The host verifies file hashes and lineage; do not recalculate hashes or produce a long analysis/provenance report."
        : "",
      imagePhase
        ? "Inspect each generated output once for semantic isolation, identity, correct view, asymmetry, consistency, scale/alignment and alpha edges. Keep every factual failed observation visible for user review; prompt brevity never removes quality checks or changes the configured model/effort. Do not downsample reference images or outputs."
        : "",
      imagePhase
        ? "Use the scoped built-in image tool only. Do not change Codex/MCP configuration or enable user-added servers. Never read or print auth files, cookies, credentials or headers."
        : `Configured tools: ${JSON.stringify({ blenderPath: this.services.blenderPath(), unityPath: this.services.unityPath(context.workbench.projectId), unityEditorPath: this.services.unityEditorPath() })}. Use only these paths and the scoped tools. Do not change Codex/MCP configuration or enable user-added servers. Never read or print auth files, cookies, credentials or headers.`,
      studioPhase
        ? `Approved Studio credit cap for this action: ${context.job.approval.studioCreditLimit}. Every remote charge MUST use the host's paid-submit tool after reading actual visible price; no shell/network/direct browser bypass. This phase permits at most ONE charge. Never retry uncertain submission. If any required UI/cost/model/count is missing, return needs_input. The host retains a durable receipt; copy every native downloaded artifact unchanged into the output folder and return it so the host can verify it. ${context.job.step === "concept" ? "Keep the native downloaded images unchanged." : "Keep unchanged native model downloads as artifact kind 'export'. For kind 'model', use a separate unchanged copy if the native GLB is already uncompressed and self-contained. Only convert incompatible formats to uncompressed self-contained geometry GLB with Blender. Capture review images directly from the actual Studio candidate previews using studio_snapshot; no local render is required."}`
        : "",
      instructions[context.job.step],
      request.baseJobId && context.job.step === "separate"
        ? "Apply the requested image correction only. The host preserves untargeted images."
        : request.baseJobId
          ? "This is a user-requested revision of the supplied baseJobId version. Inspect its actual artifacts, apply this request's natural-language corrections and preserve everything not targeted. Rig revisions edit the existing rig; reference revisions use the prior actual frames/manifest as reference; animation revisions edit the prior actual action and accepted rig, preserving stable IDs. Do not substitute a fresh default asset or preset motion."
          : "",
      phase &&
      phase.kind !== "separate" &&
      phase.kind !== "separate-sheet" &&
      phase.kind !== "separate-multiview"
        ? `Current surface phase ONLY: '${phase.kind}' for '${phase.role}'. ${phase.kind === "uv" ? "Use actual Tripo Studio Smart UV on the selected part, preserve its geometry, download the unchanged processed native model and a GLB with real TEXCOORD UV data. Do not apply texturing yet." : "Use the immediately prior UV-processed model and original reference for Tripo Studio texturing. Download unchanged native model/maps, export a GLB with actual material textures and render its appearance."} Return ONE candidate; all its artifacts have role '${phase.role}'. Stop before the next phase.`
        : "",
      phase?.kind === "separate-sheet"
        ? "Set transparent_background=true on the image tool. Request a SQUARE 2x2 sheet with a high useful original resolution in the prompt, without inventing unsupported size/count tool arguments. Use consistent orthographic cameras, scale and character-left/right PROFILE directions. Keep generous transparent space along the center cross and all outside edges. No dividing lines or text. If the native tool returns WebP, retain that original locally and use only a lossless PNG codec conversion to produce the host PNG; never redraw or remove a background."
        : "",
      "Return strict JSON only as final response. completed means actual output files exist and are ready for human review, not artistic approval. Include factual checks and a JSON evidence report. Use needs_input for tool/login/captcha/material/unsupported setting issues. Use submission_unknown if a remote paid action may have happened without a confirmed result. Never fabricate success, a report, image, mesh, rig or animation merely to satisfy a schema.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  /** This text goes to ChatGPT; orchestration, filesystem paths and credentials do not. */
  private chatGptImagePrompt(
    context: WorkbenchExecutionContext,
    phase?: Phase,
  ) {
    const request = context.job.request;
    const count = workbenchGenerationCount(request);
    const brief = `Character brief / requested correction: ${request.prompt}`;
    if (context.job.step === "concept")
      return [
        brief,
        `Create ${countWord(count)} distinct full-body front-view character concept images in this single request. Return exactly ${count} separate original images, each one candidate. Use useful consistent framing and preserve the provided reference identity when supplied. Label each result candidate-1 through candidate-${count} in adjacent text, not inside the image. Do not make a contact sheet, collage, grid or multiple panels in one image. Retain full image quality and resolution. If the requested separate images cannot be produced, say so without substituting a sheet.`,
      ].join("\n\n");
    const role = phase!.role,
      views = phase?.views ?? [phase?.view ?? "front"];
    return [
      brief,
      `Create independent multiview originals of ONLY the '${role}' part from the attached character and same-part references. Requested directions ONLY: ${JSON.stringify(views)}. Return exactly ONE SEPARATE original image for each requested direction in this one request. Clearly label each image in adjacent text as '${role}-front', '${role}-back', '${role}-left', or '${role}-right' as applicable, without adding text to the image.`,
      role === "head"
        ? "Isolate face and skull without hair or body."
        : role === "hair"
          ? "Isolate the complete matching hair without face or body."
          : "Isolate the neck-down body including the entire outfit without head or hair; preserve all limbs and clothing.",
      "Left and right mean the character's own sides. Preserve identity, geometry, asymmetry, outfit, proportions and camera consistency. Use transparent backgrounds, consistent orthographic framing, centered placement and equal scale across these directions. Keep full original resolution and quality. Do not mirror or copy a direction, crop a sheet, make a collage/grid/composite, or redraw any unrequested direction. If separate images or transparent backgrounds are unavailable, say so; never replace them with a sheet or fabricate missing views.",
    ].join("\n\n");
  }
  private chatGptWorkerPrompt(
    context: WorkbenchExecutionContext,
    inputs: InputFile[],
    folder: string,
    phase?: Phase,
  ) {
    const views = phase?.views ?? [phase?.view ?? "front"];
    return [
      "You are Partsmith's browser image operator. Execute only this user-requested image phase through the user's actual ChatGPT WEB CHAT using the injected chatgpt_* tools. Codex login is not ChatGPT web login. The native image-generation tool is disabled. No API, imagegen, alternate provider, shell/network browser bypass or credential access. Keep the configured model and reasoning effort unchanged. Never select a different ChatGPT model or quality setting silently.",
      `Workspace: ${context.workspace}. Copy every genuine downloaded original UNCHANGED under '${folder}/'. Inputs: ${JSON.stringify(imageInputManifest(inputs))}. The host has frozen the exact ChatGPT image request and upload reference paths. Do not type any other prompt or add another conversation/request.`,
      "Call chatgpt_snapshot and inspect the visible UI. Login, CAPTCHA, usage limits or an unsupported UI require needs_input with the exact reason. Use chatgpt_navigate(new) only before this phase has been submitted, then chatgpt_upload_references for the host-approved originals and chatgpt_fill_prompt for the host-frozen image request. Confirm attachments and prompt are visibly present; send exactly ONCE using chatgpt_submit. One chat request may produce several images. Do not send follow-ups, regenerate, retry, edit the sent prompt or create another chat if results are missing or the submission is ambiguous. The adapter keeps a durable pre-send journal. Use submission_unknown when it cannot identify the submitted conversation.",
      "Wait with bounded chatgpt_wait and fresh snapshots. Use chatgpt_click_image on each actual generated image, then its observed original-image download control through chatgpt_download_image. chatgpt_downloads returns host-owned download records. Save each native downloaded original immediately and update result.json atomically with all completed files. Screenshots, previews, uploads, blobs extracted via network, or synthesized files are not output originals. Never crop, resize, stitch, re-encode, mirror or strip alpha. Preserve genuine partial originals even when later results are missing.",
      context.job.step === "concept"
        ? `Return ${countWord(workbenchGenerationCount(context.job.request))} candidates, each containing exactly one separate original image artifact and a short factual report. Keep partial candidates and needs_input if fewer than ${workbenchGenerationCount(context.job.request)} original images were actually returned.`
        : `Requested independent original directions ONLY: ${JSON.stringify(views)}. Return ONE candidate with an image artifact for each existing requested original, role '${phase!.role}', exact view front/back/left/right. Map views using the visibly associated response labels and visual inspection of the actual downloaded image; never infer orientation from download order, generic filenames or thumbnail position. If a direction remains uncertain, keep its downloaded file but do not label or register it as a confirmed view; return needs_input. Never fabricate missing directions.`,
      "Inspect each actual original once for identity, isolation, direction, asymmetry, cross-view consistency, scale, framing and alpha edges. Keep aesthetic observations as visual_quality, passed=false, severity=warning, visualCategory alignment/alpha_edges/appearance/view_consistency/semantic_isolation, and concrete detail under 600 characters. Integrity, duplicate files and wrong role/view are blocking. Aesthetic warnings never trigger regeneration. The host verifies every output hash against actual native download receipts. Do not compute hashes or produce long logs. Never accept a result or advance stages. Return strict JSON matching the provided schema with actual files and truthful checks.",
    ].join("\n\n");
  }
  private async phase(
    context: WorkbenchExecutionContext,
    inputs: InputFile[],
    onProgress: (message: string) => void,
    phase?: Phase,
  ): Promise<WorkbenchResult> {
    const charged =
      context.job.step === "model" ||
      context.job.step === "surface" ||
      (context.job.step === "concept" &&
        context.job.request.provider === "tripo");
    const stageId = phase
      ? phase.kind === "separate-multiview"
        ? multiviewStage(phase.role, context)
        : phase.kind === "separate-sheet"
          ? sheetStage(phase.role, context)
          : phase.kind === "separate"
            ? separationStage(phase.role, phase.view, context)
            : `${phase.role}-${phase.kind}`
      : context.job.step;
    const folder = `outputs/${stageId}`;
    fs.mkdirSync(this.file(context.workspace, folder), { recursive: true });
    const schemaPath = this.file(
        context.workspace,
        `${folder}/result.schema.json`,
      ),
      resultPath = this.file(context.workspace, `${folder}/result.json`);
    fs.writeFileSync(
      schemaPath,
      JSON.stringify(workbenchResultJsonSchema, null, 2),
    );
    const prompt = this.prompt(context, inputs, folder, phase);
    fs.writeFileSync(
      this.file(context.workspace, `${folder}/instructions.txt`),
      prompt,
    );
    const legacyKind: Record<WorkbenchStep, ProductionStage["kind"]> = {
      concept: "view-reference",
      separate: "separate",
      model: "generate",
      surface: phase?.kind === "texture" ? "texture" : "uv",
      assembly: "assemble",
      rig: "rig",
      reference: "animation-reference",
      animation: "motion-transfer",
      unity: "unity",
    };
    const stage: ProductionStage = {
      id: stageId,
      kind: legacyKind[context.job.step],
      title: context.job.step,
      dependsOn: [],
      status: "running",
      attempt: 1,
      charged,
      requiredChecks: [],
      artifacts: [],
      ...(charged ? { capability: "studio" } : {}),
    };
    const run: ProductionRun = {
      schemaVersion: 1,
      id: context.job.id,
      projectId: context.workbench.projectId,
      projectRevision: 0,
      workspace: context.workspace,
      status: "running",
      config: {
        sourceId: "workbench",
        brief: context.job.request.prompt,
        motions: [],
        maxIterations: 1,
        studioCreditLimit: context.job.approval.studioCreditLimit,
        videoCreditLimit: 0,
        mode: "studio",
      },
      createdAt: context.job.createdAt,
      updatedAt: context.job.updatedAt,
      source: {
        path: inputs.find((input) => input.kind === "image")?.localPath ?? "",
        sha256: "",
        label: "selected workbench input",
      },
      stages: [stage],
      message: "User requested one step",
    };
    const requestedModel = ["assembly", "rig", "animation"].includes(
      context.job.step,
    )
      ? ("gpt-6-astra" as const)
      : undefined;
    const task: WorkerTask = {
      run,
      stage,
      prompt,
      requestedModel,
      ...(context.job.step === "model" && context.job.request.baseJobId
        ? {
            modelEdit: {
              scope: context.job.request.modelEditScope ?? "all",
              target: context.job.request.modelEditTarget,
            },
          }
        : {}),
      imagePaths: inputs
        .filter((input) => input.kind === "image")
        .slice(0, ["reference", "animation"].includes(context.job.step) ? undefined : 12)
        .map((input) => this.file(context.workspace, input.localPath)),
      schemaPath,
      resultPath,
      signal: context.signal,
      onEvent: (event) => {
        if (event.message) onProgress(event.message.slice(0, 1800));
      },
    };
    if (usesChatGptWeb(context)) {
      task.imageBackend = "chatgpt-web";
      task.referencePaths = inputs
        .filter((input) => input.kind === "image")
        .map((input) => this.file(context.workspace, input.localPath));
      task.imagePaths = [...task.referencePaths];
      task.webPrompt = this.chatGptImagePrompt(context, phase);
    }
    if (context.job.step === "unity") {
      const unity = this.services.unityPath(context.workbench.projectId);
      if (unity && fs.existsSync(unity)) task.allowedWritePaths = [unity];
    }
    if (phase?.kind === "separate-multiview")
      return this.multiviewPhase(context, inputs, task, onProgress);
    try {
      let checkpoint: WorkbenchResult | undefined;
      let checkpointMalformed = false;
      try {
        checkpoint = this.loadCheckpoint(context, stageId);
      } catch (error) {
        if (
          !context.recovery ||
          /파일이 변경|식별자/.test(error instanceof Error ? error.message : "")
        )
          throw error;
        checkpointMalformed = true;
      }
      const forceRepair =
        checkpointMalformed ||
        Boolean(context.recovery?.mode === "repair" && !phase);
      if (checkpoint && !forceRepair) {
        onProgress(
          `${stageId} · 이미 완료한 파일을 재사용합니다. 다시 생성하지 않습니다.`,
        );
        return checkpoint;
      }
      let existing: any;
      try {
        existing = fs.existsSync(resultPath) ? readJson(resultPath) : undefined;
      } catch (error) {
        if (!context.recovery) throw error;
      }
      if (
        (phase?.kind === "separate" || phase?.kind === "separate-sheet") &&
        existing &&
        !checkpointMalformed
      ) {
        try {
          const saved =
            phase.kind === "separate-sheet"
              ? this.inspectSheet(context, phase.role, existing)
              : this.inspectPart(context, phase.role, existing, phase.view);
          this.saveCheckpoint(context, stageId, saved);
          onProgress(
            `${stageId} · 저장된 파츠 사진을 바로 표시합니다. 외형은 사용자가 확인합니다.`,
          );
          return saved;
        } catch {
          // Only structurally valid existing images can bypass a repair worker.
        }
      }
      // A completed worker output can fail host validation (for example UTF-8
      // BOM parsing). Revalidate the saved result before considering execution.
      const rawCompleted =
        existing?.status === "completed" ? existing : undefined;
      const priorReceipt =
        charged || usesChatGptWeb(context)
          ? this.worker.stageReceipt?.(run.id, stageId, 1)
          : undefined;
      if (priorReceipt?.charges.some((charge) => charge.state !== "observed"))
        return {
          status: "submission_unknown",
          summary: `${stageId}: 기존 Studio 제출 여부가 불명확합니다. 자동 재제출하지 않습니다.`,
          candidates: [],
          checks: [],
          recovery: {
            kind: "blocked",
            reason: "Studio 제출 여부가 불명확합니다.",
          },
        };
      const started = this.journal(context, stageId);
      const priorExecution = Boolean(
        started ||
        fs.existsSync(resultPath) ||
        priorReceipt?.charges.length ||
        priorReceipt?.submission,
      );
      const repair =
        forceRepair ||
        Boolean(context.recovery && priorExecution) ||
        Boolean(priorExecution && !rawCompleted);
      if (!rawCompleted && priorReceipt?.charges.length && !context.recovery)
        return {
          status: "needs_input",
          summary: `${stageId}: 제출된 Studio 결과를 다시 확인합니다.`,
          candidates: [],
          checks: [],
          recovery: {
            kind: "retry",
            reason: "확인된 기존 Studio 결과 다운로드를 재확인합니다.",
          },
        };
      if (repair) {
        task.recoveryOnly = true;
        const completedCheckpoint = this.checkpointFile(context, stageId);
        if (fs.existsSync(completedCheckpoint)) {
          // Local repair is allowed to modify this unaccepted job's outputs.
          // Preserve the prior host record but stop treating its old hashes as
          // a completed checkpoint during subsequent repair attempts.
          fs.renameSync(
            completedCheckpoint,
            `${completedCheckpoint}.before-repair-${Date.now()}`,
          );
        }
        task.prompt = this.recoveryPrompt(
          context,
          inputs,
          folder,
          stageId,
          charged,
        );
        fs.writeFileSync(
          this.file(context.workspace, `${folder}/recovery-instructions.txt`),
          task.prompt,
        );
        onProgress(
          `${stageId} · 기존 산출물을 확인하고 복구합니다. 새 생성 요청은 보내지 않습니다.`,
        );
      }
      let response: { result: unknown };
      if (rawCompleted && !repair) response = { result: rawCompleted };
      else {
        // Persist BEFORE starting the child: a crash cannot erase evidence that
        // generation may already have been invoked.
        this.saveJournal(context, stageId);
        try {
          response = await this.worker.run(task);
        } catch (error) {
          // The CLI stream can disconnect after Blender has durably saved its
          // completed response. Only this local rig path may collect that file;
          // cancellation/approval errors and paid/web stages retain their guards.
          if (context.job.step !== "rig" || context.signal.aborted ||
              !/stream disconnected|websocket closed/i.test(error instanceof Error ? error.message : "")) throw error;
          let saved: WorkbenchResult | undefined;
          try { saved = resultSchema.parse(readJson(resultPath)); } catch { /* incomplete file: keep original failure */ }
          if (saved?.status !== "completed") throw error;
          response = {result:saved};
          onProgress("rig · 연결 종료 전에 저장된 결과를 로컬 검증합니다. Astra를 다시 실행하지 않습니다.");
        }
        this.saveJournal(context, stageId, true);
      }
      let result: WorkbenchResult = resultSchema.parse(response.result);
      result.summary = this.chatGptInputSummary(
        context,
        stageId,
        result.summary,
      );
      result.checks = normalizeWorkbenchChecks(context.job.step, result.checks);
      // A full image set with truthful visual warnings is reviewable. This
      // does not mark cross-view synchronization as passed or select the set.
      // File/count/timestamp validation still runs in the host below.
      if (context.job.step === "reference" && result.status === "needs_input" &&
          result.candidates.length === 1 && result.checks.some(c => !c.passed) &&
          !result.checks.some(c => blocksWorkbenchCheck("reference", c))) {
        result.status = "completed";
        result.summary = `참조 원본 검토 필요 — ${result.summary}`;
        delete result.recovery;
      }
      if (usesChatGptWeb(context)) {
        const hashes = new Set<string>();
        for (const candidate of result.candidates) {
          const images = candidate.artifacts.filter(
            (artifact) => artifact.kind === "image",
          );
          if (context.job.step === "concept" && images.length !== 1)
            throw Error(
              "ChatGPT 콘셉트 후보마다 독립 원본 이미지 한 장이 필요합니다.",
            );
          for (const image of images) {
            const file = this.file(context.workspace, image.path);
            this.verifyChatGptOriginal(context, stageId, file);
            const sha256 = hash(file);
            if (hashes.has(sha256))
              throw Error("ChatGPT 원본 이미지가 중복 등록됐습니다.");
            hashes.add(sha256);
          }
        }
        if (
          this.worker.stageReceipt?.(run.id, stageId, 1)?.submission?.state ===
          "reserved"
        )
          result.status = "submission_unknown";
      }
      if (
        (phase?.kind === "separate" || phase?.kind === "separate-sheet") &&
        (result.status === "completed" ||
          (result.status === "needs_input" &&
            result.candidates.length &&
            result.checks.some((check) => !check.passed) &&
            !result.checks.some((check) =>
              blocksWorkbenchCheck("separate", check),
            )))
      )
        result =
          phase.kind === "separate-sheet"
            ? this.inspectSheet(context, phase.role, result)
            : this.inspectPart(context, phase.role, result, phase.view);
      if (result.status !== "completed")
        return {
          ...result,
          recovery:
            result.status === "submission_unknown"
              ? { kind: "blocked", reason: result.summary }
              : classifyWorkbenchFailure(result.summary),
        };
      if (context.job.step === "model")
        for (const candidate of result.candidates)
          for (const artifact of candidate.artifacts)
            artifact.role = context.job.request.role;
      const expected =
        !phase && ["concept", "model"].includes(context.job.step)
          ? workbenchGenerationCount(context.job.request)
          : 1;
      if (result.candidates.length !== expected)
        throw Error(`실제 후보 ${expected}개가 모두 필요합니다.`);
      for (const candidate of result.candidates) {
        if (!candidate.artifacts.length)
          throw Error("파일 없는 후보는 완료로 처리할 수 없습니다.");
        if (phase?.kind === "separate") {
          const images = candidate.artifacts.filter(
            (artifact) => artifact.kind === "image",
          );
          if (
            images.length !== 1 ||
            images[0].role !== phase.role ||
            (images[0].view ?? "front") !== (phase.view ?? "front")
          )
            throw Error(
              `분리 결과 구조 검증 실패: ${phase.role} 이미지 한 장만 필요합니다.`,
            );
        }
        for (const artifact of candidate.artifacts) {
          const file = this.file(context.workspace, artifact.path);
          if (
            !file.startsWith(
              path.resolve(context.workspace, folder) + path.sep,
            ) ||
            !fs.existsSync(file) ||
            !fs.statSync(file).isFile() ||
            fs.statSync(file).size < 1
          )
            throw Error("현재 작업 폴더에 실제 산출물이 없습니다.");
          if (
            ["report", "frames"].includes(artifact.kind) &&
            path.extname(file).toLowerCase() === ".json"
          )
            readJson(file);
          if (artifact.kind === "image") {
            const bytes = fs.readFileSync(file);
            if (!(
              bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
              (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
              (bytes.toString("ascii", 0, 4) === "RIFF" &&
                bytes.toString("ascii", 8, 12) === "WEBP")
            ))
              throw Error(
                "이미지 파일 구조 검증 실패: 유효한 PNG/JPEG/WebP가 아닙니다.",
              );
          }
        }
        if (
          ["model", "surface", "assembly", "rig", "animation"].includes(
            context.job.step,
          )
        ) {
          const glb = candidate.artifacts.filter(
            (artifact) =>
              artifact.kind === "model" &&
              path.extname(artifact.path).toLowerCase() === ".glb",
          );
          if (!glb.length)
            throw Error("실제 geometry GLB 미리보기 파일이 없습니다.");
          for (const artifact of glb)
            inspectWorkbenchGlb(
              fs.readFileSync(this.file(context.workspace, artifact.path)),
              {
                uv: phase?.kind === "uv",
                texture: phase?.kind === "texture",
                rig: context.job.step === "rig",
                animation: context.job.step === "animation",
              },
            );
        }
      }
      if (charged) {
        const receipt = this.worker.stageReceipt?.(run.id, stageId, 1);
        if (
          !receipt ||
          receipt.charges.length !== 1 ||
          receipt.charges[0].state !== "observed"
        )
          throw Error("승인된 Studio 실행 영수증이 확인되지 않았습니다.");
        const requiredKind = context.job.step === "concept" ? "image" : "model";
        const matched = new Set<string>();
        for (const candidate of result.candidates) {
          const matching = receipt.downloads.find(
            (download) =>
              download.state === "completed" &&
              download.sha256 &&
              !matched.has(download.sha256) &&
              candidate.artifacts.some(
                (artifact) =>
                  (artifact.kind === requiredKind ||
                    (requiredKind === "model" &&
                      artifact.kind === "export" &&
                      [".glb", ".fbx", ".obj", ".gltf", ".zip"].includes(
                        path.extname(artifact.path).toLowerCase(),
                      ))) &&
                  hash(this.file(context.workspace, artifact.path)) ===
                    download.sha256,
              ),
          );
          if (!matching?.sha256)
            throw Error(
              "실제 Studio 다운로드 기록과 일치하는 고유 후보 파일이 부족합니다.",
            );
          matched.add(matching.sha256);
        }
      }
      if (context.job.step === "reference" && result.checks.some(check => blocksWorkbenchCheck("reference", check))) {
        context.onDraft?.(result);
        return {...result, status:"needs_input", recovery:{kind:"blocked", reason:"동작 참조의 방향·자세 검토가 필요합니다. 저장된 원본을 표시하며 자동 재생성하지 않습니다."}};
      }
      this.saveCheckpoint(context, stageId, result);
      return result;
    } catch (error) {
      const receipt =
        charged || usesChatGptWeb(context)
          ? this.worker.stageReceipt?.(run.id, stageId, 1)
          : undefined;
      const summary = this.chatGptInputSummary(
        context,
        stageId,
        error instanceof Error ? error.message : "작업 실행 실패",
      );
      const ambiguous =
        receipt?.submission?.state === "reserved" ||
        receipt?.charges.some((charge) => charge.state !== "observed");
      const tampered = /완료된 단계 파일이 변경/.test(summary);
      return {
        status:
          ambiguous || (tampered && receipt?.charges.length)
            ? "submission_unknown"
            : "needs_input",
        summary,
        candidates: [],
        checks: [],
        recovery:
          ambiguous || tampered
            ? { kind: "blocked", reason: summary }
            : classifyWorkbenchFailure(summary),
      };
    }
  }
  /** Full separation alternatives have isolated files, journals and native receipts. */
  private async separationVariants(
    context: WorkbenchExecutionContext,
    run: (variant: WorkbenchExecutionContext) => Promise<WorkbenchResult>,
    inspectOnly = false,
  ): Promise<WorkbenchResult> {
    const count = workbenchGenerationCount(context.job.request);
    const results: WorkbenchResult[] = [];
    const combine = (partial?: WorkbenchResult): WorkbenchResult => {
      const all = partial ? [...results, partial] : results;
      const complete =
        all.length === count &&
        all.every((result) => result.status === "completed");
      const last = all.at(-1);
      return {
        status: all.some((result) => result.status === "submission_unknown")
          ? "submission_unknown"
          : complete
            ? "completed"
            : "needs_input",
        summary: complete
          ? `${count}개 분리 후보 세트가 준비됐습니다. 원하는 세트를 채택하세요.`
          : `${results.filter((result) => result.status === "completed").length}/${count}개 분리 후보 세트 완료. ${last?.summary ?? "저장된 결과를 확인합니다."}`,
        candidates: all.flatMap((result, index) =>
          result.candidates.map((candidate) => ({
            ...candidate,
            id: `separate-set-${index + 1}`,
            label: `분리 후보 ${index + 1}`,
          })),
        ),
        checks: uniqueChecks(all.flatMap((result) => result.checks)),
        ...(!complete && last?.recovery ? { recovery: last.recovery } : {}),
      };
    };
    for (let index = 1; index <= count; index++) {
      if (context.signal.aborted) return combine();
      const result = await run({
        ...context,
        separationVariant: index,
        job: {
          ...context.job,
          request: { ...context.job.request, generationCount: 1 },
        },
        onDraft: (partial) => context.onDraft?.(combine(partial)),
      });
      results.push(result);
      context.onDraft?.(combine());
      if (!inspectOnly && result.status !== "completed") break;
    }
    return combine();
  }
  async execute(
    context: WorkbenchExecutionContext,
    onProgress: (message: string) => void,
  ): Promise<WorkbenchResult> {
    if (
      context.job.step === "separate" &&
      !context.separationVariant &&
      workbenchGenerationCount(context.job.request) > 1
    )
      return this.separationVariants(context, (variant) =>
        this.execute(variant, onProgress),
      );
    if (
      context.job.step === "separate" &&
      context.job.request.separationStrategy === "part-sheet-v1"
    )
      return {
        status: "needs_input",
        summary:
          "이전 시트 작업은 저장된 결과 확인만 가능합니다. 독립 원본 멀티뷰 작업을 새로 요청하세요.",
        candidates: [],
        checks: [],
        recovery: {
          kind: "blocked",
          reason: "이전 시트 생성·재시도는 비활성화됐습니다.",
        },
      };
    const probe = await this.worker.probe();
    if (!probe.codex.available || !probe.codex.authenticated)
      return {
        status: "needs_input",
        summary: probe.codex.message,
        candidates: [],
        checks: [],
        recovery: { kind: "blocked", reason: probe.codex.message },
      };
    const inputs = this.inputs(context);
    let result: WorkbenchResult;
    let selectedModelViews: InputFile[] = [];
    let modelViewSources: InputFile[] = [];
    if (context.job.step === "model") {
      if (
        context.job.request.baseJobId &&
        workbenchGenerationCount(context.job.request) !== 1
      )
        return {
          status: "needs_input",
          summary:
            "기존 모델 부분 재생성은 한 버전만 만듭니다. 신규 모델 여러 개 생성으로 대체하지 않습니다.",
          candidates: [],
          checks: [],
          recovery: {
            kind: "blocked",
            reason: "기존 모델 편집 개수는 1개여야 합니다.",
          },
        };
      const base = this.baseInputs(context, inputs);
      const whole = workbenchModelInput(context.job.request) === "whole";
      const imageInputs = whole
        ? (this.selectedInputs(context, inputs, "concept") ??
          inputs.filter((input) => !input.role || input.role === "whole"))
        : (this.selectedInputs(context, inputs, "separate") ??
          inputs.filter((input) => !base.includes(input)));
      const expectedViews = whole
        ? ["front"]
        : (context.job.request.views ?? orderedViews);
      const selectedViews = imageInputs.filter(
        (input) =>
          input.kind === "image" &&
          (whole || input.role === context.job.request.role) &&
          expectedViews.includes(input.view ?? "front"),
      );
      selectedModelViews = selectedViews;
      modelViewSources = selectedViews;
      if (
        context.job.request.baseJobId &&
        !base.some(
          (input) =>
            ["model", "export"].includes(input.kind) &&
            [".glb", ".fbx", ".obj", ".gltf", ".zip"].includes(
              path.extname(input.path).toLowerCase(),
            ),
        )
      )
        return {
          status: "needs_input",
          summary:
            "부분 재생성할 기존 모델 파일이 없습니다. Studio의 정확한 기존 모델을 먼저 연결해야 합니다.",
          candidates: [],
          checks: [],
          recovery: {
            kind: "blocked",
            reason: "기존 모델 없이 신규 생성으로 대체하지 않습니다.",
          },
        };
      try {
        const anchor = selectedViews.find(
          (input) => (input.view ?? "front") === "front",
        )?.sha256;
        selectedModelViews = whole
          ? selectedViews
          : selectedViews.map((input) =>
              this.modelViewInput(context, input, anchor),
            );
      } catch (error) {
        const summary =
          error instanceof Error
            ? error.message
            : "모델 입력 보정 사진 확인 실패";
        return {
          status: "needs_input",
          summary,
          candidates: [],
          checks: [],
          recovery: { kind: "blocked", reason: summary },
        };
      }
      if (
        !context.job.request.baseJobId &&
        (expectedViews.some(
          (view) =>
            selectedViews.filter((input) => (input.view ?? "front") === view)
              .length !== 1,
        ) ||
          selectedViews.length !== expectedViews.length ||
          new Set(selectedViews.map((input) => input.sha256)).size !==
            expectedViews.length)
      )
        return {
          status: "needs_input",
          summary: whole
            ? "전체 모델을 만들 원본 이미지 한 장을 먼저 채택해야 합니다."
            : "모델 입력으로 선택한 파츠 방향 사진을 모두 채택해야 합니다.",
          candidates: [],
          checks: [],
          recovery: {
            kind: "blocked",
            reason: "모델 생성용 선택 사진이 부족하거나 중복됐습니다.",
          },
        };
    }
    if (context.job.step === "separate") {
      const request = context.job.request;
      const originalConcept =
        this.selectedInputs(context, inputs, "concept") ?? [];
      const views = request.views ?? [undefined];
      const expected = 3 * views.length;
      const pairs = ["head", "hair", "body"].flatMap((role) =>
        views.map((view) => ({ role, view })),
      );
      const parts: SeparatedPart[] = [];
      const draft = (completed = false, summary?: string) =>
        this.separatedDraft(parts, completed, summary, expected);
      const base = this.baseInputs(context, inputs);
      const targeted = (role: string, view?: WorkbenchView) =>
        (!request.role || request.role === role) &&
        (!request.view || request.view === (view ?? "front"));
      // Preserve all unaffected role/direction photos before any new invocation.
      for (const { role, view } of pairs) {
        if (!request.reuseExisting && targeted(role, view)) continue;
        const previous = this.loadCheckpoint(
          context,
          separationStage(role, view, context),
        );
        if (previous) {
          parts.push({
            role,
            view,
            result: this.inspectPart(context, role, previous, view),
          });
          continue;
        }
        const input = base.find(
          (item) =>
            item.kind === "image" &&
            item.role === role &&
            (item.view ?? "front") === (view ?? "front"),
        );
        if (!input) continue;
        const artifact = this.preserveInput(
          context,
          input,
          "outputs/" + separationStage(role, view, context),
        );
        artifact.view = view ?? input.view;
        const output: WorkbenchResult = {
          status: "completed",
          summary: "기준 버전의 기존 사진을 그대로 보존했습니다.",
          candidates: [
            {
              id: role + "-" + (view ?? "front"),
              label: role,
              artifacts: [artifact],
              objects: [],
            },
          ],
          checks: this.inheritedChecks(context, role),
        };
        this.inspectPart(context, role, output, view, true);
        this.saveCheckpoint(
          context,
          separationStage(role, view, context),
          output,
        );
        parts.push({ role, view, result: output });
      }
      if (parts.length) context.onDraft?.(draft());
      for (const { role, view } of pairs) {
        if (parts.some((part) => part.role === role && part.view === view))
          continue;
        if (!targeted(role, view)) continue;
        if (context.signal.aborted)
          return {
            ...draft(
              false,
              "사용자가 파츠 분리를 중지했습니다. 저장된 사진은 계속 확인할 수 있습니다.",
            ),
            recovery: { kind: "blocked", reason: "사용자 취소" },
          };
        const generatedReferences: InputFile[] = parts
          .filter((part) => part.role === role)
          .flatMap((part) =>
            part.result.candidates[0].artifacts
              .filter((artifact) => artifact.kind === "image")
              .map((artifact) => ({
                ...artifact,
                localPath: artifact.path,
                sha256: hash(this.file(context.workspace, artifact.path)),
                bytes: fs.statSync(this.file(context.workspace, artifact.path))
                  .size,
              })),
          );
        const references = [
          ...inputs.filter(
            (input) =>
              input.kind === "image" &&
              (originalConcept.includes(input) ||
                (!originalConcept.length &&
                  !["head", "hair", "body"].includes(input.role ?? ""))),
          ),
          ...inputs
            .filter((input) => input.kind === "image" && input.role === role)
            .sort(
              (a, b) =>
                Number((b.view ?? "front") === "front") -
                Number((a.view ?? "front") === "front"),
            ),
          ...generatedReferences,
        ];
        // Remove identical pixels/files sent twice; never downsample or omit a distinct same-part reference.
        const referenceHashes = new Set<string>();
        const phaseInputs = references.filter((input) => {
          const key = input.sourceSha256 ?? input.sha256;
          if (referenceHashes.has(key)) return false;
          referenceHashes.add(key);
          return true;
        });
        if (request.separationStrategy === "part-multiview-v1") {
          let group = this.multiviewPlan(context, role);
          if (!group) {
            const remaining = pairs
              .filter(
                (pair) =>
                  pair.role === role &&
                  targeted(role, pair.view) &&
                  !parts.some(
                    (part) => part.role === role && part.view === pair.view,
                  ),
              )
              .map((pair) => pair.view)
              .filter((v): v is WorkbenchView => v !== undefined);
            if (remaining.length > 1)
              group = this.multiviewPlan(context, role, remaining);
          }
          if (group) {
            const collectDraft = () => {
              for (const direction of group!.views) {
                const result = this.savedPart(context, role, direction);
                if (!result) continue;
                const part = { role, view: direction, result },
                  index = parts.findIndex(
                    (p) => p.role === role && p.view === direction,
                  );
                if (index < 0) parts.push(part);
                else parts[index] = part;
              }
              if (parts.length) context.onDraft?.(draft());
            };
            onProgress(
              `${role} · ${group.views.length}방향 독립 원본을 한 작업으로 요청합니다.`,
            );
            const output = await this.phase(
              { ...context, onDraft: collectDraft },
              phaseInputs,
              onProgress,
              { kind: "separate-multiview", role, views: group.views },
            );
            collectDraft();
            if (output.status !== "completed")
              return {
                ...output,
                candidates: draft().candidates,
                checks: uniqueChecks([...draft().checks, ...output.checks]),
              };
            continue;
          }
        }
        let plan =
          request.separationStrategy === "part-sheet-v1"
            ? this.sheetPlan(context, role)
            : undefined;
        if (request.separationStrategy === "part-sheet-v1" && !plan) {
          const remaining = pairs
            .filter(
              (pair) =>
                pair.role === role &&
                targeted(role, pair.view) &&
                !parts.some(
                  (part) => part.role === role && part.view === pair.view,
                ),
            )
            .map((pair) => pair.view)
            .filter((v): v is WorkbenchView => v !== undefined);
          if (remaining.length > 1)
            plan = this.sheetPlan(context, role, remaining);
        }
        onProgress(
          parts.length +
            1 +
            "/" +
            expected +
            " · " +
            role +
            " / " +
            (plan
              ? `${plan.views.length}방향 멀티뷰 시트 1회 요청`
              : (view ?? "front") + " 사진 생성 중"),
        );
        const output = await this.phase(
          context,
          phaseInputs,
          onProgress,
          plan
            ? {
                kind: "separate-sheet",
                role,
                views: plan.views,
              }
            : {
                kind: "separate",
                role,
                view,
              },
        );
        if (output.status !== "completed") {
          const current = draft(false, output.summary);
          return {
            ...output,
            candidates: current.candidates,
            checks: [...current.checks, ...output.checks],
          };
        }
        if (plan) {
          try {
            const splitParts = this.splitSheet(context, plan, output);
            for (const part of splitParts) {
              const existingIndex = parts.findIndex(
                (prior) => prior.role === part.role && prior.view === part.view,
              );
              if (existingIndex < 0) parts.push(part);
              else parts[existingIndex] = part;
            }
          } catch (error) {
            const summary = `${role}: ${error instanceof Error ? error.message : "저장된 멀티뷰 시트 로컬 분할 확인이 필요합니다."}`;
            return {
              ...draft(false, summary),
              recovery: { kind: "blocked", reason: summary },
            };
          }
        } else parts.push({ role, view, result: output });
        context.onDraft?.(draft());
      }
      const imageHashes = parts.flatMap((part) =>
        part.result.candidates[0].artifacts
          .filter((artifact) => artifact.kind === "image")
          .map((artifact) => hash(this.file(context.workspace, artifact.path))),
      );
      // Subsequent view workers may only read earlier images; verify the host hashes again.
      for (const part of parts)
        this.loadCheckpoint(
          context,
          separationStage(part.role, part.view, context),
        );
      if (request.separationStrategy === "part-sheet-v1")
        for (const role of ["head", "hair", "body"])
          if (this.sheetPlan(context, role))
            this.loadCheckpoint(context, sheetStage(role, context));
      if (request.separationStrategy === "part-multiview-v1")
        for (const role of ["head", "hair", "body"]) {
          const plan = this.multiviewPlan(context, role);
          if (plan) this.savedMultiview(context, plan);
        }
      if (new Set(imageHashes).size !== imageHashes.length)
        return {
          status: "needs_input",
          summary: "서로 다른 파츠·방향에 같은 이미지가 등록됐습니다.",
          candidates: [],
          checks: draft().checks,
          recovery: {
            kind: "blocked",
            reason: "중복 사진을 직접 확인해야 합니다.",
          },
        };
      const complete = parts.length === expected;
      result = draft(complete);
      if (!complete)
        result.recovery = {
          kind: "blocked",
          reason:
            "요청한 사진 수정만 완료했습니다. 나머지 방향 사진은 사용자가 실행해야 합니다.",
        };
    } else if (context.job.step === "surface") {
      const artifacts: WorkbenchResult["candidates"][number]["artifacts"] = [];
      const checks: WorkbenchResult["checks"] = [];
      const targetRole = context.job.request.role;
      const base = this.baseInputs(context, inputs);
      if (targetRole)
        for (const input of base.filter(
          (item) => item.role && item.role !== targetRole,
        ))
          artifacts.push(
            this.preserveInput(
              context,
              input,
              "outputs/surface-preserved/" + input.role,
            ),
          );
      for (const role of targetRole
        ? [targetRole]
        : workbenchModelInput(context.job.request) === "whole"
          ? ["whole"]
          : ["head", "hair", "body"]) {
        const primary =
          this.selectedInputs(context, inputs, `model:${role}`) ??
          inputs.filter((input) => input.role === role);
        let current = [
          ...primary,
          ...inputs.filter(
            (input) => input.kind === "image" && !primary.includes(input),
          ),
        ];
        for (const kind of ["uv", "texture"] as const) {
          if (context.signal.aborted)
            return {
              status: "needs_input",
              summary:
                "작업이 중지됐습니다. 완료된 원격 작업은 자동 재제출하지 않습니다.",
              candidates: [],
              checks,
            };
          onProgress(
            `${role} · ${kind === "uv" ? "Smart UV" : "텍스처"} 처리 중`,
          );
          const output = await this.phase(context, current, onProgress, {
            kind,
            role,
          });
          if (output.status !== "completed") return output;
          checks.push(...output.checks);
          const roleArtifacts = output.candidates[0].artifacts.map(
            (artifact) => ({ ...artifact, role }),
          );
          if (kind === "texture") artifacts.push(...roleArtifacts);
          current = [
            ...inputs.filter((input) => input.kind === "image"),
            ...roleArtifacts.map((artifact) => ({
              ...artifact,
              localPath: artifact.path,
              sha256: hash(this.file(context.workspace, artifact.path)),
              bytes: fs.statSync(this.file(context.workspace, artifact.path))
                .size,
            })),
          ];
        }
      }
      result = {
        status: "completed",
        summary:
          "선택한 모델의 Smart UV·텍스처 결과가 준비됐습니다. 외형을 확인한 뒤 채택하세요.",
        candidates: [
          {
            id: "surface",
            label: "모델 후처리 결과",
            artifacts,
            objects: [],
          },
        ],
        checks,
      };
    } else
      result = await this.phase(
        context,
        context.job.step === "model"
          ? [
              ...selectedModelViews.map((input) => ({
                ...input,
                referenceUse: "selected-part-view" as const,
              })),
              ...inputs
                .filter(
                  (input) =>
                    !modelViewSources.includes(input) &&
                    (input.kind !== "image" ||
                      !["head", "hair", "body"].includes(input.role ?? "") ||
                      input.role === context.job.request.role),
                )
                .map((input) => ({
                  ...input,
                  referenceUse: "prior-version" as const,
                })),
            ]
          : inputs,
        onProgress,
      );
    if (
      result.status === "completed" &&
      ["assembly", "rig", "animation"].includes(context.job.step)
    ) {
      try {
        await this.inspectBlend(context, result.candidates[0]);
      } catch (error) {
        const summary =
          error instanceof Error ? error.message : "Blender 검사 실패";
        return {
          status: "needs_input",
          summary,
          candidates: [],
          checks: result.checks,
          recovery: classifyWorkbenchFailure(summary),
        };
      }
    }
    return result;
  }
  recover(
    context: WorkbenchExecutionContext,
    onProgress: (message: string) => void,
  ) {
    return this.execute(
      {
        ...context,
        recovery: context.recovery ?? {
          attempt: 1,
          error: context.job.summary,
          mode: "repair",
        },
      },
      onProgress,
    );
  }
}

function runBlender(
  exe: string,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  if (!exe || !fs.existsSync(exe))
    return Promise.reject(
      Error("설정된 Blender 실행 파일을 찾을 수 없습니다."),
    );
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const abort = () => {
      child.kill();
      finish(Error("Blender 검사가 중지됐습니다."));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(Error("Blender 장면 검사 시간 초과"));
    }, 120000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data) => {
      output = (output + data.toString()).slice(-2000);
    });
    child.stderr.on("data", (data) => {
      output = (output + data.toString()).slice(-2000);
    });
    child.on("error", finish);
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : Error(`Blender 검사 실패 (${code}): ${output}`),
      ),
    );
    if (signal.aborted) abort();
  });
}
