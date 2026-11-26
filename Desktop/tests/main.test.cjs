'use strict';

// Execute main-process functions with Electron mocked. Never launch Electron or issue Unity commands.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { ProjectClient } = require('../src/project-client.cjs');

const mainPath = path.resolve(__dirname, '../src/main.cjs');
const localRequire = createRequire(mainPath);

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'combat-lab-main-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  function project(name) {
    const root = path.join(temporary, name);
    fs.mkdirSync(path.join(root, 'Assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ProjectSettings'));
    fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.10f1');
    return fs.realpathSync(root);
  }
  const root = project('projectA');
  const calls = [], statuses = new Map(), ipc = new Map();
  const options = {
    save: async () => ({ canceled: true }),
    generate: async () => ({ candidates: [], provider: 'codex', createdUtc: '2026-10-08T00:00:00Z' }),
    describe: async target => ({ adapters: [{ id: path.basename(target.projectPath), sources: [] }] })
  };
  class FakeClient extends ProjectClient {
    getStatus() { return { connected: true, running: false, isPlaying: false, isCompiling: false,
      status: path.basename(this.projectPath), ...statuses.get(this.projectPath) }; }
    describe() { return options.describe(this); }
    async command(name, payload) { calls.push({ projectPath: this.projectPath, name, payload }); return { assetPath: payload.assetPath }; }
  }
  const electron = {
    app: { setName() {}, getPath: () => path.join(temporary, 'settings'), requestSingleInstanceLock: () => false, quit() {} },
    nativeTheme: { themeSource: 'system' },
    protocol: { registerSchemesAsPrivileged() {} },
    dialog: { showSaveDialog: (...args) => options.save(...args) },
    ipcMain: { handle: (name, callback) => ipc.set(name, callback) }
  };
  const providerStatus = {
    codex: { available: true, authenticated: true, provider: 'codex', label: 'Codex 연결됨', error: '' },
    claude: { available: true, authenticated: true, provider: 'claude', label: 'Claude Code 연결됨', error: '' }
  };
  const generatorCalls = [];
  const fakeGenerator = provider => class {
    async status() { return { ...providerStatus[provider] }; }
    generate(input, optionsValue) { generatorCalls.push(provider); return options.generate(input, optionsValue, provider); }
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './project-client.cjs' ? { ProjectClient: FakeClient } : name === './ai-candidates.cjs' ? { CodexCandidateGenerator: fakeGenerator('codex'), ClaudeCodeCandidateGenerator: fakeGenerator('claude') } : localRequire(name),
    process: { argv: [], platform: process.platform }, __dirname: path.dirname(mainPath),
    Buffer, URL, Response, console, setTimeout, structuredClone, AbortController
  });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8') + '\nglobalThis.testApi = {handlers, selectProject, snapshot, media, installIpc, setWindow: value => { window = value; }};', context);
  const api = context.testApi;
  api.selectProject(root);
  const request = { schemaVersion: 1, candidates: [{ id: 'baseline', values: [] }] };
  return { temporary, root, project, api, options, calls, statuses, request, ipc, nativeTheme: electron.nativeTheme, providerStatus, generatorCalls };
}

test('AI provider auto-selects Codex first, falls back to a logged-in Claude Code, and persists explicit choices', async t => {
  const { temporary, api, providerStatus } = fixture(t);
  const settingsFile = path.join(temporary, 'settings', 'settings.json');
  let status = await api.handlers.aiStatus();
  assert.equal(status.preference, 'auto');
  assert.equal(status.provider, 'codex');

  providerStatus.codex = { available: true, authenticated: false, provider: 'codex', label: 'Codex 로그인 필요', error: '로그인' };
  status = await api.handlers.aiStatus();
  assert.equal(status.provider, 'claude');
  assert.equal(status.authenticated, true);

  providerStatus.claude = { available: false, authenticated: false, provider: 'claude', label: 'Claude Code 연결 필요', error: '없음' };
  status = await api.handlers.aiStatus();
  assert.equal(status.provider, 'codex', 'an installed but logged-out CLI is reported before a missing one');
  assert.equal(status.authenticated, false);

  providerStatus.claude = { available: true, authenticated: true, provider: 'claude', label: 'Claude Code 연결됨', error: '' };
  status = await api.handlers.setAiProvider('codex');
  assert.equal(status.preference, 'codex');
  assert.equal(status.provider, 'codex', 'an explicit choice never falls back to another CLI');
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).aiProvider, 'codex');
  status = await api.handlers.setAiProvider('claude');
  assert.equal(status.provider, 'claude');
  assert.equal(status.authenticated, true);
  for (const invalid of ['openai', '', null, {}]) await assert.rejects(api.handlers.setAiProvider(invalid));
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).aiProvider, 'claude');
});

