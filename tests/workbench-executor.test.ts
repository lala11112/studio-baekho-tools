import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  const role = task.stage.id.replace("separate-", "");
  const folder = path
    .dirname(path.relative(task.run.workspace, task.resultPath))
    .replaceAll("\\", "/");
  const image = `${folder}/${role}.png`;
  // Explicit signature fixture only; no generated-image quality assertion.
  fs.writeFileSync(
    path.join(task.run.workspace, image),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from(`offline fixture ${role}`),
    ]),
  );
  return {
    status: "completed",
    summary: "Offline part fixture",
    candidates: [
      {
        id: role,
        label: role,
        artifacts: [{ path: image, kind: "image", role }],
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
    assert(args.includes("mcp_servers.blender.enabled=false"));
    assert(args.includes("mcp_servers.fal_ai.enabled=false"));
    assert(args.includes("mcp_servers.notion.enabled=false"));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
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
  const result = output(task, 4);
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
    const result = output(task, 4);
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
  ])
    assert.equal(classifyWorkbenchFailure(reason).kind, "blocked", reason);
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
    const result = output(task, 4);
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
    const result = output(task, 4);
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
