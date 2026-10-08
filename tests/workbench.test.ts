import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { WorkbenchEngine } from "../engine/workbench";
import { buildWorkbenchGlb } from "./fixtures/workbench-glb";
import type {
  WorkbenchExecutionContext,
  WorkbenchExecutor,
  WorkbenchRequest,
  WorkbenchResult,
  WorkbenchView,
} from "../shared/workbench";

// These are synthetic fixtures for host state-machine validation, not generation-quality evidence.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const image = (label: string) =>
  Buffer.concat([png, Buffer.from(`mock:${label}`)]);
let fixtureModelSequence = 0;
function glb(_label: string) {
  return buildWorkbenchGlb(++fixtureModelSequence);
}
class MockExecutor implements WorkbenchExecutor {
  calls: WorkbenchExecutionContext[] = [];
  progressCallbacks: ((message: string) => void)[] = [];
  recover?: WorkbenchExecutor["recover"];
  inspectSaved?: WorkbenchExecutor["inspectSaved"];
  submitted = new Set<string>();
  hasSubmission(job: { id: string }) {
    return this.submitted.has(job.id);
  }
  hook?: (
    ctx: WorkbenchExecutionContext,
    result: WorkbenchResult,
  ) => WorkbenchResult | Promise<WorkbenchResult>;
  async execute(
    ctx: WorkbenchExecutionContext,
    onProgress = (_message: string) => {},
  ) {
    this.calls.push(ctx);
    this.progressCallbacks.push(onProgress);
    const result = this.fixture(ctx);
    return this.hook ? this.hook(ctx, result) : result;
  }
  fixture(ctx: WorkbenchExecutionContext): WorkbenchResult {
    const step = ctx.job.step;
    const candidates: WorkbenchResult["candidates"] = [];
    for (let i = 0; i < (step === "concept" ? 4 : 1); i++) {
      const artifacts: WorkbenchResult["candidates"][number]["artifacts"] = [];
      const write = (
        name: string,
        bytes: string | Buffer,
        kind: (typeof artifacts)[number]["kind"],
        role?: string,
        view?: WorkbenchView,
      ) => {
        const relative = `${i}/${name}`;
        fs.mkdirSync(path.dirname(path.join(ctx.workspace, relative)), {
          recursive: true,
        });
        fs.writeFileSync(path.join(ctx.workspace, relative), bytes);
        artifacts.push({ path: relative, kind, role, view });
        return relative;
      };
      write(
        "report.json",
        "\uFEFF" + JSON.stringify({ synthetic: true }),
        "report",
      );
      if (step === "concept")
        write("candidate.png", image(`${ctx.job.id}-${i}`), "image");
      if (step === "model")
        write(
          "candidate.glb",
          glb(`${ctx.job.id}-${i}`),
          "model",
          ctx.job.request.role,
        );
      if (step === "separate")
        for (const role of ["head", "hair", "body"])
          for (const view of ctx.job.request.views ?? ["front"])
            write(
              `${role}-${view}.png`,
              image(`${role}-${view}`),
              "image",
              role,
              ctx.job.request.views ? view : undefined,
            );
      if (step === "surface")
        for (const role of ["head", "hair", "body"])
          write(`${role}.glb`, glb(role), "model", role);
      if (["assembly", "rig", "animation"].includes(step)) {
        write("scene.blend", `BLENDER-v500 mock ${ctx.job.id}`, "blend");
        write("scene.glb", glb(ctx.job.id), "model");
        write("review.png", image(ctx.job.id), "image");
      }
      if (step === "reference") {
        const times = Array.from(
          { length: ctx.job.request.referenceFrameCount ?? 3 },
          (_, i) =>
            (i * (ctx.job.request.duration ?? 2)) /
            ((ctx.job.request.referenceFrameCount ?? 3) - 1),
        );
        const frames = times.map((time) => ({
          time,
          front: write(`front-${time}.png`, image(`front-${time}`), "image"),
          side: write(`side-${time}.png`, image(`side-${time}`), "image"),
          back: write(`back-${time}.png`, image(`back-${time}`), "image"),
        }));
        write(
          "frames.json",
          "\uFEFF" +
            JSON.stringify({
              schemaVersion: 1,
              motion: ctx.job.request.motion,
              fps: ctx.job.request.fps,
              duration: ctx.job.request.duration,
              camera: "fixed",
              frames,
            }),
          "frames",
        );
      }
      if (step === "unity") write("character.fbx", "mock export", "export");
      candidates.push({
        id: `candidate-${i}`,
        label: `Synthetic candidate ${i}`,
        artifacts,
        ...(step === "assembly"
          ? {
              objects: [
                {
                  id: "body",
                  name: "Body",
                  category: "body" as const,
                  separate: true,
                },
                {
                  id: "hair",
                  name: "Hair",
                  category: "hair" as const,
                  separate: true,
                },
                {
                  id: "skirt",
                  name: "Skirt",
                  category: "clothing" as const,
                  separate: true,
                },
                {
                  id: "merged-sleeve",
                  name: "Merged sleeve",
                  category: "clothing" as const,
                  separate: false,
                },
              ],
            }
          : {}),
      });
    }
    return {
      status: "completed",
      summary: "Synthetic test completion, review required",
      candidates,
      checks: [{ name: "synthetic-only", passed: true }],
    };
  }
}
async function setup(
  t: TestContext,
  source = true,
  recoveryDelaysMs = [0, 0, 0],
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-guided-test-"));
  const store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  const project = new Engine(store, {} as any).create("Guided synthetic test");
  store.write(project.id, "assets/front.png", image("source"));
  project.assets.push({
    id: "front",
    kind: "image",
    file: "assets/front.png",
    label: "Synthetic source",
  } as any);
  store.save(project);
  const executor = new MockExecutor(),
    engine = new WorkbenchEngine(store, executor, { recoveryDelaysMs }),
    w = engine.create(project.id);
  t.after(() => {
    engine.shutdown();
    store.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (source) engine.importSource(w.id, "front");
  const execute = async (request: WorkbenchRequest, accept = false) => {
    const running = engine.execute(w.id, request, {
      accepted: true,
      studioCreditLimit: 1000,
      imageCreditLimit: 100,
    });
    const jobId = running.activeJobId!;
    const completed = await engine.wait(w.id);
    const job = completed.jobs.find((j) => j.id === jobId)!;
    if (accept) {
      assert.equal(job.status, "review", job.summary);
      if (job.candidates.length === 1) engine.accept(w.id, jobId);
      else engine.select(w.id, jobId, job.candidates[0].id);
    }
    return job;
  };
  const assemble = async () => {
    await execute({ step: "separate", prompt: "separate" }, true);
    for (const role of ["head", "hair", "body"] as const)
      await execute(
        { step: "model", prompt: "generate", role, polygonCount: 10000 },
        true,
      );
    await execute({ step: "surface", prompt: "UV and texture" }, true);
    return execute({ step: "assembly", prompt: "match front" }, true);
  };
  return { root, store, project, executor, engine, w, execute, assemble };
}

test("guided steps require chosen inputs and explicit generation scope; default concept provider is GPT", async (t) => {
  const x = await setup(t, false);
  assert.throws(
    () => x.engine.execute(x.w.id, { step: "separate", prompt: "split" }),
    /concept/,
  );
  assert.throws(
    () => x.engine.execute(x.w.id, { step: "concept", prompt: "hero" }),
    /비용/,
  );
  assert.equal(x.executor.calls.length, 0);
  const job = await x.execute({ step: "concept", prompt: "hero" });
  assert.equal(job.request.provider, "gpt");
  assert.equal(job.candidates.length, 4);
  assert.equal(job.status, "review");
  assert.deepEqual(x.engine.get(x.w.id).selections, {});
  assert.equal(x.executor.calls.length, 1);
  assert.throws(() => x.engine.accept(x.w.id, job.id), /하나/);
  x.engine.select(x.w.id, job.id, job.candidates[2].id);
  assert.equal(
    x.engine.get(x.w.id).selections.concept.candidateId,
    job.candidates[2].id,
  );
  assert.equal(
    x.executor.calls.length,
    1,
    "selection never starts the next worker",
  );
});

test("separation review gates models and all three chosen part candidates gate UV/textures", async (t) => {
  const x = await setup(t);
  const separated = await x.execute({ step: "separate", prompt: "split" });
  assert.equal(separated.status, "review");
  assert.throws(
    () =>
      x.engine.execute(
        x.w.id,
        { step: "model", prompt: "head", role: "head" },
        { accepted: true, studioCreditLimit: 100, imageCreditLimit: 0 },
      ),
    /separate/,
  );
  x.engine.accept(x.w.id, separated.id);
  await x.execute({ step: "model", prompt: "head", role: "head" }, true);
  assert.throws(
    () =>
      x.engine.execute(
        x.w.id,
        { step: "surface", prompt: "surface" },
        { accepted: true, studioCreditLimit: 100, imageCreditLimit: 0 },
      ),
    /model:hair/,
  );
  assert.equal(x.executor.calls.length, 2);
});

test("host rejects replicated candidates and can revalidate retained results without another generation", async (t) => {
  const x = await setup(t, false);
  let retained: WorkbenchResult | undefined;
  x.executor.hook = (_, result) => {
    retained = structuredClone(result);
    result.candidates.pop();
    return result;
  };
  const job = await x.execute({ step: "concept", prompt: "hero" });
  assert.equal(job.status, "failed");
  assert.equal(job.validationPending, true);
  const resultFile = x.store.file(
    x.project.id,
    `workbench/${x.w.id}/jobs/${job.id}/.worker-result.json`,
  );
  fs.writeFileSync(resultFile, "\uFEFF" + JSON.stringify(retained));
  x.engine.retryValidation(x.w.id, job.id);
  assert.equal(x.engine.get(x.w.id).jobs[0].status, "review");
  assert.equal(x.executor.calls.length, 1);
  x.executor.hook = (_, result) => {
    for (const c of result.candidates)
      c.artifacts = result.candidates[0].artifacts;
    return result;
  };
  const duplicate = await x.execute({ step: "concept", prompt: "hero again" });
  assert.equal(duplicate.status, "failed");
  assert.match(duplicate.summary, /서로 다른 후보/);
});

test("immutable input tampering is detected before another worker runs", async (t) => {
  const x = await setup(t);
  const selected = x.engine.get(x.w.id).jobs[0].candidates[0].artifacts[0];
  fs.appendFileSync(x.store.file(x.project.id, selected.path), "modified");
  assert.throws(
    () => x.engine.execute(x.w.id, { step: "separate", prompt: "split" }),
    /변경/,
  );
  assert.equal(x.executor.calls.length, 0);
});

test("assembly edits preserve versions and explicit restore invalidates downstream rig without deleting files", async (t) => {
  const x = await setup(t);
  const original = await x.assemble();
  const rig = await x.execute(
    {
      step: "rig",
      prompt: "rig",
      rigTargets: [{ objectId: "hair", extraBones: true }],
    },
    true,
  );
  const targets = rig.request.rigTargets!;
  assert.equal(targets.find((t) => t.objectId === "hair")?.extraBones, true);
  assert.equal(targets.find((t) => t.objectId === "skirt")?.extraBones, false);
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "rig",
        prompt: "bad target",
        rigTargets: [{ objectId: "merged-sleeve", extraBones: true }],
      }),
    /식별·분리/,
  );
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "assembly",
        prompt: "edit",
        baseJobId: original.id,
        objectIds: ["missing"],
      }),
    /존재/,
  );
  const edited = await x.execute({
    step: "assembly",
    prompt: "reduce head",
    baseJobId: original.id,
    objectIds: ["body"],
  });
  assert.equal(
    x.engine.get(x.w.id).selections.assembly.jobId,
    original.id,
    "unaccepted edit leaves accepted assembly intact",
  );
  x.engine.accept(x.w.id, edited.id);
  assert.equal(x.engine.get(x.w.id).selections.rig, undefined);
  assert.ok(
    fs.existsSync(
      x.store.file(x.project.id, rig.candidates[0].artifacts[0].path),
    ),
  );
  x.engine.revert(x.w.id, original.id);
  assert.equal(x.engine.get(x.w.id).selections.assembly.jobId, original.id);
  assert.equal(
    x.engine.get(x.w.id).selections.rig,
    undefined,
    "restoring assembly does not silently accept old rig",
  );
});

