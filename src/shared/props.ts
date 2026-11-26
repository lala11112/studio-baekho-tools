import type { AssetBinding, Cell, Direction, GenerationRegion, GenerationSettings, GridMap, PrefabAsset, PropDefinition, PropInstance, RoomPurpose, ValidationIssue, Vec3 } from './types';
import { analyzeLevelDesign, compileLevelDesign, createObstacleEvaluator, type TacticalObstacle } from './level-design';
import { parseLocalBounds, parseWallMountDefinition, wallMountIssues } from './wall-mounts';
import type { LocalBounds, UnityPropSetMembership, WallMountDefinition } from './types';
import { placeGroupedProps } from './grouped-props';
import { effectivePropComposition } from './prop-composition';
import { markPropGroupAuthored } from './prop-groups';
import { teleportIssues, teleportReservedCells } from './teleport';
import { normalizePropYaw, propYaw } from './prop-orientation';
import { resolveFixtureBinding } from './light-bindings';
import { fixturePosition } from './features';

const ROOMS: RoomPurpose[] = ['battle', 'boss', 'reward', 'start', 'shop'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const only = (v: Record<string, unknown>, names: string[]) => Object.keys(v).every(k => names.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const label = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 80 && !/[\u0000-\u001f\u007f]/.test(v);
const key = (c: Cell) => `${c.x},${c.row}`;
const inside = (c: Cell, r: GenerationRegion) => c.x >= r.x && c.row >= r.row && c.x < r.x + r.width && c.row < r.row + r.height;
const vec = (v: unknown, positive = false): v is Vec3 => record(v) && only(v, ['x','y','z']) && ['x','y','z'].every(k => finite(v[k]) && Math.abs(v[k]) <= 1000 && (!positive || v[k] > 0));
const cell = (v: unknown, width: number, height: number): v is Cell => record(v) && Number.isInteger(v.x) && Number.isInteger(v.row) && Number(v.x) >= 0 && Number(v.x) < width && Number(v.row) >= 0 && Number(v.row) < height;
const direction = (v: unknown): v is Direction => [0,90,180,270].includes(v as number);
const DIRS: Record<Direction, readonly [number,number]> = {0:[0,-1],90:[1,0],180:[0,1],270:[-1,0]};

export function parseUnityPropSetMembership(value: unknown): UnityPropSetMembership {
  if (!record(value) || !only(value, ['guid', 'label', 'usage', 'arrangement'])
    || typeof value.guid !== 'string' || !/^[a-fA-F0-9]{32}$/.test(value.guid) || !label(value.label)
    || !['equipment', 'storage', 'natural'].includes(value.usage as string)
    || !['wall', 'island', 'either'].includes(value.arrangement as string)) throw new Error('Unity 소품 세트의 GUID·이름·용도·배치 형태를 확인해 주세요.');
  return { guid: value.guid.toLowerCase(), label: value.label, usage: value.usage, arrangement: value.arrangement } as UnityPropSetMembership;
}

export function parsePropDefinition(value: unknown): PropDefinition {
  if (!record(value) || !only(value,['category','tags','blocksMovement','size','placement','roomTypes','weight','composition','unitySets','behavior','frontYaw']) || !label(value.category)
    || !Array.isArray(value.tags) || value.tags.length > 24 || !value.tags.every(label) || new Set(value.tags).size !== value.tags.length
    || typeof value.blocksMovement !== 'boolean' || (value.size !== undefined && !vec(value.size,true))
    || !['floor','wall','ceiling'].includes(value.placement as string) || !Array.isArray(value.roomTypes) || !value.roomTypes.length
    || !value.roomTypes.every(r=>ROOMS.includes(r)) || new Set(value.roomTypes).size !== value.roomTypes.length
    || !finite(value.weight) || value.weight < 0 || value.weight > 10000
    || value.behavior !== undefined && !['workSurface','seat','floorEquipment','surfaceAccessory','generic'].includes(value.behavior as string)
    || value.frontYaw !== undefined && (!finite(value.frontYaw) || Math.abs(value.frontYaw) > 1000000)) throw new Error('소품 정의의 종류·태그·크기·배치 위치·방 용도·가중치를 확인해 주세요.');
  if (value.composition !== undefined) {
    const c = value.composition;
    if (!record(c) || !only(c, ['usage','family','member','arrangement'])
      || !['equipment','storage','natural','floorDetail','edge','unknown','excluded'].includes(c.usage as string)
      || !label(c.family) || !['anchor','companion','either'].includes(c.member as string)
      || !['wall','island','either'].includes(c.arrangement as string)) throw new Error('소품 묶음의 용도·계열·역할·구성 방식을 확인해 주세요.');
  }
  const result = structuredClone(value) as unknown as PropDefinition;
  if (value.unitySets !== undefined) {
    if (!Array.isArray(value.unitySets) || value.unitySets.length > 256) throw new Error('Unity 소품 세트 목록은 최대 256개여야 합니다.');
    result.unitySets = Array.from(value.unitySets, parseUnityPropSetMembership);
    if (new Set(result.unitySets.map(set => set.guid)).size !== result.unitySets.length) throw new Error('Unity 소품 세트 GUID가 중복됩니다.');
  }
  return result;
}

export function parsePropInstance(value: unknown, width: number, height: number): PropInstance {
  if (!record(value) || !only(value,['id','bindingId','x','row','direction','yawOffset','offset','cells','size','blocksMovement','category','anchor','role','authored','groupId','provenance'])
    || !id(value.id) || !id(value.bindingId) || !cell(value,width,height) || !direction(value.direction) || !vec(value.offset)
    || !vec(value.size,true) || typeof value.blocksMovement !== 'boolean' || !label(value.category)
    || value.yawOffset !== undefined && (!finite(value.yawOffset) || Math.abs(value.yawOffset) > 1000000)
    || (value.anchor !== undefined && !['floor','wall','ceiling'].includes(value.anchor as string))
    || (value.role !== undefined && !['prop','decoration','vegetation'].includes(value.role as string))
    || (value.authored !== undefined && typeof value.authored !== 'boolean')
    || (value.groupId !== undefined && !id(value.groupId))
    || (value.provenance !== undefined && !['generated','manual'].includes(value.provenance as string))
    || !Array.isArray(value.cells) || !value.cells.length || value.cells.length > width*height
    || !value.cells.every(c => cell(c,width,height) && only(c as unknown as Record<string,unknown>,['x','row']))
    || new Set(value.cells.map(c=>key(c as Cell))).size !== value.cells.length
    || !value.cells.some(c=>(c as Cell).x===value.x && (c as Cell).row===value.row)) throw new Error('소품 인스턴스의 ID·좌표·점유 영역·크기가 올바르지 않습니다.');
  return structuredClone(value) as unknown as PropInstance;
}

/** Structural checks used before reading untrusted saved maps. */
export function propDataErrors(input: Record<string,unknown>): string[] {
  if (input.propInstances === undefined) return [];
  if (!Array.isArray(input.propInstances) || input.propInstances.length > 3200) return ['propInstances 배열은 최대 3,200개여야 합니다.'];
  const errors: string[] = [], seen = new Set<string>();
  for (const value of input.propInstances) try {
    const instance = parsePropInstance(value,Number(input.width),Number(input.height));
    if (seen.has(instance.id)) errors.push(`소품 ID ${instance.id}가 중복됩니다.`);
    seen.add(instance.id);
  } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  return errors;
}
export const propStructureErrors = propDataErrors;

/** Classification is a suggestion only; measurements are never inferred from filenames. */
export function suggestPropDefinition(binding: Pick<AssetBinding,'label'|'prefabPath'|'role'>): PropDefinition {
  const name = `${binding.label} ${binding.prefabPath}`.toLowerCase();
  const categories: [RegExp,string][] = [
    [/crate|chest|box|상자|궤짝/,'상자'], [/barrel|cask|드럼|통(?:_|\b|\s)/,'통'],
    [/rock|boulder|stone|바위|돌/,'바위'], [/table|desk|chair|shelf|cabinet|bench|가구|책상|책장|의자|탁자/,'가구'],
    [/plant|grass|flower|bush|tree|화분|식물|풀|꽃|나무/,'식생'], [/debris|rubble|shard|잔해|파편/,'잔해'],
  ];
  return {category:categories.find(([pattern])=>pattern.test(name))?.[1] ?? '미분류',tags:[],blocksMovement:binding.role==='prop',placement:'floor',roomTypes:[...ROOMS],weight:1};
}

export interface PropBoundsCatalog { version: 1 | 2; assets: { guid: string; size: Vec3; bounds?:LocalBounds; wallMount?:WallMountDefinition }[] }
export function parsePropBoundsCatalog(value: unknown): PropBoundsCatalog {
  if (!record(value) || !only(value,['version','assets']) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.assets) || value.assets.length > 100000) throw new Error('Unity 소품 크기 파일의 형식(version: 1 또는 2, assets)을 확인해 주세요.');
  const seen = new Set<string>();
  for (const asset of value.assets) {
    if (!record(asset) || !only(asset,value.version===2?['guid','size','bounds','wallMount']:['guid','size']) || typeof asset.guid !== 'string' || !/^[a-fA-F0-9]{32}$/.test(asset.guid) || !vec(asset.size,true)) throw new Error('Unity 소품 크기의 GUID와 양수 XYZ 크기를 확인해 주세요.');
    if(value.version===2){const bounds=parseLocalBounds(asset.bounds);if((['x','y','z'] as const).some(axis=>Math.abs(bounds.size[axis]-(asset.size as Vec3)[axis])>1e-5))throw new Error('원본 경계 크기와 소품 크기가 다릅니다.');if(asset.wallMount!==undefined&&asset.wallMount!==null)parseWallMountDefinition(asset.wallMount);}
    const guid = asset.guid.toLowerCase();
    if (seen.has(guid)) throw new Error(`Unity 소품 크기 파일에 GUID ${guid}가 중복됩니다.`);
    seen.add(guid);
  }
  const result=structuredClone(value) as unknown as PropBoundsCatalog;
  for(const entry of result.assets)if(entry.wallMount===null)delete entry.wallMount;
  return result;
}
function withImportedPropBounds(binding: AssetBinding, entry: PropBoundsCatalog['assets'][number] | undefined): AssetBinding {
  const result = structuredClone(binding);
  if (['prop','decoration','vegetation'].includes(result.role) && entry)
    result.prop = {...(result.prop ?? suggestPropDefinition(result)),size:structuredClone(entry.size)};
  if(entry?.bounds)result.bounds=structuredClone(entry.bounds);
  if(entry?.wallMount&&!['floor','wall','door','prop','stair','slope','bridge','ceiling','cliff','deadzone'].includes(result.role))result.wallMount=structuredClone(entry.wallMount);
  return result;
}
function applyValidatedPropBoundsCatalog(bindings: AssetBinding[], catalog: PropBoundsCatalog): { bindings: AssetBinding[]; updated: number } {
  const sizes = new Map(catalog.assets.map(a=>[a.guid.toLowerCase(),a]));
  let updated = 0;
  const result = bindings.map(binding => {
    const size = sizes.get(binding.prefabGuid.toLowerCase());
    if (['prop','decoration','vegetation','light'].includes(binding.role) && size) updated++;
    return withImportedPropBounds(binding,size);
  });
  return {bindings:result,updated};
}
export function applyPropBoundsCatalog(bindings: AssetBinding[], value: unknown): { bindings: AssetBinding[]; updated: number } {
  return applyValidatedPropBoundsCatalog(bindings,parsePropBoundsCatalog(value));
}

/** Keep validated measurements available even when the user has not registered their props yet. */
export function preparePropBoundsImport(bindings: AssetBinding[], value: unknown, assets: PrefabAsset[] | null): { bindings: AssetBinding[]; updated: number; catalog: PropBoundsCatalog; available: number; missing: number } {
  const catalog = parsePropBoundsCatalog(value);
  if (!catalog.assets.length) throw new Error('소품 크기 파일에 측정된 프리팹이 없습니다. Unity에서 소품 프리팹을 선택해 크기를 다시 내보내 주세요.');
  if (assets !== null) {
    const projectGuids = new Set(assets.map(asset=>asset.guid.toLowerCase()));
    catalog.assets = catalog.assets.filter(asset=>projectGuids.has(asset.guid.toLowerCase()));
    if (!catalog.assets.length) throw new Error('소품 크기 파일이 연결한 Unity 프로젝트의 프리팹과 일치하지 않습니다. 같은 프로젝트에서 내보낸 파일을 선택해 주세요.');
  }
  const result = applyValidatedPropBoundsCatalog(bindings,catalog);
  const eligible = bindings.filter(binding=>['prop','decoration','vegetation','light'].includes(binding.role)).length;
  return {...result,catalog,available:catalog.assets.length,missing:eligible-result.updated};
}

/** Apply a retained, validated catalog when a prefab is registered or assigned a prop role. */
export function applyImportedPropBounds(binding: AssetBinding, catalog: PropBoundsCatalog | null): AssetBinding {
  const size = catalog?.assets.find(asset=>asset.guid.toLowerCase()===binding.prefabGuid.toLowerCase());
  return withImportedPropBounds(binding,size);
}
export function snapshotPropCatalog(bindings: AssetBinding[]): AssetBinding[] {
  if (!Array.isArray(bindings) || bindings.length > 256) throw new Error('소품 카탈로그는 최대 256개입니다.');
  return bindings.filter(b=>b.wallMount||['prop','decoration','vegetation','light'].includes(b.role)).map(b=>({...structuredClone(b),...(b.prop?{prop:parsePropDefinition(b.prop)}:{})}));
}
const floorPropCatalog = (bindings: AssetBinding[]) => snapshotPropCatalog(bindings).filter(b=>!b.wallMount&&['prop','decoration','vegetation'].includes(b.role));
export function propCatalogPrompt(bindings: AssetBinding[]): string {
  const catalog = floorPropCatalog(bindings);
  return catalog.length ? `소품 카탈로그 (확정 배치는 로컬 크기 검사 후 결정): ${JSON.stringify(catalog.map(b=>({id:b.id,role:b.role,label:b.label,...b.prop,scale:b.scale})))}` : '';
}

/** Size is a world-space AABB at the saved rotation, not a scale request. */
export function propWorldSize(binding: AssetBinding, facing: number = 0): Vec3 | undefined {
  const size = binding.prop?.size;
  if (!size) return undefined;
  const x=Math.abs(size.x*binding.scale.x),y=Math.abs(size.y*binding.scale.y),z=Math.abs(size.z*binding.scale.z);
  const angle=(facing+binding.rotationY)*Math.PI/180,cos=Math.abs(Math.cos(angle)),sin=Math.abs(Math.sin(angle));
  return {x:x*cos+z*sin,y,z:x*sin+z*cos};
}
export function propFootprint(map: Pick<GridMap,'cellSize'>, origin: Cell, size: Vec3): Cell[] {
  const width=Math.max(1,Math.ceil(size.x/map.cellSize-1e-8)),height=Math.max(1,Math.ceil(size.z/map.cellSize-1e-8));
  if(!Number.isFinite(width*height)||width*height>1600)throw new Error('소품 점유 영역이 최대 맵 크기(1,600셀)를 초과합니다.');
  return Array.from({length:width*height},(_,i)=>({x:origin.x+i%width,row:origin.row+Math.floor(i/width)}));
}
export function propOccupancy(map: GridMap): Map<string, PropInstance> {
  const occupancy=new Map<string,PropInstance>();
  for(const instance of map.propInstances??[])for(const c of instance.cells)occupancy.set(key(c),instance);
  return occupancy;
}
export function assertWholeProps(map: GridMap, region: GenerationRegion): void {
  for (const p of map.propInstances??[]) if (p.cells.some(c=>inside(c,region)) && !p.cells.every(c=>inside(c,region))) throw new Error(`소품 ${p.id}의 일부만 선택할 수 없습니다. 점유 영역 전체를 포함해 주세요.`);
}

function wallSupportTop(map: GridMap, instance: PropInstance): number {
  const floor=map.elevations[instance.row]?.[instance.x]??0,[dx,dr]=DIRS[instance.direction];
  const tops=instance.cells.filter(c=>map.rows[c.row+dr]?.[c.x+dx]==='#').map(c=>{
    const x=c.x+dx,row=c.row+dr;return map.elevations[row][x]+(map.wallHeights?.find(w=>w.x===x&&w.row===row)?.height??map.structureSettings?.defaultWallHeight??4);
  });
  return tops.length?Math.min(...tops):floor+(map.structureSettings?.defaultWallHeight??4);
}

/** Bottom-aligned position; ceiling attachments follow the current roof without rewriting offsets. */
export function propPosition(map: GridMap, instance: PropInstance, binding?: AssetBinding): Vec3 {
  const floor=map.elevations[instance.row]?.[instance.x]??0;
  let y=floor;
  if(instance.anchor==='ceiling') y=(map.ceilings?.find(c=>c.x===instance.x&&c.row===instance.row)?.undersideY??floor)-instance.size.y;
  if(instance.anchor==='wall') {
    const top=wallSupportTop(map,instance);
    y=floor+Math.max(0,(top-floor-instance.size.y)/2);
  }
  return {x:(instance.x-(map.width-1)/2)*map.cellSize+instance.offset.x+(binding?.offset.x??0),y:y+instance.offset.y+(binding?.offset.y??0),z:((map.height-1)/2-instance.row)*map.cellSize+instance.offset.z+(binding?.offset.z??0)};
}

export function propValidationIssues(map: GridMap, bindings?: AssetBinding[]): ValidationIssue[] {
  const issues:ValidationIssue[]=[],occupied=new Map<string,string>();
  for(const p of map.propInstances??[]) {
    const binding=bindings?.find(b=>b.id===p.bindingId);
    if(bindings&&!binding)issues.push({severity:'error',code:'prop-binding',message:`소품 ${p.id}의 프리팹 ${p.bindingId}가 없습니다.`,cells:p.cells});
    const y=propPosition(map,p,binding).y,base=map.elevations[p.row]?.[p.x],bad:Cell[]=[];
    for(const c of p.cells) {
      const k=key(c),ceiling=map.ceilings?.find(v=>v.x===c.x&&v.row===c.row);
      if(occupied.has(k))issues.push({severity:'error',code:'prop-overlap',message:`소품 ${p.id}와 ${occupied.get(k)}의 점유 영역이 겹칩니다.`,cells:[c]});
      occupied.set(k,p.id);
      if(!'.P'.includes(map.rows[c.row]?.[c.x]??'_')||Math.abs((map.elevations[c.row]?.[c.x]??Infinity)-base)>1e-6||y<(map.elevations[c.row]?.[c.x]??0)-1e-6||ceiling&&y+p.size.y>ceiling.undersideY+1e-6||p.anchor==='ceiling'&&!ceiling)bad.push(c);
      if(p.blocksMovement&&map.rows[c.row]?.[c.x]!=='P')issues.push({severity:'error',code:'prop-occupancy',message:`소품 ${p.id}의 통행 차단 셀이 누락되었습니다.`,cells:[c]});
    }
    const xs=p.cells.map(c=>c.x),rs=p.cells.map(c=>c.row);
    const minX=Math.min(...xs),maxX=Math.max(...xs),minR=Math.min(...rs),maxR=Math.max(...rs),centerX=p.x*map.cellSize+p.offset.x+(binding?.offset.x??0),centerR=p.row*map.cellSize-p.offset.z-(binding?.offset.z??0);
    if(p.cells.length!==(maxX-minX+1)*(maxR-minR+1)||centerX-p.size.x/2<(minX-.5)*map.cellSize-1e-6||centerX+p.size.x/2>(maxX+.5)*map.cellSize+1e-6||centerR-p.size.z/2<(minR-.5)*map.cellSize-1e-6||centerR+p.size.z/2>(maxR+.5)*map.cellSize+1e-6)bad.push({x:p.x,row:p.row});
    const measured=binding&&propWorldSize(binding,propYaw(p));
    if(measured&&(['x','y','z'] as const).some(axis=>Math.abs(measured[axis]-p.size[axis])>1e-5))issues.push({severity:'error',code:'prop-scale-changed',message:`소품 ${p.id}의 프리팹 크기·배율·회전이 배치 후 변경되었습니다. 크기를 다시 검증해 배치해 주세요.`,cells:p.cells});
    if(p.anchor==='wall'){const [dx,dr]=DIRS[p.direction];if(y+p.size.y>wallSupportTop(map,p)+1e-6||!p.cells.every(c=>map.rows[c.row+dr]?.[c.x+dx]==='#'||p.cells.some(n=>n.x===c.x+dx&&n.row===c.row+dr)))bad.push({x:p.x,row:p.row});}
    if(bad.length)issues.push({severity:'error',code:'prop-fit',message:`소품 ${p.id}의 점유 영역·높이·천장 여유가 맞지 않습니다.`,cells:bad});
  }
  return issues;
}

function seeded(seed: number): ()=>number {let n=seed>>>0;return()=>{n+=0x6D2B79F5;let t=Math.imul(n^n>>>15,1|n);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};}
function weighted<T>(items:T[],weight:(v:T)=>number,random:()=>number):T {let cursor=random()*items.reduce((s,v)=>s+weight(v),0);for(const item of items){cursor-=weight(item);if(cursor<0)return item;}return items[items.length-1];}
function terrainEdge(map:GridMap,c:Cell,dx:number,dr:number):number|null {
  const tile=map.rows[c.row]?.[c.x];if(!tile||!'.DRB'.includes(tile))return null;
  const base=map.elevations[c.row][c.x];
  if(tile==='R'){const ramp=map.ramps.find(r=>r.x===c.x&&r.row===c.row);if(!ramp)return null;const [rx,rr]=DIRS[ramp.direction];if(rx===dx&&rr===dr)return base+ramp.rise;if(rx===-dx&&rr===-dr)return base;return null;}
  if(tile==='B'){const b=map.bridges?.find(b=>b.x===c.x&&b.row===c.row);if(b){const [bx,br]=DIRS[b.direction];if(bx*dr!==br*dx)return null;}}
  return base;
}
export function connected(map:GridMap):boolean {
  const open:Cell[]=[];for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++)if('.DRB'.includes(map.rows[row][x]))open.push({x,row});
  if(!open.length)return false;const seen=new Set([key(open[0])]),queue=[open[0]];
  for(let i=0;i<queue.length;i++)for(const [dx,dr]of Object.values(DIRS)){const c=queue[i],next={x:c.x+dx,row:c.row+dr},a=terrainEdge(map,c,dx,dr),b=terrainEdge(map,next,-dx,-dr);if(a!==null&&b!==null&&Math.abs(a-b)<=map.maxStepHeight+1e-6&&!seen.has(key(next))){seen.add(key(next));queue.push(next);}}
  return seen.size===open.length;
}

