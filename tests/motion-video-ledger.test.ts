import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MotionVideoLedger, type VideoPlan } from "../engine/motion-video-ledger";
import type { ChromePacket } from "../engine/chrome-job-ledger";

test("video submissions freeze cost/settings, require master motion, reject replay and verify native+decoded provenance", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packet: ChromePacket = { jobId: "test", request: { step: "reference", prompt: "test", duration: 2, motionVideo: { serviceUrl: "https://dreamina.capcut.com/", model: "TestModel" } }, approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 } };
  const file = path.join(dir, "host.json");
  let ledger = new MotionVideoLedger(file, packet, "frozen");
  const plan: VideoPlan = { phase: "front", observedCost: 10, model: "TestModel", duration: 5, resolution: "1080p", url: "https://dreamina.capcut.com/ai-tool", sourceModelId: "" };
  assert.throws(() => ledger.begin(plan));
  assert.throws(() => ledger.validatePlan({ ...plan, phase: "side" }));
  assert.throws(() => ledger.validatePlan({ ...plan, model: "CheaperModel" }));
  assert.throws(() => ledger.validatePlan({ ...plan, observedCost: -1 }));
  assert.throws(() => ledger.validatePlan({ ...plan, url: "https://wrong.example/" }));
  const videos = [], artifacts = [];
  for (const [index, phase] of ["front", "side", "back"].entries()) {
    ledger.reserveApproved({ ...plan, phase, sourceModelId: phase === "front" ? "" : "result-front" });
    ledger = new MotionVideoLedger(file, packet, "frozen");
    assert.throws(() => ledger.reserveApproved({ ...plan, phase }));
    const resultId = `result-${phase}`, url = `https://dreamina.capcut.com/result/${resultId}`;
    ledger.complete({ phase, resultId, url });
    const download = { path: `outputs/${phase}.mp4`, sha256: String(index + 1).repeat(64) };
    ledger.recordDownload(phase, download);
    videos.push({ view: phase, resultId, url, ...download });
    artifacts.push({ path: download.path, role: phase, kind: "video" });
  }
  const decoded = [{ path: "outputs/video-reference/frames.json", sha256: "a".repeat(64) }];
  const receipt = { videos, files: decoded, result: { candidates: [{ artifacts }] } };
  assert.throws(() => ledger.verify(receipt), /추출/);
  ledger.recordDecoded(decoded);
  ledger.verify(receipt);
  assert.throws(() => ledger.verify({ ...receipt, files: [] }), /추출/);
  assert.throws(() => ledger.verify({ ...receipt, result: { candidates: [{ artifacts: [] }] } }), /다운로드/);
  assert.throws(() => ledger.complete({ phase: "front", resultId: "other", url: "https://dreamina.capcut.com/result/other" }));
});
