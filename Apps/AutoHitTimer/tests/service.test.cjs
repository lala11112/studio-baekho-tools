'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Store, readJson, atomicJson } = require('../src/store.cjs');
const { Controller } = require('../src/controller.cjs');
const { ProjectClient } = require('../src/project-client.cjs');
const mainPath = path.resolve(__dirname, '../src/main.cjs'), localRequire = createRequire(mainPath);
function fixture(t, { legacy = false } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-service-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const dataRoot = path.join(temporary, 'integrated'), legacyDataRoot = path.join(temporary, 'legacy');
  const calls = [], handlers = new Map(), protocols = new Map(), intervals = new Map(), sent = [];
  let controller, window = { kind: 'host', webContents: {} }, contents = { mainFrame: { url: 'aht://app/index.html?embedded=1' }, send: (...args) => sent.push(args) };
  const options = { open: async () => ({ canceled: true }), ready: true };
  class TrackedStore extends Store {
    load(project) { calls.push('load'); return super.load(project); }
    save(project, value) { calls.push('save'); return super.save(project, value); }
  }
  class Client extends ProjectClient {
    async command(name) { calls.push('unity:' + name); return {}; }
  }
  class TestController extends Controller {
    constructor(value) {
      calls.push('controller');
      super({ ...value, clientFactory: project => new Client(project), ai: { status: async () => { calls.push('ai:status'); return {}; } } });
      controller = this;
    }
    async shutdown() { calls.push('shutdown'); return super.shutdown(); }
  }
  const lifecycle = [];
  const electron = {
    app: { isReady: () => options.ready, setName: () => lifecycle.push('name'), setPath: () => lifecycle.push('path'),
      getPath: () => { lifecycle.push('getPath'); return temporary; }, requestSingleInstanceLock: () => { lifecycle.push('lock'); return false; },
      on: () => lifecycle.push('listener'), quit: () => lifecycle.push('quit'), whenReady: () => { lifecycle.push('ready'); return Promise.resolve(); } },
    BrowserWindow: class { constructor() { lifecycle.push('window'); } },
    ipcMain: { handle: (name, callback) => { assert.ok(!handlers.has(name)); handlers.set(name, callback); } },
    protocol: { registerSchemesAsPrivileged: () => lifecycle.push('privileges'), handle: (name, callback) => { assert.ok(!protocols.has(name)); protocols.set(name, callback); } },
    dialog: { showOpenDialog: (...args) => options.open(...args) }, shell: {}, net: { fetch: url => ({ fileUrl: url }) }
  };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : name === './controller.cjs' ? { Controller: TestController }
    : name === './store.cjs' ? { Store: TrackedStore, readJson, atomicJson } : name === './project-client.cjs' ? { ...localRequire(name), ProjectClient: Client } : localRequire(name),
    module: { exports: {} }, __dirname: path.dirname(mainPath), Buffer, URL, Response, structuredClone,
    setInterval: callback => { const id = intervals.size + 1; intervals.set(id, callback); return id; }, clearInterval: id => intervals.delete(id) });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context);
  const createService = () => context.module.exports.createAutoHitTimerService({ getWindow: () => window, getWebContents: () => contents,
    dataRoot, ...(legacy ? { legacyDataRoot } : {}), kitRoot: path.join(temporary, 'kit') });
  const service = createService();
  function project(name = 'project-A') {
    const root = path.join(temporary, name);
    fs.mkdirSync(path.join(root, 'Assets'), { recursive: true }); fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'Unity fixture');
    return fs.realpathSync(root);
  }
  function seed(root, projectPath, jobs = []) {
    const store = new Store(root); store.savePreferences({ projectPath }); store.save(projectPath, { jobs, settings: {}, selectedJobId: jobs[0]?.id || '' });
    return store.filename(projectPath);
  }
  return { service, createService, temporary, dataRoot, legacyDataRoot, project, seed, calls, handlers, protocols, intervals, sent, lifecycle, options,
    controller: () => controller, contents, window,
    invoke: (name, ...args) => handlers.get('aht:' + name)({ sender: contents, senderFrame: contents.mainFrame }, ...args) };
}
function job(id = 'job-a', patch = {}) {
  return { id, clip: { name: 'Attack' }, status: 'review', analysisStatus: 'uncertain', reviewed: false, windows: [{ start: 0, end: 1 }],
    frames: [], savedAssets: [], versions: [], createdUtc: '2026-10-10T00:00:00Z', ...patch };
}

