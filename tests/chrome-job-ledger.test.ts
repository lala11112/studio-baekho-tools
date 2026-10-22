import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChromeJobLedger,
  type ChromePacket,
} from "../engine/chrome-job-ledger";

test("Chrome paid journal freezes phase, source and cost; recovery cannot resubmit", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "host.json"),
    source = "11111111-1111-1111-1111-111111111111",
    uv = "22222222-2222-2222-2222-222222222222",
    tex = "33333333-3333-3333-3333-333333333333";
  const url = (id: string) =>
    `https://studio.tripo3d.ai/ko/workspace/${id===tex ? "texture" : "smart-uv"}/rabbit-${id}`;
  const packet: ChromePacket = {
    jobId: "job-1",
    request: {
      step: "surface",
      prompt: "rabbit",
      externalSurface: {
        observedUvCost: 20,
        observedTextureCost: 20,
        textureResolution: "4K",
        removeLighting: false,
      },
    },
    approval: { accepted: true, studioCreditLimit: 40, imageCreditLimit: 0 },
    sourceStudioModel: { modelId: source, url: url(source) },
  };
  let ledger = new ChromeJobLedger(file, packet, "hash-1");
  const begin = {
    phase: "uv",
    sourceModelId: source,
    observedCost: 20,
    url: url(source),
  };
  assert.throws(() => ledger.begin({ ...begin, phase: "texture" }), /Smart UV/);
  assert.throws(
    () => ledger.begin({ ...begin, observedCost: 21 }),
    /승인한 범위/,
  );
  assert.throws(
    () => ledger.begin({ ...begin, sourceModelId: uv }),
    /승인한 범위/,
  );
  assert.throws(
    () => ledger.begin({ ...begin, url: "https://evil.example/" }),
    /승인한 범위/,
  );
  assert.equal(ledger.read().entries.length, 0);
  assert.throws(()=>ledger.begin({...begin,url:url(source)+"?token=secret"}),/승인한 범위/);
  assert.throws(()=>ledger.begin({...begin,url:url(source).replace("smart-uv","unobserved-route")}),/승인한 범위/);
  ledger.begin(begin);
  ledger = new ChromeJobLedger(file, packet, "hash-1");
  assert.throws(() => ledger.begin(begin), /이미 예약/);
  assert.throws(() => new ChromeJobLedger(file, packet, "hash-2"), /일치하지/);
  assert.throws(() => ledger.verify({}), /기록이 부족/);
  ledger.complete({ phase: "uv", resultId: uv, url: url(uv) });
  assert.throws(() => ledger.begin(begin), /이미 예약/);
  assert.throws(
    () =>
      ledger.begin({
        phase: "texture",
        sourceModelId: source,
        observedCost: 20,
        url: url(source),
      }),
    /승인한 범위/,
  );
  ledger.begin({
    phase: "texture",
    sourceModelId: uv,
    observedCost: 20,
    url: url(uv),
  });
  ledger.complete({ phase: "texture", resultId: tex, url: url(tex) });
  assert.throws(
    () => ledger.complete({ phase: "uv", resultId: tex, url: url(tex) }),
    /바꿀 수/,
  );
  const receipt = {
    surface: {
      sourceModelId: source,
      uv: {
        sourceModelId: source,
        modelId: uv,
        url: url(uv),
        creditCost: 20,
        fbxPath: "uv.fbx",
      },
      texture: {
        sourceModelId: uv,
        modelId: tex,
        url: url(tex),
        creditCost: 20,
        fbxPath: "texture.fbx",
        texturePaths: ["color.png"],
        resolution: "4K" as const,
        removeLighting: false,
      },
    },
  };
  ledger.verify(receipt);
  receipt.surface.texture.creditCost = 19;
  assert.throws(() => ledger.verify(receipt), /호스트 제출 기록/);
  assert.equal(
    ledger.read().entries.reduce((n, e) => n + e.cost, 0),
    40,
  );
});


test("model cost approval binds exact settings, rejects denial/cancellation/bypass and persists one reservation", async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"model-cost-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const packet:ChromePacket={jobId:"model",request:{step:"model",prompt:"rabbit",executionMode:"codex-app",generationCount:1,polygonCount:10000,
 externalModel:{model:"P2.0",topology:"quad",observedCreditCost:0,inputMode:"single",costApproval:"in-app"}},approval:{accepted:true,studioCreditLimit:0,imageCreditLimit:0}};
 const plan={observedCost:100,url:"https://studio.tripo3d.ai/ko/workspace/generate",model:"P2.0" as const,topology:"quad" as const,generationCount:1,polygonCount:10000,inputMode:"single" as const};
 const file=path.join(dir,"journal.json");let l=new ChromeJobLedger(file,packet,"frozen");let calls=0;
 const yes=async()=>{calls++;return true;};
 assert.throws(()=>l.begin({phase:"model",sourceModelId:"",observedCost:0,url:plan.url}),/비용을 먼저 승인/);
 for(const bad of [{generationCount:2},{polygonCount:5000},{inputMode:"multiview"},{observedCost:-1},{url:plan.url+"?token=secret"},{url:plan.url.replace("generate","texture")},{model:"P1"}])
   await assert.rejects(l.approveModel({...plan,...bad} as any,yes,()=>false),/맞지/);
 assert.equal(calls,0);assert.equal(l.read().entries.length,0);
 await assert.rejects(l.approveModel(plan,async()=>false,()=>false),/승인하지/);
 let cancelled=false;await assert.rejects(l.approveModel(plan,async()=>{cancelled=true;return true;},()=>cancelled),/취소/);
 assert.equal(l.read().entries.length,0);
 let release!:(yes:boolean)=>void;const pending=l.approveModel(plan,()=>new Promise(r=>release=r),()=>false);
 await assert.rejects(l.approveModel(plan,yes,()=>false),/맞지/);release(true);await pending;
 l=new ChromeJobLedger(file,packet,"frozen");assert.equal(l.read().entries[0].cost,100);assert.deepEqual(l.read().entries[0].approvedModelPlan,plan);
 await assert.rejects(l.approveModel(plan,yes,()=>false),/맞지/);assert.equal(calls,0);
});
