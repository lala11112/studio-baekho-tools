/** Copy three existing placed parts into an isolated profile. Never select production results. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { defaultCreation } from '../shared/graphics-creation';
import type { AssetVersion, GraphicsWorkspace } from '../shared/graphics';

const out = path.resolve('artifacts/runtime/qa-20261018-parts-keep-app');
const manifest = path.join(out, 'fixture.json');
assert(!fs.existsSync(manifest), 'Existing fixture must be reused, not recreated');
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const prior = read('artifacts/runtime/graphics-independent-head-live.json');
const sourceRoot = path.join(process.env.APPDATA!, 'partsmith', 'projects', prior.projectId);
const sourceWorkspace = path.join(sourceRoot, 'graphics/workspace.json');
const workspaceSha = sha(sourceWorkspace), old = read(sourceWorkspace) as GraphicsWorkspace;
const ids = ['cd3dcf12-5648-485a-99b9-5a9e5bc8d44f', '52db8516-7418-4702-8770-76ed24404b7a', '9eb67693-1173-479a-a72e-7d6828b93af6'];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-parts-keep-'));
const profile = path.join(root, 'profile'), store = new Store(profile);
await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
try {
  const project = new Engine(store, {} as any).create('TEST 기존 인간형 파트 · 로컬 조립');
  const protectedFiles: { path: string; sha256: string }[] = [];
  const versions: AssetVersion[] = ids.map(id => {
    const original = old.versions.find(v => v.id === id); assert(original);
    // Import one authoritative editable original, not generated FBX/GLB siblings
    // relabelled as ambiguous independent imports.
    const source = { ...original, files: original.files.filter(f => /\.blend$/i.test(f.path)) };
    assert.equal(source.files.length, 1);
    for (const file of source.files) {
      const absolute = path.join(sourceRoot, file.path); assert.equal(sha(absolute), file.sha256);
      store.write(project.id, file.path, fs.readFileSync(absolute));
      assert.equal(sha(store.file(project.id, file.path)), file.sha256);
      protectedFiles.push({ path: absolute, sha256: file.sha256 });
    }
    return { ...structuredClone(source), objectId: 'parts-copy', label: `TEST ${source.slot}`, sourceVersionIds: [], provenance: { type: 'import' } };
  });
  const creation = defaultCreation('character');
  creation.subject = 'human'; creation.attributes.composition = 'parts';
  creation.attributes.compositionStrategy = 'independent-parts';
  creation.parts = ['head', 'body', 'hair'].map((id, i) => ({ id, label: ['머리', '몸통', '머리카락'][i], enabled: true, instruction: '', faceLimit: 5000, count: 1 }));
  creation.activePartId = 'head';
  creation.stageSettings.assembly = { instruction: '세 파트의 기존 위치·크기·형상·UV·재질을 유지해 로컬 조립합니다. 새로운 생성이나 배치 보정 없이 검사용 사본을 만듭니다.', values: { count: 1, assemblyMode: 'assemble', assemblyPlacement: 'keep' } };
  const accepted = Object.fromEntries(versions.map(v => [`model:${v.slot}`, v.id]));
  const workspace: GraphicsWorkspace = { schemaVersion: 1, id: project.id, projectId: project.id, revision: 1, objects: [{ id: 'parts-copy', name: 'TEST 머리·몸통·머리카락', kind: 'character', createdAt: new Date().toISOString(), selectedTasks: [], instruction: '', settings: {}, references: [], accepted, creation }], versions, tasks: [], deliveries: [] };
  store.put('graphics', project.id, workspace);
  store.write(project.id, 'graphics/workspace.json', JSON.stringify(workspace, null, 2));
  assert.equal(sha(sourceWorkspace), workspaceSha);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ root, profile, projectId: project.id, objectId: 'parts-copy', versions, initial: workspace, sourceWorkspace, workspaceSha, protectedFiles, fixtureOnly: true, productionAdoption: false, paid: 0, GPT: 0, createdAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ root, projectId: project.id, sourceParts: versions.map(v => v.id) }));
} finally { store.db.close(); }
