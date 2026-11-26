import { connectionCells } from './connections';
import { analyzeLevelDesign } from './level-design';
import { protectedPropIds } from './prop-groups';
import { effectivePropCompositions } from './prop-composition';
import { propFootprint, propWorldSize } from './props';
import type { AssetBinding, Cell, Direction, GenerationSettings, GridMap } from './types';
import { compatiblePropBehaviors, effectivePropBehavior, groupedYawOffsets, propAccessCells } from './prop-behavior';

export interface CompositionArea { center: Cell; cells: Cell[] }
export interface CompositionCell extends Cell { kind: 'focal' | 'support' | 'quiet'; preference: number }
/** A transient layout, shared by furnishing and wall services; never serialized into the map. */
export interface RoomCompositionPlan {
  focal?: CompositionArea;
  supports: CompositionArea[];
  quietCells: Cell[];
  quietPatches: CompositionArea[];
  zones: CompositionCell[];
  reservedCells: Cell[];
}
const key = (cell: Cell) => `${cell.x},${cell.row}`;
const neighbors = (c: Cell): Cell[] => [{ x: c.x - 1, row: c.row }, { x: c.x + 1, row: c.row }, { x: c.x, row: c.row - 1 }, { x: c.x, row: c.row + 1 }];
const sample = (value: string, seed: number) => {
  let n = seed >>> 0;
  for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  n = Math.imul(n ^ n >>> 16, 0x85ebca6b); n = Math.imul(n ^ n >>> 13, 0xc2b2ae35);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
};

/** Generated furniture must not move the design anchors on the next additive/rearrange pass. */
export function compositionTerrain(source: GridMap): GridMap {
  const map = structuredClone(source), protectedIds = protectedPropIds(source);
  const movable = (source.propInstances ?? []).filter(p => p.provenance === 'generated' && !protectedIds.has(p.id));
  const movableIds = new Set(movable.map(p => p.id));
  map.propInstances = (map.propInstances ?? []).filter(p => !movableIds.has(p.id));
  const fixed = new Set((map.propInstances ?? []).flatMap(p => p.cells.map(key)));
  const protectedCells = new Set([...(map.lockedCells ?? []), ...map.assetOverrides.filter(o => o.role === 'prop')].map(key));
  const rows = map.rows.map(r => [...r]);
  // Raw image prop intentions are not measured geography either.
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const k = key({ x, row });
    if (rows[row][x] === 'P' && !fixed.has(k) && !protectedCells.has(k)) rows[row][x] = '.';
  }
  map.rows = rows.map(r => r.join(''));
  return map;
}

function components(cells: Cell[]): Cell[][] {
  const pending = new Map(cells.map(c => [key(c), c])), result: Cell[][] = [];
  while (pending.size) {
    const start = pending.values().next().value! as Cell, group: Cell[] = [start]; pending.delete(key(start));
    for (let i = 0; i < group.length; i++) for (const next of neighbors(group[i])) {
      if (pending.delete(key(next))) group.push(next);
    }
    result.push(group);
  }
  return result;
}

/** Compact geodesic growth follows real walls/reservations rather than drawing rectangular thirds. */
function grow(center: Cell, cells: Cell[], count: number): Cell[] {
  const allowed = new Set(cells.map(key)), visited = new Set([key(center)]), queue = [center];
  for (let i = 0; i < queue.length && queue.length < count; i++) {
    const adjacent = neighbors(queue[i]).sort((a, b) => Math.hypot(a.x - center.x, a.row - center.row) - Math.hypot(b.x - center.x, b.row - center.row) || a.row - b.row || a.x - b.x);
    for (const next of adjacent) if (allowed.has(key(next)) && !visited.has(key(next))) {
      visited.add(key(next)); queue.push(next); if (queue.length >= count) break;
    }
  }
  return queue;
}

function floorDistances(starts: Cell[], floor: Set<string>): Map<string, number> {
  const queue = [...starts], distances = new Map(starts.map(c => [key(c), 0]));
  for (let i = 0; i < queue.length; i++) for (const c of neighbors(queue[i])) if (floor.has(key(c)) && !distances.has(key(c))) {
    distances.set(key(c), distances.get(key(queue[i]))! + 1); queue.push(c);
  }
  return distances;
}

