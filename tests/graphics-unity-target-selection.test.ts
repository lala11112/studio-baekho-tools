import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { GraphicsEngine } from '../engine/graphics';
import { readUnityTarget } from '../engine/graphics-unity';
import type { Tripo } from '../engine/tripo';
import type { GraphicsTask, UnityDelivery } from '../shared/graphics';

async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-unity-target-'));
  const store = new Store(root); await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  const engine = new Engine(store, new Proxy({}, { get: () => () => { throw Error('Network forbidden'); } }) as Tripo);
  const project = engine.create('Target selection regression');
  const graphics = new GraphicsEngine(store, engine, { resources: path.resolve('integrations') });
  const workspace = await graphics.action(project.id, { kind: 'create-object', name: 'Static object', objectKind: 'prop' });
  const unity = (name: string) => {
    const target = path.join(root, name); fs.mkdirSync(path.join(target, 'Assets'), { recursive: true });
    fs.mkdirSync(path.join(target, 'ProjectSettings')); fs.mkdirSync(path.join(target, 'Packages'));
    fs.writeFileSync(path.join(target, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.3.21f1\n');
    fs.writeFileSync(path.join(target, 'ProjectSettings/GraphicsSettings.asset'), 'GraphicsSettings:\n  m_CustomRenderPipeline: {fileID: 0}\n');
    fs.writeFileSync(path.join(target, 'Packages/manifest.json'), '{"dependencies":{}}');
    return target;
  };
  const oldTarget = unity('old'), nextTarget = unity('new');
  const p = store.project(project.id); p.unityPath = oldTarget; store.save(p);
  await graphics.action(project.id, { kind: 'inspect-target' });
  t.after(() => { graphics.shutdown(); store.db.close(); });
  return { root, store, engine, graphics, project, workspace, oldTarget, nextTarget };
}
const task = (objectId: string, targetProfile: ReturnType<typeof readUnityTarget>, status: GraphicsTask['status']): GraphicsTask => ({ id: 'frozen-task', objectId, taskId: 'X05', createdAt: '2026-10-18', updatedAt: '2026-10-18', status, inputVersionIds: [], settings: {}, instruction: 'Frozen delivery', requestHash: 'frozen-request', outputVersionIds: [], backendJobIds: [], targetProfile, localOnly: true, message: 'Historical result' });
const delivery = (objectId: string, target: ReturnType<typeof readUnityTarget>, status: UnityDelivery['status']): UnityDelivery => ({ id: 'saved-delivery', objectId, versionIds: [], profileFingerprint: target.fingerprint, converterVersion: 'existing', createdAt: '2026-10-18', destination: 'Assets/PartsmithGraphics/object', status, files: [], guid: 'a'.repeat(32), warnings: [], errors: [], playbackVerified: false });

test('explicit Unity target selection persists project and profile while historical frozen requests and GUIDs remain exact', async t => {
  const f = await fixture(t), w = f.graphics.get(f.project.id), objectId = w.objects[0].id;
  w.tasks.push(task(objectId, w.target!, 'review')); w.deliveries.push(delivery(objectId, w.target!, 'imported'));
  f.store.put('graphics', f.project.id, w);
  const previousTasks = structuredClone(w.tasks), previousDeliveries = structuredClone(w.deliveries);
  const targetBytes = fs.readFileSync(path.join(f.nextTarget, 'ProjectSettings/GraphicsSettings.asset'));
  const result = await f.graphics.action(f.project.id, { kind: 'set-unity-target', projectPath: ` ${f.nextTarget} ` });
  assert.equal(result.target!.projectPath, fs.realpathSync(f.nextTarget));
  assert.equal(f.store.project(f.project.id).unityPath, fs.realpathSync(f.nextTarget));
  assert.deepEqual(result.tasks, previousTasks); assert.deepEqual(result.deliveries, previousDeliveries);
  const inspected = await f.graphics.action(f.project.id, { kind: 'inspect-target' });
  assert.equal(inspected.target!.fingerprint, result.target!.fingerprint);
  assert.deepEqual(fs.readFileSync(path.join(f.nextTarget, 'ProjectSettings/GraphicsSettings.asset')), targetBytes);
  assert.deepEqual(f.store.project(f.project.id).jobs, []);
  assert.deepEqual(result.objects, w.objects); assert.deepEqual(result.versions, []);
});

test('invalid Unity target paths leave project bytes and workspace selection untouched', async t => {
  const f = await fixture(t), beforeProject = f.store.project(f.project.id), beforeWorkspace = f.graphics.get(f.project.id);
  const bytes = fs.readFileSync(f.store.file(f.project.id, 'project.json'));
  for (const projectPath of ['', ' ', f.root, path.join(f.root, 'missing')]) {
    await assert.rejects(f.graphics.action(f.project.id, { kind: 'set-unity-target', projectPath }));
    assert.deepEqual(f.store.project(f.project.id), beforeProject);
    assert.deepEqual(f.graphics.get(f.project.id), beforeWorkspace);
    assert.deepEqual(fs.readFileSync(f.store.file(f.project.id, 'project.json')), bytes);
  }
});

for (const status of ['running', 'awaiting_approval', 'submission_unknown'] as const) {
  test(`Unity target selection is blocked by ${status} tasks`, async t => {
    const f = await fixture(t), w = f.graphics.get(f.project.id);
    w.tasks.push(task(w.objects[0].id, w.target!, status)); f.store.put('graphics', f.project.id, w);
    const p = f.store.project(f.project.id), before = structuredClone(w);
    await assert.rejects(f.graphics.action(f.project.id, { kind: 'set-unity-target', projectPath: f.nextTarget }), /먼저 완료하거나 취소/);
    assert.deepEqual(f.store.project(f.project.id), p); assert.deepEqual(f.graphics.get(f.project.id), before);
  });
}

test('queued Unity delivery blocks target changes even without a running task', async t => {
  const f = await fixture(t), w = f.graphics.get(f.project.id);
  w.deliveries.push(delivery(w.objects[0].id, w.target!, 'queued')); f.store.put('graphics', f.project.id, w);
  const p = f.store.project(f.project.id), before = structuredClone(w);
  await assert.rejects(f.graphics.action(f.project.id, { kind: 'set-unity-target', projectPath: f.nextTarget }), /먼저 완료하거나 취소/);
  assert.deepEqual(f.store.project(f.project.id), p); assert.deepEqual(f.graphics.get(f.project.id), before);
});
