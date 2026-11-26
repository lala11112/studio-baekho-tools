import { connectionCells } from './connections';
import { placeholderWallBinding, WALL_PLACEHOLDER_KINDS } from './wall-placeholders';
import { terrainSurfaceY, wallBaseY, wallTopY } from './wall-geometry';
import type { AssetBinding, Cell, Direction, FixtureRole, GenerationRegion, GenerationSettings, GridMap, LocalBounds, MapConnection, MapFixture, ValidationIssue, Vec3, WallConnector, WallFace, WallMountDefinition, WallMountInstance, WallMountSettings, WallMountSite, WallPlaceholderKind } from './types';

export const DEFAULT_WALL_SETTINGS: WallMountSettings = { enabled: false, singles: true, runs: true, density: 20, runDensity: 40, placeholderFallback: true, runOrientation: 'horizontal' };
/** New projects opt in; loading an older project never changes its layout policy. */
export const NEW_WALL_SETTINGS: WallMountSettings = { ...DEFAULT_WALL_SETTINGS, runLayout: 'composed', runOrientation: 'both', connectRuns: true, runHeight: { mode: 'auto', reference: 'floor', min: 1, max: 3 } };
const EPS = 1e-5, LIMIT = 3200;
const DIRS: Direction[] = [0, 90, 180, 270];
const STEPS: Record<Direction, [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
const SITES: WallMountSite[] = ['wall', 'doorTop', 'doorSide', 'upper', 'lower', 'corner'];
const ROLES: FixtureRole[] = ['light', 'railing', 'column', 'arch', 'water', 'hazard', 'trap', 'gate', 'switch', 'secretDoor', 'rest', 'merchant', 'altar', 'decoration', 'vegetation'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const vec = (v: unknown): v is Vec3 => record(v) && only(v, ['x', 'y', 'z']) && [v.x, v.y, v.z].every(n => finite(n) && Math.abs(n) <= 1000);
const ck = (c: Cell) => `${c.x},${c.row}`;
const fk = (c: WallFace) => `${ck(c)},${c.direction}`;
const pk = (v: Vec3) => `${Math.round(v.x * 10000)},${Math.round(v.y * 10000)},${Math.round(v.z * 10000)}`;
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (v: Vec3, n: number): Vec3 => ({ x: v.x * n, y: v.y * n, z: v.z * n });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const norm = (v: Vec3) => { const result = mul(v, 1 / (length(v) || 1)); return { x: result.x === 0 ? 0 : result.x, y: result.y === 0 ? 0 : result.y, z: result.z === 0 ? 0 : result.z }; };
const near = (a: Vec3, b: Vec3) => length(sub(a, b)) < EPS;
const normal = (d: Direction): Vec3 => { const [x, row] = STEPS[d]; return { x, y: 0, z: -row }; };
const tangent = (n: Vec3): Vec3 => ({ x: n.z, y: 0, z: -n.x });
const inside = (c: Cell, r?: GenerationRegion) => !r || c.x >= r.x && c.row >= r.row && c.x < r.x + r.width && c.row < r.row + r.height;
const point = (map: GridMap, c: Cell, y = map.elevations[c.row]?.[c.x] ?? 0): Vec3 => ({ x: (c.x - (map.width - 1) / 2) * map.cellSize, y, z: ((map.height - 1) / 2 - c.row) * map.cellSize });
const rotate = (v: Vec3, degrees: number): Vec3 => { const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c }; };
const roll = (v: Vec3, degrees: number): Vec3 => { const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z }; };
const scaled = (v: Vec3, b: AssetBinding): Vec3 => ({ x: v.x * b.scale.x, y: v.y * b.scale.y, z: v.z * b.scale.z });
const transformed = (v: Vec3, b: AssetBinding, yaw: number, rotationZ = 0): Vec3 => rotate(rotationZ ? roll(scaled(v, b), rotationZ) : scaled(v, b), yaw);
const angle = (v: Vec3) => Math.atan2(v.x, v.z) * 180 / Math.PI;
const hash = (s: string) => { let n = 2166136261; for (const c of s) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0; };
const warning = (message: string, code = 'wall-placement'): ValidationIssue => ({ severity: 'warning', code, message });

export function parseLocalBounds(value: unknown): LocalBounds {
  if (!record(value) || !only(value, ['center', 'size']) || !vec(value.center) || !vec(value.size) || ![value.size.x, value.size.y, value.size.z].every(n => n > 0)) throw new Error('벽 부착물 경계의 중심과 양수 XYZ 크기를 확인해 주세요.');
  return structuredClone(value) as unknown as LocalBounds;
}
function connector(value: unknown, allowVertical = false): value is WallConnector {
  return record(value) && only(value, ['position', 'direction']) && vec(value.position) && vec(value.direction) && (allowVertical || Math.abs(value.direction.y) < EPS) && Math.abs(length(value.direction) - 1) < 1e-3;
}
const cardinal3 = (v: Vec3) => [normal(0), normal(90), normal(180), normal(270), { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }].some(d => near(d, v));
const isJunction = (kind: WallMountDefinition['kind']) => kind === 'elbow' || kind === 'tee';
function junctionGeometry(def: WallMountDefinition): boolean {
  const [mount] = def.mounts, sockets = def.sockets;
  if (def.mounts.length !== 1 || !mount || !DIRS.some(d => near(mount.direction, normal(d))) || sockets.some(s => !cardinal3(s.direction) || Math.abs(dot(s.direction, mount.direction)) > EPS) || !sockets.some(s => Math.abs(s.direction.y) > 1 - EPS) || !sockets.some(s => Math.abs(s.direction.y) < EPS)) return false;
  if (new Set(sockets.map(s => pk(s.direction))).size !== sockets.length) return false;
  const a = sockets[0], b = sockets.find(s => Math.abs(dot(a.direction, s.direction)) < EPS); if (!b) return false;
  const hub = add(a.position, mul(a.direction, dot(sub(b.position, a.position), a.direction)));
  return sockets.every(s => { const offset = sub(s.position, hub), distance = dot(offset, s.direction); return distance > EPS && length(sub(offset, mul(s.direction, distance))) < EPS; });
}
export function parseWallMountDefinition(value: unknown): WallMountDefinition {
  const junction = record(value) && ['elbow', 'tee'].includes(value.kind as string);
  if (!record(value) || !only(value, ['kind', 'family', 'sites', 'heightMode', 'height', 'spacing', 'probability', 'doorSide', 'mounts', 'sockets', 'collisionBoxes'])
    || !['single', 'straight', 'innerCorner', 'outerCorner', 'endCap', 'elbow', 'tee'].includes(value.kind as string)
    || typeof value.family !== 'string' || value.family.length > 80 || /[\u0000-\u001f\u007f]/.test(value.family)
    || (value.kind !== 'single' && !value.family.trim()) || !Array.isArray(value.sites) || !value.sites.length || !value.sites.every(s => SITES.includes(s)) || new Set(value.sites).size !== value.sites.length
    || !['center', 'floor', 'top'].includes(value.heightMode as string) || !finite(value.height) || Math.abs(value.height) > 300
    || !finite(value.spacing) || value.spacing < .05 || value.spacing > 100 || !finite(value.probability) || value.probability < 0 || value.probability > 100
    || !['left', 'right', 'both'].includes(value.doorSide as string) || !Array.isArray(value.mounts) || value.mounts.length > 8 || !value.mounts.every(v => connector(v))
    || !Array.isArray(value.sockets) || value.sockets.length !== (value.kind === 'single' ? 0 : value.kind === 'endCap' ? 1 : value.kind === 'tee' ? 3 : 2) || !value.sockets.every(v => connector(v, junction))
    || !Array.isArray(value.collisionBoxes) || value.collisionBoxes.length > 32) throw new Error('벽 부착물의 설치 위치·높이·간격·연결점 설정을 확인해 주세요.');
  const mounts = value.mounts as WallConnector[], sockets = value.sockets as WallConnector[];
  if (value.kind !== 'endCap' && !mounts.length || ['innerCorner', 'outerCorner'].includes(value.kind as string) && mounts.length < 2) throw new Error('직선과 개별 부착물은 부착점이, 코너는 양쪽 벽의 부착점이 필요합니다.');
  if (value.kind === 'single' && (value.sites as WallMountSite[]).includes('corner') && (value.sites.length !== 1 || mounts.length < 2 || !mounts.some(a => mounts.some(b => Math.abs(dot(a.direction, b.direction)) < EPS)))) throw new Error('모서리 개별 부착물은 모서리 전용으로 지정하고 직각인 양쪽 벽의 부착점 두 개를 등록해 주세요.');
  if (value.kind !== 'single' && !junction && [...mounts, ...sockets].some(c => !DIRS.some(d => near(c.direction, normal(d))))) throw new Error('연속 부품의 부착점·연결점 방향은 수평 90도 방향이어야 합니다.');
  if (junction && (!junctionGeometry(value as unknown as WallMountDefinition) || !value.sites.every(s => s === 'wall') || value.collisionBoxes.length < (value.kind === 'tee' ? 3 : 2))) throw new Error('엘보·T 배관은 벽면 부착점 하나, 같은 평면의 공통 중심에서 바깥으로 향하는 수평·수직 연결점과 각 팔의 충돌 상자가 필요합니다.');
  if (sockets.length === 2 && (near(sockets[0].position, sockets[1].position) || (value.kind === 'straight' ? dot(sockets[0].direction, sockets[1].direction) > -1 + EPS : Math.abs(dot(sockets[0].direction, sockets[1].direction)) > EPS))) throw new Error('직선은 반대 방향, 코너는 직각 방향으로 떨어진 연결점 두 개가 필요합니다.');
  value.collisionBoxes.forEach(parseLocalBounds);
  return structuredClone(value) as unknown as WallMountDefinition;
}
export function parseWallMountInstance(value: unknown, width: number, height: number): WallMountInstance {
  const cell = (v: unknown) => record(v) && Number.isInteger(v.x) && Number.isInteger(v.row) && Number(v.x) >= 0 && Number(v.x) < width && Number(v.row) >= 0 && Number(v.row) < height;
  if (!record(value) || !only(value, ['position', 'rotationY', 'rotationZ', 'support', 'bounds', 'sockets', 'site', 'doorId', 'runId', 'authored', 'doorReference', 'doorSide', 'bindingReference', 'placeholder']) || !vec(value.position) || !finite(value.rotationY) || Math.abs(value.rotationY) > 36000
    || !SITES.includes(value.site as WallMountSite) || !Array.isArray(value.support) || !value.support.length || value.support.length > width * height * 4
    || !value.support.every(s => cell(s) && only(s as Record<string, unknown>, ['x', 'row', 'direction']) && DIRS.includes((s as WallFace).direction)) || new Set(value.support.map(s => fk(s as WallFace))).size !== value.support.length
    || !Array.isArray(value.bounds) || !value.bounds.length || value.bounds.length > 32 || !Array.isArray(value.sockets) || value.sockets.length > 3 || !value.sockets.every(v => connector(v, true))
    || value.doorId !== undefined && !id(value.doorId) || value.runId !== undefined && !id(value.runId) || value.authored !== undefined && typeof value.authored !== 'boolean'
    || value.doorSide !== undefined && !['left', 'right'].includes(value.doorSide as string)
    || value.placeholder !== undefined && (!WALL_PLACEHOLDER_KINDS.includes(value.placeholder as typeof WALL_PLACEHOLDER_KINDS[number]) || value.bindingReference !== undefined)) throw new Error('벽 부착물의 저장된 자세·지지 벽·연결점이 올바르지 않습니다.');
  const rotationZ = value.rotationZ === undefined ? 0 : value.rotationZ;
  const sockets = value.sockets as WallConnector[], junctionSockets = sockets.some(s => Math.abs(s.direction.y) > 1 - EPS) && sockets.some(s => Math.abs(s.direction.y) < EPS);
  if (!finite(rotationZ) || !DIRS.includes(((rotationZ % 360 + 360) % 360) as Direction) || Math.abs(rotationZ) > 36000
    || (rotationZ % 360 !== 0 || junctionSockets) && (value.rotationY % 90 !== 0 || value.site !== 'wall' || !sockets.length || sockets.some(s => !cardinal3(s.direction)) || new Set(value.support.map(s => (s as WallFace).direction)).size !== 1)
    || junctionSockets && value.placeholder !== undefined && !['pipeElbow', 'pipeTee'].includes(value.placeholder as string)
    || !junctionSockets && (rotationZ % 360 === 0 ? sockets.some(s => Math.abs(s.direction.y) > EPS) : ![90, 270].includes((rotationZ % 360 + 360) % 360) || sockets.some(s => Math.abs(s.direction.y) < 1 - EPS) || value.placeholder !== undefined && !['pipeStraight', 'pipeEndCap'].includes(value.placeholder as string))) throw new Error('벽 배관의 회전과 수평·수직 연결점 구성이 맞지 않습니다.');
  value.bounds.forEach(parseLocalBounds);
  if (value.bindingReference !== undefined) {
    const b = value.bindingReference;
    if (!record(b) || !only(b, ['scale', 'rotationY', 'offset', 'prefabGuid', 'prefabPath']) || !vec(b.scale) || ![b.scale.x, b.scale.y, b.scale.z].every(n => n > 0) || !finite(b.rotationY) || Math.abs(b.rotationY) > 36000
      || b.offset !== undefined && !vec(b.offset) || b.prefabGuid !== undefined && (typeof b.prefabGuid !== 'string' || !/^[a-fA-F0-9]{32}$/.test(b.prefabGuid)) || b.prefabPath !== undefined && (typeof b.prefabPath !== 'string' || b.prefabPath.length > 2000)) throw new Error('벽 부착물의 원본 프리팹·배율·회전 기준이 올바르지 않습니다.');
  }
  if (value.doorReference !== undefined) {
    const d = value.doorReference;
    if (!record(d) || !only(d, ['position', 'direction', 'width', 'height']) || !vec(d.position) || !DIRS.includes(d.direction as Direction) || !finite(d.width) || d.width <= 0 || d.width > 40 || !finite(d.height) || d.height <= 0 || d.height > 20 || !value.doorId) throw new Error('문 부착물의 기준 문 자세가 올바르지 않습니다.');
  }
  return structuredClone(value) as unknown as WallMountInstance;
}

export function defaultWallMount(binding: AssetBinding): WallMountDefinition {
  const b = binding.bounds ?? { center: { x: 0, y: 0, z: .1 }, size: binding.prop?.size ?? { x: .6, y: .6, z: .2 } };
  return { kind: 'single', family: '', sites: ['wall'], heightMode: 'center', height: 0, spacing: 3, probability: 100, doorSide: 'both', mounts: [{ position: { x: b.center.x, y: b.center.y, z: b.center.z - b.size.z / 2 }, direction: { x: 0, y: 0, z: 1 } }], sockets: [], collisionBoxes: [] };
}

