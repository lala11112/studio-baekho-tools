import { connectionCells } from './connections';
import { spatialIntent } from './spatial-intent';
import type { Cell, Direction, GenerationRegion, GenerationSettings, GridMap, LevelDesignSettings, MapFixture, RoomPurpose, ValidationIssue } from './types';

/** Shared qualitative guidance from docs/level-design-principles.md; numeric recipes remain opt-in. */
export const LEVEL_DESIGN_PRINCIPLES = `DOCUMENTED LEVEL DESIGN PRINCIPLES (docs/level-design-principles.md):
Metrics: honor the configured player movement, body clearance, door dimensions and enabled features when defining achievable actions. Do not invent movement mechanics or numeric clearance thresholds.
Encounter: keep entry approaches usable, give the player an opportunity to assess an enabled encounter before committing, and support meaningful approach, retreat or recovery choices within the selected features.
Flow: keep external connections and mandatory objectives reachable through height-correct paths; preserve safe access that does not force crossing hazards. Gameplay choices must differ in their use or tradeoff, not merely in appearance.
Purpose: combat goals apply to battle/boss rooms only when the relevant gameplay is enabled. Start, reward and shop rooms prioritize safe preparation, collection or service access; do not add combat or disabled features to create variety.
These are qualitative gameplay principles, separate from optional numeric design recipes and their automatic checks. Treat concept writing as gameplay intent, blueprint generation as spatial design, and layout extraction as faithful interpretation of the image.`;

export const DEFAULT_LEVEL_DESIGN: LevelDesignSettings = { pattern: 'auto', characterRadius: .4, dodgeDistance: 3 };
export type DesignPattern = Exclude<LevelDesignSettings['pattern'], 'auto'>;
export const DESIGN_PATTERN_LABELS: Record<DesignPattern, string> = { openArena: '열린 전투장', flankingArena: '우회 전투장', raisedArena: '고저차 전투장' };
const directions: Record<Direction, readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
const key = (c: Cell): string => `${c.x},${c.row}`;
const cell = (k: string): Cell => { const [x, row] = k.split(',').map(Number); return { x, row }; };
const distance = (a: Cell, b: Cell): number => Math.hypot(a.x - b.x, a.row - b.row);

export function parseLevelDesignSettings(value: unknown): LevelDesignSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('레벨디자인 설정이 올바르지 않습니다.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['pattern', 'characterRadius', 'dodgeDistance', 'theme'].includes(k))) throw new Error('지원하지 않는 레벨디자인 설정입니다.');
  if (!['auto', 'openArena', 'flankingArena', 'raisedArena'].includes(String(v.pattern))) throw new Error('레벨디자인 패턴을 확인해 주세요.');
  for (const [name, low, high] of [['characterRadius', .1, 5], ['dodgeDistance', .25, 20]] as const)
    if (typeof v[name] !== 'number' || !Number.isFinite(v[name]) || v[name] < low || v[name] > high) throw new Error(`${name} 값은 ${low}~${high}m여야 합니다.`);
  if (v.theme !== undefined && (typeof v.theme !== 'string' || v.theme.length > 80 || /[\u0000-\u001f\u007f]/.test(v.theme))) throw new Error('테마 태그는 80자 이내의 텍스트여야 합니다.');
  return { pattern: v.pattern as LevelDesignSettings['pattern'], characterRadius: v.characterRadius as number, dodgeDistance: v.dodgeDistance as number, ...(v.theme === undefined ? {} : { theme: (v.theme as string).trim() }) };
}

export interface LevelDesignRecipe {
  pattern: DesignPattern; label: string; purpose: RoomPurpose; characterRadius: number; characterHeight: number;
  dodgeDistance: number; entryClearance: number; combatRequired: boolean; intent: string; prompt: string;
}

