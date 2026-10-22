import assert from 'node:assert/strict';
import test from 'node:test';
import { captureRegion, compareModules, mergeGeneratedRegion, pasteRegion } from '../src/shared/editing';
import { connectionCells, connectionPose, DEFAULT_SETTINGS } from '../src/shared/map';
import { applyGeneratedFeatures, DEFAULT_DESIGNER } from '../src/shared/features';
import type { GridMap } from '../src/shared/types';

function blank(): GridMap {
  return { version: 4, name: 'Edit test', width: 8, height: 8, cellSize: 2, rows: Array(8).fill('________'),
    elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], connections: [], assetOverrides: [], maxStepHeight: 0.4 };
}
function source(): GridMap {
  const map = blank();
  map.rows[2] = '__RD#___';
  map.rows[3] = '__.BP___';
  map.elevations[2].splice(2, 3, 0, 1, 2); map.elevations[3].splice(2, 3, 3, 4, 5);
  map.ramps = [{ x: 2, row: 2, direction: 90, rise: 1, kind: 'slope' }];
  map.connections = [{ id: 'port', label: '높은 문', x: 3, row: 2, direction: 0, width: 1.5, height: 2.5, kind: 'door' }];
  map.assetOverrides = [{ x: 4, row: 2, role: 'wall', bindingId: 'stone' }];
  map.ceilings = [{ x: 2, row: 3, undersideY: 8 }]; map.wallHeights = [{ x: 4, row: 2, height: 4 }];
  map.bridges = [{ x: 3, row: 3, direction: 90 }]; map.cliffs = [{ x: 2, row: 3, direction: 270, depth: 9 }];
  map.fixtures = [{ id: 'gate', x: 2, row: 3, role: 'gate', direction: 90, offset: { x: 0, y: 0, z: 0 } },
    { id: 'switch', x: 4, row: 3, role: 'switch', direction: 270, offset: { x: 0.5, y: 1, z: -0.25 }, linkedId: 'gate', bindingId: 'switch-prefab' }];
  map.markers = [{ id: 'enemy', label: '보스', kind: 'enemy', contentKey: 'boss-01', x: 3, row: 3, direction: 180, offset: { x: 0.1, y: 0.2, z: 0.3 } }];
  map.lockedCells = [{ x: 4, row: 3 }]; map.zones = [{ x: 3, row: 3, kind: 'combat' }];
  return map;
}

test('rotated rectangular paste preserves all layers and remaps entity links without modifying source', () => {
  const map = source(), before = structuredClone(map);
  const snapshot = captureRegion(map, { x: 2, row: 2, width: 3, height: 2 });
  const result = pasteRegion(map, snapshot, { x: 5, row: 4 }, { rotate90: 1 });
  assert.deepEqual(map, before);
  assert.deepEqual(result.rows.slice(4, 7).map(row => row.slice(5, 7)), ['.R', 'BD', 'P#']);
  assert.deepEqual(result.elevations.slice(4, 7).map(row => row.slice(5, 7)), [[3, 0], [4, 1], [5, 2]]);
  assert.deepEqual(result.ramps.at(-1), { x: 6, row: 4, direction: 180, rise: 1, kind: 'slope' });
  assert.deepEqual(result.ceilings?.at(-1), { x: 5, row: 4, undersideY: 8 });
  assert.deepEqual(result.wallHeights?.at(-1), { x: 6, row: 6, height: 4 });
  assert.deepEqual(result.bridges?.at(-1), { x: 5, row: 5, direction: 180 });
  assert.deepEqual(result.cliffs?.at(-1), { x: 5, row: 4, direction: 0, depth: 9 });
  assert.deepEqual(result.assetOverrides.at(-1), { x: 6, row: 6, role: 'wall', bindingId: 'stone' });
  const fixture = result.fixtures!.at(-1)!;
  assert.deepEqual({ x: fixture.x, row: fixture.row, direction: fixture.direction, offset: fixture.offset },
    { x: 5, row: 6, direction: 0, offset: { x: -0.25, y: 1, z: -0.5 } });
  assert.notEqual(fixture.id, 'switch'); assert.notEqual(fixture.linkedId, 'gate');
  assert.equal(fixture.linkedId, result.fixtures!.at(-2)!.id);
  assert.equal(fixture.bindingId, 'switch-prefab');
  assert.equal(result.markers!.at(-1)!.contentKey, 'boss-01');
  assert.notEqual(result.markers!.at(-1)!.id, 'enemy');
  assert.notEqual(result.connections.at(-1)!.id, 'port');
  assert.deepEqual(result.lockedCells?.at(-1), { x: 5, row: 6 });
  assert.deepEqual(result.zones?.at(-1), { x: 5, row: 5, kind: 'combat' });
  snapshot.elevations[0][0] = 100;
  assert.equal(map.elevations[2][2], 0);
});

