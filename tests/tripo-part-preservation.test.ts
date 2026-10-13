import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { restoreTripoPartPreservation, createTripoPartPreservationRestorer } from '../engine/tripo-part-preservation';

const blender = process.env.PARTSMITH_TEST_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-tpp-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frozen = (name: string) => ({ path: name, sha256: hash(path.join(root, name)), bytes: fs.statSync(path.join(root, name)).size });
  const args = () => ({ projectRoot: root, source: frozen('source.fbx'), provider: frozen('provider.fbx'), sourceVersionId: 'head-source', providerJobId: 'provider-job', slot: 'part-head', blenderPath: blender, resources: path.resolve('integrations'), signal: new AbortController().signal });
  return { root, frozen, args };
}
function python(root: string, code: string) {
  const script = path.join(root, 'fixture.py'); fs.writeFileSync(script, code);
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script], { windowsHide: true, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, result.stdout.slice(-5000) + result.stderr.slice(-5000));
}
function nativeFixture(root: string) {
  python(root, `import bpy, pathlib
from mathutils import Matrix,Vector
root=pathlib.Path(${JSON.stringify(root)})
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2,location=(.05,.02,.3))
obj=bpy.context.object;obj.name='Head';obj.scale=(.1,.1,.1)
obj['partsmith_id']='native-head';obj['partsmith_part_id']='head'
mat=bpy.data.materials.new('SourceMaterial');mat.use_nodes=True;obj.data.materials.append(mat)
def export(name,triangles=False):
 bpy.ops.export_scene.fbx(filepath=str(root/name),use_selection=False,object_types={'MESH','ARMATURE'},use_triangles=triangles,use_custom_props=True,add_leaf_bones=False,bake_anim=False,path_mode='COPY',embed_textures=True)
export('source.fbx')
bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.import_scene.fbx(filepath=str(root/'source.fbx'),use_image_search=False)
obj=next(o for o in bpy.context.scene.objects if o.type=='MESH')
points=[obj.matrix_world@v.co for v in obj.data.vertices];low=Vector(tuple(min(v[a] for v in points) for a in range(3)));high=Vector(tuple(max(v[a] for v in points) for a in range(3)));center=(low+high)/2
for vertex,point in zip(obj.data.vertices,points):vertex.co=(point-center)*5
obj.matrix_world=Matrix.Identity(4)
del obj['partsmith_id'];del obj['partsmith_part_id']
for index,item in enumerate(obj.data.uv_layers[0].data):item.uv=(.1+(index%4)*.2,.1+(index//4)*.1)
obj.data.materials[0].node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.1,.3,.8,1)
obj.data.materials[0].node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.37
image=bpy.data.images.new('ProviderColor',width=16,height=16);image.generated_color=(.2,.4,.8,1)
image.filepath_raw=str(root/'provider-color.png');image.file_format='PNG';image.save();bpy.data.images.remove(image)
image=bpy.data.images.load(str(root/'provider-color.png'))
nodes=obj.data.materials[0].node_tree.nodes;texture=nodes.new('ShaderNodeTexImage');texture.image=image
obj.data.materials[0].node_tree.links.new(texture.outputs['Color'],nodes.get('Principled BSDF').inputs['Base Color'])
export('provider.fbx');export('topology.fbx',True)
obj.data.vertices[0].co.x+=.07;export('shape.fbx');obj.data.vertices[0].co.x-=.07
obj.shape_key_add(name='Basis');key=obj.shape_key_add(name='UnsupportedMorph');key.data[0].co.x+=.03;export('morph.fbx');obj.shape_key_clear()
bpy.ops.object.armature_add();rig=bpy.context.object;export('rig.fbx');bpy.data.objects.remove(rig,do_unlink=True)
bpy.ops.mesh.primitive_cube_add(size=.2);export('multi.fbx')
`);
}

test('actual SmartUV restoration keeps provider UV/material and original part placement, topology and IDs with verified cache', { skip: !fs.existsSync(blender), timeout: 120_000 }, async t => {
  const f = fixture(t); nativeFixture(f.root);
  const args = f.args(), inputs = [args.source.sha256, args.provider.sha256];
  const result = await restoreTripoPartPreservation(args);
  assert.equal(result.cached, false);
  assert.deepEqual(result.files.map(file => file.kind), ['blend', 'model', 'model', 'report']);
  assert.deepEqual(result.files.map(file => path.basename(file.path)), ['asset.blend', 'asset.fbx', 'asset.glb', 'report.json']);
  assert(Object.values(result.report.checks).every(value => value === true));
  assert.equal(result.report.sourcePositionsSha256, result.report.restoredPositionsSha256);
  assert.equal(result.report.providerUvSha256, result.report.restoredUvSha256);
  assert.equal(result.report.sourceStableId, 'native-head'); assert.equal(result.report.sourcePartId, 'head');
  assert.equal(result.report.faces, 6); assert.deepEqual(result.report.polygonSizes, { '4': 6 });
  assert(result.report.glbImages.length > 0, 'embedded provider texture must survive native and GLB exports');
  assert(Math.abs(result.report.correspondence.uniformScale - 5) < 1e-5);
  assert(result.report.fbxRoundTripMaxWorldDeviation <= result.report.fbxRoundTripTolerance);
  assert.deepEqual([hash(path.join(f.root, 'source.fbx')), hash(path.join(f.root, 'provider.fbx'))], inputs);
  const cached = await restoreTripoPartPreservation(args);
  assert.equal(cached.cached, true); assert.deepEqual(cached.files, result.files);
  fs.appendFileSync(path.join(f.root, result.files[1].path), 'corrupt-test-output');
  await assert.rejects(restoreTripoPartPreservation(args), /해시/);
});

test('actual SmartUV restoration rejects changed topology, nonlinear edits, multiple meshes, rigs and morphs', { skip: !fs.existsSync(blender), timeout: 120_000 }, async t => {
  const f = fixture(t); nativeFixture(f.root);
  for (const [name, pattern] of [['topology.fbx', /indexed topology/], ['shape.fbx', /uniform transform/], ['multi.fbx', /exactly one static mesh/], ['rig.fbx', /exactly one static mesh/], ['morph.fbx', /morphs/]] as const) {
    await assert.rejects(restoreTripoPartPreservation({ ...f.args(), provider: f.frozen(name), providerJobId: name }), pattern);
  }
});

test('SmartUV input identity, slot and hash failures stop before native execution', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'source.fbx'), 'source'); fs.writeFileSync(path.join(f.root, 'provider.fbx'), 'provider');
  let calls = 0;
  const restore = createTripoPartPreservationRestorer({ runBlender: async () => { calls++; throw Error('Unexpected native call'); } });
  await assert.rejects(restore({ ...f.args(), slot: 'main' }), /파트 슬롯/);
  await assert.rejects(restore({ ...f.args(), source: { ...f.args().source, sha256: '0'.repeat(64) } }), /해시/);
  await assert.rejects(restore({ ...f.args(), source: { ...f.args().source, path: '../source.fbx' } }), /폴더 밖/);
  assert.equal(calls, 0);
});
