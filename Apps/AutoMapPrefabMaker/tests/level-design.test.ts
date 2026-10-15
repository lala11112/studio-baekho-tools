import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, generationConditionIssues } from '../src/shared/features';
import { analyzeLevelDesign, compileLevelDesign, DEFAULT_LEVEL_DESIGN, parseLevelDesignSettings, placeLevelDesignContent } from '../src/shared/level-design';
import { imagePrompt, layoutPrompt } from '../electron/services/prompts';
import type { AssetBinding, GenerationSettings, GridMap, GameplayMarker, MapFixture } from '../src/shared/types';

const settings = (): GenerationSettings => ({ ...DEFAULT_SETTINGS, seed: 4, levelDesign: { ...DEFAULT_LEVEL_DESIGN, pattern: 'openArena' }, designer: { ...DEFAULT_DESIGNER, elevation: false } });
function room(size = 16): GridMap {
  const rows = Array.from({ length: size }, (_, row) => row === 0 || row === size - 1 ? '#'.repeat(size) : `#${'.'.repeat(size - 2)}#`);
  rows[0] = rows[0].slice(0, size / 2) + 'D' + rows[0].slice(size / 2 + 1);
  return { version: 5, name: '검증방', width: size, height: size, cellSize: 2, rows, elevations: Array.from({ length: size }, () => Array(size).fill(0)), ramps: [], maxStepHeight: .4, connections: [{ id: 'north', label: '북쪽', x: size / 2, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }], assetOverrides: [] };
}
const marker = (id: string, x: number, row: number, kind: GameplayMarker['kind'] = 'enemy'): GameplayMarker => ({ id, label: id, x, row, kind, contentKey: '', direction: 0, offset: { x: 0, y: 0, z: 0 } });
const fixture = (id: string, x: number, row: number, role: MapFixture['role']): MapFixture => ({ id, role, x, row, direction: 0, offset: { x: 0, y: 0, z: 0 } });
const setTile = (map: GridMap, x: number, row: number, tile: string) => { map.rows[row] = map.rows[row].slice(0, x) + tile + map.rows[row].slice(x + 1); };

test('recipes honor enabled terrain and are identical in both AI prompts', () => {
  const s = settings(); s.levelDesign!.pattern = 'auto'; s.designer!.elevation = false; s.designer!.props = false;
  assert.equal(compileLevelDesign(s).pattern, 'openArena');
  const recipe = compileLevelDesign(s);
  assert.ok(imagePrompt(s).includes(recipe.prompt)); assert.ok(layoutPrompt(s).includes(recipe.prompt));
  s.levelDesign!.pattern = 'raisedArena'; assert.throws(() => compileLevelDesign(s), /높이 지형/);
  s.levelDesign!.pattern = 'openArena'; s.designer!.preset = 'shop';
  assert.match(imagePrompt(s), /safe shop/); assert.equal(compileLevelDesign(s).combatRequired, false);
  assert.throws(() => parseLevelDesignSettings({ ...DEFAULT_LEVEL_DESIGN, characterRadius: NaN }), /characterRadius/);
  assert.throws(() => parseLevelDesignSettings({ ...DEFAULT_LEVEL_DESIGN, extra: true }), /지원하지 않는/);
});

test('open arena reports actual traversable area, door approaches, connected routes and dodge cross', () => {
  const report = analyzeLevelDesign(room(), settings());
  assert.deepEqual(report.issues, []); assert.equal(report.walkableArea, (14 * 14 + 1) * 4);
  assert.ok(report.reservedEntryCells.some(c => c.x === 8 && c.row === 2));
  assert.equal(report.combatCells.length, 9); assert.ok(report.routes[0].length > 3);
});

