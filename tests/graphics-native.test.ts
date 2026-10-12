import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { createGraphicsNativeExecutor, type GraphicsNativeArgs } from "../engine/graphics-native";
import { codexArguments, type ProductionWorker, type WorkerTask } from "../engine/codex-worker";
import type { AssetVersion } from "../shared/graphics";

const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function png(file: string, color = 91) {
  const image = new PNG({ width: 8, height: 8 });
  image.data.fill(color);
  for (let index = 3; index < image.data.length; index += 4) image.data[index] = 255;
  fs.writeFileSync(file, PNG.sync.write(image));
}
function fixture(t: any, taskId = "I01") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args: GraphicsNativeArgs = {
    projectRoot: root, workspacePath: path.join(root, "graphics-workspace.json"),
    object: { id: "object-1", name: "Greatsword", kind: "weapon", createdAt: "2026-10-12", selectedTasks: [taskId], instruction: "A matching greatsword", settings: {}, references: [], accepted: {} },
    task: { id: "task-1", objectId: "object-1", taskId, createdAt: "2026-10-12", updatedAt: "2026-10-12", status: "running", inputVersionIds: [], settings: {}, instruction: "A matching greatsword", requestHash: "frozen-request", outputVersionIds: [], backendJobIds: [], message: "", localOnly: false },
    inputs: [], blenderPath: process.execPath, resources: path.resolve("integrations"), signal: new AbortController().signal, onProgress: () => {},
  };
  function addInput(extension = ".png", kind = "image") {
    const source = path.join(root, "source" + extension);
    if (extension === ".png") png(source, 21); else fs.writeFileSync(source, "mock original scene");
    const version: AssetVersion = { id: "version-1", objectId: "object-1", role: kind === "image" ? "design" : "model", slot: "main", label: "Original", createdAt: "2026-10-12", sourceVersionIds: [], provenance: { type: "import" }, warnings: [], files: [{ path: path.basename(source), kind, bytes: fs.statSync(source).size, sha256: hash(source) }] };
    args.inputs.push(version); args.task.inputVersionIds.push(version.id);
    return source;
  }
  return { root, args, addInput };
}
function workerMock(run: (task: WorkerTask) => Promise<unknown> | unknown): ProductionWorker {
  return { probe: async () => { throw Error("No probe should imply image availability"); }, run: async task => ({ result: await run(task) }) };
}
function generated(task: WorkerTask, views = ["image-1"], options: { event?: boolean; claimPath?: string; duplicate?: boolean } = {}) {
  const images = views.map((view, index) => {
    const file = path.join(task.run.workspace, view + ".png"); png(file, options.duplicate ? 91 : 91 + index);
    return { path: path.basename(file), nativePath: options.claimPath ?? file, view };
  });
  if (options.event !== false) fs.writeFileSync(path.join(task.run.workspace, "codex-events.jsonl"), images.map(image => JSON.stringify({ type: "item.completed", item: { type: "image_generation", status: "completed", output_path: path.resolve(task.run.workspace, image.path) } })).join("\n") + "\n");
  return { status: "completed", summary: "Done", images, warnings: [] };
}

test("native image uses original bytes, inherited model/effort, native events and project-owned originals", async t => {
  const f = fixture(t, "I02"), original = f.addInput();
  let calls = 0;
  const execute = createGraphicsNativeExecutor({ workerFactory: () => workerMock(task => {
    calls++;
    assert.equal(task.imageBackend, "codex");
    assert.equal(task.connectedChrome, undefined);
    assert.equal(task.requestedModel, undefined);
    const cli = codexArguments(task);
    assert(!cli.includes("--model"));
    assert(!cli.includes("features.image_generation=false"));
    assert(!cli.some(item => /mcp_servers.*enabled=false/.test(item)));
    assert.equal(task.imagePaths.length, 1);
    assert.notEqual(task.imagePaths[0], original);
    assert.equal(hash(task.imagePaths[0]), hash(original));
    assert.match(task.prompt, /weapons\/props/);
    task.onEvent({ type: "turn.completed", usage: { input_tokens: 200, cached_input_tokens: 120, output_tokens: 40 } });
    return generated(task);
  }) });
  const result = await execute(f.args);
  assert.equal(calls, 1);
  assert.equal(result.role, "design");
  assert.equal(result.files.length, 1);
  assert(!path.isAbsolute(result.files[0].path));
  assert(fs.existsSync(path.join(f.root, result.files[0].path)));
  assert.deepEqual(result.usage, { input_tokens: 200, cached_input_tokens: 120, output_tokens: 40 });
  assert.deepEqual(await execute(f.args), result);
  assert.equal(calls, 1, "checkpoint recovery must not dispatch another generation");
});

