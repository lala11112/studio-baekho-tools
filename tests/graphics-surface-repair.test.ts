import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createGraphicsSurfaceRepairer, repairGraphicsSurface } from '../engine/graphics-surface-repair';

const blender = process.env.PARTSMITH_TEST_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function setup(t: any) {
  const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ps-surface-fix-test-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), temp); assert(path.basename(root).startsWith('ps-surface-fix-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const frozen = (name: string) => ({ path: name, sha256: sha(path.join(root, name)), bytes: fs.statSync(path.join(root, name)).size });
  const args = () => ({ projectRoot: root, source: frozen('texture.fbx'), sourceVersionId: 'textured', repairSource: frozen('repair.fbx'), repairVersionId: 'repaired', originalSource: frozen('original.fbx'), originalVersionId: 'original', mode: 'reuse-planar-material' as const, resources: path.resolve('integrations'), blenderPath: blender, signal: new AbortController().signal });
  return { root, frozen, args };
}
function fixture(root: string) {
  const code = `import bpy,pathlib
root=pathlib.Path(${JSON.stringify(root)})
bpy.ops.wm.read_factory_settings(use_empty=True)
verts=[(-1,-1,-1),(-1,-1,1),(-1,1,-1),(-1,1,1),(1,-1,-1),(1,-1,1),(1,1,-1),(1,1,1)]
faces=[(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3),(0,1,3,2)]
mat=bpy.data.materials.new('Metal');mat.use_nodes=True
mesh=bpy.data.meshes.new('ChestMesh');mesh.from_pydata(verts,[],faces[:5]);mesh.update()
obj=bpy.data.objects.new('Chest',mesh);bpy.context.collection.objects.link(obj);bpy.context.view_layer.objects.active=obj;obj.select_set(True);obj.data.materials.append(mat)
def setuv():
 layer=obj.data.uv_layers.new(name='UVMap')
 for p in obj.data.polygons:
  for l,value in zip(p.loop_indices,[(.1,.1),(.4,.1),(.4,.4),(.1,.4)]):layer.data[l].uv=value if p.index<5 else (0,0)
def export(name):
 bpy.ops.export_scene.fbx(filepath=str(root/name),use_selection=True,object_types={'MESH'},use_triangles=False,use_custom_props=True,add_leaf_bones=False,bake_anim=False,path_mode='COPY',embed_textures=True)
setuv();export('original.fbx')
mesh=bpy.data.meshes.new('RepairMesh');mesh.from_pydata(verts,[],faces);mesh.update();obj.data=mesh;obj.data.materials.append(mat);setuv();export('repair.fbx');export('no-images.fbx')
image=bpy.data.images.new('Color',width=16,height=16);image.generated_color=(.2,.3,.4,1);image.filepath_raw=str(root/'color.png');image.file_format='PNG';image.save();bpy.data.images.remove(image)
image=bpy.data.images.load(str(root/'color.png'));image.pack();node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=image;mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
export('texture.fbx')
obj.data.vertices[0].co.x+=.1;export('shape-change.fbx');obj.data.vertices[0].co.x-=.1
old=tuple(obj.data.uv_layers.active.data[0].uv);obj.data.uv_layers.active.data[0].uv=(.9,.9);export('uv-change.fbx');obj.data.uv_layers.active.data[0].uv=old
obj.shape_key_add(name='Basis');obj.shape_key_add(name='Key');export('morph.fbx');obj.shape_key_clear()
obj.data.uv_layers.new(name='Ambiguous');export('ambiguous.fbx')
`;
  const script = path.join(root, 'fixture.py'); fs.writeFileSync(script, code);
  const run = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script], { windowsHide: true, encoding: 'utf8', timeout: 90_000 });
  assert.equal(run.status, 0, run.stdout.slice(-2000) + run.stderr.slice(-2000));
}

test('local native material reuse changes only appended missing UV, keeps images and geometry, and reuses saved result', { skip: !fs.existsSync(blender), timeout: 120_000 }, async t => {
  const f = setup(t); fixture(f.root); const args = f.args();
  const result = await repairGraphicsSurface(args);
  assert.deepEqual(result.files.map(file => path.basename(file.path)), ['asset.blend', 'asset.fbx', 'asset.glb', 'report.json']);
  assert.equal(result.report.passed, true); assert(Object.values(result.report.checks).every(v => v === true));
  assert.deepEqual(result.report.repairedFaces, [5]); assert.equal(result.report.mappings[0].donorFaceIndex, 0);
  assert.equal(result.report.mappings[0].sharedUvIntentional, true); assert(result.report.mappings[0].uvArea > 0);
  assert.equal(result.report.sourceOriginalUVSha256, result.report.resultOriginalUVSha256);
  assert.equal(result.report.uniqueUvLayout, false); assert.equal(result.report.visualQualityVerified, false);
  assert.equal(result.report.modelTurns, 0); assert.equal(result.report.paidSubmissions, 0); assert(result.report.warnings.length);
  assert.equal((await repairGraphicsSurface(args)).cached, true);
  for (const file of [args.source, args.originalSource, args.repairSource]) assert.equal(sha(path.join(f.root, file.path)), file.sha256);
  fs.appendFileSync(path.join(f.root, result.files[1].path), 'tamper');
  await assert.rejects(repairGraphicsSurface(args), /해시/);
});

test('native repair rejects changed geometry, changed UV, morphs, ambiguous maps, absent textures and incompatible donor', { skip: !fs.existsSync(blender), timeout: 120_000 }, async t => {
  const f = setup(t); fixture(f.root);
  for (const [name, message] of [['shape-change.fbx', /not the original under a proper uniform transform/], ['uv-change.fbx', /Textured UVs differ/], ['morph.fbx', /morphs/], ['ambiguous.fbx', /one unambiguous/], ['no-images.fbx', /embedded texture/]] as const) {
    await assert.rejects(repairGraphicsSurface({ ...f.args(), source: f.frozen(name) }), message);
  }
  await assert.rejects(repairGraphicsSurface({ ...f.args(), donorFaceIndex: 5 }), /No compatible/);
  await assert.rejects(repairGraphicsSurface({ ...f.args(), originalSource: f.frozen('repair.fbx') }), /not append-only/);
});

test('invalid identity, traversal, stale hash and cancellation stop before native repair', async t => {
  const f = setup(t); for (const name of ['original.fbx', 'repair.fbx', 'texture.fbx']) fs.writeFileSync(path.join(f.root, name), name);
  let calls = 0; const repair = createGraphicsSurfaceRepairer({ runBlender: async () => { calls++; throw Error('Unexpected native call'); } });
  await assert.rejects(repair({ ...f.args(), mode: 'auto' as any }), /명시적인/);
  await assert.rejects(repair({ ...f.args(), originalVersionId: 'repaired' }), /정확한/);
  await assert.rejects(repair({ ...f.args(), source: { ...f.frozen('texture.fbx'), path: '../texture.fbx' } }), /프로젝트 밖/);
  await assert.rejects(repair({ ...f.args(), source: { ...f.frozen('texture.fbx'), sha256: '0'.repeat(64) } }), /해시/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(repair({ ...f.args(), signal: controller.signal }), /abort/i);
  assert.equal(calls, 0);
});
