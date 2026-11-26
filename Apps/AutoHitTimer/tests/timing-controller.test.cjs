'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Controller } = require('../src/controller.cjs');
const { Store } = require('../src/store.cjs');
const { newJob } = require('../src/domain.cjs');

const clip = { guid: 'a'.repeat(32), localId: '74', name: 'Attack', length: 1, sourceFingerprint: 'hash' };
const durationPath = 'Execution.Duration', comboPath = 'Execution.ComboTransitionTime';
function fixture({ timingError, capabilities = true, overrideAI, length = 1 } = {}) {
  const selectedClip = { ...clip, length };
  const calls = [], timingCalls = []; let batch = 0, persisted;
  const target = { sourceGuid: 'source', actionPath: 'ComboSteps[0]', group: 'combo', snapshot: 'snapshot',
    duration: length * .9, currentClip: selectedClip, timeSettings: [{ path: comboPath, value: length * .7 }, { path: durationPath, value: length * .9 }] };
  const client = { projectPath: 'C:/timing-test', heartbeat: () => ({ ready: true }), mediaPath: value => value,
    command: async (command, payload) => {
      calls.push({ command, payload });
      if (command === 'actors') return { actors: [{ id: 'actor' }] };
      if (command === 'targets') return { capabilities: { attackTiming: capabilities }, targets: [target] };
      if (command === 'capture') return { sessionId: 'session', clip: selectedClip, duration: length,
        frames: payload.times.map(time => ({ id: `b${++batch}t${time}`, time, path: '/frame.png' })) };
      if (command === 'previewChange') return { canApply: true, changeId: 'change', editableTimeSettings: [{ path: durationPath, value: length }] };
      return {};
    } };
  const ai = { status: async () => ({ available: true, authenticated: true }),
    analyze: async () => ({ status: 'hits', summary: '타격', windows: [{ start: length * .25, end: length * .5, uncertain: false }] }),
    analyzeTiming: async input => {
      timingCalls.push(input);
      if (timingError) throw Object.assign(new Error('timing unavailable'), { code: timingError });
      const marker = time => { const frame = [...input.frames].sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
        return { time: frame.time, frameId: frame.id, reason: '자연스러운 연결', uncertain: false }; };
      return overrideAI ? overrideAI(input, marker) : { comboTransition: marker(length * .7), actionEnd: marker(length * .9) };
    } };
  const c = new Controller({ store: { load: () => ({ jobs: [], settings: {} }), save(project, value) { persisted = structuredClone(value); }, savePreferences() {} },
    clientFactory: () => client, ai });
  return { c, calls, timingCalls, target, selectedClip, persisted: () => persisted };
}
async function prepare(options) {
  const f = fixture(options); await f.c.connectProject('C:/timing-test'); f.c.addJobs([f.selectedClip]);
  f.c.updateJob(f.c.job().id, { sourceGuid: 'source', actionPath: 'ComboSteps[0]' });
  return f;
}
async function analyze(c) { c.analyzeJobs([c.job().id]); await c.queuePromise; }

test('timing uses whole-clip context then bounded 60fps refinement, without adopting suggestions', async () => {
  const { c, calls, timingCalls } = await prepare(); await analyze(c);
  const job = c.job();
  assert.equal(job.status, 'review'); assert.equal(job.timingError, '');
  assert.deepEqual(job.timeOverrides, []); assert.equal(job.reviewed, false);
  assert.equal(timingCalls.length, 3);
  assert.equal(timingCalls[0].frames[0].time, 0); assert.equal(timingCalls[0].frames.at(-1).time, 1);
  for (const input of timingCalls) { assert.ok(input.frames.length <= 96); assert.deepEqual(input.windows, job.windows); }
  for (const marker of Object.values(job.timingSuggestions)) {
    assert.equal(marker.uncertain, false);
    assert.ok(job.frames.some(frame => frame.id === marker.frameId && frame.time === marker.time));
  }
  assert.equal(calls.filter(call => call.command === 'capture' && call.payload.fps === 60).length, 3);
  assert.equal(calls.filter(call => call.command === 'apply').length, 0);
  assert.equal(job.duration, 1);
});

