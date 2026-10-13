import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { createGraphicsAstraExecutor, graphicsAstraOperations } from "../engine/graphics-astra";
import type { GraphicsNativeArgs } from "../engine/graphics-native";
import { codexArguments, type ProductionWorker, type WorkerTask } from "../engine/codex-worker";
import type { AssetVersion, GraphicsRole } from "../shared/graphics";

const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(t: any, operation = "R02") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-astra-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args: GraphicsNativeArgs = {
    projectRoot: root, workspacePath: path.join(root, "graphics.json"),
    object: { id: "object-1", kind: "character", name: "Original creature", createdAt: "2026-10-13", selectedTasks: [operation], instruction: "", settings: {}, references: [], accepted: {} },
    task: { id: "task-1", objectId: "object-1", taskId: operation, createdAt: "2026-10-13", updatedAt: "2026-10-13", status: "running", inputVersionIds: [], settings: { clipName: "Idle", duration: 1, fps: 30, loop: true }, instruction: "Apply the requested edit while preserving the original asset", requestHash: "immutable-request", outputVersionIds: [], backendJobIds: [], message: "", localOnly: false },
    inputs: [], blenderPath: process.execPath, resources: path.resolve("integrations"), signal: new AbortController().signal, onProgress: () => {},
  };
  function input(role: GraphicsRole = "model", extension = ".blend", slot = "main") {
    const id = "version-" + (args.inputs.length + 1), file = path.join(root, id + extension);
    fs.writeFileSync(file, "immutable original " + id);
    const version: AssetVersion = { id, objectId: args.object.id, role, slot, label: "Original", createdAt: "2026-10-13", sourceVersionIds: [], provenance: { type: "import" }, warnings: [], files: [{ path: path.basename(file), sha256: hash(file), bytes: fs.statSync(file).size, kind: extension === ".blend" ? "blend" : "model" }] };
    args.inputs.push(version); args.task.inputVersionIds.push(id); args.object.accepted[`${role}:${slot}`] = id;
    return { version, file, refresh: () => { version.files[0].sha256 = hash(file); version.files[0].bytes = fs.statSync(file).size; } };
  }
  const worker = (handler: (task: WorkerTask) => unknown | Promise<unknown>): ProductionWorker => ({ probe: async () => { throw Error("No probe/generation permitted"); }, run: async task => ({ result: await handler(task) }) });
  const authored = (task: WorkerTask) => {
    fs.writeFileSync(path.join(task.run.workspace, "outputs/asset.blend"), "actual authored scene fixture");
    return { status: "completed", summary: "Saved for review", blendPath: "outputs/asset.blend", warnings: ["Visual review still required"] };
  };
  return { root, args, input, worker, authored };
}

