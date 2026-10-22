import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGenerationSettings, DEFAULT_DESIGNER } from '../src/shared/features';
import { createDemoMap, DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import { DEFAULT_WALL_SETTINGS } from '../src/shared/wall-mounts';
import { handleWallHeightSetting, renderWallMountSettings } from '../src/wall-mount-ui';
import type { WallMountSettings } from '../src/shared/types';

const settings = (wallMounts: unknown) => ({ ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, wallMounts } });
const wall = (): WallMountSettings => ({ ...DEFAULT_WALL_SETTINGS, enabled: true });
const height = { mode: 'fixed' as const, reference: 'floor' as const, min: 2, max: 2 };
const range = { reference: 'top' as const, start: .5, end: 3 };

test('height policies persist through settings and project files without changing legacy defaults', () => {
  const old = parseGenerationSettings(settings(wall())).designer!.wallMounts!;
  assert.equal(old.runHeight, undefined); assert.equal(old.verticalRange, undefined);
  for (const runHeight of [height, { ...height, mode: 'random' as const, reference: 'top' as const, min: .25, max: 3.75 }]) {
    const source = { ...wall(), runHeight, verticalRange: range };
    const parsed = parseGenerationSettings(settings(source));
    assert.deepEqual(parsed.designer!.wallMounts, source);
    const saved = parseProjectFile(JSON.parse(JSON.stringify({ formatVersion: 1, map: createDemoMap(), settings: parsed, bindings: [] })));
    assert.deepEqual(saved.settings.designer!.wallMounts, source);
    assert.equal(saved.formatVersion, 1);
  }
});

test('strict height policy validation rejects invalid references, ranges, numbers, and unknown keys', () => {
  for (const runHeight of [
    null, {}, { ...height, mode: 'unknown' }, { ...height, reference: 'world' },
    { ...height, min: -1 }, { ...height, max: 101 }, { ...height, min: NaN },
    { ...height, max: Infinity }, { ...height, min: '2' }, { ...height, max: 3 },
    { ...height, mode: 'random', min: 3, max: 2 }, { ...height, unexpected: true },
  ]) assert.throws(() => parseGenerationSettings(settings({ ...wall(), runHeight })), /가로 배관 높이/);
  for (const verticalRange of [
    null, {}, { ...range, reference: 'world' }, { ...range, start: -1 }, { ...range, end: 101 },
    { ...range, start: NaN }, { ...range, end: Infinity }, { ...range, start: 3 },
    { ...range, start: 4 }, { ...range, end: '3' }, { ...range, unexpected: true },
  ]) assert.throws(() => parseGenerationSettings(settings({ ...wall(), verticalRange })), /세로 배관 범위/);
  assert.doesNotThrow(() => parseGenerationSettings(settings({ ...wall(), runHeight: { ...height, mode: 'random', min: 0, max: 100 }, verticalRange: { ...range, start: 0, end: 100 } })));
});

test('UI height changes are detached and switching to legacy modes removes optional policies', () => {
  const original = wall(), snapshot = structuredClone(original);
  let updated = handleWallHeightSetting(original, 'runHeightMode', 'fixed');
  updated = handleWallHeightSetting(updated, 'runHeightValue', '1.25');
  updated = handleWallHeightSetting(updated, 'runHeightReference', 'top');
  assert.deepEqual(updated.runHeight, { mode: 'fixed', reference: 'top', min: 1.25, max: 1.25 });
  updated = handleWallHeightSetting(updated, 'runHeightMode', 'random');
  updated = handleWallHeightSetting(updated, 'runHeightMax', '3.25');
  updated = handleWallHeightSetting(updated, 'runHeightMin', '.75');
  updated = handleWallHeightSetting(updated, 'verticalRangeMode', 'custom');
  updated = handleWallHeightSetting(updated, 'verticalRangeReference', 'top');
  updated = handleWallHeightSetting(updated, 'verticalRangeStart', '.25');
  updated = handleWallHeightSetting(updated, 'verticalRangeEnd', '2.5');
  assert.doesNotThrow(() => parseGenerationSettings(settings(updated)));
  assert.deepEqual(original, snapshot);
  updated = handleWallHeightSetting(updated, 'runHeightMode', 'asset');
  updated = handleWallHeightSetting(updated, 'verticalRangeMode', 'full');
  assert.equal('runHeight' in updated, false); assert.equal('verticalRange' in updated, false);
  for (const value of ['', ' ', 'NaN', 'Infinity', '-1', '101']) {
    assert.throws(() => handleWallHeightSetting({ ...wall(), runHeight: height }, 'runHeightValue', value));
  }
});

test('both panels expose height controls and only current-map tools expose explicit reapply', () => {
  const config: WallMountSettings = { ...wall(), runHeight: { ...height, mode: 'random', max: 3 }, verticalRange: range };
  for (const current of [false, true]) {
    const html = renderWallMountSettings(config, true, current);
    for (const name of ['runHeightMode', 'runHeightReference', 'runHeightMin', 'runHeightMax', 'verticalRangeMode', 'verticalRangeReference', 'verticalRangeStart', 'verticalRangeEnd']) {
      assert.match(html, new RegExp(`data-d-control="wall-setting:${name}"[^>]*disabled`));
    }
    assert.equal(html.includes('data-d-action="reapply-wall-runs"'), current);
  }
  assert.match(renderWallMountSettings(undefined), /value="asset" selected/);
  assert.match(renderWallMountSettings(undefined), /value="full" selected/);
  assert.match(renderWallMountSettings({ ...wall(), runHeight: height }), /wall-setting:runHeightValue/);
});
