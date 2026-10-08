import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { ProductionEngine } from "../engine/production";
import {
  codexArguments,
  type ProductionWorker,
  type WorkerTask,
  type StageReceipt,
} from "../engine/codex-worker";
import type {
  ProductionConfig,
  ProductionRun,
  StageResult,
} from "../shared/production";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
// Explicit synthetic test fixtures; these are never shipping production outputs.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
function glb(rig = true, animation = true) {
  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0, ...(rig ? { skin: 0 } : {}) }],
    ...(rig ? { skins: [{ joints: [0] }] } : {}),
    ...(animation
      ? {
          animations: [
            {
              samplers: [{ input: 0, output: 0 }],
              channels: [
                { sampler: 0, target: { node: 0, path: "translation" } },
              ],
            },
          ],
        }
      : {}),
  };
  const raw = JSON.stringify(json),
    body = Buffer.from(raw.padEnd(Math.ceil(raw.length / 4) * 4, " "));
  const bytes = Buffer.alloc(20 + body.length + 8 + 36);
  bytes.write("glTF");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(body.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  body.copy(bytes, 20);
  bytes.writeUInt32LE(36, 20 + body.length);
  bytes.writeUInt32LE(0x004e4942, 24 + body.length);
  return bytes;
}
class MockWorker implements ProductionWorker {
  calls: WorkerTask[] = [];
  receipts = new Map<string, StageReceipt>();
  hook?: (
    task: WorkerTask,
    result: StageResult,
  ) => Promise<StageResult> | StageResult;
  studio = true;
  authenticated = true;
  async probe() {
    return {
      codex: {
        available: true,
        authenticated: this.authenticated,
        message: "mock authentication missing",
      },
      capabilities: { studio: this.studio, video: false, motion: false },
      message: "Explicit mock only",
    };
  }
  stageReceipt(runId: string, stageId: string, attempt: number) {
    return (
      this.receipts.get(`${runId}/${stageId}/${attempt}`) ?? {
        charges: [],
        downloads: [],
      }
    );
  }
  async run(task: WorkerTask) {
    this.calls.push(task);
    const result = this.fixture(task);
    return {
      result: this.hook ? await this.hook(task, result) : result,
      threadId: `mock-${task.stage.id}`,
    };
  }
  fixture(task: WorkerTask): StageResult {
    const { run, stage } = task,
      prefix = `stages/${stage.id}/attempt-${stage.attempt}`;
    const artifacts: StageResult["artifacts"] = [];
    const write = (
      name: string,
      bytes: Buffer | string,
      kind: "model" | "image" | "report",
      role?: string,
    ) => {
      const relative = `${prefix}/${name}`,
        absolute = path.join(run.workspace, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, bytes);
      artifacts.push({ path: relative, kind, role });
      return relative;
    };
    write("model.glb", glb(), "model");
    write("review.png", png, "image");
    write("report.json", JSON.stringify({ mock: true }), "report");
    if (stage.kind === "separate")
      for (const role of ["body", "head", "hair"])
        write(`${role}.png`, png, "image", role);
    if (stage.kind === "animation-reference") {
      const frames = [0, 1, 2].map((i) => {
        const bytes = Buffer.concat([
          png,
          Buffer.from(`explicit-mock-frame-${i}`),
        ]);
        return {
          path: write(`frame-${i}.png`, bytes, "image"),
          sha256: sha(bytes),
          time: i / 2,
        };
      });
      write(
        "sequence-manifest.json",
        JSON.stringify({ view: stage.role, camera: "fixed", frames }),
        "report",
      );
    }
    if (stage.kind === "motion-transfer") {
      const sequences = stage.dependsOn
        .map((id) => run.stages.find((s) => s.id === id)!)
        .filter((s) => s.kind === "animation-reference");
      const views = sequences.map((s) => {
        const manifest = s.artifacts.find(
          (a) => path.basename(a.path) === "sequence-manifest.json",
        )!;
        return {
          view: s.role,
          sequenceManifestPath: manifest.path,
          sha256: manifest.sha256,
        };
      });
      const sets = Object.fromEntries(
        views.map((view) => [
          view.view,
          JSON.parse(
            fs.readFileSync(
              path.join(run.workspace, view.sequenceManifestPath),
              "utf8",
            ),
          ).frames,
        ]),
      );
      write(
        "synchronized-reference-manifest.json",
        JSON.stringify({
          views,
          frameCorrespondence: [0, 1, 2].map((i) => ({
            time: i / 2,
            frontPath: sets.front[i].path,
            sidePath: sets.side[i].path,
            backPath: sets.back[i].path,
          })),
        }),
        "report",
      );
    }
    if (stage.charged) {
      const bytes = fs.readFileSync(
        path.join(run.workspace, `${prefix}/model.glb`),
      );
      this.receipts.set(`${run.id}/${stage.id}/${stage.attempt}`, {
        charges: [{ state: "observed", cost: 1 }],
        downloads: [
          {
            state: "completed",
            file: `${prefix}/model.glb`,
            sha256: sha(bytes),
            bytes: bytes.length,
          },
        ],
      });
    }
    return {
      status: "completed",
      summary: "Explicit mock fixture",
      artifacts,
      checks: stage.requiredChecks.map((name) => ({ name, passed: true })),
    };
  }
}
async function setup(overrides: Partial<ProductionConfig> = {}) {
  const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "partsmith-production-test-"),
    ),
    store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  const project = new Engine(store, {} as any).create("Production mock test");
  project.unityPath = path.join(root, "unity-fixture");
  for (const folder of ["Assets", "ProjectSettings"])
    fs.mkdirSync(path.join(project.unityPath, folder), { recursive: true });
  store.write(project.id, "assets/front.png", png);
  project.assets.push({
    id: "front",
    kind: "image",
    label: "Synthetic fixture",
    file: "assets/front.png",
  } as any);
  store.save(project);
  const worker = new MockWorker(),
    engine = new ProductionEngine(store, worker);
  const run = engine.create(project.id, {
    sourceId: "front",
    brief: "Mock tests only",
    motions: ["wave"],
    maxIterations: 2,
    studioCreditLimit: 100,
    videoCreditLimit: 0,
    mode: "studio",
    ...overrides,
  });
  return { store, worker, engine, run, project };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("test wait timeout");
}
async function done(engine: ProductionEngine, id: string) {
  await until(() => engine.get(id).status !== "running");
  await new Promise((r) => setTimeout(r, 5));
  return engine.get(id);
}
function saveRun(store: Store, run: ProductionRun) {
  store.put("production", run.id, run);
}

