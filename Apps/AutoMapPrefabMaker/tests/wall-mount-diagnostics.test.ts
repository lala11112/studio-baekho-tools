import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import type { AssetBinding, GenerationSettings, GridMap } from '../src/shared/types';
import { getWallMountReadiness, wallMountGenerationIssues } from '../src/shared/wall-mount-diagnostics';
import { DEFAULT_WALL_SETTINGS, defaultWallMount, placeWallMounts } from '../src/shared/wall-mounts';

function settings(): GenerationSettings {
  return { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, elevation: false, props: false, wallMounts: { ...DEFAULT_WALL_SETTINGS, enabled: true, runs: false } } };
}
function lamp(): AssetBinding {
  const binding: AssetBinding = { id: 'wall-lamp', label: '벽등', role: 'light', prefabGuid: '1'.repeat(32), prefabPath: 'Assets/Lamp.prefab',
    scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
    bounds: { center: { x: 0, y: 0, z: .15 }, size: { x: .6, y: .4, z: .3 } } };
  binding.wallMount = defaultWallMount(binding);
  return binding;
}
function room(): GridMap {
  return { version: 5, name: 'Wall diagnostics', width: 8, height: 8, cellSize: 2, maxStepHeight: .4, rows: ['########', ...Array(6).fill('#......#'), '########'],
    elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [], connections: [], assetOverrides: [] };
}

test('readiness preserves explicit and legacy disabled choices and warns only when wall assets exist', () => {
  const legacy = { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER } }, disabled = settings();
  disabled.designer!.wallMounts!.enabled = false;
  for (const source of [legacy, disabled, DEFAULT_SETTINGS]) {
    const before = structuredClone(source), result = getWallMountReadiness(source, [lamp()]);
    assert.equal(result.enabled, false); assert.equal(result.configured, 1); assert.equal(result.measured, 1);
    assert.equal(result.temporaryFallback, false);
    assert.deepEqual(result.issues.map(issue => issue.code), ['wall-disabled']); assert.deepEqual(source, before);
    assert.deepEqual(getWallMountReadiness(source, []).issues, []);
  }
});

test('ordinary decoration permits temporary planning and explicit opt-out explains missing assets', () => {
  const ordinary = lamp(); ordinary.role = 'decoration'; delete ordinary.wallMount;
  const missing = getWallMountReadiness(settings(), [ordinary]);
  assert.equal(missing.configured, 0); assert.equal(missing.measured, 0); assert.equal(missing.temporaryFallback, true);
  assert.deepEqual(missing.issues, []);
  const disabled = settings(); disabled.designer!.wallMounts!.placeholderFallback = false;
  const explicit = getWallMountReadiness(disabled, [ordinary]);
  assert.equal(explicit.temporaryFallback, false); assert.equal(explicit.issues[0].code, 'wall-catalog');
  assert.match(explicit.issues[0].message, /임시 배치.*꺼져.*벽 부착 자동 배치에 사용.*v2/);
});

test('unmeasured configured assets retain their setup reasons instead of silently falling back', () => {
  const unmeasured = lamp(); delete unmeasured.bounds;
  const result = getWallMountReadiness(settings(), [lamp(), unmeasured]);
  assert.equal(result.configured, 2); assert.equal(result.measured, 1); assert.equal(result.temporaryFallback, false); assert.equal(result.issues[0].code, 'wall-unmeasured');
  unmeasured.wallMount!.collisionBoxes = [lamp().bounds!];
  assert.equal(getWallMountReadiness(settings(), [unmeasured]).measured, 1);
});

test('fallback readiness is per category and never hides disabled categories or zero asset selection', () => {
  const source = settings(), binding = lamp();
  assert.equal(getWallMountReadiness(source, [binding]).temporaryFallback, false);
  source.designer!.wallMounts!.runs = true;
  assert.equal(getWallMountReadiness(source, [binding]).temporaryFallback, true);
  source.designer!.wallMounts!.placeholderFallback = false;
  assert.equal(getWallMountReadiness(source, [binding]).temporaryFallback, false);
  source.designer!.wallMounts!.singles = false; source.designer!.wallMounts!.runs = false;
  assert.equal(getWallMountReadiness(source, []).issues[0].code, 'wall-category');
  source.designer!.wallMounts!.singles = true; delete source.designer!.wallMounts!.placeholderFallback;
  binding.wallMount!.probability = 0;
  const zero = getWallMountReadiness(source, [binding]);
  assert.equal(zero.temporaryFallback, false); assert.equal(zero.issues[0].code, 'wall-selection');
});

