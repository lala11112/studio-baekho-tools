import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareTripoPartSource, preflightTripoPartSource, createTripoPartSourceTools } from '../engine/tripo-part-source';
import { restoreTripoPartPreservation } from '../engine/tripo-part-preservation';

const blender = process.env.PARTSMITH_TEST_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-tps-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frozen = (name: string) => ({ path: name, sha256: hash(path.join(root, name)), bytes: fs.statSync(path.join(root, name)).size });
  const args = () => ({ projectRoot: root, source: frozen('raw.fbx'), objectId: 'independent-head-object', sourceVersionId: 'raw-generated-head', slot: 'part-head', blenderPath: blender, resources: path.resolve('integrations'), signal: new AbortController().signal });
  return { root, frozen, args };
}
function nativeFixture(root: string) {
  const code = `import bpy,pathlib
root=pathlib.Path(${JSON.stringify(root)})
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2,location=(.05,.02,.3))
obj=bpy.context.object;obj.name='GeneratedHead';obj.scale=(.1,.15,.2)
mat=bpy.data.materials.new('ProviderMaterial');mat.use_nodes=True;obj.data.materials.append(mat)
image=bpy.data.images.new('ProviderColor',width=16,height=16);image.generated_color=(.2,.4,.8,1)
image.filepath_raw=str(root/'color.png');image.file_format='PNG';image.save();bpy.data.images.remove(image)
image=bpy.data.images.load(str(root/'color.png'));node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=image
mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
def export(name,embed=True):
 bpy.ops.export_scene.fbx(filepath=str(root/name),use_selection=False,object_types={'MESH','ARMATURE'},use_triangles=False,use_custom_props=True,add_leaf_bones=False,bake_anim=False,path_mode='COPY' if embed else 'ABSOLUTE',embed_textures=embed)
export('raw.fbx');export('external.fbx',False)
obj['partsmith_id']='tampered';obj['partsmith_part_id']='head';obj['partsmith_object_id']='independent-head-object';obj['partsmith_source_sha256']='0'*64;export('binding.fbx')
for key in ('partsmith_id','partsmith_part_id','partsmith_object_id','partsmith_source_sha256'):del obj[key]
obj.shape_key_add(name='Basis');key=obj.shape_key_add(name='Morph');key.data[0].co.x+=.03;export('morph.fbx');obj.shape_key_clear()
bpy.ops.object.armature_add();rig=bpy.context.object;export('rig.fbx');bpy.data.objects.remove(rig,do_unlink=True)
bpy.ops.mesh.primitive_cube_add(size=.2);other=bpy.context.object;export('multi.fbx');bpy.data.objects.remove(other,do_unlink=True)
for vertex in obj.data.vertices:vertex.co.z=0
export('planar.fbx')
`;
  const script = path.join(root, 'fixture.py'); fs.writeFileSync(script, code);
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script], { windowsHide: true, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, result.stdout.slice(-5000) + result.stderr.slice(-5000));
}

test('native generated part preparation preserves original content, adds hash-bound IDs and passes cached preflight and restoration', { skip: !fs.existsSync(blender), timeout: 120_000 }, async t => {
  const f = fixture(t); nativeFixture(f.root); const args = f.args();
  const prepared = await prepareTripoPartSource(args);
  assert.deepEqual(prepared.files.map(file => path.basename(file.path)), ['asset.blend', 'asset.fbx', 'asset.glb', 'report.json']);
  assert.deepEqual(prepared.files.map(file => file.kind), ['blend', 'model', 'model', 'report']);
  assert(Object.values(prepared.report.checks).every(value => value === true));
  assert.equal(prepared.report.faces, 6); assert.deepEqual(prepared.report.polygonSizes, { '4': 6 });
  assert.equal(prepared.report.triangles, 12); assert.equal(prepared.report.nativeSourceSha256, prepared.files[1].sha256);
  assert.equal(prepared.report.sourcePositionsSha256, prepared.report.preparedPositionsSha256);
  assert.equal(prepared.report.sourceUvSha256, prepared.report.preparedUvSha256);
  assert.equal(prepared.report.textures.length, 1); assert(prepared.report.glbImages.length > 0);
  const expected = 'partsmith-' + createHash('sha256').update(JSON.stringify({ objectId: args.objectId, slot: args.slot, sourceSha256: args.source.sha256 })).digest('hex').slice(0, 32);
  assert.equal(prepared.report.stableMeshId, expected);
  assert.equal((await prepareTripoPartSource(args)).cached, true);
  const source = prepared.files[1], preparedArgs = { ...args, source, sourceVersionId: 'prepared-head' };
  const preflight = await preflightTripoPartSource(preparedArgs);
  assert.equal(preflight.files.length, 1); assert.equal(preflight.report.stableMeshId, expected);
  assert.equal(preflight.report.sourceSha256, source.sha256);
  assert.equal((await preflightTripoPartSource(preparedArgs)).cached, true);
  const restored = await restoreTripoPartPreservation({ ...preparedArgs, provider: args.source, providerJobId: 'future-uv-fixture' });
  assert(Object.values(restored.report.checks).every(value => value === true));
  assert.equal(restored.report.sourceStableId, expected);
  assert.equal(hash(path.join(f.root, 'raw.fbx')), args.source.sha256);
  await assert.rejects(preflightTripoPartSource({ ...preparedArgs, slot: 'part-body' }), /exact part ID/);
  await assert.rejects(preflightTripoPartSource({ ...preparedArgs, objectId: 'other-object' }), /different object/);
  await assert.rejects(prepareTripoPartSource(preparedArgs), /conflicting stable identity/);
  fs.appendFileSync(path.join(f.root, source.path), 'corruption');
  await assert.rejects(preflightTripoPartSource(preparedArgs), /해시/);
});

test('native preflight rejects raw missing IDs and preparation rejects unsupported structure and external textures before services', { skip: !fs.existsSync(blender), timeout: 120_000 }, async t => {
  const f = fixture(t); nativeFixture(f.root);
  await assert.rejects(preflightTripoPartSource(f.args()), /existing stable mesh ID/);
  await assert.rejects(preflightTripoPartSource({ ...f.args(), source: f.frozen('binding.fbx') }), /source hash binding/);
  for (const [name, pattern] of [['multi.fbx', /exactly one static mesh/], ['rig.fbx', /exactly one static mesh/], ['morph.fbx', /morphs/], ['planar.fbx', /nondegenerate three-dimensional/], ['external.fbx', /External or missing FBX texture/]] as const) {
    await assert.rejects(prepareTripoPartSource({ ...f.args(), source: f.frozen(name) }), pattern);
  }
});

test('part source input identity and immutable file failures stop before native execution', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'raw.fbx'), 'raw'); let calls = 0;
  const local = createTripoPartSourceTools({ runBlender: async () => { calls++; throw Error('Unexpected native call'); } });
  await assert.rejects(local.prepare({ ...f.args(), objectId: '' }), /오브젝트/);
  await assert.rejects(local.preflight({ ...f.args(), slot: 'main' }), /파트 슬롯/);
  await assert.rejects(local.prepare({ ...f.args(), source: { ...f.args().source, sha256: '0'.repeat(64) } }), /해시/);
  await assert.rejects(local.preflight({ ...f.args(), source: { ...f.args().source, path: '../outside.fbx' } }), /폴더 밖/);
  assert.equal(calls, 0);
});