interface Face { support: WallFace; cell: Cell; center: Vec3; n: Vec3; t: Vec3; start: Vec3; end: Vec3; low: number; high: number }
interface Side { faces: Face[]; start: Vec3; end: Vec3; n: Vec3; t: Vec3; low: number; high: number; length: number }
interface Boundary { sides: Side[]; closed: boolean }
function wallHeight(map: GridMap, c: Cell) { return map.wallHeights?.find(w => w.x === c.x && w.row === c.row)?.height ?? map.structureSettings?.defaultWallHeight ?? 4; }
function facesFor(map: GridMap, bindings: readonly AssetBinding[] = []): Face[] {
  const result: Face[] = [];
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    if (map.rows[row][x] !== '#') continue;
    for (const d of DIRS) {
      const [dx, dr] = STEPS[d], cell = { x: x + dx, row: row + dr };
      if (!'.PRB'.includes(map.rows[cell.row]?.[cell.x] ?? '_')) continue;
      const n = normal(d), t = tangent(n), low = Math.max(wallBaseY(map, { x, row }, bindings), terrainSurfaceY(map, cell, bindings) ?? map.elevations[cell.row][cell.x]);
      const center = add(point(map, { x, row }, low), mul(n, map.cellSize / 2));
      result.push({ support: { x, row, direction: d }, cell, center, n, t, start: sub(center, mul(t, map.cellSize / 2)), end: add(center, mul(t, map.cellSize / 2)), low, high: wallTopY(map, { x, row }, bindings) });
    }
  }
  return result;
}
function boundaries(faces: Face[]): Boundary[] {
  const used = new Set<Face>(), starts = new Map<string, Face[]>(), ends = new Map<string, Face[]>();
  const endpoint = (f: Face, v: Vec3) => `${pk(v)}:${f.high.toFixed(4)}`;
  for (const f of faces) { const a = endpoint(f, f.start), b = endpoint(f, f.end); starts.set(a, [...(starts.get(a) ?? []), f]); ends.set(b, [...(ends.get(b) ?? []), f]); }
  const result: Boundary[] = [];
  // Open paths first, so locks/selection boundaries cannot accidentally wrap into protected faces.
  const order = [...faces.filter(f => !ends.has(endpoint(f, f.start))), ...faces];
  for (const first of order) {
    if (used.has(first)) continue;
    const path: Face[] = []; let f: Face | undefined = first;
    while (f && !used.has(f)) { used.add(f); path.push(f); const next: Face[] = starts.get(endpoint(f, f.end)) ?? []; f = next.length === 1 ? next[0] : undefined; }
    const closed = f === first;
    const groups: Face[][] = [];
    for (const p of path) { const previous = groups.at(-1); if (previous && near(previous[0].n, p.n)) previous.push(p); else groups.push([p]); }
    if (closed && groups.length > 1 && near(groups[0][0].n, groups.at(-1)![0].n)) groups[0] = [...groups.pop()!, ...groups[0]];
    result.push({ closed, sides: groups.map(g => ({ faces: g, start: g[0].start, end: g.at(-1)!.end, n: g[0].n, t: g[0].t, low: g[0].low, high: g[0].high, length: g.length * length(sub(g[0].end, g[0].start)) })) });
  }
  return result;
}
const heightAt = (def: WallMountDefinition, low: number, high: number) => def.heightMode === 'floor' ? low + def.height : def.heightMode === 'top' ? high - def.height : (low + high) / 2 + def.height;
function runHeightFamily(family: AssetBinding[], config: WallMountSettings, seed: number, key: string): AssetBinding[] {
  const policy = config.runHeight;
  if (!policy) return family;
  // Auto also has a useful, deterministic interpretation if the user selects the legacy layout.
  if (policy.mode === 'auto') return family.map(binding => ({ ...binding, wallMount: { ...binding.wallMount!, heightMode: 'center', height: 0 } }));
  const fraction = hash(`${seed}-run-height-${key}`) / 4294967296;
  const height = policy.mode === 'random' ? policy.min + fraction * (policy.max - policy.min) : policy.min;
  return family.map(binding => ({ ...binding, wallMount: { ...binding.wallMount!, heightMode: policy.reference, height } }));
}
function verticalLimits(side: Pick<Side, 'low' | 'high'>, range: WallMountSettings['verticalRange']): [number, number] {
  if (!range) return [side.low, side.high];
  return range.reference === 'floor' ? [side.low + range.start, side.low + range.end] : [side.high - range.end, side.high - range.start];
}
function withinVerticalRange(fixtures: MapFixture[], side: Pick<Side, 'low' | 'high'>, range: WallMountSettings['verticalRange']): boolean {
  if (!range) return true;
  const [low, high] = verticalLimits(side, range);
  return fixtures.every(fixture => fixture.wall!.bounds.every(box => box.center.y - box.size.y / 2 >= low - EPS && box.center.y + box.size.y / 2 <= high + EPS));
}
function worldBounds(b: AssetBinding, p: Vec3, yaw: number, rotationZ = 0): LocalBounds[] {
  const source = b.wallMount!.collisionBoxes.length ? b.wallMount!.collisionBoxes : [b.bounds ?? { center: { x: 0, y: 0, z: .1 }, size: b.prop?.size ?? { x: .6, y: .6, z: .2 } }];
  const a = yaw * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const rz = rotationZ * Math.PI / 180, rc = Math.abs(Math.cos(rz)), rs = Math.abs(Math.sin(rz));
  return source.map(box => { const native = { x: Math.abs(box.size.x * b.scale.x), y: Math.abs(box.size.y * b.scale.y), z: Math.abs(box.size.z * b.scale.z) }, size = rotationZ ? { x: native.x * rc + native.y * rs, y: native.x * rs + native.y * rc, z: native.z } : native; return { center: add(p, transformed(box.center, b, yaw, rotationZ)), size: { x: size.x * c + size.z * s, y: size.y, z: size.x * s + size.z * c } }; });
}
function worldSockets(b: AssetBinding, p: Vec3, yaw: number, rotationZ = 0): WallConnector[] { return b.wallMount!.sockets.map(s => ({ position: add(p, transformed(s.position, b, yaw, rotationZ)), direction: norm(transformed(s.direction, b, yaw, rotationZ)) })); }
function touchedFaces(side: Side, boxes: LocalBounds[]): Face[] {
  const ranges = boxes.map(box => { const p = dot(sub(box.center, side.start), side.t), extent = (Math.abs(side.t.x) * box.size.x + Math.abs(side.t.z) * box.size.z) / 2; return [p - extent, p + extent]; });
  return side.faces.filter(f => { const p = dot(sub(f.center, side.start), side.t), h = length(sub(f.end, f.start)) / 2; return ranges.some(([a, b]) => a < p + h - EPS && b > p - h + EPS); });
}
function makeFixture(map: GridMap, b: AssetBinding, p: Vec3, yaw: number, sides: Side[], site: WallMountSite, fixtureId: string, rotationZ = 0): MapFixture {
  const bounds = worldBounds(b, p, yaw, rotationZ), support = [...new Map(sides.flatMap(s => touchedFaces(s, bounds)).map(f => [fk(f.support), f.support])).values()];
  const first = sides.flatMap(s => touchedFaces(s, bounds))[0] ?? sides[0]?.faces[0];
  return { id: fixtureId, role: ROLES.includes(b.role as FixtureRole) ? b.role as FixtureRole : 'decoration', x: first?.cell.x ?? 0, row: first?.cell.row ?? 0, direction: ((Math.round(yaw / 90) * 90 % 360 + 360) % 360) as Direction, offset: { x: 0, y: 0, z: 0 }, bindingId: b.id, anchor: 'wall', wall: { position: p, rotationY: yaw, ...(rotationZ ? { rotationZ } : {}), support, bounds, sockets: worldSockets(b, p, yaw, rotationZ), site, bindingReference: bindingReference(b) } };
}
function bindingReference(b: AssetBinding): NonNullable<WallMountInstance['bindingReference']> { return { scale: { ...b.scale }, rotationY: b.rotationY, offset: { ...b.offset }, prefabGuid: b.prefabGuid, prefabPath: b.prefabPath }; }
function fixtureBinding(f: MapFixture, bindings: readonly AssetBinding[]): AssetBinding | undefined { return f.wall?.placeholder ? WALL_PLACEHOLDER_KINDS.includes(f.wall.placeholder) ? placeholderWallBinding(f.wall.placeholder) : undefined : bindings.find(b => b.id === f.bindingId); }
function savePlaceholder(f: MapFixture, placeholders: ReadonlyMap<string, WallPlaceholderKind>): void {
  const kind = f.bindingId ? placeholders.get(f.bindingId) : undefined; if (!kind || !f.wall) return;
  f.wall.placeholder = kind; delete f.bindingId; delete f.wall.bindingReference;
}
function planningPlaceholder(kind: WallPlaceholderKind, used: Set<string>, placeholders: Map<string, WallPlaceholderKind>): AssetBinding {
  const binding = placeholderWallBinding(kind), base = binding.id; let suffix = 1;
  while (used.has(binding.id)) binding.id = `${base}-${suffix++}`;
  used.add(binding.id); placeholders.set(binding.id, kind); return binding;
}
function intersects(a: LocalBounds, b: LocalBounds, inset = EPS): boolean { return (['x', 'y', 'z'] as const).every(k => Math.abs(a.center[k] - b.center[k]) < (a.size[k] + b.size[k]) / 2 - inset); }
function boxCells(map: GridMap, box: LocalBounds): Cell[] {
  const minX = Math.max(0, Math.ceil((box.center.x - box.size.x / 2) / map.cellSize + (map.width - 1) / 2 - .5 + EPS));
  const maxX = Math.min(map.width - 1, Math.floor((box.center.x + box.size.x / 2) / map.cellSize + (map.width - 1) / 2 + .5 - EPS));
  const minR = Math.max(0, Math.ceil((map.height - 1) / 2 - (box.center.z + box.size.z / 2) / map.cellSize - .5 + EPS));
  const maxR = Math.min(map.height - 1, Math.floor((map.height - 1) / 2 - (box.center.z - box.size.z / 2) / map.cellSize + .5 - EPS));
  const result: Cell[] = []; for (let row = minR; row <= maxR; row++) for (let x = minX; x <= maxX; x++) result.push({ x, row }); return result;
}
function propBoxes(map: GridMap, bindings: readonly AssetBinding[]): LocalBounds[] {
  return (map.propInstances ?? []).map(p => { const b = bindings.find(v => v.id === p.bindingId), floor = map.elevations[p.row][p.x]; let y = floor;
    if (p.anchor === 'ceiling') y = (map.ceilings?.find(c => ck(c) === ck(p))?.undersideY ?? floor) - p.size.y;
    if (p.anchor === 'wall') y = floor + Math.max(0, (wallHeight(map, p) - p.size.y) / 2);
    return { center: add(point(map, p, y + p.size.y / 2), add(p.offset, b?.offset ?? { x: 0, y: 0, z: 0 })), size: p.size }; });
}
function legacyFixtureBoxes(map: GridMap, bindings: readonly AssetBinding[]): LocalBounds[] {
  return (map.fixtures ?? []).filter(f => !f.wall).map(f => {
    const b = bindings.find(v => v.id === f.bindingId || !f.bindingId && v.role === f.role), floor = map.elevations[f.row]?.[f.x] ?? 0;
    const n = normal(f.direction); let p = point(map, f, floor);
    if (f.anchor === 'wall') p = add(p, { x: n.x * map.cellSize / 2, y: wallHeight(map, f) / 2, z: n.z * map.cellSize / 2 });
    if (f.anchor === 'ceiling') p.y = map.ceilings?.find(c => ck(c) === ck(f))?.undersideY ?? floor;
    p = add(p, add(f.offset, b?.offset ?? { x: 0, y: 0, z: 0 }));
    const box = b?.bounds ?? { center: { x: 0, y: 0, z: 0 }, size: b?.prop?.size ?? { x: .3, y: .3, z: .3 } };
    if (!b) return { center: p, size: box.size };
    return worldBounds({ ...b, bounds: box, wallMount: defaultWallMount(b) }, p, f.direction + b.rotationY)[0];
  });
}
interface Context { bindings: readonly AssetBinding[]; radius: number; headroom: number; obstacles: LocalBounds[] }
function context(map: GridMap, bindings: readonly AssetBinding[], settings?: GenerationSettings): Context { return { bindings, radius: settings?.levelDesign?.characterRadius ?? .35, headroom: settings?.designer?.headroom ?? map.headroom ?? 2, obstacles: [...propBoxes(map, bindings), ...legacyFixtureBoxes(map, bindings)] }; }
function fitIssue(map: GridMap, fixture: MapFixture, ctx: Context, others: MapFixture[] = map.fixtures ?? []): string | undefined {
  const w = fixture.wall!;
  if (!w.support.length) return '지지할 벽면이 없습니다';
  for (const s of w.support) {
    if (map.rows[s.row]?.[s.x] !== '#' && !(w.site === 'doorTop' && map.rows[s.row]?.[s.x] === 'D' && map.structureFills?.some(f => ck(f) === ck(s) && f.purpose === 'doorTop'))) return '지지 벽면 또는 문 위 마감이 없습니다';
  }
  for (const box of w.bounds) {
    if (box.center.x - box.size.x / 2 < -map.width * map.cellSize / 2 - EPS || box.center.x + box.size.x / 2 > map.width * map.cellSize / 2 + EPS || box.center.z - box.size.z / 2 < -map.height * map.cellSize / 2 - EPS || box.center.z + box.size.z / 2 > map.height * map.cellSize / 2 + EPS) return '맵 경계를 벗어납니다';
    const supportedLow = Math.min(...w.support.map(s => map.rows[s.row][s.x] === '#' ? wallBaseY(map, s, ctx.bindings) : Math.max(...(map.structureFills ?? []).filter(f => ck(f) === ck(s) && f.purpose === 'doorTop').map(f => f.position.y - f.size.y / 2)))), supportedHigh = Math.min(...w.support.map(s => map.rows[s.row][s.x] === '#' ? wallTopY(map, s, ctx.bindings) : Math.min(...(map.structureFills ?? []).filter(f => ck(f) === ck(s) && f.purpose === 'doorTop').map(f => f.position.y + f.size.y / 2))));
    if (box.center.y - box.size.y / 2 < supportedLow - EPS || box.center.y + box.size.y / 2 > supportedHigh + EPS) return '설치 높이가 벽 높이를 벗어납니다';
    for (const c of boxCells(map, box)) {
      const floor = map.elevations[c.row][c.x], tile = map.rows[c.row][c.x];
      const base = tile === '#' ? wallBaseY(map, c, ctx.bindings) : floor, top = tile === '#' ? wallTopY(map, c, ctx.bindings) : floor;
      if (tile === '#' && intersects(box, { center: point(map, c, (base + top) / 2), size: { x: map.cellSize, y: top - base, z: map.cellSize } }, .025)) return '벽 내부와 겹칩니다';
      if ('.PDRB'.includes(tile) && box.center.y - box.size.y / 2 < (terrainSurfaceY(map, c, ctx.bindings) ?? floor) - EPS) return '바닥 아래로 내려갑니다';
      const roof = map.ceilings?.find(v => ck(v) === ck(c)); if (roof && box.center.y + box.size.y / 2 > roof.undersideY + EPS) return '천장과 겹칩니다';
      if ('.DRB'.includes(tile) && intersects(box, { center: point(map, c, floor + ctx.headroom / 2), size: { x: Math.min(map.cellSize, ctx.radius * 2), y: ctx.headroom, z: Math.min(map.cellSize, ctx.radius * 2) } })) return '캐릭터 통행 여유와 겹칩니다';
    }
    for (const door of map.connections) {
      const d = doorReference(map, door), n = normal(((door.direction + 180) % 360) as Direction), p = sub({ ...d.position, y: d.position.y - door.height / 2 }, mul(n, map.cellSize / 2));
      if (intersects(box, { center: p, size: { x: door.direction === 0 || door.direction === 180 ? door.width : map.cellSize, y: door.height, z: door.direction === 90 || door.direction === 270 ? door.width : map.cellSize } })) return '문 개구부와 겹칩니다';
    }
    if (ctx.obstacles.some(o => intersects(box, o))) return '기존 물체와 겹칩니다';
    if (others.some(f => f.id !== fixture.id && f.wall?.bounds.some(o => intersects(box, o)))) return '다른 벽 부착물과 겹칩니다';
  }
  return undefined;
}
export function wallMountDependencies(fixture: MapFixture): Cell[] { return [...new Map([{ x: fixture.x, row: fixture.row }, ...(fixture.wall?.support ?? []).map(s => ({ x: s.x, row: s.row }))].map(c => [ck(c), c])).values()]; }
function protectedFixture(map: GridMap, f: MapFixture) { const locks = new Set((map.lockedCells ?? []).map(ck)); return wallMountDependencies(f).some(c => locks.has(ck(c))); }
function eligible(map: GridMap, f: MapFixture, region?: GenerationRegion) { return !protectedFixture(map, f) && wallMountDependencies(f).every(c => inside(c, region)); }
function settingsFor(settings: WallMountSettings | GenerationSettings) { return 'enabled' in settings ? { config: settings, generation: undefined } : { config: settings.designer?.wallMounts ?? DEFAULT_WALL_SETTINGS, generation: settings }; }
function singleOnFace(map: GridMap, b: AssetBinding, face: Face, site: WallMountSite, fixtureId: string, center = face.center, allFaces = facesFor(map)): MapFixture {
  const def = b.wallMount!, mount = def.mounts[0], yaw = angle(face.n) - angle(norm(scaled(mount.direction, b)));
  const target = { ...center, y: heightAt(def, face.low, face.high) };
  const p = add(sub(target, transformed(mount.position, b, yaw)), b.offset);
  const continuous = site === 'doorTop' ? [face] : allFaces.filter(f => f.support.direction === face.support.direction && Math.abs(dot(sub(f.center, face.center), face.n)) < EPS && f.low === face.low && f.high === face.high);
  return makeFixture(map, b, p, yaw, [{ faces: continuous, start: face.start, end: face.end, n: face.n, t: face.t, low: face.low, high: face.high, length: map.cellSize }], site, fixtureId);
}
function doorReference(map: GridMap, door: MapConnection): NonNullable<WallMountInstance['doorReference']> {
  const cells = connectionCells(map, door), p = point(map, door), across = door.direction === 0 || door.direction === 180, n = normal(((door.direction + 180) % 360) as Direction);
  if (across) p.x += (door.width - map.cellSize) / 2; else p.z -= (door.width - map.cellSize) / 2;
  p.x += n.x * map.cellSize / 2; p.z += n.z * map.cellSize / 2;
  p.y = Math.max(...cells.map(c => map.elevations[c.row]?.[c.x] ?? 0)) + door.height;
  return { position: p, direction: door.direction, width: door.width, height: door.height };
}
function doorCandidates(map: GridMap, b: AssetBinding, faces: Face[]): MapFixture[] {
  const def = b.wallMount!, result: MapFixture[] = [];
  for (const d of map.connections) {
    const reference = doorReference(map, d), cells = connectionCells(map, d), inward = ((d.direction + 180) % 360) as Direction, n = normal(inward), t = tangent(n);
    if (def.sites.includes('doorTop')) {
      const fills = cells.map(c => map.structureFills?.find(f => ck(c) === ck(f) && f.purpose === 'doorTop'));
      if (fills.every(Boolean)) {
        const low = Math.max(...fills.map(f => f!.position.y - f!.size.y / 2)), high = Math.min(...fills.map(f => f!.position.y + f!.size.y / 2));
        const face: Face = { support: { ...cells[0], direction: inward }, cell: cells[0], center: reference.position, n, t, start: sub(reference.position, mul(t, d.width / 2)), end: add(reference.position, mul(t, d.width / 2)), low, high };
        const f = singleOnFace(map, b, face, 'doorTop', `wm-door-${d.id}-top-${b.id}`);
        f.wall!.support = cells.map(c => ({ ...c, direction: inward })); f.wall!.doorId = d.id; f.wall!.doorReference = reference;
        result.push(f);
      }
    }
    if (def.sites.includes('doorSide')) for (const side of (def.doorSide === 'both' ? ['left', 'right'] : [def.doorSide]) as ('left' | 'right')[]) {
      const sign = side === 'left' ? -1 : 1, desired = add(reference.position, mul(t, sign * (d.width / 2 + map.cellSize / 2)));
      const face = faces.filter(f => near(f.n, n) && Math.abs(dot(sub(f.center, desired), n)) < EPS).sort((a, b) => length(sub(a.center, desired)) - length(sub(b.center, desired)))[0];
      if (!face || length(sub({ ...face.center, y: desired.y }, desired)) > map.cellSize / 2 + EPS) continue;
      const f = singleOnFace(map, b, face, 'doorSide', `wm-door-${d.id}-${side}-${b.id}`, undefined, faces);
      f.wall!.doorId = d.id; f.wall!.doorReference = reference; f.wall!.doorSide = side; result.push(f);
    }
  }
  return result;
}

