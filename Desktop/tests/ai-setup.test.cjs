'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the production setup controller and event handlers against a small DOM.
// The packaged Electron diagnostic covers actual rendering and Unity playback.
function setup(overrides = {}, configure = () => {}) {
  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.events = {}; this.value = '';
      this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false;
      this.classList = { toggle() {}, add() {}, remove() {} };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    get options() { return this.children.filter(child => child.tagName === 'option'); }
    setAttribute() {}
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    async emit(name) { for (const callback of this.events[name] || []) await callback(); }
    querySelectorAll(selector) {
      const tags = selector.split(',').map(value => value.trim());
      return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
  }
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element(['adapter', 'source', 'action', 'editorCandidate', 'winner'].includes(id) ? 'select' : 'div'));
    return elements.get(id);
  };
  get('goal').value = '묵직하지만 콤보 흐름은 끊기지 않는 타격감';
  get('candidateTotal').value = '4';
  const parameters = [{ id: 'impact', label: 'Impact', minimum: 0, maximum: 3, baseline: 1, unit: '× baseline' }];
  const defaultRequest = { schemaVersion: 1, adapterId: 'fixture', sourceGuid: 'source', durationSeconds: 10, seed: 1701, recordVideo: true, candidates: [{ id: 'default', label: '기존 기본값', values: [{ id: 'impact', value: 1 }] }] };
  const snapshot = { projectPath: 'C:/Fixture', projectName: 'Fixture', connection: { connected: true }, ai: { available: true, authenticated: true, provider: 'codex', label: 'Codex' }, catalog: { adapters: [{ id: 'fixture', sources: [{ guid: 'source', parameters, defaultRequest }] }] }, runs: [] };
  configure(snapshot);
  const generated = count => ({ ...defaultRequest, candidates: Array.from({ length: count }, (_, index) => ({ id: `candidate_${index + 1}`, label: `후보 ${index + 1}`, rationale: `제안 이유 ${index + 1}`, values: [{ id: 'impact', value: 0.5 + index * 0.1 }] })), generation: { provider: 'codex', goal: get('goal').value, count } });
  const calls = [];
  const api = {
    refresh: async () => JSON.parse(JSON.stringify(snapshot)),
    generateCandidates: async request => { calls.push(request); return generated(request.count); },
    cancelGeneration: async () => ({ cancelled: true }),
    ...overrides,
  };
  const context = vm.createContext({
    window: { baekho: api, scrollTo() {} },
    document: { getElementById: get, createElement: tag => new Element(tag) },
    console, snapshot, CombatTuning: require('../renderer/tuning-contract.js'), async openReport() {}, stop() {}, videos: [], results: [],
  });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const controller = source.slice(0, source.indexOf('// Report videos share'));
  const listeners = source.slice(source.indexOf("$('dismissMessage').addEventListener"), source.indexOf("$('compareCount').addEventListener"));
  vm.runInContext(controller + '\n' + listeners + '\napplySnapshot(snapshot);', context);
  return { $: get, run: code => vm.runInContext(code, context), json: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)), generated, calls, api };
}

test('setup starts without fallback candidates and AI generation creates read-only values and rationale', async () => {
  const ui = setup();
  assert.equal(ui.run('state.request.candidates.length'), 0);
  assert.equal(ui.$('runExperiment').disabled, true);
  assert.equal(ui.$('generateCandidates').disabled, false);
  await ui.$('generateCandidates').emit('click');
  assert.equal(ui.calls[0].count, 4);
  assert.equal(ui.run('state.request.candidates.length'), 4);
  assert.equal(ui.run('requestReady()'), true);
  assert.equal(ui.run('state.requestOrigin'), 'ai');
  assert.equal(ui.$('candidates').querySelectorAll('input').length, 0);
  assert.equal(ui.$('candidates').querySelectorAll('output').length, 4);
  assert.equal(ui.$('candidates').querySelectorAll('p').length, 4);
  assert.equal(ui.$('runExperiment').disabled, false);
});

