'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the shipped renderer's setup controller and event handlers. The DOM
// records controls and events, while Unity/AI calls remain explicit test inputs.
function setup() {
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.classList = { toggle() {} }; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    async emit(name) { for (const callback of this.events[name] || []) await callback(); }
    querySelectorAll(selector) { const tags = selector.split(',').map(value => value.trim()); return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]); }
  }
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  $('goal').value = '기본 목표'; $('candidateTotal').value = '2';
  const parameters = [{ id: 'impact', minimum: 0, maximum: 10, baseline: 1 }];
  const request = { schemaVersion: 1, adapterId: 'fixture', sourceGuid: 'source-a', durationSeconds: 10, seed: 1701, recordVideo: true, candidates: [] };
  const actions = ['normal-combo', 'normal-1', 'normal-2', 'skill', 'ultimate'].map(id => ({ id, label: id, available: true, parameters: structuredClone(parameters), defaultRequest: { ...request, actionId: id } }));
  const snapshot = { projectPath: 'project-a', projectName: 'Fixture', runs: [], connection: { connected: true }, ai: { available: true, authenticated: true }, catalog: { adapters: [{ id: 'fixture', supportsCombinedExport: true, sources: [{ guid: 'source-a', actions }, { guid: 'source-b', actions: structuredClone(actions) }] }] } };
  const calls = { generate: [], export: [], run: [], report: [] };
  const generated = input => ({ ...request, adapterId: input.adapterId, sourceGuid: input.sourceGuid, actionId: input.actionId,
    candidates: Array.from({ length: input.count }, (_, index) => ({ id: `candidate-${index}`, label: `후보 ${index}`, values: [{ id: 'impact', value: 1 + index }] })) });
  const api = {
    refresh: async () => structuredClone(snapshot), generateCandidates: async input => { calls.generate.push(input); return generated(input); },
    exportCombinedPreset: async input => { calls.export.push(input); return { assetPath: 'Assets/Combined.asset' }; },
    run: async input => { calls.run.push(input); return { runId: `run-${input.actionId}` }; },
    cancelGeneration: async () => ({ cancelled: true }),
  };
  const context = vm.createContext({ window: { baekho: api, scrollTo() {} }, document: { getElementById: $, createElement: tag => new Element(tag) }, snapshot,
    stop() {}, videos: [], results: [], openReport: async id => calls.report.push(id) });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('// Report videos share')) + '\n' + source.slice(source.indexOf("$('dismissMessage').addEventListener"), source.indexOf("$('compareCount').addEventListener")) + '\napplySnapshot(snapshot);', context);
  const run = code => vm.runInContext(code, context);
  return { $, api, calls, generated, snapshot, run, json: code => JSON.parse(run(`JSON.stringify(${code})`)), panel: id => run(`state.actionPanels.get(${JSON.stringify(id)})`),
    async generate(id, count = 2, goal = `${id} 목표`) { const controls = this.panel(id); controls.goal.value = goal; await controls.goal.emit('input'); controls.count.value = count; await controls.count.emit('input'); await controls.generate.emit('click'); },
    selectPair() { run("toggleAction('normal-combo', false); toggleAction('normal-1', true); toggleAction('skill', true)"); },
  };
}

test('each selected action has an independent visible generator, candidates and explicit final choice', async () => {
  const ui = setup(); ui.selectPair();
  assert.equal(ui.$('multiActionDesign').children.length, 2);
  assert.equal(ui.$('singleActionDesign').hidden, true);
  await ui.generate('normal-1', 2, '빠른 연타');
  await ui.generate('skill', 3, '강한 마무리');
  assert.deepEqual(ui.json('state.selectedActions'), ['normal-1', 'skill']);
  assert.deepEqual(ui.calls.generate.map(input => [input.actionId, input.count, input.goal]), [['normal-1', 2, '빠른 연타'], ['skill', 3, '강한 마무리']]);
  assert.equal(ui.panel('normal-1').candidates.children.length, 2);
  assert.equal(ui.panel('skill').candidates.children.length, 3);
  assert.equal(ui.panel('normal-1').winner.value, '');
  assert.equal(ui.panel('skill').winner.value, '');
  assert.equal(ui.$('exportCombinedPreset').disabled, true);
  const before = ui.json("state.actionDrafts['normal-1']");
  await ui.generate('skill', 4, '묵직한 마무리');
  assert.deepEqual(ui.json("state.actionDrafts['normal-1']"), before);
});

