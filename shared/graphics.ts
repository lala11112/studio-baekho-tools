import type { CreationSpec } from './graphics-creation';
import type { WorkbenchRuntimeApproval, WorkbenchRuntimeAnswer } from './workbench';
/** App-owned Unity graphics tasks. Assets are immutable; acceptance never executes a task. */
export type GraphicsKind = "character" | "weapon" | "prop" | "environment" | "sprite" | "ui" | "vfx";
export type GraphicsRole = "design" | "model" | "material" | "rig" | "motion-reference" | "animation" | "unity";
export type GraphicsFile = { path: string; sha256: string; bytes: number; kind: string };
export type AssetVersion = {
  id: string; objectId: string; role: GraphicsRole; slot: string; label: string;
  files: GraphicsFile[]; createdAt: string; sourceVersionIds: string[];
  provenance: { type: "import" | "legacy" | "local" | "codex" | "tripo" | "runway"; jobId?: string; remoteId?: string };
  preview?: string; warnings: string[];
};
export type UnityTargetProfile = {
  id: string; projectPath: string; unityVersion: string;
  pipeline: "urp" | "hdrp" | "builtin" | "unknown"; platform: "pc";
  packages: Record<string, string>; inspectedAt: string; fingerprint: string; warnings: string[];
};
/** Frozen settings from the exact accepted animation's producing task, never current object controls. */
export type UnityClipSettings = { versionId: string; name: string; loop: boolean; rootMotion: boolean; fps: number };
export type UnityDelivery = {
  id: string; objectId: string; versionIds: string[]; profileFingerprint: string;
  converterVersion: string; createdAt: string; destination: string;
  status: "queued" | "imported" | "failed" | "conflict";
  files: GraphicsFile[]; guid?: string; prefabPath?: string; userPrefabPath?: string;
  warnings: string[]; errors: string[]; playbackVerified: boolean;
};
export type GraphicsObject = {
  id: string; name: string; kind: GraphicsKind; createdAt: string;
  selectedTasks: string[]; instruction: string; settings: Record<string, string | number | boolean>;
  references: { versionId: string; role: "appearance" | "style" | "motion" | "dimensions" }[];
  accepted: Record<string, string>;
  creation?: CreationSpec;
};
export type GraphicsTaskDefinition = {
  id: string; name: string; group: string; inputs: string; output: string;
  executor: "local" | "tripo" | "codex-image" | "astra" | "runway" | "none";
  status: "ready" | "unverified" | "planned"; reason?: string;
};
export type GraphicsTask = {
  id: string; objectId: string; taskId: string; createdAt: string; updatedAt: string;
  status: "awaiting_approval" | "running" | "review" | "failed" | "cancelled" | "submission_unknown";
  inputVersionIds: string[]; settings: Record<string, string | number | boolean>;
  instruction: string; requestHash: string; outputVersionIds: string[];
  backendJobIds: string[]; quoteId?: string;
  cost?: { provider: string; credits: number | null; basis: string; expiresAt?: number };
  message: string; localOnly: boolean; errorCode?: string;
  usage?: unknown;
  /** Durable, independently registered candidate executions; never repeat them on recovery. */
  completedExecutions?: string[];
  objectSnapshot?: Pick<GraphicsObject, "name" | "kind" | "references" | "accepted" | "creation">;
  targetProfile?: UnityTargetProfile;
  deliveryId?: string;
  unityClipSettings?: UnityClipSettings[];
  paidApproval?: { requestHash: string; provider: string; credits: number; approvedAt: string };
  /** A live tool permission/question, distinct from the frozen service-cost approval. */
  runtimeApproval?: WorkbenchRuntimeApproval & { requestedAt: string; executionId: string };
  /** Keep decisions without storing the user's form values or authentication data. */
  runtimeApprovalHistory?: { id: string; title: string; executionId: string; requestedAt: string; answeredAt: string; decision: "accepted" | "declined" | "cancelled" | "interrupted" }[];
};
export type GraphicsUsageAudit = {
  sampledJobs: number; measuredWorkers: number; missingWorkers: number; localExecutions: number;
  inputTokens: number; cachedInputTokens: number; uncachedInputTokens: number; outputTokens: number;
  findings: { severity: "info" | "warning"; message: string }[];
};
export type GraphicsWorkspace = {
  schemaVersion: 1; id: string; projectId: string; revision: number;
  objects: GraphicsObject[]; versions: AssetVersion[]; tasks: GraphicsTask[];
  deliveries: UnityDelivery[]; target?: UnityTargetProfile; usage?: GraphicsUsageAudit;
  tripoBudget?: { limit: number; setAt: string };
  connections?: { name: string; available: boolean; message: string; checkedAt: string }[];
};
/** Exact Blender/Unity Action identity, never a filesystem path or sanitized name. */
export function isGraphicsClipName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && value.trim().length > 0 &&
    value !== "." && value !== ".." && !/[\\/\p{Cc}]/u.test(value);
}

export type GraphicsAction =
  | { kind: "create-object"; name: string; objectKind: GraphicsKind }
  | { kind: "update-object"; objectId: string; patch: Partial<Pick<GraphicsObject, "name" | "selectedTasks" | "instruction" | "settings" | "references" | "creation">> }
  | { kind: "import"; objectId: string; role: GraphicsRole; clipName?: string }
  | { kind: "accept"; objectId: string; versionId: string }
  | { kind: "prepare"; objectId: string; taskId: string }
  | { kind: "approve" | "cancel" | "recover"; taskId: string }
  | { kind: "runtime-approval"; taskId: string; approvalId: string; answer: WorkbenchRuntimeAnswer }
  | { kind: "set-tripo-budget"; credits: number }
  | { kind: "inspect-target" | "audit-usage" | "import-legacy" | "probe-connections" };
