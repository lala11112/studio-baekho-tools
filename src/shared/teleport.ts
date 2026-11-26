import { connectionCells } from './connections';
import { DEFAULT_LEVEL_DESIGN, playerMovementGraph } from './level-design';
import { resolveFixtureBinding } from './light-bindings';
import { propPosition } from './props';
import { resolvedCliffFace, resolvedStructureFill } from './structures';
import type { AssetBinding, Cell, GameplayMarker, GenerationRegion, GenerationSettings, GridMap, LocalBounds, MapFixture, TeleportClearance, ValidationIssue, Vec3 } from './types';

export type { TeleportClearance } from './types';
interface Volume extends LocalBounds { danger?: boolean }
interface Point { x: number; z: number }
interface Context { volumes: Volume[]; reachable: Set<string>; roofs: Map<string, number>; shiftedFloors: Set<string> }
const EPS = 1e-7;
const key = (c: Cell) => `${c.x},${c.row}`;
const directions = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] } as const;
const validClearance = (value: TeleportClearance | undefined): value is TeleportClearance => !!value
  && Number.isFinite(value.radius) && value.radius >= .1 && value.radius <= 5
  && Number.isFinite(value.height) && value.height >= .25 && value.height <= 20;

/** Persist these dimensions on each landing marker, independently of later generation settings. */
export function teleportClearance(settings: GenerationSettings, map?: GridMap): TeleportClearance {
  return { radius: settings.levelDesign?.characterRadius ?? DEFAULT_LEVEL_DESIGN.characterRadius, height: settings.designer?.headroom ?? map?.headroom ?? 2 };
}

function position(map: GridMap, c: Cell & { offset?: Vec3 }): Vec3 {
  return { x: (c.x - (map.width - 1) / 2) * map.cellSize + (c.offset?.x ?? 0),
    y: (map.elevations[c.row]?.[c.x] ?? 0) + (c.offset?.y ?? 0),
    z: ((map.height - 1) / 2 - c.row) * map.cellSize + (c.offset?.z ?? 0) };
}

function pointRectDistance(a: Point, minX: number, maxX: number, minZ: number, maxZ: number): number {
  return Math.max(minX - a.x, 0, a.x - maxX) ** 2 + Math.max(minZ - a.z, 0, a.z - maxZ) ** 2;
}

/** Squared distance from a swept landing center to an axis-aligned rectangle. */
function segmentRectDistance(a: Point, b: Point, minX: number, maxX: number, minZ: number, maxZ: number): number {
  let low = 0, high = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, minX, maxX], [a.z, b.z - a.z, minZ, maxZ]]) {
    if (Math.abs(delta) < EPS) { if (start < min || start > max) { low = 2; break; } }
    else { const from = (min - start) / delta, to = (max - start) / delta; low = Math.max(low, Math.min(from, to)); high = Math.min(high, Math.max(from, to)); }
  }
  if (low <= high) return 0;
  let result = Math.min(pointRectDistance(a, minX, maxX, minZ, maxZ), pointRectDistance(b, minX, maxX, minZ, maxZ));
  const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
  for (const x of [minX, maxX]) for (const z of [minZ, maxZ]) {
    const t = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / length)) : 0;
    result = Math.min(result, (x - a.x - t * dx) ** 2 + (z - a.z - t * dz) ** 2);
  }
  return result;
}

function footprint(map: GridMap, a: Point, radius: number, b: Point = a): Cell[] {
  const toX = (x: number) => x / map.cellSize + (map.width - 1) / 2;
  const toRow = (z: number) => (map.height - 1) / 2 - z / map.cellSize;
  const minX = Math.floor(toX(Math.min(a.x, b.x) - radius) + .5), maxX = Math.floor(toX(Math.max(a.x, b.x) + radius) + .5);
  const minRow = Math.floor(toRow(Math.max(a.z, b.z) + radius) + .5), maxRow = Math.floor(toRow(Math.min(a.z, b.z) - radius) + .5);
  const cells: Cell[] = [];
  for (let row = minRow; row <= maxRow; row++) for (let x = minX; x <= maxX; x++) {
    const p = position(map, { x, row }), half = map.cellSize / 2;
    if (segmentRectDistance(a, b, p.x - half, p.x + half, p.z - half, p.z + half) < radius * radius - EPS) cells.push({ x, row });
  }
  return cells;
}

