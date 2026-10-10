import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { WorkbenchEngine } from "../engine/workbench";

test("external concept freezes scope, reserves once, validates receipt and waits for selection", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-external-"));
  const store = new Store(root);
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  let calls = 0;
  const executor = {execute: async () => { calls++; throw new Error("must not start worker"); }};
  const engine = new WorkbenchEngine(store, executor);
  t.after(() => { engine.shutdown(); store.db.close(); fs.rmSync(root, {recursive:true,force:true}); });
  const p = new Engine(store, {} as any).create("Synthetic external receipt test");
  const request = {step:"concept" as const, provider:"gpt" as const, executionMode:"codex-session" as const,
    prompt:"Two synthetic test candidates",generationCount:2};
  const approval = {accepted:true,studioCreditLimit:0,imageCreditLimit:0};
  let w = engine.action(p.id, {kind:"execute",request,approval});
  const j = w.jobs[0], requestHash = j.externalExecution!.requestHash;
  assert.equal(j.status,"needs_input");
  assert.equal(w.activeJobId,undefined);
  assert.equal(calls,0);
  assert.throws(() => engine.action(p.id,{kind:"execute",request,approval}), /외부 실행/);
  assert.throws(() => engine.action(p.id,{kind:"external-reserve",jobId:j.id,requestHash:"wrong"}), /명세/);
  engine.action(p.id,{kind:"external-reserve",jobId:j.id,requestHash});
  assert.throws(() => engine.action(p.id,{kind:"external-reserve",jobId:j.id,requestHash}), /명세/);
  assert.throws(() => engine.action(p.id,{kind:"retry",jobId:j.id}), /재시도하지/);
  const restored = new WorkbenchEngine(store,executor);
  assert.equal(restored.getForProject(p.id)!.jobs[0].externalExecution!.state,"reserved");
  assert.equal(calls,0);
  const workspace = store.file(p.id,`workbench/${w.id}/jobs/${j.id}`);
  // Synthetic PNG fixtures test the host contract only, never production quality.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64");
  const files = [0,1].map(i => {
    const name = `${i}.png`, bytes = Buffer.concat([png,Buffer.from(`fixture-${i}`)]);
    fs.writeFileSync(path.join(workspace,name),bytes);
    return {path:name,sha256:createHash("sha256").update(bytes).digest("hex")};
  });
  const receipt = {jobId:j.id,requestHash,conversationUrl:"https://chatgpt.com/c/test-conversation",files,
    result:{status:"completed",summary:"Synthetic receipt validation",checks:[],
      candidates:files.map((f,i)=>({id:`test-${i}`,label:`Synthetic ${i}`,artifacts:[{path:f.path,kind:"image"}]}))}};
  const save = () => fs.writeFileSync(path.join(workspace,"external-result.json"),JSON.stringify(receipt));
  receipt.jobId="wrong"; save();
  assert.throws(()=>restored.action(p.id,{kind:"external-receive",jobId:j.id}),/일치하지/);
  receipt.jobId=j.id;
  const originalHash=files[0].sha256;files[0].sha256="bad";save();
  assert.throws(()=>restored.action(p.id,{kind:"external-receive",jobId:j.id}),/해시/);
  files[0].sha256=originalHash;save();
  w=restored.action(p.id,{kind:"external-receive",jobId:j.id});
  assert.equal(w.jobs[0].status,"review");
  assert.equal(w.jobs[0].candidates.length,2);
  assert.equal(w.selections.concept,undefined);
  assert.equal(calls,0);
  assert.throws(()=>restored.action(p.id,{kind:"external-receive",jobId:j.id}),/기다리는/);
  restored.action(p.id,{kind:"select",jobId:j.id,candidateId:"test-1"});
  assert.equal(restored.getForProject(p.id)!.selections.concept.candidateId,"test-1");
  const turnaroundRequest = {...request,conceptMode:"turnaround" as const,generationCount:1};
  const viewsJob = restored.action(p.id,{kind:"execute",request:turnaroundRequest,approval}).jobs[0];
  assert.equal(viewsJob.slot,"whole-reference");
  assert.equal(viewsJob.dependencies.concept.candidateId,"test-1");
  assert.deepEqual(viewsJob.request.views,["front","back","left","right"]);
  restored.action(p.id,{kind:"external-reserve",jobId:viewsJob.id,requestHash:viewsJob.externalExecution!.requestHash});
  assert.throws(()=>restored.action(p.id,{kind:"select",jobId:j.id,candidateId:"test-0"}),/제출된 작업/);
  const viewsWorkspace=store.file(p.id,`workbench/${w.id}/jobs/${viewsJob.id}`);
  const viewFiles=["front","back","left","right"].map(view=>{
    const bytes=Buffer.concat([png,Buffer.from(`synthetic-${view}`)]),name=`${view}.png`;
    fs.writeFileSync(path.join(viewsWorkspace,name),bytes);
    return {path:name,sha256:createHash("sha256").update(bytes).digest("hex")};
  });
  const viewsReceipt={jobId:viewsJob.id,requestHash:viewsJob.externalExecution!.requestHash,
    conversationUrl:receipt.conversationUrl,files:viewFiles,
    result:{status:"completed",summary:"Synthetic whole views",checks:[],candidates:[{id:"views",label:"Four views",
      artifacts:viewFiles.map(f=>({path:f.path,kind:"image",role:"whole",view:f.path.replace(".png","")}))}]}};
  viewsReceipt.result.candidates[0].artifacts[3].view="left";
  const saveViews=()=>fs.writeFileSync(path.join(viewsWorkspace,"external-result.json"),JSON.stringify(viewsReceipt));
  saveViews();
  assert.throws(()=>restored.action(p.id,{kind:"external-receive",jobId:viewsJob.id}),/독립 이미지/);
  viewsReceipt.result.candidates[0].artifacts[3].view="right";saveViews();
  restored.action(p.id,{kind:"external-receive",jobId:viewsJob.id});
  assert.equal(restored.getForProject(p.id)!.selections["whole-reference"],undefined);
  restored.action(p.id,{kind:"select",jobId:viewsJob.id,candidateId:"views"});
  assert.equal(restored.getForProject(p.id)!.selections.concept.candidateId,"test-1");
  restored.action(p.id,{kind:"select",jobId:j.id,candidateId:"test-0"});
  assert.equal(restored.getForProject(p.id)!.selections["whole-reference"],undefined);
  let next=restored.action(p.id,{kind:"execute",request,approval}).jobs[0];
  restored.action(p.id,{kind:"external-cancel",jobId:next.id});
  assert.throws(()=>restored.action(p.id,{kind:"external-reserve",jobId:next.id,requestHash:next.externalExecution!.requestHash}),/명세/);
  next=restored.action(p.id,{kind:"execute",request,approval}).jobs[0];
  restored.action(p.id,{kind:"external-reserve",jobId:next.id,requestHash:next.externalExecution!.requestHash});
  restored.action(p.id,{kind:"external-cancel",jobId:next.id});
  assert.throws(()=>restored.action(p.id,{kind:"execute",request,approval}),/외부 실행/);
  assert.throws(()=>restored.action(p.id,{kind:"external-receive",jobId:next.id}),/기다리는/);
  assert.equal(calls,0);
});