test('mirror order transforms directions and world offsets consistently before rotation', () => {
  const snapshot = captureRegion(source(), { x: 2, row: 2, width: 3, height: 2 });
  const xMirror = pasteRegion(blank(), snapshot, { x: 0, row: 0 }, { mirrorX: true });
  assert.deepEqual(xMirror.ramps[0], { x: 2, row: 0, direction: 270, rise: 1, kind: 'slope' });
  assert.deepEqual(xMirror.fixtures![1].offset, { x: -0.5, y: 1, z: -0.25 });
  const zMirror = pasteRegion(blank(), snapshot, { x: 0, row: 0 }, { mirrorZ: true });
  assert.equal(zMirror.connections[0].direction, 180);
  assert.deepEqual(zMirror.fixtures![1].offset, { x: 0.5, y: 1, z: 0.25 });
  const combined = pasteRegion(blank(), snapshot, { x: 0, row: 0 }, { mirrorX: true, mirrorZ: true, rotate90: 3 });
  assert.equal(combined.ramps[0].direction, 180);
  assert.deepEqual(combined.fixtures![1].offset, { x: -0.25, y: 1, z: -0.5 });
});

test('out-of-bounds, mismatched scale and locked destinations reject the entire paste', () => {
  const map = source(), before = structuredClone(map), snapshot = captureRegion(map, { x: 2, row: 2, width: 3, height: 2 });
  assert.throws(() => captureRegion(map, { x: -1, row: 0, width: 2, height: 2 }), /영역/);
  assert.throws(() => pasteRegion(map, snapshot, { x: 7, row: 7 }, { rotate90: 1 }), /영역/);
  assert.throws(() => pasteRegion(map, snapshot, { x: 2, row: 2 }), /잠긴/);
  assert.throws(() => pasteRegion({ ...map, cellSize: 3 }, snapshot, { x: 0, row: 0 }), /셀 크기/);
  assert.deepEqual(map, before);
});

function moduleMap(id: string, direction: 0 | 90 | 180 | 270, elevation: number): GridMap {
  const map = blank();
  map.rows = Array(8).fill('........');
  const x = direction === 270 ? 0 : direction === 90 ? 7 : 3;
  const row = direction === 0 ? 0 : direction === 180 ? 7 : 3;
  map.rows[row] = map.rows[row].slice(0, x) + 'D' + map.rows[row].slice(x + 1);
  map.elevations = Array.from({ length: 8 }, () => Array(8).fill(elevation));
  map.connections = [{ id, label: id, x, row, direction, width: 2, height: 3, kind: 'door' }];
  return map;
}

test('module comparison rotates and translates B including its Y without flattening source elevations', () => {
  const a = moduleMap('a', 90, 4), b = moduleMap('b', 0, -2), before = structuredClone([a, b]);
  const result = compareModules(a, 'a', b, 'b');
  assert.equal(result.transform.rotationY, 270); assert.equal(result.transform.position.y, 6);
  const poseA = connectionPose(a, a.connections[0]), poseB = connectionPose(b, b.connections[0]);
  const angle = result.transform.rotationY * Math.PI / 180;
  assert.ok(Math.abs(poseB.position.x * Math.cos(angle) + poseB.position.z * Math.sin(angle) + result.transform.position.x - poseA.position.x) < 0.0001);
  assert.ok(Math.abs(-poseB.position.x * Math.sin(angle) + poseB.position.z * Math.cos(angle) + result.transform.position.z - poseA.position.z) < 0.0001);
  assert.equal(poseB.position.y + result.transform.position.y, poseA.position.y);
  assert.deepEqual(result.issues, []); assert.deepEqual([a, b], before);
});

test('comparison catches kind/size mismatches and approximate 3D overlaps', () => {
  const a = moduleMap('a', 90, 0), b = moduleMap('b', 270, 0);
  b.connections[0].kind = 'arch'; b.connections[0].width = 1.98; b.connections[0].height = 2.95;
  const mismatch = compareModules(a, 'a', b, 'b').issues;
  assert.equal(mismatch.filter(issue => issue.severity === 'error').length, 1);
  assert.equal(mismatch.filter(issue => issue.severity === 'warning').length, 2);
  b.connections[0].x = 7; // An inward-facing socket puts both modules in the same volume.
  assert.ok(compareModules(a, 'a', b, 'b').issues.some(issue => issue.message.includes('겹칩니다')));
  assert.throws(() => compareModules(a, 'missing', b, 'b'), /연결문/);
  b.connections[0].x = 0; b.connections[0].kind = 'door'; b.connections[0].width = 2.01; b.connections[0].height = 3;
  assert.deepEqual(compareModules(a, 'a', b, 'b').issues, []);
});

