import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  prepareUnityDelivery,
  readUnityTarget,
} from "../engine/graphics-unity";
import type { AssetVersion, GraphicsObject } from "../shared/graphics";

const hash = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const put = (root: string, file: string, value: string) => {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, value);
  return absolute;
};
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-unity-clips-"));
  assert.equal(
    path.dirname(fs.realpathSync(root)),
    fs.realpathSync(os.tmpdir()),
  );
  t.after(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  );
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const object: GraphicsObject = {
    id: "character",
    name: "Synthetic character",
    kind: "character",
    createdAt: "fixture",
    selectedTasks: [],
    instruction: "",
    settings: {},
    references: [],
    accepted: {},
  };
  const version = (
    id: string,
    role: "rig" | "animation",
    slot: string,
    file: string,
  ): AssetVersion => {
    const source = path.join(project, file);
    if (!fs.existsSync(source)) put(project, file, "native source fixture");
    const value: AssetVersion = {
      id,
      objectId: object.id,
      role,
      slot,
      label: slot,
      createdAt: "fixture",
      sourceVersionIds: role === "animation" ? ["rig"] : [],
      provenance: { type: "local" },
      files: [
        {
          path: file,
          sha256: hash(source),
          bytes: fs.statSync(source).size,
          kind: "blend",
        },
      ],
      warnings: [],
    };
    object.accepted[`${role}:${slot}`] = id;
    return value;
  };
  let targetNumber = 0;
  const args = (versions: AssetVersion[], blenderPath = "") => {
    const unity = path.join(root, "unity-" + targetNumber++);
    fs.mkdirSync(path.join(unity, "Assets"), { recursive: true });
    put(
      unity,
      "ProjectSettings/ProjectVersion.txt",
      "m_EditorVersion: 6000.3.21f1\n",
    );
    put(
      unity,
      "ProjectSettings/GraphicsSettings.asset",
      "GraphicsSettings:\n  m_CustomRenderPipeline: {fileID: 0}\n",
    );
    put(
      unity,
      "ProjectSettings/QualitySettings.asset",
      "QualitySettings:\n  m_CurrentQuality: 0\n  m_QualitySettings:\n  - serializedVersion: 4\n    customRenderPipeline: {fileID: 0}\n  m_PerPlatformDefaultQuality:\n    Standalone: 0\n",
    );
    put(unity, "Packages/manifest.json", '{"dependencies":{}}');
    return {
      projectRoot: project,
      object,
      versions,
      profile: readUnityTarget(unity),
      blenderPath,
      resources: path.resolve("integrations"),
    };
  };
  return { root, project, object, version, args };
}

test("separate Unity clips require exact accepted rig and clip identities before local processing", async (t) => {
  const f = fixture(t),
    rig = f.version("rig", "rig", "main", "rig.blend"),
    idle = f.version("idle", "animation", "Idle", "idle.blend");
  delete f.object.accepted["animation:Idle"];
  await assert.rejects(prepareUnityDelivery(f.args([rig, idle])), /먼저 채택/);
  f.object.accepted["animation:Idle"] = idle.id;
  const material = { ...idle, role: "material" as const };
  await assert.rejects(
    prepareUnityDelivery(f.args([rig, material])),
    /별도 재질/,
  );
  const unnamed = { ...idle, slot: "main" };
  f.object.accepted["animation:main"] = unnamed.id;
  await assert.rejects(
    prepareUnityDelivery(f.args([rig, unnamed])),
    /정확한 Action 이름/,
  );
  const duplicate = { ...idle, id: "idle-duplicate" };
  await assert.rejects(
    prepareUnityDelivery(f.args([rig, idle, duplicate])),
    /먼저 채택/,
  );
});

