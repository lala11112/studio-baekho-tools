import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { WorkbenchEngine } from "../engine/workbench";
import { workbenchWarningMessages } from "../shared/workbench-checks";
import { buildWorkbenchGlb } from "./fixtures/workbench-glb";
import type {
  WorkbenchExecutionContext,
  WorkbenchExecutor,
  WorkbenchRequest,
  WorkbenchResult,
  WorkbenchView,
  WorkbenchArtifact,
  WorkbenchJob,
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
    for (
      let i = 0;
      i < (ctx.job.request.generationCount ?? (step === "concept" ? 4 : 1));
      i++
    ) {
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
      if (step === "motion-source")
        for (const view of ["left","right"] as const)
          write(`${view}.png`,image(view),"image","motion-source",view);
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
              image(`${role}-${view}${i ? `-${i}` : ""}`),
              "image",
              role,
              ctx.job.request.views ? view : undefined,
            );
      if (step === "surface")
        for (const role of ctx.job.request.modelInput === "whole"
          ? ["whole"]
          : ["head", "hair", "body"])
          write(`${role}.glb`, glb(role), "model", role);
      if (["assembly", "rig", "animation"].includes(step)) {
        write("scene.blend", `BLENDER-v500 mock ${ctx.job.id}`, "blend");
        write("scene.glb", glb(ctx.job.id), "model");
        write("review.png", image(ctx.job.id), "image");
      }
      if (step === "reference") {
        const times = ctx.job.request.referenceTimes ?? Array.from(
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
  prepareSeparationImages?: (
    artifacts: WorkbenchArtifact[],
    workspace: string,
    projectRoot: string,
  ) => WorkbenchArtifact[],
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
    engine = new WorkbenchEngine(store, executor, {
      recoveryDelaysMs,
      prepareSeparationImages,
    }),
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

test("requested image sets and new model counts are frozen and require explicit candidate selection", async (t) => {
  const x = await setup(t);
  for (const generationCount of [1, 2, 4]) {
    for (const step of ["concept", "separate", "model"] as const) {
      const job = await x.execute({
        step,
        prompt: "requested count",
        generationCount,
        ...(step === "model" ? { modelInput: "whole" as const } : {}),
      });
      assert.equal(job.status, "review", job.summary);
      assert.equal(job.request.generationCount, generationCount);
      assert.equal(job.candidates.length, generationCount);
      if (generationCount > 1)
        assert.throws(() => x.engine.accept(x.w.id, job.id), /하나/);
      if (step === "separate")
        for (const candidate of job.candidates)
          assert.equal(
            candidate.artifacts.filter((a) => a.kind === "image").length,
            12,
          );
    }
  }
  const calls = x.executor.calls.length;
  for (const generationCount of [0, -1, 1.5, 17, NaN, Infinity])
    for (const step of ["concept", "separate", "model"] as const)
      assert.throws(
        () =>
          x.engine.execute(x.w.id, {
            step,
            prompt: "bad count",
            generationCount,
          }),
        /생성 개수/,
      );
  assert.equal(x.executor.calls.length, calls);
});

test("motion input render requires an accepted rig, awaits adoption, and expires when that rig changes",async(t)=>{
  const x=await setup(t);
  assert.throws(()=>x.engine.execute(x.w.id,{step:"motion-source",prompt:"render"}),/rig/);
  await x.assemble();await x.execute({step:"rig",prompt:"rig"},true);
  const rendered=await x.execute({step:"motion-source",prompt:"local render",motionSourceAxis:"X"});
  assert.equal(rendered.status,"review");assert.deepEqual(Object.keys(rendered.dependencies),["rig"]);
  assert(!x.engine.get(x.w.id).selections["motion-source"]);
  x.engine.accept(x.w.id,rendered.id);
  assert(x.engine.get(x.w.id).selections["motion-source"]);
  await x.execute({step:"rig",prompt:"replacement rig"},true);
  assert(!x.engine.get(x.w.id).selections["motion-source"]);
  assert(x.engine.get(x.w.id).jobs.some(j=>j.id===rendered.id));
});

test("whole surface can skip assembly without a worker, persist, and freeze direct rig lineage", async (t) => {
  const x = await setup(t);
  await x.execute({step:"model",prompt:"whole"},true);
  const surface = await x.execute({step:"surface",prompt:"texture"},true);
  const before=x.engine.get(x.w.id), calls=x.executor.calls.length;
  x.engine.action(x.project.id,{kind:"rig-source",source:"surface"});
  assert.equal(x.executor.calls.length,calls);
  assert.equal(x.engine.get(x.w.id).jobs.length,before.jobs.length);
  const restored=new WorkbenchEngine(x.store,x.executor,{recoveryDelaysMs:[0,0,0]});
  assert.equal(restored.get(x.w.id).rigSource,"surface");
  restored.shutdown();
  const rig=await x.execute({step:"rig",prompt:"actual rig",rigProfile:"quadruped",rigControls:{ears:true,tail:true}},true);
  assert.equal(rig.request.rigSource,"surface");
  assert.deepEqual(rig.request.rigTargets,[]);
  assert.deepEqual(Object.keys(rig.dependencies),["concept","surface"]);
  assert.equal(rig.dependencies.surface.jobId,surface.id);
  assert(x.executor.calls.at(-1)!.inputs.some(a=>a.sha256===surface.candidates[0].artifacts.find(a=>a.kind==="model")!.sha256));
  assert(!x.engine.get(x.w.id).jobs.some(j=>j.step==="assembly"));
  // Selecting a correction later changes the route and invalidates only downstream choices.
  await x.execute({step:"assembly",prompt:"later correction"},true);
  assert.equal(x.engine.get(x.w.id).rigSource,"assembly");
  assert(!x.engine.get(x.w.id).selections.rig);
  assert(x.engine.get(x.w.id).jobs.some(j=>j.id===rig.id));
});

test("assembly skip rejects missing, unaccepted, parts and tampered sources before any worker", async (t) => {
  const x=await setup(t);
  const skip=()=>x.engine.action(x.project.id,{kind:"rig-source",source:"surface"});
  assert.throws(skip,/채택/);
  await x.execute({step:"model",prompt:"whole"},true);
  const surface=await x.execute({step:"surface",prompt:"texture"});
  assert.throws(skip,/채택/);
  x.engine.accept(x.w.id,surface.id);
  const calls=x.executor.calls.length;
  fs.appendFileSync(x.store.file(x.project.id,surface.candidates[0].artifacts[0].path),"tampered");
  assert.throws(skip);
  assert.equal(x.executor.calls.length,calls);
  const y=await setup(t);
  await y.assemble();
  assert.throws(()=>y.engine.action(y.project.id,{kind:"rig-source",source:"surface"}),/분리한 파츠/);
});

test("new surface selection invalidates direct rig while preserving its files and history",async(t)=>{
  const x=await setup(t);
  await x.execute({step:"model",prompt:"whole"},true);
  await x.execute({step:"surface",prompt:"texture"},true);
  x.engine.action(x.project.id,{kind:"rig-source",source:"surface"});
  const rig=await x.execute({step:"rig",prompt:"rig"},true);
  await x.execute({step:"surface",prompt:"new version"},true);
  assert(!x.engine.get(x.w.id).selections.rig);
  assert(fs.existsSync(x.store.file(x.project.id,rig.candidates[0].artifacts[0].path)));
});

test("whole-image modeling is the new default and proceeds to texture without a separation job", async (t) => {
  const x = await setup(t);
  const source = x.engine.get(x.w.id).selections.concept;
  const model = await x.execute({ step: "model", prompt: "whole" }, true);
  assert.equal(model.slot, "model:whole");
  assert.equal(model.request.modelInput, "whole");
  assert.equal(model.request.role, "whole");
  assert.deepEqual(model.dependencies, { concept: source });
  assert.equal(
    x.executor.calls[0].inputs.filter((a) => a.kind === "image").length,
    1,
  );
  const surface = await x.execute({ step: "surface", prompt: "texture" }, true);
  assert.equal(surface.status, "review");
  assert.equal(surface.request.modelInput, "whole");
  assert.deepEqual(Object.keys(surface.dependencies), [
    "concept",
    "model:whole",
  ]);
  assert.equal(
    surface.candidates[0].artifacts.filter((a) => a.kind === "model").length,
    1,
  );
  assert.equal(
    x.engine.get(x.w.id).jobs.some((j) => j.step === "separate"),
    false,
  );
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "assembly",
        prompt: "wrong route",
        modelInput: "parts",
      }),
    /채택한 텍스처 모델/,
  );
  const assembly = await x.execute(
    { step: "assembly", prompt: "refine whole character" },
    true,
  );
  assert.equal(assembly.request.modelInput, "whole");
  assert.equal(assembly.status, "review");
  const replacement = await x.execute(
    { step: "concept", prompt: "new concept", generationCount: 1 },
    true,
  );
  assert.equal(x.engine.get(x.w.id).selections.concept.jobId, replacement.id);
  assert.equal(x.engine.get(x.w.id).selections["model:whole"], undefined);
  assert.equal(x.engine.get(x.w.id).selections.surface, undefined);
});