/** Cells occupied by the saved player's body, including horizontal marker offsets. */
export function teleportReservedCells(map: GridMap): Cell[] {
  const result = new Map<string, Cell>();
  for (const marker of map.markers ?? []) if (marker.kind === 'teleport' && validClearance(marker.clearance)) {
    for (const c of footprint(map, position(map, marker), marker.clearance.radius))
      if (c.x >= 0 && c.row >= 0 && c.x < map.width && c.row < map.height) result.set(key(c), c);
  }
  return [...result.values()];
}

function fixtureVolume(map: GridMap, fixture: MapFixture, bindings: AssetBinding[]): Volume[] {
  if (fixture.wall) return fixture.wall.bounds.map(bounds => ({ ...bounds, danger: ['water', 'hazard', 'trap'].includes(fixture.role) }));
  const binding = resolveFixtureBinding(map, bindings, fixture), base = position(map, fixture);
  const [dx, dr] = fixture.anchor === 'wall' ? directions[fixture.direction] : [0, 0];
  base.x += dx * map.cellSize / 2; base.z -= dr * map.cellSize / 2;
  if (fixture.anchor === 'ceiling') base.y = (map.ceilings?.find(c => c.x === fixture.x && c.row === fixture.row)?.undersideY ?? base.y) + fixture.offset.y;
  if (fixture.anchor === 'wall') base.y += (map.wallHeights?.find(c => c.x === fixture.x && c.row === fixture.row)?.height ?? 3) / 2;
  const danger = ['water', 'hazard', 'trap'].includes(fixture.role);
  if (binding) { base.x += binding.offset.x; base.y += binding.offset.y; base.z += binding.offset.z; }
  const native = binding?.bounds?.size ?? binding?.prop?.size;
  if (binding && native) {
    const angle = (fixture.direction + binding.rotationY) * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const center = binding.bounds?.center ?? { x: 0, y: native.y / 2, z: 0 };
    const cx = center.x * binding.scale.x, cy = center.y * binding.scale.y, cz = center.z * binding.scale.z;
    return [{ center: { x: base.x + cos * cx + sin * cz, y: base.y + cy, z: base.z - sin * cx + cos * cz },
      size: { x: Math.abs(native.x * binding.scale.x * cos) + Math.abs(native.z * binding.scale.z * sin), y: Math.abs(native.y * binding.scale.y), z: Math.abs(native.x * binding.scale.x * sin) + Math.abs(native.z * binding.scale.z * cos) }, danger }];
  }
  // Unmeasured fixtures retain a conservative blockout volume at their authored anchor.
  const size = fixture.anchor === 'ceiling' ? { x: map.cellSize, y: map.cellSize * .1, z: map.cellSize }
    : fixture.anchor === 'wall' ? { x: map.cellSize, y: map.cellSize, z: map.cellSize }
      : { x: map.cellSize, y: Math.max(map.cellSize, 2), z: map.cellSize };
  return [{ center: { ...base, y: base.y + (fixture.anchor === 'ceiling' ? -size.y / 2 : fixture.anchor === 'wall' ? 0 : size.y / 2) }, size, danger }];
}