test("mock DAG automatically executes every stage serially with verified frames and Astra arguments; no video provider is required", async () => {
  const { engine, worker, run } = await setup();
  engine.start(run.id);
  const result = await done(engine, run.id);
  assert.equal(result.status, "completed", result.message);
  assert.equal(worker.calls.length, result.stages.length);
  for (const task of worker.calls)
    for (const id of task.stage.dependsOn)
      assert.equal(
        task.run.stages.find((s) => s.id === id)?.status,
        "completed",
      );
  const motion = worker.calls.find((t) => t.stage.kind === "motion-transfer")!;
  assert.equal(motion.imagePaths.length, 10);
  assert(motion.imagePaths.slice(1).every((p) => p.includes("frame-")));
  const args = codexArguments(motion);
  assert.equal(args[args.indexOf("--model") + 1], "gpt-6-astra");
  assert(!codexArguments(worker.calls[0]).includes("--model"));
  const unity = worker.calls.find((t) => t.stage.kind === "unity")!;
  assert.equal(unity.allowedWritePaths?.length, 1);
  assert(codexArguments(unity).includes("--add-dir"));
  assert.equal(motion.allowedWritePaths?.length, 0);
});
test("initial approval cannot be bypassed by pause/resume; input hashes and project revision bind approval", async () => {
  const { engine, store, run, project } = await setup();
  engine.pause(run.id);
  assert.equal(engine.get(run.id).status, "ready");
  assert.throws(() => engine.resume(run.id), /승인/);
  fs.writeFileSync(
    path.join(run.workspace, run.source.path),
    Buffer.concat([png, Buffer.from("changed")]),
  );
  assert.throws(() => engine.start(run.id), /이미지.*변경/);
  const other = engine.create(project.id, run.config);
  project.revision++;
  store.save(project);
  assert.throws(() => engine.start(other.id), /버전이 변경/);
});
test("global run serialization and local pause/resume retain bounded attempts without duplicated active work", async () => {
  const { engine, worker, run, project } = await setup();
  worker.hook = async (task, result) => {
    if (task.stage.kind === "separate" && task.stage.attempt === 1)
      await new Promise<void>((_, reject) =>
        task.signal.addEventListener("abort", () => reject(Error("stopped")), {
          once: true,
        }),
      );
    return result;
  };
  engine.start(run.id);
  await until(() => worker.calls.length === 1);
  const second = engine.create(project.id, run.config);
  assert.throws(() => engine.start(second.id), /한 번에 하나/);
  engine.pause(run.id);
  await done(engine, run.id);
  engine.resume(run.id);
  const finished = await done(engine, run.id);
  assert.equal(finished.status, "completed", finished.message);
  assert.equal(finished.stages[0].attempt, 2);
});
test("zero studio budget and disconnected login stop before the first paid invocation", async () => {
  for (const mode of ["budget", "studio", "auth"]) {
    const { engine, worker, run } = await setup(
      mode === "budget" ? { studioCreditLimit: 0 } : {},
    );
    if (mode === "studio") worker.studio = false;
    if (mode === "auth") worker.authenticated = false;
    engine.start(run.id);
    const stopped = await done(engine, run.id);
    assert.equal(stopped.status, "needs_input");
    assert(!worker.calls.some((t) => t.stage.charged));
    assert(!stopped.stages.some((s) => s.remoteAmbiguous));
  }
});
test("pre-submit error can resume; host-journaled unknown submission never automatically retries even after restart", async () => {
  for (const charged of [false, true]) {
    const { engine, worker, store, run } = await setup();
    let once = true;
    worker.hook = (task, result) => {
      if (task.stage.id === "body.generate" && once) {
        once = false;
        if (!charged)
          worker.receipts.delete(
            `${run.id}/${task.stage.id}/${task.stage.attempt}`,
          );
        throw Error("Synthetic transport failure");
      }
      return result;
    };
    engine.start(run.id);
    const stopped = await done(engine, run.id);
    assert.equal(
      stopped.stages.find((s) => s.id === "body.generate")!.remoteAmbiguous,
      charged,
    );
    const reopened = new ProductionEngine(store, worker);
    if (charged) {
      assert.throws(() => reopened.resume(run.id), /원격 제출/);
      assert.equal(
        worker.calls.filter((t) => t.stage.id === "body.generate").length,
        1,
      );
    } else {
      reopened.resume(run.id);
      assert.equal((await done(reopened, run.id)).status, "completed");
    }
  }
});
test("startup recovers running charged stage using trusted receipt and does not auto execute", async () => {
  const { engine, worker, store, run } = await setup();
  run.status = "running";
  run.approvedAt = new Date().toISOString();
  const stage = run.stages.find((s) => s.id === "body.generate")!;
  stage.status = "running";
  stage.attempt = 1;
  worker.receipts.set(`${run.id}/${stage.id}/1`, {
    charges: [{ state: "reserved", cost: 5 }],
    downloads: [],
  });
  saveRun(store, run);
  const reopened = new ProductionEngine(store, worker);
  assert.equal(reopened.get(run.id).status, "needs_input");
  assert.equal(worker.calls.length, 0);
  assert.throws(() => reopened.resume(run.id), /원격 제출/);
  engine.shutdown();
});
test("a charge recorded after pause is rechecked before resume and cannot become a second submission", async () => {
  const { engine, worker, store, run } = await setup();
  run.approvedAt = new Date().toISOString();
  run.status = "paused";
  const stage = run.stages.find((s) => s.id === "body.generate")!;
  stage.status = "needs_input";
  stage.attempt = 1;
  stage.remoteAmbiguous = false;
  saveRun(store, run);
  worker.receipts.set(`${run.id}/${stage.id}/1`, {
    charges: [{ state: "clicked", cost: 5 }],
    downloads: [],
  });
  assert.throws(() => engine.resume(run.id), /원격 제출/);
  assert.equal(worker.calls.length, 0);
  assert.equal(
    engine.get(run.id).stages.find((s) => s.id === stage.id)!.remoteAmbiguous,
    true,
  );
});
test("confirmed paid quality rework automatically reruns target and descendants within bound", async () => {
  const { engine, worker, run } = await setup();
  worker.hook = (task, result) =>
    task.stage.id === "body.review" && task.stage.attempt === 1
      ? {
          status: "rework",
          summary: "Mock geometry defect",
          artifacts: [],
          checks: [],
          reworkStageId: "body.generate",
        }
      : result;
  engine.start(run.id);
  const result = await done(engine, run.id);
  assert.equal(result.status, "completed", result.message);
  assert.equal(result.stages.find((s) => s.id === "body.generate")!.attempt, 2);
  assert.equal(result.stages.find((s) => s.id === "body.uv")!.attempt, 1);
});
test("persistent quality failure exhausts maxIterations and never runs descendants", async () => {
  const { engine, worker, run } = await setup();
  worker.hook = (task, result) =>
    task.stage.id === "body.review"
      ? {
          status: "rework",
          summary: "Mock persistent defect",
          artifacts: [],
          checks: [],
          reworkStageId: "body.generate",
        }
      : result;
  engine.start(run.id);
  const result = await done(engine, run.id);
  assert.equal(result.status, "needs_input");
  assert.equal(
    worker.calls.filter((t) => t.stage.id === "body.generate").length,
    2,
  );
  assert(!worker.calls.some((t) => t.stage.id === "body.uv"));
});
test("completion checks reject missing, empty, traversal, symlink, false checks, and header-only fake models", async () => {
  for (const mode of [
    "missing",
    "empty",
    "traversal",
    "symlink",
    "check",
    "header",
    "receipt",
  ]) {
    const { engine, worker, run } = await setup();
    worker.hook = (task, result) => {
      const target =
        mode === "header" || mode === "receipt" ? "body.generate" : "separate";
      if (task.stage.id !== target) return result;
      const artifact = result.artifacts.find(
        (a) => a.kind === (target === "separate" ? "image" : "model"),
      )!;
      const file = path.join(run.workspace, artifact.path);
      if (mode === "missing") fs.unlinkSync(file);
      if (mode === "empty") fs.writeFileSync(file, "");
      if (mode === "traversal") artifact.path = "../outside.png";
      if (mode === "symlink") {
        const outside = fs.mkdtempSync(
          path.join(os.tmpdir(), "outside-proof-"),
        );
        fs.writeFileSync(path.join(outside, "image.png"), png);
        const junction = path.join(path.dirname(file), "escape");
        fs.symlinkSync(outside, junction, "junction");
        artifact.path = path.relative(
          run.workspace,
          path.join(junction, "image.png"),
        );
      }
      if (mode === "check") result.checks[0].passed = false;
      if (mode === "header") {
        const bytes = Buffer.alloc(20);
        bytes.write("glTF");
        bytes.writeUInt32LE(2, 4);
        bytes.writeUInt32LE(20, 8);
        fs.writeFileSync(file, bytes);
      }
      if (mode === "receipt")
        worker.receipts.delete(
          `${run.id}/${task.stage.id}/${task.stage.attempt}`,
        );
      return result;
    };
    engine.start(run.id);
    const result = await done(engine, run.id);
    assert.equal(result.status, "needs_input", mode);
    assert.match(result.message, /검증 실패/, mode);
    assert(!worker.calls.some((t) => t.stage.kind === "motion-transfer"));
  }
});
test("missing sequence and identical copied frames cannot satisfy animated reference evidence", async () => {
  for (const mode of ["missing", "copied"]) {
    const { engine, worker, run } = await setup();
    worker.hook = (task, result) => {
      if (task.stage.kind !== "animation-reference") return result;
      const manifest = result.artifacts.find((a) =>
        a.path.endsWith("sequence-manifest.json"),
      )!;
      if (mode === "missing")
        result.artifacts = result.artifacts.filter((a) => a !== manifest);
      else {
        const file = path.join(run.workspace, manifest.path),
          data = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const frame of data.frames) {
          fs.writeFileSync(path.join(run.workspace, frame.path), png);
          frame.sha256 = sha(png);
        }
        fs.writeFileSync(file, JSON.stringify(data));
      }
      return result;
    };
    engine.start(run.id);
    const result = await done(engine, run.id);
    assert.equal(result.status, "needs_input");
    assert(
      !worker.calls.some(
        (t) => t.stage.kind === "motion-transfer" || t.stage.kind === "unity",
      ),
    );
  }
});
test("repeated correspondence timestamps and missing rig/animation blocks final success", async () => {
  for (const mode of ["repeated", "rig", "animation"]) {
    const { engine, worker, run } = await setup();
    worker.hook = (task, result) => {
      if (task.stage.kind !== "motion-transfer") return result;
      if (mode === "repeated") {
        const a = result.artifacts.find((a) =>
            a.path.endsWith("synchronized-reference-manifest.json"),
          )!,
          file = path.join(run.workspace, a.path),
          data = JSON.parse(fs.readFileSync(file, "utf8"));
        data.frameCorrespondence.fill(data.frameCorrespondence[0]);
        fs.writeFileSync(file, JSON.stringify(data));
      } else
        fs.writeFileSync(
          path.join(
            run.workspace,
            result.artifacts.find((a) => a.kind === "model")!.path,
          ),
          glb(mode !== "rig", mode !== "animation"),
        );
      return result;
    };
    engine.start(run.id);
    const result = await done(engine, run.id);
    assert.equal(result.status, "needs_input", mode);
    assert(!worker.calls.some((t) => t.stage.kind === "unity"));
  }
});
