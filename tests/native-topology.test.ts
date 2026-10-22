import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { spawnSync } from 'node:child_process';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { NativeTopologyManager } from '../electron/native-topology';
import type { AssetVersion } from '../shared/graphics';
import { validateNativeTopologyMap } from '../shared/native-topology';
import { gltfMeshIdentities, meshEntries, disposeMeshInspection } from '../src/viewport-inspection';
import { createNativeEdgeViews, syncNativeEdgeView, disposeNativeEdgeView } from '../src/native-topology-view';

const blender = process.env.PARTSMITH_TEST_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const resources = path.resolve('integrations');
function load(file: string): Promise<GLTF> {
  const bytes = fs.readFileSync(file);
  return new Promise((resolve, reject) => new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '', resolve, reject));
}

test('native polygon edges survive cube quads, mixed faces, UV/material seams, skin+morph animation, cache restart and hash guards', { skip: !fs.existsSync(blender), timeout: 180000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-native-topology-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.blend'), originalPreview = path.join(root, 'source.glb');
  const script = path.join(root, 'fixture.py');
  fs.writeFileSync(script, `import bpy\nfrom mathutils import Vector\nbpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2, location=(-4,0,0))
cube=bpy.context.object; cube.name='Cube.Native'; cube['partsmith_id']='cube'
# Mixed separate triangle and quad: seven real edges, never quad-paired guesses.
data=bpy.data.meshes.new('mixed'); data.from_pydata([(0,0,0),(1,0,0),(1,1,0),(0,1,0),(2,0,0),(3,0,0),(2,1,0)],[],[(0,1,2,3),(4,5,6)])
mixed=bpy.data.objects.new('Mixed',data); bpy.context.collection.objects.link(mixed); mixed['partsmith_id']='mixed'
# UV seams and two materials force duplicate render vertices and primitives.
bpy.ops.mesh.primitive_cube_add(size=1, location=(4,0,0)); seam=bpy.context.object; seam.name='Seams'; seam['partsmith_id']='seams'
for name in ['a','b']: seam.data.materials.append(bpy.data.materials.new(name))
for face in seam.data.polygons: face.material_index=face.index%2
# Same actual mesh carries a morph, a skin and animated armature.
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,3)); skin=bpy.context.object; skin.name='SkinMorph'; skin['partsmith_id']='skin'
skin.shape_key_add(name='Basis'); morph=skin.shape_key_add(name='Top')
for p in morph.data:
 if p.co.z>0: p.co.x+=0.3
morph.value=0.3
arm_data=bpy.data.armatures.new('Arm'); arm=bpy.data.objects.new('Arm',arm_data); bpy.context.collection.objects.link(arm)
bpy.context.view_layer.objects.active=arm; arm.select_set(True); bpy.ops.object.mode_set(mode='EDIT'); bone=arm_data.edit_bones.new('Root'); bone.head=(0,0,0); bone.tail=(0,0,1); bpy.ops.object.mode_set(mode='OBJECT')
group=skin.vertex_groups.new(name='Root'); group.add(list(range(len(skin.data.vertices))),1,'REPLACE')
modifier=skin.modifiers.new('Armature','ARMATURE'); modifier.object=arm
arm.pose.bones['Root'].rotation_mode='XYZ'
for frame,angle in [(1,0),(16,0.4),(31,0)]:
 arm.pose.bones['Root'].rotation_euler.z=angle; arm.pose.bones['Root'].keyframe_insert('rotation_euler',frame=frame)
bpy.context.scene.frame_start=1; bpy.context.scene.frame_end=31; bpy.context.scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(source)},compress=False)
bpy.ops.export_scene.gltf(filepath=${JSON.stringify(originalPreview)},export_format='GLB',export_animations=True,export_extras=True)
`);
  const made = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const sourceHash = hash(source), previewHash = hash(originalPreview);
  const version: AssetVersion = { id: 'version', objectId: 'object', role: 'animation', slot: 'Idle', label: 'fixture', createdAt: '', sourceVersionIds: [], provenance: { type: 'import' }, warnings: [], preview: 'source.glb',
    files: [source, originalPreview].map(file => ({ path: path.basename(file), sha256: hash(file), bytes: fs.statSync(file).size, kind: file === originalPreview ? 'preview' : 'blend' })) };
  const options = { projectRoot: () => root, version: (_id: string, versionId: string) => versionId === 'version' ? version : undefined, blenderPath: () => blender, resources: () => resources };
  const manager = new NativeTopologyManager(options);
  const [result, concurrent] = await Promise.all([manager.inspect('project', 'version'), manager.inspect('project', 'version')]);
  assert.equal(result.status, 'ready', JSON.stringify(result)); assert.deepEqual(result, concurrent);
  if (result.status !== 'ready') return;
  validateNativeTopologyMap(result.map);
  assert.equal(hash(source), sourceHash); assert.equal(hash(originalPreview), previewHash);
  const cube = result.map.meshes.find(mesh => mesh.sourceId === 'cube')!;
  assert.deepEqual(cube.counts, { vertices: 8, edges: 12, polygons: 6, triangles: 0, quads: 6, ngons: 0 });
  assert.equal(cube.primitives[0].edges.length, 24, 'cube original edges have no face diagonals');
  const mixed = result.map.meshes.find(mesh => mesh.sourceId === 'mixed')!;
  assert.equal(mixed.counts.edges, 7); assert.equal(mixed.counts.triangles, 1); assert.equal(mixed.counts.quads, 1);
  const seams = result.map.meshes.find(mesh => mesh.sourceId === 'seams')!;
  assert.equal(seams.primitives.length, 2); assert.equal(seams.primitives.reduce((n, primitive) => n + primitive.faces.length, 0), 6);
  assert.ok(seams.primitives.some(primitive => primitive.sourceVertices.length > new Set(primitive.sourceVertices).size));
  const derivative = path.join(root, result.preview.path);
  assert.equal(manager.isAllowed('project', derivative), true); assert.equal(manager.isAllowed('project', source), false);
  version.files.push({ path: 'other.fbx', sha256: '0'.repeat(64), bytes: 0, kind: 'model' });
  assert.equal(manager.isAllowed('project', derivative), false, 'a cached overlay cannot authorize a newly ambiguous imported source');
  const ambiguous = await manager.inspect('project', 'version');
  assert.equal(ambiguous.status, 'unavailable');
  if (ambiguous.status === 'unavailable') assert.match(ambiguous.reason, /여러 3D 원본/);
  version.files.pop();
  const longRoot = path.join(root, 'long-project-path-'.repeat(11), 'nested-project'); fs.mkdirSync(longRoot, { recursive: true });
  fs.copyFileSync(source, path.join(longRoot, 'source.blend')); fs.copyFileSync(originalPreview, path.join(longRoot, 'source.glb'));
  assert.ok(path.join(longRoot, 'source.blend').length > 260, 'fixture must exceed Windows MAX_PATH');
  const longManager = new NativeTopologyManager({ ...options, projectRoot: () => longRoot });
  const longResult = await longManager.inspect('long', 'version');
  assert.equal(longResult.status, 'ready', JSON.stringify(longResult));
  if (longResult.status === 'ready') {
    assert.deepEqual(longResult.map.meshes, result.map.meshes);
    assert.ok(path.join(longRoot, longResult.preview.path).length > 400);
    assert.equal(longManager.isAllowed('long', path.join(longRoot, longResult.preview.path)), true);
  }
  assert.equal(hash(path.join(longRoot, 'source.blend')), sourceHash);
  const gltf = await load(derivative), scene = new THREE.Scene(); scene.add(gltf.scene);
  const entries = meshEntries(gltf.scene, 'fixture', gltfMeshIdentities(gltf.scene, gltf.parser));
  const views = createNativeEdgeViews(entries, gltf.parser, result.map); views.forEach(view => scene.add(view.lines));
  const skinView = views.find(view => view.native.sourceId === 'skin')!;
  assert.ok(skinView.entry.mesh instanceof THREE.SkinnedMesh); assert.ok(skinView.entry.mesh.morphTargetInfluences!.length > 0);
  assert.ok(gltf.animations.length > 0);
  const material = skinView.entry.mesh.material, geometry = skinView.entry.mesh.geometry;
  const mixer = new THREE.AnimationMixer(gltf.scene); mixer.clipAction(gltf.animations[0]).play();
  for (const time of [0, 0.15, 0.45, 0.8]) {
    mixer.setTime(time); skinView.entry.mesh.morphTargetInfluences![0] = time;
    gltf.scene.scale.set(2, 1.5, 1); gltf.scene.rotation.y = time; gltf.scene.position.set(2, -1, 3);
    scene.updateMatrixWorld(true);
    views.forEach(view => syncNativeEdgeView(view, true));
    const points = skinView.lines.geometry.getAttribute('position');
    skinView.primitive.edges.forEach((vertex, index) => {
      const expected = skinView.entry.mesh.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(skinView.entry.mesh.matrixWorld);
      assert.ok(expected.distanceTo(new THREE.Vector3().fromBufferAttribute(points, index)) < 2e-6);
    });
  }
  skinView.entry.mesh.visible = false; syncNativeEdgeView(skinView, true); assert.equal(skinView.lines.visible, false);
  const corrupted = structuredClone(result.map); corrupted.meshes[0].primitives[0].sourceVertices[0] = 7;
  assert.throws(() => createNativeEdgeViews(entries, gltf.parser, corrupted), /정점 속성/);
  views.forEach(disposeNativeEdgeView); entries.forEach(disposeMeshInspection);
  assert.equal(skinView.entry.mesh.material, material); assert.equal(skinView.entry.mesh.geometry, geometry);
  const restarted = new NativeTopologyManager(options);
  assert.equal(restarted.isAllowed('project', derivative), false);
  assert.deepEqual(await restarted.inspect('project', 'version'), result); assert.equal(restarted.isAllowed('project', derivative), true);
  fs.appendFileSync(derivative, Buffer.from([1]));
  assert.equal(restarted.isAllowed('project', derivative), false);
  assert.equal((await restarted.inspect('project', 'version')).status, 'unavailable', 'bad cache must never trigger source regeneration');
  fs.appendFileSync(source, Buffer.from([2]));
  const changed = await manager.inspect('project', 'version'); assert.equal(changed.status, 'unavailable');
  if (changed.status === 'unavailable') assert.match(changed.reason, /해시/);
  assert.equal(hash(originalPreview), previewHash);
});