test('entry enemies, insufficient door width and height, and no dodge space have locations', () => {
  const map = room(); map.markers = [marker('entrance-enemy', 8, 1)]; map.connections[0].width = .5;
  const issues = analyzeLevelDesign(map, settings()).issues;
  assert.ok(issues.some(i => i.code === 'door-clearance')); assert.ok(issues.some(i => i.code === 'entry-clearance' && i.cells?.some(c => c.row === 1)));
  map.connections[0].width = 2; map.markers = [];
  for (let row = 1; row < map.height - 1; row++) map.rows[row] = '########.#######';
  const narrow = analyzeLevelDesign(map, settings()); assert.ok(narrow.issues.some(i => i.code === 'dodge-space'));
  const widePlayer = settings(); widePlayer.levelDesign!.characterRadius = 1.1;
  assert.ok(analyzeLevelDesign(map, widePlayer).issues.some(i => i.code === 'entry-clearance'));
});

test('radius and overhead clearance remove cells and terrain elevation is not flattened', () => {
  const map = room(), s = settings();
  map.ceilings = [{ x: 5, row: 5, undersideY: 1.8 }]; map.elevations[4][4] = 3;
  const before = structuredClone(map), report = analyzeLevelDesign(map, s);
  assert.ok(!report.walkableCells.some(c => c.x === 5 && c.row === 5));
  assert.deepEqual(map, before);
});

test('mandatory paths cannot require hazards and a closed gate cannot hide its own switch', () => {
  const map = room();
  map.fixtures = Array.from({ length: 14 }, (_, i) => fixture(`hazard-${i}`, i + 1, 6, 'hazard'));
  map.markers = [marker('reward', 8, 12, 'reward')];
  assert.ok(analyzeLevelDesign(map, settings()).issues.some(i => i.code === 'objective-route'));
  map.fixtures = [fixture('gate', 8, 6, 'gate'), { ...fixture('switch', 8, 9, 'switch'), linkedId: 'gate' }];
  map.rows[6] = '########.#######';
  assert.ok(analyzeLevelDesign(map, settings()).issues.some(i => i.code === 'locked-switch'));
  map.fixtures[1].row = 4;
  assert.ok(!analyzeLevelDesign(map, settings()).issues.some(i => i.code === 'locked-switch'));
});

test('flanking requires an actual obstacle island with paths on opposite sides', () => {
  const map = room(), s = settings(); s.levelDesign!.pattern = 'flankingArena';
  assert.ok(analyzeLevelDesign(map, s).issues.some(i => i.code === 'flanking-routes'));
  setTile(map, 8, 8, 'P');
  const report = analyzeLevelDesign(map, s); assert.ok(!report.issues.some(i => i.code === 'flanking-routes')); assert.ok(report.routes.length >= 3);
  for (let row = 0; row < 8; row++) setTile(map, 8, row, '#');
  assert.ok(analyzeLevelDesign(map, s).issues.some(i => i.code === 'flanking-routes'));
});

test('raised arena counts distinct stair approaches to the same highest platform', () => {
  const map = room(), s = settings(); s.designer!.elevation = true; s.levelDesign!.pattern = 'raisedArena';
  for (let row = 1; row <= 5; row++) for (let x = 1; x < 15; x++) map.elevations[row][x] = 2;
  map.elevations[0][8] = 2; map.rows[6] = '#'.repeat(16);
  for (const x of [3, 11]) { setTile(map, x, 6, 'R'); map.ramps.push({ x, row: 6, direction: 0, rise: 2 }); }
  assert.ok(!analyzeLevelDesign(map, s).issues.some(i => i.code === 'raised-approaches'));
  map.ramps[1].x = 4; setTile(map, 11, 6, '#'); setTile(map, 4, 6, 'R');
  assert.ok(analyzeLevelDesign(map, s).issues.some(i => i.code === 'raised-approaches'));
});