test("reference review precedes animation and BOM multiview manifests preserve synchronized timing", async (t) => {
  const x = await setup(t);
  await x.assemble();
  await x.execute({ step: "rig", prompt: "rig" }, true);
  const references = await x.execute({
    step: "reference",
    prompt: "wave",
    motion: "wave",
    duration: 2,
    fps: 12,
    loop: false,
  });
  assert.equal(references.status, "review", references.summary);
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "animation",
        prompt: "animate",
        motion: "wave",
      }),
    /reference:wave/,
  );
  x.engine.accept(x.w.id, references.id);
  const animated = await x.execute(
    { step: "animation", prompt: "animate reference", motion: "wave" },
    true,
  );
  assert.equal(animated.dependencies["reference:wave"].jobId, references.id);
  const exported = await x.execute({ step: "unity", prompt: "validate" });
  assert.equal(exported.status, "review");
  assert.equal(x.engine.get(x.w.id).selections.unity, undefined);
});

test("host rejects static repeated multiview images instead of calling them animation references", async (t) => {
  const x = await setup(t);
  await x.assemble();
  await x.execute({ step: "rig", prompt: "rig" }, true);
  x.executor.hook = (ctx, result) => {
    const manifest = result.candidates[0].artifacts.find(
      (a) => a.kind === "frames",
    )!;
    const file = path.join(ctx.workspace, manifest.path);
    const doc = JSON.parse(
      fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
    );
    for (const frame of doc.frames) frame.front = doc.frames[0].front;
    fs.writeFileSync(file, JSON.stringify(doc));
    return result;
  };
  const job = await x.execute({
    step: "reference",
    prompt: "wave",
    motion: "wave",
  });
  assert.equal(job.status, "failed");
  assert.match(job.summary, /정지 이미지/);
});

