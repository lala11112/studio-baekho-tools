import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { createGraphicsProceduralExecutor, executeGraphicsProcedural, proceduralProblem } from '../engine/graphics-procedural';
import type { GraphicsNativeArgs } from '../engine/graphics-native';
import { inspectGraphicsSurface } from '../engine/graphics-surface-preflight';

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t: any, taskId = 'M04') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-procedural-test-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  const args: GraphicsNativeArgs = { projectRoot: root, workspacePath: path.join(root, 'workspace.json'), blenderPath: process.execPath, resources: path.resolve('integrations'), signal: new AbortController().signal, onProgress: () => {},
    object: { id: 'rock', name: 'Rock', kind: 'prop', createdAt: 'fixture', selectedTasks: [], instruction: '', settings: {}, references: [], accepted: {} },
    task: { id: 'local-' + taskId, taskId, objectId: 'rock', createdAt: 'fixture', updatedAt: 'fixture', status: 'running', requestHash: 'frozen', settings: { subject: 'rock', 'attr.style': 'lowpoly', count: 1, quad: true, faceLimit: 10000 }, instruction: '컴파일된 기본 설명은 자유 지시가 아닙니다.', inputVersionIds: [], outputVersionIds: [], backendJobIds: [], message: '', localOnly: true, objectSnapshot: { name: 'Rock', kind: 'prop', references: [], accepted: {} } }, inputs: [] };
  const attach = (file: string, role: 'model' | 'material' = 'model') => {
    args.inputs = [{ id: 'accepted', objectId: args.object.id, role, slot: 'main', label: 'Original', files: [{ path: path.relative(root, file).replaceAll('\\', '/'), sha256: sha(file), bytes: fs.statSync(file).size, kind: 'blend' }], createdAt: 'fixture', sourceVersionIds: [], provenance: { type: 'import' }, warnings: [] }];
    args.task.inputVersionIds = ['accepted']; args.task.objectSnapshot!.accepted = { [role + ':main']: 'accepted' };
  };
  return { root, args, attach };
}

test('finite local preflight rejects unsupported text/options, supports explicit UV and material values', () => {
  assert.equal(proceduralProblem({ subject: 'rock', 'attr.style': 'realistic', 'attr.cracks': 'many', 'attr.moss': 'some', 'attr.shape': 'long' }), undefined);
  assert.equal(proceduralProblem({ subject: 'box', 'attr.container': 'metal', 'attr.lid': 'open', 'attr.interior': 'hollow', 'attr.width': 2 }), undefined);
  assert.ok(proceduralProblem({subject:'box',symmetry:false})); assert.ok(proceduralProblem({subject:'rock',symmetry:'true'}));
  assert.equal(proceduralProblem({subject:'rock',symmetry:false}),undefined);
  for (const settings of [{ subject: 'human' }, { subject: 'rock', 'attr.mineral': 'vein' }, { subject: 'box', 'attr.container': 'jar' }, { subject: 'box', 'attr.hinge': 'hinge' }, { subject: 'rock', 'attr.mood': 'cute' }, { subject: 'rock', freeInstruction: 'make a dragon' }, { subject: 'rock', count: 2 }, { subject: 'rock', 'attr.width': 0 }] as Record<string,string|number|boolean>[]) assert.ok(proceduralProblem(settings));
  assert.equal(proceduralProblem({ uvMode: 'keep' }, 'T02'), undefined); assert.ok(proceduralProblem({ uvMode: 'tripo' }, 'T02'));
  assert.equal(proceduralProblem({ roughness: .2, emission: 2, color: '#AABBCC' }, 'T05'), undefined);
  assert.ok(proceduralProblem({ opacity: 2 }, 'T05')); assert.ok(proceduralProblem({ metallic: .5, 'lock.materials': true }, 'T05'));
});

