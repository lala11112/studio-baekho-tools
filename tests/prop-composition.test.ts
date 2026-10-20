import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import { analyzeLevelDesign, obstacleTactics } from '../src/shared/level-design';
import { getPropCoverageReport, insertPropInstance, placeProps, propValidationIssues, propWorldSize } from '../src/shared/props';
import type { AssetBinding, GenerationSettings, GridMap } from '../src/shared/types';

const tile = (map: GridMap, x: number, row: number, value: string) => { map.rows[row] = map.rows[row].slice(0, x) + value + map.rows[row].slice(x + 1); };
function room(width = 18, height = 16): GridMap {
  const map: GridMap = { version: 5, name: 'Composition', width, height, cellSize: 2, maxStepHeight: .4,
    rows: Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`),
    elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], assetOverrides: [],
    connections: [{ id: 'north', label: 'North', x: Math.floor(width / 2), row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
  tile(map, Math.floor(width / 2), 0, 'D');
  return map;
}
const settings = (seed = 237): GenerationSettings => ({ ...DEFAULT_SETTINGS, width: 18, height: 16, connectionCount: 1, seed,
  designer: { ...DEFAULT_DESIGNER, elevation: false, props: true, propLayout: 'balanced', propCoverage: 12, decorations: false, vegetation: false },
  levelDesign: { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 } });
function asset(id: string, x: number, z: number, y = 1): AssetBinding {
  return { id, label: id, role: 'prop', prefabGuid: '1'.repeat(32), prefabPath: `Assets/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
    prop: { category: id, tags: [], blocksMovement: true, size: { x, y, z }, placement: 'floor', roomTypes: ['battle', 'shop'], weight: 1 } };
}
const catalog = () => [asset('small', 1.2, 1.2), asset('medium', 2.6, 1.8), asset('large', 4.2, 2.4)];

test('balanced generation starts with large anchors, uses measured area and ignores P intention count', () => {
  const map = room(), bindings = catalog(), s = settings(), before = structuredClone(map);
  const result = placeProps(map, s, bindings, undefined, [], { tactical: true });
  assert.deepEqual(map, before);
  const props = result.map.propInstances!;
  assert.ok(props.length > 3); assert.equal(props[0].bindingId, 'large');
  assert.ok(new Set(props.map(p => p.bindingId)).size >= 2);
  const report = getPropCoverageReport(result.map, s, bindings);
  assert.equal(report.floorArea, 16 * 14 * 4);
  assert.equal(report.occupiedArea, props.reduce((sum, p) => sum + p.size.x * p.size.z, 0));
  assert.notEqual(report.occupiedArea, props.reduce((sum, p) => sum + p.cells.length * 4, 0));
  assert.ok(report.actualPercent! > 5);
  assert.deepEqual(propValidationIssues(result.map, bindings), []);
  assert.deepEqual(analyzeLevelDesign(result.map, s).issues, []);
  assert.equal(obstacleTactics(result.map, s).length, props.length);
  for (const p of props) assert.deepEqual(p.size, propWorldSize(bindings.find(b => b.id === p.bindingId)!, p.direction));
  tile(map, 2, 2, 'P'); tile(map, 12, 10, 'P');
  assert.deepEqual(placeProps(map, s, bindings, undefined, [], { tactical: true }).map, result.map);
});

test('balanced results are deterministic, independent of catalog order, and scale with floor area', () => {
  const s = settings(), bindings = [asset('medium', 2.6, 1.8)]; s.designer!.preset = 'shop';
  const small = placeProps(room(12, 12), s, bindings, undefined, [], { tactical: true }).map;
  const large = placeProps(room(24, 22), s, bindings, undefined, [], { tactical: true }).map;
  assert.ok(large.propInstances!.length > small.propInstances!.length);
  const first = placeProps(room(), settings(), catalog(), undefined, [], { tactical: true }).map;
  assert.deepEqual(first, placeProps(room(), settings(), catalog().reverse(), undefined, [], { tactical: true }).map);
  assert.notDeepEqual(first.propInstances, placeProps(room(), settings(238), catalog(), undefined, [], { tactical: true }).map.propInstances);
});

test('legacy preferred tall binding searches distant origins before accepting a smaller easy fit', () => {
  const map = room(40, 40), s = settings(); delete s.designer!.propLayout;
  tile(map, 4, 5, 'P');
  map.ceilings = Array.from({ length: 38 }, (_, row) => Array.from({ length: 38 }, (_, x) => ({ x: x + 1, row: row + 1, undersideY: x >= 2 && x <= 7 && row >= 29 && row <= 34 ? 4 : 2.5 }))).flat();
  const tall = asset('tall', 1.2, 1.2, 3), small = asset('small', 1.2, 1.2); tall.prop!.weight = 1000;
  const result = placeProps(map, s, [small, tall], undefined, [], { tactical: true }).map;
  assert.equal(result.propInstances!.length, 1); assert.equal(result.propInstances![0].bindingId, 'tall');
  assert.ok(result.propInstances![0].x <= 8 && result.propInstances![0].row >= 30);
});