test("interrupting an external operation blocks retry until user confirms it was not submitted", async (t) => {
  const x = await setup(t, false);
  x.executor.hook = (ctx, result) =>
    new Promise((resolve) =>
      ctx.signal.addEventListener("abort", () => resolve(result), {
        once: true,
      }),
    );
  const w = x.engine.execute(
    x.w.id,
    { step: "concept", prompt: "hero" },
    { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  x.engine.cancel(x.w.id);
  await x.engine.wait(x.w.id);
  assert.equal(x.engine.get(x.w.id).jobs[0].status, "submission_unknown");
  assert.throws(
    () => x.engine.execute(x.w.id, { step: "concept", prompt: "hero" }),
    /이전 제출/,
  );
  x.engine.action(x.project.id, {
    kind: "resolve-submission",
    jobId: w.activeJobId!,
    confirmedNotSubmitted: true,
  });
  assert.equal(x.engine.get(x.w.id).jobs[0].status, "cancelled");
  assert.equal(x.executor.calls.length, 1);
});

test("restart recovers running work without invoking executor or advancing", async (t) => {
  const x = await setup(t);
  const w = x.engine.get(x.w.id);
  w.jobs.unshift({
    id: "interrupted",
    step: "model",
    slot: "model:head",
    request: { step: "model", role: "head", prompt: "old" },
    status: "running",
    createdAt: "",
    updatedAt: "",
    summary: "",
    dependencies: {},
    approval: { accepted: true, studioCreditLimit: 100, imageCreditLimit: 0 },
    candidates: [],
    checks: [],
  });
  w.activeJobId = "interrupted";
  x.store.put("workbench", w.id, w);
  const recovered = new WorkbenchEngine(x.store, x.executor).get(w.id);
  assert.equal(recovered.jobs[0].status, "submission_unknown");
  assert.equal(recovered.activeJobId, undefined);
  assert.equal(x.executor.calls.length, 0);
});

test("one shared Studio worker cannot start or resume a second project concurrently", async (t) => {
  const x = await setup(t, false);
  const project = new Engine(x.store, {} as any).create("Second project");
  const second = x.engine.create(project.id);
  const firstSecondJob = x.engine.execute(
    second.id,
    { step: "concept", prompt: "second concept" },
    { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 },
  );
  await x.engine.wait(second.id);
  const secondState = x.engine.get(second.id);
  secondState.jobs[0].status = "failed";
  x.store.put("workbench", secondState.id, secondState);
  let finish: (() => void) | undefined;
  x.executor.hook = (_, result) =>
    new Promise((resolve) => {
      finish = () => resolve(result);
    });
  x.engine.execute(
    x.w.id,
    { step: "concept", prompt: "first concept" },
    { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => x.engine.execute(second.id, { step: "concept", prompt: "parallel" }),
    /다른 프로젝트/,
  );
  assert.throws(
    () => x.engine.retry(second.id, firstSecondJob.activeJobId!),
    /다른 프로젝트/,
  );
  assert.equal(x.executor.calls.length, 2);
  finish!();
  await x.engine.wait(x.w.id);
  x.executor.hook = undefined;
  x.engine.retry(second.id, firstSecondJob.activeJobId!);
  await x.engine.wait(second.id);
  assert.equal(x.executor.calls.length, 3);
});

test("paid partial work resumes the same immutable job and cannot be replaced or declared unsubmitted", async (t) => {
  const x = await setup(t, false);
  x.executor.hook = (ctx, result) => {
    x.executor.submitted.add(ctx.job.id);
    return {
      ...result,
      status: "needs_input",
      summary: "Mock provider needs login after partial completion",
      candidates: [],
    };
  };
  const job = await x.execute({
    step: "concept",
    provider: "tripo",
    prompt: "hero",
  });
  assert.equal(job.status, "needs_input");
  assert.throws(
    () => x.engine.execute(x.w.id, { step: "concept", prompt: "new hero" }),
    /이미 제출/,
  );
  x.executor.hook = undefined;
  x.engine.retry(x.w.id, job.id);
  const resumed = await x.engine.wait(x.w.id);
  assert.equal(resumed.jobs[0].status, "review");
  assert.equal(resumed.jobs.length, 1);
  assert.equal(x.executor.calls[0].workspace, x.executor.calls[1].workspace);
  assert.deepEqual(
    x.executor.calls[0].job.approval,
    x.executor.calls[1].job.approval,
  );
  assert.equal(
    x.executor.calls[0].job.request.prompt,
    x.executor.calls[1].job.request.prompt,
  );
  const w = x.engine.get(x.w.id);
  w.jobs[0].status = "submission_unknown";
  x.store.put("workbench", w.id, w);
  assert.throws(
    () =>
      x.engine.action(x.project.id, {
        kind: "resolve-submission",
        jobId: job.id,
        confirmedNotSubmitted: true,
      }),
    /실제 제출/,
  );
});

test("upstream selection cannot orphan a paid partial job; it unlocks after the existing work finishes", async (t) => {
  const x = await setup(t);
  const originalConcept = x.engine.get(x.w.id).selections.concept;
  await x.execute({ step: "separate", prompt: "split" }, true);
  x.executor.hook = (ctx, result) => {
    x.executor.submitted.add(ctx.job.id);
    return { ...result, status: "needs_input", candidates: [] };
  };
  const partial = await x.execute({
    step: "model",
    role: "head",
    prompt: "head",
  });
  assert.throws(
    () => x.engine.importSource(x.w.id, "front"),
    /이미 제출된 작업/,
  );
  assert.deepEqual(x.engine.get(x.w.id).selections.concept, originalConcept);
  x.executor.hook = undefined;
  x.engine.retry(x.w.id, partial.id);
  await x.engine.wait(x.w.id);
  assert.doesNotThrow(() => x.engine.importSource(x.w.id, "front"));
  assert.equal(x.executor.calls.length, 3);
});

test("reference phase count is explicit and must match generated frames including both endpoints", async (t) => {
  const x = await setup(t);
  await x.assemble();
  await x.execute({ step: "rig", prompt: "rig" }, true);
  const four = await x.execute({
    step: "reference",
    prompt: "wave",
    motion: "wave",
    referenceFrameCount: 4,
    duration: 2,
  });
  assert.equal(four.status, "review", four.summary);
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "reference",
        prompt: "wave",
        motion: "wave",
        referenceFrameCount: 13,
      }),
    /3~12/,
  );
  x.executor.hook = (ctx, result) => {
    const manifest = result.candidates[0].artifacts.find(
      (a) => a.kind === "frames",
    )!;
    const file = path.join(ctx.workspace, manifest.path);
    const doc = JSON.parse(
      fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
    );
    doc.frames.pop();
    fs.writeFileSync(file, JSON.stringify(doc));
    return result;
  };
  const mismatch = await x.execute({
    step: "reference",
    prompt: "wave",
    motion: "wave",
    referenceFrameCount: 4,
  });
  assert.equal(mismatch.status, "failed");
  assert.match(mismatch.summary, /프레임 명세/);
});