test("single separation and selected multiview directions are frozen into each part model", async (t) => {
  const x = await setup(t);
  for (const views of [
    ["front"],
    ["front", "left"],
    ["front", "back", "right"],
  ] as WorkbenchView[][]) {
    const separated = await x.execute(
      {
        step: "separate",
        prompt: "split",
        separationMode: views.length === 1 ? "single" : "multiview",
        views,
      },
      true,
    );
    assert.equal(separated.status, "review");
    assert.deepEqual(separated.request.views, views);
    assert.equal(
      separated.candidates[0].artifacts.filter((a) => a.kind === "image")
        .length,
      views.length * 3,
    );
    const model = await x.execute(
      { step: "model", prompt: "part", role: "body", modelInput: "parts" },
      true,
    );
    assert.equal(model.status, "review");
    assert.deepEqual(model.request.views, views);
  }
  for (const views of [[], ["back"], ["front", "front"], ["front", "unknown"]])
    assert.throws(
      () =>
        x.engine.execute(x.w.id, {
          step: "separate",
          prompt: "invalid",
          views: views as WorkbenchView[],
        }),
      /정면/,
    );
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "separate",
        prompt: "invalid",
        separationMode: "single",
        views: ["front", "back"],
      }),
    /정면/,
  );
});

test("switching accepted model routes clears incompatible active selections while preserving history", async (t) => {
  const x = await setup(t);
  await x.execute(
    { step: "separate", prompt: "single", separationMode: "single" },
    true,
  );
  for (const role of ["head", "hair", "body"] as const)
    await x.execute({ step: "model", prompt: "parts", role }, true);
  const partsSurface = await x.execute(
    { step: "surface", prompt: "parts texture" },
    true,
  );
  const whole = await x.execute(
    { step: "model", prompt: "whole", modelInput: "whole" },
    true,
  );
  assert.equal(x.engine.get(x.w.id).selections.surface, undefined);
  for (const role of ["head", "hair", "body"])
    assert.equal(x.engine.get(x.w.id).selections[`model:${role}`], undefined);
  assert.ok(x.engine.get(x.w.id).jobs.some((j) => j.id === partsSurface.id));
  const wholeSurface = await x.execute(
    { step: "surface", prompt: "whole texture" },
    true,
  );
  await x.execute({ step: "model", prompt: "parts again", role: "head" }, true);
  assert.equal(x.engine.get(x.w.id).selections["model:whole"], undefined);
  assert.equal(x.engine.get(x.w.id).selections.surface, undefined);
  assert.ok(x.engine.get(x.w.id).jobs.some((j) => j.id === whole.id));
  assert.ok(x.engine.get(x.w.id).jobs.some((j) => j.id === wholeSurface.id));
  assert.throws(
    () =>
      x.engine.execute(
        x.w.id,
        { step: "surface", prompt: "incomplete parts", modelInput: "parts" },
        { accepted: true, imageCreditLimit: 0, studioCreditLimit: 100 },
      ),
    /model:hair/,
  );
});

