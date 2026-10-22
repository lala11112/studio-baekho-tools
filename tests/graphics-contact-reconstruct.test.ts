import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGraphicsContactExecutor } from '../engine/graphics-contact';
import type { GraphicsNativeArgs } from '../engine/graphics-native';
import type { AssetVersion } from '../shared/graphics';
import type { GraphicsContactReview } from '../shared/graphics-contact';
import type { WorkerTask } from '../engine/codex-worker';

// Executor protocol fixtures only. Native geometry and visual quality are tested separately.
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const stamp = (file: string) => ({ localPath: file, sha256: hash(file), bytes: fs.statSync(file).size });
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-reconstruct-executor-'));
  t.after(() => {
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(actual).startsWith('ps-reconstruct-executor-'));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  const inputs: AssetVersion[] = ['main', 'part-head', 'part-body', 'part-hair'].map((slot, index) => {
    const file = path.join(root, slot + '.blend'); fs.writeFileSync(file, 'immutable scene fixture ' + index);
    return { id: slot, objectId: 'object', role: 'model', slot, label: slot, createdAt: '', sourceVersionIds: [], provenance: { type: 'codex', jobId: 'm08' }, warnings: [],
      files: [{ path: relative(root, file), kind: 'blend', ...stamp(file) }] };
  });
  const ids = inputs.slice(1).map(version => version.id), oldFolder = path.join(root, 'graphics/jobs/analyze-1/contact');
  const oldReport = path.join(oldFolder, 'checked-original/report.json');
  write(oldReport, { phase: 'analyze', status: 'blocked', sourceVersionId: 'main', partVersionIds: ids, identity: 'analysis-frozen' });
  const contact: GraphicsContactReview = { schemaVersion: 1, phase: 'analyze', status: 'blocked', sourceVersionId: 'main', partVersionIds: ids,
    reportPath: relative(root, oldReport), views: [], warnings: ['Hair interior shares exterior vertices; body collar uncertain'], allowedVertexCount: 0 };
  const diagnosis: AssetVersion = { id: 'diagnosis', objectId: 'object', role: 'model', slot: 'contact-review', label: 'Blocked original diagnosis', createdAt: '',
    sourceVersionIds: inputs.map(version => version.id), provenance: { type: 'codex', jobId: 'analyze-1' }, warnings: contact.warnings, contact,
    files: [{ path: relative(root, oldReport), kind: 'report', ...stamp(oldReport) }] };
  const oldBaseline = path.join(oldFolder, 'baseline.json');
  write(oldBaseline, { identity: 'analysis-frozen', sourceSha256: inputs[0].files[0].sha256, sourceVersionId: 'main', partVersionIds: ids, contract: { exact: { meshes: {} } } });
  write(path.join(oldFolder, 'prepared.json'), { identity: 'analysis-frozen', baselinePath: oldBaseline, baselineFile: stamp(oldBaseline) });
  write(path.join(oldFolder, 'checkpoint.json'), { identity: 'analysis-frozen', result: { contact }, files: diagnosis.files });
  write(path.join(oldFolder, 'dispatch.json'), { identity: 'analysis-frozen', phase: 'analyze', automaticRetries: 0 });
  const proposal = path.join(oldFolder, 'work/regions-proposal.json');
  write(proposal, { status: 'blocked', sourceSha256: inputs[0].files[0].sha256, sourceVersionId: 'main', partVersionIds: ids, meshes: [], camera: { front: '+X', confidence: 'confirmed' } });
  inputs.push(diagnosis);
  const args: GraphicsNativeArgs = { projectRoot: root, workspacePath: path.join(root, 'workspace.json'),
    object: { id: 'object', kind: 'character', name: 'Existing human', createdAt: '', selectedTasks: [], instruction: '', settings: {}, references: [], accepted: { 'model:main': 'previously-adopted' } },
    task: { id: 'reconstruct-1', objectId: 'object', taskId: 'M06', createdAt: '', updatedAt: '', status: 'running', inputVersionIds: inputs.map(version => version.id),
      settings: { contactPhase: 'reconstruct', sourceVersionId: 'main', contactPartVersionIds: JSON.stringify(ids), contactAnalysisVersionId: diagnosis.id,
        contactAnalysisTaskId: 'analyze-1', contactTopologyReconstructionConfirmed: true, 'lock.topology': false, count: 1 },
      instruction: 'Reconstruct only the scoped neck and inner hair; preserve face, ears, body and prior versions.', requestHash: 'frozen-reconstruction',
      outputVersionIds: [], backendJobIds: [], message: '', localOnly: false },
    inputs, blenderPath: process.execPath, resources: path.resolve('integrations'), signal: new AbortController().signal, onProgress() {} };
  const folder = path.join(root, 'graphics/jobs/reconstruct-1/contact'), modes: string[] = [], workers: WorkerTask[] = [];
  let action: 'completed' | 'blocked' | 'throw' | 'saved-then-throw' = 'completed';
  let workerHook: ((task: WorkerTask) => void) | undefined;
  let validationHook: ((report: any) => void) | undefined;
  const execute = createGraphicsContactExecutor({ runBlender: async (_executable, command) => {
    const q = read(command.at(-1)!); modes.push(q.mode);
    if (q.mode === 'prepare') {
      write(q.report, { identity: q.identity, sourceSha256: q.sourceSha256, sourceVersionId: q.sourceVersionId, partVersionIds: q.partVersionIds, contract: { exact: { meshes: {} } } });
      fs.writeFileSync(path.join(q.output, 'before.png'), 'local baseline render');
      write(q.previewReport, { views: [{ id: 'posX', file: 'before.png' }] }); return;
    }
    if (q.mode === 'reconstruction-scope') {
      assert.equal(hash(q.proposal), q.proposalSha256); assert.equal(read(q.proposal).status, 'blocked');
      write(q.report, { schemaVersion: 1, sourceSha256: args.inputs[0].files[0].sha256, allowedVertexCount: 2, bodyExact: true, allowed: { head: [2], hair: [3] } });
      fs.writeFileSync(path.join(q.output, 'overlay-scope.png'), 'local scope render');
      write(q.previewReport, { views: [], overlays: [{ id: 'posX', file: 'overlay-scope.png' }] }); return;
    }
    assert.equal(q.mode, 'reconstruct'); assert.equal(hash(q.regions), q.regionsSha256);
    const names = ['asset.fbx', 'asset.glb', 'before.png', 'after.png', 'regions.json'];
    const candidates = ['head', 'body', 'hair'].map(slot => ({ slot, files: ['blend', 'fbx', 'glb'].map(ext => `part-${slot}.${ext}`) }));
    for (const name of [...names, ...candidates.flatMap(candidate => candidate.files)]) fs.writeFileSync(path.join(q.output, name), 'validated local fixture ' + name);
    const report = { schemaVersion: 1, identity: q.identity, phase: 'reconstruct', status: 'repaired', passed: true,
      sourceVersionId: 'main', partVersionIds: ids, outputSha256: hash(q.outputBlend), allowedVertexCount: 2,
      checks: Object.fromEntries(['protectedVerticesExact', 'originalTopologyExact', 'originalUvMaterialsIdsExact', 'transformsExact', 'boundedDisplacement', 'addedGeometryLocalized', 'bodyExact'].map(name => [name, true])),
      files: [...names, ...candidates.flatMap(candidate => candidate.files)], mainFiles: ['asset.fbx', 'asset.glb', 'regions.json'], candidates, regions: 'regions.json',
      views: [{ id: 'posX', label: '+X', file: 'before.png' }], afterViews: [{ id: 'posX', label: '+X', file: 'after.png' }], warnings: ['Changed faces require UV; appearance review pending'] };
    validationHook?.(report); write(q.report, report);
  }, workerFactory: () => ({ probe: async () => { throw Error('External production probe forbidden'); }, run: async task => {
    workers.push(task); workerHook?.(task);
    if (action === 'throw') throw Error('Synthetic interrupted stream');
    if (action !== 'blocked') fs.writeFileSync(path.join(task.run.workspace, 'corrected.blend'), 'one authored native candidate');
    if (action === 'saved-then-throw') throw Error('Synthetic completion stream disconnected after save');
    return { result: { status: action === 'blocked' ? 'needs_input' : 'completed', summary: action === 'blocked' ? 'Local scope cannot resolve penetration' : 'Candidate ready for review', warnings: [] } };
  } }) });
  return { root, args, folder, oldFolder, proposal, diagnosis, modes, workers, execute,
    action: (value: typeof action) => { action = value; }, onWorker: (value: typeof workerHook) => { workerHook = value; }, onValidation: (value: typeof validationHook) => { validationHook = value; } };
}