test('require, service creation, initialize and summary are read-only and do not activate Controller, AI or Unity', async t => {
  const f = fixture(t);
  f.options.ready = false; assert.throws(() => f.service.initialize(), /after Electron/); f.options.ready = true;
  f.service.initialize(); f.service.initialize();
  assert.equal(f.protocols.size, 2); assert.ok(f.handlers.has('aht:getState'));
  const summary = f.service.getSummary(); assert.equal(typeof summary.then, 'undefined'); assert.equal(summary.projectPath, '');
  assert.equal(fs.existsSync(f.dataRoot), false); assert.deepEqual(f.calls, []); assert.deepEqual(f.lifecycle, []);
  await f.service.shutdown(); assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.dataRoot), false);
});

test('saved draft summary reads heartbeat and preserves uncertain, no-hit and unresolved saves without Store.load', t => {
  const f = fixture(t), project = f.project();
  const filename = f.seed(f.dataRoot, project, [job('uncertain'), job('no-hit', { analysisStatus: 'no-hit', windows: [] }),
    job('saving', { pendingSave: { requestId: 'preserve', changeId: 'preserve' } })]);
  atomicJson(path.join(project, 'Library', 'AutoHitTimerBridge', 'status.json'), { protocolVersion: 1, projectPath: project, timestampUtcMs: Date.now(), ready: true });
  const before = fs.readFileSync(filename, 'utf8');
  const summary = f.service.getSummary();
  assert.equal(summary.connected, true); assert.equal(summary.jobs[0].analysisStatus, 'uncertain'); assert.equal(summary.jobs[1].hitCount, 0);
  assert.equal(summary.jobs[2].pendingSave, true); assert.equal(summary.jobs[2].reviewed, false);
  assert.deepEqual(f.calls, []); assert.equal(fs.readFileSync(filename, 'utf8'), before);
  fs.writeFileSync(filename, '{broken');
  assert.ok(f.service.getSummary().error); assert.equal(fs.readdirSync(path.dirname(filename)).length, 1, 'summary must not create corruption backups');
});

for (const checkpoint of ['capturing', 'analyzing']) test(`passive ${checkpoint} checkpoint is marked interrupted without activation or changing its source`, t => {
  const legacy = checkpoint === 'analyzing';
  const f = fixture(t, { legacy }), project = f.project();
  const filename = f.seed(legacy ? f.legacyDataRoot : f.dataRoot, project, [job('checkpoint', { status: checkpoint })]);
  const hash = () => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  const before = hash();
  const summary = f.service.getSummary();
  assert.equal(summary.busy, false);
  assert.equal(summary.jobs[0].status, 'interrupted');
  assert.equal(readJson(filename).jobs[0].status, checkpoint);
  assert.equal(hash(), before);
  assert.deepEqual(f.calls, []);
  assert.equal(f.controller(), undefined);
  assert.equal(fs.readdirSync(path.dirname(filename)).length, 1);
  if (legacy) assert.equal(fs.existsSync(f.dataRoot), false);
});

test('active controller capture and analysis statuses remain live in summary', async t => {
  const f = fixture(t), project = f.project(); f.seed(f.dataRoot, project, [job()]);
  await f.service.activate();
  f.controller().state.busy = true;
  for (const status of ['capturing', 'analyzing']) {
    f.controller().state.jobs[0].status = status;
    const summary = f.service.getSummary();
    assert.equal(summary.busy, true);
    assert.equal(summary.jobs[0].status, status);
  }
  await f.service.shutdown();
});