test(
  "real Blender combines exact clips, keeps other Actions and rejects bind/rotation/FPS mismatches",
  { timeout: 240_000 },
  async (t) => {
    const blender = process.env.PARTSMITH_TEST_BLENDER;
    if (!blender || !fs.existsSync(blender)) {
      t.skip("Set PARTSMITH_TEST_BLENDER for real native rig/clip combination");
      return;
    }
    const f = fixture(t);
    const setup = put(
      f.root,
      "setup.py",
      String.raw`
import bpy, pathlib, sys
folder=pathlib.Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.object.armature_add()
rig=bpy.context.object;rig.name='Rig';rig.rotation_mode='XYZ'
bpy.ops.object.mode_set(mode='EDIT')
root=rig.data.edit_bones[0];root.name='Root'
child=rig.data.edit_bones.new('Deform');child.head=(0,0,1);child.tail=(0,0,2);child.parent=root;child.use_connect=True
bpy.ops.object.mode_set(mode='OBJECT')
for bone in rig.pose.bones: bone.rotation_mode='XYZ'
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,1.5))
mesh=bpy.context.object;mesh.name='Body';mesh.parent=rig
modifier=mesh.modifiers.new('Skin','ARMATURE');modifier.object=rig
group=mesh.vertex_groups.new(name='Deform');group.add(list(range(len(mesh.data.vertices))),1.0,'REPLACE')
material=bpy.data.materials.new('OriginalMaterial');material.use_nodes=True
material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(0.1,0.3,0.8,1)
mesh.data.materials.append(material)
image=bpy.data.images.new('NativeTexture',width=8,height=8);image.generated_color=(0.1,0.3,0.8,1)
image.filepath_raw=str(folder/'texture.png');image.file_format='PNG';image.save()
bpy.data.images.remove(image);image=bpy.data.images.load(str(folder/'texture.png'));image.pack()
node=material.node_tree.nodes.new('ShaderNodeTexImage');node.image=image
material.node_tree.links.new(node.outputs['Color'],material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
scene=bpy.context.scene;scene.render.fps=30;scene.frame_start=1;scene.frame_end=31
def action(name,amplitude):
    rig.animation_data_create();rig.animation_data.action=None
    for frame,value in [(1,0),(16,amplitude),(31,0)]:
        rig.pose.bones['Deform'].rotation_euler.z=value
        rig.pose.bones['Deform'].keyframe_insert(data_path='rotation_euler',index=2,frame=frame)
    rig.animation_data.action.name=name;rig.animation_data.action.use_fake_user=True
    scene.frame_set(1)
action('Keep',0.15);action('Idle',0.05)
bpy.ops.wm.save_as_mainfile(filepath=str(folder/'rig.blend'),compress=False)
for filename,name,amplitude,change in [('idle','Idle',0.25,''),('jump','Jump',0.45,''),('bad-bind','Idle',0.25,'bind'),('bad-rotation','Idle',0.25,'rotation'),('bad-fps','Idle',0.25,'fps')]:
    bpy.ops.wm.open_mainfile(filepath=str(folder/'rig.blend'),load_ui=False,use_scripts=False)
    rig=bpy.data.objects['Rig'];scene=bpy.context.scene
    rig.animation_data_clear()
    for item in list(bpy.data.actions):bpy.data.actions.remove(item)
    action(name,amplitude)
    if change=='bind':
        bpy.context.view_layer.objects.active=rig
        bpy.ops.object.mode_set(mode='EDIT');rig.data.edit_bones['Deform'].tail.z=2.5;bpy.ops.object.mode_set(mode='OBJECT')
    if change=='rotation':rig.pose.bones['Deform'].rotation_mode='QUATERNION'
    if change=='fps':scene.render.fps=24
    bpy.ops.wm.save_as_mainfile(filepath=str(folder/(filename+'.blend')),compress=False)
`,
    );
    const created = spawnSync(
      blender,
      [
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--python-exit-code",
        "1",
        "--python",
        setup,
        "--",
        f.project,
      ],
      { windowsHide: true, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(created.status, 0, created.stderr + created.stdout);
    const rig = f.version("rig", "rig", "main", "rig.blend"),
      idle = f.version("idle", "animation", "Idle", "idle.blend"),
      jump = f.version("jump", "animation", "Jump", "jump.blend");
    const originalHashes = [rig, idle, jump].map((v) => v.files[0].sha256);
    const args = f.args([rig, idle, jump], blender),
      delivery = await prepareUnityDelivery(args);
    assert.equal(delivery.status, "queued", delivery.errors.join("\n"));
    const staging = path.join(
      args.profile.projectPath,
      `Library/PartsmithGraphicsStaging/${delivery.id}`,
    );
    const inspection = JSON.parse(
      fs.readFileSync(path.join(staging, "inspection.json"), "utf8"),
    );
    assert.deepEqual(inspection.clips, ["Idle", "Jump", "Keep"]);
    assert.deepEqual(inspection.merge.selectedClips, ["Idle", "Jump"]);
    assert.deepEqual(Object.keys(inspection.merge.untouchedActions), ["Keep"]);
    assert.equal(inspection.merge.sourceChanged, false);
    assert.equal(inspection.merge.animationAuthored, false);
    assert.equal(
      delivery.files.filter((file) => file.kind === "fbx").length,
      1,
    );
    assert.equal(
      delivery.files.some((file) => /Textures\/.+\.png$/.test(file.path)),
      true,
    );
    assert.equal(
      delivery.files.find((file) => /Textures\/.+\.png$/.test(file.path))!
        .sha256,
      hash(path.join(f.project, "texture.png")),
    );
    const request = JSON.parse(
      fs.readFileSync(path.join(staging, "request.json"), "utf8"),
    );
    assert.deepEqual(request.expectedClips, ["Idle", "Jump", "Keep"]);
    const reused = await prepareUnityDelivery(args);
    assert.equal(reused.id, delivery.id);
    assert.deepEqual(
      [rig, idle, jump].map((v) => hash(path.join(f.project, v.files[0].path))),
      originalHashes,
    );

    const inspect = put(
      f.root,
      "inspect-fbx.py",
      String.raw`
import bpy,json,sys
args=sys.argv[sys.argv.index('--')+1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=args[0],use_image_search=False)
rig=next(obj for obj in bpy.context.scene.objects if obj.type=='ARMATURE')
actions={}
for action in bpy.data.actions:
    rig.animation_data_create();rig.animation_data.action=action
    if getattr(action,'slots',None):rig.animation_data.action_slot=action.slots[0]
    scene=bpy.context.scene
    scene.frame_set(1);before=[value for row in rig.pose.bones['Deform'].matrix for value in row]
    scene.frame_set(16);after=[value for row in rig.pose.bones['Deform'].matrix for value in row]
    actions[action.name]=max(abs(a-b) for a,b in zip(before,after))
open(args[1],'w').write(json.dumps(actions))
`,
    );
    const measured = path.join(f.root, "fbx-motion.json");
    const verified = spawnSync(
      blender,
      [
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--python-exit-code",
        "1",
        "--python",
        inspect,
        "--",
        path.join(staging, "Asset.fbx"),
        measured,
      ],
      { windowsHide: true, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(verified.status, 0, verified.stderr + verified.stdout);
    const motion = JSON.parse(fs.readFileSync(measured, "utf8"));
    for (const name of ["Idle", "Jump", "Keep"])
      assert(
        Object.entries(motion).some(
          ([key, value]) => key.endsWith(name) && Number(value) > 0.01,
        ),
        `${name} must deform the child bone in exported FBX: ${JSON.stringify(motion)}`,
      );

    for (const [file, expected] of [
      ["bad-bind.blend", /bind pose/],
      ["bad-rotation.blend", /rotation modes/],
      ["bad-fps.blend", /different FPS/],
    ] as const) {
      const incompatible = f.version(file, "animation", "Idle", file);
      const badArgs = f.args([rig, incompatible], blender),
        failed = await prepareUnityDelivery(badArgs);
      assert.equal(failed.status, "failed");
      assert.match(failed.errors.join(" "), expected);
      assert.equal(
        fs.existsSync(
          path.join(
            badArgs.profile.projectPath,
            `Library/PartsmithGraphicsInbox/${failed.id}.json`,
          ),
        ),
        false,
      );
      assert.equal(hash(path.join(f.project, "rig.blend")), originalHashes[0]);
    }
    const missing = f.version(
      "missing-action",
      "animation",
      "Walk",
      "idle.blend",
    );
    const failed = await prepareUnityDelivery(f.args([rig, missing], blender));
    assert.equal(failed.status, "failed");
    assert.match(
      failed.errors.join(" "),
      /Exact selected Action is missing: Walk/,
    );
  },
);