export interface PropPlacementOptions {
  /** Only a new generation pipeline may move unbound, unlocked P intentions. */
  tactical?: boolean;
  /** Generated unbound dressing may vary rotation and relocate to fit its complete measured footprint. */
  varyGeneratedDecorations?: boolean;
  /** Internal exact rotation trial. Does not alter binding.rotationY. */
  facing?: Direction;
  /** Internal exact instance yaw adjustment, used when preserving a manual pose. */
  yawOffset?: number;
  /** Explicit manual edits convert this role even when its generation toggle is off. */
  onlyRole?: 'prop' | 'decoration' | 'vegetation';
  /** Limit a manual fixture edit to its temporary intention, preserving other attachment layers. */
  onlyFixtureId?: string;
  /** A dressing-only generation pass must retain unmeasured obstacle placeholders. */
  skipProps?: boolean;
  /** Generation keeps a pre-existing object that straddles the selected boundary intact. */
  preserveCrossing?: boolean;
}

export interface PropCoverageReport {
  mode: 'legacy' | 'balanced' | 'grouped';
  measurable: boolean;
  floorArea: number;
  occupiedArea: number;
  targetPercent: number;
  actualPercent: number | null;
  targetArea: number;
  unmet: boolean;
  unmeasuredCount: number;
  reasons: string[];
}

