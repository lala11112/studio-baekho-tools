export interface AssetRef { guid: string; localId: string; path: string; name: string; kind?: string; }
export interface AssetEntry extends AssetRef { rig?: string; duration?: number; }
export interface FieldSchema {
  path: string; label: string; type: 'number'|'integer'|'string'|'boolean'|'enum'|'vector2'|'vector3'|'color'|'asset'|'array'|'object'|'unsupported';
  tooltip?: string; min?: number; max?: number; percent?: boolean;
  options?: { label: string; value: number }[]; assetType?: string; children?: FieldSchema[]; element?: FieldSchema;
}
export type Values = Record<string, any>;
export type MonsterKind = 'normal'|'boss';
export interface BossPhaseConfig {
  phaseId:string; phaseMaxHp:number; atkMultiplier:number; defMultiplier:number;
  skillIds:string[]|null;
  pattern:{mode:'weighted'|'sequence';loop:boolean;steps:{kind:'attack'|'wait';attackId:string|null;waitSeconds:number}[]};
  shield:number|null;
  music:{mode:'keep'|'play'|'stop';clip:AssetRef|null;volume:number;fadeSeconds:number};
  note:string;
}
export interface BossConfig {
  enableWeakness:boolean;weaknessElement:number;weakDamageMult:number;
  enableResistance:boolean;resistElement:number;resistDamageMult:number;
  groggyDamageMult:number;statusImmunityList:string[];initialShield:number;
  phaseDownSeconds:number;phaseHoldSeconds:number;phaseReviveSeconds:number;
  phases:BossPhaseConfig[];reward:{gold:number;items:AssetRef[]};
}
export interface PreviewShape { shape: 'sphere'|'box'|'capsule'|'path'; start: number; end: number; offset?: number[]; radius?: number; size?: number[]; height?: number; points?: number[][]; }
export interface AttackDefinition { typeId: string; name: string; description: string; category: 'normal'|'selfDestruct'; fields: FieldSchema[]; defaults: Values; previewSupported: boolean; preview?: { shapes: PreviewShape[] }; generated?: boolean; }
export interface AttackConfig { id: string; typeId: string; values: Values; }
export interface MoveBlendTree {
  type: 'blend2d'; parameterX: string; parameterY: string; overrideController: boolean;
  children: { clip: AssetRef|null; position: number[]; timeScale: number }[];
}
export interface AnimationInfo { parameters: {name:string;type:string}[]; move: MoveBlendTree|null; warnings: string[]; }
export interface ModelAnalysis {
  bounds: {min:number[];max:number[];center:number[];size:number[]}|null;
  hpBarPosition: number[]; vfxPosition: number[]; warnings: string[];
}
export interface EnemyBlueprint {
  version: 1|2|3; kind?:MonsterKind; boss?:BossConfig; name: string; template: AssetRef | null; model: AssetRef | null;
  modelTransform: { position: number[]; rotation: number[]; scale: number[] };
  stats: Values; components: Record<string, Values>;
  animation: { mode: 'clips'|'controller'; controller: AssetRef|null; states: Record<string,AssetRef|null>; move?: MoveBlendTree };
  attacks: AttackConfig[]; selfDestruct: AttackConfig|null;
  hpBarPosition: number[]; vfxPosition: number[];
  anchors?: {hpBar:'auto'|'manual';vfx:'auto'|'manual'};
}
export interface Catalog {
  projectRoot: string; unityVersion: string; assets: AssetEntry[]; attacks: AttackDefinition[];
  statsFields: FieldSchema[]; componentFields: Record<string,FieldSchema[]>;
  template: EnemyBlueprint; warnings: string[];
  kind?:MonsterKind; boss?:{immunities:{id:string;label:string}[];items:AssetEntry[]};
}
export interface ValidationIssue { severity: 'error'|'warning'; path: string; message: string; }
export interface ValidationResult { valid: boolean; issues: ValidationIssue[]; }
export interface BuildResult { requestId: string; state: 'running'|'completed'|'failed'; prefabPath?: string; assets?: string[]; error?: string; }
export interface Connection { projectRoot: string; projectName: string; unityVersion: string; instanceId: string; }
export interface PreviewOpenResult { sessionId: string; }
export interface PreviewFrameRequest { sessionId: string; sequence: number; time: number; yaw: number; pitch: number; zoom: number; clip: AssetRef|null; blueprint: EnemyBlueprint; attackId: string|null; showHitboxes: boolean; state?: string; moveParameters?: number[]; }
export interface PreviewFrameResult { sequence: number; imagePath: string; warning?: string; }
export interface CompilerInfo { editorPath: string; references: string[]; defines: string[]; languageVersion: string; hasErrors: boolean; }
export type AiProvider = 'codex'|'claude';
export interface AiStatus { state: 'ready'|'missing'|'login_required'|'error'; message: string; provider?: AiProvider; version?: string; models?: {id:string;name:string}[]; }
export interface AiProgress { stage: string; message: string; attempt?: number; }
export interface AiAttackRequest { prompt: string; blueprint: EnemyBlueprint; model?: string; }
export interface AiAttackResult { attackId: string; typeId: string; summary: string; files: string[]; configuredExisting?: boolean; existingValues?: Values; }
export type AiConceptRequest = AiAttackRequest;
export interface AiConceptResult { blueprint:EnemyBlueprint; summary:string; reasons:string[]; warnings:string[]; attacks:AiAttackResult[]; }
export interface DesktopApi {
  connect(): Promise<Connection>; chooseProject(): Promise<string|null>; installBridge(projectRoot:string):Promise<void>;
  catalog(kind?:MonsterKind):Promise<Catalog>; validate(blueprint:EnemyBlueprint):Promise<ValidationResult>; build(blueprint:EnemyBlueprint):Promise<BuildResult>;
  searchAssets(query:string,kinds:string[]):Promise<{assets:AssetEntry[];total:number;truncated:boolean}>;
  animationInfo(controller:AssetRef|null):Promise<AnimationInfo>; analyzeModel(blueprint:EnemyBlueprint):Promise<ModelAnalysis>;
  save(blueprint:EnemyBlueprint):Promise<string|null>; open():Promise<EnemyBlueprint|null>;
  previewOpen(blueprint:EnemyBlueprint):Promise<PreviewOpenResult>; previewFrame(request:PreviewFrameRequest):Promise<{sequence:number;dataUrl:string;warning?:string}>; previewClose(sessionId:string):Promise<void>;
  aiStatus():Promise<AiStatus>; aiLogin():Promise<void>; aiSelectExecutable():Promise<AiStatus>; aiSetProvider(provider:AiProvider):Promise<AiStatus>; aiGenerate(request:AiAttackRequest):Promise<AiAttackResult>; aiGenerateConcept(request:AiConceptRequest):Promise<AiConceptResult>; aiCancel():Promise<void>;
  onProgress(callback:(progress:AiProgress)=>void):()=>void; reveal(path:string):Promise<void>;
}
declare global { interface Window { forge: DesktopApi; } }
