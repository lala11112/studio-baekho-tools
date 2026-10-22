import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { createGraphicsMotionSourceExecutor, executeGraphicsMotionSource, prepareGraphicsMotionSource } from "../engine/graphics-motion-source";
import type { GraphicsNativeArgs } from "../engine/graphics-native";

const fileHash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-sides-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.blend"); fs.writeFileSync(source, "mock original blend");
  const args: GraphicsNativeArgs = { projectRoot: root, workspacePath: path.join(root, "graphics/workspace.json"), blenderPath: process.execPath,
    resources: path.resolve("integrations"), signal: new AbortController().signal, onProgress: () => {},
    object: { id: "object", name: "Model", kind: "character", createdAt: "test", selectedTasks: [], instruction: "", settings: {}, references: [], accepted: { "model:main": "model-v1" } },
    task: { id: "sides-task", objectId: "object", taskId: "N01", createdAt: "test", updatedAt: "test", status: "running", settings: { motionSourceAxis: "X" }, instruction: "", requestHash: "frozen-sides",
      inputVersionIds: ["model-v1"], outputVersionIds: [], backendJobIds: [], message: "", localOnly: true,
      objectSnapshot: { name: "Model", kind: "character", references: [], accepted: { "model:main": "model-v1" } } },
    inputs: [{ id: "model-v1", objectId: "object", role: "model", slot: "main", label: "Model", createdAt: "test", sourceVersionIds: [], provenance: { type: "import" }, warnings: [],
      files: [{ path: "source.blend", kind: "blend", sha256: fileHash(source), bytes: fs.statSync(source).size }] }] };
  let renders = 0, invalid = false;
  const runBlender = async (_binary: string, command: string[]) => {
    renders++;
    assert(command.includes("--disable-autoexec")); assert(command.includes("--python-exit-code"));
    const spec = JSON.parse(fs.readFileSync(command.at(-1)!, "utf8"));
    assert.notEqual(spec.source, source); assert.equal(fileHash(spec.source), fileHash(source));
    const png = new PNG({ width: 2048, height: 2048 }); png.data.fill(230); const bytes = PNG.sync.write(png);
    for (const view of ["left", "right"]) fs.writeFileSync(path.join(spec.output, view + ".png"), bytes);
    fs.writeFileSync(path.join(spec.output, "render.json"), JSON.stringify({ identity: spec.identity, sourceSha256: spec.sourceSha256,
      axis: spec.axis, originalPreserved: true, fullBodyInFrame: true, missingImages: [], resolution: [2048, 2048],
      views: ["left", "right"].map(view => ({ view, projectedBounds: [invalid ? 0 : 0.15, 0.85, 0.15, 0.85] })) }));
  };
  return { root, args, source, execute: createGraphicsMotionSourceExecutor({ runBlender }), runBlender, count: () => renders, invalid: () => { invalid = true; },
    refreshSource: () => { args.inputs[0].files[0].sha256 = fileHash(source); args.inputs[0].files[0].bytes = fs.statSync(source).size; } };
}

test("N01 requires a frozen accepted model or rig and never invokes a worker", async t => {
  const f = fixture(t); delete f.args.task.objectSnapshot!.accepted["model:main"];
  assert.throws(() => prepareGraphicsMotionSource(f.args), /채택/);
  await assert.rejects(f.execute(f.args), /채택/); assert.equal(f.count(), 0);
});

test("local side bundle preserves source and accepted design; restart reuses hashes without rendering", async t => {
  const f = fixture(t), hash = fileHash(f.source), accepted = structuredClone(f.args.object.accepted);
  const result = await f.execute(f.args);
  assert.equal(result.role, "design"); assert.equal(result.slot, "motion-source"); assert.equal(result.files.filter(file => file.kind === "image").length, 2);
  assert.deepEqual(result.usage, { localOnly: true, modelTurns: 0, paidSubmissions: 0 });
  assert.equal(fileHash(f.source), hash); assert.deepEqual(f.args.object.accepted, accepted);
  assert.deepEqual(await createGraphicsMotionSourceExecutor({ runBlender: f.runBlender })({ ...f.args, recoveryOnly: true }), result); assert.equal(f.count(), 1);
  fs.appendFileSync(path.join(f.root, result.files[0].path), "changed");
  await assert.rejects(f.execute({ ...f.args, recoveryOnly: true }), /해시/); assert.equal(f.count(), 1);
});

