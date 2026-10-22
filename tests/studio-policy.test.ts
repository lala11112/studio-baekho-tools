import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  StudioLedger,
  creditFromLabel,
  guardedPath,
  isStudioUrl,
  isLoginUrl,
  meshEditTerms,
  canvasPoints,
} from "../electron/studio-policy";

test("Studio routing rejects deceptive domains, credentials and protocols", () => {
  assert(isStudioUrl("https://studio.tripo3d.ai/workspace/generate"));
  assert(!isStudioUrl("https://studio.tripo3d.ai.attacker.test/"));
  assert(!isStudioUrl("https://key@studio.tripo3d.ai/"));
  assert(!isStudioUrl("http://studio.tripo3d.ai/"));
  assert(!isStudioUrl("javascript:alert(1)"));
  assert(isLoginUrl("https://accounts.google.com/"));
  assert(!isLoginUrl("https://accounts.google.com.attacker.test/"));
});
test("Only an unambiguous cost on the actual action label is accepted", () => {
  assert.equal(creditFromLabel("Generate100"), 100);
  assert.equal(creditFromLabel("생성 ⚡ 100"), 100);
  assert.equal(creditFromLabel("Generate 100 50"), undefined);
  assert.equal(creditFromLabel("100"), undefined);
  assert.equal(creditFromLabel("P2.0"), undefined);
  assert.equal(creditFromLabel("Export 5"), 5);
  assert.equal(creditFromLabel("Generate"), undefined);
  assert.equal(creditFromLabel("Retry Selection 3 edits remaining"), undefined);
  assert.equal(creditFromLabel("Regenerate 2 free retries left"), undefined);
  assert.equal(creditFromLabel("재생성 무료 3회"), undefined);
});

test("Mesh Edit accepts observed free uses or explicit paid edit price and never new Generate", () => {
  const text = "Edit Mesh 3 free edits remaining Retry Selection";
  assert.equal(
    meshEditTerms("Retry Selection", "3 free edits remaining", text).cost,
    0,
  );
  assert.equal(
    meshEditTerms(
      "Regenerate ⚡ 0",
      "Remaining edits: 2",
      "Edit Mesh Remaining edits: 2 Regenerate ⚡ 0",
    ).remaining,
    2,
  );
  assert.equal(
    meshEditTerms(
      "재생성",
      "남은 무료 수정 2회",
      "메시 편집 남은 무료 수정 2회 재생성",
    ).cost,
    0,
  );
  assert.equal(
    meshEditTerms(
      "Regenerate",
      "Unlimited free edits",
      "Edit Mesh Unlimited free edits Regenerate",
    ).cost,
    0,
  );
  assert.throws(
    () =>
      meshEditTerms(
        "Regenerate",
        "3 edits remaining",
        "Edit Mesh 3 edits remaining Regenerate",
      ),
    /not visible/,
  );
  assert.throws(
    () =>
      meshEditTerms(
        "Regenerate",
        "Unlimited edits",
        "Edit Mesh Unlimited edits Regenerate",
      ),
    /not visible/,
  );
  assert.throws(
    () => meshEditTerms("Generate 50 credits", "3 free edits remaining", text),
    /new Generate/,
  );
  assert.throws(
    () =>
      meshEditTerms(
        "Regenerate",
        "0 free edits remaining",
        "Edit Mesh 0 free edits remaining Regenerate",
      ),
    /exhausted/,
  );
  assert.throws(
    () =>
      meshEditTerms(
        "Regenerate",
        "Balance 250",
        "Edit Mesh Balance 250 Regenerate",
      ),
    /not visible/,
  );
  assert.throws(
    () =>
      meshEditTerms(
        "Regenerate",
        "3 free edits remaining",
        "3 free edits remaining",
      ),
    /Edit Mesh context/,
  );
  assert.throws(
    () =>
      meshEditTerms(
        "Regenerate",
        "3 free edits remaining",
        "Edit Mesh No quota shown",
      ),
    /Visible/,
  );
  assert.equal(
    meshEditTerms(
      "Regenerate ⚡ 50",
      "Regenerate ⚡ 50",
      "Edit Mesh 0 free edits remaining Regenerate ⚡ 50",
    ).cost,
    50,
  );
  assert.throws(
    () =>
      meshEditTerms(
        "Regenerate 50",
        "Regenerate 50",
        "Edit Mesh Regenerate 50",
      ),
    /not visible/,
  );
  assert.throws(
    () =>
      meshEditTerms(
        "Regenerate 50 credits · 3 free edits remaining",
        "3 free edits remaining",
        "Edit Mesh Regenerate 50 credits · 3 free edits remaining",
      ),
    /ambiguous/,
  );
});

test("Canvas drag paths are bounded normalized points, not arbitrary coordinates or payloads", () => {
  assert.deepEqual(
    canvasPoints([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]),
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
  );
  assert.throws(
    () =>
      canvasPoints([
        { x: -0.1, y: 0 },
        { x: 1, y: 1 },
      ]),
    /0–1/,
  );
  assert.throws(
    () =>
      canvasPoints([
        { x: 0, y: 0 },
        { x: NaN, y: 1 },
      ]),
    /0–1/,
  );
  assert.throws(() => canvasPoints([{ x: 0, y: 0 }]), /2–32/);
  assert.throws(
    () => canvasPoints(Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }))),
    /2–32/,
  );
});

