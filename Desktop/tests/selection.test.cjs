'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the production setup controller against a small DOM. These cases cover
// project/adapter transitions that cannot be represented by a runnable request.
function renderer() {
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName; this.children = []; this.value = ''; this.checked = false;
      this.classes = new Set();
      this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = [...items]; this.value = ''; }
    setAttribute() {}
    addEventListener() {}
    querySelectorAll() { return []; }
  }
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  $('goal').value = '명중감을 선명하게'; $('candidateTotal').value = '2';
  const context = vm.createContext({
    document: { getElementById: $, createElement: tag => new Element(tag) },
    window: { baekho: {}, scrollTo() {} }, stop() {}, videos: [],
  });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('// Report videos share')), context);
  return {
    $, run: code => vm.runInContext(code, context),
    json: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
    snapshot(catalog, options = {}) {
      context.inputSnapshot = structuredClone({
        projectPath: 'project-a', projectName: 'Project A', catalog, runs: [],
        connection: { connected: true }, ai: { available: true, authenticated: true }, ...options,
      });
      vm.runInContext('applySnapshot(inputSnapshot)', context);
    },
  };
}

function catalog() {
  const makeSource = (adapterId, guid, actionId) => ({
    guid, label: guid,
    actions: [{ id: actionId, label: `${actionId} 표시 이름`, available: true,
      parameters: [{ id: 'impact', label: 'Impact', minimum: 0, maximum: 5, baseline: 1 }],
      defaultRequest: { schemaVersion: 1, adapterId, sourceGuid: guid, actionId, durationSeconds: 10, seed: 1701, recordVideo: true, candidates: [] } }],
  });
  return { adapters: [
    { id: 'first', displayName: 'First project adapter', sources: [makeSource('first', 'first-source', 'slash')] },
    { id: 'custom', displayName: 'Custom project adapter', sources: [makeSource('custom', 'custom-source', 'weapon.fire-burst')] },
    { id: 'empty', displayName: 'Empty project adapter', sources: [], error: '게임의 설정 데이터를 만들어 주세요.' },
  ] };
}

test('an empty second adapter stays selected across refreshes and displays its error', () => {
  const ui = renderer(), description = catalog();
  ui.snapshot(description);
  ui.run("chooseSource('empty')");
  assert.equal(ui.$('adapter').value, 'empty');
  assert.equal(ui.run('state.request'), null);
  assert.equal(ui.$('sourceHelp').textContent, description.adapters[2].error);
  ui.snapshot(description);
  assert.equal(ui.$('adapter').value, 'empty');
  description.adapters[2].displayName = 'Updated empty adapter';
  ui.snapshot(description);
  assert.equal(ui.$('adapter').value, 'empty');
  assert.equal(ui.$('generateCandidates').disabled, true);
});

test('an unavailable action keeps its identity without inheriting another action request', () => {
  const ui = renderer(), description = catalog(), source = description.adapters[1].sources[0];
  source.defaultRequest = source.actions[0].defaultRequest;
  source.actions.push({ id: 'shield.parry', label: '방패 받아치기', available: false, unavailableReason: '방패 설정이 필요합니다.' });
  ui.snapshot(description);
  ui.run("chooseSource('custom', 'custom-source', 'shield.parry')");
  assert.equal(ui.$('adapter').value, 'custom');
  assert.equal(ui.$('action').value, 'shield.parry');
  assert.equal(ui.run('state.request'), null);
  assert.equal(ui.$('sourceHelp').textContent, '방패 설정이 필요합니다.');
  ui.snapshot(description);
  assert.equal(ui.$('action').value, 'shield.parry');
  assert.equal(ui.$('generateCandidates').disabled, true);
});

test('a source with an error remains inspectable alongside working sources', () => {
  const ui = renderer(), description = catalog();
  description.adapters[1].sources.push({ guid: 'broken-source', label: '수정이 필요한 데이터', actions: [], error: '프리팹 연결이 없습니다.' });
  ui.snapshot(description);
  ui.run("chooseSource('custom', 'broken-source')");
  assert.equal(ui.$('source').value, 'broken-source');
  assert.equal(ui.$('sourceHelp').textContent, '프리팹 연결이 없습니다.');
  assert.equal(ui.run('state.request'), null);
  ui.snapshot(description, { connection: { connected: false } });
  ui.snapshot(description);
  assert.equal(ui.$('source').value, 'broken-source');
  assert.equal(ui.$('sourceHelp').textContent, '프리팹 연결이 없습니다.');
});

