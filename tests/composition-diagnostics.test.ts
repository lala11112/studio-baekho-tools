import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { compositionGenerationIssues } from '../src/shared/composition-diagnostics';
import { wallMountGenerationIssues } from '../src/shared/wall-mount-diagnostics';
import { NEW_WALL_SETTINGS, placeWallMounts } from '../src/shared/wall-mounts';
import type { GenerationSettings, GridMap } from '../src/shared/types';

const room = (): GridMap => ({ version: 5, name: 'Diagnostics', width: 10, height: 10, cellSize: 2, maxStepHeight: .4,
  rows: ['##########', ...Array(8).fill('#........#'), '##########'], elevations: Array.from({ length: 10 }, () => Array(10).fill(0)), ramps: [], connections: [], assetOverrides: [] });
const settings = (): GenerationSettings => ({ ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, elevation: false,
  propLayout: 'grouped', props: false, decorations: true, decorationDensity: 10, vegetation: false } });

test('post-IPC composition diagnostics retain decoration and vegetation-only unmet demand without catalog', () => {
  for (const role of ['decorations', 'vegetation'] as const) {
    const source = settings(); source.designer!.decorations = false; source.designer![role] = true;
    const map = room(), saved = structuredClone(map);
    const issues = compositionGenerationIssues(map, source, []);
    assert.ok(issues.some(i => i.code === 'grouped-props-no-catalog'));
    assert.ok(issues.some(i => i.code === 'room-composition-count'));
    assert.deepEqual(map, saved);
  }
});

test('decoration diagnostics count only local requested content and respect disabled or zero demand', () => {
  const source = settings(), map = room();
  map.fixtures = [{ id: 'outside', role: 'decoration', x: 7, row: 7, direction: 0, offset: { x: 0, y: 0, z: 0 } }];
  assert.match(compositionGenerationIssues(map, source, [], { x: 1, row: 1, width: 2, height: 2 }).find(i => i.code === 'room-composition-count')!.message, /장식 0개 \/ 목표 1개/);
  map.fixtures.push({ ...map.fixtures[0], id: 'inside', x: 1, row: 1 });
  assert.equal(compositionGenerationIssues(map, source, [], { x: 1, row: 1, width: 2, height: 2 }).some(i => i.code === 'room-composition-count'), false);
  source.designer!.decorationDensity = 0;
  assert.deepEqual(compositionGenerationIssues(map, source, []), []);
});

test('composed fixed horizontal paths do not report intentionally disabled height transitions as missing parts', () => {
  const source = settings(); source.designer!.wallMounts = { ...NEW_WALL_SETTINGS, enabled: true, singles: false,
    runHeight: { mode: 'fixed', reference: 'floor', min: 1.25, max: 1.25 } };
  const placed = placeWallMounts(room(), source, []);
  assert.ok(placed.addedModules > 0);
  assert.equal(wallMountGenerationIssues(placed.map, source, []).some(i => i.code === 'wall-junction-empty'), false);
  source.designer!.wallMounts.runLayout = 'legacy';
  assert.ok(wallMountGenerationIssues(placed.map, source, []).some(i => i.code === 'wall-junction-empty'), 'legacy both+fixed can still create vertical branches');
});
