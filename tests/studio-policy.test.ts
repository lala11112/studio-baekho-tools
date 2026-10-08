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
