import { connectionCells, connectionPose, FLOOR_THICKNESS_RATIO, validateMap } from './map';
import { fixturePosition } from './features';
import { synchronizeStructures } from './structures';
import { assertWholeProps, propPosition } from './props';
import { protectedPropIds } from './prop-groups';
import type { AssetBinding, Direction, GridMap, MapConnection, MapFixture, PropInstance, ValidationIssue, Vec3, WallMountInstance } from './types';
import { wallMountDependencies } from './wall-mounts';
import { wallBaseY } from './wall-geometry';

export interface RegionRect { x: number; row: number; width: number; height: number }
/** A detached map with region-local cell coordinates. */
export type RegionSnapshot = GridMap;
export interface RegionTransform { rotate90?: 0 | 1 | 2 | 3; mirrorX?: boolean; mirrorZ?: boolean }
export interface ModuleTransform { position: Vec3; rotationY: number }
export interface ModuleComparison { transform: ModuleTransform; issues: ValidationIssue[] }

const layers = ['ramps', 'connections', 'assetOverrides', 'ceilings', 'wallHeights', 'bridges', 'cliffs',
  'fixtures', 'markers', 'lockedCells', 'zones','pitBottoms','structureFills','propInstances'] as const;
type CellRecord = { x: number; row: number; direction?: number; offset?: Vec3; id?: string; linkedId?: string; cells?: {x:number;row:number}[]; position?:Vec3; size?:Vec3; wall?:WallMountInstance; groupId?: string; authored?: boolean; provenance?: 'generated' | 'manual' };
const clone = <T>(value: T): T => structuredClone(value);
const within = (point: { x: number; row: number }, rect: RegionRect): boolean => point.x >= rect.x && point.row >= rect.row
  && point.x < rect.x + rect.width && point.row < rect.row + rect.height;
const normalizedAngle = (angle: number): number => ((angle % 360) + 360) % 360;

function propGroups(map: GridMap): Map<string, PropInstance[]> {
  const groups = new Map<string, PropInstance[]>();
  for (const prop of map.propInstances ?? []) if (prop.groupId) {
    const members = groups.get(prop.groupId);
    if (members) members.push(prop); else groups.set(prop.groupId, [prop]);
  }
  return groups;
}

function assertWholePropGroups(map: GridMap, rect: RegionRect): void {
  for (const [id, members] of propGroups(map)) {
    const cells = members.flatMap(prop => prop.cells);
    if (cells.some(cell => within(cell, rect)) && !cells.every(cell => within(cell, rect)))
      throw new Error(`소품 묶음 ${id}의 전체를 선택해 주세요.`);
  }
}

function checkRect(map: GridMap, rect: RegionRect): void {
  if (![rect.x, rect.row, rect.width, rect.height].every(Number.isInteger) || rect.width < 1 || rect.height < 1
    || rect.x < 0 || rect.row < 0 || rect.x + rect.width > map.width || rect.row + rect.height > map.height) {
    throw new Error('선택 영역 전체가 맵 안에 있어야 합니다.');
  }
}

function checkWholeConnections(map: GridMap, rect: RegionRect): void {
  assertWholeProps(map,rect);
  assertWholePropGroups(map, rect);
  const groups=new Map<string,MapFixture[]>();
  for(const f of map.fixtures??[])if(f.wall){const k=f.wall.runId??f.id;groups.set(k,[...(groups.get(k)??[]),f]);}
  for(const fixtures of groups.values()){
    const cells=fixtures.flatMap(wallMountDependencies);
    if(cells.some(c=>within(c,rect))&&!cells.every(c=>within(c,rect)))throw new Error('벽 부착물과 연결 구간의 지지 벽 전체를 선택해 주세요.');
  }
  for (const connection of map.connections) {
    const footprint = connectionCells(map, connection);
    if (footprint.some(point => within(point, rect)) && !footprint.every(point => within(point, rect))) {
      throw new Error(`넓은 연결문 ${connection.id}의 일부만 선택할 수 없습니다. 연결문 전체를 포함해 주세요.`);
    }
  }
}

