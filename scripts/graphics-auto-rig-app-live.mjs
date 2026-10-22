/** New isolated profile only. Invoke with node --import tsx; no AI inference or network. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';
import binary from 'electron';
import {Store} from '../engine/store.ts';
import {Engine} from '../engine/engine.ts';
import {defaultCreation} from '../shared/graphics-creation.ts';

const runtime=path.resolve('artifacts/runtime'),fixturePath=path.join(runtime,'graphics-auto-rig-app-fixture.json'),evidencePath=path.join(runtime,'graphics-auto-rig-app-live.json');
const mode=process.argv[2]??'fixture';
assert(['fixture','inspect','inspect-candidate','repair','adopt','delivery','restart','read','review','region','packaged-restart'].includes(mode));
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const save=(f,v)=>fs.writeFileSync(f,JSON.stringify(v,null,2));
if(mode==='fixture'){
  assert(!fs.existsSync(fixturePath),'Reuse recorded fixture instead of duplicating it');
  const original=path.join(runtime,'graphics-arp-knee-ornament-result','human-rig-revised.blend');
  assert.equal(sha(original),'a4cf973b2f9c9a849870848b0921d066e7a834f5c443f8d9867dc58c2946735f');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-auto-rig-app-')),profile=path.join(root,'profile'),unity=path.join(root,'Unity');
  const store=new Store(profile);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  store.settings={...store.settings,unityPath:unity,blenderPath:'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe'};
  const project=new Engine(store,{}).create('자동 리그 선택 보정 · 격리 검증');
  const creation=defaultCreation('character');creation.subject='human';creation.parts=[];
  const source={path:'assets/existing-approved-rig.blend',sha256:sha(original),bytes:fs.statSync(original).size,kind:'blend'};
  store.write(project.id,source.path,fs.readFileSync(original));
  const version={id:'existing-arp-copy',objectId:'human-copy',role:'rig',slot:'main',label:'기존 ARP 리그 · 격리 검사 사본',files:[source],createdAt:new Date().toISOString(),sourceVersionIds:[],provenance:{type:'import'},warnings:['기존 후보를 복사한 검증용 사본']};
  const workspace={schemaVersion:1,id:project.id,projectId:project.id,revision:1,objects:[{id:'human-copy',name:'사람 리그 검사 사본',kind:'character',createdAt:version.createdAt,selectedTasks:[],instruction:'',settings:{rigType:'humanoid',rigFingers:true},references:[],accepted:{'rig:main':version.id},creation}],versions:[version],tasks:[],deliveries:[]};
  store.put('graphics',project.id,workspace);store.write(project.id,'graphics/workspace.json',JSON.stringify(workspace,null,2));
  const put=(rel,bytes)=>{const f=path.join(unity,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,bytes);};
  put('ProjectSettings/ProjectVersion.txt','m_EditorVersion: 6000.3.21f1\n');
  put('Packages/manifest.json',JSON.stringify({dependencies:{'com.unity.render-pipelines.universal':'17.3.0','com.unity.modules.animation':'1.0.0','com.unity.modules.imageconversion':'1.0.0','com.unity.modules.jsonserialize':'1.0.0','com.unity.modules.physics':'1.0.0','com.unity.modules.uielements':'1.0.0'}}));
  fs.cpSync('C:/Unity/3D Tool Test/Assets/Settings',path.join(unity,'Assets/Settings'),{recursive:true});
  for(const name of ['GraphicsSettings.asset','QualitySettings.asset'])put('ProjectSettings/'+name,fs.readFileSync(path.join('C:/Unity/3D Tool Test/ProjectSettings',name)));
  const fixture={root,profile,unity,projectId:project.id,objectId:'human-copy',sourceVersionId:version.id,projectRoot:store.directory(project.id),sourceFiles:[source],original,originalSha256:sha(original),createdAt:new Date().toISOString()};
  save(fixturePath,fixture);console.log(JSON.stringify(fixture));process.exit(0);
}
const fixture=read(fixturePath),report=fs.existsSync(evidencePath)?read(evidencePath):{fixture,events:[],paidSubmissions:0,productionGPT:0};
assert(path.basename(fixture.root).startsWith('ps-auto-rig-app-'));assert(path.resolve(fixture.profile).startsWith(path.resolve(fixture.root)+path.sep));
assert.equal(sha(fixture.original),fixture.originalSha256);
for(const file of fixture.sourceFiles)assert.equal(sha(path.join(fixture.projectRoot,file.path)),file.sha256);
const bootstrap=path.join(fixture.root,'app-bootstrap.cjs');
fs.writeFileSync(bootstrap,`const {app,dialog}=require('electron');app.setAppPath(${JSON.stringify(process.cwd())});process.chdir(${JSON.stringify(process.cwd())});global.fetch=async()=>{throw Error('Network forbidden in isolated auto-rig validation')};dialog.showErrorBox=(a,b)=>{console.error(a,b);app.exit(1)};app.on('browser-window-created',(_,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);w.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:/^https?:/.test(d.url)}))});require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});`);
const env={...process.env,PARTSMITH_DATA:fixture.profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
const packaged=mode==='packaged-restart';
const packageVersion='0.7.0-preview.31',packageRoot=path.resolve('release',packageVersion,'win-unpacked');
const persistedBefore=packaged?read(path.join(fixture.projectRoot,'graphics/workspace.json')):undefined;
const stableSnapshot=w=>({runs:w.autoRigRuns,accepted:w.objects.map(o=>({id:o.id,accepted:o.accepted})),versions:w.versions});
const packagedFiles=packaged?[...new Map([...persistedBefore.versions.flatMap(v=>v.files),...(persistedBefore.autoRigRuns??[]).flatMap(run=>[run.source,...run.files,...(run.reportFile?[run.reportFile]:[])])].map(f=>[f.path,f])).values()].map(f=>({...f,actualSha256:sha(path.join(fixture.projectRoot,f.path))})):[];
const app=await electron.launch({executablePath:packaged?path.join(packageRoot,'Partsmith.exe'):binary,args:packaged?[]:[bootstrap],env,timeout:30000});
let debugPage;const errors=[];
try{
 if(packaged){
  const metadata=await app.evaluate(({app,session})=>{
   globalThis.fetch=async()=>{throw Error('Network forbidden in isolated packaged restart')};
   session.defaultSession.webRequest.onBeforeRequest((request,callback)=>callback({cancel:/^https?:/.test(request.url)}));
   return {isPackaged:app.isPackaged,version:app.getVersion()};
  });
  assert.deepEqual(metadata,{isPackaged:true,version:packageVersion});report.packaged=metadata;
 }
 const page=await app.firstWindow();debugPage=page;page.on('pageerror',e=>errors.push(e.message));
 const state=()=>page.evaluate(()=>window.desktop.call({type:'state'}));
 const workspace=async()=>{const s=await state();assert.equal(path.resolve(s.dataDir),path.resolve(fixture.profile));const w=s.graphicsWorkspaces.find(w=>w.projectId===fixture.projectId);assert(w);return w;};
 const action=async a=>page.evaluate(({id,action})=>window.desktop.call({type:'graphics.action',id,action}),{id:fixture.projectId,action:a});
 const wait=async predicate=>{const end=Date.now()+240000;while(Date.now()<end){const w=await workspace();if(predicate(w))return w;await new Promise(r=>setTimeout(r,500));}throw Error('Isolated auto-rig state timeout');};
 await page.getByRole('button',{name:'새 프로젝트',exact:true}).waitFor();
 await page.locator(`[data-project-id="${fixture.projectId}"]`).getByTestId('project-open').click();
 await page.getByTestId('graphics-studio').waitFor();await page.getByTestId('graphics-object-'+fixture.objectId).click();
 const stage=page.getByRole('navigation',{name:'제작 단계',exact:true}).getByRole('button',{name:/리깅|리그/});
 if(await stage.count())await stage.first().click();
 let w=await workspace();const acceptedBefore=structuredClone(w.objects[0].accepted),taskCount=w.tasks.length;
 if(packaged){
  assert.deepEqual(stableSnapshot(w),stableSnapshot(persistedBefore));assert(w.autoRigRuns.every(run=>run.state!=='running'));
  await new Promise(r=>setTimeout(r,3000));w=await workspace();assert.deepEqual(stableSnapshot(w),stableSnapshot(persistedBefore));
  for(const f of packagedFiles){assert.equal(f.actualSha256,f.sha256);assert.equal(sha(path.join(fixture.projectRoot,f.path)),f.sha256);}
  const workerPath=path.join(packageRoot,'resources/integrations/blender/graphics_auto_rig.py');assert.equal(sha(workerPath),sha(path.resolve('integrations/blender/graphics_auto_rig.py')));
  const packageEvidence={fixture,metadata:report.packaged,unchangedRuns:true,unchangedAcceptance:true,unchangedVersions:true,registeredFiles:packagedFiles.length,registeredFilesExact:true,workerSha256:sha(workerPath),noAutoRerun:true,paidSubmissions:0,productionGPT:0,checkedAt:new Date().toISOString()};
  save(path.join(runtime,'graphics-auto-rig-packaged-restart.json'),packageEvidence);
 }
 if(mode==='review'){
  await page.setViewportSize({width:1440,height:1100});
  await page.getByTestId('auto-rig-review').getByRole('button',{name:'3D 결과 보기',exact:true}).click();
  const viewport=page.locator('.inspection-viewport').first();const playback=viewport.locator('.playback');
  await playback.locator('select').waitFor();const clips=await playback.locator('option').allTextContents();assert.equal(clips.length,4);
  const skeleton=viewport.getByRole('button',{name:/뼈대 ON/});if(await skeleton.count())await skeleton.click();
  await viewport.getByRole('button',{name:'+Z 방향',exact:true}).click();
  const canvas=viewport.locator('.canvas');const box=await canvas.boundingBox();assert(box);await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-300);await new Promise(r=>setTimeout(r,300));
  const fullInfluences=Number(await viewport.getAttribute('data-full-skin-influences'));assert(fullInfluences>4,'Actual preview must retain all influences');
  report.preview={clips,fullInfluences,samples:[]};
  for(const clip of clips){await playback.locator('select').selectOption({label:clip});await new Promise(r=>setTimeout(r,650));
   for(const [name,label] of [['material','재질 보기'],['solid','단색 보기']]){await viewport.getByRole('button',{name:label,exact:true}).click();await viewport.screenshot({path:path.join(runtime,'graphics-auto-rig-app-review-'+clips.indexOf(clip)+'-'+name+'.png')});}
   await viewport.getByTestId('viewport-wire-toggle').click();await viewport.screenshot({path:path.join(runtime,'graphics-auto-rig-app-review-'+clips.indexOf(clip)+'-wire.png')});await viewport.getByTestId('viewport-wire-toggle').click();
   report.preview.samples.push({clip,at:new Date().toISOString()});
  }
  await playback.locator('button').click();await playback.locator('button').click();assert.equal(await viewport.locator('.viewport-error').count(),0);assert.deepEqual(w.objects[0].accepted,acceptedBefore);
 }
 if(mode==='inspect'){
  assert(!report.inspectionRunId,'Inspect once; reuse saved inspection');
  const details=page.getByTestId('graphics-auto-rig').locator('details').filter({has:page.locator('summary',{hasText:'선택 영역만 가중치 보정'})});
  await details.locator('summary').click();await details.getByRole('button',{name:'부위·뼈 영향 검사',exact:true}).click();
  w=await wait(w=>(w.autoRigRuns??[]).some(r=>r.operation==='inspect'&&r.state!=='running'));
  const run=w.autoRigRuns.filter(r=>r.operation==='inspect').at(-1);assert.equal(run.state,'review',run.error);assert(run.inspection.islands.length);
  report.inspectionRunId=run.id;report.inspection=run;assert.deepEqual(w.objects[0].accepted,acceptedBefore);
 }
 if(mode==='inspect-candidate'){
  assert(report.candidate&&!report.candidateInspection,'Inspect existing candidate once with current worker');
  await page.getByTestId('auto-rig-review').getByRole('button',{name:'3D 결과 보기',exact:true}).click();
  const details=page.getByTestId('graphics-auto-rig').locator('details').filter({has:page.locator('summary',{hasText:'선택 영역만 가중치 보정'})});
  await details.locator('summary').click();await details.getByRole('button',{name:'부위·뼈 영향 검사',exact:true}).click();
  w=await wait(w=>(w.autoRigRuns??[]).some(r=>r.sourceVersionId===report.candidate.id&&r.operation==='inspect'&&r.state!=='running'));
  const run=w.autoRigRuns.filter(r=>r.sourceVersionId===report.candidate.id&&r.operation==='inspect').at(-1);assert.equal(run.state,'review',run.error);
  assert(run.inspection.islands.every(i=>Array.isArray(i.vertexIndices)));report.candidateInspection=run;assert.deepEqual(w.objects[0].accepted,acceptedBefore);
 }
 if(mode==='region'){
  await page.setViewportSize({width:1440,height:1100});
  assert(report.candidateInspection);const beforeFiles=JSON.stringify(report.candidate.files);
  await page.getByTestId('auto-rig-review').getByRole('button',{name:'3D 결과 보기',exact:true}).click();
  const details=page.getByTestId('graphics-auto-rig').locator('details').filter({has:page.locator('summary',{hasText:'선택 영역만 가중치 보정'})});
  await details.locator('summary').click();await details.getByLabel('보정 대상 부위').selectOption(JSON.stringify([report.selectedIsland.mesh,report.selectedIsland.islandId]));
  const notice=page.getByTestId('viewport-rig-inspection-preview');await notice.waitFor();
  const region=page.getByTestId('viewport-rig-region');await region.filter({hasText:'선택 부위 강조 · 8개 원본 정점'}).waitFor();
  assert.equal(await details.getByRole('button',{name:'선택 부위 보정 후보 만들기',exact:true}).isEnabled(),true);
  w=await workspace();assert.equal(JSON.stringify(w.versions.find(v=>v.id===report.candidate.id).files),beforeFiles);assert.deepEqual(w.objects[0].accepted,acceptedBefore);
  report.region={message:await region.innerText(),notice:await notice.innerText(),inspectionRunId:report.candidateInspection.id,candidateFilesExact:true,noRepairDispatched:true};
  const viewport=page.locator('.inspection-viewport').first();const skeleton=viewport.getByRole('button',{name:/뼈대 ON/});if(await skeleton.count())await skeleton.click();
  await viewport.getByRole('button',{name:'+Z 방향',exact:true}).click();await region.scrollIntoViewIfNeeded();
  await viewport.screenshot({path:path.join(runtime,'graphics-auto-rig-app-region-close.png')});
 }
 if(mode==='repair'){
  assert(report.inspectionRunId&&!report.candidate,'Use exact saved inspection once');
  const run=w.autoRigRuns.find(r=>r.id===report.inspectionRunId);assert.equal(run.state,'review');
  // Bounded test-only rigid binding to a currently dominant DEFORM bone, on a real accessory.
  const island=run.inspection.islands.filter(i=>i.vertices>=3&&i.vertices<=40&&i.bones.filter(b=>run.inspection.boneNames.includes(b.name)&&b.meanWeight>0).length>1).sort((a,b)=>a.vertices-b.vertices)[0];assert(island);
  const targetBone=island.bones.filter(b=>run.inspection.boneNames.includes(b.name)).sort((a,b)=>b.meanWeight-a.meanWeight)[0].name;
  const details=page.getByTestId('graphics-auto-rig').locator('details').filter({has:page.locator('summary',{hasText:'선택 영역만 가중치 보정'})});
  if(!await details.getByLabel('보정 대상 부위').isVisible())await details.locator('summary').click();
  await details.getByLabel('보정 대상 부위').selectOption(JSON.stringify([island.mesh,island.islandId]));
  await details.getByLabel('가중치 보정 방식').selectOption('rigid-bind');
  await details.getByLabel('보정 기준 뼈').selectOption(targetBone);
  await details.getByRole('button',{name:'선택 부위 보정 후보 만들기',exact:true}).click();
  w=await wait(w=>(w.autoRigRuns??[]).some(r=>r.operation==='repair'&&r.state!=='running'));
  const repair=w.autoRigRuns.filter(r=>r.operation==='repair').at(-1);assert.equal(repair.state,'review',repair.error);
  const candidate=w.versions.find(v=>v.id===repair.candidateVersionId);assert(candidate?.autoRig?.exportFbx);report.repair=repair;report.candidate=candidate;report.selectedIsland=island;report.targetBone=targetBone;
  assert.deepEqual(w.objects[0].accepted,acceptedBefore);
 }
 if(mode==='adopt'){
  assert(report.candidate);await page.getByTestId('auto-rig-adopt').click();w=await wait(w=>w.objects[0].accepted['rig:main']===report.candidate.id);report.acceptedVersionId=w.objects[0].accepted['rig:main'];
 }
 if(mode==='delivery'){
  assert.equal(w.objects[0].accepted['rig:main'],report.candidate.id);
  if(report.delivery){
   const receiptFile=path.join(fixture.unity,'Library/PartsmithGraphicsResults',report.delivery.id+'.json');
   if(fs.existsSync(receiptFile))report.delivery.actualReceipt=read(receiptFile);
   assert(['failed','conflict'].includes(report.delivery.actualReceipt?.status??report.delivery.status),'Do not duplicate completed/queued delivery');
   (report.previousDeliveries??=[]).push(report.delivery);delete report.delivery;
  }
  for(const task of w.tasks.filter(t=>t.taskId==='X05'&&['running','awaiting_approval','submission_unknown'].includes(t.status))){
   const receiptFile=path.join(fixture.unity,'Library/PartsmithGraphicsResults',task.deliveryId+'.json');
   assert(fs.existsSync(receiptFile)&&read(receiptFile).status==='conflict','Only explicitly conflicted isolated request can be stopped before a new frozen target');
   await action({kind:'cancel',taskId:task.id});
  }
  await action({kind:'inspect-target'});await action({kind:'prepare',objectId:fixture.objectId,taskId:'X05'});
  w=await workspace();const task=w.tasks.filter(t=>t.taskId==='X05').at(-1);assert.equal(task.status,'awaiting_approval',task.message);
  await action({kind:'approve',taskId:task.id});w=await wait(w=>!!w.tasks.find(t=>t.id===task.id)?.deliveryId);
  report.deliveryTask=w.tasks.find(t=>t.id===task.id);report.delivery=w.deliveries.find(d=>d.id===report.deliveryTask.deliveryId);assert(report.delivery);
 }
 if(mode!=='delivery')assert.equal(w.tasks.length,taskCount);
 assert.equal(w.tasks.filter(t=>t.provider==='Tripo API'||t.paidApproval).length,0);
 report.events.push({mode,at:new Date().toISOString(),runs:(w.autoRigRuns??[]).map(r=>({id:r.id,state:r.state,operation:r.operation})),accepted:w.objects[0].accepted});
 if(report.harnessFailure){(report.previousHarnessFailures??=[]).push(report.harnessFailure);delete report.harnessFailure;}
 report.errors=errors;report.lastWorkspace=w;save(evidencePath,report);
 await page.screenshot({path:path.join(runtime,'graphics-auto-rig-app-'+mode+'.png')});
 console.log(JSON.stringify({mode,candidate:report.candidate?.id,inspection:report.inspectionRunId,delivery:report.delivery?.id,errors}));
}catch(error){report.harnessFailure={mode,error:String(error),errors,text:await debugPage?.locator('body').innerText().catch(()=>''),at:new Date().toISOString()};save(evidencePath,report);if(debugPage)await debugPage.screenshot({path:path.join(runtime,'graphics-auto-rig-app-failure.png')}).catch(()=>{});throw error;}finally{await app.close();}
