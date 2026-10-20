import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProject } from '../electron/services/projects';
import { captureRegion, pasteRegion } from '../src/shared/editing';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, parseGenerationSettings } from '../src/shared/features';
import { buildManifest, DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { parsePropBoundsCatalog } from '../src/shared/props';
import { DEFAULT_STRUCTURE_SETTINGS, synchronizeStructures } from '../src/shared/structures';
import type { AssetBinding, GenerationSettings, GridMap, ProjectFile, Vec3 } from '../src/shared/types';
import { wallMountIssues } from '../src/shared/wall-mounts';
import { wallMountGenerationIssues } from '../src/shared/wall-mount-diagnostics';
import { placeholderWallBinding, WALL_PLACEHOLDER_KINDS } from '../src/shared/wall-placeholders';
import { replaceWallPlaceholders } from '../src/shared/wall-replacement';

function config(): GenerationSettings {
  return { ...DEFAULT_SETTINGS, width: 8, height: 8, seed: 68, designer: { ...DEFAULT_DESIGNER, elevation: false, props: false, structureFill: true,
    wallMounts: { enabled: true, singles: false, runs: true, density: 20, runDensity: 50, runOrientation: 'both' } } };
}
function room(): GridMap {
  return synchronizeStructures({ version: 5, name: 'Connected pipe network', width: 8, height: 8, cellSize: 2, maxStepHeight: .4,
    rows: ['####D###', ...Array(6).fill('#......#'), '########'], elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [],
    connections: [{ id: 'entry', label: 'Entry', x: 4, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }],
    assetOverrides: [], structureSettings: { ...DEFAULT_STRUCTURE_SETTINGS } });
}
const near = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-5;
function assertJoinedNetwork(map: GridMap): void {
  const mounted = map.fixtures!.filter(f => f.wall?.runId);
  const joint = mounted.find(f => f.wall!.sockets.length === 3 || f.wall!.placeholder === 'pipeElbow');
  assert.ok(joint, 'a real junction fixture exists');
  const group = mounted.filter(f => f.wall!.runId === joint.wall!.runId);
  assert.ok(group.some(f => f.wall!.sockets.every(s => Math.abs(s.direction.y) > .99)), 'junction network contains vertical pipes');
  assert.ok(group.some(f => f.wall!.sockets.length === 2 && f.wall!.sockets.every(s => Math.abs(s.direction.y) < .01)), 'junction network contains horizontal pipes');
  for (const f of mounted) for (const socket of f.wall!.sockets) {
    const mates = mounted.filter(other => other !== f).flatMap(other => other.wall!.sockets.filter(s => near(s.position, socket.position)
      && near(s.direction, { x: -socket.direction.x, y: -socket.direction.y, z: -socket.direction.z })).map(() => other));
    assert.equal(mates.length, 1, `${f.id} has exactly one physical mate per socket`);
    assert.equal(mates[0].wall!.runId, f.wall!.runId, 'physically joined parts share their network');
  }
  assert.deepEqual(wallMountIssues(map, map.fixtures!.some(f => f.bindingId) ? undefined : []), []);
}
function actualBindings(): AssetBinding[] {
  return WALL_PLACEHOLDER_KINDS.map((kind, index) => {
    const b = placeholderWallBinding(kind); b.id = `actual_${kind}`; b.prefabGuid = (index + 1).toString(16).repeat(32); b.prefabPath = `Assets/${kind}.prefab`;
    if (b.wallMount!.kind !== 'single') b.wallMount!.family = 'ActualNetwork'; return b;
  });
}
const structures: AssetBinding[] = (['floor', 'wall', 'door'] as const).map((role, i) => ({ id: role, label: role, role, prefabGuid: (i + 11).toString(16).repeat(32), prefabPath: `Assets/${role}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 }));

test('connected placeholder networks round trip and rotate as one physical assembly', () => {
  const settings = config(), map = applyGeneratedFeatures(room(), settings, undefined, []);
  assertJoinedNetwork(map);
  assert.ok(!wallMountGenerationIssues(map, settings, []).some(i => i.code === 'wall-junction-empty'));
  const project: ProjectFile = { formatVersion: 1, map, settings, bindings: [] };
  const loaded = parseProjectFile(JSON.parse(JSON.stringify(normalizeProject(project))));
  assert.deepEqual(loaded.map.fixtures, map.fixtures); assert.deepEqual(loaded.bindings, []);
  const snapshot = captureRegion(map, { x: 0, row: 0, width: 8, height: 8 });
  for (const rotate90 of [1, 2, 3] as const) {
    const rotated = pasteRegion(map, snapshot, { x: 0, row: 0 }, { rotate90 });
    assertJoinedNetwork(rotated); assert.deepEqual(validateMap(rotated).filter(issue => issue.severity === 'error'), []);
  }
  assert.throws(() => buildManifest(map, structures), /임시 벽 부착물/);
});

test('junction catalog metadata and full same-kind bulk conversion produce a connected Unity manifest', () => {
  const bindings = [...structures, ...actualBindings()], source = applyGeneratedFeatures(room(), config(), undefined, []), before = structuredClone(source);
  const catalog = { version: 2, assets: bindings.filter(b => b.wallMount).map(b => ({ guid: b.prefabGuid, size: b.bounds!.size, bounds: b.bounds, wallMount: b.wallMount })) };
  assert.equal(parsePropBoundsCatalog(catalog).assets.filter(a => a.wallMount?.kind === 'tee').length, 1);
  let map = source; for (const kind of WALL_PLACEHOLDER_KINDS) map = replaceWallPlaceholders(map, kind, `actual_${kind}`, bindings).map;
  assert.deepEqual(source, before); assert.ok(map.fixtures!.every(f => !f.wall!.placeholder)); assert.deepEqual(wallMountIssues(map, bindings), []);
  assertJoinedNetwork(map);
  const manifest = buildManifest(map, bindings);
  for (const fixture of map.fixtures!) {
    const placement = manifest.placements.find(p => p.id === `fixture-${fixture.id}`)!;
    assert.equal(placement.surface, 'pivot'); assert.deepEqual(placement.position, fixture.wall!.position);
    assert.equal(placement.rotation.z, fixture.wall!.rotationZ ?? 0);
    assert.equal(placement.prefabGuid, bindings.find(b => b.id === fixture.bindingId)!.prefabGuid);
  }
});

test('connection option accepts old settings, preserves explicit independent mode and rejects malformed flags', () => {
  const settings = config(); assert.equal(parseGenerationSettings(settings).designer!.wallMounts!.connectRuns, undefined);
  settings.designer!.wallMounts!.connectRuns = false;
  assert.equal(parseGenerationSettings(settings).designer!.wallMounts!.connectRuns, false);
  const map = applyGeneratedFeatures(room(), settings, undefined, []);
  assert.ok(!map.fixtures!.some(f => f.wall?.placeholder === 'pipeElbow' || f.wall?.placeholder === 'pipeTee'));
  assert.ok(!wallMountGenerationIssues(map, settings, []).some(i => i.code === 'wall-junction-empty'));
  settings.designer!.wallMounts!.connectRuns = true;
  assert.ok(wallMountGenerationIssues(map, settings, []).some(i => i.code === 'wall-junction-empty'));
  (settings.designer!.wallMounts as any).connectRuns = 'yes'; assert.throws(() => parseGenerationSettings(settings));
});
