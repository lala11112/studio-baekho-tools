import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { GraphicsEngine } from '../engine/graphics';
import { requiresPartSpaceRestoration, type GraphicsWorkspace, type AssetVersion } from '../shared/graphics';
import type { restoreTripoPartPreservation } from '../engine/tripo-part-preservation';
import type { Tripo } from '../engine/tripo';

test('part restoration is a local, repeat-safe derivative; interrupted and failed repair never polls a paid job', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'part-space-coordinator-'));
  const store = new Store(root); await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  let remoteCalls = 0, localCalls = 0, fail = true;
  const remote = new Proxy({}, { get: () => () => { remoteCalls++; throw Error('External request forbidden'); } }) as Tripo;
  const engine = new Engine(store, remote), project = engine.create('Local part restoration');
  const makeFile = (relative: string) => {
    store.write(project.id, relative, Buffer.from(relative)); const value = fs.readFileSync(store.file(project.id, relative));
    return { path: relative, kind: relative.endsWith('json') ? 'report' : 'model', sha256: createHash('sha256').update(value).digest('hex'), bytes: value.length };
  };
  const source: AssetVersion = { id: 'source', objectId: 'human', role: 'model', slot: 'part-head', label: 'Head', files: [makeFile('source.fbx')], createdAt: '', sourceVersionIds: [], provenance: { type: 'local' }, warnings: [] };
  const raw: AssetVersion = { ...source, id: 'provider', label: 'Head UV', files: [makeFile('provider.fbx')], sourceVersionIds: ['source'], provenance: { type: 'tripo', jobId: 'paid-job', remoteId: 'paid-remote' } };
  // Viewport-only GLBs must not replace either side of the exact FBX restoration.
  source.files.push({ ...makeFile('source-viewport.glb'), kind: 'preview' });
  raw.files.push({ ...makeFile('provider-viewport.glb'), kind: 'preview' });
  const initial: GraphicsWorkspace = { schemaVersion: 1, id: project.id, projectId: project.id, revision: 0,
    objects: [{ id: 'human', name: 'Human', kind: 'character', createdAt: '', selectedTasks: [], settings: { partId: 'head' }, instruction: '', references: [], accepted: { 'model:part-head': 'source' } }],
    versions: [source, raw], tasks: [{ id: 'uv', objectId: 'human', taskId: 'T01', status: 'review', settings: { partId: 'head' }, instruction: '', createdAt: '', updatedAt: '', inputVersionIds: ['source'], outputVersionIds: ['provider'], backendJobIds: ['paid-job'], quoteId: 'old-quote', requestHash: 'unchanged', localOnly: false, message: '' }], deliveries: [] };
  store.put('graphics', project.id, initial);
  const restore: typeof restoreTripoPartPreservation = async args => {
    localCalls++; assert.equal(args.sourceVersionId, 'source'); assert.equal(args.source.sha256, source.files[0].sha256); assert.equal(args.provider.sha256, raw.files[0].sha256);
    if (fail) throw Error('Fixture correspondence mismatch');
    return { files: ['asset.blend', 'asset.fbx', 'asset.glb', 'report.json'].map(file => makeFile('restored/' + file)), cached: false, report: {} } as Awaited<ReturnType<typeof restoreTripoPartPreservation>>;
  };
  const options = { resources: path.resolve('integrations'), restorePartSpace: restore };
  let graphics = new GraphicsEngine(store, engine, options);
  const settle = async () => { for (let i = 0; i < 100; i++) { if (!graphics.isActive(project.id)) return; await new Promise(r => setTimeout(r, 5)); } throw Error('Local fixture did not finish'); };
  t.after(async () => { graphics.shutdown(); await settle(); store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert(requiresPartSpaceRestoration(initial, raw));
  await assert.rejects(graphics.action(project.id, { kind: 'accept', objectId: 'human', versionId: raw.id }), /크기·위치/);
  await graphics.action(project.id, { kind: 'restore-part-space', versionId: raw.id }); await settle();
  assert.equal(graphics.get(project.id).tasks[0].status, 'failed');
  assert.deepEqual(graphics.get(project.id).versions, initial.versions);
  assert.deepEqual(graphics.get(project.id).objects[0].accepted, initial.objects[0].accepted);
  // Simulate an interrupted local continuation, preserving the remote submission.
  const interrupted = graphics.get(project.id); interrupted.tasks[0].status = 'running'; store.put('graphics', project.id, interrupted);
  graphics = new GraphicsEngine(store, engine, options);
  assert.equal(graphics.get(project.id).tasks[0].status, 'failed'); fail = false;
  await graphics.action(project.id, { kind: 'recover', taskId: 'uv' }); await settle();
  const after = graphics.get(project.id), derived = after.versions.at(-1)!;
  assert.equal(after.versions.length, 3); assert.deepEqual(after.versions.slice(0, 2), initial.versions);
  assert.equal(derived.partSpace?.providerVersionId, raw.id); assert(!requiresPartSpaceRestoration(after, derived));
  assert.deepEqual(after.objects[0].accepted, initial.objects[0].accepted);
  assert.equal(after.tasks[0].status, 'review'); assert.equal(after.tasks[0].requestHash, 'unchanged');
  assert.equal(after.tasks[0].quoteId, 'old-quote'); assert.deepEqual(after.tasks[0].backendJobIds, ['paid-job']);
  await graphics.action(project.id, { kind: 'restore-part-space', versionId: raw.id });
  assert.equal(graphics.get(project.id).versions.length, 3); assert.equal(localCalls, 2); assert.equal(remoteCalls, 0);
  await graphics.action(project.id, { kind: 'accept', objectId: 'human', versionId: derived.id });
  assert.equal(graphics.get(project.id).objects[0].accepted['model:part-head'], derived.id);
});