test('readiness distinguishes disabled categories, zero density and zero selection chances', () => {
  const source = settings(), binding = lamp();
  assert.deepEqual(getWallMountReadiness(source, [binding]).issues, []);
  source.designer!.wallMounts!.singles = false;
  assert.equal(getWallMountReadiness(source, [binding]).issues[0].code, 'wall-category');
  source.designer!.wallMounts!.singles = true; source.designer!.wallMounts!.density = 0;
  assert.equal(getWallMountReadiness(source, [binding]).issues[0].code, 'wall-category');
  source.designer!.wallMounts!.density = 20; binding.wallMount!.probability = 0;
  assert.equal(getWallMountReadiness(source, [binding]).issues[0].code, 'wall-selection');
  binding.wallMount!.probability = 100;
  binding.prop = { category: 'lamp', tags: [], blocksMovement: false, placement: 'wall', roomTypes: ['battle'], weight: 0 };
  assert.equal(getWallMountReadiness(source, [binding]).issues[0].code, 'wall-selection');
  assert.deepEqual(getWallMountReadiness(source, [binding, lamp()]).issues, []);
});

test('empty generation surfaces actual fit failures and never changes the supplied map or assets', () => {
  const map = room(); map.cellSize = 1;
  const source = settings(), bindings = [lamp()], before = structuredClone({ map, source, bindings });
  const issues = wallMountGenerationIssues(map, source, bindings);
  assert.ok(issues.some(issue => issue.code === 'wall-single-fit'));
  assert.ok(issues.some(issue => issue.code === 'wall-density' && issue.message.includes('0%')));
  assert.ok(issues.every(issue => issue.severity === 'warning'));
  assert.deepEqual({ map, source, bindings }, before);
});

test('missing placement is reported when the planner can install assets while successful maps stay quiet', () => {
  const map = room(), source = settings(), bindings = [lamp()];
  assert.ok(wallMountGenerationIssues(map, source, bindings).some(issue => issue.code === 'wall-generation-empty' && issue.message.includes('개를 설치')));
  const placed = placeWallMounts(map, source, bindings).map;
  assert.ok(placed.fixtures!.length > 0); assert.deepEqual(wallMountGenerationIssues(placed, source, bindings), []);
});

test('unregistered assets can plan temporary mounts and successful temporary maps only need replacement', () => {
  const map = room(), source = settings(), before = structuredClone(map);
  const missing = wallMountGenerationIssues(map, source, []);
  assert.ok(missing.some(issue => issue.code === 'wall-generation-empty' && issue.message.includes('개를 설치')));
  assert.ok(missing.every(issue => issue.code !== 'wall-catalog'));
  assert.deepEqual(map, before);
  const placed = placeWallMounts(map, source, []).map;
  const count = placed.fixtures?.filter(fixture => fixture.wall?.placeholder).length ?? 0;
  assert.ok(count > 0);
  const issues = wallMountGenerationIssues(placed, source, []);
  assert.equal(issues.length, 1); assert.equal(issues[0].code, 'wall-placeholder');
  assert.equal(issues[0].severity, 'warning'); assert.ok(issues[0].message.includes(`${count}개`));
  assert.match(issues[0].message, /실제 프리팹으로 교체/);
  assert.ok(issues.every(issue => issue.code !== 'wall-generation-empty'));
});

test('regional temporary warnings only count mounts supported by the requested region', () => {
  const source = settings(), placed = placeWallMounts(room(), source, []).map;
  const region = { x: 0, row: 0, width: 8, height: 3 };
  const expected = placed.fixtures?.filter(fixture => fixture.wall?.placeholder && fixture.wall.support.some(cell => cell.row < 3)).length ?? 0;
  assert.ok(expected > 0);
  const issues = wallMountGenerationIssues(placed, source, [], region);
  assert.equal(issues.filter(issue => issue.code === 'wall-placeholder').length, 1);
  assert.ok(issues.find(issue => issue.code === 'wall-placeholder')!.message.includes(`${expected}개`));
});

test('regional diagnostics ignore outside fixtures and deduplicate repeated planner warnings', () => {
  const source = settings(), measured = lamp(), unmeasured = lamp(); unmeasured.id = 'unmeasured'; delete unmeasured.bounds;
  const placed = placeWallMounts(room(), source, [measured]).map;
  placed.fixtures = placed.fixtures!.filter(fixture => fixture.row >= 4);
  const issues = wallMountGenerationIssues(placed, source, [measured, unmeasured], { x: 0, row: 0, width: 8, height: 3 });
  assert.ok(issues.some(issue => issue.code === 'wall-generation-empty'));
  assert.equal(issues.filter(issue => issue.code === 'wall-unmeasured').length, 1);
  assert.deepEqual(wallMountGenerationIssues(placed, source, [measured], { x: 0, row: 4, width: 8, height: 4 }), []);
});
