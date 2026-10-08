export type ProductionConfig = {
  sourceId: string;
  brief: string;
  motions: string[];
  maxIterations: number;
  studioCreditLimit: number;
  videoCreditLimit: number;
  videoUrl?: string;
  mode: "studio";
};
export type ProductionStatus =
  | "ready"
  | "running"
  | "paused"
  | "needs_input"
  | "completed"
  | "cancelled"
  | "failed";
export type ProductionStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "needs_input"
  | "invalidated"
  | "cancelled"
  | "failed";
export type ProductionStageKind =
  | "separate"
  | "generate"
  | "review"
  | "uv"
  | "texture"
  | "assemble"
  | "assembly-review"
  | "final-uv"
  | "final-texture"
  | "rig"
  | "view-reference"
  | "animation-reference"
  | "motion-transfer"
  | "unity";
export type ProductionArtifact = {
  path: string;
  kind: "image" | "model" | "video" | "report";
  role?: string;
  sha256: string;
  bytes: number;
  stageId: string;
};
export type StageResult = {
  status: "completed" | "needs_input" | "rework";
  summary: string;
  artifacts: {
    path: string;
    kind: ProductionArtifact["kind"];
    role?: string;
  }[];
  checks: { name: string; passed: boolean }[];
  reworkStageId?: string;
};
export type ProductionStage = {
  id: string;
  kind: ProductionStageKind;
  title: string;
  role?: string;
  motion?: string;
  dependsOn: string[];
  status: ProductionStageStatus;
  attempt: number;
  charged: boolean;
  capability?: "studio" | "video" | "motion";
  requiredChecks: string[];
  threadId?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  result?: StageResult;
  artifacts: ProductionArtifact[];
  remoteAmbiguous?: boolean;
  requiresApproval?: boolean;
};
export type ProductionRun = {
  schemaVersion: 1;
  id: string;
  projectId: string;
  projectRevision: number;
  config: ProductionConfig;
  status: ProductionStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  /** Absolute isolated workspace; all artifact paths are relative to this directory. */
  workspace: string;
  source: { path: string; sha256: string; label: string };
  stages: ProductionStage[];
  activeStageId?: string;
  message: string;
};
export type ProductionProbe = {
  codex: {
    available: boolean;
    path?: string;
    version?: string;
    authenticated: boolean;
    message: string;
  };
  capabilities: { studio: boolean; video: boolean; motion: boolean };
  message: string;
};
