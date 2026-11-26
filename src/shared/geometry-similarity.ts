import type { Cell, Direction, GridMap } from './types';
import { connectionCells } from './connections';

const directionVectors: Record<Direction, readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
const tile = (value: string): string => value === 'P' ? '.' : value;
const sorted = (values: unknown[][]): string[] => values.map(value => JSON.stringify(value)).sort();
const openingCenter = (map: GridMap, connection: GridMap['connections'][number]): Cell => {
  const cells = connectionCells(map, connection);
  return { x: (cells[0].x + cells[cells.length - 1].x) / 2, row: (cells[0].row + cells[cells.length - 1].row) / 2 };
};

/** Exact structural identity excludes movable props, names, IDs and gameplay/decorative layers. */
export function variantGeometryKey(map: GridMap): string {
  const bounds = boundsFor(map), orientations: string[] = [];
  for (const mirror of [false, true]) for (let rotation = 0; rotation < 4; rotation++) {
    const width = rotation % 2 ? bounds.height : bounds.width, height = rotation % 2 ? bounds.width : bounds.height;
    const point = (c: Cell): [number, number] => {
      let x = c.x - bounds.minX, row = c.row - bounds.minRow, w = bounds.width, h = bounds.height;
      if (mirror) x = bounds.width - 1 - x;
      for (let i = 0; i < rotation; i++) { [x, row] = [h - 1 - row, x]; [w, h] = [h, w]; }
      return [x, row];
    };
    const direction = (d: Direction): Direction => (((mirror ? (360 - d) % 360 : d) + rotation * 90) % 360) as Direction;
    const rows = Array.from({ length: height }, () => Array<string>(width).fill('_'));
    const elevations = Array.from({ length: height }, () => Array<number>(width).fill(0));
    for (let row = bounds.minRow; row < bounds.minRow + bounds.height; row++) for (let x = bounds.minX; x < bounds.minX + bounds.width; x++) {
      const [tx, tr] = point({ x, row }); rows[tr][tx] = tile(map.rows[row][x]);
      if (rows[tr][tx] !== '_') elevations[tr][tx] = map.elevations[row][x];
    }
    orientations.push(JSON.stringify({
      width, height, cellSize: map.cellSize, rows: rows.map(r => r.join('')), elevations,
      ramps: sorted(map.ramps.map(r => [...point(r), direction(r.direction), r.rise, r.kind ?? 'stair'])),
      bridges: sorted((map.bridges ?? []).map(b => [...point(b), direction(b.direction) % 180])),
      connections: sorted(map.connections.map(c => [...point(openingCenter(map, c)), direction(c.direction), c.width, c.height])),
      ceilings: sorted((map.ceilings ?? []).map(c => [...point(c), c.undersideY])),
      walls: sorted((map.wallHeights ?? []).map(w => [...point(w), w.height])),
      cliffs: sorted((map.cliffs ?? []).map(c => [...point(c), direction(c.direction), c.depth])),
    }));
  }
  return orientations.sort()[0];
}

interface Bounds { minX: number; minRow: number; width: number; height: number }
function boundsFor(map: GridMap): Bounds {
  let minX = map.width, minRow = map.height, maxX = -1, maxRow = -1;
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) if (map.rows[row][x] !== '_') { minX = Math.min(minX, x); minRow = Math.min(minRow, row); maxX = Math.max(maxX, x); maxRow = Math.max(maxRow, row); }
  return maxX < 0 ? { minX: 0, minRow: 0, width: 1, height: 1 } : { minX, minRow, width: maxX - minX + 1, height: maxRow - minRow + 1 };
}

interface MovementMetadata { ramps: Map<number, GridMap['ramps'][number]>; bridges: Map<number, NonNullable<GridMap['bridges']>[number]> }
function edgeHeight(map: GridMap, x: number, row: number, dx: number, dr: number, metadata: MovementMetadata): number | undefined {
  const t = tile(map.rows[row]?.[x] ?? '_');
  if (!'.DRB'.includes(t)) return undefined;
  const y = map.elevations[row][x];
  if (t === 'B') {
    const bridge = metadata.bridges.get(row * map.width + x);
    if (!bridge) return undefined;
    const [bx, br] = directionVectors[bridge.direction];
    if (bx * dr !== br * dx) return undefined;
  }
  if (t !== 'R') return y;
  const ramp = metadata.ramps.get(row * map.width + x);
  if (!ramp) return undefined;
  const [ax, ar] = directionVectors[ramp.direction];
  return ax === dx && ar === dr ? y + ramp.rise : ax === -dx && ar === -dr ? y : undefined;
}