test("legacy verified separation imports as review only and rejects a different reference character", async (t) => {
  const x = await setup(t);
  const source = x.engine.get(x.w.id).jobs[0].candidates[0].artifacts[0];
  const artifacts = (["head", "hair", "body"] as const).map((role) => ({
    role,
    file: x.store.write(x.project.id, `legacy/${role}.png`, image(role)),
  }));
  assert.throws(
    () =>
      x.engine.importSeparation(x.w.id, {
        sourceSha256: "mismatch",
        artifacts,
      }),
    /원본/,
  );
  const restored = x.engine.importSeparation(x.w.id, {
    sourceSha256: source.sha256,
    artifacts,
  });
  assert.equal(restored.jobs[0].step, "separate");
  assert.equal(restored.jobs[0].status, "review");
  assert.equal(restored.selections.separate, undefined);
  assert.equal(x.executor.calls.length, 0);
});

test("backup restore copies only verified registered files and refuses tampered assets", async (t) => {
  const x = await setup(t);
  await x.execute({ step: "separate", prompt: "split" }, true);
  const backup = path.join(x.root, "backup");
  fs.cpSync(x.store.directory(x.project.id), backup, { recursive: true });
  const otherRoot = path.join(x.root, "restored");
  const other = new Store(otherRoot);
  await other.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  t.after(() => other.db.close());
  other.save(x.store.project(x.project.id));
  const restored = new WorkbenchEngine(other, new MockExecutor());
  restored.restoreFromBackup(x.project.id, backup);
  assert.equal(
    restored.get(x.w.id).selections.separate.jobId,
    x.engine.get(x.w.id).selections.separate.jobId,
  );
  const asset = restored.get(x.w.id).jobs[0].candidates[0].artifacts[0];
  fs.appendFileSync(path.join(backup, asset.path), "tamper");
  assert.throws(() => restored.restoreFromBackup(x.project.id, backup), /손상/);
});

test("files outside an immutable job workspace cannot be registered by worker output", async (t) => {
  const x = await setup(t, false);
  x.executor.hook = (_, result) => {
    result.candidates[0].artifacts[0].path = "../../../../assets/front.png";
    return result;
  };
  const result = await x.execute({ step: "concept", prompt: "hero" });
  assert.equal(result.status, "failed");
  assert.match(result.summary, /밖 파일/);
  assert.deepEqual(result.candidates, []);
});

test("classified transient failure recovers the same frozen job and waits for user review", async (t) => {
  const x = await setup(t, false);
  const recoveries: WorkbenchExecutionContext[] = [];
  x.executor.hook = (ctx, result) => {
    // The worker's context is a disposable copy, never the next retry's budget.
    ctx.job.request.prompt = "worker-mutated prompt";
    ctx.job.approval.studioCreditLimit = 99999;
    return {
      ...result,
      status: "needs_input",
      summary: "Temporary download unavailable",
      candidates: [],
      recovery: { kind: "retry", reason: "Resume confirmed download" },
    };
  };
  x.executor.recover = async (ctx) => {
    recoveries.push(ctx);
    return x.executor.fixture(ctx);
  };
  const job = await x.execute({ step: "concept", prompt: "approved hero" });
  assert.equal(
    x.executor.calls.length,
    1,
    "execute is never replayed automatically",
  );
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].job.id, job.id);
  assert.equal(recoveries[0].workspace, x.executor.calls[0].workspace);
  assert.equal(recoveries[0].job.request.prompt, "approved hero");
  assert.equal(recoveries[0].job.approval.studioCreditLimit, 1000);
  assert.deepEqual(recoveries[0].recovery, {
    attempt: 1,
    error: "Resume confirmed download",
    mode: "retry",
  });
  assert.equal(job.status, "review");
  assert.equal(job.recovery, undefined);
  assert.match(job.summary, /자동 복구 1회/);
  assert.equal(x.engine.get(x.w.id).jobs.length, 1);
  assert.deepEqual(x.engine.get(x.w.id).selections, {});
  assert.equal(x.engine.get(x.w.id).activeJobId, undefined);
});

test("automatic recovery is bounded to three calls and retains an actionable exhaustion reason", async (t) => {
  const x = await setup(t);
  let recoveries = 0;
  const failure: WorkbenchResult = {
    status: "needs_input",
    summary: "Local inspection could not open the saved asset",
    candidates: [],
    checks: [],
    recovery: { kind: "repair", reason: "Repair saved inspection script" },
  };
  x.executor.hook = () => failure;
  x.executor.recover = async (ctx) => {
    recoveries++;
    assert.equal(ctx.recovery?.attempt, recoveries);
    assert.equal(ctx.job.recovery?.state, "running");
    assert.equal(ctx.job.recovery?.nextAttemptAt, undefined);
    return failure;
  };
  const job = await x.execute({ step: "separate", prompt: "split" });
  assert.equal(x.executor.calls.length, 1);
  assert.equal(recoveries, 3);
  assert.equal(job.status, "needs_input");
  assert.deepEqual(job.recovery, {
    attempt: 3,
    maxAttempts: 3,
    state: "exhausted",
    reason: "Repair saved inspection script",
  });
  assert.match(job.summary, /3회 후에도/);
  assert.equal(x.engine.get(x.w.id).activeJobId, undefined);
  x.executor.hook = undefined;
  x.engine.retry(x.w.id, job.id);
  const manuallyResumed = await x.engine.wait(x.w.id);
  assert.equal(manuallyResumed.jobs[0].status, "review");
  assert.equal(manuallyResumed.jobs[0].recovery, undefined);
  assert.equal(x.executor.calls.length, 2);
});