test('reconstruction reuses saved blocked diagnosis, freezes scope before one dispatch and preserves native originals', async t => {
  const f = fixture(t), originals = f.args.inputs.flatMap(version => version.files.map(file => ({ file: path.join(f.root, file.path), sha256: file.sha256 })));
  const acceptance = structuredClone(f.args.object.accepted);
  f.onWorker(task => {
    assert.equal(task.requestedModel, 'gpt-6-astra'); assert.match(task.prompt, /LOCAL RECONSTRUCTION ONCE/);
    assert.match(task.prompt, /do NOT repeat semantic analysis/); assert.match(task.prompt, /BODY\/CLOTHING remain entirely exact/);
    assert.doesNotMatch(task.prompt, /ANALYSIS ONLY/);
    const dispatch = read(path.join(f.folder, 'dispatch.json'));
    assert.equal(dispatch.phase, 'reconstruct'); assert.equal(dispatch.automaticRetries, 0);
    assert.ok(fs.existsSync(path.join(f.folder, 'reconstruction-scope.json')));
  });
  const result = await f.execute(f.args);
  assert.deepEqual(f.modes, ['prepare', 'reconstruction-scope', 'reconstruct']); assert.equal(f.workers.length, 1);
  assert.equal(result.contact!.phase, 'reconstruct'); assert.equal(result.contact!.analysisVersionId, 'diagnosis');
  assert.deepEqual(result.candidates!.map(candidate => candidate.slot), ['main', 'part-head', 'part-body', 'part-hair']);
  assert.deepEqual(f.args.object.accepted, acceptance);
  for (const source of originals) assert.equal(hash(source.file), source.sha256);
  const dispatchHash = hash(path.join(f.folder, 'dispatch.json'));
  f.args.recoveryOnly = true; assert.deepEqual(await f.execute(f.args), result);
  assert.equal(f.workers.length, 1); assert.equal(f.modes.length, 3); assert.equal(hash(path.join(f.folder, 'dispatch.json')), dispatchHash);
});