interface Oriented { binding: AssetBinding; yaw: number; rotationZ?: number; input: WallConnector; output?: WallConnector; length: number }
function oriented(b: AssetBinding, side: Side, travel = side.t): Oriented[] {
  const def = b.wallMount!, result: Oriented[] = [];
  const vertical = Math.abs(travel.y) > 1 - EPS;
  for (const yaw of vertical ? [angle(side.n), ...DIRS.filter(d => d !== angle(side.n))] : DIRS) for (const rotationZ of vertical ? [90, 270] : [0]) {
    if (def.mounts.some(m => !near(norm(transformed(m.direction, b, yaw, rotationZ)), side.n))) continue;
    const sockets = def.sockets.map(s => ({ position: transformed(s.position, b, yaw, rotationZ), direction: norm(transformed(s.direction, b, yaw, rotationZ)) }));
    const input = sockets.find(s => near(s.direction, mul(travel, -1))), output = sockets.find(s => near(s.direction, travel));
    if (def.kind === 'endCap') { if (input) result.push({ binding: b, yaw, ...(rotationZ ? { rotationZ } : {}), input, length: 0 }); }
    else if (input && output && dot(sub(output.position, input.position), travel) > EPS && length(sub(sub(output.position, input.position), mul(travel, dot(sub(output.position, input.position), travel)))) < EPS) result.push({ binding: b, yaw, ...(rotationZ ? { rotationZ } : {}), input, output, length: length(sub(output.position, input.position)) });
  }
  return result;
}
function moduleAt(map: GridMap, part: Oriented, socketPosition: Vec3, side: Side, fixtureId: string): MapFixture {
  return makeFixture(map, part.binding, sub(socketPosition, part.input.position), part.yaw, [side], 'wall', fixtureId, part.rotationZ);
}
function matchingMounts(b: AssetBinding, yaw: number, side: Side, p: Vec3, rotationZ = 0) {
  return b.wallMount!.mounts.every(m => {
    if (!near(norm(transformed(m.direction, b, yaw, rotationZ)), side.n)) return false;
    const v = add(p, transformed(m.position, b, yaw, rotationZ));
    return Math.abs(dot(sub(v, side.start), side.n)) < EPS && v.y >= side.low - EPS && v.y <= side.high + EPS;
  });
}
function singleCorner(map: GridMap, b: AssetBinding, a: Side, next: Side, fixtureId: string): MapFixture | undefined {
  const def = b.wallMount!;
  if (def.mounts.length < 2) return undefined;
  for (const baseMount of def.mounts) for (const faceNormal of [a.n, next.n]) {
    const yaw = angle(faceNormal) - angle(norm(scaled(baseMount.direction, b))), mounts = def.mounts.map(m => ({ position: transformed(m.position, b, yaw), direction: norm(transformed(m.direction, b, yaw)) }));
    const ma = mounts.find(m => near(m.direction, a.n)), mb = mounts.find(m => near(m.direction, next.n)); if (!ma || !mb) continue;
    const da = dot(sub(a.end, ma.position), a.n), db = dot(sub(next.start, mb.position), next.n), p = { x: a.n.x * da + next.n.x * db, y: heightAt(def, a.low, a.high) - ma.position.y, z: a.n.z * da + next.n.z * db };
    if (Math.abs(p.y + mb.position.y - heightAt(def, next.low, next.high)) > EPS || mounts.some(m => ![a, next].some(s => near(s.n, m.direction) && Math.abs(dot(sub(add(p, m.position), s.start), s.n)) < EPS))) continue;
    return makeFixture(map, b, add(p, b.offset), yaw, [a, next], 'corner', fixtureId);
  }
  return undefined;
}
function fitLengths(parts: Oriented[], distance: number, exact: boolean): Oriented[] | null {
  if (distance < -EPS) return null;
  if (Math.abs(distance) < EPS) return [];
  const sorted = [...parts].sort((a, b) => b.length - a.length || a.binding.id.localeCompare(b.binding.id));
  // Millimetre quantization is used only to bound search. Actual socket coordinates are checked again.
  const maximum = Math.round(distance * 1000), seen = new Map<number, { previous: number; part: Oriented }>(), queue = [0]; seen.set(0, { previous: -1, part: sorted[0] });
  let best = 0;
  for (let i = 0; i < queue.length && i < 20000; i++) {
    const used = queue[i]; for (const part of sorted) {
      const next = used + Math.max(1, Math.round(part.length * 1000));
      if (next > maximum || seen.has(next)) continue;
      seen.set(next, { previous: used, part }); queue.push(next); if (next > best) best = next;
    }
    if (seen.has(maximum)) { best = maximum; break; }
  }
  if (exact && !seen.has(maximum)) return null;
  const result: Oriented[] = []; for (let n = best; n > 0;) { const item = seen.get(n)!; result.push(item.part); n = item.previous; if (result.length > LIMIT) return null; }
  const total = result.reduce((n, p) => n + p.length, 0);
  return exact && Math.abs(total - distance) > EPS || total > distance + EPS ? null : result;
}
function cornerAt(map: GridMap, bindings: AssetBinding[], a: Side, b: Side, fixtureId: string): MapFixture | undefined {
  const cross = a.t.x * b.t.z - a.t.z * b.t.x, kind = cross > 0 ? 'innerCorner' : 'outerCorner';
  for (const binding of bindings.filter(v => v.wallMount!.kind === kind)) for (const yaw of DIRS) {
    const def = binding.wallMount!, mounts = def.mounts.map(m => ({ position: transformed(m.position, binding, yaw), direction: norm(transformed(m.direction, binding, yaw)) }));
    const ma = mounts.find(m => near(m.direction, a.n)), mb = mounts.find(m => near(m.direction, b.n));
    if (!ma || !mb) continue;
    const p: Vec3 = { x: 0, y: heightAt(def, a.low, a.high) - ma.position.y, z: 0 };
    const da = dot(sub(a.end, ma.position), a.n), db = dot(sub(b.start, mb.position), b.n);
    p.x = a.n.x * da + b.n.x * db; p.z = a.n.z * da + b.n.z * db;
    if (Math.abs(p.y + mb.position.y - heightAt(def, b.low, b.high)) > EPS || mounts.some(m => ![a, b].some(s => near(m.direction, s.n) && Math.abs(dot(sub(add(p, m.position), s.start), s.n)) < EPS))) continue;
    const f = makeFixture(map, binding, add(p, binding.offset), yaw, [a, b], 'corner', fixtureId);
    const sa = f.wall!.sockets.find(s => near(s.direction, mul(a.t, -1))), sb = f.wall!.sockets.find(s => near(s.direction, b.t));
    if (!sa || !sb || dot(sub(sa.position, a.start), a.t) < -EPS || dot(sub(a.end, sa.position), a.t) < -EPS || dot(sub(sb.position, b.start), b.t) < -EPS || dot(sub(b.end, sb.position), b.t) < -EPS) continue;
    return f;
  }
  return undefined;
}
function socketJoin(a: WallConnector, b: WallConnector) { return near(a.position, b.position) && dot(a.direction, b.direction) < -1 + EPS; }
function components(fixtures: MapFixture[]): MapFixture[][] {
  const result: MapFixture[][] = [], used = new Set<MapFixture>();
  for (const first of fixtures) { if (used.has(first)) continue; const group = [first]; used.add(first);
    for (let i = 0; i < group.length; i++) for (const f of fixtures) if (!used.has(f) && group[i].wall!.sockets.some(s => f.wall!.sockets.some(t => socketJoin(s, t)))) { used.add(f); group.push(f); }
    result.push(group);
  }
  return result;
}
function unmatched(fixtures: MapFixture[]) { return fixtures.flatMap(f => f.wall!.sockets.filter(s => !fixtures.some(g => g !== f && g.wall!.sockets.some(t => socketJoin(s, t)))).map(socket => ({ fixture: f, socket }))); }
function buildBoundaryRuns(map: GridMap, boundary: Boundary, family: AssetBinding[], density: number, ctx: Context, prefix: string, issues: ValidationIssue[]): MapFixture[][] {
  const sides = boundary.sides, straight = family.filter(b => b.wallMount!.kind === 'straight'), caps = family.filter(b => b.wallMount!.kind === 'endCap');
  if (!straight.length) return [];
  const selected = new Set<number>(), budget = sides.reduce((n, s) => n + s.length, 0) * density / 100;
  let chosen = 0;
  for (const { s, i } of sides.map((s, i) => ({ s, i })).sort((a, b) => hash(`${prefix}-${a.i}`) - hash(`${prefix}-${b.i}`))) if (chosen < budget - EPS) { selected.add(i); chosen += s.length; }
  const corners = new Map<number, MapFixture>(); // corner i joins side i and i+1.
  for (let i = 0; i < sides.length; i++) {
    const j = (i + 1) % sides.length;
    if (!selected.has(i) || !selected.has(j) || !boundary.closed && j === 0 || !near(sides[i].end, sides[j].start)) continue;
    const f = cornerAt(map, family, sides[i], sides[j], `${prefix}-corner-${i}`);
    if (f && !fitIssue(map, f, ctx)) corners.set(i, f); else issues.push(warning('연속 장식 코너가 없거나 양쪽 벽에 맞지 않아 해당 모서리에서 끝마감합니다.', 'wall-run-corner'));
  }
  // An unsolvable interior length becomes a capped boundary. No stretching or disconnected corners.
  for (let i = 0; i < sides.length; i++) {
    const before = corners.get((i + sides.length - 1) % sides.length), after = corners.get(i), side = sides[i];
    if (!before || !after) continue;
    const a = before.wall!.sockets.find(s => near(s.direction, side.t))!, b = after.wall!.sockets.find(s => near(s.direction, mul(side.t, -1)))!;
    const distance = dot(sub(b.position, a.position), side.t);
    if (length(sub(sub(b.position, a.position), mul(side.t, distance))) > EPS || !fitLengths(straight.flatMap(b => oriented(b, side)), distance, true)) { corners.delete(i); issues.push(warning('원본 부품 길이로 모서리 사이를 정확히 연결할 수 없어 끝마감 후 여백을 남깁니다.', 'wall-run-length')); }
  }
  const pieces: MapFixture[] = [...corners.values()];
  for (let i = 0; i < sides.length; i++) {
    if (!selected.has(i)) continue;
    const side = sides[i], before = corners.get((i + sides.length - 1) % sides.length), after = corners.get(i), parts = straight.flatMap(b => oriented(b, side));
    if (!parts.length) continue;
    const a = before?.wall!.sockets.find(s => near(s.direction, side.t)), b = after?.wall!.sockets.find(s => near(s.direction, mul(side.t, -1)));
    const sidePieces: MapFixture[] = [], capAt = (position: Vec3, travel: Vec3, suffix: string): MapFixture | undefined => {
      for (const part of caps.flatMap(c => oriented(c, side, travel))) { const f = moduleAt(map, part, position, side, `${prefix}-${i}-${suffix}`); if (matchingMounts(part.binding, part.yaw, side, f.wall!.position) && !fitIssue(map, f, ctx, [...pieces, ...sidePieces])) return f; }
      return undefined;
    };
    if (a && b) {
      const sequence = fitLengths(parts, dot(sub(b.position, a.position), side.t), true);
      if (!sequence) continue;
      let p = a.position; for (const [k, part] of sequence.entries()) { const f = moduleAt(map, part, p, side, `${prefix}-${i}-${k}`); sidePieces.push(f); p = add(p, mul(side.t, part.length)); }
    } else {
      const travel = b ? mul(side.t, -1) : side.t, availableParts = straight.flatMap(c => oriented(c, side, travel)), sample = availableParts[0];
      if (!sample) continue;
      let p: Vec3, available: number;
      if (a || b) { p = (a ?? b)!.position; available = dot(sub(b ? side.start : side.end, p), travel); }
      else {
        const mount = transformed(sample.binding.wallMount!.mounts[0].position, sample.binding, sample.yaw), anchor = { ...side.start, y: heightAt(sample.binding.wallMount!, side.low, side.high) };
        // Keep caps within the side; their outermost geometry determines the required margin.
        const railOffset = sub(sample.input.position, mount), prototype = add(anchor, sub(railOffset, mul(travel, dot(railOffset, travel)))), margins = caps.flatMap(c => oriented(c, side, mul(travel, -1))).map(c => { const f = moduleAt(map, c, prototype, side, 'prototype'); return Math.max(0, ...f.wall!.bounds.map(box => -dot(sub(box.center, prototype), travel) + (Math.abs(travel.x) * box.size.x + Math.abs(travel.z) * box.size.z) / 2)); });
        if (!margins.length) { issues.push(warning('사용 가능한 끝마감 부품이 없어 연결 장식 구간을 건너뛰었습니다.', 'wall-run-cap')); continue; }
        p = add(prototype, mul(travel, Math.min(...margins) + .001)); available = side.length - Math.min(...margins) - .001;
        const cap = capAt(p, mul(travel, -1), 'start'); if (!cap) continue; sidePieces.push(cap);
      }
      const capOptions = caps.flatMap(c => oriented(c, side, travel)), margin = Math.min(...capOptions.map(c => { const f = moduleAt(map, c, p, side, 'prototype'); return Math.max(0, ...f.wall!.bounds.map(box => dot(sub(box.center, p), travel) + (Math.abs(travel.x) * box.size.x + Math.abs(travel.z) * box.size.z) / 2)); }));
      if (!Number.isFinite(margin)) { issues.push(warning('사용 가능한 끝마감 부품이 없어 연결 장식 구간을 건너뛰었습니다.', 'wall-run-cap')); continue; }
      const sequence = fitLengths(availableParts, Math.max(0, available - margin - .001), false) ?? [];
      if (!sequence.length && !(a || b)) continue;
      for (const [k, part] of sequence.entries()) { const f = moduleAt(map, part, p, side, `${prefix}-${i}-${k}`); sidePieces.push(f); p = add(p, mul(travel, part.length)); }
      const cap = capAt(p, travel, 'end'); if (!cap) continue; sidePieces.push(cap);
    }
    if (sidePieces.some(f => !matchingMounts(family.find(b => b.id === f.bindingId)!, f.wall!.rotationY, side, f.wall!.position) || fitIssue(map, f, ctx, [...pieces, ...sidePieces]))) { issues.push(warning('연결 장식의 부착점이 벽에 맞지 않거나 기존 물체·통행 공간과 겹쳐 해당 구간을 건너뛰었습니다.', 'wall-run-collision')); continue; }
    pieces.push(...sidePieces);
  }
  const complete: MapFixture[][] = [];
  for (const group of components(pieces)) {
    if (unmatched(group).length) { issues.push(warning('연결점이 맞는 끝마감까지 완성할 수 없는 구간을 건너뛰었습니다.', 'wall-run-open')); continue; }
    complete.push(group);
  }
  return complete;
}

