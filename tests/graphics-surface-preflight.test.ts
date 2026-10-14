import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createGraphicsSurfaceInspector, inspectGraphicsSurface, type GraphicsSurfaceArgs } from '../engine/graphics-surface-preflight';

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const blender = process.env.PARTSMITH_TEST_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-surface-test-'));
  t.after(() => { assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  const args = (file: string): GraphicsSurfaceArgs => ({ projectRoot: root, sourceVersionId: path.basename(file),
    source: { path: path.relative(root, file).replaceAll('\\', '/'), sha256: sha(file), bytes: fs.statSync(file).size },
    blenderPath: process.execPath, resources: path.resolve('integrations'), signal: new AbortController().signal });
  return { root, args };
}
function fakeReport(q: any, ready: boolean) {
  return { schemaVersion: 1, identity: q.identity, sourceSha256: q.sourceSha256, sourceVersionId: q.sourceVersionId, validatorFingerprint: q.validatorFingerprint,
    passed: ready, ready, uvMissing: false, uvMissingFaces: 0, invalidUvFaces: ready ? 0 : 1, faces: 6, triangles: 12,
    materialIndexIssues: 0, ambiguousUvMeshes: 0, invalidGeometryFaces: 0, meshes: [],
    reasons: ready ? [] : ['UV 면적이 없습니다.'], reason: ready ? '' : 'UV 면적이 없습니다.', localOnly: true, modelTurns: 0, paidSubmissions: 0 };
}

test('coverage cache binds the exact source and validator; failed coverage is cached without rerunning Blender', async t => {
  const f = fixture(t), source = path.join(f.root, 'source.fbx'); fs.writeFileSync(source, 'frozen native');
  let calls = 0;
  const inspect = createGraphicsSurfaceInspector({ runBlender: async (_binary, command) => {
    calls++; assert(command.includes('--disable-autoexec')); assert(command.includes('--factory-startup'));
    const q = JSON.parse(fs.readFileSync(command.at(-1)!, 'utf8'));
    assert.equal(sha(q.source), sha(source)); assert.notEqual(q.source, source);
    fs.writeFileSync(q.report, JSON.stringify(fakeReport(q, false)));
  } });
  const args = f.args(source), initial = await inspect(args);
  assert.equal(initial.report.ready, false); assert.equal(initial.report.invalidUvFaces, 1); assert.equal(initial.cached, false);
  const cached = await inspect(args); assert.equal(cached.cached, true); assert.deepEqual(cached.report, initial.report); assert.equal(calls, 1);
  assert.equal(sha(source), args.source.sha256);
  fs.appendFileSync(source, 'changed'); await assert.rejects(inspect(args), /해시/); assert.equal(calls, 1);
});

test('coverage rejects forged success, cache tampering, outside paths and cancellation before publication', async t => {
  for (const mode of ['forged', 'tamper', 'outside', 'cancel'] as const) await t.test(mode, async child => {
    const f = fixture(child), source = path.join(f.root, 'source.glb'); fs.writeFileSync(source, 'source');
    const controller = new AbortController(), args = { ...f.args(source), signal: controller.signal }; let calls = 0;
    const inspect = createGraphicsSurfaceInspector({ runBlender: async (_binary, command) => {
      calls++; const q = JSON.parse(fs.readFileSync(command.at(-1)!, 'utf8')), report = fakeReport(q, true);
      if (mode === 'forged') report.invalidUvFaces = 1;
      if (mode === 'cancel') controller.abort();
      fs.writeFileSync(q.report, JSON.stringify(report));
    } });
    if (mode === 'forged') await assert.rejects(inspect(args), /증거/);
    if (mode === 'cancel') await assert.rejects(inspect(args), /abort/i);
    if (mode === 'outside') { args.source.path = '../outside.glb'; await assert.rejects(inspect(args), /밖/); assert.equal(calls, 0); }
    if (mode === 'tamper') { const result = await inspect(args); fs.appendFileSync(path.join(f.root, result.files[0].path), 'x'); await assert.rejects(inspect(args), /해시/); assert.equal(calls, 1); }
  });
});

test('actual Blender catches repaired zero UV faces, missing UV and ambiguous layers on exact native uploads', { skip: !fs.existsSync(blender), timeout: 180000 }, async t => {
  const f = fixture(t), script = path.join(f.root, 'fixtures.py');
  fs.writeFileSync(script, `import bpy,pathlib,sys
root=pathlib.Path(sys.argv[sys.argv.index('--')+1])
def mesh(kind):
 bpy.ops.wm.read_factory_settings(use_empty=True)
 m=bpy.data.meshes.new('Chest');m.from_pydata([(0,0,0),(1,0,0),(1,1,0),(0,1,0),(2,0,0),(2,1,0)],[],[(0,1,2,3),(1,4,5,2)])
 o=bpy.data.objects.new('Chest',m);bpy.context.collection.objects.link(o);o.select_set(True);bpy.context.view_layer.objects.active=o
 if kind!='missing':
  uv=m.uv_layers.new(name='UVMap')
  for p in m.polygons:
   for j,i in enumerate(p.loop_indices):uv.data[i].uv=[(0,0),(1,0),(1,1),(0,1)][j]
  if kind=='collapsed':
   for i in m.polygons[1].loop_indices:uv.data[i].uv=(0,0)
  if kind in ('ambiguous','equivalent'):
   extra=m.uv_layers.new(name='Other UV');m.uv_layers.active=extra;extra.active_render=True
   for i,v in enumerate(extra.data):v.uv=uv.data[i].uv if kind=='equivalent' else uv.data[i].uv*.5
   uv.active_render=True
 if kind=='empty-material':
  mat=bpy.data.materials.new('Deleted');m.materials.append(mat);bpy.data.materials.remove(mat)
 return o
for kind in ('valid','collapsed','missing','ambiguous','equivalent','empty-material'):
 mesh(kind);bpy.ops.wm.save_as_mainfile(filepath=str(root/(kind+'.blend')))
 if kind in ('valid','collapsed','missing'):
  bpy.ops.export_scene.fbx(filepath=str(root/(kind+'.fbx')),use_selection=True,object_types={'MESH'},bake_anim=False,path_mode='COPY',embed_textures=True)
  bpy.ops.export_scene.gltf(filepath=str(root/(kind+'.glb')),export_format='GLB',use_selection=True)
mesh('valid');bpy.ops.wm.stl_export(filepath=str(root/'missing.stl'),export_selected_objects=True)
`, 'utf8');
  const make = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script, '--', f.root], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(make.status, 0, make.stdout + make.stderr);
  for (const name of ['valid.fbx', 'valid.glb', 'collapsed.fbx', 'collapsed.glb', 'missing.fbx', 'missing.glb', 'ambiguous.blend', 'equivalent.blend', 'empty-material.blend', 'missing.stl']) {
    const file = path.join(f.root, name), args = { ...f.args(file), blenderPath: blender };
    const result = await inspectGraphicsSurface(args), r = result.report;
    assert.equal(sha(file), args.source.sha256, name + ' source changed');
    assert.equal(r.faces >= 2, true); assert.equal(r.sourceVersionId, name); assert.equal(r.sourceSha256, args.source.sha256);
    if (name.startsWith('valid') || name.startsWith('equivalent')) assert.equal(r.ready, true, name + ': ' + r.reason);
    if (name.startsWith('collapsed')) { assert.equal(r.ready, false); assert.equal(r.invalidUvFaces > 0, true); assert.equal(r.uvMissing, false); }
    if (name.startsWith('missing')) { assert.equal(r.ready, false); assert.equal(r.uvMissing, true); }
    if (name.startsWith('ambiguous')) { assert.equal(r.ready, false); assert.equal(r.ambiguousUvMeshes, 1); }
    if (name.startsWith('empty-material')) { assert.equal(r.ready, false); assert.equal(r.materialIndexIssues, 2); }
    const again = await inspectGraphicsSurface(args); assert.equal(again.cached, true); assert.deepEqual(again.report, r);
  }
  // OBJ UVs are accepted without external MTL lookups; STL has no UVs.
  const obj = path.join(f.root, 'valid.obj'); fs.writeFileSync(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n');
  assert.equal((await inspectGraphicsSurface({ ...f.args(obj), blenderPath: blender })).report.ready, true);
});