test('reconstruction blocks incompatible or altered saved evidence before authoring', async t => {
  const variants = ['not-blocked', 'wrong-analysis-task', 'missing-permission', 'topology-locked', 'confirmed-old-mask', 'report-bytes', 'checkpoint-contact', 'checkpoint-report-hash', 'old-baseline-source', 'source-bytes', 'old-baseline-path'] as const;
  for (const variant of variants) await t.test(variant, async child => {
    const f = fixture(child);
    if (variant === 'not-blocked') f.diagnosis.contact!.status = 'ready';
    if (variant === 'wrong-analysis-task') f.args.task.settings.contactAnalysisTaskId = 'different';
    if (variant === 'missing-permission') delete f.args.task.settings.contactTopologyReconstructionConfirmed;
    if (variant === 'topology-locked') f.args.task.settings['lock.topology'] = true;
    if (variant === 'confirmed-old-mask') f.args.task.settings.contactRegionsConfirmed = true;
    if (variant === 'report-bytes') fs.appendFileSync(path.join(f.root, f.diagnosis.contact!.reportPath), 'changed');
    if (variant === 'checkpoint-contact' || variant === 'checkpoint-report-hash') {
      const file = path.join(f.oldFolder, 'checkpoint.json'), q = read(file);
      if (variant === 'checkpoint-contact') q.result.contact.sourceVersionId = 'foreign'; else q.files[0].sha256 = 'wrong';
      write(file, q);
    }
    if (variant === 'old-baseline-source' || variant === 'old-baseline-path') {
      const file = path.join(f.oldFolder, 'prepared.json'), q = read(file), old = read(q.baselinePath);
      if (variant === 'old-baseline-source') { old.sourceVersionId = 'foreign'; write(q.baselinePath, old); q.baselineFile = stamp(q.baselinePath); }
      else { const substitute = path.join(f.root, 'unbound-baseline.json'); write(substitute, old); q.baselinePath = substitute; }
      write(file, q);
    }
    if (variant === 'source-bytes') fs.appendFileSync(path.join(f.root, f.args.inputs[0].files[0].path), 'changed');
    await assert.rejects(f.execute(f.args)); assert.equal(f.workers.length, 0); assert.equal(f.modes.length, 0);
  });
});

