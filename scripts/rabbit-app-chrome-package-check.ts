/** Real rabbit data, isolated package UI and restart check; NEVER clicks Run. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { Store } from "../engine/store";
const projectId="26122336-8a7c-48b5-b15f-fa193ca157fd",workbenchId="1839dc9e-c05b-459b-b985-6ceca49fac76";
const liveProject=path.join(process.env.APPDATA!,"partsmith/projects",projectId);
const project=JSON.parse(fs.readFileSync(path.join(liveProject,"project.json"),"utf8"));
const workbench=JSON.parse(fs.readFileSync(path.join(liveProject,"workbench",workbenchId,"workbench.json"),"utf8"));
assert(!workbench.jobs.some((j:any)=>j.status==="running"));
const job=workbench.jobs.find((j:any)=>j.id==="18e8e770-ad5c-4f7e-9cfc-ad310bbdf3d1");
assert.equal(job.status,"needs_input");assert.equal(job.externalExecution.state,"reserved");
const savedExternal=structuredClone(job.externalExecution);
const data=path.resolve("artifacts/runtime/rabbit-app-chrome-package-"+Date.now());
const store=new Store(data);await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
store.put("project",projectId,project);store.put("workbench",workbenchId,workbench);store.db.close();
fs.cpSync(liveProject,path.join(data,"projects",projectId),{recursive:true});
const errors:string[]=[];
const launch=async()=>{
 const app=await electron.launch({executablePath:path.resolve("release/0.6.10/win-unpacked/Partsmith.exe"),env:{...process.env,PARTSMITH_DATA:data}});
 const page=await app.firstWindow();page.setDefaultTimeout(10000);page.on("pageerror",e=>errors.push(e.message));
 await page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`).getByTestId("project-open").click();
 await page.getByTestId("workbench-step-surface").click();
 return {app,page};
};
let {app,page}=await launch();
try {
 assert(!(await page.getByTestId("workbench-codex-run").isEnabled()));
 await page.getByTestId("workbench-codex-reply").fill("다운로드 감지 수정 후 기존 UV를 유지해 이어서 확인");
 assert(await page.getByTestId("workbench-codex-run").isEnabled());
 assert.equal(await page.getByTestId("workbench-chatgpt-connection-status").count(),0);
 assert.equal(await page.getByTestId("workbench-chatgpt-open").count(),0);
 assert.equal(await page.getByTestId("workbench-texture-resolution").inputValue(),"4K");
 assert.equal(await page.getByTestId("workbench-observed-uv-cost").inputValue(),"20");
 assert.equal(await page.getByTestId("workbench-observed-texture-cost").inputValue(),"20");
 await page.getByTestId("workbench-codex-run").scrollIntoViewIfNeeded();
 await page.screenshot({path:"artifacts/runtime/rabbit-app-chrome-ready.png",timeout:10000});
 await app.close();({app,page}=await launch());
 const state:any=await page.evaluate(()=>(window as any).desktop.call({type:"state"}));
 const w=state.workbenches.find((w:any)=>w.id===workbenchId),j=w.jobs.find((j:any)=>j.id===job.id);
 assert.deepEqual(j.externalExecution,savedExternal);
 assert.equal(w.selections["model:whole"].candidateId,"model-1");assert.equal(w.selections.surface,undefined);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({package:"0.6.10",codexButtonEnabled:true,restartPreserved:true,jobId:job.id,workerStarted:false,paidRequests:0,errors}));
} finally {await app.close();}
