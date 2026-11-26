import assert from 'node:assert/strict';
import test from 'node:test';
import { largestDistinctSubset, spaceProportions, structuralPairs, type QualityCandidate, type StructuralPair } from '../scripts/report-spatial-quality';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import type { GridMap, ProjectFile } from '../src/shared/types';

function project(): ProjectFile {
  const width = 16, height = 12;
  const map: GridMap = { version: 5, name: 'quality', width, height, cellSize: 2, maxStepHeight: .4, rows: Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`), elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], connections: [], assetOverrides: [] };
  return { formatVersion: 1, map, settings: { ...DEFAULT_SETTINGS, width, height }, bindings: [] };
}

test('structural quality reporting never counts names, fixtures or P props as variation', () => {
  const a = project(), b = structuredClone(a); b.map.name = 'different theme'; b.map.rows[5] = b.map.rows[5].slice(0, 5) + 'P' + b.map.rows[5].slice(6);
  b.map.fixtures = [{ id: 'lamp', role: 'light', x: 4, row: 4, direction: 0, offset: { x: 0, y: 3, z: 0 } }];
  assert.deepEqual(spaceProportions(a.map), spaceProportions(b.map));
  const candidates = [{ index: 1, project: a }, { index: 2, project: b }];
  assert.deepEqual(structuralPairs(candidates)[0].differingAttributes, []);
  assert.equal(largestDistinctSubset(candidates).length, 1);
});

test('space proportions preserve rotation and unused exterior margins', () => {
  const source = project().map, rotated = structuredClone(source), margin = 3;
  rotated.width = source.height + margin * 2; rotated.height = source.width + margin * 2;
  rotated.rows = Array.from({ length: rotated.height }, (_, row) => row < margin || row >= rotated.height - margin ? '_'.repeat(rotated.width)
    : '_'.repeat(margin) + Array.from({ length: source.height }, (_, x) => source.rows[source.height - 1 - x][row - margin]).join('') + '_'.repeat(margin));
  assert.deepEqual(spaceProportions(source), spaceProportions(rotated));
});

test('the criterion requires a mutually distinct subset, not four candidates compared to one outlier', () => {
  const candidates: QualityCandidate[] = Array.from({ length: 6 }, (_, i) => ({ index: i + 1, project: project() }));
  const pair = (first: number, second: number): StructuralPair => ({ first, second, footprintSimilarity: .5, differingAttributes: ['윤곽', '높이·계단 접근'], proportionDifferences: { usableFraction: 0, clearance: 0, pocketShares: 0 } });
  const outlierOnly = [2, 3, 4, 5, 6].map(i => pair(1, i));
  assert.equal(largestDistinctSubset(candidates, outlierOnly).length, 2);
  const clique = [...outlierOnly, pair(2, 3), pair(2, 4), pair(3, 4)];
  assert.deepEqual(largestDistinctSubset(candidates, clique), [1, 2, 3, 4]);
});