test('v2 direct edits keep untouched fields absent, enable matching group Override, and validate linear curves', async () => {
  const ui = setup({}, snapshot => {
    const source = snapshot.catalog.adapters[0].sources[0];
    source.parameters.splice(0, source.parameters.length,
      { id: 'step.0.camera.shake.amplitude', label: '카메라 충격', group: 'camera', targetId: 'step.0', minimum: 0, maximum: 3, baseline: 0.4, kind: 'number' },
      { id: 'step.0.camera.shake.mode', label: '모드', group: 'camera', targetId: 'step.0', minimum: 0, maximum: 2, baseline: 0, kind: 'enum', options: ['상속', '끔', '직접'] });
    source.curves = [{ id: 'step.0.camera.shake.envelope', label: '감쇠 곡선', group: 'camera', targetId: 'step.0', minimum: 0, maximum: 1, maximumTime: 1, keys: [{ time: 0, value: 1 }, { time: 1, value: 0 }] }];
    source.supportedRequestVersions = [1, 2];
    Object.assign(source.defaultRequest, { schemaVersion: 2, includeSourceControl: true, scenarioMode: 'fixed', precisionCapture: true, precisionTargetId: '', repeatCount: 1 });
  });
  await ui.$('addManualCandidate').emit('click'); await ui.$('addManualCandidate').emit('click');
  assert.deepEqual(ui.json('state.request.candidates[0].values'), []);
  assert.deepEqual(ui.json('state.request.candidates[0].curves'), []);
  assert.equal(ui.$('runExperiment').disabled, false);
  const input = ui.$('candidates').querySelectorAll('input').find(element => element.type === 'number');
  input.value = '1.25'; await input.emit('input');
  assert.equal(ui.run("state.request.candidates[0].values.find(item => item.id === 'step.0.camera.shake.amplitude').value"), 1.25);
  assert.equal(ui.run("state.request.candidates[0].values.find(item => item.id === 'step.0.camera.shake.mode').value"), 2);
  assert.equal(ui.run('state.request.candidates[0].revision'), 2);
  const editor = ui.$('candidates').querySelectorAll('textarea')[0];
  editor.value = '0, 1\n0.3, 0.5\n1, 0'; await editor.emit('change');
  assert.equal(ui.run('state.request.candidates[0].curves[0].keys.length'), 3);
  editor.value = '0, 1\n0, 0'; await editor.emit('change');
  assert.equal(ui.run('state.request.candidates[0].curves[0].keys.length'), 3, 'invalid editor text never replaces the last valid curve');
  ui.run('validate(state.request)');
});

test('a v2 adapter imports legacy multiplier requests through its separate v1 parameter catalog', async () => {
  const request = { schemaVersion: 1, adapterId: 'fixture', sourceGuid: 'source', durationSeconds: 10, seed: 1701, recordVideo: true,
    candidates: [1, 1.2].map((value, index) => ({ id: `legacy-${index}`, values: [{ id: 'impact', value }] })) };
  const ui = setup({ loadRequest: async () => request }, snapshot => {
    const source = snapshot.catalog.adapters[0].sources[0];
    source.legacyParameters = structuredClone(source.parameters);
    source.parameters.splice(0, 1, { id: 'step.0.knockback', label: '절대 넉백', minimum: 0, maximum: 50, baseline: 3 });
    source.supportedRequestVersions = [1, 2]; source.defaultRequest.schemaVersion = 2;
  });
  await ui.$('importRequest').emit('click');
  assert.equal(ui.run('state.request.schemaVersion'), 1);
  assert.equal(ui.run('currentParameters()[0].id'), 'impact');
  assert.equal(ui.$('candidates').querySelectorAll('input').length, 0);
  assert.equal(ui.run('requestReady()'), true);
});

test('editing the goal or candidate count invalidates generated values until regenerated', async () => {
  const ui = setup();
  await ui.$('generateCandidates').emit('click');
  ui.$('candidateTotal').value = '7'; await ui.$('candidateTotal').emit('input');
  assert.equal(ui.run('requestReady()'), false);
  assert.equal(ui.$('runExperiment').disabled, true);
  assert.match(ui.$('candidateHint').textContent, /이전 제안/);
  await ui.$('generateCandidates').emit('click');
  assert.equal(ui.run('state.request.candidates.length'), 7);
  assert.equal(ui.run('requestReady()'), true);
  ui.$('goal').value = '가벼운 연타'; await ui.$('goal').emit('input');
  assert.equal(ui.$('runExperiment').disabled, true);
  assert.equal(ui.$('exportRequest').disabled, true);
});

test('AI generation preserves user-chosen run conditions', async () => {
  const ui = setup();
  ui.$('duration').value = '21'; await ui.$('duration').emit('input');
  ui.$('seed').value = '42'; await ui.$('seed').emit('input');
  ui.$('recordVideo').checked = false; await ui.$('recordVideo').emit('change');
  await ui.$('generateCandidates').emit('click');
  assert.deepEqual(ui.json('[state.request.durationSeconds, state.request.seed, state.request.recordVideo]'), [21, 42, false]);
});