test('partial generation preserves outside cells, locks, zones and original connection metadata exactly', () => {
  const original = moduleMap('stable-port', 0, 0);
  original.lockedCells = [{ x: 2, row: 2 }]; original.zones = [{ x: 3, row: 3, kind: 'reward' }];
  original.fixtures = [{ id: 'locked-light', role: 'light', x: 2, row: 2, direction: 90, offset: { x: 0.1, y: 1, z: 0.2 } },
    { id: 'outside-light', role: 'light', x: 7, row: 7, direction: 0, offset: { x: 0, y: 1, z: 0 } }];
  original.ceilings = [{ x: 2, row: 2, undersideY: 4 }];
  const candidate = structuredClone(original), before = structuredClone(original);
  candidate.name = 'Discarded name'; candidate.connections[0].id = 'generated-port'; candidate.connections[0].height = 8;
  candidate.rows[0] = '########'; // The original port tile must remain D.
  candidate.rows[2] = '..P.P...'; candidate.rows[7] = '########';
  candidate.elevations[2][2] = 8; candidate.elevations[7][7] = 9;
  candidate.ceilings![0].undersideY = 12;
  candidate.fixtures = [{ id: 'new-light', role: 'light', x: 4, row: 3, direction: 0, offset: { x: 0, y: 0.3, z: 0 } }];
  candidate.zones = []; candidate.lockedCells = [];
  const result = mergeGeneratedRegion(original, candidate, { x: 2, row: 0, width: 3, height: 4 });
  assert.deepEqual(original, before);
  assert.equal(result.name, original.name); assert.deepEqual(result.connections, original.connections);
  assert.equal(result.rows[0][3], 'D'); assert.equal(result.rows[2][2], '.'); assert.equal(result.rows[2][4], 'P');
  assert.equal(result.elevations[2][2], 0); assert.equal(result.elevations[7][7], 0); assert.equal(result.rows[7], original.rows[7]);
  assert.deepEqual(result.ceilings, original.ceilings); assert.deepEqual(result.lockedCells, original.lockedCells); assert.deepEqual(result.zones, original.zones);
  assert.deepEqual(result.fixtures?.slice(0, 2), original.fixtures); assert.equal(result.fixtures?.at(-1)?.id, 'new-light');
});

test('partial generation rejects broken height seams and incompatible dimensions atomically', () => {
  const original = moduleMap('a', 0, 0), before = structuredClone(original), candidate = structuredClone(original);
  for (let row = 2; row < 4; row++) for (let x = 2; x < 4; x++) candidate.elevations[row][x] = 4;
  assert.throws(() => mergeGeneratedRegion(original, candidate, { x: 2, row: 2, width: 2, height: 2 }), /경계/);
  assert.throws(() => mergeGeneratedRegion(original, { ...candidate, width: 9 }, { x: 2, row: 2, width: 2, height: 2 }), /맵 크기/);
  assert.deepEqual(original, before);
});

test('partial generation remaps new fixture/marker IDs colliding with protected content and preserves internal links', () => {
  const original = moduleMap('a', 0, 0);
  original.fixtures = [{ id: 'gate-1', role: 'gate', x: 6, row: 6, direction: 0, offset: { x: 0, y: 0, z: 0 } },
    { id: 'outside-switch', role: 'switch', x: 5, row: 6, direction: 0, offset: { x: 0, y: 0, z: 0 }, linkedId: 'gate-1' }];
  original.markers = [{ id: 'enemy-1', label: 'old', kind: 'enemy', contentKey: '', x: 6, row: 5, direction: 0, offset: { x: 0, y: 0, z: 0 } }];
  const candidate = structuredClone(original);
  candidate.fixtures = [{ ...candidate.fixtures![0], x: 2, row: 2 },
    { ...candidate.fixtures![1], id: 'switch-1', x: 3, row: 2 }];
  candidate.markers![0].x = 2; candidate.markers![0].row = 3;
  const result = mergeGeneratedRegion(original, candidate, { x: 2, row: 2, width: 2, height: 2 });
  assert.deepEqual(result.fixtures!.slice(0, 2), original.fixtures);
  assert.deepEqual(result.markers![0], original.markers[0]);
  const gate = result.fixtures!.find(fixture => fixture.x === 2)!, trigger = result.fixtures!.find(fixture => fixture.x === 3)!;
  assert.notEqual(gate.id, 'gate-1'); assert.equal(trigger.linkedId, gate.id);
  assert.equal(result.fixtures![1].linkedId, 'gate-1'); assert.notEqual(result.markers![1].id, 'enemy-1');
  assert.equal(candidate.fixtures![0].id, 'gate-1'); assert.equal(candidate.fixtures![1].linkedId, 'gate-1');
});


