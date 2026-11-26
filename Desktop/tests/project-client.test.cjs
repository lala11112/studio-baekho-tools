'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectClient } = require('../src/project-client.cjs');

function json(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value));
}

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'combat-lab-client-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, 'Unity project');
  fs.mkdirSync(path.join(project, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(project, 'ProjectSettings'));
  fs.writeFileSync(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.10f1\n');
  const client = new ProjectClient(project);
  function heartbeat(overrides = {}) {
    json(path.join(client.bridgePath, 'status.json'), {
      protocolVersion: 1, projectPath: client.projectPath, timestampUtcMs: Date.now(), running: false,
      status: '대기 중', unityVersion: '6000.3.10f1', isPlaying: false, isCompiling: false, directory: '', ...overrides
    });
  }
  function run(id = '20261008-050017-abcd1234', candidateCount = 3, resultCount = candidateCount) {
    const directory = path.join(client.resultsPath, id);
    const candidates = Array.from({ length: candidateCount }, (_, i) => ({ id: `candidate_${i}`, label: `후보 ${i}`, values: [{ id: 'hitStop', value: i / 10 }] }));
    const request = { schemaVersion: 1, adapterId: 'adapter', sourceGuid: 'source', candidates };
    const report = {
      schemaVersion: 1, runId: id, sourceGuid: 'source', startedUtc: '2026-10-08T05:00:17.4452547Z',
      results: candidates.slice(0, resultCount).map(candidate => ({ candidate, status: 'completed', metrics: {}, videoPath: path.join(directory, `${candidate.id}.mp4`) }))
    };
    json(path.join(directory, 'report.json'), report);
    json(path.join(directory, 'request.json'), request);
    return { directory, report, request, id };
  }
  return { temporary, project, client, heartbeat, run };
}

function simulateUnity(t, client, processRequest) {
  const calls = [];
  let failure;
  const timer = setInterval(() => {
    const requests = path.join(client.bridgePath, 'requests');
    if (!fs.existsSync(requests)) return;
    for (const filename of fs.readdirSync(requests).filter(name => name.endsWith('.json'))) {
      try {
        const requestPath = path.join(requests, filename);
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
        const processingPath = path.join(client.bridgePath, 'processing', filename);
        fs.mkdirSync(path.dirname(processingPath), { recursive: true });
        fs.renameSync(requestPath, processingPath);
        calls.push(request);
        const response = processRequest(request);
        if (response !== undefined) {
          const target = path.join(client.bridgePath, 'responses', filename);
          json(`${target}.tmp`, response);
          fs.renameSync(`${target}.tmp`, target);
        }
      } catch (error) { failure = error; }
    }
  }, 5);
  t.after(() => { clearInterval(timer); if (failure) throw failure; });
  return calls;
}

test('validates a canonical Unity root and rejects Assets or arbitrary folders', t => {
  const { project, temporary, client } = fixture(t);
  assert.equal(ProjectClient.validateProject(path.join(project, '.')), client.projectPath);
  for (const input of ['', null, temporary, path.join(project, 'Assets'), '../missing']) {
    assert.throws(() => ProjectClient.validateProject(input), { code: 'INVALID_PROJECT' });
  }
});

test('heartbeat is normalized; reload/stale/mismatch/incompatible states are disconnected', t => {
  const { heartbeat, client, temporary } = fixture(t);
  assert.equal(client.getStatus().connected, false);
  heartbeat({ running: true, isPlaying: true });
  assert.deepEqual({ ...client.getStatus(), timestampUtcMs: 0 }, {
    connected: true, running: true, status: '대기 중', unityVersion: '6000.3.10f1', isPlaying: true,
    isCompiling: false, error: '', timestampUtcMs: 0, directory: ''
  });
  heartbeat({ timestampUtcMs: Date.now() - 16000, running: true });
  assert.equal(client.getStatus().connected, false);
  assert.equal(client.getStatus().running, true, 'keep last known running state without claiming live connection');
  assert.match(client.getStatus().status, /다시 연결/);
  heartbeat({ timestampUtcMs: Date.now() + 60000 });
  assert.equal(client.getStatus().connected, false);
  heartbeat({ timestampUtcMs: '2026-10-08' });
  assert.equal(client.getStatus().connected, false);
  heartbeat({ projectPath: temporary });
  assert.match(client.getStatus().error, /프로젝트 경로/);
  heartbeat({ protocolVersion: 9 });
  assert.match(client.getStatus().error, /버전/);
});

test('handles transient/oversized heartbeat JSON as disconnected', t => {
  const { heartbeat, client } = fixture(t);
  heartbeat();
  fs.writeFileSync(path.join(client.bridgePath, 'status.json'), '{');
  assert.equal(client.getStatus().connected, false);
  fs.writeFileSync(path.join(client.bridgePath, 'status.json'), ' '.repeat(300000));
  assert.equal(client.getStatus().connected, false);
});

test('describe sends one atomic UUID request and returns candidates for every source', async t => {
  const { heartbeat, client } = fixture(t);
  heartbeat();
  const expected = { adapters: [{ id: 'test', displayName: '테스트', sources: [
    { guid: 'sourceA', label: 'A', parameters: [], defaultRequest: { candidates: [{ id: 'baseline' }, { id: 'soft' }, { id: 'strong' }] }, error: '' },
    { guid: 'sourceB', label: 'B', parameters: [], defaultRequest: null, error: 'Missing data' }
  ] }] };
  const calls = simulateUnity(t, client, request => ({ id: request.id, ok: true, payloadJson: JSON.stringify(expected), error: '' }));
  assert.deepEqual(await client.describe(), expected);
  assert.equal(calls.length, 1);
  assert.match(calls[0].id, /^[a-f0-9]{32}$/);
  assert.equal(calls[0].protocolVersion, 1);
  assert.equal(calls[0].command, 'describe');
  assert.deepEqual(JSON.parse(calls[0].payloadJson), {});
  assert.ok(calls[0].expiresUtcMs > Date.now());
  assert.deepEqual(fs.readdirSync(path.join(client.bridgePath, 'requests')), []);
  assert.equal(fs.readdirSync(path.join(client.bridgePath, 'responses')).length, 1, 'keep receipts for Unity idempotency');
});

test('start preserves structured request and export/cancel use the allowlist', async t => {
  const { heartbeat, client } = fixture(t);
  heartbeat();
  const calls = simulateUnity(t, client, request => ({ id: request.id, ok: true, payloadJson: JSON.stringify({ acknowledged: request.command }), error: '' }));
  const payload = { request: { schemaVersion: 1, candidates: [{ id: 'baseline', values: [] }] } };
  assert.deepEqual(await client.command('start', payload), { acknowledged: 'start' });
  assert.deepEqual(JSON.parse(calls[0].payloadJson), payload);
  await client.command('cancel');
  await client.command('export', { assetPath: 'Assets/Example.asset' });
  assert.deepEqual(calls.map(call => call.command), ['start', 'cancel', 'export']);
  await assert.rejects(client.command('eval', {}), { code: 'INVALID_COMMAND' });
  await assert.rejects(client.command('start', []), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(client.command('start', {}, { timeoutMs: Infinity }), { code: 'INVALID_TIMEOUT' });
});

test('combined export preserves every action and candidate in a single bridge request', async t => {
  const { heartbeat, client } = fixture(t);
  heartbeat();
  const calls = simulateUnity(t, client, request => ({ id: request.id, ok: true,
    payloadJson: JSON.stringify({ assetPath: 'Assets/Combined.asset' }), error: '' }));
  const payload = { assetPath: 'Assets/Combined.asset', request: { schemaVersion: 1, adapterId: 'adapter', sourceGuid: 'source',
    selections: ['normal-combo', 'skill', 'ultimate'].map((actionId, index) => ({ candidateId: `chosen-${index}`,
      request: { schemaVersion: 1, adapterId: 'adapter', sourceGuid: 'source', actionId,
        candidates: [{ id: `chosen-${index}`, values: [{ id: 'impact', value: 1 + index }] }] } })) } };
  assert.deepEqual(await client.command('export-combined', payload), { assetPath: payload.assetPath });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'export-combined');
  assert.deepEqual(JSON.parse(calls[0].payloadJson), payload);
  assert.deepEqual(fs.readdirSync(path.join(client.bridgePath, 'requests')), []);
});

test('disconnected commands never queue requests', async t => {
  const { client, heartbeat } = fixture(t);
  heartbeat({ timestampUtcMs: Date.now() - 16000 });
  await assert.rejects(client.command('start', {}), { code: 'UNITY_DISCONNECTED' });
  assert.equal(fs.existsSync(path.join(client.bridgePath, 'requests')), false);
});

test('timeout removes only this callers unclaimed request without retries', async t => {
  const { client, heartbeat } = fixture(t);
  heartbeat();
  const other = path.join(client.bridgePath, 'requests', `${'a'.repeat(32)}.json`);
  json(other, { id: 'other' });
  await assert.rejects(client.command('start', {}, { timeoutMs: 30 }), { code: 'COMMAND_TIMEOUT_WITHDRAWN' });
  assert.deepEqual(fs.readdirSync(path.dirname(other)), [path.basename(other)]);
});

test('claimed timeout reports uncertainty, keeps processing file, and does not resend', async t => {
  const { client, heartbeat } = fixture(t);
  heartbeat();
  const calls = simulateUnity(t, client, () => undefined);
  await assert.rejects(client.command('start', {}, { timeoutMs: 220 }), { code: 'COMMAND_TIMEOUT_UNCERTAIN' });
  assert.equal(calls.length, 1);
  assert.equal(fs.readdirSync(path.join(client.bridgePath, 'processing')).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(client.bridgePath, 'requests')), []);
});

