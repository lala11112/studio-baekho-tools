export type StudioTool = "modeling" | "combat" | "hit-timing";
export type StudioNativeTool = Exclude<StudioTool, "modeling">;
export type StudioPage = "home" | "tools" | "runs" | "results" | "settings";
export interface StudioTarget {
  tool: StudioTool;
  projectId?: string;
  /** Combat project identity from the list snapshot; prevents stale cross-project links. */
  projectPath?: string;
  runId?: string;
  jobId?: string;
  tab?: string;
  create?: boolean;
}
export interface StudioEntry {
  id: string;
  tool: StudioTool;
  title: string;
  projectName: string;
  detail: string;
  status: string;
  tone: "neutral" | "active" | "review" | "success" | "error";
  updatedAt: string;
  target: StudioTarget;
}
export interface StudioSummary {
  version: string;
  projects: StudioEntry[];
  runs: StudioEntry[];
  results: StudioEntry[];
  combat: {
    projectName: string;
    projectPath: string;
    connected: boolean;
    running: boolean;
    generating: boolean;
    error: string;
  };
  hitTimer: {
    projectName: string;
    projectPath: string;
    connected: boolean;
    busy: boolean;
    error: string;
    experimental: true;
  };
  storage: { modeling: string; combat: string; hitTimer: string };
  warnings: string[];
}
export interface StudioBounds { x: number; y: number; width: number; height: number }
export interface StudioApi {
  summary(): Promise<StudioSummary>;
  showCombat(bounds: StudioBounds, target?: StudioTarget): Promise<void>;
  hideCombat(): Promise<void>;
  resizeCombat(bounds: StudioBounds): Promise<void>;
  chooseCombatProject(): Promise<void>;
  showTool(tool: StudioNativeTool, bounds: StudioBounds, target?: StudioTarget): Promise<void>;
  hideTools(): Promise<void>;
  resizeTool(tool: StudioNativeTool, bounds: StudioBounds): Promise<void>;
  chooseHitTimerProject(): Promise<void>;
}
declare global {
  interface Window { studio: StudioApi }
}