test('reconstruction recovery never launches a first or second worker', async t => {
  await t.test('recovery before dispatch is read-only', async child => {
    const f = fixture(child); f.args.recoveryOnly = true;
    await assert.rejects(f.execute(f.args), /복구할/); assert.equal(f.workers.length, 0); assert.equal(f.modes.length, 0);
  });
  await t.test('interruption without result cannot reauthor', async child => {
    const f = fixture(child); f.action('throw'); await assert.rejects(f.execute(f.args), /Synthetic interrupted/);
    f.args.recoveryOnly = true; await assert.rejects(f.execute(f.args), /저장 결과/); assert.equal(f.workers.length, 1);
    assert.deepEqual(f.modes, ['prepare', 'reconstruction-scope']);
  });
  await t.test('saved model after lost completion validates locally without a new worker', async child => {
    const f = fixture(child); f.action('saved-then-throw');
    const result = await f.execute(f.args); assert.equal(result.contact!.status, 'repaired'); assert.equal(f.workers.length, 1);
    f.args.recoveryOnly = true; assert.deepEqual(await f.execute(f.args), result); assert.equal(f.workers.length, 1);
  });
  await t.test('needs_input creates only a blocked non-model diagnosis', async child => {
    const f = fixture(child); f.action('blocked'); const result = await f.execute(f.args);
    assert.equal(result.slot, 'contact-review'); assert.equal(result.contact!.status, 'blocked'); assert.equal(result.candidates, undefined);
    assert.ok(result.files.every(file => !/\.(blend|fbx|glb)$/.test(file.path)));
    assert.deepEqual(f.modes, ['prepare', 'reconstruction-scope']);
    f.args.recoveryOnly = true; assert.deepEqual(await f.execute(f.args), result); assert.equal(f.workers.length, 1);
  });
});

test('reconstruction rejects scope mutation during authoring and forged scope stamps during recovery', async t => {
  await t.test('worker cannot modify its frozen scope', async child => {
    const f = fixture(child);
    f.onWorker(() => fs.appendFileSync(path.join(f.folder, 'reconstruction-scope.json'), 'changed scope'));
    await assert.rejects(f.execute(f.args), /고정한/); assert.equal(f.workers.length, 1); assert.equal(f.modes.length, 2);
  });
  await t.test('dispatch binds prepared scope and baseline independently of editable prepared metadata', async child => {
    const f = fixture(child); f.action('throw'); await assert.rejects(f.execute(f.args), /Synthetic interrupted/);
    const preparedPath = path.join(f.folder, 'prepared.json'), q = read(preparedPath), scope = read(q.regionFile.localPath);
    scope.allowed.body = [0, 1, 2]; write(q.regionFile.localPath, scope); q.regionFile = stamp(q.regionFile.localPath); write(preparedPath, q);
    write(path.join(f.folder, 'work/result.json'), { status: 'completed', summary: 'Saved forged fixture', warnings: [] });
    fs.writeFileSync(path.join(f.folder, 'work/corrected.blend'), 'saved result'); f.args.recoveryOnly = true;
    await assert.rejects(f.execute(f.args)); assert.equal(f.workers.length, 1); assert.equal(f.modes.length, 2);
  });
  await t.test('changed reused proposal cannot resume under the old dispatch identity', async child => {
    const f = fixture(child); f.action('throw'); await assert.rejects(f.execute(f.args), /Synthetic interrupted/);
    const proposal = read(f.proposal); proposal.camera.front = '-X'; write(f.proposal, proposal); f.args.recoveryOnly = true;
    await assert.rejects(f.execute(f.args), /실행 요청이 다릅니다/); assert.equal(f.workers.length, 1); assert.equal(f.modes.length, 2);
  });
  await t.test('worker cannot change the host validator', async child => {
    const f = fixture(child), resources = path.join(f.root, 'isolated-test-resources'), scripts = path.join(resources, 'blender');
    fs.mkdirSync(scripts, { recursive: true });
    for (const name of ['graphics_contact.py', 'graphics_contact_reconstruct.py', 'graphics_contact_compat.py', 'graphics_astra_validate.py', 'graphics_glb.py', 'graphics_humanoid.py', 'graphics_size.py'])
      fs.copyFileSync(path.join(f.args.resources, 'blender', name), path.join(scripts, name));
    f.args.resources = resources;
    f.onWorker(() => fs.appendFileSync(path.join(scripts, 'graphics_contact_reconstruct.py'), '\n# synthetic unauthorized mutation\n'));
    await assert.rejects(f.execute(f.args), /검사 도구가 변경/); assert.equal(f.workers.length, 1); assert.equal(f.modes.length, 2);
  });
});

