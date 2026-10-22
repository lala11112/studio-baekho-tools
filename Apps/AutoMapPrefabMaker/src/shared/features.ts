import type { AssetBinding, AssetRole, Bridge, Cell, CliffFace, DesignerSettings, Direction, FixtureRole, GenerationRegion, GenerationSettings, GridMap, MapFixture, GameplayMarker, ValidationIssue, Vec3 } from './types';
import { automaticCeilingY, configureStructures, DEFAULT_STRUCTURE_SETTINGS } from './structures';
import { parseLevelDesignSettings, analyzeLevelDesign, DEFAULT_LEVEL_DESIGN, placeLevelDesignContent } from './level-design';
import { placeProps } from './props';
import { clearGroupedPropHints, placeGroupedProps } from './grouped-props';
import { protectedPropIds } from './prop-groups';
import { parseWallMountInstance, placeWallMounts, wallMountDependencies, wallMountIssues } from './wall-mounts';
export type { GenerationRegion } from './types';
import { connectionAt, connectionCells } from './connections';

export const DIRECTIONS: Record<Direction, readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
export const FIXTURE_ROLES: readonly FixtureRole[] = ['light', 'railing', 'column', 'arch', 'water', 'hazard', 'trap', 'gate', 'switch', 'secretDoor', 'rest', 'merchant', 'altar', 'decoration', 'vegetation'];
export const ASSET_ROLES: readonly AssetRole[] = ['floor', 'wall', 'door', 'prop', 'stair', 'slope', 'bridge', 'ceiling', 'cliff', 'deadzone', ...FIXTURE_ROLES];
export const MAX_CEILING_Y = 200;
export const MAX_WALL_HEIGHT = 300;
export const DEFAULT_DESIGNER: DesignerSettings = {
  lightPlacement: 'auto',
  merchants: false, altars: false, structureFill: false, pitBottomKind: 'deadzone', gapRole: 'wall',
  preset: 'battle', ceilings: false, elevation: true, props: true, lights: false, enemies: false, rewards: false, events: false,
  bridges: false, cliffs: false, railings: false, columns: false, arches: false, slopes: false, water: false,
  hazards: false, traps: false, gates: false, secrets: false, rests: false, decorations: false, vegetation: false,
  ceilingHeight: 4, wallHeight: 4, cliffDepth: 4, headroom: 2, fixtureDensity: 5,
  enemyCount: 6, rewardCount: 2, eventCount: 1, bridgeCount: 1, bridgeHeight: 2, cliffCount: 1, cliffSize: 2,
};
export const DESIGNER_PRESETS: Record<DesignerSettings['preset'], DesignerSettings> = {
  battle: { ...DEFAULT_DESIGNER, enemies: true, rewards: true },
  boss: { ...DEFAULT_DESIGNER, preset: 'boss', enemies: true, enemyCount: 1, rewards: true, rewardCount: 1 },
  reward: { ...DEFAULT_DESIGNER, preset: 'reward', elevation: false, props: false, rewards: true, rewardCount: 4, lights: true, rests: true },
  start: { ...DEFAULT_DESIGNER, preset: 'start', elevation: false, props: false },
  shop: { ...DEFAULT_DESIGNER, preset: 'shop', elevation: false, props: false, merchants: true },
};
export function structureSettingsFor(settings: GenerationSettings) {
  const d=settings.designer??DEFAULT_DESIGNER;
  return {...DEFAULT_STRUCTURE_SETTINGS,ceilingClearance:d.ceilingHeight,defaultWallHeight:d.wallHeight,pitDepth:d.cliffDepth,pitBottomKind:d.pitBottomKind??'deadzone',gapRole:d.gapRole??'wall'};
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const keysOnly = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const label = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 80 && !/[\u0000-\u001f\u007f]/.test(v);
const direction = (v: unknown): v is Direction => [0, 90, 180, 270].includes(v as number);
const vector = (v: unknown): v is Vec3 => record(v) && keysOnly(v, ['x','y','z']) && [v.x,v.y,v.z].every(n => finite(n) && Math.abs(n) <= 1000);

/** The same strict parser protects IPC requests and saved settings. Missing designer preserves legacy behavior. */
export function parseGenerationSettings(value: unknown): GenerationSettings {
  if (!record(value) || !keysOnly(value, ['conceptMode','prompt','width','height','cellSize','elevationStep','maxStepHeight','connectionCount','connectionWidth','connectionHeight','codexModel','designer','roomPreset','sizeMode','seed','sizeResolved','levelDesign'])) throw new Error('settings의 구조가 올바르지 않습니다.');
  if (typeof value.prompt !== 'string' || value.prompt.length > 6000) throw new Error('settings 맵 설명은 6,000자 이하로 입력해 주세요.');
  if (value.conceptMode !== undefined && value.conceptMode !== 'ai' && value.conceptMode !== 'manual') throw new Error('컨셉 작성 모드를 확인해 주세요.');
  if (![value.width,value.height].every(n => finite(n) && Number.isInteger(n) && n >= 8 && n <= 40)) throw new Error('settings 가로와 세로는 8~40 사이의 정수여야 합니다.');
  if (!finite(value.cellSize) || value.cellSize < .25 || value.cellSize > 10) throw new Error('settings 한 칸의 크기는 0.25~10m 사이여야 합니다.');
  if (!finite(value.elevationStep) || value.elevationStep < .25 || value.elevationStep > 10) throw new Error('settings 높이 단계는 0.25~10m 사이여야 합니다.');
  if (!finite(value.maxStepHeight) || value.maxStepHeight < .05 || value.maxStepHeight > 1) throw new Error('settings 이동 단차는 0.05~1m 사이여야 합니다.');
  if (!finite(value.connectionCount) || !Number.isInteger(value.connectionCount) || value.connectionCount < 1 || value.connectionCount > 16) throw new Error('settings 연결문 수는 1~16 사이의 정수여야 합니다.');
  if (typeof value.codexModel !== 'string' || (value.codexModel !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.codexModel))) throw new Error('settings Codex 모델 ID를 확인해 주세요.');
  const result: GenerationSettings = { conceptMode: value.conceptMode ?? 'manual', prompt: value.prompt.trim(), width: value.width as number, height: value.height as number, cellSize:value.cellSize, elevationStep:value.elevationStep, maxStepHeight:value.maxStepHeight, connectionCount:value.connectionCount, codexModel:value.codexModel };
  if (value.connectionWidth !== undefined) {
    if (!finite(value.connectionWidth) || value.connectionWidth < .25 || value.connectionWidth > 40) throw new Error('settings 연결문 폭은 0.25~40m 사이여야 합니다.');
    result.connectionWidth = value.connectionWidth;
  }
  if (value.connectionHeight !== undefined) {
    if (!finite(value.connectionHeight) || value.connectionHeight < .25 || value.connectionHeight > 20) throw new Error('settings 연결문 높이는 0.25~20m 사이여야 합니다.');
    result.connectionHeight = value.connectionHeight;
  }
  if(value.roomPreset!==undefined){if(!['small','medium','large','boss','start','reward','shop'].includes(value.roomPreset as string))throw new Error('방 규격을 확인하세요.');result.roomPreset=value.roomPreset as GenerationSettings['roomPreset'];}
  if(value.sizeMode!==undefined){if(!['preset','custom'].includes(value.sizeMode as string))throw new Error('크기 모드를 확인하세요.');result.sizeMode=value.sizeMode as GenerationSettings['sizeMode'];}
  if(value.seed!==undefined){if(!finite(value.seed)||!Number.isInteger(value.seed)||value.seed<0||value.seed>0xffffffff)throw new Error('생성 시드는 0~4294967295 정수여야 합니다.');result.seed=value.seed;}
  if(value.sizeResolved!==undefined){if(typeof value.sizeResolved!=='boolean')throw new Error('크기 확정 상태를 확인하세요.');result.sizeResolved=value.sizeResolved;}
  // Presets resolve their dimensions immediately before generation; saved preview dimensions may differ.
  if (result.connectionWidth !== undefined && !(result.sizeMode === 'preset' && result.roomPreset && !result.sizeResolved)
    && result.connectionWidth > Math.max(result.width, result.height) * result.cellSize + 1e-8)
    throw new Error('settings 연결문 폭이 맵의 가로·세로 길이보다 큽니다. 문 폭을 줄이거나 맵 크기를 늘려 주세요.');
  if(value.levelDesign!==undefined)result.levelDesign=parseLevelDesignSettings(value.levelDesign);
  if (value.designer !== undefined) {
    const d = value.designer;
    if (!record(d) || !keysOnly(d,[...Object.keys(DEFAULT_DESIGNER),'decorationDensity','vegetationDensity','propLayout','propCoverage','wallMounts'])) throw new Error('settings.designer의 구조가 올바르지 않습니다.');
    if(d.wallMounts!==undefined){
      const w=d.wallMounts;
      if(!record(w)||!keysOnly(w,['enabled','singles','runs','density','runDensity','placeholderFallback','runOrientation','connectRuns','runHeight','verticalRange'])||w.connectRuns!==undefined&&typeof w.connectRuns!=='boolean'||w.placeholderFallback!==undefined&&typeof w.placeholderFallback!=='boolean'||w.runOrientation!==undefined&&!['horizontal','vertical','both'].includes(w.runOrientation as string)||['enabled','singles','runs'].some(k=>typeof w[k]!=='boolean')||['density','runDensity'].some(k=>!finite(w[k])||!Number.isInteger(w[k])||Number(w[k])<1||Number(w[k])>100))throw new Error('벽 부착물의 토글·배관 방향·밀도(1~100%)를 확인하세요.');
      if (w.runHeight !== undefined) {
        const h = w.runHeight;
        if (!record(h) || !keysOnly(h, ['mode','reference','min','max']) || !['fixed','random'].includes(h.mode as string)
          || !['floor','top'].includes(h.reference as string) || !finite(h.min) || !finite(h.max)
          || h.min < 0 || h.max > 100 || h.min > h.max || h.mode === 'fixed' && h.min !== h.max)
          throw new Error('가로 배관 높이는 0~100m 범위여야 합니다. 최소≤최대, 지정 높이는 최소=최대로 설정하세요.');
      }
      if (w.verticalRange !== undefined) {
        const h = w.verticalRange;
        if (!record(h) || !keysOnly(h, ['reference','start','end']) || !['floor','top'].includes(h.reference as string)
          || !finite(h.start) || !finite(h.end) || h.start < 0 || h.end > 100 || h.start >= h.end)
          throw new Error('세로 배관 범위는 0~100m 안에서 시작 거리가 끝 거리보다 작아야 합니다.');
      }
    }
    const merged = { ...DEFAULT_DESIGNER, ...d, ...(d.rests===true ? { merchants:d.merchants??true, altars:d.altars??true } : {}) };
    for (const [key,defaultValue] of Object.entries(DEFAULT_DESIGNER)) {
      if (typeof defaultValue === 'boolean' && typeof merged[key as keyof DesignerSettings] !== 'boolean') throw new Error(`settings.designer.${key}는 토글이어야 합니다.`);
    }
    if (!['battle','boss','reward','start','shop'].includes(merged.preset as string)) throw new Error('방 용도는 전투·보스·보상·시작·상점 중 하나여야 합니다.');
    if(!['floor','deadzone'].includes(merged.pitBottomKind as string)||!['wall','cliff'].includes(merged.gapRole as string))throw new Error('구조 마감 역할을 확인하세요.');
    if (!['auto','ceiling','wall','both'].includes(merged.lightPlacement as string)) throw new Error('settings.designer.lightPlacement는 auto, ceiling, wall, both 중 하나여야 합니다.');
    for (const key of ['ceilingHeight','wallHeight','cliffDepth','headroom','bridgeHeight'] as const) if (!finite(merged[key]) || merged[key] < .25 || merged[key] > 20) throw new Error(`settings.designer.${key}는 0.25~20m여야 합니다.`);
    for (const key of ['enemyCount','rewardCount','eventCount','bridgeCount','cliffCount','cliffSize','fixtureDensity'] as const) if (!finite(merged[key]) || !Number.isInteger(merged[key]) || merged[key] < 1 || merged[key] > (key === 'fixtureDensity' ? 100 : key === 'bridgeCount' || key === 'cliffCount' ? 8 : key === 'cliffSize' ? 8 : 100)) throw new Error(`settings.designer.${key}의 수량이 범위를 벗어났습니다.`);
    for (const key of ['decorationDensity','vegetationDensity'] as const) if (d[key] !== undefined && (!finite(d[key]) || !Number.isInteger(d[key]) || d[key] < 1 || d[key] > 100)) throw new Error(`settings.designer.${key}의 밀도는 1~100 사이의 정수여야 합니다.`);
    if (d.propLayout !== undefined && !['legacy','balanced','grouped'].includes(d.propLayout as string)) throw new Error('소품 구성 방식은 구역별 묶음 구성·자동 균형 구성·기존 개수 유지 중 하나여야 합니다.');
    if (d.propCoverage !== undefined && (!finite(d.propCoverage) || !Number.isInteger(d.propCoverage) || d.propCoverage < 1 || d.propCoverage > 30)) throw new Error('소품 목표 바닥 점유율은 1~30 사이의 정수여야 합니다.');
    if (merged.ceilings && merged.ceilingHeight < merged.headroom) throw new Error('천장 높이가 캐릭터 여유 높이보다 낮습니다.');
    if (merged.slopes && !merged.elevation) throw new Error('경사로를 생성하려면 높이 지형을 켜 주세요.');
    result.designer = merged as DesignerSettings;
  }
  return result;
}