/** Captures every cell layer without retaining references to the source map. */
export function captureRegion(map: GridMap, rect: RegionRect): RegionSnapshot {
  checkRect(map, rect);
  checkWholeConnections(map, rect);
  const result = clone(map);
  result.width = rect.width; result.height = rect.height;
  result.rows = map.rows.slice(rect.row, rect.row + rect.height).map(row => row.slice(rect.x, rect.x + rect.width));
  result.elevations = map.elevations.slice(rect.row, rect.row + rect.height).map(row => row.slice(rect.x, rect.x + rect.width));
  for (const layer of layers) {
    const records = map[layer] as CellRecord[] | undefined;
    if (records) Object.assign(result, { [layer]: records.filter(point => within(point, rect))
      .map(point => ({ ...clone(point), x: point.x - rect.x, row: point.row - rect.row,
        ...(point.cells?{cells:point.cells.map(c=>({x:c.x-rect.x,row:c.row-rect.row}))}:{}),
        ...(point.position?{position:{x:point.position.x-(rect.x+(rect.width-1)/2-(map.width-1)/2)*map.cellSize,y:point.position.y,z:point.position.z-((map.height-1)/2-rect.row-(rect.height-1)/2)*map.cellSize}}:{}) })) });
  }
  const origin={x:(rect.x+(rect.width-1)/2-(map.width-1)/2)*map.cellSize,y:0,z:((map.height-1)/2-rect.row-(rect.height-1)/2)*map.cellSize};
  const local=(p:Vec3):Vec3=>({x:p.x-origin.x,y:p.y,z:p.z-origin.z});
  for(const fixture of result.fixtures??[])if(fixture.wall){
    const w=fixture.wall;w.position=local(w.position);w.bounds=w.bounds.map(b=>({...b,center:local(b.center)}));w.sockets=w.sockets.map(s=>({...s,position:local(s.position)}));
    w.support=w.support.map(c=>({...c,x:c.x-rect.x,row:c.row-rect.row}));
    if(w.doorReference)w.doorReference.position=local(w.doorReference.position);
  }
  return result;
}
export const copyRegion = captureRegion;

