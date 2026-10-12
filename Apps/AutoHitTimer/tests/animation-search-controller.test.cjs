'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../src/controller.cjs');

const clip = (index, extra = {}) => ({ guid: index.toString(16).padStart(32, '0'), localId: '7400000', name: `Sword_${index}`, path: `Assets/Sword_${index}.anim`, length: 1, compatible: true, ...extra });
function fixture({ clips = [clip(1)], rank, search } = {}) {
  const calls = [], rankings = [], events = [];
  const client = { projectPath: 'C:/search-test', heartbeat: () => ({ ready: true }), command: async (command, payload, options) => {
    calls.push({ command, payload, options });
    if (command === 'actors') return { actors: [{ id: 'actor' }] };
    if (command === 'targets') return {};
    if (command !== 'search') throw new Error(`Unexpected mutation: ${command}`);
    if (search) return search(payload, options);
    const end = Math.min(clips.length, payload.offset + payload.limit);
    return { clips: clips.slice(payload.offset, end), truncated: end < clips.length, nextOffset: end < clips.length ? end : null };
  } };
  const store = { load: () => ({ jobs: [], settings: {} }), save() {}, savePreferences() {} };
  const ai = { status: async () => ({ available: true, authenticated: true }), rankAnimations: async (input, options) => {
    rankings.push({ input, options });
    return rank ? rank(input, options) : { matches: [{ index: 0, score: .8, reason: '검을 사용하는 동작입니다.' }], model: 'test-model' };
  } };
  const controller = new Controller({ store, clientFactory: () => client, ai });
  controller.on('state', state => events.push(structuredClone(state.search)));
  return { controller, client, calls, rankings, events };
}

test('natural-language search considers all catalog pages and maps ranked results to real Unity references', async () => {
  const clips = Array.from({ length: 325 }, (_, i) => clip(i + 1));
  const f = fixture({ clips, rank: async ({ clips: batch }) => ({ matches: [{ index: batch.length - 1, score: batch.length < 160 ? .95 : .7, reason: '요청한 검 동작과 가까운 이름입니다.' }], model: 'test-model' }) });
  await f.controller.connectProject('C:/search-test');
  const result = await f.controller.searchAnimations('앞으로 돌진하면서 검으로 베는 동작');
  assert.equal(result.mode, 'semantic'); assert.equal(result.searchedCount, 325);
  assert.equal(result.clips[0].guid, clips[324].guid); assert.equal(result.clips[0].searchScore, .95);
  assert.deepEqual(f.calls.filter(call => call.command === 'search').map(call => [call.payload.query, call.payload.offset]), [['', 0], ['', 300]]);
  assert.deepEqual(f.rankings.map(call => call.input.clips.length), [160, 160, 5, 3]);
  assert.ok(f.rankings.every(call => call.input.query === '앞으로 돌진하면서 검으로 베는 동작'));
  assert.match(result.summary, /미리보기/); assert.equal(f.controller.state.jobs.length, 0);
  assert.ok(f.events.some(event => event.busy && event.progressText.includes('3/3')));
  assert.equal(f.controller.state.search.busy, false);
});

test('name mode needs no AI and preserves compatibility restrictions and state contexts', async () => {
  const shared = clip(1, { compatible: false, reason: '리그 불일치', stateName: 'Base.Attack' });
  const f = fixture({ clips: [shared, shared, { ...shared, stateName: 'Base.Counter' }], rank: () => { throw new Error('AI should not run'); } });
  await f.controller.connectProject('C:/search-test');
  const result = await f.controller.searchAnimations(' Sword ', { mode: 'name' });
  assert.equal(result.clips.length, 2); assert.equal(result.clips[0].reason, '리그 불일치');
  assert.equal(result.clips[0].compatible, false); assert.equal(f.rankings.length, 0);
  assert.equal(f.calls.find(call => call.command === 'search').payload.query, 'Sword');
});

test('large catalogs reduce and rerank finalists together instead of comparing independent batch scores', async () => {
  const clips = Array.from({ length: 1441 }, (_, i) => clip(i + 1));
  const f = fixture({ clips, rank: async ({ clips: batch }) => ({ matches: batch.map((_, index) => ({ index, score: index / batch.length, reason: '검 동작 후보입니다.' })).slice(-20).reverse() }) });
  await f.controller.connectProject('C:/search-test');
  const result = await f.controller.searchAnimations('빠르게 검으로 베기');
  assert.equal(result.searchedCount, 1441); assert.equal(result.clips.length, 20); assert.equal(result.truncated, true);
  assert.deepEqual(f.rankings.map(call => call.input.clips.length), [...Array(9).fill(160), 1, 160, 21, 40]);
  assert.equal(new Set(result.clips.map(item => item.guid)).size, 20);
  assert.ok(result.clips.every(item => f.rankings.at(-1).input.clips.some(candidate => candidate.guid === item.guid)));
});

test('no relevant match returns an empty result instead of arbitrary clips', async () => {
  const f = fixture({ rank: async () => ({ matches: [] }) }); await f.controller.connectProject('C:/search-test');
  const result = await f.controller.searchAnimations('공중에서 활을 쏘는 동작');
  assert.deepEqual(result.clips, []); assert.equal(result.searchedCount, 1);
  assert.match(result.summary, /찾지 못했습니다/);
});