test('activation is lazy and idempotent and restores only the isolated selected project', async t => {
  const f = fixture(t), project = f.project(); f.seed(f.dataRoot, project, [job()]);
  f.service.initialize(); assert.equal(f.controller(), undefined);
  await Promise.all([f.service.activate(), f.service.activate()]);
  assert.equal(f.calls.filter(call => call === 'controller').length, 1); assert.equal(f.calls.filter(call => call === 'load').length, 1);
  assert.equal(f.intervals.size, 1); assert.equal(f.service.getSummary().projectPath, project);
  assert.equal(f.service.getSummary().jobs[0].id, 'job-a');
  assert.ok(!f.calls.some(call => call.startsWith('unity:')));
  await f.service.shutdown(); assert.equal(f.intervals.size, 0);
});

test('legacy summary never writes; first activation copies validated JSON and preserves original pending saves and existing integrated files', async t => {
  const f = fixture(t, { legacy: true }), project = f.project();
  const sourceFile = f.seed(f.legacyDataRoot, project, [job('pending', { pendingSave: { changeId: 'c', requestId: 'r' } })]);
  const original = fs.readFileSync(sourceFile, 'utf8'); const preferences = fs.readFileSync(path.join(f.legacyDataRoot, 'preferences.json'), 'utf8');
  assert.equal(f.service.getSummary().jobs[0].pendingSave, true); assert.equal(fs.existsSync(f.dataRoot), false);
  const other = f.project('project-B'); const otherFile = f.seed(f.dataRoot, other, [job('integrated-existing')]);
  const existing = fs.readFileSync(otherFile, 'utf8');
  new Store(f.legacyDataRoot).save(other, { jobs: [job('legacy-must-not-replace')], settings: {}, selectedJobId: 'legacy-must-not-replace' });
  await f.service.activate();
  assert.equal(f.service.getSummary().projectPath, other, 'existing integrated choice wins');
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), original); assert.equal(fs.readFileSync(path.join(f.legacyDataRoot, 'preferences.json'), 'utf8'), preferences);
  assert.deepEqual(readJson(otherFile), JSON.parse(existing), 'activation may serialize current drafts, but migration must preserve the integrated choice and job');
  const copied = new Store(f.dataRoot).filename(project);
  assert.equal(fs.readFileSync(copied, 'utf8'), original);
  assert.ok(fs.existsSync(path.join(f.dataRoot, 'legacy-import.json')));
  await f.service.shutdown();
});

test('legacy migration rejects a junction escape before copying any files', async t => {
  const f = fixture(t, { legacy: true }), project = f.project();
  f.seed(f.legacyDataRoot, project, [job()]);
  const projects = path.join(f.legacyDataRoot, 'projects'), outside = path.join(f.temporary, 'outside-projects');
  fs.renameSync(projects, outside); fs.symlinkSync(outside, projects, 'junction');
  assert.ok(f.service.getSummary().error); assert.equal(fs.existsSync(f.dataRoot), false);
  await f.service.activate();
  assert.match(f.service.getSummary().error, /데이터 가져오기 실패/);
  assert.equal(fs.existsSync(path.join(f.dataRoot, 'preferences.json')), false);
  assert.equal(fs.existsSync(path.join(f.dataRoot, 'projects')), false);
  await f.service.shutdown();
});

test('completed migration is not replayed on the next service launch', async t => {
  const f = fixture(t, { legacy: true }), project = f.project();
  f.seed(f.legacyDataRoot, project, [job('first-import')]);
  await f.service.activate(); await f.service.shutdown();
  const later = f.project('later-project');
  new Store(f.legacyDataRoot).save(later, { jobs: [job('later-must-not-import')], settings: {} });
  const nextService = f.createService();
  await nextService.activate();
  assert.equal(fs.existsSync(new Store(f.dataRoot).filename(later)), false);
  assert.equal(nextService.getSummary().jobs[0].id, 'first-import');
  await nextService.shutdown();
});

test('oversized legacy preferences are rejected before any destination files are created', async t => {
  const f = fixture(t, { legacy: true });
  fs.mkdirSync(f.legacyDataRoot); const filename = path.join(f.legacyDataRoot, 'preferences.json');
  fs.writeFileSync(filename, '{}'); fs.truncateSync(filename, 64 * 1024 + 1);
  assert.ok(f.service.getSummary().error); assert.equal(fs.existsSync(f.dataRoot), false);
  await f.service.activate();
  assert.match(f.service.getSummary().error, /데이터 가져오기 실패/);
  assert.equal(fs.existsSync(f.dataRoot), false); assert.equal(fs.statSync(filename).size, 64 * 1024 + 1);
  await f.service.shutdown();
});