function glb(file: string) {
  const json = Buffer.from('{"asset":{"version":"2.0"}} '), size = 20 + json.length;
  const bytes = Buffer.alloc(size); bytes.write("glTF", 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(size, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20); fs.writeFileSync(file, bytes);
}
async function blenderMock(_executable: string, command: string[], _signal?: AbortSignal) {
  const q = read(command.at(-1)!);
  if (q.mode === "prepare") {
    fs.writeFileSync(q.outputBlend, "host-prepared immutable scene");
    write(q.report, { identity: q.identity, nonce: q.nonce, sourceSha256: q.sourceSha256, meshes: [{ id: "mesh-original" }] });
  } else {
    glb(path.join(q.output, "asset.glb"));
    for (const name of ["front", "side", "back"]) {
      const png = new PNG({ width: 8, height: 8 }); png.data.fill(140); fs.writeFileSync(path.join(q.output, name + ".png"), PNG.sync.write(png));
    }
    write(q.report, { identity: q.identity, nonce: q.nonce, operation: q.operation, sourceSha256: q.sourceSha256, outputSha256: hash(q.outputBlend), passed: true, meshes: [{ id: "mesh-original", vertices: 8, weightedVertices: 8 }], files: ["asset.glb", "front.png", "side.png", "back.png"], checks: Object.fromEntries(["meshLineage", "topology", "materials", "actionsPreserved", "weights", "deformation", "skeleton", "clipRange", "motion", "skinPreserved", "armatureModifiersPreserved", "animationDependencies", "animationSkeletonPreserved"].map(key => [key, true])) });
  }
}

test("Astra routes only the actual catalog operation IDs", () => {
  assert.deepEqual(graphicsAstraOperations, ["M05", "M06", "M07", "M08", "M15", "R01", "R02", "R03", "N04", "N05", "N06"]);
});

test("new model contracts reject ambiguous parts, unknown edit IDs, multi-candidate dispatch and impossible locks before any worker", async t => {
  for (const variant of ["parts", "duplicate", "edit", "count", "lock"] as const) await t.test(variant, async child => {
    const f = fixture(child, variant === "edit" ? "M06" : variant === "lock" ? "M15" : "M07");
    f.input(variant === "lock" ? "design" : "model", variant === "lock" ? ".png" : ".blend");
    f.args.task.settings.requestedParts = JSON.stringify([{ id: "a", label: "A" }, { id: "b", label: "B" }]);
    if (variant === "parts") f.args.task.settings.requestedParts = "not json";
    if (variant === "duplicate") f.args.task.settings.requestedParts = JSON.stringify([{ id: "a", label: "A" }, { id: "a", label: "A2" }]);
    if (variant === "edit") f.args.task.settings.editMeshIds = '["unknown-id"]';
    if (variant === "count") f.args.task.settings.count = 2;
    if (variant === "lock") f.args.task.settings["lock.topology"] = true;
    let workers = 0;
    const execute = createGraphicsAstraExecutor({ runBlender: blenderMock, workerFactory: () => { workers++; return f.worker(f.authored); } });
    await assert.rejects(execute(f.args), /JSON|중복|메시 ID|독립 작업|원본 3D/);
    assert.equal(workers, 0);
    assert(!fs.existsSync(path.join(f.root, "graphics/jobs/task-1/astra/dispatch.json")));
  });
});

test("M06 name resolution rejects missing or ambiguous prepared names before dispatch or worker creation", async t => {
  for (const variant of ["missing", "duplicate"] as const) await t.test(variant, async child => {
    const f = fixture(child, "M06"), source = f.input();
    f.args.task.settings.editMeshNames = '["selected-part"]';
    let workers = 0, prepareCalls = 0;
    const execute = createGraphicsAstraExecutor({ workerFactory: () => { workers++; return f.worker(f.authored); }, runBlender: async (...args) => {
      await blenderMock(...args);
      const q = read(args[1].at(-1)!);
      assert.equal(q.mode, "prepare"); prepareCalls++;
      const baseline = read(q.report);
      baseline.meshes = variant === "missing" ? [{ id: "other", name: "unrelated-part" }] :
        [{ id: "first", name: "selected-part" }, { id: "second", name: "selected-part" }];
      write(q.report, baseline);
    } });
    await assert.rejects(execute(f.args), /유일하게 연결되지/);
    assert.equal(prepareCalls, 1); assert.equal(workers, 0);
    assert.equal(hash(source.file), source.version.files[0].sha256);
    assert(!fs.existsSync(path.join(f.root, "graphics/jobs/task-1/astra/dispatch.json")));
  });
});

test("enabled appendage and explicit structural lock require positive host evidence", async t => {
  for (const setting of ["rigWings", "rigClothing", "rigCloth", "rigAccessories", "lock.rig"] as const) await t.test(setting, async child => {
    const f = fixture(child); f.input(); f.args.task.settings[setting] = true;
    const execute = createGraphicsAstraExecutor({ workerFactory: () => f.worker(task => {
      assert.match(task.prompt, /partsmith_feature/); return f.authored(task);
    }), runBlender: async (...args) => {
      await blenderMock(...args); const q = read(args[1].at(-1)!);
      if (q.mode === "validate") {
        const expected: Record<string, string> = { rigWings: "wings", rigClothing: "cloth", rigCloth: "cloth", rigAccessories: "accessories" };
        if (expected[setting]) assert.deepEqual(q.rigFeatures, [expected[setting]]);
        const report = read(q.report); report.checks.skeleton = false; write(q.report, report);
      }
    } });
    await assert.rejects(execute(f.args), /부속 관절|구조 잠금/);
  });
});

test("M15 explicit adopted part source takes priority over an adopted whole-image reference", async t => {
  const f = fixture(t, "M15"), part = f.input("design", ".png", "part-head");
  f.input("design", ".png", "main"); f.args.task.settings.sourceVersionId = part.version.id;
  let workers = 0;
  const execute = createGraphicsAstraExecutor({ runBlender: async (...args) => {
    const q = read(args[1].at(-1)!); assert.equal(q.sourceSha256, part.version.files[0].sha256);
    await blenderMock(...args);
    if (q.mode === "validate") { const report = read(q.report); report.checks.newGeometry = true; write(q.report, report); }
  }, workerFactory: () => f.worker(task => {
    workers++; assert(task.prompt.includes(`Source version: ${part.version.id}.`)); assert.equal(task.imagePaths.length, 2); return f.authored(task);
  }) });
  assert.equal((await execute(f.args)).role, "model"); assert.equal(workers, 1);
});

test("explicit recovery without a durable Astra dispatch cannot start preparation or a worker", async t => {
  const f = fixture(t); f.input(); f.args.recoveryOnly = true;
  let workers = 0, blenderCalls = 0;
  const execute = createGraphicsAstraExecutor({ workerFactory: () => { workers++; return f.worker(f.authored); }, runBlender: async (...args) => { blenderCalls++; await blenderMock(...args); } });
  await assert.rejects(execute(f.args), /복구에서 새 모델 호출/);
  assert.equal(workers, 0); assert.equal(blenderCalls, 0);
});

test("Astra uses requested model, inherited effort and copied original; verified recovery has no new worker", async t => {
  const f = fixture(t), source = f.input("model", ".fbx"); let calls = 0, validations = 0;
  const execute = createGraphicsAstraExecutor({ runBlender: async (...args) => { validations++; await blenderMock(...args); }, workerFactory: () => f.worker(task => {
    calls++;
    assert.equal(task.requestedModel, "gpt-6-astra"); assert.equal(task.connectedChrome, undefined);
    const command = codexArguments(task);
    assert.equal(command[command.indexOf("--model") + 1], "gpt-6-astra");
    assert(!command.some(value => /reasoning_effort|mcp_servers.*enabled=false/.test(value)));
    assert.match(task.prompt, /Generic skeleton/); assert.match(task.prompt, /No browser production, paid\/cloud service/);
    assert.match(task.prompt, /exact existing MESH object set/);
    assert.match(task.prompt, /control-widget, ground or helper meshes, even hidden/);
    assert.match(task.prompt, /armature\.data\.bones\[name\]\["partsmith_feature"\] \(not PoseBone properties\)/);
    assert.match(task.prompt, /measurable FK pose response/);
    assert.match(task.prompt, /IK\/CopyTransforms must not completely override/);
    assert.match(task.prompt, /source\.blend/); assert.match(task.prompt, /sourcePath-to-localPath/);
    assert.equal(hash(source.file), source.version.files[0].sha256);
    assert(task.referencePaths?.every(file => file !== source.file));
    task.onEvent({ type: "usage", usage: { input_tokens: 80, cached_input_tokens: 50, output_tokens: 20 } });
    return f.authored(task);
  }) });
  const result = await execute(f.args);
  assert.equal(result.role, "rig"); assert.equal(result.slot, "main"); assert.equal(result.files.length, 6);
  assert.equal(calls, 1); assert.equal(validations, 2);
  assert.deepEqual(await execute(f.args), result); assert.equal(calls, 1); assert.equal(validations, 2);
  assert.deepEqual(result.usage, { input_tokens: 80, cached_input_tokens: 50, output_tokens: 20 });
  assert.equal(hash(source.file), source.version.files[0].sha256);
});

test("saved scene and completion recover from transport error without authoring again", async t => {
  const f = fixture(t, "M05"); f.input("model", ".glb"); let calls = 0;
  const execute = createGraphicsAstraExecutor({ runBlender: blenderMock, workerFactory: () => f.worker(task => {
    calls++; write(task.resultPath, f.authored(task)); throw Error("transport disconnected after native save");
  }) });
  const result = await execute(f.args); assert.equal(result.role, "model");
  await execute(f.args); assert.equal(calls, 1);
});

test("failed native preview recovery retains partial GLB and uses a fresh derivative without another worker", async t => {
  const f = fixture(t, "M05"); f.input(); let calls = 0;
  const folders: string[] = [];
  const execute = createGraphicsAstraExecutor({ workerFactory: () => f.worker(task => { calls++; return f.authored(task); }), runBlender: async (...args) => {
    const q = read(args[1].at(-1)!);
    if (q.mode !== "validate") return blenderMock(...args);
    folders.push(q.output);
    assert.match(q.validatorFingerprint, /^[a-f0-9]{64}$/);
    if (folders.length === 1) { glb(path.join(q.output, "asset.glb")); throw Error("Render failed after immutable GLB export"); }
    assert.notEqual(q.output, folders[0]);
    await blenderMock(...args);
  } });
  await assert.rejects(execute(f.args), /Render failed/);
  const partial = path.join(folders[0], "asset.glb"), originalHash = hash(partial);
  f.args.recoveryOnly = true;
  const recovered = await execute(f.args);
  assert.equal(hash(partial), originalHash); assert.equal(calls, 1); assert.equal(folders.length, 2);
  assert.equal(recovered.files.find(file => file.kind === "model")?.path, path.relative(f.root, path.join(folders[1], "asset.glb")).split(path.sep).join("/"));
  await execute(f.args); assert.equal(calls, 1); assert.equal(folders.length, 2);
});

test("native scene without a completion message is validated locally and retains an explicit review warning", async t => {
  const f = fixture(t, "M05"); f.input(); let calls = 0;
  const execute = createGraphicsAstraExecutor({ runBlender: blenderMock, workerFactory: () => f.worker(task => {
    calls++; f.authored(task); throw Error("transport lost the final JSON message");
  }) });
  const result = await execute(f.args);
  assert(result.warnings.some(warning => /완료 메시지가 누락/.test(warning)));
  const proof = read(path.join(f.root, "graphics/jobs/task-1/astra/native-recovery.json"));
  assert.equal(proof.modelTurns, 0); assert.equal(proof.mode, "saved-blend-without-completion-message");
  await execute(f.args); assert.equal(calls, 1);
});

test("incomplete dispatch never repeats Astra, including after restart", async t => {
  const f = fixture(t); f.input(); let calls = 0;
  const deps = { runBlender: blenderMock, workerFactory: () => f.worker(() => { calls++; throw Error("disconnected"); }) };
  await assert.rejects(createGraphicsAstraExecutor(deps)(f.args), /disconnected/);
  await assert.rejects(createGraphicsAstraExecutor(deps)(f.args), /자동 재호출/);
  assert.equal(calls, 1);
});

test("unaccepted source, changed original and changed prepared copy stop before result registration", async t => {
  for (const variant of ["unaccepted", "original", "copy"] as const) await t.test(variant, async child => {
    const f = fixture(child), source = f.input(); let calls = 0;
    if (variant === "unaccepted") f.args.object.accepted = {};
    if (variant === "original") fs.appendFileSync(source.file, "modified");
    const execute = createGraphicsAstraExecutor({ runBlender: blenderMock, workerFactory: () => f.worker(task => {
      calls++; fs.appendFileSync(path.join(task.run.workspace, "source.blend"), "tampered"); return f.authored(task);
    }) });
    await assert.rejects(execute(f.args), variant === "unaccepted" ? /채택 원본/ : /입력 원본 또는 작업 사본/);
    assert.equal(calls, variant === "copy" ? 1 : 0);
  });
});

test("native Blender evidence cannot be replaced by a generic worker success JSON", async t => {
  for (const variant of ["weights", "nonce", "glb", "escape"] as const) await t.test(variant, async child => {
    const f = fixture(child); f.input(); let calls = 0;
    const execute = createGraphicsAstraExecutor({ workerFactory: () => f.worker(task => { calls++; return f.authored(task); }), runBlender: async (...args) => {
      await blenderMock(...args); const q = read(args[1].at(-1)!);
      if (q.mode !== "validate") return;
      const report = read(q.report);
      if (variant === "weights") report.checks.weights = false;
      if (variant === "nonce") report.nonce = "worker-invented";
      if (variant === "glb") fs.writeFileSync(path.join(q.output, "asset.glb"), "invented glb");
      if (variant === "escape") report.files[0] = q.outputBlend;
      write(q.report, report);
    } });
    await assert.rejects(execute(f.args), /검사|증거|GLB|폴더 밖/); assert.equal(calls, 1);
  });
});

test("N06 uses exact accepted animated clip, preserves prior scene and never starts from static rig", async t => {
  const f = fixture(t, "N06"), original = f.input("animation", ".blend", "Idle");
  f.input("rig"); let calls = 0;
  const execute = createGraphicsAstraExecutor({ runBlender: blenderMock, workerFactory: () => f.worker(task => {
    calls++; assert.match(task.prompt, /ANIMATION REVISION/); assert.match(task.prompt, /Do NOT start from a static rig/);
    assert.match(task.prompt, new RegExp("Source version: " + original.version.id));
    assert.match(task.prompt, /exact action name: "Idle"/); assert.match(task.prompt, /frames 1\.\.31/);
    assert.match(task.prompt, /both action and scene ranges must match these exact endpoints/);
    assert.match(task.prompt, /No F-curve modifiers, including CYCLES/);
    return f.authored(task);
  }) });
  const result = await execute(f.args); assert.equal(result.role, "animation"); assert.equal(result.slot, "Idle");
  assert.equal(calls, 1);
});

test("N04 requires accepted same-clip video, decoded frame hashes and explicit clip identity", async t => {
  const f = fixture(t, "N04"); f.input("rig");
  const reference = f.input("motion-reference", ".mp4", "Idle"), frame = path.join(f.root, "frame.png"), manifestPath = path.join(f.root, "motion-reference.json");
  const png = new PNG({ width: 8, height: 8 }); png.data.fill(190); fs.writeFileSync(frame, PNG.sync.write(png));
  const manifest = { schemaVersion: 1, source: "video-ai", clipName: "Idle", duration: 1, videos: { side: { path: path.basename(reference.file), sha256: hash(reference.file) } }, frames: [{ time: 0, side: path.basename(frame), sha256: hash(frame) }] };
  write(manifestPath, manifest);
  for (const [file, kind] of [[frame, "image"], [manifestPath, "frames"]]) reference.version.files.push({ path: path.basename(file), kind, sha256: hash(file), bytes: fs.statSync(file).size });
  let calls = 0, decodes = 0;
  const prepareMotionFrames: NonNullable<Parameters<typeof createGraphicsAstraExecutor>[0]>["prepareMotionFrames"] = async options => {
    decodes++; assert.equal(options.source.sha256, hash(reference.file)); assert.equal(options.maxFrames, 240);
    const dir = options.outputDirectory; fs.mkdirSync(dir, { recursive: true });
    const frames = Array.from({ length: 4 }, (_, index) => {
      const local = path.join(dir, `${index}.png`); fs.copyFileSync(frame, local);
      return { path: path.relative(f.root, local), sha256: hash(local), bytes: fs.statSync(local).size, kind: "image", index, pts: index, time: index / 4, relativeTime: index / 4, duration: 0.25, width: 8, height: 8 };
    });
    const indexFile = path.join(dir, "native-frames.json"); write(indexFile, { frames });
    return { source: options.source, frames, manifest: { path: path.relative(f.root, indexFile), sha256: hash(indexFile), bytes: fs.statSync(indexFile).size, kind: "report" }, timeBase: { numerator: 1, denominator: 4 }, nativeFrameRate: { numerator: 4, denominator: 1 }, durationSeconds: 1, framePaths: frames.map(item => path.join(f.root, item.path)) };
  };
  const execute = createGraphicsAstraExecutor({ runBlender: blenderMock, prepareMotionFrames, workerFactory: () => f.worker(task => {
    calls++; assert.match(task.prompt, /ORIGINAL VIDEO AND decoded frames/); assert.match(task.prompt, /ALL native frames/);
    assert.equal(task.imagePaths.length, 4); assert.ok(task.imagePaths.every(file => fs.existsSync(path.resolve(task.run.workspace, file))));
    assert.match(task.prompt, /Native video FPS is distinct from requested 3D FPS/);
    const index = read(path.join(task.run.workspace, "motion-input.json"));
    assert.equal(index.views[0].frameCount, 4); assert.equal(index.views[0].originalSha256, hash(reference.file));
    assert.equal(index.views[0].nativeFrameRate.numerator, 4);
    return f.authored(task);
  }) });
  delete f.args.object.accepted["motion-reference:Idle"];
  await assert.rejects(execute(f.args), /같은 클립 이름/); assert.equal(calls, 0);
  f.args.object.accepted["motion-reference:Idle"] = reference.version.id;
  const failedDecode = createGraphicsAstraExecutor({ runBlender: blenderMock,
    prepareMotionFrames: async () => { throw Error("native frame decode incomplete"); },
    workerFactory: () => { throw Error("must not start inference"); } });
  await assert.rejects(failedDecode(f.args), /native frame decode incomplete/);
  assert.equal(fs.existsSync(path.join(f.root, "graphics/jobs/task-1/astra/dispatch.json")), false);
  const result = await execute(f.args); assert.equal(result.slot, "Idle"); assert.equal(calls, 1); assert.equal(decodes, 1);
  assert.ok(result.files.some(file => file.path.endsWith("motion-input.json")));
  await execute({ ...f.args, recoveryOnly: true }); assert.equal(calls, 1); assert.equal(decodes, 1);
  // A later revision retains this exact original reference even after another
  // reference becomes accepted for the clip. The source lineage is authoritative.
  const animated = f.input("animation", ".blend", "Idle");
  animated.version.sourceVersionIds.push(reference.version.id);
  f.args.task.id = "revision-2"; f.args.task.taskId = "N06";
  f.args.object.accepted["motion-reference:Idle"] = "a-newer-unrelated-reference";
  const revise = createGraphicsAstraExecutor({ runBlender: blenderMock, prepareMotionFrames, workerFactory: () => f.worker(task => {
    calls++; assert.match(task.prompt, /Retained accepted video/); assert.match(task.prompt, new RegExp(reference.version.id));
    assert.equal(task.imagePaths.length, 4); return f.authored(task);
  }) });
  assert.equal((await revise(f.args)).slot, "Idle"); assert.equal(calls, 2);
});

const blender = process.env.PARTSMITH_TEST_BLENDER ?? "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe";
function localPython(root: string, name: string, source: string, input?: string) {
  const script = path.join(root, name + ".py"); fs.writeFileSync(script, source);
  const result = spawnSync(blender, ["--background", ...(input ? [input] : ["--factory-startup"]), "--disable-autoexec", "--python-exit-code", "1", "--python", script], { windowsHide: true, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stdout.slice(-3000) + result.stderr.slice(-2000));
}

test("actual Blender independently checks native edited blend, weighted rig and revision action; worker boundary is synthetic", { skip: !fs.existsSync(blender), timeout: 180_000 }, async t => {
  const f = fixture(t, "N06"), original = f.input("animation", ".blend", "Idle"); f.args.blenderPath = blender;
  localPython(f.root, "fixture", `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add(size=1)\nmesh=bpy.context.object\nmesh.name='OriginalMesh'\nmesh['partsmith_id']='retained-mesh'\nbpy.ops.object.armature_add()\nrig=bpy.context.object\nrig.name='OriginalRig'\nbpy.ops.object.mode_set(mode='EDIT')\nroot=rig.data.edit_bones[0]\nroot.name='root'\nchild=rig.data.edit_bones.new('joint')\nchild.head=(0,0,1)\nchild.tail=(0,0,2)\nchild.parent=root\ntip=rig.data.edit_bones.new('tip')\ntip.head=(0,0,2)\ntip.tail=(0,0,3)\ntip.parent=child\nbpy.ops.object.mode_set(mode='OBJECT')\nmod=mesh.modifiers.new('ActualSkin','ARMATURE')\nmod.object=rig\ngroup=mesh.vertex_groups.new(name='joint')\ngroup.add(list(range(len(mesh.data.vertices))),1,'REPLACE')\nbone=rig.pose.bones['joint']\nbone.rotation_mode='QUATERNION'\nfrom mathutils import Quaternion,Vector\nfor frame,angle in [(1,0),(16,0.2),(31,0)]:\n bone.rotation_quaternion=Quaternion(Vector((0,1,0)),angle)\n bone.keyframe_insert('rotation_quaternion',frame=frame)\nrig.animation_data.action.name='Idle'\nkeep=rig.animation_data.action.copy()\nkeep.name='UntargetedWalk'\nkeep.use_fake_user=True\nscene=bpy.context.scene\nscene.frame_start=1\nscene.frame_end=31\nscene.render.fps=30\nscene.frame_set(1)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(original.file)},compress=False)\n`);
  const nativeActionName = "Armature|대기 001.001";
  localPython(f.root, "native-action-name", `import bpy\nbpy.data.actions['Idle'].name=${JSON.stringify(nativeActionName)}\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(original.file)},compress=False)\n`, original.file);
  original.version.slot = nativeActionName; f.args.object.accepted = { ["animation:" + nativeActionName]: original.version.id }; f.args.task.settings.clipName = nativeActionName;
  original.refresh(); const originalHash = hash(original.file); let calls = 0;
  const execute = createGraphicsAstraExecutor({ workerFactory: () => f.worker(task => {
    calls++;
    const sourceBlend = path.join(task.run.workspace, "source.blend"), output = path.join(task.run.workspace, "outputs/asset.blend");
    localPython(f.root, "synthetic-revision", `import bpy\nfrom mathutils import Quaternion,Vector\nrig=bpy.data.objects['OriginalRig']\nbone=rig.pose.bones['joint']\nbone.rotation_quaternion=Quaternion(Vector((0,1,0)),0.45)\nbone.keyframe_insert('rotation_quaternion',frame=16)\nbpy.context.scene.frame_set(1)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(output)},compress=False)\n`, sourceBlend);
    return { status: "completed", summary: "Synthetic native scene edit; no Astra called", blendPath: "outputs/asset.blend", warnings: [] };
  }) });
  const result = await execute(f.args);
  const report = read(path.join(f.root, result.files.find(file => file.kind === "report")!.path));
  assert.equal(report.checks.weights, true); assert.equal(report.meshes[0].weightedVertices, 8);
  assert(report.deformingMeshIds.includes("retained-mesh")); assert(report.clip.movingBones.includes("OriginalRig/joint"));
  assert.equal(report.checks.actionsPreserved, true); assert.equal(report.clip.frameRange[1], 31);
  assert.equal(result.slot, nativeActionName); assert(report.actions.some((action: { name: string }) => action.name === nativeActionName));
  assert(report.files.includes("asset.glb")); assert.equal(report.unityPlaybackVerified, false);
  assert(Array.isArray(report.glbImages));
  assert.equal(report.validatorFingerprint, createHash("sha256").update(hash(path.resolve("integrations/blender/graphics_astra_validate.py")) + hash(path.resolve("integrations/blender/graphics_glb.py")) + hash(path.resolve("integrations/blender/graphics_humanoid.py"))).digest("hex"));
  const nativeGlb = fs.readFileSync(path.join(f.root, result.files.find(file => file.kind === "model")!.path));
  const gltf = JSON.parse(nativeGlb.toString("utf8", 20, 20 + nativeGlb.readUInt32LE(12)).trim());
  assert((gltf.images ?? []).every((image: { uri?: string }) => image.uri === undefined));
  assert.equal(hash(original.file), originalHash); assert.equal(calls, 1);
  await execute(f.args); assert.equal(calls, 1);
  const invalidBlend = path.join(f.root, "invalid-weights.blend");
  localPython(f.root, "invalid-weights", `import bpy\nmesh=bpy.data.objects['OriginalMesh']\nmesh.vertex_groups.clear()\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(invalidBlend)},compress=False)\n`, path.join(f.root, result.files.find(file => file.kind === "blend")!.path));
  const validateSpec = read(path.join(f.root, "graphics/jobs/task-1/astra/validate-request.json"));
  validateSpec.outputBlend = invalidBlend; validateSpec.report = path.join(f.root, "must-not-exist.json");
  const specPath = path.join(f.root, "invalid-request.json"); write(specPath, validateSpec);
  const rejected = spawnSync(blender, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", path.resolve("integrations/blender/graphics_astra_validate.py"), "--", specPath], { windowsHide: true, encoding: "utf8", timeout: 120_000 });
  assert.equal(rejected.status, 1); assert.match(rejected.stdout + rejected.stderr, /unweighted vertices or invalid\/non-normalized/);
  assert(!fs.existsSync(validateSpec.report)); assert.equal(hash(original.file), originalHash);
});

test("actual imported Blender scene with no matching action stops in native preparation before any Astra worker", { skip: !fs.existsSync(blender), timeout: 60_000 }, async t => {
  const f=fixture(t,"N06"),original=f.input("animation",".blend","Idle");f.args.blenderPath=blender;
  localPython(f.root,"no-matching-action",`import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()\nbpy.ops.object.armature_add()\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(original.file)},compress=False)\n`);
  original.refresh();const originalHash=hash(original.file);let workers=0;
  const execute=createGraphicsAstraExecutor({workerFactory:()=>{workers++;return f.worker(f.authored);}});
  await assert.rejects(execute(f.args),/does not contain the exact action/);
  assert.equal(workers,0);assert.equal(hash(original.file),originalHash);
  assert(!fs.existsSync(path.join(f.root,"graphics/jobs/task-1/astra/dispatch.json")));
});

test("actual FBX preparation stages long Windows paths with exact companion bytes and packed original texture", { skip: !fs.existsSync(blender), timeout: 90_000 }, async t => {
  const f=fixture(t,"M05"),original=f.input("model",".fbx");f.args.blenderPath=blender;
  const texture=path.join(f.root,"native-texture.png"),png=new PNG({width:32,height:32});png.data.fill(190);fs.writeFileSync(texture,PNG.sync.write(png));
  localPython(f.root,"export-native-fbx",`import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add(size=1)\nmesh=bpy.context.object\nmaterial=bpy.data.materials.new('PreservedMaterial')\nmaterial.use_nodes=True\nnode=material.node_tree.nodes.new('ShaderNodeTexImage')\nnode.image=bpy.data.images.load(${JSON.stringify(texture)})\nmaterial.node_tree.links.new(node.outputs['Color'],material.node_tree.nodes['Principled BSDF'].inputs['Base Color'])\nmesh.data.materials.append(material)\nbpy.ops.export_scene.fbx(filepath=${JSON.stringify(original.file)},use_selection=True,path_mode='RELATIVE',embed_textures=False,add_leaf_bones=False)\n`);
  const deep=path.join(f.root,...Array.from({length:7},(_,index)=>`project-directory-${index}-with-preserved-native-assets`));
  fs.mkdirSync(path.join(deep,"originals"),{recursive:true});
  const sourcePath=path.join(deep,"originals/model.fbx"),texturePath=path.join(deep,"originals/native-texture.png");
  fs.copyFileSync(original.file,sourcePath);fs.copyFileSync(texture,texturePath);assert(sourcePath.length>300);
  original.version.files=[{path:"originals/model.fbx",kind:"model",sha256:hash(sourcePath),bytes:fs.statSync(sourcePath).size},{path:"originals/native-texture.png",kind:"image",sha256:hash(texturePath),bytes:fs.statSync(texturePath).size}];
  f.args.projectRoot=deep;f.args.workspacePath=path.join(deep,"graphics/workspace.json");
  let stage="",workerBoundary=0;
  const execute=createGraphicsAstraExecutor({runBlender:async(executable,args)=>{
    const spec=read(args.at(-1)!);assert.equal(spec.mode,"prepare");stage=path.dirname(spec.source);
    assert(spec.source.length<240);assert(spec.outputBlend.length<240);assert(args.at(-1)!.length<240);
    const output=spawnSync(executable,args,{windowsHide:true,encoding:"utf8",timeout:60_000});
    assert.equal(output.status,0,output.stdout.slice(-2500)+output.stderr.slice(-2500));
  },workerFactory:()=>f.worker(task=>{
    workerBoundary++;assert(fs.existsSync(path.join(task.run.workspace,"source.blend")));
    const baseline=read(path.join(deep,"graphics/jobs/task-1/astra/baseline.json"));
    assert.equal(baseline.sourceSha256,hash(sourcePath));assert.equal(baseline.textures.length,1);
    assert.deepEqual(baseline.textures[0].size,[32,32]);assert.equal(baseline.textures[0].sha256,hash(texturePath));
    throw Error("Synthetic authoring boundary stop; no actual Astra");
  })});
  await assert.rejects(execute(f.args),/Synthetic authoring boundary stop/);
  assert.equal(workerBoundary,1);assert(!fs.existsSync(stage));
  assert.equal(hash(sourcePath),hash(original.file));assert.equal(hash(texturePath),hash(texture));
});