test('legacy adapters without an action list still create their normal-combo request', () => {
  const ui = renderer(), description = catalog(), source = description.adapters[0].sources[0];
  source.parameters = source.actions[0].parameters;
  source.defaultRequest = source.actions[0].defaultRequest;
  delete source.actions;
  ui.snapshot(description);
  assert.equal(ui.run('state.request.actionId'), 'normal-combo');
  assert.equal(ui.run('currentParameters()[0].id'), 'impact');
  assert.equal(ui.run('actionAvailable()'), true);
});

test('custom action IDs and imported requests select the correct adapter schema', () => {
  const ui = renderer();
  ui.snapshot(catalog());
  ui.run("chooseSource('custom', 'custom-source', 'weapon.fire-burst')");
  assert.equal(ui.run('state.request.actionId'), 'weapon.fire-burst');
  assert.match(ui.$('sourceHelp').textContent, /weapon\.fire-burst 표시 이름/);
  ui.run(`
    globalThis.imported = { ...state.request, candidates: [{ id: 'one', values: [{ id: 'impact', value: 2 }] }, { id: 'two', values: [{ id: 'impact', value: 3 }] }] };
    chooseSource('first'); validate(imported); replaceRequest(imported, 'import');
  `);
  assert.equal(ui.$('adapter').value, 'custom');
  assert.equal(ui.$('source').value, 'custom-source');
  assert.equal(ui.$('action').value, 'weapon.fire-burst');
  assert.equal(ui.run('requestReady()'), true);
  assert.equal(ui.$('runExperiment').disabled, false);
});

test('reconnect preserves existing candidates, but a changed schema invalidates them', () => {
  const ui = renderer(), description = catalog();
  ui.snapshot(description);
  ui.run("chooseSource('custom'); replaceRequest({ ...state.request, candidates: [{ id: 'one', values: [{ id: 'impact', value: 2 }] }] }, 'import')");
  ui.snapshot(description, { connection: { connected: false } });
  assert.equal(ui.$('adapter').value, 'custom');
  assert.equal(ui.$('runExperiment').disabled, true);
  ui.snapshot(description);
  assert.equal(ui.run('requestReady()'), true);
  description.adapters[1].sources[0].actions[0].parameters[0].maximum = 1.5;
  ui.snapshot(description);
  assert.equal(ui.run('state.request.candidates.length'), 1, 'keep the old proposal visible for comparison');
  assert.equal(ui.run('requestReady()'), false);
  assert.equal(ui.$('runExperiment').disabled, true);
});

test('deleted targets are replaced with a valid selection and cannot retain old candidates', () => {
  const ui = renderer(), description = catalog();
  ui.snapshot(description);
  ui.run("chooseSource('custom'); replaceRequest({ ...state.request, candidates: [{ id: 'one', values: [{ id: 'impact', value: 2 }] }] }, 'import')");
  description.adapters.splice(1, 1);
  ui.snapshot(description);
  assert.equal(ui.$('adapter').value, 'first');
  assert.equal(ui.run('state.request.candidates.length'), 0);
  assert.equal(ui.$('runExperiment').disabled, true);
  description.adapters[0].sources[0].actions[0].id = 'replacement-action';
  ui.snapshot(description);
  assert.equal(ui.$('action').value, 'replacement-action');
  assert.equal(ui.run('state.request.actionId'), 'replacement-action');
});

test('switching projects resets selection and a project without adapters shows installation guidance', () => {
  const ui = renderer();
  ui.snapshot(catalog());
  ui.run("chooseSource('custom')");
  ui.snapshot({ adapters: [] }, { projectPath: 'project-b' });
  assert.equal(ui.$('adapter').value, '');
  assert.equal(ui.run('state.request'), null);
  assert.equal(ui.$('adapterSetup').hidden, false);
  assert.match(ui.$('sourceHelp').textContent, /Example 어댑터/);
  ui.snapshot(catalog(), { projectPath: 'project-b' });
  assert.equal(ui.$('adapter').value, 'first');
  assert.equal(ui.$('adapterSetup').hidden, true);
});

test('an adapter can gain its first source without falling back to a different adapter', () => {
  const ui = renderer(), description = catalog();
  ui.snapshot(description);
  ui.run("chooseSource('empty')");
  description.adapters[2].sources = description.adapters[1].sources;
  description.adapters[2].error = '';
  ui.snapshot(description);
  assert.equal(ui.$('adapter').value, 'empty');
  assert.equal(ui.$('source').value, 'custom-source');
  assert.equal(ui.run('state.request.adapterId'), 'empty');
  assert.equal(ui.run('state.request.actionId'), 'weapon.fire-burst');
});
