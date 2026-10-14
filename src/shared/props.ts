import type { AssetBinding, Cell, Direction, GenerationRegion, GenerationSettings, GridMap, PropDefinition, PropInstance, RoomPurpose, ValidationIssue, Vec3 } from './types';
import { analyzeLevelDesign, compileLevelDesign, createObstacleEvaluator, type TacticalObstacle } from './level-design';

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

export function parsePropDefinition(value: unknown): PropDefinition {
  if (!record(value) || !only(value,['category','tags','blocksMovement','size','placement','roomTypes','weight']) || !label(value.category)
    || !Array.isArray(value.tags) || value.tags.length > 24 || !value.tags.every(label) || new Set(value.tags).size !== value.tags.length
    || typeof value.blocksMovement !== 'boolean' || (value.size !== undefined && !vec(value.size,true))
    || !['floor','wall','ceiling'].includes(value.placement as string) || !Array.isArray(value.roomTypes) || !value.roomTypes.length
    || !value.roomTypes.every(r=>ROOMS.includes(r)) || new Set(value.roomTypes).size !== value.roomTypes.length
    || !finite(value.weight) || value.weight < 0 || value.weight > 10000) throw new Error('소품 정의의 종류·태그·크기·배치 위치·방 용도·가중치를 확인해 주세요.');
  return structuredClone(value) as unknown as PropDefinition;
}