function propAreaInRegion(map: GridMap, prop: PropInstance, area: GenerationRegion, binding?: AssetBinding): number {
  const position = propPosition(map, prop, binding), left = (area.x - map.width / 2) * map.cellSize, right = (area.x + area.width - map.width / 2) * map.cellSize;
  const top = (map.height / 2 - area.row) * map.cellSize, bottom = (map.height / 2 - area.row - area.height) * map.cellSize;
  if (position.x - prop.size.x / 2 >= left && position.x + prop.size.x / 2 <= right && position.z - prop.size.z / 2 >= bottom && position.z + prop.size.z / 2 <= top) return prop.size.x * prop.size.z;
  return Math.max(0, Math.min(right, position.x + prop.size.x / 2) - Math.max(left, position.x - prop.size.x / 2))
    * Math.max(0, Math.min(top, position.z + prop.size.z / 2) - Math.max(bottom, position.z - prop.size.z / 2));
}

/** Use the underlying floor, including P footprints, so furnishing never shrinks the denominator. */
export function getPropCoverageReport(map: GridMap, settings: GenerationSettings, bindings: AssetBinding[], region?: GenerationRegion): PropCoverageReport {
  const area = region ?? { x: 0, row: 0, width: map.width, height: map.height };
  const counted = (binding?: AssetBinding) => settings.designer?.propLayout !== 'grouped' || !binding || !['floorDetail','edge','excluded'].includes(effectivePropComposition(binding).usage);
  const props = (map.propInstances ?? []).filter(p => (p.role ?? (p.blocksMovement ? 'prop' : 'decoration')) === 'prop' && (p.anchor ?? 'floor') === 'floor' && p.cells.some(c => inside(c, area)) && counted(bindings.find(b => b.id === p.bindingId)));
  const occupancy = propOccupancy(map), floor = new Set<string>();
  for (let row = area.row; row < area.row + area.height; row++) for (let x = area.x; x < area.x + area.width; x++) if ('.P'.includes(map.rows[row]?.[x] ?? '_')) floor.add(key({ x, row }));
  const unmeasuredCells = [...floor].filter(k => { const [x, row] = k.split(',').map(Number); return map.rows[row][x] === 'P' && !occupancy.has(k); });
  const purpose = settings.designer?.preset ?? 'battle', theme = settings.levelDesign?.theme?.trim().toLowerCase();
  const eligible = bindings.filter(b => b.role === 'prop' && b.prop?.placement === 'floor' && b.prop.blocksMovement && b.prop.weight > 0 && b.prop.roomTypes.includes(purpose) && (!theme || !b.prop.tags.length || b.prop.tags.some(t => t.toLowerCase() === theme)) && counted(b));
  const measured = eligible.filter(b => b.prop?.size), unmeasuredCount = unmeasuredCells.length;
  const targetPercent = Math.min(30, Math.max(1, settings.designer?.propCoverage ?? 12)), floorArea = floor.size * map.cellSize ** 2;
  const occupiedArea = props.reduce((sum, p) => sum + propAreaInRegion(map, p, area, bindings.find(b => b.id === p.bindingId)), 0);
  const measurable = !unmeasuredCount && (measured.length > 0 || props.length > 0);
  const actualPercent = measurable && floorArea ? occupiedArea / floorArea * 100 : null;
  const targetArea = floorArea * targetPercent / 100, mode = settings.designer?.propLayout ?? 'legacy';
  const unmet = mode !== 'legacy' && settings.designer?.props !== false && measurable && occupiedArea + 1e-6 < targetArea;
  const reasons: string[] = [];
  if (!measured.length) reasons.push('현재 방 용도·테마에 맞는 크기가 측정된 바닥 소품이 없습니다.');
  if (unmeasuredCount) reasons.push(`크기 미확정 소품 ${unmeasuredCount}개가 있어 바닥 점유율을 계산할 수 없습니다.`);
  if (unmet) reasons.push('목표 점유율에 미달합니다. 소품 크기·천장·잠금·간격·출입구·회피·우회 경로 조건을 확인해 주세요.');
  return { mode, measurable, floorArea, occupiedArea, targetPercent, actualPercent, targetArea, unmet, unmeasuredCount, reasons };
}