test('theme preferences update native controls and persist across project changes', t => {
  const { temporary, root, api, project, nativeTheme } = fixture(t);
  const settingsFile = path.join(temporary, 'settings', 'settings.json');
  api.handlers.setTheme('dark');
  assert.equal(nativeTheme.themeSource, 'dark');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { projectPath: root, theme: 'dark' });

  const other = project('projectB');
  api.selectProject(other);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { projectPath: other, theme: 'dark' });
  assert.equal(nativeTheme.themeSource, 'dark');

  api.handlers.setTheme('light');
  assert.equal(nativeTheme.themeSource, 'light');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { projectPath: other, theme: 'light' });
});

test('invalid theme requests preserve the saved preference and native appearance', t => {
  const { temporary, api, nativeTheme } = fixture(t);
  const settingsFile = path.join(temporary, 'settings', 'settings.json');
  api.handlers.setTheme('dark');
  const saved = fs.readFileSync(settingsFile, 'utf8');
  for (const invalid of ['system', 'Dark', '', null, undefined, {}, ['light']]) {
    assert.throws(() => api.handlers.setTheme(invalid));
    assert.equal(nativeTheme.themeSource, 'dark');
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), saved);
  }
});

test('report refresh preserves media grants and invalidates grants on project change', async t => {
  const { root, api, project } = fixture(t);
  const directory = path.join(root, 'CombatLabResults', 'run-a');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'video.mp4'), 'video');
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({
    schemaVersion: 1, runId: 'run-a', startedUtc: '2026-10-08T00:00:00Z', results: [{
      candidate: { id: 'baseline', values: [] }, status: 'completed', videoPath: path.join(directory, 'video.mp4')
    }]
  }));
  const first = await api.handlers.loadReport('run-a');
  for (let i = 0; i < 4; i++) {
    const next = await api.handlers.loadReport('run-a');
    assert.equal(next.report.results[0].videoUrl, first.report.results[0].videoUrl);
  }
  assert.equal(api.media.size, 1);
  api.selectProject(project('projectB'));
  assert.equal(api.media.size, 0);
});

test('preset export allows only a new .asset under canonical Assets', async t => {
  const { root, temporary, api, options, calls, request } = fixture(t);
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'Assets', 'escaped'), 'junction');
  const existing = path.join(root, 'Assets', 'existing.asset');
  fs.writeFileSync(existing, 'preserve');
  for (const filePath of [
    path.join(outside, 'outside.asset'), path.join(root, 'Assets', 'escaped', 'outside.asset'),
    path.join(root, 'Assets', 'wrong.txt'), existing, path.join(root, 'Assets', 'NUL.asset')
  ]) {
    options.save = async () => ({ canceled: false, filePath });
    await assert.rejects(api.handlers.exportPreset({ request, candidateId: 'baseline' }));
  }
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'preserve');
  options.save = async () => ({ canceled: false, filePath: path.join(root, 'Assets', '새 프리셋.asset') });
  const saved = await api.handlers.exportPreset({ request, candidateId: 'baseline' });
  assert.equal(saved.assetPath, 'Assets/새 프리셋.asset');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'export');
});

test('export rechecks compilation and selected project after native chooser returns', async t => {
  const { root, api, options, calls, request, statuses, project } = fixture(t);
  options.save = async () => {
    statuses.set(root, { isCompiling: true });
    return { canceled: false, filePath: path.join(root, 'Assets', 'new.asset') };
  };
  await assert.rejects(api.handlers.exportPreset({ request, candidateId: 'baseline' }), /편집 모드/);
  statuses.set(root, {});
  const other = project('projectB');
  options.save = async () => {
    api.selectProject(other);
    return { canceled: false, filePath: path.join(root, 'Assets', 'new.asset') };
  };
  await assert.rejects(api.handlers.exportPreset({ request, candidateId: 'baseline' }), /프로젝트가 변경/);
  assert.equal(calls.length, 0);
});