test('N01 saved-only recovery never creates directories or renders without a complete checkpoint', async t => {
  const f = fixture(t), original = fileHash(f.source), accepted = structuredClone(f.args.object.accepted);
  const output = path.join(f.root, 'graphics/jobs/sides-task/motion-source');
  await assert.rejects(f.execute({ ...f.args, recoveryOnly: true }), /복구에서 새로 실행하지 않습니다/);
  assert.equal(fs.existsSync(path.join(f.root, 'graphics')), false);
  fs.mkdirSync(output, { recursive: true });
  await assert.rejects(f.execute({ ...f.args, recoveryOnly: true }), /복구에서 새로 실행하지 않습니다/);
  assert.deepEqual(fs.readdirSync(output), []);
  const partial = path.join(output, 'left.png'); fs.writeFileSync(partial, 'incomplete saved output');
  const partialHash = fileHash(partial);
  await assert.rejects(f.execute({ ...f.args, recoveryOnly: true }), /복구에서 새로 실행하지 않습니다/);
  assert.deepEqual(fs.readdirSync(output), ['left.png']); assert.equal(fileHash(partial), partialHash);
  assert.equal(f.count(), 0); assert.equal(fileHash(f.source), original); assert.deepEqual(f.args.object.accepted, accepted);
});

test('N01 failed first render cannot be silently repeated by recovery', async t => {
  const f = fixture(t); f.invalid();
  await assert.rejects(f.execute(f.args), /전신 여백/); assert.equal(f.count(), 1);
  await assert.rejects(f.execute({ ...f.args, recoveryOnly: true }), /복구에서 새로 실행하지 않습니다/);
  assert.equal(f.count(), 1); assert.deepEqual(fs.readdirSync(path.join(f.root, 'graphics/jobs/sides-task/motion-source')), []);
});

test("bad full-body framing is rejected before registering either side", async t => {
  const f = fixture(t); f.invalid(); await assert.rejects(f.execute(f.args), /전신 여백/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "graphics/jobs/sides-task/motion-source")), []);
});

test("changed accepted bytes and frozen axis stop before rerender or overwrite", async t => {
  const f = fixture(t); await f.execute(f.args); f.args.task.settings.motionSourceAxis = "Y";
  await assert.rejects(f.execute({ ...f.args, recoveryOnly: true }), /요청이 다릅니다/); assert.equal(f.count(), 1);
  f.args.task.settings.motionSourceAxis = "X"; fs.appendFileSync(f.source, "mutated");
  await assert.rejects(f.execute({ ...f.args, recoveryOnly: true }), /해시/); assert.equal(f.count(), 1);
});

const blender = process.env.PARTSMITH_TEST_BLENDER ?? "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe";
test("actual local Blender fits both 2048px sides including tall tips and retains colored materials", { skip: !fs.existsSync(blender), timeout: 180_000 }, async t => {
  const f = fixture(t), script = path.join(f.root, "synthetic.py");
  fs.writeFileSync(script, `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nred=bpy.data.materials.new('Red');red.diffuse_color=(.7,.03,.02,1);red.use_nodes=True\nred.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.7,.03,.02,1)\nfor name,loc,scale in [('Body',(0,0,1),(.3,.6,.8)),('Ear',(0,.3,2.1),(.12,.12,.6)),('Foot',(0,-.4,.15),(.3,.4,.15))]:\n bpy.ops.mesh.primitive_cube_add(size=2,location=loc)\n obj=bpy.context.object;obj.name=name;obj.scale=scale;obj.data.materials.append(red)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(f.source.replaceAll("\\", "/"))})\n`);
  const built = spawnSync(blender, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", script], { windowsHide: true, encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr + built.stdout.slice(-1500)); f.refreshSource(); f.args.blenderPath = blender;
  const original = fileHash(f.source), result = await executeGraphicsMotionSource(f.args);
  assert.equal(fileHash(f.source), original); assert.equal(result.files.length, 3);
  const report = JSON.parse(fs.readFileSync(path.join(f.root, result.files.find(file => file.kind === "report")!.path), "utf8"));
  assert.equal(report.fullBodyInFrame, true); assert.equal(report.meshCount, 3); assert.equal(report.materialsAuthored, false);
  for (const image of result.files.filter(file => file.kind === "image")) {
    const png = PNG.sync.read(fs.readFileSync(path.join(f.root, image.path)));
    assert.equal(png.width, 2048); assert.equal(png.height, 2048);
    let redPixels = 0;
    for (let index = 0; index < png.data.length; index += 4) if (png.data[index] > png.data[index + 1] * 1.5 && png.data[index] > 70) redPixels++;
    assert(redPixels > 10000, "Existing red material must remain visible");
  }
});
