import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, generationConditionIssues } from '../src/shared/features';
import { analyzeLevelDesign, compileLevelDesign, DEFAULT_LEVEL_DESIGN, LEVEL_DESIGN_PRINCIPLES, parseLevelDesignSettings, placeLevelDesignContent } from '../src/shared/level-design';
import { conceptPrompt, imagePrompt, layoutPrompt } from '../electron/services/prompts';
import type { AssetBinding, GenerationSettings, GridMap, GameplayMarker, MapFixture } from '../src/shared/types';

const settings = (): GenerationSettings => ({ ...DEFAULT_SETTINGS, connectionWidth: 2, seed: 4, levelDesign: { ...DEFAULT_LEVEL_DESIGN, pattern: 'openArena' }, designer: { ...DEFAULT_DESIGNER, elevation: false } });
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

test('documented gameplay principles reach all AI stages while numeric recipes remain optional', () => {
  for (const enabled of [false, true]) {
    const s = settings();
    if (!enabled) delete s.levelDesign;
    const concept = conceptPrompt(s);
    const image = imagePrompt(s), layout = layoutPrompt(s);
    for (const prompt of [concept, image, layout]) {
      assert.equal(prompt.split(LEVEL_DESIGN_PRINCIPLES).length, 2);
      assert.match(prompt, /docs\/level-design-principles\.md/);
    }
    assert.doesNotMatch(concept, /LOCAL LEVEL DESIGN RECIPE/);
    if (enabled) {
      assert.ok(image.includes(compileLevelDesign(s).prompt));
      assert.ok(layout.includes(compileLevelDesign(s).prompt));
    } else {
      assert.doesNotMatch(image, /LOCAL LEVEL DESIGN RECIPE/);
      assert.doesNotMatch(layout, /LOCAL LEVEL DESIGN RECIPE/);
    }
  }
  assert.match(LEVEL_DESIGN_PRINCIPLES, /Start, reward and shop rooms prioritize safe/);
  assert.match(LEVEL_DESIGN_PRINCIPLES, /Do not invent movement mechanics or numeric clearance thresholds/);
});

test('blueprints prefer structural asymmetry within user settings and region preservation limits', () => {
  const s = settings(); s.designer!.preset = 'boss'; s.prompt = '좌우 대칭을 유지하는 보스 전투방';
  const region = { x: 2, row: 3, width: 5, height: 6 };
  for (const prompt of [imagePrompt(s), imagePrompt(s, region)]) {
    assert.match(prompt, /purposeful structural asymmetry/);
    assert.match(prompt, /When possible, vary at least two permitted structural aspects/);
    assert.match(prompt, /outer silhouette, usable-area proportions, enabled terrain heights, stair approaches, obstacle groups, and new external door positions or spacing/);
    assert.match(prompt, /Preserve explicitly fixed door locations, and every existing door during a region edit/);
    assert.match(prompt, /explicitly requested symmetry, room purpose, enabled features, exact counts and dimensions take priority/);
    assert.match(prompt, /do not create narrow passages or add features merely to break symmetry/);
    assert.ok(prompt.includes(s.prompt));
    assert.doesNotMatch(prompt, /large clear central fighting area/);
  }
  const partial = imagePrompt(s, region);
  assert.match(partial, /ONLY inside unlocked editable cells/);
  assert.match(partial, /Preserve outside cells, locked cells, existing connections, elevations and region seams exactly/);
  assert.match(partial, /x=2\.\.6, row=3\.\.8/);
});

test('extraction preserves symmetric or asymmetric image geometry instead of composing a new layout', () => {
  const s = settings(); s.designer!.propLayout = 'legacy';
  for (const prompt of [layoutPrompt(s), layoutPrompt(s, { x: 1, row: 1, width: 6, height: 6 })]) {
    assert.match(prompt, /Preserve the visible symmetry or asymmetry/);
    assert.match(prompt, /Do not mirror, regularize, recenter or redesign visible geometry/);
    assert.match(prompt, /Preserve the visible obstacle positions and count, including any mirrored groups/);
    assert.doesNotMatch(prompt, /SPATIAL COMPOSITION:|Prefer a few unequal, off-center obstacle groups|Avoid mirrored pairs/);
  }
  s.designer!.propLayout = 'balanced';
  assert.match(layoutPrompt(s), /interpret object hints without reshaping the room/);
  assert.doesNotMatch(layoutPrompt(s), /Plan usable space for large anchor props/);
  delete s.designer; delete s.levelDesign;
  assert.match(layoutPrompt(s), /Preserve the visible raised platforms and stairs/);
  assert.doesNotMatch(layoutPrompt(s), /Use raised platforms and stairs where useful/);
});

test('open arena reports actual traversable area, door approaches, connected routes and dodge cross', () => {
  const report = analyzeLevelDesign(room(), settings());
  assert.deepEqual(report.issues, []); assert.equal(report.walkableArea, (14 * 14 + 1) * 4);
  assert.ok(report.reservedEntryCells.some(c => c.x === 8 && c.row === 2));
  assert.equal(report.combatCells.length, 9); assert.ok(report.routes[0].length > 3);
});

test('combat composition follows usable terrain across empty padding and varies reproducibly by intention', () => {
  const source = room(), s = settings(), before = analyzeLevelDesign(source, s);
  const padded = structuredClone(source), west = 12;
  padded.width += west; padded.rows = source.rows.map(row => '_'.repeat(west) + row);
  padded.elevations = source.elevations.map(row => [...Array(west).fill(0), ...row]);
  padded.connections = source.connections.map(c => ({ ...c, x: c.x + west }));
  const after = analyzeLevelDesign(padded, s);
  assert.deepEqual(after.issues, []);
  assert.deepEqual(after.combatCenter, { x: before.combatCenter!.x + west, row: before.combatCenter!.row });
  const choices = Array.from({ length: 12 }, (_, seed) => analyzeLevelDesign(source, { ...s, seed }));
  assert.ok(new Set(choices.map(report => JSON.stringify(report.combatCenter))).size >= 3);
  assert.ok(choices.every(report => report.combatCells.length === 9 && !report.issues.some(i => i.severity === 'error')));
  assert.deepEqual(analyzeLevelDesign(source, s).combatCenter, before.combatCenter);
});

test('authored combat zones override the spatial preference only when existing clearance checks pass', () => {
  const map = room(), s = settings(); map.zones = [{ x: 3, row: 10, kind: 'combat' }];
  const selected = analyzeLevelDesign(map, s); assert.deepEqual(selected.combatCenter, { x: 3, row: 10 });
  map.fixtures = [fixture('blocked-zone', 3, 10, 'hazard')];
  const safe = analyzeLevelDesign(map, s); assert.notDeepEqual(safe.combatCenter, { x: 3, row: 10 });
  assert.equal(safe.combatCells.length, 9);
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