test('durable local result recovers without Blender, changed hashes and incomplete dispatch cannot rerun', async t => {
  const f = fixture(t); let calls = 0;
  const runBlender = async (_binary: string, command: string[]) => {
    calls++; assert.ok(command.includes('--disable-autoexec'));
    const q = JSON.parse(fs.readFileSync(command.at(-1)!, 'utf8')); fs.mkdirSync(q.output);
    for (const file of ['Asset.blend', 'Asset.fbx', 'Asset.glb']) fs.writeFileSync(path.join(q.output, file), 'fixture ' + file);
    fs.writeFileSync(path.join(q.output, 'inspection.json'), JSON.stringify({ identity: q.identity, operation: 'M04', originalPreserved: true, vertices: 8, faces: 6, triangles:12, quads: 6, faceLimit:10000,faceLimitSatisfied:true,symmetry:{axis:'X',verified:true,maxMirrorError:0,tolerance:.00001},selfContainedGlb: true, warnings: [] }));
  };
  const result = await createGraphicsProceduralExecutor({ runBlender })(f.args);
  assert.deepEqual(result.usage, { localOnly: true, modelTurns: 0, paidSubmissions: 0 });
  assert.equal(result.role, 'model'); assert.equal(result.files.length, 4);
  f.args.recoveryOnly = true; assert.deepEqual(await createGraphicsProceduralExecutor({ runBlender })(f.args), result); assert.equal(calls, 1);
  fs.appendFileSync(path.join(f.root, result.files[0].path), 'changed');
  await assert.rejects(createGraphicsProceduralExecutor({ runBlender })(f.args), /해시/); assert.equal(calls, 1);
  const other = fixture(t); const failed = createGraphicsProceduralExecutor({ runBlender: async () => { calls++; throw Error('interrupted local process'); } });
  await assert.rejects(failed(other.args), /interrupted/); await assert.rejects(failed(other.args), /자동 재실행/); assert.equal(calls, 2);
});

test('UV/material input must be frozen, accepted and unchanged before Blender starts', async t => {
  const f = fixture(t, 'T05'), file = path.join(f.root, 'source.blend'); fs.writeFileSync(file, 'original'); f.attach(file); f.args.task.settings = { roughness: .5 };
  const executor = createGraphicsProceduralExecutor({ runBlender: async () => { assert.fail('must stop before Blender'); } });
  f.args.task.objectSnapshot!.accepted = {}; await assert.rejects(executor(f.args), /채택/);
  f.args.task.objectSnapshot!.accepted = { 'model:main': 'accepted' }; fs.appendFileSync(file, 'changed'); await assert.rejects(executor(f.args), /해시/);
});