test('all selected winners produce exactly one export request containing the correct candidates', async () => {
  const ui = setup(); ui.selectPair();
  await ui.generate('normal-1'); await ui.generate('skill');
  ui.panel('normal-1').winner.value = 'candidate-0'; await ui.panel('normal-1').winner.emit('change');
  assert.equal(ui.$('exportCombinedPreset').disabled, true);
  assert.throws(() => ui.run('combinedRequest()'), /최종 후보/);
  ui.panel('skill').winner.value = 'candidate-1'; await ui.panel('skill').winner.emit('change');
  assert.equal(ui.$('exportCombinedPreset').disabled, false);
  await ui.$('exportCombinedPreset').emit('click');
  assert.equal(ui.calls.export.length, 1);
  const combined = ui.calls.export[0].request;
  assert.equal(combined.schemaVersion, 1); assert.equal(combined.adapterId, 'fixture'); assert.equal(combined.sourceGuid, 'source-a');
  assert.deepEqual(Array.from(combined.selections, value => [value.request.actionId, value.candidateId]), [['normal-1', 'candidate-0'], ['skill', 'candidate-1']]);
  ui.panel('normal-1').goal.value = '다른 목표'; await ui.panel('normal-1').goal.emit('input');
  assert.equal(ui.$('exportCombinedPreset').disabled, true);
  assert.equal(ui.run("state.actionDrafts.skill.candidateId"), 'candidate-1');
  assert.throws(() => ui.run('combinedRequest()'), /후보를 생성/);
});

test('whole combo and individual normal attacks cannot overlap; zero selection allows replacing the initial combo', () => {
  const ui = setup();
  ui.run("toggleAction('normal-1', true)");
  assert.deepEqual(ui.json('state.selectedActions'), ['normal-combo']);
  assert.match(ui.$('messageText').textContent, /함께 선택할 수 없습니다/);
  ui.run("toggleAction('normal-combo', false)");
  assert.equal(ui.run('state.request'), null);
  assert.equal(ui.$('generateCandidates').disabled, true);
  ui.run("toggleAction('normal-1', true); toggleAction('normal-2', true); toggleAction('ultimate', true)");
  assert.deepEqual(ui.json('state.selectedActions'), ['normal-1', 'normal-2', 'ultimate']);
  assert.equal(ui.$('multiActionDesign').children.length, 3);
});

test('nonfocused action schema changes invalidate only that action and do not revive it on reconnect', async () => {
  const ui = setup(); ui.selectPair(); await ui.generate('normal-1'); await ui.generate('skill');
  ui.run("state.actionDrafts['normal-1'].candidateId='candidate-0'; state.actionDrafts.skill.candidateId='candidate-1'; updateControls()");
  ui.snapshot.catalog.adapters[0].sources[0].actions[1].parameters[0].maximum = 6;
  ui.run('applySnapshot(copy(snapshot))');
  assert.equal(ui.run("draftReady(state.actionDrafts['normal-1'])"), false);
  assert.equal(ui.run("state.actionDrafts['normal-1'].candidateId"), '');
  assert.equal(ui.run('draftReady(state.actionDrafts.skill)'), true);
  assert.equal(ui.run('state.actionDrafts.skill.candidateId'), 'candidate-1');
  ui.run('applySnapshot({...copy(snapshot),connection:{connected:false}}); applySnapshot(copy(snapshot))');
  assert.equal(ui.run("draftReady(state.actionDrafts['normal-1'])"), false);
  assert.equal(ui.$('exportCombinedPreset').disabled, true);
});

test('removing the focused action preserves other selected drafts and changing source clears them', async () => {
  const ui = setup(); ui.selectPair(); await ui.generate('normal-1'); await ui.generate('skill');
  const before = ui.json("state.actionDrafts['normal-1'].request");
  ui.snapshot.catalog.adapters[0].sources[0].actions = ui.snapshot.catalog.adapters[0].sources[0].actions.filter(action => action.id !== 'skill');
  ui.run('applySnapshot(copy(snapshot))');
  assert.deepEqual(ui.json('state.selectedActions'), ['normal-1']);
  assert.deepEqual(ui.json('state.request'), before);
  ui.run("chooseSource('fixture', 'source-b')");
  assert.equal(ui.run('Object.keys(state.actionDrafts).length'), 1);
  assert.equal(ui.run('state.request.sourceGuid'), 'source-b');
  assert.equal(ui.run('state.request.candidates.length'), 0);
});