/** Weighted deficit scheduling avoids iid repetition while keeping rare weights rare. */
function diversityOrder(bindings: AssetBinding[], existing: PropInstance[], random: () => number): AssetBinding[] {
  const categoryWeights = new Map<string, number>();
  for (const category of new Set(bindings.map(b => b.prop!.category))) {
    const group = bindings.filter(b => b.prop!.category === category);
    categoryWeights.set(category, group.reduce((n, b) => n + b.prop!.weight, 0) / group.length);
  }
  const total = [...categoryWeights.values()].reduce((a, b) => a + b, 0) || 1;
  const count = existing.filter(p => categoryWeights.has(p.category)).length;
  const categories = [...categoryWeights.keys()].map(category => ({ category,
    deficit: categoryWeights.get(category)! / total * (count + 1) - existing.filter(p => p.category === category).length, tie: random() }));
  categories.sort((a, b) => b.deficit - a.deficit || b.tie - a.tie);
  return categories.flatMap(({ category }) => {
    const group = bindings.filter(b => b.prop!.category === category), sum = group.reduce((n, b) => n + b.prop!.weight, 0) || 1;
    const used = existing.filter(p => p.category === category);
    return group.map(binding => ({ binding, deficit: binding.prop!.weight / sum * (used.length + 1) - used.filter(p => p.bindingId === binding.id).length, tie: random() }))
      .sort((a, b) => b.deficit - a.deficit || b.tie - a.tie).map(v => v.binding);
  });
}

type PropSizeBand = 'large' | 'medium' | 'small';
const PROP_BANDS: PropSizeBand[] = ['large', 'medium', 'small'];
const PROP_BAND_SHARE: Record<PropSizeBand, number> = { large: .5, medium: .35, small: .15 };
const sizeBand = (size: Vec3): PropSizeBand => Math.max(size.x, size.z) < 2 - 1e-8 ? 'small' : Math.max(size.x, size.z) < 4 - 1e-8 ? 'medium' : 'large';

/** Prefer alternatives to reflected pairs, while allowing them when safe space is constrained. */
function mirrorPairPenalty(map: Pick<GridMap, 'width' | 'height'>, candidate: Cell, centers: Cell[]): number {
  return centers.some(p => Math.abs((map.width - 1 - p.x) - candidate.x) < .51 && Math.abs(p.row - candidate.row) < .51
    || Math.abs(p.x - candidate.x) < .51 && Math.abs((map.height - 1 - p.row) - candidate.row) < .51
    || Math.abs((map.width - 1 - p.x) - candidate.x) < .51 && Math.abs((map.height - 1 - p.row) - candidate.row) < .51) ? 30 : 0;
}

/** Generation-only furnishing: native dimensions, a frozen floor budget, and soft size-band quotas. */
function placeBalancedProps(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], region: GenerationRegion | undefined, externalReserved: Cell[], accept?: (map: GridMap) => boolean): { map: GridMap; issues: ValidationIssue[] } {
  if (!settings.designer || settings.designer.props === false) return placeProps(source, settings, bindings, region, externalReserved, { skipProps: true, preserveCrossing: true, varyGeneratedDecorations: true });
  let map = structuredClone(source);
  const area = region ?? { x: 0, row: 0, width: map.width, height: map.height }, locks = new Set((map.lockedCells ?? []).map(key));
  const catalog = floorPropCatalog(bindings), purpose = settings.designer.preset, theme = settings.levelDesign?.theme?.trim().toLowerCase();
  const usable = catalog.filter(b => b.role === 'prop' && b.prop?.size && b.prop.blocksMovement && b.prop.placement === 'floor' && b.prop.weight > 0 && b.prop.roomTypes.includes(purpose) && (!theme || !b.prop.tags.length || b.prop.tags.some(t => t.toLowerCase() === theme))).sort((a, b) => a.id.localeCompare(b.id));
  const issues: ValidationIssue[] = catalog.filter(b => b.role === 'prop' && !b.prop?.size).map(b => ({ severity: 'warning', code: 'prop-unmeasured', message: `${b.label}: 크기 미확정 · 임시 표시. Unity에서 크기를 측정해 주세요.` }));
  if (!usable.length) {
    issues.push({ severity: 'warning', code: 'prop-coverage-unknown', message: '현재 방 용도·테마에 맞는 측정된 바닥 소품이 없어 기존 임시 표시를 유지합니다. 바닥 점유율은 계산할 수 없습니다.' });
    return { map, issues };
  }
  const frozen = getPropCoverageReport(map, settings, bindings, region), occupied = propOccupancy(map), rows = map.rows.map(row => [...row]);
  for (let row = area.row; row < area.row + area.height; row++) for (let x = area.x; x < area.x + area.width; x++) {
    const c = { x, row };
    if (rows[row]?.[x] === 'P' && !locks.has(key(c)) && !occupied.has(key(c)) && !map.assetOverrides.some(o => o.role === 'prop' && o.x === x && o.row === row)) rows[row][x] = '.';
  }
  map.rows = rows.map(row => row.join(''));
  const propSettings = { ...settings, designer: { ...settings.designer, decorations: false, vegetation: false } };
  // Fixed assignments are measured in place. Existing instances, including crossing ones, are retained.
  map = placeProps(map, propSettings, bindings, region, externalReserved, { preserveCrossing: true }).map;
  const baseline = analyzeLevelDesign(map, settings), recipe = compileLevelDesign(settings);
  const center = baseline.combatCenter ?? baseline.walkableCells[Math.floor(baseline.walkableCells.length / 2)] ?? { x: (map.width - 1) / 2, row: (map.height - 1) / 2 };
  const reserved = new Map([...externalReserved, ...teleportReservedCells(map), ...baseline.reservedEntryCells, ...baseline.combatCells, ...baseline.routes.flat()].map(c => [key(c), c]));
  const keepRoute = (cells: Cell[]) => {
    const radius = Math.max(0, Math.ceil(recipe.characterRadius / map.cellSize - .5));
    for (const c of cells) for (let dr = -radius; dr <= radius; dr++) for (let dx = -radius; dx <= radius; dx++) { const n = { x: c.x + dx, row: c.row + dr }; reserved.set(key(n), n); }
  };
  const random = seeded(settings.seed ?? 0), roofs = new Map((map.ceilings ?? []).map(c => [key(c), c.undersideY]));
  const zoneKinds = new Map((map.zones ?? []).map(c => [key(c), c.kind]));
  const localProps = () => (map.propInstances ?? []).filter(p => (p.role ?? (p.blocksMovement ? 'prop' : 'decoration')) === 'prop' && (p.anchor ?? 'floor') === 'floor' && p.cells.some(c => inside(c, area)));
  const footprintArea = (p: PropInstance) => propAreaInRegion(map, p, area, bindings.find(b => b.id === p.bindingId));
  const usedArea = () => localProps().reduce((sum, p) => sum + footprintArea(p), 0);
  const inBandArea = (band: PropSizeBand) => localProps().filter(p => sizeBand(p.size) === band).reduce((sum, p) => sum + footprintArea(p), 0);
  const available = new Set(PROP_BANDS.filter(band => usable.some(b => sizeBand(propWorldSize(b)!) === band)));
  const shareTotal = [...available].reduce((sum, band) => sum + PROP_BAND_SHARE[band], 0);
  const quotas = Object.fromEntries(PROP_BANDS.map(band => [band, available.has(band) ? frozen.targetArea * PROP_BAND_SHARE[band] / shareTotal : 0])) as Record<PropSizeBand, number>;
  let index = 0;
  const tryBand = (band: PropSizeBand): boolean => {
    const currentOccupied = propOccupancy(map), existing = map.propInstances ?? [], evaluate = recipe.combatRequired ? createObstacleEvaluator(map, settings) : undefined;
    const evaluations = new Map<string, TacticalObstacle | undefined>();
    const centers = existing.filter(p => p.blocksMovement).map(p => ({ x: p.x + (Math.max(...p.cells.map(c => c.x)) - p.x) / 2, row: p.row + (Math.max(...p.cells.map(c => c.row)) - p.row) / 2, band: sizeBand(p.size) }));
    const anchors = centers.filter(p => p.band === 'large'), approachBand = recipe.dodgeDistance / map.cellSize + 1.25;
    const origins: { c: Cell; score: number }[] = [];
    for (let row = area.row; row < area.row + area.height; row++) for (let x = area.x; x < area.x + area.width; x++) {
      const c = { x, row }, k = key(c), zone = zoneKinds.get(k);
      if (map.rows[row]?.[x] !== '.' || locks.has(k) || currentOccupied.has(k) || reserved.has(k) || zone === 'reward' || zone === 'rest') continue;
      const distance = Math.hypot(x - center.x, row - center.row), nearest = Math.min(...centers.map(p => Math.hypot(x - p.x, row - p.row)), 5);
      const anchorDistance = Math.min(...anchors.map(p => Math.hypot(x - p.x, row - p.row)), 4);
      const direction = (index % 3 + Math.floor((settings.seed ?? 0) % 4)) * Math.PI * 2 / 3;
      const score = -Math.abs(distance - approachBand) * 2 + nearest * 2 + (zone === 'combat' ? 8 : 0)
        + (band === 'large' ? ((x - center.x) * Math.cos(direction) + (row - center.row) * Math.sin(direction)) * .7 : -Math.abs(anchorDistance - 3) * 3)
        + random() * .5;
      origins.push({ c, score });
    }
    origins.sort((a, b) => b.score - a.score || a.c.row - b.c.row || a.c.x - b.c.x);
    const ordered = diversityOrder(usable.filter(b => sizeBand(propWorldSize(b)!) === band), localProps(), random);
    // Finish every origin/rotation for a chosen prefab before downgrading to another prefab.
    for (const binding of ordered) {
      const orientations = ([0, 90, 180, 270] as Direction[]).map(direction => ({ direction, tie: random() })).sort((a, b) => a.tie - b.tie).map(v => v.direction);
      const footprints = orientations.map(facing => ({ facing, size: propWorldSize(binding, facing)! }))
        .filter(({ size }) => size.x <= area.width * map.cellSize && size.z <= area.height * map.cellSize);
      // Rank the complete rotated footprint, whose center may be several cells from its origin.
      // Reuse the origin's random tie so catalog sizes and rotations consume no extra randomness.
      const candidates = origins.flatMap(({ c, score }) => footprints.map(({ facing, size }) => {
        const candidateCenter = { x: c.x + (Math.max(1, Math.ceil(size.x / map.cellSize - 1e-8)) - 1) / 2, row: c.row + (Math.max(1, Math.ceil(size.z / map.cellSize - 1e-8)) - 1) / 2 };
        return { c, facing, size, score: score - mirrorPairPenalty(map, candidateCenter, centers) };
      })).sort((a, b) => b.score - a.score);
      for (const { c, facing, size } of candidates) {
        const cells = propFootprint(map, c, size), base = map.elevations[c.row][c.x];
        if (cells.some(n => !inside(n, area) || map.rows[n.row]?.[n.x] !== '.' || locks.has(key(n)) || currentOccupied.has(key(n)) || reserved.has(key(n)) || ['reward', 'rest'].includes(zoneKinds.get(key(n)) ?? '') || Math.abs(map.elevations[n.row][n.x] - base) > 1e-6 || (roofs.get(key(n)) ?? Infinity) - base < size.y + binding.offset.y)) continue;
        // Reserve one cell of separation between full rectangles; bypasses remain available to play.
        if (existing.some(p => p.blocksMovement && p.cells.some(n => cells.some(v => Math.max(Math.abs(n.x - v.x), Math.abs(n.row - v.row)) <= 1)))) continue;
        const footprintKey = cells.map(key).join(';');
        if (evaluate && !evaluations.has(footprintKey)) evaluations.set(footprintKey, evaluate(cells));
        const tactic = evaluations.get(footprintKey); if (evaluate && !tactic) continue;
        const trial = structuredClone(map), trialRows = trial.rows.map(row => [...row]); trialRows[c.row][c.x] = 'P'; trial.rows = trialRows.map(row => row.join(''));
        try {
          const fitted = placeProps(trial, propSettings, [binding], region, [...reserved.values()], { facing, preserveCrossing: true }).map;
          if (accept && !accept(fitted)) continue;
          map = fitted;
          if (tactic) tactic.routes.forEach(keepRoute);
          index++;
          return true;
        } catch { /* Physical fit, attachment and global connectivity are all checked atomically. */ }
      }
    }
    available.delete(band);
    return false;
  };
  for (const band of PROP_BANDS) while (available.has(band) && usedArea() + 1e-6 < frozen.targetArea && inBandArea(band) + 1e-6 < quotas[band]) if (!tryBand(band)) break;
  // Reuse the remaining budget when a size band is missing or cannot fit its allocated share.
  while (usedArea() + 1e-6 < frozen.targetArea && available.size && (map.propInstances?.length ?? 0) < 3200) {
    const next = PROP_BANDS.filter(band => available.has(band)).sort((a, b) => (quotas[b] - inBandArea(b)) - (quotas[a] - inBandArea(a)) || PROP_BANDS.indexOf(a) - PROP_BANDS.indexOf(b))[0];
    tryBand(next);
  }
  if (usedArea() + 1e-6 < frozen.targetArea) issues.push({ severity: 'warning', code: 'prop-coverage-unmet', message: `소품 바닥 점유율 ${(frozen.floorArea ? usedArea() / frozen.floorArea * 100 : 0).toFixed(1)}% / 목표 ${frozen.targetPercent}%: 남은 공간에서 크기·천장·잠금·간격·출입구·회피·우회 경로 조건을 함께 만족하지 못해 가능한 배치만 유지했습니다.` });
  if (settings.designer.decorations || settings.designer.vegetation) map = placeProps(map, settings, bindings, region, [...reserved.values()], { skipProps: true, preserveCrossing: true, varyGeneratedDecorations: true }).map;
  return { map, issues };
}

