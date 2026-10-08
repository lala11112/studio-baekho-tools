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
  submitted = new Set<string>();
  hasSubmission(job: { id: string }) {
    return this.submitted.has(job.id);
  }
  hook?: (
    ctx: WorkbenchExecutionContext,
    result: WorkbenchResult,
  ) => WorkbenchResult | Promise<WorkbenchResult>;
  async execute(ctx: WorkbenchExecutionContext) {
    this.calls.push(ctx);
    const result = this.fixture(ctx);
    return this.hook ? this.hook(ctx, result) : result;
  }
  fixture(ctx: WorkbenchExecutionContext): WorkbenchResult {
    const step = ctx.job.step;
    const candidates: WorkbenchResult["candidates"] = [];
    for (let i = 0; i < (["concept", "model"].includes(step) ? 4 : 1); i++) {
      const artifacts: WorkbenchResult["candidates"][number]["artifacts"] = [];
      const write = (
        name: string,
        bytes: string | Buffer,
        kind: (typeof artifacts)[number]["kind"],
        role?: string,
      ) => {
        const relative = `${i}/${name}`;
        fs.mkdirSync(path.dirname(path.join(ctx.workspace, relative)), {
          recursive: true,
        });
        fs.writeFileSync(path.join(ctx.workspace, relative), bytes);
        artifacts.push({ path: relative, kind, role });
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
          write(`${role}.png`, image(role), "image", role);
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
async function setup(t: TestContext, source = true) {
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
    engine = new WorkbenchEngine(store, executor),
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
