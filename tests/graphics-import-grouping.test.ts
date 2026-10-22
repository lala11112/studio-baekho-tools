import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { GraphicsEngine } from '../engine/graphics';
import { importedModelSourceProblem } from '../shared/graphics';
import { graphicsInputSupportProblem } from '../shared/graphics-input-support';
import { deriveJourney, getJourneyReadiness } from '../shared/graphics-journey';
import { defaultCreation } from '../shared/graphics-creation';

async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-import-grouping-'));
  const store = new Store(root); await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  let calls = 0;
  const forbidden = () => { calls++; throw Error('External/native activity forbidden'); };
  const engine = new Engine(store, new Proxy({}, { get: () => forbidden }) as any);
  const project = engine.create('Independent model imports');
  const graphics = new GraphicsEngine(store, engine, { resources: path.resolve('integrations'), native: forbidden, procedural: forbidden, planar: forbidden } as any);
  const w = await graphics.action(project.id, { kind: 'create-object', name: 'Object', objectKind: 'prop' });
  t.after(async () => { await graphics.shutdown(); store.db.close(); });
  const file = (name: string, bytes = name) => { const p = path.join(root, 'picked', name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; };
  return { root, store, project, graphics, objectId: w.objects[0].id, file, calls: () => calls };
}

test('independent 3D originals become distinct unadopted candidates with exact registered sidecars', async t => {
  const f = await fixture(t), sources = [f.file('open.fbx'), f.file('closed.glb')], image = f.file('pattern.JPG', 'exact image bytes');
  const w = f.graphics.importFiles(f.project.id, f.objectId, 'model', [...sources, image]);
  assert.equal(w.versions.length, 2); assert.deepEqual(w.objects[0].accepted, {});
  for (const [i, v] of w.versions.entries()) {
    assert.deepEqual(v.files.map(x => path.basename(x.path)), [path.basename(sources[i]), 'pattern.JPG']);
    assert.equal(importedModelSourceProblem(v), undefined);
    for (const entry of v.files) assert.deepEqual(fs.readFileSync(f.store.file(f.project.id, entry.path)), fs.readFileSync(entry.kind === 'image' ? image : sources[i]));
  }
  assert.equal(f.calls(), 0); assert.equal(w.tasks.length, 0);
  const previewSources: string[] = [];
  await f.graphics.prepareImportedPreviews(f.project.id, w.versions.map(v => v.id), async (_id, source) => { previewSources.push(source); throw Error('Capture only'); });
  assert.deepEqual(previewSources, [w.versions[0].files[0].path]);
});

test('all import groups validate before original copies or workspace registration', async t => {
  const f = await fixture(t), a = f.file('a/model.fbx'), b = f.file('b/model.glb'), sidecar = f.file('a/texture.png');
  const snapshot = () => ({ workspace: f.graphics.get(f.project.id), originals: fs.existsSync(f.store.file(f.project.id, 'graphics/originals')) });
  const before = snapshot();
  for (const selection of [[a, b, sidecar], [a, sidecar, f.file('a/TEXTURE.PNG')], [a, f.file('a/caf\u00e9.png'), f.file('a/cafe\u0301.png')], [a, f.file('a/Stra\u00dfe.png'), f.file('a/STRASSE.PNG')], [a, f.file('a/clip.mp4')], [a, f.file('a/unsupported.exe')], [a, a]]) {
    assert.throws(() => f.graphics.importFiles(f.project.id, f.objectId, 'model', selection));
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(f.graphics.importFiles(f.project.id, f.objectId, 'model', [a, b]).versions.length, 2);
  const designs = f.graphics.importFiles(f.project.id, f.objectId, 'design', [sidecar, f.file('b/design.png')]);
  assert.equal(designs.versions.filter(v => v.role === 'design').length, 2);
});

test('historical ambiguous imports preserve history but cannot be adopted, prepared or previewed', async t => {
  const f = await fixture(t);
  let w = f.graphics.importFiles(f.project.id, f.objectId, 'model', [f.file('first.fbx'), f.file('other.glb')]);
  const v = w.versions[0]; v.files.push(...w.versions[1].files); w.versions.splice(1);
  w.objects[0].accepted['model:main'] = v.id; w.objects[0].settings.roughness = 0.5;
  f.store.put('graphics', f.project.id, w);
  const before = structuredClone(f.graphics.get(f.project.id));
  assert.match(importedModelSourceProblem(v)!, /3D 원본 하나/);
  const draft = defaultCreation('prop');
  const journey = deriveJourney(w, f.objectId, draft, { stage: 'model', candidateVersionId: v.id });
  assert.equal(journey.review?.adoptable, false); assert.match(journey.review!.reason, /3D 원본 하나/);
  assert.equal(journey.secondaryActions.some(action => action.label === 'Unity 전달 준비'), false);
  assert.ok(getJourneyReadiness(w, f.objectId, draft, { stage: 'unity', taskOverride: 'X05' }).problems.some(p => /3D 원본 하나/.test(p.reason)));
  for (const taskId of ['T02', 'T03', 'T05', 'A05', 'X04', 'X05']) {
    assert.match(graphicsInputSupportProblem(taskId, [v])!, /3D 원본 하나/);
    await assert.rejects(f.graphics.action(f.project.id, { kind: 'prepare', objectId: f.objectId, taskId }), /3D 원본 하나/);
  }
  await assert.rejects(f.graphics.action(f.project.id, { kind: 'accept', objectId: f.objectId, versionId: v.id }), /3D 원본 하나/);
  await assert.rejects(f.graphics.prepareImportedPreviews(f.project.id, [v.id], async () => { throw Error('Must not preview'); }), /3D 원본 하나/);
  await assert.rejects(f.graphics.action(f.project.id, { kind: 'inspect-planar', versionId: v.id }), /3D 원본 하나/);
  assert.deepEqual(f.graphics.get(f.project.id), before); assert.equal(f.calls(), 0);
  const frozen: any = { id: 'legacy-approval', objectId: f.objectId, taskId: 'T03', status: 'awaiting_approval', inputVersionIds: [v.id], settings: {}, outputVersionIds: [], backendJobIds: [], createdAt: '', updatedAt: '', instruction: '', message: '', requestHash: '' };
  w.tasks.push(frozen); f.store.put('graphics', f.project.id, w);
  await assert.rejects(f.graphics.action(f.project.id, { kind: 'approve', taskId: frozen.id }), /3D 원본 하나/);
  await assert.rejects((f.graphics as any).execute(f.project.id, frozen.id, new AbortController().signal), /3D 원본 하나/);
  assert.equal(f.calls(), 0); assert.equal(f.graphics.get(f.project.id).tasks[0].status, 'awaiting_approval');
  const generated = { ...v, provenance: { type: 'local' as const } };
  assert.equal(importedModelSourceProblem(generated), undefined);
  assert.equal(importedModelSourceProblem({ ...v, files: [v.files[0], { ...v.files[1], kind: 'preview' }] }), undefined);
});