test('reanalysis preserves explicit timings and archives prior proposals', async () => {
  const { c } = await prepare(); await analyze(c); const job = c.job();
  const first = structuredClone(job.timingSuggestions);
  const edits = [{ path: durationPath, value: .85 }, { path: comboPath, value: .65 }];
  c.updateJob(job.id, { timeOverrides: edits, reviewed: true }); await analyze(c);
  assert.deepEqual(job.timeOverrides, edits); assert.equal(job.reviewed, false);
  assert.deepEqual(job.versions.at(-1).timingSuggestions, first);
  assert.deepEqual(job.versions.at(-1).timeOverrides, edits);
});

test('timing-only failure preserves hits; usage limit stops subsequent jobs', async () => {
  for (const code of ['AI_INVALID_OUTPUT', 'AI_USAGE_LIMIT']) {
    const { c } = await prepare({ timingError: code }); c.addJobs([clip]);
    c.analyzeJobs(c.state.jobs.map(job => job.id)); await c.queuePromise;
    const first = c.state.jobs[0];
    assert.equal(first.status, 'review'); assert.equal(first.windows.length, 1);
    assert.match(first.timingError, /unavailable/); assert.equal(first.timingSuggestions, null);
    assert.equal(c.state.jobs[1].status, code === 'AI_USAGE_LIMIT' ? 'draft' : 'review');
  }
});

test('refinement failure keeps coarse proposals review-only and retains explicit edits', async () => {
  const { c } = await prepare({ overrideAI(input, marker) {
    if (input.refinement) throw Object.assign(new Error('refinement failed'), { code: 'AI_CONNECTION_FAILED' });
    return { comboTransition: marker(.7), actionEnd: marker(.9) };
  } });
  c.updateJob(c.job().id, { timeOverrides: [{ path: durationPath, value: .95 }] }); await analyze(c);
  assert.equal(c.job().status, 'review'); assert.equal(c.job().windows.length, 1);
  assert.ok(Object.values(c.job().timingSuggestions).every(marker => marker.uncertain));
  assert.equal(c.job().timeOverrides[0].value, .95);
});

test('long-clip local analysis recursively narrows samples and respects each image budget', async () => {
  const { c, timingCalls } = await prepare({ length: 120 });
  const job = c.job();
  job.windows = [{ start: 20, end: 30, uncertain: false }];
  job.frames = Array.from({ length: 2881 }, (_, index) => ({ id: `f${index}`, time: index / 24, path: '/frame.png' }));
  await c.analyzeTiming(job, new AbortController().signal);
  assert.equal(timingCalls.length, 5);
  assert.equal(timingCalls[0].frames.length, 96);
  assert.equal(timingCalls[0].frames.at(-1).time, 120);
  for (const input of timingCalls) assert.ok(input.frames.length <= 96);
  assert.equal(job.timingSuggestions.actionEnd.uncertain, false);
});

test('refinement cannot confidently select context outside the candidate bracket', async () => {
  const { c } = await prepare({ overrideAI(input, marker) {
    return { comboTransition: marker(input.refinement ? 0 : .7), actionEnd: marker(.9) };
  } }); await analyze(c);
  assert.equal(c.job().timingSuggestions.comboTransition.uncertain, true);
  assert.match(c.job().timingSuggestions.comboTransition.reason, /범위/);
});

test('incomplete refinements are never persisted as actionable recommendations', async () => {
  const { c } = await prepare();
  const published = [];
  c.on('state', value => published.push(structuredClone(value.jobs[0])));
  await analyze(c);
  const candidates = published.filter(job => job.timingSuggestions && job.status === 'analyzing');
  assert.ok(candidates.length > 2);
  // The final completed pair may be published while the queue is still changing status.
  for (const job of candidates.slice(0, -1))
    assert.ok(Object.values(job.timingSuggestions).filter(item => item && typeof item === 'object').every(item => item.uncertain));
  assert.equal(c.job().timingSuggestions.actionEnd.uncertain, false);
});

