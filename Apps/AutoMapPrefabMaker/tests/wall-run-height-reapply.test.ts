import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_WALL_SETTINGS, placeWallMounts, reapplyWallRuns, wallMountDependencies, wallMountIssues } from '../src/shared/wall-mounts';
import type { GridMap, MapFixture, WallMountSettings } from '../src/shared/types';

function room(): GridMap { return { version: 5, name: 'Reapply pipe heights', width: 12, height: 10, cellSize: 2, maxStepHeight: .4, rows: ['############', ...Array(8).fill('#..........#'), '############'], elevations: Array.from({ length: 10 }, () => Array(12).fill(0)), ramps: [], connections: [], assetOverrides: [], headroom: 2 }; }
const settings = (patch: Partial<WallMountSettings> = {}): WallMountSettings => ({ ...DEFAULT_WALL_SETTINGS, enabled: true, singles: false, runDensity: 40, ...patch });
const switchFixture = (id: string, linkedId?: string): MapFixture => ({ id, role: 'switch', x: 6, row: 5, direction: 0, anchor: 'floor', offset: { x: 0, y: 0, z: 0 }, ...(linkedId ? { linkedId } : {}) });
function groups(map: GridMap) { const result = new Map<string, MapFixture[]>(); for (const fixture of map.fixtures ?? []) if (fixture.wall?.runId) result.set(fixture.wall.runId, [...(result.get(fixture.wall.runId) ?? []), fixture]); return [...result.values()]; }

test('height reapply replaces generated runs transactionally and keeps singles and terrain intact', () => {
  const map = placeWallMounts(room(), settings({ singles: true, density: 40 }), []).map, original = structuredClone(map);
  const result = reapplyWallRuns(map, settings({ runHeight: { mode: 'fixed', reference: 'floor', min: 1.25, max: 1.25 } }), []);
  assert.equal(result.unchanged, false); assert.ok(result.regeneratedRuns > 0); assert.equal(result.preservedRuns, 0); assert.equal(result.skippedRuns, 0); assert.deepEqual(map, original);
  assert.deepEqual(result.map.fixtures!.filter(f => !f.wall?.runId), map.fixtures!.filter(f => !f.wall?.runId));
  assert.deepEqual(result.map.rows, map.rows); assert.deepEqual(result.map.elevations, map.elevations);
  for (const fixture of result.map.fixtures!.filter(f => f.wall?.runId)) for (const socket of fixture.wall!.sockets) assert.ok(Math.abs(socket.position.y - 1.25) < 1e-5);
  assert.deepEqual(wallMountIssues(result.map, []), []);
  const repeat = reapplyWallRuns(result.map, settings({ runHeight: { mode: 'fixed', reference: 'floor', min: 1.25, max: 1.25 } }), []); assert.equal(repeat.unchanged, true); assert.deepEqual(repeat.map, result.map);
});

test('any manual, locked, copied, unknown or linked member protects its entire run', () => {
  const map = placeWallMounts(room(), settings({ runOrientation: 'vertical' }), []).map, runs = groups(map);
  assert.ok(runs.length > 7);
  runs[0][0].wall!.authored = true;
  map.lockedCells = [wallMountDependencies(runs[1][0])[0]];
  for (const fixture of runs[2]) fixture.wall!.runId = 'wm-run-a_copy_1_run';
  for (const fixture of runs[3]) fixture.wall!.runId = 'imported-network';
  const control = switchFixture('external-switch', runs[4][0].id); map.fixtures!.push(control);
  runs[5][0].linkedId = control.id;
  const protectedFixtures = structuredClone(runs.slice(0, 6).flat()), original = structuredClone(map);
  const result = reapplyWallRuns(map, settings({ runOrientation: 'vertical', verticalRange: { reference: 'floor', start: .5, end: 2.75 } }), []);
  assert.equal(result.unchanged, false); assert.ok(result.preservedRuns >= 6); assert.ok(result.regeneratedRuns > 0); assert.deepEqual(map, original);
  for (const fixture of protectedFixtures) assert.deepEqual(result.map.fixtures!.find(f => f.id === fixture.id), fixture);
  assert.deepEqual(result.map.fixtures!.find(f => f.id === control.id), control); assert.deepEqual(wallMountIssues(result.map, []), []);
});

test('rerun never lets elbow and tee assembly mutate preserved horizontal or vertical runs', () => {
  const config = settings({ runOrientation: 'both', connectRuns: false, runHeight: { mode: 'fixed', reference: 'floor', min: 3, max: 3 } });
  const map = placeWallMounts(room(), config, []).map, runs = groups(map);
  const horizontal = runs.find(group => group.every(f => !f.wall!.rotationZ))!, vertical = runs.find(group => group.every(f => !!f.wall!.rotationZ))!;
  assert.ok(horizontal && vertical); map.fixtures!.push(switchFixture('linked-control', horizontal[0].id));
  for (const fixture of vertical) fixture.wall!.runId = 'wm-vertical-a_copy_1_run';
  const preserved = structuredClone([...horizontal, ...vertical]);
  const result = reapplyWallRuns(map, { ...config, connectRuns: true }, []);
  assert.equal(result.reason, undefined, JSON.stringify(result.issues)); assert.ok(result.regeneratedRuns > 0);
  for (const fixture of preserved) assert.deepEqual(result.map.fixtures!.find(f => f.id === fixture.id), fixture);
  assert.deepEqual(wallMountIssues(result.map, []), []);
});

test('new orientation and merged networks are counted as regenerated on their original support area', () => {
  const map = placeWallMounts(room(), settings({ runDensity: 100, runOrientation: 'horizontal' }), []).map;
  const changed = reapplyWallRuns(map, settings({ runDensity: 100, runOrientation: 'vertical', verticalRange: { reference: 'floor', start: .5, end: 2.75 } }), []);
  assert.equal(changed.unchanged, false); assert.ok(changed.regeneratedRuns > 0); assert.equal(changed.skippedRuns, 0); assert.deepEqual(wallMountIssues(changed.map, []), []);
});

test('no eligible groups or impossible new heights keep the original map and explain the result', () => {
  const map = placeWallMounts(room(), settings(), []).map, original = structuredClone(map);
  const invalid = reapplyWallRuns(map, settings({ runHeight: { mode: 'fixed', reference: 'floor', min: 10, max: 10 } }), []);
  assert.equal(invalid.reason, 'no-valid-runs'); assert.equal(invalid.unchanged, true); assert.deepEqual(invalid.map, original); assert.ok(invalid.issues.length);
  map.fixtures!.forEach(f => { f.wall!.authored = true; });
  const protectedResult = reapplyWallRuns(map, settings(), []); assert.equal(protectedResult.reason, 'no-eligible-runs'); assert.deepEqual(protectedResult.map, map); assert.ok(protectedResult.issues.length);
  const empty = reapplyWallRuns(room(), settings(), []); assert.equal(empty.reason, 'no-eligible-runs'); assert.equal(empty.map.fixtures, undefined);
});

test('a final validation error rolls back all changes instead of returning a partly regenerated map', () => {
  const map = placeWallMounts(room(), settings(), []).map; map.fixtures!.push(switchFixture('broken-link', 'missing-target'));
  const original = structuredClone(map), result = reapplyWallRuns(map, settings({ runHeight: { mode: 'fixed', reference: 'floor', min: 1.25, max: 1.25 } }), []);
  assert.equal(result.reason, 'validation-failed'); assert.equal(result.unchanged, true); assert.deepEqual(result.map, original); assert.deepEqual(map, original); assert.ok(result.issues.some(i => i.code === 'wall-run-reapply-link'));
});
