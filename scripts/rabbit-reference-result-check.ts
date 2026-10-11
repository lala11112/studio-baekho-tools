/** Historical static-pose check. Do NOT run for the replacement continuous-video plan. Never generates or accepts. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {_electron as electron} from "playwright";
import {Store} from "../engine/store";
const projectId="26122336-8a7c-48b5-b15f-fa193ca157fd",workbenchId="1839dc9e-c05b-459b-b985-6ceca49fac76";
const source=path.join(process.env.APPDATA!,"partsmith/projects",projectId);
const project=JSON.parse(fs.readFileSync(path.join(source,"project.json"),"utf8"));
const workbench=JSON.parse(fs.readFileSync(path.join(source,"workbench",workbenchId,"workbench.json"),"utf8"));
const plans={Rabbit_Idle:[0,1,2],Rabbit_Jump:[0,0.4,0.9,1.4,2]};
assert(!workbench.activeJobId);assert.equal(workbench.selections.rig.candidateId,"rabbit-rig-v3");
assert(!workbench.jobs.some((j:any)=>j.step==="animation"));
const jobs=Object.entries(plans).map(([motion,times])=>{
  const job=workbench.jobs.find((j:any)=>j.step==="reference"&&j.request.motion===motion);
  assert(["review","needs_input"].includes(job?.status),motion);assert(!workbench.selections[`reference:${motion}`]);
  const candidates=job.status==="review"?job.candidates:job.draftCandidates;
  assert.deepEqual(job.request.referenceTimes,times);assert.equal(job.request.fps,30);assert.equal(candidates?.length,1);
  const artifacts=candidates[0].artifacts,images=artifacts.filter((a:any)=>a.kind==="image");
  assert.equal(images.length,times.length*3);
  for(const artifact of artifacts)assert.equal(createHash("sha256").update(fs.readFileSync(path.join(source,artifact.path))).digest("hex"),artifact.sha256);
  assert.equal(new Set(images.map((a:any)=>a.sha256)).size,images.length);
  const manifest=JSON.parse(fs.readFileSync(path.join(source,artifacts.find((a:any)=>a.kind==="frames").path),"utf8"));
  assert.deepEqual(manifest.frames.map((f:any)=>f.time),times);
  return job;
});
const data=path.resolve("artifacts/runtime/rabbit-reference-result-"+Date.now());
const store=new Store(data);await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
store.put("project",projectId,project);store.put("workbench",workbenchId,workbench);store.db.close();fs.cpSync(source,path.join(data,"projects",projectId),{recursive:true});
const errors:string[]=[];
const launch=async()=>{
 const app=await electron.launch({executablePath:path.resolve("release/0.6.16/win-unpacked/Partsmith.exe"),env:{...process.env,PARTSMITH_DATA:data}});
 const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on("pageerror",e=>errors.push(e.message));
 page.on("console",m=>{if(m.type()==="error")errors.push(m.text());});
 await page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`).getByTestId("project-open").click();
 await page.getByTestId("workbench-step-motion").click();await page.getByTestId("workbench-tab-reference").click();return {app,page};
};
let {app,page}=await launch();
try{
 for(const job of jobs){
   await page.getByTestId("workbench-motion-name").fill(job.request.motion);
   const sequence=page.getByTestId("workbench-sequence");await sequence.locator("img").first().waitFor();
   assert.equal(await sequence.locator("img").count(),3);
   assert(await page.getByTestId("workbench-tab-animation").isDisabled());
   if(job.status==="needs_input")assert.equal(await page.getByTestId("workbench-accept-reference").count(),0);
   await sequence.getByLabel("참조 동작 시점").fill(job.request.motion==="Rabbit_Idle"?"1":"2");
   await page.waitForFunction(()=>Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="workbench-sequence"] img')).every(i=>i.complete&&i.naturalWidth>0));
   await sequence.scrollIntoViewIfNeeded();await sequence.screenshot({path:`artifacts/runtime/${job.request.motion}-reference-review.png`});
 }
 await app.close();({app,page}=await launch());
 const state:any=await page.evaluate(()=>(window as any).desktop.call({type:"state"}));
 const restored=state.workbenches.find((w:any)=>w.id===workbenchId);
 assert.deepEqual(restored.selections,workbench.selections);assert.equal(restored.activeJobId,undefined);
 for(const job of jobs){const after=restored.jobs.find((j:any)=>j.id===job.id);assert.equal(after.status,job.status);assert.deepEqual(after.candidates,job.candidates);assert.deepEqual(after.draftCandidates,job.draftCandidates);assert.deepEqual(after.draftChecks,job.draftChecks);}
 assert(!restored.jobs.some((j:any)=>j.step==="animation"));assert.deepEqual(errors,[]);
 const report={package:"0.6.16",jobs:jobs.map((j:any)=>({id:j.id,motion:j.request.motion,status:j.status,count:j.request.referenceFrameCount*3})),nativeArtifactHashes:true,threeViewsVisible:true,restartPreserved:true,autoAccepted:false,animationStarted:false,errors};
 fs.writeFileSync("artifacts/runtime/rabbit-reference-result-check.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app.close();}
