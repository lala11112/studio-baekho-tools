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
import type { AssetVersion } from "../shared/graphics";

const blender = process.env.PARTSMITH_TEST_BLENDER ?? "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe";
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
function python(root: string, source: string, input?: string) {
  const script = path.join(root, "fixture.py"); fs.writeFileSync(script, source);
  const result = spawnSync(blender, ["--background", ...(input ? [input] : ["--factory-startup"]), "--disable-autoexec", "--python-exit-code", "1", "--python", script], { windowsHide: true, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stdout.slice(-5000) + result.stderr.slice(-5000));
}
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-human-parts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args: GraphicsNativeArgs = {
    projectRoot: root, workspacePath: path.join(root, "graphics.json"),
    object: { id: "object", kind: "character", name: "Synthetic head body hair", createdAt: "2026-10-13", selectedTasks: ["M08"], instruction: "", settings: {}, references: [], accepted: {} },
    task: { id: "assembly", objectId: "object", taskId: "M08", createdAt: "2026-10-13", updatedAt: "2026-10-13", status: "running", inputVersionIds: [], settings: {}, instruction: "Synthetic assembly fixture; no actual model or service call", requestHash: "frozen", outputVersionIds: [], backendJobIds: [], message: "", localOnly: false },
    inputs: [], blenderPath: blender, resources: path.resolve("integrations"), signal: new AbortController().signal, onProgress: () => {},
  };
  function adopt(file: string, slot: string, companions: string[] = []) {
    const version: AssetVersion = { id: "version-" + (args.inputs.length + 1), objectId: args.object.id, role: "model", slot, label: slot, createdAt: "2026-10-13", sourceVersionIds: [], provenance: { type: "import" }, warnings: [], files: [file, ...companions].map(file => ({ path: path.relative(root, file).split(path.sep).join("/"), sha256: hash(file), bytes: fs.statSync(file).size, kind: file.endsWith(".blend") ? "blend" : "model" })) };
    args.inputs.push(version); args.task.inputVersionIds.push(version.id); args.object.accepted[`model:${slot}`] = version.id; return version;
  }
  return { root, args, adopt };
}