test("every separation candidate is validated and identical sets or duplicate models are rejected", async (t) => {
  const x = await setup(t);
  x.executor.hook = (_, result) => {
    result.candidates[1].artifacts = result.candidates[1].artifacts.filter(
      (a) => a.role !== "body",
    );
    return result;
  };
  const missing = await x.execute({
    step: "separate",
    prompt: "two",
    generationCount: 2,
  });
  assert.equal(missing.status, "failed");
  assert.match(missing.summary, /12장/);
  x.executor.hook = (_, result) => {
    result.candidates[1].artifacts = result.candidates[0].artifacts;
    return result;
  };
  const duplicate = await x.execute({
    step: "separate",
    prompt: "two",
    generationCount: 2,
  });
  assert.equal(duplicate.status, "failed");
  assert.match(duplicate.summary, /서로 다른 이미지 세트/);
  const model = await x.execute({
    step: "model",
    prompt: "two",
    generationCount: 2,
  });
  assert.equal(model.status, "failed");
  assert.match(model.summary, /서로 다른 후보/);
});

test("multiple correction alternatives freeze the selected separation base and preserve unaffected originals in every set", async (t) => {
  const x = await setup(t);
  const base = await x.execute({
    step: "separate",
    prompt: "two bases",
    generationCount: 2,
    views: ["front", "back"],
  });
  x.engine.select(x.w.id, base.id, base.candidates[1].id);
  x.executor.hook = (ctx, result) => {
    for (const candidate of result.candidates)
      for (const artifact of candidate.artifacts.filter(
        (a) => a.kind === "image",
      )) {
        const old = base.candidates[1].artifacts.find(
          (a) => a.role === artifact.role && a.view === artifact.view,
        )!;
        fs.writeFileSync(
          path.join(ctx.workspace, artifact.path),
          artifact.role === "head" && artifact.view === "back"
            ? image(`${candidate.id}-changed`)
            : fs.readFileSync(x.store.file(x.project.id, old.path)),
        );
      }
    return result;
  };
  const correction = await x.execute({
    step: "separate",
    prompt: "change back",
    baseJobId: base.id,
    role: "head",
    view: "back",
    generationCount: 2,
  });
  assert.equal(correction.status, "review", correction.summary);
  assert.equal(correction.request.baseCandidateId, base.candidates[1].id);
  assert.deepEqual(correction.request.views, ["front", "back"]);
  assert.equal(x.engine.get(x.w.id).selections.separate.jobId, base.id);
  const oldHook = x.executor.hook;
  x.executor.hook = async (ctx, result) => {
    const corrected = await oldHook!(ctx, result);
    const untouched = corrected.candidates[1].artifacts.find(
      (a) => a.role === "body" && a.view === "front",
    )!;
    fs.writeFileSync(
      path.join(ctx.workspace, untouched.path),
      image("must not change"),
    );
    return corrected;
  };
  const invalid = await x.execute({
    step: "separate",
    prompt: "change back",
    baseJobId: base.id,
    baseCandidateId: base.candidates[1].id,
    role: "head",
    view: "back",
    generationCount: 2,
  });
  assert.equal(invalid.status, "failed");
  assert.match(invalid.summary, /그대로 보존/);
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "separate",
        prompt: "wrong direction",
        baseJobId: base.id,
        views: ["front"],
      }),
    /기준 버전의 방향/,
  );
});

test("model candidate reroll selects the accepted candidate and never permits multiple mesh edits", async (t) => {
  const x = await setup(t);
  const base = await x.execute(
    { step: "model", prompt: "two", generationCount: 2 },
    true,
  );
  x.engine.select(x.w.id, base.id, base.candidates[1].id);
  const edited = await x.execute({
    step: "model",
    prompt: "edit selected",
    baseJobId: base.id,
  });
  assert.equal(edited.status, "review");
  assert.equal(edited.request.baseCandidateId, base.candidates[1].id);
  assert.equal(edited.request.generationCount, 1);
  assert.equal(edited.request.modelEditScope, "all");
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "model",
        prompt: "unsafe edits",
        baseJobId: base.id,
        generationCount: 2,
      }),
    /수정 결과 1개/,
  );
});

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
  assert.equal(job.request.imageBackend, "chatgpt-web");
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
      rigProfile: "quadruped",
      rigControls: { ears: true, tail: true },
    },
    true,
  );
  const targets = rig.request.rigTargets!;
  assert.equal(x.executor.calls.at(-1)!.job.request.rigProfile,"quadruped");
  assert.deepEqual(x.engine.get(x.w.id).jobs.find(j=>j.id===rig.id)!.request.rigControls,{ears:true,tail:true});
  assert.throws(()=>x.engine.execute(x.w.id,{step:"rig",prompt:"bad",rigControls:{ears:"true" as any,tail:true}}),/귀·꼬리/);
  assert.throws(()=>x.engine.execute(x.w.id,{step:"rig",prompt:"bad",rigProfile:"human" as any}),/체형/);
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

