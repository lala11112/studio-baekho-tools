import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { createGraphicsAstraExecutor } from "../engine/graphics-astra";
import type { GraphicsNativeArgs } from "../engine/graphics-native";
import type { AssetVersion, GraphicsRole } from "../shared/graphics";

const blender = process.env.PARTSMITH_TEST_BLENDER ?? "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe";
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const validator = path.resolve("integrations/blender/graphics_astra_validate.py");
function python(root: string, source: string, input?: string) {
  const script = path.join(root, "local-check.py"); fs.writeFileSync(script, source);
  const result = spawnSync(blender, ["--background", ...(input ? [input] : ["--factory-startup"]), "--disable-autoexec", "--python-exit-code", "1", "--python", script], { windowsHide: true, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stdout.slice(-5000) + result.stderr.slice(-5000));
}
function fixture(t: any, operation: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-ga-model-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args: GraphicsNativeArgs = {
    projectRoot: root, workspacePath: path.join(root, "graphics.json"),
    object: { id: "object", kind: "prop", name: "Synthetic parts", createdAt: "2026-10-13", selectedTasks: [operation], instruction: "", settings: {}, references: [], accepted: {} },
    task: { id: "task-1", objectId: "object", taskId: operation, createdAt: "2026-10-13", updatedAt: "2026-10-13", status: "running", inputVersionIds: [], settings: {}, instruction: "Synthetic fixture checks; no actual authoring model call", requestHash: "frozen", outputVersionIds: [], backendJobIds: [], message: "", localOnly: false },
    inputs: [], blenderPath: blender, resources: path.resolve("integrations"), signal: new AbortController().signal, onProgress: () => {},
  };
  function adopt(file: string, role: GraphicsRole = "model", slot = "main") {
    const version: AssetVersion = { id: "version-" + (args.inputs.length + 1), objectId: args.object.id, role, slot, label: slot, createdAt: "2026-10-13", sourceVersionIds: [], provenance: { type: "import" }, warnings: [], files: [{ path: path.relative(root, file).split(path.sep).join("/"), sha256: hash(file), bytes: fs.statSync(file).size, kind: file.endsWith(".blend") ? "blend" : "image" }] };
    args.inputs.push(version); args.task.inputVersionIds.push(version.id); args.object.accepted[`${role}:${slot}`] = version.id; return version;
  }
  let calls = 0;
  function execute(edit: string) {
    return createGraphicsAstraExecutor({ workerFactory: () => ({ probe: async () => { throw Error("No services"); }, run: async task => {
      calls++; assert.equal(task.requestedModel, "gpt-6-astra");
      python(root, `import bpy\n${edit}\nbpy.context.view_layer.update()\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(path.join(task.run.workspace, "outputs/asset.blend"))},compress=False)\n`, path.join(task.run.workspace, "source.blend"));
      return { result: { status: "completed", summary: "Synthetic scene only", blendPath: "outputs/asset.blend", warnings: [] } };
    } }) });
  }
  return { root, args, adopt, execute, calls: () => calls };
}
const twoMeshes = `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nfor name,x in [('blade',-1),('handle',1)]:\n bpy.ops.mesh.primitive_cube_add(size=1,location=(x,0,0))\n obj=bpy.context.object\n obj.name=name\n obj['partsmith_id']=name\n`;
const loadValidator = `import pathlib,sys\nsys.path.insert(0,${JSON.stringify(path.dirname(validator))})\nnamespace={'__file__':${JSON.stringify(validator)}}\nexec(pathlib.Path(${JSON.stringify(validator)}).read_text(encoding='utf8').rsplit('\\nq = json.loads(',1)[0],namespace)\n`;

const missingSurfaceSource = `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
mesh=bpy.data.meshes.new('HeadMesh')
mesh.from_pydata([(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)],[],[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)])
obj=bpy.data.objects.new('Head',mesh);bpy.context.scene.collection.objects.link(obj)
obj['partsmith_id']='head';obj['partsmith_part_id']='head'
uv=mesh.uv_layers.new(name='OriginalUV')
for index,item in enumerate(uv.data): item.uv=(index/100,index/50)
ids=mesh.attributes.new('source_vertex_id','INT','POINT')
for index,item in enumerate(ids.data): item.value=index+100
ids=mesh.attributes.new('source_face_id','INT','FACE')
for index,item in enumerate(ids.data): item.value=index+200
material=bpy.data.materials.new('Original');mesh.materials.append(material)
bpy.ops.mesh.primitive_cube_add(size=.2,location=(3,0,0))
bpy.context.object.name='Untargeted';bpy.context.object['partsmith_id']='untargeted'
`;
const appendCap = `import bmesh
mesh=bpy.data.objects['Head'].data
bm=bmesh.new();bm.from_mesh(mesh);bm.verts.ensure_lookup_table()
top=[bm.verts[index] for index in [4,5,6,7]]
apex=bm.verts.new((0,0,1.5))
for index in range(4): bm.faces.new((top[index],top[(index+1)%4],apex))
bm.to_mesh(mesh);bm.free();mesh.update()
`;

test("actual M05 static candidate keeps the unaccepted head slot and native FBX quads after vertex-only correction", { skip: !fs.existsSync(blender), timeout: 120_000 }, async t => {
  const f = fixture(t, "M05"), original = path.join(f.root, "original.blend");
  python(f.root, twoMeshes + `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(original)},compress=False)\n`);
  const source = f.adopt(original, "model", "part-head"), originalHash = hash(original);
  delete f.args.object.accepted['model:part-head'];
  f.args.task.settings = { editSourceMode: "candidate", sourceVersionId: source.id, editSourceSlot: "part-head" };
  const execute = f.execute(`bpy.data.objects['blade'].data.vertices[0].co.z += 0.1`);
  const result = await execute(f.args);
  assert.equal(result.slot, "part-head"); assert.equal(result.role, "model");
  assert.equal(f.args.object.accepted['model:part-head'], undefined); assert.equal(hash(original), originalHash);
  const report = read(path.join(f.root, result.files.find(file => file.kind === 'report')!.path));
  assert.equal(report.checks.topology, true); assert.equal(report.checks.materials, true);
  assert.equal(report.checks.candidateStatic, true); assert.equal(report.checks.candidateObjectPreserved, true);
  const fbx = result.files.find(file => file.path.endsWith('.fbx'))!;
  assert(fbx); assert(result.files.indexOf(fbx) < result.files.findIndex(file => file.path.endsWith('.glb')));
  python(f.root, `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=${JSON.stringify(path.join(f.root, fbx.path))},use_image_search=False)
meshes={obj.get('partsmith_id'):obj for obj in bpy.context.scene.objects if obj.type=='MESH'}
assert set(meshes)=={'blade','handle'}
assert all(len(obj.data.vertices)==8 and len(obj.data.polygons)==6 for obj in meshes.values())
assert all(len(face.vertices)==4 for obj in meshes.values() for face in obj.data.polygons)
`);
  f.args.recoveryOnly = true; assert.deepEqual(await execute(f.args), result); assert.equal(f.calls(), 1);
});

test("actual M09 append-only repair retains an unaccepted source slot and rejects geometry, boundary, scope and dependency violations", { skip: !fs.existsSync(blender), timeout: 180_000 }, async t => {
  const f = fixture(t, "M09"), original = path.join(f.root, "original.blend");
  python(f.root, missingSurfaceSource + `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(original)},compress=False)\n`);
  const source = f.adopt(original, "model", "part-head"), originalHash = hash(original);
  delete f.args.object.accepted['model:part-head']; // Selected candidates may be repaired without silent adoption.
  f.args.task.settings = { sourceVersionId: source.id, meshSelectionVersionId: source.id, editMeshIds: '["head"]', repairMaxAddedFaces: 4, repairMaxAddedVertices: 1 };
  const execute = f.execute(appendCap), result = await execute(f.args);
  assert.equal(result.slot, "part-head"); assert.equal(result.role, "model");
  assert.equal(f.args.object.accepted['model:part-head'], undefined);
  assert.equal(hash(original), originalHash);
  const report = read(path.join(f.root, result.files.find(file => file.kind === "report")!.path));
  assert.equal(report.checks.appendOnlyRepair, true);
  assert.equal(report.checks.topology, false, "Append-only repair must not claim unchanged total topology");
  assert.equal(report.repair.addedFaces, 4); assert.equal(report.repair.addedVertices, 1);
  assert.equal(report.repair.boundaryAttachmentEdges.length, 4);
  assert.equal(report.repair.maxOriginalPositionDisplacement, 0);
  assert.equal(report.repair.selfIntersectionVerified, false);
  assert.equal(report.repair.newUVQualityVerified, false);
  assert.equal(result.files.filter(file => file.kind === "image").length, 6);
  assert.equal(report.repair.comparisonFraming, "identical-output-bounds");
  const fbx = result.files.find(file => file.path.endsWith('.fbx'))!;
  assert(fbx); assert(result.files.indexOf(fbx) < result.files.findIndex(file => file.path.endsWith('.glb')));
  python(f.root, `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=${JSON.stringify(path.join(f.root, fbx.path))},use_image_search=False)
head=next(obj for obj in bpy.context.scene.objects if obj.get('partsmith_id')=='head')
assert head.get('partsmith_part_id')=='head'
assert len(head.data.vertices)==9 and len(head.data.polygons)==9
assert sum(len(face.vertices)==4 for face in head.data.polygons)==5
assert sum(len(face.vertices)==3 for face in head.data.polygons)==4
other=next(obj for obj in bpy.context.scene.objects if obj.get('partsmith_id')=='untargeted')
assert len(other.data.polygons)==6 and all(len(face.vertices)==4 for face in other.data.polygons)
assert all(len(layer.data)==32 for layer in head.data.uv_layers)
`);
  f.args.recoveryOnly = true; assert.deepEqual(await execute(f.args), result); assert.equal(f.calls(), 1);
  const baselinePath = path.join(f.root, "graphics/jobs/task-1/astra/baseline.json"), sourcePath = path.join(f.root, "graphics/jobs/task-1/astra/work/source.blend");
  python(f.root, loadValidator + `import bpy,json,bmesh
baseline=json.loads(pathlib.Path(${JSON.stringify(baselinePath)}).read_text())
source=${JSON.stringify(sourcePath)}
append_code=${JSON.stringify(appendCap)}
q={'operation':'M09','editMeshIds':['head'],'repairMaxAddedFaces':4,'repairMaxAddedVertices':1}
def reject(edit,expected,extra=None):
 bpy.ops.wm.open_mainfile(filepath=source,load_ui=False,use_scripts=False)
 exec(append_code,globals())
 exec(edit,globals())
 bpy.context.view_layer.update()
 try:
  namespace['repair_checks']({**q,**(extra or {})},baseline,namespace['snapshot']())
  raise AssertionError('Unsafe repair accepted: '+expected)
 except RuntimeError as error:
  assert expected in str(error),(expected,str(error))
reject("bpy.data.objects['Head'].data.vertices[0].co.x+=0.001",'original vertex')
reject("bpy.data.objects['Head'].data.uv_layers[0].data[0].uv.x+=0.1",'UV layer')
reject("bpy.data.objects['Untargeted'].data.vertices[0].co.x+=0.1",'untargeted mesh')
reject("bpy.data.objects['Head'].location.x+=0.1",'original object')
reject("bpy.data.objects['Head']['partsmith_part_id']='body'",'custom ID')
reject("bpy.data.objects['Head'].data.vertices[-1].co.z=100",'bounded target region')
reject("",'budgets',{'repairMaxAddedFaces':3})
reject("bpy.ops.object.empty_add()",'original object')
reject("bpy.data.objects['Head'].shape_key_add(name='Basis')",'unrigged meshes')
reject("bpy.data.objects['Head'].modifiers.new('Unexpected','SUBSURF')",'unrigged meshes')
reject("bpy.ops.object.armature_add()",'unrigged meshes')
reject("mesh=bpy.data.objects['Head'].data;mesh.attributes['source_vertex_id'].data[0].value=999",'attribute')
reject("mesh=bpy.data.objects['Head'].data;bm=bmesh.new();bm.from_mesh(mesh);bm.faces.ensure_lookup_table();bm.faces[5].normal_flip();bm.to_mesh(mesh);bm.free()",'inconsistent winding')
# Disconnected component: preserve source arrays, but use a separate triangle.
bpy.ops.wm.open_mainfile(filepath=source,load_ui=False,use_scripts=False)
mesh=bpy.data.objects['Head'].data;bm=bmesh.new();bm.from_mesh(mesh)
vs=[bm.verts.new(co) for co in [(0,0,1.5),(.2,0,1.5),(0,.2,1.5)]];bm.faces.new(vs);bm.to_mesh(mesh);bm.free()
try:
 namespace['repair_checks']({**q,'repairMaxAddedVertices':3},baseline,namespace['snapshot']())
 raise AssertionError('Floating repair accepted')
except RuntimeError as error:
 assert 'disconnected component' in str(error),str(error)
`);
  assert.equal(hash(original), originalHash);
});

test("actual M09 normalizes only equivalent built-in face storage and rejects material or smoothing changes in both directions", { skip: !fs.existsSync(blender), timeout: 60_000 }, t => {
  const f = fixture(t, "M09");
  python(f.root, loadValidator + `import bpy,json
source_code=${JSON.stringify(missingSurfaceSource)}
append_code=${JSON.stringify(appendCap)}
q={'operation':'M09','editMeshIds':['head'],'repairMaxAddedFaces':4,'repairMaxAddedVertices':1}
def storage(mesh,name,present,value=0):
 attribute=mesh.attributes.get(name)
 if not present:
  if attribute: mesh.attributes.remove(attribute)
  return
 if not attribute: attribute=mesh.attributes.new(name,'INT' if name=='material_index' else 'BOOLEAN','FACE')
 for item in attribute.data: item.value=value
def check(name,before_present,after_present,source_value,result_value,expect_pass):
 exec(source_code,globals())
 mesh=bpy.data.objects['Head'].data
 mesh.materials.append(bpy.data.materials.new('Second material'))
 storage(mesh,'material_index',False);storage(mesh,'sharp_face',False)
 storage(mesh,name,before_present,source_value)
 baseline=namespace['snapshot']();baseline['repairContract']=namespace['repair_contract']()
 exec(append_code,globals())
 storage(mesh,name,after_present,result_value)
 bpy.context.view_layer.update()
 try:
  checks,evidence=namespace['repair_checks'](q,baseline,namespace['snapshot']())
 except RuntimeError as error:
  assert not expect_pass,(name,before_present,after_present,str(error))
  assert 'original assignments' in str(error),(name,str(error))
 else:
  assert expect_pass,('A semantic face-property change was accepted',name)
  assert checks['appendOnlyRepair']
  assert name in evidence['equivalentFaceAttributeStorageChanges']
for name in ['material_index','sharp_face']:
 check(name,False,True,0,0,True)
 check(name,True,False,0,0,True)
 check(name,False,True,0,1,False)
 check(name,True,False,1,0,False)
`);
});

test("actual Blender partitions two native parts and assembles their independent editable scenes without source mutation", { skip: !fs.existsSync(blender), timeout: 240_000 }, async t => {
  const f = fixture(t, "M07"), original = path.join(f.root, "original.blend");
  python(f.root, twoMeshes + `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(original)},compress=False)\n`);
  f.adopt(original); const originalHash = hash(original);
  f.args.task.settings.requestedParts = JSON.stringify([{ id: "blade", label: "Blade" }, { id: "handle", label: "Handle" }]);
  const split = f.execute(`for obj in bpy.context.scene.objects:\n if obj.type=='MESH': obj['partsmith_part_id']=obj['partsmith_id']`);
  const result = await split(f.args);
  assert.deepEqual(result.candidates?.map(value => value.slot), ["part-blade", "part-handle"]);
  assert.equal(result.role, "model"); assert.equal(hash(original), originalHash);
  const report = read(path.join(f.root, result.files.find(file => file.kind === "report")!.path));
  assert.equal(report.checks.partition, true); assert.equal(report.visualQualityVerified, false);
  const parts = result.candidates!.map(candidate => ({ slot: candidate.slot, file: path.join(f.root, candidate.files.find(file => file.kind === "blend")!.path) }));
  for (const part of parts) {
    python(f.root, `import bpy\nmeshes=[obj for obj in bpy.context.scene.objects if obj.type=='MESH']\nassert len(bpy.data.scenes)==1\nassert len(meshes)==1 and meshes[0].get('partsmith_part_id')==${JSON.stringify(part.slot.replace(/^part-/, ""))}\n`, part.file);
    const candidate = result.candidates!.find(value => value.slot === part.slot)!;
    assert(candidate.files.some(file => file.path.endsWith(".fbx")));
    assert(candidate.files.some(file => file.path.endsWith(".glb")));
    // The authoring process still contains the whole scene and prior part
    // scenes. Selection alone must not leak those siblings into any GLB scene.
    const glb = fs.readFileSync(path.join(f.root, candidate.files.find(file => file.path.endsWith(".glb"))!.path));
    const document = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
    assert.equal(document.scenes.length, 1, "A standalone part must not retain the whole or sibling scenes");
    assert.equal(document.scene, 0);
    assert.equal(document.meshes.length, 1, "The GLB must not contain sibling mesh payloads");
    const meshNodes = document.nodes.filter((node: any) => node.mesh !== undefined);
    assert.equal(meshNodes.length, 1);
    assert.equal(meshNodes[0].name, part.slot.replace(/^part-/, ""));
    assert.deepEqual(document.scenes[0].nodes, [document.nodes.indexOf(meshNodes[0])]);
    assert.equal(document.meshes[0].primitives.reduce((total: number, primitive: any) => total + document.accessors[primitive.indices].count / 3, 0), 12);
  }
  f.args.recoveryOnly = true; assert.deepEqual(await split(f.args), result); assert.equal(f.calls(), 1);
  f.args.recoveryOnly = false; f.args.task.id = "task-assemble"; f.args.task.taskId = "M08"; f.args.task.settings = {};
  f.args.inputs = []; f.args.task.inputVersionIds = []; f.args.object.accepted = {};
  const hashes = parts.map(part => hash(part.file)); for (const part of parts) f.adopt(part.file, "model", part.slot);
  const assembled = await f.execute(`for index,obj in enumerate(sorted([o for o in bpy.context.scene.objects if o.type=='MESH'],key=lambda o:o.name)):\n obj.location.z += index*0.5`)(f.args);
  assert.equal(assembled.role, "model"); assert.equal(assembled.slot, "main");
  const assembledReport = read(path.join(f.root, assembled.files.find(file => file.kind === "report")!.path));
  assert.equal(assembledReport.meshes.length, 2); assert.equal(assembledReport.checks.topology, true);
  assert(assembledReport.meshes.every((mesh: any) => /^version-\d:/.test(mesh.id)));
  assert.deepEqual(parts.map(part => hash(part.file)), hashes); assert.equal(hash(original), originalHash);
  // Independent validator rejects a duplicate surface even if requested part labels still exist.
  python(f.root, loadValidator + `import bpy,json\nbaseline=json.loads(pathlib.Path(${JSON.stringify(path.join(f.root, "graphics/jobs/task-1/astra/baseline.json"))}).read_text())\nfor obj in bpy.context.scene.objects:\n if obj.type=='MESH': obj['partsmith_part_id']=obj['partsmith_id']\nobj=bpy.data.objects['blade']\ncopy=obj.copy();copy.data=obj.data.copy();copy['partsmith_id']='duplicate'\nbpy.context.scene.collection.objects.link(copy)\ntry:\n namespace['model_checks']({'operation':'M07','requestedParts':[{'id':'blade'},{'id':'handle'}]},baseline,namespace['snapshot']())\n raise AssertionError('Duplicated original surface accepted')\nexcept RuntimeError as error:\n assert 'partition every original polygon exactly once' in str(error)\n`, original);
});

test("actual Blender partial edit locks all untargeted geometry and new local model starts from image-only empty scene", { skip: !fs.existsSync(blender), timeout: 180_000 }, async t => {
  const f = fixture(t, "M06"), original = path.join(f.root, "original.blend");
  python(f.root, twoMeshes + `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(original)},compress=False)\n`);
  f.adopt(original); const originalHash = hash(original); f.args.task.settings.editMeshIds = '["blade"]';
  const result = await f.execute(`bpy.data.objects['blade'].data.vertices[0].co.z += 0.1`)(f.args);
  const baselinePath = path.join(f.root, "graphics/jobs/task-1/astra/baseline.json");
  const report = read(path.join(f.root, result.files.find(file => file.kind === "report")!.path));
  assert.equal(report.checks.partialEdit, true); assert.equal(hash(original), originalHash);
  python(f.root, loadValidator + `import bpy,json\nbaseline=json.loads(pathlib.Path(${JSON.stringify(baselinePath)}).read_text())\nq={'operation':'M06','editMeshIds':['blade']}\nbpy.data.objects['blade'].data.vertices[0].co.z+=0.1\nbpy.data.objects['handle'].data.vertices[0].co.z+=0.1\ntry:\n namespace['model_checks'](q,baseline,namespace['snapshot']())\n raise AssertionError('Untargeted geometry accepted')\nexcept RuntimeError as error:\n assert 'untargeted' in str(error)\n`, original);
  const model = fixture(t, "M15"), png = new PNG({ width: 4, height: 4 }); png.data.fill(150);
  const image = path.join(model.root, "design.png"); fs.writeFileSync(image, PNG.sync.write(png)); model.adopt(image, "design");
  const created = await model.execute(`assert not [obj for obj in bpy.context.scene.objects if obj.type=='MESH']\nbpy.ops.mesh.primitive_cube_add(size=1)\nbpy.context.object['partsmith_id']='new-original'`)(model.args);
  const newReport = read(path.join(model.root, created.files.find(file => file.kind === "report")!.path));
  assert.equal(created.role, "model"); assert.equal(newReport.checks.newGeometry, true); assert.equal(newReport.visualQualityVerified, false);
  assert.equal(hash(image), model.args.inputs[0].files[0].sha256); assert.equal(model.calls(), 1);
});

test("actual GLB mesh name without extras resolves against the frozen native blend before M06 authoring", { skip: !fs.existsSync(blender), timeout: 120_000 }, async t => {
  const f = fixture(t, "M06"), original = path.join(f.root, "original.blend"), preview = path.join(f.root, "preview.glb");
  python(f.root, twoMeshes + `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(original)},compress=False)\nbpy.ops.export_scene.gltf(filepath=${JSON.stringify(preview)},export_format='GLB',export_extras=False)\n`);
  const bytes = fs.readFileSync(preview), json = JSON.parse(bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)));
  const selected = json.nodes.filter((node: any) => node.mesh !== undefined && node.name === "blade");
  assert.equal(selected.length, 1); assert.equal(selected[0].extras, undefined);
  const version = f.adopt(original), sourceHash = hash(original);
  f.args.task.settings.editMeshNames = JSON.stringify([selected[0].name]);
  f.args.task.settings.meshSelectionVersionId = version.id;
  f.args.task.settings.sourceVersionId = version.id;
  let workers = 0;
  const execute = createGraphicsAstraExecutor({ workerFactory: () => ({ probe: async () => { throw Error("No service probe"); }, run: async task => {
    workers++;
    assert.match(task.prompt, /PARTIAL EDIT: edit positions only within exact mesh IDs \["blade"\]/);
    assert.match(task.prompt, new RegExp(`Source version: ${version.id}\\.`));
    const baseline = read(path.join(f.root, "graphics/jobs/task-1/astra/baseline.json"));
    assert.equal(baseline.sourceSha256, sourceHash);
    assert.equal(baseline.meshes.find((mesh: any) => mesh.name === selected[0].name).id, "blade");
    python(f.root, `import bpy\nmesh=bpy.data.objects['blade']\nassert mesh['partsmith_id']=='blade'\nassert bpy.data.objects['handle']['partsmith_id']=='handle'\nmesh.data.vertices[0].co.z += 0.1\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(path.join(task.run.workspace, "outputs/asset.blend"))},compress=False)\n`, path.join(task.run.workspace, "source.blend"));
    return { result: { status: "completed", summary: "Injected deterministic partial edit; no GPT call", blendPath: "outputs/asset.blend", warnings: [] } };
  } }) });
  const result = await execute(f.args), report = read(path.join(f.root, result.files.find(file => file.kind === "report")!.path));
  const baseline = read(path.join(f.root, "graphics/jobs/task-1/astra/baseline.json"));
  assert.equal(workers, 1); assert.equal(report.checks.partialEdit, true); assert.equal(hash(original), sourceHash);
  assert.deepEqual(report.meshes.find((mesh: any) => mesh.id === "handle").positions, baseline.meshes.find((mesh: any) => mesh.id === "handle").positions);
  assert.notDeepEqual(report.meshes.find((mesh: any) => mesh.id === "blade").positions, baseline.meshes.find((mesh: any) => mesh.id === "blade").positions);
  assert.equal(hash(preview), createHash("sha256").update(bytes).digest("hex"));
});