test("actual Blender assembles API FBX, GLB and an imported blend with deterministic IDs and exact packed 4K originals", { skip: !fs.existsSync(blender), timeout: 240_000 }, async t => {
  const f = fixture(t);
  const entries = [
    { part: "head", extension: "fbx", color: [210, 125, 75] },
    { part: "body", extension: "glb", color: [60, 140, 210] },
    { part: "hair", extension: "blend", color: [90, 60, 30] },
  ];
  const textures: string[] = [], sources: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const folder = path.join(f.root, entry.part); fs.mkdirSync(folder);
    const texture = path.join(folder, "original.png"), source = path.join(folder, "source." + entry.extension);
    const png = new PNG({ width: 4096, height: 4096 });
    for (let i = 0; i < png.data.length; i += 4) { png.data[i] = entry.color[0]; png.data[i + 1] = entry.color[1]; png.data[i + 2] = entry.color[2]; png.data[i + 3] = 255; }
    fs.writeFileSync(texture, PNG.sync.write(png)); textures.push(hash(texture)); sources.push(source);
    python(f.root, `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1,location=(${index * 1.7},0,${index + 0.25}))
obj=bpy.context.object;obj.name='NativePart';obj.scale=(1.0,0.75,1.25)
# No custom ID: emulate API/native imports that do not retain Blender extras.
material=bpy.data.materials.new('NativeMaterial');material.use_nodes=True
image=bpy.data.images.load(${JSON.stringify(texture)});image.pack()
node=material.node_tree.nodes.new('ShaderNodeTexImage');node.image=image
material.node_tree.links.new(node.outputs['Color'],material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
obj.data.materials.append(material)
bpy.context.view_layer.update()
` + (entry.extension === "fbx"
      ? `bpy.ops.export_scene.fbx(filepath=${JSON.stringify(source)},use_selection=True,object_types={'MESH'},path_mode='COPY',embed_textures=True,bake_anim=False,use_custom_props=False)\n`
      : entry.extension === "glb"
        ? `bpy.ops.export_scene.gltf(filepath=${JSON.stringify(source)},export_format='GLB',use_selection=True,export_extras=False)\n`
        : `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(source)},compress=False)\n`));
    f.adopt(source, "part-" + entry.part);
  }
  const originalHashes = sources.map(hash);
  let workers = 0;
  const execute = createGraphicsAstraExecutor({ workerFactory: () => ({ probe: async () => { throw Error("Services are prohibited in this test"); }, run: async task => {
    workers++;
    const prepared = read(path.join(f.root, "graphics/jobs/assembly/astra/prepared.json"));
    assert.equal(prepared.assemblySources.length, 3);
    for (const [index, part] of prepared.assemblySources.entries()) {
      assert.equal(part.sourceSha256, originalHashes[index]);
      assert.equal(part.sha256, hash(part.path)); assert.equal(part.reportSha256, hash(part.report));
      const proof = read(part.report);
      assert(proof.meshes.every((mesh: any) => /^mesh-[a-f0-9]{24}$/.test(mesh.id)));
      assert(proof.textures.length > 0);
      for (const texture of proof.textures) { assert.deepEqual(texture.size, [4096, 4096]); assert.equal(texture.sha256, textures[index]); }
    }
    const baseline = read(prepared.baseline);
    assert.deepEqual(baseline.meshes.map((mesh: any) => mesh.partId).sort(), ["part-body", "part-hair", "part-head"]);
    for (const part of prepared.assemblySources) {
      const proof = read(part.report), original = proof.meshes[0];
      const assembled = baseline.meshes.find((mesh: any) => mesh.id === part.versionId + ":" + original.id);
      assert(assembled);
      for (const field of ["vertices", "faces", "topology", "positions", "transform", "uv", "faceMaterials"]) assert.deepEqual(assembled[field], original[field], `${part.slot} changed ${field}`);
    }
    assert.deepEqual(baseline.textures.map((texture: any) => texture.sha256).sort(), prepared.assemblySources.flatMap((part: any) => read(part.report).textures.map((texture: any) => texture.sha256)).sort());
    python(f.root, `import bpy\nassert len([o for o in bpy.context.scene.objects if o.type=='MESH'])==3\nbpy.context.scene['synthetic_authoring_only']=True\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(path.join(task.run.workspace, "outputs/asset.blend"))},compress=False)\n`, path.join(task.run.workspace, "source.blend"));
    return { result: { status: "completed", summary: "Deterministic fixture assembly; GPT 0", blendPath: "outputs/asset.blend", warnings: [] } };
  } }) });
  const result = await execute(f.args), report = read(path.join(f.root, result.files.find(file => file.kind === "report")!.path));
  assert.equal(result.role, "model"); assert.equal(result.slot, "main");
  assert.equal(report.checks.materials, true); assert.equal(report.checks.topology, true);
  assert.equal(report.meshes.length, 3); assert.deepEqual([...new Set(report.textures.map((value: any) => value.sha256))].sort(), [...textures].sort());
  assert.deepEqual(sources.map(hash), originalHashes);
  f.args.recoveryOnly = true; assert.deepEqual(await execute(f.args), result); assert.equal(workers, 1);

  // Reimport the same GLB locally: generated IDs and geometry are stable, even
  // though .blend container bytes are not assumed reproducible across saves.
  const prepared = read(path.join(f.root, "graphics/jobs/assembly/astra/prepared.json"));
  const native = prepared.assemblySources[1], repeat = path.join(f.root, "repeat.json"), repeatBlend = path.join(f.root, "repeat.blend");
  const q = { mode: "prepare", identity: "repeat", nonce: "repeat", operation: "M08", source: sources[1], sourceSha256: originalHashes[1], outputBlend: repeatBlend, report: repeat };
  const spec = path.join(f.root, "repeat-request.json"); fs.writeFileSync(spec, JSON.stringify(q));
  const check = spawnSync(blender, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", path.resolve("integrations/blender/graphics_astra_validate.py"), "--", spec], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.deepEqual(read(repeat).meshes, read(native.report).meshes); assert.deepEqual(read(repeat).textures, read(native.report).textures);
});

test("corrupt accepted part is rejected by local preparation before an Astra dispatch", { skip: !fs.existsSync(blender), timeout: 60_000 }, async t => {
  const f = fixture(t), source = path.join(f.root, "bad.fbx"), other = path.join(f.root, "other.glb");
  fs.writeFileSync(source, "invalid native FBX"); fs.writeFileSync(other, "invalid native GLB");
  f.adopt(source, "part-head"); f.adopt(other, "part-body");
  let workers = 0;
  const execute = createGraphicsAstraExecutor({ workerFactory: () => { workers++; throw Error("A worker must not start"); } });
  await assert.rejects(execute(f.args), /Blender/);
  assert.equal(workers, 0); assert.equal(hash(source), f.args.inputs[0].files[0].sha256);
  assert(!fs.existsSync(path.join(f.root, "graphics/jobs/assembly/astra/dispatch.json")));
});