function combinedFixture(t) {
  const current = fixture(t);
  const base = { schemaVersion: 1, adapterId: 'combat', sourceGuid: 'source-guid', durationSeconds: 10, seed: 1701, recordVideo: true,
    candidates: [{ id: 'baseline', values: [{ id: 'impact', value: 1 }] }, { id: 'chosen', values: [{ id: 'impact', value: 1.5 }] }] };
  const request = { schemaVersion: 1, adapterId: base.adapterId, sourceGuid: base.sourceGuid,
    selections: ['normal-combo', 'skill'].map(actionId => ({ request: { ...structuredClone(base), actionId }, candidateId: 'chosen' })) };
  const catalog = { adapters: [{ id: base.adapterId, displayName: 'Combat', supportsCombinedExport: true,
    sources: [{ guid: base.sourceGuid, label: 'Assets/Game/PlayerForm.asset', parameters: [],
      defaultRequest: base, actions: request.selections.map(selection => ({ id: selection.request.actionId,
        label: selection.request.actionId, available: true,
        parameters: [{ id: 'impact', label: 'Impact', minimum: 0, maximum: 2, baseline: 1 }],
        defaultRequest: selection.request })) }] }] };
  current.options.describe = async () => structuredClone(catalog);
  return { ...current, combinedRequest: request, combinedCatalog: catalog };
}

test('combined export opens one chooser and sends every chosen attack in one asset command', async t => {
  const { root, api, options, calls, combinedRequest: request } = combinedFixture(t);
  let choosers = 0;
  options.save = async () => { choosers++; return { canceled: false, filePath: path.join(root, 'Assets', '선택한 공격.asset') }; };
  const saved = await api.handlers.exportCombinedPreset({ request });
  assert.equal(saved.assetPath, 'Assets/선택한 공격.asset');
  assert.equal(choosers, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectPath, root);
  assert.equal(calls[0].name, 'export-combined');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), { request, assetPath: 'Assets/선택한 공격.asset' });
});

test('combined export validates identities, unique actions, selected candidates and nested requests before choosing a file', async t => {
  const { api, options, calls, combinedRequest } = combinedFixture(t);
  let choosers = 0;
  options.save = async () => { choosers++; return { canceled: true }; };
  const invalid = [
    request => { request.schemaVersion = 2; },
    request => { request.selections = []; },
    request => { request.selections = Array.from({ length: 33 }, (_, index) => ({ ...structuredClone(request.selections[0]),
      request: { ...structuredClone(request.selections[0].request), actionId: `action-${index}` } })); },
    request => { request.adapterId = ''; },
    request => { request.sourceGuid = ''; },
    request => { request.selections[1].request.adapterId = 'another-adapter'; },
    request => { request.selections[1].request.sourceGuid = 'another-source'; },
    request => { request.selections[1].request.actionId = 'normal-combo'; },
    request => { request.selections[1].request.actionId = ''; },
    request => { delete request.selections[1].request.actionId; },
    request => { request.selections[1].candidateId = ''; },
    request => { request.selections[1].candidateId = 'not-in-candidates'; },
    request => { delete request.selections[1].candidateId; },
    request => { request.selections[1].request.schemaVersion = 2; },
    request => { request.selections[1].request.candidates = {}; },
    request => { request.selections[1].request.candidates = []; },
    request => { request.selections[1].request.candidates[0].id = 'chosen'; },
    request => { request.selections[1].request.candidates[1].id = '../chosen'; },
    request => { request.selections[1].request.candidates[1].values = []; },
    request => { request.selections[1].request.candidates[1].values[0].value = Infinity; },
    request => { request.selections[1].request.candidates[1].values[0].value = 3; },
    request => { request.selections[1].request.candidates[1].values[0].id = 'untrusted-parameter'; },
    request => { request.selections[1].request.durationSeconds = 0; },
    request => { request.selections[1].request.durationSeconds = 61; },
    request => { request.selections[1].request.seed = 0.5; },
    request => { request.selections[1].request.recordVideo = 'true'; },
    request => { request.selections[1].request.actionId = '../skill'; },
    request => { request.selections[1].request = null; },
    request => { request.selections[1] = null; }
  ];
  for (const mutate of invalid) {
    const request = structuredClone(combinedRequest);
    mutate(request);
    await assert.rejects(api.handlers.exportCombinedPreset({ request }), undefined, mutate.toString());
  }
  assert.equal(choosers, 0);
  assert.equal(calls.length, 0);
});