test("agent completion claims without native image events fail and never trigger a second generation", async t => {
  const f = fixture(t); let calls = 0;
  const execute = createGraphicsNativeExecutor({ workerFactory: () => workerMock(task => { calls++; return generated(task, ["image-1"], { event: false }); }) });
  await assert.rejects(execute(f.args), /네이티브 이미지 도구 실행 기록/);
  await assert.rejects(execute(f.args), /네이티브 이미지 도구 실행 기록/);
  assert.equal(calls, 1);
});

test("native source path must actually appear in the native event and match the copied bytes", async t => {
  const f = fixture(t);
  const original = f.addInput();
  const execute = createGraphicsNativeExecutor({ workerFactory: () => workerMock(task => generated(task, ["image-1"], { claimPath: original })) });
  await assert.rejects(execute(f.args), /원본 경로·해시/);
});

test("a native tool argument path is not proof that its output was generated", async t => {
  const f = fixture(t);
  const execute = createGraphicsNativeExecutor({ workerFactory: () => workerMock(task => {
    const result = generated(task, ["image-1"], { event: false });
    fs.writeFileSync(path.join(task.run.workspace, "codex-events.jsonl"), JSON.stringify({ type: "item.completed", item: { type: "image_generation", status: "completed", arguments: { output_path: result.images[0].nativePath } } }) + "\n");
    return result;
  }) });
  await assert.rejects(execute(f.args), /원본 경로·해시/);
});

test("saved originals recover locally even if transport fails after their native completion", async t => {
  const f = fixture(t); let calls = 0;
  const execute = createGraphicsNativeExecutor({ workerFactory: () => workerMock(task => {
    calls++; fs.writeFileSync(task.resultPath, JSON.stringify(generated(task)));
    throw Error("transport disconnected after saved originals");
  }) });
  const result = await execute(f.args);
  assert.equal(result.files.length, 1);
  assert.equal(calls, 1);
  await execute(f.args);
  assert.equal(calls, 1);
});

const savedThreadId = "01a13092-cd87-7db3-86d0-7734bd5c72a7";
function savedNativeThread(task: WorkerTask, native: string) {
  const result = generated(task, ["image-1"], { event: false, claimPath: native });
  fs.copyFileSync(path.join(task.run.workspace, result.images[0].path), native);
  // Actual exec JSON omits imageGeneration, while its read-only rollout retains it.
  fs.writeFileSync(path.join(task.run.workspace, "codex-events.jsonl"), JSON.stringify({ type: "thread.started", thread_id: savedThreadId }) + "\n");
  const thread = { id: savedThreadId, cwd: task.run.workspace, turns: [{ items: [{
    type: "imageGeneration", id: "exec-native-image", status: "completed", failure: null,
    savedPath: native, result: fs.readFileSync(native).toString("base64"),
  }] }] };
  return { result, response: { thread } };
}

test("omitted exec image event recovers one original via exact native thread bytes without another generation", async t => {
  const f = fixture(t), native = path.join(f.root, "native-original.png");
  let calls = 0, reads = 0, response: any;
  const execute = createGraphicsNativeExecutor({
    workerFactory: () => workerMock(task => {
      calls++; const saved = savedNativeThread(task, native); response = saved.response;
      fs.writeFileSync(task.resultPath, JSON.stringify(saved.result));
      throw Error("transport ended after the native original completed");
    }),
    readNativeThread: async (threadId, signal) => {
      reads++; assert.equal(threadId, savedThreadId); assert.equal(signal, f.args.signal);
      return response;
    },
  });
  const result = await execute(f.args);
  assert.equal(calls, 1); assert.equal(reads, 1);
  assert.equal(hash(path.join(f.root, result.files[0].path)), hash(native));
  const evidence = fs.readFileSync(path.join(f.root, "graphics/jobs/task-1/native-provenance.json"), "utf8");
  const proof = JSON.parse(evidence);
  assert.equal(proof.source, "codex-app-server-thread-read");
  assert.equal(proof.threadId, savedThreadId); assert.equal(proof.modelTurns, 0);
  assert.equal(proof.images[0].sha256, hash(native));
  assert.equal(proof.images[0].savedPath, native);
  assert(!evidence.includes(response.thread.turns[0].items[0].result), "raw native base64 must never enter the persisted host proof");
  assert.deepEqual(await execute(f.args), result);
  assert.equal(calls, 1); assert.equal(reads, 1, "verified checkpoint needs no extra thread query");
});