test('FBX embedded media is imported only from staged registered bytes; production folder and maps stay unchanged', { skip: !fs.existsSync(blender), timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-topology-fbx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const production = path.join(root, 'production'); fs.mkdirSync(production);
  const texture = path.join(production, 'color.png'), fbx = path.join(production, 'source.fbx'), glb = path.join(production, 'source.glb');
  const png = new PNG({ width: 4, height: 4 }); png.data.fill(255); fs.writeFileSync(texture, PNG.sync.write(png));
  const script = path.join(root, 'create.py');
  fs.writeFileSync(script, `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()
obj=bpy.context.object; obj['partsmith_id']='fbx-cube'
material=bpy.data.materials.new('Native'); material.use_nodes=True; obj.data.materials.append(material)
image=bpy.data.images.load(${JSON.stringify(texture)}); image.pack()
node=material.node_tree.nodes.new('ShaderNodeTexImage'); node.image=image
material.node_tree.links.new(node.outputs['Color'],material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
bpy.ops.export_scene.fbx(filepath=${JSON.stringify(fbx)},use_selection=True,path_mode='COPY',embed_textures=True,add_leaf_bones=False)
bpy.ops.export_scene.gltf(filepath=${JSON.stringify(glb)},export_format='GLB',use_selection=True)
`);
  const built = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const names = fs.readdirSync(production), hashes = names.map(name => hash(path.join(production, name)));
  const version: AssetVersion = { id: 'fbx', objectId: 'o', role: 'model', slot: 'main', label: 'FBX', createdAt: '', sourceVersionIds: [], provenance: { type: 'import' }, warnings: [], preview: 'production/source.glb',
    files: [fbx, glb, texture].map(file => ({ path: path.relative(root, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size, sha256: hash(file), kind: file === glb ? 'preview' : 'source' })) };
  const manager = new NativeTopologyManager({ projectRoot: () => root, version: () => version, blenderPath: () => blender, resources: () => resources });
  const result = await manager.inspect('project', 'fbx');
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.deepEqual(fs.readdirSync(production), names); assert.deepEqual(names.map(name => hash(path.join(production, name))), hashes);
  if (result.status !== 'ready') return;
  assert.equal(result.map.meshes[0].counts.quads, 6); assert.equal(result.map.dependencies[0].sha256, hash(texture));
  const request = JSON.parse(fs.readFileSync(path.join(path.dirname(path.join(root, result.preview.path)), 'request.json'), 'utf8'));
  assert.ok(request.sourcePath.includes(`${path.sep}input${path.sep}`)); assert.notEqual(request.sourcePath, fbx);
  assert.equal(request.identity.source.sha256, hash(fbx)); assert.equal(fs.existsSync(request.sourcePath), false, 'private staging is cleaned after registration');
  fs.appendFileSync(texture, Buffer.from([3]));
  assert.equal(manager.isAllowed('project', path.join(root, result.preview.path)), false);
  assert.equal((await manager.inspect('project', 'fbx')).status, 'unavailable');
});