test('combined export accepts a single action and treats an omitted action as the legacy normal combo', async t => {
  const { root, api, options, calls, combinedRequest: request } = combinedFixture(t);
  request.selections = request.selections.slice(0, 1);
  delete request.selections[0].request.actionId;
  options.save = async () => ({ canceled: false, filePath: path.join(root, 'Assets', 'Legacy.asset') });
  await api.handlers.exportCombinedPreset({ request });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'export-combined');
  assert.equal(calls[0].payload.request.selections.length, 1);
});

test('combined export supports a legacy adapter with combined export but no action catalog', async t => {
  const { root, api, options, calls, combinedRequest: request, combinedCatalog: catalog } = combinedFixture(t);
  const source = catalog.adapters[0].sources[0];
  source.parameters = structuredClone(source.actions[0].parameters);
  source.actions = [];
  request.selections = request.selections.slice(0, 1);
  delete request.selections[0].request.actionId;
  options.save = async () => ({ canceled: false, filePath: path.join(root, 'Assets', 'LegacyCombined.asset') });
  await api.handlers.exportCombinedPreset({ request });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'export-combined');
  assert.equal(calls[0].payload.request.selections.length, 1);
  request.selections[0].request.actionId = 'skill';
  await assert.rejects(api.handlers.exportCombinedPreset({ request }));
  assert.equal(calls.length, 1, 'a legacy adapter cannot silently accept a named action it did not advertise');
});

test('combined export accepts 32 distinct selected actions and snapshots the payload before the chooser', async t => {
  const { root, api, options, calls, combinedRequest: request, combinedCatalog: catalog } = combinedFixture(t);
  const template = request.selections[0];
  request.selections = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(template),
    request: { ...structuredClone(template.request), actionId: `attack-${index}` } }));
  const source = catalog.adapters[0].sources[0];
  const actionTemplate = source.actions[0];
  source.actions = request.selections.map(selection => ({ ...structuredClone(actionTemplate), id: selection.request.actionId,
    defaultRequest: structuredClone(selection.request) }));
  const expected = structuredClone(request);
  options.save = async () => {
    request.selections[0].candidateId = 'baseline';
    request.selections[1].request.candidates[1].values[0].value = 1.9;
    return { canceled: false, filePath: path.join(root, 'Assets', 'AllActions.asset') };
  };
  await api.handlers.exportCombinedPreset({ request });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload.request)), expected);
});

test('combined export requires the current adapter capability from Unity rather than renderer or cached metadata', async t => {
  const { api, options, calls, combinedRequest: request, combinedCatalog: catalog } = combinedFixture(t);
  let choosers = 0;
  options.save = async () => { choosers++; return { canceled: true }; };
  await api.snapshot();
  for (const capability of [undefined, false, 'true']) {
    catalog.adapters[0].supportsCombinedExport = capability;
    await assert.rejects(api.handlers.exportCombinedPreset({ request, supportsCombinedExport: true }));
  }
  catalog.adapters[0].supportsCombinedExport = true;
  catalog.adapters[0].id = 'replacement-adapter';
  await assert.rejects(api.handlers.exportCombinedPreset({ request }));
  assert.equal(choosers, 0);
  assert.equal(calls.length, 0);
});

test('combined export rejects removed sources and unavailable actions before opening the chooser', async t => {
  const { api, options, calls, combinedRequest: request, combinedCatalog: catalog } = combinedFixture(t);
  let choosers = 0;
  options.save = async () => { choosers++; return { canceled: true }; };
  const source = catalog.adapters[0].sources[0];
  source.guid = 'replacement-source';
  await assert.rejects(api.handlers.exportCombinedPreset({ request }));
  source.guid = request.sourceGuid;
  source.actions[1].available = false;
  await assert.rejects(api.handlers.exportCombinedPreset({ request }));
  source.actions.pop();
  await assert.rejects(api.handlers.exportCombinedPreset({ request }));
  assert.equal(choosers, 0);
  assert.equal(calls.length, 0);
});

