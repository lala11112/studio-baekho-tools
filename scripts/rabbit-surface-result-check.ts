/** Real completed rabbit files in an isolated app profile. No generation or selection. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {_electron as electron} from "playwright";
import {Store} from "../engine/store";
const projectId="26122336-8a7c-48b5-b15f-fa193ca157fd",workbenchId="1839dc9e-c05b-459b-b985-6ceca49fac76",jobId="18e8e770-ad5c-4f7e-9cfc-ad310bbdf3d1";
const source=path.join(process.env.APPDATA!,"partsmith/projects",projectId);
const project=JSON.parse(fs.readFileSync(path.join(source,"project.json"),"utf8"));
const workbench=JSON.parse(fs.readFileSync(path.join(source,"workbench",workbenchId,"workbench.json"),"utf8"));
const job=workbench.jobs.find((j:any)=>j.id===jobId);
assert(!workbench.activeJobId);assert.equal(job.status,"review");assert.equal(job.externalExecution.state,"received");
assert.equal(job.candidates.length,1);assert.equal(workbench.selections.surface,undefined);
for(const a of job.candidates[0].artifacts)assert.equal(createHash("sha256").update(fs.readFileSync(path.join(source,a.path))).digest("hex"),a.sha256);
const data=path.resolve("artifacts/runtime/rabbit-surface-result-"+Date.now());
const store=new Store(data);await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
store.put("project",projectId,project);store.put("workbench",workbenchId,workbench);store.db.close();
fs.cpSync(source,path.join(data,"projects",projectId),{recursive:true});
const errors:string[]=[],responses:number[]=[],consoleErrors:string[]=[];
const launch=async()=>{
 const app=await electron.launch({executablePath:path.resolve("release/0.6.12/win-unpacked/Partsmith.exe"),env:{...process.env,PARTSMITH_DATA:data}});
 const page=await app.firstWindow();page.setDefaultTimeout(10000);
 page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")consoleErrors.push(m.text());});page.on("response",r=>{if(r.url().includes("preview.glb"))responses.push(r.status());});
 await page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`).getByTestId("project-open").click();
 await page.getByTestId("workbench-step-surface").click();return {app,page};
};
let {app,page}=await launch();
try{
 await page.locator(".wb-model canvas").first().waitFor();
 for(let n=0;n<20&&!responses.length;n++)await new Promise(r=>setTimeout(r,500));
 assert(responses.includes(200),"Actual GLB must load through the packaged app asset protocol");
 await new Promise(r=>setTimeout(r,1500));assert.equal(await page.locator(".viewport-error").count(),0);
 await page.locator(".wb-model").first().scrollIntoViewIfNeeded();
 await page.screenshot({path:"artifacts/runtime/rabbit-surface-result.png"});
 await app.close();({app,page}=await launch());
 const state:any=await page.evaluate(()=>(window as any).desktop.call({type:"state"}));
 const w=state.workbenches.find((w:any)=>w.id===workbenchId),j=w.jobs.find((j:any)=>j.id===jobId);
 assert.equal(j.status,"review");assert.deepEqual(j.candidates,job.candidates);assert.deepEqual(j.externalExecution,job.externalExecution);
 assert.equal(w.selections.surface,undefined);assert.equal(w.activeJobId,undefined);assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);
 const report={package:"0.6.12",jobId,artifactHashes:true,glbResponse:200,restartPreserved:true,autoSelected:false,paidSubmissions:0,errors};
 fs.writeFileSync("artifacts/runtime/rabbit-surface-result-check.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app.close();}
