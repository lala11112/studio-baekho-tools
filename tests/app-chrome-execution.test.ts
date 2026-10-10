import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { WorkbenchEngine } from "../engine/workbench";
import type { ExternalWorkbenchRunner } from "../shared/workbench";

test("app dispatch returns questions, collects validated files and never advances or resumes automatically", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-app-chrome-"));
  const store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  let calls = 0,
    verifies = 0;
  const runner: ExternalWorkbenchRunner = {
    async run(ctx, progress) {
      calls++;
      progress("Synthetic browser test only");
      if (calls === 1)
        return {
          status: "needs_input",
          summary: "Synthetic question",
          question: "테스트 확인 답변",
        };
      assert.equal(ctx.reply, "확인");
      const permission = await ctx.requestApproval!({
        id: "synthetic-approval",
        title: "Synthetic Tripo permission",
        detail: "No real browser call",
        fields: [],
      });
      assert.equal(permission.accepted, true);
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      fs.writeFileSync(path.join(ctx.workspace, "image.png"), bytes);
      fs.writeFileSync(
        path.join(ctx.workspace, "external-result.json"),
        JSON.stringify({
          jobId: ctx.job.id,
          requestHash: ctx.job.externalExecution!.requestHash,
          conversationUrl: "https://chatgpt.com/c/synthetic",
          files: [
            {
              path: "image.png",
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
          result: {
            status: "completed",
            summary: "Synthetic result",
            checks: [],
            candidates: [
              {
                id: "one",
                label: "Synthetic image",
                artifacts: [{ path: "image.png", kind: "image" }],
              },
            ],
          },
        }),
      );
      return { status: "completed", summary: "Synthetic done" };
    },
    verifyReceipt() {
      verifies++;
    },
  };
  const legacy = {
    execute: async () => {
      throw Error("legacy worker must not run");
    },
  };
  const engine = new WorkbenchEngine(store, legacy, { externalRunner: runner });
  t.after(() => {
    engine.shutdown();
    store.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const p = new Engine(store, {} as any).create("Synthetic Chrome dispatch");
  const request = {
    step: "concept" as const,
    provider: "gpt" as const,
    prompt: "one image",
    generationCount: 1,
    executionMode: "codex-app" as const,
  };
  let w = engine.action(p.id, {
    kind: "execute",
    request,
    approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 },
  });
  const id = w.jobs[0].id;
  assert.equal(w.jobs[0].status, "running");
  assert.throws(
    () => engine.action(p.id, { kind: "external-run", jobId: id }),
    /진행|실행|작업/,
  );
  await engine.wait(w.id);
  w = engine.get(w.id);
  assert.equal(
    w.jobs[0].externalExecution!.worker!.question,
    "테스트 확인 답변",
  );
  assert.equal(calls, 1);
  const restarted = new WorkbenchEngine(store, legacy, {
    externalRunner: runner,
  });
  assert.equal(calls, 1);
  assert.equal(restarted.get(w.id).jobs[0].status, "needs_input");
  engine.action(p.id, { kind: "external-run", jobId: id, reply: "확인" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    engine.get(w.id).jobs[0].externalExecution!.worker!.approval!.id,
    "synthetic-approval",
  );
  assert.throws(
    () =>
      engine.action(p.id, {
        kind: "external-approval",
        jobId: id,
        approvalId: "stale",
        answer: { accepted: true, values: {} },
      }),
    /이미 끝났/,
  );
  engine.action(p.id, {
    kind: "external-approval",
    jobId: id,
    approvalId: "synthetic-approval",
    answer: { accepted: true, values: {} },
  });
  assert.throws(
    () =>
      engine.action(p.id, {
        kind: "external-approval",
        jobId: id,
        approvalId: "synthetic-approval",
        answer: { accepted: true, values: {} },
      }),
    /이미 끝났/,
  );
  await engine.wait(w.id);
  w = engine.get(w.id);
  assert.equal(w.jobs[0].status, "review");
  assert.equal(w.jobs[0].externalExecution!.worker!.approval, undefined);
  assert.equal(w.jobs[0].externalExecution!.state, "received");
  assert.equal(w.selections.concept, undefined);
  assert.equal(w.jobs.length, 1);
  assert.equal(verifies, 1);
  assert.throws(
    () => engine.action(p.id, { kind: "external-run", jobId: id }),
    /외부 작업/,
  );
});

test("cancel and restart ignore late Chrome completion and never launch a new worker", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-app-cancel-"));
  const store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  let finish!: (value: any) => void,
    calls = 0;
  const runner: ExternalWorkbenchRunner = {
    run: () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    verifyReceipt: () => {
      throw Error("must not accept cancelled result");
    },
  };
  const legacy = {
    execute: async () => {
      throw Error("unused");
    },
  };
  const engine = new WorkbenchEngine(store, legacy, { externalRunner: runner });
  t.after(() => {
    engine.shutdown();
    store.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const p = new Engine(store, {} as any).create("Synthetic cancellation");
  const w = engine.action(p.id, {
    kind: "execute",
    request: {
      step: "concept",
      provider: "gpt",
      prompt: "one",
      generationCount: 1,
      executionMode: "codex-app",
    },
    approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 },
  });
  await Promise.resolve();
  engine.action(p.id, { kind: "cancel" });
  finish({ status: "completed", summary: "Late completion" });
  await engine.wait(w.id);
  const restarted = new WorkbenchEngine(store, legacy, {
    externalRunner: runner,
  });
  assert.equal(calls, 1);
  assert.equal(restarted.get(w.id).jobs[0].status, "submission_unknown");
  assert.equal(
    restarted.get(w.id).jobs[0].externalExecution!.state,
    "reserved",
  );
});
