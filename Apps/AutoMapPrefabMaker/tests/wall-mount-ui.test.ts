import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWallMountFields, handleWallMountField, renderWallMountSettings, renderWallMountReadiness, renderWallFixtureEditor } from '../src/wall-mount-ui';
import { createDesigner } from '../src/designer';
import { DEFAULT_SETTINGS, createDemoMap } from '../src/shared/map';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { placeholderWallBinding } from '../src/shared/wall-placeholders';
import type { AssetBinding, ProjectFile, MapFixture } from '../src/shared/types';

const light = (): AssetBinding => ({ id: 'door_light', role: 'light', label: '문 위 <조명>', prefabGuid: '1'.repeat(32), prefabPath: 'Assets/DoorLight.prefab', scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0, bounds: { center: { x: .2, y: .1, z: .15 }, size: { x: .6, y: .2, z: .3 } } });
const enabled = () => handleWallMountField(light(), 'enabled', true);

test('lights and decorations expose universal mount rules without changing their functional role or measurements', () => {
  const source = light(), original = structuredClone(source), initial = renderWallMountFields(source);
  assert.match(initial, /data-wall-field="enabled"/);
  let binding = handleWallMountField(source, 'enabled', true);
  binding = handleWallMountField(binding, 'sites.doorTop', true);
  binding = handleWallMountField(binding, 'probability', '75');
  binding = handleWallMountField(binding, 'heightMode', 'top');
  binding = handleWallMountField(binding, 'height', '.25');
  assert.equal(binding.role, 'light'); assert.deepEqual(binding.bounds, source.bounds);
  assert.ok(binding.wallMount?.sites.includes('doorTop')); assert.equal(binding.wallMount?.probability, 75);
  assert.equal(binding.wallMount?.height, .25); assert.deepEqual(source, original);
  assert.match(renderWallMountFields(binding), /문 위/);
  assert.match(renderWallMountFields(binding), /value="75"/);
  assert.equal(handleWallMountField(binding, 'enabled', false).wallMount, undefined);
  assert.equal(renderWallMountFields({ ...source, role: 'floor' }), '');
});

test('mount editing checks bounds and keeps at least one usable site', () => {
  const binding = enabled();
  for (const field of ['height', 'spacing', 'probability']) assert.throws(() => handleWallMountField(binding, field, 'NaN'));
  assert.throws(() => handleWallMountField(binding, 'probability', '101'));
  assert.throws(() => handleWallMountField(binding, 'spacing', '-1'));
  assert.throws(() => handleWallMountField(binding, 'sites.wrong', true));
  const onlyWall = { ...binding, wallMount: { ...binding.wallMount!, sites: ['wall' as const] } };
  assert.throws(() => handleWallMountField(onlyWall, 'sites.wall', false));
  assert.throws(() => handleWallMountField({ ...binding, role: 'prop' }, 'enabled', true));
});