test('saved reconstruction output corruption prevents cached recovery without worker replay', async t => {
  const f = fixture(t), result = await f.execute(f.args), file = result.candidates!.find(candidate => candidate.slot === 'part-hair')!.files.find(file => file.path.endsWith('.blend'))!;
  fs.appendFileSync(path.join(f.root, file.path), 'changed registered candidate'); f.args.recoveryOnly = true;
  await assert.rejects(f.execute(f.args), /고정한/); assert.equal(f.workers.length, 1); assert.equal(f.modes.length, 3);
});

test('contact procedure recovery requires explicit saved-only intent and the exact incident script without authoring again', async t => {
  for (const variant of ['ordinary-call', 'no-dispatch', 'wrong-script', 'wrong-script-with-spoofed-receipt'] as const) await t.test(variant, async child => {
    const f = fixture(child);
    if (variant !== 'no-dispatch') { f.action('blocked'); await f.execute(f.args); }
    f.args.task.contactProcedureRecoveryRequested = true; f.args.recoveryOnly = variant !== 'ordinary-call';
    const work = path.join(f.folder, 'work'); fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'author_once.py'), 'print("This is not the approved stored procedure")');
    fs.writeFileSync(path.join(work, 'author.log'), 'AttributeError: bpy_struct: attribute "loop_total" from "MeshPolygon" is read-only');
    if (variant === 'wrong-script-with-spoofed-receipt') write(path.join(f.folder, 'procedure-dispatch.json'), {
      schemaVersion: 1, identity: read(path.join(f.folder, 'dispatch.json')).identity,
      authorSha256: '8988f6734ee6c09f9f816a93b0dea590a7670bdf2ba956b69fbafeeee93a166c',
      preparedSha256: hash(path.join(f.folder, 'prepared.json')), workerCalls: 0, localProcedureExecutions: 1,
    });
    const modes = [...f.modes], workerCount = f.workers.length;
    await assert.rejects(f.execute(f.args), variant === 'ordinary-call' ? /명시적인 로컬 복구/ : variant === 'no-dispatch' ? /복구할 접합 실행 기록/ : /동일한 저장 절차/);
    assert.deepEqual(f.modes, modes); assert.equal(f.workers.length, workerCount);
    assert.equal(fs.existsSync(path.join(f.folder, 'checkpoint-procedure.json')), false);
    assert.equal(fs.existsSync(path.join(work, 'corrected.blend')), false);
  });
});

test('normal blocked checkpoint cannot satisfy explicit procedure recovery as if it were a recovered model', async t => {
  const f = fixture(t); f.action('blocked'); const blocked = await f.execute(f.args);
  assert.equal(blocked.contact!.status, 'blocked'); assert.ok(fs.existsSync(path.join(f.folder, 'checkpoint.json')));
  f.args.task.contactProcedureRecoveryRequested = true; f.args.recoveryOnly = true;
  await assert.rejects(f.execute(f.args));
  assert.equal(f.workers.length, 1); assert.deepEqual(f.modes, ['prepare', 'reconstruction-scope']);
  assert.equal(fs.existsSync(path.join(f.folder, 'checkpoint-procedure.json')), false);
});

test('reconstruction requires every native protected-geometry receipt before registration', async t => {
  for (const check of ['protectedVerticesExact', 'originalTopologyExact', 'originalUvMaterialsIdsExact', 'transformsExact', 'boundedDisplacement', 'addedGeometryLocalized', 'bodyExact']) await t.test(check, async child => {
    const f = fixture(child); f.onValidation(report => { report.checks[check] = false; });
    await assert.rejects(f.execute(f.args), /보호 영역·새 면 범위/); assert.equal(f.workers.length, 1);
    assert.equal(fs.existsSync(path.join(f.folder, 'checkpoint.json')), false);
  });
});
