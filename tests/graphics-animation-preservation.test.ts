import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createGraphicsAstraExecutor } from "../engine/graphics-astra";
import type { GraphicsNativeArgs } from "../engine/graphics-native";
import type { AssetVersion } from "../shared/graphics";

const blender = process.env.PARTSMITH_TEST_BLENDER ?? "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe";
const validator = path.resolve("integrations/blender/graphics_astra_validate.py");
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const literal = (value: unknown) => JSON.stringify(value);
function python(root: string, source: string, input?: string) {
  const script = path.join(root, "local-check.py"); fs.writeFileSync(script, source);
  const result = spawnSync(blender, ["--background", ...(input ? [input] : ["--factory-startup"]), "--disable-autoexec", "--python-exit-code", "1", "--python", script], { windowsHide: true, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stdout.slice(-5000) + result.stderr.slice(-5000));
}
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-animation-skin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args: GraphicsNativeArgs = {
    projectRoot: root, workspacePath: path.join(root, "graphics.json"),
    object: { id: "object", kind: "character", name: "Synthetic weighted rig", createdAt: "2026-10-13", selectedTasks: ["N05"], instruction: "", settings: {}, references: [], accepted: {} },
    task: { id: "task", objectId: "object", taskId: "N05", createdAt: "2026-10-13", updatedAt: "2026-10-13", status: "running", inputVersionIds: [], settings: { clipName: "Idle", duration: 1, fps: 30 }, instruction: "Synthetic pose animation; no actual model call", requestHash: "frozen", outputVersionIds: [], backendJobIds: [], message: "", localOnly: false },
    inputs: [], blenderPath: blender, resources: path.resolve("integrations"), signal: new AbortController().signal, onProgress: () => {},
  };
  function adopt(file: string) {
    const version: AssetVersion = { id: "rig", objectId: "object", role: "rig", slot: "main", label: "Rig", createdAt: "2026-10-13", sourceVersionIds: [], provenance: { type: "import" }, warnings: [], files: [{ path: path.relative(root, file), sha256: hash(file), bytes: fs.statSync(file).size, kind: "blend" }] };
    args.inputs = [version]; args.task.inputVersionIds = [version.id]; args.object.accepted = { "rig:main": version.id };
  }
  return { root, args, adopt };
}
const sourceRig = `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1)
mesh=bpy.context.object;mesh.name='OriginalMesh';mesh['partsmith_id']='original-mesh'
bpy.ops.object.armature_add()
rig=bpy.context.object;rig.name='OriginalRig'
bpy.ops.object.mode_set(mode='EDIT')
root=rig.data.edit_bones[0];root.name='root'
joint=rig.data.edit_bones.new('joint');joint.head=(0,0,1);joint.tail=(0,0,2);joint.parent=root
tip=rig.data.edit_bones.new('tip');tip.head=(0,0,2);tip.tail=(0,0,3);tip.parent=joint
bpy.ops.object.mode_set(mode='OBJECT')
skin=mesh.modifiers.new('OriginalSkin','ARMATURE');skin.object=rig
for name,weight in [('joint',0.75),('tip',0.25)]:
 group=mesh.vertex_groups.new(name=name);group.add(list(range(8)),weight,'REPLACE')
for bone in rig.pose.bones: bone.rotation_mode='QUATERNION'
bpy.context.scene.render.fps=30
`;
const authorPose = `import bpy
from mathutils import Quaternion,Vector
rig=bpy.data.objects['OriginalRig'];bone=rig.pose.bones['joint']
for frame,angle in [(1,0),(16,0.45),(31,0)]:
 bone.rotation_quaternion=Quaternion(Vector((0,1,0)),angle)
 bone.keyframe_insert('rotation_quaternion',frame=frame)
rig.animation_data.action.name='Idle'
scene=bpy.context.scene;scene.frame_start=1;scene.frame_end=31;scene.render.fps=30;scene.frame_set(1)
`;
const loadValidator = `import bpy,pathlib,sys,json
sys.path.insert(0,${literal(path.dirname(validator))})
namespace={'__file__':${literal(validator)}}
exec(pathlib.Path(${literal(validator)}).read_text(encoding='utf8').rsplit('\\nq = json.loads(',1)[0],namespace)
`;