test("thread fallback rejects a different thread, different job cwd, or failed native item and never redispatches", async t => {
  for (const variant of ["thread", "cwd", "failed"] as const) await t.test(variant, async subtest => {
    const f = fixture(subtest), native = path.join(f.root, "native-original.png");
    let calls = 0, response: any;
    const execute = createGraphicsNativeExecutor({
      workerFactory: () => workerMock(task => {
        calls++; const saved = savedNativeThread(task, native); response = saved.response;
        if (variant === "thread") response.thread.id = "different-thread";
        if (variant === "cwd") response.thread.cwd = f.root;
        if (variant === "failed") response.thread.turns[0].items[0].failure = "native failure";
        return saved.result;
      }), readNativeThread: async () => response,
    });
    const rejection = variant === "failed" ? /성공한 네이티브 이미지/ : /thread ID 또는 작업 폴더/;
    await assert.rejects(execute(f.args), rejection);
    await assert.rejects(execute(f.args), rejection);
    assert.equal(calls, 1); assert.equal(hash(native), hash(path.join(f.root, "graphics/jobs/task-1/work/image-1.png")));
    assert(!fs.existsSync(path.join(f.root, "graphics/jobs/task-1/checkpoint.json")));
  });
});

test("native thread decoded bytes and registered work copy must independently match the saved original", async t => {
  for (const variant of ["decoded-result", "work-copy", "invalid-base64"] as const) await t.test(variant, async subtest => {
    const f = fixture(subtest), native = path.join(f.root, "native-original.png");
    let calls = 0, response: any;
    const execute = createGraphicsNativeExecutor({
      workerFactory: () => workerMock(task => {
        calls++; const saved = savedNativeThread(task, native); response = saved.response;
        const item = response.thread.turns[0].items[0];
        if (variant === "decoded-result") item.result = Buffer.from("different native image bytes").toString("base64");
        if (variant === "work-copy") png(path.join(task.run.workspace, "image-1.png"), 12);
        if (variant === "invalid-base64") item.result = "invalid!";
        return saved.result;
      }), readNativeThread: async () => response,
    });
    await assert.rejects(execute(f.args), /SHA256|원본 경로|응답 바이트/);
    await assert.rejects(execute(f.args));
    assert.equal(calls, 1); assert(fs.existsSync(native));
    assert(!fs.existsSync(path.join(f.root, "graphics/jobs/task-1/native-provenance.json")));
  });
});

test("untrusted agent thread claim and ambiguous thread starts never query another native rollout", async t => {
  for (const variant of ["agent-claim", "multiple-starts"] as const) await t.test(variant, async subtest => {
    const f = fixture(subtest); let reads = 0;
    const execute = createGraphicsNativeExecutor({
      workerFactory: () => workerMock(task => {
        const result = generated(task, ["image-1"], { event: false });
        const events = variant === "agent-claim"
          ? [{ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ type: "thread.started", thread_id: savedThreadId }) } }]
          : [{ type: "thread.started", thread_id: savedThreadId }, { type: "thread.started", thread_id: "01a13092-cd87-7db3-86d0-7734bd5c72a8" }];
        fs.writeFileSync(path.join(task.run.workspace, "codex-events.jsonl"), events.map(event => JSON.stringify(event)).join("\n"));
        return result;
      }), readNativeThread: async () => { reads++; throw Error("Must not query an untrusted thread"); },
    });
    await assert.rejects(execute(f.args), /텍스트 완료 응답만으로/);
    assert.equal(reads, 0);
  });
});

test("cancel during read-only native recovery preserves the original without a checkpoint", async t => {
  const f = fixture(t), native = path.join(f.root, "native-original.png"), controller = new AbortController();
  f.args.signal = controller.signal;
  let response: any, calls = 0;
  const execute = createGraphicsNativeExecutor({
    workerFactory: () => workerMock(task => { calls++; const saved = savedNativeThread(task, native); response = saved.response; return saved.result; }),
    readNativeThread: async () => { controller.abort(); return response; },
  });
  await assert.rejects(execute(f.args), { name: "AbortError" });
  assert.equal(calls, 1); assert(fs.existsSync(native));
  assert(!fs.existsSync(path.join(f.root, "graphics/jobs/task-1/checkpoint.json")));
});

