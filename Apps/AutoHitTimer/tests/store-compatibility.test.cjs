'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store.cjs');
const START = 'Feedback.Slash.SlashVFXStartTime';
const project = 'C:\\Disposable\\TimingCompatibility';

function setup(t, value) {
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryParent, 'aht-store-compatibility-')));
  t.after(() => {
    assert.equal(path.dirname(directory), temporaryParent);
    assert(path.basename(directory).startsWith('aht-store-compatibility-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = new Store(directory), filename = store.filename(project);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const original = Buffer.from(JSON.stringify(value, null, 2)); fs.writeFileSync(filename, original);
  return { store, filename, original, backup: filename + '.effects-v2-backup' };
}
function timingDraft(patch = {}) {
  return { id: 'stable-job-id', clip: { guid: 'a'.repeat(32), localId: '9223372036854775806', length: 1.8, name: 'Attack' },
    status: 'review', duration: 2.1, reviewed: true, sourceGuid: 'b'.repeat(32), actionPath: 'Actions[2]', contextKey: 'actor|weapon|bone',
    expectedSnapshot: 'original-snapshot', frames: [{ id: 'frame-9', time: .375, path: 'Library/AutoHitTimer/frame.png' }],
    windows: [{ id: 'stable-window', sourceIndex: 7, start: .25, end: .45, reason: 'keep timing', uncertain: false }],
    timeOverrides: [{ path: 'Execution.ComboTransitionTime', value: 1.2 }],
    versions: [{ savedUtc: '2026-10-23T10:00:00Z', windows: [{ id: 'historic', start: .2, end: .4 }], frames: [{ id: 'old-frame' }], effects: { historical: true } }],
    savedAssets: [{ path: 'Assets/Existing.asset' }], ...patch };
}

test('schema 2 downgrade backs up original bytes and preserves timing data while restoring one legacy slash start', t => {
  const job = timingDraft({ editMode: 'effectsOnly', effects: { defaults: { startTime: .42, offset: { x: 1, y: 2, z: 3 } }, hits: [] },
    effectSuggestion: { summary: 'retired proposal' }, effectRecommendations: [{ prefab: 'retired' }], legacySlashStartTime: .1,
    timeOverrides: [{ path: START, value: .05 }, { path: 'Execution.ComboTransitionTime', value: 1.2 }, { path: START, value: .09 }] });
  const value = { schemaVersion: 2, project, settings: { actorId: 'actor' }, selectedJobId: job.id, jobs: [job] };
  const { store, filename, original, backup } = setup(t, value), loaded = store.load(project), actual = loaded.jobs[0];
  assert(fs.readFileSync(backup).equals(original)); assert(fs.readFileSync(filename).equals(original), 'Load must not overwrite the existing file');
  assert.equal(loaded.schemaVersion, 1); assert.equal(loaded.selectedJobId, job.id); assert.deepEqual(loaded.settings, value.settings);
  assert.deepEqual(actual.timeOverrides, [{ path: 'Execution.ComboTransitionTime', value: 1.2 }, { path: START, value: .42 }]);
  for (const key of ['id', 'clip', 'duration', 'frames', 'windows', 'versions', 'savedAssets', 'sourceGuid', 'actionPath', 'contextKey', 'expectedSnapshot']) assert.deepEqual(actual[key], job[key], key);
  for (const key of ['editMode', 'effects', 'effectSuggestion', 'effectRecommendations', 'legacySlashStartTime']) assert(!Object.hasOwn(actual, key), key);
  assert.equal(actual.reviewed, false);
  store.load(project); assert(fs.readFileSync(backup).equals(original), 'Existing backup must never be overwritten');
  store.save(project, loaded); const saved = JSON.parse(fs.readFileSync(filename));
  assert.equal(saved.schemaVersion, 1); assert.deepEqual(store.load(project), saved);
});

test('legacy slash fallback retains the negative sentinel and adds no duplicate override after repeated saves', t => {
  const job = timingDraft({ effects: null, legacySlashStartTime: -1, editMode: 'attack', timeOverrides: [{ path: START, value: .6 }] });
  const { store } = setup(t, { schemaVersion: 2, project, settings: {}, jobs: [job], selectedJobId: job.id });
  let value = store.load(project);
  for (let count = 0; count < 3; count++) { store.save(project, value); value = store.load(project); }
  assert.deepEqual(value.jobs[0].timeOverrides, [{ path: START, value: -1 }]);
});

test('existing schema 1 timing drafts load and save without migration changes or an effects backup', t => {
  const job = timingDraft(); delete job.versions[0].effects;
  const value = { schemaVersion: 1, project, settings: { actorId: 'actor' }, jobs: [job], selectedJobId: job.id };
  const { store, backup } = setup(t, value);
  assert.deepEqual(store.load(project), value); assert(!fs.existsSync(backup));
  store.save(project, value); assert.deepEqual(store.load(project), value); assert(!fs.existsSync(backup));
});

test('uncertain save keeps its entire job and receipt context unchanged until resolution, then cleans up on save', t => {
  const job = timingDraft({ editMode: 'effectsOnly', effects: { defaults: { startTime: .31 }, hits: [] }, effectSuggestion: { effects: 'retained in pending context' },
    pendingSave: { changeId: 'immutable-change', requestId: 'immutable-request', sentUtc: '2026-10-23T11:00:00Z' }, error: 'TIMEOUT_UNCERTAIN' });
  const { store, original, backup } = setup(t, { schemaVersion: 2, project, jobs: [job], selectedJobId: job.id, settings: {} });
  const loaded = store.load(project); assert.deepEqual(loaded.jobs[0], job); assert(fs.readFileSync(backup).equals(original));
  store.save(project, loaded); const pendingReload = store.load(project); assert.deepEqual(pendingReload.jobs[0], job);
  pendingReload.jobs[0].pendingSave = null; pendingReload.jobs[0].status = 'saved';
  store.save(project, pendingReload);
  const resolved = store.load(project).jobs[0];
  assert.deepEqual(pendingReload.jobs[0], resolved, 'Successful resolution also removes retired fields from the active controller job');
  assert.equal(resolved.pendingSave, null); assert.equal(resolved.status, 'saved'); assert.equal(resolved.expectedSnapshot, job.expectedSnapshot);
  assert.deepEqual(resolved.frames, job.frames); assert.deepEqual(resolved.windows, job.windows);
  assert.deepEqual(resolved.timeOverrides.at(-1), { path: START, value: .31 });
  assert(!Object.hasOwn(resolved, 'effects')); assert(!Object.hasOwn(resolved, 'effectSuggestion')); assert(fs.readFileSync(backup).equals(original));
});

test('a blocked backup prevents conversion and further writes instead of returning an empty project', t => {
  const value = { schemaVersion: 2, project, settings: {}, selectedJobId: 'stable-job-id', jobs: [timingDraft({ effects: { defaults: { startTime: .5 } } })] };
  const { store, filename, original, backup } = setup(t, value);
  fs.mkdirSync(backup);
  assert.throws(() => store.load(project), error => error.code === 'DRAFT_BACKUP_FAILED');
  assert(fs.readFileSync(filename).equals(original));
  assert.throws(() => store.save(project, { jobs: [], settings: {}, selectedJobId: '' }), /원본을 보존/);
});

test('resolved schema 1 receipt honors a newer timing override and cannot carry retired values into a new target', t => {
  const job = timingDraft({ editMode: 'effectsOnly', effects: { defaults: { startTime: .31 } },
    timeOverrides: [{ path: START, value: .2 }], pendingSave: null });
  const { store } = setup(t, { schemaVersion: 1, project, settings: {}, selectedJobId: job.id, jobs: [job] });
  const loaded = store.load(project);
  assert.deepEqual(loaded.jobs[0].timeOverrides, [{ path: START, value: .2 }]);
  assert(!Object.hasOwn(loaded.jobs[0], 'effects'));
  loaded.jobs[0].sourceGuid = 'c'.repeat(32); loaded.jobs[0].timeOverrides = [];
  store.save(project, loaded);
  assert.deepEqual(store.load(project).jobs[0].timeOverrides, []);
});