test('a downgraded adapter preview cannot authorize apply even with a cached capability', async () => {
  const { c } = await prepare(); await analyze(c); c.updateJob(c.job().id, { reviewed: true });
  c.client.command = async () => ({ canApply: true, changeId: 'legacy', editableTimeSettings: [{ path: comboPath, value: .7 }] });
  await assert.rejects(c.previewChange(), { code: 'INTEGRATION_UPDATE_REQUIRED' });
  assert.equal(c.state.capabilities.attackTiming, undefined); assert.equal(c.preview, null);
  await assert.rejects(c.applyChange('legacy'));
});

test('preview preserves same-clip duration, rejects truncated hits, and allows manual early combo', async () => {
  const { c, target, calls } = await prepare(); await analyze(c); const job = c.job();
  target.duration = .4; c.updateJob(job.id, { reviewed: true });
  await assert.rejects(c.previewChange(), { code: 'INVALID_ATTACK_TIMING' });
  c.updateJob(job.id, { timeOverrides: [{ path: durationPath, value: .8 }, { path: comboPath, value: .2 }] });
  c.updateJob(job.id, { reviewed: true }); await c.previewChange();
  assert.deepEqual(calls.at(-1).payload.timeOverrides, job.timeOverrides);
  assert.ok(!('timingSuggestions' in calls.at(-1).payload));
  for (const value of [0, -.1, .49, 1.1]) {
    c.updateJob(job.id, { timeOverrides: [{ path: durationPath, value }, { path: comboPath, value: .2 }] });
    c.updateJob(job.id, { reviewed: true }); await assert.rejects(c.previewChange(), { code: 'INVALID_ATTACK_TIMING' });
  }
  c.updateJob(job.id, { timeOverrides: [{ path: durationPath, value: .8 }, { path: comboPath, value: .9 }] });
  c.updateJob(job.id, { reviewed: true }); await assert.rejects(c.previewChange(), { code: 'INVALID_ATTACK_TIMING' });
});

test('old integrations cannot authorize a save that would overwrite lifecycle times', async () => {
  const { c, calls } = await prepare({ capabilities: false }); await analyze(c);
  c.updateJob(c.job().id, { reviewed: true });
  await assert.rejects(c.previewChange(), { code: 'INTEGRATION_UPDATE_REQUIRED' });
  assert.equal(calls.filter(call => call.command === 'previewChange').length, 0);
});

test('target/template changes reset effective overrides while keeping clip proposals', async () => {
  const { c } = await prepare(); await analyze(c); const job = c.job();
  const suggestions = structuredClone(job.timingSuggestions);
  c.updateJob(job.id, { timeOverrides: [{ path: durationPath, value: .8 }] });
  c.updateJob(job.id, { mode: 'register', templatePath: 'ComboSteps[0]' });
  assert.deepEqual(job.timeOverrides, []); assert.deepEqual(job.timingSuggestions, suggestions);
  assert.equal(job.expectedSnapshot, 'snapshot');
  assert.throws(() => c.updateJob(job.id, { timeOverrides: null }));
  assert.throws(() => c.updateJob(job.id, { timeOverrides: [null] }));
  assert.throws(() => c.updateJob(job.id, { timeOverrides: [{ path: durationPath, value: .8 }, { path: durationPath, value: .9 }] }));
});

test('draft persistence round trips lifecycle edits and never rewrites uncertain save context', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-timing-store-'));
  try {
    const store = new Store(directory), job = newJob(clip);
    job.timeOverrides = [{ path: durationPath, value: .8 }, { path: comboPath, value: .6 }];
    job.timingSuggestions = { comboTransition: { time: .7, frameId: 'f7', reason: '연계', uncertain: false }, actionEnd: { time: .9, frameId: 'f9', reason: '회복', uncertain: false } };
    job.pendingSave = { requestId: 'request', changeId: 'change' };
    job.status = 'analyzing';
    store.save('C:/timing-test', { jobs: [job], settings: {} });
    assert.deepEqual(store.load('C:/timing-test').jobs[0], job);
    const legacy = { id: 'old', windows: [], status: 'review', pendingSave: { requestId: 'old-request', changeId: 'old-change' } };
    store.save('C:/timing-test', { jobs: [legacy] });
    assert.deepEqual(store.load('C:/timing-test').jobs[0], legacy);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