test("incorrect reference views remain non-selectable drafts with real files and no automatic retry", async (t) => {
  const x=await setup(t);await x.assemble();await x.execute({step:"rig",prompt:"rig"},true);
  x.executor.hook=(ctx,result)=>{
    result.checks=[{name:"wrong_side_view",passed:false,severity:"error",visualCategory:"view_consistency",detail:"A front image was generated for the side."}];
    ctx.onDraft?.(result);result.status="needs_input";result.recovery={kind:"blocked",reason:"Review incorrect direction"};return result;
  };
  const job=await x.execute({step:"reference",prompt:"idle",motion:"Idle",referenceTimes:[0,1,2]});
  assert.equal(job.status,"needs_input");assert.equal(job.candidates.length,0);
  assert.equal(job.draftCandidates?.[0].artifacts.filter(a=>a.kind==="image").length,9);
  assert.equal(job.draftChecks?.[0].passed,false);
  assert.throws(()=>x.engine.accept(x.w.id,job.id));
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
    referenceTimes: [0,0.4,1.4,2],
    duration: 2,
  });
  assert.equal(four.status, "review", four.summary);
  assert.deepEqual(four.request.referenceTimes,[0,0.4,1.4,2]);
  assert.throws(()=>x.engine.execute(x.w.id,{step:"reference",prompt:"wave",motion:"wave",referenceFrameCount:3,referenceTimes:[0,2,1]}),/참조 시점/);
  x.executor.hook=(ctx,result)=>{
    const manifest=result.candidates[0].artifacts.find(a=>a.kind==="frames")!;
    const file=path.join(ctx.workspace,manifest.path),doc=JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
    doc.frames[1].time=0.5;fs.writeFileSync(file,JSON.stringify(doc));return result;
  };
  const shifted=await x.execute({step:"reference",prompt:"wave",motion:"wave",referenceFrameCount:4,referenceTimes:[0,0.4,1.4,2],duration:2});
  assert.equal(shifted.status,"failed");assert.match(shifted.summary,/저장된 요청/);
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
      {
        name: "back_view_geometry_convincing",
        passed: false,
        severity: "warning",
      },
      { name: "head:left_view_silhouette_consistent", passed: false },
      {
        name: "separate-body-right:right_view_proportions_matches_reference",
        passed: false,
      },
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
    ["separate", "back_view_geometry_valid"],
    ["separate", "back_view_file_integrity_convincing"],
    ["separate", "unknown_visual_evaluation"],
    ["concept", "clean_peripheral_alpha"],
    ["concept", "back_view_geometry_convincing"],
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

test("stable visual observation categories retain truthful failures and details without recovery", async (t) => {
  const x = await setup(t);
  let recoveries = 0;
  x.executor.hook = (_, result) => ({
    ...result,
    checks: [
      {
        name: "visual_quality",
        visualCategory: "view_consistency",
        detail: "후면 머리 형태가 원본보다 둥글어 보입니다.",
        passed: false,
      },
      {
        name: "hair:visual_quality",
        visualCategory: "alpha_edges",
        detail: "머리카락 끝의 투명 가장자리를 확인하세요.",
        passed: false,
      },
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
    job.checks.every(
      (check) => check.passed === false && check.severity === "warning",
    ),
  );
  assert.equal(job.checks[0].visualCategory, "view_consistency");
  assert.equal(
    job.checks[0].detail,
    "후면 머리 형태가 원본보다 둥글어 보입니다.",
  );
  assert.ok(
    workbenchWarningMessages("separate", job.checks).some((text) =>
      text.includes(job.checks[0].detail!),
    ),
  );
  assert.equal(x.engine.get(x.w.id).selections.separate, undefined);
});

test("visual categories cannot rename integrity failures or bypass image structure gates", async (t) => {
  for (const fault of [
    "integrity-name",
    "unknown-category",
    "too-long-detail",
    "duplicate-image",
    "missing-direction",
  ] as const) {
    const x = await setup(t);
    x.executor.hook = (_, result) => {
      result.checks = [
        {
          name: "visual_quality",
          visualCategory: "appearance",
          detail: "외형 검토가 필요합니다.",
          passed: false,
        },
      ];
      if (fault === "integrity-name")
        result.checks[0].name = "source_hash_matches";
      if (fault === "unknown-category")
        result.checks[0].visualCategory = "file_integrity" as any;
      if (fault === "too-long-detail")
        result.checks[0].detail = "x".repeat(601);
      if (fault === "duplicate-image") {
        const images = result.candidates[0].artifacts.filter(
          (a) => a.kind === "image",
        );
        images[1].path = images[0].path;
      }
      if (fault === "missing-direction")
        result.candidates[0].artifacts = result.candidates[0].artifacts.filter(
          (a) => a.view !== "back",
        );
      return result;
    };
    const job = await x.execute({ step: "separate", prompt: "split" });
    assert.equal(job.status, "failed", fault);
    assert.equal(job.candidates.length, 0, fault);
    assert.equal(x.engine.get(x.w.id).selections.separate, undefined, fault);
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
  assert.equal(split.request.provider, "gpt");
  assert.equal(split.request.imageBackend, "chatgpt-web");
  assert.equal(split.request.separationStrategy, "part-multiview-v1");
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
        views: ["back"],
      }),
    /정면/,
  );
});

