'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const snapshot = (projectPath, selectedJobId = 'job') => ({ projectPath, selectedJobId,
  jobs: [{ id: selectedJobId, duration: 1, status: 'review', copy: true, reviewed: false,
    windows: [{ id: 'hit', start: .2, end: .4 }], frames: [{ time: .2, url: 'aht-media://frame' }] }] });

function rendererFixture() {
  const elements = new Map(), errors = [], classes = new Set();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, textContent: '',
      classList: { toggle() {}, remove() {} }, setAttribute() {} });
    return elements.get(id);
  };
  const api = { getState: async () => snapshot('C:/A') };
  const context = vm.createContext({ URLSearchParams, window: { autoHitTimer: api, location: { search: '?embedded=1' } },
    document: { getElementById: element, documentElement: { classList: { toggle(name, enabled) { if (enabled) classes.add(name); } } } },
    render() {}, renderSearch() {}, renderFooter() {}, renderButtons() {}, cancelAnimationFrame() {},
    showNotice(message, kind) { errors.push({ message, kind }); } });
  vm.runInContext(source.slice(source.indexOf('  const api ='), source.indexOf('  function showNotice(')), context);
  vm.runInContext(source.slice(source.indexOf('  function acceptState('), source.indexOf('  async function run(')), context);
  vm.runInContext(source.slice(source.indexOf('  function switchTab('), source.indexOf('  function togglePlayback(')), context);
  const run = code => vm.runInContext(code, context);
  return { context, api, run, errors, classes, element, elements };
}

test('bare host navigation synchronizes state without replacing the current tab, preview or draft', async () => {
  const ui = rendererFixture();
  ui.context.initial = snapshot('C:/A');
  ui.run("acceptState(initial); switchTab('save'); currentTime = .3; selectedWindowId = 'hit'; preview = {changeId:'reviewed-preview'}; previewJobId = 'job'; previewFingerprint = fingerprint(job()); searchMessage = '보존할 검색';");
  await ui.run("followNavigation({projectPath:'C:/A'})");
  assert.equal(ui.run('currentTab'), 'save');
  assert.equal(ui.run('currentTime'), .3);
  assert.equal(ui.run('selectedWindowId'), 'hit');
  assert.equal(ui.run('preview.changeId'), 'reviewed-preview');
  assert.equal(ui.run('searchMessage'), '보존할 검색');
  assert.equal(ui.run('job().copy'), true);
  assert.equal(ui.run('job().windows[0].start'), .2);
  assert.equal(ui.errors.length, 0);
});

test('a focused unsaved field survives a bare navigation refresh but not a project change', async () => {
  const ui = rendererFixture();
  ui.context.initial = snapshot('C:/A');
  ui.run('acceptState(initial)');
  const createInput = value => ({ id: 'output-folder', value, matches: () => true,
    focus() { ui.context.document.activeElement = this; } });
  const draft = createInput('Assets/MyUnsubmittedFolder');
  ui.elements.set('output-folder', draft);
  ui.context.document.activeElement = draft;
  for (const name of ['renderNotice', 'renderProject', 'renderJobs', 'renderStage', 'renderHits']) ui.context[name] = () => {};
  ui.context.renderSave = () => { ui.elements.set('output-folder', createInput('Assets/SavedFolder')); };
  vm.runInContext(source.slice(source.indexOf('  function render('), source.indexOf('  function renderProject(')), ui.context);
  await ui.run("followNavigation({projectPath:'C:/A'})");
  assert.equal(ui.element('output-folder').value, 'Assets/MyUnsubmittedFolder');
  ui.api.getState = async () => snapshot('C:/B');
  await ui.run("followNavigation({projectPath:'C:/B',jobId:'job',tab:'save'})");
  assert.equal(ui.element('output-folder').value, 'Assets/SavedFolder', 'another project never inherits a focused draft');
});

test('explicit host navigation opens only the selected job in the current project', async () => {
  const ui = rendererFixture();
  ui.context.initial = snapshot('C:/A');
  ui.run("acceptState(initial); currentTime = .3; preview = {changeId:'old-preview'}; previewJobId = 'job'; previewFingerprint = fingerprint(job());");
  ui.api.getState = async () => snapshot('C:/B');
  await ui.run("followNavigation({projectPath:'C:\\\\B',jobId:'job',tab:'save'})");
  assert.equal(ui.run('state.projectPath'), 'C:/B');
  assert.equal(ui.run('currentTab'), 'save');
  assert.equal(ui.run('preview'), null, 'same job ID in another project cannot reuse a preview');
  assert.equal(ui.run('currentTime'), 0);
  await ui.run("followNavigation({projectPath:'C:/B',jobId:'job'})");
  assert.equal(ui.run('currentTab'), 'hits');
  assert.equal(ui.errors.length, 0);
});