test('Unity errors, bad response IDs, malformed payload and bad describe shape are surfaced', async t => {
  const { client, heartbeat } = fixture(t);
  heartbeat();
  let mode = 'error';
  simulateUnity(t, client, request => {
    if (mode === 'error') return { id: request.id, ok: false, error: '씬을 저장하세요.' };
    if (mode === 'id') return { id: 'wrong', ok: true, payloadJson: '{}' };
    if (mode === 'json') return { id: request.id, ok: true, payloadJson: '{' };
    return { id: request.id, ok: true, payloadJson: '{}' };
  });
  await assert.rejects(client.command('start'), { code: 'UNITY_COMMAND_FAILED', message: '씬을 저장하세요.' });
  mode = 'id';
  await assert.rejects(client.command('cancel'), { code: 'INVALID_RESPONSE' });
  mode = 'json';
  await assert.rejects(client.command('cancel'), { code: 'INVALID_RESPONSE' });
  mode = 'shape';
  await assert.rejects(client.describe(), { code: 'INVALID_RESPONSE' });
});

test('report enumeration counts requested candidates and finished results, skipping malformed runs', t => {
  const { client, run, heartbeat } = fixture(t);
  const full = run('full', 3);
  const partial = run('partial', 4, 1);
  const noHits = run('no-hits', 2);
  noHits.report.results[0].status = 'no-hits';
  json(path.join(noHits.directory, 'report.json'), noHits.report);
  const failed = run('failed', 3, 1);
  failed.report.results[0].status = 'failed';
  json(path.join(failed.directory, 'report.json'), failed.report);
  const malformed = run('malformed');
  malformed.report.results.push(null);
  json(path.join(malformed.directory, 'report.json'), malformed.report);
  json(path.join(client.resultsPath, 'wrong-id', 'report.json'), full.report);
  json(path.join(client.resultsPath, 'unrelated', 'report.json'), { title: 'unrelated' });
  const summaries = Object.fromEntries(client.listRuns().map(result => [result.id, result]));
  assert.equal(Object.keys(summaries).length, 4);
  assert.deepEqual(summaries.full, { id: 'full', startedUtc: full.report.startedUtc, candidateCount: 3, completedCount: 3, status: 'completed', adapterId: 'adapter', sourceGuid: 'source', actionId: 'normal-combo' });
  assert.equal(summaries.partial.candidateCount, 4);
  assert.equal(summaries.partial.completedCount, 1);
  assert.equal(summaries.partial.status, 'incomplete');
  assert.equal(summaries['no-hits'].status, 'no-hits');
  assert.equal(summaries.failed.status, 'failed');
  heartbeat({ running: true, directory: partial.directory });
  assert.equal(client.listRuns().find(result => result.id === 'partial').status, 'running');
});

