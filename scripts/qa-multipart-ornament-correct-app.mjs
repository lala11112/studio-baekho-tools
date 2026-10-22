/** One explicitly queued local four-island correction, through the real app DOM. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';

const dir=path.resolve('artifacts/runtime/qa-20261018-multipart-ornament-app');
const proposal=JSON.parse(fs.readFileSync(path.join(dir,'proposed-selection.json'),'utf8'));
const previous=JSON.parse(fs.readFileSync(path.join(dir,'inspection.json'),'utf8'));
const attempt=process.argv[2]??'initial';assert(['initial','after-preview-fix'].includes(attempt));
if(attempt==='after-preview-fix'){const first=JSON.parse(fs.readFileSync(path.join(dir,'correction.json'),'utf8'));assert(first.failure&&!first.dispatchAt&&!first.run,'Earlier attempt must have ended before any dispatch');}
const reportFile=path.join(dir,attempt==='initial'?'correction.json':'correction-after-preview-fix.json');
assert(!fs.existsSync(reportFile),'Observe the existing run; this script must not redispatch');
const project=path.join(previous.profile,'projects',previous.projectId);
const before=JSON.parse(fs.readFileSync(path.join(project,'graphics/workspace.json'),'utf8'));
assert.deepEqual(before,previous.after);
const candidate=before.versions.find(v=>v.id===proposal.candidateVersionId);
const inspection=before.autoRigRuns.find(r=>r.id===proposal.inspectionRunId);
assert(candidate&&inspection?.state==='review'&&inspection.operation==='inspect');
assert.equal(inspection.source.sha256,proposal.sourceSha256);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const file of previous.originalFiles)assert.equal(sha(file.path),file.sha256);
const repairs=proposal.repairs.map(({vertexIndices,...repair})=>repair);
const report={at:new Date().toISOString(),profile:previous.profile,projectId:previous.projectId,objectId:previous.objectId,sourceCandidateId:candidate.id,inspectionId:inspection.id,repairs,before,events:[],AI:0,paidAPI:0,productionGPT:0};
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2));save();
const env={...process.env,PARTSMITH_DATA:previous.profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.resolve('release/0.7.0-preview.43/win-unpacked/Partsmith.exe'),args:['--remote-debugging-port=19346'],env});
let page,dispatched=false,terminal=false;
try{
 report.runtime=await app.evaluate(({app,session,BrowserWindow})=>{global.fetch=async()=>{throw Error('External forbidden')};session.defaultSession.webRequest.onBeforeRequest((q,cb)=>cb({cancel:/^https?:/.test(q.url)}));for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);return{version:app.getVersion(),packaged:app.isPackaged};});
 assert.deepEqual(report.runtime,{version:'0.7.0-preview.43',packaged:true});
 report.asarSha256=sha('release/0.7.0-preview.43/win-unpacked/resources/app.asar');
 page=await app.firstWindow();await page.setViewportSize({width:1440,height:1100});page.setDefaultTimeout(15000);
 const state=async()=>(await page.evaluate(()=>window.desktop.call({type:'state'}))).graphicsWorkspaces.find(w=>w.projectId===previous.projectId);
 const click=async(locator,label)=>{await locator.scrollIntoViewIfNeeded();assert(await locator.isVisible());assert(await locator.isEnabled());await locator.click();report.events.push({label,at:new Date().toISOString()});save();};
 await click(page.locator(`[data-project-id="${previous.projectId}"]`).getByTestId('project-open'),'open existing isolated project');
 await click(page.getByTestId('graphics-object-'+previous.objectId),'select multipart object');
 await click(page.getByRole('navigation',{name:'제작 단계',exact:true}).getByRole('button',{name:/리깅/}).first(),'rig settings');
 const history=page.locator('.gs-version-history');if(!await history.getAttribute('open'))await click(history.locator('summary'),'open result history');
 await click(page.getByTestId('graphics-version-'+candidate.id),'show exact original rig');
 const panel=page.getByTestId('graphics-auto-rig'),details=panel.locator('details').filter({has:page.locator('summary',{hasText:'선택 영역만 가중치 보정'})});
 if(!await details.getAttribute('open'))await click(details.locator('summary'),'open bounded correction');
 for(let i=0;i<proposal.repairs.length;i++){
  const item=proposal.repairs[i];
  await details.getByLabel('보정 대상 부위',{exact:true}).selectOption(JSON.stringify([item.mesh,item.islandId]));
  await details.getByLabel('가중치 보정 방식',{exact:true}).selectOption('remove-influence');
  await page.getByText('선택 부위 강조 · '+item.vertexIndices.length+'개 원본 정점',{exact:true}).waitFor();
  for(const bone of item.bones)await details.getByLabel('제거할 뼈 '+bone,{exact:true}).check();
  assert.equal(await page.locator('.viewport-error').count(),0);
  await page.screenshot({path:path.join(dir,'region-'+(i+1)+'-confirmed.png')});
  await click(details.getByRole('button',{name:'보정 목록에 추가',exact:true}),'confirm exact island '+item.islandId+' / '+item.bones.join(','));
  assert.match(await page.getByTestId('auto-rig-correction-queue').innerText(),new RegExp('선택 '+(i+1)+'개'));
 }
 assert.deepEqual(await state(),before);
 const queue=page.getByTestId('auto-rig-correction-queue');
 assert.match(await queue.innerText(),/선택 4개 · 총 72정점/);
 report.queueText=await queue.innerText();await page.screenshot({path:path.join(dir,'queued-four.png')});
 const submit=queue.getByRole('button',{name:'선택 4개 · 총 72정점 보정 후보 만들기',exact:true});
 report.dispatchAt=new Date().toISOString();save();dispatched=true;
 await click(submit,'ONE local repair of the four confirmed islands');
 let last=0;
 for(;;){const w=await state(),added=w.autoRigRuns.filter(r=>!before.autoRigRuns.some(old=>old.id===r.id));assert(added.length<=1);if(added.length){report.run=added[0];assert.equal(report.run.operation,'repair');assert.equal(report.run.sourceVersionId,candidate.id);assert.deepEqual(report.run.repairs,repairs);save();if(report.run.state!=='running'){terminal=true;report.after=w;break;}if(Date.now()-last>15000){last=Date.now();console.log(JSON.stringify({runId:report.run.id,state:report.run.state,message:report.run.message}));}}await page.waitForTimeout(500);}
 assert.equal(report.run.state,'review',report.run.error);
 assert.deepEqual(report.after.objects,before.objects);assert.deepEqual(report.after.tasks,before.tasks);assert.deepEqual(report.after.deliveries,before.deliveries);
 for(const old of before.autoRigRuns)assert.deepEqual(report.after.autoRigRuns.find(r=>r.id===old.id),old);
 for(const old of before.versions)assert.deepEqual(report.after.versions.find(v=>v.id===old.id),old);
 const versions=report.after.versions.filter(v=>!before.versions.some(old=>old.id===v.id));assert.equal(versions.length,1);assert.equal(versions[0].id,report.run.candidateVersionId);
 report.candidate=versions[0];report.candidateFiles=versions[0].files.map(file=>({...file,absolutePath:path.join(project,file.path)}));
 for(const file of [...previous.originalFiles,...report.candidateFiles.map(f=>({...f,path:f.absolutePath}))])assert.equal(sha(file.path),file.sha256);
 await page.getByTestId('auto-rig-review').waitFor();await page.screenshot({path:path.join(dir,'new-candidate.png')});
 report.passedAt=new Date().toISOString();save();console.log(JSON.stringify({passed:true,runId:report.run.id,candidateId:report.candidate.id,files:report.candidateFiles}));
}catch(error){report.failure=String(error);report.body=await page?.locator('body').innerText().catch(()=>null);save();if(dispatched&&!terminal){console.error('Keep same app / port 19346 for observation; never redispatch');await new Promise(()=>{});}throw error;}
finally{if(!dispatched||terminal)await app.close();}
