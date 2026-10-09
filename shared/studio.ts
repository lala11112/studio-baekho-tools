export type StudioTool = "modeling" | "combat";
export type StudioPage = "home" | "tools" | "runs" | "results" | "settings";
export interface StudioTarget {
  tool: StudioTool;
  projectId?: string;
  /** Combat project identity from the list snapshot; prevents stale cross-project links. */
  projectPath?: string;
  runId?: string;
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
  storage: { modeling: string; combat: string };
  warnings: string[];
}
export interface StudioBounds { x: number; y: number; width: number; height: number }
export interface StudioApi {
  summary(): Promise<StudioSummary>;
  showCombat(bounds: StudioBounds, target?: StudioTarget): Promise<void>;
  hideCombat(): Promise<void>;
  resizeCombat(bounds: StudioBounds): Promise<void>;
  chooseCombatProject(): Promise<void>;
}
declare global {
  interface Window { studio: StudioApi }
}