test("Free Mesh Edit uses durable one-operation journal and cannot replay after restart or recovery", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-free-edit-"));
  const context = {
    runId: "free-edit",
    stageId: "model",
    rootDir,
    creditLimit: 0,
    maxAttempts: 1,
    modelEdit: { scope: "all" as const },
  };
  const first = new StudioLedger(rootDir, context);
  first.reserve(
    "free:1",
    0,
    "Retry Selection · 3 free edits remaining",
    "snap1",
  );
  first.clicked("free:1");
  const resumed = new StudioLedger(rootDir, context);
  assert.equal(resumed.summary().remaining, 0);
  assert.equal(resumed.summary().charges.length, 1);
  assert.throws(
    () => resumed.reserve("free:2", 0, "Retry Selection", "snap2"),
    /already submitted/,
  );
  const recovery = new StudioLedger(rootDir, {
    ...context,
    recoveryOnly: true,
  });
  assert.throws(
    () => recovery.reserve("free:2", 0, "Retry Selection", "snap2"),
    /자동 복구/,
  );
});
test("Host credit journal survives restart and rejects duplicate/ambiguous paid attempts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ledger-"));
  const context = {
    runId: "run-a",
    stageId: "body.generate",
    rootDir,
    creditLimit: 200,
    maxAttempts: 2,
    attempt: 1,
  };
  const first = new StudioLedger(rootDir, context);
  first.reserve("body:1", 100, "Generate100", "snapshot-1");
  const resumed = new StudioLedger(rootDir, context);
  assert.equal(resumed.summary().remaining, 100);
  assert.throws(
    () => resumed.reserve("body:1", 100, "Generate100", "snapshot-2"),
    /already reserved/,
  );
  assert.throws(
    () => resumed.reserve("body:other", 100, "Generate100", "snapshot-2"),
    /already submitted/,
  );
  const next = new StudioLedger(rootDir, {
    ...context,
    stageId: "head.generate",
  });
  assert.throws(
    () => next.reserve("head:1", 100, "Generate100", "snapshot-2"),
    /Prior submission/,
  );
  resumed.observe("body:1", "Visible task completed");
  assert.throws(
    () => resumed.reserve("body:other", 100, "Generate100", "snapshot-3"),
    /already submitted/,
  );
  const nextReady = new StudioLedger(rootDir, {
    ...context,
    stageId: "head.generate",
  });
  nextReady.reserve("head:1", 100, "Generate100", "snapshot-3");
  nextReady.observe("head:1", "Head completed");
  const overBudget = new StudioLedger(rootDir, {
    ...context,
    stageId: "hair.generate",
  });
  assert.throws(
    () => overBudget.reserve("hair:1", 1, "Generate1", "snapshot-4"),
    /credit limit/,
  );
  assert.throws(
    () => new StudioLedger(rootDir, { ...context, creditLimit: 201 }),
    /immutable/,
  );
  const overAttempts = new StudioLedger(rootDir, {
    ...context,
    stageId: "body.generate",
    attempt: 3,
  });
  assert.throws(
    () => overAttempts.reserve("body:3", 0, "Generate0", "snapshot-5"),
    /attempt limit/,
  );
});
test("Workspace file boundary rejects traversal and linked files outside run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-path-"));
  const workspace = path.join(root, "workspace"),
    outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.png"), "secret");
  fs.writeFileSync(path.join(workspace, "front.png"), "image");
  assert.equal(
    guardedPath(workspace, "front.png"),
    path.join(workspace, "front.png"),
  );
  assert.throws(
    () => guardedPath(workspace, "../outside/secret.png"),
    /escapes/,
  );
  fs.symlinkSync(outside, path.join(workspace, "linked"), "junction");
  assert.throws(() => guardedPath(workspace, "linked/secret.png"), /Invalid/);
  assert.throws(
    () => guardedPath(workspace, "linked/new.png", false),
    /outside/,
  );
});

test("recovery connection can read existing receipts but cannot reserve any new paid operation", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-recovery-"));
  const context = {
    runId: "recovery-test",
    stageId: "head-model",
    rootDir,
    creditLimit: 200,
    maxAttempts: 3,
    attempt: 1,
  };
  const initial = new StudioLedger(rootDir, context);
  initial.reserve("first", 100, "Generate100", "observed-1");
  initial.observe("first", "Existing result is ready");
  const recovering = new StudioLedger(rootDir, {
    ...context,
    stageId: "new-stage",
    attempt: 2,
    recoveryOnly: true,
  });
  assert.equal(recovering.summary().charges.length, 1);
  assert.equal(recovering.summary().remaining, 100);
  assert.throws(
    () => recovering.reserve("second", 100, "Generate100", "observed-2"),
    /자동 복구/,
  );
  assert.throws(
    () => recovering.reserve("zero-cost", 0, "Generate0", "observed-3"),
    /자동 복구/,
  );
  assert.equal(StudioLedger.readCharges(rootDir, context.runId).length, 1);
});