test('unavailable size bands redistribute their budgets and impossible coverage returns safe partial results', () => {
  const s = settings(), medium = asset('medium', 2.6, 1.8), huge = asset('large', 100, 100);
  const result = placeProps(room(), s, [huge, medium], undefined, [], { tactical: true });
  assert.ok(result.map.propInstances!.length > 3); assert.ok(result.map.propInstances!.every(p => p.bindingId === 'medium'));
  const blocked = room(10, 10), snapshot = structuredClone(blocked);
  const partial = placeProps(blocked, s, [huge], undefined, [], { tactical: true });
  assert.deepEqual(blocked, snapshot); assert.equal(partial.map.propInstances?.length ?? 0, 0);
  assert.ok(partial.issues.some(i => i.code === 'prop-coverage-unmet'));
  const report = getPropCoverageReport(partial.map, s, [huge]); assert.equal(report.actualPercent, 0); assert.equal(report.unmet, true);
});

test('missing measurements keep proxies and report unknown coverage; dressing-only passes do not reinterpret them', () => {
  const map = room(), binding = asset('unknown', 1, 1); delete binding.prop!.size; tile(map, 2, 2, 'P');
  const result = placeProps(map, settings(), [binding], undefined, [], { tactical: true });
  assert.deepEqual(result.map, map); assert.ok(result.issues.some(i => i.code === 'prop-coverage-unknown'));
  const report = getPropCoverageReport(result.map, settings(), [binding]); assert.equal(report.measurable, false); assert.equal(report.actualPercent, null);
  assert.deepEqual(placeProps(result.map, settings(), [binding], undefined, [], { skipProps: true }).map, map);
});

test('regions preserve fixed, crossing, outside and locked props and only furnish complete interior footprints', () => {
  const s = settings(), bindings = catalog(), source = insertPropInstance(room(), { x: 3, row: 4 }, 'large', s, bindings);
  const fixed = source.propInstances![0]; assert.equal(fixed.authored, true);
  tile(source, 14, 12, 'P'); source.lockedCells = [{ x: 14, row: 12 }];
  const region = { x: 5, row: 1, width: 11, height: 13 }, before = structuredClone(source);
  const crossingCoverage = getPropCoverageReport(source, s, bindings, region);
  assert.ok(Math.abs(crossingCoverage.occupiedArea - 2.64) < 1e-8);
  const result = placeProps(source, s, bindings, region, [], { tactical: true }).map;
  assert.deepEqual(result.propInstances!.find(p => p.id === fixed.id), fixed);
  assert.equal(result.rows[12][14], 'P');
  assert.ok(result.propInstances!.filter(p => p.id !== fixed.id).every(p => p.cells.every(c => c.x >= 5 && c.x < 16 && c.row >= 1 && c.row < 14)));
  for (let row = 0; row < source.height; row++) for (let x = 0; x < source.width; x++) if (x < 5 || x >= 16 || row < 1 || row >= 14) assert.equal(result.rows[row][x], before.rows[row][x]);
});

test('coverage includes fixed measured floor props, clamps settings and ignores decoration area', () => {
  const s = settings(), bindings = catalog(), source = insertPropInstance(room(), { x: 3, row: 4 }, 'large', s, bindings);
  const initial = getPropCoverageReport(source, s, bindings); assert.equal(initial.floorArea, 896); assert.equal(initial.occupiedArea, 10.08);
  const decor = structuredClone(source.propInstances![0]); decor.id = 'decor'; decor.role = 'decoration'; decor.blocksMovement = false; source.propInstances!.push(decor);
  assert.equal(getPropCoverageReport(source, s, bindings).occupiedArea, initial.occupiedArea);
  s.designer!.propCoverage = 200; assert.equal(getPropCoverageReport(source, s, bindings).targetPercent, 30);
  s.designer!.propCoverage = 0; assert.equal(getPropCoverageReport(source, s, bindings).targetPercent, 1);
});

test('legacy generation preserves crossing props through tactical, empty-intent and safe-room paths', () => {
  const s = settings(), bindings = catalog(); delete s.designer!.propLayout; s.designer!.decorations = true;
  const source = insertPropInstance(room(), { x: 3, row: 4 }, 'large', s, bindings), fixed = structuredClone(source.propInstances![0]);
  const region = { x: 5, row: 1, width: 11, height: 13 };
  assert.throws(() => placeProps(source, s, bindings, region), /일부만 선택/);
  assert.deepEqual(placeProps(source, s, bindings, region, [], { tactical: true, preserveCrossing: true }).map, source);
  tile(source, 12, 10, 'P');
  const result = placeProps(source, s, bindings, region, [], { tactical: true, preserveCrossing: true }).map;
  assert.equal(result.propInstances!.length, 2); assert.deepEqual(result.propInstances!.find(p => p.id === fixed.id), fixed);
  const safeSettings = structuredClone(s); safeSettings.designer!.preset = 'shop';
  const safe = placeProps(source, safeSettings, bindings, region, [], { tactical: true, preserveCrossing: true }).map;
  assert.equal(safe.propInstances!.length, 2); assert.deepEqual(safe.propInstances!.find(p => p.id === fixed.id), fixed);
});

test('maximum sized rooms finish with valid partial coverage when every tactical corridor is reserved', () => {
  const s = settings(); s.designer!.propCoverage = 30;
  const result = placeProps(room(40, 40), s, catalog(), undefined, [], { tactical: true });
  assert.ok(result.map.propInstances!.length > 20);
  assert.deepEqual(propValidationIssues(result.map, catalog()), []);
  assert.deepEqual(analyzeLevelDesign(result.map, s).issues, []);
  const report = getPropCoverageReport(result.map, s, catalog());
  assert.equal(report.floorArea, 38 * 38 * 4);
  assert.ok(report.actualPercent! > 0);
  assert.ok(!report.unmet || result.issues.some(i => i.code === 'prop-coverage-unmet'));
});
