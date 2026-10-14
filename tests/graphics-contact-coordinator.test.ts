import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { GraphicsEngine } from '../engine/graphics';
import type { Tripo } from '../engine/tripo';
import type { AssetVersion, GraphicsWorkspace } from '../shared/graphics';
import type { GraphicsContactReview } from '../shared/graphics-contact';
import type { GraphicsNativeArgs, GraphicsNativeResult } from '../engine/graphics-native';

// Synthetic coordinator contracts only: these fixtures do not prove human anatomy or visual quality.
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const slots = ['head', 'body', 'hair'];
async function idle(graphics: GraphicsEngine, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!graphics.isActive(id)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Synthetic contact executor did not settle');
}

async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-coordinator-'));
  let store = new Store(root); await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  let remoteCalls = 0, behavior: 'ready' | 'blocked' | 'throw' = 'ready';
  let mutateResult: ((result: GraphicsNativeResult) => void) | undefined;
  const calls: GraphicsNativeArgs[] = [];
  const tripo = new Proxy({}, { get: () => () => { remoteCalls++; throw Error('External API request forbidden in coordinator fixture'); } }) as Tripo;
  let engine = new Engine(store, tripo);
  const project = engine.create('Synthetic contact coordinator');
  const writeFile = (relative: string, text = relative) => {
    store.write(project.id, relative, text);
    return { path: relative, kind: relative.endsWith('.blend') ? 'blend' : relative.endsWith('.fbx') ? 'model' : 'report', bytes: Buffer.byteLength(text), sha256: sha(text) };
  };
  const make = (id: string, slot: string, assembled = false): AssetVersion => ({
    id, objectId: 'human', role: 'model', slot, label: id,
    files: [writeFile(`${id}.blend`), writeFile(`${id}.fbx`)], createdAt: '',
    sourceVersionIds: assembled ? ['head', 'body', 'hair', 'design'] : [],
    provenance: { type: 'local', ...(assembled ? { jobId: 'assembly' } : {}) }, warnings: [],
  });
  const design: AssetVersion = { id: 'design', objectId: 'human', role: 'design', slot: 'main', label: 'Original appearance',
    files: [writeFile('design.png')], createdAt: '', sourceVersionIds: [], provenance: { type: 'import' }, warnings: [] };
  const versions = [make('old-main', 'main'), ...slots.map(part => make(part, `part-${part}`)), design,
    make('assembled', 'main', true), ...slots.map(part => make(`placed-${part}`, `part-${part}`, true))];
  const initial: GraphicsWorkspace = { schemaVersion: 1, id: project.id, projectId: project.id, revision: 0,
    objects: [{ id: 'human', name: 'Human', kind: 'character', createdAt: '', selectedTasks: ['M08'],
      settings: { partId: 'head', count: 4, unsavedValue: 'keep' }, instruction: 'Unsaved user instruction',
      references: [{ versionId: 'design', role: 'appearance' }],
      accepted: { 'model:main': 'old-main', 'model:part-head': 'head', 'model:part-body': 'body', 'model:part-hair': 'hair', 'design:main': 'design' } }],
    versions, tasks: [{ id: 'assembly', objectId: 'human', taskId: 'M08', status: 'review', inputVersionIds: ['head', 'body', 'hair', 'design'],
      outputVersionIds: ['assembled', 'placed-head', 'placed-body', 'placed-hair'], settings: {}, instruction: '', requestHash: 'assembly-frozen',
      backendJobIds: [], createdAt: '', updatedAt: '', localOnly: true, message: '' }], deliveries: [], tripoBudget: { limit: 300, setAt: '' } };
  store.put('graphics', project.id, initial);
  const executor = async (args: GraphicsNativeArgs): Promise<GraphicsNativeResult> => {
    calls.push(args);
    if (behavior === 'throw') throw Error('Synthetic bounded analysis failed');
    const phase = args.task.settings.contactPhase as GraphicsContactReview['phase'];
    const prefix = `graphics/jobs/${args.task.id}`;
    const files = ['report.json', 'regions.json', 'before.png', phase === 'analyze' ? 'overlay.png' : 'after.png'].map(name => writeFile(`${prefix}/${name}`));
    const contact: GraphicsContactReview = { schemaVersion: 1, phase,
      status: behavior === 'blocked' ? 'blocked' : phase === 'analyze' ? 'ready' : 'repaired',
      sourceVersionId: String(args.task.settings.sourceVersionId), partVersionIds: JSON.parse(String(args.task.settings.contactPartVersionIds)),
      ...(phase !== 'analyze' ? { analysisVersionId: String(args.task.settings.contactAnalysisVersionId) } : {}),
      reportPath: files[0].path, regionsPath: files[1].path, allowedVertexCount: behavior === 'blocked' ? 0 : 12,
      views: [{ id: 'view-a', label: 'Verified view A', beforePath: files[2].path,
        ...(phase === 'analyze' ? { overlayPath: files[3].path } : { afterPath: files[3].path }) }], warnings: ['Synthetic fixture; external appearance review required'] };
    const result: GraphicsNativeResult = { contact, files, role: 'model', slot: 'contact-review', label: 'Contact review', warnings: contact.warnings };
    if (phase !== 'analyze' && behavior !== 'blocked') {
      result.slot = 'main';
      result.candidates = ['main', ...slots.map(part => `part-${part}`)].map(slot => ({
        role: 'model', slot, label: `Repaired ${slot}`, warnings: contact.warnings,
        files: [...(slot === 'main' ? files : []), writeFile(`${prefix}/${slot}.blend`), writeFile(`${prefix}/${slot}.fbx`)],
      }));
      result.files = result.candidates.flatMap(candidate => candidate.files);
    }
    mutateResult?.(result);
    return result;
  };
  const options = { resources: path.resolve('integrations'), astra: executor };
  let graphics = new GraphicsEngine(store, engine, options);
  t.after(() => {
    graphics.shutdown(); store.db.close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('contact-coordinator-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return {
    project, initial, calls, get graphics() { return graphics; }, get store() { return store; }, get remoteCalls() { return remoteCalls; },
    state: () => graphics.get(project.id), save: (w: GraphicsWorkspace) => store.put('graphics', project.id, w),
    behavior: (value: typeof behavior) => { behavior = value; }, mutate: (value?: typeof mutateResult) => { mutateResult = value; },
    prepare: (versionId = 'assembled', phase: GraphicsContactReview['phase'] = 'analyze') => graphics.action(project.id, { kind: 'prepare-contact', versionId, phase }),
    accept: (versionId: string) => graphics.action(project.id, { kind: 'accept', objectId: 'human', versionId }),
    run: async (taskId: string) => { await graphics.action(project.id, { kind: 'approve', taskId }); await idle(graphics, project.id); return graphics.get(project.id).tasks.find(task => task.id === taskId)!; },
    restart: async () => {
      assert.equal(graphics.isActive(project.id), false); graphics.shutdown(); store.db.close();
      store = new Store(root); await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
      engine = new Engine(store, tripo); graphics = new GraphicsEngine(store, engine, options);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function analysis(f: Fixture) {
  const task = (await f.prepare()).tasks.at(-1)!;
  assert.equal((await f.run(task.id)).status, 'review');
  return f.state().versions.find(version => version.provenance.jobId === task.id)!;
}
async function repair(f: Fixture) {
  const reviewed = await analysis(f), task = (await f.prepare(reviewed.id, 'repair')).tasks.at(-1)!;
  assert.equal((await f.run(task.id)).status, 'review');
  return { reviewed, task: f.state().tasks.find(value => value.id === task.id)!, main: f.state().versions.find(version => version.provenance.jobId === task.id && version.slot === 'main')! };
}
async function reconstruction(f: Fixture) {
  f.behavior('blocked'); const reviewed = await analysis(f); f.behavior('ready');
  const task = (await f.prepare(reviewed.id, 'reconstruct')).tasks.at(-1)!;
  assert.equal((await f.run(task.id)).status, 'review');
  return { reviewed, task: f.state().tasks.find(value => value.id === task.id)!, main: f.state().versions.find(version => version.provenance.jobId === task.id && version.slot === 'main')! };
}

test('synthetic contact preparation freezes unaccepted assembly and placed parts without changing drafts or starting work', async t => {
  const f = await fixture(t), before = structuredClone(f.state());
  const prepared = await f.prepare(), task = prepared.tasks.at(-1)!;
  assert.equal(task.status, 'awaiting_approval'); assert.equal(task.taskId, 'M06');
  assert.deepEqual(task.inputVersionIds, ['assembled', 'placed-head', 'placed-body', 'placed-hair', 'design']);
  assert.equal(task.settings.contactPhase, 'analyze'); assert.equal(task.settings.count, 1); assert.equal(task.settings.partId, undefined);
  assert.equal(task.cost?.provider, 'Codex'); assert.equal(task.cost?.credits, null);
  assert.deepEqual(prepared.objects, before.objects); assert.deepEqual(prepared.versions, before.versions);
  assert.deepEqual(await f.prepare(), prepared, 'Repeated preparation must not make another task or revision');
  await f.restart(); assert.deepEqual(f.state(), prepared); assert.deepEqual(await f.prepare(), prepared);
  assert.equal(f.calls.length, 0); assert.equal(f.remoteCalls, 0); assert.equal(f.store.project(f.project.id).jobs.length, 0);
});

test('synthetic ambiguous, foreign and stale assembly inputs fail before state mutation', async t => {
  const cases: Record<string, (f: Fixture, w: GraphicsWorkspace) => void> = {
    'main is from another object': (_f, w) => { w.versions.find(v => v.id === 'assembled')!.objectId = 'foreign'; },
    'part from another producer': (_f, w) => { w.versions.find(v => v.id === 'placed-hair')!.provenance.jobId = 'other'; },
    'part source differs': (_f, w) => { w.versions.find(v => v.id === 'placed-body')!.sourceVersionIds = ['head']; },
    'duplicate part slot': (_f, w) => { w.versions.find(v => v.id === 'placed-hair')!.slot = 'part-head'; },
    'missing part': (_f, w) => { w.versions = w.versions.filter(v => v.id !== 'placed-hair'); },
    'duplicate producer': (_f, w) => { w.tasks.push(structuredClone(w.tasks[0])); },
    'duplicate source version ID': (_f, w) => { w.versions.push(structuredClone(w.versions.find(v => v.id === 'assembled')!)); },
    'duplicate placed part version ID': (_f, w) => { w.versions.push(structuredClone(w.versions.find(v => v.id === 'placed-hair')!)); },
    'changed last native file': (f, w) => { f.store.write(f.project.id, w.versions.find(v => v.id === 'placed-hair')!.files.at(-1)!.path, 'changed'); },
    'changed appearance reference': (f) => { f.store.write(f.project.id, 'design.png', 'changed reference'); },
    'no editable original': (_f, w) => { w.versions.find(v => v.id === 'assembled')!.files = w.versions.find(v => v.id === 'assembled')!.files.filter(file => file.kind !== 'blend'); },
  };
  for (const [name, corrupt] of Object.entries(cases)) await t.test(name, async child => {
    const f = await fixture(child), value = structuredClone(f.state()); corrupt(f, value); f.save(value);
    const before = structuredClone(f.state()); await assert.rejects(f.prepare());
    assert.deepEqual(f.state(), before); assert.equal(f.calls.length, 0); assert.equal(f.remoteCalls, 0);
  });
});

test('synthetic ready analysis is nonadoptable and repair binds exact masks, inputs and source despite later draft edits', async t => {
  const f = await fixture(t), reviewed = await analysis(f), accepted = structuredClone(f.state().objects[0].accepted);
  assert.equal(reviewed.slot, 'contact-review'); assert.equal(reviewed.contact!.status, 'ready');
  const analysisMessage = f.state().tasks.find(task => task.id === reviewed.provenance.jobId)!.message;
  assert.match(analysisMessage, /수정 영역.*확인.*보정/); assert.match(analysisMessage, /모델은 아직 변경하지 않았/);
  assert.doesNotMatch(analysisMessage, /확인 후 채택하세요/);
  await assert.rejects(f.accept(reviewed.id)); assert.deepEqual(f.state().objects[0].accepted, accepted);
  const prepared = await f.prepare(reviewed.id, 'repair'), task = prepared.tasks.at(-1)!;
  assert.deepEqual(task.inputVersionIds, ['assembled', 'placed-head', 'placed-body', 'placed-hair', 'design', reviewed.id]);
  assert.equal(task.settings.contactAnalysisVersionId, reviewed.id); assert.equal(task.settings.contactRegionsConfirmed, true);
  assert.deepEqual(JSON.parse(String(task.settings.contactPartVersionIds)), reviewed.contact!.partVersionIds);
  await f.graphics.action(f.project.id, { kind: 'update-object', objectId: 'human', patch: { instruction: 'Later unrelated draft', settings: { partId: 'hair', count: 4 } } });
  assert.equal((await f.run(task.id)).status, 'review');
  const input = f.calls.at(-1)!.inputs.at(-1)!;
  assert.equal(input.id, reviewed.id); assert.equal(input.contact!.regionsPath, reviewed.contact!.regionsPath);
  assert.deepEqual(input.files, reviewed.files); assert.deepEqual(f.calls.at(-1)!.task.inputVersionIds, task.inputVersionIds);
  assert.equal(f.calls.at(-1)!.object.settings.partId, undefined); assert.equal(f.calls.at(-1)!.task.settings.count, 1);
  assert.deepEqual(f.state().objects[0].accepted, accepted); assert.equal(f.calls.length, 2); assert.equal(f.remoteCalls, 0);
  assert.deepEqual(await f.prepare(reviewed.id, 'repair'), f.state());
});

test('synthetic blocked analysis cannot repair or adopt and changed mask bytes stop before another executor call', async t => {
  await t.test('protected or uncertain region remains blocked across restart', async child => {
    const f = await fixture(child); f.behavior('blocked'); const reviewed = await analysis(f), before = structuredClone(f.state());
    const blockedMessage = before.tasks.find(task => task.id === reviewed.provenance.jobId)!.message;
    assert.match(blockedMessage, /중단/); assert.match(blockedMessage, /이유.*확인/); assert.match(blockedMessage, /기존 원본·채택은 유지/);
    assert.doesNotMatch(blockedMessage, /확인 후 채택하세요/);
    await assert.rejects(f.prepare(reviewed.id, 'repair')); await assert.rejects(f.accept(reviewed.id));
    assert.deepEqual(f.state(), before); await f.restart(); assert.deepEqual(f.state(), before);
    await f.prepare(); assert.equal(f.calls.length, 1); assert.equal(f.state().tasks.length, 2);
  });
  await t.test('mask hash changes after repair preparation', async child => {
    const f = await fixture(child), reviewed = await analysis(f), prepared = await f.prepare(reviewed.id, 'repair'), task = prepared.tasks.at(-1)!;
    f.store.write(f.project.id, reviewed.contact!.regionsPath!, 'modified masks'); const before = structuredClone(f.state());
    await assert.rejects(f.run(task.id), /해시|변경|원본/); assert.deepEqual(f.state(), before); assert.equal(f.calls.length, 1);
  });
});

test('synthetic reconstruction freezes a completed blocked diagnosis without promoting its masks or replaying analysis', async t => {
  const f = await fixture(t); f.behavior('blocked');
  const reviewed = await analysis(f), before = structuredClone(f.state()), prepared = await f.prepare(reviewed.id, 'reconstruct'), task = prepared.tasks.at(-1)!;
  assert.equal(task.status, 'awaiting_approval'); assert.equal(task.settings.contactPhase, 'reconstruct');
  assert.equal(task.settings.contactAnalysisVersionId, reviewed.id); assert.equal(task.settings.contactAnalysisTaskId, reviewed.provenance.jobId);
  assert.equal(task.settings.contactTopologyReconstructionConfirmed, true); assert.equal(task.settings.contactRegionsConfirmed, undefined);
  assert.equal(task.settings['lock.topology'], false); assert.equal(task.settings['lock.materials'], true); assert.equal(task.settings['lock.rig'], true);
  assert.equal(task.settings.count, 1); assert.equal(task.settings.partId, undefined);
  assert.deepEqual(task.inputVersionIds, ['assembled', 'placed-head', 'placed-body', 'placed-hair', 'design', reviewed.id]);
  assert.deepEqual(prepared.versions, before.versions); assert.deepEqual(prepared.objects, before.objects);
  assert.match(task.instruction, /얼굴·귀·몸통·의상/); assert.match(task.instruction, /새 분석 실행·자동 재시도/);
  assert.match(task.cost!.basis, /저장 진단 재사용/); assert.match(task.cost!.basis, /Tripo·fal 비용 없음/);
  await f.restart(); assert.deepEqual(f.state(), prepared); assert.deepEqual(await f.prepare(reviewed.id, 'reconstruct'), prepared);
  assert.equal(f.calls.length, 1); assert.equal(f.remoteCalls, 0);
  f.behavior('ready'); assert.equal((await f.run(task.id)).status, 'review');
  const dispatched = f.calls.at(-1)!;
  assert.equal(dispatched.inputs.at(-1)!.id, reviewed.id); assert.equal(dispatched.inputs.at(-1)!.contact!.status, 'blocked');
  assert.equal(dispatched.task.settings.contactRegionsConfirmed, undefined); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.state().objects, before.objects); assert.deepEqual(await f.prepare(reviewed.id, 'reconstruct'), f.state());
  assert.equal(f.state().tasks.filter(value => value.settings.contactPhase === 'analyze').length, 1);
});

test('synthetic reconstruction rejects unbound or unfinished diagnosis before another executor call', async t => {
  const cases: Record<string, (f: Fixture, w: GraphicsWorkspace, reviewed: AssetVersion) => void> = {
    'ready analysis is a different approval scope': (_f, w, reviewed) => { w.versions.find(v => v.id === reviewed.id)!.contact!.status = 'ready'; },
    'repair result cannot start reconstruction': (_f, w, reviewed) => { w.versions.find(v => v.id === reviewed.id)!.contact!.phase = 'repair'; },
    'analysis did not finish': (_f, w, reviewed) => { w.tasks.find(task => task.id === reviewed.provenance.jobId)!.completedExecutions = []; },
    'analysis producer is not in review': (_f, w, reviewed) => { w.tasks.find(task => task.id === reviewed.provenance.jobId)!.status = 'cancelled'; },
    'changed analysis producer parts': (_f, w, reviewed) => { w.tasks.find(task => task.id === reviewed.provenance.jobId)!.settings.contactPartVersionIds = '["old-head","old-body","old-hair"]'; },
    'changed diagnosis bytes': (f, _w, reviewed) => { f.store.write(f.project.id, reviewed.contact!.reportPath, 'changed diagnosis'); },
  };
  for (const [name, corrupt] of Object.entries(cases)) await t.test(name, async child => {
    const f = await fixture(child); f.behavior('blocked'); const reviewed = await analysis(f), value = structuredClone(f.state());
    corrupt(f, value, reviewed); f.save(value); const before = structuredClone(f.state());
    await assert.rejects(f.prepare(reviewed.id, 'reconstruct')); assert.deepEqual(f.state(), before);
    assert.equal(f.calls.length, 1); assert.equal(f.remoteCalls, 0);
  });
});

test('synthetic reconstruction registration rejects wrong phase, incomplete parts and foreign diagnosis without changing originals', async t => {
  for (const issue of ['wrong-phase', 'wrong-analysis', 'missing-parts', 'duplicate-parts', 'missing-metadata'] as const) await t.test(issue, async child => {
    const f = await fixture(child); f.behavior('blocked'); const reviewed = await analysis(f); f.behavior('ready');
    const task = (await f.prepare(reviewed.id, 'reconstruct')).tasks.at(-1)!, before = structuredClone(f.state());
    f.mutate(result => {
      if (issue === 'wrong-phase') result.contact!.phase = 'repair';
      else if (issue === 'wrong-analysis') result.contact!.analysisVersionId = 'foreign';
      else if (issue === 'missing-parts') result.candidates = result.candidates!.slice(0, 1);
      else if (issue === 'duplicate-parts') result.candidates![3].slot = 'part-head';
      else delete result.contact;
    });
    assert.equal((await f.run(task.id)).status, 'failed'); assert.deepEqual(f.state().versions, before.versions);
    assert.deepEqual(f.state().objects, before.objects); assert.equal(f.calls.length, 2); assert.equal(f.remoteCalls, 0);
  });
});

test('synthetic reconstructed candidates remain unaccepted and adopt all exact parts atomically', async t => {
  await t.test('four-part adoption and restart', async child => {
    const f = await fixture(child), { task, main } = await reconstruction(f), before = structuredClone(f.state());
    const candidates = before.versions.filter(version => task.outputVersionIds.includes(version.id));
    assert.equal(candidates.length, 4); assert.deepEqual(before.objects[0].accepted, f.initial.objects[0].accepted);
    assert.match(task.message, /보호 영역 검사/); assert.match(task.message, /수정한 면의 UV는 아직 미완료/);
    assert.doesNotMatch(task.message, /면 구조.*보존.*통과/);
    await assert.rejects(f.accept(candidates.find(version => version.slot === 'part-head')!.id), /함께/);
    assert.deepEqual(f.state(), before); await f.accept(main.id);
    assert.deepEqual(f.state().objects[0].accepted, { ...before.objects[0].accepted, ...Object.fromEntries(candidates.map(version => [`model:${version.slot}`, version.id])) });
    assert.deepEqual(f.state().versions, before.versions); assert.deepEqual(f.state().tasks, before.tasks);
    const adopted = structuredClone(f.state()); await f.restart(); assert.deepEqual(f.state(), adopted);
    for (const version of f.initial.versions) for (const file of version.files) assert.equal(sha(fs.readFileSync(f.store.file(f.project.id, file.path))), file.sha256);
    assert.equal(f.calls.length, 2); assert.equal(f.remoteCalls, 0);
  });
  await t.test('changed last part aborts adoption without changing one slot', async child => {
    const f = await fixture(child), { task, main } = await reconstruction(f), last = f.state().versions.find(version => version.id === task.outputVersionIds.at(-1))!;
    f.store.write(f.project.id, last.files.at(-1)!.path, 'changed last part'); const before = structuredClone(f.state());
    await assert.rejects(f.accept(main.id)); assert.deepEqual(f.state(), before); assert.equal(f.calls.length, 2);
  });
  await t.test('missing reconstruction authorization cannot adopt', async child => {
    const f = await fixture(child), { task, main } = await reconstruction(f), value = structuredClone(f.state());
    delete value.tasks.find(row => row.id === task.id)!.settings.contactTopologyReconstructionConfirmed;
    f.save(value); const before = structuredClone(f.state()); await assert.rejects(f.accept(main.id)); assert.deepEqual(f.state(), before);
  });
  await t.test('blocked reconstruction is diagnosis only and never automatically repeated', async child => {
    const f = await fixture(child); f.behavior('blocked'); const reviewed = await analysis(f);
    const task = (await f.prepare(reviewed.id, 'reconstruct')).tasks.at(-1)!; assert.equal((await f.run(task.id)).status, 'review');
    const before = structuredClone(f.state()), blocked = before.versions.find(version => version.provenance.jobId === task.id)!;
    assert.equal(blocked.slot, 'contact-review'); assert.equal(blocked.contact!.phase, 'reconstruct'); assert.equal(blocked.contact!.status, 'blocked');
    await assert.rejects(f.accept(blocked.id)); await assert.rejects(f.prepare(blocked.id, 'reconstruct'));
    await f.restart(); assert.deepEqual(f.state(), before); assert.deepEqual(await f.prepare(reviewed.id, 'reconstruct'), before);
    assert.deepEqual(f.state().objects, f.initial.objects); assert.equal(f.calls.length, 2); assert.equal(f.remoteCalls, 0);
  });
});

test('synthetic contact phases stay capped through failure, cancellation and restart', async t => {
  for (const phase of ['analyze', 'repair', 'reconstruct'] as const) for (const terminal of ['failed', 'cancelled', 'submission_unknown'] as const) await t.test(`${phase}/${terminal}`, async child => {
    const f = await fixture(child);
    if (phase === 'reconstruct') f.behavior('blocked');
    const reviewed = phase !== 'analyze' ? await analysis(f) : undefined;
    f.behavior('ready');
    const task = (await f.prepare(reviewed?.id ?? 'assembled', phase)).tasks.at(-1)!;
    if (terminal === 'failed') { f.behavior('throw'); assert.equal((await f.run(task.id)).status, 'failed'); }
    else if (terminal === 'cancelled') await f.graphics.action(f.project.id, { kind: 'cancel', taskId: task.id });
    else { const value = f.state(); value.tasks.at(-1)!.status = 'running'; f.save(value); }
    const count = f.calls.length; await f.restart(); assert.equal(f.state().tasks.at(-1)!.status, terminal);
    const before = structuredClone(f.state()); await f.prepare(reviewed?.id ?? 'assembled', phase);
    assert.deepEqual(f.state(), before); assert.equal(f.calls.length, count); assert.equal(f.remoteCalls, 0);
    await assert.rejects(f.run(task.id)); assert.equal(f.calls.length, count);
  });
});

test('synthetic repair registration rejects mismatched source, part and analysis identity without registering any candidate', async t => {
  for (const field of ['sourceVersionId', 'partVersionIds', 'analysisVersionId', 'missingMetadata'] as const) await t.test(field, async child => {
    const f = await fixture(child), reviewed = await analysis(f), task = (await f.prepare(reviewed.id, 'repair')).tasks.at(-1)!, before = structuredClone(f.state());
    f.mutate(result => {
      if (field === 'missingMetadata') delete result.contact;
      else if (field === 'partVersionIds') result.contact!.partVersionIds = ['head', 'body', 'hair'];
      else result.contact![field] = 'wrong-identity';
    });
    assert.equal((await f.run(task.id)).status, 'failed');
    assert.deepEqual(f.state().versions, before.versions); assert.deepEqual(f.state().objects, before.objects);
    assert.deepEqual(f.state().tasks.at(-1)!.outputVersionIds, []); assert.equal(f.calls.length, 2); assert.equal(f.remoteCalls, 0);
  });
});

test('synthetic repaired main atomically adopts its exact parts; corrupt last-part file preserves every accepted slot', async t => {
  await t.test('valid full adoption and restart', async child => {
    const f = await fixture(child), { task, main } = await repair(f), before = structuredClone(f.state());
    assert.match(task.message, /원본 보존 검사.*통과/); assert.match(task.message, /전후 비교.*외형.*확인.*함께 채택/);
    const outputs = before.versions.filter(v => task.outputVersionIds.includes(v.id));
    await assert.rejects(f.accept(outputs.find(v => v.slot === 'part-head')!.id), /함께/);
    assert.deepEqual(f.state(), before); await f.accept(main.id);
    assert.deepEqual(f.state().objects[0].accepted, { ...before.objects[0].accepted, ...Object.fromEntries(outputs.map(v => [`model:${v.slot}`, v.id])) });
    assert.deepEqual(f.state().versions, before.versions); assert.deepEqual(f.state().tasks, before.tasks);
    const adopted = structuredClone(f.state()); await f.restart(); assert.deepEqual(f.state(), adopted); assert.equal(f.calls.length, 2);
    for (const v of f.initial.versions) for (const file of v.files) assert.equal(sha(fs.readFileSync(f.store.file(f.project.id, file.path))), file.sha256);
    assert.equal(f.remoteCalls, 0); assert.equal(f.store.project(f.project.id).jobs.length, 0);
  });
  await t.test('last candidate corruption is atomic', async child => {
    const f = await fixture(child), { task, main } = await repair(f), value = f.state();
    const last = value.versions.find(v => v.id === task.outputVersionIds.at(-1))!;
    f.store.write(f.project.id, last.files.at(-1)!.path, 'corrupt last native file'); const before = structuredClone(f.state());
    await assert.rejects(f.accept(main.id)); assert.deepEqual(f.state(), before); assert.equal(f.calls.length, 2); assert.equal(f.remoteCalls, 0);
  });
  await t.test('repair cannot inherit legacy main-only adoption', async child => {
    const f = await fixture(child), { task, main } = await repair(f), value = f.state();
    value.versions = value.versions.filter(v => v.provenance.jobId !== task.id || v.id === main.id);
    value.tasks.find(v => v.id === task.id)!.outputVersionIds = [main.id]; f.save(value);
    const before = structuredClone(f.state());
    await assert.rejects(f.accept(main.id)); assert.deepEqual(f.state(), before); assert.equal(f.remoteCalls, 0);
  });
  await t.test('repair without its producing task is not a legacy model', async child => {
    const f = await fixture(child), { task, main } = await repair(f), value = f.state();
    value.tasks = value.tasks.filter(v => v.id !== task.id); f.save(value); const before = structuredClone(f.state());
    await assert.rejects(f.accept(main.id)); assert.deepEqual(f.state(), before); assert.equal(f.remoteCalls, 0);
  });
  await t.test('missing metadata and missing repair parts cannot masquerade as a legacy main', async child => {
    const f = await fixture(child), { task, main } = await repair(f), value = f.state();
    value.versions = value.versions.filter(v => v.provenance.jobId !== task.id || v.id === main.id);
    delete value.versions.find(v => v.id === main.id)!.contact;
    value.tasks.find(v => v.id === task.id)!.outputVersionIds = [main.id]; f.save(value); const before = structuredClone(f.state());
    await assert.rejects(f.accept(main.id)); assert.deepEqual(f.state(), before); assert.equal(f.remoteCalls, 0);
  });
});

test('saved contact procedure compatibility recovery preserves blocked history and atomically adopts one locally recovered candidate', async t => {
  const f = await fixture(t); f.behavior('blocked'); const reviewed = await analysis(f);
  const task = (await f.prepare(reviewed.id, 'reconstruct')).tasks.at(-1)!;
  assert.equal((await f.run(task.id)).status, 'review');
  const blocked = f.state().versions.find(version => version.provenance.jobId === task.id)!;
  f.store.write(f.project.id, `graphics/jobs/${task.id}/contact/work/author.log`, 'AttributeError: bpy_struct: attribute "loop_total" from "MeshPolygon" is read-only');
  f.store.write(f.project.id, `graphics/jobs/${task.id}/contact/work/result.json`, JSON.stringify({ status: 'needs_input', summary: 'Saved procedure stopped before model was saved', warnings: [] }));
  const before = structuredClone(f.state()), frozen = structuredClone(before.tasks.at(-1)!);
  f.behavior('ready'); await f.graphics.action(f.project.id, { kind: 'recover-contact-procedure', taskId: task.id }); await idle(f.graphics, f.project.id);
  const recovered = f.state(), savedTask = recovered.tasks.find(value => value.id === task.id)!;
  assert.equal(savedTask.status, 'review'); assert.equal(savedTask.contactProcedureRecoveryRequested, true); assert.equal(savedTask.derivativeRefreshRequested, undefined);
  assert.equal(savedTask.outputVersionIds.length, 5); assert.ok(savedTask.outputVersionIds.includes(blocked.id));
  assert.deepEqual(recovered.versions.find(version => version.id === blocked.id), blocked); assert.deepEqual(recovered.objects, before.objects);
  for (const field of ['settings', 'inputVersionIds', 'requestHash', 'instruction', 'objectSnapshot', 'cost', 'backendJobIds'] as const) assert.deepEqual(savedTask[field], frozen[field]);
  assert.equal(f.calls.at(-1)!.recoveryOnly, true); assert.equal(f.calls.at(-1)!.task.contactProcedureRecoveryRequested, true);
  assert.equal(f.calls.at(-1)!.refreshDerivatives, true); assert.equal(f.remoteCalls, 0);
  assert.match(savedTask.message, /보호 영역 검사/); assert.doesNotMatch(savedTask.message, /안전하게 진행할 수 없어 중단/);
  const main = recovered.versions.find(version => version.provenance.jobId === task.id && version.slot === 'main')!;
  const parts = recovered.versions.filter(version => version.provenance.jobId === task.id && version.slot.startsWith('part-'));
  await assert.rejects(f.accept(parts[0].id), /함께/); await f.accept(main.id);
  assert.deepEqual(f.state().objects[0].accepted, { ...before.objects[0].accepted, ...Object.fromEntries([main, ...parts].map(version => [`model:${version.slot}`, version.id])) });
  const adopted = structuredClone(f.state()); await f.restart(); assert.deepEqual(f.state(), adopted);
  const calls = f.calls.length; await assert.rejects(f.graphics.action(f.project.id, { kind: 'recover-contact-procedure', taskId: task.id }));
  assert.equal(f.calls.length, calls); assert.deepEqual(f.state(), adopted);
});

test('local procedure recovery rejects unrelated errors, changed evidence and preexisting model before state mutation', async t => {
  for (const issue of ['unrelated-error', 'wrong-response', 'model-already-saved', 'changed-input', 'changed-blocked-report', 'not-reconstruct', 'incomplete-original', 'already-requested'] as const) await t.test(issue, async child => {
    const f = await fixture(child); f.behavior('blocked'); const reviewed = await analysis(f);
    const task = (await f.prepare(reviewed.id, 'reconstruct')).tasks.at(-1)!; await f.run(task.id);
    const work = `graphics/jobs/${task.id}/contact/work`;
    f.store.write(f.project.id, `${work}/author.log`, issue === 'unrelated-error' ? 'Synthetic geometry issue' : 'AttributeError: bpy_struct: attribute "loop_total" from "MeshPolygon" is read-only');
    f.store.write(f.project.id, `${work}/result.json`, JSON.stringify({ status: issue === 'wrong-response' ? 'completed' : 'needs_input', warnings: [] }));
    const value = f.state(), current = value.tasks.at(-1)!;
    if (issue === 'model-already-saved') f.store.write(f.project.id, `${work}/corrected.blend`, 'existing authored candidate');
    if (issue === 'changed-input') f.store.write(f.project.id, 'placed-head.blend', 'changed head');
    if (issue === 'changed-blocked-report') {
      const blocked = value.versions.find(version => version.provenance.jobId === task.id)!;
      f.store.write(f.project.id, blocked.contact!.reportPath, 'changed diagnostic');
    }
    if (issue === 'not-reconstruct') current.settings.contactPhase = 'repair';
    if (issue === 'incomplete-original') current.completedExecutions = [];
    if (issue === 'already-requested') current.contactProcedureRecoveryRequested = true;
    f.save(value); const before = structuredClone(f.state());
    await assert.rejects(f.graphics.action(f.project.id, { kind: 'recover-contact-procedure', taskId: task.id }));
    assert.deepEqual(f.state(), before); assert.equal(f.calls.length, 2); assert.equal(f.remoteCalls, 0);
  });
});

test('failed local procedure recovery persists exact intent and resumes saved-only through generic recovery after restart', async t => {
  const f = await fixture(t); f.behavior('blocked'); const reviewed = await analysis(f);
  const task = (await f.prepare(reviewed.id, 'reconstruct')).tasks.at(-1)!; await f.run(task.id);
  const work = `graphics/jobs/${task.id}/contact/work`;
  f.store.write(f.project.id, `${work}/author.log`, 'AttributeError: bpy_struct: attribute "loop_total" from "MeshPolygon" is read-only');
  f.store.write(f.project.id, `${work}/result.json`, JSON.stringify({ status: 'needs_input', warnings: [] }));
  const before = structuredClone(f.state()); f.behavior('throw');
  await f.graphics.action(f.project.id, { kind: 'recover-contact-procedure', taskId: task.id }); await idle(f.graphics, f.project.id);
  assert.equal(f.state().tasks.at(-1)!.status, 'failed'); assert.equal(f.state().tasks.at(-1)!.contactProcedureRecoveryRequested, true);
  assert.equal(f.state().tasks.at(-1)!.derivativeRefreshRequested, true); assert.deepEqual(f.state().versions, before.versions); assert.deepEqual(f.state().objects, before.objects);
  const failed = structuredClone(f.state()); await f.restart(); assert.deepEqual(f.state(), failed);
  assert.equal(f.calls.length, 3, 'Restart must not invoke the executor');
  f.behavior('ready'); await f.graphics.action(f.project.id, { kind: 'recover', taskId: task.id }); await idle(f.graphics, f.project.id);
  assert.equal(f.state().tasks.at(-1)!.status, 'review'); assert.equal(f.calls.at(-1)!.recoveryOnly, true);
  assert.equal(f.calls.at(-1)!.task.contactProcedureRecoveryRequested, true); assert.equal(f.state().tasks.at(-1)!.outputVersionIds.length, 5);
  assert.deepEqual(f.state().objects, before.objects); assert.equal(f.remoteCalls, 0);
});