/** A shared local recipe is consumed verbatim by image generation and terrain extraction. */
export function compileLevelDesign(settings: GenerationSettings): LevelDesignRecipe {
  const config = settings.levelDesign ?? DEFAULT_LEVEL_DESIGN, d = settings.designer;
  const purpose = d?.preset ?? 'battle', combatRequired = purpose === 'battle' || purpose === 'boss';
  const allowed: DesignPattern[] = ['openArena'];
  if (combatRequired && d?.props) allowed.push('flankingArena');
  if (combatRequired && d?.elevation) allowed.push('raisedArena');
  const pattern = config.pattern === 'auto' ? allowed[(settings.seed ?? 0) % allowed.length] : config.pattern;
  if (!allowed.includes(pattern)) throw new Error('선택한 설계 패턴에 필요한 장애물 또는 높이 지형을 켜 주세요. 안전한 방은 열린 공간 패턴을 사용합니다.');
  const entryClearance = config.dodgeDistance + config.characterRadius;
  const intent = !combatRequired ? '안전하게 진입해 방의 목적물에 접근하는 공간' : pattern === 'flankingArena' ? '장애물 양쪽으로 돌아 접근 방향을 선택하는 전투' : pattern === 'raisedArena' ? '두 접근로로 고지를 공략하고 이탈할 수 있는 전투' : '진입 후 거리를 확보하고 회피하는 열린 전투';
  const terrain = pattern === 'flankingArena' ? 'Include an interior obstacle island and two genuinely separate walkable paths around opposite sides of it; perimeter walls do not count as this island.' : pattern === 'raisedArena' ? 'The main highest platform must have at least two separate stair approaches from lower land; adjacent stairs in one flight count as one approach.' : 'Reserve a broad unobstructed flat area; terrain features may remain elsewhere if enabled.';
  const prompt = `LOCAL LEVEL DESIGN RECIPE (seed ${settings.seed ?? 0}): ${pattern}; purpose ${purpose}. Player height ${d?.headroom ?? 2}m, radius ${config.characterRadius}m, dodge ${config.dodgeDistance}m. From EVERY external door reserve an inward approach ${entryClearance}m deep, without props, hazards, traps or enemy positions. Door openings must fit player width and height. ${combatRequired ? `Include a flat combat position with unobstructed north/east/south/west dodge sweeps of ${config.dodgeDistance}m plus ${config.characterRadius}m body clearance. ${terrain}` : 'Prioritize safe movement to rewards or services; no combat-space requirement.'} Keep all doors and mandatory objectives reachable through height-correct paths without crossing hazards. Leave requested props and fixtures outside reserved entry, route and dodge spaces. Do not flatten requested terrain or reduce requested content counts. These are blockout constraints; no numeric fun score is implied.`;
  return { pattern, label: DESIGN_PATTERN_LABELS[pattern], purpose, characterRadius: config.characterRadius, characterHeight: d?.headroom ?? 2, dodgeDistance: config.dodgeDistance, entryClearance, combatRequired, intent, prompt };
}

export type PlayerMovementGraph = Map<string, string[]>;
type Graph = PlayerMovementGraph;
function edgeHeight(map: GridMap, c: Cell, dx: number, dr: number): number | undefined {
  if (!'.DRB'.includes(map.rows[c.row]?.[c.x] ?? '_')) return undefined;
  const height = map.elevations[c.row][c.x];
  if (map.rows[c.row][c.x] === 'B') {
    const bridge = map.bridges?.find(b => b.x === c.x && b.row === c.row);
    if (!bridge) return undefined;
    const [ax, ar] = directions[bridge.direction];
    if (ax * dr !== ar * dx) return undefined;
  }
  if (map.rows[c.row][c.x] !== 'R') return height;
  const ramp = map.ramps.find(r => r.x === c.x && r.row === c.row);
  if (!ramp) return undefined;
  const [ax, ar] = directions[ramp.direction];
  return ax === dx && ar === dr ? height + ramp.rise : ax === -dx && ar === -dr ? height : undefined;
}
function movement(map: GridMap, a: Cell, b: Cell): boolean {
  const dx = b.x - a.x, dr = b.row - a.row;
  const ah = edgeHeight(map, a, dx, dr), bh = edgeHeight(map, b, -dx, -dr);
  return ah !== undefined && bh !== undefined && Math.abs(ah - bh) <= map.maxStepHeight + 1e-8;
}

