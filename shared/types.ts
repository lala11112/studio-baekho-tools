export type Vec3 = [number, number, number];
export type Transform = { position: Vec3; rotation: Vec3; scale: Vec3 };
export const identity = (): Transform => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});
export type Asset = {
  id: string;
  file: string;
  /** Original Tripo output when file is a separate GLB preview. */
  nativeFile?: string;
  format?: string;
  kind: "image" | "model";
  label: string;
  origin: "import" | "tripo" | "demo" | "crop" | "blender";
  parentId?: string;
  parentIds?: string[];
  jobId?: string;
  createdAt: string;
  prompt?: string;
};
export type Part = {
  id: string;
  name: string;
  role: "body" | "head" | "hair" | "other";
  prompt: string;
  imageId?: string;
  candidates: string[];
  selectedId?: string;
  locked: boolean;
  visible: boolean;
  transform: Transform;
  occluded: boolean;
};
export type JobKind =
  | "image"
  | "edit"
  | "model"
  | "rig-check"
  | "rig"
  | "animate"
  | "segment"
  | "smartsegment"
  | "complete"
  | "retopology"
  | "uv-pack"
  | "smart-uv"
  | "texture"
  | "convert";
export type JobStatus =
  | "queued"
  | "submitting"
  | "running"
  | "success"
  | "failed"
  | "submission_unknown"
  | "paused"
  | "cancelled"
  | "cancelled_local";
