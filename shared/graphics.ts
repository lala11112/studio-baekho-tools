/** App-owned Unity graphics tasks. Assets are immutable; acceptance never executes a task. */
export type GraphicsKind = "character" | "weapon" | "prop" | "environment" | "sprite" | "ui" | "vfx";
export type GraphicsRole = "design" | "model" | "material" | "rig" | "motion-reference" | "animation" | "unity";
export type GraphicsFile = { path: string; sha256: string; bytes: number; kind: string };
export type AssetVersion = {
  id: string; objectId: string; role: GraphicsRole; slot: string; label: string;
  files: GraphicsFile[]; createdAt: string; sourceVersionIds: string[];
  provenance: { type: "import" | "legacy" | "local" | "codex" | "tripo"; jobId?: string; remoteId?: string };
  preview?: string; warnings: string[];
};
export type UnityTargetProfile = {
  id: string; projectPath: string; unityVersion: string;
  pipeline: "urp" | "hdrp" | "builtin" | "unknown"; platform: "pc";
  packages: Record<string, string>; inspectedAt: string; fingerprint: string; warnings: string[];
};
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
  objectSnapshot?: Pick<GraphicsObject, "name" | "kind" | "references" | "accepted">;
  targetProfile?: UnityTargetProfile;
  deliveryId?: string;
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
  connections?: { name: string; available: boolean; message: string; checkedAt: string }[];
};
export type GraphicsAction =
  | { kind: "create-object"; name: string; objectKind: GraphicsKind }
  | { kind: "update-object"; objectId: string; patch: Partial<Pick<GraphicsObject, "name" | "selectedTasks" | "instruction" | "settings" | "references">> }
  | { kind: "import"; objectId: string; role: GraphicsRole }
  | { kind: "accept"; objectId: string; versionId: string }
  | { kind: "prepare"; objectId: string; taskId: string }
  | { kind: "approve" | "cancel" | "recover"; taskId: string }
  | { kind: "inspect-target" | "audit-usage" | "import-legacy" | "probe-connections" };