test("human input, ambiguous submission and unclassified exceptions never trigger automatic recovery", async (t) => {
  for (const kind of ["human", "ambiguous", "exception"] as const) {
    await t.test(kind, async (t) => {
      const x = await setup(t, false);
      let recoveries = 0;
      x.executor.recover = async (ctx) => {
        recoveries++;
        return x.executor.fixture(ctx);
      };
      x.executor.hook = () => {
        if (kind === "exception")
          throw new Error("Unknown worker transport failure");
        return {
          status: kind === "ambiguous" ? "submission_unknown" : "needs_input",
          summary:
            kind === "ambiguous"
              ? "Submission receipt unknown"
              : "User login required",
          candidates: [],
          checks: [],
          recovery: {
            kind: kind === "ambiguous" ? "retry" : "blocked",
            reason: "Do not automatically spend again",
          },
        };
      };
      const job = await x.execute({ step: "concept", prompt: "hero" });
      assert.equal(recoveries, 0);
      assert.equal(x.executor.calls.length, 1);
      assert.equal(job.recovery?.state, "blocked");
      assert.equal(job.recovery?.attempt, 0);
      assert.equal(
        job.status,
        kind === "human" ? "needs_input" : "submission_unknown",
      );
    });
  }
});

test("completed result validation failures use local repair and preserve frozen inputs", async (t) => {
  const x = await setup(t);
  let recoveries = 0;
  x.executor.hook = (_ctx, result) => {
    result.candidates[0].artifacts = result.candidates[0].artifacts.filter(
      (a) => a.role !== "hair",
    );
    return result;
  };
  x.executor.recover = async (ctx) => {
    recoveries++;
    assert.equal(ctx.recovery?.mode, "repair");
    assert.match(ctx.recovery!.error, /머리·머리카락·몸통/);
    assert.equal(ctx.job.validationPending, true);
    assert.deepEqual(ctx.inputs, x.executor.calls[0].inputs);
    const retained = JSON.parse(
      fs.readFileSync(path.join(ctx.workspace, ".worker-result.json"), "utf8"),
    );
    assert.equal(retained.status, "completed");
    return x.executor.fixture(ctx);
  };
  const job = await x.execute({ step: "separate", prompt: "split" });
  assert.equal(job.status, "review", job.summary);
  assert.equal(recoveries, 1);
  assert.equal(x.executor.calls.length, 1);
  assert.equal(job.validationPending, false);
  assert.equal(x.engine.get(x.w.id).selections.separate, undefined);
});

test("cancel interrupts recovery backoff, preserves saved work and ignores late progress", async (t) => {
  const x = await setup(t, true, [30000, 30000, 30000]);
  let recoveries = 0;
  x.executor.hook = (_ctx, result) => ({
    ...result,
    status: "needs_input",
    candidates: [],
    recovery: { kind: "retry", reason: "Transient read timeout" },
  });
  x.executor.recover = async (ctx) => {
    recoveries++;
    return x.executor.fixture(ctx);
  };
  x.engine.execute(x.w.id, { step: "separate", prompt: "split" });
  await new Promise((resolve) => setImmediate(resolve));
  const pending = x.engine.get(x.w.id);
  assert.equal(pending.jobs[0].status, "running");
  assert.equal(pending.jobs[0].recovery?.state, "waiting");
  assert.ok(pending.jobs[0].recovery?.nextAttemptAt);
  x.executor.progressCallbacks[0](
    "Late callback from finished initial invocation",
  );
  assert.equal(x.engine.get(x.w.id).jobs[0].summary, pending.jobs[0].summary);
  assert.throws(
    () => x.engine.execute(x.w.id, { step: "separate", prompt: "duplicate" }),
    /현재 작업/,
  );
  const started = Date.now();
  x.engine.cancel(x.w.id);
  const stopped = await x.engine.wait(x.w.id);
  assert.ok(
    Date.now() - started < 1000,
    "cancel must not wait for the entire backoff",
  );
  assert.equal(recoveries, 0);
  assert.equal(stopped.jobs[0].status, "cancelled");
  assert.equal(stopped.jobs[0].recovery?.state, "blocked");
  assert.equal(stopped.jobs[0].recovery?.nextAttemptAt, undefined);
  x.executor.progressCallbacks[0]("Late callback after cancellation");
  assert.equal(x.engine.get(x.w.id).jobs[0].summary, stopped.jobs[0].summary);
  assert.equal(
    x.engine.get(x.w.id).selections.concept.jobId,
    pending.selections.concept.jobId,
  );
});

test("shutdown during a running repair ignores its eventual completion and never starts a stage", async (t) => {
  const x = await setup(t);
  let repairStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    repairStarted = resolve;
  });
  let finishRepair!: () => void;
  let lateProgress!: (message: string) => void;
  x.executor.hook = (_ctx, result) => ({
    ...result,
    status: "needs_input",
    candidates: [],
    recovery: { kind: "repair", reason: "Repair local output" },
  });
  x.executor.recover = async (ctx, progress) => {
    lateProgress = progress;
    repairStarted();
    await new Promise<void>((resolve) => {
      finishRepair = resolve;
    });
    return x.executor.fixture(ctx);
  };
  x.engine.execute(x.w.id, { step: "separate", prompt: "split" });
  await ready;
  x.engine.shutdown();
  lateProgress("Worker returned after shutdown");
  finishRepair();
  const stopped = await x.engine.wait(x.w.id);
  assert.equal(stopped.jobs[0].status, "cancelled");
  assert.equal(stopped.jobs[0].candidates.length, 0);
  assert.equal(stopped.selections.separate, undefined);
  assert.equal(x.executor.calls.length, 1);
});