interface DoorMetric { reachable: number; meanDistance: number; maxDistance: number; pairs: number[] }
function doorMetrics(map: GridMap, bounds: Bounds): DoorMetric[] {
  const key = (x: number, row: number) => row * map.width + x;
  const metadata: MovementMetadata = { ramps: new Map(map.ramps.map(r => [key(r.x, r.row), r])), bridges: new Map((map.bridges ?? []).map(b => [key(b.x, b.row), b])) };
  const graph = new Map<number, number[]>();
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) if ('.DRB'.includes(tile(map.rows[row][x]))) {
    const edges: number[] = [];
    for (const [dx, dr] of Object.values(directionVectors)) {
      const a = edgeHeight(map, x, row, dx, dr, metadata), b = edgeHeight(map, x + dx, row + dr, -dx, -dr, metadata);
      if (a !== undefined && b !== undefined && Math.abs(a - b) <= map.maxStepHeight + 1e-8) edges.push(key(x + dx, row + dr));
    }
    graph.set(key(x, row), edges);
  }
  const span = Math.max(bounds.width, bounds.height) * map.cellSize;
  return map.connections.map(door => {
    // Door metadata names the first opening cell, whose side reverses under reflection.
    // Start from the complete opening so equivalent wide doors have equivalent routes.
    const queue = connectionCells(map, door).map(c => key(c.x, c.row)).filter(k => graph.has(k)), distances = new Map<number, number>(queue.map(k => [k, 0]));
    if (!queue.length) return { reachable: 0, meanDistance: 0, maxDistance: 0, pairs: map.connections.map(() => -1) };
    for (let i = 0; i < queue.length; i++) for (const next of graph.get(queue[i]) ?? []) if (!distances.has(next)) { distances.set(next, distances.get(queue[i])! + map.cellSize); queue.push(next); }
    const values = [...distances.values()];
    return { reachable: distances.size / Math.max(1, graph.size), meanDistance: values.reduce((sum, n) => sum + n, 0) / values.length / span, maxDistance: Math.max(...values) / span, pairs: map.connections.map(other => {
      const d = Math.min(...connectionCells(map, other).map(c => distances.get(key(c.x, c.row)) ?? Infinity));
      return Number.isFinite(d) ? d / span : -1;
    }) };
  });
}

interface FeaturePoint { x: number; row: number; direction: number; values: number[]; kind?: string }
interface GeometryView {
  footprint: Uint8Array; floor: Uint8Array; elevations: Float64Array;
  doors: FeaturePoint[]; stairs: FeaturePoint[]; doorMetrics: DoorMetric[];
  physicalArea: number; walls: number[]; ceilings: number[]; cliffs: number[];
}
const RESOLUTION = 32;

function viewFor(map: GridMap, bounds: Bounds, rotation = 0, mirror = false, metrics = doorMetrics(map, bounds)): GeometryView {
  const turned = rotation % 2 === 1, width = turned ? bounds.height : bounds.width, height = turned ? bounds.width : bounds.height;
  const longest = Math.max(width, height), pixelWidth = width / longest * RESOLUTION, pixelHeight = height / longest * RESOLUTION;
  const offsetX = (RESOLUTION - pixelWidth) / 2, offsetRow = (RESOLUTION - pixelHeight) / 2;
  const transform = (x: number, row: number): [number, number] => {
    x -= bounds.minX; row -= bounds.minRow;
    if (mirror) x = bounds.width - 1 - x;
    let w = bounds.width, h = bounds.height;
    for (let turn = 0; turn < rotation; turn++) { [x, row] = [h - 1 - row, x]; [w, h] = [h, w]; }
    return [x, row];
  };
  const rotateDirection = (direction: Direction): Direction => {
    let [dx, dr] = directionVectors[direction];
    if (mirror) dx = -dx;
    for (let turn = 0; turn < rotation; turn++) [dx, dr] = [-dr, dx];
    return Number(Object.entries(directionVectors).find(([, v]) => v[0] === dx && v[1] === dr)![0]) as Direction;
  };
  const point = (c: Cell & { direction: Direction }, values: number[], kind?: string): FeaturePoint => {
    const [x, row] = transform(c.x, c.row);
    return { x: (offsetX + (x + .5) / longest * RESOLUTION) / RESOLUTION, row: (offsetRow + (row + .5) / longest * RESOLUTION) / RESOLUTION, direction: rotateDirection(c.direction), values, ...(kind ? { kind } : {}) };
  };
  const rawTiles = Array.from({ length: height }, () => Array<string>(width).fill('_'));
  const rawHeights = Array.from({ length: height }, () => Array<number>(width).fill(0));
  let floorCount = 0;
  for (let row = bounds.minRow; row < bounds.minRow + bounds.height; row++) for (let x = bounds.minX; x < bounds.minX + bounds.width; x++) {
    const [tx, tr] = transform(x, row), t = tile(map.rows[row][x]);
    rawTiles[tr][tx] = t; rawHeights[tr][tx] = map.elevations[row][x];
    if ('.DRB'.includes(t)) floorCount++;
  }
  const footprint = new Uint8Array(RESOLUTION ** 2), floor = new Uint8Array(RESOLUTION ** 2), elevations = new Float64Array(RESOLUTION ** 2);
  for (let row = 0; row < RESOLUTION; row++) for (let x = 0; x < RESOLUTION; x++) {
    const sx = Math.floor((x + .5 - offsetX) / RESOLUTION * longest), sr = Math.floor((row + .5 - offsetRow) / RESOLUTION * longest);
    if (sx < 0 || sr < 0 || sx >= width || sr >= height) continue;
    const index = row * RESOLUTION + x, t = rawTiles[sr][sx];
    footprint[index] = Number(t !== '_'); floor[index] = Number('.DRB'.includes(t)); elevations[index] = t === '_' ? 0 : rawHeights[sr][sx];
  }
  const doorEntries = map.connections.map((d, index) => ({ point: point({ ...openingCenter(map, d), direction: d.direction }, [d.width, d.height]), index })).sort((a, b) => a.point.row - b.point.row || a.point.x - b.point.x || a.point.direction - b.point.direction);
  return { footprint, floor, elevations, doors: doorEntries.map(d => d.point), stairs: map.ramps.map(r => point(r, [r.rise], r.kind ?? 'stair')), doorMetrics: doorEntries.map(d => ({ ...metrics[d.index], pairs: doorEntries.map(other => metrics[d.index].pairs[other.index]) })), physicalArea: floorCount * map.cellSize ** 2,
    walls: (map.wallHeights ?? []).map(w => w.height).sort((a, b) => a - b), ceilings: (map.ceilings ?? []).map(c => c.undersideY).sort((a, b) => a - b), cliffs: (map.cliffs ?? []).map(c => c.depth).sort((a, b) => a - b) };
}

