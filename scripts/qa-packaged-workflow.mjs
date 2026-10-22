/** Current packaged app, real DOM commands, isolated data. Never approves a paid task. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';
import electronBinary from 'electron';
const repo=process.cwd(), out=path.join(repo,'artifacts/runtime/qa-20261018-app');fs.mkdirSync(out,{recursive:true});
const source=process.env.PARTSMITH_QA_SOURCE==='1';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const packageVersion=read('package.json').version, executable=path.resolve(`release/${packageVersion}/win-unpacked/Partsmith.exe`);
const qaCase=process.env.PARTSMITH_QA_CASE??'';assert(/^[a-z0-9-]*$/.test(qaCase));
const evidence=path.join(out,`${source?'workflow-source':`workflow-${packageVersion}`}${qaCase?'-'+qaCase:''}.json`);
const audit=read('artifacts/runtime/qa-20261018-production.json');
const original=audit.before.records.find(r=>r.kind==='graphics'&&r.data.projectId.startsWith('caae83af')).data;
const sourceProfile=path.join(process.env.APPDATA,'partsmith/projects',original.projectId);
const model=original.versions.find(v=>v.id.startsWith('7d228d37'));
const design=original.versions.find(v=>v.id.startsWith('69e5699a'));
const files=[design.files.find(f=>f.path.endsWith('.png')),model.files.find(f=>f.path.endsWith('.fbx'))].map(f=>({...f,absolute:path.join(sourceProfile,f.path)}));
for(const f of files)assert.equal(sha(f.absolute),f.sha256);
const mode=process.argv[2]??'create';
const report=fs.existsSync(evidence)?read(evidence):{root:fs.mkdtempSync(path.join(os.tmpdir(),'ps-qa-20261018-')),events:[],files,paidSubmissions:0,productionGPT:0};
const profile=path.join(report.root,'profile');
const save=()=>fs.writeFileSync(evidence,JSON.stringify(report,null,2));save();
const env={...process.env,PARTSMITH_DATA:profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
const bootstrap=path.join(report.root,'qa-bootstrap.cjs');
if(source)fs.writeFileSync(bootstrap,`const{app}=require('electron');app.setAppPath(${JSON.stringify(repo)});process.chdir(${JSON.stringify(repo)});global.fetch=async()=>{throw Error('QA external network forbidden')};app.on('browser-window-created',(_,w)=>{w.webContents.setBackgroundThrottling(false);w.once('ready-to-show',()=>w.showInactive())});require(${JSON.stringify(path.join(repo,'dist-electron/main.cjs'))});`);
const app=await electron.launch({executablePath:source?electronBinary:executable,args:source?[bootstrap]:[],env,timeout:30000});let page;
try{
 report.package=await app.evaluate(({app,BrowserWindow,session})=>{globalThis.fetch=async()=>{throw Error('QA: external fetch forbidden')};session.defaultSession.webRequest.onBeforeRequest((r,cb)=>cb({cancel:/^https?:/.test(r.url)}));for(const w of BrowserWindow.getAllWindows()){w.setTitle('Partsmith · 격리 검증');w.webContents.setBackgroundThrottling(false);w.showInactive();}return {version:app.getVersion(),isPackaged:app.isPackaged,data:app.getPath('userData')};});
 assert.equal(path.resolve(report.package.data),path.resolve(profile));assert.equal(report.package.isPackaged,!source);if(!source)assert.equal(report.package.version,packageVersion);
 report.build={source,packageVersion,mainSha256:sha(path.join(repo,'dist-electron/main.cjs'))};
 page=await app.firstWindow();page.setDefaultTimeout(15000);await page.setViewportSize({width:1440,height:1000});
 const capture=async name=>{report.layouts??={};report.layouts[name]=await page.evaluate(()=>Object.fromEntries(['.app-body','.gs-workspace','.gs-main','.gs-command-area','.gs-guide','.gs-guide-heading','.gs-result'].map(selector=>{const e=document.querySelector(selector);return[selector,e?{rect:e.getBoundingClientRect().toJSON(),scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}:null];})));save();const data=await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.showInactive();return Promise.race([w.webContents.capturePage().then(p=>p.toPNG().toString('base64')),new Promise((_,reject)=>setTimeout(()=>reject(Error('QA capture timeout')),10000))]);});fs.writeFileSync(path.join(out,name),Buffer.from(data,'base64'));};
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const state=()=>page.evaluate(()=>window.desktop.call({type:'state'}));
 const workspace=async()=>{const s=await state();assert.equal(path.resolve(s.dataDir),path.resolve(profile));return s.graphicsWorkspaces.find(w=>w.projectId===report.projectId)??{objects:[],versions:[],tasks:[],deliveries:[]};};
 const click=async(locator,label)=>{await locator.scrollIntoViewIfNeeded();assert(await locator.isVisible(),label);assert(await locator.isEnabled(),label);await locator.click();report.events.push({mode,label,at:new Date().toISOString()});save();};
 const wait=async(predicate,label)=>{const end=Date.now()+180000;while(Date.now()<end){const w=await workspace();if(predicate(w))return w;await new Promise(r=>setTimeout(r,300));}throw Error('Timeout '+label);};
 const history=async()=>{const summary=page.locator('.gs-version-history > summary');if(await summary.count()&&(await page.locator('.gs-version-history').getAttribute('open'))===null)await click(summary,'결과 기록 열기');};
 if(mode==='create'){
  if(!report.projectId){
  await click(page.getByRole('button',{name:/^새 오브젝트 만들기/}),'home new object');
  if(await page.getByRole('dialog').getByRole('button',{name:'새 프로젝트 만들기',exact:true}).count())await click(page.getByRole('dialog').getByRole('button',{name:'새 프로젝트 만들기',exact:true}),'choose new project');
  const dialog=page.getByRole('dialog');await dialog.locator('input').first().fill('앱 전체 점검 · 격리 프로젝트');
  const demo=dialog.getByRole('checkbox');if(await demo.isChecked())await demo.uncheck();
  await click(dialog.getByRole('button',{name:/프로젝트 만들기/}),'create isolated project');
  const s=await state();assert.equal(s.projects.length,1);report.projectId=s.projects[0].id;save();
  }else{
   await click(page.locator(`[data-project-id="${report.projectId}"]`).getByTestId('project-open'),'resume saved empty QA project');
   await click(page.getByTestId('graphics-new-object'),'open preserved object draft');
  }
  const create=page.getByTestId('graphics-create-dialog');await create.waitFor();
  await click(create.getByRole('button',{name:'사물',exact:true}),'choose object category');
  await click(create.getByRole('button',{name:'상자·용기',exact:true}),'choose crate');
  await click(create.getByRole('button',{name:'상자·용기',exact:true}),'toggle crate off');
  assert(await create.getByRole('button',{name:'오브젝트 만들기',exact:true}).isDisabled());
  await click(create.getByRole('button',{name:'상자·용기',exact:true}),'choose crate again');
  await create.getByLabel('이름',{exact:true}).fill('검증 상자');
  await click(create.getByRole('button',{name:'취소',exact:true}),'cancel draft');
  assert.equal((await workspace()).objects.length,0);
  await click(page.getByTestId('graphics-new-object'),'reopen object draft');
  assert.equal(await create.getByLabel('이름',{exact:true}).inputValue(),'검증 상자');
  await click(create.getByRole('button',{name:'오브젝트 만들기',exact:true}),'create crate');
  const w=await wait(w=>w.objects.length===1,'crate exists');report.objectId=w.objects[0].id;assert.equal(w.objects[0].creation.subject,'box');save();
 }else{
  await click(page.locator(`[data-project-id="${report.projectId}"]`).getByTestId('project-open'),'open QA project');
  await click(page.getByTestId('graphics-object-'+report.objectId),'select QA crate');
 }
 if(mode==='create'||mode==='import'){
  const w0=await workspace();
  for(const [index,role] of ['design','model'].entries()){
   let v=w0.versions.filter(v=>v.role===role).at(-1);
   if(!v){
   const details=page.locator('.gs-import-details');if((await details.getAttribute('open'))===null)await click(details.locator('summary'),'open import options');
   await page.getByLabel('가져올 자료의 역할').selectOption(role);
   await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},files[index].absolute);
   await click(page.getByTestId('graphics-import'),'import '+role+' through file dialog result');
   let w=await wait(w=>w.versions.some(v=>v.role===role),'import '+role);v=w.versions.filter(v=>v.role===role).at(-1);
   assert.equal(Object.values(w.objects[0].accepted).includes(v.id),false,'Import must not auto adopt');
   if(role==='model'){
    w=await wait(w=>w.versions.find(row=>row.id===v.id)?.files.some(f=>f.kind==='preview'&&/\.glb$/i.test(f.path)),'automatic imported model preview');
    v=w.versions.find(row=>row.id===v.id);report.automaticPreviewReady=true;
   }
   }
   report[role+'Version']=v;save();
   await history();await click(page.getByTestId('graphics-version-'+v.id),'preview imported '+role);
   await capture(role+'-imported.png');
   const primary=page.getByTestId('graphics-guide-primary');report[role+'Primary']=await primary.innerText();save();
   if(role==='design'&&(await workspace()).objects[0].accepted['design:main']!==v.id){
    assert.match(await primary.innerText(),/이 이미지 사용/);await click(primary,'use imported design; next settings only');
    await wait(w=>w.objects[0].accepted['design:main']===v.id,'design adoption');
   }
  }
 }
 if(mode==='settings'){
  const before=await workspace();
  await click(page.getByRole('button',{name:'2 모델',exact:true}),'open model settings');
  const geometry=page.getByTestId('model-geometry-settings'),faces=page.getByTestId('model-face-count'),slider=page.getByTestId('model-face-slider');
  await geometry.getByLabel('모델 제작 모델').selectOption('P2-20260801');
  assert.equal(await faces.inputValue(),'5000');
  const quad=geometry.getByRole('button',{name:'쿼드',exact:true}),tri=geometry.getByRole('button',{name:'삼각형',exact:true});
  assert.equal(await quad.getAttribute('aria-pressed'),'true');
  await click(quad,'clear topology');assert.equal(await quad.getAttribute('aria-pressed'),'false');
  assert(await page.getByTestId('graphics-prepare').isDisabled(),'Incomplete topology must block new generation');
  await click(tri,'triangle topology');assert.equal(await slider.getAttribute('max'),'50000');
  await slider.focus();await slider.press('End');assert.equal(await faces.inputValue(),'50000');
  await click(quad,'quad clamps explicit upper target');assert.equal(await faces.inputValue(),'25000');
  await geometry.getByLabel('모델 제작 모델').selectOption('P1-20260311');assert.equal(await faces.inputValue(),'20000');assert(await quad.isDisabled());
  await geometry.getByLabel('모델 제작 모델').selectOption('P2-20260801');await click(quad,'return quad');
  await faces.fill('7300');assert.equal(await slider.inputValue(),'7300');
  await page.getByLabel('후보 개수',{exact:true}).fill('2');
  await page.getByLabel('실제 크기 모드').selectOption('uniform');await page.getByLabel('크기 기준 축').selectOption('x');
  await page.getByLabel('기준 길이 미터').fill('');assert(await page.getByRole('button',{name:'크기 설정 저장 · 생성 없음',exact:true}).isDisabled());
  await page.getByLabel('기준 길이 미터').fill('2.5');await page.getByLabel('크기 피벗').selectOption('bottom-center');
  await click(page.getByRole('button',{name:'크기 설정 저장 · 생성 없음',exact:true}),'save settings without generation');
  const saved=await wait(w=>w.objects[0].creation.physicalSize.lengthMeters===2.5,'physical settings saved');
  const creation=saved.objects[0].creation;assert.equal(creation.stageSettings.model.values.faceLimit,7300);assert.equal(creation.stageSettings.model.values.quad,true);assert.equal(creation.stageSettings.model.values.count,2);
  assert.deepEqual(saved.objects[0].accepted,before.objects[0].accepted);assert.equal(saved.tasks.length,before.tasks.length);assert.equal(saved.versions.length,before.versions.length);
  report.savedSettings=creation;await capture('settings-saved.png');
 }
 if(mode==='settings-restart'){
  const after=await workspace();assert.deepEqual(after.objects[0].creation,report.savedSettings);
  await click(page.getByRole('button',{name:'2 모델',exact:true}),'reopen model settings after restart');
  assert.equal(await page.getByTestId('model-face-count').inputValue(),'7300');assert.equal(await page.getByLabel('후보 개수',{exact:true}).inputValue(),'2');
  assert.equal(await page.getByLabel('기준 길이 미터').inputValue(),'2.5');assert.equal(await page.getByLabel('크기 피벗').inputValue(),'bottom-center');
 }
 if(['preview','planar','repair'].includes(mode)){
  await history();await click(page.getByTestId('graphics-version-'+report.modelVersion.id),'show exact imported native model');
  const before=await workspace();
  if(await page.getByTestId('graphics-prepare-import-preview').count()){
   await click(page.getByTestId('graphics-prepare-import-preview'),'prepare local preview of preserved import');
   await wait(w=>w.versions.find(v=>v.id===report.modelVersion.id).files.some(f=>/\.glb$/i.test(f.path)),'local preview ready');
  }
  await page.getByTestId('viewport-wire-toggle').waitFor({timeout:30000});assert.equal(await page.locator('.viewport-error').count(),0);
  await click(page.getByTestId('viewport-wire-toggle'),'show local mesh edges');
  await click(page.getByRole('button',{name:'단색 보기',exact:true}),'show solid shading');
  const after=await workspace();assert.deepEqual(after.objects[0].accepted,before.objects[0].accepted);assert.equal(after.versions.length,before.versions.length);
  const restored=after.versions.find(v=>v.id===report.modelVersion.id);for(const f of report.modelVersion.files)assert(restored.files.some(g=>g.path===f.path&&g.sha256===f.sha256));
  report.previewVersion=restored;await capture('model-preview-ready.png');
  if(mode==='planar'||mode==='repair'){
   await click(page.getByRole('button',{name:'수정하기',exact:true}),'open local edit actions');await click(page.getByRole('button',{name:'빠진 면 검사',exact:true}),'open planar review');
   const panel=page.getByTestId('graphics-planar-review');
   if(!(await workspace()).planarInspections?.[restored.id])await click(panel.getByRole('button',{name:'이 원본의 빠진 면 검사',exact:true}),'inspect actual imported chest boundaries');
   const inspected=await wait(w=>!!w.planarInspections?.[restored.id],'local boundary inspection');
   report.planarInspection=inspected.planarInspections[restored.id];save();await panel.getByText(/저장된 검사 ·/).waitFor();
   const repair=panel.getByRole('button',{name:'선택한 부분 복구',exact:true});
   if(mode==='planar')assert(await repair.isDisabled(),'No automatic boundary selection');
   await capture('planar-inspected.png');
   if(mode==='repair'){
    const existing=inspected.versions.find(v=>v.planarRepair?.versionId===restored.id);
    if(!existing){
     const boundaries=report.planarInspection.meshes[0].boundaries;assert.equal(boundaries.find(b=>b.number===5).id,'788d4f712ed75d8dd45adbf4');
     for(const b of boundaries){const box=panel.locator('.gs-planar-boundaries fieldset').filter({has:page.locator('legend',{hasText:new RegExp('영역 '+b.number+' ·')})});await box.getByRole('radio',{name:b.number===5?'막을 부분':'원래 열린 부분·유지',exact:true}).check();}
     await click(panel.getByRole('button',{name:'영역 5 확대',exact:true}),'focus known original large opening');await capture('planar-selected.png');
     await click(repair,'repair only selected original large quad locally');
    }
    const repaired=await wait(w=>w.versions.some(v=>v.planarRepair?.versionId===restored.id),'saved local planar repair');
    const result=repaired.versions.find(v=>v.planarRepair?.versionId===restored.id);report.repairVersion=result;save();
    await panel.getByRole('heading',{name:'복구본 저장됨 · 사용자 외형 검토 대기'}).waitFor({timeout:30000});
    const use=panel.getByRole('button',{name:'이 복구본 사용',exact:true});await use.waitFor();
    await capture('planar-before-after.png');await click(use,'TEST ONLY use isolated repaired result');
    await wait(w=>w.objects[0].accepted['model:main']===result.id,'exact isolated repair adoption');
   }
  }
 }
 if(mode==='unity'){
  const target=read('artifacts/runtime/qa-20261018-pose/final.json').project;
  await click(page.getByRole('button',{name:'7 Unity 전달',exact:true}),'open static Unity delivery settings');
  await click(page.getByTestId('graphics-change-unity-target'),'change actual project Unity target');
  const modal=page.getByRole('dialog',{name:'Unity 프로젝트 변경'});
  const originalTarget=(await workspace()).target;
  await modal.getByLabel('새 Unity 프로젝트 경로').fill(path.join(report.root,'not-a-Unity-project'));
  await click(modal.getByRole('button',{name:'검사하고 저장',exact:true}),'reject invalid Unity target locally');
  await modal.getByRole('alert').waitFor();assert.deepEqual((await workspace()).target,originalTarget);
  await modal.getByLabel('새 Unity 프로젝트 경로').fill(target);await click(modal.getByRole('button',{name:'검사하고 저장',exact:true}),'save validated isolated Unity target');
  await wait(w=>w.target&&path.resolve(w.target.projectPath)===path.resolve(target),'new target saved');await modal.waitFor({state:'hidden'});
  assert.match(await page.getByTestId('graphics-unity-target-path').innerText(),/UnityButtons/);
  assert.equal((await workspace()).objects[0].accepted['model:main'],report.repairVersion.id);
  if(!report.deliveryTask){
   await click(page.getByTestId('graphics-guide-primary'),'prepare exact repaired chest Unity delivery');
   const prepared=await wait(w=>w.tasks.some(t=>t.taskId==='X05'),'local delivery approval');
   const task=prepared.tasks.filter(t=>t.taskId==='X05').at(-1);assert.equal(task.status,'awaiting_approval',task.message);assert.equal(path.resolve(task.targetProfile.projectPath),path.resolve(target));assert(task.inputVersionIds.includes(report.repairVersion.id));
   report.deliveryTask=task;save();
  }
  const task=(await workspace()).tasks.find(t=>t.id===report.deliveryTask.id);
  assert(await page.getByTestId('graphics-change-unity-target').isDisabled(),'Frozen pending delivery target cannot change');
  if(task.status==='awaiting_approval'){await capture('unity-approval.png');await click(page.getByTestId('graphics-guide-primary'),'approve local-only exact Unity delivery');}
  const delivered=await wait(w=>!!w.tasks.find(t=>t.id===task.id)?.deliveryId,'queued exact Unity delivery');
  report.deliveryTask=delivered.tasks.find(t=>t.id===task.id);report.delivery=delivered.deliveries.find(d=>d.id===report.deliveryTask.deliveryId);assert.equal(report.delivery.status,'queued',JSON.stringify(report.delivery.errors));save();
 }
 if(mode==='receipt'){
  await click(page.getByRole('button',{name:'7 Unity 전달',exact:true}),'review Unity receipt');
  const received=await wait(w=>w.deliveries.some(d=>d.id===report.delivery.id&&d.status==='imported'),'Unity imported receipt');
  report.receipt=received.deliveries.find(d=>d.id===report.delivery.id);assert.equal(report.receipt.playbackVerified,false);
  await page.getByText('Unity에서 확인된 가져오기 기록',{exact:true}).waitFor({timeout:30000});await capture('unity-imported.png');
 }
 const w=await workspace();report.lastWorkspace=w;assert(w.tasks.every(t=>['LOCAL_PLANAR_INSPECT','LOCAL_PLANAR_REPAIR','X05'].includes(t.taskId)&&t.localOnly),'Only explicitly verified local operations may run');
 assert.equal(w.objects.length,1);assert.equal((await state()).projects[0].jobs.length,0);assert.deepEqual(errors,[]);report.errors=errors;
 for(const f of files)assert.equal(sha(f.absolute),f.sha256);
 await capture(mode+'-final.png');report.lastMode=mode;report.passedAt=new Date().toISOString();if(report.failure)(report.priorFailures??=[]).push(report.failure);delete report.failure;save();
 console.log(JSON.stringify({mode,root:report.root,projectId:report.projectId,objects:w.objects.length,versions:w.versions.length,tasks:w.tasks.length,errors}));
}catch(error){report.failure={mode,message:String(error),body:await page?.locator('body').innerText().catch(()=>''),at:new Date().toISOString()};save();throw error;}finally{await app.close();}