test('preload event subscriptions strip IPC events, validate navigation and support unsubscribe', () => {
  const events = new EventEmitter(); let api;
  const context = vm.createContext({ require: () => ({ ipcRenderer: events, webUtils: { getPathForFile: () => '' },
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'autoHitTimer'); api = value; } } }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), context);
  const received = [], visibility = [], event = { sender: 'must not leak' };
  const remove = api.onNavigate((...args) => received.push(args));
  const removeVisibility = api.onVisibility(value => visibility.push(value));
  events.emit('aht:navigate', event, { projectPath: 'C:/project', jobId: 'job-a', tab: 'hits', extra: event });
  events.emit('aht:navigate', event, { jobId: 'missing-project' });
  events.emit('aht:navigate', event, { projectPath: 'C:/project', jobId: '../escape' });
  events.emit('aht:navigate', event, { projectPath: 'C:/project', tab: 'unknown' });
  events.emit('aht:visibility', event, false); events.emit('aht:visibility', event, 'false');
  assert.deepEqual(JSON.parse(JSON.stringify(received)), [[{ projectPath: 'C:/project', jobId: 'job-a', tab: 'hits' }]]);
  assert.deepEqual(visibility, [false]); remove(); removeVisibility();
  events.emit('aht:navigate', event, { projectPath: 'C:/project' }); events.emit('aht:visibility', event, true);
  assert.equal(received.length, 1); assert.equal(visibility.length, 1); assert.equal(Object.isFrozen(api), true);
});

test('IPC rejects shell senders, subframes and other paths before activation; valid embedded mainFrame activates', async t => {
  const f = fixture(t); f.service.initialize(); const handler = f.handlers.get('aht:getState');
  assert.equal((await handler({ sender: f.window.webContents, senderFrame: f.contents.mainFrame })).error.code, 'FORBIDDEN');
  assert.equal((await handler({ sender: f.contents, senderFrame: { url: f.contents.mainFrame.url } })).error.code, 'FORBIDDEN');
  for (const url of ['aht://app/app.js', 'aht://app/index.html/extra', 'aht://user@app/index.html', 'https://app/index.html']) {
    f.contents.mainFrame.url = url; assert.equal((await f.invoke('getState')).error.code, 'FORBIDDEN');
  }
  assert.deepEqual(f.calls, []);
  f.contents.mainFrame.url = 'aht://app/index.html?embedded=1'; assert.equal((await f.invoke('getState')).ok, true);
  assert.equal(f.calls[0], 'controller'); await f.service.shutdown();
});

test('protocol resources use the strict document/style/script allowlist', t => {
  const f = fixture(t); f.service.initialize(); const resource = f.protocols.get('aht');
  for (const name of ['index.html', 'styles.css', 'embedded.css', 'app.js']) assert.match(resource({ url: 'aht://app/' + name, method: 'GET' }).fileUrl, new RegExp(name.replace('.', '\\.')));
  for (const url of ['aht://app/src/main.cjs', 'aht://other/index.html', 'aht://app/../package.json']) assert.equal(resource({ url, method: 'GET' }).status, 404);
  assert.equal(resource({ url: 'aht://app/index.html', method: 'POST' }).status, 404);
});

test('bare navigation preserves selection/preview; explicit scoped links select only an existing job and reject stale projects', async t => {
  const f = fixture(t), project = f.project(); f.seed(f.dataRoot, project, [job('one'), job('two')]);
  await f.service.activate(); const c = f.controller(); c.preview = { keep: true };
  const writes = f.calls.filter(call => call === 'save').length;
  await f.service.navigate();
  assert.equal(c.state.selectedJobId, 'one'); assert.equal(c.preview.keep, true); assert.equal(f.calls.filter(call => call === 'save').length, writes);
  await assert.rejects(f.service.navigate({ projectPath: project + '-stale', jobId: 'two' }), /목록을 새로고침/);
  await assert.rejects(f.service.navigate({ projectPath: project, jobId: 'missing' }), /작업을 선택/);
  await assert.rejects(f.service.navigate({ tab: 'timing' }), /알 수 없는/);
  assert.equal(c.state.selectedJobId, 'one');
  await f.service.navigate({ projectPath: project, jobId: 'two', tab: 'save' });
  assert.equal(c.state.selectedJobId, 'two');
  const event = f.sent.filter(item => item[0] === 'aht:navigate').at(-1)[1];
  assert.deepEqual(JSON.parse(JSON.stringify(event)), { projectPath: project, jobId: 'two', tab: 'save' });
  f.service.setVisible(false); assert.equal(f.sent.at(-1)[0], 'aht:visibility'); assert.equal(f.sent.at(-1)[1], false);
  await f.service.shutdown();
});