/** Furnish existing geography, preserving measured instances and authored or locked P intentions. */
export function placeAdditionalBalancedProps(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], reserved: Cell[] = [], accept?: (map: GridMap) => boolean): { map: GridMap; issues: ValidationIssue[] } {
  const protectedMap = structuredClone(source), locks = new Map((source.lockedCells ?? []).map(c => [key(c), { ...c }]));
  for (const assignment of source.assetOverrides) if (assignment.role === 'prop') locks.set(key(assignment), { x: assignment.x, row: assignment.row });
  protectedMap.lockedCells = [...locks.values()];
  const result = placeBalancedProps(protectedMap, settings, bindings, undefined, reserved, accept);
  if (source.lockedCells === undefined) delete result.map.lockedCells; else result.map.lockedCells = structuredClone(source.lockedCells);
  return result;
}

/** Legacy count-preserving tactical placement with two usable bypasses. */
function placeTacticalProps(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], region: GenerationRegion | undefined, externalReserved: Cell[], preserveCrossing = false): {map: GridMap; issues: ValidationIssue[]} {
  if (settings.designer?.propLayout === 'grouped') return placeGroupedProps(source, settings, bindings, region, externalReserved);
  if (settings.designer?.propLayout === 'balanced') return placeBalancedProps(source, settings, bindings, region, externalReserved);
  if (!settings.levelDesign || !settings.designer || settings.designer.props === false || !bindings.some(b => b.prop) || !compileLevelDesign(settings).combatRequired) return placeProps(source, settings, bindings, region, externalReserved, { preserveCrossing });
  let map = structuredClone(source);
  const area = region ?? { x: 0, row: 0, width: map.width, height: map.height }, locked = new Set((map.lockedCells ?? []).map(key)), occupied = propOccupancy(map);
  if (!preserveCrossing) assertWholeProps(map, area);
  const movable: Cell[] = [];
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const c = { x, row };
    if (map.rows[row][x] === 'P' && inside(c, area) && !locked.has(key(c)) && !occupied.has(key(c)) && !map.assetOverrides.some(o => o.role === 'prop' && o.x === x && o.row === row)) movable.push(c);
  }
  if (!movable.length) return placeProps(map, settings, bindings, region, externalReserved, { preserveCrossing });
  const cleared = map.rows.map(row => [...row]); for (const c of movable) cleared[c.row][c.x] = '.'; map.rows = cleared.map(row => row.join(''));
  const propSettings = { ...settings, designer: { ...settings.designer, decorations: false, vegetation: false } };
  // Explicit cell overrides and pre-existing instances remain anchored.
  map = placeProps(map, propSettings, bindings, region, externalReserved, { preserveCrossing }).map;
  const baseline = analyzeLevelDesign(map, settings), center = baseline.combatCenter ?? baseline.walkableCells[Math.floor(baseline.walkableCells.length / 2)];
  if (!center) throw new Error('전술 소품을 배치할 이동 가능한 공간이 없습니다.');
  const issues: ValidationIssue[] = [], reserved = new Map([...externalReserved, ...teleportReservedCells(map), ...baseline.reservedEntryCells, ...baseline.combatCells, ...baseline.routes.flat()].map(c => [key(c), c]));
  const keepRoute = (cells: Cell[]) => {
    const radius = Math.max(0, Math.ceil(settings.levelDesign!.characterRadius / map.cellSize - .5));
    for (const c of cells) for (let dr = -radius; dr <= radius; dr++) for (let dx = -radius; dx <= radius; dx++) { const n = { x: c.x + dx, row: c.row + dr }; reserved.set(key(n), n); }
  };
  const random = seeded(settings.seed ?? 0), sector = Math.floor(random() * 4), side = [[1, 1], [-1, 1], [-1, -1], [1, -1]][sector];
  const catalog = floorPropCatalog(bindings), theme = settings.levelDesign.theme?.trim().toLowerCase();
  const usable = catalog.filter(b => b.role === 'prop' && b.prop?.size && b.prop.blocksMovement && b.prop.placement === 'floor' && b.prop.weight > 0 && b.prop.roomTypes.includes(settings.designer!.preset) && (!theme || !b.prop.tags.length || b.prop.tags.some(t => t.toLowerCase() === theme))).sort((a, b) => a.id.localeCompare(b.id));
  for (const b of catalog) if (b.role === 'prop' && !b.prop?.size) issues.push({ severity: 'warning', code: 'prop-unmeasured', message: `${b.label}: 원본 크기 정보가 없어 자동 배치에서 제외했습니다.` });
  const roofs = new Map((map.ceilings ?? []).map(c => [key(c), c.undersideY]));
  for (let index = 0; index < movable.length; index++) {
    const currentOccupied = propOccupancy(map), existing = map.propInstances ?? [], evaluate = createObstacleEvaluator(map, settings), evaluations = new Map<string, TacticalObstacle | undefined>();
    const band = settings.levelDesign.dodgeDistance / map.cellSize + 1.25;
    const previousCenters = existing.filter(p => p.blocksMovement).map(p => ({ x: p.x + (Math.max(...p.cells.map(c => c.x)) - p.x) / 2, row: p.row + (Math.max(...p.cells.map(c => c.row)) - p.row) / 2 }));
    const origins: { c: Cell; score: number }[] = [];
    for (let row = area.row; row < area.row + area.height; row++) for (let x = area.x; x < area.x + area.width; x++) {
      const c = { x, row }, k = key(c), zone = map.zones?.find(z => z.x === x && z.row === row)?.kind;
      if (map.rows[row]?.[x] !== '.' || locked.has(k) || currentOccupied.has(k) || reserved.has(k) || zone === 'reward' || zone === 'rest') continue;
      const dx = x - center.x, dr = row - center.row, distance = Math.hypot(dx, dr);
      const routeDistance = Math.min(...baseline.routes.flat().map(p => Math.hypot(x - p.x, row - p.row)), band);
      const nearest = Math.min(...previousCenters.map(p => Math.hypot(x - p.x, row - p.row)), 3);
      // Alternate an approach flank and a perpendicular retreat flank, not opposite mirror pairs.
      const sx = index % 3 === 1 ? -side[1] : side[0], sr = index % 3 === 1 ? side[0] : side[1];
      const score = -Math.abs(distance - band) * 5 - Math.abs(routeDistance - 1.5) * 2 + (dx * sx + dr * sr) * .8
        - Math.abs(nearest - 3) * 2 - mirrorPairPenalty(map, c, previousCenters) + (zone === 'combat' ? 12 : 0) + random() * .5;
      origins.push({ c, score });
    }
    origins.sort((a, b) => b.score - a.score || a.c.row - b.c.row || a.c.x - b.c.x);
    // Exhaust positions for the chosen prefab before allowing another prefab to replace it.
    const ordered = diversityOrder(usable, existing.filter(p=>(p.role??(p.blocksMovement?'prop':'decoration'))==='prop'), random);
    let chosen: { map: GridMap; routes: [Cell[], Cell[]] } | undefined;
    for (const binding of ordered) {
      const orientations = ([0, 90, 180, 270] as Direction[]).map(direction => ({ direction, order: random() })).sort((a, b) => a.order - b.order).map(v => v.direction);
      for (const { c } of origins) {
        for (const facing of orientations) {
          const size = propWorldSize(binding, facing)!;
          if (size.x > map.width * map.cellSize || size.z > map.height * map.cellSize) continue;
          const footprintWidth = Math.max(1, Math.ceil(size.x / map.cellSize - 1e-8)), footprintHeight = Math.max(1, Math.ceil(size.z / map.cellSize - 1e-8));
          if (c.x + footprintWidth > area.x + area.width || c.row + footprintHeight > area.row + area.height) continue;
          const cells = propFootprint(map, c, size), base = map.elevations[c.row][c.x];
          if (cells.some(n => !inside(n, area) || map.rows[n.row]?.[n.x] !== '.' || locked.has(key(n)) || currentOccupied.has(key(n)) || reserved.has(key(n)) || ['reward', 'rest'].includes(map.zones?.find(z => z.x === n.x && z.row === n.row)?.kind ?? '') || Math.abs(map.elevations[n.row][n.x] - base) > 1e-6 || (roofs.get(key(n)) ?? Infinity) - base < size.y + binding.offset.y)) continue;
          const footprintKey = `${c.x},${c.row}:${footprintWidth},${footprintHeight}`;
          if (!evaluations.has(footprintKey)) evaluations.set(footprintKey, evaluate(cells));
          const tactic = evaluations.get(footprintKey); if (!tactic) continue;
          const trial = structuredClone(map), rows = trial.rows.map(row => [...row]); rows[c.row][c.x] = 'P'; trial.rows = rows.map(row => row.join(''));
          try {
            const fitted = placeProps(trial, propSettings, [binding], region, [...reserved.values()], { facing, preserveCrossing });
            chosen = { map: fitted.map, routes: tactic.routes }; break;
          } catch { /* A physical-fit or global-route conflict rejects this complete candidate. */ }
        }
        if (chosen) break;
      }
      if (chosen) break;
    }
    if (!chosen) throw new Error(`전술 소품 ${index + 1}/${movable.length}의 주요 전투·접근 후보 위치에서 측정된 프리팹과 양쪽 우회 공간을 함께 확보하지 못했습니다. 입구·회피·필수 경로·잠금·요청 수량을 보존했습니다. 방 크기나 소품 조건을 조정해 주세요.`);
    map = chosen.map; chosen.routes.forEach(keepRoute);
  }
  if (settings.designer.decorations || settings.designer.vegetation) map = placeProps(map, settings, bindings, region, [...reserved.values()], { varyGeneratedDecorations: true, preserveCrossing }).map;
  return { map, issues };
}

