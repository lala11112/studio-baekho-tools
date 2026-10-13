import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { GraphicsEngine } from "../engine/graphics";
import type { Tripo } from "../engine/tripo";
import type {
  AssetVersion,
  GraphicsAction,
  GraphicsKind,
  GraphicsRole,
} from "../shared/graphics";
import type {
  GraphicsNativeArgs,
  GraphicsNativeResult,
} from "../engine/graphics-native";
import {
  defaultCreation,
  humanParts,
  setHumanPartsCreation,
  type CreationSpec,
} from "../shared/graphics-creation";
import { runwayEstimate } from "../shared/runway";

const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
type Executor = (args: GraphicsNativeArgs) => Promise<GraphicsNativeResult>;
async function fixture(t: any, kind: GraphicsKind = "prop") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-creation-flow-"));
  const store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  let apiCalls = 0;
  const forbidden = async () => {
    apiCalls++;
    throw Error("Unexpected API request in isolated coordinator test");
  };
  const tripo = {
    balance: forbidden,
    upload: forbidden,
    submit: forbidden,
    task: forbidden,
    download: forbidden,
  } as unknown as Tripo;
  const engine = new Engine(store, tripo),
    project = engine.create("Creation flow fixture");
  const calls: { executor: string; args: GraphicsNativeArgs }[] = [];
  const implementations: Record<string, Executor> = {};
  const capture =
    (executor: string): Executor =>
    async (args) => {
      calls.push({ executor, args });
      if (!implementations[executor])
        throw Error("Unconfigured injected executor: " + executor);
      return implementations[executor](args);
    };
  const graphics = new GraphicsEngine(store, engine, {
    resources: path.resolve("integrations"),
    native: capture("native"),
    procedural: capture("procedural"),
    astra: capture("astra"),
    video: capture("video"),
    motionSource: capture("motionSource"),
  });
  const w = await graphics.action(project.id, {
      kind: "create-object",
      name: "Test object",
      objectKind: kind,
    }),
    objectId = w.objects[0].id;
  const action = (action: GraphicsAction) =>
    graphics.action(project.id, action);
  const state = () => graphics.get(project.id);
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      if (!graphics.isActive(project.id) && !engine.isProjectActive(project.id))
        return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error("Injected executor did not settle");
  };
  t.after(async () => {
    graphics.shutdown();
    await idle();
    store.db.close();
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()));
    assert(path.basename(actual).startsWith("ps-creation-flow-"));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  const seed = (role: GraphicsRole, slot = "main") => {
    const w = state(),
      id = `source-${w.versions.length + 1}`,
      file = `graphics/fixture/${id}${role === "design" ? ".png" : ".blend"}`;
    const png = new PNG({ width: 32, height: 32 });
    png.data.fill(220);
    const bytes =
      role === "design"
        ? PNG.sync.write(png)
        : Buffer.from("Synthetic editable scene boundary " + id);
    store.write(project.id, file, bytes);
    const version: AssetVersion = {
      id,
      objectId,
      role,
      slot,
      label: id,
      createdAt: "2026-10-13",
      sourceVersionIds: [],
      provenance: { type: "import" },
      warnings: [],
      files: [
        {
          path: file,
          kind: role === "design" ? "image" : "blend",
          bytes: bytes.length,
          sha256: digest(bytes),
        },
      ],
    };
    w.versions.push(version);
    store.put("graphics", project.id, w);
    return version;
  };
  const output = (
    args: GraphicsNativeArgs,
    role: GraphicsRole,
    slot = "main",
    suffix = "",
  ): GraphicsNativeResult => {
    const extension =
      role === "design"
        ? ".png"
        : role === "motion-reference"
          ? ".mp4"
          : ".glb";
    const file = `graphics/fixture/${args.task.id}${suffix}${extension}`;
    const png = new PNG({ width: 32, height: 32 });
    png.data.fill(130);
    store.write(
      project.id,
      file,
      role === "design"
        ? PNG.sync.write(png)
        : Buffer.from(
            `Synthetic ${role} ${args.task.id} ${suffix} seed=${args.task.settings.variationSeed}`,
          ),
    );
    return {
      files: [
        {
          path: file,
          kind:
            role === "design"
              ? "image"
              : role === "motion-reference"
                ? "video"
                : "model",
        },
      ],
      role,
      slot,
      label: "Injected result",
      warnings: [
        "Synthetic executor boundary; no service/Blender quality validation",
      ],
    };
  };
  const setCreation = async (change: (creation: CreationSpec) => void) => {
    const creation = structuredClone(
      state().objects[0].creation ?? defaultCreation(kind),
    );
    change(creation);
    await action({ kind: "update-object", objectId, patch: { creation } });
    return creation;
  };
  const accept = (version: AssetVersion) =>
    action({ kind: "accept", objectId, versionId: version.id });
  const prepare = async (taskId: string) =>
    (await action({ kind: "prepare", objectId, taskId })).tasks.at(-1)!;
  const approve = async (id: string) => {
    await action({ kind: "approve", taskId: id });
    await idle();
  };
  return {
    root,
    store,
    engine,
    graphics,
    project,
    objectId,
    action,
    state,
    idle,
    seed,
    output,
    calls,
    implementations,
    setCreation,
    accept,
    prepare,
    approve,
    get apiCalls() {
      return apiCalls;
    },
  };
}

