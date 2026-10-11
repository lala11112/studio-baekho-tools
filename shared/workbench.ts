/** A workbench never advances without a user's execute/select/accept action. */
export type WorkbenchStep =
  | "concept"
  | "separate"
  | "model"
  | "surface"
  | "assembly"
  | "rig"
  | "reference"
  | "animation"
  | "unity";
export type WorkbenchRole = "head" | "hair" | "body";
export type WorkbenchModelRole = WorkbenchRole | "whole";
export type WorkbenchView = "front" | "back" | "left" | "right";
export type WorkbenchObject = {
  id: string;
  name: string;
  category: "body" | "clothing" | "hair" | "other";
  separate: boolean;
};
export type WorkbenchRigTarget = { objectId: string; extraBones: boolean };
export type WorkbenchArtifact = {
  path: string;
  kind: "image" | "video" | "model" | "blend" | "report" | "frames" | "export";
  role?: string;
  view?: WorkbenchView;
  sha256: string;
  bytes: number;
  /** Host-created display/Tripo derivative. Raw source bytes and lineage stay unchanged. */
  normalized?: {
    path: string;
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    sourceSha256: string;
    anchorSha256: string;
  };
  normalizationIssue?: string;
};
export type WorkbenchCandidate = {
  id: string;
  label: string;
  artifacts: WorkbenchArtifact[];
  objects?: WorkbenchObject[];
};
export type WorkbenchRequest = {
  /** Independent whole-character views, reviewed as one set after design selection. */
  conceptMode?: "design" | "turnaround";
  executionMode?: "worker" | "codex-session" | "codex-app";
  /** Observed Studio settings for a manually executed whole-model submission. */
  externalModel?: { model: "P2.0"; topology: "quad" | "triangle"; observedCreditCost: number };
  /** Initial whole-model Smart UV followed by texture, executed in the current chat. */
  externalSurface?: {
    observedUvCost: number;
    observedTextureCost: number;
    textureResolution: "2K" | "4K" | "8K";
    removeLighting: boolean;
  };
  step: WorkbenchStep;
  prompt: string;
  provider?: "gpt" | "tripo";
  /** Frozen execution route for concept/separate GPT jobs. Absent on legacy
   * saved jobs means Codex; only new requests default to the ChatGPT website. */
  imageBackend?: "chatgpt-web" | "codex";
  role?: WorkbenchModelRole;
  /** User-approved candidate count; the app batch bound is independent of provider limits. */
  generationCount?: number;
  modelInput?: "whole" | "parts";
  separationMode?: "single" | "multiview";
  /** Frozen requested directions. Legacy saved separation without this field is front-only. */
  views?: WorkbenchView[];
  /** New GPT jobs request independent view images together per part.
   * The sheet strategy and absent fields remain readable on saved legacy jobs;
   * legacy sheets cannot start a worker again. Saved requests are not migrated. */
  separationStrategy?: "part-multiview-v1" | "part-sheet-v1";
  /** Optional one-view correction within the frozen separation set. */
  view?: WorkbenchView;
  /** Preserve every existing image and generate only missing role/view pairs. */
  reuseExisting?: boolean;
  polygonCount?: number;
  baseJobId?: string;
  /** Host-frozen candidate ID, including selected legacy multi-candidate history. */
  baseCandidateId?: string;
  /** Existing Tripo model regeneration scope; never a replacement new-model submission. */
  modelEditScope?: "all" | "part";
  modelEditTarget?: string;
  objectIds?: string[];
  rigTargets?: WorkbenchRigTarget[];
  /** Anatomical controls are independent of optional clothing/hair object bones. */
  rigProfile?: "automatic" | "quadruped";
  rigControls?: { ears: boolean; tail: boolean };
  motion?: string;
  fps?: number;
  duration?: number;
  referenceFrameCount?: number;
  referenceTimes?: number[];
  /** Absent on historical jobs means independent static poses. New UI uses video AI. */
  motionVideo?: { serviceUrl: string; model: string };
  loop?: boolean;
};
export type WorkbenchApproval = {
  accepted: boolean;
  studioCreditLimit: number;
  imageCreditLimit: number;
};
export type WorkbenchRecovery = {
  kind: "retry" | "repair" | "blocked";
  reason: string;
};
export type WorkbenchCheck = {
  name: string;
  passed: boolean;
  /** Advisory visual observations remain false; the host decides whether a check blocks. */
  severity?: "warning" | "error";
  /** New aesthetic observations use the stable name visual_quality and this finite category. */
  visualCategory?:
    | "alignment"
    | "alpha_edges"
    | "appearance"
    | "view_consistency"
    | "semantic_isolation";
  /** Plain-language observation, at most 600 characters; never changes file safety gates. */
  detail?: string;
};
export type WorkbenchJob = {
  externalExecution?: {
    state: "prepared" | "reserved" | "received";
    requestHash: string;
    reservedAt?: string;
    conversationUrl?: string;
    studioModels?: { candidateId: string; modelId: string; url: string }[];
    surface?: WorkbenchSurfaceReceipt;
    /** Explicit user continuations after the bounded attempts; never reset history. */
    continuations?: { afterAttempt:number; at:string; reason:string }[];
    workerHistory?: NonNullable<WorkbenchJob["externalExecution"]>["worker"][];
    worker?: { attempt: number; startedAt?:string; threadId?: string; question?: string; lastReply?: string; usage?: unknown; approval?: WorkbenchRuntimeApproval };
  };
  id: string;
  step: WorkbenchStep;
  slot: string;
  request: WorkbenchRequest;
  status:
    | "running"
    | "review"
    | "needs_input"
    | "submission_unknown"
    | "failed"
    | "cancelled";
  createdAt: string;
  updatedAt: string;
  summary: string;
  /** Exact accepted upstream versions at execution time. */
  dependencies: Record<string, WorkbenchSelection>;
  approval: WorkbenchApproval;
  candidates: WorkbenchCandidate[];
  checks: WorkbenchCheck[];
  /** Verified partial separation images, visible but never selectable. */
  draftCandidates?: WorkbenchCandidate[];
  draftChecks?: WorkbenchCheck[];
  validationPending?: boolean;
  recovery?: {
    attempt: number;
    maxAttempts: number;
    state: "waiting" | "running" | "exhausted" | "blocked";
    reason: string;
    nextAttemptAt?: string;
  };
};
export type WorkbenchSurfaceReceipt = {
  sourceModelId: string;
  uv: { sourceModelId: string; modelId: string; url: string; fbxPath: string; creditCost: number };
  texture: { sourceModelId: string; modelId: string; url: string; fbxPath: string; creditCost: number;
    texturePaths: string[]; resolution: "2K" | "4K" | "8K"; removeLighting: boolean };
};
export type WorkbenchSelection = { jobId: string; candidateId: string };
export type Workbench = {
  schemaVersion: 1;
  id: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  jobs: WorkbenchJob[];
  selections: Record<string, WorkbenchSelection>;
  activeJobId?: string;
  message: string;
};
export type WorkbenchResult = {
  status: "completed" | "needs_input" | "submission_unknown";
  summary: string;
  candidates: {
    id: string;
    label: string;
    artifacts: Omit<WorkbenchArtifact, "sha256" | "bytes">[];
    objects?: WorkbenchObject[];
  }[];
  checks: WorkbenchCheck[];
  /** Host-approved recovery classification; never authorizes another generation. */
  recovery?: WorkbenchRecovery;
};
export type WorkbenchExecutionContext = {
  workbench: Workbench;
  job: WorkbenchJob;
  workspace: string;
  inputs: WorkbenchArtifact[];
  signal: AbortSignal;
  onDraft?: (result: WorkbenchResult) => void;
  recovery?: { attempt: number; error: string; mode: "retry" | "repair" };
};
export interface WorkbenchExecutor {
  execute(
    context: WorkbenchExecutionContext,
    onProgress: (message: string) => void,
  ): Promise<WorkbenchResult>;
  /** Resume/repair this exact job without replaying an ambiguous paid submission. */
  recover?(
    context: WorkbenchExecutionContext,
    onProgress: (message: string) => void,
  ): Promise<WorkbenchResult>;
  /** Read existing separation outputs only; no worker, generation, or paid submission. */
  inspectSaved?(context: WorkbenchExecutionContext): Promise<WorkbenchResult>;
  hasSubmission?(job: WorkbenchJob): boolean;
  probe?(): Promise<unknown>;
  shutdown?(): void;
}
export interface ExternalWorkbenchRunner {
  run(context: WorkbenchExecutionContext & { reply?: string; requestApproval?: (approval: WorkbenchRuntimeApproval) => Promise<WorkbenchRuntimeAnswer> }, onProgress: (message: string) => void): Promise<{
    status: "completed" | "needs_input" | "submission_unknown";
    summary: string;
    question?: string;
    threadId?: string;
    usage?: unknown;
  }>;
  verifyReceipt(context: WorkbenchExecutionContext): void;
  shutdown?(): void;
}
export type WorkbenchRuntimeApproval = {
  id: string;
  title: string;
  detail: string;
  fields: {id:string;label:string;required:boolean;options?:{value:string;label:string}[]}[];
};
export type WorkbenchRuntimeAnswer = {accepted:boolean;values:Record<string,string>};
export type WorkbenchAction =
  | {kind:"external-approval";jobId:string;approvalId:string;answer:WorkbenchRuntimeAnswer}
  | { kind: "external-run"; jobId: string; reply?: string; continueOnce?: boolean }
  | { kind: "external-reserve"; jobId: string; requestHash: string }
  | { kind: "external-receive"; jobId: string }
  | { kind: "external-cancel"; jobId: string }
  | { kind: "execute"; request: WorkbenchRequest; approval?: WorkbenchApproval }
  | { kind: "select"; jobId: string; candidateId: string }
  | { kind: "accept"; jobId: string }
  | { kind: "revert"; jobId: string; candidateId?: string }
  | { kind: "cancel" }
  | { kind: "retry-validation"; jobId: string }
  | { kind: "retry"; jobId: string }
  | { kind: "inspect-saved"; jobId: string }
  | { kind: "normalize-images"; jobId: string }
  | { kind: "import-source"; assetId: string }
  | { kind: "resolve-submission"; jobId: string; confirmedNotSubmitted: true };
