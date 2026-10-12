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

test("transport loss collects completed receipts locally; otherwise bounded retries are collection-only",async t=>{
 for(const mode of ["saved","transient","denied","cancelled"] as const){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"app-recovery-")),store=new Store(root);await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  let calls=0;const recoveries:any[]=[];
  const runner:ExternalWorkbenchRunner={async run(ctx){
    calls++;recoveries.push(ctx.recovery);
    ctx.onUsage?.({total:{inputTokens:100,cachedInputTokens:80,outputTokens:5,totalTokens:105}});
    if(mode==="saved"){
      const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64");
      fs.writeFileSync(path.join(ctx.workspace,"image.png"),bytes);
      fs.writeFileSync(path.join(ctx.workspace,"external-result.json"),JSON.stringify({jobId:ctx.job.id,requestHash:ctx.job.externalExecution!.requestHash,
        conversationUrl:"https://chatgpt.com/c/test",files:[{path:"image.png",sha256:createHash("sha256").update(bytes).digest("hex")}],
        result:{status:"completed",summary:"Saved",checks:[],candidates:[{id:"one",label:"one",artifacts:[{path:"image.png",kind:"image"}]}]}}));
    }
    if(mode==="cancelled")await new Promise(r=>setTimeout(r,20));
    throw Error(mode==="denied"?"approval denied; websocket closed":"stream disconnected before completion: websocket closed");
  },verifyReceipt(){}};
  const engine=new WorkbenchEngine(store,{execute:async()=>{throw Error("unused");}},{externalRunner:runner,recoveryDelaysMs:[1,1,1]});
  t.after(()=>{engine.shutdown();store.db.close();fs.rmSync(root,{recursive:true,force:true});});
  const p=new Engine(store,{} as any).create("Recovery fixture");
  const w=engine.action(p.id,{kind:"execute",request:{step:"concept",provider:"gpt",prompt:"one",generationCount:1,executionMode:"codex-app"},approval:{accepted:true,studioCreditLimit:0,imageCreditLimit:0}});
  if(mode==="cancelled"){await new Promise(r=>setImmediate(r));engine.action(p.id,{kind:"cancel"});}
  await engine.wait(w.id);const got=engine.get(w.id);
  assert.equal(calls,mode==="transient"?3:1,mode);assert(!got.activeJobId);
  assert.equal(got.jobs[0].status,mode==="saved"?"review":mode==="cancelled"?"submission_unknown":"needs_input",got.jobs[0].summary);
  if(mode==="transient"){assert(recoveries.slice(1).every(r=>r.mode==="retry"));assert.equal(got.jobs[0].externalExecution!.workerHistory!.length,2);}
  assert.deepEqual(got.selections,{});
  assert.equal((got.jobs[0].externalExecution!.worker!.usage as any).total.totalTokens,105);
  for(const old of got.jobs[0].externalExecution!.workerHistory??[])assert.equal((old!.usage as any).total.totalTokens,105);
 }
});