test('project picker uses host parent and blocks active work before opening the dialog', async t => {
  const f = fixture(t), project = f.project(); await f.service.activate();
  let dialogs = 0; f.options.open = async parent => { assert.equal(parent, f.window); dialogs++; return { canceled: false, filePaths: [project] }; };
  f.controller().state.busy = true; await assert.rejects(f.service.chooseProject(), /진행 중/); assert.equal(dialogs, 0);
  f.controller().state.busy = false; await f.service.chooseProject(); assert.equal(f.service.getSummary().projectPath, project); assert.equal(dialogs, 1);
  await f.service.shutdown();
});

test('async shutdown stops polling, cancels only active analysis and waits for its queue without changing pending saves', async t => {
  const f = fixture(t), project = f.project(); f.seed(f.dataRoot, project, [job('pending', { pendingSave: { changeId: 'c', requestId: 'r' } })]);
  await f.service.activate(); const c = f.controller(), pendingSave = structuredClone(c.state.jobs[0].pendingSave);
  let release; c.abortController = new AbortController(); const signal = c.abortController.signal; c.state.busy = true;
  c.queuePromise = new Promise(resolve => { release = resolve; });
  assert.equal(f.service.hasActiveWork(), true);
  let complete = false; const shutdown = f.service.shutdown().then(() => { complete = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.intervals.size, 0); assert.equal(signal.aborted, true); assert.equal(complete, false);
  assert.equal(f.calls.filter(call => call === 'unity:cancel').length, 1);
  release(); await shutdown;
  assert.equal(complete, true); assert.deepEqual(c.state.jobs[0].pendingSave, pendingSave);
  assert.equal(f.calls.filter(call => call === 'unity:apply').length, 0);
  await f.service.shutdown(); assert.equal(f.calls.filter(call => call === 'shutdown').length, 1);
});

test('shutdown with only an unresolved save never sends cancellation or replay commands', async t => {
  const f = fixture(t), project = f.project(); const filename = f.seed(f.dataRoot, project, [job('pending', { pendingSave: { changeId: 'c', requestId: 'r' } })]);
  await f.service.activate(); const before = fs.readFileSync(filename, 'utf8');
  await f.service.shutdown(); assert.ok(!f.calls.some(call => call.startsWith('unity:'))); assert.equal(fs.readFileSync(filename, 'utf8'), before);
});

test('frame grants remain project-contained and enforce the existing 8 MiB limit', async t => {
  const f = fixture(t), project = f.project(), folder = path.join(project, 'Library', 'AutoHitTimerBridge');
  fs.mkdirSync(folder, { recursive: true });
  const png = path.join(folder, 'frame.png'); fs.writeFileSync(png, 'PNG fixture');
  f.seed(f.dataRoot, project, [job('frames', { frames: [{ id: 'frame', time: 0, path: png }] })]);
  f.service.initialize(); const state = (await f.invoke('getState')).value;
  assert.equal(state.jobs[0].frames[0].path, undefined);
  const request = { url: state.jobs[0].frames[0].url, method: 'GET' }, media = f.protocols.get('aht-media');
  assert.equal(media(request).status, 200);
  fs.truncateSync(png, 8 * 1024 * 1024 + 1); assert.equal(media(request).status, 413);
  const outside = path.join(f.temporary, 'outside.png'); fs.writeFileSync(outside, 'private'); fs.unlinkSync(png); fs.symlinkSync(outside, png);
  assert.equal(media(request).status, 404);
  await f.service.shutdown();
});