/** Convert generated P intentions, decorations and vegetation into fixed, measured instances atomically. */
export function placeProps(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], region?: GenerationRegion, reserved: Cell[] = [], options: PropPlacementOptions = {}): {map:GridMap;issues:ValidationIssue[]} {
  reserved = [...reserved, ...teleportReservedCells(source)];
  if(options.tactical)return placeTacticalProps(source,settings,bindings,region,reserved,options.preserveCrossing);
  const map=structuredClone(source),catalog=floorPropCatalog(bindings),issues:ValidationIssue[]=[];
  if(!catalog.some(b=>b.prop))return {map,issues}; // Opening or regenerating a legacy library never changes its assignment scheme.
  const area=region??{x:0,row:0,width:map.width,height:map.height};if(!options.preserveCrossing&&!options.skipProps)assertWholeProps(map,area);
  const locks=new Set((map.lockedCells??[]).map(key)),occupied=propOccupancy(map),reservedKeys=new Set(reserved.map(key));
  const mapRows=map.rows.map(r=>[...r]),purpose=settings.designer?.preset??'battle',theme=settings.levelDesign?.theme?.trim().toLowerCase(),random=seeded(settings.seed??0);
  for(const b of catalog)if(!b.prop?.size)issues.push({severity:'warning',code:'prop-unmeasured',message:`${b.label}: 원본 크기 정보가 없어 자동 배치에서 제외했습니다.`});
  const usable=catalog.filter(b=>b.prop?.size&&b.prop.weight>0&&b.prop.roomTypes.includes(purpose)&&(!theme||!b.prop.tags.length||b.prop.tags.some(t=>t.toLowerCase()===theme))).sort((a,b)=>a.id.localeCompare(b.id));
  const intents:({role:'prop'|'decoration'|'vegetation';fixtureId?:string;bindingId?:string;facing?:Direction;anchor?:'floor'|'wall'|'ceiling'}&Cell)[]=[];
  if(!options.skipProps&&(options.onlyRole?options.onlyRole==='prop':settings.designer?.props!==false))for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++)if(mapRows[row][x]==='P'&&inside({x,row},area)&&!locks.has(key({x,row}))&&!occupied.has(key({x,row})))intents.push({x,row,role:'prop',bindingId:map.assetOverrides.find(o=>o.x===x&&o.row===row&&o.role==='prop')?.bindingId});
  for(const f of map.fixtures??[])if(!f.wall&&(f.role==='decoration'||f.role==='vegetation')&&(options.onlyRole?f.role===options.onlyRole:f.role==='decoration'?settings.designer?.decorations!==false:settings.designer?.vegetation===true)&&(!options.onlyFixtureId||f.id===options.onlyFixtureId)&&inside(f,area)&&!locks.has(key(f)))intents.push({x:f.x,row:f.row,role:f.role,fixtureId:f.id,bindingId:f.bindingId,facing:options.varyGeneratedDecorations&&!f.bindingId?undefined:f.direction,anchor:f.anchor});
  const intendedKeys=new Set(intents.filter(i=>i.role==='prop').map(key));
  // P marks one intended object, not arbitrary spare space that another object may silently consume.
  const existingIds=new Set((map.propInstances??[]).map(p=>p.id));
  for(const intent of intents){
    const relocatable=!!options.varyGeneratedDecorations&&!options.onlyRole&&intent.role!=='prop'&&!intent.bindingId&&(intent.anchor??'floor')==='floor';
    if(occupied.has(key(intent))&&!relocatable)throw new Error(`소품 의도 (${intent.x}, ${intent.row})가 다른 소품의 점유 영역과 겹칩니다.`);
    const eligible=usable.filter(binding=>{const def=binding.prop!;return binding.role===intent.role&&(intent.role!=='prop'||def.blocksMovement)&&(!intent.bindingId||binding.id===intent.bindingId)&&(!intent.anchor||def.placement===intent.anchor);});
    const facingsByBinding=new Map(eligible.map(binding=>[binding.id,options.facing!==undefined?[options.facing]:intent.facing!==undefined?[intent.facing]:options.varyGeneratedDecorations?([0,90,180,270] as Direction[]).map(direction=>({direction,order:random()})).sort((a,b)=>a.order-b.order).map(v=>v.direction):[0,90,180,270] as Direction[]]));
    const candidatesAt=(origin:Cell)=>{
      const candidates:{binding:AssetBinding;instance:PropInstance}[]=[];
      for(const binding of eligible){const def=binding.prop!,facings=facingsByBinding.get(binding.id)!;
      if((origin.x!==intent.x||origin.row!==intent.row)&&def.placement!=='floor')continue;
      for(const facing of facings){
        const yawOffset=options.yawOffset??0;
        const size=propWorldSize(binding,facing+yawOffset)!;
        if(size.x>map.width*map.cellSize+1e-6||size.z>map.height*map.cellSize+1e-6)continue;
        const cells=propFootprint(map,origin,size);
        if(cells.some(c=>!inside(c,area)||!inside(c,{x:0,row:0,width:map.width,height:map.height})||locks.has(key(c))||occupied.has(key(c))||reservedKeys.has(key(c))||intendedKeys.has(key(c))&&key(c)!==key(intent)))continue;
        const base=map.elevations[origin.row][origin.x];
        if(cells.some(c=>!'.P'.includes(mapRows[c.row][c.x])||Math.abs(map.elevations[c.row][c.x]-base)>1e-6
          ||(def.placement==='floor'||def.blocksMovement)&&map.markers?.some(m=>m.x===c.x&&m.row===c.row)
          ||map.fixtures?.some(f=>f.id!==intent.fixtureId&&f.x===c.x&&f.row===c.row&&(f.anchor??'floor')===def.placement&&(def.placement!=='wall'||f.direction===facing))))continue;
        const width=Math.max(...cells.map(c=>c.x))-origin.x+1,height=Math.max(...cells.map(c=>c.row))-origin.row+1;
        const instance:PropInstance={id:`prop_${origin.x}_${origin.row}`,bindingId:binding.id,role:intent.role,x:origin.x,row:origin.row,direction:facing,...(yawOffset?{yawOffset}:{}),cells,size,offset:{x:(width-1)*map.cellSize/2,y:0,z:-(height-1)*map.cellSize/2||0},blocksMovement:def.blocksMovement,category:def.category,anchor:def.placement};
        // Non-zero asset offsets may move physical bounds outside the checked footprint. Reserve conservatively.
        if(Math.abs(binding.offset.x)>(width*map.cellSize-size.x)/2+1e-6||Math.abs(binding.offset.z)>(height*map.cellSize-size.z)/2+1e-6)continue;
        if(def.placement==='wall'){
          const [dx,dr]=DIRS[facing];if(!cells.every(c=>mapRows[c.row+dr]?.[c.x+dx]==='#'||cells.some(p=>p.x===c.x+dx&&p.row===c.row+dr)))continue;
          instance.offset.x+=dx*(width*map.cellSize-size.x)/2;instance.offset.z-=dr*(height*map.cellSize-size.z)/2;
          if(Math.abs(instance.offset.x-(width-1)*map.cellSize/2+binding.offset.x)>(width*map.cellSize-size.x)/2+1e-6||Math.abs(instance.offset.z+(height-1)*map.cellSize/2+binding.offset.z)>(height*map.cellSize-size.z)/2+1e-6)continue;
        }
        const y=propPosition(map,instance,binding).y;
        if(def.placement==='wall'&&y+size.y>wallSupportTop(map,instance)+1e-6)continue;
        if(cells.some(c=>{const roof=map.ceilings?.find(v=>v.x===c.x&&v.row===c.row);return y<base-1e-6||roof&&y+size.y>roof.undersideY+1e-6||def.placement==='ceiling'&&!roof;}))continue;
        if(def.blocksMovement){const testRows=mapRows.map(r=>[...r]);for(const c of cells)testRows[c.row][c.x]='P';if(!connected({...map,rows:testRows.map(r=>r.join(''))}))continue;}
        candidates.push({binding,instance});break;
      }
      }
      return candidates;
    };
    let candidates=candidatesAt(intent);
    if(!candidates.length&&relocatable&&eligible.length){
      // A generated anchor is a preference; its complete bounds must also fit terrain and routes.
      const alternatives:Cell[]=[];
      for(let row=area.row;row<area.row+area.height;row++)for(let x=area.x;x<area.x+area.width;x++)if((x!==intent.x||row!==intent.row)&&mapRows[row]?.[x]==='.'&&!locks.has(key({x,row}))&&!occupied.has(key({x,row}))&&!reservedKeys.has(key({x,row})))alternatives.push({x,row});
      alternatives.sort((a,b)=>(a.x-intent.x)**2+(a.row-intent.row)**2-((b.x-intent.x)**2+(b.row-intent.row)**2)||a.row-b.row||a.x-b.x);
      for(const origin of alternatives){candidates=candidatesAt(origin);if(candidates.length)break;}
    }
    if(!candidates.length)throw new Error(`소품 (${intent.x}, ${intent.row})에 맞는 측정된 프리팹이 없습니다. 종류·방 용도·테마·크기·천장·통행·잠금을 확인해 주세요.${issues.length?' '+issues.map(i=>i.message).join(' '):''}`);
    // Choose the kind first, then its variant. Adding variants does not overwhelm unrelated kinds.
    const kinds=[...new Set(candidates.map(c=>c.binding.prop!.category))];
    const category=weighted(kinds,k=>{const group=candidates.filter(c=>c.binding.prop!.category===k);return group.reduce((s,c)=>s+c.binding.prop!.weight,0)/group.length;},random);
    const diverseBinding=options.varyGeneratedDecorations?diversityOrder(candidates.map(c=>c.binding),(map.propInstances??[]).filter(p=>(p.role??(p.blocksMovement?'prop':'decoration'))===intent.role),random)[0]:undefined;
    const chosen=diverseBinding?candidates.find(c=>c.binding.id===diverseBinding.id)!.instance:weighted(candidates.filter(c=>c.binding.prop!.category===category),c=>c.binding.prop!.weight,random).instance;
    const stem=chosen.id;let n=1;while(existingIds.has(chosen.id))chosen.id=`${stem}_${n++}`;existingIds.add(chosen.id);
    const explicitIntent=!!intent.bindingId||!!intent.fixtureId?.startsWith('fixture_');
    if(explicitIntent)chosen.authored=true;
    chosen.provenance=explicitIntent?'manual':'generated';
    for(const c of chosen.cells){occupied.set(key(c),chosen);if(chosen.blocksMovement)mapRows[c.row][c.x]='P';}
    if(!chosen.blocksMovement&&mapRows[intent.row][intent.x]==='P')mapRows[intent.row][intent.x]='.';
    (map.propInstances??=[]).push(chosen);
    if(intent.fixtureId)map.fixtures=map.fixtures?.filter(f=>f.id!==intent.fixtureId);
    map.assetOverrides=map.assetOverrides.filter(o=>!(o.role==='prop'&&o.x===intent.x&&o.row===intent.row));
  }
  map.rows=mapRows.map(r=>r.join(''));if(intents.length)map.version=5;
  return {map,issues};
}

