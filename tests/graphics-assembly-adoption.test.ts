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

async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-adoption-')), store = new Store(root);
  await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  let remoteCalls = 0;
  const engine = new Engine(store, new Proxy({}, { get: () => () => { remoteCalls++; throw Error('External request forbidden'); } }) as Tripo);
  const project = engine.create('Assembly adoption'), graphics = new GraphicsEngine(store, engine, { resources: path.resolve('integrations') });
  const make = (id: string, slot: string, assembled = false): AssetVersion => {
    const relative = `${id}.fbx`, data = Buffer.from(id); store.write(project.id, relative, data);
    return { id, objectId: 'human', role: 'model', slot, label: id, files: [{ path: relative, kind: 'model', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }], createdAt: '', sourceVersionIds: assembled ? ['head', 'body', 'hair'] : [], provenance: { type: 'local', ...(assembled ? { jobId: 'assembly' } : {}) }, warnings: [] };
  };
  const versions = [make('old-main', 'main'), ...['head', 'body', 'hair'].map(part => make(part, `part-${part}`)), make('assembled', 'main', true), ...['head', 'body', 'hair'].map(part => make(`placed-${part}`, `part-${part}`, true))];
  const initial: GraphicsWorkspace = { schemaVersion: 1, id: project.id, projectId: project.id, revision: 0,
    objects: [{ id: 'human', name: 'Human', kind: 'character', createdAt: '', selectedTasks: [], settings: { partId: 'head' }, instruction: '', references: [], accepted: { 'model:main': 'old-main', 'model:part-head': 'head', 'model:part-body': 'body', 'model:part-hair': 'hair', 'design:main': 'design-unchanged' } }], versions,
    tasks: [{ id: 'assembly', objectId: 'human', taskId: 'M08', status: 'review', inputVersionIds: ['head', 'body', 'hair'], outputVersionIds: ['assembled', 'placed-head', 'placed-body', 'placed-hair'], settings: {}, instruction: '', requestHash: 'frozen', backendJobIds: [], createdAt: '', updatedAt: '', localOnly: true, message: '' }], deliveries: [] };
  store.put('graphics', project.id, initial);
  t.after(() => { graphics.shutdown(); store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, project, graphics, initial, get remoteCalls() { return remoteCalls; },
    state: () => graphics.get(project.id), save: (value: GraphicsWorkspace) => store.put('graphics', project.id, value),
    accept: (versionId = 'assembled') => graphics.action(project.id, { kind: 'accept', objectId: 'human', versionId }) };
}

test('assembly adoption atomically selects main and positioned parts, preserves history, and freezes the placed head for UV', async t => {
  const f = await fixture(t), before = structuredClone(f.initial);
  await f.accept();
  assert.deepEqual(f.state().objects[0].accepted, { ...before.objects[0].accepted, 'model:main': 'assembled', 'model:part-head': 'placed-head', 'model:part-body': 'placed-body', 'model:part-hair': 'placed-hair' });
  assert.deepEqual(f.state().versions, before.versions); assert.deepEqual(f.state().tasks, before.tasks);
  for (const version of before.versions) for (const file of version.files) assert.equal(createHash('sha256').update(fs.readFileSync(f.store.file(f.project.id, file.path))).digest('hex'), file.sha256);
  const uv = await f.graphics.action(f.project.id, { kind: 'prepare', objectId: 'human', taskId: 'T01' });
  assert.deepEqual(uv.tasks.at(-1)!.inputVersionIds, ['placed-head']); assert.equal(uv.tasks.at(-1)!.status, 'awaiting_approval');
  assert.equal(f.remoteCalls, 0); assert.equal(f.store.project(f.project.id).jobs.length, 0);
});

test('a part alone and a legacy main-only assembly change only their selected slots', async t => {
  const f = await fixture(t), accepted = structuredClone(f.initial.objects[0].accepted);
  await f.accept('placed-head'); assert.deepEqual(f.state().objects[0].accepted, { ...accepted, 'model:part-head': 'placed-head' });
  const legacy = structuredClone(f.initial); legacy.versions = legacy.versions.filter(version => !version.id.startsWith('placed-')); legacy.tasks[0].outputVersionIds = ['assembled']; f.save(legacy);
  await f.accept(); assert.deepEqual(f.state().objects[0].accepted, { ...accepted, 'model:main': 'assembled' }); assert.equal(f.remoteCalls, 0);
});

test('incomplete, ambiguous, foreign or changed assembly candidates leave every accepted slot untouched', async t => {
  const cases: Record<string, (f: Awaited<ReturnType<typeof fixture>>, value: GraphicsWorkspace) => void> = {
    'missing output': (_f, w) => { w.tasks[0].outputVersionIds.pop(); },
    'missing all part output IDs': (_f, w) => { w.tasks[0].outputVersionIds = ['assembled']; },
    'missing candidate': (_f, w) => { w.versions = w.versions.filter(version => version.id !== 'placed-hair'); },
    'duplicate output ID': (_f, w) => { w.tasks[0].outputVersionIds.push('placed-head'); },
    'duplicate slot': (_f, w) => { w.versions.find(version => version.id === 'placed-hair')!.slot = 'part-head'; },
    'different object': (_f, w) => { w.versions.find(version => version.id === 'placed-hair')!.objectId = 'another'; },
    'different producer': (_f, w) => { w.versions.find(version => version.id === 'placed-hair')!.provenance.jobId = 'other-task'; },
    'different source IDs': (_f, w) => { w.versions.find(version => version.id === 'placed-hair')!.sourceVersionIds = ['head']; },
    'missing file': (_f, w) => { w.versions.find(version => version.id === 'placed-hair')!.files[0].path = 'absent.fbx'; },
    'changed last candidate file': (f, w) => { f.store.write(f.project.id, w.versions.find(version => version.id === 'placed-hair')!.files[0].path, 'changed'); },
  };
  for (const [name, corrupt] of Object.entries(cases)) await t.test(name, async child => {
    const f = await fixture(child), value = structuredClone(f.initial); corrupt(f, value); f.save(value);
    const before = structuredClone(f.state());
    await assert.rejects(f.accept());
    assert.deepEqual(f.state(), before); assert.equal(f.remoteCalls, 0);
  });
});