test('stale project or job links never switch to an unrelated result', async () => {
  const ui = rendererFixture();
  ui.api.getState = async () => snapshot('C:/C', 'other-job');
  await ui.run("followNavigation({projectPath:'C:/B',jobId:'other-job',tab:'save'})");
  assert.equal(ui.run('currentTab'), 'hits');
  assert.match(ui.errors[0].message, /프로젝트/);
  await ui.run("followNavigation({projectPath:'C:/C',jobId:'old-job',tab:'save'})");
  assert.equal(ui.run('currentTab'), 'hits');
  assert.match(ui.errors[1].message, /작업/);
});

test('newer navigation supersedes a late state response from an older request', async () => {
  const ui = rendererFixture();
  let release;
  ui.api.getState = () => new Promise(resolve => { release = resolve; });
  const oldNavigation = ui.run("followNavigation({projectPath:'C:/B',jobId:'job',tab:'hits'})");
  ui.api.getState = async () => snapshot('C:/C');
  await ui.run("followNavigation({projectPath:'C:/C',jobId:'job',tab:'save'})");
  release(snapshot('C:/B'));
  await oldNavigation;
  assert.equal(ui.run('state.projectPath'), 'C:/C');
  assert.equal(ui.run('currentTab'), 'save');
  assert.equal(ui.errors.length, 0);
});

test('a late initial refresh cannot replace state supplied by navigation or an event', async () => {
  const ui = rendererFixture();
  let release;
  ui.api.getState = () => new Promise(resolve => { release = resolve; });
  const initialRefresh = ui.run('refreshState()');
  ui.api.getState = async () => snapshot('C:/B');
  await ui.run("followNavigation({projectPath:'C:/B',jobId:'job',tab:'save'})");
  release(snapshot('C:/A'));
  await initialRefresh;
  assert.equal(ui.run('state.projectPath'), 'C:/B');
  assert.equal(ui.run('currentTab'), 'save');
});

test('a state event during navigation wins over the pending snapshot', async () => {
  const ui = rendererFixture();
  let release;
  ui.api.getState = () => new Promise(resolve => { release = resolve; });
  const navigation = ui.run("followNavigation({projectPath:'C:/B',jobId:'job',tab:'save'})");
  ui.context.newState = snapshot('C:/C');
  ui.run('acceptState(newState)');
  release(snapshot('C:/B'));
  await navigation;
  assert.equal(ui.run('state.projectPath'), 'C:/C');
  assert.equal(ui.run('currentTab'), 'hits');
  assert.match(ui.errors[0].message, /프로젝트/);
});

test('a late change preview cannot attach to an identical job in another project', async () => {
  const ui = rendererFixture();
  ui.context.initial = snapshot('C:/A');
  ui.run('acceptState(initial)');
  let release;
  ui.api.previewChange = () => new Promise(resolve => { release = resolve; });
  ui.context.button = { id: 'preview-change' };
  ui.context.run = async (_label, action) => action();
  ui.context.renderSave = () => {};
  const handler = source.slice(source.indexOf("    if (button?.id === 'preview-change')"), source.indexOf("    if (button?.id === 'apply-change'"));
  const pending = ui.run(`(async () => { ${handler} })()`);
  ui.context.nextProject = snapshot('C:/B');
  ui.run('acceptState(nextProject)');
  release({ changeId: 'old-project-preview', canApply: true });
  await pending;
  assert.equal(ui.run('preview'), null);
});

test('invalid navigation tabs are ignored and hiding only pauses playback', async () => {
  const ui = rendererFixture();
  ui.context.initial = snapshot('C:/A');
  ui.run("acceptState(initial); switchTab('save'); currentTime = .3; playing = true;");
  await ui.run("followNavigation({projectPath:'C:/A',tab:'unknown'})");
  assert.equal(ui.run('currentTab'), 'save');
  let visibility;
  ui.api.onVisibility = callback => { visibility = callback; };
  const handler = source.split(/\r?\n/).find(line => line.includes('api.onVisibility?.('));
  assert.ok(handler, 'renderer subscribes to host visibility');
  vm.runInContext(handler.trim().replace(/,$/, ';'), ui.context);
  visibility(false);
  assert.equal(ui.run('playing'), false);
  visibility(true);
  assert.equal(ui.run('playing'), false, 'show does not resume playback');
  assert.equal(ui.run('currentTime'), .3);
  assert.equal(ui.run('currentTab'), 'save');
  assert.equal(ui.run('job().copy'), true);
});

test('all state and host event subscriptions are released on unload', () => {
  const ui = rendererFixture();
  const removed = [];
  let unload;
  for (const name of ['onState', 'onNavigate', 'onVisibility']) ui.api[name] = () => () => removed.push(name);
  ui.context.window.addEventListener = (event, callback) => { assert.equal(event, 'beforeunload'); unload = callback; };
  const subscriptions = source.slice(source.indexOf('    const unsubscribes ='), source.indexOf("    run('앱 상태를 불러오지 못했습니다'"));
  vm.runInContext(subscriptions, ui.context);
  assert.equal(typeof unload, 'function');
  unload();
  assert.deepEqual(removed, ['onState', 'onNavigate', 'onVisibility']);
});