/** Applies a full generated candidate only inside the selected unlocked area, then checks its seams. */
export function mergeGeneratedRegion(original: GridMap, candidate: GridMap, rect: RegionRect, decorate?: (merged: GridMap) => GridMap, bindings?: AssetBinding[]): GridMap {
  checkRect(original, rect);
  assertWholeProps(candidate,rect);
  assertWholePropGroups(candidate, rect);
  if (candidate.width !== original.width || candidate.height !== original.height || candidate.cellSize !== original.cellSize) {
    throw new Error('부분 재생성 결과의 맵 크기와 셀 크기가 원본과 같아야 합니다.');
  }
  if (candidate.rows.length !== original.height || candidate.elevations.length !== original.height
    || candidate.rows.some(row => row.length !== original.width) || candidate.elevations.some(row => row.length !== original.width)) {
    throw new Error('부분 재생성 결과의 셀 배열이 올바르지 않습니다.');
  }
  const protectedCells = new Set([...(original.lockedCells ?? []), ...original.connections.flatMap(connection => connectionCells(original, connection))]
    .map(point => `${point.x}:${point.row}`));
  for(const fixture of original.fixtures??[])if(fixture.wall)for(const c of wallMountDependencies(fixture))protectedCells.add(`${c.x}:${c.row}`);
  // Preserve authored assignments and whole objects that straddle the selection or a lock.
  for (const override of original.assetOverrides) if (override.role === 'prop') protectedCells.add(`${override.x}:${override.row}`);
  for (const fixture of original.fixtures ?? []) if (fixture.bindingId && ['decoration','vegetation'].includes(fixture.role)) protectedCells.add(`${fixture.x}:${fixture.row}`);
  const propLocks = [...protectedCells].map(value => { const [x, row] = value.split(':').map(Number); return { x, row }; });
  const protectedProps = protectedPropIds({ ...original, lockedCells: propLocks }, rect);
  for (const prop of original.propInstances ?? []) if (protectedProps.has(prop.id)) for (const c of prop.cells) protectedCells.add(`${c.x}:${c.row}`);
  const replace = (point: { x: number; row: number }) => within(point, rect) && !protectedCells.has(`${point.x}:${point.row}`);
  for(const prop of candidate.propInstances??[])if(prop.cells.some(replace)&&!prop.cells.every(replace))throw new Error(`소품 ${prop.id}의 점유 영역이 잠금 또는 부분 재생성 경계를 가로지릅니다.`);
  for (const [id, members] of propGroups(candidate)) {
    const cells = members.flatMap(prop => prop.cells);
    if (cells.some(replace) && !cells.every(replace)) throw new Error(`소품 묶음 ${id}이 잠금 또는 부분 재생성 경계를 가로지릅니다.`);
  }
  const result = clone(original), rows = result.rows.map(row => [...row]);
  if (candidate.version === 5 || original.version === 5) result.version=5;
  else if (candidate.version === 4) result.version = 4;
  for (let row = rect.row; row < rect.row + rect.height; row++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    if (!replace({ x, row })) continue;
    rows[row][x] = candidate.rows[row][x]; result.elevations[row][x] = candidate.elevations[row][x];
  }
  result.rows = rows.map(row => row.join(''));
  const identityLayers=['fixtures','markers','propInstances','structureFills'] as const;
  const retainedIds = new Set([...original.connections.map(c=>c.id),...identityLayers.flatMap(layer=>(original[layer]??[]).filter(point=>!replace(point)).map(point=>point.id))]);
  const reservedIds = new Set([...retainedIds,...identityLayers.flatMap(layer=>(candidate[layer]??[]).filter(replace).map(point=>point.id))]);
  const remapped = { fixtures: new Map<string, string>(), markers: new Map<string, string>(),propInstances:new Map<string,string>(),structureFills:new Map<string,string>() };
  for (const layer of identityLayers) for (const point of candidate[layer] ?? []) {
    if (!replace(point) || !retainedIds.has(point.id)) continue;
    let suffix = 1, id = `${point.id.slice(0, 64)}_regen_${suffix}`;
    while (reservedIds.has(id)) id = `${point.id.slice(0, 64)}_regen_${++suffix}`;
    reservedIds.add(id); remapped[layer].set(point.id, id);
  }
  const retainedGroupIds = new Set((original.propInstances ?? []).filter(prop => !replace(prop)).map(prop => prop.groupId).filter((id): id is string => !!id));
  const reservedGroupIds = new Set([...retainedGroupIds, ...(candidate.propInstances ?? []).map(prop => prop.groupId).filter((id): id is string => !!id)]);
  const remappedGroups = new Map<string, string>();
  for (const prop of candidate.propInstances ?? []) if (replace(prop) && prop.groupId && retainedGroupIds.has(prop.groupId) && !remappedGroups.has(prop.groupId)) {
    let suffix = 1, id = `${prop.groupId.slice(0, 64)}_regen_${suffix}`;
    while (reservedGroupIds.has(id)) id = `${prop.groupId.slice(0, 64)}_regen_${++suffix}`;
    reservedGroupIds.add(id); remappedGroups.set(prop.groupId, id);
  }
  for (const layer of layers) {
    if (layer === 'connections' || layer === 'lockedCells' || layer === 'zones') continue;
    const source = candidate[layer] as CellRecord[] | undefined, target = original[layer] as CellRecord[] | undefined;
    if (!source && !target) continue;
    const inserted = clone(source ?? []).filter(replace).map(point => {
      if (point.id && (layer === 'fixtures' || layer === 'markers'||layer==='propInstances'||layer==='structureFills')) point.id = remapped[layer].get(point.id) ?? point.id;
      if (layer === 'fixtures' && point.linkedId) point.linkedId = remapped.fixtures.get(point.linkedId) ?? point.linkedId;
      if (layer === 'propInstances' && point.groupId) point.groupId = remappedGroups.get(point.groupId) ?? point.groupId;
      return point;
    });
    Object.assign(result, { [layer]: [...clone(target ?? []).filter(point => !replace(point)), ...inserted] });
  }
  // Feature regeneration must honor the same protection as the terrain merge.
  if (decorate) result.lockedCells = [...protectedCells].map(value => { const [x,row] = value.split(':').map(Number); return { x,row }; });
  const completed = synchronizeStructures(decorate ? decorate(result) : result,rect);
  if (original.lockedCells) completed.lockedCells = clone(original.lockedCells);
  else delete completed.lockedCells;
  const errors = validateMap(completed, bindings).filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(`부분 재생성 경계를 연결할 수 없습니다: ${errors.slice(0, 3).map(issue => issue.message).join(' / ')}`);
  return completed;
}

