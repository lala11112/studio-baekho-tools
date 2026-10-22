import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import type { Tripo } from "../engine/tripo";
import type { Generation, Job } from "../shared/types";

const imageUrl = "https://cdn.tripo3d.ai/reference.png";
const modelUrl = "https://cdn.tripo3d.ai/model.glb";
const glb = Buffer.from("glTFmock-model");
const p2: Generation = {
  kind: "model",
  model: "P2-20260801",
  prompt: "memo is not image-to-model prompt",
  count: 1,
};

async function setup(
  overrides: Record<string, unknown> = {},
  preview?: (id: string, file: string) => Promise<string>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-processing-"));
  const store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  const calls: { endpoint: string; body: any }[] = [],
    uploads: string[] = [];
  const fake = {
    upload: async (file: string) => {
      uploads.push(file);
      return "file_" + path.basename(file);
    },
    submit: async (endpoint: string, body: unknown) => {
      calls.push({ endpoint, body });
      return { task_id: "task_" + calls.length };
    },
    task: async () => ({
      status: "success",
      output: { model_url: modelUrl },
      credits_consumed: 110,
    }),
    download: async () => glb,
    ...overrides,
  };
  const engine = new Engine(store, fake as unknown as Tripo, preview);
  const p = engine.create("API processing tests");
  const add = (kind: "image" | "model", name: string) => {
    const file = `assets/${name}.${kind === "image" ? "png" : "glb"}`;
    store.write(p.id, file, kind === "image" ? Buffer.from("image") : glb);
    return engine.asset(p, file, kind, name, "import");
  };
  const images = ["front", "left", "back", "right"].map((name) =>
    add("image", name),
  );
  const model = add("model", "source-model");
  p.parts[0].imageId = images[0].id;
  store.save(p);
  return { root, store, engine, p, images, model, calls, uploads };
}