test("actual wings control requires tagged deform bone, direct weights and measurable joint response", { skip: !fs.existsSync(blender), timeout: 60_000 }, t => {
  const f = fixture(t, "R02");
  python(f.root, `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add(size=1)\nmesh=bpy.context.object;mesh['partsmith_id']='wing-mesh'\nbpy.ops.object.armature_add()\nrig=bpy.context.object\nbpy.ops.object.mode_set(mode='EDIT')\nroot=rig.data.edit_bones[0]\nwing=rig.data.edit_bones.new('wing.L');wing.head=(0,0,1);wing.tail=(1,0,1);wing.parent=root\nbpy.ops.object.mode_set(mode='OBJECT')\nmod=mesh.modifiers.new('Skin','ARMATURE');mod.object=rig\ngroup=mesh.vertex_groups.new(name='wing.L');group.add(list(range(8)),1,'REPLACE')\nrig.data.bones['wing.L']['partsmith_feature']='wings'\nbpy.context.view_layer.update()\n` + loadValidator + `proof=namespace['rig_feature_test'](['wings'])\nassert proof['wings'][0]['movingMeshIds']==['wing-mesh']\nmesh.vertex_groups.clear()\ntry:\n namespace['rig_feature_test'](['wings'])\n raise AssertionError('Label-only wing accepted')\nexcept RuntimeError as error:\n assert 'actual weighted pose response: wings' in str(error)\n`);
});