/** Height-correct movement and body clearance, independent of combat and dodge requirements. */
export function playerMovementGraph(map: GridMap, recipe: Pick<LevelDesignRecipe, 'characterRadius' | 'characterHeight'>, extraBlocked = new Set<string>()): PlayerMovementGraph {
  const roofs = new Map((map.ceilings ?? []).map(c => [key(c), c.undersideY]));
  const rises = new Map(map.ramps.map(r => [key(r), r.rise]));
  const blocked = new Set(extraBlocked);
  for (const prop of map.propInstances ?? []) if (prop.blocksMovement) for (const c of prop.cells) blocked.add(key(c));
  for (const f of map.fixtures ?? []) if ((f.anchor ?? 'floor') === 'floor' && ['column', 'gate'].includes(f.role)) blocked.add(key(f));
  const walkable = new Set<string>();
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const c = { x, row }, k = key(c), tile = map.rows[row][x];
    if (!'.DRB'.includes(tile) || blocked.has(k)) continue;
    const top = map.elevations[row][x] + (rises.get(k) ?? 0), roof = roofs.get(k);
    if (roof !== undefined && roof - top < recipe.characterHeight - 1e-8) continue;
    const reach = Math.ceil(recipe.characterRadius / map.cellSize + .5);
    let clearance = true;
    for (let dr = -reach; dr <= reach && clearance; dr++) for (let dx = -reach; dx <= reach; dx++) {
      if (!dx && !dr) continue;
      const near = { x: x + dx, row: row + dr }, nearTile = map.rows[near.row]?.[near.x] ?? '_';
      // A door's outward plane is open; its exact opening width is checked separately.
      if (tile === 'D' && nearTile === '_') continue;
      const solid = !'.DRB'.includes(nearTile) || blocked.has(key(near)) || (tile !== 'R' && nearTile !== 'R' && Math.abs((map.elevations[near.row]?.[near.x] ?? Infinity) - map.elevations[row][x]) > map.maxStepHeight);
      const nearest = Math.hypot(Math.max(0, Math.abs(dx) - .5), Math.max(0, Math.abs(dr) - .5)) * map.cellSize;
      if (solid && nearest < recipe.characterRadius - 1e-8) { clearance = false; break; }
    }
    if (clearance) walkable.add(k);
  }
  const graph: Graph = new Map();
  for (const k of walkable) { const c = cell(k); graph.set(k, Object.values(directions).map(([dx, dr]) => ({ x: c.x + dx, row: c.row + dr })).filter(n => walkable.has(key(n)) && movement(map, c, n)).map(key)); }
  return graph;
}

const graphFor = playerMovementGraph;

export interface TacticalObstacle {
  cells: Cell[]; routes: [Cell[], Cell[]]; detourMeters: number; axis: 'eastWest' | 'northSouth';
}

/** Reuse one height/radius graph while inspecting candidate footprints; BFS stays in a local ring. */
export function createObstacleEvaluator(map: GridMap, settings: GenerationSettings): (cells: Cell[]) => TacticalObstacle | undefined {
  const recipe = compileLevelDesign(settings), graph = graphFor(map, recipe, new Set((map.fixtures ?? []).filter(f => f.role === 'hazard' || f.role === 'trap').map(key)));
  return cells => {
    if (!cells.length) return undefined;
    const xs = cells.map(c => c.x), rs = cells.map(c => c.row), minX = Math.min(...xs), maxX = Math.max(...xs), minR = Math.min(...rs), maxR = Math.max(...rs);
    const margin = Math.ceil(recipe.characterRadius / map.cellSize + .5), local: Graph = new Map(), blocked = new Set(cells.map(key));
    // Preserve the character's body clearance around the proposed complete footprint.
    for (let row = minR - margin; row <= maxR + margin; row++) for (let x = minX - margin; x <= maxX + margin; x++) {
      const c = { x, row }, k = key(c);
      const dx = Math.max(minX - .5 - x, 0, x - maxX - .5), dr = Math.max(minR - .5 - row, 0, row - maxR - .5);
      if (Math.hypot(dx, dr) * map.cellSize < recipe.characterRadius - 1e-8) blocked.add(k);
      if (graph.has(k)) local.set(k, (graph.get(k) ?? []).filter(n => { const v = cell(n); return v.x >= minX - margin && v.x <= maxX + margin && v.row >= minR - margin && v.row <= maxR + margin; }));
    }
    for (const horizontal of [true, false]) {
      const middle = Math.floor(horizontal ? (minR + maxR) / 2 : (minX + maxX) / 2);
      const a = horizontal ? { x: minX - margin, row: middle } : { x: middle, row: minR - margin };
      const b = horizontal ? { x: maxX + margin, row: middle } : { x: middle, row: maxR + margin };
      const cut = new Set([...blocked, ...[...local.keys()].filter(k => horizontal ? cell(k).row > middle : cell(k).x > middle)]);
      const first = path(local, key(a), key(b), cut);
      const secondCut = new Set([...blocked, ...first.slice(1, -1), ...[...local.keys()].filter(k => horizontal ? cell(k).row < middle : cell(k).x < middle)]);
      const second = path(local, key(a), key(b), secondCut);
      if (first.length && second.length) {
        const direct = Math.abs(a.x - b.x) + Math.abs(a.row - b.row), detourMeters = (Math.min(first.length, second.length) - 1 - direct) * map.cellSize;
        if (detourMeters > 0) return { cells: cells.map(c => ({ ...c })), routes: [first.map(cell), second.map(cell)], detourMeters, axis: horizontal ? 'eastWest' : 'northSouth' };
      }
    }
    return undefined;
  };
}