const near = (a: number, b: number, absolute = .1, relative = .12): boolean => Math.abs(a - b) <= Math.max(absolute, Math.abs(a) * relative, Math.abs(b) * relative);
/** Source point index -> matched target point index. Share this association with route metrics. */
function pointMapping(a: FeaturePoint[], b: FeaturePoint[]): number[] | undefined {
  if (a.length !== b.length) return undefined;
  const tolerance = .055, bins = new Map<string, { other: FeaturePoint; i: number }[]>();
  const binKey = (x: number, row: number) => `${x}:${row}`;
  b.forEach((other, i) => {
    const k = binKey(Math.floor(other.x / tolerance), Math.floor(other.row / tolerance));
    const bin = bins.get(k); if (bin) bin.push({ other, i }); else bins.set(k, [{ other, i }]);
  });
  const edges = a.map(point => {
    const x = Math.floor(point.x / tolerance), row = Math.floor(point.row / tolerance), nearby: { other: FeaturePoint; i: number }[] = [];
    for (let dr = -1; dr <= 1; dr++) for (let dx = -1; dx <= 1; dx++) nearby.push(...(bins.get(binKey(x + dx, row + dr)) ?? []));
    return nearby.map(({ other, i }) => ({ other, i, distance: Math.hypot(point.x - other.x, point.row - other.row) }))
    .filter(({ other, distance }) => point.direction === other.direction && point.kind === other.kind && distance <= .055 && point.values.length === other.values.length && point.values.every((value, j) => near(value, other.values[j], .05, .05)))
    .sort((x, y) => x.distance - y.distance || x.i - y.i).map(v => v.i);
  });
  // Nearby flights can share tolerance neighborhoods. Matching must not depend on array order.
  const matched = new Map<number, number>();
  const assign = (index: number, visited: Set<number>): boolean => {
    for (const next of edges[index]) if (!visited.has(next)) {
      visited.add(next);
      if (!matched.has(next) || assign(matched.get(next)!, visited)) { matched.set(next, index); return true; }
    }
    return false;
  };
  if (!a.every((_, i) => assign(i, new Set()))) return undefined;
  const mapping = Array<number>(a.length);
  for (const [target, source] of matched) mapping[source] = target;
  return mapping;
}

export interface GeometrySimilarity {
  similar: boolean;
  silhouetteSimilarity: number;
  /** Matching height, stairs, doors and actual terrain-route relationships. */
  matchingRelationships: string[];
}