test("restarting with pending recovery never restarts a worker or its timer", async (t) => {
  const x = await setup(t);
  const job = await x.execute({ step: "separate", prompt: "split" });
  const snapshot = x.engine.get(x.w.id);
  snapshot.jobs[0].status = "running";
  snapshot.jobs[0].recovery = {
    attempt: 2,
    maxAttempts: 3,
    state: "waiting",
    reason: "Saved transient failure",
    nextAttemptAt: new Date().toISOString(),
  };
  snapshot.activeJobId = job.id;
  x.store.put("workbench", x.w.id, snapshot);
  const restored = new WorkbenchEngine(x.store, x.executor, {
    recoveryDelaysMs: [0, 0, 0],
  });
  const recovered = restored.get(x.w.id);
  assert.equal(recovered.jobs[0].status, "failed");
  assert.equal(recovered.jobs[0].recovery?.state, "blocked");
  assert.equal(recovered.jobs[0].recovery?.nextAttemptAt, undefined);
  assert.equal(recovered.activeJobId, undefined);
  assert.equal(x.executor.calls.length, 1);
});

test("separation visual observations stay false warnings and permit user review without repair", async (t) => {
  const x = await setup(t);
  let recoveries = 0;
  x.executor.hook = (_, result) => ({
    ...result,
    checks: [
      { name: "original_position_and_scale_preserved", passed: false },
      { name: "hair:original_alignment_and_scale_preserved", passed: false },
      { name: "clean_peripheral_alpha", passed: false },
    ],
  });
  x.executor.recover = async (ctx) => {
    recoveries++;
    return x.executor.fixture(ctx);
  };
  const job = await x.execute({ step: "separate", prompt: "split" });
  assert.equal(job.status, "review", job.summary);
  assert.equal(recoveries, 0);
  assert.ok(
    job.checks.every((c) => c.passed === false && c.severity === "warning"),
  );
  assert.equal(x.engine.get(x.w.id).selections.separate, undefined);
  assert.throws(
    () =>
      x.engine.execute(
        x.w.id,
        {
          step: "model",
          prompt: "model",
          role: "head",
          polygonCount: 10000,
        },
        { accepted: true, studioCreditLimit: 1000, imageCreditLimit: 0 },
      ),
    /separate/,
  );
  x.engine.accept(x.w.id, job.id);
  assert.equal(x.engine.get(x.w.id).selections.separate.jobId, job.id);
});

test("unknown failures and visual failures outside separation remain blocking despite worker severity", async (t) => {
  for (const [step, name] of [
    ["separate", "source_hash_matches"],
    ["concept", "clean_peripheral_alpha"],
  ] as const) {
    const x = await setup(t);
    x.executor.hook = (_, result) => ({
      ...result,
      checks: [{ name, passed: false, severity: "warning" }],
    });
    const job = await x.execute({ step, prompt: "test" });
    assert.equal(job.status, "failed");
    assert.equal(job.candidates.length, 0);
  }
});

test("validated separation drafts appear before completion, cannot be selected, and survive cancellation", async (t) => {
  const x = await setup(t);
  let release!: () => void;
  let draft!: WorkbenchResult;
  x.executor.hook = async (ctx, result) => {
    draft = {
      ...result,
      candidates: [
        {
          ...result.candidates[0],
          artifacts: result.candidates[0].artifacts.filter(
            (a) =>
              a.kind === "report" || (a.role === "head" && a.view === "front"),
          ),
        },
      ],
      checks: [{ name: "clean_peripheral_alpha", passed: false }],
    };
    ctx.onDraft!(draft);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return result;
  };
  x.engine.execute(x.w.id, { step: "separate", prompt: "split" });
  await new Promise((resolve) => setImmediate(resolve));
  const live = x.engine.get(x.w.id).jobs[0];
  assert.equal(live.status, "running");
  assert.equal(live.candidates.length, 0);
  assert.equal(
    live.draftCandidates?.[0].artifacts.filter((a) => a.kind === "image")
      .length,
    1,
  );
  assert.equal(live.draftChecks?.[0].severity, "warning");
  assert.match(live.draftCandidates![0].artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.throws(
    () => x.engine.select(x.w.id, live.id, live.draftCandidates![0].id),
    /현재 작업/,
  );
  x.engine.cancel(x.w.id);
  x.executor.calls[0].onDraft!({ ...draft, checks: [] });
  release();
  const stopped = (await x.engine.wait(x.w.id)).jobs[0];
  assert.equal(stopped.status, "cancelled");
  assert.deepEqual(stopped.draftCandidates, live.draftCandidates);
  assert.deepEqual(stopped.draftChecks, live.draftChecks);
  assert.equal(stopped.candidates.length, 0);
  assert.throws(() => x.engine.accept(x.w.id, live.id), /후보/);
  assert.throws(
    () =>
      x.engine.execute(
        x.w.id,
        {
          step: "model",
          prompt: "model",
          role: "head",
          polygonCount: 10000,
        },
        { accepted: true, studioCreditLimit: 1000, imageCreditLimit: 0 },
      ),
    /separate/,
  );
});

test("draft registration rejects escaped paths, invalid images, duplicate roles and integrity failures", async (t) => {
  for (const fault of ["path", "format", "role", "integrity"] as const) {
    const x = await setup(t);
    x.executor.hook = (ctx, result) => {
      const artifacts = result.candidates[0].artifacts;
      if (fault === "path")
        artifacts.find((a) => a.kind === "image")!.path =
          "../../../../assets/front.png";
      if (fault === "format")
        fs.writeFileSync(
          path.join(
            ctx.workspace,
            artifacts.find((a) => a.kind === "image")!.path,
          ),
          "not an image",
        );
      if (fault === "role")
        artifacts.find((a) => a.role === "hair")!.role = "head";
      if (fault === "integrity")
        result.checks = [
          { name: "file_hash_matches", passed: false, severity: "warning" },
        ];
      ctx.onDraft!(result);
      return result;
    };
    const job = await x.execute({ step: "separate", prompt: "split" });
    assert.equal(job.status, "failed", fault);
    assert.equal(job.draftCandidates, undefined, fault);
    assert.equal(job.candidates.length, 0, fault);
  }
});

test("late draft from a completed invocation cannot overwrite the next recovery state", async (t) => {
  const x = await setup(t, true, [30000, 30000, 30000]);
  let retained!: WorkbenchResult;
  x.executor.hook = (_ctx, result) => {
    retained = result;
    return {
      ...result,
      status: "needs_input",
      candidates: [],
      recovery: { kind: "retry", reason: "Temporary local read" },
    };
  };
  x.executor.recover = async (ctx) => x.executor.fixture(ctx);
  x.engine.execute(x.w.id, { step: "separate", prompt: "split" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(x.engine.get(x.w.id).jobs[0].recovery?.state, "waiting");
  x.executor.calls[0].onDraft!(retained);
  assert.equal(x.engine.get(x.w.id).jobs[0].draftCandidates, undefined);
  x.engine.cancel(x.w.id);
  await x.engine.wait(x.w.id);
});

test("explicit inspect-saved loads partial and complete images without worker execution or stage advancement", async (t) => {
  const x = await setup(t);
  let saved!: WorkbenchResult;
  x.executor.hook = (_, result) => {
    saved = result;
    return {
      ...result,
      status: "needs_input",
      candidates: [],
      summary: "Saved visual review awaiting user",
    };
  };
  const stopped = await x.execute({ step: "separate", prompt: "split" });
  const calls = x.executor.calls.length;
  let inspections = 0;
  x.executor.inspectSaved = async (ctx) => {
    inspections++;
    assert.equal(ctx.job.id, stopped.id);
    assert.deepEqual(ctx.inputs, x.executor.calls[0].inputs);
    return {
      ...saved,
      status: "needs_input",
      candidates: [
        {
          ...saved.candidates[0],
          artifacts: saved.candidates[0].artifacts.filter(
            (a) =>
              a.kind === "report" || (a.role === "head" && a.view === "front"),
          ),
        },
      ],
      checks: [
        { name: "original_alignment_and_scale_preserved", passed: false },
      ],
    };
  };
  x.engine.action(x.project.id, { kind: "inspect-saved", jobId: stopped.id });
  const partial = (await x.engine.wait(x.w.id)).jobs[0];
  assert.equal(partial.status, "needs_input");
  assert.equal(
    partial.draftCandidates?.[0].artifacts.filter((a) => a.kind === "image")
      .length,
    1,
  );
  assert.equal(partial.candidates.length, 0);
  assert.equal(inspections, 1);
  assert.equal(x.executor.calls.length, calls);
  x.executor.inspectSaved = async () => ({
    ...saved,
    checks: [{ name: "clean_peripheral_alpha", passed: false }],
  });
  x.engine.action(x.project.id, { kind: "inspect-saved", jobId: stopped.id });
  const full = (await x.engine.wait(x.w.id)).jobs[0];
  assert.equal(full.status, "review", full.summary);
  assert.equal(full.checks[0].passed, false);
  assert.equal(full.draftCandidates, undefined);
  assert.equal(full.draftChecks, undefined);
  assert.equal(x.executor.calls.length, calls);
  assert.equal(x.engine.get(x.w.id).selections.separate, undefined);
});

test("new separation freezes twelve role/view images and models have one result", async (t) => {
  const x = await setup(t);
  const split = await x.execute(
    { step: "separate", prompt: "four views" },
    true,
  );
  assert.deepEqual(split.request.views, ["front", "back", "left", "right"]);
  assert.equal(
    split.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    12,
  );
  const model = await x.execute({ step: "model", prompt: "one", role: "head" });
  assert.equal(model.status, "review");
  assert.equal(model.candidates.length, 1);
  x.executor.hook = (_, result) => ({
    ...result,
    candidates: Array.from({ length: 4 }, (_, i) => ({
      ...result.candidates[0],
      id: `legacy-${i}`,
    })),
  });
  const tooMany = await x.execute({
    step: "model",
    prompt: "one",
    role: "hair",
  });
  assert.equal(tooMany.status, "failed");
  assert.match(tooMany.summary, /1개 결과/);
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "separate",
        prompt: "bad",
        views: ["front"],
      }),
    /네 방향/,
  );
});

