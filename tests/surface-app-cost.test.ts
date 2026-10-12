import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChromeJobLedger,
  type ChromePacket,
  type SurfacePlan,
} from "../engine/chrome-job-ledger";
import { validateUnityPlayback } from "../engine/workbench-unity";
const id = "11111111-1111-1111-1111-111111111111",
  url = `https://studio.tripo3d.ai/ko/workspace/smart-uv/rabbit-${id}`;
test("surface actual-cost approval is separate per phase, immutable and cannot bypass or replay UV", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "surface-cost-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packet: ChromePacket = {
    jobId: "surface",
    request: {
      step: "surface",
      prompt: "",
      modelInput: "whole",
      executionMode: "codex-app",
      externalSurface: {
        observedUvCost: 0,
        observedTextureCost: 0,
        textureResolution: "4K",
        removeLighting: false,
        costApproval: "in-app",
      },
    },
    approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 },
    sourceStudioModel: { modelId: id, url },
  };
  const file = path.join(root, "journal.json"),
    ledger = new ChromeJobLedger(file, packet, "hash");
  const uv: SurfacePlan = {
    phase: "uv",
    sourceModelId: id,
    observedCost: 20,
    url,
    textureResolution: "4K",
    removeLighting: false,
  };
  assert.throws(() => ledger.begin(uv), /먼저 승인/);
  await assert.rejects(
    ledger.approveSurface(
      uv,
      async () => false,
      () => false,
    ),
    /승인하지/,
  );
  assert.equal(ledger.read().entries.length, 0);
  await assert.rejects(
    ledger.approveSurface(
      { ...uv, textureResolution: "2K" },
      async () => true,
      () => false,
    ),
    /설정/,
  );
  let approve!: (v: boolean) => void;
  const pending = ledger.approveSurface(
    uv,
    async () => new Promise((r) => (approve = r)),
    () => false,
  );
  await assert.rejects(
    ledger.approveSurface(
      uv,
      async () => true,
      () => false,
    ),
    /설정/,
  );
  assert.equal(ledger.read().entries.length, 0);
  approve(true);
  await pending;
  assert.equal(ledger.read().entries[0].cost, 20);
  await assert.rejects(
    ledger.approveSurface(
      uv,
      async () => true,
      () => false,
    ),
  );
  const texture = {
    ...uv,
    phase: "texture" as const,
    url: url.replace("smart-uv", "texture"),
  };
  await assert.rejects(
    ledger.approveSurface(
      texture,
      async () => true,
      () => false,
    ),
  );
  ledger.complete({ phase: "uv", resultId: id, url });
  await assert.rejects(
    ledger.approveSurface(
      texture,
      async () => true,
      () => true,
    ),
  );
  assert.equal(ledger.read().entries.length, 1);
  const restarted = new ChromeJobLedger(file, packet, "hash");
  await restarted.approveSurface(
    texture,
    async () => true,
    () => false,
  );
  assert.equal(restarted.read().entries.length, 2);
  assert.equal(
    restarted.read().entries.reduce((n, e) => n + e.cost, 0),
    40,
  );
});
test("Generic needs actual clip playback and bone motion; Human Avatar alone is not completion", () => {
  const request = {
    requestId: "job",
    revision: 0,
    rigType: "generic",
    expectedClips: [{ name: "Idle" }, { name: "Jump" }],
  };
  const report = {
    requestId: "job",
    revision: 0,
    rigType: "generic",
    avatarValid: true,
    avatarHuman: false,
    runtimePlayModeVerified: true,
    clips: ["Idle", "Jump"],
    runtimeClips: ["Idle", "Jump"],
    runtimeMovingClips: ["Idle", "Jump"],
    errors: [],
  };
  validateUnityPlayback(report, request);
  assert.throws(() =>
    validateUnityPlayback(
      { ...report, runtimePlayModeVerified: false },
      request,
    ),
  );
  assert.throws(
    () =>
      validateUnityPlayback(
        { ...report, runtimeMovingClips: ["Idle"] },
        request,
      ),
    /Jump/,
  );
  assert.throws(() =>
    validateUnityPlayback(
      { ...report, rigType: "humanoid" },
      { ...request, rigType: "humanoid" },
    ),
  );
  assert.throws(() =>
    validateUnityPlayback({ ...report, requestId: "other" }, request),
  );
});