/** Local route alternatives are evidence of a movement decision, not a claim about projectile cover. */
export function obstacleTactics(map: GridMap, settings: GenerationSettings): TacticalObstacle[] {
  const evaluate = createObstacleEvaluator(map, settings);
  return (map.propInstances ?? []).filter(p => p.blocksMovement && (p.anchor ?? 'floor') === 'floor').flatMap(p => { const result = evaluate(p.cells); return result ? [result] : []; });
}

function path(graph: Graph, start: string, goal: string, blocked = new Set<string>()): string[] {
  if (!graph.has(start) || !graph.has(goal) || blocked.has(start) || blocked.has(goal)) return [];
  const queue = [start], parent = new Map<string, string | null>([[start, null]]);
  for (let i = 0; i < queue.length; i++) { const k = queue[i]; if (k === goal) break; for (const next of graph.get(k) ?? []) if (!blocked.has(next) && !parent.has(next)) { parent.set(next, k); queue.push(next); } }
  if (!parent.has(goal)) return [];
  const route: string[] = []; for (let at: string | null = goal; at !== null; at = parent.get(at) ?? null) route.unshift(at);
  return route;
}
function reachable(graph: Graph, start: string, blocked = new Set<string>()): Set<string> {
  const visited = new Set<string>(); if (!graph.has(start) || blocked.has(start)) return visited;
  const queue = [start]; visited.add(start);
  for (let i = 0; i < queue.length; i++) for (const next of graph.get(queue[i]) ?? []) if (!visited.has(next) && !blocked.has(next)) { visited.add(next); queue.push(next); }
  return visited;
}
function dodgeCells(map: GridMap, graph: Graph, c: Cell, recipe: LevelDesignRecipe): Cell[] {
  if (map.rows[c.row][c.x] !== '.' || !graph.has(key(c))) return [];
  const result = new Map<string, Cell>([[key(c), c]]), steps = Math.ceil((recipe.dodgeDistance + recipe.characterRadius - map.cellSize / 2) / map.cellSize);
  const height = map.elevations[c.row][c.x];
  for (const [dx, dr] of Object.values(directions)) {
    let last = c;
    for (let i = 1; i <= steps; i++) {
      const next = { x: c.x + dx * i, row: c.row + dr * i };
      if (map.rows[next.row]?.[next.x] !== '.' || !graph.get(key(last))?.includes(key(next)) || Math.abs(map.elevations[next.row][next.x] - height) > 1e-8) return [];
      result.set(key(next), next); last = next;
    }
  }
  return [...result.values()];
}

/** Opposite-side routes must enclose a real interior obstacle, not merely any cycle in open floor. */
function flankingRoutes(map: GridMap, graph: Graph): Cell[][] {
  const visited = new Set<string>();
  for (let row = 1; row < map.height - 1; row++) for (let x = 1; x < map.width - 1; x++) {
    const start = { x, row };
    if (!'#P'.includes(map.rows[row][x]) || visited.has(key(start))) continue;
    const group = [start]; visited.add(key(start)); let interior = true;
    for (let i = 0; i < group.length; i++) for (const [dx, dr] of Object.values(directions)) {
      const n = { x: group[i].x + dx, row: group[i].row + dr }, t = map.rows[n.row]?.[n.x] ?? '_';
      if (t === '_') interior = false;
      if ('#P'.includes(t) && !visited.has(key(n))) { visited.add(key(n)); group.push(n); }
    }
    if (!interior) continue;
    const minX = Math.min(...group.map(c => c.x)), maxX = Math.max(...group.map(c => c.x)), minR = Math.min(...group.map(c => c.row)), maxR = Math.max(...group.map(c => c.row));
    for (const horizontal of [true, false]) {
      const middle = Math.floor(horizontal ? (minR + maxR) / 2 : (minX + maxX) / 2);
      const a = horizontal ? { x: minX - 1, row: middle } : { x: middle, row: minR - 1 };
      const b = horizontal ? { x: maxX + 1, row: middle } : { x: middle, row: maxR + 1 };
      const cut = new Set([...graph.keys()].filter(k => { const c = cell(k); return horizontal ? c.row > middle : c.x > middle; }));
      const first = path(graph, key(a), key(b), cut);
      const oppositeCut = new Set([...graph.keys()].filter(k => { const c = cell(k); return horizontal ? c.row < middle : c.x < middle; }));
      first.slice(1, -1).forEach(k => oppositeCut.add(k));
      const second = path(graph, key(a), key(b), oppositeCut);
      if (first.length && second.length) return [first.map(cell), second.map(cell)];
    }
  }
  return [];
}