test("creation choices, imports, adoption and preparing a frozen request dispatch no service or worker", async (t) => {
  const f = await fixture(t),
    image = f.seed("design");
  await f.accept(image);
  await f.setCreation((c) => {
    c.subject = "rock";
    c.attributes.surface = "rugged";
    c.stageSettings.model!.values.modelMethod = "local";
    c.stageSettings.model!.values.count = 2;
    c.stageSettings.design!.values.count = 4;
  });
  const task = await f.prepare("M04"),
    frozen = structuredClone(task);
  assert.equal(task.status, "awaiting_approval");
  assert.equal(task.settings.count, 2);
  assert.equal(task.settings["attr.surface"], "rugged");
  await f.setCreation((c) => {
    c.attributes.surface = "smooth";
    c.stageSettings.model!.values.count = 1;
  });
  assert.deepEqual(f.state().tasks[0], frozen);
  assert.equal(f.calls.length, 0);
  assert.equal(f.apiCalls, 0);
});

test('whole-then-split prepares one whole model, preserves import slot, and never sends whole design as a missing part texture reference', async t => {
  const f = await fixture(t, 'character'), whole = f.seed('design');
  await f.accept(whole);
  await f.setCreation(c => { Object.assign(c, setHumanPartsCreation(c, 'whole-then-split')); c.stageSettings.model!.values.count = 1; });
  const model = await f.prepare('M01');
  assert.deepEqual(model.inputVersionIds, [whole.id]);
  assert.equal(model.settings.partId, undefined);
  assert.equal(model.settings.faceLimit, 5000);
  assert.equal(model.settings.quad, true);
  assert.equal(model.cost?.credits, 100);
  await f.action({ kind: 'cancel', taskId: model.id });
  const wholeModel = f.seed('model');
  const imported = f.graphics.importFiles(f.project.id, f.objectId, 'model', [f.store.file(f.project.id, wholeModel.files[0].path)]).versions.at(-1)!;
  assert.equal(imported.slot, 'main');
  const head = f.seed('model', 'part-head'); await f.accept(head);
  await assert.rejects(f.prepare('T03'), /파츠에 채택한 디자인 이미지가 없습니다/);
  assert.equal(f.state().objects[0].accepted['design:main'], whole.id);
  assert.equal(f.calls.length, 0); assert.equal(f.apiCalls, 0);
});

test("M06 mesh selection is tied to the selected source version and remains frozen across later form edits", async t => {
  const f = await fixture(t), original = f.seed("model"), replacement = f.seed("model");
  await f.accept(original);
  await f.setCreation(c => {
    c.stageSettings.assembly = { instruction: "선택한 손잡이만 두껍게", values: {
      assemblyMode: "partial", editMeshNames: '["Handle"]', editMeshIds: "[]", meshSelectionVersionId: original.id,
    } };
  });
  await f.accept(replacement);
  await assert.rejects(f.prepare("M06"), /메시를 선택한 원본과 현재 채택 모델이 다릅니다/);
  assert.equal(f.state().tasks.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.apiCalls, 0);
  await f.accept(original);
  const task = await f.prepare("M06"), frozen = structuredClone(task);
  assert.equal(task.settings.sourceVersionId, original.id);
  assert.equal(task.settings.meshSelectionVersionId, original.id);
  assert.equal(task.settings.editMeshNames, '["Handle"]');
  await f.setCreation(c => {
    c.stageSettings.assembly!.values.editMeshNames = '["DifferentMesh"]';
    c.stageSettings.assembly!.values.meshSelectionVersionId = replacement.id;
  });
  assert.deepEqual(f.state().tasks.at(-1), frozen);
  f.implementations.astra = async args => {
    assert.equal(args.task.settings.sourceVersionId, original.id);
    assert.equal(args.task.settings.meshSelectionVersionId, original.id);
    assert.equal(args.task.settings.editMeshNames, '["Handle"]');
    assert.equal(args.inputs[0].id, original.id);
    throw Error("Injected worker boundary reached; no authoring or service executed");
  };
  await f.approve(task.id);
  assert.equal(f.calls.length, 1); assert.equal(f.apiCalls, 0);
});