test('empty catalogs skip AI and malformed or legacy truncated catalogs fail explicitly', async () => {
  const empty = fixture({ clips: [] }); await empty.controller.connectProject('C:/search-test');
  assert.equal((await empty.controller.searchAnimations('베기')).searchedCount, 0); assert.equal(empty.rankings.length, 0);
  for (const reply of [{}, { clips: [clip(1)], truncated: true }, { clips: [clip(1)], truncated: true, nextOffset: 0 }, { clips: [null], truncated: false }]) {
    const f = fixture({ search: () => reply }); await f.controller.connectProject('C:/search-test');
    await assert.rejects(f.controller.searchAnimations('베기'), error => ['INVALID_RESPONSE', 'SEARCH_CATALOG_INCOMPLETE'].includes(error.code));
    assert.equal(f.controller.state.search.busy, false); assert.equal(f.rankings.length, 0);
  }
});

test('AI failures restore search controls, leave jobs untouched, and allow explicit name fallback', async () => {
  const f = fixture({ rank: async () => { throw Object.assign(new Error('Codex 로그인 필요'), { code: 'AI_AUTH_REQUIRED' }); } });
  await f.controller.connectProject('C:/search-test');
  await assert.rejects(f.controller.searchAnimations('찌르는 동작'), { code: 'AI_AUTH_REQUIRED' });
  assert.equal(f.controller.state.search.busy, false); assert.equal(f.controller.searchPromise, null);
  assert.equal((await f.controller.searchAnimations('Sword', { mode: 'name' })).clips.length, 1);
  assert.equal(f.controller.state.jobs.length, 0);
});

test('cancelled searches discard even a late AI response without cancelling Unity analysis', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture({ rank: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  await f.controller.connectProject('C:/search-test');
  const pending = f.controller.searchAnimations('베는 동작');
  const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  await ready; f.controller.cancelAnimationSearch();
  release({ matches: [{ index: 0, score: .9, reason: '검 베기' }] }); await rejected;
  assert.equal(f.controller.state.search.busy, false);
  assert.ok(!f.calls.some(call => call.command === 'cancel'));
});

test('a newer search and a project switch cannot publish stale results or clear newer progress', async () => {
  const releases = [], starts = [];
  const f = fixture({ rank: () => new Promise(resolve => { releases.push(resolve); starts.shift()?.(); }) });
  await f.controller.connectProject('C:/search-test');
  // Do not await the eventual rejection while arranging the next request.
  let started = new Promise(resolve => starts.push(resolve));
  const first = f.controller.searchAnimations('첫 검색'); const firstRejected = assert.rejects(first, { code: 'CANCELLED' }); await started;
  started = new Promise(resolve => starts.push(resolve));
  const second = f.controller.searchAnimations('둘째 검색'); const secondRejected = assert.rejects(second, { code: 'CANCELLED' }); await started;
  releases[0]({ matches: [] }); await firstRejected;
  assert.equal(f.controller.state.search.busy, true);
  await f.controller.connectProject('C:/search-test');
  releases[1]({ matches: [] }); await secondRejected;
  assert.equal(f.controller.state.search.busy, false);
});

test('actor changes cancel pending catalog requests and shutdown aborts pending AI work', async () => {
  let signal, release, started;
  let ready = new Promise(resolve => { started = resolve; });
  const f = fixture({ search: async (_payload, options) => { signal = options.signal; started(); return new Promise(resolve => { release = resolve; }); } });
  await f.controller.connectProject('C:/search-test');
  const pending = f.controller.searchAnimations('베기'); const rejected = assert.rejects(pending, { code: 'CANCELLED' }); await ready;
  await f.controller.updateSettings({ actorId: 'different-actor' }); assert.equal(signal.aborted, true);
  release({ clips: [clip(1)], truncated: false }); await rejected; assert.equal(f.rankings.length, 0);
  ready = new Promise(resolve => { started = resolve; });
  const f2 = fixture({ rank: async (_input, options) => { signal = options.signal; started(); return new Promise(resolve => { release = resolve; }); } });
  await f2.controller.connectProject('C:/search-test');
  const pending2 = f2.controller.searchAnimations('찌르기'); const rejected2 = assert.rejects(pending2, { code: 'CANCELLED' }); await ready;
  const stopping = f2.controller.shutdown(); assert.equal(signal.aborted, true);
  release({ matches: [] }); await stopping; await rejected2;
});

test('invalid requests and searching during analysis do not start catalog or AI work', async () => {
  const f = fixture(); await f.controller.connectProject('C:/search-test');
  for (const [query, options] of [[''], [' '.repeat(3)], ['x'.repeat(601)], [null], ['베기', { mode: 'invalid' }], ['베기', null]])
    await assert.rejects(f.controller.searchAnimations(query, options), { code: 'INVALID_INPUT' });
  f.controller.state.busy = true;
  await assert.rejects(f.controller.searchAnimations('베기'), { code: 'BUSY' });
  assert.ok(!f.calls.some(call => call.command === 'search')); assert.equal(f.rankings.length, 0);
});
