import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeGeneratedRegion } from '../src/shared/editing';
import { applyGeneratedFeatures, DEFAULT_DESIGNER } from '../src/shared/features';
import { analyzeLevelDesign, DEFAULT_LEVEL_DESIGN } from '../src/shared/level-design';
import { DEFAULT_SETTINGS, validateMap } from '../src/shared/map';
import { NEW_WALL_SETTINGS, placeWallMounts, wallMountDependencies, wallMountIssues } from '../src/shared/wall-mounts';
import type { AssetBinding, Cell, GenerationSettings, GridMap, PropInstance } from '../src/shared/types';

const inside = (c: Cell) => c.x >= 11 && c.x < 19 && c.row >= 0 && c.row < 12;

test('partial terrain, grouped composition and composed pipes preserve outside cells, wide doors and crossing manual groups', () => {
  const width = 24, height = 20, rows = Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`);
  rows[0] = '#'.repeat(10) + 'DD' + '#'.repeat(width - 12);
  const map: GridMap = { version: 5, name: 'partial integration', width, height, cellSize: 2, maxStepHeight: .4, rows,
    elevations: rows.map(() => Array(width).fill(0)), ramps: [], assetOverrides: [], lockedCells: [{ x: 15, row: 8 }],
    connections: [{ id: 'wide', label: 'Wide', x: 10, row: 0, direction: 0, width: 4, height: 3, kind: 'door' }] };
  const binding: AssetBinding = { id: 'crate', label: 'Crate', role: 'prop', prefabGuid: '1'.repeat(32), prefabPath: 'Assets/Crate.prefab', scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
    prop: { category: 'Crate', placement: 'floor', size: { x: 1.2, y: 1, z: 1.2 }, blocksMovement: true, roomTypes: ['shop'], tags: [], weight: 1,
      composition: { usage: 'storage', family: 'supply', member: 'either', arrangement: 'island' } } };
  const manual: PropInstance[] = [10, 11].map((x, i) => ({ id: `manual-${i}`, bindingId: binding.id, role: 'prop', x, row: 5, direction: 0, cells: [{ x, row: 5 }],
    size: { x: 1.2, y: 1, z: 1.2 }, offset: { x: 0, y: 0, z: 0 }, blocksMovement: true, category: 'Crate', anchor: 'floor', groupId: 'crossing-manual', provenance: 'manual', authored: true }));
  map.propInstances = manual;
  for (const p of manual) map.rows[p.row] = map.rows[p.row].slice(0, p.x) + 'P' + map.rows[p.row].slice(p.x + 1);
  const settings: GenerationSettings = { ...DEFAULT_SETTINGS, width, height, connectionCount: 1, seed: 237, designer: { ...DEFAULT_DESIGNER, preset: 'shop', elevation: false, props: true,
    propLayout: 'grouped', propCoverage: 4, decorations: false, wallMounts: { ...NEW_WALL_SETTINGS, enabled: true, runDensity: 15, density: 5 } }, levelDesign: { ...DEFAULT_LEVEL_DESIGN, pattern: 'openArena' } };
  const original = placeWallMounts(map, settings, [binding]).map, before = structuredClone(original), candidate = structuredClone(original);
  // The extraction service returns geography, without the original measured objects or fixture IDs.
  candidate.propInstances = []; candidate.fixtures = []; candidate.connections[0].width = 2;
  for (let row = 0; row < height; row++) for (let x = 0; x < width; x++) if (!inside({ x, row }) || x === 15 && row === 8 || x === 11 && row === 0) {
    candidate.rows[row] = candidate.rows[row].slice(0, x) + '#' + candidate.rows[row].slice(x + 1); candidate.elevations[row][x] = 8;
  }
  const region = { x: 11, row: 0, width: 8, height: 12 };
  const result = mergeGeneratedRegion(original, candidate, region, merged => applyGeneratedFeatures(merged, settings, region, [binding]), [binding]);
  assert.deepEqual(original, before); assert.deepEqual(result.connections, original.connections); assert.deepEqual(result.lockedCells, original.lockedCells);
  assert.equal(result.rows[0], original.rows[0]); assert.equal(result.elevations[0][11], 0); assert.equal(result.elevations[8][15], 0);
  for (let row = 0; row < height; row++) for (let x = 0; x < width; x++) if (!inside({ x, row })) {
    assert.equal(result.rows[row][x], original.rows[row][x]); assert.equal(result.elevations[row][x], original.elevations[row][x]);
  }
  for (const prop of manual) assert.deepEqual(result.propInstances!.find(p => p.id === prop.id), prop);
  const oldFixtures = new Set((original.fixtures ?? []).map(f => f.id));
  for (const fixture of original.fixtures ?? []) assert.deepEqual(result.fixtures!.find(f => f.id === fixture.id), fixture);
  for (const prop of result.propInstances!.filter(p => !manual.some(old => old.id === p.id))) assert.ok(prop.cells.every(inside));
  for (const fixture of result.fixtures!.filter(f => !oldFixtures.has(f.id) && f.wall)) assert.ok(wallMountDependencies(fixture).every(inside));
  assert.deepEqual(validateMap(result, [binding]).filter(i => i.severity === 'error'), []);
  assert.deepEqual(analyzeLevelDesign(result, settings).issues.filter(i => i.severity === 'error'), []); assert.deepEqual(wallMountIssues(result, [binding]), []);
});