/** An explicit replacement keeps the instance ID and validates the new complete footprint before committing. */
export function replacePropInstance(source: GridMap, instanceId: string, bindingId: string, settings: GenerationSettings, bindings: AssetBinding[], reserved: Cell[] = []): GridMap {
  const old=source.propInstances?.find(p=>p.id===instanceId),binding=bindings.find(b=>b.id===bindingId);
  if(!old||!binding||binding.wallMount||!['prop','decoration','vegetation'].includes(binding.role)||!binding.prop?.size)throw new Error('교체할 소품과 크기가 등록된 프리팹을 선택해 주세요.');
  const originalLocks=new Set((source.lockedCells??[]).map(key));
  if(old.cells.some(c=>originalLocks.has(key(c))))throw new Error('잠긴 소품은 교체할 수 없습니다.');
  const map=structuredClone(source),rows=map.rows.map(r=>[...r]),oldCells=new Set(old.cells.map(key));
  markPropGroupAuthored(map, old.id);
  map.propInstances=map.propInstances?.filter(p=>p.id!==old.id);
  for(const c of old.cells)if(rows[c.row][c.x]==='P')rows[c.row][c.x]='.';
  // Limit conversion to this one intention while retaining every neighboring collision layer.
  const locks=new Map((map.lockedCells??[]).map(c=>[key(c),c]));
  for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++)if(rows[row][x]==='P')locks.set(key({x,row}),{x,row});
  for(const fixture of map.fixtures??[])if(['decoration','vegetation'].includes(fixture.role)&&!oldCells.has(key(fixture)))locks.set(key(fixture),{x:fixture.x,row:fixture.row});
  map.lockedCells=[...locks.values()];
  const tempId=`replace_${old.id.slice(0,64)}`;
  const intentRole=binding.role==='prop'&&!binding.prop.blocksMovement?'decoration':binding.role;
  if(intentRole==='prop') {
    rows[old.row][old.x]='P';
    map.assetOverrides=map.assetOverrides.filter(o=>!(o.role==='prop'&&o.x===old.x&&o.row===old.row));
    map.assetOverrides.push({x:old.x,row:old.row,role:'prop',bindingId});
  } else {
    if(map.fixtures?.some(f=>f.id===tempId))throw new Error('소품 교체 임시 ID가 기존 시설과 충돌합니다.');
    (map.fixtures??=[]).push({id:tempId,role:intentRole as 'decoration'|'vegetation',x:old.x,row:old.row,direction:old.direction,offset:{x:0,y:0,z:0},bindingId,anchor:binding.prop.placement});
  }
  map.rows=rows.map(r=>r.join(''));
  const config={...settings,...(settings.designer?{designer:{...settings.designer,props:intentRole==='prop',decorations:intentRole==='decoration',vegetation:intentRole==='vegetation'}}:{})};
  const catalog=bindings.map(b=>b.id===bindingId?{...b,role:intentRole,prop:{...b.prop!,weight:Math.max(1,b.prop!.weight)}}:b);
  const result=placeProps(map,config,catalog,undefined,reserved,{onlyRole:intentRole as 'prop'|'decoration'|'vegetation',facing:old.direction,yawOffset:old.yawOffset??0,...(intentRole!=='prop'?{onlyFixtureId:tempId}:{})}).map;
  const inserted=result.propInstances?.find(p=>!source.propInstances?.some(old=>old.id===p.id));
  // The generated ID may match the removed ID, which is desirable and still identifies the replacement.
  const changed=inserted??result.propInstances?.find(p=>p.x===old.x&&p.row===old.row&&p.bindingId===bindingId);
  if(!changed)throw new Error('소품을 교체할 공간이 없습니다.');
  changed.id=old.id;changed.role=binding.role as 'prop'|'decoration'|'vegetation';changed.authored=true;changed.provenance='manual';
  if(old.groupId)changed.groupId=old.groupId;
  if(source.lockedCells)result.lockedCells=structuredClone(source.lockedCells);else delete result.lockedCells;
  const errors=[...propValidationIssues(result,bindings),...wallMountIssues(result,bindings)].filter(i=>i.severity==='error');
  if(errors.length)throw new Error(errors.map(i=>i.message).join(' '));
  return result;
}