export function fixturePosition(map: GridMap, item: Cell & { offset?: Vec3; anchor?: MapFixture['anchor']; direction?: Direction; wall?:MapFixture['wall'] }): Vec3 {
  if(item.wall)return {...item.wall.position};
  let y = map.elevations[item.row]?.[item.x] ?? 0;
  if (item.anchor === 'ceiling') y = map.ceilings?.find(c => c.x === item.x && c.row === item.row)?.undersideY ?? y;
  if (item.anchor === 'wall') y += (map.wallHeights?.find(c => c.x === item.x && c.row === item.row)?.height ?? 3) / 2;
  const [dx,dr] = item.anchor === 'wall' ? DIRECTIONS[item.direction ?? 0] : [0,0];
  return { x: (item.x - (map.width-1)/2 + dx/2)*map.cellSize + (item.offset?.x ?? 0), y:y+(item.offset?.y ?? 0), z:((map.height-1)/2-item.row-dr/2)*map.cellSize+(item.offset?.z ?? 0) };
}
export const markerPosition = fixturePosition;

/** Keep a room's flat roof continuous across enclosed pits, while leaving exterior void uncovered. */
export function ceilingEligibleCells(map:GridMap):Cell[] {
  const interiorVoid=new Set(interiorPitRegions(map).flat().filter(c=>map.rows[c.row][c.x]==='_').map(c=>`${c.x},${c.row}`));
  const cells:Cell[]=[];
  for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++)if('.DPRB'.includes(map.rows[row][x])||interiorVoid.has(`${x},${row}`))cells.push({x,row});
  return cells;
}

