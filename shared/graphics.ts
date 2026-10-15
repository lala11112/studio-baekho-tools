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
  /** Local, hash-verified restoration after a service normalizes an individual part. */
  partSpace?: { schemaVersion: 1; sourceVersionId: string; providerVersionId: string; reportPath: string };
  /** Separate native working copy with stable part/mesh IDs; provider bytes remain immutable. */
  partSource?: { schemaVersion: 1; providerVersionId: string; reportPath: string };
  /** Explicit local recovery reuses existing material pixels; it does not generate texture detail. */
  surfaceRepair?: { schemaVersion: 1; providerVersionId: string; repairVersionId: string; originalVersionId: string; reportPath: string };
  planarRepair?: import('./graphics-planar').PlanarRepairProvenance;
  /** Analysis is review-only; repaired main and placed parts are adopted atomically. */
  contact?: import('./graphics-contact').GraphicsContactReview;
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
  rig?: import('./graphics-rig').UnityRigReceipt;
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
  derivativeRefreshRequested?: boolean;
  /** Explicit one-use local compatibility recovery of an already-authored contact procedure; never author again. */
  contactProcedureRecoveryRequested?: boolean;
  partSpaceRecoveryVersionId?: string;
  partSourceRecoveryVersionId?: string;
  surfaceRecoveryVersionId?: string;
  planarSelection?: import('./graphics-planar').PlanarSelection;
  /** Exact saved inspection used by this one local repair attempt, independent of later inspections. */
  planarInspection?: import('./graphics-planar').PlanarInspection;
  objectSnapshot?: Pick<GraphicsObject, "name" | "kind" | "references" | "accepted" | "creation">;
  targetProfile?: UnityTargetProfile;
  deliveryId?: string;
  unityClipSettings?: UnityClipSettings[];
  unityRigContract?: import('./graphics-rig').UnityRigContract;
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
  /** Read-only inspect-legacy response only; never saved in the workspace. */
  legacyPreview?: { versions: AssetVersion[]; fingerprint: string; objectName: string };
  /** Transient, read-only storage inspection; never persisted with production state. */
  storageReport?: import('./graphics-storage').GraphicsStorageReport;
  planarInspections?: Record<string, import('./graphics-planar').PlanarInspection>;
};

/** Unlink only an unused legacy collection. Never remove production objects or their history. */
export function graphicsLegacyUnlinkProblem(workspace: GraphicsWorkspace, objectId: string): string | undefined {
  const object = workspace.objects.find(item => item.id === objectId);
  const versions = workspace.versions.filter(version => version.objectId === objectId);
  if (!object || object.id !== "legacy" || versions.some(version => version.provenance.type !== "legacy"))
    return "기존 프로젝트에서 연결한 오브젝트만 연결 해제할 수 있습니다.";
  if (workspace.tasks.some(task => task.status === "running" || task.status === "submission_unknown"))
    return "실행 중이거나 제출 여부를 확인 중인 작업이 있습니다. 완료 후 연결을 해제하세요.";
  if (workspace.tasks.some(task => task.objectId === objectId) || workspace.deliveries.some(delivery => delivery.objectId === objectId))
    return "이 오브젝트에 제작 또는 Unity 전달 기록이 있어 연결을 해제할 수 없습니다.";
  const ids = new Set(versions.map(version => version.id));
  const refers = (value: unknown): boolean => typeof value === "string" ? ids.has(value)
    : Array.isArray(value) ? value.some(refers)
    : !!value && typeof value === "object" && Object.values(value).some(refers);
  if (workspace.objects.some(item => item.id !== objectId && refers([item.references, item.accepted, item.settings, item.creation])) ||
    workspace.versions.some(version => version.objectId !== objectId && refers(version.sourceVersionIds)) ||
    workspace.tasks.some(task => refers([task.inputVersionIds, task.outputVersionIds, task.objectSnapshot, task.settings, task.unityClipSettings])) ||
    workspace.deliveries.some(delivery => refers(delivery.versionIds)))
    return "다른 오브젝트나 작업이 이 자료를 참조하고 있어 연결을 해제할 수 없습니다.";
  return undefined;
}
/** Exact Blender/Unity Action identity, never a filesystem path or sanitized name. */
export function isGraphicsClipName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && value.trim().length > 0 &&
    value !== "." && value !== ".." && !/[\\/\p{Cc}]/u.test(value);
}