test("new GPT separation defaults to independent multiview requests and rejects legacy sheet execution", async (t) => {
  const x = await setup(t);
  for (const request of [
    {
      step: "separate",
      prompt: "invalid strategy",
      separationStrategy: "unknown-v2",
    },
    {
      step: "separate",
      prompt: "wrong provider",
      provider: "tripo",
      separationStrategy: "part-multiview-v1",
    },
    {
      step: "concept",
      prompt: "wrong stage",
      separationStrategy: "part-multiview-v1",
    },
  ])
    assert.throws(
      () => x.engine.execute(x.w.id, request as WorkbenchRequest),
      /묶음 생성 방식/,
    );
  assert.throws(
    () =>
      x.engine.execute(x.w.id, {
        step: "separate",
        prompt: "old sheet request",
        separationStrategy: "part-sheet-v1",
      }),
    /시트 생성 방식.*실행할 수 없습니다.*독립 멀티뷰/,
  );
  assert.equal(x.executor.calls.length, 0);
  assert.equal(x.engine.get(x.w.id).jobs.length, 1);
  const request: WorkbenchRequest = {
    step: "separate",
    prompt: "new GPT batch",
    separationStrategy: "part-multiview-v1",
  };
  const originalRequest = structuredClone(request);
  const grouped = await x.execute(request);
  assert.deepEqual(request, originalRequest, "Input is not mutated");
  assert.equal(grouped.request.separationStrategy, "part-multiview-v1");
  assert.equal(
    x.executor.calls[0].job.request.separationStrategy,
    "part-multiview-v1",
  );
  assert.equal(grouped.status, "review");
  assert.equal(x.engine.get(x.w.id).selections.separate, undefined);
  const defaulted = await x.execute({
    step: "separate",
    prompt: "default views",
  });
  assert.equal(defaulted.request.provider, "gpt");
  assert.equal(defaulted.request.separationStrategy, "part-multiview-v1");
  assert.equal(
    x.executor.calls.at(-1)!.job.request.separationStrategy,
    "part-multiview-v1",
  );
  const tripo = await x.execute({
    step: "separate",
    provider: "tripo",
    prompt: "legacy provider",
  });
  assert.equal(tripo.request.separationStrategy, undefined);
  const stored = x.engine.get(x.w.id);
  stored.jobs.find((job) => job.id === grouped.id)!.status = "failed";
  x.store.put("workbench", stored.id, stored);
  x.engine.retry(x.w.id, grouped.id);
  const resumed = await x.engine.wait(x.w.id);
  assert.equal(
    resumed.jobs.find((job) => job.id === grouped.id)!.request
      .separationStrategy,
    "part-multiview-v1",
  );
  assert.equal(
    x.executor.calls.at(-1)!.job.request.separationStrategy,
    "part-multiview-v1",
    "Retry preserves the frozen independent multiview strategy",
  );
});

test("GPT image backend is explicit, defaults only for new image stages, and remains frozen on retry", async (t) => {
  const x = await setup(t);
  for (const request of [
    {
      step: "concept",
      prompt: "hero",
      provider: "tripo",
      imageBackend: "chatgpt-web",
    },
    {
      step: "separate",
      prompt: "split",
      provider: "tripo",
      imageBackend: "codex",
    },
    { step: "concept", prompt: "hero", imageBackend: "unknown" },
    { step: "reference", prompt: "move", imageBackend: "chatgpt-web" },
    { step: "assembly", prompt: "assemble", imageBackend: "codex" },
  ])
    assert.throws(
      () => x.engine.execute(x.w.id, request as WorkbenchRequest),
      /GPT 이미지 연결/,
    );
  assert.equal(x.executor.calls.length, 0);
  const codex = await x.execute({
    step: "concept",
    prompt: "keep configured Codex",
    imageBackend: "codex",
  });
  assert.equal(codex.request.imageBackend, "codex");
  const tripo = await x.execute({
    step: "concept",
    prompt: "Studio",
    provider: "tripo",
  });
  assert.equal(tripo.request.imageBackend, undefined);
  x.executor.hook = (_, result) => ({
    ...result,
    status: "needs_input",
    candidates: [],
  });
  const web = await x.execute({ step: "separate", prompt: "web split" });
  assert.equal(web.request.imageBackend, "chatgpt-web");
  x.executor.hook = undefined;
  x.engine.retry(x.w.id, web.id);
  await x.engine.wait(x.w.id);
  assert.equal(
    x.executor.calls.at(-1)!.job.request.imageBackend,
    "chatgpt-web",
  );
});

test("retry and restart preserve a legacy separation plan without automatic strategy migration", async (t) => {
  const x = await setup(t);
  x.executor.hook = (_, result) => ({
    ...result,
    status: "needs_input",
    candidates: [],
  });
  const stopped = await x.execute({ step: "separate", prompt: "legacy split" });
  const stored = x.engine.get(x.w.id);
  const legacy = stored.jobs.find((job) => job.id === stopped.id)!;
  delete legacy.request.separationStrategy;
  delete legacy.request.provider;
  delete legacy.request.imageBackend;
  legacy.status = "running";
  stored.activeJobId = legacy.id;
  const frozen = structuredClone(legacy.request);
  x.store.put("workbench", stored.id, stored);
  const restarted = new WorkbenchEngine(x.store, x.executor, {
    recoveryDelaysMs: [0, 0, 0],
  });
  t.after(() => restarted.shutdown());
  const restored = restarted.get(x.w.id);
  assert.equal(restored.activeJobId, undefined);
  assert.equal(restored.jobs[0].status, "failed");
  assert.deepEqual(restored.jobs[0].request, frozen);
  assert.equal(x.executor.calls.length, 1, "Restart must not start a worker");
  x.executor.hook = undefined;
  restarted.retry(x.w.id, legacy.id);
  const resumed = (await restarted.wait(x.w.id)).jobs[0];
  assert.equal(resumed.status, "review", resumed.summary);
  assert.equal(x.executor.calls.length, 2);
  assert.deepEqual(x.executor.calls[1].job.request, frozen);
  assert.deepEqual(resumed.request, frozen);
  assert.equal(restarted.get(x.w.id).selections.separate, undefined);
});