test("incomplete native run cannot be implicitly retried", async t => {
  const f = fixture(t); let calls = 0;
  const execute = createGraphicsNativeExecutor({ workerFactory: () => workerMock(() => { calls++; throw Error("native unavailable"); }) });
  await assert.rejects(execute(f.args), /native unavailable/);
  await assert.rejects(execute(f.args), /새 요청을 보내지 않습니다/);
  assert.equal(calls, 1);
});

test("corrupted saved original fails closed rather than generating another version", async t => {
  const f = fixture(t); let calls = 0;
  const execute = createGraphicsNativeExecutor({ workerFactory: () => workerMock(task => { calls++; return generated(task); }) });
  const result = await execute(f.args);
  fs.writeFileSync(path.join(f.root, result.files[0].path), "corrupt");
  await assert.rejects(execute(f.args), /저장된 그래픽 결과가 변경/);
  assert.equal(calls, 1);
});

test("different frozen request cannot reuse an existing dispatched job", async t => {
  const f = fixture(t); let calls = 0;
  const execute = createGraphicsNativeExecutor({ workerFactory: () => workerMock(task => { calls++; return generated(task); }) });
  await execute(f.args);
  f.args.task.instruction = "Different paid request";
  await assert.rejects(execute(f.args), /요청 정보가 다릅니다/);
  assert.equal(calls, 1);
});

test("input hash changes block execution before a worker is created", async t => {
  const f = fixture(t, "I02"), original = f.addInput();
  let called = false;
  const execute = createGraphicsNativeExecutor({ workerFactory: () => { called = true; throw Error("must not execute"); } });
  fs.appendFileSync(original, "changed");
  await assert.rejects(execute(f.args), /해시가 변경/);
  assert.equal(called, false);
});

test("multiple image candidates require unique original files without implying a turnaround", async t => {
  const f = fixture(t, "I03"); f.addInput();
  f.args.task.settings.count = 2;
  const execute = createGraphicsNativeExecutor({ workerFactory: () => workerMock(task => {
    assert.match(task.prompt, /EDIT EXISTING IMAGE/);
    return generated(task, ["image-1", "image-2"], { duplicate: true });
  }) });
  await assert.rejects(execute(f.args), /복제한 결과/);
  assert(fs.existsSync(path.join(f.root, "graphics/jobs/task-1/work/image-1.png")), "keep partial genuine originals for inspection");
});

test("abort after native output preserves files without marking a successful review", async t => {
  const f = fixture(t), controller = new AbortController(); f.args.signal = controller.signal;
  const execute = createGraphicsNativeExecutor({ workerFactory: () => workerMock(task => { const result = generated(task); controller.abort(); return result; }) });
  await assert.rejects(execute(f.args), /중지했습니다/);
  assert(!fs.existsSync(path.join(f.root, "graphics/jobs/task-1/checkpoint.json")));
});

test("local transform freezes exact settings, preserves source, and reuses verified exports without AI", async t => {
  const f = fixture(t, "A05"), original = f.addInput(".blend", "blend"), originalHash = hash(original);
  f.args.task.settings = { scale: 2.5, pivot: "bottom" };
  let calls = 0;
  const execute = createGraphicsNativeExecutor({ workerFactory: () => { throw Error("AI must not run"); }, runBlender: async (_exe, command) => {
    calls++;
    assert(command.includes("--disable-autoexec"));
    const spec = JSON.parse(fs.readFileSync(command.at(-1)!, "utf8"));
    assert.equal(spec.source, original); assert.equal(spec.scale, 2.5); assert.equal(spec.pivot, "bottom");
    for (const file of ["asset.blend", "asset.glb", "asset.fbx"]) fs.writeFileSync(path.join(spec.output, file), "mock local output " + file);
    fs.writeFileSync(path.join(spec.output, "report.json"), JSON.stringify({ identity: spec.identity, operation: "A05", originalPreserved: true, sourceSha256: originalHash, files: ["asset.blend", "asset.glb", "asset.fbx"], warnings: [] }));
  } });
  const result = await execute(f.args);
  assert.equal(hash(original), originalHash);
  assert.equal(result.files.length, 4);
  assert(result.warnings.some(value => /재생 검증/.test(value)));
  await execute(f.args);
  assert.equal(calls, 1);
});

