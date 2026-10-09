'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('preload subscriptions forward typed payloads without exposing IPC events and can unsubscribe', () => {
  const ipc = new EventEmitter();
  let api;
  const context = vm.createContext({ require: () => ({ ipcRenderer: ipc,
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'baekho'); api = value; } } }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), context);
  const event = { sender: { secret: 'must remain in preload' } }, navigations = [], visibility = [];
  const unsubscribeNavigation = api.onNavigate((...args) => navigations.push(args));
  const unsubscribeVisibility = api.onVisibility((...args) => visibility.push(args));
  ipc.emit('baekho:navigate', event, { projectPath: 'C:/project', runId: 'saved-run', tab: 'compare', ignored: event });
  ipc.emit('baekho:navigate', event, { projectPath: 'C:/project', runId: '../outside' });
  ipc.emit('baekho:navigate', event, { projectPath: 'C:/project', tab: 'unknown' });
  ipc.emit('baekho:navigate', event, { runId: 'missing-project-identity' });
  ipc.emit('baekho:navigate', event, { projectPath: {}, tab: 'setup' });
  ipc.emit('baekho:navigate', event, null);
  ipc.emit('baekho:visibility', event, false);
  ipc.emit('baekho:visibility', event, 'false');
  assert.deepEqual(JSON.parse(JSON.stringify(navigations)), [[{ projectPath: 'C:/project', runId: 'saved-run', tab: 'compare' }]]);
  assert.deepEqual(visibility, [[false]]);
  unsubscribeNavigation(); unsubscribeVisibility();
  ipc.emit('baekho:navigate', event, { projectPath: 'C:/project', tab: 'setup' });
  ipc.emit('baekho:visibility', event, true);
  assert.equal(navigations.length, 1);
  assert.equal(visibility.length, 1);
  assert.throws(() => api.onNavigate(null), /callback/);
  assert.equal(Object.isFrozen(api), true);
});

function navigationFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const elements = new Map(), reports = [], errors = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, classList: { toggle() {} }, setAttribute() {} });
    return elements.get(id);
  };
  const snapshot = projectPath => ({ projectPath, projectName: projectPath, catalog: { adapters: [] }, connection: { connected: false, running: false }, runs: [] });
  const state = { snapshot: null, catalog: { adapters: [] }, request: { candidates: ['draft-candidate'] }, actionDrafts: { skill: { goal: '보존할 입력' } },
    reportLoading: false, reportGeneration: 0, projectGeneration: 0, navigationGeneration: 0,
    view: 'setup', selectedRunId: null, reportSignature: '', reportBundle: null };
  const context = vm.createContext({ $, state, window: { scrollTo() {} }, stop() {}, updateControls() {}, drawHistory() {},
    currentAction: () => null, clearActionDrafts: () => { state.actionDrafts = {}; }, reconcileSelection() {}, videos: [],
    list: value => Array.isArray(value) ? value : [],
    results: [{ candidate: { id: 'winner' } }], drawReport: bundle => reports.push(bundle),
    operation: async action => { try { await action(); } catch (error) { errors.push(error); } },
    api: { refresh: async () => snapshot('fixture'),
      loadReport: async id => ({ report: { runId: id, results: [] }, judgment: { feedback: 'saved feedback', selectedCandidateId: 'winner' } }) } });
  const showView = source.slice(source.indexOf('function showView('), source.indexOf('function dateLabel('));
  const navigation = source.slice(source.indexOf('async function openReport('), source.indexOf("$('dismissMessage').addEventListener"));
  const refresh = source.slice(source.indexOf('function applySnapshot('), source.indexOf('// Report videos share'));
  vm.runInContext(showView + refresh + navigation, context);
  return { state, $, reports, errors, context, snapshot, run: code => vm.runInContext(code, context) };
}

test('host report navigation waits for bootstrap and opens its report without replacing setup drafts', async () => {
  const ui = navigationFixture();
  const request = ui.state.request, drafts = ui.state.actionDrafts;
  await ui.run("followNavigation({projectPath:'fixture',runId:'historical-run'})");
  assert.equal(ui.reports.length, 0);
  ui.state.snapshot = ui.snapshot('fixture');
  await ui.run('followNavigation(pendingNavigation)');
  assert.equal(ui.state.selectedRunId, 'historical-run');
  assert.equal(ui.state.view, 'compare');
  assert.equal(ui.$('feedback').value, 'saved feedback');
  assert.equal(ui.$('winner').value, 'winner');
  assert.equal(ui.state.request, request);
  assert.equal(ui.state.actionDrafts, drafts);
  await ui.run("followNavigation({projectPath:'fixture',tab:'setup'})");
  assert.equal(ui.state.view, 'setup');
  assert.equal(ui.state.request, request);
  assert.equal(ui.reports.length, 1);
});

