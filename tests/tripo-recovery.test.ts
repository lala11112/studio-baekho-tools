import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../engine/engine";
import { Store } from "../engine/store";
import { Tripo, TripoError } from "../engine/tripo";
import type { Generation } from "../shared/types";

const fbx = Buffer.from(
  "Kaydara FBX Binary  \x00\x1a\x00immutable native quad model",
);
const imageRequest: Generation = {
  kind: "image",
  prompt: "prop",
  model: "seedream_v5",
  size: "2K",
  count: 1,
};
const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tripo-result-recovery-"));
  const store = new Store(root);
  await store.open(wasm);
  const opened = [store];
  t.after(() => {
    opened.forEach((value) => value.db.close());
    fs.rmSync(root, { recursive: true, force: true });
  });
  const count = { posts: 0, gets: 0, downloads: 0, previews: 0 };
  let offline = false,
    previewFails = true,
    outputBytes: Buffer = fbx,
    responseId = "task_result",
    query = "first";
  const api = {
    upload: async () => "file_original",
    submit: async () => {
      count.posts++;
      return { task_id: "task_result" };
    },
    task: async () => {
      count.gets++;
      if (offline) throw Error("metadata offline");
      return {
        task_id: responseId,
        status: "success",
        credits_consumed: 100,
        output: {
          model_url: `https://cdn.tripo3d.ai/result.glb?signature=${query}`,
        },
      };
    },
    download: async () => {
      count.downloads++;
      return outputBytes;
    },
  } as unknown as Tripo;
  const preview = (current: Store) => async (id: string, native: string) => {
    count.previews++;
    if (previewFails) throw Error("Blender unavailable");
    const file = native.replace(/\.fbx$/, "-preview.glb");
    current.write(id, file, Buffer.from("glTFvalidated preview fixture"));
    return file;
  };
  const engine = new Engine(store, api, preview(store));
  const project = engine.create("recovery fixture");
  store.write(project.id, "assets/reference.png", Buffer.from("reference"));
  const source = engine.asset(
    project,
    "assets/reference.png",
    "image",
    "original",
    "import",
  );
  store.save(project);
  const request: Generation = {
    kind: "model",
    model: "P2-20260801",
    prompt: "",
    count: 1,
    sourceId: source.id,
    quad: true,
    texture: false,
  };
  const [job] = engine.approve(engine.quote(project.id, request).id, true);
  for (
    let i = 0;
    i < 100 && store.project(project.id).jobs[0].status !== "running";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.project(project.id).jobs[0].status, "running");
  return {
    root,
    store,
    engine,
    project,
    source,
    job,
    count,
    native: () => store.project(project.id).jobs[0].nativeFiles![0],
    setOffline: () => {
      offline = true;
    },
    setReady: () => {
      previewFails = false;
    },
    setBytes: (bytes: Buffer) => {
      outputBytes = bytes;
    },
    setResponseId: (id: string) => {
      responseId = id;
    },
    refreshSignature: () => {
      query = "refreshed";
    },
    reopen: async () => {
      const next = new Store(root);
      await next.open(wasm);
      opened.push(next);
      return { store: next, engine: new Engine(next, api, preview(next)) };
    },
  };
}

test("a persisted native result recovers after restart without GET, download or paid POST", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.engine.poll(f.project.id, f.job.id), /Blender/);
  const native = f.native();
  assert.deepEqual(fs.readFileSync(f.store.file(f.project.id, native)), fbx);
  f.setOffline();
  f.setReady();
  const next = await f.reopen();
  await next.engine.poll(f.project.id, f.job.id);
  const current = next.store.project(f.project.id),
    job = current.jobs[0];
  assert.equal(job.status, "success");
  assert.equal(job.remoteId, "task_result");
  assert.equal(job.credits, 100);
  assert.deepEqual(job.nativeFiles, [native]);
  assert.equal(
    current.assets.find((asset) => asset.id === job.assetId)?.parentId,
    f.source.id,
  );
  assert.deepEqual(f.count, { posts: 1, gets: 1, downloads: 1, previews: 2 });
});

test("a changed cached native is blocked before network or conversion and never overwritten", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.engine.poll(f.project.id, f.job.id), /Blender/);
  const file = f.store.file(f.project.id, f.native()),
    changed = Buffer.concat([fbx, Buffer.from("changed")]);
  fs.writeFileSync(file, changed);
  f.setReady();
  const next = await f.reopen();
  await assert.rejects(next.engine.poll(f.project.id, f.job.id), /원본 해시/);
  assert.deepEqual(fs.readFileSync(file), changed);
  assert.equal(next.store.project(f.project.id).jobs[0].assetId, undefined);
  assert.deepEqual(f.count, { posts: 1, gets: 1, downloads: 1, previews: 1 });
});