test("legacy three-front review remains readable but cannot start a new four-view model", async (t) => {
  const x = await setup(t);
  const source = x.engine.get(x.w.id).jobs[0].candidates[0].artifacts[0];
  const imported = x.engine.importSeparation(x.w.id, {
    sourceSha256: source.sha256,
    artifacts: (["head", "hair", "body"] as const).map((role) => ({
      role,
      file: x.store.write(x.project.id, `legacy/${role}.png`, image(role)),
    })),
  });
  x.engine.accept(x.w.id, imported.jobs[0].id);
  assert.throws(
    () =>
      x.engine.execute(
        x.w.id,
        { step: "model", prompt: "model", role: "head" },
        { accepted: true, studioCreditLimit: 1000, imageCreditLimit: 0 },
      ),
    /정면·후면·좌측·우측/,
  );
  assert.equal(x.executor.calls.length, 0);
});

test("targeted image reroll preserves accepted input until adoption and keeps other part models current", async (t) => {
  const x = await setup(t);
  const initial = await x.execute({ step: "separate", prompt: "split" }, true);
  for (const role of ["head", "hair", "body"] as const)
    await x.execute({ step: "model", prompt: "model", role }, true);
  const before = x.engine.get(x.w.id).selections;
  x.executor.hook = (ctx, result) => {
    const target = result.candidates[0].artifacts.find(
      (a) => a.role === "head" && a.view === "back",
    )!;
    fs.writeFileSync(
      path.join(ctx.workspace, target.path),
      image("new-head-back"),
    );
    return result;
  };
  const corrected = await x.execute({
    step: "separate",
    prompt: "fix back",
    baseJobId: initial.id,
    role: "head",
    view: "back",
  });
  assert.equal(corrected.status, "review", corrected.summary);
  assert.equal(x.engine.get(x.w.id).selections.separate.jobId, initial.id);
  const priorBack = initial.candidates[0].artifacts.find(
    (a) => a.role === "head" && a.view === "back",
  )!;
  assert.equal(
    fs.readFileSync(x.store.file(x.project.id, priorBack.path)).toString("hex"),
    image("head-back").toString("hex"),
  );
  x.engine.accept(x.w.id, corrected.id);
  const after = x.engine.get(x.w.id).selections;
  assert.equal(after["model:head"], undefined);
  assert.deepEqual(after["model:hair"], before["model:hair"]);
  assert.deepEqual(after["model:body"], before["model:body"]);
  assert.equal(after.separate.jobId, corrected.id);
});

test("host rejects a targeted reroll that changes an untouched direction", async (t) => {
  const x = await setup(t);
  const initial = await x.execute({ step: "separate", prompt: "split" }, true);
  x.executor.hook = (ctx, result) => {
    const unrelated = result.candidates[0].artifacts.find(
      (a) => a.role === "hair" && a.view === "left",
    )!;
    fs.writeFileSync(
      path.join(ctx.workspace, unrelated.path),
      image("unexpected-hair-left"),
    );
    return result;
  };
  const corrected = await x.execute({
    step: "separate",
    prompt: "fix head back",
    baseJobId: initial.id,
    role: "head",
    view: "back",
  });
  assert.equal(corrected.status, "failed");
  assert.match(corrected.summary, /그대로 보존/);
  assert.equal(x.engine.get(x.w.id).selections.separate.jobId, initial.id);
});