test('late generation follows its original action without clobbering a separately focused draft', async () => {
  const ui = setup(); ui.selectPair(); await ui.generate('skill');
  const skill = ui.json('state.actionDrafts.skill.request'); let finish, input;
  ui.api.generateCandidates = request => { input = request; return new Promise(resolve => { finish = resolve; }); };
  const pending = ui.run("generateAction('normal-1')");
  ui.run("focusAction('skill')"); finish(ui.generated(input)); await pending;
  assert.equal(ui.run('state.selection.actionId'), 'skill');
  assert.deepEqual(ui.json('state.actionDrafts.skill.request'), skill);
  assert.equal(ui.run("draftReady(state.actionDrafts['normal-1'])"), true);
});

test('cancelled and obsolete generation results cannot overwrite drafts', async () => {
  const ui = setup(); ui.selectPair(); await ui.generate('normal-1'); await ui.generate('skill');
  const before = ui.json('state.actionDrafts'); let finish, input;
  ui.api.generateCandidates = request => { input = request; return new Promise(resolve => { finish = resolve; }); };
  let pending = ui.run("generateAction('normal-1')");
  await ui.panel('normal-1').cancel.emit('click'); finish(ui.generated(input)); await pending;
  assert.deepEqual(ui.json('state.actionDrafts'), before);
  pending = ui.run("generateAction('normal-1')");
  ui.run("chooseSource('fixture', 'source-b')"); finish(ui.generated(input)); await pending;
  assert.equal(ui.run('state.request.sourceGuid'), 'source-b');
  assert.equal(ui.run('state.request.candidates.length'), 0);
});

test('a project change clears every action draft and ignores an in-flight response from the old project', async () => {
  const ui = setup(); ui.selectPair(); await ui.generate('skill'); let finish, input;
  ui.api.generateCandidates = request => { input = request; return new Promise(resolve => { finish = resolve; }); };
  const pending = ui.run("generateAction('normal-1')");
  ui.snapshot.projectPath = 'project-b'; ui.run('applySnapshot(copy(snapshot))');
  finish(ui.generated(input)); await pending;
  assert.deepEqual(ui.json('state.selectedActions'), ['normal-combo']);
  assert.equal(ui.run('state.request.candidates.length'), 0);
  assert.equal(ui.run('state.actionDrafts.skill'), undefined);
  assert.equal(ui.$('multiActionDesign').hidden, true);
});

test('a schema change during generation rejects the result and preserves candidates for the other action', async () => {
  const ui = setup(); ui.selectPair(); await ui.generate('skill'); let finish, input;
  const before = ui.json('state.actionDrafts.skill.request');
  ui.api.generateCandidates = request => { input = request; return new Promise(resolve => { finish = resolve; }); };
  const pending = ui.run("generateAction('normal-1')");
  ui.snapshot.catalog.adapters[0].sources[0].actions[1].parameters[0].maximum = 7;
  ui.run('applySnapshot(copy(snapshot))'); finish(ui.generated(input)); await pending;
  assert.equal(ui.run("state.actionDrafts['normal-1'].request.candidates.length"), 0);
  assert.deepEqual(ui.json('state.actionDrafts.skill.request'), before);
  assert.match(ui.$('messageText').textContent, /공격 데이터가 변경/);
});

test('shared run conditions apply to each action and each compare button runs only its own candidates', async () => {
  const ui = setup(); ui.selectPair(); await ui.generate('normal-1'); await ui.generate('skill');
  ui.$('duration').value = 17; await ui.$('duration').emit('input');
  ui.$('seed').value = 44; await ui.$('seed').emit('input');
  ui.$('recordVideo').checked = false; await ui.$('recordVideo').emit('change');
  await ui.panel('normal-1').run.emit('click');
  assert.equal(ui.calls.run.length, 1);
  assert.equal(ui.calls.run[0].actionId, 'normal-1');
  assert.deepEqual([ui.calls.run[0].durationSeconds, ui.calls.run[0].seed, ui.calls.run[0].recordVideo], [17, 44, false]);
  assert.equal(ui.run("state.actionDrafts['normal-1'].runId"), 'run-normal-1');
  assert.equal(ui.run('state.actionDrafts.skill.request.durationSeconds'), 17);
});

