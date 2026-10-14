export type Direction = 0 | 90 | 180 | 270;
export type FixtureRole = 'light' | 'railing' | 'column' | 'arch' | 'water' | 'hazard' | 'trap' | 'gate' | 'switch' | 'secretDoor' | 'rest' | 'merchant' | 'altar' | 'decoration';
export type AssetRole = 'floor' | 'wall' | 'door' | 'prop' | 'stair' | 'slope' | 'bridge' | 'ceiling' | 'cliff' | 'deadzone' | FixtureRole;
export type Tile = '_' | '.' | '#' | 'D' | 'P' | 'R' | 'B';
export interface Vec3 { x: number; y: number; z: number }
/** Stair base is its cell elevation; direction is ascent from +Z rotated clockwise around Y. */
export interface Ramp { x: number; row: number; direction: Direction; rise: number; kind?: 'stair' | 'slope' }
export interface Cell { x: number; row: number }
export interface GenerationRegion extends Cell { width: number; height: number }
export interface CeilingCell extends Cell { undersideY: number; heightMode?: 'auto' | 'manual' }
export interface WallHeight extends Cell { height: number; heightMode?: 'auto' | 'manual' }
export type RoomPurpose = 'battle' | 'boss' | 'reward' | 'start' | 'shop';
export type RoomPresetId = 'small' | 'medium' | 'large' | 'boss' | 'start' | 'reward' | 'shop';
export interface LevelDesignSettings { pattern: 'auto' | 'openArena' | 'flankingArena' | 'raisedArena'; characterRadius: number; dodgeDistance: number; theme?: string }
export interface StructureSettings { ceilingClearance: number; fillDoorTops: boolean; fillHeightGaps: boolean; gapRole: 'wall' | 'cliff'; pitBottomKind: 'floor' | 'deadzone'; pitDepth: number; deadzoneThickness: number; defaultWallHeight: number }
export interface PitBottom extends Cell { kind: 'floor' | 'deadzone'; y: number; thickness: number }
export interface StructureFill extends Cell { id: string; role: 'wall' | 'cliff'; purpose: 'doorTop' | 'doorSide' | 'heightGap' | 'pitSide'; direction: Direction; position: Vec3; size: Vec3 }
export interface PropDefinition { category: string; tags: string[]; blocksMovement: boolean; size?: Vec3; placement: 'floor' | 'wall' | 'ceiling'; roomTypes: RoomPurpose[]; weight: number }
export interface PropInstance extends Cell { id: string; bindingId: string; role?: 'prop' | 'decoration'; direction: Direction; offset: Vec3; cells: Cell[]; size: Vec3; blocksMovement: boolean; category: string; anchor?: 'floor' | 'wall' | 'ceiling' }
export interface Bridge extends Cell { direction: Direction }
export interface CliffFace extends Cell { direction: Direction; depth: number }
export interface MapFixture extends Cell { id: string; role: FixtureRole; direction: Direction; offset: Vec3; bindingId?: string; anchor?: 'floor' | 'wall' | 'ceiling'; linkedId?: string }
export interface GameplayMarker extends Cell { id: string; label: string; kind: 'enemy' | 'reward' | 'event'; contentKey: string; direction: Direction; offset: Vec3 }
export interface MapZone extends Cell { kind: 'combat' | 'reward' | 'rest' }
export interface DesignerSettings {
  preset: RoomPurpose;
  merchants?: boolean; altars?: boolean; structureFill?: boolean; pitBottomKind?: 'floor' | 'deadzone'; gapRole?: 'wall' | 'cliff';
  /** Auto uses existing ceilings, or inward-facing wall panels when no ceiling is available. */
  lightPlacement?: 'auto' | 'ceiling' | 'wall' | 'both';
  ceilings: boolean; elevation: boolean; props: boolean; lights: boolean; enemies: boolean; rewards: boolean; events: boolean;
  bridges: boolean; cliffs: boolean; railings: boolean; columns: boolean; arches: boolean; slopes: boolean;
  water: boolean; hazards: boolean; traps: boolean; gates: boolean; secrets: boolean; rests: boolean; decorations: boolean;
  ceilingHeight: number; wallHeight: number; cliffDepth: number; headroom: number; fixtureDensity: number;
  enemyCount: number; rewardCount: number; eventCount: number; bridgeCount: number; bridgeHeight: number; cliffCount: number; cliffSize: number;
}
/** Direction points OUTWARD from the module. Coordinates identify the doorway D cell. */
export interface MapConnection { id: string; label: string; x: number; row: number; direction: 0 | 90 | 180 | 270; width: number; height: number; kind: string }
export interface CellAssetOverride { x: number; row: number; role: AssetRole; bindingId: string }
export interface GridMap {
  version: 3 | 4 | 5;
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
  ceilings?: CeilingCell[];
  wallHeights?: WallHeight[];
  bridges?: Bridge[];
  cliffs?: CliffFace[];
  fixtures?: MapFixture[];
  markers?: GameplayMarker[];
  lockedCells?: Cell[];
  zones?: MapZone[];
  headroom?: number;
  structureSettings?: StructureSettings;
  pitBottoms?: PitBottom[];
  structureFills?: StructureFill[];
  propInstances?: PropInstance[];
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
  designer?: DesignerSettings;
  roomPreset?: RoomPresetId;
  sizeMode?: 'preset' | 'custom';
  seed?: number;
  sizeResolved?: boolean;
  levelDesign?: LevelDesignSettings;
}
export interface PrefabAsset { name: string; path: string; guid: string }
export interface AssetBinding {
  id: string;
  label: string;
  role: AssetRole;
  /** A light binding without a mount restriction remains usable on either surface. */
  lightAnchor?: 'ceiling' | 'wall';
  prefabGuid: string;
  prefabPath: string;
  /** Floor Y multiplies cellSize * 0.12 thickness; stair Y is computed from native rise on export; remaining axes are absolute root scales. */
  scale: Vec3;
  /** World-space correction; Y moves the aligned surface. New stair/slope exports align their measured bottom center. */
  offset: Vec3;
  rotationY: number;
  /** Stair-only source rise in meters when scale.y is 1; defaults to 1 for older bindings. */
  stairNativeRise?: number;
  prop?: PropDefinition;
}
export interface ProjectFile {
  formatVersion: 1;
  map: GridMap;
  settings: GenerationSettings;
  bindings: AssetBinding[];
  blueprintDataUrl?: string;
  generationDraft?: { imageDataUrl: string; settings: GenerationSettings; region?: { x:number; row:number; width:number; height:number }; catalog?: AssetBinding[] };
}
export interface ValidationIssue { severity: 'error' | 'warning'; message: string; cells?: Cell[]; code?: string }
export interface Placement {
  id: string;
  role: AssetRole | 'spawn' | 'exit';
  prefabGuid: string;
  /** Schema 3: Y is floor top or wall/door/prop bottom; stair Y remains its low-base pivot. Includes binding offset. */
  position: Vec3;
  rotation: Vec3;
  /** Floor Y multiplies cellSize * 0.12 thickness; importer measures source bounds to derive root scale. */
  scale: Vec3;
  surface?: 'top' | 'bottom' | 'pivot';
  fitHeight?: number;
  fitWidth?: number;
  fitSize?: Vec3;
  /** v5 measured prop/decoration: preserve native scale, align bounds center X/Z and bottom Y. */
  centerXZ?: true;
  linkedId?: string;
}
export interface ExportManifest {
  schemaVersion: 4 | 5;
  name: string;
  width: number;
  height: number;
  cellSize: number;
  placements: Placement[];
  markers: { id: string; label: string; kind: GameplayMarker['kind']; contentKey: string; position: Vec3; rotation: Vec3 }[];
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
  generateImage(settings: GenerationSettings, region?: GenerationRegion, catalog?: AssetBinding[]): Promise<string>;
  extractLayout(settings: GenerationSettings, imageDataUrl: string, region?: GenerationRegion, catalog?: AssetBinding[]): Promise<GridMap>;
  cancelGeneration(): Promise<void>;
  scanProject(): Promise<ScanResult | null>;
  importPropCatalog?(): Promise<unknown | null>;
  saveProject(project: ProjectFile): Promise<string | null>;
  saveProjects(projects: ProjectFile[]): Promise<string | null>;
  openProject(): Promise<ProjectFile | null>;
  openComparisonProject(): Promise<ProjectFile | null>;
  saveRecovery(project: ProjectFile): Promise<void>;
  loadRecovery(): Promise<ProjectFile | null>;
  exportBundle(project: ProjectFile): Promise<string | null>;
}
declare global { interface Window { baekho?: DesktopAPI } }
