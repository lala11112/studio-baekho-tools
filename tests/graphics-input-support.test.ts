import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { graphicsInputSupportProblem } from '../shared/graphics-input-support';
import { getJourneyReadiness } from '../shared/graphics-journey';
import { defaultCreation } from '../shared/graphics-creation';
import type { AssetVersion, GraphicsWorkspace } from '../shared/graphics';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { GraphicsEngine } from '../engine/graphics';
import type { Tripo } from '../engine/tripo';

const version = (extension: string, kind = 'model'): AssetVersion => ({ id: 'v', objectId: 'o', role: 'model', slot: 'main', label: 'Source', createdAt: '', files: [{ path: `original.${extension}`, kind, bytes: 1, sha256: 'a'.repeat(64) }], sourceVersionIds: [], provenance: { type: 'import' }, warnings: [] });
test('native format readiness distinguishes unsupported originals from missing originals and ignores viewport derivatives', () => {
  for (const task of ['T02', 'T05', 'A05', 'X04']) {
    for (const ext of ['obj', 'stl']) assert.match(graphicsInputSupportProblem(task, [version(ext)])!, /지원하지 않습니다.*BLEND\/FBX 원본으로 가져와 채택/);
    for (const ext of ['blend', 'fbx', 'glb']) assert.equal(graphicsInputSupportProblem(task, [version(ext)]), undefined);
    const v = version('stl'); v.files.push(...version('glb', 'preview').files);
    assert.match(graphicsInputSupportProblem(task, [v])!, /STL 원본은/);
    v.files.push(...version('fbx').files); assert.equal(graphicsInputSupportProblem(task, [v]), undefined);
  }
  assert.match(graphicsInputSupportProblem('T02', [version('glb', 'preview')])!, /모델 원본 파일이 없습니다/);
  assert.match(graphicsInputSupportProblem('T02', [])!, /모델 원본이 없습니다/);
  assert.equal(graphicsInputSupportProblem('X05', [version('obj')]), undefined);
  assert.match(graphicsInputSupportProblem('X05', [version('stl')])!, /STL 원본은/);
  assert.equal(graphicsInputSupportProblem('X05', [{ ...version('png'), role: 'design' }], 'sprite'), undefined);
  assert.equal(graphicsInputSupportProblem('X05', [{ ...version('png'), role: 'design' }], 'ui'), undefined);
  const rig = { ...version('blend'), role: 'rig' as const }, clip = { ...version('blend'), id: 'clip', role: 'animation' as const, slot: 'Idle' };
  assert.equal(graphicsInputSupportProblem('X05', [rig, clip]), undefined);
  assert.equal(graphicsInputSupportProblem('T03', [version('stl')]), undefined);
});

test('guided UV and Unity readiness exposes format limitations before preparation', () => {
  const draft = defaultCreation('prop'), v = version('stl');
  const workspace: GraphicsWorkspace = { schemaVersion: 1, id: 'p', projectId: 'p', revision: 0, objects: [{ id: 'o', name: 'Object', kind: 'prop', createdAt: '', selectedTasks: [], settings: {}, instruction: '', references: [], accepted: { 'model:main': 'v' } }], versions: [v], tasks: [], deliveries: [] };
  for (const [taskOverride, stage] of [['T02', 'surface'], ['T05', 'surface'], ['A05', 'unity'], ['X04', 'unity'], ['X05', 'unity']] as const) {
    const readiness = getJourneyReadiness(workspace, 'o', draft, { stage, taskOverride });
    assert.ok(readiness.problems.some(problem => /STL 원본/.test(problem.reason)));
  }
  workspace.versions[0] = version('obj');
  assert.equal(getJourneyReadiness(workspace, 'o', draft, { stage: 'unity', taskOverride: 'X05' }).problems.length, 0);
});

test('unsupported native formats stop before task, quote, worker or provider activity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-input-support-'));
  const store = new Store(root); await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  let providerCalls = 0, workerCalls = 0;
  const engine = new Engine(store, new Proxy({}, { get: () => () => { providerCalls++; throw Error('Provider forbidden'); } }) as Tripo);
  const project = engine.create('Format early blocking');
  const worker: any = async () => { workerCalls++; throw Error('Worker forbidden'); };
  const graphics = new GraphicsEngine(store, engine, { resources: path.resolve('integrations'), native: worker, procedural: worker, prepareUnity: worker });
  t.after(() => { graphics.shutdown(); store.db.close(); });
  const w = await graphics.action(project.id, { kind: 'create-object', name: 'Source', objectKind: 'prop' });
  await graphics.action(project.id, { kind: 'update-object', objectId: w.objects[0].id, patch: { settings: { metallic: 0.5 } } });
  for (const extension of ['stl', 'obj']) {
    const source = path.join(root, `source.${extension}`); fs.writeFileSync(source, `original ${extension}`);
    const imported = graphics.importFiles(project.id, w.objects[0].id, 'model', [source]);
    await graphics.action(project.id, { kind: 'accept', objectId: w.objects[0].id, versionId: imported.versions.at(-1)!.id });
    for (const taskId of ['T02', 'T05', 'A05', 'X04', ...(extension === 'stl' ? ['X05'] : [])]) {
      const before = graphics.get(project.id);
      await assert.rejects(graphics.action(project.id, { kind: 'prepare', objectId: w.objects[0].id, taskId }), /원본은 이 작업에서 지원하지 않습니다/);
      assert.deepEqual(graphics.get(project.id), before);
    }
  }
  const unity = path.join(root, 'Unity');
  fs.mkdirSync(path.join(unity, 'Assets'), { recursive: true }); fs.mkdirSync(path.join(unity, 'ProjectSettings')); fs.mkdirSync(path.join(unity, 'Packages'));
  fs.writeFileSync(path.join(unity, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.3.21f1\n');
  await graphics.action(project.id, { kind: 'set-unity-target', projectPath: unity });
  let prepared = await graphics.action(project.id, { kind: 'prepare', objectId: w.objects[0].id, taskId: 'X05' });
  assert.equal(prepared.tasks.at(-1)!.status, 'awaiting_approval');
  await graphics.action(project.id, { kind: 'cancel', taskId: prepared.tasks.at(-1)!.id });
  const source = path.join(root, 'supported.fbx'); fs.writeFileSync(source, 'native FBX bytes');
  const imported = graphics.importFiles(project.id, w.objects[0].id, 'model', [source]);
  await graphics.action(project.id, { kind: 'accept', objectId: w.objects[0].id, versionId: imported.versions.at(-1)!.id });
  for (const taskId of ['T02', 'T05', 'A05', 'X04']) {
    prepared = await graphics.action(project.id, { kind: 'prepare', objectId: w.objects[0].id, taskId });
    assert.equal(prepared.tasks.at(-1)!.status, 'awaiting_approval');
    await graphics.action(project.id, { kind: 'cancel', taskId: prepared.tasks.at(-1)!.id });
  }
  assert.equal(providerCalls, 0); assert.equal(workerCalls, 0);
  assert.equal(store.project(project.id).jobs.length, 0); assert.equal(graphics.get(project.id).tasks.length, 5);
});