test('report winners transfer only into the matching current action candidates', async () => {
  const ui = setup(); ui.selectPair(); await ui.generate('normal-1'); await ui.generate('skill');
  ui.run("state.reportBundle={request:copy(state.actionDrafts['normal-1'].request)}");
  ui.$('winner').value = 'candidate-1'; await ui.$('useReportCandidate').emit('click');
  assert.equal(ui.run("state.actionDrafts['normal-1'].candidateId"), 'candidate-1');
  assert.equal(ui.run('state.actionDrafts.skill.candidateId'), '');
  ui.run('state.reportBundle.request.candidates[0].values[0].value=8');
  assert.equal(ui.run('reportDraft()'), null);
  ui.$('winner').value = 'candidate-0'; await ui.$('useReportCandidate').emit('click');
  assert.equal(ui.run("state.actionDrafts['normal-1'].candidateId"), 'candidate-1');
});

test('Unity float32 serialization and empty optional fields still allow adopting a report winner', async () => {
  const ui = setup(); ui.selectPair(); await ui.generate('normal-1'); await ui.generate('skill');
  ui.run(`(() => {
    const request = state.actionDrafts['normal-1'].request;
    request.candidates[0].values[0].value = 0.08;
    request.candidates[1].values[0].value = 1.17;
    delete request.candidates[0].label;
    state.reportBundle = { request: copy(request) };
    state.reportBundle.request.candidates.forEach(candidate => {
      candidate.values.forEach(value => { value.value = Math.fround(value.value); });
      candidate.label ??= '';
      candidate.rationale ??= '';
    });
  })()`);
  assert.equal(ui.run('state.reportBundle.request.candidates[0].values[0].value'), 0.07999999821186066);
  assert.equal(ui.run("reportDraft() === state.actionDrafts['normal-1']"), true);
  ui.$('winner').value = 'candidate-0'; await ui.$('useReportCandidate').emit('click');
  assert.equal(ui.run("state.actionDrafts['normal-1'].candidateId"), 'candidate-0');
  assert.equal(ui.run('state.actionDrafts.skill.candidateId'), '');
  ui.run('state.reportBundle.request.candidates[0].values[0].value=0.08001');
  assert.equal(ui.run('reportDraft()'), null, 'a real float32 value change still marks the report stale');
});

test('report candidate matching uses unique IDs and rejects duplicate or changed candidate metadata', () => {
  const ui = setup();
  assert.equal(ui.run(`matchingCandidates(
    [{id:'a',values:[{id:'x',value:0.08},{id:'y',value:2}]},{id:'b',label:'B',rationale:null,values:[{id:'x',value:1}]}],
    [{id:'b',label:'B',rationale:'',values:[{id:'x',value:1}]},{id:'a',label:'',rationale:'',values:[{id:'y',value:2},{id:'x',value:Math.fround(0.08)}]}]
  )`), true);
  assert.equal(ui.run("matchingCandidates([{id:'a',values:[{id:'x',value:1}]}],[{id:'b',values:[{id:'x',value:1}]}])"), false);
  assert.equal(ui.run("matchingCandidates([{id:'a',rationale:'원래 이유',values:[]}],[{id:'a',rationale:'새 이유',values:[]}])"), false);
  assert.equal(ui.run("matchingCandidates([{id:'a',values:[{id:'x',value:1},{id:'x',value:1}]}],[{id:'a',values:[{id:'x',value:1},{id:'x',value:1}]}])"), false);
  assert.equal(ui.run("matchingCandidates([{id:'a',values:[]},{id:'b',values:[]}],[{id:'a',values:[]},{id:'a',values:[]}])"), false);
});

test('an older adapter cannot invoke combined export even when all winners are selected', async () => {
  const ui = setup(); ui.selectPair(); await ui.generate('normal-1'); await ui.generate('skill');
  ui.run("state.actionDrafts['normal-1'].candidateId='candidate-0'; state.actionDrafts.skill.candidateId='candidate-1'; state.catalog.adapters[0].supportsCombinedExport=false; updateControls()");
  assert.equal(ui.$('exportCombinedPreset').disabled, true);
  assert.match(ui.$('combinedHint').textContent, /업데이트/);
  await ui.$('exportCombinedPreset').emit('click');
  assert.equal(ui.calls.export.length, 0);
  assert.match(ui.$('messageText').textContent, /지원하지 않습니다/);
});