function transformPoint(x: number, row: number, width: number, height: number, transform: RegionTransform): { x: number; row: number } {
  if (transform.mirrorX) x = width - 1 - x;
  if (transform.mirrorZ) row = height - 1 - row;
  for (let turn = 0; turn < (transform.rotate90 ?? 0); turn++) {
    [x, row] = [height - 1 - row, x];
    [width, height] = [height, width];
  }
  return { x, row };
}

function transformOffset(offset: Vec3, transform: RegionTransform): Vec3 {
  let { x, z } = offset;
  if (transform.mirrorX) x = -x;
  if (transform.mirrorZ) z = -z;
  for (let turn = 0; turn < (transform.rotate90 ?? 0); turn++) [x, z] = [z, -x];
  return { x: x || 0, y: offset.y, z: z || 0 };
}

/** Mirrors first, then rotates clockwise on the grid. Invalid or locked destinations fail atomically. */
export function pasteRegion(map: GridMap, snapshot: RegionSnapshot, destination: { x: number; row: number },
  transform: RegionTransform = {}): GridMap {
  if (![0, 1, 2, 3].includes(transform.rotate90 ?? 0)) throw new Error('회전은 90도 단위여야 합니다.');
  if((transform.mirrorX||transform.mirrorZ)&&snapshot.fixtures?.some(f=>f.wall))throw new Error('벽 부착물이 포함된 영역은 대칭 붙여넣기를 지원하지 않습니다. 회전 또는 일반 붙여넣기를 사용하세요.');
  if (Math.abs(map.cellSize - snapshot.cellSize) > 0.000001) throw new Error('셀 크기가 같은 맵에 붙여넣어 주세요.');
  const turns = transform.rotate90 ?? 0;
  const rect = { ...destination, width: turns % 2 ? snapshot.height : snapshot.width, height: turns % 2 ? snapshot.width : snapshot.height };
  checkRect(map, rect);
  checkWholeConnections(map, rect);
  checkWholeConnections(snapshot, { x: 0, row: 0, width: snapshot.width, height: snapshot.height });
  if (map.lockedCells?.some(point => within(point, rect))) throw new Error('잠긴 셀이 포함되어 있습니다. 먼저 잠금을 해제해 주세요.');
  const result = clone(map);
  if (snapshot.version===5||map.version===5) result.version=5;
  else if (snapshot.version === 4) result.version = 4;
  const rows = result.rows.map(row => [...row]);
  for (let row = 0; row < snapshot.height; row++) for (let x = 0; x < snapshot.width; x++) {
    const point = transformPoint(x, row, snapshot.width, snapshot.height, transform);
    rows[point.row + rect.row][point.x + rect.x] = snapshot.rows[row][x];
    result.elevations[point.row + rect.row][point.x + rect.x] = snapshot.elevations[row][x];
  }
  result.rows = rows.map(row => row.join(''));
  const usedIds = new Set([...map.connections, ...(map.fixtures ?? []), ...(map.markers ?? []),...(map.propInstances??[]),...(map.structureFills??[])].map(entry => entry.id));
  const ids = { connections: new Map<string, string>(), fixtures: new Map<string, string>(), markers: new Map<string, string>(),propInstances:new Map<string,string>(),structureFills:new Map<string,string>() };
  const runIds=new Map<string,string>();
  for (const layer of ['connections', 'fixtures', 'markers','propInstances','structureFills'] as const) for (const source of snapshot[layer] ?? []) {
    let suffix = 1;
    let id = `${source.id.slice(0, 66)}_copy_${suffix}`;
    while (usedIds.has(id)) id = `${source.id.slice(0, 66)}_copy_${++suffix}`;
    usedIds.add(id); ids[layer].set(source.id, id);
  }
  for(const f of snapshot.fixtures??[])if(f.wall?.runId&&!runIds.has(f.wall.runId))runIds.set(f.wall.runId,`${ids.fixtures.get(f.id)!.slice(0,75)}_run`);
  const usedGroupIds = new Set((map.propInstances ?? []).map(prop => prop.groupId).filter((id): id is string => !!id));
  const groupIds = new Map<string, string>();
  for (const prop of snapshot.propInstances ?? []) if (prop.groupId && !groupIds.has(prop.groupId)) {
    let suffix = 1, id = `${prop.groupId.slice(0, 66)}_copy_${suffix}`;
    while (usedGroupIds.has(id)) id = `${prop.groupId.slice(0, 66)}_copy_${++suffix}`;
    usedGroupIds.add(id); groupIds.set(prop.groupId, id);
  }
  for (const layer of layers) {
    const source = snapshot[layer] as CellRecord[] | undefined;
    const target = map[layer] as CellRecord[] | undefined;
    if (!source && !target) continue;
    const inserted = (source ?? []).map(record => {
      const point = transformPoint(record.x, record.row, snapshot.width, snapshot.height, transform);
      const next = { ...clone(record), x: point.x + rect.x, row: point.row + rect.row };
      if (layer === 'connections') {
        const footprint = connectionCells(snapshot, record as MapConnection)
          .map(cell => transformPoint(cell.x, cell.row, snapshot.width, snapshot.height, transform));
        next.x = Math.min(...footprint.map(cell => cell.x)) + rect.x;
        next.row = Math.min(...footprint.map(cell => cell.row)) + rect.row;
      }
      if (record.direction !== undefined) {
        let angle = record.direction;
        if (transform.mirrorX) angle = -angle;
        if (transform.mirrorZ) angle = 180 - angle;
        next.direction = normalizedAngle(angle + turns * 90);
      }
      if (record.offset) next.offset = transformOffset(record.offset, transform);
      if(record.cells){
        next.cells=record.cells.map(c=>{const p=transformPoint(c.x,c.row,snapshot.width,snapshot.height,transform);return{x:p.x+rect.x,row:p.row+rect.row};});
        next.x=Math.min(...next.cells.map(c=>c.x));next.row=Math.min(...next.cells.map(c=>c.row));
        if(record.offset){const oldCenter={x:((Math.max(...record.cells.map(c=>c.x))+Math.min(...record.cells.map(c=>c.x)))/2-record.x)*map.cellSize,z:-( (Math.max(...record.cells.map(c=>c.row))+Math.min(...record.cells.map(c=>c.row)))/2-record.row)*map.cellSize};const correction=transformOffset({x:record.offset.x-oldCenter.x,y:record.offset.y,z:record.offset.z-oldCenter.z},transform);next.offset={x:(Math.max(...next.cells.map(c=>c.x))-next.x)*map.cellSize/2+correction.x,y:correction.y,z:-(Math.max(...next.cells.map(c=>c.row))-next.row)*map.cellSize/2+correction.z};}
      }
      if(record.size&&turns%2)next.size={x:record.size.z,y:record.size.y,z:record.size.x};
      if(record.position){const p=transformOffset(record.position,transform);next.position={x:p.x+(rect.x+(rect.width-1)/2-(map.width-1)/2)*map.cellSize,y:p.y,z:p.z+((map.height-1)/2-rect.row-(rect.height-1)/2)*map.cellSize};}
      if(record.wall){
        const origin={x:(rect.x+(rect.width-1)/2-(map.width-1)/2)*map.cellSize,z:((map.height-1)/2-rect.row-(rect.height-1)/2)*map.cellSize};
        const world=(p:Vec3)=>{const r=transformOffset(p,transform);return{x:r.x+origin.x,y:r.y,z:r.z+origin.z};};
        const w=clone(record.wall);w.position=world(w.position);w.rotationY=normalizedAngle(w.rotationY+turns*90);w.authored=true;
        w.bounds=w.bounds.map(b=>({center:world(b.center),size:turns%2?{x:b.size.z,y:b.size.y,z:b.size.x}:b.size}));
        w.sockets=w.sockets.map(s=>({position:world(s.position),direction:transformOffset(s.direction,transform)}));
        w.support=w.support.map(c=>{const p=transformPoint(c.x,c.row,snapshot.width,snapshot.height,transform);return{x:p.x+rect.x,row:p.row+rect.row,direction:normalizedAngle(c.direction+turns*90) as Direction};});
        if(w.runId)w.runId=runIds.get(w.runId)!;
        if(w.doorId)w.doorId=ids.connections.get(w.doorId)??w.doorId;
        if(w.doorReference)w.doorReference={...w.doorReference,position:world(w.doorReference.position),direction:normalizedAngle(w.doorReference.direction+turns*90) as Direction};
        next.wall=w;
      }
      if (record.id && (layer === 'connections' || layer === 'fixtures' || layer === 'markers'||layer==='propInstances'||layer==='structureFills')) next.id = ids[layer].get(record.id)!;
      if (record.linkedId && ids.fixtures.has(record.linkedId)) next.linkedId = ids.fixtures.get(record.linkedId);
      if (layer === 'propInstances') {
        if (record.groupId) next.groupId = groupIds.get(record.groupId)!;
        next.authored = true; next.provenance = 'manual';
      }
      return next;
    });
    Object.assign(result, { [layer]: [...clone(target ?? []).filter(point => !within(point, rect)), ...inserted] });
  }
  return synchronizeStructures(result);
}