test('missing results are empty and legacy report without request still loads', t => {
  const { client, run } = fixture(t);
  assert.deepEqual(client.listRuns(), []);
  const sample = run();
  fs.unlinkSync(path.join(sample.directory, 'request.json'));
  const loaded = client.loadReport(sample.id);
  assert.equal(loaded.request, null);
  assert.deepEqual(loaded.report, sample.report);
  assert.equal(client.listRuns()[0].candidateCount, 3);
});

test('report paths reject traversal, reserved names and a report ID mismatch', t => {
  const { client, run } = fixture(t);
  const sample = run();
  for (const bad of ['..', '../other', '..\\other', '/absolute', 'C:\\absolute', 'a/b', 'a\\b', 'NUL', 'a.', 'a ', '%2e%2e']) {
    assert.throws(() => client.loadReport(bad), { code: 'INVALID_PATH' });
  }
  sample.report.runId = 'elsewhere';
  json(path.join(sample.directory, 'report.json'), sample.report);
  assert.throws(() => client.loadReport(sample.id), { code: 'INVALID_REPORT' });
});

test('duplicate or missing candidate IDs make a report invalid', t => {
  const { client, run } = fixture(t);
  const sample = run();
  sample.report.results[1].candidate.id = sample.report.results[0].candidate.id;
  json(path.join(sample.directory, 'report.json'), sample.report);
  assert.throws(() => client.loadReport(sample.id), { code: 'INVALID_REPORT' });
  delete sample.report.results[1].candidate.id;
  json(path.join(sample.directory, 'report.json'), sample.report);
  assert.throws(() => client.loadReport(sample.id), { code: 'INVALID_REPORT' });
});