/** Plans the whole room even when a later placement operation is restricted to a small region. */
export function planRoomComposition(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], reserved: Cell[] = []): RoomCompositionPlan {
  const map = compositionTerrain(source), baseline = analyzeLevelDesign(map, settings), seed = settings.seed ?? 0;
  const reservedCells = [...new Map([...reserved, ...baseline.reservedEntryCells, ...baseline.combatCells, ...baseline.routes.flat(),
    ...(map.lockedCells ?? []), ...(map.markers ?? []), ...map.connections.flatMap(c => connectionCells(map, c)),
    ...(map.fixtures ?? []).filter(f => !f.wall && (f.anchor ?? 'floor') === 'floor'),
    ...(map.propInstances ?? []).flatMap(p => { const b = bindings.find(b => b.id === p.bindingId); return [...p.cells, ...(b ? propAccessCells(p, b, settings.levelDesign?.characterRadius ?? .4, map.cellSize) : [])]; }),
    ...(map.zones ?? []).filter(z => ['reward', 'rest'].includes(z.kind))].map(c => [key(c), { x: c.x, row: c.row }])).values()];
  const forbidden = new Set(reservedCells.map(key)), floor: Cell[] = [], available: Cell[] = [];
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) if (map.rows[row][x] === '.') {
    const c = { x, row }; floor.push(c); if (!forbidden.has(key(c))) available.push(c);
  }
  const empty: RoomCompositionPlan = { supports: [], quietCells: [], quietPatches: [], zones: [], reservedCells };
  if (available.length < 2) return empty;
  const d = settings.designer, theme = settings.levelDesign?.theme?.trim().toLowerCase();
  // Use the same eligible geometry as the measured group placer. Wall/ceiling assets and
  // nonblocking "prop" registrations must not enlarge focal patches or erase breathing room.
  const candidateCatalog = bindings.filter(b => !b.wallMount && b.prop?.size && b.prop.weight > 0 && b.prop.placement === 'floor' && effectivePropBehavior(b) !== 'surfaceAccessory'
    && (b.role !== 'prop' || b.prop.blocksMovement) && (!d || b.prop.roomTypes.includes(d.preset))
    && (!theme || !b.prop.tags.length || b.prop.tags.some(t => t.toLowerCase() === theme))
    && effectivePropCompositions(b).some(c => ['equipment', 'storage', 'natural'].includes(c.usage) && c.family.trim())
    && (b.role === 'prop' ? d?.props : b.role === 'decoration' ? d?.decorations : b.role === 'vegetation' && d?.vegetation));
  const catalog = candidateCatalog.filter(b => !['workSurface', 'seat'].includes(effectivePropBehavior(b)) || candidateCatalog.some(other =>
    (effectivePropBehavior(b) === 'seat' ? compatiblePropBehaviors(other, b) : compatiblePropBehaviors(b, other))
    && effectivePropCompositions(b).some(c => effectivePropCompositions(other).some(o => c.usage === o.usage && c.family === o.family))));
  const floorSet = new Set(floor.map(key)), availableSet = new Set(available.map(key));
  // Manhattan clearance can be calculated once by a multi-source flood, without a cell-pair search.
  const clearance = new Map<string, number>(), edge = floor.filter(c => neighbors(c).some(n => !floorSet.has(key(n))));
  for (const c of edge) clearance.set(key(c), 1);
  for (let i = 0; i < edge.length; i++) for (const n of neighbors(edge[i])) if (floorSet.has(key(n)) && !clearance.has(key(n))) {
    clearance.set(key(n), clearance.get(key(edge[i]))! + 1); edge.push(n);
  }
  const maxClearance = Math.max(1, ...clearance.values()), entries = map.connections.flatMap(c => connectionCells(map, c));
  const span = Math.max(1, Math.hypot(map.width, map.height));
  const visible = (a: Cell, b: Cell) => {
    const steps = Math.max(Math.abs(a.x - b.x), Math.abs(a.row - b.row));
    for (let i = 1; i < steps; i++) {
      const x = Math.round(a.x + (b.x - a.x) * i / steps), row = Math.round(a.row + (b.row - a.row) * i / steps);
      if (!'.PDR'.includes(map.rows[row]?.[x] ?? '_')) return false;
    }
    return true;
  };
  const localSpace = (c: Cell) => {
    let count = 0;
    for (let dr = -2; dr <= 2; dr++) for (let dx = -2; dx <= 2; dx++) if (availableSet.has(key({ x: c.x + dx, row: c.row + dr }))) count++;
    return count / 25;
  };
  const roofs = new Map((map.ceilings ?? []).map(c => [key(c), c.undersideY]));
  const measuredShapes = catalog.flatMap(binding => effectivePropCompositions(binding).filter(c => ['equipment', 'storage', 'natural'].includes(c.usage))
    .flatMap(composition => ([0, 90, 180, 270] as Direction[]).flatMap(direction => groupedYawOffsets(binding, composition, seed, 'anchor-0').map(yawOffset => {
      const size = propWorldSize(binding, direction + yawOffset)!;
      return { binding, composition, direction, yawOffset, size };
    }))));
  const shapeKey = (shape: typeof measuredShapes[number]) => JSON.stringify([shape.size, shape.binding.offset, shape.composition.arrangement, shape.direction]);
  const anchorShapes = [...new Map(measuredShapes.filter(s => s.composition.member !== 'companion' && effectivePropBehavior(s.binding) !== 'seat').map(shape => [shapeKey(shape), shape])).values()];
  const fitsOrigin = (origin: Cell, { binding, composition, direction, size }: typeof measuredShapes[number]) => {
    if (size.x > map.width * map.cellSize || size.z > map.height * map.cellSize) return false;
    const cells = propFootprint(map, origin, size), base = map.elevations[origin.row]?.[origin.x];
    if (binding.offset.y < 0 || cells.some(c => !availableSet.has(key(c)) || Math.abs(map.elevations[c.row]?.[c.x] - base) > 1e-6
      || (roofs.get(key(c)) ?? Infinity) - base < size.y + binding.offset.y)) return false;
    const width = Math.max(...cells.map(c => c.x)) - origin.x + 1, height = Math.max(...cells.map(c => c.row)) - origin.row + 1;
    if (Math.abs(binding.offset.x) > (width * map.cellSize - size.x) / 2 + 1e-6 || Math.abs(binding.offset.z) > (height * map.cellSize - size.z) / 2 + 1e-6) return false;
    if (composition.arrangement !== 'wall' || effectivePropBehavior(binding) === 'seat') return true;
    const back = ((direction + 180) % 360) as Direction;
    const dx = back === 90 ? 1 : back === 270 ? -1 : 0, dr = back === 180 ? 1 : back === 0 ? -1 : 0;
    return cells.filter(c => back === 0 ? c.row === origin.row : back === 180 ? c.row === origin.row + height - 1 : back === 90 ? c.x === origin.x + width - 1 : c.x === origin.x)
      .every(c => map.rows[c.row + dr]?.[c.x + dx] === '#');
  };
  const canAnchor = (origin: Cell) => !anchorShapes.length || anchorShapes.some(shape => fitsOrigin(origin, shape));
  // Placement still considers every weighted prefab. Only statistical scene sizing ignores
  // geometry that cannot fit anywhere, so a few oversized registrations cannot erase all quiet
  // floor. This scan is cached once per measured shape/rotation, never repeated per placed prop.
  const possible = new Map<string, boolean>(), nativeFootprints = new Map<AssetBinding, number>();
  for (const shape of measuredShapes) {
    if (nativeFootprints.has(shape.binding)) continue;
    const signature = shapeKey(shape);
    if (!possible.has(signature)) possible.set(signature, available.some(origin => fitsOrigin(origin, shape)));
    if (possible.get(signature)) nativeFootprints.set(shape.binding,
      Math.max(1, Math.ceil(shape.size.x / map.cellSize - 1e-8)) * Math.max(1, Math.ceil(shape.size.z / map.cellSize - 1e-8)));
  }
  const statisticalCatalog = catalog.filter(b => nativeFootprints.has(b));
  const footprints = [...nativeFootprints.values()].sort((a, b) => a - b), nativeCells = footprints[Math.floor(footprints.length / 2)] ?? 1;
  const wallWeight = statisticalCatalog.length ? statisticalCatalog.filter(b => effectivePropCompositions(b).some(c => c.arrangement !== 'island')).length / statisticalCatalog.length : .5;
  const focalScore = (c: Cell) => {
    const adjacentWall = neighbors(c).some(n => map.rows[n.row]?.[n.x] === '#');
    const entranceDistance = entries.length ? Math.min(...entries.map(e => Math.hypot(c.x - e.x, c.row - e.row))) / span : .5;
    const visibility = entries.some(e => visible(e, c)) ? .35 : 0;
    return localSpace(c) + (adjacentWall ? wallWeight * 1.6 : (1 - wallWeight) * (clearance.get(key(c)) ?? 1) / maxClearance)
      + entranceDistance * .7 + visibility + sample(`focal:${c.x},${c.row}`, seed) * .3;
  };
  const ordered = available.filter(canAnchor).map(c => ({ c, score: focalScore(c) })).sort((a, b) => b.score - a.score || a.c.row - b.c.row || a.c.x - b.c.x);
  if (!ordered.length) return empty;
  const center = ordered[0].c;
  const focalCount = Math.max(nativeCells * 8, Math.round(Math.sqrt(available.length) * (1.8 + sample('focal-size', seed) * 1.2)));
  const focalCells = grow(center, available, focalCount), focalSet = new Set(focalCells.map(key));
  // A quiet patch is additional to mandatory circulation. Its physical scale follows room clearance,
  // room size and prefab footprints; there is no fixed fraction or fixed location across rooms.
  const quietCandidates = available.filter(c => !focalSet.has(key(c)));
  const quietGroups = components(quietCandidates).sort((a, b) => b.length - a.length);
  let quietCells: Cell[] = [];
  if (quietGroups.length && available.length >= Math.max(16, nativeCells * 8)) {
    const ranked = quietGroups.flatMap(cells => cells.map(c => ({ c, cells, score: (clearance.get(key(c)) ?? 1) / maxClearance
      + Math.hypot(c.x - center.x, c.row - center.row) / span + Math.min(cells.length, focalCount) / Math.max(1, focalCount) * .4
      + sample(`quiet:${c.x},${c.row}`, seed) * .15 }))).sort((a, b) => b.score - a.score || a.c.row - b.c.row || a.c.x - b.c.x);
    const quiet = ranked[0];
    const count = Math.max(4, nativeCells * 2, Math.round(Math.sqrt(floor.length) * (.8 + sample('quiet-size', seed) * .6)));
    quietCells = grow(quiet.c, quiet.cells, Math.min(count, quiet.cells.length));
  }
  // Secondary scenes occupy compact influences. Treating the entire remainder as one support
  // zone spreads small groups across every wall and fills away the room's visual hierarchy.
  const supports: CompositionArea[] = [], supportSet = new Set<string>();
  const unavailable = new Set([...focalCells, ...quietCells].map(key)), centers = [center];
  const excludeScene = (cells: Cell[]) => { for (const c of cells) for (const n of [c, ...neighbors(c)]) unavailable.add(key(n)); };
  excludeScene(focalCells);
  // Separation follows the usable room's physical scale and prefab footprints, not a quota of
  // scenes or groups. Larger scenes can hold as many complete native groups as safely fit.
  const separation = Math.max(5, Math.round(Math.sqrt(available.length) * (.48 + sample('scene-rhythm', seed) * .12)), Math.ceil(Math.sqrt(nativeCells) * 3));
  const rejected = new Set<string>();
  while (true) {
    const distances = floorDistances(centers, floorSet);
    const candidates = ordered.filter(({ c }) => !unavailable.has(key(c)) && !rejected.has(key(c)) && (distances.get(key(c)) ?? Infinity) >= separation)
      .map(({ c, score }) => ({ c, score: Math.min(separation * 1.8, distances.get(key(c)) ?? separation * 1.8) / separation + score * .35 + sample(`support:${c.x},${c.row}`, seed) * .5 }))
      .sort((a, b) => b.score - a.score || a.c.row - b.c.row || a.c.x - b.c.x);
    if (!candidates.length) break;
    const candidate = candidates[0].c;
    const count = Math.max(nativeCells * 6, Math.round(Math.sqrt(available.length) * (.9 + sample(`support-size:${candidate.x},${candidate.row}`, seed) * .45)));
    const cells = grow(candidate, available.filter(c => !unavailable.has(key(c))), count);
    if (cells.length < Math.max(4, nativeCells * 2)) { rejected.add(key(candidate)); continue; }
    supports.push({ center: candidate, cells }); centers.push(candidate);
    cells.forEach(c => supportSet.add(key(c))); excludeScene(cells);
  }
  quietCells = available.filter(c => !focalSet.has(key(c)) && !supportSet.has(key(c)));
  const quietSet = new Set(quietCells.map(key));
  const quietPatches = components(quietCells).sort((a, b) => b.length - a.length).map(cells => ({
    center: cells.reduce((best, c) => (clearance.get(key(c)) ?? 0) > (clearance.get(key(best)) ?? 0) ? c : best), cells,
  }));
  return { focal: { center, cells: focalCells }, supports, quietCells, quietPatches, reservedCells,
    zones: available.map(c => ({ ...c, kind: quietSet.has(key(c)) ? 'quiet' : focalSet.has(key(c)) ? 'focal' : 'support',
      preference: quietSet.has(key(c)) ? 0 : focalSet.has(key(c)) ? 3 + 1 / (1 + Math.hypot(c.x - center.x, c.row - center.row))
        : .5 + 1 / (1 + Math.min(...supports.map(s => Math.hypot(c.x - s.center.x, c.row - s.center.row)))) })) };
}