function raisedApproaches(map: GridMap, graph: Graph): Cell[] {
  const flats = [...graph.keys()].map(cell).filter(c => map.rows[c.row][c.x] === '.');
  if (!flats.length) return [];
  const top = Math.max(...flats.map(c => map.elevations[c.row][c.x]));
  const high = new Set(flats.filter(c => Math.abs(map.elevations[c.row][c.x] - top) < 1e-8).map(key));
  const visited = new Set<string>(), platforms: Set<string>[] = [];
  for (const k of high) if (!visited.has(k)) {
    const group = new Set([k]), queue = [k]; visited.add(k);
    for (let i = 0; i < queue.length; i++) for (const n of graph.get(queue[i]) ?? []) if (high.has(n) && !visited.has(n)) { visited.add(n); group.add(n); queue.push(n); }
    platforms.push(group);
  }
  const main = platforms.sort((a, b) => b.size - a.size)[0]; if (!main) return [];
  const entrances = map.ramps.filter(r => {
    const [dx, dr] = directions[r.direction], highKey = key({ x: r.x + dx, row: r.row + dr }), lowKey = key({ x: r.x - dx, row: r.row - dr });
    return main.has(highKey) && graph.get(key(r))?.includes(highKey) && graph.get(key(r))?.includes(lowKey);
  });
  const groups: Cell[] = [], assigned = new Set<string>();
  for (const r of entrances) if (!assigned.has(key(r))) {
    const flight = [r]; assigned.add(key(r));
    for (let i = 0; i < flight.length; i++) for (const n of entrances) if (!assigned.has(key(n)) && n.direction === r.direction && Math.abs(n.x - flight[i].x) + Math.abs(n.row - flight[i].row) === 1) { assigned.add(key(n)); flight.push(n); }
    groups.push({ x: r.x, row: r.row });
  }
  return groups;
}

export interface LevelDesignReport {
  recipe: LevelDesignRecipe; issues: ValidationIssue[]; walkableArea: number; walkableCells: Cell[];
  reservedEntryCells: Cell[]; combatCells: Cell[]; combatCenter?: Cell; routes: Cell[][]; hazardCells: Cell[];
  obstacleChoices: TacticalObstacle[];
}