/** No bridge underside/support. Only solid land rims bordering void produce cliff faces. */
export function exposedCliffFaces(map: GridMap, depth: number): CliffFace[] {
  const faces: CliffFace[] = [];
  for (let row=0;row<map.height;row++) for (let x=0;x<map.width;x++) {
    if (!'.P#R'.includes(map.rows[row][x])) continue;
    for (const d of [0,90,180,270] as const) { const [dx,dy]=DIRECTIONS[d]; if ((map.rows[row+dy]?.[x+dx] ?? '_')==='_') faces.push({x,row,direction:d,depth}); }
  }
  return faces;
}

export function featureStructureErrors(input: Record<string, unknown>): string[] {
  const errors: string[]=[];
  const cell = (v: Record<string,unknown>) => finite(v.x)&&Number.isInteger(v.x)&&v.x>=0&&v.x<Number(input.width)&&finite(v.row)&&Number.isInteger(v.row)&&v.row>=0&&v.row<Number(input.height);
  const arrays: Record<string,{keys:string[];check:(v:Record<string,unknown>)=>boolean; max?:number; unique:(v:Record<string,unknown>)=>string}> = {
    ceilings:{keys:['x','row','undersideY','heightMode'],check:v=>finite(v.undersideY)&&Math.abs(v.undersideY)<=MAX_CEILING_Y&&(v.heightMode===undefined||['auto','manual'].includes(v.heightMode as string)),unique:v=>`${v.x},${v.row}`},
    wallHeights:{keys:['x','row','height','heightMode'],check:v=>finite(v.height)&&v.height>=.25&&v.height<=MAX_WALL_HEIGHT&&(v.heightMode===undefined||['auto','manual'].includes(v.heightMode as string)),unique:v=>`${v.x},${v.row}`},
    bridges:{keys:['x','row','direction'],check:v=>direction(v.direction),unique:v=>`${v.x},${v.row}`},
    cliffs:{keys:['x','row','direction','depth'],check:v=>direction(v.direction)&&finite(v.depth)&&v.depth>=.25&&v.depth<=20,max:6400,unique:v=>`${v.x},${v.row},${v.direction}`},
    fixtures:{keys:['id','role','x','row','direction','offset','bindingId','anchor','linkedId','wall'],check:v=>safeId(v.id)&&FIXTURE_ROLES.includes(v.role as FixtureRole)&&direction(v.direction)&&vector(v.offset)&&(v.bindingId===undefined||safeId(v.bindingId))&&(v.anchor===undefined||['floor','wall','ceiling'].includes(v.anchor as string))&&(v.linkedId===undefined||safeId(v.linkedId)),max:3200,unique:v=>String(v.id)},
    markers:{keys:['id','label','kind','contentKey','x','row','direction','offset'],check:v=>safeId(v.id)&&label(v.label)&&['enemy','reward','event'].includes(v.kind as string)&&typeof v.contentKey==='string'&&v.contentKey.length<=120&&!/[\u0000-\u001f\u007f]/.test(v.contentKey)&&direction(v.direction)&&vector(v.offset),unique:v=>String(v.id)},
    lockedCells:{keys:['x','row'],check:()=>true,unique:v=>`${v.x},${v.row}`},
    zones:{keys:['x','row','kind'],check:v=>['combat','reward','rest'].includes(v.kind as string),unique:v=>`${v.x},${v.row}`},
  };
  for (const [key,spec] of Object.entries(arrays)) {
    const a=input[key]; if (a===undefined) continue;
    if (!Array.isArray(a)||a.length>(spec.max??1600)) { errors.push(`map.${key} 배열의 크기 또는 구조가 올바르지 않습니다.`); continue; }
    const ids=new Set<string>();
    for (const item of a) {
      if (!record(item)||!keysOnly(item,spec.keys)||!cell(item)||!spec.check(item)) { errors.push(`map.${key} 항목의 좌표 또는 값이 올바르지 않습니다.`); continue; }
      if(key==='fixtures'&&item.wall!==undefined)try{const wall=parseWallMountInstance(item.wall,Number(input.width),Number(input.height));if(item.anchor!=='wall'||(wall.placeholder?!!item.bindingId||!!wall.bindingReference:!item.bindingId))throw new Error('벽 부착물에는 벽 기준과 지정 프리팹 또는 임시 부착물 정보가 필요합니다. 임시 부착물에는 프리팹 참조를 저장할 수 없습니다.');}catch(e){errors.push(e instanceof Error?e.message:String(e));}
      const id=spec.unique(item); if(ids.has(id)) errors.push(`map.${key} 항목이 중복되었습니다: ${id}`); ids.add(id);
    }
  }
  if(input.headroom!==undefined&&(!finite(input.headroom)||input.headroom<.25||input.headroom>20)) errors.push('map.headroom은 0.25~20m여야 합니다.');
  return errors;
}