const rotate = (point: Vec3, rotationY: number): Vec3 => {
  const radians = rotationY * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  return { x: point.x * cosine + point.z * sine, y: point.y, z: -point.x * sine + point.z * cosine };
};
interface Bounds { min: Vec3; max: Vec3 }
function bounds(map: GridMap, transform: ModuleTransform): Bounds[] {
  const result: Bounds[] = [], cell = map.cellSize;
  const addWorld = (position: Vec3, height: number, width = cell, depth = cell, rotationY = 0) => {
    const center = rotate(position, transform.rotationY);
    const angle = (transform.rotationY + rotationY) * Math.PI / 180;
    const halfX = (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * depth) / 2;
    const halfZ = (Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * depth) / 2;
    result.push({ min: { x: center.x + transform.position.x - halfX, y: center.y + transform.position.y, z: center.z + transform.position.z - halfZ },
      max: { x: center.x + transform.position.x + halfX, y: center.y + transform.position.y + height, z: center.z + transform.position.z + halfZ } });
  };
  const add = (x: number, row: number, bottom: number, top: number) => addWorld(
    { x: (x - (map.width - 1) / 2) * cell, y: bottom, z: ((map.height - 1) / 2 - row) * cell }, top - bottom);
  const measuredProps=new Set((map.propInstances??[]).flatMap(p=>p.cells.map(c=>`${c.x}:${c.row}`)));
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const tile = map.rows[row][x];
    if (tile === '_') continue;
    const y = map.elevations[row][x];
    let height = 0;
    if (tile === '#') height = map.wallHeights?.find(point => point.x === x && point.row === row)?.height ?? cell * 0.95;
    if (tile === 'P'&&!measuredProps.has(`${x}:${row}`)) height = cell * 0.6;
    if (tile === 'R') height = map.ramps.find(point => point.x === x && point.row === row)?.rise ?? 0;
    add(x, row, tile === '#' ? Math.min(y - cell * FLOOR_THICKNESS_RATIO, wallBaseY(map, { x, row })) : y - cell * FLOOR_THICKNESS_RATIO, y + height);
  }
  for (const ceiling of map.ceilings ?? []) add(ceiling.x, ceiling.row, ceiling.undersideY, ceiling.undersideY + cell * FLOOR_THICKNESS_RATIO);
  for (const cliff of map.cliffs ?? []) {
    if(map.structureFills?.some(fill=>fill.purpose==='pitSide'&&fill.x===cliff.x&&fill.row===cliff.row&&fill.direction===cliff.direction))continue;
    const edge = rotate({ x: 0, y: 0, z: cell * 0.465 }, cliff.direction);
    addWorld({ x: (cliff.x - (map.width - 1) / 2) * cell + edge.x, y: map.elevations[cliff.row][cliff.x] - cliff.depth,
      z: ((map.height - 1) / 2 - cliff.row) * cell + edge.z }, cliff.depth, cell * 0.96, cell * 0.07, cliff.direction);
  }
  for(const fill of map.structureFills??[])addWorld({...fill.position,y:fill.position.y-fill.size.y/2},fill.size.y,fill.size.x,fill.size.z);
  for(const bottom of map.pitBottoms??[])if(bottom.kind==='floor')add(bottom.x,bottom.row,bottom.y-bottom.thickness,bottom.y);
  for(const prop of map.propInstances??[])addWorld(propPosition(map,prop),prop.size.y,prop.size.x,prop.size.z);
  for (const fixture of map.fixtures ?? []) {
    if (fixture.role === 'light' && fixture.anchor === 'ceiling') {
      const origin = fixturePosition(map, fixture);
      addWorld({ ...origin, y: origin.y - cell * 0.074 }, cell * 0.074, cell * 0.76, cell * 0.25, fixture.direction);
      continue;
    }
    if (fixture.role === 'light' && fixture.anchor === 'wall') {
      const origin = fixturePosition(map, fixture), forward = rotate({ x: 0, y: 0, z: cell * 0.0335 }, fixture.direction);
      addWorld({ x: origin.x + forward.x, y: origin.y - cell * 0.185, z: origin.z + forward.z }, cell * 0.37,
        cell * 0.55, cell * 0.067, fixture.direction);
      continue;
    }
    const flat = ['water', 'hazard', 'trap'].includes(fixture.role);
    const tall = ['arch', 'gate', 'secretDoor', 'column'].includes(fixture.role);
    addWorld(fixturePosition(map, fixture), cell * (flat ? 0.05 : tall ? 1.3 : 0.55), cell * (fixture.role === 'column' ? 0.3 : 0.85),
      cell * (['arch', 'gate', 'secretDoor', 'railing'].includes(fixture.role) ? 0.18 : flat ? 0.85 : 0.45), fixture.direction);
  }
  return result;
}

