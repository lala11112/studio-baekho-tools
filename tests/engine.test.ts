import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { Tripo, TripoError } from "../engine/tripo";
import type { Generation } from "../shared/types";
const input: Generation = {
  kind: "image",
  prompt: "test humanoid",
  model: "seedream_v5",
  size: "2K",
  count: 1,
};
async function setup(fake: any = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-test-"));
  const store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  const engine = new Engine(store, fake as Tripo);
  return { root, store, engine, p: engine.create("Test") };
}
async function settled(store: Store, id: string) {
  for (let i = 0; i < 50; i++) {
    const j = store.project(id).jobs;
    if (
      j.length &&
      j.every((x) => !["queued", "submitting"].includes(x.status))
    )
      return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("timeout");
}
test("approval is single-use and binds exact project revision", async () => {
  let calls = 0;
  const { engine, store, p } = await setup({
    submit: async () => {
      calls++;
      return { task_id: "task_123" };
    },
  });
  const q = engine.quote(p.id, input);
  assert.throws(() => engine.approve(q.id, false), /동의/);
  engine.approve(q.id, true);
  assert.throws(() => engine.approve(q.id, true), /이미/);
  await settled(store, p.id);
  assert.equal(calls, 1);
  const stale = engine.quote(p.id, input);
  engine.touch(store.project(p.id));
  assert.throws(() => engine.approve(stale.id, true), /변경/);
});
test("ambiguous POST never automatically retries and cancels remaining candidates", async () => {
  let calls = 0;
  const { engine, store, p } = await setup({
    submit: async () => {
      calls++;
      throw new TripoError("timeout");
    },
  });
  engine.approve(engine.quote(p.id, { ...input, count: 3 }).id, true);
  const jobs = await settled(store, p.id);
  assert.equal(calls, 1);
  assert.equal(jobs[0].status, "submission_unknown");
  assert.deepEqual(
    jobs.slice(1).map((j) => j.status),
    ["cancelled_local", "cancelled_local"],
  );
});
test("known remote ID survives restart and download error; requery does not create jobs", async () => {
  let submits = 0,
    queries = 0;
  const fake = {
    submit: async () => {
      submits++;
      return { task_id: "task_abc" };
    },
    task: async () => {
      queries++;
      return {
        status: "success",
        output: { generated_image_url: "https://cdn.tripo3d.ai/test.png" },
        credits_consumed: 20,
      };
    },
    download: async () => {
      throw Error("offline");
    },
  };
  const { engine, store, p, root } = await setup(fake);
  engine.approve(engine.quote(p.id, input).id, true);
  const [job] = await settled(store, p.id);
  await assert.rejects(() => engine.poll(p.id, job.id));
  assert.equal(store.project(p.id).jobs[0].remoteId, "task_abc");
  const reopened = new Store(root);
  await reopened.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  assert.equal(reopened.project(p.id).jobs[0].remoteId, "task_abc");
  assert.equal(submits, 1);
  assert.equal(queries, 1);
});
test("poll downloads once, creates image lineage and records actual cost", async () => {
  let downloads = 0;
  const { engine, store, p } = await setup({
    submit: async () => ({ task_id: "task_ok" }),
    task: async () => ({
      status: "success",
      output: { generated_image_url: "https://cdn.tripo3d.ai/test.png" },
      credits_consumed: 12,
    }),
    download: async () => {
      downloads++;
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    },
  });
  engine.approve(engine.quote(p.id, input).id, true);
  const [j] = await settled(store, p.id);
  await engine.poll(p.id, j.id);
  await engine.poll(p.id, j.id);
  const next = store.project(p.id);
  assert.equal(downloads, 1);
  assert.equal(next.assets.length, 1);
  assert.equal(next.jobs[0].credits, 12);
  assert.equal(next.assets[0].origin, "tripo");
});
test("tracking stop does not falsely claim remote cancellation", async () => {
  const { engine, store, p } = await setup({
    submit: async () => ({ task_id: "task_run" }),
  });
  engine.approve(engine.quote(p.id, input).id, true);
  const [j] = await settled(store, p.id);
  engine.cancel(p.id, j.id);
  assert.equal(store.project(p.id).jobs[0].status, "paused");
  assert.match(store.project(p.id).jobs[0].message!, /과금/);
});
test("path traversal and unsupported input are rejected", async () => {
  const { store, engine, p } = await setup();
  assert.throws(() => store.file(p.id, "../../secrets"), /밖/);
  assert.throws(
    () => engine.quote(p.id, { ...input, model: "imaginary-model" }),
    /지원/,
  );
  assert.throws(() => engine.quote(p.id, { ...input, count: 100 }));
  assert.throws(() =>
    engine.quote(p.id, { ...input, kind: "rig", sourceId: "missing" }),
  );
});
test("provider never sends credentials to download URLs; rejects loopback", async () => {
  let request: any;
  const api = new Tripo(
    () => "test-token",
    async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ code: 0, data: { balance: 30 } }), {
        status: 200,
      });
    },
  );
  assert.equal((await api.balance()).balance, 30);
  assert.equal(request.url, "https://openapi.tripo3d.ai/v3/account/balance");
  assert.equal(request.init.headers.Authorization, "Bearer test-token");
  await assert.rejects(() => api.download("http://127.0.0.1/secret"), /도메인/);
});
test("regional authentication uses the chosen host once, with no cross-region retry", async () => {
  const calls: string[] = [];
  const api = new Tripo(
    () => "secret-test-token",
    async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ code: 2 }), { status: 401 });
    },
    () => "china",
  );
  await assert.rejects(
    () => api.balance(),
    (error) => {
      assert.match((error as Error).message, /중국\(\.com\)/);
      assert.match((error as Error).message, /연결 지역/);
      assert(!(error as Error).message.includes("secret-test-token"));
      return true;
    },
  );
  assert.deepEqual(calls, ["https://openapi.tripo3d.com/v3/account/balance"]);
});
test("legacy settings retain local paths and migrate to international authentication", async () => {
  const { store } = await setup();
  store.put("settings", "local", {
    blenderPath: "custom-blender",
    unityPath: "custom-project",
    unityEditorPath: "custom-unity",
  });
  assert.equal(store.settings.tripoRegion, "international");
  assert.equal(store.settings.unityPath, "custom-project");
});
test("recover interrupted submission as unknown, not resubmitted", async () => {
  const { p, store, root } = await setup();
  p.jobs.push({
    id: "interrupted",
    kind: "image",
    status: "submitting",
    progress: 0,
    quoteId: "q",
    request: input,
    createdAt: "test",
    revision: 0,
  });
  store.save(p);
  const reopened = new Store(root);
  await reopened.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  assert.equal(reopened.project(p.id).jobs[0].status, "submission_unknown");
});
