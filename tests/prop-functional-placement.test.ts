import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { placeGroupedProps } from '../src/shared/grouped-props';
import { DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import { propAccessCells } from '../src/shared/prop-behavior';
import { normalizePropYaw, propFrontYaw, propYaw } from '../src/shared/prop-orientation';
import { propPosition, propValidationIssues, propWorldSize } from '../src/shared/props';
import type { AssetBinding, Direction, GenerationSettings, GridMap } from '../src/shared/types';

function room(width = 20, height = 18): GridMap {
  const rows = Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`);
  rows[0] = rows[0].slice(0, 10) + 'D' + rows[0].slice(11);
  return { version: 5, name: 'Functional furniture', width, height, cellSize: 2, maxStepHeight: .4, rows,
    elevations: rows.map(() => Array(width).fill(0)), ramps: [], assetOverrides: [],
    connections: [{ id: 'entry', label: 'Entry', x: 10, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
}
function settings(): GenerationSettings {
  return { ...DEFAULT_SETTINGS, width: 20, height: 18, connectionCount: 1, seed: 237,
    designer: { ...DEFAULT_DESIGNER, preset: 'shop', elevation: false, props: true, propLayout: 'grouped', propCoverage: 1, decorations: false, vegetation: false },
    levelDesign: { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 } };
}
function asset(id: string): AssetBinding {
  return { id, label: id, role: 'prop', prefabGuid: id.length.toString(16).padStart(32, '0'), prefabPath: `Assets/${id}.prefab`, rotationY: 0,
    offset: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    prop: { category: id, tags: [], blocksMovement: true, size: { x: 1.2, y: 1, z: 1.2 }, placement: 'floor', roomTypes: ['shop'], weight: 1 } };
}
const groups = (map: GridMap) => [...new Set((map.propInstances ?? []).map(p => p.groupId))].map(id => map.propInstances!.filter(p => p.groupId === id));
const difference = (a: number, b: number) => Math.abs(normalizePropYaw(a - b + 180) - 180);

test('native front calibration faces usable room space on all four wall orientations', () => {
  const a = asset('Console_A'), b = asset('Console_B'), bindings = [a, b];
  a.rotationY = 27; a.prop!.frontYaw = 180; b.rotationY = -40; b.prop!.frontYaw = 90;
  for (const side of [0, 90, 180, 270] as Direction[]) {
    const source = room(); source.connections = [];
    source.rows = Array.from({ length: source.height }, (_, row) => Array.from({ length: source.width }, (_, x) =>
      side === 0 && row === 0 || side === 180 && row === source.height - 1 || side === 90 && x === source.width - 1 || side === 270 && x === 0 ? '#' : '.').join(''));
    const result = placeGroupedProps(source, settings(), bindings), props = result.map.propInstances ?? [];
    assert.ok(props.length >= 2, `${side}: ${JSON.stringify(result.issues)}`);
    for (const p of props) {
      const binding = bindings.find(b => b.id === p.bindingId)!;
      assert.equal(p.direction, (side + 180) % 360);
      assert.ok(difference(propFrontYaw(p, binding), p.direction) < 1e-8);
      assert.deepEqual(p.size, propWorldSize(binding, propYaw(p)));
      assert.ok(propAccessCells(p, binding, .4, 2).every(c => result.map.rows[c.row]?.[c.x] === '.'));
    }
    assert.deepEqual(propValidationIssues(result.map, bindings), []);
  }
});

test('a complete workstation places the chair in front facing the desk and omits unsupported screens', () => {
  const desk = asset('Desk'), chair = asset('Chair'), monitor = asset('Monitor'), bindings = [desk, chair, monitor];
  desk.prop!.size = { x: 2.01, y: 1, z: 1.2 }; chair.prop!.size = { x: .6, y: 1, z: .6 };
  desk.rotationY = 37; desk.prop!.frontYaw = 180; chair.rotationY = -24; chair.prop!.frontYaw = 90;
  monitor.prop!.size = { x: 8, y: 8, z: 8 };
  const s = settings(), result = placeGroupedProps(room(), s, bindings), props = result.map.propInstances ?? [];
  assert.ok(props.length >= 2, JSON.stringify(result.issues));
  assert.ok(props.every(p => p.bindingId !== monitor.id));
  for (const group of groups(result.map)) {
    assert.equal(group.length, 2);
    const table = group.find(p => p.bindingId === desk.id)!, seat = group.find(p => p.bindingId === chair.id)!;
    assert.ok(table && seat);
    assert.ok(difference(propFrontYaw(table, desk) + 180, propFrontYaw(seat, chair)) <= 6);
    const a = propPosition(result.map, table, desk), b = propPosition(result.map, seat, chair), front = propFrontYaw(table, desk) * Math.PI / 180;
    assert.ok((b.x - a.x) * Math.sin(front) + (b.z - a.z) * Math.cos(front) > 0, 'chair occupies the desk user side');
    assert.ok(Math.abs((b.x - a.x) * Math.cos(front) - (b.z - a.z) * Math.sin(front)) < 1e-6, 'physical centers align even when desk and chair have different cell widths');
    for (const c of propAccessCells(seat, chair, .4, 2)) {
      assert.equal(result.map.rows[c.row]?.[c.x], '.');
      assert.ok(!props.some(p => p.cells.some(n => n.x === c.x && n.row === c.row)), 'later groups preserve chair access');
    }
  }
  assert.ok(result.issues.some(i => i.code === 'grouped-props-support-required'));
  assert.deepEqual(result, placeGroupedProps(room(), s, bindings.slice().reverse()));
  assert.deepEqual(placeGroupedProps(result.map, s, bindings).map, result.map);
  const restored = parseProjectFile(JSON.parse(JSON.stringify({ formatVersion: 1, map: result.map, settings: s, bindings })));
  assert.deepEqual(restored.map.propInstances, props);
  assert.deepEqual(propValidationIssues(restored.map, bindings), []);
});

test('functional partners and floor support remain required inside explicit Unity sets and manual families', () => {
  const desk = asset('Desk'), chair = asset('Chair'), monitor = asset('Monitor');
  const set = { guid: '1'.repeat(32), label: 'Workstation', usage: 'equipment' as const, arrangement: 'wall' as const };
  for (const b of [desk, chair, monitor]) b.prop!.unitySets = [set];
  monitor.prop!.size = { x: 4, y: 4, z: 4 };
  for (const bindings of [[desk], [chair], [monitor], [desk, monitor]]) {
    const result = placeGroupedProps(room(), settings(), bindings);
    assert.equal(result.map.propInstances?.length ?? 0, 0);
    assert.ok(result.issues.some(i => ['grouped-props-support-required', 'grouped-props-partner-required'].includes(i.code ?? '')));
  }
  const paired = placeGroupedProps(room(), settings(), [desk, chair, monitor]);
  assert.ok(paired.map.propInstances!.length >= 2);
  assert.ok(paired.map.propInstances!.every(p => p.bindingId !== monitor.id));
  monitor.prop!.behavior = 'floorEquipment'; monitor.prop!.size = { x: 1.2, y: 2.4, z: 1.2 };
  assert.ok(placeGroupedProps(room(), settings(), [monitor]).map.propInstances!.length >= 2, 'explicit freestanding screens can form the authored equipment set');
  const generator = asset('Generator');
  assert.equal(placeGroupedProps(room(), settings(), [desk, generator]).map.propInstances?.some(p => p.bindingId === desk.id) ?? false, false);
});

test('blocked equipment access is rejected and a failed workstation never leaves an orphan desk', () => {
  const source = room(), s = settings(), consoles = [asset('Console_A'), asset('Console_B')];
  source.connections = []; source.rows = source.rows.map((_, row) => (row === 0 ? '#' : '.').repeat(source.width));
  const available = placeGroupedProps(source, s, consoles);
  assert.ok(available.map.propInstances!.length >= 2, JSON.stringify(available.issues));
  source.fixtures = Array.from({ length: source.width }, (_, x) => ({ id: `fixed-${x}`, role: 'merchant' as const, x, row: 2, direction: 0 as const, offset: { x: 0, y: 0, z: 0 } }));
  const blocked = placeGroupedProps(source, s, consoles);
  assert.equal(blocked.map.propInstances?.length ?? 0, 0);
  assert.ok(blocked.issues.some(i => i.code === 'grouped-props-access-unavailable'));
  const desk = asset('Desk'), chair = asset('Chair'); chair.prop!.size = { x: 100, y: 1, z: 100 };
  assert.equal(placeGroupedProps(room(), s, [desk, chair]).map.propInstances?.length ?? 0, 0);
});

test('storage and natural objects use bounded seeded yaw before measuring their complete footprints', () => {
  for (const name of ['Crate', 'Rock']) {
    const binding = asset(name), s = settings(), result = placeGroupedProps(room(), s, [binding]), props = result.map.propInstances!;
    assert.ok(props.length >= 2);
    assert.ok(props.some(p => Math.abs(p.yawOffset ?? 0) > (name === 'Rock' ? 6 : 0)));
    if (name === 'Crate') assert.ok(props.every(p => Math.abs(p.yawOffset ?? 0) <= 6));
    for (const p of props) assert.deepEqual(p.size, propWorldSize(binding, propYaw(p)));
    assert.deepEqual(propValidationIssues(result.map, [binding]), []);
    assert.deepEqual(result, placeGroupedProps(room(), s, [binding]));
    assert.notDeepEqual(result.map.propInstances, placeGroupedProps(room(), { ...s, seed: 238 }, [binding]).map.propInstances);
  }
});

test('hanging fixtures can block equipment use space even while clearing the equipment itself', () => {
  const source = room(), consoles = [asset('Console_A'), asset('Console_B')], lamp: AssetBinding = { ...asset('Lamp'), role: 'light', prop: undefined,
    bounds: { center: { x: 0, y: -1.3, z: 0 }, size: { x: 1.2, y: 2, z: 1.2 } } };
  source.connections = []; source.rows = source.rows.map((_, row) => (row === 0 ? '#' : '.').repeat(source.width));
  source.ceilings = Array.from({ length: source.width }, (_, x) => ({ x, row: 2, undersideY: 3 }));
  source.fixtures = Array.from({ length: source.width }, (_, x) => ({ id: `hanging-${x}`, role: 'light' as const, bindingId: lamp.id,
    x, row: 2, direction: 0 as const, anchor: 'ceiling' as const, offset: { x: 0, y: 0, z: 0 } }));
  const blocked = placeGroupedProps(source, settings(), [...consoles, lamp]);
  assert.equal(blocked.map.propInstances?.length ?? 0, 0);
  assert.ok(blocked.issues.some(i => i.code === 'grouped-props-access-unavailable'));
  for (const roof of source.ceilings) roof.undersideY = 5;
  assert.ok(placeGroupedProps(source, settings(), [...consoles, lamp]).map.propInstances!.length >= 2, 'overhead fixtures above character clearance remain usable');
});

test('a cardinal fallback is fitted when subtle storage yaw would exceed a narrow floor strip', () => {
  const source = room(12, 3), binding = asset('Crate');
  source.rows[0] = '#'.repeat(source.width); source.connections = [];
  binding.prop!.size = { x: 1.99, y: 1, z: 1.99 };
  const placed = placeGroupedProps(source, settings(), [binding]);
  assert.ok(placed.map.propInstances!.length >= 2, JSON.stringify(placed.issues));
  assert.ok(placed.map.propInstances!.every(p => Math.abs(p.yawOffset ?? 0) < 1e-8));
  assert.deepEqual(propValidationIssues(placed.map, [binding]), []);
});
