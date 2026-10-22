/** Synthetic textured files, real Blender; no service or paid operation. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  ChromeJobLedger,
  type ChromePacket,
} from "../engine/chrome-job-ledger";
import { NativeDownloadCollector } from "../engine/native-download";
import { collectSurfaceResult } from "../engine/chrome-surface-result";
const fixture = fs
  .readFileSync("artifacts/runtime/native-fixture-path.txt", "utf8")
  .trim();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-surface-")),
  workspace = path.join(root, "job"),
  downloads = path.join(root, "downloads");
fs.mkdirSync(workspace);
fs.mkdirSync(downloads);
const id = "11111111-1111-1111-1111-111111111111",
  url = `https://studio.tripo3d.ai/ko/workspace/generate/test-${id}`;
const packet: ChromePacket = {
  jobId: "fixture",
  request: {
    step: "surface",
    prompt: "fixture",
    executionMode: "codex-app",
    externalSurface: {
      observedUvCost: 0,
      observedTextureCost: 0,
      textureResolution: "4K",
      removeLighting: false,
      costApproval: "in-app",
    },
  },
  sourceStudioModel: { modelId: id, url },
  approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 },
};
const ledger = new ChromeJobLedger(
    path.join(root, "journal.json"),
    packet,
    "hash",
  ),
  collector = new NativeDownloadCollector(
    downloads,
    workspace,
    "model",
    path.join(root, "downloads.json"),
  );
const options = {
  workspace,
  packet,
  requestHash: "hash",
  ledger,
  downloads: collector,
  cacheFile: path.join(root, "cache.json"),
  blender: "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe",
  script: path.resolve("integrations/blender/native_model_preview.py"),
  signal: new AbortController().signal,
};
for (const phase of ["uv", "texture"] as const) {
  await ledger.approveSurface(
    {
      phase,
      sourceModelId: id,
      url,
      observedCost: 20,
      textureResolution: "4K",
      removeLighting: false,
    },
    async () => true,
    () => false,
  );
  ledger.complete({ phase, resultId: id, url });
  const ticket = collector.prepare(phase, url);
  const name = phase === "uv" ? "uv.fbx" : "textured.zip";
  fs.copyFileSync(path.join(fixture, name), path.join(downloads, name));
  collector.collect(ticket.id);
  const result = await collectSurfaceResult(options);
  assert.equal(result?.status, phase === "uv" ? undefined : "completed");
}
ledger.recordSurfaceObservations(["Synthetic appearance warning retained"]);
await collectSurfaceResult({
  ...options,
  convert: async () => {
    throw Error("cache must prevent repeat conversion");
  },
});
const receipt = JSON.parse(
  fs.readFileSync(path.join(workspace, "external-result.json"), "utf8"),
);
assert(receipt.result.checks.some((c: any) => !c.passed));
assert(receipt.surface.texture.texturePaths.length > 0);
assert.notEqual(receipt.surface.texture.fbxPath, receipt.surface.uv.fbxPath);
fs.writeFileSync(
  "artifacts/runtime/surface-native-check.json",
  JSON.stringify(
    {
      synthetic: true,
      realBlender: true,
      uvCheckpoint: true,
      texture4K: true,
      cacheReuse: true,
      paidSubmissions: 0,
      workspace,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    synthetic: true,
    realBlender: true,
    texture4K: true,
    cacheReuse: true,
    workspace,
  }),
);
