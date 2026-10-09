const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../src/controller.cjs');
const clip = { guid: 'a'.repeat(32), localId: '7400000', name: 'Attack', length: 1, sourceFingerprint: 'hash' };
function fixture({ failAI = false, uncertainSave = false, deferPreview = false } = {}) {
  const calls = []; let batch = 0;
  let persisted, requestId, releasePreview, receipt = { complete: false }, journal = { status: 'preview' };
  const client = { projectPath: 'C:/test', heartbeat: () => ({ ready: true }), mediaPath: filename => filename,
    response: () => receipt,
    command: async (command, payload, options) => {
      calls.push({ command, payload });
      if (command === 'actors') return { actors: [{ id: 'actor', label: 'Player' }] };
      if (command === 'targets') return { sources: [{ guid: 's', label: 'Fire' }], targets: [{ sourceGuid: 's', actionPath: 'Actions.ComboSteps.Array.data[0]', snapshot: 'snapshot' }], groups: [] };
      if (command === 'saveStatus') return journal;
      if (command === 'capture') { batch++; return { sessionId: 'session', clip, duration: 1, fps: payload.fps, frames: (payload.times || Array.from({ length: 25 }, (_, i) => i / 24)).map((time, i) => ({ id: `b${batch}f${i}`, time, path: '/frame.png' })) }; }
      if (command === 'previewChange') {
        if (deferPreview) await new Promise(resolve => { releasePreview = resolve; });
        return { changeId: 'change', canApply: true, issues: [] };
      }
      if (command === 'apply') {
        requestId = options.id;
        assert.equal(persisted.jobs[0].pendingSave.requestId, requestId, 'persist request ID before Unity dispatch');
        if (uncertainSave) throw Object.assign(new Error('uncertain'), { code: 'TIMEOUT_UNCERTAIN', requestId });
        return { assets: [{ path: 'Assets/result.asset' }], summary: '완료' };
      }
      return {};
    } };
  const store = { load: () => ({ jobs: [], settings: {} }), save(project, value) { persisted = structuredClone(value); }, savePreferences() {} };
  const ai = { status: async () => ({ available: true, authenticated: true }), analyze: async () => {
    if (failAI) throw Object.assign(new Error('limit'), { code: 'AI_USAGE_LIMIT' });
    return { status: 'hits', summary: '베기', windows: [{ start: .25, end: .5, reason: '앞으로 베기', uncertain: false }] };
  } };
  return { controller: new Controller({ store, clientFactory: () => client, ai }), calls, releasePreview: () => releasePreview(),
    completeSave(value) { receipt = { complete: true, result: value }; },
    recoveryState(nextReceipt, nextJournal) { receipt = nextReceipt; journal = nextJournal; } };
}
test('queue captures, coarsely analyzes, refines and leaves a review draft without applying', async () => {
  const { controller: c, calls } = fixture(); await c.connectProject('C:/test'); c.addJobs([clip, clip]);
  c.analyzeJobs(c.state.jobs.map(job => job.id)); await c.queuePromise;
  assert.ok(c.state.jobs.every(job => job.status === 'review' && job.windows.length === 1 && !job.reviewed));
  assert.equal(calls.filter(call => call.command === 'capture').length, 4);
  assert.equal(calls.filter(call => call.command === 'apply').length, 0);
  assert.equal(c.state.busy, false);
});
test('AI limit preserves captured frames and does not start the next queued job', async () => {
  const { controller: c } = fixture({ failAI: true }); await c.connectProject('C:/test'); c.addJobs([clip, clip]);
  c.analyzeJobs(c.state.jobs.map(job => job.id)); await c.queuePromise;
  assert.equal(c.state.jobs[0].status, 'failed'); assert.ok(c.state.jobs[0].frames.length);
  assert.equal(c.state.jobs[1].status, 'draft');
});
test('editing a reviewed preview invalidates apply; saved changes require explicit preview and apply', async () => {
  const { controller: c, calls } = fixture(); await c.connectProject('C:/test'); c.addJobs([clip]); const job = c.job();
  c.analyzeJobs([job.id]); await c.queuePromise;
  c.updateJob(job.id, { sourceGuid: 's', actionPath: 'Actions.ComboSteps.Array.data[0]' });
  await assert.rejects(c.previewChange(), /검토/);
  c.updateJob(job.id, { reviewed: true }); await c.previewChange();
  c.updateJob(job.id, { windows: [{ start: .3, end: .6, sourceIndex: -1 }] });
  await assert.rejects(c.applyChange('change'), /다시 확인/);
  c.updateJob(job.id, { reviewed: true }); await c.previewChange(); await c.applyChange('change');
  assert.equal(job.status, 'saved'); assert.equal(calls.filter(call => call.command === 'apply').length, 1);
  assert.ok(!('frames' in calls.find(call => call.command === 'previewChange').payload));
});
test('changing preview actor prevents saving analysis from the prior character', async () => {
  const { controller: c } = fixture(); await c.connectProject('C:/test'); c.addJobs([clip]);
  c.analyzeJobs([c.job().id]); await c.queuePromise; c.state.settings.weaponId = 'different'; c.updateJob(c.job().id, { reviewed: true });
  await assert.rejects(c.previewChange(), /다시 촬영/);
});