/** Standalone upright runs use the native horizontal straight/cap kit, rolled around its wall normal. */
function buildVerticalRun(map: GridMap, face: Face, family: AssetBinding[], ctx: Context, prefix: string, range?: WallMountSettings['verticalRange']): MapFixture[] | undefined {
  const up = { x: 0, y: 1, z: 0 }, down = { x: 0, y: -1, z: 0 };
  const side: Side = { faces: [face], start: face.start, end: face.end, n: face.n, t: face.t, low: face.low, high: face.high, length: map.cellSize };
  const parts = family.filter(b => b.wallMount!.kind === 'straight').flatMap(b => oriented(b, side, up)), caps = family.filter(b => b.wallMount!.kind === 'endCap');
  const lower = caps.flatMap(b => oriented(b, side, down)), upper = caps.flatMap(b => oriented(b, side, up));
  if (!parts.length || !lower.length || !upper.length) return undefined;
  const sample = parts[0], mount = transformed(sample.binding.wallMount!.mounts[0].position, sample.binding, sample.yaw, sample.rotationZ), offset = sub(sample.input.position, mount);
  const rail = add(face.center, { x: offset.x, y: -face.center.y, z: offset.z });
  const prototypes = [...parts, ...lower, ...upper].flatMap(part => moduleAt(map, part, rail, side, 'prototype').wall!.bounds);
  const overlapsProfile = (box: LocalBounds) => prototypes.some(p => Math.abs(p.center.x - box.center.x) < (p.size.x + box.size.x) / 2 - EPS && Math.abs(p.center.z - box.center.z) < (p.size.z + box.size.z) / 2 - EPS);
  const obstacles = [...ctx.obstacles, ...(map.fixtures ?? []).flatMap(f => f.wall?.bounds ?? [])];
  for (const door of map.connections) {
    const d = doorReference(map, door), n = normal(((door.direction + 180) % 360) as Direction), center = sub({ ...d.position, y: d.position.y - door.height / 2 }, mul(n, map.cellSize / 2));
    obstacles.push({ center, size: { x: door.direction === 0 || door.direction === 180 ? door.width : map.cellSize, y: door.height, z: door.direction === 90 || door.direction === 270 ? door.width : map.cellSize } });
  }
  const [requestedLow, requestedHigh] = verticalLimits(face, range);
  let intervals: [number, number][] = [[Math.max(face.low, requestedLow) + .001, Math.min(face.high, requestedHigh, map.ceilings?.find(c => ck(c) === ck(face.cell))?.undersideY ?? Infinity) - .001]];
  for (const obstacle of obstacles.filter(overlapsProfile)) {
    const low = obstacle.center.y - obstacle.size.y / 2 - .001, high = obstacle.center.y + obstacle.size.y / 2 + .001;
    intervals = intervals.flatMap(([a, b]) => high <= a || low >= b ? [[a, b] as [number, number]] : [[a, Math.min(b, low)] as [number, number], [Math.max(a, high), b] as [number, number]].filter(([x, y]) => y > x + EPS));
  }
  for (const [low, high] of intervals.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))) for (const first of lower) for (const last of upper) {
    const lowerBounds = moduleAt(map, first, rail, side, 'prototype').wall!.bounds, upperBounds = moduleAt(map, last, rail, side, 'prototype').wall!.bounds;
    const startMargin = Math.max(0, ...lowerBounds.map(b => -b.center.y + b.size.y / 2)), endMargin = Math.max(0, ...upperBounds.map(b => b.center.y + b.size.y / 2));
    const sequence = fitLengths(parts, high - low - startMargin - endMargin, false); if (!sequence?.length) continue;
    let position = { ...rail, y: low + startMargin };
    const pieces = [moduleAt(map, first, position, side, `${prefix}-start`)];
    for (const [i, part] of sequence.entries()) { pieces.push(moduleAt(map, part, position, side, `${prefix}-${i}`)); position = add(position, mul(up, part.length)); }
    pieces.push(moduleAt(map, last, position, side, `${prefix}-end`));
    if (!withinVerticalRange(pieces, side, range) || pieces.some(f => !matchingMounts(family.find(b => b.id === f.bindingId)!, f.wall!.rotationY, side, f.wall!.position, f.wall!.rotationZ) || fitIssue(map, f, ctx, [...(map.fixtures ?? []), ...pieces])) || unmatched(pieces).length) continue;
    return pieces;
  }
  return undefined;
}

function downwardBranch(map: GridMap, joint: MapFixture, socket: WallConnector, side: Side, family: AssetBinding[], ctx: Context, range?: WallMountSettings['verticalRange']): MapFixture[] | undefined {
  const down = { x: 0, y: -1, z: 0 }, parts = family.filter(b => b.wallMount!.kind === 'straight').flatMap(b => oriented(b, side, down)), caps = family.filter(b => b.wallMount!.kind === 'endCap').flatMap(b => oriented(b, side, down));
  const branchPrefix = joint.id.length > 60 ? `wm-junction-${hash(joint.id).toString(36)}` : joint.id;
  if (!parts.length || !caps.length) return undefined;
  const prototypes = [...parts, ...caps].flatMap(part => moduleAt(map, part, socket.position, side, 'prototype').wall!.bounds);
  const profileOverlap = (box: LocalBounds) => prototypes.some(p => Math.abs(p.center.x - box.center.x) < (p.size.x + box.size.x) / 2 - EPS && Math.abs(p.center.z - box.center.z) < (p.size.z + box.size.z) / 2 - EPS);
  const [requestedLow, requestedHigh] = verticalLimits(side, range);
  if (socket.position.y > requestedHigh + EPS || socket.position.y < requestedLow - EPS || !withinVerticalRange([joint], side, range)) return undefined;
  let low = Math.max(side.low, requestedLow) + .001;
  for (const obstacle of [...ctx.obstacles, ...(map.fixtures ?? []).flatMap(f => f.wall?.bounds ?? [])].filter(profileOverlap)) {
    const bottom = obstacle.center.y - obstacle.size.y / 2, top = obstacle.center.y + obstacle.size.y / 2;
    if (bottom >= socket.position.y - EPS) continue;
    if (top >= socket.position.y - EPS) return undefined;
    low = Math.max(low, top + .001);
  }
  for (const cap of caps) {
    const capBounds = moduleAt(map, cap, socket.position, side, 'prototype').wall!.bounds, margin = Math.max(0, ...capBounds.map(b => socket.position.y - b.center.y + b.size.y / 2));
    const sequence = fitLengths(parts, socket.position.y - low - margin, false); if (!sequence?.length) continue;
    let p = socket.position; const pieces: MapFixture[] = [];
    for (const [i, part] of sequence.entries()) { pieces.push(moduleAt(map, part, p, side, `${branchPrefix}-branch-${i}`)); p = add(p, mul(down, part.length)); }
    pieces.push(moduleAt(map, cap, p, side, `${branchPrefix}-branch-cap`));
    if (!withinVerticalRange(pieces, side, range) || pieces.some(f => !matchingMounts(family.find(b => b.id === f.bindingId)!, f.wall!.rotationY, side, f.wall!.position, f.wall!.rotationZ) || fitIssue(map, f, ctx, [...(map.fixtures ?? []), joint, ...pieces]))) continue;
    return pieces;
  }
  return undefined;
}

interface JunctionAddition { fixtures: MapFixture[]; removeIds: Set<string>; runId: string }
function connectAt(map: GridMap, target: MapFixture, retained: WallConnector[], removed: MapFixture[], family: AssetBinding[], junctions: AssetBinding[], ctx: Context, faces: Face[], region?: GenerationRegion, range?: WallMountSettings['verticalRange']): JunctionAddition | undefined {
  const first = target.wall!.support.map(s => faces.find(f => fk(f.support) === fk(s))).find((f): f is Face => !!f); if (!first) return undefined;
  const side: Side = { faces: faces.filter(f => near(f.n, first.n) && Math.abs(dot(sub(f.center, first.center), first.n)) < EPS && f.low === first.low && f.high === first.high), start: first.start, end: first.end, n: first.n, t: first.t, low: first.low, high: first.high, length: map.cellSize };
  const yaw = target.wall!.rotationY, yaws = [yaw, ...DIRS.filter(d => d !== (yaw % 360 + 360) % 360)];
  for (const binding of junctions) for (const candidateYaw of yaws) for (const rotationZ of [0, 90, 180, 270]) {
    if (binding.wallMount!.mounts.some(m => !near(norm(transformed(m.direction, binding, candidateYaw, rotationZ)), side.n))) continue;
    const local = worldSockets(binding, { x: 0, y: 0, z: 0 }, candidateYaw, rotationZ), input = local.find(s => near(s.direction, retained[0].direction)); if (!input) continue;
    const p = sub(retained[0].position, input.position), sockets = worldSockets(binding, p, candidateYaw, rotationZ);
    if (!retained.every(s => sockets.some(t => near(s.position, t.position) && near(s.direction, t.direction)))) continue;
    const branch = sockets.find(s => s.direction.y < -1 + EPS); if (!branch || sockets.length !== retained.length + 1) continue;
    const joint = makeFixture(map, binding, p, candidateYaw, [side], 'wall', target.id, rotationZ);
    joint.wall!.runId = target.wall!.runId;
    const jointFaceKeys = new Set(joint.wall!.support.map(fk)), verticalRuns = new Set((map.fixtures ?? []).filter(f => f.wall?.runId && f.wall.runId !== target.wall!.runId && f.wall.support.some(s => jointFaceKeys.has(fk(s)))).map(f => f.wall!.runId!));
    const removableVertical = [...verticalRuns].flatMap(runId => {
      const group = (map.fixtures ?? []).filter(f => f.wall?.runId === runId);
      return group.every(f => !f.wall!.authored && eligible(map, f, region) && f.wall!.sockets.every(s => Math.abs(s.direction.y) > 1 - EPS) && fixtureBinding(f, ctx.bindings)?.wallMount?.family === binding.wallMount!.family) ? group : [];
    });
    const removeIds = new Set([...removed, ...removableVertical].map(f => f.id));
    if ((map.fixtures ?? []).some(f => !removeIds.has(f.id) && f.linkedId && removeIds.has(f.linkedId) && f.linkedId !== joint.id)) continue;
    const work = { ...map, fixtures: (map.fixtures ?? []).filter(f => !removeIds.has(f.id)) };
    if (!eligible(map, joint, region) || fitIssue(work, joint, ctx)) continue;
    const branchPieces = downwardBranch(work, joint, branch, side, family, ctx, range); if (!branchPieces || branchPieces.some(f => !eligible(map, f, region))) continue;
    const additions = [joint, ...branchPieces]; additions.forEach(f => { f.wall!.runId = target.wall!.runId; });
    if (additions.some(f => work.fixtures.some(g => g.id === f.id))) continue;
    const group = [...work.fixtures.filter(f => f.wall?.runId === target.wall!.runId), ...additions];
    if (unmatched(group).length || components(group).length !== 1 || group.some(f => f.wall!.sockets.some(s => group.reduce((n, g) => n + (g === f ? 0 : g.wall!.sockets.filter(t => socketJoin(s, t)).length), 0) !== 1))) continue;
    return { fixtures: additions, removeIds, runId: target.wall!.runId! };
  }
  return undefined;
}

function connectRuns(map: GridMap, catalog: AssetBinding[], bindings: AssetBinding[], activeFaces: Face[], config: WallMountSettings, ctx: Context, seed: number, region: GenerationRegion | undefined, issues: ValidationIssue[]): { added: number; removed: number; changed: boolean } {
  const result = { added: 0, removed: 0, changed: false }, desired = Math.ceil(activeFaces.length * config.runDensity / 100), usedFaces = new Set<string>();
  for (const f of map.fixtures ?? []) if (f.wall && isJunction(fixtureBinding(f, bindings)?.wallMount?.kind ?? 'single')) f.wall.support.forEach(s => usedFaces.add(fk(s)));
  const groups = new Map<string, MapFixture[]>();
  for (const f of map.fixtures ?? []) if (f.wall?.runId) groups.set(f.wall.runId, [...(groups.get(f.wall.runId) ?? []), f]);
  const editable = new Set([...groups].filter(([, group]) => group.every(f => !f.wall!.authored && eligible(map, f, region))).map(([runId]) => runId));
  const candidates = (map.fixtures ?? []).filter(f => f.wall?.runId && editable.has(f.wall.runId) && f.wall.sockets.every(s => Math.abs(s.direction.y) < EPS) && ['straight', 'endCap'].includes(fixtureBinding(f, bindings)?.wallMount?.kind ?? ''));
  candidates.sort((a, b) => Number(fixtureBinding(b, bindings)?.wallMount?.kind === 'endCap') - Number(fixtureBinding(a, bindings)?.wallMount?.kind === 'endCap') || hash(`${seed}-joint-${a.id}`) - hash(`${seed}-joint-${b.id}`));
  let attempted = false;
  for (const original of candidates) {
    if (usedFaces.size >= desired) break;
    const target = map.fixtures!.find(f => f.id === original.id); if (!target?.wall || !target.wall.support.some(s => !usedFaces.has(fk(s)))) continue;
    const definition = fixtureBinding(target, bindings)?.wallMount, kind = definition?.kind === 'endCap' ? 'elbow' : 'tee', family = catalog.filter(b => b.wallMount!.family === definition?.family && (b.prop?.weight ?? 1) > 0);
    const junctions = family.filter(b => b.wallMount!.kind === kind && hash(`${seed}-joint-prob-${target.id}-${b.id}`) % 10000 < b.wallMount!.probability * 100);
    attempted = true; if (!junctions.length) continue;
    let addition = connectAt(map, target, target.wall.sockets, [target], family, junctions, ctx, activeFaces, region, config.verticalRange);
    if (!addition && kind === 'elbow') {
      const terminal = map.fixtures!.find(f => f.wall?.runId === target.wall!.runId && fixtureBinding(f, bindings)?.wallMount?.kind === 'straight' && f.wall!.sockets.some(s => target.wall!.sockets.some(t => socketJoin(s, t))));
      const retained = terminal?.wall!.sockets.filter(s => !target.wall!.sockets.some(t => socketJoin(s, t)));
      if (terminal && retained?.length === 1 && !terminal.wall!.authored && eligible(map, terminal, region)) addition = connectAt(map, target, retained, [target, terminal], family, junctions, ctx, activeFaces, region, config.verticalRange);
    }
    if (!addition || map.fixtures!.length - addition.removeIds.size + addition.fixtures.length > LIMIT) continue;
    map.fixtures = [...map.fixtures!.filter(f => !addition!.removeIds.has(f.id)), ...addition.fixtures];
    addition.fixtures[0].wall!.support.forEach(s => usedFaces.add(fk(s))); result.added += addition.fixtures.length; result.removed += addition.removeIds.size; result.changed = true;
  }
  if (attempted && usedFaces.size < desired) issues.push(warning('같은 세트의 엘보·T 부품, 정확한 연결점, 벽 높이·여유 공간을 만족하는 구간만 연결했습니다. 기존 독립 배관은 유지했습니다.', 'wall-junction-fit'));
  return result;
}

