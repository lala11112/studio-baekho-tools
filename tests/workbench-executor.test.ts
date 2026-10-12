import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import {
  CodexWorkbenchExecutor,
  classifyWorkbenchFailure,
  type WorkbenchServices,
} from "../engine/workbench-executor";
import {
  codexArguments,
  type ProductionWorker,
  type WorkerTask,
  type StageReceipt,
} from "../engine/codex-worker";
import type {
  WorkbenchExecutionContext,
  WorkbenchResult,
  WorkbenchStep,
} from "../shared/workbench";
import { buildWorkbenchGlb } from "./fixtures/workbench-glb";
import { inspectWorkbenchGlb } from "../engine/glb-inspect";

const digest = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function partOutput(task: WorkerTask): WorkbenchResult {
  const [role, view] = task.stage.id.replace("separate-", "").split("-") as [
    string,
    "front" | "back" | "left" | "right" | undefined,
  ];
  const folder = path
    .dirname(path.relative(task.run.workspace, task.resultPath))
    .replaceAll("\\", "/");
  const image = `${folder}/${role}.png`;
  // Explicit signature fixture only; no generated-image quality assertion.
  fs.writeFileSync(
    path.join(task.run.workspace, image),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from(`offline fixture ${role} ${view ?? "front"}`),
    ]),
  );
  return {
    status: "completed",
    summary: "Offline part fixture",
    candidates: [
      {
        id: role,
        label: role,
        artifacts: [{ path: image, kind: "image", role, view }],
        objects: [],
      },
    ],
    checks: [],
  };
}
class Worker implements ProductionWorker {
  calls: WorkerTask[] = [];
  receipts = new Map<string, StageReceipt>();
  hook: (task: WorkerTask) => WorkbenchResult = () => ({
    status: "needs_input",
    summary: "Explicit mock: stop before external work",
    candidates: [],
    checks: [],
  });
  probe = async () => ({
    codex: { available: true, authenticated: true, message: "Mock" },
    capabilities: { studio: true, video: false, motion: true },
    message: "Mock",
  });
  stageReceipt = (_runId: string, stageId: string) =>
    this.receipts.get(stageId) ?? { charges: [], downloads: [] };
  async run(task: WorkerTask) {
    this.calls.push(task);
    const result = this.hook(task);
    fs.writeFileSync(task.resultPath, JSON.stringify(result));
    return { result };
  }
}
function fixture(step: WorkbenchStep = "concept") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-executor-"));
  const projectRoot = path.join(root, "project"),
    workspace = path.join(projectRoot, "jobs/job");
  fs.mkdirSync(workspace, { recursive: true });
  const services: WorkbenchServices = {
    projectRoot: () => projectRoot,
    blenderPath: () =>
      "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe",
    unityPath: () => undefined,
    unityEditorPath: () => "",
    resourcesPath: path.resolve("integrations"),
    checkpointRoot: path.join(root, "host-checkpoints"),
  };
  const context: WorkbenchExecutionContext = {
    workspace,
    inputs: [],
    signal: new AbortController().signal,
    workbench: {
      schemaVersion: 1,
      id: "bench",
      projectId: "project",
      jobs: [],
      selections: {},
      createdAt: "now",
      updatedAt: "now",
      message: "test",
    },
    job: {
      id: "job",
      step,
      slot: step,
      request: { step, prompt: "test" },
      status: "running",
      createdAt: "now",
      updatedAt: "now",
      summary: "test",
      dependencies: {},
      approval: {
        accepted: true,
        studioCreditLimit: 1000,
        imageCreditLimit: 0,
      },
      candidates: [],
      checks: [],
    },
  };
  if (step === "model") {
    context.job.request.role = "head";
    for (const view of ["front", "back", "left", "right"] as const) {
      const relative = `refs/${view}.png`;
      const file = path.join(projectRoot, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          Buffer.from(view),
        ]),
      );
      context.inputs.push({
        path: relative,
        kind: "image",
        role: "head",
        view,
        sha256: digest(file),
        bytes: fs.statSync(file).size,
      });
    }
  }
  return { root, services, context };
}
function output(task: WorkerTask, n = 1): WorkbenchResult {
  const folder = path
    .dirname(path.relative(task.run.workspace, task.resultPath))
    .replaceAll("\\", "/");
  const candidates = Array.from({ length: n }, (_, i) => {
    const file = `${folder}/model-${i}.glb`;
    fs.writeFileSync(path.join(task.run.workspace, file), buildWorkbenchGlb(i));
    return {
      id: `candidate-${i}`,
      label: "Explicit mock",
      artifacts: [{ path: file, kind: "model" as const }],
      objects: [],
    };
  });
  return {
    status: "completed",
    summary: "Explicit mock",
    candidates,
    checks: [],
  };
}
test("assembly, rig and animation explicitly use Astra; image steps retain configured model", async () => {
  for (const step of [
    "concept",
    "separate",
    "reference",
    "assembly",
    "rig",
    "animation",
  ] as WorkbenchStep[]) {
    const f = fixture(step),
      worker = new Worker();
    const executor = new CodexWorkbenchExecutor(worker, f.services);
    await executor.execute(f.context, () => {});
    const args = codexArguments(worker.calls[0]);
    if (["assembly", "rig", "animation"].includes(step))
      assert.equal(args[args.indexOf("--model") + 1], "gpt-6-astra");
    else assert(!args.includes("--model"));
    assert(!args.some(arg => /^mcp_servers\.(blender|fal_ai|notion)\.enabled=/.test(arg)));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("local Unity dispatch never probes or invokes a GPT worker, including configuration failures",async()=>{
 const f=fixture('unity'),worker=new Worker();f.context.job.request.unityExecution='local';
 worker.probe=async()=>{throw Error('Unexpected GPT probe');};f.services.unityPath=()=>'';
 try{const result=await new CodexWorkbenchExecutor(worker,f.services).execute(f.context,()=>{});assert.equal(result.status,'needs_input');assert.match(result.summary,/Unity 프로젝트/);assert.equal(worker.calls.length,0);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("surface retry reuses completed paid phases instead of charging them twice", async () => {
  const f = fixture("surface"),
    worker = new Worker();
  let ready = false;
  worker.hook = (task) => {
    if (task.stage.id === "hair-uv" && !ready)
      return {
        status: "needs_input",
        summary: "Login required before submit",
        candidates: [],
        checks: [],
      };
    const result = output(task);
    const file = result.candidates[0].artifacts[0].path;
    worker.receipts.set(task.stage.id, {
      charges: [{ state: "observed", cost: 5 }],
      downloads: [
        {
          state: "completed",
          file,
          sha256: digest(path.join(task.run.workspace, file)),
        },
      ],
    });
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "needs_input",
  );
  assert(executor.hasConfirmedSubmission(f.context.job));
  ready = true;
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "completed",
  );
  assert.equal(
    worker.calls.filter((call) => call.stage.id === "head-uv").length,
    1,
  );
  assert.equal(
    worker.calls.filter((call) => call.stage.id === "head-texture").length,
    1,
  );
  assert.equal(
    worker.calls.filter((call) => call.stage.id === "hair-uv").length,
    2,
  );
  assert.equal(worker.receipts.size, 6);
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("ambiguous receipt prevents another worker submission even when the user retries", async () => {
  const f = fixture("model"),
    worker = new Worker();
  worker.receipts.set("model", {
    charges: [{ state: "clicked", cost: 100 }],
    downloads: [],
  });
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "submission_unknown",
  );
  assert.equal(worker.calls.length, 0);
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("local rig and animation collect saved completion after stream loss, preserving file/cancellation/denial guards", async () => {
  for (const step of ["assembly", "rig", "animation"] as const)
  for (const mode of ["complete", "missing-file", "incomplete", "cancelled", "denied", "denied-stream"] as const) {
    const f=fixture(step), worker=new Worker(), controller=new AbortController();
    f.context.signal=controller.signal;
    worker.run=async(task)=>{
      worker.calls.push(task);
      const result=output(task);
      if(mode==="incomplete") result.status="needs_input";
      fs.writeFileSync(task.resultPath,JSON.stringify(result));
      if(mode==="missing-file") fs.unlinkSync(path.join(task.run.workspace,result.candidates[0].artifacts[0].path));
      if(mode==="cancelled") controller.abort();
      throw Error(mode==="denied"?"approval denied":`${mode==="denied-stream" ? "approval denied; " : ""}stream disconnected before completion: websocket closed by server`);
    };
    try {
      const executor=new CodexWorkbenchExecutor(worker,f.services);
      // Exercise collection/file validation alone; the separate real Blender
      // inspector and packaged rabbit checks cover host scene validation.
      const result=await (executor as any).phase(f.context,[],()=>{});
      assert.equal(result.status,mode==="complete"?"completed":"needs_input",mode);
      assert.equal(worker.calls.length,1);
    } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
  }
});

test("transport recovery validates saved animation without another worker; bad files still fail", async () => {
  for (const mode of ["complete", "missing-file", "invalid-glb", "invalid-json"] as const) {
    const f=fixture("animation"), worker=new Worker();
    const folder=path.join(f.context.workspace,"outputs/animation");fs.mkdirSync(folder,{recursive:true});
    const task={run:{workspace:f.context.workspace},stage:{id:"animation"},resultPath:path.join(folder,"result.json")} as WorkerTask;
    const saved=output(task);
    fs.writeFileSync(task.resultPath,JSON.stringify(saved));
    if(mode==="missing-file") fs.unlinkSync(path.join(f.context.workspace,saved.candidates[0].artifacts[0].path));
    if(mode==="invalid-glb") fs.writeFileSync(path.join(f.context.workspace,saved.candidates[0].artifacts[0].path),"invalid");
    if(mode==="invalid-json") fs.writeFileSync(task.resultPath,JSON.stringify({...saved,candidates:"invalid"}));
    f.context.recovery={attempt:1,mode:"repair",error:"stream disconnected before completion: websocket closed by server"};
    try {
      const result=await (new CodexWorkbenchExecutor(worker,f.services) as any).phase(f.context,[],()=>{});
      assert.equal(result.status,mode==="complete"?"completed":"needs_input",mode);
      assert.equal(worker.calls.length,0,mode);
    } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
  }
});
test("saved reference failures are returned unchanged for host draft validation without invoking a worker",async()=>{
  const f=fixture("reference"),worker=new Worker();
  worker.probe=async()=>{throw Error("No probe for saved files");};
  const folder=path.join(f.context.workspace,"outputs/reference");fs.mkdirSync(folder,{recursive:true});
  const task={run:{workspace:f.context.workspace},stage:{id:"reference"},resultPath:path.join(folder,"result.json")} as WorkerTask;
  const result=output(task);result.checks=[{name:"wrong_side",passed:false,severity:"error",visualCategory:"view_consistency",detail:"Front instead of side"}];
  fs.writeFileSync(task.resultPath,JSON.stringify(result));const before=digest(task.resultPath);
  try{const saved=await new CodexWorkbenchExecutor(worker,f.services).inspectSaved(f.context);
    assert.equal(saved.status,"needs_input");assert.equal(saved.checks[0].passed,false);assert.equal(worker.calls.length,0);assert.equal(digest(task.resultPath),before);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test("a saved UTF-8 BOM completed result is revalidated without regenerating candidates", async () => {
  const f = fixture("model"),
    worker = new Worker();
  const folder = path.join(f.context.workspace, "outputs/model");
  fs.mkdirSync(folder, { recursive: true });
  const task = {
    run: { workspace: f.context.workspace },
    stage: { id: "model" },
    resultPath: path.join(folder, "result.json"),
  } as WorkerTask;
  const result = output(task, 1);
  fs.writeFileSync(task.resultPath, "\uFEFF" + JSON.stringify(result));
  worker.receipts.set("model", {
    charges: [{ state: "observed", cost: 100 }],
    downloads: result.candidates.map((candidate) => ({
      state: "completed",
      file: candidate.artifacts[0].path,
      sha256: digest(
        path.join(f.context.workspace, candidate.artifacts[0].path),
      ),
    })),
  });
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "completed",
  );
  assert.equal(worker.calls.length, 0);
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("modifying a paid checkpoint output blocks recovery without another charge", async () => {
  const f = fixture("model"),
    worker = new Worker();
  worker.hook = (task) => {
    const result = output(task, 1);
    worker.receipts.set("model", {
      charges: [{ state: "observed", cost: 100 }],
      downloads: result.candidates.map((candidate) => ({
        state: "completed",
        file: candidate.artifacts[0].path,
        sha256: digest(
          path.join(f.context.workspace, candidate.artifacts[0].path),
        ),
      })),
    });
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const first = await executor.execute(f.context, () => {});
  assert.equal(first.status, "completed");
  fs.appendFileSync(
    path.join(f.context.workspace, first.candidates[0].artifacts[0].path),
    "changed",
  );
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "submission_unknown",
  );
  assert.equal(worker.calls.length, 1);
  fs.rmSync(f.root, { recursive: true, force: true });
});
test(
  "real local Blender inspection detects stable objects, dedicated bones, weights and authored motion",
  {
    skip: !fs.existsSync(
      "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe",
    ),
  },
  () => {
    const f = fixture("rig"),
      script = path.join(f.root, "fixture.py"),
      blend = path.join(f.root, "fixture.blend"),
      report = path.join(f.root, "inspection.json");
    // This procedural object is exclusively a local inspector test fixture.
    fs.writeFileSync(
      script,
      `import bpy\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete(use_global=False)\nbpy.ops.mesh.primitive_cube_add()\nm=bpy.context.object\nm['partsmith_id']='cloth-object'\nm['partsmith_category']='clothing'\nbpy.ops.object.armature_add()\na=bpy.context.object\nbpy.ops.object.mode_set(mode='EDIT')\nb=a.data.edit_bones.new('cloth')\nb.head=(0,0,0)\nb.tail=(0,0,1)\nbpy.ops.object.mode_set(mode='OBJECT')\na.data.bones['cloth']['partsmith_target_id']='cloth-object'\ng=m.vertex_groups.new(name='cloth')\ng.add(list(range(len(m.data.vertices))),1.0,'REPLACE')\nmod=m.modifiers.new('Armature','ARMATURE')\nmod.object=a\np=a.pose.bones['cloth']\np.rotation_mode='XYZ'\np.rotation_euler.x=0\np.keyframe_insert('rotation_euler',frame=1)\np.rotation_euler.x=0.5\np.keyframe_insert('rotation_euler',frame=12)\np.rotation_euler.x=0\np.keyframe_insert('rotation_euler',frame=24)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})\n`,
    );
    const created = spawnSync(
      f.services.blenderPath(),
      ["--background", "--factory-startup", "--python", script],
      { windowsHide: true, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(created.status, 0, created.stderr);
    const inspected = spawnSync(
      f.services.blenderPath(),
      [
        "--background",
        blend,
        "--disable-autoexec",
        "--python",
        path.resolve("integrations/blender/workbench_inspect.py"),
        "--",
        report,
      ],
      { windowsHide: true, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(inspected.status, 0, inspected.stderr);
    const actual = JSON.parse(fs.readFileSync(report, "utf8"));
    assert.equal(actual.objects[0].id, "cloth-object");
    assert.equal(
      actual.objects[0].weightedVertices,
      actual.objects[0].vertices,
    );
    assert(
      actual.rigs[0].bones.some((bone: any) => bone.target === "cloth-object"),
    );
    assert(
      actual.actions.some(
        (action: any) => action.poseChannels > 0 && action.varyingChannels > 0,
      ),
    );
    fs.rmSync(f.root, { recursive: true, force: true });
  },
);

test("animation input manifests are rebased to copied registered frames without mutating originals", async () => {
  const f = fixture("animation"),
    worker = new Worker();
  const prefix = "workbench/old-bench/jobs/old-job/";
  const folder = path.join(
    f.services.projectRoot("project"),
    prefix,
    "outputs/reference",
  );
  fs.mkdirSync(folder, { recursive: true });
  for (const view of ["front", "side", "back"]) {
    const file = path.join(folder, `${view}.png`);
    fs.writeFileSync(file, `Explicit image fixture ${view}`);
    f.context.inputs.push({
      path: `${prefix}outputs/reference/${view}.png`,
      kind: "image",
      sha256: digest(file),
      bytes: fs.statSync(file).size,
    });
  }
  const source = path.join(folder, "frames.json");
  fs.writeFileSync(
    source,
    "\uFEFF" +
      JSON.stringify({
        frames: [
          {
            time: 0,
            front: "outputs/reference/front.png",
            side: "outputs/reference/side.png",
            back: "outputs/reference/back.png",
          },
        ],
      }),
  );
  const originalHash = digest(source);
  f.context.inputs.push({
    path: `${prefix}outputs/reference/frames.json`,
    kind: "frames",
    sha256: originalHash,
    bytes: fs.statSync(source).size,
  });
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  await executor.execute(f.context, () => {});
  const copied = JSON.parse(
    fs.readFileSync(
      path.join(f.context.workspace, "inputs/3-frames.json"),
      "utf8",
    ),
  );
  for (const view of ["front", "side", "back"])
    assert(
      fs.existsSync(path.join(f.context.workspace, copied.frames[0][view])),
    );
  assert.equal(digest(source), originalHash);
  assert(worker.calls[0].prompt.includes("sourceSha256"));
  fs.rmSync(f.root, { recursive: true, force: true });
});

for (const mode of ["side", "multiview"] as const) {
  test(`${mode} accepted video and frame paths reach the animation worker without changing originals`, async t => {
    const f = fixture("animation"), worker = new Worker();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const prefix = "workbench/bench/jobs/accepted/", root = f.services.projectRoot("project");
    const views = mode === "side" ? ["side"] : ["front", "side", "back"];
    const add = (relative: string, kind: "video" | "image" | "frames", bytes: string) => {
      const file = path.join(root, prefix, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
      f.context.inputs.push({ path: prefix + relative, kind, sha256: digest(file), bytes: fs.statSync(file).size });
    };
    for (const view of views) { add(`outputs/${view}.mp4`, "video", `fixture-video-${view}`); add(`outputs/${view}.png`, "image", `fixture-frame-${view}`); }
    const manifest = { source: "video-ai", mode, videos: Object.fromEntries(views.map(view => [view, { path: `outputs/${view}.mp4`, startTime: 0 }])), frames: [{ time: 0, ...Object.fromEntries(views.map(view => [view, `outputs/${view}.png`])) }] };
    add("outputs/frames.json", "frames", JSON.stringify(manifest));
    const original = f.context.inputs.at(-1)!;
    await new CodexWorkbenchExecutor(worker, f.services).execute(f.context, () => {});
    assert.equal(worker.calls.length, 1);
    const copied = JSON.parse(fs.readFileSync(path.join(f.context.workspace, `inputs/${f.context.inputs.length - 1}-frames.json`), "utf8"));
    assert.deepEqual(Object.keys(copied.videos), views);
    for (const view of views) {
      assert.equal(fs.readFileSync(path.join(f.context.workspace, copied.videos[view].path), "utf8"), `fixture-video-${view}`);
      assert.equal(fs.readFileSync(path.join(f.context.workspace, copied.frames[0][view]), "utf8"), `fixture-frame-${view}`);
    }
    assert.equal(digest(path.join(root, original.path)), original.sha256);
    // Missing registered originals must still fail before running an expensive worker.
    f.context.inputs = f.context.inputs.filter(a => a.kind !== "video"); worker.calls.length = 0;
    await assert.rejects(new CodexWorkbenchExecutor(worker, f.services).execute(f.context, () => {}), /등록된 입력/);
    assert.equal(worker.calls.length, 0);
  });
}

test("GLB inspection rejects broken UV accessors, inflated weights and static animation", () => {
  const valid = buildWorkbenchGlb();
  assert(
    inspectWorkbenchGlb(valid, {
      uv: true,
      texture: true,
      rig: true,
      animation: true,
    }).primitiveCount > 0,
  );
  const modify = (accessorIndex: number, value: number) => {
    const result = Buffer.from(valid);
    const { data } = inspectWorkbenchGlb(result);
    const accessor = data.accessors[accessorIndex];
    const position =
      28 +
      result.readUInt32LE(12) +
      data.bufferViews[accessor.bufferView].byteOffset +
      (accessor.byteOffset ?? 0);
    result.writeFloatLE(value, position);
    return result;
  };
  assert.throws(() => inspectWorkbenchGlb(modify(1, NaN), { uv: true }), /NaN/);
  assert.throws(
    () => inspectWorkbenchGlb(modify(3, 2), { rig: true }),
    /웨이트/,
  );
  const still = Buffer.from(valid),
    data = inspectWorkbenchGlb(still).data;
  const motion = data.accessors[5],
    motionStart =
      28 +
      still.readUInt32LE(12) +
      data.bufferViews[motion.bufferView].byteOffset;
  still.fill(
    0,
    motionStart,
    motionStart + data.bufferViews[motion.bufferView].byteLength,
  );
  assert.throws(
    () => inspectWorkbenchGlb(still, { animation: true }),
    /정지 포즈/,
  );
});

test("separation uses one image call per part without Studio or Blender instructions", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  worker.hook = partOutput;
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(
    worker.calls.map((task) => task.stage.id),
    ["separate-head", "separate-hair", "separate-body"],
  );
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(
    result.candidates[0].artifacts.map((artifact) => artifact.role),
    ["head", "hair", "body"],
  );
  for (const task of worker.calls) {
    assert.match(task.prompt, /exactly ONE built-in image generation call/);
    assert(!/Blender|Studio|paid-submit|at most ONE charge/i.test(task.prompt));
    assert(!task.recoveryOnly);
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("separation publishes each image before the next call and keeps aesthetic failures as review warnings", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  const drafts: WorkbenchResult[] = [];
  f.context.onDraft = (result) => drafts.push(structuredClone(result));
  worker.hook = (task) => {
    assert.equal(drafts.length, worker.calls.length - 1);
    const result = partOutput(task);
    result.checks = [
      { name: "original_alignment_and_scale_preserved", passed: false },
      { name: "clean_peripheral_alpha", passed: false },
      { name: "immutable_input_hash_verified", passed: true },
    ];
    if (task.stage.id === "separate-hair") {
      result.status = "needs_input";
      result.summary = "Original canvas alignment could not be recovered";
    }
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "completed");
  assert.equal(worker.calls.length, 3);
  assert(worker.calls.every((task) => !task.recoveryOnly));
  assert.deepEqual(
    drafts.map((draft) => draft.candidates[0].artifacts.length),
    [1, 2, 3],
  );
  assert(drafts.every((draft) => draft.status === "needs_input"));
  assert.equal(
    result.checks.filter(
      (check) => !check.passed && check.severity === "warning",
    ).length,
    6,
  );
  assert.match(worker.calls[0].prompt, /NOT completion requirements/);
  assert.match(worker.calls[0].prompt, /user decides whether to accept/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

function savedPartFixture(
  f: ReturnType<typeof fixture>,
  role: string,
  status: "completed" | "needs_input" = "completed",
) {
  const folder = path.join(f.context.workspace, `outputs/separate-${role}`);
  fs.mkdirSync(folder, { recursive: true });
  const task = {
    run: { workspace: f.context.workspace },
    stage: { id: `separate-${role}` },
    resultPath: path.join(folder, "result.json"),
  } as WorkerTask;
  const result = partOutput(task);
  result.status = status;
  result.checks = [
    { name: "original_alignment_and_scale_preserved", passed: false },
  ];
  fs.writeFileSync(task.resultPath, JSON.stringify(result));
  return { result, file: task.resultPath };
}

test("saved separation inspection restores available photos read-only without worker, probe or generation", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  worker.probe = async () => {
    throw Error("probe must not run");
  };
  const head = savedPartFixture(f, "head"),
    hair = savedPartFixture(f, "hair", "needs_input");
  const files = [
    head.file,
    hair.file,
    ...[head, hair].map(({ result }) =>
      path.join(f.context.workspace, result.candidates[0].artifacts[0].path),
    ),
  ];
  const before = files.map((file) => [digest(file), fs.statSync(file).mtimeMs]);
  const result = await new CodexWorkbenchExecutor(
    worker,
    f.services,
  ).inspectSaved(f.context);
  assert.equal(result.status, "needs_input");
  assert.equal(result.recovery?.kind, "blocked");
  assert.deepEqual(
    result.candidates[0].artifacts.map((artifact) => artifact.role),
    ["head", "hair"],
  );
  assert(
    result.checks.every(
      (check) => !check.passed && check.severity === "warning",
    ),
  );
  assert.equal(worker.calls.length, 0);
  assert.equal(fs.existsSync(f.services.checkpointRoot!), false);
  assert.equal(fs.existsSync(path.join(f.context.workspace, "inputs")), false);
  assert.deepEqual(
    files.map((file) => [digest(file), fs.statSync(file).mtimeMs]),
    before,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("a saved rear-view geometry observation is shown without a worker and an explicit retry only generates untouched views", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  f.context.job.request.views = [...fourViews];
  const front = savedPartFixture(f, "head-front"),
    back = savedPartFixture(f, "head-back");
  back.result.checks = [
    { name: "back_view_geometry_convincing", passed: false },
  ];
  fs.writeFileSync(back.file, JSON.stringify(back.result));
  const files = [
    front.file,
    back.file,
    ...[front, back].map(({ result }) =>
      path.join(f.context.workspace, result.candidates[0].artifacts[0].path),
    ),
  ];
  const before = files.map((file) => [digest(file), fs.statSync(file).mtimeMs]);
  const probe = worker.probe;
  worker.probe = async () => {
    throw Error("read-only inspection cannot probe");
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const saved = await executor.inspectSaved(f.context);
  assert.equal(saved.candidates[0].artifacts.length, 2);
  assert(
    saved.checks.some(
      (check) =>
        check.name === "head:back_view_geometry_convincing" &&
        !check.passed &&
        check.severity === "warning",
    ),
  );
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(
    files.map((file) => [digest(file), fs.statSync(file).mtimeMs]),
    before,
  );
  worker.probe = probe;
  worker.hook = partOutput;
  const continued = await executor.recover(
    {
      ...f.context,
      recovery: {
        attempt: 1,
        error: "back_view_geometry_convincing",
        mode: "repair",
      },
    },
    () => {},
  );
  assert.equal(continued.status, "completed");
  assert.equal(worker.calls.length, 10);
  assert(
    !worker.calls.some((task) =>
      ["separate-head-front", "separate-head-back"].includes(task.stage.id),
    ),
  );
  assert(worker.calls.every((task) => !task.recoveryOnly));
  assert.deepEqual(
    files.map((file) => [digest(file), fs.statSync(file).mtimeMs]),
    before,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("canonical aesthetic categories and distinct details survive checkpoints without overriding technical integrity", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  worker.hook = (task) => ({
    ...partOutput(task),
    checks: [
      {
        name: "visual_quality",
        passed: false,
        severity: "warning",
        visualCategory: "view_consistency",
        detail: "Rear silhouette needs user review",
      },
      {
        name: "visual_quality",
        passed: false,
        severity: "warning",
        visualCategory: "alignment",
        detail: "Part is slightly left of center",
      },
      {
        name: "visual_quality",
        passed: false,
        severity: "warning",
        visualCategory: "alignment",
        detail: "Part scale differs between directions",
      },
    ],
  });
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "completed");
  assert.equal(result.checks.length, 9);
  assert.equal((await executor.inspectSaved(f.context)).checks.length, 9);
  assert.match(worker.calls[0].prompt, /canonical check name visual_quality/);
  assert.match(worker.calls[0].prompt, /Genuine file, hash, path/);
  const invalid = fixture("separate"),
    badWorker = new Worker();
  badWorker.hook = (task) => ({
    ...partOutput(task),
    checks: [
      {
        name: "immutable_input_hash_verified",
        passed: false,
        severity: "warning",
        visualCategory: "appearance",
        detail: "Should never downgrade integrity",
      },
    ],
  });
  const blocked = await new CodexWorkbenchExecutor(
    badWorker,
    invalid.services,
  ).execute(invalid.context, () => {});
  assert.equal(blocked.status, "needs_input");
  assert.match(blocked.summary, /immutable_input_hash_verified/);
  assert.equal(badWorker.calls.length, 1);
  fs.rmSync(f.root, { recursive: true, force: true });
  fs.rmSync(invalid.root, { recursive: true, force: true });
});

test("saved inspection offers all three photos for review but rejects damaged and unregistered files", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  const records = ["head", "hair", "body"].map((role) =>
    savedPartFixture(f, role),
  );
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  assert.equal((await executor.inspectSaved(f.context)).status, "completed");
  const hair = records[1];
  hair.result.checks.push({
    name: "immutable_input_hash_verified",
    passed: false,
    severity: "warning",
  });
  fs.writeFileSync(hair.file, JSON.stringify(hair.result));
  let result = await executor.inspectSaved(f.context);
  assert.equal(result.status, "needs_input");
  assert.deepEqual(
    result.candidates[0].artifacts.map((artifact) => artifact.role),
    ["head", "body"],
  );
  assert.match(result.summary, /immutable_input_hash_verified/);
  records[2].result.candidates[0].artifacts[0].path = "../outside.png";
  fs.writeFileSync(records[2].file, JSON.stringify(records[2].result));
  fs.writeFileSync(
    path.join(
      f.context.workspace,
      records[0].result.candidates[0].artifacts[0].path,
    ),
    "not an image",
  );
  result = await executor.inspectSaved(f.context);
  assert.equal(result.candidates.length, 0);
  assert.equal(worker.calls.length, 0);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("an explicitly continued separation reuses saved warning photos and only generates the untouched part", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  const saved = [
    savedPartFixture(f, "head"),
    savedPartFixture(f, "hair", "needs_input"),
  ];
  const hashes = saved.map(({ file }) => digest(file));
  worker.hook = partOutput;
  const result = await new CodexWorkbenchExecutor(worker, f.services).recover(
    {
      ...f.context,
      recovery: {
        attempt: 1,
        error: "original alignment validation",
        mode: "repair",
      },
    },
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(
    worker.calls.map((task) => task.stage.id),
    ["separate-body"],
  );
  assert.equal(worker.calls[0].recoveryOnly, undefined);
  assert.deepEqual(
    saved.map(({ file }) => digest(file)),
    hashes,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("saved inspection never bypasses a changed checkpoint using otherwise valid result metadata", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  worker.hook = partOutput;
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  await executor.execute(f.context, () => {});
  fs.appendFileSync(
    path.join(f.context.workspace, "outputs/separate-head/head.png"),
    "changed after checkpoint",
  );
  const calls = worker.calls.length;
  worker.probe = async () => {
    throw Error("no probe during saved inspection");
  };
  const result = await executor.inspectSaved(f.context);
  assert.equal(result.status, "needs_input");
  assert.match(result.summary, /완료된 단계 파일이 변경/);
  assert.deepEqual(
    result.candidates[0].artifacts.map((artifact) => artifact.role),
    ["hair", "body"],
  );
  assert.equal(worker.calls.length, calls);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("explicit nonrepairable or new-generation requirements stop even when they mention validation", () => {
  for (const reason of [
    "검증 실패: 기존 파일만으로 복구 불가능, 새 이미지 생성 필요",
    "JSON validation failed; cannot repair the missing generated image",
    "Geometry validation: a new image generation is required",
    "검증 결과 사용자 판단이 필요합니다",
    "JSON result validation missing because approval_policy never rejected the tool",
    "결과 파일 없음: 승인 정책에서 도구 실행이 거부됐습니다",
  ])
    assert.equal(classifyWorkbenchFailure(reason).kind, "blocked", reason);
});

const fourViews = ["front", "back", "left", "right"] as const;
function sheetOutput(task: WorkerTask): WorkbenchResult {
  const role = /^separate-(head|hair|body)-sheet-v1$/.exec(task.stage.id)![1];
  const views = JSON.parse(
    /Requested generated cells ONLY: (\[[^\]]+\])/.exec(task.prompt)![1],
  ) as string[];
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(0);
  const roleIndex = ["head", "hair", "body"].indexOf(role);
  for (const [i, view] of fourViews.entries()) {
    if (!views.includes(view)) continue;
    for (let y = 6; y < 24; y++)
      for (let x = 8; x < 22; x++)
        png.data.set(
          [40 + roleIndex * 60, i * 45 + 20, 50 + i * 20, 255],
          (((i > 1 ? 32 : 0) + y) * 64 + (i % 2) * 32 + x) * 4,
        );
  }
  const file = path.join(path.dirname(task.resultPath), "sheet.png");
  fs.writeFileSync(file, PNG.sync.write(png));
  return {
    status: "completed",
    summary: "Synthetic PNG sheet; no actual image tool invoked",
    candidates: [
      {
        id: role,
        label: role,
        artifacts: [
          {
            path: path.relative(task.run.workspace, file).replaceAll("\\", "/"),
            kind: "image",
            role,
          },
        ],
        objects: [],
      },
    ],
    checks: [
      {
        name: "visual_quality",
        passed: false,
        severity: "warning",
        visualCategory: "view_consistency",
        detail: role + " synthetic observation retained",
      },
    ],
  };
}
function sheetFixture() {
  const f = fixture("separate");
  f.context.job.request.views = [...fourViews];
  f.context.job.request.separationStrategy = "part-sheet-v1";
  return f;
}
function multiviewFixture() {
  const f = fixture("separate");
  f.context.job.request.views = [...fourViews];
  f.context.job.request.separationStrategy = "part-multiview-v1";
  return f;
}
function recordChatGptDownloads(
  worker: Worker,
  task: WorkerTask,
  result: WorkbenchResult,
  state = "observed",
) {
  worker.receipts.set(task.stage.id, {
    imageBackend: "chatgpt-web",
    submission: {
      state,
      conversationUrl: "https://chatgpt.com/c/offline-fixture",
    },
    charges: [],
    downloads: result.candidates.flatMap((candidate) =>
      candidate.artifacts
        .filter((artifact) => artifact.kind === "image")
        .map((artifact) => {
          const file = path.join(task.run.workspace, artifact.path);
          return {
            state: "completed",
            file,
            sha256: digest(file),
            bytes: fs.statSync(file).size,
            runId: task.run.id,
            stageId: task.stage.id,
            sourcePage: "https://chatgpt.com/c/offline-fixture",
            imageLabel: "Generated image (explicit offline fixture)",
          };
        }),
    ),
  });
}
test("ChatGPT concept count 1 or 2 is frozen in one request and requires that many native originals", async () => {
  for (const count of [1, 2]) {
    const f = fixture("concept"),
      worker = new Worker();
    f.context.job.request.imageBackend = "chatgpt-web";
    f.context.job.request.generationCount = count;
    worker.hook = (task) => {
      const result: WorkbenchResult = {
        status: "completed",
        summary: "Offline original fixture",
        checks: [],
        candidates: Array.from({ length: count }, (_, index) => {
          const file = path.join(
            path.dirname(task.resultPath),
            `original-${index}.png`,
          );
          const png = new PNG({ width: 4, height: 4 });
          png.data.fill(10 + index);
          fs.writeFileSync(file, PNG.sync.write(png));
          return {
            id: `image-${index}`,
            label: "fixture",
            artifacts: [
              {
                kind: "image",
                path: path
                  .relative(task.run.workspace, file)
                  .replaceAll("\\", "/"),
              },
            ],
            objects: [],
          };
        }),
      };
      recordChatGptDownloads(worker, task, result);
      return result;
    };
    const executor = new CodexWorkbenchExecutor(worker, f.services);
    const result = await executor.execute(f.context, () => {});
    assert.equal(result.status, "completed", result.summary);
    assert.equal(result.candidates.length, count);
    assert.equal(worker.calls.length, 1);
    assert.match(
      worker.calls[0].webPrompt!,
      new RegExp(`Return exactly ${count} separate original images`),
    );
    assert(!worker.calls[0].webPrompt!.includes("FOUR"));
    assert.match(worker.calls[0].prompt, /send exactly ONCE/);
    assert.equal(
      (await executor.execute(f.context, () => {})).status,
      "completed",
    );
    assert.equal(worker.calls.length, 1);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("actual-chat routing requests four concepts once and requires matching native download provenance", async () => {
  const f = fixture("concept"),
    worker = new Worker();
  f.context.job.request.imageBackend = "chatgpt-web";
  f.context.job.request.prompt = "Distinctive character brief";
  worker.hook = (task) => {
    const candidates = [0, 1, 2, 3].map((index) => {
      const file = path.join(
        path.dirname(task.resultPath),
        `candidate-${index}.png`,
      );
      const png = new PNG({ width: 4, height: 4 });
      png.data.fill(10 + index);
      fs.writeFileSync(file, PNG.sync.write(png));
      return {
        id: `candidate-${index}`,
        label: "Offline fixture",
        artifacts: [
          {
            kind: "image" as const,
            path: path.relative(task.run.workspace, file).replaceAll("\\", "/"),
          },
        ],
        objects: [],
      };
    });
    const result: WorkbenchResult = {
      status: "completed",
      summary: "Offline fixture",
      candidates,
      checks: [],
    };
    recordChatGptDownloads(worker, task, result);
    return result;
  };
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "completed", result.summary);
  assert.equal(result.candidates.length, 4);
  assert.equal(worker.calls.length, 1);
  const task = worker.calls[0];
  assert.equal(task.imageBackend, "chatgpt-web");
  assert.match(task.webPrompt!, /Distinctive character brief/);
  assert.match(task.webPrompt!, /FOUR.*single request/);
  assert(!task.webPrompt!.includes(f.context.workspace));
  assert.match(task.prompt, /send exactly ONCE/);
  assert(!task.prompt.includes("Use FOUR separate built-in calls"));
  assert(codexArguments(task).includes("features.image_generation=false"));
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("ChatGPT multiview verifies three chat phases and twelve independent unchanged originals", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  f.context.job.request.imageBackend = "chatgpt-web";
  worker.hook = (task) => {
    const result = multiviewOutput(task);
    recordChatGptDownloads(worker, task, result);
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "completed", result.summary);
  assert.equal(worker.calls.length, 3);
  assert.equal(
    result.candidates[0].artifacts.filter(
      (artifact) => artifact.kind === "image",
    ).length,
    12,
  );
  for (const task of worker.calls) {
    assert.equal(task.imageBackend, "chatgpt-web");
    assert.match(task.webPrompt!, /ONE SEPARATE original image/);
    assert.match(task.prompt, /never infer orientation from download order/);
    assert.deepEqual(task.referencePaths, task.imagePaths);
  }
  assert.equal(executor.hasSubmission(f.context.job), true);
  assert.equal(executor.hasConfirmedSubmission(f.context.job), true);
  const inspected = await executor.inspectSaved(f.context);
  assert.equal(inspected.status, "completed");
  assert.equal(worker.calls.length, 3);
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("ChatGPT login before submission is an unsent blocked request and recovery cannot send after login", async () => {
  const f = fixture("concept"),
    worker = new Worker();
  f.context.job.request.imageBackend = "chatgpt-web";
  worker.hook = () => ({
    status: "needs_input",
    summary: "ChatGPT 로그인 필요",
    candidates: [],
    checks: [],
  });
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const first = await executor.execute(f.context, () => {});
  assert.equal(first.status, "needs_input");
  assert.equal(first.recovery?.kind, "blocked");
  assert.match(first.summary, /앱 전송 기록은 없습니다/);
  assert.match(first.summary, /새 생성 실행/);
  assert.equal(executor.hasSubmission(f.context.job), false);
  worker.hook = (task) => {
    assert.equal(task.recoveryOnly, true);
    assert.match(task.prompt, /No fill, upload, submit, new chat/);
    return {
      status: "needs_input",
      summary: "No existing submitted conversation",
      candidates: [],
      checks: [],
    };
  };
  await executor.recover(
    {
      ...f.context,
      recovery: { attempt: 1, error: "Login completed by user", mode: "retry" },
    },
    () => {},
  );
  assert.equal(worker.calls.length, 2);
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("ChatGPT originals without genuine stage provenance cannot become drafts or complete", async () => {
  for (const failure of [
    "no-receipt",
    "different-stage",
    "different-hash",
    "wrong-source",
    "wrong-conversation",
  ] as const) {
    const f = multiviewFixture(),
      worker = new Worker();
    f.context.job.request.imageBackend = "chatgpt-web";
    worker.hook = (task) => {
      const result = multiviewOutput(task);
      if (failure !== "no-receipt") {
        recordChatGptDownloads(worker, task, result);
        for (const download of worker.receipts.get(task.stage.id)!.downloads) {
          if (failure === "different-stage") download.stageId = "other-stage";
          if (failure === "different-hash") download.sha256 = "0".repeat(64);
          if (failure === "wrong-source")
            download.sourcePage = "https://other.invalid/image";
          if (failure === "wrong-conversation")
            download.sourcePage = "https://chatgpt.com/c/another-conversation";
        }
      }
      return result;
    };
    const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
      f.context,
      () => {},
    );
    assert.equal(result.status, "needs_input", failure);
    assert.equal(result.candidates.length, 0, failure);
    assert.match(result.summary, /ChatGPT 원본 다운로드 기록/, failure);
    assert.equal(worker.calls.length, 1, failure);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("ChatGPT partial originals remain available and a started chat resumes only download inspection", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  f.context.job.request.imageBackend = "chatgpt-web";
  f.context.job.request.role = "head";
  let originals: WorkbenchResult;
  worker.hook = (task) => {
    originals = multiviewOutput(task);
    recordChatGptDownloads(worker, task, originals);
    const partial = structuredClone(originals);
    partial.status = "needs_input";
    partial.candidates[0].artifacts = partial.candidates[0].artifacts.slice(
      0,
      2,
    );
    return partial;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const partial = await executor.execute(f.context, () => {});
  assert.equal(
    partial.candidates[0].artifacts.filter(
      (artifact) => artifact.kind === "image",
    ).length,
    2,
  );
  const originalPrompt = worker.calls[0].webPrompt;
  worker.hook = (task) => {
    assert.equal(task.recoveryOnly, true);
    assert.equal(task.imageBackend, "chatgpt-web");
    assert.equal(task.webPrompt, originalPrompt);
    assert.match(task.prompt, /No fill, upload, submit, new chat/);
    return originals!;
  };
  const recovered = await executor.recover(
    {
      ...f.context,
      recovery: { attempt: 1, error: "download interrupted", mode: "retry" },
    },
    () => {},
  );
  assert.equal(
    recovered.candidates[0].artifacts.filter(
      (artifact) => artifact.kind === "image",
    ).length,
    4,
  );
  assert.equal(worker.calls.length, 2);
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("an ambiguous web submission retains native downloads but cannot be marked complete or resubmitted", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  f.context.job.request.imageBackend = "chatgpt-web";
  worker.hook = (task) => {
    const result = multiviewOutput(task);
    recordChatGptDownloads(worker, task, result, "reserved");
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "submission_unknown");
  assert.equal(worker.calls.length, 1);
  assert.equal(executor.hasSubmission(f.context.job), true);
  assert.equal(executor.hasConfirmedSubmission(f.context.job), false);
  assert.equal(
    result.candidates[0].artifacts.filter(
      (artifact) => artifact.kind === "image",
    ).length,
    4,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});
function multiviewOutput(
  task: WorkerTask,
  onlyViews?: string[],
): WorkbenchResult {
  const role = /^separate-(head|hair|body)-multiview-v1(?:-set-\d+)?$/.exec(
    task.stage.id,
  )![1];
  const views =
    onlyViews ??
    JSON.parse(
      /Requested independent original directions ONLY: (\[[^\]]+\])/.exec(
        task.prompt,
      )![1],
    );
  const artifacts = views.map((view: string) => {
    const index = fourViews.indexOf(view as (typeof fourViews)[number]);
    const png = new PNG({ width: 62 + index * 4, height: 70 + index * 6 });
    png.data.fill(0);
    for (let y = 8; y < png.height - 8; y++)
      for (let x = 6; x < png.width - 6; x++)
        png.data.set(
          [
            30 + ["head", "hair", "body"].indexOf(role) * 60,
            30 + index * 40,
            70,
            255,
          ],
          (y * png.width + x) * 4,
        );
    const file = path.join(path.dirname(task.resultPath), `${view}-native.png`);
    fs.writeFileSync(file, PNG.sync.write(png));
    return {
      path: path.relative(task.run.workspace, file).replaceAll("\\", "/"),
      kind: "image" as const,
      role,
      view: view as (typeof fourViews)[number],
    };
  });
  return {
    status: onlyViews ? "needs_input" : "completed",
    summary: "Independent synthetic originals; no generation tool called",
    candidates: [{ id: role, label: role, artifacts, objects: [] }],
    checks: [
      {
        name: "visual_quality",
        passed: false,
        severity: "warning",
        visualCategory: "view_consistency",
        detail: role + " synthetic quality observation",
      },
    ],
  };
}
function checkpointPath(f: ReturnType<typeof fixture>, stageId: string) {
  return path.join(
    f.services.checkpointRoot!,
    createHash("sha256")
      .update(`${f.context.job.id}/${stageId}`)
      .digest("hex") + ".json",
  );
}
function addSeparationBase(
  f: ReturnType<typeof fixture>,
  pairs = ["head", "hair", "body"].flatMap((role) =>
    fourViews.map((view) => ({
      role,
      view: view as (typeof fourViews)[number] | undefined,
    })),
  ),
) {
  const artifacts = pairs.map(({ role, view }) => {
    const relative = `old-parts/${role}-${view ?? "front"}.png`;
    const file = path.join(f.services.projectRoot("project"), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from(`base saved ${role}/${view ?? "front"}`),
      ]),
    );
    return {
      path: relative,
      kind: "image" as const,
      role,
      view,
      sha256: digest(file),
      bytes: fs.statSync(file).size,
    };
  });
  const base: WorkbenchExecutionContext["job"] = {
    ...structuredClone(f.context.job),
    id: "base-separation",
    status: "needs_input",
    candidates: [],
    draftCandidates: [{ id: "draft", label: "saved images", artifacts }],
  };
  f.context.workbench.jobs.push(base);
  f.context.job.request.baseJobId = base.id;
  f.context.job.request.baseCandidateId = "draft";
  f.context.inputs.push(...artifacts);
  return artifacts;
}

test("separation count creates isolated full front-only alternatives and saved inspection never reruns them", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  f.context.job.request.generationCount = 2;
  f.context.job.request.separationMode = "single";
  f.context.job.request.views = ["front"];
  f.context.job.request.imageBackend = "chatgpt-web";
  worker.hook = (task) => {
    const result = partOutput(task);
    const file = path.join(
      task.run.workspace,
      result.candidates[0].artifacts[0].path,
    );
    fs.appendFileSync(file, task.stage.id);
    recordChatGptDownloads(worker, task, result);
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "completed", result.summary);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.id),
    ["separate-set-1", "separate-set-2"],
  );
  assert.equal(worker.calls.length, 6);
  assert.equal(new Set(worker.calls.map((task) => task.stage.id)).size, 6);
  for (const candidate of result.candidates) {
    assert.equal(
      candidate.artifacts.filter((artifact) => artifact.kind === "image")
        .length,
      3,
    );
    assert(candidate.artifacts.every((artifact) => artifact.view === "front"));
  }
  assert(executor.hasConfirmedSubmission(f.context.job));
  assert.equal((await executor.inspectSaved(f.context)).status, "completed");
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "completed",
  );
  assert.equal(worker.calls.length, 6);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("multiview alternatives keep separate phase receipts and retain the completed set during recovery", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  f.context.job.request.generationCount = 2;
  f.context.job.request.imageBackend = "chatgpt-web";
  let interrupted = true;
  worker.hook = (task) => {
    const result = multiviewOutput(
      task,
      task.recoveryOnly
        ? [...fourViews]
        : task.stage.id === "separate-head-multiview-v1-set-2" && interrupted
          ? ["front"]
          : undefined,
    );
    if (task.recoveryOnly) result.status = "completed";
    recordChatGptDownloads(worker, task, result);
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const first = await executor.execute(f.context, () => {});
  assert.equal(first.status, "needs_input");
  assert.equal(first.candidates.length, 2);
  assert.equal(
    first.candidates[0].artifacts.filter(
      (artifact) => artifact.kind === "image",
    ).length,
    12,
  );
  assert.equal(
    first.candidates[1].artifacts.filter(
      (artifact) => artifact.kind === "image",
    ).length,
    1,
  );
  assert.equal(worker.calls.length, 4);
  interrupted = false;
  const recovered = await executor.recover(
    {
      ...f.context,
      recovery: {
        attempt: 1,
        mode: "retry",
        error: "existing originals now available",
      },
    },
    () => {},
  );
  assert.equal(recovered.status, "completed", recovered.summary);
  assert.equal(recovered.candidates.length, 2);
  assert(
    recovered.candidates.every(
      (candidate) =>
        candidate.artifacts.filter((artifact) => artifact.kind === "image")
          .length === 12,
    ),
  );
  assert.equal(worker.calls.length, 7);
  assert.equal(worker.calls[4].stage.id, "separate-head-multiview-v1-set-2");
  assert.equal(worker.calls[4].recoveryOnly, true);
  assert.match(worker.calls[4].prompt, /No fill, upload, submit, new chat/);
  assert.equal(
    worker.calls.filter((task) => task.stage.id.endsWith("set-1")).length,
    3,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("four-view separation produces twelve independent photos and references earlier directions of the same part", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  f.context.job.request.views = [...fourViews];
  const originalFile = path.join(
    f.services.projectRoot("project"),
    "source-front.png",
  );
  fs.writeFileSync(
    originalFile,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("imported full character fixture"),
    ]),
  );
  f.context.inputs.push({
    path: "source-front.png",
    kind: "image",
    role: "front",
    sha256: digest(originalFile),
    bytes: fs.statSync(originalFile).size,
  });
  const drafts: number[] = [];
  f.context.onDraft = (result) =>
    drafts.push(
      result.candidates[0].artifacts.filter(
        (artifact) => artifact.kind === "image",
      ).length,
    );
  worker.hook = partOutput;
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "completed");
  assert.equal(result.candidates[0].artifacts.length, 12);
  assert.deepEqual(
    drafts,
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    worker.calls.map((task) => task.stage.id),
    ["head", "hair", "body"].flatMap((role) =>
      fourViews.map((view) => `separate-${role}-${view}`),
    ),
  );
  assert(
    worker.calls.every((task) =>
      task.imagePaths?.some((file) => file.endsWith("source-front.png")),
    ),
  );
  const left = worker.calls.find(
    (task) => task.stage.id === "separate-head-left",
  )!;
  assert(left.imagePaths!.some((file) => file.includes("separate-head-front")));
  assert(left.imagePaths!.some((file) => file.includes("separate-head-back")));
  assert.match(left.prompt, /character's own sides/);
  assert.match(left.prompt, /Never mirror-copy/);
  worker.probe = async () => {
    throw Error("saved inspection never probes");
  };
  const saved = await executor.inspectSaved(f.context);
  assert.equal(saved.status, "completed");
  assert.equal(saved.candidates[0].artifacts.length, 12);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("independent multiview uses three logical workers and retains twelve full native originals without cropping", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  worker.hook = multiviewOutput;
  const drafts: number[] = [];
  f.context.onDraft = (r) =>
    drafts.push(
      r.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    );
  const executor = new CodexWorkbenchExecutor(worker, f.services),
    result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "completed");
  assert.deepEqual(
    worker.calls.map((t) => t.stage.id),
    ["head", "hair", "body"].map((role) => `separate-${role}-multiview-v1`),
  );
  const images = result.candidates[0].artifacts.filter(
    (a) => a.kind === "image",
  );
  assert.equal(images.length, 12);
  assert.equal(
    new Set(images.map((a) => digest(path.join(f.context.workspace, a.path))))
      .size,
    12,
  );
  for (const artifact of images) {
    const native = path.join(
      f.context.workspace,
      `outputs/separate-${artifact.role}-multiview-v1/${artifact.view}-native.png`,
    );
    const image = PNG.sync.read(
        fs.readFileSync(path.join(f.context.workspace, artifact.path)),
      ),
      i = fourViews.indexOf(artifact.view!);
    assert.equal(image.width, 62 + i * 4);
    assert.equal(image.height, 70 + i * 6);
    assert.equal(
      digest(native),
      digest(path.join(f.context.workspace, artifact.path)),
    );
  }
  assert(drafts.includes(4) && drafts.includes(8) && drafts.includes(12));
  assert(drafts.every((count, index) => !index || count >= drafts[index - 1]));
  assert(!result.candidates[0].artifacts.some((a) => a.kind === "export"));
  assert(result.checks.some((c) => !c.passed && c.severity === "warning"));
  for (const task of worker.calls) {
    assert.match(task.prompt, /ONE separate full-quality native image file/);
    assert.match(task.prompt, /do not invent an n\/count argument/);
    assert.match(
      task.prompt,
      /concurrently only when the actual tools support concurrency/,
    );
    assert(!task.prompt.includes("TOP LEFT"));
    assert(
      !task.prompt.includes("Make exactly ONE built-in image generation call"),
    );
    assert.equal(task.requestedModel, undefined);
  }
  worker.probe = async () => {
    throw Error("inspection must not probe");
  };
  assert.equal((await executor.inspectSaved(f.context)).status, "completed");
  assert.equal(worker.calls.length, 3);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("independent multiview missing-only batches preserve every existing image and freeze only requested missing views", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  f.context.job.request.reuseExisting = true;
  const sources = addSeparationBase(f, [
    { role: "head", view: "front" },
    { role: "head", view: "back" },
    { role: "hair", view: undefined },
    { role: "body", view: "front" },
  ]);
  worker.hook = multiviewOutput;
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.equal(worker.calls.length, 3);
  assert.match(
    worker.calls[0].prompt,
    /Requested independent original directions ONLY: \["left","right"\]/,
  );
  for (const source of sources) {
    const kept = result.candidates[0].artifacts.find(
      (a) =>
        a.kind === "image" &&
        a.role === source.role &&
        a.view === (source.view ?? "front"),
    )!;
    assert.equal(
      digest(path.join(f.context.workspace, kept.path)),
      source.sha256,
    );
    assert.equal(
      digest(path.join(f.services.projectRoot("project"), source.path)),
      source.sha256,
    );
  }
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        checkpointPath(f, "separate-head-multiview-v1") + ".plan.json",
        "utf8",
      ),
    ).views,
    ["left", "right"],
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("independent multiview single-view revision preserves eleven images and retains the original one-view path", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  f.context.job.request.role = "hair";
  f.context.job.request.view = "left";
  const base = addSeparationBase(f);
  worker.hook = partOutput;
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(
    worker.calls.map((t) => t.stage.id),
    ["separate-hair-left"],
  );
  for (const source of base.filter(
    (a) => a.role !== "hair" || a.view !== "left",
  )) {
    const kept = result.candidates[0].artifacts.find(
      (a) =>
        a.kind === "image" && a.role === source.role && a.view === source.view,
    )!;
    assert.equal(
      digest(path.join(f.context.workspace, kept.path)),
      source.sha256,
    );
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("ChatGPT single-view correction preserves eleven prior images without requiring new receipts for old inputs", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  Object.assign(f.context.job.request, {
    imageBackend: "chatgpt-web",
    role: "hair",
    view: "left",
    prompt: "Change only the left hair tip",
  });
  const base = addSeparationBase(f);
  worker.hook = (task) => {
    const result = partOutput(task);
    recordChatGptDownloads(worker, task, result);
    return result;
  };
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "completed", result.summary);
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0].stage.id, "separate-hair-left");
  assert.match(worker.calls[0].webPrompt!, /Change only the left hair tip/);
  assert.match(
    worker.calls[0].webPrompt!,
    /Requested directions ONLY: \["left"\]/,
  );
  for (const source of base.filter(
    (image) => image.role !== "hair" || image.view !== "left",
  )) {
    const kept = result.candidates[0].artifacts.find(
      (image) =>
        image.kind === "image" &&
        image.role === source.role &&
        image.view === source.view,
    )!;
    assert.equal(
      digest(path.join(f.context.workspace, kept.path)),
      source.sha256,
    );
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("independent multiview partial progress remains visible and recovery only finds already generated originals", async () => {
  const f = multiviewFixture(),
    worker = new Worker(),
    executor = new CodexWorkbenchExecutor(worker, f.services);
  let full: WorkbenchResult | undefined;
  const drafts: number[] = [];
  f.context.onDraft = (r) =>
    drafts.push(
      r.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    );
  worker.hook = (task) => {
    full = multiviewOutput(task);
    const partial = structuredClone(full);
    partial.status = "needs_input";
    partial.candidates[0].artifacts = partial.candidates[0].artifacts.slice(
      0,
      2,
    );
    fs.writeFileSync(task.resultPath, JSON.stringify(partial));
    task.onEvent({ type: "partial", message: "two originals saved" });
    assert(drafts.includes(2));
    return partial;
  };
  const first = await executor.execute(f.context, () => {});
  assert.equal(first.status, "needs_input");
  assert.equal(
    first.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    2,
  );
  assert.equal(worker.calls.length, 1);
  const before = full!.candidates[0].artifacts.map((a) =>
    digest(path.join(f.context.workspace, a.path)),
  );
  const inspected = await executor.inspectSaved(f.context);
  assert.equal(
    inspected.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    2,
  );
  assert.equal(worker.calls.length, 1);
  worker.hook = (task) => {
    if (task.stage.id === "separate-head-multiview-v1") {
      assert.equal(task.recoveryOnly, true);
      assert(codexArguments(task).includes("features.image_generation=false"));
      assert.match(
        task.prompt,
        /Recover ONLY existing independent original files/,
      );
      return full!;
    }
    return multiviewOutput(task);
  };
  const recovered = await executor.recover(
    {
      ...f.context,
      recovery: { attempt: 1, error: "find existing files", mode: "retry" },
    },
    () => {},
  );
  assert.equal(recovered.status, "completed");
  assert.equal(worker.calls.length, 4);
  assert.deepEqual(
    full!.candidates[0].artifacts.map((a) =>
      digest(path.join(f.context.workspace, a.path)),
    ),
    before,
  );
  assert.equal(
    worker.calls.filter((t) => t.stage.id === "separate-head-multiview-v1")
      .length,
    2,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("saved independent multiview result before host checkpoint is recovered without a worker", async () => {
  const f = multiviewFixture(),
    worker = new Worker(),
    executor = new CodexWorkbenchExecutor(worker, f.services),
    internal = executor as any;
  internal.multiviewPlan(f.context, "head", [...fourViews]);
  const folder = path.join(
    f.context.workspace,
    "outputs/separate-head-multiview-v1",
  );
  fs.mkdirSync(folder, { recursive: true });
  const task = {
    run: { workspace: f.context.workspace },
    stage: { id: "separate-head-multiview-v1" },
    resultPath: path.join(folder, "result.json"),
    prompt:
      'Requested independent original directions ONLY: ["front","back","left","right"]',
  } as WorkerTask;
  const raw = multiviewOutput(task),
    hashes = raw.candidates[0].artifacts.map((a) =>
      digest(path.join(f.context.workspace, a.path)),
    );
  fs.writeFileSync(task.resultPath, JSON.stringify(raw));
  worker.probe = async () => {
    throw Error("must not probe");
  };
  const inspected = await executor.inspectSaved(f.context);
  assert.equal(inspected.status, "needs_input");
  assert.equal(
    inspected.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    4,
  );
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(
    raw.candidates[0].artifacts.map((a) =>
      digest(path.join(f.context.workspace, a.path)),
    ),
    hashes,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("cancelling an independent multiview group preserves its saved original and never starts other parts", async () => {
  const f = multiviewFixture(),
    worker = new Worker(),
    abort = new AbortController();
  f.context.signal = abort.signal;
  worker.hook = (task) => {
    const result = multiviewOutput(task, ["front"]);
    fs.writeFileSync(task.resultPath, JSON.stringify(result));
    task.onEvent({ type: "partial" });
    abort.abort();
    throw Error("User cancelled");
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services),
    stopped = await executor.execute(f.context, () => {});
  assert.equal(stopped.status, "needs_input");
  assert.equal(worker.calls.length, 1);
  assert.equal(
    stopped.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    1,
  );
  const result = await executor.inspectSaved({
    ...f.context,
    signal: new AbortController().signal,
  });
  assert.equal(
    result.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    1,
  );
  assert.equal(worker.calls.length, 1);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("an ambiguous independent multiview invocation cannot fall back to new individual generation", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  worker.hook = () => {
    throw Error("network connection reset");
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "needs_input",
  );
  worker.hook = (task) => {
    assert.equal(task.recoveryOnly, true);
    return {
      status: "needs_input",
      summary: "Existing independent originals unavailable",
      candidates: [],
      checks: [],
    };
  };
  assert.equal(
    (
      await executor.recover(
        {
          ...f.context,
          recovery: { attempt: 1, error: "network", mode: "retry" },
        },
        () => {},
      )
    ).status,
    "needs_input",
  );
  assert.deepEqual(
    worker.calls.map((t) => t.stage.id),
    ["separate-head-multiview-v1", "separate-head-multiview-v1"],
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("independent multiview rejects duplicate or wrong-role originals and does not claim twelve valid files", async () => {
  for (const failure of ["duplicate", "role", "missing"]) {
    const f = multiviewFixture(),
      worker = new Worker();
    worker.hook = (task) => {
      const r = multiviewOutput(task),
        images = r.candidates[0].artifacts;
      if (failure === "duplicate")
        fs.copyFileSync(
          path.join(task.run.workspace, images[0].path),
          path.join(task.run.workspace, images[1].path),
        );
      if (failure === "role") images[1].role = "hair";
      if (failure === "missing")
        fs.unlinkSync(path.join(task.run.workspace, images[1].path));
      return r;
    };
    const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
      f.context,
      () => {},
    );
    assert.equal(result.status, "needs_input");
    assert.equal(worker.calls.length, 1);
    assert.equal(
      result.candidates[0].artifacts.filter((a) => a.kind === "image").length,
      3,
    );
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("tampered independent originals block recovery without hiding unaffected completed parts", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  worker.hook = multiviewOutput;
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "completed",
  );
  fs.appendFileSync(
    path.join(
      f.context.workspace,
      "outputs/separate-head-multiview-v1/front-native.png",
    ),
    "tampered",
  );
  const inspected = await executor.inspectSaved(f.context);
  assert.equal(inspected.status, "needs_input");
  assert.match(inspected.summary, /파일이 변경/);
  assert.equal(
    inspected.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    8,
  );
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "needs_input",
  );
  assert.equal(worker.calls.length, 3);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("historical sheet generation stays disabled but existing native sheet inspection remains local", async () => {
  const f = sheetFixture(),
    worker = new Worker(),
    executor = new CodexWorkbenchExecutor(worker, f.services),
    internal = executor as any;
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "needs_input",
  );
  assert.equal(worker.calls.length, 0);
  internal.sheetPlan(f.context, "head", [...fourViews]);
  const folder = path.join(
    f.context.workspace,
    "outputs/separate-head-sheet-v1",
  );
  fs.mkdirSync(folder, { recursive: true });
  const task = {
    run: { workspace: f.context.workspace },
    stage: { id: "separate-head-sheet-v1" },
    resultPath: path.join(folder, "result.json"),
    prompt: 'Requested generated cells ONLY: ["front","back","left","right"]',
  } as WorkerTask;
  const raw = sheetOutput(task);
  fs.writeFileSync(task.resultPath, JSON.stringify(raw));
  const sha = digest(
    path.join(f.context.workspace, raw.candidates[0].artifacts[0].path),
  );
  worker.probe = async () => {
    throw Error("must not probe");
  };
  const inspected = await executor.inspectSaved(f.context);
  assert.equal(
    inspected.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    4,
  );
  assert.equal(
    inspected.candidates[0].artifacts.filter((a) => a.kind === "export").length,
    1,
  );
  assert.equal(worker.calls.length, 0);
  assert.equal(
    digest(path.join(f.context.workspace, raw.candidates[0].artifacts[0].path)),
    sha,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("independent multiview final visual observations merge into already checkpointed images and remain false", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  worker.hook = (task) => {
    const result = multiviewOutput(task),
      partial = structuredClone(result);
    partial.status = "needs_input";
    partial.checks = [];
    fs.writeFileSync(task.resultPath, JSON.stringify(partial));
    task.onEvent({ type: "partial" });
    result.checks = [
      {
        name: "visual_quality",
        passed: false,
        severity: "warning",
        visualCategory: "appearance",
        detail: `${task.stage.id} final-only observation`,
      },
    ];
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services),
    result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "completed");
  for (const role of ["head", "hair", "body"])
    assert(
      result.checks.some(
        (c) =>
          c.detail === `separate-${role}-multiview-v1 final-only observation` &&
          !c.passed,
      ),
    );
  const saved = await executor.inspectSaved(f.context);
  assert(
    saved.checks.some(
      (c) => c.detail?.includes("final-only observation") && !c.passed,
    ),
  );
  for (const view of fourViews) {
    const saved = JSON.parse(
      fs.readFileSync(checkpointPath(f, `separate-head-${view}`), "utf8"),
    );
    assert(
      saved.result.checks.some(
        (c: any) => c.detail?.includes("final-only observation") && !c.passed,
      ),
    );
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("independent multiview rejects same visible pixels even when an incremental original has different PNG metadata or invisible RGB", async () => {
  for (const variant of ["metadata", "invisible-rgb"]) {
    const f = multiviewFixture(),
      worker = new Worker();
    worker.hook = (task) => {
      const partial = multiviewOutput(task, ["front", "left", "right"]);
      fs.writeFileSync(task.resultPath, JSON.stringify(partial));
      task.onEvent({ type: "partial" });
      const result = multiviewOutput(task, ["back"]),
        front = path.join(
          task.run.workspace,
          partial.candidates[0].artifacts[0].path,
        ),
        back = path.join(
          task.run.workspace,
          result.candidates[0].artifacts[0].path,
        );
      const png = PNG.sync.read(fs.readFileSync(front));
      if (variant === "metadata") png.gamma = 0.45;
      else png.data[0] = 125;
      fs.writeFileSync(back, PNG.sync.write(png));
      assert.notEqual(digest(front), digest(back));
      result.status = "completed";
      return result;
    };
    const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
      f.context,
      () => {},
    );
    assert.equal(result.status, "needs_input");
    assert.match(result.summary, /같은 원본 이미지/);
    assert.equal(
      result.candidates[0].artifacts.filter((a) => a.kind === "image").length,
      3,
    );
    assert.equal(worker.calls.length, 1);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("historical sheet local crop checkpoint recovery never invokes a worker or changes the original sheet", async () => {
  const f = sheetFixture(),
    worker = new Worker(),
    executor = new CodexWorkbenchExecutor(worker, f.services),
    internal = executor as any;
  internal.sheetPlan(f.context, "head", [...fourViews]);
  const folder = path.join(
    f.context.workspace,
    "outputs/separate-head-sheet-v1",
  );
  fs.mkdirSync(folder, { recursive: true });
  const task = {
      run: { workspace: f.context.workspace },
      stage: { id: "separate-head-sheet-v1" },
      resultPath: path.join(folder, "result.json"),
      prompt: 'Requested generated cells ONLY: ["front","back","left","right"]',
    } as WorkerTask,
    raw = sheetOutput(task);
  fs.writeFileSync(task.resultPath, JSON.stringify(raw));
  const original = path.join(
      f.context.workspace,
      raw.candidates[0].artifacts[0].path,
    ),
    sha = digest(original),
    save = internal.saveCheckpoint.bind(executor);
  let once = true;
  internal.saveCheckpoint = (
    context: WorkbenchExecutionContext,
    id: string,
    result: WorkbenchResult,
  ) => {
    if (id === "separate-head-back" && once) {
      once = false;
      throw Error("Synthetic interrupted local crop");
    }
    return save(context, id, result);
  };
  const interrupted = await executor.inspectSaved(f.context);
  assert.equal(interrupted.status, "needs_input");
  assert(fs.existsSync(checkpointPath(f, "separate-head-front")));
  const recovered = await executor.inspectSaved(f.context);
  assert.equal(
    recovered.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    4,
  );
  assert.equal(worker.calls.length, 0);
  assert.equal(digest(original), sha);
  fs.appendFileSync(original, "tampered");
  const blocked = await executor.inspectSaved(f.context);
  assert.match(blocked.summary, /파일이 변경/);
  assert.equal(blocked.candidates.length, 0);
  assert.equal(worker.calls.length, 0);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("separation sends every distinct relevant reference once without unrelated reports or internal metadata", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  f.context.job.request.role = "head";
  const base = addSeparationBase(f);
  const source = path.join(
    f.services.projectRoot("project"),
    "whole-character.png",
  );
  fs.writeFileSync(
    source,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("whole character unique pixels"),
    ]),
  );
  const original = {
    path: "whole-character.png",
    kind: "image" as const,
    role: "body",
    sha256: digest(source),
    bytes: fs.statSync(source).size,
  };
  const concept = {
    ...structuredClone(f.context.job),
    id: "concept-origin",
    step: "concept" as const,
    candidates: [{ id: "source", label: "source", artifacts: [original] }],
  };
  f.context.workbench.jobs.push(concept);
  f.context.job.dependencies.concept = {
    jobId: concept.id,
    candidateId: "source",
  };
  f.context.inputs.push(original);
  // Repeated same-SHA input, plus nonimage material the image worker does not need.
  f.context.inputs.push({ ...base[0], bytes: base[0].bytes });
  const report = path.join(
    f.services.projectRoot("project"),
    "irrelevant-report.json",
  );
  fs.writeFileSync(
    report,
    JSON.stringify({ irrelevant_scene_metadata: "UNRELATED_SECRET_MARKER" }),
  );
  f.context.inputs.push({
    path: "irrelevant-report.json",
    kind: "report",
    sha256: digest(report),
    bytes: fs.statSync(report).size,
  });
  worker.hook = multiviewOutput;
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.equal(worker.calls.length, 1);
  const task = worker.calls[0];
  assert.equal(task.imagePaths.length, 5);
  assert.equal(new Set(task.imagePaths.map(digest)).size, 5);
  assert(task.imagePaths.some((file) => digest(file) === original.sha256));
  for (const source of base.filter((a) => a.role === "head"))
    assert(task.imagePaths.some((file) => digest(file) === source.sha256));
  assert(!task.prompt.includes("irrelevant-report.json"));
  assert(!task.prompt.includes("UNRELATED_SECRET_MARKER"));
  for (const key of [
    '"sha256"',
    '"bytes"',
    '"baseJobId"',
    '"baseCandidateId"',
    "Scene object IDs",
  ])
    assert(!task.prompt.includes(key), key);
  assert.match(task.prompt, /Inspect each generated output once/);
  assert.match(task.prompt, /Do not downsample/);
  assert.equal(task.requestedModel, undefined);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("a missing frozen independent multiview plan cannot fall back to a single-view generation", async () => {
  const f = multiviewFixture(),
    worker = new Worker();
  worker.hook = multiviewOutput;
  f.context.job.request.reuseExisting = true;
  addSeparationBase(f, []);
  const executor = new CodexWorkbenchExecutor(worker, f.services),
    internal = executor as any,
    save = internal.saveCheckpoint.bind(executor);
  internal.saveCheckpoint = (
    context: WorkbenchExecutionContext,
    stage: string,
    result: WorkbenchResult,
  ) => {
    if (stage === "separate-head-right")
      throw Error("Synthetic last-crop interruption");
    return save(context, stage, result);
  };
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "needs_input",
  );
  assert.equal(worker.calls.length, 1);
  fs.unlinkSync(checkpointPath(f, "separate-head-multiview-v1") + ".plan.json");
  await assert.rejects(
    () => executor.execute(f.context, () => {}),
    /고정 계획이 없습니다/,
  );
  assert.equal(worker.calls.length, 1);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("selected full-character reference remains available even when its old metadata calls it body", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  f.context.job.request = {
    ...f.context.job.request,
    views: [...fourViews],
    role: "head",
    view: "front",
  };
  const relative = "full-character.png",
    file = path.join(f.services.projectRoot("project"), relative);
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("full character"),
    ]),
  );
  const image = {
    path: relative,
    kind: "image" as const,
    role: "body",
    sha256: digest(file),
    bytes: fs.statSync(file).size,
  };
  const concept = {
    ...structuredClone(f.context.job),
    id: "concept",
    step: "concept" as const,
    candidates: [{ id: "chosen", label: "full character", artifacts: [image] }],
  };
  f.context.workbench.jobs.push(concept);
  f.context.inputs.push(image);
  f.context.job.dependencies.concept = {
    jobId: concept.id,
    candidateId: "chosen",
  };
  worker.hook = partOutput;
  await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(worker.calls.length, 1);
  assert(worker.calls[0].imagePaths?.some((path) => path.endsWith(relative)));
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("one direction correction preserves eleven real base images and invokes just its targeted phase", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  f.context.job.request = {
    ...f.context.job.request,
    views: [...fourViews],
    role: "hair",
    view: "left",
    prompt: "왼쪽 땋은 머리를 더 길게",
  };
  const base = addSeparationBase(f);
  f.context.workbench.jobs[0].draftChecks = [
    { name: "hair:clean_peripheral_alpha", passed: false, severity: "warning" },
  ];
  worker.hook = partOutput;
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(
    worker.calls.map((task) => task.stage.id),
    ["separate-hair-left"],
  );
  assert.match(worker.calls[0].prompt, /왼쪽 땋은 머리를 더 길게/);
  assert(
    result.checks.some(
      (check) => check.name === "hair:clean_peripheral_alpha" && !check.passed,
    ),
  );
  assert(!result.checks.some((check) => check.name.includes("hair:hair:")));
  for (const source of base.filter(
    (artifact) => !(artifact.role === "hair" && artifact.view === "left"),
  )) {
    const retained = result.candidates[0].artifacts.find(
      (artifact) =>
        artifact.kind === "image" &&
        artifact.role === source.role &&
        artifact.view === source.view,
    )!;
    assert.equal(
      digest(path.join(f.context.workspace, retained.path)),
      source.sha256,
    );
    assert.equal(
      digest(path.join(f.services.projectRoot("project"), source.path)),
      source.sha256,
    );
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("continue missing views preserves legacy front drafts and generates only ten missing directions", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  f.context.job.request.views = [...fourViews];
  f.context.job.request.reuseExisting = true;
  const original = addSeparationBase(f, [
    { role: "head", view: undefined },
    { role: "hair", view: undefined },
  ]);
  worker.hook = partOutput;
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.equal(worker.calls.length, 10);
  assert(
    !worker.calls.some((task) =>
      ["separate-head-front", "separate-hair-front"].includes(task.stage.id),
    ),
  );
  for (const source of original) {
    const artifact = result.candidates[0].artifacts.find(
      (item) => item.role === source.role && item.view === "front",
    )!;
    assert.equal(
      digest(path.join(f.context.workspace, artifact.path)),
      source.sha256,
    );
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("repeated inherited visual warnings stay false and bounded instead of multiplying past the result limit", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  f.context.job.request = {
    ...f.context.job.request,
    views: [...fourViews],
    role: "head",
    view: "front",
  };
  addSeparationBase(f);
  f.context.workbench.jobs[0].draftChecks = Array.from({ length: 120 }, () => ({
    name: "hair:clean_peripheral_alpha",
    passed: false,
    severity: "warning" as const,
  }));
  worker.hook = partOutput;
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.equal(result.checks.length, 1);
  assert.deepEqual(result.checks[0], {
    name: "hair:clean_peripheral_alpha",
    passed: false,
    severity: "warning",
  });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("targeted correction of a partial draft stays partial without silently generating other directions", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  f.context.job.request = {
    ...f.context.job.request,
    views: [...fourViews],
    role: "hair",
    view: "front",
  };
  addSeparationBase(f, [{ role: "head", view: undefined }]);
  worker.hook = partOutput;
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "needs_input");
  assert.equal(result.recovery?.kind, "blocked");
  assert.equal(result.candidates[0].artifacts.length, 2);
  assert.deepEqual(
    worker.calls.map((task) => task.stage.id),
    ["separate-hair-front"],
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("missing-only execution still respects an explicitly selected direction", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  f.context.job.request = {
    ...f.context.job.request,
    views: [...fourViews],
    reuseExisting: true,
    role: "head",
    view: "back",
  };
  addSeparationBase(f, [{ role: "head", view: undefined }]);
  worker.hook = partOutput;
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "needs_input");
  assert.equal(result.recovery?.kind, "blocked");
  assert.deepEqual(
    worker.calls.map((task) => task.stage.id),
    ["separate-head-back"],
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

function recordStudioModels(
  worker: Worker,
  task: WorkerTask,
  result: WorkbenchResult,
) {
  worker.receipts.set(task.stage.id, {
    charges: [{ state: "observed", cost: 100 }],
    downloads: result.candidates.map((candidate) => ({
      state: "completed",
      file: candidate.artifacts[0].path,
      sha256: digest(
        path.join(task.run.workspace, candidate.artifacts[0].path),
      ),
    })),
  });
}
test("whole character uses its accepted concept directly and one native Tripo count submission returns multiple candidates", async () => {
  const f = fixture("model"),
    worker = new Worker();
  const concept = { ...f.context.inputs[0], role: undefined, view: undefined };
  f.context.inputs = [concept];
  f.context.job.request = {
    step: "model",
    prompt: "",
    modelInput: "whole",
    role: "whole",
    generationCount: 2,
  };
  worker.hook = (task) => {
    const result = output(task, 2);
    recordStudioModels(worker, task, result);
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "completed", result.summary);
  assert.equal(result.candidates.length, 2);
  assert(
    result.candidates.every((candidate) =>
      candidate.artifacts.every((artifact) => artifact.role === "whole"),
    ),
  );
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0].imagePaths?.length, 1);
  assert.match(
    worker.calls[0].prompt,
    /selected WHOLE character concept image/,
  );
  assert.match(worker.calls[0].prompt, /visibly selected native count 2/);
  assert.match(worker.calls[0].prompt, /single-image input mode/);
  assert.match(
    worker.calls[0].prompt,
    /never clamp count, loop Generate, or substitute repeated submissions/,
  );
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "completed",
  );
  assert.equal(worker.calls.length, 1);
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("front-only part modeling supports requested count above four with one charge and rejects missing candidate downloads", async () => {
  for (const missingDownload of [false, true]) {
    const f = fixture("model"),
      worker = new Worker();
    f.context.inputs = [f.context.inputs[0]];
    Object.assign(f.context.job.request, {
      modelInput: "parts",
      views: ["front"],
      generationCount: 5,
      prompt: "",
    });
    worker.hook = (task) => {
      const result = output(task, 5);
      recordStudioModels(worker, task, result);
      if (missingDownload) worker.receipts.get(task.stage.id)!.downloads.pop();
      return result;
    };
    const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
      f.context,
      () => {},
    );
    assert.equal(
      result.status,
      missingDownload ? "needs_input" : "completed",
      result.summary,
    );
    if (!missingDownload) assert.equal(result.candidates.length, 5);
    else assert.match(result.summary, /고유 후보 파일이 부족/);
    assert.equal(worker.calls.length, 1);
    assert.equal(worker.calls[0].imagePaths?.length, 1);
    assert.match(worker.calls[0].prompt, /visibly selected native count 5/);
    assert.equal(worker.receipts.get("model")?.charges.length, 1);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("whole character surface performs only whole UV and texture operations", async () => {
  const f = fixture("surface"),
    worker = new Worker();
  f.context.job.request.modelInput = "whole";
  worker.hook = (task) => {
    const result = output(task, 1);
    recordStudioModels(worker, task, result);
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(
    worker.calls.map((task) => task.stage.id),
    ["whole-uv", "whole-texture"],
  );
  assert(
    result.candidates[0].artifacts.every(
      (artifact) => artifact.role === "whole",
    ),
  );
  assert(executor.hasConfirmedSubmission(f.context.job));
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("motion source preparation never probes or dispatches Codex even when its source is missing",async()=>{
  const f=fixture("motion-source"),worker=new Worker();
  worker.probe=async()=>{throw Error("Unexpected model probe");};
  try {
    const result=await new CodexWorkbenchExecutor(worker,f.services).execute(f.context,()=>{});
    assert.equal(result.status,"needs_input");assert.match(result.summary,/리깅 Blender 원본/);assert.equal(worker.calls.length,0);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("direct surface rig uses Astra native import while rig revisions keep the accepted blend",async()=>{
  const f=fixture("rig"),worker=new Worker();
  f.context.job.request.rigSource="surface";
  try {
    const executor=new CodexWorkbenchExecutor(worker,f.services);
    await executor.execute(f.context,()=>{});
    assert.equal(worker.calls.length,1);
    assert.equal(worker.calls[0].requestedModel,"gpt-6-astra");
    assert.match(worker.calls[0].prompt,/Import the selected WHOLE textured native FBX/);
    assert.match(worker.calls[0].prompt,/Never import the UV-only export checkpoint/);
    assert.match(worker.calls[0].prompt,/Do not assemble, remesh, refine shape/);
    const revision=fixture("rig"),revisionWorker=new Worker();
    try {
      revision.context.job.request.rigSource="surface";
      revision.context.job.request.baseJobId="prior-rig";
      await new CodexWorkbenchExecutor(revisionWorker,revision.services).execute(revision.context,()=>{});
      assert.match(revisionWorker.calls[0].prompt,/prior accepted rig .blend, never reimport/);
      assert(!revisionWorker.calls[0].prompt.includes("Assembly/correction was explicitly skipped"));
    }finally{fs.rmSync(revision.root,{recursive:true,force:true});}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("whole character assembly refines the selected character with Astra without inventing three input parts", async () => {
  const f = fixture("assembly"),
    worker = new Worker();
  f.context.job.request.modelInput = "whole";
  await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0].requestedModel, "gpt-6-astra");
  assert.match(
    worker.calls[0].prompt,
    /Refine the selected WHOLE textured character/,
  );
  assert(!worker.calls[0].prompt.includes("Assemble the THREE"));
  fs.rmSync(f.root, { recursive: true, force: true });
});
test("model requires four mapped references, one output and an observable supported correction prompt", async () => {
  const f = fixture("model"),
    worker = new Worker();
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const missing = f.context.inputs.pop()!;
  const blocked = await executor.execute(f.context, () => {});
  assert.equal(blocked.status, "needs_input");
  assert.equal(worker.calls.length, 0);
  f.context.inputs.push(missing);
  f.context.job.request.prompt = "몸통보다 머리를 작게";
  worker.hook = (task) => {
    const result = output(task, 1);
    worker.receipts.set("model", {
      charges: [{ state: "observed", cost: 25 }],
      downloads: [
        {
          state: "completed",
          file: result.candidates[0].artifacts[0].path,
          sha256: digest(
            path.join(
              task.run.workspace,
              result.candidates[0].artifacts[0].path,
            ),
          ),
        },
      ],
    });
    return result;
  };
  const result = await executor.execute(f.context, () => {});
  assert.equal(result.status, "completed");
  assert.equal(result.candidates.length, 1);
  assert.equal(worker.calls[0].imagePaths?.length, 4);
  assert.match(worker.calls[0].prompt, /ONE-candidate/);
  assert.match(worker.calls[0].prompt, /map character-left\/right correctly/);
  assert.match(
    worker.calls[0].prompt,
    /before paid-submit, observe a prompt field/,
  );
  assert.match(
    worker.calls[0].prompt,
    /NEVER submit while silently ignoring the prompt/,
  );
  assert.match(worker.calls[0].prompt, /몸통보다 머리를 작게/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("model uploads verified normalized canvases while preserving raw image lineage and rejecting stale derivatives", async () => {
  const f = fixture("model"),
    worker = new Worker();
  const rawHashes = f.context.inputs.map((input) => input.sha256);
  const anchor = f.context.inputs[0].sha256;
  for (const [index, input] of f.context.inputs.entries()) {
    // Actual PNG container fixture only; no claim of generated-image quality.
    const png = new PNG({ width: 2048, height: 2048 });
    png.data.fill(0);
    const pixel = (1024 * 2048 + 1024) * 4;
    png.data[pixel] = index + 1;
    png.data[pixel + 3] = 255;
    const relative = `normalized/${input.view}.png`,
      file = path.join(f.services.projectRoot("project"), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PNG.sync.write(png));
    input.normalized = {
      path: relative,
      sha256: digest(file),
      bytes: fs.statSync(file).size,
      width: 2048,
      height: 2048,
      sourceSha256: input.sha256,
      anchorSha256: anchor,
    };
  }
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  await executor.execute(f.context, () => {});
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0].imagePaths?.length, 4);
  for (const [index, file] of worker.calls[0].imagePaths!.entries()) {
    assert.match(file, /model-view-head-/);
    assert.equal(digest(file), f.context.inputs[index].normalized!.sha256);
  }
  assert.match(
    worker.calls[0].prompt,
    /2048x2048 PNG with common canvas, part scale and center/,
  );
  assert.deepEqual(
    f.context.inputs.map((input) =>
      digest(path.join(f.services.projectRoot("project"), input.path)),
    ),
    rawHashes,
  );
  const target = f.context.inputs[1],
    valid = { ...target.normalized! };
  for (const patch of [
    { sourceSha256: "wrong" },
    { anchorSha256: "wrong" },
    { sha256: "wrong" },
    { bytes: 1 },
    { width: 1024 },
    { path: "../outside.png" },
  ]) {
    target.normalized = { ...valid, ...patch };
    const result = await executor.execute(f.context, () => {});
    assert.equal(result.status, "needs_input");
    assert.equal(result.recovery?.kind, "blocked");
    assert.equal(worker.calls.length, 1);
  }
  target.normalized = valid;
  fs.appendFileSync(
    path.join(f.services.projectRoot("project"), valid.path),
    "changed derivative",
  );
  const changed = await executor.execute(f.context, () => {});
  assert.equal(changed.recovery?.kind, "blocked");
  assert.equal(worker.calls.length, 1);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("existing-model reroll uses only Studio regional editing, verifies allowance, and never requires fresh four-view generation", async () => {
  for (const scope of ["all", "part"] as const) {
    const f = fixture("model"),
      worker = new Worker();
    f.context.inputs = [];
    const relative = "old-model/native.glb",
      file = path.join(f.services.projectRoot("project"), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildWorkbenchGlb());
    const native = {
      path: relative,
      kind: "model" as const,
      role: "head",
      sha256: digest(file),
      bytes: fs.statSync(file).size,
    };
    const base = {
      ...structuredClone(f.context.job),
      id: "old-model",
      candidates: [
        { id: "chosen", label: "chosen model", artifacts: [native] },
      ],
    };
    f.context.workbench.jobs.push(base);
    f.context.inputs.push(native);
    f.context.job.request = {
      ...f.context.job.request,
      baseJobId: base.id,
      baseCandidateId: "chosen",
      modelEditScope: scope,
      modelEditTarget: scope === "part" ? "왼쪽 귀만" : undefined,
      prompt: "귀 끝을 둥글게",
    };
    await new CodexWorkbenchExecutor(worker, f.services).execute(
      f.context,
      () => {},
    );
    assert.equal(worker.calls.length, 1);
    const prompt = worker.calls[0].prompt;
    assert.match(
      prompt,
      /existing-model partial regeneration\/regional-edit feature/,
    );
    assert.match(prompt, /remaining partial-regeneration allowance\/count/);
    assert.match(prompt, /free allowance is exhausted/);
    assert.match(prompt, /Never use new-model Generate/);
    assert.match(
      prompt,
      /at most ONE observed host-gated partial regeneration/,
    );
    assert.match(prompt, /studio_canvas_drag/);
    assert.match(prompt, /studio_mesh_edit_submit/);
    assert.match(prompt, /Never use ordinary studio_submit/);
    assert.deepEqual(worker.calls[0].modelEdit, {
      scope,
      target: scope === "part" ? "왼쪽 귀만" : undefined,
    });
    assert(!prompt.includes("ONE-candidate mode"));
    assert.match(
      prompt,
      scope === "part"
        ? /Select ONLY the requested region '왼쪽 귀만'/
        : /select the entire existing model/,
    );
    assert.equal(digest(file), native.sha256);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("a base Studio screenshot cannot replace or duplicate the selected separation input views", async () => {
  const f = fixture("model"),
    worker = new Worker();
  const refs = [...f.context.inputs];
  const selection = {
    ...structuredClone(f.context.job),
    id: "selected-parts",
    step: "separate" as const,
    candidates: [{ id: "parts", label: "parts", artifacts: refs }],
  };
  f.context.workbench.jobs.push(selection);
  f.context.job.dependencies.separate = {
    jobId: selection.id,
    candidateId: "parts",
  };
  const previewFile = path.join(
    f.services.projectRoot("project"),
    "preview.png",
  );
  fs.copyFileSync(
    path.join(f.services.projectRoot("project"), refs[0].path),
    previewFile,
  );
  const preview = { ...refs[0], path: "preview.png" };
  const nativeFile = path.join(f.services.projectRoot("project"), "native.glb");
  fs.writeFileSync(nativeFile, buildWorkbenchGlb());
  const native = {
    path: "native.glb",
    kind: "model" as const,
    role: "head",
    sha256: digest(nativeFile),
    bytes: fs.statSync(nativeFile).size,
  };
  const base = {
    ...structuredClone(f.context.job),
    id: "prior-model",
    candidates: [{ id: "prior", label: "prior", artifacts: [preview, native] }],
  };
  f.context.workbench.jobs.push(base);
  f.context.inputs.push(preview, native);
  f.context.job.request.baseJobId = base.id;
  await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(worker.calls.length, 1);
  const selectedOccurrences =
    worker.calls[0].prompt.match(/"referenceUse":"selected-part-view"/g) ?? [];
  assert.equal(selectedOccurrences.length, 4);
  assert.match(worker.calls[0].prompt, /"referenceUse":"prior-version"/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("targeted surface revision retains the other two parts and only runs selected UV and texture", async () => {
  const f = fixture("surface"),
    worker = new Worker();
  f.context.job.request.role = "head";
  const artifacts = ["head", "hair", "body"].map((role, i) => {
    const relative = `old-surface/${role}.glb`,
      file = path.join(f.services.projectRoot("project"), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildWorkbenchGlb(i));
    return {
      path: relative,
      kind: "model" as const,
      role,
      sha256: digest(file),
      bytes: fs.statSync(file).size,
    };
  });
  const base = {
    ...structuredClone(f.context.job),
    id: "base-surface",
    candidates: [{ id: "surface", label: "base", artifacts }],
  };
  f.context.workbench.jobs.push(base);
  f.context.job.request.baseJobId = base.id;
  f.context.inputs.push(...artifacts);
  const revisedPath = "new-selected/head.glb",
    revisedFile = path.join(f.services.projectRoot("project"), revisedPath);
  fs.mkdirSync(path.dirname(revisedFile), { recursive: true });
  fs.writeFileSync(revisedFile, buildWorkbenchGlb(8));
  const revised = {
    path: revisedPath,
    kind: "model" as const,
    role: "head",
    sha256: digest(revisedFile),
    bytes: fs.statSync(revisedFile).size,
  };
  const model = {
    ...structuredClone(f.context.job),
    id: "new-head-model",
    step: "model" as const,
    candidates: [{ id: "new-model", label: "new head", artifacts: [revised] }],
  };
  f.context.workbench.jobs.push(model);
  f.context.inputs.push(revised);
  f.context.job.dependencies["model:head"] = {
    jobId: model.id,
    candidateId: "new-model",
  };
  worker.hook = (task) => {
    if (task.stage.id === "head-uv") {
      assert.match(task.prompt, /new-selected\/head.glb/);
      assert(!task.prompt.includes("old-surface/head.glb"));
    }
    const result = output(task);
    const file = result.candidates[0].artifacts[0].path;
    worker.receipts.set(task.stage.id, {
      charges: [{ state: "observed", cost: 5 }],
      downloads: [
        {
          state: "completed",
          file,
          sha256: digest(path.join(task.run.workspace, file)),
        },
      ],
    });
    return result;
  };
  const result = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(
    worker.calls.map((task) => task.stage.id),
    ["head-uv", "head-texture"],
  );
  for (const source of artifacts.filter(
    (artifact) => artifact.role !== "head",
  )) {
    const kept = result.candidates[0].artifacts.find(
      (artifact) => artifact.role === source.role,
    )!;
    assert.equal(
      digest(path.join(f.context.workspace, kept.path)),
      source.sha256,
    );
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("failed part recovery reuses completed head and repairs hair without another image call", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  worker.hook = (task) => {
    const result = partOutput(task);
    if (task.stage.id === "separate-hair" && !task.recoveryOnly)
      throw Error("network connection reset after generated image was saved");
    return result;
  };
  const first = await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.equal(first.status, "needs_input");
  assert.equal(first.recovery?.kind, "retry");
  const headFile = path.join(
    f.context.workspace,
    "outputs/separate-head/head.png",
  );
  const original = digest(headFile);
  const retry = await new CodexWorkbenchExecutor(worker, f.services).recover(
    {
      ...f.context,
      recovery: { attempt: 1, error: first.summary, mode: "retry" },
    },
    () => {},
  );
  assert.equal(retry.status, "completed");
  assert.equal(
    worker.calls.filter((task) => task.stage.id === "separate-head").length,
    1,
  );
  const hairCalls = worker.calls.filter(
    (task) => task.stage.id === "separate-hair",
  );
  assert.equal(hairCalls.length, 2);
  assert.equal(hairCalls[1].recoveryOnly, true);
  assert.match(
    hairCalls[1].prompt,
    /generation and paid submissions are disabled/,
  );
  assert.equal(
    worker.calls.find((task) => task.stage.id === "separate-body")
      ?.recoveryOnly,
    undefined,
  );
  assert.equal(digest(headFile), original);
  assert.equal(
    fs
      .readdirSync(f.services.checkpointRoot!)
      .filter((name) => name.endsWith(".execution.json")).length,
    3,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("malformed completed metadata is repaired locally instead of reparsing forever", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  const folder = path.join(f.context.workspace, "outputs/separate-head");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "result.json"), "{invalid json");
  worker.hook = partOutput;
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const result = await executor.recover(
    {
      ...f.context,
      recovery: { attempt: 1, error: "JSON parse error", mode: "repair" },
    },
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.equal(worker.calls[0].recoveryOnly, true);
  assert.equal(worker.calls[1].recoveryOnly, undefined);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("confirmed Studio submission recovery only downloads existing results", async () => {
  const f = fixture("model"),
    worker = new Worker();
  worker.receipts.set("model", {
    charges: [{ state: "observed", cost: 100 }],
    downloads: [],
  });
  worker.hook = (task) => {
    assert.equal(task.recoveryOnly, true);
    assert.match(task.prompt, /existing submitted task only/);
    const result = output(task, 1);
    worker.receipts.get("model")!.downloads = result.candidates.map(
      (candidate) => ({
        state: "completed",
        file: candidate.artifacts[0].path,
        sha256: digest(
          path.join(task.run.workspace, candidate.artifacts[0].path),
        ),
      }),
    );
    return result;
  };
  const result = await new CodexWorkbenchExecutor(worker, f.services).recover(
    {
      ...f.context,
      recovery: { attempt: 1, error: "network download failed", mode: "retry" },
    },
    () => {},
  );
  assert.equal(result.status, "completed");
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.receipts.get("model")!.charges.length, 1);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("ambiguous Studio receipt blocks automatic recovery; unknown and user-required failures stay blocked", async () => {
  const f = fixture("model"),
    worker = new Worker();
  worker.receipts.set("model", {
    charges: [{ state: "clicked", cost: 100 }],
    downloads: [],
  });
  const result = await new CodexWorkbenchExecutor(worker, f.services).recover(
    f.context,
    () => {},
  );
  assert.equal(result.status, "submission_unknown");
  assert.equal(result.recovery?.kind, "blocked");
  assert.equal(worker.calls.length, 0);
  for (const reason of [
    "Login required",
    "CAPTCHA",
    "credit budget exceeded",
    "unsupported model",
    "unknown artistic decision",
  ])
    assert.equal(classifyWorkbenchFailure(reason).kind, "blocked");
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("failed part checks never poison the checkpoint or loop without a repair worker", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  worker.hook = (task) => {
    const result = partOutput(task);
    if (task.stage.id === "separate-hair" && !task.recoveryOnly)
      result.checks = [{ name: "image alignment", passed: false }];
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  const first = await executor.execute(f.context, () => {});
  assert.equal(first.recovery?.kind, "repair");
  const repaired = await executor.recover(
    {
      ...f.context,
      recovery: { attempt: 1, error: first.summary, mode: "repair" },
    },
    () => {},
  );
  assert.equal(repaired.status, "completed");
  assert.equal(
    worker.calls.filter((call) => call.stage.id === "separate-head").length,
    1,
  );
  assert.equal(
    worker.calls.filter((call) => call.stage.id === "separate-hair")[1]
      .recoveryOnly,
    true,
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("legacy invalid phase checkpoint is repaired while sound phase checkpoints are reused", async () => {
  const f = fixture("separate"),
    worker = new Worker();
  worker.hook = partOutput;
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "completed",
  );
  const checkpoint = fs
    .readdirSync(f.services.checkpointRoot!)
    .filter((name) => !name.endsWith(".execution.json"))
    .map((name) => path.join(f.services.checkpointRoot!, name))
    .find(
      (file) =>
        JSON.parse(fs.readFileSync(file, "utf8")).stageId === "separate-hair",
    )!;
  const saved = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
  saved.result.checks = [{ name: "legacy invalid check", passed: false }];
  fs.writeFileSync(checkpoint, JSON.stringify(saved));
  const repaired = await executor.recover(
    {
      ...f.context,
      recovery: { attempt: 1, error: "작업 검증 실패", mode: "repair" },
    },
    () => {},
  );
  assert.equal(repaired.status, "completed");
  assert.equal(worker.calls.length, 4);
  assert.equal(worker.calls[3].stage.id, "separate-hair");
  assert.equal(worker.calls[3].recoveryOnly, true);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("part model review uses actual Studio snapshots and converts only incompatible native files", async () => {
  const f = fixture("model"),
    worker = new Worker();
  await new CodexWorkbenchExecutor(worker, f.services).execute(
    f.context,
    () => {},
  );
  assert.match(
    worker.calls[0].prompt,
    /actual Studio preview with studio_snapshot/,
  );
  assert.match(worker.calls[0].prompt, /without invoking Blender/);
  assert.match(worker.calls[0].prompt, /Only unsupported formats/);
  assert(
    !worker.calls[0].prompt.includes(
      "create a separate real GLB preview and image render for each if needed using Blender",
    ),
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("interrupted local repair invalidates only its old checkpoint and can resume without a paid replay", async () => {
  const f = fixture("model"),
    worker = new Worker();
  let repairInterrupted = false;
  worker.hook = (task) => {
    if (task.recoveryOnly && !repairInterrupted) {
      repairInterrupted = true;
      fs.appendFileSync(
        path.join(task.run.workspace, "outputs/model/model-0.glb"),
        "partial local repair",
      );
      throw Error("network connection reset during local repair");
    }
    const result = output(task, 1);
    worker.receipts.set("model", {
      charges: [{ state: "observed", cost: 100 }],
      downloads: result.candidates.map((candidate) => ({
        state: "completed",
        file: candidate.artifacts[0].path,
        sha256: digest(
          path.join(task.run.workspace, candidate.artifacts[0].path),
        ),
      })),
    });
    return result;
  };
  const executor = new CodexWorkbenchExecutor(worker, f.services);
  assert.equal(
    (await executor.execute(f.context, () => {})).status,
    "completed",
  );
  const interrupted = await executor.recover(
    {
      ...f.context,
      recovery: {
        attempt: 1,
        error: "host geometry 검증 실패",
        mode: "repair",
      },
    },
    () => {},
  );
  assert.equal(interrupted.status, "needs_input");
  assert.equal(interrupted.recovery?.kind, "retry");
  const repaired = await executor.recover(
    {
      ...f.context,
      recovery: { attempt: 2, error: interrupted.summary, mode: "retry" },
    },
    () => {},
  );
  assert.equal(repaired.status, "completed");
  assert.equal(worker.calls.length, 3);
  assert.equal(worker.calls[1].recoveryOnly, true);
  assert.equal(worker.calls[2].recoveryOnly, true);
  assert(
    fs
      .readdirSync(f.services.checkpointRoot!)
      .some((name) => name.includes(".before-repair-")),
  );
  fs.rmSync(f.root, { recursive: true, force: true });
});
