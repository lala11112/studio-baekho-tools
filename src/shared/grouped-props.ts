import { connectionCells } from './connections';
import { analyzeLevelDesign, compileLevelDesign, createObstacleEvaluator } from './level-design';
import { resolveFixtureBinding } from './light-bindings';
import { effectivePropComposition, effectivePropCompositions, getCompositionIssues } from './prop-composition';
import { connected, propFootprint, propOccupancy, propPosition, propValidationIssues, propWorldSize } from './props';
import type { AssetBinding, Cell, Direction, GenerationRegion, GenerationSettings, GridMap, PropComposition, PropInstance, ValidationIssue } from './types';
import { wallMountDependencies, wallMountIssues } from './wall-mounts';
import { compositionTerrain, planRoomComposition, type RoomCompositionPlan } from './room-composition';
import { teleportReservedCells, teleportIssues } from './teleport';
import { effectivePropBehavior, groupedYawOffsets, propAccessCells } from './prop-behavior';
import { propFacingOffset, propFrontYaw, propYaw } from './prop-orientation';

const key = (c: Cell) => `${c.x},${c.row}`;
const inside = (c: Cell, r: GenerationRegion) => c.x >= r.x && c.row >= r.row && c.x < r.x + r.width && c.row < r.row + r.height;
const directions: Record<Direction, readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
const roleOf = (p: PropInstance) => p.role ?? (p.blocksMovement ? 'prop' : 'decoration');
type Eligible = { binding: AssetBinding; composition: PropComposition };
type Member = { prop: PropInstance; asset: Eligible };
type Rect = { left: number; right: number; top: number; bottom: number };
const rect = (p: PropInstance): Rect => ({ left: p.x, right: Math.max(...p.cells.map(c => c.x)), top: p.row, bottom: Math.max(...p.cells.map(c => c.row)) });
const hash = (value: string, seed: number) => {
  let n = seed >>> 0;
  for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  // Avalanche adjacent seeds and similarly named prefab IDs before using the score as a random sample.
  n = Math.imul(n ^ n >>> 16, 0x85ebca6b); n = Math.imul(n ^ n >>> 13, 0xc2b2ae35);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
};

/** Optional AI hints must not become entrance obstacles before the measured furnishing pass. */
export function clearGroupedPropHints(source: GridMap, region?: GenerationRegion): GridMap {
  const map = structuredClone(source), area = region ?? { x: 0, row: 0, width: source.width, height: source.height };
  const locks = new Set((map.lockedCells ?? []).map(key)), occupied = propOccupancy(map), rows = map.rows.map(r => [...r]);
  for (let row = area.row; row < area.row + area.height; row++) for (let x = area.x; x < area.x + area.width; x++) {
    const c = { x, row };
    if (rows[row]?.[x] === 'P' && !locks.has(key(c)) && !occupied.has(key(c)) && !map.assetOverrides.some(o => o.role === 'prop' && o.x === x && o.row === row)) rows[row][x] = '.';
  }
  map.rows = rows.map(r => r.join(''));
  return map;
}

