import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProject } from '../electron/services/projects';
import { captureRegion, pasteRegion } from '../src/shared/editing';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, parseGenerationSettings } from '../src/shared/features';
import { buildManifest, DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { DEFAULT_STRUCTURE_SETTINGS, synchronizeStructures } from '../src/shared/structures';
import type { AssetBinding, GenerationSettings, GridMap, ProjectFile } from '../src/shared/types';
import { wallMountIssues } from '../src/shared/wall-mounts';
import { placeholderWallBinding, WALL_PLACEHOLDER_KINDS } from '../src/shared/wall-placeholders';
import { replaceWallPlaceholders } from '../src/shared/wall-replacement';

function config(orientation: 'horizontal' | 'vertical' | 'both' = 'vertical'): GenerationSettings {
  return { ...DEFAULT_SETTINGS, width: 8, height: 8, seed: 68, designer: { ...DEFAULT_DESIGNER, elevation: false, props: false, structureFill: true,
    wallMounts: { enabled: true, singles: false, runs: true, density: 20, runDensity: 100, runOrientation: orientation, connectRuns: false } } };
}
function room(): GridMap {
  return synchronizeStructures({ version: 5, name: 'Vertical pipes', width: 8, height: 8, cellSize: 2, maxStepHeight: .4,
    rows: ['####D###', ...Array(6).fill('#......#'), '########'], elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [],
    connections: [{ id: 'entry', label: 'Entry', x: 4, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }],
    assetOverrides: [], structureSettings: { ...DEFAULT_STRUCTURE_SETTINGS } });
}
function realBindings(): AssetBinding[] {
  return WALL_PLACEHOLDER_KINDS.map((kind, index) => {
    const b = placeholderWallBinding(kind); b.id = `real_${kind}`; b.prefabGuid = (index + 1).toString(16).repeat(32); b.prefabPath = `Assets/${kind}.prefab`;
    if (b.wallMount!.kind !== 'single') b.wallMount!.family = 'ActualPipeFamily';
    return b;
  });
}
const structure: AssetBinding[] = (['floor', 'wall', 'door'] as const).map((role, index) => ({ id: role, label: role, role,
  prefabGuid: (index + 10).toString(16).repeat(32), prefabPath: `Assets/${role}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 }));

test('orientation setting validates each supported choice and preserves old project settings', () => {
  for (const orientation of ['horizontal', 'vertical', 'both'] as const) assert.equal(parseGenerationSettings(config(orientation)).designer!.wallMounts!.runOrientation, orientation);
  const legacy = config(); delete legacy.designer!.wallMounts!.runOrientation;
  assert.equal(parseGenerationSettings(legacy).designer!.wallMounts!.runOrientation, undefined);
  const invalid = config() as any; invalid.designer.wallMounts.runOrientation = 'diagonal';
  assert.throws(() => parseGenerationSettings(invalid), /배관 방향/);
});

test('vertical fallback survives generation, save/reopen and whole-region quarter-turns with its roll and sockets', () => {
  const settings = config(), map = applyGeneratedFeatures(room(), settings, undefined, []);
  assert.ok(map.fixtures!.some(f => f.wall?.rotationZ && f.wall.placeholder === 'pipeStraight'));
  const project: ProjectFile = { formatVersion: 1, map, settings, bindings: [] };
  const loaded = parseProjectFile(JSON.parse(JSON.stringify(normalizeProject(project))));
  assert.deepEqual(loaded.map.fixtures, map.fixtures); assert.deepEqual(wallMountIssues(loaded.map, []), []);
  const snapshot = captureRegion(map, { x: 0, row: 0, width: 8, height: 8 });
  for (const rotate90 of [1, 2, 3] as const) {
    const rotated = pasteRegion(map, snapshot, { x: 0, row: 0 }, { rotate90 });
    assert.deepEqual(wallMountIssues(rotated, []), []); assert.deepEqual(validateMap(rotated).filter(i => i.severity === 'error'), []);
    assert.equal(rotated.fixtures!.filter(f => f.wall?.rotationZ).length, map.fixtures!.filter(f => f.wall?.rotationZ).length);
  }
  assert.throws(() => buildManifest(loaded.map, structure), /임시 벽 부착물/);
});

test('bulk conversion covers horizontal and vertical members and exports the original roll for Unity', () => {
  const source = applyGeneratedFeatures(room(), config('both'), undefined, []), before = structuredClone(source);
  assert.ok(source.fixtures!.some(f => f.wall?.rotationZ)); assert.ok(source.fixtures!.some(f => f.wall && !f.wall.rotationZ));
  const bindings = [...structure, ...realBindings()]; let map = source;
  for (const kind of WALL_PLACEHOLDER_KINDS) map = replaceWallPlaceholders(map, kind, `real_${kind}`, bindings).map;
  assert.deepEqual(source, before); assert.ok(map.fixtures!.every(f => !f.wall?.placeholder));
  assert.deepEqual(wallMountIssues(map, bindings), []);
  const saved = parseProjectFile(JSON.parse(JSON.stringify({ formatVersion: 1, map, settings: config('both'), bindings })));
  const manifest = buildManifest(saved.map, bindings);
  for (const fixture of saved.map.fixtures!) {
    const placement = manifest.placements.find(p => p.id === `fixture-${fixture.id}`)!;
    assert.equal(placement.rotation.z, fixture.wall!.rotationZ ?? 0); assert.equal(placement.rotation.y, fixture.wall!.rotationY);
    assert.equal(placement.surface, 'pivot'); assert.deepEqual(placement.position, fixture.wall!.position);
  }
});
