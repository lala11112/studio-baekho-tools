/** Real app-button API verification. Explicit --stage only; durable 300-credit ceiling, no ambiguous resubmit. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import electronBinary from "electron";
import type { AppState } from "../shared/types";
import type { GraphicsWorkspace } from "../shared/graphics";
import { graphicsTripoReserved } from "../shared/graphics-catalog";

const repo=process.cwd(),profile=path.join(process.env.APPDATA!,"partsmith");
const evidence=path.join(repo,"artifacts/runtime/graphics-api-live.json");
const stage=process.argv[process.argv.indexOf("--stage")+1];
assert(["M01","T01","T03","M05","X04","X05","X04-fixed","X05-fixed","X05-reuse","inspect"].includes(stage),"Use explicit --stage M01/T01/T03/M05/X04/X05/X04-fixed/X05-fixed/X05-reuse/inspect; each invocation handles ONE app task.");
const operation=stage.replace(/-(fixed|reuse)$/,"");
const report:any=fs.existsSync(evidence)?JSON.parse(fs.readFileSync(evidence,"utf8")):{schemaVersion:1,profile,limit:300,stages:{},createdAt:new Date().toISOString()};
assert.equal(report.profile,profile);assert.equal(report.limit,300);
const save=()=>{fs.mkdirSync(path.dirname(evidence),{recursive:true});fs.writeFileSync(evidence,JSON.stringify(report,null,2));};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"ps-api-live-"));
const bootstrap=path.join(temp,"bootstrap.cjs");
fs.writeFileSync(bootstrap,`const {app,dialog}=require('electron');app.setAppPath(${JSON.stringify(repo)});process.chdir(${JSON.stringify(repo)});dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};require(${JSON.stringify(path.join(repo,"dist-electron/main.cjs"))});`);
let app:ElectronApplication|undefined,page:Page;
const state=()=>page.evaluate(()=>window.desktop.call<AppState>({type:"state"}));
const workspace=async()=>{const w=(await state()).graphicsWorkspaces?.find(w=>w.projectId===report.projectId);assert(w,"pilot workspace missing");return w;};
async function waitFor(predicate:(w:GraphicsWorkspace)=>boolean,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const w=await workspace();if(predicate(w))return w;await new Promise(r=>setTimeout(r,500));}throw Error("App state timeout");}
async function selectTask(id:string){await page.getByRole("tab",{name:"전체",exact:true}).click();await page.getByRole("textbox",{name:"작업 검색",exact:true}).fill(id);await page.locator(`[data-task-id="${id}"] .gs-task-open`).click();}
async function acceptVersion(id:string){await page.getByTestId(`graphics-version-${id}`).click();await page.getByTestId("graphics-accept-version").click();await waitFor(w=>Object.values(w.objects.find(o=>o.id===report.objectId)!.accepted).includes(id));}
try{
  app=await electron.launch({executablePath:electronBinary as unknown as string,args:[bootstrap],env:{...process.env,PARTSMITH_DATA:profile,PARTSMITH_DEV:""},timeout:30000});
  page=await app.firstWindow();page.setDefaultTimeout(20000);
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.getByRole("button",{name:"새 프로젝트",exact:true}).waitFor();
  const initial=await state();assert.equal(path.resolve(initial.dataDir),path.resolve(profile));
  assert(initial.key.configured,"Existing owning-profile Tripo key is required; never copy/decrypt credentials into this script.");
  assert(!initial.projects.some(p=>p.jobs.some(j=>["queued","submitting","running"].includes(j.status))),"Another API production job is active");
  if(!report.projectId){
    assert.equal(stage,"M01");
    await page.getByRole("button",{name:"새 프로젝트",exact:true}).click();const modal=page.getByRole("dialog");
    await modal.getByLabel("프로젝트 이름").fill("API 실제 검증 · 대검");assert.equal(await modal.getByRole("checkbox").isChecked(),false);
    await modal.getByRole("button",{name:"프로젝트 만들기",exact:true}).click();await page.getByTestId("graphics-studio").waitFor();
    report.projectId=(await state()).projects.find(p=>!initial.projects.some(old=>old.id===p.id))!.id;save();
  }else{await page.locator(`[data-project-id="${report.projectId}"]`).getByTestId("project-open").click();await page.getByTestId("graphics-studio").waitFor();}
  if(!report.objectId){
    await page.getByLabel("이름",{exact:true}).fill("기존 네이티브 원본 · API 대검");await page.getByLabel("종류",{exact:true}).selectOption("weapon");await page.getByRole("button",{name:"오브젝트 만들기",exact:true}).click();
    await waitFor(w=>w.objects.length===1);report.objectId=(await workspace()).objects[0].id;save();
  }
  await page.getByTestId(`graphics-object-${report.objectId}`).click();
  if(!(await workspace()).tripoBudget){await page.getByText("Tripo API 누적 승인 한도",{exact:true}).click();await page.getByLabel("Tripo API 한도").fill("300");await page.getByRole("button",{name:"한도 저장",exact:true}).click();await waitFor(w=>w.tripoBudget?.limit===300);}
  assert.equal((await workspace()).tripoBudget?.limit,300);
  if(!report.sourceVersionId){
    const previous=JSON.parse(fs.readFileSync(path.join(repo,"artifacts/runtime/graphics-native-live.json"),"utf8"));
    const originalWorkspace=JSON.parse(fs.readFileSync(path.join(previous.profile,"projects",previous.projectId,"graphics/workspace.json"),"utf8"));
    const version=originalWorkspace.versions.find((v:any)=>v.provenance.jobId===previous.taskId);assert(version);
    const file=version.files.find((f:any)=>f.kind==="image"),source=path.join(previous.profile,"projects",previous.projectId,file.path);
    assert.equal(createHash("sha256").update(fs.readFileSync(source)).digest("hex"),file.sha256);
    await app.evaluate(({dialog},source)=>{Object.defineProperty(dialog,"showOpenDialog",{configurable:true,value:Function("source","return async function(){return {canceled:false,filePaths:[source]};}")(source)});},source);
    await page.getByLabel("가져올 자료의 역할").selectOption("design");await page.getByTestId("graphics-import").click();await waitFor(w=>w.versions.length===1);
    report.sourceVersionId=(await workspace()).versions[0].id;report.originalImageSha256=file.sha256;report.imageRegenerations=0;save();
    await acceptVersion(report.sourceVersionId);report.testAdoption=true;save();
  }
  if(stage!=="inspect"){
    let record=report.stages[stage];
    if(record?.approvedAt){
      assert(record.taskId,"Missing durable approved task ID");
      console.log(JSON.stringify({stage,action:"existing task inspection only",taskId:record.taskId}));
    }else{
      const current=await workspace();
      assert(!current.tasks.some(t=>["running","submission_unknown"].includes(t.status)),"An existing task needs inspection; do not replay");
      const previousStage=stage==="X04-fixed"?"M05":["X05-fixed","X05-reuse"].includes(stage)?"X04-fixed":stage==="T01"?"M01":stage==="T03"?"T01":stage==="X04"?"T03":["X05","M05"].includes(stage)?"X04":undefined;
      if(previousStage){const prior=report.stages[previousStage];assert(prior?.versionIds?.length===1,"Previous actual result must exist");const v=current.versions.find(v=>v.id===prior.versionIds[0])!;assert(v);if(!Object.values(current.objects.find(o=>o.id===report.objectId)!.accepted).includes(v.id))await acceptVersion(v.id);}
      await selectTask(operation);await page.getByLabel("원하는 결과와 유지할 특징").fill(stage==="T03"?"Preserve the approved greatsword geometry and UV. Silver metal blade, dark navy blue handle, subtle metallic ornament matching the original design. No text or character. High quality PBR textures.":"Match the adopted original greatsword. Preserve the complete blade and hilt, proportions and design. Unity PC game asset.");
      if(stage==="M05") await page.getByLabel("원하는 결과와 유지할 특징").fill("기존 대검을 재사용하는 앱 기능 검증용 수정입니다. 렌더로 날·가드·손잡이를 먼저 구분하고 칼날 부위의 폭만 중심 기준으로 5% 넓혀 주세요. 길이·두께·손잡이·가드·문양·원래 UV와 재질/텍스처 해상도는 유지합니다. 토폴로지와 정점 수를 바꾸지 말고 위치만 조정하세요. 원본은 보존하고 변경된 정점 범위·전후 폭과 실제 렌더를 증거로 남겨 주세요. 리깅이나 새 모델 생성은 하지 않습니다.");
      if(operation==="X05"){await page.getByRole("button",{name:"프로젝트 검사",exact:true}).click();await waitFor(w=>w.target?.projectPath==="C:\\Unity\\3D Tool Test");}
      if(stage==="M01"){await page.getByLabel("후보 개수",{exact:true}).fill("1");await page.getByLabel("목표 면 수",{exact:true}).fill("5000");}
      if(!record?.taskId){await page.getByTestId("graphics-prepare").click();await waitFor(w=>w.tasks.some(t=>t.taskId===operation&&t.status==="awaiting_approval"));const t=(await workspace()).tasks.find(t=>t.taskId===operation&&t.status==="awaiting_approval")!;record=report.stages[stage]={taskId:t.id,requestHash:t.requestHash,estimatedCredits:t.cost?.credits,preparedAt:new Date().toISOString()};save();}
      const pending=(await workspace()).tasks.find(t=>t.id===record.taskId)!;assert.equal(pending.status,"awaiting_approval");
      assert((stage==="M05"?["Codex"]:["Tripo API","로컬"]).includes(pending.cost?.provider??""),"No other provider authorized");
      assert.equal(pending.cost?.credits,stage==="M01"?100:["T01","T03"].includes(stage)?20:stage==="M05"?null:0);
      assert(graphicsTripoReserved(await workspace())+(pending.cost!.credits??0)<=300);
      record.approvedAt=new Date().toISOString();save(); // Written BEFORE app click, never replay after an ambiguous click.
      await page.getByTestId(`graphics-approve-${record.taskId}`).click();
      console.log(JSON.stringify({stage,taskId:record.taskId,approvedCredits:record.estimatedCredits,limit:300}));
    }
    let latest;const deadline=Date.now()+25*60_000;
    while(Date.now()<deadline){
      const w=await workspace();latest=w.tasks.find(t=>t.id===record.taskId)!;
      if(!["running","awaiting_approval"].includes(latest.status))break;
      await new Promise(r=>setTimeout(r,4000));
    }
    assert(latest);record.status=latest.status;record.message=latest.message;record.versionIds=latest.outputVersionIds;record.backendJobIds=latest.backendJobIds;record.finishedAt=new Date().toISOString();
    const final=await state(),w=await workspace();record.jobs=final.projects.find(p=>p.id===report.projectId)!.jobs.filter(j=>latest!.backendJobIds.includes(j.id)).map(j=>({id:j.id,remoteId:j.remoteId,status:j.status,credits:j.credits,nativeFiles:j.nativeFiles,message:j.message}));
    report.reservedCredits=graphicsTripoReserved(w);report.pageErrors=errors;save();
    if(latest.status==="review"&&latest.outputVersionIds.length){await page.getByTestId(`graphics-version-${latest.outputVersionIds[0]}`).click();await page.getByTestId("graphics-preview").scrollIntoViewIfNeeded();await page.waitForTimeout(2500);await page.screenshot({path:path.join(repo,`artifacts/runtime/graphics-api-${stage}.png`),fullPage:false});}
    console.log(JSON.stringify({stage,status:record.status,message:record.message,jobs:record.jobs,reservedCredits:report.reservedCredits}));
    assert.equal(latest.status,"review","Actual API result was not completed; preserved existing task without resubmission");
  }
  const final=await workspace();for(const v of final.versions)for(const f of v.files){assert.equal(createHash("sha256").update(fs.readFileSync(path.join(profile,"projects",report.projectId,f.path))).digest("hex"),f.sha256);}
  report.lastCheckedAt=new Date().toISOString();save();
}catch(error){report.lastError=String(error);save();throw error;}
finally{if(app)await app.close();const actual=fs.realpathSync(temp);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));fs.rmSync(actual,{recursive:true,force:true,maxRetries:3});}
