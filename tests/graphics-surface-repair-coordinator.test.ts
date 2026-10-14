import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { GraphicsEngine } from '../engine/graphics';
import { surfaceRepairSources, type AssetVersion, type GraphicsWorkspace, type GraphicsTask } from '../shared/graphics';
import type { Tripo } from '../engine/tripo';
import type { repairGraphicsSurface } from '../engine/graphics-surface-repair';

test('saved texture patch recovers locally after restart, remains unadopted and never repeats a paid job', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-coordinator-'));
  const store = new Store(root); await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  let remoteCalls = 0, localCalls = 0, fail = true, pending: (() => void) | undefined;
  const remote = new Proxy({}, { get: () => () => { remoteCalls++; throw Error('No remote operation'); } }) as Tripo;
  const engine = new Engine(store, remote), project = engine.create('Existing chest');
  const file = (rel: string, content = rel) => { const data = Buffer.from(content); store.write(project.id, rel, data); return { path: rel, kind: 'model', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }; };
  const version = (id: string, inputs: string[]): AssetVersion => ({ id, objectId: 'chest', role: 'model', slot: 'main', label: id,
    files: [file(id + '.fbx')], createdAt: '', sourceVersionIds: inputs, provenance: { type: id === 'texture' ? 'tripo' : 'local' }, warnings: [] });
  const original = version('original', []), repair = version('repair', ['original']), texture = version('texture', ['repair', 'image']);
  const task = (id: string, taskId: string, inputs: string[], outputs: string[]): GraphicsTask => ({ id, taskId, objectId: 'chest', createdAt: '', updatedAt: '', status: 'review', inputVersionIds: inputs,
    outputVersionIds: outputs, settings: {}, instruction: '', requestHash: id, backendJobIds: [], localOnly: false, message: '' });
  const textureTask = task('texture-task', 'T03', ['repair', 'image'], ['texture']);
  textureTask.quoteId = 'already-paid'; textureTask.backendJobIds = ['paid-job'];
  textureTask.cost = { provider: 'Tripo API', credits: 20, basis: 'saved' };
  textureTask.paidApproval = { requestHash: textureTask.requestHash, provider: 'Tripo API', credits: 20, approvedAt: 'before' };
  const initial: GraphicsWorkspace = { schemaVersion: 1, id: project.id, projectId: project.id, revision: 0,
    objects: [{ id: 'chest', name: 'Chest', kind: 'prop', createdAt: '', selectedTasks: [], settings: {}, instruction: '', references: [], accepted: { 'model:main': 'repair' } }],
    versions: [original, repair, texture], tasks: [task('repair-task', 'M09', ['original'], ['repair']), textureTask], deliveries: [] };
  store.put('graphics', project.id, initial);
  const local: typeof repairGraphicsSurface = async args => {
    localCalls++; assert.equal(args.mode, 'reuse-planar-material'); assert.equal(args.sourceVersionId, 'texture');
    assert.equal(args.repairVersionId, 'repair'); assert.equal(args.originalVersionId, 'original');
    if (pending) await new Promise<void>(resolve => { pending = resolve; });
    args.signal.throwIfAborted(); if (fail) throw Error('Local export interrupted');
    const report = { passed: true, sourceVersionId: args.sourceVersionId, sourceSha256: args.source.sha256,
        repairVersionId: args.repairVersionId, repairSourceSha256: args.repairSource.sha256,
        originalVersionId: args.originalVersionId, originalSourceSha256: args.originalSource.sha256,
        localOnly: true, modelTurns: 0, paidSubmissions: 0, warnings: ['공유 무늬의 경계·늘어짐을 확인하세요.'], uniqueUvLayout: false, visualQualityVerified: false,
        checks: Object.fromEntries(['staticOnly', 'appendOnlyAncestry', 'uniformCorrespondence', 'geometryPreserved', 'originalUVPreserved', 'onlyAddedDegenerateUVChanged', 'materialsAndImagesPreserved', 'allFacesHaveUV', 'fbxRoundTrip'].map(key => [key, true])) };
    return { cached: false, files: [...['asset.blend', 'asset.fbx', 'asset.glb'].map(name => file('recovery/' + name)), file('recovery/report.json', JSON.stringify(report))], report };
  };
  const options = { resources: path.resolve('integrations'), repairSurface: local };
  let graphics = new GraphicsEngine(store, engine, options);
  const settle = async () => { for (let i = 0; i < 100; i++) { if (!graphics.isActive(project.id)) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Did not settle'); };
  t.after(async () => { graphics.shutdown(); pending?.(); await settle(); store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(surfaceRepairSources(initial, texture), { repair, original });
  assert.equal(surfaceRepairSources(initial, { ...texture, slot: 'part-head' }), undefined);
  assert.equal(surfaceRepairSources({ ...initial, tasks: [textureTask] }, texture), undefined);
  assert.equal(surfaceRepairSources(initial, { ...texture, sourceVersionIds: ['different'] }), undefined);
  await graphics.action(project.id, { kind: 'repair-surface-uv', versionId: texture.id }); await settle();
  let state = graphics.get(project.id);
  assert.equal(state.tasks[1].status, 'failed'); assert.deepEqual(state.versions, initial.versions);
  state.tasks[1].status = 'running'; store.put('graphics', project.id, state);
  graphics = new GraphicsEngine(store, engine, options);
  assert.equal(graphics.get(project.id).tasks[1].status, 'failed'); assert.equal(remoteCalls, 0);
  fail = false; pending = () => {};
  await graphics.action(project.id, { kind: 'recover', taskId: textureTask.id });
  graphics.sync(); assert.equal(graphics.get(project.id).tasks[1].status, 'running', 'API sync must ignore a local recovery');
  await assert.rejects(graphics.action(project.id, { kind: 'repair-surface-uv', versionId: texture.id }), /완료|실행/);
  await graphics.action(project.id, { kind: 'cancel', taskId: textureTask.id }); pending!(); pending = undefined; await settle();
  assert.equal(remoteCalls, 0, 'Cancel must not cancel the already completed remote job');
  assert.deepEqual(graphics.get(project.id).versions, initial.versions);
  await graphics.action(project.id, { kind: 'repair-surface-uv', versionId: texture.id }); await settle();
  state = graphics.get(project.id); const derived = state.versions.at(-1)!;
  assert.equal(state.versions.length, 4); assert.deepEqual(state.versions.slice(0, 3), initial.versions);
  assert.deepEqual(state.objects, initial.objects); assert.equal(derived.surfaceRepair?.providerVersionId, texture.id);
  assert.equal(derived.provenance.type, 'local'); assert.equal(surfaceRepairSources(state, derived), undefined);
  assert.equal(state.tasks[1].status, 'review'); assert.deepEqual(state.tasks[1].paidApproval, textureTask.paidApproval);
  assert.deepEqual(state.tasks[1].cost, textureTask.cost); assert.equal(state.tasks[1].requestHash, textureTask.requestHash);
  assert.equal(state.tasks[1].quoteId, textureTask.quoteId); assert.deepEqual(state.tasks[1].backendJobIds, textureTask.backendJobIds);
  assert.deepEqual(state.tasks[1].outputVersionIds, ['texture', derived.id]);
  const calls = localCalls; await graphics.action(project.id, { kind: 'repair-surface-uv', versionId: texture.id });
  assert.equal(localCalls, calls); assert.equal(remoteCalls, 0); assert.equal(store.project(project.id).jobs.length, 0);
  graphics = new GraphicsEngine(store, engine, options); assert.deepEqual(graphics.get(project.id), state);
});
