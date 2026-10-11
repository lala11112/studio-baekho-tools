import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerAppServerRequest,
  approvalText,
} from "../engine/codex-app-server-worker";

test("browser form approval waits for an explicit app answer and preserves exact enum values", async () => {
  let resolve!: (answer: any) => void;
  const answer = new Promise<any>((r) => (resolve = r));
  let settled = false;
  const result = answerAppServerRequest(
    {
      id: 7,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "browser",
        mode: "openai/form",
        message: "Allow https://studio.tripo3d.ai/ko?token=secret",
        requestedSchema: {
          type: "object",
          properties: {
            access: { type: "boolean" },
            lifetime: { type: "string", enum: ["turn", "thread"] },
          },
          required: ["access", "lifetime"],
        },
      },
    },
    async (request) => {
      assert.ok(!request.detail.includes("secret"));
      assert.deepEqual(
        request.fields[1].options?.map((o) => o.value),
        ["turn", "thread"],
      );
      return answer;
    },
  ).then((r) => {
    settled = true;
    return r;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  resolve({ accepted: true, values: { access: "true", lifetime: "turn" } });
  assert.deepEqual(await result, {
    action: "accept",
    content: { access: true, lifetime: "turn" },
    _meta: null,
  });
});

test("denial grants nothing, no session-wide command grant, unsupported identity request fails", async () => {
  const declined = async () => ({ accepted: false, values: {} });
  assert.deepEqual(
    await answerAppServerRequest(
      {
        method: "item/permissions/requestApproval",
        params: { permissions: { network: { enabled: true } } },
      },
      declined,
    ),
    { permissions: {}, scope: "turn" },
  );
  assert.deepEqual(
    await answerAppServerRequest(
      { method: "item/commandExecution/requestApproval" },
      async () => ({ accepted: true, values: {} }),
    ),
    { decision: "accept" },
  );
  await assert.rejects(
    () => answerAppServerRequest({ method: "attestation/generate" }, declined),
    /지원하지/,
  );
  await assert.rejects(
    () =>
      answerAppServerRequest(
        {
          method: "item/tool/requestUserInput",
          params: { questions: [{ isSecret: true }] },
        },
        declined,
      ),
    /비밀/,
  );
  assert.equal(
    approvalText("https://example.com/auth?code=secret#token"),
    "https://example.com/auth",
  );
});

test("invalid form choices fail instead of widening requested permission", async () => {
  await assert.rejects(
    () =>
      answerAppServerRequest(
        {
          method: "mcpServer/elicitation/request",
          params: {
            mode: "form",
            requestedSchema: {
              type: "object",
              properties: { lifetime: { type: "string", enum: ["turn"] } },
              required: ["lifetime"],
            },
          },
        },
        async () => ({ accepted: true, values: { lifetime: "forever" } }),
      ),
    /허용되지/,
  );
});


test("only explicitly trusted empty browser-origin prompts auto-accept; other approval classes still ask",async()=>{
 const base={method:"mcpServer/elicitation/request",params:{serverName:"cua_repl",mode:"form",message:"Allow Browser use to access https://studio.tripo3d.ai/",requestedSchema:{type:"object",properties:{}}}};
 let calls=0;const decline=async()=>{calls++;return {accepted:false,values:{}};};const allowed=["https://studio.tripo3d.ai","https://chatgpt.com"];
 assert.deepEqual(await answerAppServerRequest(base,decline,allowed),{action:"accept",content:{},_meta:null});assert.equal(calls,0);
 assert.deepEqual(await answerAppServerRequest({...base,params:{...base.params,message:"Allow Browser use to access https://studio.tripo3d.ai"}},decline,allowed),{action:"accept",content:{},_meta:null});
 assert.deepEqual(await answerAppServerRequest({...base,params:{...base.params,message:undefined,reason:base.params.message}},decline,allowed),{action:"accept",content:{},_meta:null});
 for(const message of ["Allow Browser use to access https://studio.tripo3d.ai.evil.example/","Allow Browser use to access https://studio.tripo3d.ai/?cost=100","Allow Browser use to access https://studio.tripo3d.ai/download/","Allow Browser use to access https://evil.example/","Allow Browser use to access https://studio.tripo3d.ai@evil.example/","Allow Browser use to access https://studio.tripo3d.ai/ and pay 100","Allow download from https://studio.tripo3d.ai/"]){
  assert.deepEqual(await answerAppServerRequest({...base,params:{...base.params,message}},decline,allowed),{action:"decline",content:null,_meta:null});
 }
 assert.equal(calls,7);
 await answerAppServerRequest(base,decline,[]);
 await answerAppServerRequest({...base,params:{...base.params,serverName:"other"}},decline,allowed);
 await answerAppServerRequest({...base,params:{...base.params,requestedSchema:{type:"object",properties:{pay:{type:"boolean"}}}}},decline,allowed);
 await answerAppServerRequest({method:"item/commandExecution/requestApproval",params:{command:"dangerous"}},decline,allowed);
 await answerAppServerRequest({method:"item/permissions/requestApproval",params:{permissions:{network:{enabled:true}}}},decline,allowed);
 assert.equal(calls,12);
});


test("routine transfers require exact host-provided URLs, never a broad site or tracking grant",async()=>{
 const origin="https://studio.tripo3d.ai",url=origin+"/ko/workspace/generate";let calls=0;const ask=async()=>{calls++;return {accepted:false,values:{}};};
 const msg=(message:string)=>({method:"mcpServer/elicitation/request",params:{mode:"form",serverName:"cua_repl",message,requestedSchema:{type:"object",properties:{}}}});
 const policy={upload:[url],download:[origin+"/ko/workspace/generate/result"]};
 for(const text of ["Allow upload to "+url,"Allow download from "+policy.download[0]])assert.deepEqual(await answerAppServerRequest(msg(text),ask,[origin],policy),{action:"accept",content:{},_meta:null});
 assert.equal(calls,0);
 for(const text of ["Allow upload to "+url+"?token=secret","Allow download from "+url,"Allow upload to https://facebook.com/tr/","Allow download from https://cdn.example/asset.fbx"])
  assert.deepEqual(await answerAppServerRequest(msg(text),ask,[origin],policy),{action:"decline",content:null,_meta:null});
 assert.equal(calls,4);
 await answerAppServerRequest(msg("Allow upload to "+url),ask,[origin],{upload:[],download:[]});assert.equal(calls,5);
});