const blender = process.env.PARTSMITH_TEST_BLENDER;
const surfaceBlender = blender ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
test('new local UV exports exactly the active layout and retains the original collapsed layer only in editable BLEND', { skip: !fs.existsSync(surfaceBlender), timeout: 90000 }, async t => {
  const f = fixture(t, 'T02'), script = path.join(f.root, 'uv-source.py'), source = path.join(f.root, 'source.blend');
  const png = new PNG({ width: 8, height: 8 }); for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 31) % 256;
  const texture = path.join(f.root, 'source.png'); fs.writeFileSync(texture, PNG.sync.write(png)); const textureHash = sha(texture);
  fs.writeFileSync(script, `import bpy,pathlib,sys,json\np=pathlib.Path(sys.argv[sys.argv.index('--')+1])\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()\no=bpy.context.object;o['partsmith_id']='test-stable-mesh'\nu=o.data.uv_layers.active\nfor i in o.data.polygons[-1].loop_indices:u.data[i].uv=(0,0)\n(p/'old-uv.json').write_text(json.dumps([list(x.uv) for x in u.data]))\nm=bpy.data.materials.new('Original');m.use_nodes=True;o.data.materials.append(m)\ni=bpy.data.images.load(str(p/'source.png'));i.pack();n=m.node_tree.nodes.new('ShaderNodeTexImage');n.image=i;uv=m.node_tree.nodes.new('ShaderNodeUVMap');uv.uv_map='UVMap';m.node_tree.links.new(uv.outputs['UV'],n.inputs['Vector']);m.node_tree.links.new(n.outputs['Color'],m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])\nbpy.ops.wm.save_as_mainfile(filepath=str(p/'source.blend'))\n`);
  const made = spawnSync(surfaceBlender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script, '--', f.root], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(made.status, 0, made.stdout + made.stderr); const original = sha(source);
  f.attach(source); f.args.blenderPath = surfaceBlender; f.args.task.settings = { uvMode: 'local' };
  const result = await executeGraphicsProcedural(f.args);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, result.files.find(x => x.path.endsWith('inspection.json'))!.path), 'utf8'));
  assert.deepEqual(receipt.uvLayers.Cube, ['UVMap', 'Partsmith UV']);
  assert.deepEqual(receipt.exportUV, [{ mesh: 'Cube', sourceLayer: 'Partsmith UV', exportLayer: 'Partsmith UV', layerCount: 1 }]);
  assert.equal(receipt.originalImages[0].sha256, textureHash);
  for (const ext of ['fbx', 'glb', 'blend']) {
    const file = result.files.find(x => x.path.endsWith('.' + ext))!, actual = path.join(f.root, file.path);
    const inspected = await inspectGraphicsSurface({ projectRoot: f.root, sourceVersionId: 'new-uv', source: { path: file.path, bytes: fs.statSync(actual).size, sha256: sha(actual) },
      blenderPath: surfaceBlender, resources: path.resolve('integrations'), signal: new AbortController().signal });
    assert.equal(inspected.report.ready, true, ext + ': ' + inspected.report.reason); assert.equal(inspected.report.invalidUvFaces, 0);
    if (ext !== 'blend') assert.equal(inspected.report.meshes[0].activeUv, inspected.report.meshes[0].consumedUv);
  }
  const verify = path.join(f.root, 'verify-preserved.py'), native = path.join(f.root, result.files.find(x => x.path.endsWith('.blend'))!.path);
  fs.writeFileSync(verify, `import bpy,pathlib,sys,json\np=pathlib.Path(sys.argv[sys.argv.index('--')+1]);bpy.ops.wm.open_mainfile(filepath=sys.argv[-1],load_ui=False,use_scripts=False)\no=bpy.data.objects['Cube'];assert o['partsmith_id']=='test-stable-mesh';assert [list(v.uv) for v in o.data.uv_layers['UVMap'].data]==json.loads((p/'old-uv.json').read_text());assert len(o.data.polygons)==6;assert o.data.uv_layers.active.name=='Partsmith UV';assert next(n for n in o.data.materials[-1].node_tree.nodes if n.type=='UVMAP').uv_map=='UVMap'\n`);
  const checked = spawnSync(surfaceBlender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', verify, '--', f.root, native], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr); assert.equal(sha(source), original);
});
test('real Blender local low/high/seed presets and UV/material derivatives preserve original geometry, UV and encoded texture bytes', { skip: !blender || !fs.existsSync(blender), timeout: 180000 }, async t => {
  const f = fixture(t); f.args.blenderPath = blender!;
  const report = (r: Awaited<ReturnType<typeof executeGraphicsProcedural>>) => JSON.parse(fs.readFileSync(path.join(f.root, r.files.find(file => file.path.endsWith('inspection.json'))!.path), 'utf8'));
  const low = await executeGraphicsProcedural(f.args), lowReport = report(low);
  assert.equal(lowReport.faces, lowReport.quads); assert.equal(lowReport.faces, 54);
  assert.equal(lowReport.triangles,108);assert.equal(lowReport.faceLimit,10000);assert.equal(lowReport.faceLimitSatisfied,true);assert.equal(lowReport.geometryBasis,'editable-mesh-data');assert.equal(lowReport.symmetry.verified,true);
  f.args.task.id = 'high'; f.args.task.settings['attr.style'] = 'realistic'; f.args.task.settings['attr.cracks'] = 'many'; f.args.task.settings['attr.moss'] = 'many';
  const high = await executeGraphicsProcedural(f.args), highReport = report(high);
  assert.ok(highReport.faces > lowReport.faces * 20); assert.ok(highReport.warnings.some((w: string) => w.includes('표면 메시 홈')));
  assert.equal(highReport.triangles,highReport.faces*2);assert.equal(highReport.symmetry.verified,true);
  f.args.task.id = 'seed-two'; f.args.task.settings.variationSeed = 2;
  const second = await executeGraphicsProcedural(f.args);
  assert.notEqual(sha(path.join(f.root, high.files.find(v => v.path.endsWith('.glb'))!.path)), sha(path.join(f.root, second.files.find(v => v.path.endsWith('.glb'))!.path)));
  f.args.task.id='asymmetric';f.args.task.settings.symmetry=false;
  const asymmetric=report(await executeGraphicsProcedural(f.args));assert.equal(asymmetric.symmetry.requested,false);assert.ok(asymmetric.symmetry.maxMirrorError>asymmetric.symmetry.tolerance);
  f.args.task.id='anime';f.args.task.settings={'attr.style':'anime',subject:'rock',symmetry:true,quad:true};
  const anime=report(await executeGraphicsProcedural(f.args));assert.ok(anime.warnings.some((w:string)=>w.includes('셀 셰이딩')));assert.equal(anime.symmetry.verified,true);assert.ok(anime.faces>lowReport.faces);assert.ok(anime.faces<highReport.faces);
  assert.notDeepEqual(anime.materialParameters.find((m:any)=>m.name==='Stone').baseColor,highReport.materialParameters.find((m:any)=>m.name==='Stone').baseColor);
  f.args.task.id = 'box'; f.args.task.settings = { subject: 'box', 'attr.container': 'chest', 'attr.interior': 'hollow', 'attr.lid': 'open', 'attr.style': 'lowpoly', quad: true, faceLimit: 10000 };
  const box = report(await executeGraphicsProcedural(f.args)); assert.ok(box.meshNames.includes('Lid')); assert.ok(box.meshNames.includes('Box bottom')); assert.equal(box.faces, box.quads);
  // Distinct non-uniform pixels detect re-encoding or accidental recoloring of the original file.
  const png = new PNG({ width: 8, height: 8 }); for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 31) % 256;
  const texture = path.join(f.root, 'source.png'); fs.writeFileSync(texture, PNG.sync.write(png));
  const source = path.join(f.root, 'textured.blend'), setup = path.join(f.root, 'setup.py');
  fs.writeFileSync(setup, `import bpy,sys,pathlib\np=pathlib.Path(sys.argv[sys.argv.index('--')+1])\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()\no=bpy.context.object;m=bpy.data.materials.new('Original');m.use_nodes=True;o.data.materials.append(m)\ni=bpy.data.images.load(str(p/'source.png'));i.pack();n=m.node_tree.nodes.new('ShaderNodeTexImage');n.image=i;m.node_tree.links.new(n.outputs['Color'],m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])\nbpy.ops.wm.save_as_mainfile(filepath=str(p/'textured.blend'),compress=False)\n`);
  const created = spawnSync(blender!, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', setup, '--', f.root], { encoding: 'utf8', timeout: 60000 }); assert.equal(created.status, 0, created.stdout + created.stderr);
  const original = sha(source), pixels = sha(texture); f.attach(source); f.args.task.taskId = 'T05'; f.args.task.id = 'material'; f.args.task.settings = { color: '#FF8000', roughness: .2, metallic: .8, emission: 1, opacity: .5 };
  const material = await executeGraphicsProcedural(f.args), materialReport = report(material);
  assert.equal(materialReport.geometryPreserved, true); assert.equal(materialReport.uvPreserved, true); assert.equal(materialReport.originalTexturesPreserved, true);
  assert.equal(materialReport.originalImages[0].sha256, pixels); assert.ok(materialReport.changes.some((c: any) => c.channel === 'color' && c.disconnected.length === 1));
  assert.equal(sha(path.join(f.root, material.files.find(file => file.kind === 'texture')!.path)), pixels);
  f.args.task.taskId = 'T02'; f.args.task.id = 'uv-keep'; f.args.task.settings = { uvMode: 'keep' };
  assert.equal(report(await executeGraphicsProcedural(f.args)).uvPreserved, true);
  f.args.task.id = 'uv-new'; f.args.task.settings = { uvMode: 'local' };
  const uv = report(await executeGraphicsProcedural(f.args)); assert.equal(uv.geometryPreserved, true); assert.deepEqual(uv.uvLayers.Cube, ['UVMap', 'Partsmith UV']);
  assert.equal(sha(source), original); assert.equal(sha(texture), pixels);
  // A valid container header and all no-URI images are additionally checked by the Blender GLB helper.
  for (const result of [low, high, second, material]) { const raw = fs.readFileSync(path.join(f.root, result.files.find(file => file.path.endsWith('.glb'))!.path)); const gltf = JSON.parse(raw.subarray(20, 20 + raw.readUInt32LE(12)).toString('utf8').trim()); assert.ok(gltf.meshes.length); assert.ok((gltf.images ?? []).every((i: any) => !i.uri && Number.isInteger(i.bufferView))); }
});