export function featureValidationIssues(map: GridMap): ValidationIssue[] {
  const issues: ValidationIssue[]=[]; const error=(message:string)=>issues.push({severity:'error',message});
  const eligibleCeilings=new Set(ceilingEligibleCells(map).map(c=>`${c.x},${c.row}`));
  for(const c of map.ceilings??[]) {
    const tile=map.rows[c.row][c.x]; const top=(map.elevations[c.row][c.x])+(map.ramps.find(r=>r.x===c.x&&r.row===c.row)?.rise??0);
    if(!eligibleCeilings.has(`${c.x},${c.row}`)) error(`천장(${c.x}, ${c.row})은 바닥 또는 내부 낭떠러지 위에 배치해야 합니다.`);
    if(tile!=='_'&&c.undersideY-top<(map.headroom??2)-1e-8) error(`천장(${c.x}, ${c.row})의 머리 위 여유 높이가 부족합니다.`);
    const door=connectionAt(map,c.x,c.row); if(door&&c.undersideY-map.elevations[c.row][c.x]<door.height) error(`천장(${c.x}, ${c.row})이 연결문 높이보다 낮습니다.`);
  }
  for(const w of map.wallHeights??[]) if(map.rows[w.row][w.x]!=='#') error(`벽 높이(${w.x}, ${w.row})는 벽 타일에만 지정할 수 있습니다.`);
  const bridgeAt=(x:number,row:number)=>map.bridges?.find(b=>b.x===x&&b.row===row);
  for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++)if(map.rows[row][x]==='B'&&!bridgeAt(x,row))error(`다리(${x}, ${row})의 방향 정보가 없습니다.`);
  for(const b of map.bridges??[]) {
    if(map.rows[b.row][b.x]!=='B') {error(`다리(${b.x}, ${b.row})는 B 타일에 있어야 합니다.`);continue;}
    const [dx,dy]=DIRECTIONS[b.direction];
    for(const sign of [-1,1]) {
      if((map.rows[b.row+dx*sign]?.[b.x+dy*sign]??'_')!=='_') error(`다리(${b.x}, ${b.row})의 양옆은 빈 공간이어야 합니다.`);
      const x=b.x+dx*sign,row=b.row+dy*sign,tile=map.rows[row]?.[x]??'_';
      if(!'.DRB'.includes(tile))error(`다리(${b.x}, ${b.row})의 양 끝은 바닥이나 같은 축의 다리에 연결되어야 합니다.`);
      if('.DRB'.includes(tile)) {
        let edge=map.elevations[row][x];
        if(tile==='R') {const ramp=map.ramps.find(r=>r.x===x&&r.row===row);const ascent=ramp?DIRECTIONS[ramp.direction]:null;
          if(!ramp||!ascent||Math.abs(ascent[0])!==Math.abs(dx))edge=Infinity;
          else if(ascent[0]===-dx*sign&&ascent[1]===-dy*sign)edge+=ramp.rise;
        }
        if(Math.abs(edge-map.elevations[b.row][b.x])>map.maxStepHeight+1e-8)error(`다리(${b.x}, ${b.row})의 양 끝 진입 높이가 맞지 않습니다.`);
      }
      if(tile==='B'&&(bridgeAt(x,row)?.direction??-1)%180!==b.direction%180)error(`다리(${b.x}, ${b.row})는 직선으로 이어져야 합니다.`);
      if(tile==='B'&&Math.abs(map.elevations[row][x]-map.elevations[b.row][b.x])>1e-8)error(`다리(${b.x}, ${b.row})의 연결된 상판은 같은 높이여야 합니다.`);
    }
  }
  const faceKeys=new Set(exposedCliffFaces(map,1).map(c=>`${c.x},${c.row},${c.direction}`));
  for(const c of map.cliffs??[])if(!faceKeys.has(`${c.x},${c.row},${c.direction}`))error(`절벽(${c.x}, ${c.row})은 빈 공간에 노출된 지형 가장자리에 있어야 합니다.`);
  for(const f of map.fixtures??[]) {
    if(f.wall)continue;
    const tile=map.rows[f.row][f.x];
    if(f.anchor==='ceiling'&&!map.ceilings?.some(c=>c.x===f.x&&c.row===f.row))error(`시설 ${f.id}의 천장 기준점이 없습니다.`);
    else if(f.anchor==='wall'&&tile!=='#')error(`시설 ${f.id}의 벽 기준점이 없습니다.`);
    else if((f.anchor??'floor')==='floor'&&!'.DPB'.includes(tile))error(`시설 ${f.id}는 평평한 바닥에 배치해야 합니다.`);
    if(f.linkedId&&!map.fixtures?.some(target=>target.id===f.linkedId&&target.id!==f.id))error(`시설 ${f.id}의 연결 대상이 없습니다.`);
    if(Math.abs(f.offset.x)>map.cellSize/2||Math.abs(f.offset.z)>map.cellSize/2)error(`시설 ${f.id}의 오프셋은 지정한 셀 안에 있어야 합니다.`);
  }
  for(const m of map.markers??[]){
    if(!'.DB'.includes(map.rows[m.row][m.x]))error(`게임 마커 ${m.id}는 이동 가능한 평평한 바닥에 있어야 합니다.`);
    if(Math.abs(m.offset.x)>map.cellSize/2||Math.abs(m.offset.z)>map.cellSize/2)error(`게임 마커 ${m.id}의 오프셋은 지정한 셀 안에 있어야 합니다.`);
  }
  return issues;
}

function generationProtectedCells(map:GridMap, region?:GenerationRegion, includeExistingProps=true):Cell[] {
  const protectedCells:Cell[]=[...(map.lockedCells??[]),...map.connections.flatMap(c=>connectionCells(map,c)),
    ...map.assetOverrides.filter(o=>o.role==='prop'),
    ...(map.fixtures??[]).filter(f=>!!f.bindingId&&(f.role==='decoration'||f.role==='vegetation')),
    ...(map.fixtures??[]).filter(f=>f.wall).flatMap(wallMountDependencies)];
  const locked=new Set(protectedCells.map(c=>`${c.x},${c.row}`));
  const inside=(c:Cell)=>!region||c.x>=region.x&&c.x<region.x+region.width&&c.row>=region.row&&c.row<region.row+region.height;
  const protectedIds=protectedPropIds({...map,lockedCells:protectedCells},region);
  for(const prop of map.propInstances??[]){
    const crossing=prop.cells.some(inside)&&!prop.cells.every(inside);
    if(includeExistingProps||crossing||protectedIds.has(prop.id)||prop.cells.some(c=>locked.has(`${c.x},${c.row}`)))protectedCells.push(...prop.cells);
  }
  return protectedCells;
}