test("explicit continuation preserves attempt history and frozen reservation without granting automatic retries",async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"partsmith-continuation-")),store=new Store(root);
 await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));let calls=0;
 const runner:ExternalWorkbenchRunner={async run(){calls++;return {status:"needs_input",summary:"Synthetic stopped",threadId:`test-${calls}`};},verifyReceipt(){throw Error("unused");}};
 const engine=new WorkbenchEngine(store,{execute:async()=>{throw Error("unused");}},{externalRunner:runner});
 t.after(()=>{engine.shutdown();store.db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new Engine(store,{} as any).create("Explicit continuation test");
 const w=engine.action(p.id,{kind:"execute",request:{step:"concept",provider:"gpt",prompt:"one",generationCount:1,executionMode:"codex-app"},approval:{accepted:true,studioCreditLimit:0,imageCreditLimit:0}}),id=w.jobs[0].id;
 await engine.wait(w.id);
 for(let n=0;n<2;n++){engine.action(p.id,{kind:"external-run",jobId:id});await engine.wait(w.id);}
 const previous=engine.get(w.id).jobs[0].externalExecution!;
 assert.equal(previous.worker!.attempt,3);
 assert.throws(()=>engine.action(p.id,{kind:"external-run",jobId:id,reply:"retry"}),/3회/);
 assert.throws(()=>engine.action(p.id,{kind:"external-run",jobId:id,continueOnce:true,reply:" "}),/3회/);
 engine.action(p.id,{kind:"external-run",jobId:id,continueOnce:true,reply:"Export collection fixed. Reuse completed UV."});await engine.wait(w.id);
 const current=engine.get(w.id).jobs[0].externalExecution!;
 assert.equal(calls,4);assert.equal(current.worker!.attempt,4);
 assert.equal(current.reservedAt,previous.reservedAt);assert.equal(current.requestHash,previous.requestHash);
 assert.equal(current.workerHistory!.length,3);assert.equal(current.workerHistory![2]!.threadId,"test-3");
 assert.equal(current.continuations![0].afterAttempt,3);
 assert.throws(()=>engine.action(p.id,{kind:"external-run",jobId:id}),/3회/);
  runner.run=async ctx=>{calls++;assert.equal(ctx.recovery?.mode,"retry");return {status:"needs_input",summary:"Explicit collection only"};};
  engine.action(p.id,{kind:"external-recover",jobId:id});await engine.wait(w.id);
  assert.equal(calls,5);assert.equal(engine.get(w.id).jobs[0].externalExecution!.worker!.attempt,5);
});

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


test("app single-image P2 model freezes only the adopted original and defers cost approval",async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"single-model-")),store=new Store(root);await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
 let modelPacket:any;let modelInputs:any[]=[];
 const runner:ExternalWorkbenchRunner={async run(ctx){
  if(ctx.job.step==="model"){modelPacket=JSON.parse(fs.readFileSync(path.join(ctx.workspace,"external-request.json"),"utf8"));modelInputs=ctx.inputs;return {status:"needs_input",summary:"Cost preview stub"};}
  const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64");fs.writeFileSync(path.join(ctx.workspace,"one.png"),bytes);
  fs.writeFileSync(path.join(ctx.workspace,"external-result.json"),JSON.stringify({jobId:ctx.job.id,requestHash:ctx.job.externalExecution!.requestHash,conversationUrl:"https://chatgpt.com/c/fixture",files:[{path:"one.png",sha256:createHash("sha256").update(bytes).digest("hex")}],result:{status:"completed",summary:"fixture",checks:[],candidates:[{id:"one",label:"one",artifacts:[{path:"one.png",kind:"image"}]}]}}));return {status:"completed",summary:"fixture"};},verifyReceipt(){}};
 const e=new WorkbenchEngine(store,{execute:async()=>{throw Error("unused");}},{externalRunner:runner});t.after(()=>{e.shutdown();store.db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new Engine(store,{} as any).create("Single image fixture"),approval={accepted:true,studioCreditLimit:0,imageCreditLimit:0};
 const w=e.action(p.id,{kind:"execute",request:{step:"concept",prompt:"one",provider:"gpt",generationCount:1,executionMode:"codex-app"},approval});await e.wait(w.id);
 const design=e.get(w.id).jobs[0];e.action(p.id,{kind:"select",jobId:design.id,candidateId:"one"});
 e.action(p.id,{kind:"execute",request:{step:"model",prompt:"",modelInput:"whole",role:"whole",generationCount:1,polygonCount:10000,executionMode:"codex-app",externalModel:{model:"P2.0",topology:"quad",inputMode:"single",costApproval:"in-app",observedCreditCost:0}},approval});await e.wait(w.id);
 assert.equal(modelInputs.length,1);assert.equal(modelInputs[0].sha256,design.candidates[0].artifacts[0].sha256);assert.deepEqual(Object.keys(modelPacket.dependencies),["concept"]);assert.equal(modelPacket.approval.studioCreditLimit,0);assert.equal(e.get(w.id).selections["model:whole"],undefined);
});