export function analyzeLevelDesign(map: GridMap, settings: GenerationSettings): LevelDesignReport {
  const recipe = compileLevelDesign(settings), issues: ValidationIssue[] = [];
  const error = (code: string, message: string, cells: Cell[]) => issues.push({ severity: 'error', code, message, cells });
  const hazards = (map.fixtures ?? []).filter(f => f.role === 'hazard' || f.role === 'trap');
  const hazardKeys = new Set(hazards.map(key)), graph = graphFor(map, recipe), safeGraph = graphFor(map, recipe, hazardKeys);
  const entry = new Map<string, Cell>(), starts: Cell[] = [];
  const danger = new Set([...hazards, ...(map.markers ?? []).filter(m => m.kind === 'enemy')].map(key));
  for (const port of map.connections) {
    const doors = connectionCells(map, port), [dx, dr] = directions[port.direction];
    if (port.width < recipe.characterRadius * 2 || port.height < recipe.characterHeight) error('door-clearance', `연결문 ${port.label}의 폭 또는 높이가 캐릭터 규격보다 작습니다.`, doors);
    starts.push(doors[Math.floor(doors.length / 2)]);
    const bad: Cell[] = [];
    for (const door of doors) {
      entry.set(key(door), door); let last = door;
      for (let step = 1; step <= Math.ceil(recipe.entryClearance / map.cellSize); step++) {
        const c = { x: door.x - dx * step, row: door.row - dr * step };
        if (c.x < 0 || c.row < 0 || c.x >= map.width || c.row >= map.height) { bad.push(door); break; }
        entry.set(key(c), c);
        if (!graph.get(key(last))?.includes(key(c)) || danger.has(key(c))) bad.push(c);
        last = c;
      }
    }
    if (bad.length) error('entry-clearance', `연결문 ${port.label} 안쪽 ${recipe.entryClearance}m에 장애물·적·위험 또는 이동할 수 없는 지형이 있습니다.`, bad);
  }
  const walkable = [...graph.keys()].map(cell), entryCells = [...entry.values()];
  const combatCandidates = walkable.map(c => ({ c, cells: dodgeCells(map, safeGraph, c, recipe) })).filter(c => c.cells.length && !entry.has(key(c.c)));
  const entrySafetyDistance = (recipe.entryClearance + recipe.dodgeDistance) / map.cellSize;
  const combatZones = new Set((map.zones ?? []).filter(zone => zone.kind === 'combat').map(key));
  // Derive support and the intention's position from usable terrain, never the enclosing grid center.
  const intent = spatialIntent(settings), xs = walkable.map(c => c.x), rs = walkable.map(c => c.row);
  const minX = xs.length ? Math.min(...xs) : 0, maxX = xs.length ? Math.max(...xs) : 0;
  const minRow = rs.length ? Math.min(...rs) : 0, maxRow = rs.length ? Math.max(...rs) : 0;
  const focus = { x: minX + (maxX - minX) * intent.focus.x, row: minRow + (maxRow - minRow) * intent.focus.row };
  const clearance = new Map<string, number>(), frontier = [...safeGraph].filter(([, edges]) => edges.length < 4).map(([k]) => k);
  frontier.forEach(k => clearance.set(k, 0));
  for (let i = 0; i < frontier.length; i++) for (const next of safeGraph.get(frontier[i]) ?? []) if (!clearance.has(next)) { clearance.set(next, clearance.get(frontier[i])! + 1); frontier.push(next); }
  const supportRadius = Math.max(2, Math.ceil(recipe.dodgeDistance / map.cellSize) + 1);
  const combatScores = new Map(combatCandidates.map(candidate => {
    const c = candidate.c, y = map.elevations[c.row][c.x];
    let support = 0;
    for (let dr = -supportRadius; dr <= supportRadius; dr++) for (let dx = -supportRadius; dx <= supportRadius; dx++) {
      if (safeGraph.has(key({ x: c.x + dx, row: c.row + dr })) && Math.abs(map.elevations[c.row + dr][c.x + dx] - y) <= map.maxStepHeight) support++;
    }
    const entrySeparation = starts.length ? Math.min(...starts.map(s => distance(c, s)), entrySafetyDistance) : 0;
    const localRoom = support / (supportRadius * 2 + 1) ** 2;
    // Once there is enough broad space, allow different approach/retreat compositions within it.
    const score = (combatZones.has(key(c)) ? 1000 : 0) + Math.min(clearance.get(key(c)) ?? 0, supportRadius) * .8 + localRoom * 3 + entrySeparation * .25 - distance(c, focus) * .3;
    return [key(c), score] as const;
  }));
  combatCandidates.sort((a, b) => {
    return combatScores.get(key(b.c))! - combatScores.get(key(a.c))! || a.c.row - b.c.row || a.c.x - b.c.x;
  });
  const combat = recipe.combatRequired ? combatCandidates[0] : undefined;
  if (recipe.combatRequired && !combat) error('dodge-space', `네 방향으로 ${recipe.dodgeDistance}m 회피할 수 있는 평지와 몸체 여유 공간이 없습니다.`, walkable.slice(0, 1));
  const target = combat?.c ?? walkable.find(c => !entry.has(key(c))) ?? starts[0];
  const routes: Cell[][] = [];
  if (target) for (const start of starts) {
    const route = path(safeGraph, key(start), key(target));
    if (!route.length) error('mandatory-route', '모든 연결문에서 위험 지형을 밟지 않고 주 공간으로 이동할 수 있어야 합니다.', [start, target]);
    else routes.push(route.map(cell));
  }
  for (const start of starts) {
    const accessible = reachable(safeGraph, key(start));
    for (const marker of map.markers ?? []) {
      if (!accessible.has(key(marker))) error('objective-route', `${marker.label} 지점에 안전하게 접근할 수 없습니다.`, [start, marker]);
      else if (start === starts[0]) routes.push(path(safeGraph, key(start), key(marker)).map(cell));
    }
    for (const service of (map.fixtures ?? []).filter(f => ['rest', 'merchant', 'altar'].includes(f.role))) {
      if (!accessible.has(key(service))) error('service-route', `${service.role} 시설에 안전하게 접근할 수 없습니다.`, [start, service]);
      else if (start === starts[0]) routes.push(path(safeGraph, key(start), key(service)).map(cell));
    }
    for (const gate of (map.fixtures ?? []).filter(f => f.role === 'gate')) {
      const switches = (map.fixtures ?? []).filter(f => f.role === 'switch' && f.linkedId === gate.id);
      if (!switches.length || !switches.some(s => accessible.has(key(s)))) error('locked-switch', '잠금문을 통과하지 않고 연결된 스위치에 접근할 수 있어야 합니다.', [gate, ...switches]);
    }
  }
  if (recipe.pattern === 'flankingArena') {
    const flank = flankingRoutes(map, safeGraph);
    if (!flank.length) {
      if (['balanced','grouped'].includes(settings.designer?.propLayout??'')) issues.push({severity:'warning',code:'flanking-routes',message:'안전하게 배치할 수 있는 내부 장애물이 없어 우회 전투 구성을 완성하지 못했습니다. 이동·출입구·회피 공간을 확보한 부분 결과를 유지합니다.',cells:walkable.slice(0,1)});
      else error('flanking-routes', '내부 장애물 양쪽으로 이어지는 별도의 우회로가 없습니다.', walkable.slice(0, 1));
    } else routes.push(...flank);
  }
  if (recipe.pattern === 'raisedArena') { const approaches = raisedApproaches(map, safeGraph); if (approaches.length < 2) error('raised-approaches', '주요 최고 지대에는 서로 떨어진 두 계단 접근로가 필요합니다.', approaches.length ? approaches : map.ramps); }
  return { recipe, issues, walkableArea: walkable.length * map.cellSize ** 2, walkableCells: walkable, reservedEntryCells: entryCells, combatCells: combat?.cells ?? [], ...(combat ? { combatCenter: combat.c } : {}), routes, hazardCells: hazards.map(f => ({ x: f.x, row: f.row })), obstacleChoices: obstacleTactics(map, settings) };
}