test('combined export allows only one new asset under canonical Assets and preserves existing files', async t => {
  const { root, temporary, api, options, calls, combinedRequest: request } = combinedFixture(t);
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'Assets', 'escaped'), 'junction');
  const existing = path.join(root, 'Assets', 'existing.asset');
  fs.writeFileSync(existing, 'preserve');
  const existingMeta = path.join(root, 'Assets', 'orphan.asset.meta');
  fs.writeFileSync(existingMeta, 'preserve-guid');
  for (const filePath of [path.join(outside, 'outside.asset'), path.join(root, 'Assets', 'escaped', 'outside.asset'),
    path.join(root, 'Assets', '..', 'outside.asset'), path.join(root, 'Assets', 'wrong.txt'), existing,
    path.join(root, 'Assets', 'orphan.asset'), path.join(root, 'Assets', 'NUL.asset')]) {
    options.save = async () => ({ canceled: false, filePath });
    await assert.rejects(api.handlers.exportCombinedPreset({ request }));
  }
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'preserve');
  assert.equal(fs.readFileSync(existingMeta, 'utf8'), 'preserve-guid');
});

test('combined export cancellation creates nothing and rechecks Unity state after the chooser', async t => {
  const { root, api, options, calls, statuses, combinedRequest: request } = combinedFixture(t);
  options.save = async () => ({ canceled: true });
  assert.equal((await api.handlers.exportCombinedPreset({ request })).cancelled, true);
  for (const change of [{ connected: false }, { running: true }, { isPlaying: true }, { isCompiling: true }]) {
    statuses.set(root, {});
    options.save = async () => {
      statuses.set(root, change);
      return { canceled: false, filePath: path.join(root, 'Assets', 'Combined.asset') };
    };
    await assert.rejects(api.handlers.exportCombinedPreset({ request }));
  }
  assert.equal(calls.length, 0);
});

test('combined export aborts when a project changes while choosing the asset path', async t => {
  const { root, api, options, calls, project, combinedRequest: request } = combinedFixture(t);
  const other = project('projectB');
  options.save = async () => {
    api.selectProject(other);
    return { canceled: false, filePath: path.join(root, 'Assets', 'Combined.asset') };
  };
  await assert.rejects(api.handlers.exportCombinedPreset({ request }), /프로젝트가 변경/);
  assert.equal(calls.length, 0);
});

test('combined export IPC is registered and rejects untrusted senders before opening the chooser', async t => {
  const { root, api, options, calls, ipc, combinedRequest: request } = combinedFixture(t);
  let choosers = 0;
  options.save = async () => { choosers++; return { canceled: false, filePath: path.join(root, 'Assets', 'Combined.asset') }; };
  api.installIpc();
  const frame = { url: 'baekho://app/index.html' };
  const contents = { mainFrame: frame };
  api.setWindow({ webContents: contents });
  const exportCombined = ipc.get('baekho:exportCombinedPreset');
  assert.equal(typeof exportCombined, 'function');
  await assert.rejects(exportCombined({ sender: {}, senderFrame: frame }, { request }), /허용되지 않은/);
  await assert.rejects(exportCombined({ sender: contents, senderFrame: { url: frame.url } }, { request }), /허용되지 않은/);
  frame.url = 'https://example.com';
  await assert.rejects(exportCombined({ sender: contents, senderFrame: frame }, { request }), /허용되지 않은/);
  assert.equal(choosers, 0);
  frame.url = 'baekho://app/index.html';
  await exportCombined({ sender: contents, senderFrame: frame }, { request });
  assert.equal(choosers, 1);
  assert.equal(calls.length, 1);
});

test('snapshot never combines old connection with a newly selected project', async t => {
  const { root, api, options, project } = fixture(t);
  let resolveOld;
  const oldDescription = new Promise(resolve => { resolveOld = resolve; });
  options.describe = target => target.projectPath === root ? oldDescription : Promise.resolve({ adapters: [{ id: 'projectB', sources: [] }] });
  const pending = api.snapshot();
  const other = project('projectB');
  api.selectProject(other);
  resolveOld({ adapters: [{ id: 'projectA', sources: [] }] });
  const snapshot = await pending;
  assert.equal(snapshot.projectPath, other);
  assert.equal(snapshot.connection.status, 'projectB');
  assert.equal(snapshot.catalog.adapters[0].id, 'projectB');
});

