/** Recover the actual app-authored Idle from disk; never submit or author motion. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {PNG} from "pngjs";
import {_electron as electron} from "playwright";
import {Store} from "../engine/store";
import {CodexWorkbenchExecutor} from "../engine/workbench-executor";
import type {Workbench,WorkbenchExecutionContext} from "../shared/workbench";
import type {ProductionWorker} from "../engine/codex-worker";

const projectId="26122336-8a7c-48b5-b15f-fa193ca157fd", benchId="1839dc9e-c05b-459b-b985-6ceca49fac76",jobId="34cc1dac-45c6-48ec-a651-532557c5d6ae";
const live=process.argv.includes("--live"),source=path.join(process.env.APPDATA!,"partsmith"),rel=`projects/${projectId}`,benchRel=`workbench/${benchId}/workbench.json`,jobRel=`workbench/${benchId}/jobs/${jobId}`;
const hash=(p:string)=>createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const initial:Workbench=JSON.parse(fs.readFileSync(path.join(source,rel,benchRel),"utf8"));
assert(!initial.activeJobId&&!initial.jobs.some(j=>j.status==="running"));
assert.equal(initial.jobs.find(j=>j.id===jobId)!.status,"needs_input");
const data=live?source:fs.mkdtempSync(path.join(os.tmpdir(),"partsmith-idle-recovery-"));
if(!live){
 fs.cpSync(path.join(source,rel),path.join(data,rel),{recursive:true});
 const store=new Store(data);await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
 store.put("project",projectId,JSON.parse(fs.readFileSync(path.join(source,rel,"project.json"),"utf8")));store.put("workbench",benchId,initial);store.db.close();
}
const root=path.join(data,rel),workspace=path.join(root,jobRel),out=path.join(workspace,"outputs/animation"),resultFile=path.join(out,"result.json"),events=path.join(out,"codex-events.jsonl"),eventsBefore=hash(events);
const primary=["Rabbit_Idle.blend","Rabbit_Idle.glb","Rabbit_Idle_side.mp4"],before=Object.fromEntries(primary.map(n=>[n,hash(path.join(out,n))]));
const receipt=JSON.parse(fs.readFileSync(path.join(out,"recovery_report.json"),"utf8"));
for(const a of receipt.verified_artifacts)assert.equal(hash(path.join(workspace,a.path)),a.sha256);
const frames=JSON.parse(fs.readFileSync(path.join(out,"frames.json"),"utf8"));assert.equal(frames.frames.length,60);
const frameHashes=new Set<string>();
for(const f of frames.frames){const p=path.join(workspace,f.path),png=PNG.sync.read(fs.readFileSync(p));assert.equal(png.width,960);assert.equal(png.height,540);frameHashes.add(hash(p));}
assert(frameHashes.size>1);
for(const view of ["front","left","back"]){
 const first=PNG.sync.read(fs.readFileSync(path.join(out,`${view}_001.png`))),last=PNG.sync.read(fs.readFileSync(path.join(out,`${view}_061.png`)));
 assert.equal(first.width,last.width);assert.equal(first.height,last.height);assert(first.data.equals(last.data));
}
const decode=spawnSync(path.resolve("node_modules/ffmpeg-static/ffmpeg.exe"),["-v","error","-i",path.join(out,"Rabbit_Idle_side.mp4"),"-f","null","-"],{encoding:"utf8",timeout:30000});assert.equal(decode.status,0,decode.stderr);
// Preserve the worker's response. Only register genuine saved renders/reports
// and put its unchanged failed appearance observation in the canonical category.
const backup=path.join(out,"result.before-host-recovery.json");assert(!fs.existsSync(backup));fs.copyFileSync(resultFile,backup);
const result=JSON.parse(fs.readFileSync(resultFile,"utf8"));assert.equal(result.status,"completed");
const appearance=result.checks.find((c:any)=>c.name==="existing_appearance_limitations");assert(appearance&&appearance.passed===false);appearance.name="visual_quality";
result.summary="저장된 Rabbit_Idle 2초·30fps 결과를 복구했습니다. 동작과 남은 외형 경고를 확인한 뒤 채택하세요.";
for(const [name,view] of [["left_013.png","left"],["front_013.png","front"],["back_031.png","back"]]){
 PNG.sync.read(fs.readFileSync(path.join(out,name)));result.candidates[0].artifacts.push({path:`outputs/animation/${name}`,kind:"image",view,role:"animation_review"});
}
result.candidates[0].artifacts.push({path:"outputs/animation/animation_evidence.json",kind:"report",role:"authoring_evidence"});
result.checks.push({name:"visual_quality",passed:false,severity:"warning",visualCategory:"appearance",detail:"눈꺼풀 제어가 없어 영상의 눈 깜빡임은 재현하지 않았습니다. 측면 영상에 보이지 않는 방향은 리그에 맞춰 작성했고, 마지막 구간은 대기 반복을 위해 조정했습니다."});
fs.writeFileSync(resultFile,JSON.stringify(result,null,2));
const job=structuredClone(initial.jobs.find(j=>j.id===jobId)!);
const inputs=[...new Map(Object.values(job.dependencies).flatMap(s=>initial.jobs.find(j=>j.id===s.jobId)!.candidates.find(c=>c.id===s.candidateId)!.artifacts).map(a=>[a.path,a])).values()];
const worker:ProductionWorker={probe:async()=>({codex:{available:true,authenticated:true,message:"local recovery check"},capabilities:{studio:false,video:false,motion:true},message:"local recovery check"}),run:async()=>{throw Error("Unexpected worker invocation: local recovery must not author assets");}};
const context:WorkbenchExecutionContext={workbench:initial,job,inputs,workspace,signal:new AbortController().signal,recovery:{attempt:3,mode:"repair",error:"stream disconnected before completion: websocket closed by server"}};
// Separate checkpoint namespace: the packaged app still performs its own validation.
const executor=new CodexWorkbenchExecutor(worker,{projectRoot:()=>root,blenderPath:()=>"C:/Program Files/Blender Foundation/Blender 5.0/blender.exe",unityPath:()=>undefined,unityEditorPath:()=>"",resourcesPath:path.resolve("integrations"),checkpointRoot:path.join(data,"recovery-checkpoints")});
const checked=await executor.recover(context,()=>{});assert.equal(checked.status,"completed",checked.summary);
const scene=JSON.parse(fs.readFileSync(path.join(workspace,"host-scene-inspection.json"),"utf8"));
assert.equal(scene.fps,30);assert.equal(scene.frameStart,1);assert.equal(scene.frameEnd,60);assert.equal(scene.rigs[0].bones.length,25);
assert(scene.actions.some((a:any)=>a.name==="Rabbit_Idle"&&a.varyingChannels>0));assert(scene.objects.every((o:any)=>o.weightedVertices===o.vertices&&o.invalidWeightVertices===0));
const launch=async()=>{
 const app=await electron.launch({executablePath:path.resolve("release/0.6.22/win-unpacked/Partsmith.exe"),env:{...process.env,PARTSMITH_DATA:data}});
 const page=await app.firstWindow();page.setDefaultTimeout(15000);
 await page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`).getByTestId("project-open").click();
 await page.getByTestId("workbench-step-motion").click();await page.getByTestId("workbench-tab-animation").click();await page.getByTestId("workbench-motion-name").fill("Rabbit_Idle");
 return {app,page};
};
let {app,page}=await launch();
const state=async()=>{const s=await page.evaluate(()=>(window as any).desktop.call({type:"state"}));return s.workbenches.find((w:any)=>w.id===benchId);};
await page.getByRole("button",{name:"기존 작업 이어서 확인",exact:true}).click();
let current;
for(let n=0;n<45;n++){current=await state();if(!current.activeJobId)break;await new Promise(r=>setTimeout(r,1000));}
assert.equal(current.jobs.find((j:any)=>j.id===jobId).status,"review",current.jobs.find((j:any)=>j.id===jobId).summary);
assert.equal(hash(events),eventsBefore,"No further Astra worker tokens");
await app.close();({app,page}=await launch());current=await state();
const registered=current.jobs.find((j:any)=>j.id===jobId);assert.equal(registered.status,"review");assert(!current.activeJobId);assert.deepEqual(current.selections,initial.selections);
await page.locator(".wb-model canvas").first().waitFor();assert.equal(await page.locator(".viewport-error").count(),0);
for(const a of registered.candidates[0].artifacts)assert.equal(hash(path.join(root,a.path)),a.sha256);
for(const n of primary)assert.equal(hash(path.join(out,n)),before[n]);
assert.equal(hash(events),eventsBefore);assert(registered.checks.some((c:any)=>c.name==="visual_quality"&&!c.passed&&c.severity==="warning"));
const proof={version:"0.6.22",live,jobId,data,status:registered.status,originalAssetHashes:before,frames:60,loopEndpointPixelsEqual:true,packedVideoDecodes:true,anatomicalRigBones:25,realVaryingPoseChannels:true,allVerticesWeighted:true,packagedRetry:true,restartPersistence:true,selectionsUnchanged:true,workerEventsUnchanged:true,newAstraCalls:0,paidSubmissions:0};
fs.writeFileSync(`artifacts/runtime/rabbit-idle-recovery-${live?"live":"package"}.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
if(live)await new Promise<void>(resolve=>app.on("close",()=>resolve()));else await app.close();