test("real Blender applies exact uniform scale and bottom pivot into new immutable exports", { timeout: 120_000 }, async t => {
  const blender = process.env.PARTSMITH_TEST_BLENDER;
  if (!blender || !fs.existsSync(blender)) { t.skip("Set PARTSMITH_TEST_BLENDER for real local Blender verification"); return; }
  const f = fixture(t, "A05"), original = f.addInput(".blend", "blend");
  f.args.blenderPath = blender;
  f.args.task.settings = { scale: 2.5, pivot: "bottom" };
  const setup = path.join(f.root, "setup.py");
  fs.writeFileSync(setup, [
    "import bpy,json,sys",
    "bpy.ops.wm.read_factory_settings(use_empty=True)",
    "bpy.ops.mesh.primitive_cube_add(size=2, location=(3,4,5))",
    "bpy.context.object.name='SyntheticCube'",
    "bpy.ops.wm.save_as_mainfile(filepath=sys.argv[sys.argv.index('--')+1], compress=False)",
  ].join("\n"));
  const prepared = spawnSync(blender, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", setup, "--", original], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
  assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
  f.args.inputs[0].files[0].bytes = fs.statSync(original).size;
  f.args.inputs[0].files[0].sha256 = hash(original);
  const originalHash = hash(original);
  const execute = createGraphicsNativeExecutor({ workerFactory: () => { throw Error("Local operation cannot dispatch a worker"); } });
  const result = await execute(f.args);
  assert.equal(hash(original), originalHash);
  assert.equal(result.files.length, 4);
  const outputBlend = path.join(f.root, result.files.find(file => file.kind === "blend")!.path);
  const inspection = path.join(f.root, "inspect.py"), measured = path.join(f.root, "measured.json");
  fs.writeFileSync(inspection, [
    "import bpy,json,sys",
    "from mathutils import Vector",
    "args=sys.argv[sys.argv.index('--')+1:]",
    "bpy.ops.wm.open_mainfile(filepath=args[0],load_ui=False,use_scripts=False)",
    "points=[obj.matrix_world @ Vector(corner) for obj in bpy.context.scene.objects if obj.type=='MESH' for corner in obj.bound_box]",
    "bounds={'min':[min(p[i] for p in points) for i in range(3)],'max':[max(p[i] for p in points) for i in range(3)]}",
    "open(args[1],'w').write(json.dumps(bounds))",
  ].join("\n"));
  const inspected = spawnSync(blender, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", inspection, "--", outputBlend, measured], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
  assert.equal(inspected.status, 0, inspected.stderr + inspected.stdout);
  const bounds = JSON.parse(fs.readFileSync(measured, "utf8"));
  assert.deepEqual(bounds.min, [-2.5, -2.5, 0]);
  assert.deepEqual(bounds.max, [2.5, 2.5, 5]);
  const glb = fs.readFileSync(path.join(f.root, result.files.find(file => file.kind === "model")!.path));
  assert.equal(glb.toString("ascii", 0, 4), "glTF");
  assert.equal(glb.readUInt32LE(8), glb.length);
  const fbx = fs.readFileSync(path.join(f.root, result.files.find(file => file.kind === "fbx")!.path));
  assert.match(fbx.toString("ascii", 0, 23), /^Kaydara FBX Binary/);
  assert.deepEqual(await execute(f.args), result);
});

test("local export rejects unknown settings and unsafe report paths", async t => {
  const f = fixture(t, "X04"); f.addInput(".blend", "blend");
  f.args.task.settings.exportFormat = "unknown";
  const execute = createGraphicsNativeExecutor({ runBlender: async (_exe, command) => {
    const spec = JSON.parse(fs.readFileSync(command.at(-1)!, "utf8"));
    fs.writeFileSync(path.join(spec.output, "report.json"), JSON.stringify({ identity: spec.identity, operation: "X04", originalPreserved: true, files: ["asset.blend", "asset.glb", "asset.fbx", "../../source.blend"] }));
  } });
  await assert.rejects(execute(f.args), /설정/);
  f.args.task.settings.exportFormat = "both";
  await assert.rejects(execute(f.args));
});