export function parsePropInstance(value: unknown, width: number, height: number): PropInstance {
  if (!record(value) || !only(value,['id','bindingId','x','row','direction','offset','cells','size','blocksMovement','category','anchor','role'])
    || !id(value.id) || !id(value.bindingId) || !cell(value,width,height) || !direction(value.direction) || !vec(value.offset)
    || !vec(value.size,true) || typeof value.blocksMovement !== 'boolean' || !label(value.category)
    || (value.anchor !== undefined && !['floor','wall','ceiling'].includes(value.anchor as string))
    || (value.role !== undefined && !['prop','decoration'].includes(value.role as string))
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

export interface PropBoundsCatalog { version: 1; assets: { guid: string; size: Vec3 }[] }
export function parsePropBoundsCatalog(value: unknown): PropBoundsCatalog {
  if (!record(value) || !only(value,['version','assets']) || value.version !== 1 || !Array.isArray(value.assets) || value.assets.length > 100000) throw new Error('Unity 소품 크기 파일의 형식(version: 1, assets)을 확인해 주세요.');
  const seen = new Set<string>();
  for (const asset of value.assets) {
    if (!record(asset) || !only(asset,['guid','size']) || typeof asset.guid !== 'string' || !/^[a-fA-F0-9]{32}$/.test(asset.guid) || !vec(asset.size,true)) throw new Error('Unity 소품 크기의 GUID와 양수 XYZ 크기를 확인해 주세요.');
    const guid = asset.guid.toLowerCase();
    if (seen.has(guid)) throw new Error(`Unity 소품 크기 파일에 GUID ${guid}가 중복됩니다.`);
    seen.add(guid);
  }
  return structuredClone(value) as unknown as PropBoundsCatalog;
}
export function applyPropBoundsCatalog(bindings: AssetBinding[], value: unknown): { bindings: AssetBinding[]; updated: number } {
  const catalog = parsePropBoundsCatalog(value), sizes = new Map(catalog.assets.map(a=>[a.guid.toLowerCase(),a.size]));
  let updated = 0;
  const result = bindings.map(binding => {
    const size = sizes.get(binding.prefabGuid.toLowerCase());
    if (!['prop','decoration'].includes(binding.role) || !size) return structuredClone(binding);
    updated++;
    return {...structuredClone(binding),prop:{...(binding.prop ?? suggestPropDefinition(binding)),size:structuredClone(size)}};
  });
  return {bindings:result,updated};
}
export function snapshotPropCatalog(bindings: AssetBinding[]): AssetBinding[] {
  if (!Array.isArray(bindings) || bindings.length > 256) throw new Error('소품 카탈로그는 최대 256개입니다.');
  return bindings.filter(b=>b.role==='prop'||b.role==='decoration').map(b=>({...structuredClone(b),...(b.prop?{prop:parsePropDefinition(b.prop)}:{})}));
}
export function propCatalogPrompt(bindings: AssetBinding[]): string {
  const catalog = snapshotPropCatalog(bindings);
  return catalog.length ? `소품 카탈로그 (확정 배치는 로컬 크기 검사 후 결정): ${JSON.stringify(catalog.map(b=>({id:b.id,role:b.role,label:b.label,...b.prop,scale:b.scale})))}` : '';
}

/** Size is a world-space AABB at the saved rotation, not a scale request. */
export function propWorldSize(binding: AssetBinding, facing: Direction = 0): Vec3 | undefined {
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
    const measured=binding&&propWorldSize(binding,p.direction);
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
function connected(map:GridMap):boolean {
  const open:Cell[]=[];for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++)if('.DRB'.includes(map.rows[row][x]))open.push({x,row});
  if(!open.length)return false;const seen=new Set([key(open[0])]),queue=[open[0]];
  for(let i=0;i<queue.length;i++)for(const [dx,dr]of Object.values(DIRS)){const c=queue[i],next={x:c.x+dx,row:c.row+dr},a=terrainEdge(map,c,dx,dr),b=terrainEdge(map,next,-dx,-dr);if(a!==null&&b!==null&&Math.abs(a-b)<=map.maxStepHeight+1e-6&&!seen.has(key(next))){seen.add(key(next));queue.push(next);}}
  return seen.size===open.length;
}

export interface PropPlacementOptions {
  /** Only a new generation pipeline may move unbound, unlocked P intentions. */
  tactical?: boolean;
  /** Generated decorations may vary their rotation; authored replacement leaves this off. */
  varyGeneratedDecorations?: boolean;
  /** Internal exact rotation trial. Does not alter binding.rotationY. */
  facing?: Direction;
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

/** Place measured obstacles in asymmetric fighting/approach bands with two usable bypasses. */
function placeTacticalProps(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], region: GenerationRegion | undefined, externalReserved: Cell[]): {map: GridMap; issues: ValidationIssue[]} {
  if (!settings.levelDesign || !settings.designer || settings.designer.props === false || !bindings.some(b => b.prop) || !compileLevelDesign(settings).combatRequired) return placeProps(source, settings, bindings, region, externalReserved);
  let map = structuredClone(source);
  const area = region ?? { x: 0, row: 0, width: map.width, height: map.height }, locked = new Set((map.lockedCells ?? []).map(key)), occupied = propOccupancy(map);
  assertWholeProps(map, area);
  const movable: Cell[] = [];
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const c = { x, row };
    if (map.rows[row][x] === 'P' && inside(c, area) && !locked.has(key(c)) && !occupied.has(key(c)) && !map.assetOverrides.some(o => o.role === 'prop' && o.x === x && o.row === row)) movable.push(c);
  }
  if (!movable.length) return placeProps(map, settings, bindings, region, externalReserved);
  const cleared = map.rows.map(row => [...row]); for (const c of movable) cleared[c.row][c.x] = '.'; map.rows = cleared.map(row => row.join(''));
  const propSettings = { ...settings, designer: { ...settings.designer, decorations: false } };
  // Explicit cell overrides and pre-existing instances remain anchored.
  map = placeProps(map, propSettings, bindings, region, externalReserved).map;
  const baseline = analyzeLevelDesign(map, settings), center = baseline.combatCenter ?? baseline.walkableCells[Math.floor(baseline.walkableCells.length / 2)];
  if (!center) throw new Error('전술 소품을 배치할 이동 가능한 공간이 없습니다.');
  const issues: ValidationIssue[] = [], reserved = new Map([...externalReserved, ...baseline.reservedEntryCells, ...baseline.combatCells, ...baseline.routes.flat()].map(c => [key(c), c]));
  const keepRoute = (cells: Cell[]) => {
    const radius = Math.max(0, Math.ceil(settings.levelDesign!.characterRadius / map.cellSize - .5));
    for (const c of cells) for (let dr = -radius; dr <= radius; dr++) for (let dx = -radius; dx <= radius; dx++) { const n = { x: c.x + dx, row: c.row + dr }; reserved.set(key(n), n); }
  };
  const random = seeded(settings.seed ?? 0), sector = Math.floor(random() * 4), side = [[1, 1], [-1, 1], [-1, -1], [1, -1]][sector];
  const catalog = snapshotPropCatalog(bindings), theme = settings.levelDesign.theme?.trim().toLowerCase();
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
      const mirror = previousCenters.some(p => Math.abs((map.width - 1 - p.x) - x) < .51 && Math.abs(p.row - row) < .51 || Math.abs(p.x - x) < .51 && Math.abs((map.height - 1 - p.row) - row) < .51 || Math.abs((map.width - 1 - p.x) - x) < .51 && Math.abs((map.height - 1 - p.row) - row) < .51);
      // Alternate an approach flank and a perpendicular retreat flank, not opposite mirror pairs.
      const sx = index % 3 === 1 ? -side[1] : side[0], sr = index % 3 === 1 ? side[0] : side[1];
      const score = -Math.abs(distance - band) * 5 - Math.abs(routeDistance - 1.5) * 2 + (dx * sx + dr * sr) * .8
        - Math.abs(nearest - 3) * 2 - (mirror ? 30 : 0) + (zone === 'combat' ? 12 : 0) + random() * .5;
      origins.push({ c, score });
    }
    origins.sort((a, b) => b.score - a.score || a.c.row - b.c.row || a.c.x - b.c.x);
    // Inspect the best tactical band first, then widen in bounded batches if footprints need room.
    const ordered = diversityOrder(usable, existing, random);
    let chosen: { map: GridMap; routes: [Cell[], Cell[]] } | undefined;
    for (let start = 0; start < origins.length && !chosen; start += 64) {
    const shortlist = origins.slice(start, start + 64);
    for (const binding of ordered) {
      const orientations = ([0, 90, 180, 270] as Direction[]).map(direction => ({ direction, order: random() })).sort((a, b) => a.order - b.order).map(v => v.direction);
      for (const { c } of shortlist) {
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
            const fitted = placeProps(trial, propSettings, [binding], region, [...reserved.values()], { facing });
            chosen = { map: fitted.map, routes: tactic.routes }; break;
          } catch { /* A physical-fit or global-route conflict rejects this complete candidate. */ }
        }
        if (chosen) break;
      }
      if (chosen) break;
    }
    }
    if (!chosen) throw new Error(`전술 소품 ${index + 1}/${movable.length}의 주요 전투·접근 후보 위치에서 측정된 프리팹과 양쪽 우회 공간을 함께 확보하지 못했습니다. 입구·회피·필수 경로·잠금·요청 수량을 보존했습니다. 방 크기나 소품 조건을 조정해 주세요.`);
    map = chosen.map; chosen.routes.forEach(keepRoute);
  }
  if (settings.designer.decorations) map = placeProps(map, settings, bindings, region, [...reserved.values()], { varyGeneratedDecorations: true }).map;
  return { map, issues };
}

