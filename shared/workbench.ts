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
export type WorkbenchObject = {
  id: string;
  name: string;
  category: "body" | "clothing" | "hair" | "other";
  separate: boolean;
};
export type WorkbenchRigTarget = { objectId: string; extraBones: boolean };
export type WorkbenchArtifact = {
  path: string;
  kind: "image" | "model" | "blend" | "report" | "frames" | "export";
  role?: string;
  sha256: string;
  bytes: number;
};
export type WorkbenchCandidate = {
  id: string;
  label: string;
  artifacts: WorkbenchArtifact[];
  objects?: WorkbenchObject[];
};
export type WorkbenchRequest = {
  step: WorkbenchStep;
  prompt: string;
  provider?: "gpt" | "tripo";
  role?: WorkbenchRole;
  polygonCount?: number;
  baseJobId?: string;
  objectIds?: string[];
  rigTargets?: WorkbenchRigTarget[];
  motion?: string;
  fps?: number;
  duration?: number;
  referenceFrameCount?: number;
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
export type WorkbenchJob = {
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
  checks: { name: string; passed: boolean }[];
  validationPending?: boolean;
  recovery?: {
    attempt: number;
    maxAttempts: number;
    state: "waiting" | "running" | "exhausted" | "blocked";
    reason: string;
    nextAttemptAt?: string;
  };
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
  checks: { name: string; passed: boolean }[];
  /** Host-approved recovery classification; never authorizes another generation. */
  recovery?: WorkbenchRecovery;
};
export type WorkbenchExecutionContext = {
  workbench: Workbench;
  job: WorkbenchJob;
  workspace: string;
  inputs: WorkbenchArtifact[];
  signal: AbortSignal;
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
  hasSubmission?(job: WorkbenchJob): boolean;
  probe?(): Promise<unknown>;
  shutdown?(): void;
}
export type WorkbenchAction =
  | { kind: "execute"; request: WorkbenchRequest; approval?: WorkbenchApproval }
  | { kind: "select"; jobId: string; candidateId: string }
  | { kind: "accept"; jobId: string }
  | { kind: "revert"; jobId: string; candidateId?: string }
  | { kind: "cancel" }
  | { kind: "retry-validation"; jobId: string }
  | { kind: "retry"; jobId: string }
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
export function workbenchSlot(request: WorkbenchRequest): string {
  if (request.step === "model") return `model:${request.role}`;
  if (request.step === "reference" || request.step === "animation")
    return `${request.step}:${request.motion?.trim()}`;
  return request.step;
}