function obstacleVolumes(map: GridMap, bindings: AssetBinding[]): Volume[] {
  const result: Volume[] = [];
  const explicit = new Set((map.propInstances ?? []).flatMap(p => p.cells).map(key));
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const tile = map.rows[row][x], role = tile === '#' ? 'wall' : tile === 'P' && !explicit.has(key({ x, row })) ? 'prop' : undefined;
    if (!role) continue;
    const candidates = bindings.filter(b => b.role === role), override = map.assetOverrides.find(o => o.x === x && o.row === row && o.role === role);
    const b = override ? candidates.find(b => b.id === override.bindingId) : candidates[(row * map.width + x) % candidates.length];
    const native = b?.bounds?.size ?? b?.prop?.size;
    if (!b || !native) continue;
    const angle = b.rotationY * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle), p = position(map, { x, row });
    const cx = (b.bounds?.center.x ?? 0) * b.scale.x, cz = (b.bounds?.center.z ?? 0) * b.scale.z;
    const height = role === 'wall' ? map.wallHeights?.find(w => w.x === x && w.row === row)?.height ?? native.y * b.scale.y : native.y * b.scale.y;
    result.push({ center: { x: p.x + b.offset.x + cos * cx + sin * cz, y: p.y + b.offset.y + height / 2, z: p.z + b.offset.z - sin * cx + cos * cz },
      size: { x: Math.abs(native.x * b.scale.x * cos) + Math.abs(native.z * b.scale.z * sin), y: height, z: Math.abs(native.x * b.scale.x * sin) + Math.abs(native.z * b.scale.z * cos) } });
  }
  for (const prop of map.propInstances ?? []) {
    const p = propPosition(map, prop, bindings.find(b => b.id === prop.bindingId));
    result.push({ center: { ...p, y: p.y + prop.size.y / 2 }, size: prop.size });
  }
  for (const fixture of map.fixtures ?? []) result.push(...fixtureVolume(map, fixture, bindings));
  for (const fill of map.structureFills ?? []) { const resolved = resolvedStructureFill(map, fill, bindings); if (resolved) result.push({ center: resolved.position, size: resolved.size }); }
  for (const cliff of map.cliffs ?? []) { const resolved = resolvedCliffFace(map, cliff, bindings); if (resolved) result.push({ center: resolved.position, size: resolved.size }); }
  return result;
}

function intersects(a: Vec3, b: Point, clearance: TeleportClearance, volume: Volume): boolean {
  const { center, size } = volume;
  if (!volume.danger && (a.y + clearance.height <= center.y - size.y / 2 + EPS || a.y >= center.y + size.y / 2 - EPS)) return false;
  return segmentRectDistance(a, b, center.x - size.x / 2, center.x + size.x / 2, center.z - size.z / 2, center.z + size.z / 2) < clearance.radius * clearance.radius - EPS;
}

function context(map: GridMap, clearance: TeleportClearance, volumes: Volume[], bindings: AssetBinding[]): Context {
  const resolve = (c: Cell, role: AssetBinding['role']) => {
    const candidates = bindings.filter(b => b.role === role), override = map.assetOverrides.find(o => o.x === c.x && o.row === c.row && o.role === role);
    return override ? candidates.find(b => b.id === override.bindingId) : candidates[(c.row * map.width + c.x) % candidates.length];
  };
  const roofs = new Map((map.ceilings ?? []).map(c => [key(c), c.undersideY + (resolve(c, 'ceiling')?.offset.y ?? 0)]));
  const floors = bindings.filter(b => b.role === 'floor'), shiftedFloors = new Set<string>();
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const override = map.assetOverrides.find(o => o.x === x && o.row === row && o.role === 'floor');
    const binding = override ? floors.find(b => b.id === override.bindingId) : floors[(row * map.width + x) % floors.length];
    if (binding && [binding.offset.x, binding.offset.y, binding.offset.z].some(v => Math.abs(v) > EPS)) shiftedFloors.add(key({ x, row }));
  }
  const graphMap = { ...map, ceilings: (map.ceilings ?? []).map(c => ({ ...c, undersideY: roofs.get(key(c))! })) };
  const graph = playerMovementGraph(graphMap, { characterRadius: clearance.radius, characterHeight: clearance.height });
  const blocked = new Set<string>();
  const graphPosition = (k: string) => { const [x, row] = k.split(',').map(Number), p = position(map, { x, row }); p.y += map.ramps.find(r => r.x === x && r.row === row)?.rise ?? 0; return p; };
  for (const k of graph.keys()) {
    const p = graphPosition(k);
    if (shiftedFloors.has(k) || volumes.some(v => intersects(p, p, clearance, v)) || footprint(map, p, clearance.radius).some(c => (roofs.get(key(c)) ?? Infinity) < p.y + clearance.height - EPS)) blocked.add(k);
  }
  const starts = map.connections.filter(c => c.width >= clearance.radius * 2 - EPS && c.height >= clearance.height - EPS)
    .flatMap(c => connectionCells(map, c)).map(key).filter(k => graph.has(k) && !blocked.has(k));
  const reachable = new Set(starts), queue = [...reachable];
  for (let i = 0; i < queue.length; i++) for (const n of graph.get(queue[i]) ?? []) if (!blocked.has(n) && !reachable.has(n)) {
    const a = graphPosition(queue[i]), b = graphPosition(n), bottom = Math.min(a.y, b.y), top = Math.max(a.y, b.y);
    const swept = { ...clearance, height: clearance.height + top - bottom };
    if (volumes.some(v => intersects({ ...a, y: bottom }, b, swept, v))
      || footprint(map, a, clearance.radius, b).some(c => (roofs.get(key(c)) ?? Infinity) < top + clearance.height - EPS)) continue;
    reachable.add(n); queue.push(n);
  }
  return { volumes, reachable, roofs, shiftedFloors };
}