test("stopped partial separation is a verified base for filling missing views only", async (t) => {
  const x = await setup(t);
  x.executor.hook = (ctx, result) => {
    const draft = {
      ...result,
      status: "needs_input" as const,
      candidates: [
        {
          ...result.candidates[0],
          artifacts: result.candidates[0].artifacts.filter(
            (a) => a.role === "head" && a.view === "front",
          ),
        },
      ],
    };
    ctx.onDraft!(draft);
    return draft;
  };
  const stopped = await x.execute({ step: "separate", prompt: "split" });
  assert.equal(stopped.status, "needs_input");
  assert.equal(stopped.draftCandidates?.[0].artifacts.length, 1);
  x.executor.hook = undefined;
  const filled = await x.execute({
    step: "separate",
    prompt: "fill missing",
    baseJobId: stopped.id,
    reuseExisting: true,
  });
  assert.equal(filled.status, "review", filled.summary);
  const retained = stopped.draftCandidates![0].artifacts[0];
  assert.equal(
    filled.candidates[0].artifacts.find(
      (a) => a.role === "head" && a.view === "front",
    )!.sha256,
    retained.sha256,
  );
  assert.equal(x.engine.get(x.w.id).selections.separate, undefined);
  fs.appendFileSync(x.store.file(x.project.id, retained.path), "changed");
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "separate",
        prompt: "fill missing",
        baseJobId: stopped.id,
        reuseExisting: true,
      }),
    /변경/,
  );
});

test("single-part surface reroll must retain every other part file", async (t) => {
  const x = await setup(t);
  await x.execute({ step: "separate", prompt: "split" }, true);
  for (const role of ["head", "hair", "body"] as const)
    await x.execute({ step: "model", prompt: "model", role }, true);
  const base = await x.execute({ step: "surface", prompt: "surface" }, true);
  const rejected = await x.execute({
    step: "surface",
    prompt: "head only",
    role: "head",
    baseJobId: base.id,
  });
  assert.equal(rejected.status, "failed");
  assert.match(rejected.summary, /그대로 보존/);
  x.executor.hook = (ctx, result) => {
    for (const artifact of result.candidates[0].artifacts.filter(
      (a) => a.role && a.role !== "head",
    )) {
      const original = base.candidates[0].artifacts.find(
        (a) => a.role === artifact.role && a.kind === artifact.kind,
      )!;
      fs.copyFileSync(
        x.store.file(x.project.id, original.path),
        path.join(ctx.workspace, artifact.path),
      );
    }
    return result;
  };
  const corrected = await x.execute({
    step: "surface",
    prompt: "head only",
    role: "head",
    baseJobId: base.id,
  });
  assert.equal(corrected.status, "review", corrected.summary);
  assert.equal(x.engine.get(x.w.id).selections.surface.jobId, base.id);
  x.engine.accept(x.w.id, corrected.id);
  assert.equal(x.engine.get(x.w.id).selections.surface.jobId, corrected.id);
});

test("existing model regeneration freezes full or named part scope and rejects missing edit targets", async (t) => {
  const x = await setup(t);
  await x.execute({ step: "separate", prompt: "split" }, true);
  const base = await x.execute(
    { step: "model", prompt: "model", role: "head" },
    true,
  );
  const full = await x.execute({
    step: "model",
    prompt: "전체 비율 수정",
    role: "head",
    baseJobId: base.id,
  });
  assert.equal(full.status, "review", full.summary);
  assert.equal(full.request.modelEditScope, "all");
  assert.equal(full.request.baseCandidateId, base.candidates[0].id);
  const partial = await x.execute({
    step: "model",
    prompt: "모양을 둥글게 수정",
    role: "head",
    baseJobId: base.id,
    modelEditScope: "part",
    modelEditTarget: "  캐릭터 왼쪽 귀  ",
  });
  assert.equal(partial.status, "review", partial.summary);
  assert.equal(partial.request.modelEditScope, "part");
  assert.equal(partial.request.modelEditTarget, "캐릭터 왼쪽 귀");
  assert.equal(
    x.executor.calls.at(-1)!.job.request.prompt,
    "모양을 둥글게 수정",
  );
  assert.equal(x.engine.get(x.w.id).selections["model:head"].jobId, base.id);
  const calls = x.executor.calls.length;
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "model",
        prompt: "수정",
        role: "head",
        baseJobId: base.id,
        modelEditScope: "part",
      }),
    /부분 재생성할 영역/,
  );
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "model",
        prompt: "신규",
        role: "head",
        modelEditScope: "all",
      }),
    /기존 모델 기준/,
  );
  assert.equal(x.executor.calls.length, calls);
});

test("existing native model edits remain available for legacy front-only separation", async (t) => {
  const x = await setup(t);
  const split = await x.execute({ step: "separate", prompt: "split" }, true);
  const model = await x.execute(
    { step: "model", prompt: "model", role: "head" },
    true,
  );
  // Emulate persisted legacy history; existing model bytes and selections are unchanged.
  const legacy = x.engine.get(x.w.id);
  const saved = legacy.jobs.find((j) => j.id === split.id)!;
  delete saved.request.views;
  saved.candidates[0].artifacts = saved.candidates[0].artifacts
    .filter((a) => a.kind !== "image" || a.view === "front")
    .map((a) => ({ ...a, view: undefined }));
  x.store.put("workbench", x.w.id, legacy);
  const edited = await x.execute({
    step: "model",
    prompt: "기존 모델 전체 수정",
    role: "head",
    baseJobId: model.id,
  });
  assert.equal(edited.status, "review", edited.summary);
  assert.equal(edited.request.modelEditScope, "all");
  assert.ok(
    x.executor.calls
      .at(-1)!
      .inputs.some(
        (a) =>
          a.kind === "model" &&
          a.sha256 ===
            model.candidates[0].artifacts.find((a) => a.kind === "model")!
              .sha256,
      ),
  );
  assert.throws(
    () =>
      x.engine.execute(
        x.w.id,
        { step: "model", prompt: "신규 모델", role: "hair" },
        { accepted: true, studioCreditLimit: 1000, imageCreditLimit: 0 },
      ),
    /정면·후면·좌측·우측/,
  );
});
