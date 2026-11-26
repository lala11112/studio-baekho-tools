export type Direction = 0 | 90 | 180 | 270;
export type FixtureRole = 'light' | 'railing' | 'column' | 'arch' | 'water' | 'hazard' | 'trap' | 'gate' | 'switch' | 'secretDoor' | 'rest' | 'merchant' | 'altar' | 'decoration' | 'vegetation';
export type AssetRole = 'floor' | 'wall' | 'door' | 'prop' | 'stair' | 'slope' | 'bridge' | 'ceiling' | 'cliff' | 'deadzone' | FixtureRole;
export type Tile = '_' | '.' | '#' | 'D' | 'P' | 'R' | 'B';
export interface Vec3 { x: number; y: number; z: number }
export interface LocalBounds { center: Vec3; size: Vec3 }
export type WallMountSite = 'wall' | 'doorTop' | 'doorSide' | 'upper' | 'lower' | 'corner';
export type WallPlaceholderKind = 'wallLight' | 'doorLight' | 'wallPanel' | 'vent' | 'pipeStraight' | 'pipeInnerCorner' | 'pipeOuterCorner' | 'pipeEndCap' | 'pipeElbow' | 'pipeTee';
export interface WallConnector { position: Vec3; direction: Vec3 }
/** Root-local measurements; connector +Z points out of the part, mount +Z into the room. */
export interface WallMountDefinition {
  kind: 'single' | 'straight' | 'innerCorner' | 'outerCorner' | 'endCap' | 'elbow' | 'tee';
  family: string; sites: WallMountSite[]; heightMode: 'center' | 'floor' | 'top'; height: number;
  spacing: number; probability: number; doorSide: 'left' | 'right' | 'both';
  mounts: WallConnector[]; sockets: WallConnector[]; collisionBoxes: LocalBounds[];
}
export interface WallMountSettings {
  enabled: boolean; singles: boolean; runs: boolean; density: number; runDensity: number;
  /** Missing preserves horizontal placement in existing projects. */
  runOrientation?: 'horizontal' | 'vertical' | 'both';
  /** Missing preserves the original independent boundary placement. */
  runLayout?: 'legacy' | 'composed';
  /** Missing uses each prefab's original mounting height. Fixed requires min === max. */
  runHeight?: { mode: 'fixed' | 'random' | 'auto'; reference: 'floor' | 'top'; min: number; max: number };
  /** Distances above the adjacent floor or below the wall top, including end caps. Missing uses the full available span. */
  verticalRange?: { reference: 'floor' | 'top'; start: number; end: number };
  /** In both mode, join compatible runs through elbows and tees. Missing means true. */
  connectRuns?: boolean;
  /** Missing means true; only substitutes categories without registered wall assets. */
  placeholderFallback?: boolean;
}
export interface WallFace extends Cell { direction: Direction }
/** Resolved world-space root pose and bounds. Stored independently of floor occupancy. */
export interface WallMountInstance {
  position: Vec3; rotationY: number; /** Local Z roll, applied before world Y rotation; absent means zero. */ rotationZ?: number; support: WallFace[]; bounds: LocalBounds[]; sockets: WallConnector[];
  site: WallMountSite; doorId?: string; runId?: string; authored?: boolean;
  /** Preview-only built-in geometry. No real prefab binding or fabricated asset identity is saved. */
  placeholder?: WallPlaceholderKind;
  doorReference?: { position: Vec3; direction: Direction; width: number; height: number };
  doorSide?: 'left' | 'right';
  bindingReference?: { scale: Vec3; rotationY: number; offset?:Vec3; prefabGuid?:string; prefabPath?:string };
}
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
export type PropUsage = 'equipment' | 'storage' | 'natural' | 'floorDetail' | 'edge' | 'unknown' | 'excluded';
export type PropBehavior = 'workSurface' | 'seat' | 'floorEquipment' | 'surfaceAccessory' | 'generic';
export interface PropComposition { usage: PropUsage; family: string; member: 'anchor' | 'companion' | 'either'; arrangement: 'wall' | 'island' | 'either' }
/** Unity-authored prefab lists. An explicit app composition takes precedence over these memberships. */
export interface UnityPropSetMembership { guid: string; label: string; usage: 'equipment' | 'storage' | 'natural'; arrangement: 'wall' | 'island' | 'either' }
export interface PropDefinition { category: string; tags: string[]; blocksMovement: boolean; size?: Vec3; placement: 'floor' | 'wall' | 'ceiling'; roomTypes: RoomPurpose[]; weight: number; composition?: PropComposition; unitySets?: UnityPropSetMembership[]; behavior?: PropBehavior; /** Native root-local visual front in degrees; absent uses the existing binding calibration. */ frontYaw?: number }
export interface PropInstance extends Cell { id: string; bindingId: string; role?: 'prop' | 'decoration' | 'vegetation'; direction: Direction; /** Additional instance yaw, independent of cardinal support direction. Missing means zero. */ yawOffset?: number; offset: Vec3; cells: Cell[]; size: Vec3; blocksMovement: boolean; category: string; anchor?: 'floor' | 'wall' | 'ceiling'; authored?: boolean; groupId?: string; provenance?: 'generated' | 'manual' }
export interface Bridge extends Cell { direction: Direction }
export interface CliffFace extends Cell { direction: Direction; depth: number }
export interface MapFixture extends Cell { id: string; role: FixtureRole; direction: Direction; offset: Vec3; bindingId?: string; anchor?: 'floor' | 'wall' | 'ceiling'; linkedId?: string; wall?: WallMountInstance }
export interface TeleportClearance { radius: number; height: number }
export interface GameplayMarker extends Cell { id: string; label: string; kind: 'enemy' | 'reward' | 'event' | 'teleport'; contentKey: string; direction: Direction; offset: Vec3; /** Required only for teleport markers; records the authored player dimensions. */ clearance?: TeleportClearance }
export interface MapZone extends Cell { kind: 'combat' | 'reward' | 'rest' }
export interface DesignerSettings {
  /** Missing in older projects keeps automatic teleport destinations disabled. */
  teleports?: boolean; teleportCount?: number;
  wallMounts?: WallMountSettings;
  preset: RoomPurpose;
  merchants?: boolean; altars?: boolean; structureFill?: boolean; pitBottomKind?: 'floor' | 'deadzone'; gapRole?: 'wall' | 'cliff';
  /** Auto uses existing ceilings, or inward-facing wall panels when no ceiling is available. */
  lightPlacement?: 'auto' | 'ceiling' | 'wall' | 'both';
  ceilings: boolean; elevation: boolean; props: boolean; lights: boolean; enemies: boolean; rewards: boolean; events: boolean;
  bridges: boolean; cliffs: boolean; railings: boolean; columns: boolean; arches: boolean; slopes: boolean;
  water: boolean; hazards: boolean; traps: boolean; gates: boolean; secrets: boolean; rests: boolean; decorations: boolean;
  /** Missing in older projects means disabled; existing decoration assets retain their role. */
  vegetation?: boolean;
  /** Each falls back to fixtureDensity when absent in older settings. */
  decorationDensity?: number; vegetationDensity?: number;
  /** Missing in existing projects retains the AI's exact object intentions. */
  propLayout?: 'legacy' | 'balanced' | 'grouped';
  /** Soft target percentage of floor area; balanced mode defaults to 12. */
  propCoverage?: number;
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
  /** Missing in legacy projects uses the image-based workflow. */
  generationMethod?: 'image' | 'direct';
  /** Missing in legacy files means manual. New projects use AI. */
  conceptMode?: 'ai' | 'manual';
  prompt: string;
  width: number;
  height: number;
  cellSize: number;
  elevationStep: number;
  maxStepHeight: number;
  connectionCount: number;
  /** Desired size for newly generated doors. Missing fields preserve legacy generation behavior. */
  connectionWidth?: number;
  connectionHeight?: number;
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
  /** Unity root-local bounds, including its original pivot offset. */
  bounds?: LocalBounds;
  wallMount?: WallMountDefinition;
}
export interface MapConcept { source: 'ai' | 'manual'; text: string }
export interface ConceptGenerationContext {
  previousConcepts?: string[];
  candidateIndex?: number;
  candidateCount?: number;
  currentMap?: GridMap;
}
export interface ProjectFile {
  formatVersion: 1;
  map: GridMap;
  settings: GenerationSettings;
  bindings: AssetBinding[];
  blueprintDataUrl?: string;
  concept?: MapConcept;
  generationDraft?: { imageDataUrl: string; settings: GenerationSettings; preferences?: GenerationSettings; concept?: MapConcept; region?: { x:number; row:number; width:number; height:number }; catalog?: AssetBinding[] };
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
  /** v5 measured prop/decoration/vegetation: preserve native scale, align bounds center X/Z and bottom Y. */
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
  markers: { id: string; label: string; kind: GameplayMarker['kind']; contentKey: string; position: Vec3; rotation: Vec3; clearance?: TeleportClearance }[];
  connections: { id: string; label: string; kind: string; width: number; height: number; position: Vec3; rotation: Vec3 }[];
}
export interface ScanResult { projectPath: string; assets: PrefabAsset[]; warnings: string[] }
export interface UnityConnectionStatus {
  state: 'no-project' | 'disconnected' | 'mismatch' | 'busy' | 'needs-setup' | 'ready' | 'error';
  endpoint: string;
  message: string;
  projectPath?: string;
  instanceId?: string;
  requestId?: string;
  warnings?: string[];
}
export interface UnityBuildStatus {
  requestId: string;
  state: 'running' | 'completed' | 'failed' | 'unknown';
  stage: 'checking' | 'preparing' | 'compiling' | 'building' | 'completed' | 'failed' | 'unknown';
  message: string;
  projectPath?: string;
  prefabPath?: string;
  navMeshPath?: string;
  error?: string;
}
export type GenerationStage = 'preparing' | 'concept' | 'image' | 'extract' | 'layout' | 'placement' | 'validation';
export interface GenerationProgress {
  id: string;
  jobId: string;
  method: 'image' | 'direct';
  stage: GenerationStage;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  elapsedMs: number;
  model?: string;
  reasoningEffort?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number; reasoningOutputTokens?: number; cachedInputTokens?: number };
}
export interface CodexModelInfo { id: string; name: string; isDefault: boolean; inputModalities?: string[] }
export interface CodexStatus {
  state: 'ready' | 'login-required' | 'missing' | 'error';
  message: string;
  version?: string;
  models: CodexModelInfo[];
  imageGeneration?: boolean;
}
/** Which local agent writes concepts and designs/analyzes layouts. Image generation always uses Codex. */
export type AnalysisProvider = 'codex' | 'claude';
export interface AiPreferences {
  analysisProvider: AnalysisProvider;
  /** Empty string uses Claude Code's default model. */
  claudeModel: string;
}
export interface ClaudeStatus {
  state: 'ready' | 'login-required' | 'missing' | 'error';
  message: string;
  version?: string;
}
export interface DesktopAPI {
  getClaudeStatus?(): Promise<ClaudeStatus>;
  selectClaudeExecutable?(): Promise<ClaudeStatus>;
  getAiPreferences?(): Promise<AiPreferences>;
  setAiPreferences?(preferences: AiPreferences): Promise<AiPreferences>;
  getCodexStatus(): Promise<CodexStatus>;
  startCodexLogin(): Promise<void>;
  selectCodexExecutable(): Promise<CodexStatus>;
  generateConcept(settings: GenerationSettings, catalog?: AssetBinding[], context?: ConceptGenerationContext): Promise<string>;
  generateImage(settings: GenerationSettings, region?: GenerationRegion, catalog?: AssetBinding[], context?: import('./spatial-intent').ImageGenerationContext): Promise<string>;
  extractLayout(settings: GenerationSettings, imageDataUrl: string, region?: GenerationRegion, catalog?: AssetBinding[]): Promise<GridMap>;
  generateLayout(settings: GenerationSettings, region?: GenerationRegion, catalog?: AssetBinding[], context?: import('./spatial-intent').ImageGenerationContext): Promise<GridMap>;
  onGenerationProgress?(listener: (event: GenerationProgress) => void): () => void;
  recordGenerationStage?(event: GenerationProgress): Promise<void>;
  cancelGeneration(): Promise<void>;
  scanProject(): Promise<ScanResult | null>;
  importPropCatalog?(): Promise<unknown | null>;
  importUnityAssetCatalog?(endpoint?: string): Promise<{
    catalog: import('./unity-asset-catalog').UnityAssetCatalog;
    scan: ScanResult;
    warnings: string[];
  }>;
  saveProject(project: ProjectFile): Promise<string | null>;
  saveProjects(projects: ProjectFile[]): Promise<string | null>;
  openProject(): Promise<ProjectFile | null>;
  openComparisonProject(): Promise<ProjectFile | null>;
  saveRecovery(project: ProjectFile): Promise<void>;
  loadRecovery(): Promise<ProjectFile | null>;
  exportBundle(project: ProjectFile): Promise<string | null>;
  getUnityStatus(endpoint?: string): Promise<UnityConnectionStatus>;
  prepareUnityIntegration(endpoint?: string): Promise<UnityConnectionStatus>;
  startUnityPrefabBuild(project: ProjectFile, endpoint?: string): Promise<UnityBuildStatus>;
  getUnityPrefabBuild(requestId: string): Promise<UnityBuildStatus>;
}
declare global { interface Window { baekho?: DesktopAPI } }