function generationArea(map:GridMap, region?:GenerationRegion, includeExistingProps=true): (cell:Cell)=>boolean {
  if(!region)return()=>true;
  if(![region.x,region.row,region.width,region.height].every(Number.isInteger)||region.x<0||region.row<0||region.width<1||region.height<1||region.x+region.width>map.width||region.row+region.height>map.height)throw new Error('재생성 영역은 맵 내부의 정수 좌표여야 합니다.');
  const locked=new Set(generationProtectedCells(map,region,includeExistingProps).map(c=>`${c.x},${c.row}`));
  return c=>c.x>=region.x&&c.x<region.x+region.width&&c.row>=region.row&&c.row<region.row+region.height&&!locked.has(`${c.x},${c.row}`);
}

type LightingCandidate = Cell & { anchor:'ceiling'|'wall'; direction:Direction; planeX:number; planeRow:number; nearest:number };

/** Reposition only lights; fluorescent strips/panels use authored prefabs and existing anchors. */
export function reapplyLighting(source:GridMap, settings:GenerationSettings, region?:GenerationRegion, bindings?:AssetBinding[]):GridMap {
  const map=structuredClone(source),d=settings.designer;
  if(!d)return map;
  const inside=generationArea(map,region);
  const protectedCells=new Set([...(map.lockedCells??[]),...map.connections.flatMap(c=>connectionCells(map,c))].map(c=>`${c.x},${c.row}`));
  const active=(c:Cell)=>inside(c)&&!protectedCells.has(`${c.x},${c.row}`);
  const previous=(map.fixtures??[]).filter(f=>f.role==='light'&&!f.wall&&active(f));
  map.fixtures=(map.fixtures??[]).filter(f=>f.wall||f.role!=='light'||!active(f));
  const ensureLinks=()=>{
    const ids=new Set(map.fixtures!.map(f=>f.id));
    if(map.fixtures!.some(f=>f.linkedId&&!ids.has(f.linkedId)))throw new Error('다른 시설이 참조하는 조명을 삭제할 수 없습니다. 연결을 해제하거나 조명 밀도를 늘려 주세요.');
  };
  if(bindings?.some(b=>b.role==='light'&&b.wallMount)&&!bindings.some(b=>b.role==='light'&&!b.wallMount)){ensureLinks();return map;}
  if(!d.lights){ensureLinks();return map;}
  const eligible=ceilingEligibleCells(map),eligibleKeys=new Set(eligible.map(c=>`${c.x},${c.row}`));
  const ceilingCandidates:LightingCandidate[]=(map.ceilings??[]).filter(c=>active(c)&&eligibleKeys.has(`${c.x},${c.row}`)).map(c=>({x:c.x,row:c.row,anchor:'ceiling',direction:0,planeX:c.x,planeRow:c.row,nearest:Infinity}));
  const wallCandidates:LightingCandidate[]=[];
  for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++){
    if(map.rows[row][x]!=='#'||!active({x,row}))continue;
    for(const direction of [0,90,180,270] as const){
      const[dx,dr]=DIRECTIONS[direction];
      if(eligibleKeys.has(`${x+dx},${row+dr}`))wallCandidates.push({x,row,anchor:'wall',direction,planeX:x+dx/2,planeRow:row+dr/2,nearest:Infinity});
    }
  }
  const requested=d.lightPlacement??'auto';
  const mode=requested==='auto'?(ceilingCandidates.length?'ceiling':'wall'):requested;
  if((mode==='ceiling'||mode==='both')&&!ceilingCandidates.length)throw new Error('형광등을 설치할 천장이 없습니다. 천장을 만들거나 벽 조명 모드를 선택해 주세요.');
  if((mode==='wall'||mode==='both')&&!wallCandidates.length)throw new Error('발광 패널을 설치할 실내 벽면이 없습니다. 벽을 선택하거나 천장 조명 모드를 선택해 주세요.');
  const candidates=mode==='ceiling'?ceilingCandidates:mode==='wall'?wallCandidates:[...ceilingCandidates,...wallCandidates];
  const area=eligible.filter(active),count=Math.max(mode==='both'?2:1,Math.ceil((area.length||candidates.length)*d.fixtureDensity/100));
  if(count>candidates.length)throw new Error(`조명 ${count}개를 분산 배치할 천장·벽면이 부족합니다. 조명 밀도를 줄여 주세요.`);
  const centerCells=area.length?area:candidates;
  const center={x:centerCells.reduce((sum,c)=>sum+c.x,0)/centerCells.length,row:centerCells.reduce((sum,c)=>sum+c.row,0)/centerCells.length};
  const seeds=map.fixtures.filter(f=>f.role==='light').map(f=>{const p=fixturePosition(map,f);return{x:p.x/map.cellSize+(map.width-1)/2,row:(map.height-1)/2-p.z/map.cellSize};});
  const updateDistances=(point:Cell)=>{for(const c of candidates)c.nearest=Math.min(c.nearest,(c.planeX-point.x)**2+(c.planeRow-point.row)**2);};
  for(const seed of seeds)updateDistances(seed);
  const usedIds=new Set([...map.fixtures,...(map.markers??[])].map(f=>f.id));
  const idFor=(index:number)=>{let id=previous[index]?.id??`light-${index+1}`,suffix=1;const base=id;while(usedIds.has(id))id=`${base.slice(0,70)}-${++suffix}`;usedIds.add(id);return id;};
  for(let index=0;index<count;index++){
    const preferred=mode==='both'?(index%2===0?'ceiling':'wall'):mode;
    const preferredPool=candidates.filter(c=>c.anchor===preferred),pool=preferredPool.length?preferredPool:candidates;
    let selected=pool[0],best=-Infinity;
    for(const c of pool){
      const score=index===0&&!seeds.length?-((c.planeX-center.x)**2+(c.planeRow-center.row)**2):c.nearest;
      if(score>best){best=score;selected=c;}
    }
    candidates.splice(candidates.indexOf(selected),1);
    const old=previous[index];
    map.fixtures.push({id:idFor(index),role:'light',x:selected.x,row:selected.row,anchor:selected.anchor,direction:selected.direction,offset:{x:0,y:0,z:0},...(old?.bindingId&&old.anchor===selected.anchor?{bindingId:old.bindingId}:{}),...(old?.linkedId?{linkedId:old.linkedId}:{})});
    updateDistances({x:selected.planeX,row:selected.planeRow});
  }
  ensureLinks();
  return map;
}

