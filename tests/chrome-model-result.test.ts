import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectModelResult } from "../engine/chrome-model-result";
import {
  ChromeJobLedger,
  type ChromePacket,
} from "../engine/chrome-job-ledger";
import { NativeDownloadCollector } from "../engine/native-download";
import { ChromeWorkbenchRunner } from "../electron/chrome-workbench-runner";
import { buildWorkbenchGlb } from "./fixtures/workbench-glb";
const id = "11111111-1111-1111-1111-111111111111",
  url = `https://studio.tripo3d.ai/ko/workspace/generate/rabbit-${id}`;
const bytes = Buffer.concat([
  Buffer.from("Kaydara FBX Binary  \x00\x1a\x00"),
  Buffer.alloc(40),
]);
async function fixture(t: any, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-host-")),
    workspace = path.join(root, "job"),
    downloadDir = path.join(root, "downloads");
  fs.mkdirSync(workspace);
  fs.mkdirSync(downloadDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packet: ChromePacket = {
    jobId: "model",
    request: {
      step: "model",
      prompt: "test",
      generationCount: count,
      polygonCount: 10000,
      externalModel: {
        model: "P2.0",
        topology: "quad",
        observedCreditCost: 100,
      },
    },
    approval: { accepted: true, studioCreditLimit: 100, imageCreditLimit: 0 },
  };
  const ledger = new ChromeJobLedger(
      path.join(root, "journal.json"),
      packet,
      "hash",
    ),
    downloads = new NativeDownloadCollector(
      downloadDir,
      workspace,
      "model",
      path.join(root, "downloads.json"),
    );
  const options = {
    workspace,
    packet,
    requestHash: "hash",
    ledger,
    downloads,
    cacheFile: path.join(root, "cache.json"),
    blender: "stub",
    script: "stub",
    signal: new AbortController().signal,
  };
  function collect(u = url) {
    const ticket = downloads.prepare("model", u);
    fs.writeFileSync(
      path.join(downloadDir, `new-${ticket.id}.fbx`),
      Buffer.concat([bytes, Buffer.from(u)]),
    );
    return downloads.collect(ticket.id);
  }
  function complete() {
    ledger.begin({ phase: "model", sourceModelId: "", observedCost: 100, url });
    ledger.complete({ phase: "model", resultId: id, url });
  }
  return {
    root,
    workspace,
    packet,
    ledger,
    downloads,
    options,
    collect,
    complete,
  };
}
const convert = async (
  _b: string,
  _s: string,
  source: string,
  output: string,
) => {
  fs.writeFileSync(path.join(output, "preview.glb"), buildWorkbenchGlb(31));
  fs.writeFileSync(
    path.join(output, "inspection.json"),
    JSON.stringify({
      vertices: 9844,
      faces: 10297,
      quads: 9038,
      triangles: 1259,
      uvLayers: 0,
      geometryEdited: false,
      nativeFbx: source,
      companions: [],
    }),
  );
};
test("host model finish reuses checkpoints, preserves originals and rejects tampered derivatives", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const options = {
    ...f.options,
    convert: async (...args: Parameters<typeof convert>) => {
      calls++;
      return convert(...args);
    },
  };
  assert.equal(await collectModelResult(options), null);
  assert.equal(calls, 0);
  f.complete();
  assert.equal(await collectModelResult(options), null);
  f.ledger.recordModelResult(id, url, ["꼬리 외형 사용자 확인 필요"]);
  assert.throws(
    () => f.ledger.recordModelResult(id, url.replace("generate/", "texture/")),
    /실제 모델/,
  );
  const original = f.collect() as any;
  const originalBytes = fs.readFileSync(path.join(f.workspace, original.path));
  await collectModelResult(options);
  await collectModelResult(options);
  assert.equal(calls, 1);
  assert.deepEqual(
    fs.readFileSync(path.join(f.workspace, original.path)),
    originalBytes,
  );
  const receipt = JSON.parse(
    fs.readFileSync(path.join(f.workspace, "external-result.json"), "utf8"),
  );
  assert.equal(receipt.studioModels[0].modelId, id);
  assert.equal(receipt.result.checks.filter((c: any) => !c.passed).length, 3);
  assert(
    receipt.result.checks.some((c: any) => c.detail.includes("꼬리 외형")),
  );
  fs.appendFileSync(
    path.join(
      f.workspace,
      receipt.files.find((p: any) => p.path.endsWith(".glb")).path,
    ),
    "tamper",
  );
  await assert.rejects(collectModelResult(options), /변경/);
  assert.equal(calls, 1);
});
test("batch finish waits for all recorded models and cancellation never runs conversion", async (t) => {
  const f = await fixture(t, 2);
  f.complete();
  f.collect();
  assert.equal(await collectModelResult({ ...f.options, convert }), null);
  const second = "22222222-2222-2222-2222-222222222222",
    secondUrl = url.replace(id, second);
  f.ledger.recordModelResult(second, secondUrl);
  f.collect(secondUrl);
  assert.throws(
    () =>
      f.ledger.recordModelResult(
        "33333333-3333-3333-3333-333333333333",
        url.replace(id, "33333333-3333-3333-3333-333333333333"),
      ),
    /개수/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collectModelResult({ ...f.options, signal: controller.signal, convert }),
  );
  assert(!fs.existsSync(path.join(f.workspace, "external-result.json")));
  await collectModelResult({ ...f.options, convert });
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(f.workspace, "external-result.json"), "utf8"),
    ).result.candidates.length,
    2,
  );
});
test("collected invalid native model fails locally before any app-server process starts", async (t) => {
  const f = await fixture(t);
  f.complete();
  f.collect();
  fs.writeFileSync(
    path.join(f.workspace, "external-request.json"),
    JSON.stringify(f.packet),
  );
  const journals = path.join(f.root, "journals", "bench");
  fs.mkdirSync(journals, { recursive: true });
  fs.copyFileSync(
    path.join(f.root, "journal.json"),
    path.join(journals, "model.json"),
  );
  fs.copyFileSync(
    path.join(f.root, "downloads.json"),
    path.join(journals, "model.downloads.json"),
  );
  const runner = new ChromeWorkbenchRunner({
    journalRoot: path.join(f.root, "journals"),
    downloadsPath: path.join(f.root, "downloads"),
    bridgePath: "NO_BRIDGE",
    projectRoot: () => f.root,
    blenderPath: () => "MISSING_BLENDER",
  });
  await assert.rejects(
    runner.run(
      {
        workspace: f.workspace,
        workbench: { id: "bench", projectId: "project" },
        job: {
          id: "model",
          step: "model",
          request: f.packet.request,
          externalExecution: { requestHash: "hash", worker: { attempt: 1 } },
        },
        inputs: [],
        signal: new AbortController().signal,
      } as any,
      () => {},
    ),
    /Blender 실행 파일/,
  );
  assert(!fs.existsSync(path.join(f.workspace, "app-worker-1")));
});