test('v2 control media and repeated results remain separate and PNG paths are confined to their report', t => {
  const { client, run, temporary } = fixture(t), sample = run('v2-repeat', 2);
  sample.request.schemaVersion = 2; sample.request.repeatCount = 3;
  sample.report.results = sample.report.results.flatMap(result => [1, 2, 3].map(repeatIndex => ({ ...result, repeatIndex })));
  const imagePath = 'source-control.frames/000001.png';
  sample.report.controlResult = { candidate: { id: 'source-control', isSourceControl: true, values: [] }, status: 'completed', videoPath: 'source-control.mp4', capture: { frames: [{ imagePath }] } };
  json(path.join(sample.directory, 'report.json'), sample.report); json(path.join(sample.directory, 'request.json'), sample.request);
  fs.mkdirSync(path.join(sample.directory, 'source-control.frames')); fs.writeFileSync(path.join(sample.directory, imagePath), 'image'); fs.writeFileSync(path.join(sample.directory, 'source-control.mp4'), 'video');
  assert.equal(client.loadReport(sample.id).report.results.length, 6);
  assert.equal(client.listRuns()[0].candidateCount, 6); assert.equal(client.listRuns()[0].status, 'completed');
  assert.equal(client.resolveImage(sample.id, imagePath), fs.realpathSync(path.join(sample.directory, imagePath)));
  assert.equal(client.resolveVideo(sample.id, 'source-control.mp4'), fs.realpathSync(path.join(sample.directory, 'source-control.mp4')));
  assert.throws(() => client.resolveImage(sample.id, '../outside.png'));
  assert.throws(() => client.resolveImage(sample.id, 'source-control.frames/unregistered.png'), { code: 'INVALID_IMAGE' });
  const outside = path.join(temporary, 'outside-images'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, '000001.png'), 'outside');
  fs.symlinkSync(outside, path.join(sample.directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  sample.report.controlResult.capture.frames.push({ imagePath: 'escape/000001.png' }); json(path.join(sample.directory, 'report.json'), sample.report);
  assert.throws(() => client.resolveImage(sample.id, 'escape/000001.png'), { code: 'INVALID_PATH' });
});

test('capture timeline reads explicit VFR PTS and rejects reversed times or unsafe sidecar paths', t => {
  const { client, run } = fixture(t), sample = run('vfr');
  const capture = { framesPath: 'candidate.frames.json' };
  const frames = [0, 17000, 50000].map((mediaPtsUs, captureIndex) => ({ captureIndex, mediaPtsUs, unityRealtimeUs: 1000000 + mediaPtsUs, kind: 'captured' }));
  json(path.join(sample.directory, capture.framesPath), { schemaVersion: 1, frames });
  assert.deepEqual(client.loadCaptureTimeline(sample.id, capture).map(frame => frame.mediaPtsUs), [0, 17000, 50000]);
  frames[2].mediaPtsUs = 1; json(path.join(sample.directory, capture.framesPath), { schemaVersion: 1, frames });
  assert.throws(() => client.loadCaptureTimeline(sample.id, capture), { code: 'INVALID_CAPTURE' });
  assert.throws(() => client.loadCaptureTimeline(sample.id, { framesPath: '../outside.json' }), { code: 'INVALID_PATH' });
});

test('completed runs with incomparable fixture conditions retain that outcome in history', t => {
  const { client, run } = fixture(t), sample = run('conditions', 2);
  for (const status of ['conditions-mismatch', 'conditions-unavailable']) {
    sample.report.results[0].status = status; json(path.join(sample.directory, 'report.json'), sample.report);
    const item = client.listRuns()[0]; assert.equal(item.status, status); assert.equal(item.completedCount, 2);
  }
});

test('video resolution requires a report reference and confines the filename to its run', t => {
  const { client, run } = fixture(t);
  const sample = run();
  const video = path.join(sample.directory, 'candidate_0.mp4');
  fs.writeFileSync(video, 'fake-video');
  fs.writeFileSync(path.join(sample.directory, 'unlisted.mp4'), 'private');
  assert.equal(client.resolveVideo(sample.id, 'candidate_0.mp4'), fs.realpathSync(video));
  assert.throws(() => client.resolveVideo(sample.id, 'unlisted.mp4'), { code: 'INVALID_VIDEO' });
  assert.throws(() => client.resolveVideo(sample.id, 'report.json'), { code: 'INVALID_VIDEO' });
  for (const filename of ['../candidate_0.mp4', 'sub/candidate_0.mp4', 'candidate_0.mp4:stream', 'C:\\candidate_0.mp4']) {
    assert.throws(() => client.resolveVideo(sample.id, filename), { code: 'INVALID_PATH' });
  }
  sample.report.results[0].videoPath = '../candidate_0.mp4';
  json(path.join(sample.directory, 'report.json'), sample.report);
  assert.throws(() => client.resolveVideo(sample.id, 'candidate_0.mp4'), { code: 'INVALID_VIDEO' });
});

test('junction escapes in result and bridge directories are rejected', async t => {
  const { client, project, temporary, heartbeat } = fixture(t);
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, client.resultsPath, 'junction');
  assert.throws(() => client.listRuns(), { code: 'INVALID_PATH' });
  fs.unlinkSync(client.resultsPath);
  fs.mkdirSync(path.join(project, 'Library'));
  fs.symlinkSync(outside, client.bridgePath, 'junction');
  json(path.join(outside, 'status.json'), { protocolVersion: 1, projectPath: project, timestampUtcMs: Date.now() });
  assert.equal(client.getStatus().connected, false);
  await assert.rejects(client.command('start'), { code: 'UNITY_DISCONNECTED' });
});

