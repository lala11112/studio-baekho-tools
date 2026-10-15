import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesigner } from '../src/designer';
import { createDemoMap, DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import type { AssetBinding, AssetRole, ProjectFile } from '../src/shared/types';

const binding = (id: string, role: AssetRole, digit = '1'): AssetBinding => ({ id, label: id, role, prefabGuid: digit.repeat(32),
  prefabPath: `Assets/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 });
function project(): ProjectFile {
  return parseProjectFile({ formatVersion: 1, settings: { ...DEFAULT_SETTINGS }, bindings: [binding('floor-a', 'floor'), binding('light-a', 'light', '2')],
    map: { ...createDemoMap(), lockedCells: [{ x: 2, row: 2 }], assetOverrides: [{ x: 2, row: 2, role: 'floor', bindingId: 'floor-a' }],
      fixtures: [{ id: 'lamp', role: 'light', x: 2, row: 2, direction: 0, offset: { x: 0, y: 1, z: 0 }, bindingId: 'light-a' }] } });
}
function harness(initial: ProjectFile, templateBindings = initial.bindings) {
  let current = structuredClone(initial), selected: { x: number; row: number } | null = { x: 2, row: 2 }, commits = 0;
  const messages: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ same: {
    settings: initial.settings, bindings: templateBindings,
  } }) } });
  const designer = createDesigner({ project: () => current, selected: () => selected, select: cell => { selected = { x: cell.x, row: cell.row }; },
    commit: edit => { const before = structuredClone(current); try { edit(); current = parseProjectFile(current); commits++; } catch (error) { current = before; throw error; } },
    render: () => {}, notify: message => { messages.push(message); }, busy: () => false, openComparison: async () => null, regenerate: async () => {} });
  const change = (key: string, value: string) => designer.change({ dataset: { dControl: key }, value } as unknown as HTMLInputElement);
  const click = (action: string, id?: string) => designer.click({ dataset: { dAction: action, id } } as unknown as HTMLElement);
  return { designer, change, click, messages, current: () => current, commits: () => commits };
}

test('reloading matching template preserves cell and fixture binding references on locked cells', async () => {
  const initial = project(), h = harness(initial);
  h.change('template-choice', 'same'); await h.click('load-template');
  assert.equal(h.commits(), 1);
  assert.deepEqual(h.current().map.assetOverrides, initial.map.assetOverrides);
  assert.deepEqual(h.current().map.fixtures, initial.map.fixtures);
  assert.deepEqual(h.current().map.lockedCells, initial.map.lockedCells);
});

test('template cannot change a locked cell prefab or transforms even with the same binding ID and role', async () => {
  for (const mutation of [
    (item: AssetBinding) => { item.prefabGuid = '3'.repeat(32); },
    (item: AssetBinding) => { item.scale.y = 2; },
    (item: AssetBinding) => { item.offset.z = 1; },
    (item: AssetBinding) => { item.rotationY = 90; },
  ]) for (const bindingIndex of [0, 1]) {
    const initial = project(), changed = structuredClone(initial.bindings); mutation(changed[bindingIndex]);
    const h = harness(initial, changed); h.change('template-choice', 'same'); await h.click('load-template');
    assert.equal(h.commits(), 0); assert.deepEqual(h.current(), initial); assert.match(h.messages.at(-1)!, /잠긴/);
  }
});

test('automatic binding reorder and newly resolving a locked fixture are rejected', async () => {
  const initial = project(); initial.map.assetOverrides = []; delete initial.map.fixtures![0].bindingId;
  for (const role of ['floor', 'light'] as const) {
    const changed = [binding(`${role}-b`, role, '3'), ...initial.bindings];
    const h = harness(initial, changed); h.change('template-choice', 'same'); await h.click('load-template');
    assert.equal(h.commits(), 0); assert.deepEqual(h.current(), initial); assert.match(h.messages.at(-1)!, /잠긴/);
  }
  initial.bindings = initial.bindings.filter(item => item.role !== 'light');
  const h = harness(initial, [...initial.bindings, binding('new-light', 'light', '3')]);
  h.change('template-choice', 'same'); await h.click('load-template'); assert.equal(h.commits(), 0);
});

test('template clears only missing unlocked references and retains compatible references', async () => {
  const initial = project(); initial.map.lockedCells = [];
  initial.bindings.push(binding('floor-old', 'floor', '3'));
  initial.map.assetOverrides.push({ x: 3, row: 2, role: 'floor', bindingId: 'floor-old' });
  const h = harness(initial, initial.bindings.filter(item => item.id !== 'floor-old'));
  h.change('template-choice', 'same'); await h.click('load-template');
  assert.equal(h.commits(), 1);
  assert.deepEqual(h.current().map.assetOverrides, [{ x: 2, row: 2, role: 'floor', bindingId: 'floor-a' }]);
  assert.equal(h.current().map.fixtures![0].bindingId, 'light-a');
});

test('fixture deletion rejects locked incoming links and otherwise clears them atomically', async () => {
  const initial = project();
  initial.map.fixtures = [{ id: 'gate', role: 'gate', x: 3, row: 2, direction: 0, offset: { x: 0, y: 0, z: 0 } },
    { id: 'switch', role: 'switch', x: 2, row: 2, direction: 0, offset: { x: 0, y: 0, z: 0 }, linkedId: 'gate' }];
  const locked = harness(initial); locked.designer.selectFixture('gate'); await locked.click('delete-fixture');
  assert.equal(locked.commits(), 0); assert.deepEqual(locked.current(), initial); assert.match(locked.messages.at(-1)!, /잠긴 배치물/);
  initial.map.lockedCells = [];
  const editable = harness(initial); editable.designer.selectFixture('gate'); await editable.click('delete-fixture');
  assert.equal(editable.commits(), 1); assert.equal(editable.current().map.fixtures!.length, 1);
  assert.equal(editable.current().map.fixtures![0].linkedId, undefined);
  assert.deepEqual(validateMap(editable.current().map).filter(issue => issue.message.includes('연결 대상')), []);
});

test('choosing a fixture or marker from the list resets an older rectangular selection', async () => {
  const initial = project(); initial.map.fixtures![0].x = 5; initial.map.fixtures![0].row = 5;
  initial.map.markers = [{ id: 'reward', label: '보상', kind: 'reward', contentKey: '', x: 6, row: 6, direction: 0, offset: { x: 0, y: 0, z: 0 } }];
  const h = harness(initial);
  h.change('area-width', '3'); h.change('area-height', '2');
  await h.click('select-fixture', 'lamp'); assert.deepEqual(h.designer.selection(), { x: 5, row: 5, width: 1, height: 1 });
  h.change('area-width', '2'); await h.click('select-marker', 'reward');
  assert.deepEqual(h.designer.selection(), { x: 6, row: 6, width: 1, height: 1 });
});

test('cell ceiling defaults to highest-floor automatic height; direct Y entry becomes manual', async () => {
  const initial = project(); initial.map.lockedCells = [];
  const automatic = harness(initial); await automatic.click('add-cell-ceiling');
  assert.equal(automatic.current().map.ceilings![0].undersideY, 6);
  assert.equal(automatic.current().map.ceilings![0].heightMode, 'auto');
  automatic.change('ceiling-y', '9');
  assert.equal(automatic.current().map.ceilings![0].heightMode, 'manual');
  assert.equal(automatic.current().map.ceilings![0].undersideY, 9);
  automatic.change('ceiling-mode', 'auto');
  assert.equal(automatic.current().map.ceilings![0].undersideY, 6);
  const manual = harness(initial); manual.change('ceiling-y', '11'); await manual.click('add-cell-ceiling');
  assert.equal(manual.current().map.ceilings![0].undersideY, 11);
  assert.equal(manual.current().map.ceilings![0].heightMode, 'manual');
});

test('gap repair preserves authored ceilings and explicit adoption changes unlocked roofs only', async () => {
  const initial = project(); initial.map.ceilings = [{ x: 2, row: 2, undersideY: 9 }, { x: 3, row: 2, undersideY: 8 }];
  const h = harness(initial); await h.click('fill-structures');
  assert.deepEqual(h.current().map.ceilings, initial.map.ceilings);
  assert.ok(h.current().map.structureFills!.length > 0);
  await h.click('adopt-auto-ceiling');
  assert.equal(h.current().map.ceilings!.find(c => c.x === 2)!.undersideY, 9);
  assert.equal(h.current().map.ceilings!.find(c => c.x === 3)!.undersideY, 6);
  assert.equal(h.current().map.ceilings!.length, 2, 'roof holes stay empty');
  h.change('current-clearance', '5');
  assert.equal(h.current().map.ceilings!.find(c => c.x === 3)!.undersideY, 7);
  assert.equal(h.current().settings.designer?.ceilingHeight, initial.settings.designer?.ceilingHeight, 'current-map clearance is separate from new-generation defaults');
});

test('pit controls edit connected closure and reject locked pit cells', async () => {
  const initial = project(); initial.map.lockedCells = []; initial.map.fixtures = []; initial.map.assetOverrides = [];
  initial.map.rows[2] = initial.map.rows[2].slice(0, 2) + '__' + initial.map.rows[2].slice(4);
  const h = harness(initial); await h.click('fill-structures');
  h.change('pit-kind', 'floor'); h.change('pit-y', '-7'); h.change('pit-thickness', '.5');
  const bottoms = h.current().map.pitBottoms!;
  assert.equal(bottoms.length, 2); assert.ok(bottoms.every(b => b.kind === 'floor' && b.y === -7 && b.thickness === .5));
  h.current().map.lockedCells = [{ x: 3, row: 2 }]; const commits = h.commits(); h.change('pit-y', '-8');
  assert.equal(h.commits(), commits); assert.match(h.messages.at(-1)!, /잠긴/);
});

test('designer exposes separate services, safe room types, analysis and deadzone visibility', async () => {
  const h = harness(project()), markup = h.designer.renderGeneration();
  for (const feature of ['rests', 'merchants', 'altars']) assert.ok(markup.includes(`data-d-feature="${feature}"`));
  assert.ok(markup.includes('시작방') && markup.includes('상점방'));
  assert.match(h.designer.renderInspector(), /실제 통행 면적/);
  assert.equal(h.designer.previewOptions().showDeadzone, false);
  await h.click('view-deadzone'); assert.equal(h.designer.previewOptions().showDeadzone, true);
  await h.click('view-design'); assert.ok(h.designer.previewOptions().designReport);
});
