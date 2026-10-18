import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { GraphicsEngine } from '../engine/graphics';
import { LocalPipeline } from '../engine/local';
import type { Tripo } from '../engine/tripo';

const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-import-preview-'));
  const store = new Store(root); await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  const engine = new Engine(store, new Proxy({}, { get: () => () => { throw Error('Network forbidden'); } }) as Tripo);
  const project = engine.create('Isolated import preview');
  const graphics = new GraphicsEngine(store, engine, { resources: path.resolve('integrations') });
  const workspace = await graphics.action(project.id, { kind: 'create-object', name: 'Imported cube', objectKind: 'prop' });
  const objectId = workspace.objects[0].id;
  t.after(() => { graphics.shutdown(); store.db.close(); });
  const source = path.join(root, 'original.fbx'); fs.writeFileSync(source, 'original FBX test bytes');
  const imported = graphics.importFiles(project.id, objectId, 'model', [source]);
  const version = imported.versions[0];
  const output = () => {
    const relative = 'previews/import-test/model.glb';
    const data = Buffer.alloc(12); data.write('glTF'); data.writeUInt32LE(2, 4); data.writeUInt32LE(12, 8);
    store.write(project.id, relative, data);
    store.write(project.id, relative.replace('.glb', '.report.json'), JSON.stringify({ schemaVersion: 1, mode: 'convert', previewOnly: true, nativeSourceSha256: version.files[0].sha256, faces: 6, triangles: 12 }));
    return relative;
  };
  return { root, store, graphics, project, objectId, source, version, output };
}

test('import preview registers only a verified derivative and retries failed conversion explicitly', async t => {
  const f = await fixture(t), originals = structuredClone(f.version.files), originalSha = hash(f.source);
  await f.graphics.prepareImportedPreviews(f.project.id, [f.version.id], async () => { throw Error('Blender unavailable'); });
  let current = f.graphics.get(f.project.id).versions[0];
  assert.deepEqual(current.files, originals); assert.match(current.warnings[0], /로컬 미리보기 준비 실패/);
  await assert.rejects(f.graphics.prepareImportedPreviews(f.project.id, [f.version.id], async () => { throw Error('Explicit retry failed'); }, true), /Explicit retry failed/);
  assert.deepEqual(f.graphics.get(f.project.id).versions[0].files, originals);
  await f.graphics.prepareImportedPreviews(f.project.id, [f.version.id], async () => f.output());
  current = f.graphics.get(f.project.id).versions[0];
  assert.deepEqual(current.files.slice(0, originals.length), originals);
  assert.equal(current.files.length, 3); assert.equal(current.files[1].kind, 'preview');
  assert.equal(current.preview, current.files[1].path); assert.deepEqual(current.warnings, []);
  assert.equal(hash(f.source), originalSha); assert.deepEqual(f.graphics.get(f.project.id).objects[0].accepted, {});
  assert.equal(f.store.project(f.project.id).jobs.length, 0);
  let calls = 0; await f.graphics.prepareImportedPreviews(f.project.id, [f.version.id], async () => { calls++; return f.output(); });
  assert.equal(calls, 0);
});

test('mismatched report and shutdown cannot register a preview', async t => {
  const f = await fixture(t);
  await assert.rejects(f.graphics.prepareImportedPreviews(f.project.id, [f.version.id], async () => {
    const relative = f.output();
    f.store.write(f.project.id, relative.replace('.glb', '.report.json'), JSON.stringify({ schemaVersion: 1, mode: 'convert', previewOnly: true, nativeSourceSha256: 'wrong', faces: 6, triangles: 12 }));
    return relative;
  }, true), /원본 검사 기록/);
  assert.equal(f.graphics.get(f.project.id).versions[0].files.length, 1);
  await assert.rejects(f.graphics.prepareImportedPreviews(f.project.id, [f.version.id], async () => {
    const relative = f.output(); f.graphics.shutdown(); return relative;
  }, true), /등록이 중단/);
  assert.equal(f.graphics.get(f.project.id).versions[0].files.length, 1);
});

test('source mutation during preview cannot register output and concurrent requests are blocked', async t => {
  const f = await fixture(t); let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const pending = f.graphics.prepareImportedPreviews(f.project.id, [f.version.id], async () => { await ready; const rel = f.output(); fs.writeFileSync(f.store.file(f.project.id, f.version.files[0].path), 'changed'); return rel; });
  assert.equal(f.graphics.isActive(f.project.id), true);
  await assert.rejects(f.graphics.prepareImportedPreviews(f.project.id, [f.version.id], async () => f.output()), /현재 작업/);
  release(); await pending;
  const current = f.graphics.get(f.project.id).versions[0];
  assert.equal(current.files.length, 1); assert.equal(current.preview, undefined);
  assert.match(current.warnings[0], /로컬 미리보기 준비 실패/);
  assert.equal(f.graphics.isActive(f.project.id), false);
});

test('real FBX, BLEND, OBJ and STL imports get local GLB previews and native counts without altering original files', { timeout: 180000 }, async t => {
  const blender = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
  if (!fs.existsSync(blender)) return t.skip('Blender unavailable');
  const f = await fixture(t);
  const script = path.join(f.root, 'fixture.py');
  fs.writeFileSync(script, `import bpy,sys,os\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()\nobj=bpy.context.object\nobj.name='PreservedCube'\nobj['original_marker']='keep'\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(path.join(f.root, 'cube.blend'))})\nbpy.ops.export_scene.fbx(filepath=${JSON.stringify(path.join(f.root, 'cube.fbx'))},use_selection=True,add_leaf_bones=False)\nbpy.ops.wm.obj_export(filepath=${JSON.stringify(path.join(f.root, 'cube.obj'))},export_selected_objects=True)\nbpy.ops.wm.stl_export(filepath=${JSON.stringify(path.join(f.root, 'cube.stl'))},export_selected_objects=True)\n`);
  const made = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python', script], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  f.store.settings.blenderPath = blender;
  const local = new LocalPipeline(f.store, path.resolve('integrations'));
  for (const extension of ['fbx', 'blend', 'obj', 'stl']) {
    const source = path.join(f.root, `cube.${extension}`), sha = hash(source);
    const imported = f.graphics.importFiles(f.project.id, f.objectId, 'model', [source]);
    const version = imported.versions.at(-1)!, originals = structuredClone(version.files);
    const result = await f.graphics.prepareImportedPreviews(f.project.id, [version.id], (id, rel) => local.previewModel(id, rel));
    const current = result.versions.find(v => v.id === version.id)!;
    assert.deepEqual(current.warnings, [], `${extension}: ${current.warnings.join(' ')}`);
    assert.deepEqual(current.files.slice(0, originals.length), originals);
    const preview = current.files.find(file => file.kind === 'preview')!;
    assert.ok(preview); assert.ok(preview.bytes > 100);
    assert.equal(hash(f.store.file(f.project.id, preview.path)), preview.sha256);
    const report = JSON.parse(fs.readFileSync(f.store.file(f.project.id, current.files.find(file => file.kind === 'report')!.path), 'utf8'));
    assert.equal(report.nativeSourceSha256, sha); assert.equal(report.faces, extension === 'stl' ? 12 : 6); assert.equal(report.triangles, 12);
    assert.equal(hash(source), sha); assert.equal(hash(f.store.file(f.project.id, originals[0].path)), sha);
    assert.deepEqual(result.objects[0].accepted, {}); assert.equal(result.tasks.length, 0);
  }
});
