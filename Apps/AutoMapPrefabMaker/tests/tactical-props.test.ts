import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, generationConditionIssues } from '../src/shared/features';
import { analyzeLevelDesign, obstacleTactics } from '../src/shared/level-design';
import { placeProps, propWorldSize } from '../src/shared/props';
import type { AssetBinding, GenerationSettings, GridMap } from '../src/shared/types';

const tile = (map: GridMap, x: number, row: number, value: string) => { map.rows[row] = map.rows[row].slice(0, x) + value + map.rows[row].slice(x + 1); };
function room(): GridMap {
  const width = 18, height = 16;
  const map: GridMap = { version: 5, name: 'Tactical', width, height, cellSize: 2, maxStepHeight: .4,
    rows: Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`),
    elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], assetOverrides: [],
    connections: [{ id: 'north', label: 'North', x: 9, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
  tile(map, 9, 0, 'D');
  for (const c of [{ x: 4, row: 5 }, { x: 13, row: 5 }, { x: 4, row: 10 }, { x: 13, row: 10 }]) tile(map, c.x, c.row, 'P');
  return map;
}
const settings = (seed = 237): GenerationSettings => ({ ...DEFAULT_SETTINGS, width: 18, height: 16, connectionCount: 1, seed,
  designer: { ...DEFAULT_DESIGNER, elevation: false, props: true, decorations: false }, levelDesign: { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 } });
const asset = (id: string, category = id, width = 1.2): AssetBinding => ({ id, label: id, role: 'prop', prefabGuid: '1'.repeat(32), prefabPath: `Assets/${id}.prefab`,
  scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  prop: { category, tags: [], blocksMovement: true, size: { x: width, y: 1, z: 1.2 }, placement: 'floor', roomTypes: ['battle', 'shop'], weight: 1 } });
const catalog = () => [asset('crate'), asset('table', 'furniture', 2.6), asset('rock')];

test('new generation turns mirrored intents into diverse, asymmetric obstacles with two usable bypasses', () => {
  const map = room(), before = structuredClone(map), s = settings(), bindings = catalog();
  const result = placeProps(map, s, bindings, undefined, [], { tactical: true }).map;
  assert.deepEqual(map, before); assert.equal(result.propInstances!.length, 4);
  assert.deepEqual(result, placeProps(map, s, bindings.reverse(), undefined, [], { tactical: true }).map);
  assert.ok(new Set(result.propInstances!.map(p => p.category)).size > 1);
  const occupied = new Set(result.propInstances!.flatMap(p => p.cells.map(c => `${c.x},${c.row}`)));
  assert.ok(result.propInstances!.some(p => p.cells.some(c => !occupied.has(`${result.width - 1 - c.x},${c.row}`))));
  const evidence = obstacleTactics(result, s), report = analyzeLevelDesign(result, s);
  assert.equal(evidence.length, 4); assert.deepEqual(report.issues, []);
  assert.ok(Math.hypot(report.combatCenter!.x - 8.5, report.combatCenter!.row - 7.5) < 2);
  assert.ok(result.propInstances!.every(p => p.x >= 3 && p.x <= 14 && p.row >= 3 && p.row <= 12));
  assert.ok(new Set(result.propInstances!.map(p => p.x < report.combatCenter!.x ? 'left' : 'right')).size > 1);
  for (const obstacle of evidence) {
    assert.ok(obstacle.detourMeters > 0); assert.ok(obstacle.routes.every(route => route.length > 2));
    const first = new Set(obstacle.routes[0].slice(1, -1).map(c => `${c.x},${c.row}`));
    assert.ok(obstacle.routes[1].slice(1, -1).every(c => !first.has(`${c.x},${c.row}`)));
  }
  for (const p of result.propInstances!) assert.deepEqual(p.size, propWorldSize(bindings.find(b => b.id === p.bindingId)!, p.direction));
  for (const c of [...report.reservedEntryCells, ...report.combatCells]) assert.ok(!occupied.has(`${c.x},${c.row}`));
  assert.notDeepEqual(result.propInstances, placeProps(map, settings(238), bindings, undefined, [], { tactical: true }).map.propInstances);
});

test('manual placement, explicit bindings, locked cells and existing instances retain their anchors', () => {
  const bindings = catalog(), s = settings(), original = room();
  const fixed = placeProps(original, s, bindings).map;
  assert.equal(fixed.propInstances![0].x, 4); assert.equal(fixed.propInstances![0].row, 5);
  assert.deepEqual(placeProps(fixed, s, bindings, undefined, [], { tactical: true }).map, fixed);
  original.lockedCells = [{ x: 4, row: 5 }]; original.assetOverrides = [{ x: 13, row: 5, role: 'prop', bindingId: 'crate' }];
  const result = placeProps(original, s, bindings, undefined, [], { tactical: true }).map;
  assert.equal(result.rows[5][4], 'P'); assert.ok(!result.propInstances!.some(p => p.x === 4 && p.row === 5));
  assert.ok(result.propInstances!.some(p => p.x === 13 && p.row === 5 && p.bindingId === 'crate'));
});

test('safe rooms and legacy catalogs do not acquire battle-specific relocation requirements', () => {
  const map = room(), s = settings(); s.designer!.preset = 'shop';
  assert.deepEqual(placeProps(map, s, catalog(), undefined, [], { tactical: true }), placeProps(map, s, catalog()));
  const legacy = asset('legacy'); delete legacy.prop;
  assert.deepEqual(placeProps(map, settings(), [legacy], undefined, [], { tactical: true }).map, map);
});

test('a manually marked combat zone overrides the default central fighting area', () => {
  const map = room(); map.rows = map.rows.map(r => r.replaceAll('P', '.')); map.zones = [{ x: 4, row: 11, kind: 'combat' }];
  assert.deepEqual(analyzeLevelDesign(map, settings()).combatCenter, { x: 4, row: 11 });
});

test('candidate batches widen beyond the central band when a tall prop only fits a distant ceiling', () => {
  const map = room(); map.width = 40; map.height = 40;
  map.rows = Array.from({ length: 40 }, (_, row) => row === 0 || row === 39 ? '#'.repeat(40) : `#${'.'.repeat(38)}#`);
  map.elevations = Array.from({ length: 40 }, () => Array(40).fill(0)); map.connections[0].x = 20; tile(map, 20, 0, 'D'); tile(map, 4, 5, 'P');
  map.ceilings = Array.from({ length: 38 }, (_, row) => Array.from({ length: 38 }, (_, x) => ({ x: x + 1, row: row + 1, undersideY: x >= 2 && x <= 7 && row >= 29 && row <= 34 ? 4 : 2.5 }))).flat();
  const tall = asset('tall'); tall.prop!.size!.y = 3;
  const result = placeProps(map, settings(), [tall], undefined, [], { tactical: true }).map;
  assert.equal(result.propInstances!.length, 1); assert.ok(result.propInstances![0].x <= 8 && result.propInstances![0].row >= 30);
  assert.equal(obstacleTactics(result, settings()).length, 1);
});