/** Compare cropped footprints under all rotations/reflections; cosmetics cannot increase variety. */
export function compareGeometry(a: GridMap, b: GridMap): GeometrySimilarity {
  const boundsA = boundsFor(a), boundsB = boundsFor(b), base = viewFor(a, boundsA), metricsB = doorMetrics(b, boundsB);
  let best: GeometrySimilarity = { similar: false, silhouetteSimilarity: 0, matchingRelationships: [] };
  for (const mirror of [false, true]) for (let rotation = 0; rotation < 4; rotation++) {
    const other = viewFor(b, boundsB, rotation, mirror, metricsB);
    let intersection = 0, union = 0, commonFloor = 0, sameFloor = 0, matchingHeights = 0;
    for (let i = 0; i < base.footprint.length; i++) {
      if (base.footprint[i] || other.footprint[i]) { union++; if (base.floor[i] === other.floor[i]) sameFloor++; }
      if (base.footprint[i] && other.footprint[i]) intersection++;
      if (base.floor[i] && other.floor[i]) { commonFloor++; if (near(base.elevations[i], other.elevations[i], .05, .025)) matchingHeights++; }
    }
    const silhouetteSimilarity = union ? intersection / union : 1;
    const relationships: string[] = [];
    // Tiny contour changes can add/remove ceiling or wall cells without changing their height design.
    const sameLayers = (x: number[], y: number[]) => {
      if (!x.length || !y.length) return x.length === y.length;
      if (!near(x.length, y.length, 2, .15)) return false;
      return Array.from({ length: Math.min(16, Math.max(x.length, y.length)) }, (_, i) => i).every((i, _, samples) => {
        const t = samples.length === 1 ? 0 : i / (samples.length - 1);
        return near(x[Math.round(t * (x.length - 1))], y[Math.round(t * (y.length - 1))], .05, .025);
      });
    };
    if ((!commonFloor || matchingHeights / commonFloor >= .95) && sameLayers(base.walls, other.walls) && sameLayers(base.ceilings, other.ceilings) && sameLayers(base.cliffs, other.cliffs)) relationships.push('높이');
    if (pointMapping(base.stairs, other.stairs)) relationships.push('계단 접근');
    const doors = pointMapping(base.doors, other.doors);
    if (doors) relationships.push('문 배치');
    const sameRoutes = doors && base.doorMetrics.length === other.doorMetrics.length && base.doorMetrics.every((route, i) => {
      const next = other.doorMetrics[doors[i]];
      return near(route.reachable, next.reachable, .025, .025) && near(route.meanDistance, next.meanDistance, .06) && near(route.maxDistance, next.maxDistance, .09) && route.pairs.length === next.pairs.length && route.pairs.every((n, j) => {
        const otherDistance = next.pairs[doors[j]];
        return (n < 0 || otherDistance < 0) ? n === otherDistance : near(n, otherDistance, .06);
      });
    });
    if ((!union || sameFloor / union >= .93) && sameRoutes && near(base.physicalArea, other.physicalArea, a.cellSize ** 2, .15)) relationships.push('동선 관계');
    const result = { similar: silhouetteSimilarity >= .9 && relationships.length === 4, silhouetteSimilarity, matchingRelationships: relationships };
    if (result.similar && !best.similar || result.similar === best.similar && (result.silhouetteSimilarity > best.silhouetteSimilarity || result.silhouetteSimilarity === best.silhouetteSimilarity && relationships.length > best.matchingRelationships.length)) best = result;
  }
  return best;
}

/** Compact, injection-free geometry data for the next image request (never layout extraction). */
export function summarizeGeometry(map: GridMap): string {
  const bounds = boundsFor(map), view = viewFor(map, bounds);
  const round = (n: number) => Number(n.toFixed(2));
  const outline = Array.from({ length: 12 }, (_, row) => Array.from({ length: 12 }, (_, x) => {
    const i = Math.min(31, Math.floor((row + .5) / 12 * 32)) * 32 + Math.min(31, Math.floor((x + .5) / 12 * 32));
    return !view.footprint[i] ? '_' : view.floor[i] ? '.' : '#';
  }).join(''));
  const heights = new Map<number, number>();
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) if ('.DRB'.includes(tile(map.rows[row][x]))) heights.set(map.elevations[row][x], (heights.get(map.elevations[row][x]) ?? 0) + 1);
  return JSON.stringify({ extentMeters: [round(bounds.width * map.cellSize), round(bounds.height * map.cellSize)], usableArea: round(view.physicalArea), outline, heights: [...heights].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 8).map(([y, n]) => [round(y), n]), heightCount: heights.size, stairs: view.stairs.slice(0, 8).map(s => [round(s.x), round(s.row), s.direction, ...s.values.map(round)]), stairCount: view.stairs.length,
    doors: view.doors.slice(0, 16).map(d => [round(d.x), round(d.row), d.direction, ...d.values.map(round)]), routes: view.doorMetrics.slice(0, 16).map(d => [round(d.reachable), round(d.meanDistance), round(d.maxDistance)]) });
}