test('AI errors and malformed response counts preserve a valid previous request', async () => {
  const ui = setup();
  await ui.$('generateCandidates').emit('click');
  const before = ui.json('state.request');
  ui.api.generateCandidates = async () => { throw new Error('연결 실패'); };
  await ui.$('generateCandidates').emit('click');
  assert.deepEqual(ui.json('state.request'), before);
  assert.equal(ui.$('runExperiment').disabled, false);
  assert.equal(ui.$('messageText').textContent, '연결 실패');
  ui.api.generateCandidates = async () => ui.generated(3);
  await ui.$('generateCandidates').emit('click');
  assert.deepEqual(ui.json('state.request'), before);
  assert.match(ui.$('messageText').textContent, /요청한 개수/);
});

test('cancel remains available during generation and a late result cannot replace the previous request', async () => {
  const ui = setup();
  await ui.$('generateCandidates').emit('click');
  const before = ui.json('state.request');
  let finish;
  ui.api.generateCandidates = () => new Promise(resolve => { finish = resolve; });
  const pending = ui.$('generateCandidates').emit('click');
  assert.equal(ui.$('cancelGeneration').hidden, false);
  assert.equal(ui.$('cancelGeneration').disabled, false);
  assert.equal(ui.$('runExperiment').disabled, true);
  await ui.$('cancelGeneration').emit('click');
  finish(ui.generated(4));
  await pending;
  assert.deepEqual(ui.json('state.request'), before);
  assert.equal(ui.run('state.generating'), false);
  assert.equal(ui.$('runExperiment').disabled, false);
  assert.match(ui.$('messageText').textContent, /취소/);
});

test('unavailable AI cannot silently substitute rule-generated candidates', async () => {
  const ui = setup();
  ui.run("state.snapshot.ai = { available: false, authenticated: false, error: 'Codex 실행 파일을 찾을 수 없습니다.' }; updateControls();");
  assert.equal(ui.$('generateCandidates').disabled, true);
  assert.equal(ui.run('state.request.candidates.length'), 0);
  assert.equal(ui.$('runExperiment').disabled, true);
  assert.match(ui.$('aiStatus').textContent, /Codex 실행 파일/);
});

function actionCatalog(snapshot) {
  const source = snapshot.catalog.adapters[0].sources[0];
  source.actions = [
    { id: 'normal-combo', label: '일반 공격 전체 콤보', available: true, parameters: source.parameters, defaultRequest: source.defaultRequest },
    { id: 'skill', label: '스킬', available: true, parameters: [{ id: 'skillImpact', label: '스킬 반응', minimum: 0, maximum: 5, baseline: 2 }], defaultRequest: { ...source.defaultRequest, actionId: 'skill' } },
    { id: 'ultimate', label: '궁극기', available: false, unavailableReason: '궁극기 애니메이션이 없습니다.', parameters: [], defaultRequest: null }
  ];
}

test('changing the action clears old candidates and generation uses only the selected action parameters', async () => {
  const ui = setup({}, actionCatalog);
  await ui.$('generateCandidates').emit('click');
  assert.equal(ui.run('requestReady()'), true);
  ui.$('action').value = 'skill'; await ui.$('action').emit('change');
  assert.equal(ui.run('state.request.actionId'), 'skill');
  assert.equal(ui.run('state.request.candidates.length'), 0);
  assert.equal(ui.$('runExperiment').disabled, true);
  assert.equal(ui.$('generateCandidates').disabled, false);
  let input;
  ui.api.generateCandidates = async value => {
    input = value;
    return { ...ui.generated(value.count), actionId: 'skill', candidates: Array.from({ length: value.count }, (_, index) => ({ id: `skill_${index}`, label: `스킬 ${index}`, rationale: '스킬 효과', values: [{ id: 'skillImpact', value: 1 + index }] })) };
  };
  await ui.$('generateCandidates').emit('click');
  assert.equal(input.actionId, 'skill');
  assert.equal(ui.run('requestReady()'), true);
  assert.deepEqual(ui.json('state.request.candidates[0].values'), [{ id: 'skillImpact', value: 1 }]);
  assert.equal(ui.$('candidates').querySelectorAll('output').length, 4);
  assert.equal(ui.$('candidates').querySelectorAll('input').length, 0);
});