export function requiresPartSpaceRestoration(workspace: GraphicsWorkspace, version: AssetVersion): boolean {
  return !version.partSpace && version.provenance.type === 'tripo' && version.slot.startsWith('part-') &&
    workspace.tasks.some(task => ['T01', 'T03'].includes(task.taskId) && !!task.settings.partId && task.outputVersionIds.includes(version.id));
}

export function requiresPartSourcePreparation(workspace: GraphicsWorkspace, version: AssetVersion): boolean {
  return !version.partSource && version.provenance.type === 'tripo' && version.slot.startsWith('part-') &&
    workspace.tasks.some(task => ['M01', 'M02', 'M03'].includes(task.taskId) && !!task.settings.partId && task.outputVersionIds.includes(version.id));
}

/** Only the exact append-only repair -> raw texture branch is eligible for this bounded recovery. */
export function surfaceRepairSources(workspace: GraphicsWorkspace, provider: AssetVersion): { repair: AssetVersion; original: AssetVersion } | undefined {
  if (provider.surfaceRepair || provider.provenance.type !== 'tripo' || provider.role !== 'model' || provider.slot !== 'main') return undefined;
  const producers = workspace.tasks.filter(task => task.taskId === 'T03' && task.objectId === provider.objectId && task.outputVersionIds.includes(provider.id));
  if (producers.length !== 1) return undefined;
  const texture = producers[0];
  const repair = workspace.versions.find(version => version.id === texture.inputVersionIds[0]);
  if (!repair || repair.objectId !== provider.objectId || repair.slot !== provider.slot || repair.role !== 'model' || !provider.sourceVersionIds.includes(repair.id)) return undefined;
  const repairs = workspace.tasks.filter(task => task.taskId === 'M09' && task.status === 'review' && task.objectId === repair.objectId && task.outputVersionIds.includes(repair.id));
  if (repairs.length !== 1) return undefined;
  const original = workspace.versions.find(version => version.id === repairs[0].inputVersionIds[0]);
  if (!original || original.objectId !== provider.objectId || original.slot !== provider.slot || original.role !== 'model' || !repair.sourceVersionIds.includes(original.id)) return undefined;
  return { repair, original };
}

export type GraphicsAction =
  | { kind: 'prepare-contact'; versionId: string; phase: 'analyze' | 'repair' | 'reconstruct' }
  | { kind: 'recover-contact-procedure'; taskId: string }
  | { kind: "create-object"; name: string; objectKind: GraphicsKind; creation?: CreationSpec }
  | { kind: "update-object"; objectId: string; patch: Partial<Pick<GraphicsObject, "name" | "selectedTasks" | "instruction" | "settings" | "references" | "creation">> }
  | { kind: "import"; objectId: string; role: GraphicsRole; clipName?: string }
  | { kind: "accept"; objectId: string; versionId: string }
  | { kind: 'restore-part-space'; versionId: string }
  | { kind: 'prepare-part-source'; versionId: string }
  | { kind: 'repair-surface-uv'; versionId: string }
  | { kind: 'inspect-planar'; versionId: string }
  | ({ kind: 'repair-planar' } & import('./graphics-planar').PlanarSelection)
  | { kind: "prepare"; objectId: string; taskId: string }
  | { kind: "approve" | "cancel" | "recover" | "refresh-parts"; taskId: string }
  | { kind: "runtime-approval"; taskId: string; approvalId: string; answer: WorkbenchRuntimeAnswer }
  | { kind: "set-tripo-budget"; credits: number }
  | { kind: "import-legacy"; versionIds: string[]; fingerprint: string }
  | { kind: "unlink-legacy"; objectId: string }
  | { kind: "inspect-target" | "audit-usage" | "inspect-legacy" | "probe-connections" | "inspect-storage" };