test('weighted diversity does not force a very rare kind, and unsatisfied quantities fail atomically', () => {
  const common = asset('common'), rare = asset('rare'); rare.prop!.weight = .001;
  const source = room(), snapshot = structuredClone(source);
  const result = placeProps(source, settings(), [common, rare], undefined, [], { tactical: true }).map;
  assert.ok(result.propInstances!.every(p => p.bindingId === 'common'));
  const huge = asset('huge'); huge.prop!.size = { x: 100, y: 1, z: 100 };
  assert.throws(() => placeProps(source, settings(), [huge], undefined, [], { tactical: true }), /소품 1\/4/);
  assert.deepEqual(source, snapshot);
});

test('generated columns, traps and hazards preserve both bypasses of every tactical obstacle', () => {
  const s = settings(); Object.assign(s.designer!, { columns: true, traps: true, hazards: true, fixtureDensity: 1, enemies: true, enemyCount: 4 });
  const result = applyGeneratedFeatures(room(), s, undefined, catalog());
  assert.equal(result.propInstances!.length, 4); assert.equal(obstacleTactics(result, s).length, 4);
  assert.deepEqual(analyzeLevelDesign(result, s).issues, []); assert.deepEqual(generationConditionIssues(result, s), []);
  assert.ok(['column', 'trap', 'hazard'].every(role => result.fixtures!.some(f => f.role === role)));
  const blocked = new Set(result.fixtures!.filter(f => ['column', 'trap', 'hazard'].includes(f.role)).map(c => `${c.x},${c.row}`));
  assert.ok(obstacleTactics(result, s).every(choice => choice.routes.flat().every(c => !blocked.has(`${c.x},${c.row}`))));
});

test('generated decorations vary kinds and facing while authored decoration bindings retain facing', () => {
  const map = room(), s = settings(); map.rows = map.rows.map(r => r.replaceAll('P', '.')); s.designer!.decorations = true;
  map.fixtures = [3, 6, 10, 13].map((x, i) => ({ id: `decor-${i}`, role: 'decoration', x, row: 12, direction: 0, offset: { x: 0, y: 0, z: 0 } }));
  const bindings = [asset('grass'), asset('pot')]; for (const b of bindings) { b.role = 'decoration'; b.prop!.blocksMovement = false; }
  const generated = placeProps(map, s, bindings, undefined, [], { varyGeneratedDecorations: true }).map;
  assert.equal(new Set(generated.propInstances!.map(p => p.category)).size, 2);
  assert.ok(new Set(generated.propInstances!.map(p => p.direction)).size > 1);
  map.fixtures[0].bindingId = 'grass'; map.fixtures[0].direction = 90;
  assert.equal(placeProps(map, s, bindings, undefined, [], { varyGeneratedDecorations: true }).map.propInstances![0].direction, 90);
});
