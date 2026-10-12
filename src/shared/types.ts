export type AssetRole = 'floor' | 'wall' | 'door' | 'prop' | 'stair';
export type Tile = '_' | '.' | '#' | 'D' | 'P' | 'R';
export interface Vec3 { x: number; y: number; z: number }
/** Stair base is its cell elevation; direction is ascent from +Z rotated clockwise around Y. */
export interface Ramp { x: number; row: number; direction: 0 | 90 | 180 | 270; rise: number }
/** Direction points OUTWARD from the module. Coordinates identify the doorway D cell. */
export interface MapConnection { id: string; label: string; x: number; row: number; direction: 0 | 90 | 180 | 270; width: number; height: number; kind: string }
export interface CellAssetOverride { x: number; row: number; role: AssetRole; bindingId: string }
export interface GridMap {
  version: 3;
  name: string;
  width: number;
  height: number;
  cellSize: number;
  rows: string[];
  elevations: number[][];
  ramps: Ramp[];
  maxStepHeight: number;
  connections: MapConnection[];
  assetOverrides: CellAssetOverride[];
}
export interface GenerationSettings {
  prompt: string;
  width: number;
  height: number;
  cellSize: number;
  elevationStep: number;
  maxStepHeight: number;
  connectionCount: number;
  /** Empty string uses the connected Codex runtime's default model. */
  codexModel: string;
}
export interface PrefabAsset { name: string; path: string; guid: string }
export interface AssetBinding {
  id: string;
  label: string;
  role: AssetRole;
  prefabGuid: string;
  prefabPath: string;
  /** Floor Y multiplies cellSize * 0.12 thickness; stair Y is computed from native rise on export; remaining axes are absolute root scales. */
  scale: Vec3;
  /** World-space correction; Y moves the aligned surface (or the stair's low-base pivot). */
  offset: Vec3;
  rotationY: number;
  /** Stair-only source rise in meters when scale.y is 1; defaults to 1 for older bindings. */
  stairNativeRise?: number;
}
export interface ProjectFile {
  formatVersion: 1;
  map: GridMap;
  settings: GenerationSettings;
  bindings: AssetBinding[];
  blueprintDataUrl?: string;
}
export interface ValidationIssue { severity: 'error' | 'warning'; message: string }
export interface Placement {
  id: string;
  role: AssetRole | 'spawn' | 'exit';
  prefabGuid: string;
  /** Schema 3: Y is floor top or wall/door/prop bottom; stair Y remains its low-base pivot. Includes binding offset. */
  position: Vec3;
  rotation: Vec3;
  /** Floor Y multiplies cellSize * 0.12 thickness; importer measures source bounds to derive root scale. */
  scale: Vec3;
}
export interface ExportManifest {
  schemaVersion: 3;
  name: string;
  width: number;
  height: number;
  cellSize: number;
  placements: Placement[];
  connections: { id: string; label: string; kind: string; width: number; height: number; position: Vec3; rotation: Vec3 }[];
}
export interface ScanResult { projectPath: string; assets: PrefabAsset[]; warnings: string[] }
export interface CodexModelInfo { id: string; name: string; isDefault: boolean }
export interface CodexStatus {
  state: 'ready' | 'login-required' | 'missing' | 'error';
  message: string;
  version?: string;
  models: CodexModelInfo[];
}
export interface DesktopAPI {
  getCodexStatus(): Promise<CodexStatus>;
  startCodexLogin(): Promise<void>;
  selectCodexExecutable(): Promise<CodexStatus>;
  generateImage(settings: GenerationSettings): Promise<string>;
  extractLayout(settings: GenerationSettings, imageDataUrl: string): Promise<GridMap>;
  cancelGeneration(): Promise<void>;
  scanProject(): Promise<ScanResult | null>;
  saveProject(project: ProjectFile): Promise<string | null>;
  openProject(): Promise<ProjectFile | null>;
  exportBundle(project: ProjectFile): Promise<string | null>;
}
declare global { interface Window { baekho?: DesktopAPI } }