/** Socket-space turns work for native off-pivot assets as well as preview geometry. */
function wallTurns(family: AssetBinding[], side: Side, incoming: Vec3, outgoing: Vec3): Oriented[] {
  const result: Oriented[] = [];
  for (const binding of family.filter(b => b.wallMount!.kind === 'elbow')) for (const yaw of DIRS) for (const rotationZ of DIRS) {
    if (binding.wallMount!.mounts.some(m => !near(norm(transformed(m.direction, binding, yaw, rotationZ)), side.n))) continue;
    const sockets = worldSockets(binding, { x: 0, y: 0, z: 0 }, yaw, rotationZ);
    const input = sockets.find(s => near(s.direction, mul(incoming, -1))), output = sockets.find(s => near(s.direction, outgoing));
    if (input && output) result.push({ binding, yaw, ...(rotationZ ? { rotationZ } : {}), input, output, length: length(sub(output.position, input.position)) });
  }
  return result;
}
function routeLength(fixtures: MapFixture[]): number {
  return fixtures.reduce((total, fixture) => { const sockets = fixture.wall!.sockets;
    if (sockets.length === 3) { const a = sockets[0], b = sockets.find(s => Math.abs(dot(a.direction, s.direction)) < EPS)!;
      const hub = add(a.position, mul(a.direction, dot(sub(b.position, a.position), a.direction)));
      return total + sockets.reduce((sum, socket) => sum + length(sub(socket.position, hub)), 0);
    }
    if (sockets.length !== 2) return total;
    const delta = sub(sockets[1].position, sockets[0].position); return total + Math.abs(delta.x) + Math.abs(delta.y) + Math.abs(delta.z);
  }, 0);
}
function sideContains(side: Side, fixture: MapFixture): boolean {
  return fixture.wall!.bounds.every(box => { const center = dot(sub(box.center, side.start), side.t), radius = (Math.abs(side.t.x) * box.size.x + Math.abs(side.t.z) * box.size.z) / 2; return center - radius >= -EPS && center + radius <= side.length + EPS; });
}
/** A capped horizontal spine, optionally stepping to another level exactly once. */
function composedSideRun(map: GridMap, side: Side, family: AssetBinding[], config: WallMountSettings, ctx: Context, prefix: string, budget: number, seed: number): MapFixture[] | undefined {
  const travel = side.t, straight = family.filter(b => b.wallMount!.kind === 'straight'), caps = family.filter(b => b.wallMount!.kind === 'endCap');
  const parts = straight.flatMap(b => oriented(b, side)), starts = caps.flatMap(b => oriented(b, side, mul(travel, -1))), ends = caps.flatMap(b => oriented(b, side));
  if (!parts.length || !starts.length || !ends.length) return undefined;
  const sample = parts[0], nativeLength = Math.min(...parts.map(p => p.length));
  // Two long stretches read as a deliberate service route; tiny isolated scraps do not.
  if (Math.min(side.length, budget) < nativeLength * 2 + .2) return undefined;
  const mount = transformed(sample.binding.wallMount!.mounts[0].position, sample.binding, sample.yaw), rail = sub(sample.input.position, mount);
  const policy = config.runHeight, roomSpan = side.high - side.low;
  const verticalSigns = hash(`${seed}-${prefix}-rise`) % 2 ? [1, -1] : [-1, 1];
  const fixedHeight = policy?.reference === 'top' ? side.high - policy.min : side.low + (policy?.min ?? 0);
  const allowed: [number, number] = policy?.mode === 'fixed' ? [fixedHeight, fixedHeight]
    : policy?.mode === 'random' ? policy.reference === 'floor' ? [side.low + policy.min, side.low + policy.max] : [side.high - policy.max, side.high - policy.min] : [side.low, side.high];
  const baseHeights = policy?.mode === 'fixed' ? [policy.reference === 'floor' ? side.low + policy.min : side.high - policy.min]
    : policy?.mode === 'auto' ? (verticalSigns[0] > 0 ? [.25, .72, .5, .06, .94] : [.72, .25, .5, .94, .06]).map(fraction => side.low + roomSpan * fraction)
      : policy?.mode === 'random' ? [allowed[0] + (allowed[1] - allowed[0]) * (hash(`${seed}-${prefix}-height`) / 4294967296), allowed[0] + (allowed[1] - allowed[0]) * .2, allowed[0] + (allowed[1] - allowed[0]) * .8]
        : [heightAt(sample.binding.wallMount!, side.low, side.high)];
  const stepAllowed = config.runOrientation === 'both' && config.connectRuns !== false && policy?.mode !== 'fixed';
  // Start near a furnished area where possible, and try other continuous spans around obstructions.
  const furniture = (map.propInstances ?? []).map(p => dot(sub(point(map, p), side.start), travel)).filter(n => n >= 0 && n <= side.length);
  const preferred = furniture.length ? furniture.reduce((a, b) => a + b, 0) / furniture.length / side.length : hash(`${seed}-${prefix}-anchor`) / 4294967296;
  const offsets = [...new Set([Math.max(0, Math.min(1, preferred)), .5, 0, 1, .25, .75])];
  const safe = (fixtures: MapFixture[]) => !unmatched(fixtures).length && fixtures.every(f => sideContains(side, f) && matchingMounts(family.find(b => b.id === f.bindingId)!, f.wall!.rotationY, side, f.wall!.position, f.wall!.rotationZ) && !fitIssue(map, f, ctx, [...(map.fixtures ?? []), ...fixtures]));
  const heightFits = (fixtures: MapFixture[]) => fixtures.filter(f => f.wall!.sockets.every(s => Math.abs(s.direction.y) < EPS)).every(f => {
    const binding = family.find(b => b.id === f.bindingId)!;
    return binding.wallMount!.mounts.every(m => { const y = add(f.wall!.position, transformed(m.position, binding, f.wall!.rotationY, f.wall!.rotationZ)).y; return y >= allowed[0] - EPS && y <= allowed[1] + EPS; });
  });
  for (const stepping of stepAllowed ? [true, false] : [false]) for (const height of baseHeights) for (const fraction of [1, .8, .6]) {
    const maximum = Math.min(side.length - .24, budget) * fraction;
    if (maximum < nativeLength * 2) continue;
    for (const sign of stepping ? verticalSigns : [0]) {
      const vertical = { x: 0, y: sign, z: 0 }, upward = straight.flatMap(b => oriented(b, side, vertical));
      const firstTurns = stepping ? wallTurns(family, side, travel, vertical) : [undefined], lastTurns = stepping ? wallTurns(family, side, vertical, travel) : [undefined];
      for (const firstTurn of firstTurns) for (const lastTurn of lastTurns) {
        if (stepping && (!firstTurn || !lastTurn || !upward.length)) continue;
        // Prefer one native vertical segment; another is only attempted if its geometry fits.
        for (const verticalCount of stepping ? [1, 2] : [0]) {
          const rise = stepping ? [...upward].sort((a, b) => a.length - b.length || a.binding.id.localeCompare(b.binding.id))[0] : undefined;
          const middleParts = rise ? Array.from({ length: verticalCount }, () => rise) : [];
          const turns = firstTurn && lastTurn ? [firstTurn, ...middleParts, lastTurn] : [];
          let delta = { x: 0, y: 0, z: 0 }; for (const part of turns) delta = add(delta, sub(part.output!.position, part.input.position));
          if (stepping && (Math.abs(delta.y) < EPS || Math.abs(dot(delta, side.n)) > EPS)) continue;
          const stepDistance = turns.reduce((sum, part) => { const d = sub(part.output!.position, part.input.position); return sum + Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z); }, 0);
          const horizontalBudget = maximum - stepDistance;
          if (horizontalBudget < nativeLength * 2) continue;
          const firstDistance = horizontalBudget * (furniture.length ? Math.max(.25, Math.min(.75, preferred)) : .35 + .3 * hash(`${seed}-${prefix}-step`) / 4294967296);
          const firstHalf = fitLengths(parts, stepping ? firstDistance : horizontalBudget, false); if (!firstHalf?.length) continue;
          const lastHalf = stepping ? fitLengths(parts, horizontalBudget - firstHalf.reduce((n, part) => n + part.length, 0), false) : [];
          if (!lastHalf || stepping && !lastHalf.length) continue;
          const plan = [...firstHalf, ...turns, ...lastHalf], span = plan.reduce((sum, part) => sum + dot(sub(part.output!.position, part.input.position), travel), 0);
          if (span <= nativeLength || span > side.length - .2 || stepDistance + firstHalf.concat(lastHalf).reduce((sum, part) => sum + part.length, 0) > budget + EPS) continue;
          for (const offset of offsets) for (const startCap of starts) for (const endCap of ends) {
            const p = add({ ...side.start, y: height }, add(sub(rail, mul(travel, dot(rail, travel))), mul(travel, .12 + Math.max(0, side.length - span - .24) * offset)));
            let cursor = p;
            const fixtures = [moduleAt(map, startCap, cursor, side, `${prefix}-start`)];
            for (const [index, part] of plan.entries()) { const f = moduleAt(map, part, cursor, side, `${prefix}-${index}`); fixtures.push(f); cursor = add(cursor, sub(part.output!.position, part.input.position)); }
            fixtures.push(moduleAt(map, endCap, cursor, side, `${prefix}-end`));
            if (!heightFits(fixtures) || !withinVerticalRange(fixtures.filter(f => f.wall!.sockets.some(s => Math.abs(s.direction.y) > 1 - EPS)), side, config.verticalRange) || !safe(fixtures)) continue;
            return fixtures;
          }
        }
      }
    }
  }
  return undefined;
}

function movedRoute(fixtures: MapFixture[], dy: number, suffix = ''): MapFixture[] {
  return fixtures.map(f => { const copy = structuredClone(f), delta = { x: 0, y: dy, z: 0 }; copy.id += suffix;
    copy.wall!.position = add(copy.wall!.position, delta); copy.wall!.bounds.forEach(box => { box.center = add(box.center, delta); }); copy.wall!.sockets.forEach(socket => { socket.position = add(socket.position, delta); }); return copy;
  });
}
function orderedRoute(group: MapFixture[], firstSide: Side): MapFixture[] {
  const cap = group.filter(f => f.wall!.sockets.length === 1 && f.wall!.support.some(s => s.direction === firstSide.faces[0].support.direction)).sort((a, b) => dot(sub(a.wall!.sockets[0].position, firstSide.start), firstSide.t) - dot(sub(b.wall!.sockets[0].position, firstSide.start), firstSide.t))[0];
  if (!cap) return [];
  const ordered = [cap], used = new Set([cap]);
  while (ordered.length < group.length) { const last = ordered.at(-1)!, next = group.find(f => !used.has(f) && last.wall!.sockets.some(s => f.wall!.sockets.some(t => socketJoin(s, t)))); if (!next) break; used.add(next); ordered.push(next); }
  return ordered.length === group.length ? ordered : [];
}
function routeFits(map: GridMap, group: MapFixture[], sides: Side[], family: AssetBinding[], ctx: Context, config: WallMountSettings): boolean {
  return !unmatched(group).length && components(group).length === 1 && group.every(f => {
    const binding = family.find(b => b.id === f.bindingId)!;
    const mounted = binding.wallMount!.mounts.every(m => sides.some(side => near(norm(transformed(m.direction, binding, f.wall!.rotationY, f.wall!.rotationZ)), side.n) && matchingMounts({ ...binding, wallMount: { ...binding.wallMount!, mounts: [m] } }, f.wall!.rotationY, side, f.wall!.position, f.wall!.rotationZ)));
    const supportedSide = sides.find(side => f.wall!.support.some(s => side.faces.some(face => fk(face.support) === fk(s))));
    if (!mounted || fitIssue(map, f, ctx, [...(map.fixtures ?? []), ...group]) || !supportedSide) return false;
    if (f.wall!.sockets.some(s => Math.abs(s.direction.y) > 1 - EPS) && !withinVerticalRange([f], supportedSide, config.verticalRange)) return false;
    if (['fixed', 'random'].includes(config.runHeight?.mode ?? '') && f.wall!.sockets.every(s => Math.abs(s.direction.y) < EPS)) {
      const policy = config.runHeight!, low = policy.reference === 'floor' ? supportedSide.low + policy.min : supportedSide.high - (policy.mode === 'fixed' ? policy.min : policy.max), high = policy.mode === 'fixed' ? low : policy.reference === 'floor' ? supportedSide.low + policy.max : supportedSide.high - policy.min;
      if (binding.wallMount!.mounts.some(m => { const y = add(f.wall!.position, transformed(m.position, binding, f.wall!.rotationY, f.wall!.rotationZ)).y; return y < low - EPS || y > high + EPS; })) return false;
    }
    return true;
  });
}
/** Replace an exact native straight span and lift the entire downstream path, including wall corners. */
function stepBoundaryRun(map: GridMap, source: MapFixture[], sides: Side[], family: AssetBinding[], config: WallMountSettings, ctx: Context, prefix: string, sign: number, preferred: number): { group: MapFixture[]; index: number } | undefined {
  const ordered = orderedRoute(source, sides[0]), candidates = ordered.map((f, index) => ({ f, index })).filter(({ f, index }) => index > 1 && index < ordered.length - 3 && fixtureBinding(f, ctx.bindings)?.wallMount?.kind === 'straight');
  candidates.sort((a, b) => Math.abs(a.index - preferred) - Math.abs(b.index - preferred));
  for (const { f, index } of candidates) {
    const side = sides.find(s => f.wall!.support.every(support => s.faces.some(face => fk(face.support) === fk(support)))); if (!side) continue;
    const input = f.wall!.sockets.find(s => ordered[index - 1].wall!.sockets.some(t => socketJoin(s, t)))!, travel = mul(input.direction, -1), vertical = { x: 0, y: sign, z: 0 };
    const firstTurns = wallTurns(family, side, travel, vertical), lastTurns = wallTurns(family, side, vertical, travel), verticalParts = family.filter(b => b.wallMount!.kind === 'straight').flatMap(b => oriented(b, side, vertical)).sort((a, b) => a.length - b.length || a.binding.id.localeCompare(b.binding.id));
    for (const first of firstTurns) for (const last of lastTurns) for (const upright of verticalParts) for (const count of [1, 2]) {
      const plan = [first, ...Array.from({ length: count }, () => upright), last];
      let delta = { x: 0, y: 0, z: 0 }; plan.forEach(part => { delta = add(delta, sub(part.output!.position, part.input.position)); });
      const advance = dot(delta, travel); if (advance <= EPS || Math.abs(dot(delta, side.n)) > EPS || Math.abs(delta.y) < EPS) continue;
      let endIndex = index, output: WallConnector | undefined;
      while (endIndex < ordered.length - 1) {
        const current = ordered[endIndex]; if (fixtureBinding(current, ctx.bindings)?.wallMount?.kind !== 'straight' || !current.wall!.support.every(s => side.faces.some(face => fk(face.support) === fk(s)))) break;
        output = current.wall!.sockets.find(s => near(s.direction, travel)); if (!output) break;
        const distance = dot(sub(output.position, input.position), travel); if (distance >= advance - EPS) break; endIndex++;
      }
      if (!output) continue;
      const remainder = dot(sub(output.position, input.position), travel) - advance;
      const continuation = fitLengths(family.filter(b => b.wallMount!.kind === 'straight').flatMap(b => oriented(b, side, travel)), remainder, true);
      if (!continuation) continue;
      plan.push(...continuation);
      let cursor = input.position; const step: MapFixture[] = [];
      for (const [partIndex, part] of plan.entries()) { step.push(moduleAt(map, part, cursor, side, `${prefix}-step-${partIndex}`)); cursor = add(cursor, sub(part.output!.position, part.input.position)); }
      const shift = sub(cursor, output.position); if (Math.abs(shift.x) > EPS || Math.abs(shift.z) > EPS) continue;
      const group = [...ordered.slice(0, index), ...step, ...movedRoute(ordered.slice(endIndex + 1), shift.y)];
      if (routeFits(map, group, sides, family, ctx, config)) return { group, index };
    }
  }
  return undefined;
}