/** Local deterministic layers; region mode leaves outside/locked cells and their metadata intact. */
export function applyGeneratedFeatures(source: GridMap, settings: GenerationSettings, region?:GenerationRegion, catalog?:AssetBinding[]): GridMap {
  const active=generationArea(source,region),map=structuredClone(source);
  if(!settings.designer)return { ...map, version:map.version===5?5:4, ceilings:map.ceilings??[],wallHeights:map.wallHeights??[],bridges:map.bridges??[],cliffs:map.cliffs??[],fixtures:map.fixtures??[],markers:map.markers??[],lockedCells:map.lockedCells??[],zones:map.zones??[] };
  const d=settings.designer;
  // Direct region callers receive the same whole-object protection as the region merge pipeline.
  // Temporary locks also keep local content relocation from moving authored dressing.
  const originalLocks=map.lockedCells;
  if(region&&['balanced','grouped'].includes(d.propLayout??''))map.lockedCells=[...new Map(generationProtectedCells(map,region).map(c=>[`${c.x},${c.row}`,{x:c.x,row:c.row}])).values()];
  // Grouped hints are optional: clear them before selecting floors, objectives and routes.
  if(d.propLayout==='grouped'&&(d.props||d.decorations||d.vegetation))map.rows=clearGroupedPropHints(map,region).rows;
  map.version=source.version===5?5:4;
  if(!region)map.headroom=d.headroom;
  map.ceilings=(map.ceilings??[]).filter(c=>!active(c));
  map.wallHeights=(map.wallHeights??[]).filter(c=>!active(c));
  map.fixtures=(map.fixtures??[]).filter(c=>!!c.wall||!active(c));
  map.markers=(map.markers??[]).filter(c=>!active(c));
  map.cliffs=(map.cliffs??[]).filter(c=>!active(c));
  if(d.cliffs)map.cliffs.push(...exposedCliffFaces(map,d.cliffDepth).filter(active));
  map.lockedCells??=[];map.zones??=[];map.bridges??=[];
  const floors:Cell[]=[];
  const ceilingCells=new Set(ceilingEligibleCells(map).map(c=>`${c.x},${c.row}`));
  const doorCells=map.connections.flatMap(c=>connectionCells(map,c));
  const ceilingY=automaticCeilingY(map,d.ceilingHeight);
  for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++) {
    if(!active({x,row}))continue;
    const t=map.rows[row][x];
    if(t==='#')map.wallHeights.push({x,row,height:d.ceilings?ceilingY-map.elevations[row][x]:d.wallHeight});
    if(d.ceilings&&ceilingCells.has(`${x},${row}`))map.ceilings.push({x,row,undersideY:ceilingY});
    if(t==='.'&&!doorCells.some(p=>Math.abs(p.x-x)+Math.abs(p.row-row)<=1))floors.push({x,row});
  }
  map.ramps=map.ramps.map(r=>active(r)?{...r,kind:d.slopes?'slope':'stair'}:r);
  const desired=Math.max(1,Math.ceil(floors.length*d.fixtureDensity/100));
  const available=[...floors],zones=new Map(map.zones.map(z=>[`${z.x},${z.row}`,z.kind]));
  const dressing:Cell[]=[...map.fixtures.filter(f=>f.role==='decoration'||f.role==='vegetation'),...(map.propInstances??[]).filter(p=>p.role==='decoration'||p.role==='vegetation').flatMap(p=>p.cells)];
  const usedIds=new Set([...map.fixtures,...map.markers].map(item=>item.id));
  const idFor=(base:string)=>{let id=base,suffix=1;while(usedIds.has(id))id=`${base}-${++suffix}`;usedIds.add(id);return id;};
  const next=(preferred?:'combat'|'reward'|'rest',spread=false)=>{
    let index=preferred?available.findIndex(c=>zones.get(`${c.x},${c.row}`)===preferred):-1;
    // Leave specifically marked areas available to matching content when neutral cells exist.
    if(index<0)index=available.findIndex(c=>!zones.has(`${c.x},${c.row}`));
    if(spread&&available.length){
      const neutral=available.some(c=>!zones.has(`${c.x},${c.row}`));
      const score=(c:Cell)=>{
        const spacing=dressing.length?Math.min(...dressing.map(p=>Math.hypot(c.x-p.x,c.row-p.row)))*4:0;
        let hash=(Math.imul(c.x+1,73856093)^Math.imul(c.row+1,19349663)^Math.imul(settings.seed??0,83492791))>>>0;
        hash=Math.imul(hash^(hash>>>16),2246822507)>>>0;
        return spacing+((hash^(hash>>>13))>>>0)/4294967296;
      };
      let best=-Infinity;
      for(let i=0;i<available.length;i++)if(!neutral||!zones.has(`${available[i].x},${available[i].row}`)){
        const value=score(available[i]);if(value>best){best=value;index=i;}
      }
    }
    return available.splice(Math.max(0,index),1)[0];
  };
  const fixture=(role:FixtureRole,count=desired,preferred?:'combat'|'reward'|'rest')=>{
    const created:MapFixture[]=[];
    if(catalog?.some(b=>b.role===role&&b.wallMount)&&!catalog.some(b=>b.role===role&&!b.wallMount))return created;
    for(let i=0;i<count;i++){
      const spread=role==='decoration'||role==='vegetation';
      const c=next(preferred,spread);if(!c)throw new Error(`${region?'선택한 잠금 해제 영역에 ':''}${role} 시설 ${count}개를 배치할 빈 바닥이 부족합니다.`);
      const f:MapFixture={id:idFor(`${role}-${i+1}`),role,...c,direction:0,offset:{x:0,y:0,z:0},...(role==='light'&&d.ceilings?{anchor:'ceiling' as const}: {})};
      map.fixtures!.push(f);created.push(f);if(spread)dressing.push(c);
    }
    return created;
  };
  const categories: [keyof DesignerSettings,FixtureRole][]=[['columns','column'],['arches','arch'],['water','water'],['hazards','hazard'],['traps','trap'],['secrets','secretDoor']];
  for(const [flag,role] of categories)if(d[flag])fixture(role);
  if(d.decorations&&d.propLayout!=='grouped')fixture('decoration',Math.max(1,Math.ceil(floors.length*(d.decorationDensity??d.fixtureDensity)/100)));
  if(d.vegetation&&d.propLayout!=='grouped')fixture('vegetation',Math.max(1,Math.ceil(floors.length*(d.vegetationDensity??d.fixtureDensity)/100)));
  if(d.gates){const gate=fixture('gate',1)[0],trigger=fixture('switch',1)[0];trigger.linkedId=gate.id;}
  if(d.rests)fixture('rest',1,'rest');
  if(d.merchants??d.rests)fixture('merchant',1,'rest');
  if(d.altars??d.rests)fixture('altar',1,'rest');
  if(d.railings){
    for(const face of exposedCliffFaces(map,1).filter(f=>active(f)&&'.P'.includes(map.rows[f.row][f.x]))){const[dx,dy]=DIRECTIONS[face.direction];map.fixtures.push({id:idFor(`railing-${face.x}-${face.row}-${face.direction}`),role:'railing',x:face.x,row:face.row,direction:face.direction,offset:{x:dx*map.cellSize/2,y:0,z:-dy*map.cellSize/2}});}
    for(const b of map.bridges.filter(active))for(const side of [(b.direction+90)%360,(b.direction+270)%360] as Direction[]){const[dx,dy]=DIRECTIONS[side];map.fixtures.push({id:idFor(`railing-${b.x}-${b.row}-${side}`),role:'railing',x:b.x,row:b.row,direction:side,offset:{x:dx*map.cellSize/2,y:0,z:-dy*map.cellSize/2}});}
  }
  for(const kind of ['enemy','reward','event'] as const){
    const enabled=kind==='enemy'?d.enemies:kind==='reward'?d.rewards:d.events;if(!enabled)continue;
    const count=d[`${kind}Count` as 'enemyCount'|'rewardCount'|'eventCount'];
    if(available.length<count)throw new Error(`${region?'선택한 잠금 해제 영역에 ':''}${kind} 마커 ${count}개를 배치할 바닥이 부족합니다.`);
    for(let i=0;i<count;i++){const c=next(kind==='enemy'?'combat':kind==='reward'?'reward':undefined);map.markers.push({id:idFor(`${kind}-${i+1}`),label:`${kind} ${i+1}`,kind,contentKey:'',...c,direction:0,offset:{x:0,y:0,z:0}});}
  }
  let result = reapplyLighting(map,settings,region,catalog);
  if(d.structureFill) result=configureStructures(result,structureSettingsFor(settings),region);
  // Balanced composition is a generation operation, including when legacy settings have no combat recipe.
  // Use the standard circulation recipe locally without changing the saved user settings.
  const balanced=d.propLayout==='balanced',grouped=d.propLayout==='grouped';
  const placementSettings=(balanced||grouped)&&!settings.levelDesign?{...settings,levelDesign:{...DEFAULT_LEVEL_DESIGN}}:settings;
  if(placementSettings.levelDesign) {
    if(grouped) {
      result=placeLevelDesignContent(result,placementSettings,region);
      result=placeGroupedProps(result,placementSettings,catalog??[],region).map;
    } else if(catalog?.some(binding=>binding.prop)) {
      const generatedMarkers=(result.markers??[]).filter(active);
      const movable=(f:MapFixture)=>active(f)&&(f.anchor??'floor')==='floor'&&!['light','railing'].includes(f.role);
      const generatedFixtures=(result.fixtures??[]).filter(movable);
      result.markers=(result.markers??[]).filter(m=>!active(m));
      result.fixtures=(result.fixtures??[]).filter(f=>!movable(f));
      // Legacy AI P cells express quantity; balanced generation instead uses measured floor coverage.
      result=placeProps(result,{...placementSettings,designer:{...d,decorations:false,vegetation:false}},catalog,region,[],{tactical:true,preserveCrossing:true}).map;
      result.markers!.push(...generatedMarkers);result.fixtures!.push(...generatedFixtures);
      result=placeLevelDesignContent(result,placementSettings,region);
      const report=analyzeLevelDesign(result,placementSettings);
      result=placeProps(result,placementSettings,catalog,region,[...report.reservedEntryCells,...report.combatCells,...report.routes.flat(),...report.obstacleChoices.flatMap(choice=>choice.routes.flat())],{varyGeneratedDecorations:true,preserveCrossing:true,...(balanced?{skipProps:true}:{})}).map;
    } else result=placeLevelDesignContent(result,placementSettings,region);
    const errors=analyzeLevelDesign(result,placementSettings).issues.filter(issue=>issue.severity==='error');
    if(errors.length)throw new Error(errors.slice(0,3).map(issue=>issue.message).join(' '));
  } else if(catalog?.some(binding=>binding.prop))result=placeProps(result,settings,catalog,region,[],{varyGeneratedDecorations:true,preserveCrossing:true}).map;
  if(region&&(balanced||grouped))result.lockedCells=originalLocks??[];
  if(d.wallMounts?.enabled)result=placeWallMounts(result,settings,catalog??[],region).map;
  return result;
}