export const WORKBENCH_STEPS: { id: WorkbenchStep; title: string }[] = [
  { id: "concept", title: "이미지 만들기" },
  { id: "separate", title: "파츠 분리 확인" },
  { id: "model", title: "파츠 모델 선택" },
  { id: "surface", title: "Smart UV · 텍스처" },
  { id: "assembly", title: "조립 · 반복 수정" },
  { id: "rig", title: "오브젝트 리깅" },
  { id: "reference", title: "멀티뷰 동작 이미지" },
  { id: "animation", title: "3D 애니메이션" },
  { id: "unity", title: "Unity 내보내기" },
];
export const WORKBENCH_ROLES: WorkbenchRole[] = ["head", "hair", "body"];
export const WORKBENCH_VIEWS: WorkbenchView[] = [
  "front",
  "back",
  "left",
  "right",
];
export const WORKBENCH_MAX_GENERATION_COUNT = 16;
export function workbenchGenerationCount(request: WorkbenchRequest): number {
  return request.generationCount ?? (request.step === "concept" ? 4 : 1);
}
export function workbenchModelInput(
  request: WorkbenchRequest,
): "whole" | "parts" {
  return request.modelInput ?? (request.role === "whole" ? "whole" : "parts");
}
export function workbenchSeparationViews(
  request: WorkbenchRequest,
): WorkbenchView[] {
  return request.views ?? ["front"];
}
export function workbenchSlot(request: WorkbenchRequest): string {
  if (request.step === "concept" && request.conceptMode === "turnaround") return "whole-reference";
  if (request.step === "model") return `model:${request.role}`;
  if (request.step === "reference" || request.step === "animation")
    return `${request.step}:${request.motion?.trim()}`;
  return request.step;
}