test('partial generation assembles local layers before validation while still rejecting broken geography', () => {
  const original = moduleMap('a', 0, 0), before = structuredClone(original);
  original.ceilings = [{ x: 7, row: 7, undersideY: 8 }];
  const candidate = structuredClone(original), region = { x: 2, row: 2, width: 2, height: 2 };
  candidate.ceilings = [{ x: 2, row: 2, undersideY: 0.1 }];
  const settings = { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, elevation: false, props: false, ceilings: true, lights: true, enemies: true, enemyCount: 1, fixtureDensity: 1 } };
  const decorate = (map: GridMap) => applyGeneratedFeatures(map, settings, region);
  const result = mergeGeneratedRegion(original, candidate, region, decorate);
  assert.equal(result.ceilings!.find(c => c.x === 2 && c.row === 2)!.undersideY, 4);
  assert.deepEqual(result.ceilings![0], original.ceilings[0]);
  assert.equal(result.fixtures!.length, 1); assert.equal(result.markers!.length, 1);
  assert.ok([...result.fixtures!, ...result.markers!].every(c => c.x >= 2 && c.x < 4 && c.row >= 2 && c.row < 4));
  candidate.elevations[2][2] = 5;
  assert.throws(() => mergeGeneratedRegion(original, candidate, region, decorate), /경계/);
  assert.deepEqual(original.rows, before.rows); assert.deepEqual(original.elevations, before.elevations);
});

test('wide door footprints remain aligned with their first-cell anchors after every rotation and reflection', () => {
  for (const direction of [0, 90, 180, 270] as const) for (const rotate90 of [0, 1, 2, 3] as const)
    for (const mirrorX of [false, true]) for (const mirrorZ of [false, true]) {
      const map = blank();
      map.connections = [{ id: 'wide', label: 'Wide door', x: 2, row: 2, direction, width: 5, height: 3, kind: 'door' }];
      for (const cell of connectionCells(map, map.connections[0])) map.rows[cell.row] = map.rows[cell.row].slice(0, cell.x) + 'D' + map.rows[cell.row].slice(cell.x + 1);
      const snapshot = captureRegion(map, { x: 2, row: 2, width: 3, height: 3 });
      const result = pasteRegion(map, snapshot, { x: 4, row: 4 }, { rotate90, mirrorX, mirrorZ });
      const footprint = connectionCells(result, result.connections.at(-1)!);
      const doorCells = [];
      for (let row = 4; row < 7; row++) for (let x = 4; x < 7; x++) if (result.rows[row][x] === 'D') doorCells.push(`${x}:${row}`);
      assert.deepEqual(footprint.map(cell => `${cell.x}:${cell.row}`).sort(), doorCells.sort(), JSON.stringify({ direction, rotate90, mirrorX, mirrorZ }));
      assert.equal(result.connections.at(-1)!.width, 5);
    }
});

test('copy and paste reject a selection that splits an existing wide doorway atomically', () => {
  const map = moduleMap('wide', 0, 0); map.connections[0].width = 6; map.rows[0] = '...DDD..';
  const before = structuredClone(map);
  assert.throws(() => captureRegion(map, { x: 4, row: 0, width: 1, height: 2 }), /연결문 전체/);
  const snapshot = captureRegion(map, { x: 3, row: 0, width: 3, height: 2 });
  assert.throws(() => pasteRegion(map, snapshot, { x: 4, row: 0 }), /연결문 전체/);
  assert.deepEqual(map, before);
});

test('partial generation protects secondary cells of a wide port even when its anchor is outside the region', () => {
  const map = moduleMap('wide', 0, 0); map.connections[0].width = 6; map.rows[0] = '...DDD..';
  const candidate = structuredClone(map); candidate.rows[0] = '...D#D..'; candidate.elevations[0][4] = 8;
  const result = mergeGeneratedRegion(map, candidate, { x: 4, row: 0, width: 1, height: 2 });
  assert.deepEqual(result.connections, map.connections);
  assert.equal(result.rows[0], map.rows[0]); assert.equal(result.elevations[0][4], 0);
});

test('wide port comparison aligns footprint centers, including ports using different cell sizes', () => {
  const a = moduleMap('a', 0, 4), b = moduleMap('b', 180, -2);
  a.connections[0].width = 4; a.rows[0] = '...DD...';
  b.cellSize = 4; b.connections[0].width = 4;
  const result = compareModules(a, 'a', b, 'b');
  const poseA = connectionPose(a, a.connections[0]), poseB = connectionPose(b, b.connections[0]);
  assert.equal(result.transform.rotationY, 0);
  assert.deepEqual({ x: poseB.position.x + result.transform.position.x, y: poseB.position.y + result.transform.position.y,
    z: poseB.position.z + result.transform.position.z }, poseA.position);
  assert.deepEqual(result.issues, []);
});