test('snapshot refreshes the catalog once after reconnect or compilation, including empty catalogs', async t => {
  const { root, api, options, statuses } = fixture(t);
  let describes = 0, nextCatalog = { adapters: [{ id: 'initial', sources: [] }] };
  options.describe = async () => { describes++; return structuredClone(nextCatalog); };
  assert.equal((await api.snapshot()).catalog.adapters[0].id, 'initial');
  await api.snapshot();
  assert.equal(describes, 1, 'ordinary heartbeats use the existing catalog');
  statuses.set(root, { connected: false });
  await api.snapshot();
  nextCatalog = { adapters: [{ id: 'after-reload', sources: [] }] };
  statuses.set(root, { connected: true, isCompiling: true });
  await api.snapshot();
  assert.equal(describes, 1, 'wait until compilation has completed');
  statuses.set(root, { connected: true });
  assert.equal((await api.snapshot()).catalog.adapters[0].id, 'after-reload');
  await api.snapshot();
  assert.equal(describes, 2);
  statuses.set(root, { isCompiling: true });
  await api.snapshot();
  statuses.set(root, {});
  nextCatalog = { adapters: [] };
  assert.equal((await api.snapshot()).catalog.adapters.length, 0);
  await api.snapshot();
  assert.equal(describes, 3, 'an empty but successfully described catalog is cached too');
});

test('a failed catalog refresh after reconnect retries without replacing the last known catalog', async t => {
  const { root, api, options, statuses } = fixture(t);
  await api.snapshot();
  statuses.set(root, { connected: false });
  await api.snapshot();
  statuses.set(root, {});
  options.describe = async () => { throw new Error('reload in progress'); };
  const pending = await api.snapshot();
  assert.equal(pending.catalog.adapters[0].id, 'projectA');
  assert.equal(pending.connection.error, 'reload in progress');
  options.describe = async () => ({ adapters: [{ id: 'ready', sources: [] }] });
  assert.equal((await api.snapshot()).catalog.adapters[0].id, 'ready');
});

test('project switching blocks a live run but allows stale last-known running state', t => {
  const { root, api, statuses, project } = fixture(t);
  const other = project('projectB');
  statuses.set(root, { connected: true, running: true });
  assert.throws(() => api.selectProject(other), /실험/);
  statuses.set(root, { connected: false, running: true });
  assert.doesNotThrow(() => api.selectProject(other));
});

test('IPC rejects other senders, subframes and external pages', async t => {
  const { api, ipc } = fixture(t);
  api.installIpc();
  const frame = { url: 'baekho://app/index.html' };
  const contents = { mainFrame: frame };
  api.setWindow({ webContents: contents });
  const bootstrap = ipc.get('baekho:bootstrap');
  await assert.rejects(bootstrap({ sender: {}, senderFrame: frame }), /허용되지 않은/);
  await assert.rejects(bootstrap({ sender: contents, senderFrame: { url: frame.url } }), /허용되지 않은/);
  frame.url = 'https://example.com';
  await assert.rejects(bootstrap({ sender: contents, senderFrame: frame }), /허용되지 않은/);
  frame.url = 'baekho://app/index.html';
  assert.ok((await bootstrap({ sender: contents, senderFrame: frame })).projectPath);
});

function generationCatalog() {
  return { adapters: [{ id: 'combat', displayName: 'Combat', sources: [{ guid: 'source-guid', label: 'Assets/Game/Attack.asset',
    parameters: [{ id: 'impact', label: 'Impact', minimum: 0, maximum: 2, baseline: 1 }],
    defaultRequest: { schemaVersion: 1, adapterId: 'combat', sourceGuid: 'source-guid', durationSeconds: 10, seed: 1701, recordVideo: true, candidates: [] }
  }] }] };
}

test('AI generation uses trusted source metadata and preserves actual generated values and provenance', async t => {
  const { api, options } = fixture(t);
  options.describe = async () => generationCatalog();
  let supplied;
  options.generate = async input => {
    supplied = input;
    return { provider: 'codex', createdUtc: '2026-10-08T00:00:00Z', candidates: Array.from({ length: input.count }, (_, index) => ({
      id: `ai-${index + 1}`, label: `후보 ${index + 1}`, rationale: '예상 효과', values: [{ id: 'impact', value: 0.5 + index * 0.1 }]
    })) };
  };
  const request = await api.handlers.generateCandidates({ adapterId: 'combat', sourceGuid: 'source-guid', goal: ' 무게감 ', count: 4,
    parameters: [{ id: 'unexpected', maximum: 100000 }] });
  assert.equal(supplied.goal, '무게감');
  assert.equal(supplied.parameters[0].id, 'impact');
  assert.equal(supplied.sourceLabel, 'Attack.asset');
  assert.equal(request.candidates.length, 4);
  assert.equal(request.candidates[3].values[0].value, 0.8);
  assert.equal(request.candidates[0].rationale, '예상 효과');
  assert.equal(request.generation.provider, 'codex');
  assert.equal(request.generation.count, 4);
  assert.equal((await api.handlers.aiStatus()).generating, false);
});