export type Generation = {
  kind: JobKind;
  prompt: string;
  model: string;
  size?: string;
  count: number;
  partId?: string;
  sourceId?: string;
  sourceTaskId?: string;
  animation?: string;
  inputMode?: "image" | "text" | "multiview";
  /** Fixed view slots: front, left, back, right. Empty optional slots are allowed. */
  sourceIds?: string[];
  faceLimit?: number;
  quad?: boolean;
  texture?: boolean;
  pbr?: boolean;
  exportUv?: boolean;
  textureQuality?: "fast" | "standard" | "detailed" | "extreme";
  textureVersion?: string;
  segmentationGranularity?: "simple" | "balanced" | "detailed";
  splitByConnectivity?: boolean;
  smartGranularity?: "coarse" | "medium" | "fine";
  segType?: "image" | "model";
  completionMode?: "ai_completion" | "quick_cap";
  partNames?: string[];
  bake?: boolean;
  textureSize?: number;
  format?: "GLTF" | "FBX" | "OBJ" | "STL" | "USDZ" | "3MF";
  rigType?: "biped" | "quadruped";
};
export type Job = {
  id: string;
  quoteId: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  remoteId?: string;
  request: Generation;
  createdAt: string;
  message?: string;
  credits?: number;
  output?: Record<string, unknown>;
  assetId?: string;
  assetIds?: string[];
  /** Downloaded originals remain recoverable even if GLB preview conversion fails. */
  nativeFiles?: string[];
  revision: number;
};
export type Assembly = {
  id: string;
  name: string;
  createdAt: string;
  parts: Part[];
};
export type BuildResult = {
  id: string;
  revision: number;
  mode: string;
  glb: string;
  fbx: string;
  blend: string;
  report: string;
  warnings: string[];
  hasRig: boolean;
  rigType?: "generic" | "humanoid";
  clips: string[];
};
export type UnityResult = {
  requestId: string;
  status: string;
  avatarValid: boolean;
  avatarHuman: boolean;
  prefabPath: string;
  userPrefabPath: string;
  scenePath: string;
  clips: string[];
  playbackVerified: boolean;
  runtimePlayModeVerified?: boolean;
  runtimeClips?: string[];
  runtimeMovingClips?: string[];
  warnings: string[];
  errors: string[];
  unityVersion?: string;
  pipeline?: string;
  revision: number;
  guid?: string;
};
export type Project = {
  schemaVersion: 1;
  id: string;
  name: string;
  style: string;
  height: number;
  unityPath: string;
  unityFolder: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  assets: Asset[];
  selectedImageId?: string;
  parts: Part[];
  jobs: Job[];
  assemblies: Assembly[];
  builds: BuildResult[];
  unity?: UnityResult;
  demo: boolean;
};
export type Settings = {
  tripoRegion: "international" | "china";
  blenderPath: string;
  unityPath: string;
  unityEditorPath: string;
};
export type Quote = {
  id: string;
  projectId: string;
  request: Generation;
  revision: number;
  expiresAt: number;
  estimatedCredits: number | null;
  costSource: string;
  inputSummary: string;
  consumed: boolean;
};
export type AppState = {
  projects: Project[];
  graphicsWorkspaces?: import("./graphics").GraphicsWorkspace[];
  productionRuns?: import("./production").ProductionRun[];
  workbenches?: import("./workbench").Workbench[];
  settings: Settings;
  key: { configured: boolean; storage: string };
  dataDir: string;
  catalog: typeof import("./catalog").catalog;
};
export type ChatGptStatus = {
  available: boolean;
  state: "closed" | "loading" | "login_required" | "ready" | "failed";
  ready: boolean;
  reason: string;
  url?: string;
  opened?: boolean;
  requiresInput?: boolean;
  canReconnect?: boolean;
  diagnostic?: { code: string; host?: string; path?: string };
};
export type Command =
  | { type: "graphics.topology"; id: string; versionId: string }
  | { type: "state" }
  | { type: "graphics.action"; id: string; action: import("./graphics").GraphicsAction }
  | {
      type: "workbench.action";
      id: string;
      action: import("./workbench").WorkbenchAction;
    }
  | { type: "workbench.probe" }
  | { type: "workbench.open"; id: string }
  | {
      type: "workbench.recover-separation";
      id: string;
      runId: string;
      attempt: number;
    }
  | {
      type: "production.create";
      id: string;
      config: import("./production").ProductionConfig;
    }
  | { type: "production.start"; runId: string; budgetAccepted: boolean }
  | {
      type:
        | "production.pause"
        | "production.resume"
        | "production.cancel"
        | "production.open";
      runId: string;
    }
  | { type: "production.probe" }
  | { type: "studio.open" | "studio.status" }
  | { type: "chatgpt.open" | "chatgpt.status" | "chatgpt.reconnect" }
  | { type: "project.create"; name: string; demo?: boolean }
  | { type: "project.delete"; id: string }
  | {
      type: "project.update";
      id: string;
      patch: Partial<
        Pick<Project, "name" | "style" | "height" | "unityPath" | "unityFolder">
      >;
    }
  | { type: "project.export"; id: string }
  | { type: "project.open" }
  | {
      type: "asset.import";
      id: string;
      kind: "image" | "model";
      partId?: string;
    }
  | { type: "image.select"; id: string; assetId: string }
  | { type: "part.add"; id: string; name: string }
  | { type: "part.delete"; id: string; partId: string }
  | { type: "part.assign"; id: string; partId: string; assetId: string }
  | {
      type: "part.update";
      id: string;
      partId: string;
      patch: Partial<Omit<Part, "id" | "candidates">>;
    }
  | {
      type: "part.crop";
      id: string;
      partId: string;
      sourceId: string;
      rect: { x: number; y: number; width: number; height: number };
      polygon?: [number, number][];
    }
  | { type: "assembly.save"; id: string; name: string }
  | { type: "assembly.restore"; id: string; assemblyId: string }
  | { type: "generation.quote"; id: string; request: Generation }
  | {
      type: "generation.approve";
      quoteId: string;
      unknownCostAccepted: boolean;
    }
  | { type: "job.poll"; id: string; jobId: string }
  | { type: "job.cancel"; id: string; jobId: string }
  | { type: "job.reconcile"; id: string; jobId: string; remoteId: string }
  | { type: "settings.update"; settings: Settings }
  | { type: "settings.probe" }
  | { type: "key.save"; key: string }
  | { type: "key.delete" }
  | { type: "key.check" }
  | {
      type: "blender.build";
      id: string;
      mode: "assemble" | "demo-rig" | "convert";
      assetId?: string;
    }
  | { type: "blender.open"; id: string; buildId: string }
  | { type: "unity.install"; id: string }
  | { type: "unity.import"; id: string; buildId: string }
  | { type: "unity.result"; id: string }
  | { type: "unity.open"; id: string }
  | { type: "folder.open"; id?: string };
export interface DesktopApi {
  call<T = unknown>(command: Command): Promise<T>;
  assetUrl(projectId: string, file: string): string;
}
declare global {
  interface Window {
    desktop: DesktopApi;
  }
}