test('host navigation arriving during a report refresh is applied after the refresh settles', async () => {
  const ui = navigationFixture();
  ui.state.snapshot = ui.snapshot('fixture');
  let release;
  ui.context.api.loadReport = id => id === 'refreshing-run'
    ? new Promise(resolve => { release = resolve; })
    : Promise.resolve({ report: { runId: id, results: [] } });
  const pending = ui.run("openReport('refreshing-run', {switchView:false})");
  await ui.run("followNavigation({projectPath:'fixture',runId:'requested-run'})");
  release({ report: { runId: 'refreshing-run', results: [] } });
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.state.selectedRunId, 'requested-run');
  assert.equal(ui.state.view, 'compare');
  assert.equal(ui.reports.length, 2);
  assert.equal(ui.errors.length, 0);
});

test('switching A to B in the host opens B report before polling and a late A poll cannot clear it', async () => {
  const ui = navigationFixture();
  ui.state.snapshot = ui.snapshot('project-A');
  let releasePoll, refreshCount = 0;
  ui.context.api.refresh = () => ++refreshCount === 1
    ? new Promise(resolve => { releasePoll = resolve; })
    : Promise.resolve(ui.snapshot('project-B'));
  const loads = [];
  ui.context.api.loadReport = async (runId, expectedProjectPath) => {
    loads.push({ runId, expectedProjectPath });
    assert.equal(ui.state.snapshot.projectPath, 'project-B', 'project transition is applied before opening its report');
    return { report: { runId, results: [] } };
  };
  const oldPoll = ui.run('refresh()');
  await ui.run("followNavigation({projectPath:'project-B',runId:'B-report'})");
  assert.equal(ui.state.snapshot.projectPath, 'project-B');
  assert.equal(ui.state.selectedRunId, 'B-report');
  assert.equal(ui.state.view, 'compare');
  assert.deepEqual(loads, [{ runId: 'B-report', expectedProjectPath: 'project-B' }]);
  releasePoll(ui.snapshot('project-A'));
  await oldPoll;
  assert.equal(ui.state.snapshot.projectPath, 'project-B');
  assert.equal(ui.state.selectedRunId, 'B-report');
  assert.equal(ui.state.view, 'compare');
  assert.equal(ui.reports.length, 1);
  assert.equal(ui.errors.length, 0);
  await ui.run('refresh()');
  assert.equal(ui.state.selectedRunId, 'B-report', 'the next ordinary B poll also preserves the opened report');
  assert.equal(ui.state.view, 'compare');
});

test('newer host navigation supersedes an older in-flight snapshot without opening its report', async () => {
  const ui = navigationFixture();
  ui.state.snapshot = ui.snapshot('project-A');
  let releaseB, refreshCount = 0;
  ui.context.api.refresh = () => ++refreshCount === 1
    ? new Promise(resolve => { releaseB = resolve; })
    : Promise.resolve(ui.snapshot('project-C'));
  const first = ui.run("followNavigation({projectPath:'project-B',runId:'B-report'})");
  await ui.run("followNavigation({projectPath:'project-C',runId:'C-report'})");
  releaseB(ui.snapshot('project-B'));
  await first;
  assert.equal(ui.state.snapshot.projectPath, 'project-C');
  assert.equal(ui.state.selectedRunId, 'C-report');
  assert.equal(ui.reports.length, 1);
  assert.equal(ui.reports[0].report.runId, 'C-report');
});

test('navigation to a project that changed again surfaces the mismatch and never opens a same-ID report', async () => {
  const ui = navigationFixture();
  ui.state.snapshot = ui.snapshot('project-A');
  ui.context.api.refresh = async () => ui.snapshot('project-C');
  await ui.run("followNavigation({projectPath:'project-B',runId:'shared-run'})");
  assert.equal(ui.state.snapshot.projectPath, 'project-C');
  assert.equal(ui.state.selectedRunId, null);
  assert.equal(ui.reports.length, 0);
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0].message, /프로젝트가 변경/);
});

test('hiding the tool pauses playback without resetting drafts or restarting it on return', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  let visibility, stops = 0;
  const draft = { goal: '보존할 입력' };
  const context = vm.createContext({ api: { onVisibility: callback => { visibility = callback; } },
    state: { request: draft }, stop: () => { stops++; } });
  const handler = source.split(/\r?\n/).find(line => line.includes('api.onVisibility?.('));
  vm.runInContext(handler, context);
  visibility(false);
  visibility(true);
  assert.equal(stops, 1);
  assert.equal(context.state.request, draft);
});