function composedBoundaryRuns(map: GridMap, boundary: Boundary, catalog: AssetBinding[], config: WallMountSettings, ctx: Context, budget: number, seed: number): MapFixture[][] {
  if (boundary.sides.length < 2 || config.runOrientation === 'vertical') return [];
  const families = [...new Set(catalog.filter(b => b.wallMount!.kind === 'straight').map(b => b.wallMount!.family))].sort();
  const startIndices = boundary.sides.map((side, index) => ({ side, index })).sort((a, b) => b.side.length - a.side.length || hash(`${seed}-${fk(a.side.faces[0].support)}`) - hash(`${seed}-${fk(b.side.faces[0].support)}`));
  for (const { index } of startIndices) for (const familyName of families) {
    const key = `${familyName}-${fk(boundary.sides[index].faces[0].support)}`, prefix = `wm-run-${hash(`${seed}-composed-boundary-${key}`).toString(36)}`;
    if (map.fixtures?.some(f => f.wall?.runId?.startsWith(`${prefix}-`))) continue;
    const available = catalog.filter(b => b.wallMount!.family === familyName && (b.prop?.weight ?? 1) > 0 && hash(`${seed}-${key}-prob-${b.id}`) % 10000 < b.wallMount!.probability * 100);
    if (!available.some(b => ['innerCorner', 'outerCorner'].includes(b.wallMount!.kind))) continue;
    const parallel = config.runDensity >= 65 && config.runHeight?.mode !== 'fixed', stepWanted = config.runOrientation === 'both' && config.connectRuns !== false && config.runHeight?.mode !== 'fixed';
    const pathBudget = budget / (parallel ? 2 : 1) - (stepWanted ? 2 : 0);
    if (pathBudget < map.cellSize * 4) continue;
    const selected: Side[] = [];
    let left = pathBudget;
    for (let n = 0; n < Math.min(3, boundary.sides.length - (boundary.closed ? 1 : 0)); n++) {
      const nextIndex = (index + n) % boundary.sides.length; if (!boundary.closed && nextIndex < index) break;
      const original = boundary.sides[nextIndex], reserve = n === 0 ? Math.min(boundary.sides[(nextIndex + 1) % boundary.sides.length].length, Math.max(map.cellSize * 2, pathBudget * .4)) : 0;
      const distance = Math.min(original.length, left - reserve); if (distance < map.cellSize * 2) break;
      const start = n === 0 ? sub(original.end, mul(original.t, distance)) : original.start, end = n === 0 ? original.end : add(original.start, mul(original.t, distance));
      selected.push({ ...original, start, end, length: distance }); left -= distance;
      if (distance < original.length && n > 0 || left < map.cellSize * 2) break;
    }
    if (selected.length < 2 || selected.some((s, i) => i > 0 && !near(selected[i - 1].end, s.start))) continue;
    const sign = hash(`${seed}-${prefix}-rise`) % 2 ? 1 : -1, first = selected[0], policy = config.runHeight;
    const height = policy?.mode === 'fixed' ? policy.reference === 'floor' ? first.low + policy.min : first.high - policy.min : policy?.mode === 'random' ? policy.reference === 'floor' ? first.low + policy.min + (policy.max - policy.min) * (sign > 0 ? .1 : .7) : first.high - policy.max + (policy.max - policy.min) * (sign > 0 ? .1 : .7) : policy?.mode === 'auto' ? first.low + (first.high - first.low) * (sign > 0 ? .22 : .72) : heightAt(available.find(b => b.wallMount!.kind === 'straight')!.wallMount!, first.low, first.high);
    const family = available.map(b => ({ ...b, wallMount: { ...b.wallMount!, heightMode: 'floor' as const, height: height - first.low } }));
    const bases = buildBoundaryRuns(map, { sides: selected, closed: false }, family, 100, ctx, prefix, []);
    let base = bases.sort((a, b) => routeLength(b) - routeLength(a))[0];
    if (!base || !base.some(f => f.wall!.site === 'corner') || !routeFits(map, base, selected, family, ctx, config)) continue;
    const order = orderedRoute(base, selected[0]);
    const equipment = order.map((fixture, position) => ({ position, distance: Math.min(Infinity, ...(map.propInstances ?? []).map(p => Math.hypot(point(map, p).x - fixture.wall!.position.x, point(map, p).z - fixture.wall!.position.z))) })).filter(c => c.position > 2 && c.position < order.length - 3).sort((a, b) => a.distance - b.distance);
    const cornerIndex = order.findIndex(f => f.wall!.site === 'corner');
    const preferred = Math.max(3, equipment[0]?.distance <= map.cellSize * 2.5 ? equipment[0].position : cornerIndex > 4 ? cornerIndex - 2 : Math.round(order.length * .4));
    let stepped = stepWanted ? stepBoundaryRun(map, base, selected, family, config, ctx, prefix, sign, preferred) : undefined;
    if (stepWanted && !stepped && policy?.mode === 'auto') for (const fraction of sign > 0 ? [.06, .25, .5] : [.94, .72, .5]) {
      const shifted = movedRoute(base, first.low + (first.high - first.low) * fraction - height);
      if (!routeFits(map, shifted, selected, family, ctx, config)) continue;
      const candidate = stepBoundaryRun(map, shifted, selected, family, config, ctx, prefix, sign, preferred);
      if (candidate) { base = shifted; stepped = candidate; break; }
    }
    const main = stepped?.group ?? base; if (routeLength(main) > budget + EPS) continue;
    main.forEach(f => { f.wall!.runId = `${prefix}-0`; }); const groups = [main];
    if (parallel) {
      const straight = main.filter(f => fixtureBinding(f, ctx.bindings)?.wallMount?.kind === 'straight' && f.wall!.sockets.every(s => Math.abs(s.direction.y) < EPS));
      const spacing = Math.max(.15, ...straight.flatMap(f => f.wall!.bounds.map(box => box.size.y))) + .15;
      for (const dy of [spacing, -spacing]) {
        const copyBase = movedRoute(base, dy, '-parallel'), work = { ...map, fixtures: [...(map.fixtures ?? []), ...main] };
        // Stagger by one measured straight at a shared transition, keeping parallel arms from crossing.
        const copyStepped = stepped ? stepBoundaryRun(work, copyBase, selected, family, config, ctx, `${prefix}-parallel`, sign, stepped.index - sign) : undefined;
        const copy = stepped ? copyStepped?.group : copyBase;
        if (!copy || routeLength(main) + routeLength(copy) > budget + EPS || !routeFits(work, copy, selected, family, ctx, config)) continue;
        copy.forEach(f => { f.wall!.runId = `${prefix}-1`; }); groups.push(copy); break;
      }
    }
    return groups;
  }
  return [];
}

function placeComposedRuns(map: GridMap, activeFaces: Face[], catalog: AssetBinding[], ctx: Context, config: WallMountSettings, seed: number, region: GenerationRegion | undefined, issues: ValidationIssue[]): MapFixture[][] {
  const wallBoundaries = boundaries(activeFaces), sides = wallBoundaries.flatMap(boundary => boundary.sides), groups: MapFixture[][] = [];
  const families = [...new Set(catalog.filter(b => b.wallMount!.kind !== 'single').map(b => b.wallMount!.family))].sort();
  const existing = (map.fixtures ?? []).filter(f => f.wall?.runId && eligible(map, f, region));
  // Density is actual assembled length. A small amount of wall always remains undecorated.
  const target = activeFaces.length * map.cellSize * Math.min(.86, config.runDensity / 100);
  let remaining = Math.max(0, target - routeLength(existing));
  const separateRisers = config.runOrientation === 'both' && config.connectRuns === false;
  const riserReserve = separateRisers ? target * .22 : 0;
  for (const boundary of wallBoundaries.sort((a, b) => b.sides.reduce((sum, s) => sum + s.length, 0) - a.sides.reduce((sum, s) => sum + s.length, 0))) {
    const work = { ...map, fixtures: [...(map.fixtures ?? []), ...groups.flat()] };
    const planned = composedBoundaryRuns(work, boundary, catalog, config, ctx, Math.max(0, remaining - riserReserve), seed);
    if (planned.flat().some(f => !eligible(map, f, region)) || work.fixtures.length + planned.flat().length > LIMIT) continue;
    groups.push(...planned); remaining -= routeLength(planned.flat());
  }
  const priority = (side: Side) => {
    const closest = Math.min(Infinity, ...(map.propInstances ?? []).map(p => length(sub(point(map, p), side.faces[Math.floor(side.faces.length / 2)].center))));
    return side.length + (Number.isFinite(closest) ? map.cellSize * 2 / (1 + closest / map.cellSize) : 0);
  };
  sides.sort((a, b) => priority(b) - priority(a) || hash(`${seed}-${fk(a.faces[0].support)}`) - hash(`${seed}-${fk(b.faces[0].support)}`));
  const familyChoices = (side: Side, riser = false) => {
    const key = side.faces.map(f => fk(f.support)).join('|'), first = hash(`${seed}-${key}-family`) % families.length;
    return families.map((_, offset) => {
      const familyName = families[(first + offset) % families.length], prefix = `wm-run-${hash(`${seed}-composed${riser ? '-riser' : ''}-${familyName}-${key}`).toString(36)}`;
      return { prefix, runId: `${prefix}-0`, family: catalog.filter(b => b.wallMount!.family === familyName && b.wallMount!.kind !== 'single' && (b.prop?.weight ?? 1) > 0 && hash(`${seed}-${key}-prob-${b.id}`) % 10000 < b.wallMount!.probability * 100) };
    });
  };
  for (const side of sides) {
    if (remaining <= EPS || !families.length) break;
    const choices = familyChoices(side);
    // A completed fallback is the stable choice on subsequent additive calls.
    if (choices.some(choice => (map.fixtures ?? []).some(f => f.wall?.runId === choice.runId))) continue;
    const work = { ...map, fixtures: [...(map.fixtures ?? []), ...groups.flat()] };
    let selected: { group: MapFixture[]; runId: string } | undefined, plainFallback: typeof selected;
    for (const { family, prefix, runId } of choices) {
      let group: MapFixture[] | undefined;
      if (config.runOrientation === 'vertical') {
        // One intentional riser per long wall section, not one per grid cell.
        const ordered = [...side.faces].sort((a, b) => Math.abs(dot(sub(a.center, side.start), side.t) - side.length / 2) - Math.abs(dot(sub(b.center, side.start), side.t) - side.length / 2));
        for (const face of ordered) { const candidate = buildVerticalRun(work, face, family, ctx, prefix, config.verticalRange); if (candidate && routeLength(candidate) <= remaining + EPS) { group = candidate; break; } }
      } else group = composedSideRun(work, side, family, config, ctx, prefix, Math.max(0, remaining - riserReserve), seed);
      if (!group || group.some(f => !eligible(map, f, region)) || work.fixtures.length + group.length > LIMIT) continue;
      if (config.runOrientation === 'both' && config.connectRuns !== false && config.runHeight?.mode !== 'fixed' && !group.some(f => f.wall!.sockets.some(s => Math.abs(s.direction.y) > 1 - EPS))) { plainFallback ??= { group, runId }; continue; }
      selected = { group, runId }; break;
    }
    selected ??= plainFallback; if (!selected) continue;
    const { group, runId } = selected;
    group.forEach(f => { f.wall!.runId = runId; }); groups.push(group); remaining -= routeLength(group);
  }
  if (separateRisers) for (const side of sides) {
    if (remaining <= EPS || !families.length) break;
    const choices = familyChoices(side, true);
    if (choices.some(choice => (map.fixtures ?? []).some(f => f.wall?.runId === choice.runId))) continue;
    riserFamily: for (const { family, prefix, runId } of choices) for (const face of side.faces) {
      const work = { ...map, fixtures: [...(map.fixtures ?? []), ...groups.flat()] }, group = buildVerticalRun(work, face, family, ctx, prefix, config.verticalRange);
      if (!group || routeLength(group) > remaining + EPS || group.some(f => !eligible(map, f, region)) || work.fixtures.length + group.length > LIMIT) continue;
      group.forEach(f => { f.wall!.runId = runId; }); groups.push(group); remaining -= routeLength(group); break riserFamily;
    }
  }
  // A short service drop only belongs near actual equipment; there is no per-wall branch quota.
  if (config.runOrientation === 'both' && config.connectRuns !== false && (map.propInstances?.length ?? 0) > 0 && remaining > EPS) for (let index = 0; index < groups.length; index++) {
    const group = groups[index], work = { ...map, fixtures: [...(map.fixtures ?? []), ...groups.flat()] };
    const equipmentDistance = (fixture: MapFixture) => Math.min(...map.propInstances!.map(p => Math.hypot(point(map, p).x - fixture.wall!.position.x, point(map, p).z - fixture.wall!.position.z)));
    const candidates = group.filter(f => fixtureBinding(f, ctx.bindings)?.wallMount?.kind === 'straight' && f.wall!.sockets.every(s => Math.abs(s.direction.y) < EPS) && equipmentDistance(f) <= map.cellSize * 2.5).sort((a, b) => equipmentDistance(a) - equipmentDistance(b) || a.id.localeCompare(b.id));
    for (const targetFixture of candidates) {
      const familyName = fixtureBinding(targetFixture, ctx.bindings)!.wallMount!.family, family = catalog.filter(b => b.wallMount!.family === familyName && (b.prop?.weight ?? 1) > 0);
      const addition = connectAt(work, targetFixture, targetFixture.wall!.sockets, [targetFixture], family, family.filter(b => b.wallMount!.kind === 'tee' && hash(`${seed}-composed-branch-${targetFixture.id}-${b.id}`) % 10000 < b.wallMount!.probability * 100), ctx, activeFaces, region, config.verticalRange);
      if (!addition) continue;
      const changed = [...group.filter(f => !addition.removeIds.has(f.id)), ...addition.fixtures], extra = routeLength(changed) - routeLength(group);
      if (extra > remaining + EPS || work.fixtures.length - addition.removeIds.size + addition.fixtures.length > LIMIT) continue;
      groups[index] = changed; remaining -= Math.max(0, extra); break;
    }
  }
  const all = [...existing, ...groups.flat()];
  if (config.runOrientation === 'both' && config.connectRuns !== false && config.runHeight?.mode !== 'fixed' && groups.length && !all.some(f => f.wall!.sockets.some(s => Math.abs(s.direction.y) > 1 - EPS))) issues.push(warning('높이 전환에 맞는 같은 세트의 엘보·세로 직선·높이 여유가 없어 완성 가능한 수평 경로를 끝마감했습니다.', 'wall-composition-height-fit'));
  if (remaining > map.cellSize) issues.push(warning('벽면 여백과 긴 경로를 유지하고, 부품 길이·높이·겹침 조건을 만족하는 구간만 배치했습니다.', 'wall-composition-fit'));
  return groups;
}