test("M04 count two dispatches independent one-candidate requests and never adopts outputs", async (t) => {
  const f = await fixture(t),
    image = f.seed("design");
  await f.accept(image);
  await f.setCreation((c) => {
    c.subject = "rock";
    c.stageSettings.model!.values.modelMethod = "local";
    c.stageSettings.model!.values.count = 2;
  });
  let entered = 0,
    simultaneous!: () => void,
    release!: () => void;
  const bothEntered = new Promise<void>((resolve) => (simultaneous = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  f.implementations.procedural = async (args) => {
    if (++entered === 2) simultaneous();
    await gate;
    return f.output(args, "model");
  };
  const task = await f.prepare("M04");
  await f.action({ kind: "approve", taskId: task.id });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      bothEntered,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(Error("Independent candidates did not enter concurrently")),
          1500,
        );
      }),
    ]);
    assert.equal(entered, 2);
    assert.equal(f.state().tasks[0].outputVersionIds.length, 0);
  } finally {
    clearTimeout(deadline);
    release();
    await f.idle();
  }
  const dispatched = f.calls.map((call) => call.args.task),
    state = f.state(),
    result = state.tasks[0];
  assert.equal(result.status, "review");
  assert.deepEqual(
    dispatched.map((task) => task.settings.count),
    [1, 1],
  );
  assert.deepEqual(
    dispatched.map((task) => task.settings.variationSeed),
    [1, 2],
  );
  assert.equal(new Set(dispatched.map((task) => task.id)).size, 2);
  assert.equal(new Set(dispatched.map((task) => task.requestHash)).size, 2);
  const candidates = state.versions.filter((version) =>
    result.outputVersionIds.includes(version.id),
  );
  assert.equal(candidates.length, 2);
  assert.equal(
    new Set(candidates.map((version) => version.files[0].path)).size,
    2,
  );
  assert.equal(
    new Set(candidates.map((version) => version.files[0].sha256)).size,
    2,
  );
  assert.deepEqual(
    result.completedExecutions,
    dispatched.map((task) => task.id),
  );
  assert.equal(state.objects[0].accepted["design:main"], image.id);
  assert.equal(state.objects[0].accepted["model:main"], undefined);
  assert.equal(f.apiCalls, 0);
});

test("second candidate failure preserves the first result and recovery never redispatches a completed child", async (t) => {
  const f = await fixture(t),
    image = f.seed("design");
  await f.accept(image);
  await f.setCreation((c) => {
    c.subject = "rock";
    c.stageSettings.model!.values.modelMethod = "local";
    c.stageSettings.model!.values.count = 2;
  });
  let savedSecond: GraphicsNativeResult | undefined;
  f.implementations.procedural = async (args) => {
    if (args.task.settings.variationSeed === 1) return f.output(args, "model");
    if (args.recoveryOnly) {
      assert(savedSecond);
      return savedSecond;
    }
    savedSecond = f.output(args, "model");
    throw Error("Second result saved before transport failed");
  };
  const task = await f.prepare("M04");
  await f.approve(task.id);
  const stopped = f.state(),
    first = stopped.versions.find(
      (version) => version.id === stopped.tasks[0].outputVersionIds[0],
    )!;
  assert.equal(stopped.tasks[0].status, "failed");
  assert.equal(stopped.tasks[0].outputVersionIds.length, 1);
  const acceptedBefore = structuredClone(stopped.objects[0].accepted),
    firstBefore = structuredClone(first);
  await f.action({ kind: "recover", taskId: task.id });
  await f.idle();
  const recovered = f.state();
  assert.equal(recovered.tasks[0].status, "review");
  assert.equal(recovered.tasks[0].outputVersionIds.length, 2);
  assert.deepEqual(
    f.calls.map((call) => call.args.task.settings.variationSeed),
    [1, 2, 2],
  );
  assert.equal(f.calls[2].args.recoveryOnly, true);
  assert.deepEqual(
    recovered.versions.find((version) => version.id === first.id),
    firstBefore,
  );
  assert.deepEqual(recovered.objects[0].accepted, acceptedBefore);
  assert.equal(
    digest(fs.readFileSync(f.store.file(f.project.id, first.files[0].path))),
    first.files[0].sha256,
  );
  assert.equal(f.apiCalls, 0);
});