test("actual animation preserves exact skin and modifier settings; normalized skin edits cannot pass as authored motion", { skip: !fs.existsSync(blender), timeout: 180_000 }, async t => {
  const f = fixture(t), original = path.join(f.root, "original.blend");
  python(f.root, sourceRig + `bpy.ops.wm.save_as_mainfile(filepath=${literal(original)},compress=False)\n`);
  f.adopt(original); const originalHash = hash(original); let workers = 0;
  const execute = createGraphicsAstraExecutor({ workerFactory: () => ({ probe: async () => { throw Error("No model/service calls"); }, run: async task => {
    workers++;
    python(f.root, authorPose + `bpy.ops.wm.save_as_mainfile(filepath=${literal(path.join(task.run.workspace, "outputs/asset.blend"))},compress=False)\n`, path.join(task.run.workspace, "source.blend"));
    return { result: { status: "completed", summary: "Synthetic native pose keys", blendPath: "outputs/asset.blend", warnings: [] } };
  } }) });
  const result = await execute(f.args);
  const report = read(path.join(f.root, result.files.find(file => file.kind === "report")!.path));
  for (const check of ["skinPreserved", "armatureModifiersPreserved", "animationDependencies", "animationSkeletonPreserved", "weights", "motion", "deformation"]) assert.equal(report.checks[check], true, check);
  assert(report.clip.movingBones.includes("OriginalRig/joint")); assert(report.clip.movingMeshes.includes("original-mesh"));
  assert.equal(workers, 1); assert.equal(hash(original), originalHash);
  const validateRequest = path.join(f.root, "graphics/jobs/task/astra/validate-request.json");
  // Exercise all three animation routes on actual native copies. Failure cases
  // never render; rig-weight edits still undergo actual deformation checks.
  python(f.root, loadValidator + `
q=json.loads(pathlib.Path(${literal(validateRequest)}).read_text(encoding='utf8'))
authored=q['outputBlend']
namespace['preview']=lambda request: ([], [])
cases={
 'normalized_weights': "mesh.vertex_groups['joint'].add([0],0.5,'REPLACE');mesh.vertex_groups['tip'].add([0],0.5,'REPLACE')",
 'sub_rounding_weights': "mesh.vertex_groups['tip'].add([0],0.2500000298023224,'REPLACE')",
 'preserve_volume': "skin.use_deform_preserve_volume=True",
 'multi_modifier': "skin.use_multi_modifier=True",
 'invert_mask': "skin.invert_vertex_group=True",
 'modifier_order': "mesh.modifiers.new('BeforeSkin','SMOOTH');bpy.context.view_layer.objects.active=mesh;bpy.ops.object.modifier_move_up(modifier='BeforeSkin')",
 'inherit_rotation': "rig.data.bones['tip'].use_inherit_rotation=False",
 'inherit_scale': "rig.data.bones['tip'].inherit_scale='NONE'",
 'pose_constraint': "rig.pose.bones['joint'].constraints.new('LIMIT_ROTATION')",
 'object_driver': "rig.driver_add('location',0).driver.expression='0'",
}
for name,edit in cases.items():
 bpy.ops.wm.open_mainfile(filepath=authored,load_ui=False,use_scripts=False)
 mesh=bpy.data.objects['OriginalMesh'];rig=bpy.data.objects['OriginalRig'];skin=mesh.modifiers['OriginalSkin']
 exec(edit)
 if name=='sub_rounding_weights':
  baseline=json.loads(pathlib.Path(q['baseline']).read_text())
  assert namespace['snapshot']()['meshes'][0]['weights']==baseline['meshes'][0]['weights']
 candidate=str(pathlib.Path(${literal(f.root)})/(name+'.blend'))
 bpy.ops.wm.save_as_mainfile(filepath=candidate,compress=False)
 for operation in ('N04','N05','N06'):
  request={**q,'operation':operation,'outputBlend':candidate,'report':str(pathlib.Path(${literal(f.root)})/(name+'-'+operation+'.json'))}
  try:
   namespace['validate'](request)
   raise AssertionError('Unsupported animation edit accepted: '+name+'/'+operation)
  except RuntimeError as error:
   expected='skeleton' if name.startswith('inherit_') else 'constraints' if name=='pose_constraint' else 'drivers' if name=='object_driver' else 'skin weights/groups or Armature modifier'
   assert expected in str(error),str(error)
  assert not pathlib.Path(request['report']).exists()
 if name=='normalized_weights':
  for operation in ('R02','R03'):
   request={**q,'operation':operation,'outputBlend':candidate,'report':str(pathlib.Path(${literal(f.root)})/(name+'-'+operation+'.json'))}
   namespace['validate'](request)
   proof=json.loads(pathlib.Path(request['report']).read_text())
   assert proof['checks']['weights'] and proof['checks']['deformation']
   assert 'skinPreserved' not in proof['checks']
`, undefined);
  assert.equal(hash(original), originalHash); assert.equal(workers, 1);
});