test("a missing cached native downloads only the same remote result and verifies its prior hash", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.engine.poll(f.project.id, f.job.id), /Blender/);
  const file = f.store.file(f.project.id, f.native());
  fs.unlinkSync(file);
  f.refreshSignature();
  f.setReady();
  await f.engine.poll(f.project.id, f.job.id);
  assert.deepEqual(fs.readFileSync(file), fbx);
  assert.equal(f.store.project(f.project.id).jobs[0].status, "success");
  assert.deepEqual(f.count, { posts: 1, gets: 2, downloads: 2, previews: 2 });
});

test("a replaced remote download cannot fill a missing hash-bound native checkpoint", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.engine.poll(f.project.id, f.job.id), /Blender/);
  const file = f.store.file(f.project.id, f.native());
  fs.unlinkSync(file);
  f.setBytes(Buffer.concat([fbx, Buffer.from("replacement")]));
  f.setReady();
  await assert.rejects(f.engine.poll(f.project.id, f.job.id), /저장된 해시/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(f.store.project(f.project.id).jobs[0].assetId, undefined);
  assert.equal(f.count.posts, 1);
  assert.equal(f.count.previews, 1);
});

test("a mismatched task query ID never acquires another task's outputs or cost", async (t) => {
  const f = await fixture(t);
  f.setResponseId("task_someone_else");
  await assert.rejects(f.engine.poll(f.project.id, f.job.id), /원격 작업 ID/);
  const job = f.store.project(f.project.id).jobs[0];
  assert.equal(job.remoteId, "task_result");
  assert.equal(job.credits, undefined);
  assert.equal(job.nativeFiles, undefined);
  assert.deepEqual(f.count, { posts: 1, gets: 1, downloads: 0, previews: 0 });
});

test("legacy originals without receipts are compared to the known remote result before reuse", async (t) => {
  const f = await fixture(t);
  const project = f.store.project(f.project.id),
    native = `assets/${f.job.id}.fbx`;
  project.jobs[0].nativeFiles = [native];
  const original = Buffer.concat([
    fbx,
    Buffer.from("unverified legacy original"),
  ]);
  f.store.write(project.id, native, original);
  f.store.save(project);
  f.setReady();
  await assert.rejects(f.engine.poll(project.id, f.job.id), /원본 해시/);
  assert.deepEqual(fs.readFileSync(f.store.file(project.id, native)), original);
  assert.equal(f.count.posts, 1);
  assert.equal(f.count.previews, 0);
});

test("a result checkpoint cannot be reused after changing the frozen request", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.engine.poll(f.project.id, f.job.id), /Blender/);
  const project = f.store.project(f.project.id);
  project.jobs[0].request.quad = false;
  f.store.save(project);
  f.setReady();
  await assert.rejects(
    f.engine.poll(project.id, f.job.id),
    /작업·요청이 다릅니다/,
  );
  assert.deepEqual(f.count, { posts: 1, gets: 1, downloads: 1, previews: 1 });
});

test("reconciliation attaches one unknown submission and cannot replace an established remote identity", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => f.engine.reconcile(f.project.id, f.job.id, "task_other"),
    /교체/,
  );
  assert.equal(
    f.engine.reconcile(f.project.id, f.job.id, "task_result").remoteId,
    "task_result",
  );
  const project = f.store.project(f.project.id);
  project.jobs.push({
    ...f.job,
    id: "unknown",
    status: "submission_unknown",
    remoteId: undefined,
  });
  f.store.save(project);
  assert.equal(
    f.engine.reconcile(project.id, "unknown", "task_recovered").remoteId,
    "task_recovered",
  );
  assert.throws(
    () => f.engine.reconcile(project.id, "unknown", "task_other"),
    /교체/,
  );
  assert.equal(f.count.posts, 1);
});

test("provider POST disables redirects and malformed task receipts remain ambiguous without retries", async () => {
  for (const task_id of [null, {}, "task id with spaces", ""]) {
    let calls = 0;
    const api = new Tripo(
      () => "fixture-only-key",
      async (_url, init) => {
        calls++;
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        return new Response(JSON.stringify({ code: 0, data: { task_id } }), {
          status: 200,
        });
      },
    );
    await assert.rejects(
      api.submit("/generation/text-to-image", imageRequest),
      (error) => {
        assert(error instanceof TripoError);
        assert.equal(error.definitive, false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("malformed upload tokens stop before any generation submission", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "tripo-upload-validation-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "reference.png");
  fs.writeFileSync(file, "fixture");
  let calls = 0;
  const api = new Tripo(
    () => "fixture-only-key",
    async (url, init) => {
      calls++;
      assert.equal(String(url).endsWith("/files"), true);
      assert.equal(init?.redirect, "error");
      return new Response(
        JSON.stringify({
          code: 0,
          data: { file_token: { invalid: "not a string" } },
        }),
        { status: 200 },
      );
    },
  );
  await assert.rejects(api.upload(file), /유효한 파일 토큰/);
  assert.equal(calls, 1);
});