/** Reposition generated content only; terrain, counts, authored offsets and IDs remain stable. */
export function placeLevelDesignContent(source: GridMap, settings: GenerationSettings, region?: GenerationRegion): GridMap {
  if (!settings.levelDesign) return structuredClone(source);
  const map = structuredClone(source), locked = new Set((map.lockedCells ?? []).map(key));
  const active = (c: Cell) => !locked.has(key(c)) && (!region || c.x >= region.x && c.x < region.x + region.width && c.row >= region.row && c.row < region.row + region.height);
  const movable = (f: MapFixture) => active(f) && (f.anchor ?? 'floor') === 'floor' && !['light', 'railing'].includes(f.role);
  // Landing points keep their saved pose and clearance when other content is rearranged.
  const markers = (map.markers ?? []).filter(m => active(m) && m.kind !== 'teleport'), fixtures = (map.fixtures ?? []).filter(movable);
  map.markers = (map.markers ?? []).filter(m => !active(m) || m.kind === 'teleport'); map.fixtures = (map.fixtures ?? []).filter(f => !movable(f));
  const analysis = analyzeLevelDesign(map, settings);
  const terrainErrors = analysis.issues.filter(i => i.severity==='error'&&!['objective-route', 'locked-switch', 'service-route'].includes(i.code ?? ''));
  if (terrainErrors.length) throw new Error(terrainErrors.slice(0, 3).map(i => i.message).join(' '));
  const entries = new Set(analysis.reservedEntryCells.map(key)), reserved = new Set([...analysis.reservedEntryCells, ...analysis.combatCells, ...analysis.routes.flat(), ...analysis.obstacleChoices.flatMap(choice => choice.routes.flat())].map(key));
  const bypassMargin = Math.max(0, Math.ceil(analysis.recipe.characterRadius / map.cellSize - .5));
  for (const c of analysis.obstacleChoices.flatMap(choice => choice.routes.flat())) {
    for (let dr = -bypassMargin; dr <= bypassMargin; dr++) for (let dx = -bypassMargin; dx <= bypassMargin; dx++) reserved.add(key({ x: c.x + dx, row: c.row + dr }));
  }
  const occupied = new Set([...map.markers, ...map.fixtures.filter(f=>!f.wall), ...(map.propInstances ?? []).flatMap(p => p.cells)].map(key));
  for (const marker of map.markers.filter(m => m.kind === 'teleport' && m.clearance)) {
    const radius = marker.clearance!.radius, x = marker.x + marker.offset.x / map.cellSize, row = marker.row - marker.offset.z / map.cellSize;
    const reach = Math.ceil(radius / map.cellSize + .5);
    for (let dr = -reach; dr <= reach; dr++) for (let dx = -reach; dx <= reach; dx++) {
      const c = { x: marker.x + dx, row: marker.row + dr };
      if (Math.hypot(Math.max(0, Math.abs(c.x - x) - .5), Math.max(0, Math.abs(c.row - row) - .5)) * map.cellSize < radius - 1e-7) occupied.add(key(c));
    }
  }
  let graph = graphFor(map, analysis.recipe);
  const start = map.connections[0];
  const accessible = start ? reachable(graph, key(start)) : new Set(graph.keys());
  const candidates = analysis.walkableCells.filter(c => active(c) && map.rows[c.row][c.x] === '.' && accessible.has(key(c)));
  const allDoors = map.connections.flatMap(c => connectionCells(map, c));
  const doorDistances = new Map<string, number>(), queue = allDoors.map(key).filter(k => graph.has(k));
  queue.forEach(k => doorDistances.set(k, 0));
  for (let i = 0; i < queue.length; i++) for (const n of graph.get(queue[i]) ?? []) if (!doorDistances.has(n)) { doorDistances.set(n, (doorDistances.get(queue[i]) ?? 0) + 1); queue.push(n); }
  const selectedEnemies = map.markers.filter(m => m.kind === 'enemy');
  const selectedDressing:Cell[]=[...map.fixtures.filter(f=>!f.wall&&(f.role==='decoration'||f.role==='vegetation')),...(map.propInstances??[]).filter(p=>p.role==='decoration'||p.role==='vegetation').flatMap(p=>p.cells)];
  const choose = (kind: string, avoidCombat: boolean): Cell => {
    const currentReachable = start ? reachable(graph, key(start)) : new Set(graph.keys());
    const usable = candidates.filter(c => currentReachable.has(key(c)) && !occupied.has(key(c)) && !(avoidCombat ? reserved : entries).has(key(c)) && (kind !== 'enemy' || selectedEnemies.every(e => distance(c, e) * map.cellSize >= Math.max(analysis.recipe.characterRadius * 2, map.cellSize))));
    const nearestDoor = (c: Cell) => doorDistances.get(key(c)) ?? 0;
    const score = (c: Cell) => {
      const dressing=kind==='decoration'||kind==='vegetation';
      const zone = map.zones?.find(z => z.x === c.x && z.row === c.row)?.kind;
      const preference = kind === 'enemy' ? 'combat' : kind === 'reward' ? 'reward' : ['rest', 'merchant', 'altar'].includes(kind) ? 'rest' : undefined;
      const spacing = dressing&&selectedDressing.length ? Math.min(...selectedDressing.map(p=>distance(c,p)))*4 : kind === 'enemy' && selectedEnemies.length ? Math.min(...selectedEnemies.map(e => distance(c, e))) * 4 : 0;
      let seedTie = ((Math.imul(c.x + 1, 73856093) ^ Math.imul(c.row + 1, 19349663) ^ (settings.seed ?? 0)) >>> 0) / 4294967296;
      if(dressing){
        let hash=(Math.imul(c.x+1,73856093)^Math.imul(c.row+1,19349663)^Math.imul(settings.seed??0,83492791))>>>0;
        hash=Math.imul(hash^(hash>>>16),2246822507)>>>0;
        seedTie=((hash^(hash>>>13))>>>0)/4294967296;
      }
      const obstacles=(map.propInstances??[]).filter(p=>p.blocksMovement), nearestObstacle=obstacles.length?Math.min(...obstacles.flatMap(p=>p.cells).map(p=>distance(c,p))):0;
      const combatDistance=analysis.combatCenter?distance(c,analysis.combatCenter):0;
      const tactical=kind==='enemy'&&obstacles.length?-Math.abs(nearestObstacle-2)*4-Math.abs(combatDistance-(analysis.recipe.dodgeDistance/map.cellSize+2))*3:0;
      // Safety is enforced above; extra distance from a door must not draw all dressing into one corner.
      const entrancePreference=dressing?Math.min(nearestDoor(c),analysis.recipe.entryClearance/map.cellSize)*.2:nearestDoor(c);
      return (zone && zone === preference ? 1000 : 0) + spacing + entrancePreference + tactical + seedTie;
    };
    usable.sort((a, b) => score(b) - score(a));
    const chosen = usable[0]; if (!chosen) throw new Error(`${kind} 배치에 필요한 안전한 공간이 없습니다. 입구·회피·접근 경로를 보존하도록 지형 또는 요청 수량을 조정해 주세요.`);
    occupied.add(key(chosen)); return chosen;
  };
  for (const marker of markers.sort((a, b) => (a.kind === 'enemy' ? 0 : 1) - (b.kind === 'enemy' ? 0 : 1))) {
    const chosen = choose(marker.kind, false); Object.assign(marker, chosen); map.markers.push(marker); if (marker.kind === 'enemy') selectedEnemies.push(marker);
    for (const door of allDoors) for (const k of path(graph, key(door), key(chosen))) reserved.add(k);
  }
  for (const fixture of fixtures) {
    const chosen = choose(fixture.role, true); Object.assign(fixture, chosen); map.fixtures.push(fixture);
    if(fixture.role==='decoration'||fixture.role==='vegetation')selectedDressing.push(fixture);
    if (['switch', 'rest', 'merchant', 'altar'].includes(fixture.role)) for (const door of allDoors) for (const k of path(graph, key(door), key(chosen))) reserved.add(k);
    if (['column', 'gate', 'hazard', 'trap'].includes(fixture.role)) graph = graphFor(map, analysis.recipe, new Set(map.fixtures.filter(f => f.role === 'hazard' || f.role === 'trap').map(key)));
  }
  return map;
}