/** Place small, meaningful sets without changing the geometry or any existing measured object. */
export function placeGroupedProps(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], region?: GenerationRegion, externalReserved: Cell[] = [], accept?: (map: GridMap) => boolean, authoredPlanningLocks?: Cell[]): { map: GridMap; issues: ValidationIssue[]; composition?: RoomCompositionPlan } {
  const issues: ValidationIssue[] = [], d = settings.designer;
  if (!d || !d.props && !d.decorations && !d.vegetation) return { map: structuredClone(source), issues };
  let map = clearGroupedPropHints(source, region);
  const area = region ?? { x: 0, row: 0, width: map.width, height: map.height }, seed = settings.seed ?? 0;
  const locks = new Set((map.lockedCells ?? []).map(key));
  const purpose = d.preset, theme = settings.levelDesign?.theme?.trim().toLowerCase();
  const activeRole = (role: AssetBinding['role']) => role === 'prop' ? d.props : role === 'decoration' ? d.decorations && (d.decorationDensity ?? d.fixtureDensity) > 0 : role === 'vegetation' ? d.vegetation && (d.vegetationDensity ?? d.fixtureDensity) > 0 : false;
  const candidateBindings = bindings.filter(b => !b.wallMount && activeRole(b.role) && b.prop?.weight && b.prop.roomTypes.includes(purpose)
    && (!theme || !b.prop.tags.length || b.prop.tags.some(t => t.toLowerCase() === theme)));
  const behaviors = new Map(candidateBindings.map(binding => [binding, effectivePropBehavior(binding)]));
  const behaviorOf = (binding: AssetBinding) => behaviors.get(binding) ?? effectivePropBehavior(binding);
  const poseOffsets = new Map<string, number[]>();
  const yawOffsets = (asset: Eligible, salt: string): number[] => {
    const signature = `${salt}:${behaviorOf(asset.binding)}:${asset.composition.usage}:${propFacingOffset(asset.binding)}`;
    let offsets = poseOffsets.get(signature);
    if (!offsets) { offsets = groupedYawOffsets(asset.binding, asset.composition, seed, salt, behaviorOf(asset.binding)); poseOffsets.set(signature, offsets); }
    return offsets;
  };
  const candidates = candidateBindings.flatMap(binding => effectivePropCompositions(binding).map(composition => ({ binding, composition })));
  issues.push(...getCompositionIssues(bindings, settings));
  const eligible: Eligible[] = candidates.filter(c => ['equipment', 'storage', 'natural'].includes(c.composition.usage) && c.composition.family.trim() && c.binding.prop?.size && c.binding.prop.placement === 'floor' && behaviorOf(c.binding) !== 'surfaceAccessory' && (c.binding.role !== 'prop' || c.binding.prop.blocksMovement)).sort((a, b) => a.binding.id.localeCompare(b.binding.id));
  for (const binding of candidateBindings.filter(b => !b.prop?.size)) issues.push({ severity: 'warning', code: 'prop-unmeasured', message: `${binding.label}: 원본 크기가 없어 군집 배치에서 제외했습니다.` });
  if (!eligible.length) {
    issues.push({ severity: 'warning', code: 'grouped-props-no-catalog', message: '크기와 용도가 확인된 바닥 소품 군집이 없습니다. 기존 실측 배치는 보존하고 자동 임시 소품 표시는 정리했습니다.' });
    return { map, issues };
  }
  // Partial-generation edit locks also cover retained automatic objects. They remain hard
  // placement constraints, but must not turn those objects into permanent design anchors.
  const planningLocks = authoredPlanningLocks ?? map.lockedCells ?? [], planningMap = { ...map, lockedCells: planningLocks };
  const recipe = compileLevelDesign(settings), baseline = analyzeLevelDesign(compositionTerrain(planningMap), settings);
  const radius = settings.levelDesign?.characterRadius ?? .4;
  const existingAccess = (map.propInstances ?? []).flatMap(p => { const b = bindings.find(b => b.id === p.bindingId); return b ? propAccessCells(p, b, radius, map.cellSize) : []; });
  const sharedReserved = [...externalReserved, ...teleportReservedCells(map), ...baseline.reservedEntryCells, ...baseline.combatCells, ...baseline.routes.flat(),
    ...map.connections.flatMap(c => connectionCells(map, c)), ...(map.markers ?? []), ...(map.fixtures ?? []).filter(f => !f.wall && (f.anchor ?? 'floor') === 'floor'),
    ...(map.fixtures ?? []).filter(f => f.wall).flatMap(wallMountDependencies)];
  const reserved = new Map([...sharedReserved, ...existingAccess, ...(map.lockedCells ?? [])].map(c => [key(c), c]));
  const planningReserved = new Map([...sharedReserved, ...planningLocks].map(c => [key(c), c]));
  const fixtureVolumes: { x: number; y: number; z: number; width: number; height: number; depth: number }[] = [];
  const fixtureCells = new Set([...(map.fixtures ?? []).filter(f => !f.wall && (f.anchor ?? 'floor') === 'floor'), ...(map.markers ?? [])].map(key));
  // Existing fixtures reserve the full bounds of the same binding that export resolves.
  for (const fixture of map.fixtures ?? []) {
    if (fixture.wall) {
      for (const bounds of fixture.wall.bounds) fixtureVolumes.push({ ...bounds.center, width: bounds.size.x, height: bounds.size.y, depth: bounds.size.z });
      continue;
    }
    const binding = resolveFixtureBinding(map, bindings, fixture);
    const angle = (fixture.direction + (binding?.rotationY ?? 0)) * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const native = binding?.bounds?.size, size = binding && (propWorldSize(binding, fixture.direction) ?? (native ? {
      x: Math.abs(native.x * binding.scale.x * cos) + Math.abs(native.z * binding.scale.z * sin), y: native.y * binding.scale.y,
      z: Math.abs(native.x * binding.scale.x * sin) + Math.abs(native.z * binding.scale.z * cos),
    } : undefined));
    if (!binding || !size) continue;
    const [dx, dr] = fixture.anchor === 'wall' ? directions[fixture.direction] : [0, 0];
    const center = binding.bounds?.center, cx = (center?.x ?? 0) * binding.scale.x, cz = (center?.z ?? 0) * binding.scale.z;
    const x = fixture.x + dx / 2 + (fixture.offset.x + binding.offset.x + cos * cx + sin * cz) / map.cellSize;
    const row = fixture.row + dr / 2 - (fixture.offset.z + binding.offset.z - sin * cx + cos * cz) / map.cellSize;
    const base = map.elevations[fixture.row]?.[fixture.x] ?? 0;
    const anchorY = fixture.anchor === 'ceiling' ? map.ceilings?.find(c => c.x === fixture.x && c.row === fixture.row)?.undersideY ?? base
      : fixture.anchor === 'wall' ? base + (map.wallHeights?.find(c => c.x === fixture.x && c.row === fixture.row)?.height ?? 3) / 2 : base;
    fixtureVolumes.push({ x: (x - (map.width - 1) / 2) * map.cellSize, z: ((map.height - 1) / 2 - row) * map.cellSize,
      y: anchorY + fixture.offset.y + binding.offset.y + (center ? center.y * binding.scale.y : size.y / 2), width: size.x, height: size.y, depth: size.z });
    if ((fixture.anchor ?? 'floor') !== 'floor') continue;
    for (let r = Math.max(0, Math.floor(row - size.z / map.cellSize / 2 + .5)); r <= Math.min(map.height - 1, Math.ceil(row + size.z / map.cellSize / 2 - .5)); r++)
      for (let c = Math.max(0, Math.floor(x - size.x / map.cellSize / 2 + .5)); c <= Math.min(map.width - 1, Math.ceil(x + size.x / map.cellSize / 2 - .5)); c++) {
        const cell = { x: c, row: r }; fixtureCells.add(key(cell)); reserved.set(key(cell), cell); planningReserved.set(key(cell), cell);
      }
  }
  const composition = planRoomComposition(planningMap, settings, candidateBindings, [...planningReserved.values()]);
  const compositionCells = new Map(composition.zones.map(c => [key(c), c]));
  const quiet = new Set(composition.quietCells.map(key));
  let floorCount = 0;
  for (let row = area.row; row < area.row + area.height; row++) for (let x = area.x; x < area.x + area.width; x++) if ('.P'.includes(map.rows[row]?.[x] ?? '_')) floorCount++;
  const floorArea = floorCount * map.cellSize ** 2, spacingRadius = Math.max(3, Math.round(Math.sqrt(floorCount) / 6));
  const targetArea = floorArea * Math.min(30, Math.max(1, d.propCoverage ?? 12)) / 100;
  const targetDecorations = Math.ceil(floorCount * (d.decorationDensity ?? d.fixtureDensity) / 100), targetVegetation = Math.ceil(floorCount * (d.vegetationDensity ?? d.fixtureDensity) / 100);
  const localProps = () => (map.propInstances ?? []).filter(p => p.cells.some(c => inside(c, area)));
  const clippedArea = (p: PropInstance) => {
    const position = propPosition(map, p, bindings.find(b => b.id === p.bindingId));
    const left = (area.x - map.width / 2) * map.cellSize, right = (area.x + area.width - map.width / 2) * map.cellSize;
    const top = (map.height / 2 - area.row) * map.cellSize, bottom = (map.height / 2 - area.row - area.height) * map.cellSize;
    return Math.max(0, Math.min(right, position.x + p.size.x / 2) - Math.max(left, position.x - p.size.x / 2)) * Math.max(0, Math.min(top, position.z + p.size.z / 2) - Math.max(bottom, position.z - p.size.z / 2));
  };
  const propArea = () => localProps().filter(p => roleOf(p) === 'prop' && p.blocksMovement && (p.anchor ?? 'floor') === 'floor' && !['floorDetail', 'edge', 'excluded'].includes(effectivePropComposition(bindings.find(b => b.id === p.bindingId) ?? { label: '', prefabPath: '', role: 'prop' } as AssetBinding).usage)).reduce((n, p) => n + clippedArea(p), 0);
  const count = (role: 'decoration' | 'vegetation') => localProps().filter(p => roleOf(p) === role).length + (map.fixtures ?? []).filter(f => !f.wall && f.role === role && inside(f, area)).length;
  let usedArea = propArea(), decorations = count('decoration'), vegetation = count('vegetation');
  const needs = (role: AssetBinding['role']) => role === 'prop' ? d.props && usedArea + 1e-6 < targetArea : role === 'decoration' ? d.decorations && decorations < targetDecorations : role === 'vegetation' ? d.vegetation && vegetation < targetVegetation : false;
  const needsAny = () => eligible.some(c => needs(c.binding.role));
  const usedIds = new Set((map.propInstances ?? []).flatMap(p => [p.id, ...(p.groupId ? [p.groupId] : [])]));
  let sequence = 0, failure = '', accessFailed = false;
  let currentOccupied = new Set<string>(), externalGap = new Set<string>();
  const bindingCounts = new Map<string, number>();
  const distances = new Float64Array(map.width * map.height);
  // Only geometry is shared between equivalent prefabs. Identity, role and selection weights
  // still belong to each asset, and mutable pending offsets never escape into these caches.
  const geometry = new Map<AssetBinding, Map<number, { size: PropInstance['size']; signature: string }>>();
  const shape = (binding: AssetBinding, yaw: number) => {
    let rotations = geometry.get(binding);
    if (!rotations) { rotations = new Map(); geometry.set(binding, rotations); }
    let result = rotations.get(yaw);
    if (!result) {
      const size = propWorldSize(binding, yaw)!;
      result = { size, signature: JSON.stringify([size.x, size.y, size.z, binding.offset.x, binding.offset.y, binding.offset.z]) };
      rotations.set(yaw, result);
    }
    return result;
  };
  const fits = new Map<string, PropInstance | null>();
  const roofs = new Map((map.ceilings ?? []).map(c => [key(c), c.undersideY])), forbiddenZones = new Set((map.zones ?? []).filter(z => ['reward', 'rest'].includes(z.kind)).map(key));
  const refreshOccupancy = () => {
    fits.clear(); bindingCounts.clear(); distances.fill(spacingRadius);
    currentOccupied = new Set((map.propInstances ?? []).flatMap(p => p.cells.map(key))); externalGap = new Set(currentOccupied);
    for (const p of map.propInstances ?? []) {
      bindingCounts.set(p.bindingId, (bindingCounts.get(p.bindingId) ?? 0) + 1);
      for (const c of p.cells) {
        for (let dr = -1; dr <= 1; dr++) for (let dx = -1; dx <= 1; dx++) externalGap.add(key({ x: c.x + dx, row: c.row + dr }));
        // Capped Chebyshev distance matches the footprint spacing rule. Include objects
        // outside a partial generation region so its boundary does not attract new groups.
        for (let row = Math.max(0, c.row - spacingRadius); row <= Math.min(map.height - 1, c.row + spacingRadius); row++)
          for (let x = Math.max(0, c.x - spacingRadius); x <= Math.min(map.width - 1, c.x + spacingRadius); x++) {
            const index = row * map.width + x;
            distances[index] = Math.min(distances[index], Math.max(Math.abs(x - c.x), Math.abs(row - c.row)));
          }
      }
    }
  };
  const overlapsFixture = (prop: PropInstance, binding: AssetBinding) => {
    const p = propPosition(map, prop, binding);
    return fixtureVolumes.some(v => Math.abs(p.x - v.x) < (prop.size.x + v.width) / 2 - 1e-6 && Math.abs(p.z - v.z) < (prop.size.z + v.depth) / 2 - 1e-6
      && p.y < v.y + v.height / 2 - 1e-6 && p.y + prop.size.y > v.y - v.height / 2 + 1e-6);
  };
  const order = (assets: Eligible[], salt: string, pending: Member[] = []) => {
    const byBinding = new Map<string, Eligible[]>(), counts = new Map(bindingCounts);
    for (const m of pending) counts.set(m.prop.bindingId, (counts.get(m.prop.bindingId) ?? 0) + 1);
    for (const asset of assets) byBinding.set(asset.binding.id, [...(byBinding.get(asset.binding.id) ?? []), asset]);
    const unique = [...byBinding.values()], count = [...byBinding.keys()].reduce((sum, id) => sum + (counts.get(id) ?? 0), 0);
    const total = unique.reduce((n, variants) => n + variants[0].binding.prop!.weight, 0) || 1;
    const pendingIds = new Set(pending.map(m => m.prop.bindingId));
    // Rank a prefab once even when it belongs to several Unity sets. First use is a weighted
    // seeded draw; subsequent use follows the measured deficit to avoid repeated favorites.
    return unique.map(variants => {
      const binding = variants[0].binding, sample = Math.max(Number.EPSILON, hash(`${salt}:${binding.id}`, seed));
      return { variants, id: binding.id, repeated: pendingIds.has(binding.id) ? 1 : 0,
        priority: count ? -(binding.prop!.weight / total * (count + 1) - (counts.get(binding.id) ?? 0)) : -Math.log(sample) / binding.prop!.weight,
        tie: sample };
    }).sort((a, b) => a.repeated - b.repeated || a.priority - b.priority || a.tie - b.tie || a.id.localeCompare(b.id))
      .flatMap(({ variants }) => variants.sort((a, b) => hash(`${salt}:${a.binding.id}:${a.composition.family}`, seed) - hash(`${salt}:${b.binding.id}:${b.composition.family}`, seed)
        || a.composition.family.localeCompare(b.composition.family)));
  };
  const construct = (asset: Eligible, origin: Cell, facing: Direction, members: Member[], yawOffset: number): Member | undefined => {
    const binding = asset.binding, { size, signature } = shape(binding, facing + yawOffset);
    if (size.x > area.width * map.cellSize || size.z > area.height * map.cellSize) return undefined;
    const cacheKey = `${signature}:${origin.x},${origin.row}`;
    if (!fits.has(cacheKey)) {
      fits.set(cacheKey, null);
      const cells = propFootprint(map, origin, size), base = map.elevations[origin.row]?.[origin.x];
      if (!Number.isFinite(base) || cells.some(c => !inside(c, area) || map.rows[c.row]?.[c.x] !== '.' || locks.has(key(c)) || externalGap.has(key(c)) || reserved.has(key(c)) || quiet.has(key(c))
        || compositionCells.get(key(c))?.kind === 'support' && distances[c.row * map.width + c.x] < Math.min(3, spacingRadius)
        || forbiddenZones.has(key(c)) || Math.abs(map.elevations[c.row][c.x] - base) > 1e-6 || (roofs.get(key(c)) ?? Infinity) - base < size.y + binding.offset.y)) return undefined;
      const width = Math.max(...cells.map(c => c.x)) - origin.x + 1, height = Math.max(...cells.map(c => c.row)) - origin.row + 1;
      if (Math.abs(binding.offset.x) > (width * map.cellSize - size.x) / 2 + 1e-6 || Math.abs(binding.offset.z) > (height * map.cellSize - size.z) / 2 + 1e-6 || binding.offset.y < -1e-6) return undefined;
      const prop: PropInstance = { id: 'grouped-pending', bindingId: binding.id, role: binding.role as PropInstance['role'], ...origin, direction: facing, ...(yawOffset ? { yawOffset } : {}),
        offset: { x: (width - 1) * map.cellSize / 2, y: 0, z: -(height - 1) * map.cellSize / 2 || 0 }, cells, size, blocksMovement: binding.prop!.blocksMovement, category: binding.prop!.category, anchor: 'floor', provenance: 'generated' };
      if (!overlapsFixture(prop, binding)) fits.set(cacheKey, prop);
    }
    const cached = fits.get(cacheKey);
    if (!cached || members.some(m => m.prop.cells.some(c => cached.cells.some(n => n.x === c.x && n.row === c.row)))) return undefined;
    const prop = { ...cached, offset: { ...cached.offset }, bindingId: binding.id, role: binding.role as PropInstance['role'], direction: facing,
      blocksMovement: binding.prop!.blocksMovement, category: binding.prop!.category };
    if (yawOffset) prop.yawOffset = yawOffset; else delete prop.yawOffset;
    return { asset, prop };
  };
  const onWall = (member: Member, side: Direction) => {
    const r = rect(member.prop), [dx, dr] = directions[side];
    const back = member.prop.cells.filter(c => side === 0 ? c.row === r.top : side === 180 ? c.row === r.bottom : side === 90 ? c.x === r.right : c.x === r.left);
    return back.every(c => map.rows[c.row + dr]?.[c.x + dx] === '#');
  };
  const move = (member: Member, axis: 'x' | 'row', amount: number): number => {
    const p = member.prop, b = member.asset.binding, r = rect(p), dimension = axis === 'x' ? p.size.x : p.size.z;
    const cells = axis === 'x' ? r.right - r.left + 1 : r.bottom - r.top + 1, slack = Math.max(0, (cells * map.cellSize - dimension) / 2);
    const centered = axis === 'x' ? (cells - 1) * map.cellSize / 2 : -(cells - 1) * map.cellSize / 2;
    const current = axis === 'x' ? p.offset.x - centered + b.offset.x : -(p.offset.z - centered + b.offset.z);
    const delta = Math.min(slack, Math.max(-slack, current + amount)) - current;
    if (axis === 'x') p.offset.x += delta; else p.offset.z -= delta;
    return delta;
  };
  const tighten = (parent: Member, child: Member, side: Direction, moveParent: boolean) => {
    const [dx, dr] = directions[side], axis = dx ? 'x' : 'row', sign = dx || dr;
    const a = propPosition(map, parent.prop, parent.asset.binding), b = propPosition(map, child.prop, child.asset.binding);
    const distance = sign * (axis === 'x' ? b.x - a.x : a.z - b.z), extent = axis === 'x' ? (parent.prop.size.x + child.prop.size.x) / 2 : (parent.prop.size.z + child.prop.size.z) / 2;
    let excess = Math.max(0, distance - extent - Math.min(.2, map.cellSize * .1));
    excess -= Math.abs(move(child, axis, -sign * excess));
    if (moveParent) move(parent, axis, sign * excess);
  };
  const alignSeat = (parent: Member, child: Member, side: Direction): boolean => {
    const previous = { ...parent.prop.offset };
    const axis = side === 0 || side === 180 ? 'x' : 'row';
    const a = propPosition(map, parent.prop, parent.asset.binding), b = propPosition(map, child.prop, child.asset.binding);
    const delta = axis === 'x' ? a.x - b.x : b.z - a.z;
    const moved = move(child, axis, delta), adjusted = move(parent, axis, moved - delta);
    const aligned = Math.abs(delta - moved + adjusted) < 1e-6;
    if (!aligned) parent.prop.offset = previous;
    return aligned;
  };
  const facesSurface = (parent: Member, child: Member): boolean => {
    const a = propPosition(map, parent.prop, parent.asset.binding), b = propPosition(map, child.prop, child.asset.binding);
    const yaw = propFrontYaw(child.prop, child.asset.binding) * Math.PI / 180;
    let near = 0, far = Infinity;
    for (const [origin, direction, center, half] of [[b.x, Math.sin(yaw), a.x, parent.prop.size.x / 2], [b.z, Math.cos(yaw), a.z, parent.prop.size.z / 2]]) {
      if (Math.abs(direction) < 1e-8) { if (Math.abs(origin - center) > half) return false; continue; }
      const first = (center - half - origin) / direction, second = (center + half - origin) / direction;
      near = Math.max(near, Math.min(first, second)); far = Math.min(far, Math.max(first, second));
    }
    return far >= near && far > 0;
  };
  const companionOrigins = (anchor: Member, asset: Eligible, facing: Direction, yawOffset: number, layout: 'wall' | 'island', members: Member[], salt: string): { c: Cell; side: Direction; parent: Member }[] => {
    const size = propWorldSize(asset.binding, facing + yawOffset)!, width = Math.max(1, Math.ceil(size.x / map.cellSize - 1e-8)), height = Math.max(1, Math.ceil(size.z / map.cellSize - 1e-8));
    if (behaviorOf(asset.binding) === 'seat') {
      const r = rect(anchor.prop), side = ((facing + 180) % 360) as Direction;
      const c = side === 90 ? { x: r.right + 1, row: Math.round((r.top + r.bottom - height + 1) / 2) }
        : side === 270 ? { x: r.left - width, row: Math.round((r.top + r.bottom - height + 1) / 2) }
        : side === 180 ? { x: Math.round((r.left + r.right - width + 1) / 2), row: r.bottom + 1 }
        : { x: Math.round((r.left + r.right - width + 1) / 2), row: r.top - height };
      return [{ c, side, parent: anchor }];
    }
    const sides: Direction[] = layout === 'wall' ? facing === 0 || facing === 180 ? [90, 270] : [0, 180] : [0, 90, 180, 270];
    const ordered = sides.map(side => ({ side, tie: hash(`${salt}:${side}`, seed) })).sort((a, b) => a.tie - b.tie).map(v => v.side);
    return [anchor, ...members.slice(1)].flatMap(parent => {
      const r = rect(parent.prop);
      return ordered.flatMap(side => {
        const c = side === 90 ? { x: r.right + 1, row: r.top } : side === 270 ? { x: r.left - width, row: r.top } : side === 180 ? { x: r.left, row: r.bottom + 1 } : { x: r.left, row: r.top - height };
        if (layout === 'wall') {
          const a = rect(anchor.prop), back = ((facing + 180) % 360) as Direction;
          if (back === 180) c.row = a.bottom - height + 1;
          if (back === 90) c.x = a.right - width + 1;
        }
        return [{ c, side, parent }];
      });
    });
  };
  const addGroup = (): boolean => {
    refreshOccupancy();
    const anchors = order(eligible.filter(a => a.composition.member !== 'companion' && behaviorOf(a.binding) !== 'seat'), `anchor-${sequence}`), evaluate = recipe.combatRequired ? createObstacleEvaluator(map, settings) : undefined;
    const tactics = new Map<string, ReturnType<NonNullable<typeof evaluate>>>();
    const failedCompanions = new Set<string>();
    const companionOrders = new Map<string, Eligible[]>();
    const anchorOrigins = new Map<string, { prop: PropInstance; facing: Direction; layout: 'wall' | 'island'; baseScore: number }[]>();
    // A fitting focal scene wins over a support-only prefab, while the seeded weighted
    // prefab ordering is retained within each stage.
    for (const stage of ['focal', 'support'] as const) for (const anchorAsset of anchors) {
      const compatible = eligible.filter(c => c.composition.usage === anchorAsset.composition.usage && c.composition.family === anchorAsset.composition.family && c.composition.member !== 'anchor' && (behaviorOf(anchorAsset.binding) === 'workSurface' ? behaviorOf(c.binding) === 'seat' : !['seat', 'workSurface'].includes(behaviorOf(c.binding))));
      if (!compatible.length || !needs(anchorAsset.binding.role) && !compatible.some(c => needs(c.binding.role))) continue;
      const layouts: ('wall' | 'island')[] = anchorAsset.composition.arrangement === 'either' ? ['wall', 'island'] : [anchorAsset.composition.arrangement];
      const fittingLayouts = layouts.filter(layout => compatible.some(c => c.composition.arrangement === 'either' || c.composition.arrangement === layout));
      const offsets = yawOffsets(anchorAsset, `anchor-${sequence}`);
      const originSignature = JSON.stringify([stage, fittingLayouts, offsets, ([0, 90, 180, 270] as Direction[]).flatMap(facing => offsets.map(offset => shape(anchorAsset.binding, facing + offset).signature))]);
      // Reuse measured origins when many catalog entries share native geometry. Asset identity,
      // weight, companion family and seeded ordering are still evaluated for every prefab.
      let origins = anchorOrigins.get(originSignature);
      if (!origins) {
        origins = [];
        for (const layout of fittingLayouts) {
          for (let row = area.row; row < area.row + area.height; row++) for (let x = area.x; x < area.x + area.width; x++) for (const facing of [0, 90, 180, 270] as Direction[]) for (const yawOffset of offsets) {
            if ((compositionCells.get(key({ x, row }))?.kind === 'focal') !== (stage === 'focal')) continue;
            const member = construct(anchorAsset, { x, row }, facing, [], yawOffset);
            if (!member || layout === 'wall' && !onWall(member, ((facing + 180) % 360) as Direction)) continue;
            const distance = Math.min(...member.prop.cells.map(c => distances[c.row * map.width + c.x]));
            const preference = member.prop.cells.reduce((n, c) => n + (compositionCells.get(key(c))?.preference ?? 0), 0) / member.prop.cells.length;
            origins.push({ prop: member.prop, facing, layout, baseScore: preference * 4 + .25 * distance / spacingRadius + (yawOffset === offsets[0] ? .2 : 0) });
          }
        }
        anchorOrigins.set(originSignature, origins);
      }
      const companionsByLayout = new Map(fittingLayouts.map(layout => [layout, compatible.filter(c => c.composition.arrangement === 'either' || c.composition.arrangement === layout)]));
      const positions = origins.map(({ prop, facing, layout, baseScore }) => ({ facing, layout, companions: companionsByLayout.get(layout)!,
        member: { asset: anchorAsset, prop: { ...prop, bindingId: anchorAsset.binding.id, role: anchorAsset.binding.role as PropInstance['role'],
          blocksMovement: anchorAsset.binding.prop!.blocksMovement, category: anchorAsset.binding.prop!.category } },
        score: baseScore + .15 * hash(`${sequence}:${anchorAsset.binding.id}:${layout}:${prop.x},${prop.row}:${facing}`, seed) }));
      positions.sort((a, b) => b.score - a.score);
      for (const position of positions) {
        const { layout, companions } = position;
        const members: Member[] = [{ asset: anchorAsset, prop: { ...position.member.prop, offset: { ...position.member.prop.offset } } }];
        const focal = compositionCells.get(key(position.member.prop))?.kind === 'focal';
        const desired = Math.min(3200 - (map.propInstances?.length ?? 0), behaviorOf(anchorAsset.binding) === 'workSurface' ? 2 : focal ? 4 : 2 + Math.floor(hash(`${sequence}:members:${anchorAsset.binding.id}`, seed) * 2));
        for (let slot = 1; slot < desired; slot++) {
          let placed = false;
          const orderKey = JSON.stringify([anchorAsset.composition.usage, anchorAsset.composition.family, layout, position.facing, slot, members.map(m => m.prop.bindingId)]);
          let ordered = companionOrders.get(orderKey);
          if (!ordered) {
            const equivalent = new Set<string>();
            ordered = order(companions, `companion-${sequence}-${slot}`, members).filter(asset => {
              const facing = (behaviorOf(asset.binding) === 'seat' ? (position.facing + 180) % 360 : position.facing) as Direction;
              const signature = JSON.stringify([behaviorOf(asset.binding), asset.binding.role, asset.binding.prop!.blocksMovement,
                yawOffsets(asset, `companion-${sequence}-${slot}`).map(offset => shape(asset.binding, facing + offset).signature)]);
              if (equivalent.has(signature)) return false;
              equivalent.add(signature); return true;
            });
            companionOrders.set(orderKey, ordered);
          }
          const needsProgress = !members.some(m => needs(m.prop.role!));
          const memberGeometry = members.map(m => [m.prop.x, m.prop.row, propYaw(m.prop), shape(m.asset.binding, propYaw(m.prop)).signature]);
          const failurePrefix = JSON.stringify([layout, position.facing, slot, memberGeometry]) + ':';
          for (const asset of ordered) {
            if ((slot > 1 || needsProgress) && !needs(asset.binding.role)) continue;
            const seat = behaviorOf(asset.binding) === 'seat', facing = (seat ? (position.facing + 180) % 360 : position.facing) as Direction;
            for (const yawOffset of yawOffsets(asset, `companion-${sequence}-${slot}`)) {
              const failureKey = failurePrefix + behaviorOf(asset.binding) + ':' + shape(asset.binding, facing + yawOffset).signature;
              if (failedCompanions.has(failureKey)) continue;
              for (const candidate of companionOrigins(members[0], asset, facing, yawOffset, layout, members, `${sequence}:${slot}`)) {
                const child = construct(asset, candidate.c, facing, members, yawOffset);
                if (!child || !seat && layout === 'wall' && !onWall(child, ((position.facing + 180) % 360) as Direction)) continue;
                const parentOffset = { ...candidate.parent.prop.offset };
                if (seat && !alignSeat(candidate.parent, child, candidate.side)) continue;
                tighten(candidate.parent, child, candidate.side, members.length === 1);
                if (seat && !facesSurface(candidate.parent, child)) { candidate.parent.prop.offset = parentOffset; continue; }
                members.push(child); placed = true; break;
              }
              if (placed) break;
              failedCompanions.add(failureKey);
            }
            if (placed) break;
          }
          if (!placed) break;
        }
        for (let length = members.length; length >= 2; length--) {
          const chosen = members.slice(0, length), blockers = chosen.filter(m => m.prop.blocksMovement).flatMap(m => m.prop.cells);
          // Shrinking a rejected group must not discard its only still-needed role.
          if (!chosen.some(m => needs(m.prop.role!))) continue;
          if (chosen.some(m => overlapsFixture(m.prop, m.asset.binding))) continue;
          // A workstation is accepted with its seat, and all usable sides remain on clear,
          // reachable level floor. Later groups reserve these same cells before fitting.
          const hasSeat = chosen.some(m => behaviorOf(m.asset.binding) === 'seat');
          if (behaviorOf(anchorAsset.binding) === 'workSurface' && !hasSeat) continue;
          const occupied = new Set(chosen.flatMap(m => m.prop.cells.map(key)));
          const access = chosen.flatMap(m => behaviorOf(m.asset.binding) === 'workSurface' && hasSeat ? []
            : propAccessCells(m.prop, m.asset.binding, radius, map.cellSize, behaviorOf(m.asset.binding)).map(c => ({ ...c, base: map.elevations[m.prop.row][m.prop.x] })));
          if (access.some(c => map.rows[c.row]?.[c.x] !== '.' || occupied.has(key(c)) || currentOccupied.has(key(c)) || fixtureCells.has(key(c))
            || Math.abs(map.elevations[c.row]?.[c.x] - c.base) > 1e-6 || (roofs.get(key(c)) ?? Infinity) - c.base < (d.headroom ?? 2)
            || fixtureVolumes.some(v => Math.abs((c.x - (map.width - 1) / 2) * map.cellSize - v.x) < radius + v.width / 2 - 1e-6
              && Math.abs(((map.height - 1) / 2 - c.row) * map.cellSize - v.z) < radius + v.depth / 2 - 1e-6
              && c.base < v.y + v.height / 2 - 1e-6 && c.base + (d.headroom ?? 2) > v.y - v.height / 2 + 1e-6))) {
            accessFailed = true; failure = '설비 앞 또는 의자 뒤의 평평하고 접근 가능한 사용 공간이 부족합니다.'; continue;
          }
          const tacticKey = blockers.map(key).sort().join(';');
          if (blockers.length && evaluate && !tactics.has(tacticKey)) tactics.set(tacticKey, evaluate(blockers));
          const tactic = tactics.get(tacticKey);
          if (layout === 'island' && blockers.length && evaluate && !tactic) continue;
          const trial = structuredClone(map), trialRows = trial.rows.map(r => [...r]);
          let groupId = `group_${sequence}_${position.member.prop.x}_${position.member.prop.row}`;
          for (let suffix = 1; usedIds.has(groupId); suffix++) groupId = `group_${sequence}_${position.member.prop.x}_${position.member.prop.row}_g${suffix}`;
          const placed = chosen.map((m, index) => {
            const p = structuredClone(m.prop); p.groupId = groupId; p.id = `${groupId}_${index}`;
            for (let suffix = 1; usedIds.has(p.id); suffix++) p.id = `${groupId}_${index}_p${suffix}`;
            for (const c of p.cells) if (p.blocksMovement) trialRows[c.row][c.x] = 'P';
            return p;
          });
          trial.rows = trialRows.map(r => r.join('')); trial.propInstances = [...(trial.propInstances ?? []), ...placed]; trial.version = 5;
          const errors = [...propValidationIssues(trial, bindings), ...analyzeLevelDesign(trial, settings).issues, ...wallMountIssues(trial, bindings), ...teleportIssues(trial, bindings)].filter(i => i.severity === 'error');
          if (errors.length) { failure = errors[0].message; continue; }
          if (!connected(trial)) { failure = '군집 배치 후 기존 바닥 동선이 나뉩니다.'; continue; }
          if (accept && !accept(trial)) { failure = '기존 배치의 보호 조건을 함께 유지할 수 없습니다.'; continue; }
          map = trial; sequence++; usedIds.add(groupId); placed.forEach(p => {
            usedIds.add(p.id);
            if (roleOf(p) === 'prop' && p.blocksMovement) usedArea += clippedArea(p);
            if (roleOf(p) === 'decoration') decorations++;
            if (roleOf(p) === 'vegetation') vegetation++;
          });
          for (const route of tactic?.routes ?? []) for (const c of route) reserved.set(key(c), c);
          for (const { x, row } of access) { const c = { x, row }; reserved.set(key(c), c); if (!composition.reservedCells.some(p => p.x === x && p.row === row)) composition.reservedCells.push(c); }
          return true;
        }
      }
    }
    return false;
  };
  while (needsAny() && (map.propInstances?.length ?? 0) <= 3198) if (!addGroup()) break;
  if (needsAny()) {
    if (accessFailed) issues.push({ severity: 'warning', code: 'grouped-props-access-unavailable', message: '설비 앞·의자 뒤 사용 공간이 막히는 후보는 생략했습니다. 같은 높이의 비어 있는 접근 공간이 필요합니다.' });
    const achieved = [
      ...(d.props ? [`소품 바닥 점유율 ${(floorArea ? usedArea / floorArea * 100 : 0).toFixed(2)}% / 목표 ${d.propCoverage ?? 12}%`] : []),
      ...(d.decorations ? [`장식 ${decorations}개 / 목표 ${targetDecorations}개`] : []),
      ...(d.vegetation ? [`식생 ${vegetation}개 / 목표 ${targetVegetation}개`] : []),
    ].join(' · ');
    const reason = (map.propInstances?.length ?? 0) > 3198 ? '전체 소품 인스턴스 한도 3,200개 안에서 완전한 군집을 더 배치할 수 없습니다.'
      : `중심 장면·성긴 보조 배치·여백${composition.quietCells.length ? ` ${composition.quietCells.length}칸` : ''}과 크기·군집 짝·벽면·간격·출입구·회피·통행·설비와 좌석의 사용 공간을 함께 보존할 수 있는 추가 군집을 찾지 못했습니다.${failure ? ` ${failure}` : ''}`;
    issues.push({ severity: 'warning', code: 'grouped-props-unmet', message: `${achieved}. ${reason}` });
  }
  return { map, issues, composition };
}