test("legacy three-front review can explicitly start a front-only part model without fabricating views", async (t) => {
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
  const model = await x.execute({
    step: "model",
    prompt: "model",
    role: "head",
    modelInput: "parts",
  });
  assert.equal(model.status, "review");
  assert.deepEqual(model.request.views, ["front"]);
  assert.equal(x.executor.calls.length, 1);
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
  const legacyState = x.engine.get(x.w.id);
  delete legacyState.jobs.find((job) => job.id === stopped.id)!.request
    .separationStrategy;
  x.store.put("workbench", legacyState.id, legacyState);
  x.executor.hook = undefined;
  const filled = await x.execute({
    step: "separate",
    prompt: "fill missing",
    separationStrategy: "part-multiview-v1",
    baseJobId: stopped.id,
    reuseExisting: true,
  });
  assert.equal(filled.status, "review", filled.summary);
  assert.equal(filled.request.separationStrategy, "part-multiview-v1");
  assert.equal(
    x.engine.get(x.w.id).jobs.find((job) => job.id === stopped.id)!.request
      .separationStrategy,
    undefined,
    "Filling missing views creates a grouped version without migrating the legacy base",
  );
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
  const fresh = await x.execute({
    step: "model",
    prompt: "신규 모델",
    role: "hair",
    modelInput: "parts",
  });
  assert.equal(fresh.status, "review");
  assert.deepEqual(fresh.request.views, ["front"]);
});