test("actual constrained or driven accepted rigs fail preparation before any authoring worker", { skip: !fs.existsSync(blender), timeout: 120_000 }, async t => {
  const f = fixture(t), original = path.join(f.root, "original.blend");
  const cases = {
    pose_constraint: "rig.pose.bones['joint'].constraints.new('LIMIT_ROTATION')",
    rig_constraint: "rig.constraints.new('LIMIT_LOCATION')",
    mesh_constraint: "mesh.constraints.new('LIMIT_LOCATION')",
    object_driver: "rig.driver_add('location',0).driver.expression='0'",
    data_driver: "rig.data.driver_add('pose_position').driver.expression='0'",
    parented_rig: "parent=bpy.data.objects.new('Parent',None);bpy.context.scene.collection.objects.link(parent);rig.parent=parent",
    nla_mixing: "rig.animation_data_create();action=bpy.data.actions.new('Prior');action.slots.new('OBJECT','OriginalRig');track=rig.animation_data.nla_tracks.new();track.strips.new('Prior',1,action)",
    non_transform_action: "rig['unsupported']=1;rig.keyframe_insert(data_path='[\"unsupported\"]',frame=1)",
  };
  python(f.root, sourceRig + `bpy.ops.wm.save_as_mainfile(filepath=${literal(original)},compress=False)
cases=json.loads(${literal(JSON.stringify(cases))})
for name,edit in cases.items():
 bpy.ops.wm.open_mainfile(filepath=${literal(original)},load_ui=False,use_scripts=False)
 mesh=bpy.data.objects['OriginalMesh'];rig=bpy.data.objects['OriginalRig']
 exec(edit)
 bpy.ops.wm.save_as_mainfile(filepath=str(pathlib.Path(${literal(f.root)})/(name+'.blend')),compress=False)
`.replace("cases=json.loads", "import json,pathlib\ncases=json.loads"));
  let workers = 0;
  const execute = createGraphicsAstraExecutor({ workerFactory: () => { workers++; throw Error("No authoring worker may be created"); } });
  for (const name of Object.keys(cases)) await t.test(name, async () => {
    const file = path.join(f.root, name + ".blend"), before = hash(file);
    f.args.task.id = name; f.adopt(file);
    await assert.rejects(execute(f.args), /constraints|drivers|parented rig|NLA mixing|non-transform/);
    assert(!fs.existsSync(path.join(f.root, "graphics/jobs", name, "astra/dispatch.json")));
    assert.equal(hash(file), before);
  });
  assert.equal(workers, 0);
});