/** Convert generated P intentions and decoration fixtures into fixed, measured instances atomically. */
export function placeProps(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], region?: GenerationRegion, reserved: Cell[] = [], options: PropPlacementOptions = {}): {map:GridMap;issues:ValidationIssue[]} {
  if(options.tactical)return placeTacticalProps(source,settings,bindings,region,reserved);
  const map=structuredClone(source),catalog=snapshotPropCatalog(bindings),issues:ValidationIssue[]=[];
  if(!catalog.some(b=>b.prop))return {map,issues}; // Opening or regenerating a legacy library never changes its assignment scheme.
  const area=region??{x:0,row:0,width:map.width,height:map.height};assertWholeProps(map,area);
  const locks=new Set((map.lockedCells??[]).map(key)),occupied=propOccupancy(map),reservedKeys=new Set(reserved.map(key));
  const mapRows=map.rows.map(r=>[...r]),purpose=settings.designer?.preset??'battle',theme=settings.levelDesign?.theme?.trim().toLowerCase(),random=seeded(settings.seed??0);
  for(const b of catalog)if(!b.prop?.size)issues.push({severity:'warning',code:'prop-unmeasured',message:`${b.label}: 원본 크기 정보가 없어 자동 배치에서 제외했습니다.`});
  const usable=catalog.filter(b=>b.prop?.size&&b.prop.weight>0&&b.prop.roomTypes.includes(purpose)&&(!theme||!b.prop.tags.length||b.prop.tags.some(t=>t.toLowerCase()===theme))).sort((a,b)=>a.id.localeCompare(b.id));
  const intents:({role:'prop'|'decoration';fixtureId?:string;bindingId?:string;facing?:Direction;anchor?:'floor'|'wall'|'ceiling'}&Cell)[]=[];
  if(settings.designer?.props!==false)for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++)if(mapRows[row][x]==='P'&&inside({x,row},area)&&!locks.has(key({x,row}))&&!occupied.has(key({x,row})))intents.push({x,row,role:'prop',bindingId:map.assetOverrides.find(o=>o.x===x&&o.row===row&&o.role==='prop')?.bindingId});
  if(settings.designer?.decorations!==false)for(const f of map.fixtures??[])if(f.role==='decoration'&&inside(f,area)&&!locks.has(key(f)))intents.push({x:f.x,row:f.row,role:'decoration',fixtureId:f.id,bindingId:f.bindingId,facing:options.varyGeneratedDecorations&&!f.bindingId?undefined:f.direction,anchor:f.anchor});
  const intendedKeys=new Set(intents.filter(i=>i.role==='prop').map(key));
  // P marks one intended object, not arbitrary spare space that another object may silently consume.
  const existingIds=new Set((map.propInstances??[]).map(p=>p.id));
  for(const intent of intents){
    if(occupied.has(key(intent)))throw new Error(`소품 의도 (${intent.x}, ${intent.row})가 다른 소품의 점유 영역과 겹칩니다.`);
    const candidates:{binding:AssetBinding;instance:PropInstance}[]=[];
    for(const binding of usable){const def=binding.prop!;if(binding.role!==intent.role||intent.role==='prop'&&!def.blocksMovement||intent.bindingId&&binding.id!==intent.bindingId||intent.anchor&&def.placement!==intent.anchor)continue;
      const facings=options.facing!==undefined?[options.facing]:intent.facing!==undefined?[intent.facing]:options.varyGeneratedDecorations?([0,90,180,270] as Direction[]).map(direction=>({direction,order:random()})).sort((a,b)=>a.order-b.order).map(v=>v.direction):[0,90,180,270] as Direction[];
      for(const facing of facings){
        const size=propWorldSize(binding,facing)!;
        if(size.x>map.width*map.cellSize+1e-6||size.z>map.height*map.cellSize+1e-6)continue;
        const cells=propFootprint(map,intent,size);
        if(cells.some(c=>!inside(c,area)||!inside(c,{x:0,row:0,width:map.width,height:map.height})||locks.has(key(c))||occupied.has(key(c))||reservedKeys.has(key(c))||intendedKeys.has(key(c))&&key(c)!==key(intent)))continue;
        const base=map.elevations[intent.row][intent.x];
        if(cells.some(c=>!'.P'.includes(mapRows[c.row][c.x])||Math.abs(map.elevations[c.row][c.x]-base)>1e-6
          ||(def.placement==='floor'||def.blocksMovement)&&map.markers?.some(m=>m.x===c.x&&m.row===c.row)
          ||map.fixtures?.some(f=>f.id!==intent.fixtureId&&f.x===c.x&&f.row===c.row&&(f.anchor??'floor')===def.placement&&(def.placement!=='wall'||f.direction===facing))))continue;
        const width=Math.max(...cells.map(c=>c.x))-intent.x+1,height=Math.max(...cells.map(c=>c.row))-intent.row+1;
        const instance:PropInstance={id:`prop_${intent.x}_${intent.row}`,bindingId:binding.id,role:intent.role,x:intent.x,row:intent.row,direction:facing,cells,size,offset:{x:(width-1)*map.cellSize/2,y:0,z:-(height-1)*map.cellSize/2||0},blocksMovement:def.blocksMovement,category:def.category,anchor:def.placement};
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
    if(!candidates.length)throw new Error(`소품 (${intent.x}, ${intent.row})에 맞는 측정된 프리팹이 없습니다. 종류·방 용도·테마·크기·천장·통행·잠금을 확인해 주세요.${issues.length?' '+issues.map(i=>i.message).join(' '):''}`);
    // Choose the kind first, then its variant. Adding variants does not overwhelm unrelated kinds.
    const kinds=[...new Set(candidates.map(c=>c.binding.prop!.category))];
    const category=weighted(kinds,k=>{const group=candidates.filter(c=>c.binding.prop!.category===k);return group.reduce((s,c)=>s+c.binding.prop!.weight,0)/group.length;},random);
    const chosen=options.varyGeneratedDecorations?candidates.find(c=>c.binding.id===diversityOrder(candidates.map(c=>c.binding),map.propInstances??[],random)[0].id)!.instance:weighted(candidates.filter(c=>c.binding.prop!.category===category),c=>c.binding.prop!.weight,random).instance;
    const stem=chosen.id;let n=1;while(existingIds.has(chosen.id))chosen.id=`${stem}_${n++}`;existingIds.add(chosen.id);
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
  if(!old||!binding||!['prop','decoration'].includes(binding.role)||!binding.prop?.size)throw new Error('교체할 소품과 크기가 등록된 프리팹을 선택해 주세요.');
  const originalLocks=new Set((source.lockedCells??[]).map(key));
  if(old.cells.some(c=>originalLocks.has(key(c))))throw new Error('잠긴 소품은 교체할 수 없습니다.');
  const map=structuredClone(source),rows=map.rows.map(r=>[...r]),oldCells=new Set(old.cells.map(key));
  map.propInstances=map.propInstances?.filter(p=>p.id!==old.id);
  for(const c of old.cells)if(rows[c.row][c.x]==='P')rows[c.row][c.x]='.';
  // Limit conversion to this one intention while retaining every neighboring collision layer.
  const locks=new Map((map.lockedCells??[]).map(c=>[key(c),c]));
  for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++)if(rows[row][x]==='P')locks.set(key({x,row}),{x,row});
  for(const fixture of map.fixtures??[])if(fixture.role==='decoration'&&!oldCells.has(key(fixture)))locks.set(key(fixture),{x:fixture.x,row:fixture.row});
  map.lockedCells=[...locks.values()];
  const tempId=`replace_${old.id.slice(0,64)}`;
  const intentRole=binding.role==='prop'&&!binding.prop.blocksMovement?'decoration':binding.role;
  if(intentRole==='prop') {
    rows[old.row][old.x]='P';
    map.assetOverrides=map.assetOverrides.filter(o=>!(o.role==='prop'&&o.x===old.x&&o.row===old.row));
    map.assetOverrides.push({x:old.x,row:old.row,role:'prop',bindingId});
  } else {
    if(map.fixtures?.some(f=>f.id===tempId))throw new Error('소품 교체 임시 ID가 기존 시설과 충돌합니다.');
    (map.fixtures??=[]).push({id:tempId,role:'decoration',x:old.x,row:old.row,direction:old.direction,offset:{x:0,y:0,z:0},bindingId,anchor:binding.prop.placement});
  }
  map.rows=rows.map(r=>r.join(''));
  const config={...settings,...(settings.designer?{designer:{...settings.designer,props:intentRole==='prop',decorations:intentRole==='decoration'}}:{})};
  const catalog=bindings.map(b=>b.id===bindingId?{...b,role:intentRole,prop:{...b.prop!,weight:Math.max(1,b.prop!.weight)}}:b);
  const result=placeProps(map,config,catalog,undefined,reserved).map;
  const inserted=result.propInstances?.find(p=>!source.propInstances?.some(old=>old.id===p.id));
  // The generated ID may match the removed ID, which is desirable and still identifies the replacement.
  const changed=inserted??result.propInstances?.find(p=>p.x===old.x&&p.row===old.row&&p.bindingId===bindingId);
  if(!changed)throw new Error('소품을 교체할 공간이 없습니다.');
  changed.id=old.id;changed.role=binding.role as 'prop'|'decoration';
  if(source.lockedCells)result.lockedCells=structuredClone(source.lockedCells);else delete result.lockedCells;
  const errors=propValidationIssues(result,bindings).filter(i=>i.severity==='error');
  if(errors.length)throw new Error(errors.map(i=>i.message).join(' '));
  return result;
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
  for(const c of prop.cells)if(rows[c.row][c.x]==='P')rows[c.row][c.x]='.';
  map.rows=rows.map(r=>r.join(''));map.propInstances=map.propInstances?.filter(p=>p.id!==instanceId);
  return map;
}