test('generation defaults leave legacy walls off and current map exposes the next-generation switch beside its one-time action', () => {
  assert.match(renderWallMountSettings(undefined), /data-d-control="wall-setting:enabled"\s+\s*>/);
  const current = renderWallMountSettings(undefined, false, true);
  assert.match(current, /data-d-action="place-wall-mounts"/);
  assert.match(current, /data-d-control="wall-setting:enabled"\s+\s*>/);
  assert.match(current, /기존 배치와 잠금을 유지/);
  assert.match(current, /설정 변경만으로 기존 배관이 이동하지 않습니다/);
  assert.match(current, /다음 자동 생성에도 넣으려면/);
  assert.match(current, /wall-setting:density"[^>]*min="1"/);
  assert.match(current, /wall-setting:runDensity"[^>]*min="1"/);
  assert.match(current, /연속 배치 목표/); assert.match(current, /가로는 벽 길이, 세로는 설치 가능한 벽면 수/);
  assert.match(current, /wall-setting:placeholderFallback" checked/);
  assert.match(current, /프리팹이 없으면 임시 벽 부착물로 배치/);
  assert.match(renderWallMountSettings({ enabled: true, singles: true, runs: true, density: 20, runDensity: 40, placeholderFallback: false }), /wall-setting:placeholderFallback"\s+\s*>/);
  assert.match(current, /value="horizontal" selected>가로 · 벽을 따라 연결/);
  assert.match(renderWallMountSettings({ enabled: true, singles: true, runs: true, density: 20, runDensity: 40, runOrientation: 'vertical' }), /value="vertical" selected>세로 · 벽을 타고 상승/);
  assert.match(current, /wall-setting:connectRuns" checked/); assert.match(current, /가로·세로 배관 연결 \(엘보·T자\)/);
  assert.match(renderWallMountSettings({ enabled: true, singles: true, runs: true, density: 20, runDensity: 40, runOrientation: 'both', connectRuns: false }), /wall-setting:connectRuns"\s+\s*>/);
});

test('readiness offers temporary placement with an empty real catalog and keeps actual registered counts', () => {
  const settings = { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, wallMounts: { enabled: true, singles: true, runs: true, density: 20, runDensity: 40 } } };
  const ordinary = { ...light(), role: 'decoration' as const };
  const html = renderWallMountReadiness(settings, [ordinary]);
  assert.match(html, /벽용 등록 0개 · 크기 확인 0개 · 생성 배치 켜짐/);
  assert.match(html, /일반 ‘장식’ 에셋은 자동으로 벽에 붙지 않습니다/);
  assert.match(html, /프리팹 없이도 배치 확인 가능/);
  assert.doesNotMatch(html, /벽 부착물로 등록된 프리팹이 없습니다/);
  const disabled = renderWallMountReadiness({ ...settings, designer: { ...settings.designer, wallMounts: { ...settings.designer.wallMounts, placeholderFallback: false } } }, []);
  assert.match(disabled, /임시 부착물 꺼짐 · 등록된 벽용 프리팹만 사용/);
  assert.match(disabled, /벽 부착물로 등록된 프리팹이 없/);
  assert.equal(ordinary.wallMount, undefined);
});

test('readiness makes disabled generation and unmeasured assets visible without changing saved choices', () => {
  const measured = enabled(), unmeasured = enabled(); delete unmeasured.bounds; unmeasured.id = 'unmeasured';
  const settings = { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, wallMounts: { enabled: false, singles: true, runs: true, density: 20, runDensity: 40 } } };
  const original = structuredClone(settings);
  const disabled = renderWallMountReadiness(settings, [measured, unmeasured]);
  assert.match(disabled, /벽용 등록 2개 · 크기 확인 1개 · 생성 배치 꺼짐/);
  assert.match(disabled, /생성 시 벽 부착물 배치가 꺼져 있습니다/);
  const active = renderWallMountReadiness({ ...settings, designer: { ...settings.designer, wallMounts: { ...settings.designer.wallMounts, enabled: true } } }, [measured, unmeasured]);
  assert.match(active, /크기가 측정되지 않은 벽 부착물/);
  assert.deepEqual(settings, original);
});

test('wall inspector exposes validated movement deltas and compatible functional replacements', () => {
  const binding = enabled(), unrelated = { ...enabled(), id: 'sign', role: 'decoration' as const };
  const fixture: MapFixture = { id: 'mount_1', role: 'light', x: 1, row: 1, direction: 0, offset: { x: 0, y: 0, z: 0 }, anchor: 'wall', bindingId: binding.id,
    wall: { position: { x: 2, y: 3.5, z: 0 }, rotationY: 0, bounds: [], sockets: [], support: [], site: 'doorTop', doorId: 'entry', authored: true } };
  const html = renderWallFixtureEditor(fixture, [binding, unrelated]);
  assert.match(html, /문 위 &lt;조명&gt;/); assert.match(html, /현재 설치 높이 Y 3.5m/);
  assert.match(html, /data-d-control="wall-edit:height" value="0"/);
  assert.doesNotMatch(html, /value="sign"/); assert.doesNotMatch(html, /fixture:offset/);
  assert.match(renderWallFixtureEditor({ ...fixture, wall: { ...fixture.wall!, runId: 'run_1' } }, [binding]), /detach-wall-fixture/);
});

test('temporary wall inspector keeps no binding selected and offers only compatible measured real prefabs', () => {
  const valid = enabled(); valid.wallMount!.sites = ['wall'];
  const unrelated = { ...valid, id: 'sign', role: 'decoration' as const };
  const wrongSite = structuredClone(valid); wrongSite.id = 'only_door'; wrongSite.wallMount!.sites = ['doorTop'];
  const wrongKind = structuredClone(valid); wrongKind.id = 'straight'; wrongKind.wallMount!.kind = 'straight';
  const fixture: MapFixture = { id: 'temporary_1', role: 'light', x: 1, row: 1, direction: 0, offset: { x: 0, y: 0, z: 0 }, anchor: 'wall',
    wall: { position: { x: 2, y: 2, z: 0 }, rotationY: 0, bounds: [], sockets: [], support: [], site: 'wall', placeholder: 'wallLight' } };
  const html = renderWallFixtureEditor(fixture, [valid, unrelated, wrongSite, wrongKind]);
  assert.match(html, /임시 벽 조명/);
  assert.match(html, /value="" selected>임시 유지 · 실제 프리팹 선택/);
  assert.match(html, /value="door_light"/);
  for (const id of ['sign', 'only_door', 'straight', 'wm-placeholder-wallLight']) assert.doesNotMatch(html, new RegExp(`value="${id}"`));
  assert.match(html, /wall-edit:height/); assert.match(html, /delete-wall-fixture/);
  assert.equal(fixture.bindingId, undefined);
  assert.match(renderWallFixtureEditor(fixture, []), /교체할 수 있는 벽용 프리팹이 아직 없습니다/);
});

test('temporary pipe inspector offers native real kinds across families without displaying synthetic bindings', () => {
  const straight = placeholderWallBinding('pipeStraight'); straight.id = 'real_pipe'; straight.label = '실제 배관'; straight.prefabPath = 'Assets/Pipe.prefab'; straight.wallMount!.family = 'industrial';
  const cap = placeholderWallBinding('pipeEndCap'); cap.id = 'real_cap'; cap.prefabPath = 'Assets/Cap.prefab';
  const fixture: MapFixture = { id: 'temporary_pipe', role: 'decoration', x: 1, row: 1, direction: 0, offset: { x: 0, y: 0, z: 0 }, anchor: 'wall',
    wall: { position: { x: 0, y: 2, z: 0 }, rotationY: 0, bounds: [], sockets: [], support: [], site: 'wall', placeholder: 'pipeStraight', runId: 'pipe_run' } };
  const html = renderWallFixtureEditor(fixture, [straight, cap]);
  assert.match(html, /value="real_pipe"/); assert.doesNotMatch(html, /value="real_cap"/);
  assert.match(html, /detach-wall-fixture/);
  const corner = placeholderWallBinding('pipeInnerCorner'); corner.id = 'real_corner'; corner.prefabPath = 'Assets/Corner.prefab'; corner.wallMount!.family = 'industrial';
  assert.match(renderWallFixtureEditor({ ...fixture, wall: { ...fixture.wall!, site: 'corner', placeholder: 'pipeInnerCorner' } }, [corner, straight]), /value="real_corner"/);
});

test('wall elbows and tees expose their authoring rules and exact-kind bulk replacement candidates', () => {
  const source = { ...light(), role: 'decoration' as const };
  let binding = handleWallMountField(source, 'enabled', true); binding = handleWallMountField(binding, 'kind', 'elbow');
  assert.match(renderWallMountFields(binding), /value="elbow" selected/); assert.match(renderWallMountFields(binding), /로컬 XY 면/);
  binding = handleWallMountField(binding, 'kind', 'tee'); assert.match(renderWallMountFields(binding), /value="tee" selected/);
  const tee = placeholderWallBinding('pipeTee'); tee.id = 'real_tee'; tee.prefabPath = 'Assets/Tee.prefab'; tee.prefabGuid = '9'.repeat(32); tee.wallMount!.family = 'actual-network';
  const elbow = placeholderWallBinding('pipeElbow'); elbow.id = 'real_elbow'; elbow.prefabPath = 'Assets/Elbow.prefab'; elbow.prefabGuid = '8'.repeat(32);
  const fixture: MapFixture = { id: 'temporary_tee', role: 'decoration', x: 1, row: 1, direction: 0, offset: { x: 0, y: 0, z: 0 }, anchor: 'wall',
    wall: { position: { x: 0, y: 2, z: 0 }, rotationY: 0, rotationZ: 90, bounds: [], sockets: [ { position: { x: 0, y: 2, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, { position: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: 1, z: 0 } } ], support: [], site: 'wall', placeholder: 'pipeTee', runId: 'network' } };
  const map = createDemoMap(); map.fixtures = [fixture, { ...structuredClone(fixture), id: 'temporary_tee_other' }, { ...structuredClone(fixture), id: 'temporary_elbow', wall: { ...fixture.wall!, placeholder: 'pipeElbow' } }];
  const html = renderWallFixtureEditor(fixture, [tee, elbow], false, map);
  assert.match(html, /가로·세로 연결/); assert.doesNotMatch(html, /세로 부품/);
  assert.match(html, /value="real_tee"/); assert.doesNotMatch(html, /value="real_elbow"/); assert.match(html, /같은 종류 2개 한 번에 교체/);
});

test('designer keeps attachment settings through room presets and rejects invalid density without changing the project', () => {
  let project: ProjectFile = { formatVersion: 1, map: createDemoMap(), settings: { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, wallMounts: { enabled: true, singles: true, runs: false, density: 33, runDensity: 10 } } }, bindings: [enabled()] };
  const messages: string[] = [];
  const designer = createDesigner({ project: () => project, selected: () => null, select: () => {}, busy: () => false, commit: edit => edit(), render: () => {}, notify: message => messages.push(message), openComparison: async () => null, regenerate: async () => {} });
  const change = (field: string, value: string) => designer.change({ dataset: { dControl: field }, value, checked: false } as unknown as HTMLInputElement);
  const wall = structuredClone(project.settings.designer!.wallMounts);
  change('preset', 'boss'); assert.deepEqual(project.settings.designer!.wallMounts, wall);
  change('wall-setting:density', '101'); assert.deepEqual(project.settings.designer!.wallMounts, wall); assert.match(messages.at(-1)!, /1~100/);
  change('wall-setting:density', '0'); assert.deepEqual(project.settings.designer!.wallMounts, wall);
  change('wall-setting:density', '40'); assert.equal(project.settings.designer!.wallMounts?.density, 40);
  designer.change({ dataset: { dControl: 'wall-setting:placeholderFallback' }, value: '', checked: false } as unknown as HTMLInputElement);
  assert.equal(project.settings.designer!.wallMounts?.placeholderFallback, false);
  change('wall-setting:runOrientation', 'both'); assert.equal(project.settings.designer!.wallMounts?.runOrientation, 'both');
  change('wall-setting:runOrientation', 'diagonal'); assert.equal(project.settings.designer!.wallMounts?.runOrientation, 'both'); assert.match(messages.at(-1)!, /가로·세로/);
  designer.change({ dataset: { dControl: 'wall-setting:connectRuns' }, value: '', checked: false } as unknown as HTMLInputElement);
  assert.equal(project.settings.designer!.wallMounts?.connectRuns, false);
});

test('designer shows saved readiness in both panels and lets current-map users enable future generation explicitly', async () => {
  const project: ProjectFile = { formatVersion: 1, map: createDemoMap(), settings: { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, wallMounts: { enabled: false, singles: true, runs: false, density: 20, runDensity: 40 } } }, bindings: [enabled()] };
  const designer = createDesigner({ project: () => project, selected: () => null, select: () => {}, busy: () => false, commit: edit => edit(), render: () => {}, notify: () => {}, openComparison: async () => null, regenerate: async () => {} });
  for (const html of [designer.renderGeneration(), designer.renderWallTools()]) {
    assert.match(html, /data-wall-readiness/);
    assert.match(html, /벽용 등록 1개 · 크기 확인 1개 · 생성 배치 꺼짐/);
    assert.match(html, /data-d-control="wall-setting:enabled"\s+\s*>/);
  }
  assert.equal(project.settings.designer?.wallMounts?.enabled, false);
  await designer.click({ dataset: { dAction: 'place-wall-mounts' } } as unknown as HTMLElement);
  assert.equal(project.settings.designer?.wallMounts?.enabled, false, 'one-time placement must not enable future generation');
  designer.change({ dataset: { dControl: 'wall-setting:enabled' }, value: '', checked: true } as unknown as HTMLInputElement);
  assert.equal(project.settings.designer?.wallMounts?.enabled, true);
  assert.match(designer.renderWallTools(), /벽용 등록 1개 · 크기 확인 1개 · 생성 배치 켜짐/);
});

test('current map placement without prefabs reports temporary counts and keeps future generation off', async () => {
  const project: ProjectFile = { formatVersion: 1, map: createDemoMap(), settings: { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, wallMounts: { enabled: false, singles: true, runs: true, density: 60, runDensity: 40 } } }, bindings: [] };
  const messages: string[] = [];
  const designer = createDesigner({ project: () => project, selected: () => null, select: () => {}, busy: () => false, commit: edit => edit(), render: () => {}, notify: message => messages.push(message), openComparison: async () => null, regenerate: async () => {} });
  await designer.click({ dataset: { dAction: 'place-wall-mounts' } } as unknown as HTMLElement);
  const fixtures = project.map.fixtures?.filter(fixture => fixture.wall?.placeholder) ?? [];
  assert.ok(fixtures.length > 0); assert.ok(fixtures.every(fixture => !fixture.bindingId));
  assert.match(designer.renderWallTools(), new RegExp(`추가한 임시 부착물 ${fixtures.length}개 · 실제 프리팹 0개`));
  assert.equal(project.settings.designer?.wallMounts?.enabled, false);
  assert.match(messages.at(-1)!, /임시 \d+개 · 실제 프리팹 0개/);
  designer.selectFixture(fixtures[0].id);
  assert.match(designer.renderInspector(), /임시 유지 · 실제 프리팹 선택/);
  const original = structuredClone(project.map);
  designer.change({ dataset: { dControl: 'wall-edit:bindingId' }, value: '' } as unknown as HTMLInputElement);
  assert.deepEqual(project.map, original);
});

test('same-kind replacement selector is separate, counts the entire map and commits one atomic undo step', async () => {
  let project: ProjectFile = { formatVersion: 1, map: createDemoMap(), settings: { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, wallMounts: { enabled: true, singles: true, runs: false, density: 60, runDensity: 40 } } }, bindings: [] };
  const history: ProjectFile[] = [], messages: string[] = [];
  const designer = createDesigner({ project: () => project, selected: () => null, select: () => {}, busy: () => false, commit: edit => { history.push(structuredClone(project)); edit(); }, render: () => {}, notify: message => messages.push(message), openComparison: async () => null, regenerate: async () => {} });
  await designer.click({ dataset: { dAction: 'place-wall-mounts' } } as unknown as HTMLElement);
  const fixtures = project.map.fixtures!.filter(fixture => fixture.wall?.placeholder === 'wallLight'); assert.ok(fixtures.length > 1);
  const real = placeholderWallBinding('wallLight'); real.id = 'new_wall_light'; real.prefabGuid = '7'.repeat(32); real.prefabPath = 'Assets/ActualWallLight.prefab';
  project.bindings = [real]; designer.selectFixture(fixtures[0].id); const before = structuredClone(project), beforeCount = history.length;
  assert.match(designer.renderInspector(), new RegExp(`같은 종류 ${fixtures.length}개 한 번에 교체`));
  designer.change({ dataset: { dControl: 'wall-bulk-binding' }, value: real.id } as unknown as HTMLInputElement);
  assert.deepEqual(project, before, 'choosing a bulk prefab must not replace the selected item'); assert.equal(history.length, beforeCount);
  assert.match(designer.renderInspector(), /선택한 하나에 사용할 프리팹/);
  await designer.click({ dataset: { dAction: 'replace-wall-placeholders' } } as unknown as HTMLElement);
  assert.equal(history.length, beforeCount + 1); assert.equal(project.map.fixtures!.filter(fixture => fixture.bindingId === real.id).length, fixtures.length);
  assert.equal(project.map.fixtures!.filter(fixture => fixture.wall?.placeholder === 'wallLight').length, 0);
  assert.deepEqual(project.map.fixtures!.filter(fixture => fixture.wall?.placeholder), before.map.fixtures!.filter(fixture => fixture.wall?.placeholder && fixture.wall.placeholder !== 'wallLight'));
  project = history.pop()!; assert.deepEqual(project, before); assert.match(designer.renderInspector(), new RegExp(`같은 종류 ${fixtures.length}개 한 번에 교체`));
  assert.match(messages.at(-1)!, /한 번의 되돌리기/);
});

test('bulk replacement failure keeps every placeholder and does not create an undo step', async () => {
  const project: ProjectFile = { formatVersion: 1, map: createDemoMap(), settings: { ...DEFAULT_SETTINGS, designer: { ...DEFAULT_DESIGNER, wallMounts: { enabled: true, singles: true, runs: false, density: 60, runDensity: 40 } } }, bindings: [] };
  let commits = 0; const messages: string[] = [];
  const designer = createDesigner({ project: () => project, selected: () => null, select: () => {}, busy: () => false, commit: edit => { commits++; edit(); }, render: () => {}, notify: message => messages.push(message), openComparison: async () => null, regenerate: async () => {} });
  await designer.click({ dataset: { dAction: 'place-wall-mounts' } } as unknown as HTMLElement);
  const fixture = project.map.fixtures!.find(item => item.wall?.placeholder === 'wallLight')!;
  const real = placeholderWallBinding('wallLight'); real.id = 'oversized'; real.prefabGuid = '8'.repeat(32); real.prefabPath = 'Assets/Oversized.prefab'; real.bounds!.size = { x: 500, y: 500, z: 500 };
  project.bindings = [real]; designer.selectFixture(fixture.id); designer.change({ dataset: { dControl: 'wall-bulk-binding' }, value: real.id } as unknown as HTMLInputElement);
  const before = structuredClone(project), beforeCommits = commits;
  await designer.click({ dataset: { dAction: 'replace-wall-placeholders' } } as unknown as HTMLElement);
  assert.deepEqual(project, before); assert.equal(commits, beforeCommits); assert.match(messages.at(-1)!, /교체|벽면|겹|공간|범위/);
});