test('junction run escape and symlink video escape cannot expose outside files', t => {
  const { client, run, temporary } = fixture(t);
  const sample = run();
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(client.resultsPath, 'escaped-run'), 'junction');
  assert.throws(() => client.loadReport('escaped-run'), { code: 'INVALID_PATH' });
  const secret = path.join(outside, 'secret.mp4');
  fs.writeFileSync(secret, 'private');
  try { fs.symlinkSync(secret, path.join(sample.directory, 'candidate_0.mp4'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('File symlinks need Windows developer mode; junction containment assertions passed.'); return; } throw error; }
  assert.throws(() => client.resolveVideo(sample.id, 'candidate_0.mp4'), { code: 'INVALID_PATH' });
});

test('judgment validates the selected result, bounds feedback, and persists only expected fields', t => {
  const { client, run } = fixture(t);
  const sample = run();
  const result = client.saveJudgment(sample.id, {
    selectedCandidateId: 'candidate_1', feedback: '반응이 선명함', arbitraryPath: '../outside', schemaVersion: 99
  });
  assert.equal(result.selectedCandidateIndex, 1);
  assert.equal(result.schemaVersion, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(sample.directory, 'judgment.json'), 'utf8'));
  assert.equal(saved.feedback, '반응이 선명함');
  assert.equal(saved.arbitraryPath, undefined);
  assert.equal(saved.path, undefined);
  assert.deepEqual(client.loadReport(sample.id).judgment, saved, 'restore persisted choice when a report is reopened');
  assert.throws(() => client.saveJudgment(sample.id, { selectedCandidateId: 'missing', feedback: '' }), { code: 'INVALID_JUDGMENT' });
  assert.throws(() => client.saveJudgment(sample.id, { selectedCandidateId: 'candidate_1', selectedCandidateIndex: 0, feedback: '' }), { code: 'INVALID_JUDGMENT' });
  assert.throws(() => client.saveJudgment(sample.id, { feedback: 'x'.repeat(20001) }), { code: 'INVALID_JUDGMENT' });
  const none = client.saveJudgment(sample.id, { selectedCandidateId: null, feedback: '보류' });
  assert.equal(none.selectedCandidateIndex, null);
  assert.deepEqual(fs.readdirSync(sample.directory).filter(name => name.endsWith('.tmp')), []);
});

test('optional malformed or mismatched judgments do not prevent opening a report', t => {
  const { client, run } = fixture(t);
  const sample = run();
  const filename = path.join(sample.directory, 'judgment.json');
  assert.equal(client.loadReport(sample.id).judgment, null);
  client.saveJudgment(sample.id, { selectedCandidateId: 'candidate_0', feedback: 'saved' });
  const judgment = JSON.parse(fs.readFileSync(filename, 'utf8'));
  for (const invalid of [
    { ...judgment, runId: 'another-run' }, { ...judgment, selectedCandidateId: 'missing' },
    { ...judgment, selectedCandidateIndex: 2 }, { ...judgment, feedback: 'x'.repeat(20001) },
    { ...judgment, sourceGuid: 'another-source' }, { ...judgment, createdUtc: 'not-a-date' }
  ]) {
    json(filename, invalid);
    assert.equal(client.loadReport(sample.id).judgment, null);
  }
  fs.writeFileSync(filename, '{');
  assert.equal(client.loadReport(sample.id).judgment, null);
  assert.equal(client.loadReport(sample.id).report.results.length, 3);
});