test('uncertain saves preserve request identity, block draft mutation and recover without a second apply', async () => {
  const { controller: c, calls, completeSave } = fixture({ uncertainSave: true });
  await c.connectProject('C:/test'); c.addJobs([clip]); const job = c.job();
  c.analyzeJobs([job.id]); await c.queuePromise;
  c.updateJob(job.id, { sourceGuid: 's', mode: 'register', copy: false });
  c.updateJob(job.id, { reviewed: true }); await c.previewChange();
  await assert.rejects(c.applyChange('change'), { code: 'TIMEOUT_UNCERTAIN' });
  assert.ok(job.pendingSave.requestId);
  assert.throws(() => c.removeJob(job.id), { code: 'SAVE_PENDING' });
  assert.throws(() => c.analyzeJobs([job.id]), { code: 'SAVE_PENDING' });
  assert.throws(() => c.updateJob(job.id, { reviewed: false }), { code: 'SAVE_PENDING' });
  completeSave({ actionPath: 'Actions.ComboSteps.Array.data[0]', assets: [{ path: 'Assets/result.asset' }] });
  c.poll(); await c.recoveryPromise;
  assert.equal(job.pendingSave, null); assert.equal(job.status, 'saved'); assert.equal(job.mode, 'update');
  assert.equal(job.actionPath, 'Actions.ComboSteps.Array.data[0]'); assert.equal(job.expectedSnapshot, 'snapshot');
  assert.equal(calls.filter(call => call.command === 'apply').length, 1);
});

test('a late preview response cannot authorize saving edits made during the request', async () => {
  const { controller: c, releasePreview } = fixture({ deferPreview: true });
  await c.connectProject('C:/test'); c.addJobs([clip]); const job = c.job();
  c.analyzeJobs([job.id]); await c.queuePromise; c.updateJob(job.id, { reviewed: true });
  const pending = c.previewChange();
  c.updateJob(job.id, { windows: [{ start: .4, end: .6 }] }); c.updateJob(job.id, { reviewed: true });
  releasePreview(); await assert.rejects(pending, { code: 'STALE_PREVIEW' });
  assert.equal(c.preview, null); await assert.rejects(c.applyChange('change'), /다시 확인/);
});

test('adapter journal recovers a committed save even when bridge recovery reports interruption', async () => {
  const { controller: c, calls, recoveryState } = fixture();
  await c.connectProject('C:/test'); c.addJobs([clip]); const job = c.job();
  Object.assign(job, { copy: false, mode: 'register', sourceGuid: 's', pendingSave: { requestId: 'request', changeId: 'change' } });
  recoveryState({ complete: true, error: 'interrupted', code: 'INTERRUPTED' },
    { status: 'complete', result: { actionPath: 'Actions.ComboSteps.Array.data[0]', assets: [{ path: 'Assets/result.asset' }] } });
  c.poll(); await c.recoveryPromise;
  assert.equal(job.status, 'saved'); assert.equal(job.mode, 'update'); assert.equal(job.pendingSave, null);
  assert.equal(calls.filter(call => call.command === 'apply').length, 0);
});

test('pre-dispatch crash unlocks only with proof of no mutation; unfinished mutation stays locked', async () => {
  const { controller: c, recoveryState } = fixture(); await c.connectProject('C:/test'); c.addJobs([clip]); const job = c.job();
  job.pendingSave = { requestId: 'request', changeId: 'change' };
  recoveryState({ complete: false }, { status: 'preview' });
  c.poll(); await c.recoveryPromise; assert.equal(job.pendingSave, null);
  job.pendingSave = { requestId: 'request', changeId: 'change' };
  recoveryState({ complete: true, error: 'interrupted' }, { status: 'recovery-required' });
  c.poll(); await c.recoveryPromise; assert.ok(job.pendingSave); assert.match(job.error, /Recover Interrupted Save/);
  recoveryState({ complete: true, error: 'interrupted' }, { status: 'rolled-back' });
  c.poll(); await c.recoveryPromise; assert.equal(job.pendingSave, null); assert.notEqual(job.status, 'saved');
});