test("actual clothing and accessory controls require their own tagged weighted joints and reject labels without influence", { skip: !fs.existsSync(blender), timeout: 60_000 }, t => {
  const f = fixture(t, "R02");
  python(f.root, `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1)
mesh=bpy.context.object;mesh['partsmith_id']='equipped-mesh'
bpy.ops.object.armature_add()
rig=bpy.context.object
bpy.ops.object.mode_set(mode='EDIT')
root=rig.data.edit_bones[0]
for index,name in enumerate(['cloth','accessories']):
 bone=rig.data.edit_bones.new(name);bone.head=(0,0,1+index);bone.tail=(1,0,1+index);bone.parent=root
bpy.ops.object.mode_set(mode='OBJECT')
mod=mesh.modifiers.new('Skin','ARMATURE');mod.object=rig
for index,name in enumerate(['cloth','accessories']):
 group=mesh.vertex_groups.new(name=name);group.add(list(range(index*4,(index+1)*4)),1,'REPLACE')
 rig.data.bones[name]['partsmith_feature']=name
bpy.context.view_layer.update()
` + loadValidator + `proof=namespace['rig_feature_test'](['cloth','accessories'])
assert set(proof)=={'cloth','accessories'}
assert all(proof[name][0]['movingMeshIds']==['equipped-mesh'] for name in proof)
mesh.vertex_groups.clear()
for name in ['cloth','accessories']:
 try:
  namespace['rig_feature_test']([name])
  raise AssertionError('Label-only feature accepted: '+name)
 except RuntimeError as error:
  assert 'actual weighted pose response: '+name in str(error)
`);
});