function bridgeGroups(map:GridMap): Bridge[][] {
  const remaining=new Map((map.bridges??[]).map(b=>[`${b.x},${b.row}`,b])), groups:Bridge[][]=[];
  for(const b of map.bridges??[]){if(!remaining.has(`${b.x},${b.row}`))continue;const group:Bridge[]=[b];remaining.delete(`${b.x},${b.row}`);for(let i=0;i<group.length;i++){const item=group[i],[dx,dy]=DIRECTIONS[item.direction];for(const sign of [-1,1]){const key=`${item.x+dx*sign},${item.row+dy*sign}`,next=remaining.get(key);if(next){remaining.delete(key);group.push(next);}}}groups.push(group);}return groups;
}
/** Void beneath B participates in pit shape, never in walkability or floor placement. */
export function interiorPitRegions(map:GridMap): Cell[][] {
  const visited=new Set<string>(),regions:Cell[][]=[];
  for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++) {
    if(!'_B'.includes(map.rows[row][x])||visited.has(`${x},${row}`))continue;
    const queue:Cell[]=[{x,row}];visited.add(`${x},${row}`);let exterior=false,hasVoid=false;
    for(let i=0;i<queue.length;i++) {
      const c=queue[i];if(c.x===0||c.row===0||c.x===map.width-1||c.row===map.height-1)exterior=true;
      if(map.rows[c.row][c.x]==='_')hasVoid=true;
      for(const [dx,dy]of Object.values(DIRECTIONS)){const nx=c.x+dx,nr=c.row+dy,key=`${nx},${nr}`;if(nx<0||nr<0||nx>=map.width||nr>=map.height||visited.has(key)||!'_B'.includes(map.rows[nr][nx]))continue;visited.add(key);queue.push({x:nx,row:nr});}
    }
    if(!exterior&&hasVoid)regions.push(queue);
  }
  return regions;
}
export function generationConditionIssues(map:GridMap,settings:GenerationSettings,region?:GenerationRegion):ValidationIssue[]{
  const issues:ValidationIssue[]=[];const error=(message:string)=>issues.push({severity:'error',message});
  // Regional regeneration preserves existing doors, including their individually edited sizes.
  if (!region) {
    if (settings.connectionWidth !== undefined && map.connections.some(c => Math.abs(c.width - settings.connectionWidth!) > 1e-8))
      error(`연결문 폭이 요청한 ${settings.connectionWidth}m와 다릅니다.`);
    if (settings.connectionHeight !== undefined && map.connections.some(c => Math.abs(c.height - settings.connectionHeight!) > 1e-8))
      error(`연결문 높이가 요청한 ${settings.connectionHeight}m와 다릅니다.`);
  }
  const d=settings.designer;if(!d)return issues;
  // Validation counts newly generated measured objects; placement alone reserves all prior instances.
  const active=generationArea(map,region,false);
  // Protected/outside terrain is excluded; a crossing bridge or pit is counted as one whole group.
  const ramps=map.ramps.filter(active),walkable:number[]=[];
  let propCount=0,bridgeCells=0;
  for(let row=0;row<map.height;row++)for(let x=0;x<map.width;x++){
    if(!active({x,row}))continue;
    const tile=map.rows[row][x];
    if('.DRB'.includes(tile))walkable.push(map.elevations[row][x]);
    if(tile==='P')propCount++;
    if(tile==='B')bridgeCells++;
  }
  for(const ramp of ramps)walkable.push(map.elevations[ramp.row][ramp.x]+ramp.rise);
  if(!d.elevation&&(ramps.length||walkable.some(y=>Math.abs(y-walkable[0])>1e-8)))error('높이 지형 끄기 조건과 다른 단차가 생성되었습니다.');
  if(d.elevation&&(!ramps.length||!walkable.some(y=>Math.abs(y-walkable[0])>map.maxStepHeight)))error('높이 지형 켜기 조건에 필요한 높이 변화와 계단이 없습니다.');
  if(!d.props&&propCount)error('장애물 끄기 조건과 다른 P 타일이 생성되었습니다.');
  // A safe partial result is valid in balanced mode; coverage warnings explain unmet targets.
  if(d.props&&!['balanced','grouped'].includes(d.propLayout??'')&&!propCount)error('장애물 켜기 조건에 필요한 장애물이 없습니다.');
  const bridges=bridgeGroups(map).filter(group=>group.some(active));
  if(d.bridges&&bridges.length!==d.bridgeCount)error(`요청한 다리 ${d.bridgeCount}개와 생성된 다리 수가 다릅니다.`);
  if(!d.bridges&&bridgeCells)error('다리 끄기 조건과 다른 다리가 생성되었습니다.');
  if(d.bridges&&bridges.some(group=>group.some(b=>active(b)&&Math.abs(map.elevations[b.row][b.x]-d.bridgeHeight)>1e-8)))error('다리 상판 높이가 요청한 높이와 다릅니다.');
  const pits=interiorPitRegions(map).filter(pit=>pit.some(active));
  if(d.cliffs&&(pits.length!==d.cliffCount||pits.some(p=>p.filter(c=>map.rows[c.row][c.x]==='_').length<d.cliffSize)))error(`낭떠러지는 ${d.cliffSize}칸 이상의 내부 빈 공간 ${d.cliffCount}개여야 합니다.`);
  if(d.cliffs&&pits.some(pit=>{
    const cells=new Set(pit.map(c=>`${c.x},${c.row}`));
    return ![...(map.cliffs??[]),...(map.structureFills??[]).filter(f=>f.purpose==='pitSide')].some(face=>{const[dx,dr]=DIRECTIONS[face.direction];return cells.has(`${face.x+dx},${face.row+dr}`);});
  }))error('낭떠러지 조건에 필요한 노출된 지형 가장자리가 없습니다.');
  if(!d.cliffs&&pits.some(p=>!p.some(c=>map.rows[c.row][c.x]==='B')||(!d.bridges&&p.some(c=>active(c)&&map.rows[c.row][c.x]==='B'))))error('낭떠러지 끄기 조건과 다른 내부 구멍이 생성되었습니다.');
  for(const [flag,role] of [['lights','light'],['railings','railing'],['columns','column'],['arches','arch'],['water','water'],['hazards','hazard'],['traps','trap'],['gates','gate'],['gates','switch'],['secrets','secretDoor'],['rests','rest'],['merchants','merchant'],['altars','altar'],['decorations','decoration'],['vegetation','vegetation']] as const) {
    const count=(map.fixtures?.filter(f=>active(f)&&f.role===role).length??0)+(['decoration','vegetation'].includes(role)?(map.propInstances?.filter(p=>active(p)&&p.role===role).length??0):0);
    const enabled=flag==='merchants'||flag==='altars'?(d[flag]??d.rests):d[flag];
    if(enabled&&!count) {
      if(d.propLayout==='grouped'&&['decoration','vegetation'].includes(role))issues.push({severity:'warning',code:'grouped-props-unmet',message:`${role}: 용도·짝·크기·통행에 맞는 묶음을 배치하지 못했습니다. 에셋의 묶음 설정을 확인하세요.`});
      else error(`${role} 켜기 조건에 필요한 시설을 배치할 위치가 없습니다.`);
    }
    if(!enabled&&((map.fixtures?.filter(f=>!f.wall&&active(f)&&f.role===role).length??0)+(['decoration','vegetation'].includes(role)?(map.propInstances?.filter(p=>active(p)&&p.role===role).length??0):0)))error(`${role} 끄기 조건과 다른 시설이 생성되었습니다.`);
  }
  const ceilings=map.ceilings?.filter(active).length??0;
  if(d.ceilings&&!ceilings)error('천장 켜기 조건에 필요한 천장이 없습니다.');
  if(!d.ceilings&&ceilings)error('천장 끄기 조건과 다른 천장이 생성되었습니다.');
  for(const kind of ['enemy','reward','event'] as const){const enabled=kind==='enemy'?d.enemies:kind==='reward'?d.rewards:d.events,expected=enabled?d[`${kind}Count` as 'enemyCount'|'rewardCount'|'eventCount']:0;if((map.markers?.filter(m=>active(m)&&m.kind===kind).length??0)!==expected)error(`${kind} 마커 수가 요청한 ${expected}개와 다릅니다.`);}
  return issues;
}