export interface WallPlacementResult { map: GridMap; issues: ValidationIssue[]; addedSingles: number; addedModules: number; runCount: number; unchanged: boolean }
export function placeWallMounts(source: GridMap, settings: WallMountSettings | GenerationSettings, bindings: AssetBinding[], region?: GenerationRegion): WallPlacementResult {
  const { config, generation } = settingsFor(settings), map = structuredClone(source), issues: ValidationIssue[] = [];
  const result: WallPlacementResult = { map, issues, addedSingles: 0, addedModules: 0, runCount: 0, unchanged: true };
  if (!config.enabled) return result;
  if (region && (![region.x, region.row, region.width, region.height].every(Number.isInteger) || region.width < 1 || region.height < 1 || region.x < 0 || region.row < 0 || region.x + region.width > map.width || region.row + region.height > map.height)) throw new Error('벽 부착물 배치 영역을 확인해 주세요.');
  const configured = bindings.filter(b => b.wallMount && ROLES.includes(b.role as FixtureRole));
  const catalog = configured.filter(b => b.bounds || b.prop?.size || b.wallMount!.collisionBoxes.length).sort((a, b) => a.id.localeCompare(b.id));
  const placeholders = new Map<string, WallPlaceholderKind>(), usedBindingIds = new Set([...bindings.map(b => b.id), ...(map.fixtures ?? []).flatMap(f => f.bindingId ? [f.bindingId] : [])]);
  if (configured.length !== catalog.length) issues.push(warning('크기가 측정되지 않은 벽 부착물은 배치하지 않았습니다. Unity 크기 파일을 가져오거나 충돌 상자를 지정해 주세요.', 'wall-unmeasured'));
  if (config.placeholderFallback !== false) {
    if (config.singles && !configured.some(b => b.wallMount!.kind === 'single')) catalog.push(...WALL_PLACEHOLDER_KINDS.filter(k => !k.startsWith('pipe')).map(k => planningPlaceholder(k, usedBindingIds, placeholders)));
    if (config.runs && !configured.some(b => b.wallMount!.kind !== 'single')) catalog.push(...WALL_PLACEHOLDER_KINDS.filter(k => k.startsWith('pipe')).map(k => planningPlaceholder(k, usedBindingIds, placeholders)));
  }
  if (!catalog.length) { issues.push(warning('벽 부착물로 등록된 프리팹이 없습니다.', 'wall-catalog')); return result; }
  catalog.forEach(b => parseWallMountDefinition(b.wallMount));
  map.fixtures ??= [];
  const effectiveBindings = [...bindings, ...catalog], ctx = context(map, effectiveBindings, generation), faces = facesFor(map, bindings), locked = new Set((map.lockedCells ?? []).map(ck));
  const activeFaces = faces.filter(f => !locked.has(ck(f.support)) && !locked.has(ck(f.cell)) && inside(f.support, region) && inside(f.cell, region));
  const existingIds = new Set(map.fixtures.map(f => f.id)), seed = generation?.seed ?? 0;
  const addFixture = (f: MapFixture) => { map.fixtures!.push(f); existingIds.add(f.id); result.unchanged = false; };
  if (config.runs && config.runDensity > 0 && config.runLayout === 'composed') {
    for (const group of placeComposedRuns(map, activeFaces, catalog, ctx, config, seed, region, issues)) {
      if (group.some(f => existingIds.has(f.id))) continue;
      group.forEach(addFixture); result.addedModules += group.length; result.runCount++;
    }
  }
  if (config.runs && config.runDensity > 0 && config.runLayout !== 'composed' && config.runOrientation !== 'vertical') {
    const families = [...new Set(catalog.filter(b => b.wallMount!.kind !== 'single').map(b => b.wallMount!.family))];
    for (const [bi, boundary] of boundaries(activeFaces).entries()) {
      if (!families.length) break;
      const familyName = families[hash(`${seed}-boundary-${bi}`) % families.length], family = runHeightFamily(catalog.filter(b => b.wallMount!.family === familyName && b.wallMount!.kind !== 'single' && (b.prop?.weight ?? 1) > 0 && hash(`${seed}-run-prob-${bi}-${b.id}`) % 10000 < b.wallMount!.probability * 100), config, seed, `${familyName}-${boundary.sides.map(s => fk(s.faces[0].support)).join('|')}`);
      const prefix = `wm-run-${hash(`${seed}-${familyName}-${boundary.sides.map(s => fk(s.faces[0].support)).join('|')}`).toString(36)}`;
      for (const [gi, group] of buildBoundaryRuns(map, boundary, family, config.runDensity, ctx, prefix, issues).entries()) {
        const runId = `${prefix}-${gi}`;
        if (map.fixtures.some(f => f.wall?.runId === runId) || group.some(f => existingIds.has(f.id))) continue;
        group.forEach(f => { f.wall!.runId = runId; });
        if (map.fixtures.length + group.length > LIMIT || group.some(f => !eligible(map, f, region) || fitIssue(map, f, ctx, [...map.fixtures!, ...group]))) continue;
        group.forEach(addFixture); result.addedModules += group.length; result.runCount++;
      }
    }
  }
  if (config.runs && config.runDensity > 0 && config.runLayout !== 'composed' && config.runOrientation === 'both' && config.connectRuns !== false) {
    const connected = connectRuns(map, catalog, effectiveBindings, activeFaces, config, ctx, seed, region, issues);
    if (connected.changed) { result.addedModules = Math.max(0, result.addedModules + connected.added - connected.removed); result.unchanged = false; }
  }
  if (config.runs && config.runDensity > 0 && config.runLayout !== 'composed' && ['vertical', 'both'].includes(config.runOrientation ?? 'horizontal')) {
    const families = [...new Set(catalog.filter(b => b.wallMount!.kind !== 'single').map(b => b.wallMount!.family))];
    const desired = Math.ceil(activeFaces.length * config.runDensity / 100), occupied = new Set(map.fixtures.filter(f => f.wall?.runId && f.wall.sockets.some(s => Math.abs(s.direction.y) > 1 - EPS) && eligible(map, f, region)).flatMap(f => f.wall!.support.map(fk)));
    let count = occupied.size;
    for (const face of [...activeFaces].sort((a, b) => hash(`${seed}-vertical-${fk(a.support)}`) - hash(`${seed}-vertical-${fk(b.support)}`))) {
      if (count >= desired || !families.length) break;
      if (occupied.has(fk(face.support))) continue;
      const familyName = families[hash(`${seed}-vertical-family-${fk(face.support)}`) % families.length], family = catalog.filter(b => b.wallMount!.family === familyName && b.wallMount!.kind !== 'single' && (b.prop?.weight ?? 1) > 0 && hash(`${seed}-vertical-prob-${fk(face.support)}-${b.id}`) % 10000 < b.wallMount!.probability * 100);
      const prefix = `wm-vertical-${hash(`${seed}-${familyName}-${fk(face.support)}`).toString(36)}`;
      if (map.fixtures.some(f => f.wall?.runId === prefix)) continue;
      const group = buildVerticalRun(map, face, family, ctx, prefix, config.verticalRange); if (!group) continue;
      group.forEach(f => { f.wall!.runId = prefix; });
      if (map.fixtures.length + group.length > LIMIT || group.some(f => !eligible(map, f, region))) continue;
      group.forEach(addFixture); result.addedModules += group.length; result.runCount++; count++;
      occupied.add(fk(face.support));
    }
    if (families.length && count < desired) issues.push(warning('원본 직선·끝마감의 길이·부착점·벽 높이·설정한 높이 범위·겹침 조건을 만족하는 위치에만 세로 배관을 배치했습니다.', 'wall-vertical-fit'));
  }
  if (config.singles && config.density > 0) {
    const singles = catalog.filter(b => b.wallMount!.kind === 'single'), candidates: MapFixture[] = [];
    for (const b of singles) {
      candidates.push(...doorCandidates(map, b, activeFaces));
      for (const face of activeFaces) for (const site of b.wallMount!.sites.filter(s => ['wall', 'upper', 'lower'].includes(s))) candidates.push(singleOnFace(map, b, face, site, `wm-${site}-${face.support.x}-${face.support.row}-${face.support.direction}-${b.id}`, undefined, faces));
      if (b.wallMount!.sites.includes('corner')) for (const boundary of boundaries(activeFaces)) for (let i = 0; i < boundary.sides.length; i++) {
        const a = boundary.sides[i], next = boundary.sides[(i + 1) % boundary.sides.length]; if (!boundary.closed && i === boundary.sides.length - 1 || !near(a.end, next.start)) continue;
        const f = singleCorner(map, b, a, next, `wm-corner-${hash(`${fk(a.faces[0].support)}-${b.id}`).toString(36)}`);
        if (f) candidates.push(f); else issues.push(warning('모서리 부착물은 양쪽 벽에 맞는 부착점 두 개가 필요합니다. Unity에서 부착점을 지정해 주세요.', 'wall-corner-mounts'));
      }
    }
    const occupiedLength = (f: MapFixture) => { const t = tangent(normal(f.wall!.support[0].direction)), intervals = f.wall!.bounds.map(b => { const center = dot(b.center, t), half = (Math.abs(t.x) * b.size.x + Math.abs(t.z) * b.size.z) / 2; return [center - half, center + half]; }); return Math.max(...intervals.map(i => i[1])) - Math.min(...intervals.map(i => i[0])); };
    const normalBudget = activeFaces.length * map.cellSize * config.density / 100, normalExisting = map.fixtures.filter(f => f.wall && !f.wall.runId && !f.wall.doorId && eligible(map, f, region)).reduce((n, f) => n + occupiedLength(f), 0);
    let count = normalExisting;
    const priority = (f: MapFixture) => -Math.log((hash(`${seed}-${f.id}`) + 1) / 4294967297) / Math.max(.00001, singles.find(b => b.id === f.bindingId)?.prop?.weight ?? 1);
    for (const f of candidates.sort((a, b) => priority(a) - priority(b))) {
      const b = singles.find(b => b.id === f.bindingId)!, def = b.wallMount!;
      if (existingIds.has(f.id) || map.fixtures.length >= LIMIT || !eligible(map, f, region) || (b.prop?.weight ?? 1) === 0 || hash(`${seed}-prob-${f.id}`) % 10000 >= def.probability * 100) continue;
      if (!f.wall!.doorId && count >= normalBudget - EPS) continue;
      if (map.fixtures.some(g => g.wall && !g.wall.runId && (f.wall!.doorId ? g.wall.doorId === f.wall!.doorId && g.wall.site === f.wall!.site && g.wall.doorSide === f.wall!.doorSide : !g.wall.doorId && length(sub(g.wall.position, f.wall!.position)) < Math.max(def.spacing, fixtureBinding(g, bindings)?.wallMount?.spacing ?? 0) - EPS))) continue;
      if (fitIssue(map, f, ctx)) continue;
      addFixture(f); result.addedSingles++; if (!f.wall!.doorId) count += occupiedLength(f);
    }
    if (normalBudget > EPS && count < normalBudget - EPS && singles.some(b => b.wallMount!.sites.some(s => !['doorTop', 'doorSide'].includes(s)))) issues.push(warning(`간격·크기·겹침 조건으로 개별 벽 장식 목표 길이의 ${Math.round(count / normalBudget * 100)}%를 배치했습니다.`, 'wall-density'));
  }
  if (!result.unchanged) map.version = 5;
  const unique = [...new Map(issues.map(i => [`${i.code}:${i.message}`, i])).values()]; issues.splice(0, issues.length, ...unique);
  if (!result.addedSingles && config.singles && !map.fixtures.some(f => f.wall && !f.wall.runId) && catalog.some(b => b.wallMount!.kind === 'single')) issues.push(warning('설치 높이·벽면 크기·문 마감·통행 여유를 만족하는 개별 부착물 위치가 없습니다.', 'wall-single-fit'));
  if (config.runs && config.runHeight && config.runOrientation !== 'vertical' && !result.addedModules && !map.fixtures.some(f => f.wall?.runId && f.wall.sockets.some(s => Math.abs(s.direction.y) < EPS))) issues.push(warning('설정한 가로 배관 높이에서 부품 크기·벽면·끝마감·겹침 조건을 만족하는 구간이 없습니다.', 'wall-run-height-fit'));
  map.fixtures.forEach(f => savePlaceholder(f, placeholders));
  return result;
}

export interface WallRunReapplyResult {
  map: GridMap;
  issues: ValidationIssue[];
  regeneratedRuns: number;
  preservedRuns: number;
  skippedRuns: number;
  unchanged: boolean;
  reason?: 'no-eligible-runs' | 'no-valid-runs' | 'validation-failed';
}

/** Rebuild generated assemblies on a detached map; the caller commits the result once for undo. */
export function reapplyWallRuns(source: GridMap, settings: WallMountSettings | GenerationSettings, bindings: AssetBinding[]): WallRunReapplyResult {
  const groups = new Map<string, MapFixture[]>();
  for (const fixture of source.fixtures ?? []) if (fixture.wall?.runId) groups.set(fixture.wall.runId, [...(groups.get(fixture.wall.runId) ?? []), fixture]);
  const referenced = new Set((source.fixtures ?? []).flatMap(fixture => fixture.linkedId ? [fixture.linkedId] : []));
  const generated = (runId: string) => /^wm-run-[0-9a-z]+-\d+$/.test(runId) || /^wm-vertical-[0-9a-z]+$/.test(runId);
  const editable = new Set([...groups].filter(([runId, group]) => generated(runId) && group.every(fixture => !fixture.wall!.authored && eligible(source, fixture) && !fixture.linkedId && !referenced.has(fixture.id) && fixtureBinding(fixture, bindings)?.wallMount?.kind !== 'single' && !!fixtureBinding(fixture, bindings)?.wallMount)).map(([runId]) => runId));
  const unchanged = (reason: WallRunReapplyResult['reason'], issues: ValidationIssue[] = []): WallRunReapplyResult => ({ map: structuredClone(source), issues, regeneratedRuns: 0, preservedRuns: groups.size, skippedRuns: editable.size, unchanged: true, reason });
  if (!editable.size) return unchanged('no-eligible-runs', [warning('재배치할 자동 배관 구간이 없습니다. 수동 수정·복사·잠금·연결 참조가 있는 구간은 유지합니다.', 'wall-run-reapply-protected')]);
  const retained = (source.fixtures ?? []).filter(fixture => !fixture.wall?.runId || !editable.has(fixture.wall.runId));
  const retainedById = new Map(retained.map(fixture => [fixture.id, fixture]));
  const work = structuredClone(source);
  work.fixtures = structuredClone(retained);
  // Prevent junction assembly from editing preserved generated, copied or linked runs.
  for (const fixture of work.fixtures) if (fixture.wall?.runId) fixture.wall.authored = true;
  const { config, generation } = settingsFor(settings), runs = { ...config, enabled: true, singles: false, runs: true };
  let planned: WallPlacementResult;
  try { planned = placeWallMounts(work, generation ? { ...generation, designer: { ...generation.designer!, wallMounts: runs } } : runs, bindings); }
  catch (error) { return unchanged('validation-failed', [warning(`배관 재배치를 취소하고 기존 맵을 유지했습니다. ${error instanceof Error ? error.message : String(error)}`, 'wall-run-reapply')]); }
  const additions = (planned.map.fixtures ?? []).filter(fixture => !retainedById.has(fixture.id) && fixture.wall?.runId);
  if (!additions.length) return unchanged('no-valid-runs', [...planned.issues, warning('새 높이에서 유효한 배관 구간을 완성할 수 없어 기존 배치를 유지했습니다.', 'wall-run-reapply-empty')]);
  planned.map.fixtures = planned.map.fixtures!.map(fixture => structuredClone(retainedById.get(fixture.id) ?? fixture));
  const errors = wallMountIssues(planned.map, bindings).filter(issue => issue.severity === 'error');
  const finalIds = new Set(planned.map.fixtures.map(fixture => fixture.id));
  if (planned.map.fixtures.some(fixture => fixture.linkedId && !finalIds.has(fixture.linkedId))) errors.push({ severity: 'error', code: 'wall-run-reapply-link', message: '배관 재배치 후 연결 대상이 사라집니다.' });
  if (errors.length) return unchanged('validation-failed', [...planned.issues, ...errors]);
  const addedRuns = new Set(additions.map(fixture => fixture.wall!.runId!)), regeneratedFaces = new Set(additions.flatMap(fixture => fixture.wall!.support.map(fk)));
  const originalById = new Map((source.fixtures ?? []).map(fixture => [fixture.id, fixture]));
  const same = planned.map.fixtures.length === originalById.size && planned.map.fixtures.every(fixture => JSON.stringify(fixture) === JSON.stringify(originalById.get(fixture.id)));
  const skippedRuns = [...editable].filter(runId => !groups.get(runId)!.some(fixture => fixture.wall!.support.some(face => regeneratedFaces.has(fk(face))))).length;
  if (skippedRuns) planned.issues.push(warning(`기존 자동 배관 ${skippedRuns}개 구간의 지지 벽에는 새 조건에 맞는 배관을 배치하지 못했습니다.`, 'wall-run-reapply-skipped'));
  return { map: same ? structuredClone(source) : planned.map, issues: planned.issues, regeneratedRuns: addedRuns.size, preservedRuns: groups.size - editable.size, skippedRuns, unchanged: same };
}