function markerIssue(map: GridMap, marker: GameplayMarker, ctx: Context): ValidationIssue | undefined {
  const fail = (code: string, message: string): ValidationIssue => ({ severity: 'error', code: `teleport-${code}`, message: `순간이동 지점 ${marker.label}: ${message}`, cells: [{ x: marker.x, row: marker.row }] });
  const clearance = marker.clearance!;
  if (map.rows[marker.row]?.[marker.x] !== '.' || Math.abs(marker.offset.y) > EPS
    || Math.abs(marker.offset.x) > map.cellSize / 2 + EPS || Math.abs(marker.offset.z) > map.cellSize / 2 + EPS) return fail('support', '평평한 바닥의 셀 안에 발 위치를 맞춰 주세요.');
  const p = position(map, marker), center = position(map, { x: marker.x, row: marker.row }), base = map.elevations[marker.row][marker.x];
  // Verify the whole landing disk and the short movement into its graph cell, including authored offsets.
  const cells = footprint(map, p, clearance.radius, center);
  if (cells.some(c => map.rows[c.row]?.[c.x] !== '.' || Math.abs((map.elevations[c.row]?.[c.x] ?? Infinity) - base) > EPS)) return fail('support', '몸 반경 전체를 같은 높이의 평평한 바닥이 지지해야 합니다.');
  if (cells.some(c => ctx.shiftedFloors.has(key(c)))) return fail('floor-offset', '바닥 에셋 위치 보정이 있으면 저장된 발 위치와 지지면이 달라집니다. 바닥의 X/Y/Z 위치 보정을 0으로 맞춰 주세요.');
  if (cells.some(c => (ctx.roofs.get(key(c)) ?? Infinity) < p.y + clearance.height - EPS)) return fail('headroom', '몸 반경 전체에 캐릭터 높이만큼 머리 위 여유가 필요합니다.');
  if ((map.markers ?? []).some(m => m !== marker && m.x === marker.x && m.row === marker.row)) return fail('occupied', '다른 게임 지점과 같은 셀을 사용할 수 없습니다.');
  if ((map.markers ?? []).some(m => m !== marker && m.kind === 'teleport' && validClearance(m.clearance)
    && Math.hypot(position(map, m).x - p.x, position(map, m).z - p.z) < clearance.radius + m.clearance.radius - EPS)) return fail('overlap', '다른 순간이동 지점의 몸 반경과 착지 영역이 겹칩니다.');
  if (ctx.volumes.some(v => intersects(p, center, clearance, v))) return fail('obstacle', '몸 공간이 소품·시설·위험물 또는 등록된 경계와 겹칩니다.');
  if (!ctx.reachable.has(key(marker))) return fail('route', '캐릭터가 통과할 수 있는 연결문까지 위험물을 피하는 경로가 필요합니다.');
  return undefined;
}

/** Shared gate for generation, surrounding edits and export; no enemy-distance or combat recipe applies. */
export function teleportIssues(map: GridMap, bindings: AssetBinding[] = []): ValidationIssue[] {
  const markers = (map.markers ?? []).filter(m => m.kind === 'teleport');
  if (!markers.length) return [];
  const volumes = obstacleVolumes(map, bindings), contexts = new Map<string, Context>(), issues: ValidationIssue[] = [];
  for (const marker of markers) {
    if (!validClearance(marker.clearance)) { issues.push({ severity: 'error', code: 'teleport-clearance', message: `순간이동 지점 ${marker.label}의 저장된 캐릭터 반경·높이를 확인해 주세요.`, cells: [{ x: marker.x, row: marker.row }] }); continue; }
    const signature = `${marker.clearance.radius},${marker.clearance.height}`;
    if (!contexts.has(signature)) contexts.set(signature, context(map, marker.clearance, volumes, bindings));
    const issue = markerIssue(map, marker, contexts.get(signature)!); if (issue) issues.push(issue);
  }
  return issues;
}