// Synthetic derivative fixture verifies host trust/provenance only, not canvas quality.
function normalizedFixture(
  artifacts: WorkbenchArtifact[],
  workspace: string,
  projectRoot: string,
): WorkbenchArtifact[] {
  return artifacts.map((a) => {
    if (a.kind !== "image") return a;
    const bytes = image(`normalized:${a.sha256}`);
    const file = path.join(
      workspace,
      `normalized-${a.role}-${a.view ?? "front"}.png`,
    );
    fs.writeFileSync(file, bytes);
    const { normalizationIssue: _issue, ...raw } = a;
    return {
      ...raw,
      normalized: {
        path: path.relative(projectRoot, file).split(path.sep).join("/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        width: 1,
        height: 1,
        sourceSha256: a.sha256,
        anchorSha256:
          artifacts.find(
            (other) =>
              other.role === a.role && (other.view ?? "front") === "front",
          )?.sha256 ?? a.sha256,
      },
    };
  });
}

test("worker-supplied image normalization metadata is stripped before trusted preparation", async (t) => {
  let serviceSawSpoof = false;
  const x = await setup(t, true, [0, 0, 0], (artifacts, workspace, root) => {
    serviceSawSpoof ||= artifacts.some(
      (a) => !!a.normalized || !!a.normalizationIssue,
    );
    return normalizedFixture(artifacts, workspace, root);
  });
  x.executor.hook = (_, result) => {
    for (const a of result.candidates[0].artifacts) {
      a.normalized = {
        path: "../../credentials",
        sha256: "forged",
        bytes: 1,
        width: 1024,
        height: 1024,
        sourceSha256: "forged",
        anchorSha256: "forged",
      };
      a.normalizationIssue = "worker cannot control host preparation";
    }
    return result;
  };
  const job = await x.execute({ step: "separate", prompt: "split" });
  assert.equal(job.status, "review", job.summary);
  assert.equal(serviceSawSpoof, false);
  const images = job.candidates[0].artifacts.filter((a) => a.kind === "image");
  assert.equal(images.length, 12);
  assert.ok(
    images.every(
      (a) => a.normalized?.sourceSha256 === a.sha256 && !a.normalizationIssue,
    ),
  );
  assert.ok(
    job.candidates[0].artifacts
      .filter((a) => a.kind !== "image")
      .every((a) => !a.normalized && !a.normalizationIssue),
  );
});

test("fresh model prepares legacy registered images while raw dependency hashes remain unchanged", async (t) => {
  let ready = false;
  const x = await setup(t, true, [0, 0, 0], (artifacts, workspace, root) =>
    ready ? normalizedFixture(artifacts, workspace, root) : artifacts,
  );
  const split = await x.execute({ step: "separate", prompt: "split" }, true);
  const raw = split.candidates[0].artifacts
    .filter((a) => a.kind === "image")
    .map((a) => ({ path: a.path, sha256: a.sha256 }));
  assert.ok(split.candidates[0].artifacts.every((a) => !a.normalized));
  ready = true;
  const model = await x.execute({
    step: "model",
    role: "head",
    prompt: "model",
  });
  assert.equal(model.status, "review", model.summary);
  const saved = x.engine.get(x.w.id).jobs.find((j) => j.id === split.id)!;
  assert.ok(
    saved.candidates[0].artifacts
      .filter((a) => a.kind === "image")
      .every((a) => !!a.normalized),
  );
  for (const original of raw) {
    const input = x.executor.calls
      .at(-1)!
      .inputs.find((a) => a.path === original.path)!;
    assert.equal(input.sha256, original.sha256);
    assert.equal(input.normalized?.sourceSha256, original.sha256);
  }
  assert.equal(model.dependencies.separate.jobId, split.id);
});

test("normalization issues allow photo review, block new model submission, and repair locally without a worker", async (t) => {
  let ready = false;
  const x = await setup(t, true, [0, 0, 0], (artifacts, workspace, root) =>
    ready
      ? normalizedFixture(artifacts, workspace, root)
      : artifacts.map((a) =>
          a.kind === "image"
            ? { ...a, normalizationIssue: "Opaque background needs review" }
            : a,
        ),
  );
  const split = await x.execute({ step: "separate", prompt: "split" }, true);
  assert.equal(split.status, "review");
  const calls = x.executor.calls.length;
  assert.throws(
    () =>
      x.engine.execute(
        x.w.id,
        { step: "model", prompt: "model", role: "head" },
        { accepted: true, studioCreditLimit: 1000, imageCreditLimit: 0 },
      ),
    /크기·배경/,
  );
  assert.equal(x.executor.calls.length, calls);
  ready = true;
  const prepared = x.engine.action(x.project.id, {
    kind: "normalize-images",
    jobId: split.id,
  });
  const job = prepared.jobs.find((j) => j.id === split.id)!;
  const img = job.candidates[0].artifacts.find((a) => a.kind === "image")!;
  assert.equal(job.status, "review");
  assert.equal(prepared.selections.separate.jobId, split.id);
  assert.equal(x.executor.calls.length, calls);
  fs.appendFileSync(
    x.store.file(x.project.id, img.normalized!.path),
    "tampered derivative",
  );
  assert.throws(() => x.engine.accept(x.w.id, split.id), /정리된 사진 파일/);
  x.engine.action(x.project.id, { kind: "normalize-images", jobId: split.id });
  x.engine.accept(x.w.id, split.id);
  assert.equal(x.executor.calls.length, calls);
  fs.appendFileSync(
    x.store.file(x.project.id, img.path),
    "tampered raw source",
  );
  assert.throws(
    () =>
      x.engine.action(x.project.id, {
        kind: "normalize-images",
        jobId: split.id,
      }),
    /기준 산출물이 변경/,
  );
});

test("local normalization failures and invalid derived provenance never cause image regeneration", async (t) => {
  for (const failure of ["throws", "source", "path", "metadata"] as const) {
    const x = await setup(t, true, [0, 0, 0], (artifacts, workspace, root) => {
      if (failure === "throws") throw new Error("Local canvas decoder failed");
      const normalized = normalizedFixture(artifacts, workspace, root);
      for (const a of normalized.filter((a) => a.kind === "image")) {
        if (failure === "source") a.normalized!.sourceSha256 = "0".repeat(64);
        if (failure === "path") a.normalized!.path = "../../outside.png";
        if (failure === "metadata") a.sha256 = "0".repeat(64);
      }
      return normalized;
    });
    let recoveries = 0;
    x.executor.recover = async (ctx) => {
      recoveries++;
      return x.executor.fixture(ctx);
    };
    const job = await x.execute({ step: "separate", prompt: "split" });
    assert.equal(job.status, "review", failure + ": " + job.summary);
    assert.equal(recoveries, 0);
    assert.ok(
      job.candidates[0].artifacts
        .filter((a) => a.kind === "image")
        .every((a) => !a.normalized && !!a.normalizationIssue),
      failure,
    );
  }
});

test("normalized derivatives are copied and verified with project backups", async (t) => {
  const x = await setup(t, true, [0, 0, 0], normalizedFixture);
  const job = await x.execute({ step: "separate", prompt: "split" }, true);
  const img = job.candidates[0].artifacts.find((a) => a.kind === "image")!;
  const backup = path.join(x.root, "normalized-backup");
  fs.cpSync(x.store.directory(x.project.id), backup, { recursive: true });
  const other = new Store(path.join(x.root, "normalized-restored"));
  await other.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  t.after(() => other.db.close());
  other.save(x.store.project(x.project.id));
  const restored = new WorkbenchEngine(other, new MockExecutor());
  restored.restoreFromBackup(x.project.id, backup);
  assert.ok(fs.existsSync(other.file(x.project.id, img.normalized!.path)));
  restored.accept(x.w.id, job.id);
  fs.appendFileSync(path.join(backup, img.normalized!.path), "broken");
  assert.throws(
    () => restored.restoreFromBackup(x.project.id, backup),
    /정리된 사진 파일/,
  );
});

function attachSheetExport(
  ctx: WorkbenchExecutionContext,
  result: WorkbenchResult,
) {
  const artifacts = result.candidates[0].artifacts;
  const front = artifacts.find(
    (a) => a.kind === "image" && a.role === "head" && a.view === "front",
  )!;
  const folder = "outputs/separate-head-front";
  fs.mkdirSync(path.join(ctx.workspace, folder), { recursive: true });
  fs.copyFileSync(
    path.join(ctx.workspace, front.path),
    path.join(ctx.workspace, folder, "part.png"),
  );
  front.path = `${folder}/part.png`;
  const source = {
    path: `${folder}/source-sheet.png`,
    kind: "export" as const,
    role: "head",
  };
  fs.writeFileSync(
    path.join(ctx.workspace, source.path),
    image("original source-sheet bytes"),
  );
  artifacts.push(source);
  return source;
}

function savedSheetFixture(x: Awaited<ReturnType<typeof setup>>) {
  const w = x.engine.get(x.w.id);
  const job: WorkbenchJob = {
    ...structuredClone(w.jobs[0]),
    id: "legacy-sheet",
    step: "separate",
    slot: "separate",
    request: {
      step: "separate",
      prompt: "saved legacy sheet fixture",
      provider: "gpt",
      separationStrategy: "part-sheet-v1",
      views: ["front", "back", "left", "right"],
    },
    dependencies: { concept: w.selections.concept },
    status: "cancelled",
    candidates: [],
    checks: [],
  };
  w.jobs.unshift(job);
  x.store.put("workbench", w.id, w);
  const workspace = x.store.file(
    x.project.id,
    `workbench/${w.id}/jobs/${job.id}`,
  );
  fs.mkdirSync(workspace, { recursive: true });
  const ctx: WorkbenchExecutionContext = {
    workbench: w,
    job,
    workspace,
    inputs: w.jobs[1].candidates[0].artifacts,
    signal: new AbortController().signal,
  };
  const result = x.executor.fixture(ctx);
  attachSheetExport(ctx, result);
  x.executor.inspectSaved = async () => structuredClone(result);
  return { ctx, result, job };
}

test("saved sheet requests cannot retry but local inspection, normalization, reroll and backup preserve history", async (t) => {
  const x = await setup(t, true, [0, 0, 0], normalizedFixture);
  const { job } = savedSheetFixture(x);
  const frozen = structuredClone(x.engine.get(x.w.id));
  assert.throws(
    () => x.engine.retry(x.w.id, job.id),
    /시트 작업.*실행할 수 없습니다.*저장된 사진 확인/,
  );
  assert.deepEqual(
    x.engine.get(x.w.id),
    frozen,
    "Blocked retry must not mutate saved history",
  );
  assert.equal(x.executor.calls.length, 0);
  x.engine.inspectSaved(x.w.id, job.id);
  const completed = (await x.engine.wait(x.w.id)).jobs[0];
  assert.equal(completed.status, "review", completed.summary);
  assert.deepEqual(completed.request, job.request);
  assert.equal(
    completed.candidates[0].artifacts.filter((a) => a.kind === "image").length,
    12,
  );
  assert.equal(
    x.executor.calls.length,
    0,
    "Saved inspection never starts generation",
  );
  const raw = completed.candidates[0].artifacts.find(
    (a) => a.kind === "export",
  )!;
  x.engine.normalizeImages(x.w.id, job.id);
  assert.equal(
    x.executor.calls.length,
    0,
    "Local normalization never starts generation",
  );
  assert.deepEqual(x.engine.get(x.w.id).jobs[0].request, job.request);
  x.engine.accept(x.w.id, completed.id);
  const backup = path.join(x.root, "sheet-backup");
  fs.cpSync(x.store.directory(x.project.id), backup, { recursive: true });
  const other = new Store(path.join(x.root, "sheet-restored"));
  await other.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  t.after(() => other.db.close());
  other.save(x.store.project(x.project.id));
  const executor = new MockExecutor();
  const restored = new WorkbenchEngine(other, executor);
  restored.restoreFromBackup(x.project.id, backup);
  assert.deepEqual(
    fs.readFileSync(other.file(x.project.id, raw.path)),
    image("original source-sheet bytes"),
  );
  assert.equal(executor.calls.length, 0);
  const corrected = await x.execute({
    step: "separate",
    prompt: "hair back only",
    role: "hair",
    view: "back",
    baseJobId: completed.id,
  });
  assert.equal(corrected.status, "review", corrected.summary);
  assert.equal(corrected.request.separationStrategy, "part-multiview-v1");
  assert.equal(
    x.engine
      .get(x.w.id)
      .jobs.find((j) => j.id === completed.id)!
      .candidates[0].artifacts.find((a) => a.kind === "export")!.sha256,
    raw.sha256,
  );
  fs.cpSync(x.store.directory(x.project.id), backup, { recursive: true });
  restored.restoreFromBackup(x.project.id, backup);
  assert.deepEqual(
    fs.readFileSync(other.file(x.project.id, raw.path)),
    image("original source-sheet bytes"),
  );
  fs.appendFileSync(path.join(backup, raw.path), "tampered sheet");
  assert.throws(() => restored.restoreFromBackup(x.project.id, backup), /손상/);
});

test("saved sheet inspection still blocks invalid source paths, roles, formats and duplicates", async (t) => {
  for (const fault of [
    "new-strategy",
    "path",
    "role",
    "view",
    "format",
    "duplicate",
    "unpaired",
  ] as const) {
    const x = await setup(t);
    const { ctx, result, job: saved } = savedSheetFixture(x);
    const source = result.candidates[0].artifacts.find(
      (a) => a.kind === "export",
    )!;
    if (fault === "new-strategy") {
      const w = x.engine.get(x.w.id);
      w.jobs[0].request.separationStrategy = "part-multiview-v1";
      x.store.put("workbench", w.id, w);
    }
    if (fault === "path") {
      const dest = "unrelated.png";
      fs.copyFileSync(
        path.join(ctx.workspace, source.path),
        path.join(ctx.workspace, dest),
      );
      source.path = dest;
    }
    if (fault === "role") source.role = "hair";
    if (fault === "view") (source as { view?: WorkbenchView }).view = "front";
    if (fault === "format")
      fs.writeFileSync(path.join(ctx.workspace, source.path), "not a PNG");
    if (fault === "duplicate") {
      const back = result.candidates[0].artifacts.find(
        (a) => a.kind === "image" && a.role === "head" && a.view === "back",
      )!;
      const folder = "outputs/separate-head-back";
      fs.mkdirSync(path.join(ctx.workspace, folder), { recursive: true });
      fs.copyFileSync(
        path.join(ctx.workspace, back.path),
        path.join(ctx.workspace, folder, "part.png"),
      );
      back.path = `${folder}/part.png`;
      const duplicate = { ...source, path: `${folder}/source-sheet.png` };
      fs.copyFileSync(
        path.join(ctx.workspace, source.path),
        path.join(ctx.workspace, duplicate.path),
      );
      result.candidates[0].artifacts.push(duplicate);
    }
    if (fault === "unpaired") {
      const front = result.candidates[0].artifacts.find(
        (a) => a.kind === "image" && a.role === "head" && a.view === "front",
      )!;
      fs.copyFileSync(
        path.join(ctx.workspace, front.path),
        path.join(ctx.workspace, "front.png"),
      );
      front.path = "front.png";
    }
    x.engine.inspectSaved(x.w.id, saved.id);
    const job = (await x.engine.wait(x.w.id)).jobs[0];
    assert.equal(job.status, "cancelled", fault);
    assert.equal(job.draftCandidates, undefined, fault);
    assert.equal(job.candidates.length, 0, fault);
    assert.match(job.summary, /멀티뷰 시트 원본/, fault);
    assert.equal(x.executor.calls.length, 0, fault);
  }
});