test('unavailable actions retain their selection and show the reason while blocking generation and execution', async () => {
  const ui = setup({}, actionCatalog);
  ui.$('action').value = 'ultimate'; await ui.$('action').emit('change');
  assert.equal(ui.$('action').value, 'ultimate');
  assert.match(ui.$('sourceHelp').textContent, /궁극기 애니메이션/);
  assert.equal(ui.$('generateCandidates').disabled, true);
  assert.equal(ui.$('runExperiment').disabled, true);
  await ui.$('generateCandidates').emit('click');
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.run('state.request'), null, 'an unavailable action has no runnable draft');
  assert.throws(() => ui.run('validate(state.request)'), /궁극기 애니메이션/);
  assert.throws(() => ui.run('validate({schemaVersion:1,...state.selection,candidates:[{id:"a",values:[]}]})'), /궁극기 애니메이션/);
  assert.throws(() => ui.run('validate({candidates:[{id:"a",values:[]}]})'), /schemaVersion 1/, 'a malformed import still gets its own schema error');
});

test('AI response for another action cannot silently replace the selected request', async () => {
  const ui = setup({}, actionCatalog);
  ui.$('action').value = 'skill'; await ui.$('action').emit('change');
  await ui.$('generateCandidates').emit('click');
  assert.equal(ui.run('state.request.actionId'), 'skill');
  assert.equal(ui.run('state.request.candidates.length'), 0);
  assert.match(ui.$('messageText').textContent, /실험 대상/);
  assert.equal(ui.$('runExperiment').disabled, true);
});

test('catalog refresh invalidates same-parameter candidates when action availability changes and displays the new reason', async () => {
  const ui = setup({}, actionCatalog);
  await ui.$('generateCandidates').emit('click');
  assert.equal(ui.run('requestReady()'), true);
  ui.run(`(() => { const next = copy(snapshot); next.catalog.adapters[0].sources[0].actions[0].available=false;
    next.catalog.adapters[0].sources[0].actions[0].unavailableReason='공격 애니메이션이 제거되었습니다.'; applySnapshot(next); })()`);
  assert.equal(ui.run('requestReady()'), false);
  assert.equal(ui.$('runExperiment').disabled, true);
  assert.equal(ui.$('generateCandidates').disabled, true);
  assert.match(ui.$('sourceHelp').textContent, /제거/);
});

test('valid skill remains usable when legacy normal-combo defaults are missing', () => {
  const ui = setup({}, snapshot => {
    actionCatalog(snapshot);
    const source = snapshot.catalog.adapters[0].sources[0];
    source.error = '일반 콤보 없음'; source.defaultRequest = null;
    source.actions[0].available = false; source.actions[0].defaultRequest = null;
  });
  assert.equal(ui.run('state.request.actionId'), 'skill');
  assert.equal(ui.$('generateCandidates').disabled, false);
  assert.match(ui.$('sourceHelp').textContent, /스킬/);
});

test('import preserves an explicit action even when all actions share identical parameter IDs', async () => {
  const ui = setup({}, snapshot => {
    actionCatalog(snapshot);
    const source = snapshot.catalog.adapters[0].sources[0];
    source.actions[1].parameters = source.parameters;
  });
  const imported = { ...ui.generated(4), actionId: 'skill' };
  ui.api.loadRequest = async () => imported;
  await ui.$('importRequest').emit('click');
  assert.equal(ui.run('state.request.actionId'), 'skill');
  assert.equal(ui.$('action').value, 'skill');
  assert.equal(ui.run('requestReady()'), true);
  ui.$('action').value = 'normal-combo'; await ui.$('action').emit('change');
  assert.equal(ui.run('state.request.candidates.length'), 0);
  assert.equal(ui.run('requestReady()'), false);
});

test('report target uses its recorded action independently of the setup selection and supports legacy archives', () => {
  const ui = setup({}, actionCatalog);
  assert.equal(ui.run('state.request.actionId'), 'normal-combo');
  assert.equal(ui.run('reportTarget({report:{adapterId:"fixture",sourceGuid:"source",actionId:"skill"}}).actionLabel'), '스킬');
  assert.equal(ui.run('reportTarget({report:{adapterId:"fixture",sourceGuid:"source"}}).actionLabel'), '일반 공격 전체 콤보');
  assert.equal(ui.run('reportTarget({report:{adapterId:"fixture",sourceGuid:"source",actionId:"skill",actionLabel:"기록된 스킬 이름"}}).actionLabel'), '기록된 스킬 이름');
  assert.equal(ui.run('reportTarget({report:{sourceGuid:"archived-source",actionId:"normal-3"}}).actionLabel'), '일반 공격 3타');
  assert.equal(ui.run('reportTarget({report:{sourceGuid:"archived-source",actionId:"normal-3"}}).sourceLabel'), 'archived-source');
});