test('AI generation runs through the selected Claude Code provider and records its provenance', async t => {
  const { api, options, providerStatus, generatorCalls } = fixture(t);
  options.describe = async () => generationCatalog();
  options.generate = async (input, _options, provider) => ({ provider, model: 'claude-test-model', createdUtc: '2026-10-08T00:00:00Z',
    candidates: Array.from({ length: input.count }, (_, index) => ({ id: `ai-${index + 1}`, label: `후보 ${index + 1}`, rationale: '예상 효과', values: [{ id: 'impact', value: 0.5 + index * 0.1 }] })) });
  await api.handlers.setAiProvider('claude');
  const request = await api.handlers.generateCandidates({ adapterId: 'combat', sourceGuid: 'source-guid', goal: '무게감', count: 2 });
  assert.deepEqual(generatorCalls, ['claude']);
  assert.equal(request.generation.provider, 'claude');
  assert.equal(request.generation.model, 'claude-test-model');

  providerStatus.claude = { available: true, authenticated: false, provider: 'claude', label: 'Claude Code 로그인 필요', error: 'Claude Code에서 로그인하세요.' };
  await api.handlers.aiStatus();
  await assert.rejects(api.handlers.generateCandidates({ adapterId: 'combat', sourceGuid: 'source-guid', goal: '무게감', count: 2 }), /Claude Code에서 로그인/);
  assert.deepEqual(generatorCalls, ['claude'], 'a logged-out provider is never invoked');
});

test('v2 refinement reads trusted measured telemetry and snapshots its guide without claiming edited values were measured', async t => {
  const { api, options, root } = fixture(t), catalog = generationCatalog(), source = catalog.adapters[0].sources[0];
  source.defaultRequest.schemaVersion = 2; source.defaultRequest.sourceHash = 'source-hash'; source.supportedRequestVersions = [1, 2]; source.curves = [];
  options.describe = async () => catalog;
  const directory = path.join(root, 'CombatLabResults', 'observed'); fs.mkdirSync(directory, { recursive: true });
  const candidate = { id: 'measured', label: '측정 후보', revision: 1, values: [{ id: 'impact', value: 0.5 }], curves: [] };
  const report = { schemaVersion: 1, runId: 'observed', adapterId: 'combat', sourceGuid: 'source-guid', actionId: 'normal-combo', sourceDependencyHash: 'source-hash', startedUtc: '2026-10-23T00:00:00Z', results: [
    { candidate, repeatIndex: 1, status: 'completed', metrics: { hits: 1, attackRequests: 1, appliedValues: [{ id: 'impact', value: 0.5 }], events: [{ kind: 'confirmed-impact', realTime: 0.3 }, { kind: 'camera-output', fov: 60 }, { kind: 'value-limited', detail: 'FOV requested=182 applied=179' }] }, capture: { precisionStatus: 'complete', maxIntervalUs: 24000 } }
  ] };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report));
  let supplied;
  options.generate = async input => { supplied = input; return { provider: 'codex', candidates: [0.6, 0.7].map((value, i) => ({ id: `ai-${i}`, values: [{ id: 'impact', value }], curves: [] })) }; };
  const input = { adapterId: 'combat', sourceGuid: 'source-guid', goal: '복귀를 빠르게', count: 2, schemaVersion: 2, mode: 'refine', recipeId: 'heavy', referenceCandidate: { ...candidate, revision: 2, values: [{ id: 'impact', value: 0.75 }] }, observationRef: { runId: 'observed', candidateId: 'measured' } };
  const request = await api.handlers.generateCandidates(input);
  assert.equal(supplied.observations.measuredRevision, 1); assert.equal(supplied.observations.referenceRevision, 2);
  assert.equal(supplied.observations.referenceMatchesMeasuredConfiguration, false);
  assert.deepEqual(Array.from(supplied.observations.repeats[0].events, event => event.kind), ['confirmed-impact', 'value-limited']);
  assert.equal(JSON.parse(request.generation.observationsJson).repeats[0].capture.maxIntervalUs, 24000);
  assert.equal(request.generation.guideHash.length, 64); assert.match(request.generation.guideSnapshot, /Combat feel guide/);
  assert.equal(JSON.parse(request.generation.recipesSnapshot).version, '1.0.0');
  source.parameters.push({ id: 'scene.inheritedStop', label: '상속 정지', minimum: 0, maximum: 1, baseline: 0.08 });
  report.results[0].metrics.appliedValues.push({ id: 'scene.inheritedStop', value: 0.03 });
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report));
  await api.handlers.generateCandidates({ ...input, referenceCandidate: candidate });
  assert.equal(supplied.observations.referenceValuesVerifiedFromAppliedValues, true);
  assert.equal(supplied.observations.referenceMatchesMeasuredConfiguration, false, 'changed inherited scene values cannot make an old source measurement match the current reference');
  report.sourceDependencyHash = 'different-source'; fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report));
  await assert.rejects(api.handlers.generateCandidates(input), /원본 버전/);
});