/** Rotate one complete measured object. Failed trials never change the source map. */
export function rotatePropInstance(source: GridMap, instanceId: string, yaw: number, settings: GenerationSettings, bindings: AssetBinding[], reserved: Cell[] = []): GridMap {
  const old=source.propInstances?.find(p=>p.id===instanceId),binding=bindings.find(b=>b.id===old?.bindingId);
  if(!old||!binding?.prop?.size||!Number.isFinite(yaw)||Math.abs(yaw)>1000000)throw new Error('회전할 소품과 유효한 Y 회전 각도를 확인해 주세요.');
  const locks=new Set((source.lockedCells??[]).map(key));
  if(old.cells.some(c=>locks.has(key(c))))throw new Error('잠긴 소품은 회전할 수 없습니다.');
  const size=propWorldSize(binding,normalizePropYaw(yaw))!,cs=source.cellSize;
  const oldCenterX=old.x*cs+old.offset.x+binding.offset.x,oldCenterR=old.row*cs-old.offset.z-binding.offset.z;
  const forbidden=new Set([...reserved,...teleportReservedCells(source)].map(key));
  const oldCells=new Set(old.cells.map(key));
  for(const override of source.assetOverrides)if(override.role==='prop'&&!oldCells.has(key(override)))forbidden.add(key(override));
  const others=new Set((source.propInstances??[]).filter(p=>p.id!==old.id).flatMap(p=>p.cells.map(key)));
  const fixtureVolumes:LocalBounds[]=[];
  // Reserve complete fixture footprints on the floor and check overhead fixtures in three dimensions.
  for(const fixture of source.fixtures??[]){
    if(fixture.wall){fixtureVolumes.push(...fixture.wall.bounds);continue;}
    const b=resolveFixtureBinding(source,bindings,fixture);
    if(!b){if((fixture.anchor??'floor')==='floor')forbidden.add(key(fixture));continue;}
    const angle=(fixture.direction+b.rotationY)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle),native=b.bounds?.size??b.prop?.size;
    const measured=native?{x:Math.abs(native.x*b.scale.x*cos)+Math.abs(native.z*b.scale.z*sin),y:Math.abs(native.y*b.scale.y),z:Math.abs(native.x*b.scale.x*sin)+Math.abs(native.z*b.scale.z*cos)}:undefined;
    if(!measured){if((fixture.anchor??'floor')==='floor')forbidden.add(key(fixture));continue;}
    const anchor=fixturePosition(source,fixture),cx=(b.bounds?.center.x??0)*b.scale.x,cz=(b.bounds?.center.z??0)*b.scale.z;
    const center={x:anchor.x+b.offset.x+cos*cx+sin*cz,y:anchor.y+b.offset.y+(b.bounds?b.bounds.center.y*b.scale.y:measured.y/2),z:anchor.z+b.offset.z-sin*cx+cos*cz};
    fixtureVolumes.push({center,size:measured});
    if((fixture.anchor??'floor')!=='floor')continue;
    const x=center.x+(source.width-1)*cs/2,row=(source.height-1)*cs/2-center.z;
    for(let r=Math.floor((row-measured.z/2)/cs+.5+1e-8);r<=Math.ceil((row+measured.z/2)/cs-.5-1e-8);r++)
      for(let xCell=Math.floor((x-measured.x/2)/cs+.5+1e-8);xCell<=Math.ceil((x+measured.x/2)/cs-.5-1e-8);xCell++)forbidden.add(key({x:xCell,row:r}));
  }
  for(const marker of source.markers??[])forbidden.add(key(marker));
  const candidates:{x:number;row:number;width:number;height:number;cx:number;cr:number}[]=[];
  const minX=Math.floor((oldCenterX-size.x/2)/cs+.5+1e-8),maxX=Math.ceil((oldCenterX+size.x/2)/cs-.5-1e-8);
  const minR=Math.floor((oldCenterR-size.z/2)/cs+.5+1e-8),maxR=Math.ceil((oldCenterR+size.z/2)/cs-.5-1e-8);
  candidates.push({x:minX,row:minR,width:maxX-minX+1,height:maxR-minR+1,cx:oldCenterX,cr:oldCenterR});
  const width=Math.max(1,Math.ceil(size.x/cs-1e-8)),height=Math.max(1,Math.ceil(size.z/cs-1e-8));
  const nearestX=Math.round(oldCenterX/cs-(width-1)/2),nearestR=Math.round(oldCenterR/cs-(height-1)/2);
  const alternatives:typeof candidates=[];
  for(let dr=-1;dr<=1;dr++)for(let dx=-1;dx<=1;dx++){
    const x=nearestX+dx,row=nearestR+dr;
    alternatives.push({x,row,width,height,cx:Math.max((x-.5)*cs+size.x/2,Math.min((x+width-.5)*cs-size.x/2,oldCenterX)),cr:Math.max((row-.5)*cs+size.z/2,Math.min((row+height-.5)*cs-size.z/2,oldCenterR))});
  }
  alternatives.sort((a,b)=>(a.cx-oldCenterX)**2+(a.cr-oldCenterR)**2-((b.cx-oldCenterX)**2+(b.cr-oldCenterR)**2)||a.row-b.row||a.x-b.x);
  candidates.push(...alternatives);
  let failure='회전한 크기가 들어갈 공간이 없습니다.';
  for(const candidate of candidates){
    if(candidate.width*candidate.height>1600)continue;
    const cells=Array.from({length:candidate.width*candidate.height},(_,i)=>({x:candidate.x+i%candidate.width,row:candidate.row+Math.floor(i/candidate.width)}));
    if(cells.some(c=>c.x<0||c.row<0||c.x>=source.width||c.row>=source.height||locks.has(key(c))||others.has(key(c))||forbidden.has(key(c))||!'.P'.includes(source.rows[c.row]?.[c.x]??'_')||source.rows[c.row][c.x]==='P'&&!oldCells.has(key(c))||Math.abs(source.elevations[c.row][c.x]-source.elevations[old.row][old.x])>1e-6))continue;
    const trial=structuredClone(source),rows=trial.rows.map(r=>[...r]);
    for(const c of old.cells)if(rows[c.row][c.x]==='P')rows[c.row][c.x]='.';
    const prop=trial.propInstances!.find(p=>p.id===old.id)!;
    Object.assign(prop,{x:candidate.x,row:candidate.row,size:{...size},cells,yawOffset:normalizePropYaw(yaw)-old.direction,offset:{x:candidate.cx-candidate.x*cs-binding.offset.x,y:old.offset.y,z:candidate.row*cs-candidate.cr-binding.offset.z},authored:true,provenance:'manual'});
    const position=propPosition(trial,prop,binding);
    if(fixtureVolumes.some(v=>Math.abs(position.x-v.center.x)<(size.x+v.size.x)/2-1e-6&&Math.abs(position.z-v.center.z)<(size.z+v.size.z)/2-1e-6&&position.y<v.center.y+v.size.y/2-1e-6&&position.y+size.y>v.center.y-v.size.y/2+1e-6)){failure='회전한 소품이 기존 부착물과 겹칩니다.';continue;}
    for(const c of cells)if(prop.blocksMovement)rows[c.row][c.x]='P';
    trial.rows=rows.map(r=>r.join(''));markPropGroupAuthored(trial,old.id);
    const errors=[...propValidationIssues(trial,bindings),...analyzeLevelDesign(trial,settings).issues,...wallMountIssues(trial,bindings),...teleportIssues(trial,bindings)].filter(i=>i.severity==='error');
    if(errors.length){failure=errors[0].message;continue;}
    if(!connected(trial)){failure='회전 후 기존 바닥 동선이 나뉩니다.';continue;}
    return trial;
  }
  throw new Error(`소품을 회전할 수 없습니다. ${failure}`);
}

export function insertPropInstance(source: GridMap, at: Cell, bindingId: string, settings: GenerationSettings, bindings: AssetBinding[], reserved: Cell[] = []): GridMap {
  if(!'.P'.includes(source.rows[at.row]?.[at.x]??'_')||source.propInstances?.some(p=>p.cells.some(c=>key(c)===key(at))))throw new Error('소품이 없는 평평한 바닥 셀을 선택해 주세요.');
  const copy=structuredClone(source),ids=new Set((copy.propInstances??[]).map(p=>p.id));let suffix=1,instanceId=`prop_manual_${at.x}_${at.row}`;
  while(ids.has(instanceId))instanceId=`prop_manual_${at.x}_${at.row}_${suffix++}`;
  (copy.propInstances??=[]).push({...at,id:instanceId,bindingId,direction:0,offset:{x:0,y:0,z:0},cells:[{...at}],size:{x:.01,y:.01,z:.01},blocksMovement:false,category:'미분류',anchor:'floor'});
  return replacePropInstance(copy,instanceId,bindingId,settings,bindings,reserved);
}

export function removePropInstance(source: GridMap, instanceId: string): GridMap {
  const prop=source.propInstances?.find(p=>p.id===instanceId);if(!prop)throw new Error('삭제할 소품이 없습니다.');
  const locks=new Set((source.lockedCells??[]).map(key));if(prop.cells.some(c=>locks.has(key(c))))throw new Error('잠긴 소품은 삭제할 수 없습니다.');
  const map=structuredClone(source),rows=map.rows.map(r=>[...r]);
  markPropGroupAuthored(map, instanceId);
  for(const c of prop.cells)if(rows[c.row][c.x]==='P')rows[c.row][c.x]='.';
  map.rows=rows.map(r=>r.join(''));map.propInstances=map.propInstances?.filter(p=>p.id!==instanceId);
  return map;
}