test("I08 uses the accepted whole design and registers a part without replacing the whole original", async (t) => {
  const f = await fixture(t, "character"),
    whole = f.seed("design");
  await f.accept(whole);
  await f.setCreation((c) => {
    c.attributes.composition = "parts";
    c.parts = humanParts();
    c.activePartId = "hair";
    c.stageSettings.design!.values.designMode = "parts";
    c.stageSettings.design!.values.count = 1;
  });
  f.implementations.native = async (args) => f.output(args, "design");
  const task = await f.prepare("I08");
  assert.deepEqual(task.inputVersionIds, [whole.id]);
  await f.approve(task.id);
  const w = f.state(),
    part = w.versions.find(
      (version) => version.id === w.tasks[0].outputVersionIds[0],
    )!;
  assert.equal(w.tasks[0].status, "review");
  assert.equal(part.slot, "part-hair");
  assert.deepEqual(part.sourceVersionIds, [whole.id]);
  assert.equal(w.objects[0].accepted["design:main"], whole.id);
  assert.equal(w.objects[0].accepted["design:part-hair"], undefined);
  await f.accept(part);
  assert.equal(f.state().objects[0].accepted["design:main"], whole.id);
  assert.equal(f.state().objects[0].accepted["design:part-hair"], part.id);
  assert.equal(
    digest(fs.readFileSync(f.store.file(f.project.id, whole.files[0].path))),
    whole.files[0].sha256,
  );
  assert.equal(f.apiCalls, 0);
});

test("M07 preserves distinct returned part slots and M08 requires all explicitly adopted parts", async (t) => {
  const f = await fixture(t, "character"),
    whole = f.seed("design"),
    mesh = f.seed("model");
  await f.accept(whole);
  await f.accept(mesh);
  await f.setCreation((c) => {
    c.attributes.composition = "parts";
    c.parts = humanParts();
    c.activePartId = "head";
    c.stageSettings.assembly!.values.assemblyMode = "separate";
  });
  f.implementations.astra = async (args) => {
    const outputs = humanParts().map((part) =>
      f.output(args, "model", `part-${part.id}`, `-${part.id}`),
    );
    return {
      files: outputs.flatMap((result) => result.files),
      role: "model",
      slot: "main",
      label: "Separated parts",
      warnings: [],
      candidates: outputs.map((result) => ({
        slot: result.slot,
        label: result.label,
        files: result.files,
        role: result.role,
        warnings: result.warnings,
      })),
    };
  };
  const task = await f.prepare("M07");
  assert.deepEqual(task.inputVersionIds, [mesh.id]);
  await f.approve(task.id);
  const w = f.state(),
    parts = w.versions.filter((version) =>
      w.tasks[0].outputVersionIds.includes(version.id),
    );
  assert.equal(w.tasks[0].status, "review");
  assert.deepEqual(
    parts.map((part) => part.slot),
    ["part-head", "part-body", "part-hair"],
  );
  assert.equal(w.objects[0].accepted["model:main"], mesh.id);
  await f.setCreation((c) => {
    c.stageSettings.assembly!.values.assemblyMode = "assemble";
  });
  await f.accept(parts[0]);
  await assert.rejects(f.prepare("M08"), /모델을 먼저 채택/);
  for (const part of parts.slice(1)) await f.accept(part);
  const assembly = await f.prepare("M08");
  assert.deepEqual(assembly.inputVersionIds, [
    ...parts.map((part) => part.id),
    whole.id,
  ]);
  assert.equal(assembly.settings.partId, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.apiCalls, 0);
});