export function wallMountIssues(map: GridMap, bindings?: AssetBinding[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [], ctx = context(map, bindings ?? []), mounted = (map.fixtures ?? []).filter(f => f.wall);
  for (const f of mounted) {
    const b = fixtureBinding(f, bindings ?? []), reason = fitIssue(map, f, ctx);
    if ((bindings || f.wall!.placeholder) && (!b?.wallMount || b.role !== f.role || !(b.bounds || b.prop?.size || b.wallMount.collisionBoxes.length) || f.wall!.placeholder && (f.bindingId !== undefined || f.wall!.bindingReference !== undefined || !b.wallMount.sites.includes(f.wall!.site) && !(f.wall!.site === 'corner' && b.wallMount.kind !== 'single')))) issues.push({ severity: 'error', code: 'wall-binding', message: `벽 부착물 ${f.id}의 프리팹·측정값 또는 설치 설정이 없습니다.`, cells: wallMountDependencies(f) });
    if (reason) issues.push({ severity: 'error', code: 'wall-fit', message: `벽 부착물 ${f.id}: ${reason}.`, cells: wallMountDependencies(f) });
    if (b?.wallMount) {
      const reference = f.wall!.bindingReference;
      if (reference && (!near(reference.scale, b.scale) || Math.abs(reference.rotationY - b.rotationY) > EPS || reference.offset && !near(reference.offset, b.offset) || reference.prefabGuid !== undefined && reference.prefabGuid !== b.prefabGuid || reference.prefabPath !== undefined && reference.prefabPath !== b.prefabPath)) issues.push({ severity: 'error', code: 'wall-measurement', message: `벽 부착물 ${f.id}의 원본 프리팹·보정·배율·회전이 변경되었습니다. 다시 배치해 주세요.`, cells: wallMountDependencies(f) });
      const rotationZ = f.wall!.rotationZ ?? 0;
      if (isJunction(b.wallMount.kind) ? !DIRS.includes(((rotationZ % 360 + 360) % 360) as Direction) || f.wall!.site !== 'wall' || f.wall!.rotationY % 90 !== 0 : rotationZ % 360 !== 0 && (!['straight', 'endCap'].includes(b.wallMount.kind) || ![90, 270].includes((rotationZ % 360 + 360) % 360) || f.wall!.site !== 'wall' || f.wall!.sockets.some(s => Math.abs(s.direction.y) < 1 - EPS))) issues.push({ severity: 'error', code: 'wall-rotation', message: `벽 부착물 ${f.id}의 배관 종류·회전·연결점이 맞지 않습니다.`, cells: wallMountDependencies(f) });
      const bounds = worldBounds(b, f.wall!.position, f.wall!.rotationY, rotationZ), sockets = worldSockets(b, f.wall!.position, f.wall!.rotationY, rotationZ);
      if (JSON.stringify(bounds.map(v => [v.center, v.size])) !== JSON.stringify(f.wall!.bounds.map(v => [v.center, v.size])) && (bounds.length !== f.wall!.bounds.length || bounds.some((v, i) => !near(v.center, f.wall!.bounds[i].center) || !near(v.size, f.wall!.bounds[i].size))) || sockets.length !== f.wall!.sockets.length || sockets.some((v, i) => !near(v.position, f.wall!.sockets[i].position) || !near(v.direction, f.wall!.sockets[i].direction))) issues.push({ severity: 'error', code: 'wall-measurement', message: `벽 부착물 ${f.id}의 측정값·크기·연결점이 변경되었습니다. 다시 배치해 주세요.`, cells: wallMountDependencies(f) });
    }
    if (f.wall!.doorId && !map.connections.some(d => d.id === f.wall!.doorId)) issues.push({ severity: 'error', code: 'wall-door', message: `벽 부착물 ${f.id}의 기준 문이 없습니다.`, cells: wallMountDependencies(f) });
  }
  for (const runId of new Set(mounted.flatMap(f => f.wall!.runId ? [f.wall!.runId] : []))) {
    const group = mounted.filter(f => f.wall!.runId === runId);
    if (unmatched(group).length || components(group).length !== 1) issues.push({ severity: 'error', code: 'wall-run-open', message: `연속 장식 ${runId}의 연결점 또는 끝마감이 맞지 않습니다.`, cells: group.flatMap(wallMountDependencies) });
  }
  const aliases = mounted.filter(f => f.wall!.sockets.some(s => mounted.reduce((n, g) => n + (g === f ? 0 : g.wall!.sockets.filter(t => socketJoin(s, t)).length), 0) > 1));
  if (aliases.length) issues.push({ severity: 'error', code: 'wall-run-alias', message: '벽 배관의 한 연결점에 여러 부품이 겹쳐 연결되어 있습니다.', cells: aliases.flatMap(wallMountDependencies) });
  return issues;
}

function translated(f: MapFixture, delta: Vec3): MapFixture { const out = structuredClone(f), w = out.wall!; w.position = add(w.position, delta); w.bounds = w.bounds.map(b => ({ center: add(b.center, delta), size: b.size })); w.sockets = w.sockets.map(s => ({ position: add(s.position, delta), direction: s.direction })); w.authored = true; return out; }
function recap(map: GridMap, fixtures: MapFixture[], bindings: AssetBinding[], runId: string): MapFixture[] {
  let group = fixtures.filter(f => f.wall?.runId === runId);
  const hasPlaceholders = group.some(f => f.wall?.placeholder);
  const placeholders = new Map<string, WallPlaceholderKind>(), placeholderCap = hasPlaceholders ? planningPlaceholder('pipeEndCap', new Set([...bindings.map(b => b.id), ...fixtures.flatMap(f => f.bindingId ? [f.bindingId] : [])]), placeholders) : undefined;
  const capBindings = placeholderCap ? [...bindings, placeholderCap] : bindings;
  // A cap left alone after its neighboring module was removed has no useful segment to close.
  const isolated = group.filter(f => fixtureBinding(f, bindings)?.wallMount?.kind === 'endCap' && !group.some(g => g !== f && f.wall!.sockets.some(s => g.wall!.sockets.some(t => socketJoin(s, t)))));
  fixtures = fixtures.filter(f => !isolated.includes(f)); group = group.filter(f => !isolated.includes(f));
  const faces = facesFor(map, bindings), ctx = context({ ...map, fixtures }, bindings);
  for (const { fixture, socket } of unmatched(group)) {
    const family = fixtureBinding(fixture, bindings)?.wallMount?.family;
    const support = fixture.wall!.support.map(s => faces.find(f => fk(f.support) === fk(s))).filter((v): v is Face => !!v), face = support.find(f => Math.abs(dot(f.n, socket.direction)) < EPS) ?? support[0];
    if (!face) throw new Error('연결 구간을 끝마감할 지지 벽이 없습니다.');
    const side: Side = { faces: faces.filter(f => near(f.n, face.n) && Math.abs(dot(sub(f.center, face.center), face.n)) < EPS && f.low === face.low && f.high === face.high), start: face.start, end: face.end, n: face.n, t: face.t, low: face.low, high: face.high, length: map.cellSize };
    let cap: MapFixture | undefined;
    for (const b of capBindings.filter(b => b.wallMount?.kind === 'endCap' && (b.wallMount.family === family || b === placeholderCap))) for (const p of oriented(b, side, socket.direction)) {
      const f = moduleAt(map, p, socket.position, side, `wm-cap-${hash(`${runId}-${fixture.id}-${pk(socket.position)}`).toString(36)}`); f.wall!.runId = runId; f.wall!.authored = true;
      if (!fitIssue(map, f, ctx, fixtures)) { cap = f; break; }
    }
    if (!cap) throw new Error('분리·삭제 후 연결점을 닫을 끝마감 프리팹이 없습니다. 기존 구간을 유지했습니다.');
    fixtures.push(cap); group.push(cap);
  }
  for (const [i, component] of components(group).entries()) for (const f of component) { f.wall!.runId = `${runId.replace(/-edit-\d+$/, '')}-edit-${i}`.slice(0, 80); f.wall!.authored = true; }
  fixtures.forEach(f => savePlaceholder(f, placeholders));
  return fixtures;
}
export function editWallMount(source: GridMap, fixtureId: string, patch: { height?: number; along?: number; distance?: number; bindingId?: string; detach?: boolean; remove?: boolean }, bindings: AssetBinding[]): GridMap {
  const map = structuredClone(source), target = map.fixtures?.find(f => f.id === fixtureId && f.wall);
  if (!target) throw new Error('수정할 벽 부착물을 선택해 주세요.');
  if ([patch.height, patch.along, patch.distance].some(v => v !== undefined && (!finite(v) || Math.abs(v) > 1000))) throw new Error('이동 거리는 유한한 미터 값이어야 합니다.');
  const runId = target.wall!.runId, originalGroup = runId ? map.fixtures!.filter(f => f.wall?.runId === runId) : [target];
  if (originalGroup.some(f => protectedFixture(map, f))) throw new Error('잠긴 셀에 연결된 벽 부착물은 수정할 수 없습니다.');
  if (patch.remove || patch.detach) {
    map.fixtures = map.fixtures!.filter(f => f !== target);
    if (runId) map.fixtures = recap(map, map.fixtures, bindings, runId);
    if (patch.remove) { if (map.fixtures.some(f => f.linkedId === target.id)) throw new Error('다른 시설이 참조하는 벽 부착물은 삭제할 수 없습니다.'); return map; }
    delete target.wall!.runId; target.wall!.authored = true; map.fixtures.push(target);
  }
  const group = patch.detach || !runId ? [target] : map.fixtures!.filter(f => f.wall?.runId === runId), n = normal(target.wall!.support[0].direction), t = tangent(n);
  const delta = add({ x: 0, y: patch.height ?? 0, z: 0 }, add(mul(t, patch.along ?? 0), mul(n, patch.distance ?? 0)));
  map.fixtures = map.fixtures!.map(f => group.includes(f) ? translated(f, delta) : f);
  let changedTarget = map.fixtures.find(f => f.id === target.id)!;
  if (patch.bindingId && patch.bindingId !== target.bindingId) {
    const b = bindings.find(b => b.id === patch.bindingId && b.wallMount && ROLES.includes(b.role as FixtureRole)); if (!b) throw new Error('교체할 벽 부착물 프리팹이 없습니다.');
    const old = changedTarget.wall!, oldBinding = fixtureBinding(changedTarget, bindings), newKind = b.wallMount!.kind;
    if (!(b.bounds || b.prop?.size || b.wallMount!.collisionBoxes.length)) throw new Error('교체 프리팹의 크기를 측정하거나 충돌 상자를 지정해 주세요.');
    if (old.placeholder && (b.role !== changedTarget.role || !b.wallMount!.sites.includes(old.site) && !(old.site === 'corner' && ['innerCorner', 'outerCorner'].includes(newKind)))) throw new Error('같은 역할과 설치 위치를 지원하는 벽 프리팹으로 교체해 주세요.');
    if (runId && !patch.detach && (oldBinding?.wallMount?.kind !== newKind || !originalGroup.some(f => f.wall?.placeholder) && b.wallMount!.family !== oldBinding?.wallMount?.family || newKind === 'single' || b.wallMount!.sockets.length !== old.sockets.length)) throw new Error('연결 구간은 같은 종류의 호환 연결점 부품으로 교체해 주세요.');
    if (runId && !patch.detach && originalGroup.some(f => f.id !== target.id && !f.wall!.placeholder && fixtureBinding(f, bindings)?.wallMount?.family !== b.wallMount!.family)) throw new Error('같은 연결 구간의 실제 프리팹은 같은 세트(Family)로 교체해 주세요.');
    let p = old.position, yaw = old.rotationY, rotationZ = old.rotationZ ?? 0;
    if (runId && !patch.detach) {
      let match = false;
      const normalizedYaw = (old.rotationY % 360 + 360) % 360, candidateYaws = [old.rotationY, ...DIRS.filter(d => d !== normalizedYaw)];
      const candidateRolls = isJunction(newKind) ? [rotationZ, ...DIRS.filter(d => d !== (rotationZ % 360 + 360) % 360)] : rotationZ % 180 ? [rotationZ, (rotationZ + 180) % 360] : [0];
      search: for (const candidateYaw of candidateYaws) for (const candidateRoll of candidateRolls) for (const socket of b.wallMount!.sockets) {
        if (b.wallMount!.mounts.some(m => !old.support.some(s => near(normal(s.direction), norm(transformed(m.direction, b, candidateYaw, candidateRoll)))))) continue;
        const direction = norm(transformed(socket.direction, b, candidateYaw, candidateRoll)), oldSocket = old.sockets.find(s => near(s.direction, direction)); if (!oldSocket) continue;
        const position = sub(oldSocket.position, transformed(socket.position, b, candidateYaw, candidateRoll)), sockets = worldSockets(b, position, candidateYaw, candidateRoll);
        if (sockets.every(s => old.sockets.some(o => near(s.position, o.position) && near(s.direction, o.direction)))) { p = position; yaw = candidateYaw; rotationZ = candidateRoll; match = true; break search; }
      }
      if (!match) throw new Error('교체 프리팹의 연결점 위치와 방향이 기존 부품과 맞지 않습니다.');
    } else if (oldBinding?.wallMount?.mounts[0] && b.wallMount!.mounts[0]) {
      const previousMount = oldBinding.wallMount.mounts[0], nextMount = b.wallMount!.mounts[0], oldContact = add(old.position, transformed(previousMount.position, oldBinding, old.rotationY, rotationZ)), targetMount = old.placeholder ? oldContact : add(sub(oldContact, oldBinding.offset), b.offset);
      yaw = angle(norm(transformed(previousMount.direction, oldBinding, old.rotationY, rotationZ))) - angle(norm(roll(scaled(nextMount.direction, b), rotationZ))); p = sub(targetMount, transformed(nextMount.position, b, yaw, rotationZ));
    }
    const candidate = { ...changedTarget, bindingId: b.id, role: b.role as FixtureRole, wall: { ...old, position: p, rotationY: yaw, ...(rotationZ ? { rotationZ } : {}), bounds: worldBounds(b, p, yaw, rotationZ), sockets: worldSockets(b, p, yaw, rotationZ), authored: true, bindingReference: bindingReference(b) } };
    delete candidate.wall.placeholder;
    map.fixtures = map.fixtures.map(f => f.id === target.id ? candidate : f); changedTarget = candidate;
  }
  // Refresh cell support after moving along a continuous wall, while retaining deliberate distance offsets.
  const faces = facesFor(map, bindings);
  for (const f of map.fixtures.filter(f => f.id === changedTarget.id || group.some(g => g.id === f.id))) {
    if (f.wall!.doorId) continue;
    const support: WallFace[] = [];
    for (const direction of new Set(f.wall!.support.map(s => s.direction))) {
      const oldFace = faces.find(face => face.support.direction === direction && f.wall!.support.some(s => fk(s) === fk(face.support))), n = normal(direction);
      if (!oldFace) continue;
      const matching = faces.filter(face => face.support.direction === direction && Math.abs(dot(sub(face.center, oldFace.center), n)) < EPS);
      const side: Side = { faces: matching, start: oldFace.start, end: oldFace.end, n, t: tangent(n), low: oldFace.low, high: oldFace.high, length: matching.length * map.cellSize };
      support.push(...touchedFaces(side, f.wall!.bounds).map(face => face.support));
    }
    f.wall!.support = [...new Map(support.map(s => [fk(s), s])).values()];
    const first = f.wall!.support[0]; if (first) { const [dx, dr] = STEPS[first.direction]; f.x = first.x + dx; f.row = first.row + dr; }
  }
  const errors = wallMountIssues(map, bindings).filter(i => i.severity === 'error'); if (errors.length) throw new Error(errors[0].message);
  return map;
}

/** Door-attached fixtures retain their authored offset when the doorway moves, rotates, or resizes. */
export function synchronizeWallMounts(source: GridMap): GridMap {
  const map = structuredClone(source), missingRuns = new Set<string>(), remove = new Set<string>();
  for (const f of map.fixtures ?? []) {
    const w = f.wall; if (!w?.doorId) continue;
    const door = map.connections.find(d => d.id === w.doorId); if (!door) { if (protectedFixture(map, f)) throw new Error('잠긴 벽 부착물의 기준 문을 삭제할 수 없습니다.'); remove.add(f.id); if (w.runId) missingRuns.add(w.runId); continue; }
    const previous = w.doorReference, next = doorReference(map, door); if (!previous) { w.doorReference = next; continue; }
    if (near(previous.position, next.position) && previous.direction === next.direction && Math.abs(previous.width - next.width) < EPS && Math.abs(previous.height - next.height) < EPS) continue;
    if (protectedFixture(map, f)) throw new Error('잠긴 벽 부착물이 연결된 문은 이동·크기 변경할 수 없습니다.');
    const yaw = next.direction - previous.direction, oldSupport = structuredClone(w.support), shift = (v: Vec3): Vec3 => {
      let relative = rotate(sub(v, previous.position), yaw);
      if (w.doorSide) relative = add(relative, mul(tangent(normal(((next.direction + 180) % 360) as Direction)), (w.doorSide === 'left' ? -1 : 1) * (next.width - previous.width) / 2));
      return add(next.position, relative);
    };
    w.position = shift(w.position); w.rotationY = ((w.rotationY + yaw) % 360 + 360) % 360;
    w.bounds = w.bounds.map(box => ({ center: shift(box.center), size: Math.abs(yaw % 180) > EPS ? { x: box.size.z, y: box.size.y, z: box.size.x } : box.size }));
    w.sockets = w.sockets.map(s => ({ position: shift(s.position), direction: rotate(s.direction, yaw) }));
    const inward = ((door.direction + 180) % 360) as Direction;
    if (w.site === 'doorTop') { w.support = connectionCells(map, door).map(c => ({ ...c, direction: inward })); f.x = door.x; f.row = door.row; }
    else { const faces = facesFor(map).filter(face => face.support.direction === inward), oldWallFace = add(point(source, oldSupport[0]), mul(normal(oldSupport[0].direction), map.cellSize / 2)), desired = shift(oldWallFace), best = faces.sort((a, b) => Math.hypot(a.center.x - desired.x, a.center.z - desired.z) - Math.hypot(b.center.x - desired.x, b.center.z - desired.z))[0]; if (best) { w.support = [best.support]; f.x = best.cell.x; f.row = best.cell.row; } }
    f.direction = ((f.direction + yaw + 360) % 360) as Direction; w.doorReference = next;
    if (protectedFixture(map, f)) throw new Error('문 부착물의 새 위치가 잠긴 셀에 영향을 줍니다.');
  }
  if (remove.size || missingRuns.size) {
    const removed = map.fixtures?.filter(f => remove.has(f.id) || f.wall?.runId && missingRuns.has(f.wall.runId)) ?? [], removedIds = new Set(removed.map(f => f.id));
    if (removed.some(f => protectedFixture(map, f))) throw new Error('문 삭제가 잠긴 연결 부착물에 영향을 줍니다.');
    if (map.fixtures?.some(f => !removedIds.has(f.id) && f.linkedId && removedIds.has(f.linkedId))) throw new Error('다른 시설이 참조하는 문 부착물을 삭제할 수 없습니다. 연결을 먼저 해제해 주세요.');
    map.fixtures = map.fixtures?.filter(f => !removedIds.has(f.id));
  }
  return map;
}

/** Manual placement uses the same measurements and obstruction checks as automatic placement. */
export function insertWallMount(source: GridMap, cell: Cell, bindingId: string, bindings: AssetBinding[]): GridMap {
  const b = bindings.find(b => b.id === bindingId && b.wallMount?.kind === 'single' && (b.bounds || b.prop?.size || b.wallMount.collisionBoxes.length));
  if (!b) throw new Error('수동 설치할 개별 벽 부착물 프리팹을 선택해 주세요.');
  const map = structuredClone(source), faces = facesFor(map, bindings), candidates = doorCandidates(map, b, faces).filter(f => ck(f) === ck(cell) || f.wall!.support.some(s => ck(s) === ck(cell)));
  for (const face of faces.filter(f => ck(f.cell) === ck(cell) || ck(f.support) === ck(cell))) for (const site of b.wallMount!.sites.filter(s => ['wall', 'upper', 'lower'].includes(s))) candidates.push(singleOnFace(map, b, face, site, 'manual', undefined, faces));
  if (b.wallMount!.sites.includes('corner')) for (const boundary of boundaries(faces)) for (let i = 0; i < boundary.sides.length; i++) {
    const a = boundary.sides[i], next = boundary.sides[(i + 1) % boundary.sides.length]; if (!boundary.closed && i === boundary.sides.length - 1 || !near(a.end, next.start)) continue;
    const f = singleCorner(map, b, a, next, 'manual'); if (f && wallMountDependencies(f).some(c => ck(c) === ck(cell))) candidates.push(f);
  }
  const ctx = context(map, bindings), f = candidates.find(f => eligible(map, f) && !fitIssue(map, f, ctx));
  if (!f) throw new Error('이 위치에 설치할 벽면·문 위 마감·높이·통행 여유가 부족합니다.');
  const used = new Set(map.fixtures?.map(f => f.id)); let i = 1; while (used.has(`wm-manual-${i}`)) i++; f.id = `wm-manual-${i}`; f.wall!.authored = true;
  map.fixtures = [...(map.fixtures ?? []), f]; map.version = 5; return map;
}