test('AI generation rejects invalid count or missing source before invoking a model', async t => {
  const { api, options } = fixture(t);
  options.describe = async () => generationCatalog();
  let calls = 0;
  options.generate = async () => { calls++; throw new Error('Unexpected AI call'); };
  for (const count of [1, 13, 2.5, '4']) await assert.rejects(api.handlers.generateCandidates({ adapterId: 'combat', sourceGuid: 'source-guid', goal: '목표', count }));
  await assert.rejects(api.handlers.generateCandidates({ adapterId: 'combat', sourceGuid: 'source-guid', goal: ' ', count: 4 }));
  await assert.rejects(api.handlers.generateCandidates({ adapterId: 'combat', sourceGuid: 'missing', goal: '목표', count: 4 }), /선택/);
  assert.equal(calls, 0);
});

test('AI generation uses the chosen action schema and rejects unavailable or unknown actions before the model', async t => {
  const { api, options } = fixture(t);
  const catalog = generationCatalog(), source = catalog.adapters[0].sources[0];
  source.actions = [
    { id: 'normal-combo', label: '일반 콤보', available: true, parameters: source.parameters, defaultRequest: source.defaultRequest },
    { id: 'skill', label: '화속성 스킬', available: true, parameters: [{ id: 'skillImpact', label: '스킬', minimum: 0, maximum: 4, baseline: 2 }], defaultRequest: { ...source.defaultRequest, actionId: 'skill' } },
    { id: 'ultimate', label: '궁극기', available: false, unavailableReason: '궁극기 데이터가 없습니다.', parameters: [], defaultRequest: null }
  ];
  options.describe = async () => catalog;
  const calls = [];
  options.generate = async input => { calls.push(input); return { provider: 'codex', candidates: [{ id: 'ai-01', values: [{ id: 'skillImpact', value: 3 }] }] }; };
  const input = { adapterId: 'combat', sourceGuid: 'source-guid', goal: '화염 명중감', count: 2 };
  const request = await api.handlers.generateCandidates({ ...input, actionId: 'skill', parameters: source.parameters });
  assert.equal(request.actionId, 'skill');
  assert.equal(calls[0].actionLabel, '화속성 스킬');
  assert.equal(calls[0].parameters[0].id, 'skillImpact');
  assert.equal(request.candidates[0].values[0].value, 3);
  await assert.rejects(api.handlers.generateCandidates({ ...input, actionId: 'ultimate' }), /궁극기 데이터/);
  await assert.rejects(api.handlers.generateCandidates({ ...input, actionId: 'missing' }), /찾을 수 없/);
  assert.equal(calls.length, 1);
  const legacy = await api.handlers.generateCandidates(input);
  assert.equal(legacy.actionId, 'normal-combo');
  assert.equal(calls[1].parameters[0].id, 'impact');
});

test('generation is cancellable and blocks duplicate generation, play and project switching until settled', async t => {
  const { api, options, request, project } = fixture(t);
  options.describe = async () => generationCatalog();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  options.generate = (_input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('AI 후보 생성을 취소했습니다.')), { once: true }); entered();
  });
  const input = { adapterId: 'combat', sourceGuid: 'source-guid', goal: '목표', count: 4 };
  const pending = api.handlers.generateCandidates(input);
  const cancelled = assert.rejects(pending, /취소/);
  await started;
  assert.equal((await api.handlers.aiStatus()).generating, true);
  await assert.rejects(api.handlers.generateCandidates(input), /이미/);
  await assert.rejects(api.handlers.run(request), /AI/);
  assert.throws(() => api.selectProject(project('other')), /AI/);
  assert.equal(api.handlers.cancelGeneration().cancelled, true);
  await cancelled;
  assert.equal((await api.handlers.aiStatus()).generating, false);
});