test("Runway two-candidate estimate is aggregated but each child receives its own matching approval", async (t) => {
  const f = await fixture(t),
    source = f.seed("design");
  await f.accept(source);
  await f.setCreation((c) => {
    Object.assign(c.stageSettings.animation!.values, {
      animationMode: "video",
      clipName: "Jump",
      motionPreset: "jump",
      duration: 2,
      count: 2,
      motionSourceVersionId: source.id,
      motionSourcePath: source.files[0].path,
      motionSourceView: "left",
    });
  });
  let entered = 0,
    simultaneous!: () => void,
    release!: () => void;
  const bothEntered = new Promise<void>((resolve) => (simultaneous = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  f.implementations.video = async (args) => {
    if (++entered === 2) simultaneous();
    await gate;
    return f.output(args, "motion-reference", "Jump");
  };
  const task = await f.prepare("N02"),
    unit = runwayEstimate(2);
  assert.equal(task.cost!.credits, unit * 2);
  assert.equal(f.calls.length, 0);
  assert.equal(task.paidApproval, undefined);
  await f.action({ kind: "approve", taskId: task.id });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      bothEntered,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              Error("Independent video candidates did not enter concurrently"),
            ),
          1500,
        );
      }),
    ]);
    assert.equal(entered, 2);
    assert.equal(f.state().tasks[0].outputVersionIds.length, 0);
  } finally {
    clearTimeout(deadline);
    release();
    await f.idle();
  }
  assert.equal(f.state().tasks[0].status, "review");
  assert.equal(f.state().tasks[0].paidApproval!.credits, unit * 2);
  assert.equal(f.calls.length, 2);
  for (const { executor, args } of f.calls) {
    assert.equal(executor, "video");
    assert.equal(args.task.settings.count, 1);
    assert.equal(args.task.paidApproval!.credits, unit);
    assert.equal(args.task.paidApproval!.requestHash, args.task.requestHash);
    assert.notEqual(args.task.requestHash, task.requestHash);
    assert.equal(args.task.objectSnapshot!.accepted["design:main"], source.id);
  }
  assert.equal(
    new Set(f.calls.map((call) => call.args.task.requestHash)).size,
    2,
  );
  assert.equal(
    f.state().objects[0].accepted["motion-reference:Jump"],
    undefined,
  );
  assert.equal(f.apiCalls, 0);
});

test("a later ambiguous paid sibling keeps a partially completed video batch blocked and recovery checks every pending child", async (t) => {
  const f = await fixture(t), source = f.seed("design");
  await f.accept(source);
  await f.setCreation((c) => Object.assign(c.stageSettings.animation!.values, {
    animationMode: "video", clipName: "Jump", duration: 2, count: 3,
    motionSourceVersionId: source.id, motionSourcePath: source.files[0].path, motionSourceView: "left",
  }));
  let release!: () => void;
  const laterFailure = new Promise<void>((resolve) => { release = resolve; });
  f.implementations.video = async (args) => {
    const candidate = Number(args.task.settings.variationSeed);
    if (candidate === 3) return f.output(args, "motion-reference", "Jump");
    f.store.write(f.project.id, `graphics/jobs/${args.task.id}/external-request.json`, JSON.stringify({ jobId: args.task.id }));
    if (candidate === 1) {
      f.store.write(f.project.id, `graphics/video-journal/${f.objectId}/${args.task.id}-state.json`, JSON.stringify({ taskId: "known-remote-task" }));
      throw Object.assign(Error("Known remote task failed normally first"), { code: "video_pending_or_failed" });
    }
    await laterFailure;
    throw Object.assign(Error("Paid submission response was lost later"), { code: "submission_unknown" });
  };
  const task = await f.prepare("N02"), accepted = structuredClone(f.state().objects[0].accepted);
  await f.action({ kind: "approve", taskId: task.id });
  // Let the first ordinary rejection and the third successful registration settle
  // before the second candidate reports an ambiguous paid submission.
  await new Promise<void>((resolve) => setImmediate(resolve));
  release(); await f.idle();
  const stopped = f.state(), completed = stopped.versions.find(version => version.id === stopped.tasks[0].outputVersionIds[0])!;
  assert.equal(stopped.tasks[0].status, "submission_unknown");
  assert.match(stopped.tasks[0].message, /response was lost later/);
  assert.equal(stopped.tasks[0].outputVersionIds.length, 1);
  assert.deepEqual(stopped.tasks[0].completedExecutions, [`${task.id}-c3`]);
  assert.deepEqual(stopped.objects[0].accepted, accepted);
  assert.equal(digest(fs.readFileSync(f.store.file(f.project.id, completed.files[0].path))), completed.files[0].sha256);
  await assert.rejects(f.prepare("N02"), /기존 작업/);
  await assert.rejects(f.action({ kind: "recover", taskId: task.id }), /원격 작업 ID|첫 업로드/);
  assert.equal(f.state().tasks[0].status, "submission_unknown");
  assert.deepEqual(f.state().versions.find(version => version.id === completed.id), completed);
  assert.deepEqual(f.state().objects[0].accepted, accepted);
  assert.equal(f.calls.length, 3); assert.equal(f.apiCalls, 0);
});