/** Place an exact map-wide count after all geometry is final; preserve locked/outside landing markers. */
export function placeTeleportMarkers(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[] = [], region?: GenerationRegion): GridMap {
  const map = structuredClone(source), d = settings.designer;
  if (!d?.teleports) return map;
  const target = d.teleportCount ?? 1, clearance = teleportClearance(settings, map);
  if (!Number.isInteger(target) || target < 1 || target > 64 || !validClearance(clearance)) throw new Error('순간이동 지점 수(1~64)와 캐릭터 반경·높이를 확인해 주세요.');
  const locked = new Set((map.lockedCells ?? []).map(key));
  const active = (c: Cell) => !locked.has(key(c)) && (!region || c.x >= region.x && c.row >= region.row && c.x < region.x + region.width && c.row < region.row + region.height);
  map.markers = (map.markers ?? []).filter(m => m.kind !== 'teleport' || !active(m));
  const preserved = map.markers.filter(m => m.kind === 'teleport');
  if (preserved.length > target) throw new Error(`보존해야 하는 순간이동 지점 ${preserved.length}개가 요청한 전체 ${target}개보다 많습니다. 개수 또는 보호 영역을 조정해 주세요.`);
  const volumes = obstacleVolumes(map, bindings), ctx = context(map, clearance, volumes, bindings), candidates: GameplayMarker[] = [];
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) if (active({ x, row }) && map.rows[row][x] === '.') {
    const marker: GameplayMarker = { id: '', label: '후보', kind: 'teleport', contentKey: '', x, row, direction: 0, offset: { x: 0, y: 0, z: 0 }, clearance: { ...clearance } };
    if (!markerIssue(map, marker, ctx)) candidates.push(marker);
  }
  const needed = target - preserved.length;
  if (candidates.length < needed) throw new Error(`안전한 순간이동 지점을 전체 ${target}개 배치할 공간이 부족합니다. 캐릭터 여유·위험물·연결문 경로를 확인하거나 개수를 줄여 주세요.`);
  const used = new Set([...map.markers, ...(map.fixtures ?? []), ...map.connections, ...(map.propInstances ?? []), ...(map.structureFills ?? [])].map(v => v.id));
  const selected = [...preserved];
  const tie = (m: Cell) => { let hash = (Math.imul(m.x + 1, 73856093) ^ Math.imul(m.row + 1, 19349663) ^ Math.imul(settings.seed ?? 0, 83492791)) >>> 0; hash = Math.imul(hash ^ hash >>> 16, 2246822507) >>> 0; return (hash ^ hash >>> 13) >>> 0; };
  for (let i = 0; i < needed; i++) {
    if (!candidates.length) throw new Error(`안전한 순간이동 지점을 전체 ${target}개 배치할 공간이 부족합니다. 착지 영역이 겹치지 않도록 개수를 줄이거나 공간을 넓혀 주세요.`);
    const spacing = (m: GameplayMarker) => selected.length ? Math.min(...selected.map(other => { const a = position(map, m), b = position(map, other); return (a.x - b.x) ** 2 + (a.z - b.z) ** 2; })) : 0;
    candidates.sort((a, b) => spacing(b) - spacing(a) || tie(b) - tie(a) || a.row - b.row || a.x - b.x);
    const chosen = candidates.shift()!;
    let suffix = i + 1, id = `teleport-${suffix}`; while (used.has(id)) id = `teleport-${++suffix}`; used.add(id);
    chosen.id = id; chosen.label = `순간이동 ${selected.length + 1}`;
    map.markers.push(chosen); selected.push(chosen);
    for (let index = candidates.length - 1; index >= 0; index--) {
      const a = position(map, candidates[index]), b = position(map, chosen);
      if (Math.hypot(a.x - b.x, a.z - b.z) < clearance.radius + chosen.clearance!.radius - EPS) candidates.splice(index, 1);
    }
  }
  const issues = teleportIssues(map, bindings); if (issues.length) throw new Error(issues.slice(0, 3).map(issue => issue.message).join(' '));
  return map;
}
