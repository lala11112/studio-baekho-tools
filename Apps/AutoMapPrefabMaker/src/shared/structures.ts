import type { AssetBinding, AssetRole, Cell, CliffFace, Direction, GenerationRegion, GridMap, PitBottom, StructureFill, StructureSettings, ValidationIssue, Vec3 } from './types';
import { connectionCells } from './connections';

export const DEFAULT_STRUCTURE_SETTINGS: StructureSettings = {
  ceilingClearance: 4, fillDoorTops: true, fillHeightGaps: true, gapRole: 'wall',
  pitBottomKind: 'deadzone', pitDepth: 4, deadzoneThickness: 1, defaultWallHeight: 4,
};
const directions: readonly Direction[] = [0, 90, 180, 270];
const step: Record<Direction, readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
const key = (c: Cell) => `${c.x},${c.row}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const inside = (c: Cell, r?: GenerationRegion) => !r || c.x >= r.x && c.row >= r.row && c.x < r.x + r.width && c.row < r.row + r.height;
const base = (map: GridMap, c: Cell) => map.elevations[c.row][c.x];
const position = (map: GridMap, c: Cell, y: number): Vec3 => ({ x: (c.x - (map.width - 1) / 2) * map.cellSize, y, z: ((map.height - 1) / 2 - c.row) * map.cellSize });
const epsilon = 1e-8;
/** Must match the Unity floor importer: Y is a thickness multiplier, never an absolute scale. */
export const FLOOR_THICKNESS_RATIO = .12;

/** Same explicit override / row-major selection contract used by terrain export. */
function geometryBinding(map: GridMap, bindings: readonly AssetBinding[], cell: Cell, role: AssetRole): AssetBinding | undefined {
  const override = map.assetOverrides.find(o => o.x === cell.x && o.row === cell.row && o.role === role);
  if (override) return bindings.find(b => b.id === override.bindingId && b.role === role);
  const candidates = bindings.filter(b => b.role === role);
  return candidates[(cell.row * map.width + cell.x) % candidates.length];
}

/** Actual calibrated floor slab bounds, including the cell's resolved binding offset and Y multiplier. */
export function floorSlabBounds(map: GridMap, cell: Cell, bindings: readonly AssetBinding[] = []): { top: number; bottom: number; thickness: number; offset: Vec3 } | undefined {
  if (!'.DPR'.includes(map.rows[cell.row]?.[cell.x] ?? '_')) return undefined;
  const binding = geometryBinding(map, bindings, cell, 'floor'), offset = binding?.offset ?? { x: 0, y: 0, z: 0 };
  const thickness = map.cellSize * FLOOR_THICKNESS_RATIO * (binding?.scale.y ?? 1), top = base(map, cell) + offset.y;
  return { top, bottom: top - thickness, thickness, offset: { ...offset } };
}

/** Saved fills describe terrain spans. Preview and export resolve their final physical envelope here.
 * Trim only the upper end under a slab; the authored lower end (including support binding offset) stays fixed.
 */
export function resolvedStructureFill(map: GridMap, fill: StructureFill, bindings: readonly AssetBinding[] = []): StructureFill | undefined {
  const offset = geometryBinding(map, bindings, fill, fill.role)?.offset ?? { x: 0, y: 0, z: 0 };
  const result: StructureFill = { ...fill, position: { x: fill.position.x + offset.x, y: fill.position.y + offset.y, z: fill.position.z + offset.z }, size: { ...fill.size } };
  // Older saves used thin panels above doors. Match a full wall cell without changing the opening height.
  if (fill.purpose === 'doorTop') {
    result.size.x = map.cellSize; result.size.z = map.cellSize;
  }
  if (fill.purpose !== 'heightGap' && fill.purpose !== 'pitSide') return result;
  const slab = floorSlabBounds(map, fill, bindings); if (!slab) return result;
  const low = result.position.y - result.size.y / 2, height = slab.bottom - low;
  if (height <= epsilon) return undefined; // The slab already closes this complete vertical gap.
  result.position.y = low + height / 2; result.size.y = height;
  return result;
}

/** Legacy cliff faces share the same floor-underside rule, without moving their pit-bottom anchor. */
export function resolvedCliffFace(map: GridMap, cliff: CliffFace, bindings: readonly AssetBinding[] = []): { position: Vec3; size: Vec3 } | undefined {
  const offset = geometryBinding(map, bindings, cliff, 'cliff')?.offset ?? { x: 0, y: 0, z: 0 }, [dx, dr] = step[cliff.direction];
  const low = base(map, cliff) - cliff.depth + offset.y;
  const high = floorSlabBounds(map, cliff, bindings)?.bottom ?? base(map, cliff) + offset.y;
  if (high - low <= epsilon) return undefined;
  const center = position(map, cliff, (high + low) / 2); center.x += dx * map.cellSize / 2 + offset.x; center.z -= dr * map.cellSize / 2 - offset.z;
  return { position: center, size: { x: map.cellSize * .96, y: high - low, z: map.cellSize * .07 } };
}

/** Only actual terrain surfaces contribute: wall bases, fixtures and lower pit closures do not. */
export function highestFloorSurface(map: GridMap): number {
  let highest = -Infinity;
  const ramps = new Map(map.ramps.map(r => [key(r), r.rise]));
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    if ('.DPRB'.includes(map.rows[row][x])) highest = Math.max(highest, map.elevations[row][x] + (map.rows[row][x] === 'R' ? ramps.get(`${x},${row}`) ?? 0 : 0));
  }
  return Number.isFinite(highest) ? highest : 0;
}

export function automaticCeilingY(map: GridMap, clearance = map.structureSettings?.ceilingClearance ?? 4): number {
  return highestFloorSurface(map) + clearance;
}

/** B is void below its deck. A region touching the map boundary is exterior, never a pit. */
export function structurePitRegions(map: GridMap): Cell[][] {
  const visited = new Set<string>(), result: Cell[][] = [];
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    if (!'_B'.includes(map.rows[row][x]) || visited.has(`${x},${row}`)) continue;
    const cells: Cell[] = [{ x, row }]; visited.add(`${x},${row}`); let exterior = false, voidFound = false;
    for (let index = 0; index < cells.length; index++) {
      const c = cells[index];
      exterior ||= c.x === 0 || c.row === 0 || c.x === map.width - 1 || c.row === map.height - 1;
      voidFound ||= map.rows[c.row][c.x] === '_';
      for (const [dx, dr] of Object.values(step)) {
        const next = { x: c.x + dx, row: c.row + dr };
        if (next.x < 0 || next.row < 0 || next.x >= map.width || next.row >= map.height || visited.has(key(next)) || !'_B'.includes(map.rows[next.row][next.x])) continue;
        visited.add(key(next)); cells.push(next);
      }
    }
    if (!exterior && voidFound) result.push(cells);
  }
  return result;
}

function assertRegion(map: GridMap, region?: GenerationRegion): void {
  if (region && (![region.x, region.row, region.width, region.height].every(Number.isInteger) || region.x < 0 || region.row < 0 || region.width < 1 || region.height < 1 || region.x + region.width > map.width || region.row + region.height > map.height)) throw new Error('구조 보완 영역은 맵 안의 정수 좌표여야 합니다.');
}
function conflict(c: Cell): never { throw new Error(`구조 변경이 선택 영역 밖 또는 잠긴 셀(${c.x}, ${c.row})에 영향을 줍니다. 영역을 넓히거나 잠금을 해제해 주세요.`); }

/** Explicit repair/adoption. Existing holes and all locked records remain intact. */
export function configureStructures(source: GridMap, settings: StructureSettings, region?: GenerationRegion): GridMap {
  const errors = structureDataErrors({ width: source.width, height: source.height, structureSettings: settings });
  if (errors.length) throw new Error(errors.join('\n'));
  assertRegion(source, region);
  const map = structuredClone(source), locked = new Set((map.lockedCells ?? []).map(key));
  map.version = 5; map.structureSettings = { ...settings };
  map.ceilings = (map.ceilings ?? []).map(c => inside(c, region) && !locked.has(key(c)) ? { ...c, heightMode: 'auto' } : c);
  const existing = new Map((map.wallHeights ?? []).map(c => [key(c), c]));
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const c = { x, row }; if (map.rows[row][x] !== '#' || !inside(c, region) || locked.has(key(c))) continue;
    existing.set(key(c), { ...c, height: existing.get(key(c))?.height ?? settings.defaultWallHeight, heightMode: 'auto' });
  }
  map.wallHeights = [...existing.values()];
  return synchronizeStructures(map, region);
}

/** Pure update of adopted structures. Does not reintroduce removed roof cells or move manual roofs. */
export function synchronizeStructures(source: GridMap, region?: GenerationRegion): GridMap {
  if (!source.structureSettings) return structuredClone(source);
  assertRegion(source, region);
  const map = structuredClone(source), settings = map.structureSettings!, locked = new Set((map.lockedCells ?? []).map(key));
  const ceilingY = automaticCeilingY(map), hasRoof = Boolean(map.ceilings?.length);
  const mayChange = (c: Cell) => {
    if (region && (!inside(c, region) || locked.has(key(c)))) conflict(c);
    return !locked.has(key(c));
  };
  map.ceilings = (map.ceilings ?? []).map(c => {
    if (c.heightMode !== 'auto' || Math.abs(c.undersideY - ceilingY) < epsilon) return c;
    return mayChange(c) ? { ...c, undersideY: ceilingY } : c;
  });
  map.wallHeights = (map.wallHeights ?? []).filter(w => {
    if (map.rows[w.row][w.x] === '#' || w.heightMode !== 'auto') return true;
    return !mayChange(w);
  }).map(w => {
    const height = hasRoof ? Math.max(.25, ceilingY - base(map, w)) : settings.defaultWallHeight;
    if (w.heightMode !== 'auto' || Math.abs(w.height - height) < epsilon) return w;
    return mayChange(w) ? { ...w, height } : w;
  });
  const derived = deriveStructures(map, settings);
  const merge = <T extends Cell>(old: T[], desired: T[], identity: (item: T) => string, equivalent: (a: T | undefined, b: T | undefined) => boolean = same): T[] => {
    const before = new Map(old.map(item => [identity(item), item])), after = new Map(desired.map(item => [identity(item), item]));
    const output: T[] = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(id), next = after.get(id), c = next ?? previous!;
      if (equivalent(previous, next)) { if (previous) output.push(previous); continue; }
      if (!mayChange(c)) { if (previous) output.push(previous); continue; }
      if (next) output.push(next);
    }
    return output;
  };
  map.pitBottoms = merge(map.pitBottoms ?? [], derived.bottoms, key);
  // Rendering/export normalize legacy door-top footprints; that alone must not invalidate a regional edit.
  const canonicalFill = (fill: StructureFill | undefined) => fill?.purpose === 'doorTop'
    ? { ...fill, size: { ...fill.size, x: map.cellSize, z: map.cellSize } } : fill;
  map.structureFills = merge(map.structureFills ?? [], derived.fills, item => item.id, (a, b) => same(canonicalFill(a), canonicalFill(b)));
  // Old decorative cliffs are superseded only on precisely matching repaired interior edges.
  const pitSides = new Set(map.structureFills.filter(f => f.purpose === 'pitSide').map(f => `${key(f)},${f.direction}`));
  map.cliffs = (map.cliffs ?? []).filter(c => !pitSides.has(`${key(c)},${c.direction}`) || locked.has(key(c)) || !inside(c, region));
  return map;
}

function deriveStructures(map: GridMap, settings: StructureSettings): { bottoms: PitBottom[]; fills: StructureFill[] } {
  const bottoms: PitBottom[] = [], fills: StructureFill[] = [], unit = map.cellSize;
  const thickness = Math.min(.2, unit * .12), previous = new Map((map.pitBottoms ?? []).map(b => [key(b), b]));
  const addEdge = (c: Cell, direction: Direction, low: number, high: number, purpose: StructureFill['purpose'], role: StructureFill['role']) => {
    if (high - low < epsilon) return;
    const [dx, dr] = step[direction], p = position(map, c, (low + high) / 2);
    // Keep the thickness inside the high cell so neighboring traversable surface remains clear.
    p.x += dx * (unit - thickness) / 2; p.z -= dr * (unit - thickness) / 2;
    fills.push({ ...c, id: `${purpose}-${c.x}-${c.row}-${direction}`, role, purpose, direction, position: p,
      size: { x: dx ? thickness : unit, y: high - low, z: dx ? unit : thickness } });
  };
  for (const pit of structurePitRegions(map)) {
    const regionKeys = new Set(pit.map(key)), rims: { c: Cell; direction: Direction }[] = [];
    for (const p of pit) for (const d of directions) {
      const [dx, dr] = step[d], c = { x: p.x + dx, row: p.row + dr };
      if (!regionKeys.has(key(c)) && '.DP#R'.includes(map.rows[c.row]?.[c.x] ?? '_')) rims.push({ c, direction: ((d + 180) % 360) as Direction });
    }
    if (!rims.length) continue;
    const saved = pit.map(c => previous.get(key(c))).find(Boolean);
    const y = saved?.y ?? Math.min(...rims.map(r => base(map, r.c))) - settings.pitDepth;
    const kind = saved?.kind ?? settings.pitBottomKind, depth = saved?.thickness ?? (kind === 'deadzone' ? settings.deadzoneThickness : unit * .12);
    for (const c of pit) bottoms.push({ ...c, kind, y, thickness: depth });
    for (const rim of rims) addEdge(rim.c, rim.direction, y, base(map, rim.c), 'pitSide', 'cliff');
  }
  if (settings.fillHeightGaps) for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const c = { x, row }, tile = map.rows[row][x]; if (!'.DPR'.includes(tile)) continue;
    for (const d of directions) {
      const [dx, dr] = step[d], neighbor = { x: x + dx, row: row + dr }, nt = map.rows[neighbor.row]?.[neighbor.x];
      if (!nt || !'.DPR'.includes(nt)) continue;
      // A ramp's body below its low base is rectangular; its sloped sides belong to the authored prefab.
      const high = base(map, c), low = base(map, neighbor);
      if (high <= low + epsilon) continue;
      if (nt === 'R') {
        const ramp = map.ramps.find(r => r.x === neighbor.x && r.row === neighbor.row);
        if (ramp && ((ramp.direction + 180) % 360) === d && Math.abs(low + ramp.rise - high) <= map.maxStepHeight + epsilon) continue;
      }
      addEdge(c, d, low, high, 'heightGap', settings.gapRole);
    }
  }
  if (settings.fillDoorTops) for (const door of map.connections) {
    const cells = connectionCells(map, door), acrossX = door.direction % 180 === 0;
    const span = cells.length * unit, margin = Math.max(0, (span - door.width) / 2), bottom = base(map, door);
    const tops = cells.map(c => {
      const roof = map.ceilings?.find(roof => key(roof) === key(c)); if (roof) return roof.undersideY;
      const neighbors = directions.map(d => { const [dx, dr] = step[d]; return { x: c.x + dx, row: c.row + dr }; });
      const walls = neighbors.filter(n => map.rows[n.row]?.[n.x] === '#').map(n => base(map, n) + (map.wallHeights?.find(w => key(w) === key(n))?.height ?? settings.defaultWallHeight));
      return walls.length ? Math.max(...walls) : bottom + settings.defaultWallHeight;
    });
    cells.forEach((c, index) => {
      const height = tops[index] - bottom - door.height; if (height <= epsilon) return;
      fills.push({ ...c, id: `doorTop-${door.id}-${index}`, role: 'wall', purpose: 'doorTop', direction: door.direction,
        position: position(map, c, bottom + door.height + height / 2), size: { x: unit, y: height, z: unit } });
    });
    if (margin > epsilon) for (const sign of [-1, 1]) {
      const index = sign < 0 ? 0 : cells.length - 1, c = cells[index];
      const center = position(map, cells[0], bottom + door.height / 2), offset = (span - unit) / 2 + sign * (span - margin) / 2;
      if (acrossX) center.x += offset; else center.z -= offset;
      fills.push({ ...c, id: `doorSide-${door.id}-${sign < 0 ? 'left' : 'right'}`, role: 'wall', purpose: 'doorSide', direction: door.direction, position: center,
        size: { x: acrossX ? margin : thickness, y: door.height, z: acrossX ? thickness : margin } });
    }
  }
  return { bottoms, fills };
}

/** Editing one pit changes its entire connected lower closure, including cells underneath bridges. */
export function setPitBottom(source: GridMap, cell: Cell, patch: Partial<Pick<PitBottom, 'kind' | 'y' | 'thickness'>>): GridMap {
  const pit = structurePitRegions(source).find(p => p.some(c => key(c) === key(cell)));
  if (!pit) throw new Error('선택한 셀은 내부 낭떠러지에 속하지 않습니다.');
  const locks = new Set((source.lockedCells ?? []).map(key)); for (const c of pit) if (locks.has(key(c))) conflict(c);
  const map = structuredClone(source), cells = new Set(pit.map(key));
  map.pitBottoms = (map.pitBottoms ?? []).map(b => cells.has(key(b)) ? { ...b, ...patch } : b);
  const errors = structureDataErrors(map as unknown as Record<string, unknown>); if (errors.length) throw new Error(errors.join('\n'));
  return synchronizeStructures(map);
}

export function structureIssues(map: GridMap): ValidationIssue[] {
  const issues: ValidationIssue[] = [], eligible = new Set(structurePitRegions(map).flat().map(key));
  for (const b of map.pitBottoms ?? []) {
    if (!eligible.has(key(b))) issues.push({ severity: 'error', code: 'pit-bottom-outside', message: `하부 마감(${b.x}, ${b.row})은 내부 구덩이에 있어야 합니다.`, cells: [b] });
    if (map.rows[b.row][b.x] === 'B' && b.y >= base(map, b) - epsilon) issues.push({ severity: 'error', code: 'pit-bottom-bridge', message: `하부 마감(${b.x}, ${b.row})이 다리 상판 이상으로 올라왔습니다.`, cells: [b] });
  }
  for (const pit of structurePitRegions(map)) {
    const saved = (map.pitBottoms ?? []).filter(b => pit.some(c => key(c) === key(b)));
    if (saved.length && (saved.length !== pit.length || saved.some(b => b.y !== saved[0].y || b.kind !== saved[0].kind || b.thickness !== saved[0].thickness))) issues.push({ severity: 'error', code: 'pit-bottom-inconsistent', message: '연결된 낭떠러지의 하부 마감 높이·종류·두께는 같아야 합니다.', cells: pit });
    if (saved.length) for (const c of pit) for (const [dx, dr] of Object.values(step)) {
      const n = { x: c.x + dx, row: c.row + dr }; if ('.DPR'.includes(map.rows[n.row]?.[n.x] ?? '_') && saved[0].y >= base(map, n) - epsilon) issues.push({ severity: 'error', code: 'pit-bottom-rim', message: `하부 마감은 둘레 바닥(${n.x}, ${n.row})보다 낮아야 합니다.`, cells: [n] });
    }
  }
  return issues;
}

/** Strict v5 structure parsing, kept separate from terrain parsing for legacy compatibility. */
export function structureDataErrors(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
  const cell = (v: Record<string, unknown>) => finite(v.x) && Number.isInteger(v.x) && v.x >= 0 && v.x < Number(input.width) && finite(v.row) && Number.isInteger(v.row) && v.row >= 0 && v.row < Number(input.height);
  const vector = (v: unknown, positive = false) => record(v) && only(v, ['x', 'y', 'z']) && [v.x, v.y, v.z].every(n => finite(n) && Math.abs(n) <= 1000000 && (!positive || n > 0));
  const s = input.structureSettings;
  if (s !== undefined && (!record(s) || !only(s, Object.keys(DEFAULT_STRUCTURE_SETTINGS)) || Object.keys(DEFAULT_STRUCTURE_SETTINGS).some(k => s[k] === undefined) ||
    !['wall', 'cliff'].includes(String(s.gapRole)) || !['floor', 'deadzone'].includes(String(s.pitBottomKind)) || typeof s.fillDoorTops !== 'boolean' || typeof s.fillHeightGaps !== 'boolean' ||
    !['ceilingClearance', 'pitDepth', 'deadzoneThickness', 'defaultWallHeight'].every(k => finite(s[k]) && (s[k] as number) >= .01 && (s[k] as number) <= 100))) errors.push('map.structureSettings의 높이·종류·토글이 올바르지 않습니다.');
  for (const [name, limit] of [['pitBottoms', 1600], ['structureFills', 16000]] as const) {
    const entries = input[name]; if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > limit) { errors.push(`map.${name} 배열의 크기 또는 구조가 올바르지 않습니다.`); continue; }
    const ids = new Set<string>();
    for (const item of entries) {
      if (!record(item) || !cell(item)) { errors.push(`map.${name}의 좌표가 올바르지 않습니다.`); continue; }
      const id = name === 'pitBottoms' ? `${item.x},${item.row}` : String(item.id);
      const valid = name === 'pitBottoms'
        ? only(item, ['x', 'row', 'kind', 'y', 'thickness']) && ['floor', 'deadzone'].includes(String(item.kind)) && finite(item.y) && Math.abs(item.y) <= 1000 && finite(item.thickness) && item.thickness > 0 && item.thickness <= 100
        : only(item, ['x', 'row', 'id', 'role', 'purpose', 'direction', 'position', 'size']) && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item.id) && ['wall', 'cliff'].includes(String(item.role)) && ['doorTop', 'doorSide', 'heightGap', 'pitSide'].includes(String(item.purpose)) && directions.includes(item.direction as Direction) && vector(item.position) && vector(item.size, true);
      if (!valid || ids.has(id)) errors.push(`map.${name} 항목 값이 잘못되었거나 중복되었습니다: ${id}`);
      ids.add(id);
    }
  }
  return errors;
}