test('content placement preserves quantities and routes while spreading enemies away from entrances', () => {
  const map = room(), s = settings(); map.markers = [marker('e1', 8, 1), marker('e2', 8, 2), marker('reward', 7, 2, 'reward')];
  map.fixtures = [fixture('trap', 3, 4, 'trap'), fixture('pillar', 4, 4, 'column')];
  const before = structuredClone(map), placed = placeLevelDesignContent(map, s), report = analyzeLevelDesign(placed, s);
  assert.deepEqual(map, before); assert.deepEqual(report.issues, []);
  assert.equal(placed.markers!.length, 3); assert.equal(placed.fixtures!.length, 2);
  assert.deepEqual(placed, placeLevelDesignContent(map, s));
  const entry = new Set(report.reservedEntryCells.map(c => `${c.x},${c.row}`));
  assert.ok(placed.markers!.every(m => !entry.has(`${m.x},${m.row}`)));
  assert.notDeepEqual(placed.markers![0], placed.markers![1]);
});

test('partial content layout keeps locked/outside data and safe purposes do not require combat', () => {
  const map = room(), s = settings(); s.designer!.preset = 'reward';
  map.markers = [marker('locked', 3, 4, 'reward'), marker('outside', 13, 13, 'event'), marker('move', 5, 5, 'reward')];
  map.lockedCells = [{ x: 3, row: 4 }];
  const placed = placeLevelDesignContent(map, s, { x: 1, row: 1, width: 7, height: 10 });
  assert.deepEqual(placed.markers!.find(m => m.id === 'locked'), map.markers[0]); assert.deepEqual(placed.markers!.find(m => m.id === 'outside'), map.markers[1]);
  assert.equal(analyzeLevelDesign(placed, s).combatCells.length, 0);
});

test('feature pipeline fits measured props before final game placement and counts converted decorations', () => {
  const map = room(), s = settings(); setTile(map, 1, 1, 'P');
  Object.assign(s.designer!, { props: true, enemies: true, enemyCount: 4, rewards: true, rewardCount: 2, decorations: true, fixtureDensity: 1, ceilings: true, lights: true });
  const asset = (role: 'prop' | 'decoration'): AssetBinding => ({ id: role, role, label: role, prefabGuid: (role === 'prop' ? '1' : '2').repeat(32), prefabPath: `Assets/${role}.prefab`, scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 }, prop: { category: role === 'prop' ? 'furniture' : 'plant', tags: [], blocksMovement: role === 'prop', size: { x: role === 'prop' ? 4 : 1, y: 1, z: 1 }, placement: 'floor', roomTypes: ['battle'], weight: 1 } });
  const before = structuredClone(map), result = applyGeneratedFeatures(map, s, undefined, [asset('prop'), asset('decoration')]);
  assert.deepEqual(map, before); assert.deepEqual(generationConditionIssues(result, s), []); assert.deepEqual(analyzeLevelDesign(result, s).issues, []);
  assert.equal(result.markers!.filter(m => m.kind === 'enemy').length, 4); assert.equal(result.markers!.filter(m => m.kind === 'reward').length, 2);
  const prop = result.propInstances!.find(p => p.bindingId === 'prop')!; assert.equal(prop.cells.length, 2);
  assert.equal(analyzeLevelDesign(result, s).obstacleChoices.length, 1);
  for (const p of result.propInstances!) for (const c of p.cells) assert.ok(!result.markers!.some(m => m.x === c.x && m.row === c.row));
  assert.ok(result.propInstances!.filter(p => p.role === 'decoration').length > 0); assert.ok(!result.fixtures!.some(f => f.role === 'decoration'));
});

test('bridge graph only traverses along the authored bridge axis', () => {
  const map = room(), s = settings(); s.designer!.preset = 'reward';
  for (let x = 1; x < 15; x++) setTile(map, x, 6, '#');
  setTile(map, 8, 6, 'B'); map.bridges = [{ x: 8, row: 6, direction: 90 }];
  map.markers = [marker('far-reward', 8, 12, 'reward')];
  assert.ok(analyzeLevelDesign(map, s).issues.some(i => i.code === 'objective-route'));
  map.bridges[0].direction = 0;
  assert.ok(!analyzeLevelDesign(map, s).issues.some(i => i.code === 'objective-route'));
});