async function submit(
  s: Awaited<ReturnType<typeof setup>>,
  request: Generation,
): Promise<Job> {
  const q = s.engine.quote(s.p.id, request);
  const [job] = s.engine.approve(q.id, true);
  for (let i = 0; i < 100; i++) {
    const live = s.store.project(s.p.id).jobs.find((j) => j.id === job.id)!;
    if (!["queued", "submitting"].includes(live.status)) {
      assert.equal(live.status, "running", live.message);
      return live;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("submission timed out");
}

test("P2 image uses official fields and supports independent generation without a part", async () => {
  const s = await setup();
  await submit(s, {
    ...p2,
    sourceId: s.images[0].id,
    faceLimit: 12000,
    quad: true,
    texture: false,
    pbr: true,
    exportUv: true,
    textureVersion: "v3.5-20260815",
  });
  assert.deepEqual(s.calls, [
    {
      endpoint: "/generation/image-to-model",
      body: {
        input: "file_front.png",
        model: "P2-20260801",
        face_limit: 12000,
        quad: true,
        texture: false,
        pbr: false,
        texture_quality: "standard",
        texture_version: "v3.5-20260815",
        export_uv: true,
      },
    },
  ]);
  assert.equal(
    s.engine.quote(s.p.id, { ...p2, partId: s.p.parts[0].id }).request.sourceId,
    s.images[0].id,
  );
  assert.equal(
    s.engine.quote(s.p.id, { ...p2, sourceId: s.images[0].id })
      .estimatedCredits,
    null,
  );
});

test("paid requests reject invalid P2 bounds, stale/locked parts and unsupported texture quality", async () => {
  const s = await setup();
  const source = { ...p2, sourceId: s.images[0].id };
  for (const options of [
    { faceLimit: 47 },
    { faceLimit: 50001 },
    { quad: true, faceLimit: 25001 },
    { textureQuality: "fast" as const },
  ])
    assert.throws(() => s.engine.quote(s.p.id, { ...source, ...options }));
  assert.throws(() =>
    s.engine.quote(s.p.id, {
      ...source,
      model: "P1-20260311",
      faceLimit: 20001,
    }),
  );
  const p = s.store.project(s.p.id);
  p.parts[0].locked = true;
  s.store.save(p);
  assert.throws(
    () => s.engine.quote(s.p.id, { ...p2, partId: p.parts[0].id }),
    /고정/,
  );
  assert.equal(s.calls.length, 0);
});

test("text and sparse multiview use separate endpoints and record all parent images", async () => {
  const s = await setup();
  await submit(s, {
    ...p2,
    inputMode: "text",
    prompt: "A stylized knight",
    texture: true,
  });
  assert.equal(s.calls[0].endpoint, "/generation/text-to-model");
  assert.equal(s.calls[0].body.prompt, "A stylized knight");
  assert(!("input" in s.calls[0].body));
  assert.throws(() =>
    s.engine.quote(s.p.id, {
      ...p2,
      inputMode: "text",
      prompt: "x".repeat(1025),
    }),
  );
  assert.throws(
    () =>
      s.engine.quote(s.p.id, {
        ...p2,
        inputMode: "multiview",
        sourceIds: ["", s.images[1].id],
      }),
    /정면/,
  );
  const job = await submit(s, {
    ...p2,
    inputMode: "multiview",
    sourceIds: [s.images[0].id, "", s.images[2].id, ""],
  });
  assert.deepEqual(s.calls[1].body.inputs, [
    { front: "file_front.png" },
    { back: "file_back.png" },
  ]);
  assert.equal(s.calls[1].endpoint, "/generation/multiview-to-model");
  await s.engine.poll(s.p.id, job.id);
  const a = s.store.project(s.p.id).assets.find((a) => a.jobId === job.id)!;
  assert.deepEqual(a.parentIds, [s.images[0].id, s.images[2].id]);
  assert.equal(a.origin, "tripo");
});

test("P2 FBX originals, cost and remote identity survive failed preview then recover without another POST", async () => {
  let downloads = 0,
    attempts = 0;
  let store!: Store;
  const native = Buffer.from(
    "Kaydara FBX Binary  \x00\x1a\x00retained quad mesh",
  );
  const s = await setup(
    {
      download: async () => {
        downloads++;
        return native;
      },
    },
    async (id, file) => {
      attempts++;
      assert.equal(
        path.extname(file),
        ".fbx",
        "actual content overrides misleading .glb URL",
      );
      assert.deepEqual(fs.readFileSync(store.file(id, file)), native);
      if (attempts === 1) throw new Error("Blender unavailable");
      const preview = file.replace(".fbx", "-preview.glb");
      store.write(id, preview, glb);
      return preview;
    },
  );
  store = s.store;
  const job = await submit(s, { ...p2, sourceId: s.images[0].id, quad: true });
  await assert.rejects(() => s.engine.poll(s.p.id, job.id), /Blender/);
  const pending = s.store.project(s.p.id).jobs[0];
  assert.equal(pending.remoteId, job.remoteId);
  assert.equal(pending.status, "running");
  assert.equal(pending.credits, 110);
  assert.equal(pending.nativeFiles?.length, 1);
  assert.deepEqual(
    fs.readFileSync(s.store.file(s.p.id, pending.nativeFiles![0])),
    native,
  );
  await s.engine.poll(s.p.id, job.id);
  await s.engine.poll(s.p.id, job.id);
  const done = s.store.project(s.p.id),
    a = done.assets.find((a) => a.jobId === job.id)!;
  assert.equal(a.format, "fbx");
  assert.match(a.nativeFile!, /\.fbx$/);
  assert.match(a.file, /-preview\.glb$/);
  assert.equal(a.parentId, s.images[0].id);
  assert.equal(downloads, 1);
  assert.equal(attempts, 2);
  assert.equal(s.calls.length, 1);
});

test("smart segmentation handles seg_model_url plus mask, lineage and underlying completion task", async () => {
  let taskOutput: Record<string, unknown> = {
    seg_model_url: modelUrl,
    mask_url: imageUrl,
    prompt: "head,body",
    seg_task_id: "task_segments",
    model_task_id: "task_generated",
  };
  const s = await setup({
    task: async () => ({
      status: "success",
      output: taskOutput,
      credits_consumed: 55,
    }),
    download: async (url: string) =>
      url.endsWith(".png")
        ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        : glb,
  });
  const job = await submit(s, {
    kind: "smartsegment",
    model: "",
    prompt: "head,hair,body",
    count: 1,
    sourceId: s.model.id,
    segType: "model",
    smartGranularity: "fine",
  });
  assert.equal(s.calls[0].endpoint, "/mesh/smartsegment");
  assert.equal(s.calls[0].body.input, "file_source-model.glb");
  assert.deepEqual(
    s.calls[0].body.transform,
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  );
  await s.engine.poll(s.p.id, job.id);
  const completed = s.store.project(s.p.id).jobs[0];
  assert.equal(completed.assetIds?.length, 2);
  assert.equal(completed.output?.seg_task_id, "task_segments");
  const results = s.store
    .project(s.p.id)
    .assets.filter((a) => a.jobId === job.id);
  assert.deepEqual(
    results.map((a) => a.kind),
    ["model", "image"],
  );
  assert(results.every((a) => a.parentId === s.model.id));
  const uploadCount = s.uploads.length;
  taskOutput = { model_url: modelUrl };
  await submit(s, {
    kind: "complete",
    model: "v1.0-20250506",
    prompt: "",
    count: 1,
    sourceTaskId: job.remoteId,
    completionMode: "quick_cap",
    partNames: ["head"],
  });
  assert.deepEqual(s.calls[1], {
    endpoint: "/mesh/complete",
    body: {
      input: "task_segments",
      model: "v1.0-20250506",
      completion_mode: "quick_cap",
      part_names: ["head"],
    },
  });
  assert.equal(
    s.uploads.length,
    uploadCount,
    "completion input is a segmentation task, never a newly uploaded model",
  );
});

test("segment, retopology, Tripo UV packing and texturing emit only supported payloads", async () => {
  const s = await setup();
  const common = { sourceId: s.model.id, prompt: "", count: 1 };
  await submit(s, {
    ...common,
    kind: "segment",
    model: "v2.0-20260430",
    segmentationGranularity: "detailed",
    splitByConnectivity: false,
  });
  await submit(s, {
    ...common,
    kind: "retopology",
    model: "v2.0",
    faceLimit: 5000,
    quad: true,
    bake: false,
    partNames: ["head"],
  });
  await submit(s, { ...common, kind: "uv-pack", model: "", textureSize: 2048 });
  await submit(s, {
    ...common,
    kind: "texture",
    model: "v3.5-20260815",
    prompt: "painted leather",
    textureQuality: "fast",
    pbr: true,
  });
  assert.deepEqual(s.calls[0], {
    endpoint: "/mesh/segment",
    body: {
      input: "file_source-model.glb",
      model: "v2.0-20260430",
      segmentation_granularity: "detailed",
      split_by_connectivity: false,
    },
  });
  assert.deepEqual(s.calls[1], {
    endpoint: "/mesh/decimate",
    body: {
      input: "file_source-model.glb",
      model: "v2.0",
      face_limit: 5000,
      quad: true,
      bake: false,
      part_names: ["head"],
    },
  });
  assert.deepEqual(s.calls[2], {
    endpoint: "/models/convert",
    body: {
      input: "file_source-model.glb",
      format: "GLTF",
      pack_uv: true,
      bake: true,
      texture_size: 2048,
      texture_format: "PNG",
      with_animation: true,
    },
  });
  assert.deepEqual(s.calls[3].body.texture_prompt, { text: "painted leather" });
  assert.equal(s.calls[3].body.delight, true);
  assert.throws(() =>
    s.engine.quote(s.p.id, {
      ...common,
      kind: "retopology",
      model: "v2.0",
      quad: true,
      faceLimit: 10001,
    }),
  );
  assert.throws(() =>
    s.engine.quote(s.p.id, {
      ...common,
      kind: "retopology",
      model: "v1.0",
      faceLimit: 5000,
      bake: true,
    }),
  );
  assert.throws(() =>
    s.engine.quote(s.p.id, {
      ...common,
      kind: "convert",
      model: "",
      format: "GLTF",
      quad: true,
    }),
  );
  assert.throws(() =>
    s.engine.quote(s.p.id, {
      ...common,
      kind: "segment",
      model: "v2.0-20260430",
      count: 2,
    }),
  );
  assert.throws(() =>
    s.engine.quote(s.p.id, {
      ...common,
      kind: "texture",
      model: "v3.0-20250812",
      textureQuality: "fast",
    }),
  );
});

test("texture reference upload is distinct from model input and mutually exclusive with text", async () => {
  const s = await setup();
  const request: Generation = {
    kind: "texture",
    model: "v3.5-20260815",
    sourceId: s.model.id,
    sourceIds: [s.images[0].id],
    prompt: "",
    count: 1,
  };
  await submit(s, request);
  assert.equal(s.calls[0].body.input, "file_source-model.glb");
  assert.deepEqual(s.calls[0].body.texture_prompt, { image: "file_front.png" });
  assert.throws(
    () => s.engine.quote(s.p.id, { ...request, prompt: "cannot mix" }),
    /하나만/,
  );
});

test("missing result URL remains retryable, while rig-check succeeds without file only with boolean result", async () => {
  let output: Record<string, unknown> = {};
  const s = await setup({
    task: async () => ({ status: "success", output, credits_consumed: 0 }),
  });
  const job = await submit(s, { ...p2, sourceId: s.images[0].id });
  await assert.rejects(() => s.engine.poll(s.p.id, job.id), /결과 파일 URL/);
  assert.equal(s.store.project(s.p.id).jobs[0].status, "running");
  const rig = await submit(s, {
    kind: "rig-check",
    model: "",
    sourceId: s.model.id,
    prompt: "",
    count: 1,
  });
  assert.equal(
    s.engine.quote(s.p.id, {
      kind: "rig-check",
      model: "",
      sourceId: s.model.id,
      prompt: "",
      count: 1,
    }).estimatedCredits,
    0,
  );
  await assert.rejects(() => s.engine.poll(s.p.id, rig.id), /riggable/);
  output = { riggable: false, rig_type: "unknown" };
  await s.engine.poll(s.p.id, rig.id);
  const live = s.store.project(s.p.id).jobs.find((j) => j.id === rig.id)!;
  assert.equal(live.status, "success");
  assert.equal(live.assetId, undefined);
  assert.match(live.message!, /부적합/);
});

test("image candidates wait for the prior remote result before the next paid POST", async () => {
  const order: string[] = [];
  let count = 0;
  const s = await setup({
    submit: async () => {
      order.push("POST");
      return { task_id: `task_image_${++count}` };
    },
    task: async () => {
      order.push("GET");
      return { status: "success", output: { generated_image_url: imageUrl } };
    },
    download: async () => {
      order.push("download");
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    },
  });
  const q = s.engine.quote(s.p.id, {
    kind: "image",
    prompt: "character",
    model: "seedream_v5",
    size: "2K",
    count: 2,
  });
  s.engine.approve(q.id, true);
  for (let i = 0; i < 100 && count < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["POST", "GET", "download", "POST"]);
  const jobs = s.store.project(s.p.id).jobs;
  assert.equal(jobs[0].status, "success");
  assert.equal(jobs[1].status, "running");
});

test("failed image result stops remaining approved candidates without another paid POST", async () => {
  let posts = 0;
  const s = await setup({
    submit: async () => {
      posts++;
      return { task_id: "task_image_failure" };
    },
    task: async () => ({ status: "banned", error_code: 1007 }),
  });
  s.engine.approve(
    s.engine.quote(s.p.id, {
      kind: "image",
      prompt: "character",
      model: "seedream_v5",
      size: "2K",
      count: 3,
    }).id,
    true,
  );
  for (
    let i = 0;
    i < 100 &&
    s.store
      .project(s.p.id)
      .jobs.some((j) => ["queued", "submitting", "running"].includes(j.status));
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(posts, 1);
  assert.deepEqual(
    s.store.project(s.p.id).jobs.map((j) => j.status),
    ["failed", "cancelled_local", "cancelled_local"],
  );
});

test("unsupported native input and P-series options are rejected before approval", async () => {
  const s = await setup();
  const source = { ...p2, sourceId: s.images[0].id };
  assert.throws(
    () =>
      s.engine.quote(s.p.id, { ...source, model: "P1-20260311", quad: true }),
    /P1/,
  );
  assert.throws(
    () =>
      s.engine.quote(s.p.id, {
        ...source,
        model: "v3.1-20260211",
        exportUv: false,
      }),
    /P-series/,
  );
  await submit(s, { ...source, model: "P1-20260311", quad: false });
  assert(!("quad" in s.calls[0].body));
  const p = s.store.project(s.p.id),
    a = p.assets.find((a) => a.id === s.model.id)!;
  a.nativeFile = "assets/output.zip";
  s.store.write(p.id, a.nativeFile, "zip");
  s.store.save(p);
  assert.throws(
    () =>
      s.engine.quote(p.id, {
        kind: "texture",
        sourceId: a.id,
        prompt: "",
        model: "v3.5-20260815",
        count: 1,
      }),
    /GLB\/FBX/,
  );
});

test("native export formats are retained as native assets, not renamed to GLB", async () => {
  const s = await setup({
    task: async () => ({
      status: "success",
      output: { model_url: "https://cdn.tripo3d.ai/export.obj" },
      credits_consumed: 10,
    }),
    download: async () => Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3"),
  });
  const job = await submit(s, {
    kind: "convert",
    sourceId: s.model.id,
    prompt: "",
    model: "",
    format: "OBJ",
    count: 1,
  });
  await s.engine.poll(s.p.id, job.id);
  const a = s.store.project(s.p.id).assets.find((a) => a.jobId === job.id)!;
  assert.equal(a.format, "obj");
  assert.match(a.file, /\.obj$/);
  assert.equal(a.nativeFile, a.file);
  assert.throws(
    () =>
      s.engine.reconcile(
        s.p.id,
        job.id,
        "f78371bc-abcd-4321-8123-123456789abc",
      ),
    /교체/,
  );
  assert.equal(s.store.project(s.p.id).jobs[0].remoteId, job.remoteId);
});

test("approval quotes expose effective processing defaults and every multiview or texture reference", async () => {
  const s = await setup();
  const multi = s.engine.quote(s.p.id, {
    ...p2,
    inputMode: "multiview",
    sourceIds: [s.images[0].id, "", s.images[2].id, ""],
  });
  assert.match(multi.inputSummary, /정면: front/);
  assert.match(multi.inputSummary, /뒷면: back/);
  assert.equal(multi.request.texture, true);
  assert.equal(multi.request.pbr, true);
  assert.equal(multi.request.textureQuality, "standard");
  assert.equal(multi.request.textureVersion, "v3.0-20250812");
  assert.equal(multi.request.quad, false);
  const texture = s.engine.quote(s.p.id, {
    kind: "texture",
    model: "v3.5-20260815",
    sourceId: s.model.id,
    sourceIds: [s.images[0].id],
    prompt: "",
    count: 1,
  });
  assert.match(texture.inputSummary, /source-model/);
  assert.match(texture.inputSummary, /텍스처 참조: front/);
  const convert = s.engine.quote(s.p.id, {
    kind: "convert",
    model: "",
    sourceId: s.model.id,
    prompt: "",
    count: 1,
  });
  assert.equal(convert.request.format, "GLTF");
  assert.equal(convert.request.bake, true);
  assert.equal(convert.request.textureSize, 2048);
  const project = s.store.project(s.p.id);
  project.jobs.push({
    id: "rigged",
    quoteId: "old",
    kind: "rig",
    status: "success",
    progress: 100,
    remoteId: "task_rigged",
    request: {
      kind: "rig",
      model: "v1.0-20240301",
      sourceId: s.model.id,
      prompt: "",
      count: 1,
    },
    createdAt: "test",
    revision: project.revision,
    assetId: s.model.id,
  });
  s.store.save(project);
  const animate = s.engine.quote(s.p.id, {
    kind: "animate",
    model: "v1.0-20240301",
    sourceTaskId: "task_rigged",
    animation: "preset:biped:walk",
    prompt: "",
    count: 1,
  });
  assert.match(animate.inputSummary, /task_rigged/);
  assert.match(animate.inputSummary, /source-model/);
});

test("CDN error documents cannot become successful binary assets through a filename extension", async () => {
  for (const [suffix, body, image] of [
    [".bin", "<!doctype html><title>Expired URL</title>", false],
    [".glb", "<!doctype html><title>Expired URL</title>", false],
    [".fbx", "<html>Storage error</html>", false],
    [".png", '{"error":"AccessDenied"}', true],
    [".jpeg", '{"error":"AccessDenied"}', true],
    [".webp", '{"error":"AccessDenied"}', true],
  ] as const) {
    const url = `https://cdn.tripo3d.ai/error${suffix}`;
    const s = await setup({
      task: async () => ({
        status: "success",
        output: image ? { generated_image_url: url } : { model_url: url },
        credits_consumed: 17,
      }),
      download: async () => Buffer.from(body),
    });
    const request: Generation = image
      ? {
          kind: "image",
          model: "seedream_v5",
          size: "2K",
          prompt: "character",
          count: 1,
        }
      : { ...p2, sourceId: s.images[0].id };
    const job = await submit(s, request);
    await assert.rejects(() => s.engine.poll(s.p.id, job.id), /파일 형식/);
    const current = s.store.project(s.p.id),
      live = current.jobs.find((j) => j.id === job.id)!;
    assert.equal(live.status, "running", suffix);
    assert.equal(live.remoteId, job.remoteId, suffix);
    assert.equal(live.credits, 17, suffix);
    assert.equal(live.assetId, undefined, suffix);
    assert.equal(
      current.assets.filter((a) => a.jobId === job.id).length,
      0,
      suffix,
    );
    assert.equal(
      s.calls.length,
      1,
      "failed download validation never resubmits a paid task",
    );
  }
});

test("ASCII FBX with leading whitespace is recognized and preserved for preview conversion", async () => {
  let store!: Store;
  const native = Buffer.from(
    "\n  ; FBX 7.4.0 project file\nFBXHeaderExtension: { }",
  );
  const s = await setup(
    {
      task: async () => ({
        status: "success",
        output: { model_url: "https://cdn.tripo3d.ai/result.bin" },
      }),
      download: async () => native,
    },
    async (id, file) => {
      assert.match(file, /\.fbx$/);
      assert.deepEqual(fs.readFileSync(store.file(id, file)), native);
      store.write(id, "assets/ascii-preview.glb", glb);
      return "assets/ascii-preview.glb";
    },
  );
  store = s.store;
  const job = await submit(s, { ...p2, sourceId: s.images[0].id, quad: true });
  await s.engine.poll(s.p.id, job.id);
  assert.equal(s.store.project(s.p.id).jobs[0].status, "success");
});