/** Aligns B's entire module to A's outward port. Native elevation arrays remain untouched. */
export function compareModules(a: GridMap, portAId: string, b: GridMap, portBId: string): ModuleComparison {
  const portA = a.connections.find(port => port.id === portAId), portB = b.connections.find(port => port.id === portBId);
  if (!portA || !portB) throw new Error('비교할 두 연결문을 선택해 주세요.');
  const poseA = connectionPose(a, portA), poseB = connectionPose(b, portB);
  const rotationY = normalizedAngle(portA.direction + 180 - portB.direction);
  const rotated = rotate(poseB.position, rotationY);
  const transform = { rotationY, position: { x: poseA.position.x - rotated.x, y: poseA.position.y - rotated.y, z: poseA.position.z - rotated.z } };
  const issues: ValidationIssue[] = [];
  if (portA.kind !== portB.kind) issues.push({ severity: 'error', message: `연결문 종류가 다릅니다: ${portA.kind} / ${portB.kind}` });
  const tolerance = 0.01;
  if (Math.abs(portA.width - portB.width) > tolerance + Number.EPSILON) issues.push({ severity: 'warning', message: '연결문 폭 차이가 1cm를 초과합니다.' });
  if (Math.abs(portA.height - portB.height) > tolerance + Number.EPSILON) issues.push({ severity: 'warning', message: '연결문 높이 차이가 1cm를 초과합니다.' });
  const aBounds = bounds(a, { position: { x: 0, y: 0, z: 0 }, rotationY: 0 }), bBounds = bounds(b, transform);
  const overlap = aBounds.some(first => bBounds.some(second => ['x', 'y', 'z'].every(axis => {
    const key = axis as keyof Vec3;
    return Math.min(first.max[key], second.max[key]) - Math.max(first.min[key], second.min[key]) > 0.001;
  })));
  if (overlap) issues.push({ severity: 'warning', message: '두 맵의 대략적인 3D 구조가 겹칩니다. 실제 프리팹 충돌은 Unity에서 확인하세요.' });
  return { transform, issues };
}
