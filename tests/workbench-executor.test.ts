import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  CodexWorkbenchExecutor,
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
