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
      ...(phase === 'repair' ? { analysisVersionId: String(args.task.settings.contactAnalysisVersionId) } : {}),
      reportPath: files[0].path, regionsPath: files[1].path, allowedVertexCount: behavior === 'blocked' ? 0 : 12,
      views: [{ id: 'view-a', label: 'Verified view A', beforePath: files[2].path,
        ...(phase === 'analyze' ? { overlayPath: files[3].path } : { afterPath: files[3].path }) }], warnings: ['Synthetic fixture; external appearance review required'] };
    const result: GraphicsNativeResult = { contact, files, role: 'model', slot: 'contact-review', label: 'Contact review', warnings: contact.warnings };
    if (phase === 'repair' && behavior !== 'blocked') {
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
    prepare: (versionId = 'assembled', phase: 'analyze' | 'repair' = 'analyze') => graphics.action(project.id, { kind: 'prepare-contact', versionId, phase }),
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

test('synthetic contact phases stay capped through failure, cancellation and restart', async t => {
  for (const phase of ['analyze', 'repair'] as const) for (const terminal of ['failed', 'cancelled', 'submission_unknown'] as const) await t.test(`${phase}/${terminal}`, async child => {
    const f = await fixture(child), reviewed = phase === 'repair' ? await analysis(f) : undefined;
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
