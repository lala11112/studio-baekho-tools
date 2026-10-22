import assert from 'node:assert/strict';
import test from 'node:test';
import { imagePrompt, layoutPrompt } from '../electron/services/prompts';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, generationConditionIssues } from '../src/shared/features';
import { furnishExistingMap, rearrangeMapProps } from '../src/shared/furnishing';
import { analyzeLevelDesign, DEFAULT_LEVEL_DESIGN } from '../src/shared/level-design';
import { buildManifest, DEFAULT_SETTINGS, validateMap } from '../src/shared/map';
import { protectedPropIds } from '../src/shared/prop-groups';
import { getPropCoverageReport, propPosition, propValidationIssues, propWorldSize, removePropInstance, replacePropInstance } from '../src/shared/props';
import type { AssetBinding, GenerationSettings, GridMap, PropComposition, PropInstance } from '../src/shared/types';

function room(): GridMap {
  const width = 24, height = 20, rows = Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`);
  rows[0] = '#'.repeat(12) + 'D' + '#'.repeat(11);
  return { version: 5, name: 'Grouped generation', width, height, cellSize: 2, maxStepHeight: .4, rows,
    elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], assetOverrides: [],
    connections: [{ id: 'north', label: 'North', x: 12, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
}
function settings(): GenerationSettings {
  return { ...DEFAULT_SETTINGS, width: 24, height: 20, connectionCount: 1, seed: 237,
    designer: { ...DEFAULT_DESIGNER, preset: 'battle', elevation: false, props: true, propLayout: 'grouped', propCoverage: 12,
      decorations: true, vegetation: false, decorationDensity: 1 }, levelDesign: { ...DEFAULT_LEVEL_DESIGN, pattern: 'openArena' } };
}
function asset(id = 'Crate', role: 'prop' | 'decoration' = 'prop', composition?: PropComposition): AssetBinding {
  return { id, label: id, role, prefabGuid: id.length.toString(16).padStart(32, '0'), prefabPath: `Assets/${id}.prefab`,
    scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
    prop: { category: id, tags: [], blocksMovement: role === 'prop', size: { x: 1.2, y: 1, z: 1.2 }, placement: 'floor', roomTypes: ['battle', 'shop'], weight: 1,
      ...(composition ? { composition } : {}) } };
}
function catalog(): AssetBinding[] {
  const crate = asset(); crate.rotationY = 90; crate.scale.x = 1.1;
  return [crate, asset('Console', 'prop', { usage: 'equipment', family: 'station', member: 'anchor', arrangement: 'wall' }),
    asset('Chair', 'decoration', { usage: 'equipment', family: 'station', member: 'companion', arrangement: 'wall' })];
}
const groups = (map: GridMap) => [...new Set((map.propInstances ?? []).flatMap(prop => prop.groupId ? [prop.groupId] : []))]
  .map(id => map.propInstances!.filter(prop => prop.groupId === id));
const setTile = (map: GridMap, x: number, row: number, value: string) => { map.rows[row] = map.rows[row].slice(0, x) + value + map.rows[row].slice(x + 1); };

test('generation builds measured mixed-role groups with safe objectives and no independent decoration fixtures', () => {
  const source = room(), config = settings(), assets = catalog(), before = structuredClone(source);
  Object.assign(config.designer!, { enemies: true, enemyCount: 2, rewards: true, rewardCount: 1 });
  const result = applyGeneratedFeatures(source, config, undefined, assets), arranged = groups(result);
  assert.ok(arranged.length > 0); assert.ok(arranged.length <= 5, '24×20 room uses at most five groups');
  assert.ok(arranged.some(members => members.some(prop => prop.role === 'prop') && members.some(prop => prop.role === 'decoration')));
  assert.ok(arranged.every(members => members.length >= 2 && members.length <= 4 && members.every(prop => prop.provenance === 'generated')));
  assert.equal(result.fixtures?.filter(fixture => fixture.role === 'decoration' || fixture.role === 'vegetation').length, 0);
  assert.equal(result.markers?.filter(marker => marker.kind === 'enemy').length, 2); assert.equal(result.markers?.filter(marker => marker.kind === 'reward').length, 1);
  for (const prop of result.propInstances!) assert.deepEqual(prop.size, propWorldSize(assets.find(binding => binding.id === prop.bindingId)!, prop.direction));
  assert.deepEqual(propValidationIssues(result, assets), []); assert.deepEqual(validateMap(result).filter(issue => issue.severity === 'error'), []);
  assert.deepEqual(analyzeLevelDesign(result, config).issues.filter(issue => issue.severity === 'error'), []);
  assert.deepEqual(generationConditionIssues(result, config).filter(issue => issue.severity === 'error'), []);
  assert.deepEqual(source, before); assert.deepEqual(result, applyGeneratedFeatures(source, config, undefined, [...assets].reverse()));
});

test('optional raw P hints including entry hints do not determine quantities or block the grouped planning phase', () => {
  const config = settings(), assets = catalog(), expected = applyGeneratedFeatures(room(), config, undefined, assets), hinted = room();
  for (const cell of [{ x: 12, row: 1 }, { x: 3, row: 4 }, { x: 19, row: 14 }]) setTile(hinted, cell.x, cell.row, 'P');
  const before = structuredClone(hinted), result = applyGeneratedFeatures(hinted, config, undefined, assets);
  assert.deepEqual(result, expected); assert.equal(result.rows[1][12], '.'); assert.deepEqual(hinted, before);
});

test('hint cleanup keeps locked, directly assigned and measured obstacles authoritative', () => {
  const config = settings(), assets = catalog();
  for (const kind of ['locked', 'assigned', 'measured'] as const) {
    const source = room(); setTile(source, 12, 1, 'P');
    if (kind === 'locked') source.lockedCells = [{ x: 12, row: 1 }];
    if (kind === 'assigned') source.assetOverrides.push({ x: 12, row: 1, role: 'prop', bindingId: assets[0].id });
    if (kind === 'measured') source.propInstances = [{ id: 'fixed-entry', bindingId: assets[0].id, role: 'prop', x: 12, row: 1, direction: 0,
      cells: [{ x: 12, row: 1 }], size: propWorldSize(assets[0])!, offset: { x: 0, y: 0, z: 0 }, blocksMovement: true, category: 'Crate', anchor: 'floor', provenance: 'manual' }];
    const before = structuredClone(source);
    assert.throws(() => applyGeneratedFeatures(source, config, undefined, assets), /안쪽|이동|공간/, kind);
    assert.deepEqual(source, before);
  }
  const source = room(), region = { x: 4, row: 4, width: 14, height: 12 };
  setTile(source, 2, 14, 'P'); setTile(source, 8, 8, 'P');
  const result = applyGeneratedFeatures(source, config, region, assets);
  assert.equal(result.rows[14][2], 'P');
  assert.ok(result.propInstances!.every(prop => prop.cells.every(cell => cell.x >= region.x && cell.x < region.x + region.width && cell.row >= region.row && cell.row < region.row + region.height)));
});

test('unknown or missing libraries return safe partial rooms without scattering fallback fixtures', () => {
  const config = settings(); config.levelDesign!.pattern = 'flankingArena'; config.designer!.vegetation = true;
  for (const assets of [undefined, [asset('SM_A001'), asset('SM_B001', 'decoration')]]) {
    const result = applyGeneratedFeatures(room(), config, undefined, assets);
    assert.equal(result.propInstances?.length ?? 0, 0);
    assert.equal(result.fixtures?.filter(fixture => ['decoration', 'vegetation'].includes(fixture.role)).length, 0);
    assert.deepEqual(validateMap(result).filter(issue => issue.severity === 'error'), []);
    const conditions = generationConditionIssues(result, config);
    assert.deepEqual(conditions.filter(issue => issue.severity === 'error'), []);
    assert.ok(conditions.some(issue => issue.code === 'grouped-props-unmet' && issue.severity === 'warning'));
    assert.ok(analyzeLevelDesign(result, config).issues.some(issue => issue.code === 'flanking-routes' && issue.severity === 'warning'));
  }
  const implicit = settings(); delete implicit.levelDesign;
  assert.doesNotThrow(() => applyGeneratedFeatures(room(), implicit, undefined, [asset('SM_A001')]));
});

test('grouped prompts describe functional groups and optional P hints while legacy quantities remain explicit', () => {
  const config = settings(); config.designer!.propCoverage = 18;
  for (const prompt of [imagePrompt, layoutPrompt]) {
    const grouped = prompt(config);
    assert.match(grouped, /AUTOMATIC GROUPED COMPOSITION/); assert.match(grouped, /one anchor and 1-3 compatible companions/);
    assert.match(grouped, /18%/); assert.match(grouped, /P cells are optional hints/); assert.match(grouped, /zero is allowed/);
    assert.match(grouped, /do not scatter leftover parts/); assert.doesNotMatch(grouped, /retaining the exact object count/);
    const legacy = prompt({ ...config, designer: { ...config.designer!, propLayout: 'legacy' } });
    assert.match(legacy, /retaining the exact object count/); assert.doesNotMatch(legacy, /AUTOMATIC GROUPED COMPOSITION/);
    const region = prompt(config, { x: 2, row: 3, width: 10, height: 12 }); assert.match(region, /ONLY to this selected editable region/);
  }
});

test('flat floor panels remain measurable objects but contribute no grouped obstacle coverage', () => {
  const source = room(), config = settings(), panel = asset('Floor_Panel'), crate = asset();
  panel.prop!.size = { x: 8, y: .1, z: 4 };
  const cells = Array.from({ length: 2 }, (_, row) => Array.from({ length: 4 }, (_, x) => ({ x: x + 2, row: row + 12 }))).flat();
  const measured: PropInstance = { id: 'manual-panel', bindingId: panel.id, role: 'prop', x: 2, row: 12, direction: 0,
    offset: { x: 3, y: 0, z: -1 }, cells, size: { ...panel.prop!.size }, blocksMovement: true, category: 'Floor_Panel', anchor: 'floor', authored: true, provenance: 'manual' };
  source.propInstances = [measured]; for (const cell of cells) setTile(source, cell.x, cell.row, 'P');
  assert.deepEqual(propValidationIssues(source, [panel, crate]), []);
  const report = getPropCoverageReport(source, config, [panel, crate]);
  assert.equal(report.mode, 'grouped'); assert.equal(report.measurable, true); assert.equal(report.occupiedArea, 0); assert.equal(report.actualPercent, 0);
  assert.ok(report.unmet);
  assert.equal(getPropCoverageReport(source, { ...config, designer: { ...config.designer!, propLayout: 'balanced' } }, [panel, crate]).occupiedArea, 32);
});

test('manifest flattens grouped members to ordinary native-scale placements without authoring metadata', () => {
  const config = settings(), assets = catalog(), result = applyGeneratedFeatures(room(), config, undefined, assets);
  const structural: AssetBinding[] = (['floor', 'wall', 'door'] as const).map(role => ({ ...asset(`Structure_${role}`), role, prop: undefined }));
  const manifest = buildManifest(result, [...assets, ...structural]);
  assert.equal(manifest.schemaVersion, 5);
  for (const prop of result.propInstances!) {
    const binding = assets.find(item => item.id === prop.bindingId)!, placement = manifest.placements.find(item => item.id === `prop-instance-${prop.id}`)!;
    assert.ok(placement); assert.deepEqual(placement.position, propPosition(result, prop, binding)); assert.deepEqual(placement.scale, binding.scale);
    assert.equal(placement.rotation.y, prop.direction + binding.rotationY); assert.equal(placement.centerXZ, true);
    for (const field of ['groupId', 'provenance', 'composition', 'authored']) assert.equal(Object.hasOwn(placement, field), false);
  }
  assert.equal(manifest.placements.filter(placement => placement.centerXZ).length, result.propInstances!.length);
});

test('manual remove and refit mark every surviving sibling protected before later automatic rearrangement', () => {
  const config = settings(), assets = catalog(), generated = applyGeneratedFeatures(room(), config, undefined, assets), group = groups(generated)[0];
  assert.ok(group.length >= 2);
  const target = group[0], before = structuredClone(generated);
  for (const action of ['remove', 'refit'] as const) {
    const edited = action === 'remove' ? removePropInstance(generated, target.id) : replacePropInstance(generated, target.id, target.bindingId, config, assets);
    const surviving = group.filter(prop => action !== 'remove' || prop.id !== target.id);
    for (const old of surviving) {
      const changed = edited.propInstances!.find(prop => prop.id === old.id)!;
      assert.equal(changed.authored, true); assert.equal(changed.provenance, 'manual'); assert.equal(changed.groupId, old.groupId);
      assert.ok(protectedPropIds(edited).has(changed.id));
      if (old.id !== target.id) assert.deepEqual(changed, { ...old, authored: true, provenance: 'manual' });
    }
    const rearranged = rearrangeMapProps(edited, config, assets, { props: true, decorations: true });
    for (const old of surviving) assert.deepEqual(rearranged.map.propInstances!.find(prop => prop.id === old.id), edited.propInstances!.find(prop => prop.id === old.id));
  }
  assert.deepEqual(generated, before);
});

test('metadata-only regrouping commits once and unselected decoration counts remain unchanged', () => {
  const config = settings(), assets = [asset()], initial = furnishExistingMap(room(), config, assets, { props: true, decorations: false }).map;
  const ungrouped = structuredClone(initial); for (const prop of ungrouped.propInstances!) delete prop.groupId;
  const result = rearrangeMapProps(ungrouped, config, assets, { props: true, decorations: false });
  assert.equal(result.unchanged, false); assert.equal(result.movedProps, 0); assert.equal(result.addedProps, 0); assert.equal(result.removedProps, 0);
  assert.ok(groups(result.map).length > 0);
  assert.equal(rearrangeMapProps(result.map, config, assets, { props: true, decorations: false }).unchanged, true);
  const decoration = asset('Existing_Decoration', 'decoration'); assets.push(decoration);
  const decorated = structuredClone(initial), fixed: PropInstance = { id: 'existing-unselected', bindingId: decoration.id, role: 'decoration', x: 2, row: 16, direction: 0,
    offset: { x: 0, y: 0, z: 0 }, cells: [{ x: 2, row: 16 }], size: propWorldSize(decoration)!, blocksMovement: false, category: decoration.prop!.category, anchor: 'floor', provenance: 'generated' };
  decorated.propInstances!.push(fixed);
  const selected = rearrangeMapProps(decorated, config, assets, { props: true, decorations: false });
  assert.ok(!selected.issues.some(issue => ['furnishing-invalid-map', 'furnishing-failed'].includes(issue.code ?? '')), JSON.stringify(selected.issues));
  assert.equal(selected.addedDecorations, 0); assert.deepEqual(selected.map.propInstances!.find(prop => prop.id === fixed.id), fixed);
  assert.equal(selected.map.propInstances!.filter(prop => prop.role === 'decoration').length, 1);
});

test('ID reuse across changed prefab order and newly registered assets cannot collide or inflate counts', () => {
  const config = settings(); config.designer!.decorations = false; config.designer!.propCoverage = 2;
  const oldAssets = [asset('Crate_A'), asset('Crate_B')], initial = furnishExistingMap(room(), config, oldAssets, { props: true, decorations: false }).map;
  assert.ok(initial.propInstances!.some(prop => prop.bindingId === oldAssets[0].id)); assert.ok(initial.propInstances!.some(prop => prop.bindingId === oldAssets[1].id));
  const props = structuredClone(initial.propInstances!), ids = props.map(prop => prop.id);
  for (let index = 0; index < props.length; index++) {
    props[index].id = ids[(index + 1) % ids.length]; props[index].x = 2 + index % 6 * 3; props[index].row = 5 + Math.floor(index / 6) * 3;
    props[index].cells = [{ x: props[index].x, row: props[index].row }]; props[index].offset = { x: 0, y: 0, z: 0 };
  }
  const source = room(), rows = source.rows.map(row => [...row]); source.propInstances = props;
  for (const prop of props) rows[prop.row][prop.x] = 'P'; source.rows = rows.map(row => row.join(''));
  const assets = [...oldAssets, asset('Crate_C')], result = rearrangeMapProps(source, config, assets, { props: true, decorations: false });
  assert.equal(result.unchanged, false); assert.ok(!result.issues.some(issue => issue.code === 'furnishing-failed'), JSON.stringify(result.issues));
  const placed = result.map.propInstances!, currentIds = new Set(placed.map(prop => prop.id)), previousIds = new Set(props.map(prop => prop.id));
  assert.equal(currentIds.size, placed.length);
  assert.equal(result.addedProps, placed.filter(prop => !previousIds.has(prop.id)).length);
  assert.equal(result.removedProps, props.filter(prop => !currentIds.has(prop.id)).length);
  for (const prop of placed) {
    const previous = props.find(old => old.id === prop.id);
    if (previous) { assert.equal(prop.bindingId, previous.bindingId); assert.equal(prop.role, previous.role); }
  }
  assert.deepEqual(propValidationIssues(result.map, assets), []);
});
