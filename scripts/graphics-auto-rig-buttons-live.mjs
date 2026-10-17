/** Saved automatic result, visible DOM actions only; state IPC is read-only. No AI rerun. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';
import {_electron as electron} from 'playwright';import binary from 'electron';import {Store} from '../engine/store.ts';
const runtime=path.resolve('artifacts/runtime'),evidencePath=path.join(runtime,'graphics-auto-rig-buttons-live.json'),oldPath=path.join(runtime,'graphics-auto-rig-start-live.json');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const mode=process.argv[2]??'review';assert(['setup','target-fixture','review','inspect','adopt','delivery','receipt','restart','packaged-restart'].includes(mode));
const original=read(oldPath),oldEvidenceSha=sha(oldPath),root=fs.realpathSync(original.root);assert(path.basename(root).startsWith('ps-auto-rig-start-'));
const stored=read(path.join(original.projectRoot,'graphics/workspace.json')),candidate=stored.versions.find(v=>v.id===original.run.candidateVersionId);assert(candidate&&candidate.id.startsWith('b005b7d1'));
for(const f of candidate.files)assert.equal(sha(path.join(original.projectRoot,f.path)),f.sha256);
const report=fs.existsSync(evidencePath)?read(evidencePath):{fixture:{...original,objectId:'human',sourceVersionId:'static-human',sourceFiles:[original.source,original.preview],original:original.sourceOriginal,originalSha256:original.source.sha256,unity:path.join(root,'UnityButtons')},candidate,events:[],paidSubmissions:0,productionGPT:0,noAiRerun:true};
const save=()=>fs.writeFileSync(evidencePath,JSON.stringify(report,null,2));
if(mode==='target-fixture'){
 const workspaceSha=sha(path.join(original.projectRoot,'graphics/workspace.json'));
 const store=new Store(report.fixture.profile);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));const project=store.project(original.projectId),previous=project.unityPath;project.unityPath=report.fixture.unity;store.save(project);
 assert.equal(sha(path.join(original.projectRoot,'graphics/workspace.json')),workspaceSha);assert.equal(sha(oldPath),oldEvidenceSha);
 report.targetFixtureCorrection={previous,unity:report.fixture.unity,at:new Date().toISOString(),beforeAppLaunch:true,workspaceUnchanged:true,description:'Corrected isolated project-specific target, which overrides its settings default. Prior target inspection was read-only; no delivery was prepared.'};save();console.log(JSON.stringify(report.targetFixtureCorrection));
 await new Promise(r=>setTimeout(r,250));process.exit(0);
}
if(mode==='setup'){
 assert(!report.setup,'Reuse initialized Unity fixture');const unity=report.fixture.unity;
 assert(path.resolve(unity).startsWith(root+path.sep));
 const put=(p,content)=>{const f=path.join(unity,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,content);};
 const reference=read('artifacts/runtime/graphics-auto-rig-app-fixture.json').unity;
 if(!fs.existsSync(unity)){
  for(const folder of ['ProjectSettings','Packages'])fs.cpSync(path.join(reference,folder),path.join(unity,folder),{recursive:true});
  fs.cpSync(path.join(reference,'Assets/Settings'),path.join(unity,'Assets/Settings'),{recursive:true});
 }else assert(fs.existsSync(path.join(unity,'ProjectSettings/ProjectVersion.txt'))&&!fs.existsSync(path.join(unity,'Assets/PartsmithGraphics')),'Existing fixture must still be unsubmitted');
 const cli=path.join(process.env.LOCALAPPDATA,'Unity/bin/unity.exe'),log=fs.createWriteStream(path.join(runtime,'graphics-auto-rig-buttons-unity-initialize.log'));
 await new Promise((resolve,reject)=>{const child=spawn(cli,['run',unity,'--format','json','--timeout','300','--','-logFile',path.join(runtime,'graphics-auto-rig-buttons-unity-initialize-editor.log')],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});child.once('error',reject);child.once('exit',code=>{log.end();code===0?resolve():reject(Error('Unity fixture initialization '+code));});});
 const store=new Store(report.fixture.profile);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));store.settings={...store.settings,unityPath:unity};
 report.setup={at:new Date().toISOString(),unity,fixtureOnly:true,description:'Initialized isolated Unity project and configured its path before app workflow; existing candidates, runs and acceptance unchanged.'};save();assert.equal(sha(oldPath),oldEvidenceSha);console.log(JSON.stringify(report.setup));process.exit(0);
}
const bootstrap=path.join(root,'buttons-bootstrap.cjs');fs.writeFileSync(bootstrap,`const {app}=require('electron');app.setAppPath(${JSON.stringify(process.cwd())});process.chdir(${JSON.stringify(process.cwd())});global.fetch=async()=>{throw Error('Network forbidden in buttons-only verification')};app.on('browser-window-created',(_,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);w.webContents.session.webRequest.onBeforeRequest((r,cb)=>cb({cancel:/^https?:/.test(r.url)}))});require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});`);
const env={...process.env,PARTSMITH_DATA:original.profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
const packaged=mode==='packaged-restart',packageRoot=path.resolve('release/0.7.0-preview.32/win-unpacked');
const app=await electron.launch({executablePath:packaged?path.join(packageRoot,'Partsmith.exe'):binary,args:packaged?[]:[bootstrap],env,timeout:30000});let page;const errors=[];
try{
 if(packaged){const metadata=await app.evaluate(({app,session})=>{globalThis.fetch=async()=>{throw Error('Network forbidden in isolated packaged verification')};session.defaultSession.webRequest.onBeforeRequest((r,cb)=>cb({cancel:/^https?:/.test(r.url)}));return {isPackaged:app.isPackaged,version:app.getVersion()};});assert.deepEqual(metadata,{isPackaged:true,version:'0.7.0-preview.32'});report.packaged=metadata;}
 page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1100});
 const workspace=async()=>{const s=await page.evaluate(()=>window.desktop.call({type:'state'}));assert.equal(path.resolve(s.dataDir),path.resolve(original.profile));return s.graphicsWorkspaces.find(w=>w.projectId===original.projectId);};
 const click=async(locator,label)=>{await locator.scrollIntoViewIfNeeded();assert(await locator.isVisible());assert(await locator.isEnabled());await locator.click();report.events.push({kind:'visible-button',label,mode,at:new Date().toISOString()});save();};
 const wait=async predicate=>{const end=Date.now()+240000;while(Date.now()<end){const w=await workspace();if(predicate(w))return w;await new Promise(r=>setTimeout(r,400));}throw Error('App state timeout');};
 await page.getByRole('button',{name:'새 프로젝트',exact:true}).waitFor();await click(page.locator(`[data-project-id="${original.projectId}"]`).getByTestId('project-open'),'open isolated project');
 await page.getByTestId('graphics-studio').waitFor();await click(page.getByTestId('graphics-object-human'),'select human');
 await click(page.getByRole('navigation',{name:'제작 단계',exact:true}).getByRole('button',{name:/리깅|리그/}).first(),'rig stage');
 const history=page.locator('.gs-version-history');await click(history.locator('summary'),'open saved result history');
 await click(page.getByTestId('graphics-version-'+candidate.id),'select exact saved automatic candidate');
 let w=await workspace();const before={runs:structuredClone(w.autoRigRuns),accepted:structuredClone(w.objects[0].accepted),files:JSON.stringify(candidate.files)};
 assert.equal(w.autoRigRuns.filter(r=>r.operation==='rig').length,3,'Never repeat AI');
 if(mode==='review'){
  await click(page.getByTestId('auto-rig-review').getByRole('button',{name:'3D 결과 보기',exact:true}),'show saved automatic result');
  const viewport=page.locator('.inspection-viewport').first(),playback=viewport.locator('.playback');await playback.locator('select').waitFor();
  const clips=await playback.locator('option').allTextContents();assert.equal(clips.length,4);const influences=Number(await viewport.getAttribute('data-full-skin-influences'));assert(influences>4);
  const bones=viewport.getByRole('button',{name:/뼈대 ON/});if(await bones.count())await click(bones,'hide bone overlay');
  await click(viewport.getByRole('button',{name:'+Z 방향',exact:true}),'front source axis');
  for(let i=0;i<clips.length;i++){await playback.locator('select').selectOption({label:clips[i]});await new Promise(r=>setTimeout(r,500));
   for(const [name,label] of [['material','재질 보기'],['solid','단색 보기']]){await click(viewport.getByRole('button',{name:label,exact:true}),label);await viewport.screenshot({path:path.join(runtime,`graphics-auto-rig-buttons-review-${i}-${name}.png`)});}
   await click(viewport.getByTestId('viewport-wire-toggle'),'wire on');await viewport.screenshot({path:path.join(runtime,`graphics-auto-rig-buttons-review-${i}-wire.png`)});await click(viewport.getByTestId('viewport-wire-toggle'),'wire off');
  }
  await click(playback.locator('button'),'pause');await click(playback.locator('button'),'play');assert.equal(await viewport.locator('.viewport-error').count(),0);report.preview={clips,influences,candidateId:candidate.id};
 }
 if(mode==='inspect'){
  await click(page.getByTestId('auto-rig-review').getByRole('button',{name:'3D 결과 보기',exact:true}),'show saved automatic result');
  const details=page.getByTestId('graphics-auto-rig').locator('details').filter({has:page.locator('summary',{hasText:'선택 영역만 가중치 보정'})});await click(details.locator('summary'),'open bounded correction options');
  if(!report.inspection)await click(details.getByRole('button',{name:'부위·뼈 영향 검사',exact:true}),'inspect existing automatic result');
  w=await wait(w=>(w.autoRigRuns??[]).some(r=>r.operation==='inspect'&&r.sourceVersionId===candidate.id&&r.state!=='running'));
  const run=w.autoRigRuns.filter(r=>r.operation==='inspect'&&r.sourceVersionId===candidate.id).at(-1);assert.equal(run.state,'review',run.error);report.inspection=run;save();
  if(!await details.getByLabel('보정 대상 부위').isVisible())await click(details.locator('summary'),'reopen correction options after inspection');
  const island=run.inspection.islands.filter(i=>i.vertices>=3&&i.vertices<=30).sort((a,b)=>a.vertices-b.vertices)[0];assert(island);await details.getByLabel('보정 대상 부위').selectOption(JSON.stringify([island.mesh,island.islandId]));
  const region=page.getByTestId('viewport-rig-region');await region.filter({hasText:`선택 부위 강조 · ${island.vertices}개 원본 정점`}).waitFor();report.selectedRegion={island,message:await region.innerText()};
  assert(await details.getByRole('button',{name:'선택 부위 보정 후보 만들기',exact:true}).isEnabled());
 }
 if(mode==='adopt'){
  assert(!w.objects[0].accepted['rig:main'],'Do not re-adopt');await click(page.getByTestId('auto-rig-adopt'),'use exact saved automatic rig');w=await wait(w=>w.objects[0].accepted['rig:main']===candidate.id);report.acceptedVersionId=candidate.id;
 }
 if(mode==='delivery'){
  assert(report.setup&&report.acceptedVersionId===candidate.id);assert(!report.delivery,'Reuse existing delivery');
  await click(page.getByRole('navigation',{name:'제작 단계',exact:true}).getByRole('button',{name:/Unity 전달/}),'Unity settings stage');
  const diagnostics=page.locator('.gs-diagnostics-disclosure');const inspect=diagnostics.getByRole('button',{name:'프로젝트 검사',exact:true});if(!await inspect.isVisible())await click(diagnostics.locator('summary').first(),'open Unity target inspection');
  await click(inspect,'inspect configured isolated Unity target');w=await wait(w=>!!w.target);assert.equal(path.resolve(w.target.projectPath),path.resolve(report.fixture.unity));
  if(await diagnostics.locator('summary').first().isVisible())await click(diagnostics.locator('summary').first(),'close Unity target inspection');
  await click(page.getByTestId('graphics-guide-primary'),'prepare Unity delivery');w=await wait(w=>w.tasks.some(t=>t.taskId==='X05'&&!before.runs.some(r=>r.id===t.id)));
  const task=w.tasks.filter(t=>t.taskId==='X05').at(-1);assert.equal(task.status,'awaiting_approval',task.message);report.deliveryTask=task;save();
  await click(page.getByTestId('graphics-guide-primary'),'approve local Unity delivery');w=await wait(w=>!!w.tasks.find(t=>t.id===task.id)?.deliveryId);report.deliveryTask=w.tasks.find(t=>t.id===task.id);report.delivery=w.deliveries.find(d=>d.id===report.deliveryTask.deliveryId);assert(report.delivery);assert.equal(report.delivery.status,'queued',JSON.stringify(report.delivery.errors));
 }
 if(mode==='receipt'){
  await click(page.getByRole('navigation',{name:'제작 단계',exact:true}).getByRole('button',{name:/Unity 전달/}),'Unity result stage');
  w=await wait(w=>w.deliveries.find(d=>d.id===report.delivery.id)?.status==='imported');report.appReceipt=w.deliveries.find(d=>d.id===report.delivery.id);assert.equal(report.appReceipt.playbackVerified,false);report.receiptMethod='Existing automatic receipt polling; no mutating IPC or GUI launch';
  await page.getByText('Unity에서 확인된 가져오기 기록',{exact:true}).waitFor();report.receiptVisibleText='Unity에서 확인된 가져오기 기록';
 }
 if(['restart','packaged-restart'].includes(mode)){
  await new Promise(r=>setTimeout(r,2500));w=await workspace();assert.deepEqual(w.autoRigRuns,before.runs);assert.deepEqual(w.objects[0].accepted,before.accepted);assert(w.autoRigRuns.every(run=>run.state!=='running'));
  for(const run of w.autoRigRuns)for(const file of [...run.files,...(run.reportFile?[run.reportFile]:[])])assert.equal(sha(path.join(original.projectRoot,file.path)),file.sha256);
  report.restart={mode,at:new Date().toISOString(),runsExact:true,acceptedExact:true,candidateFilesExact:true,noAiRerun:true,package:report.packaged};
  if(packaged){const worker=path.join(packageRoot,'resources/integrations/blender/graphics_auto_rig.py');assert.equal(sha(worker),sha('integrations/blender/graphics_auto_rig.py'));report.restart.packagedWorkerSha256=sha(worker);}
 }
 w=await workspace();assert.equal(w.autoRigRuns.filter(r=>r.operation==='rig').length,3);assert.equal(w.autoRigRuns.filter(r=>r.operation==='repair').length,0);
 if(!['inspect'].includes(mode))assert.deepEqual(w.autoRigRuns,before.runs);
 if(mode!=='adopt')assert.deepEqual(w.objects[0].accepted,before.accepted);
 assert.equal(JSON.stringify(w.versions.find(v=>v.id===candidate.id).files),before.files);for(const file of candidate.files)assert.equal(sha(path.join(original.projectRoot,file.path)),file.sha256);
 for(const file of report.fixture.sourceFiles)assert.equal(sha(path.join(original.projectRoot,file.path)),file.sha256);assert.equal(sha(original.sourceOriginal),original.source.sha256);report.sourceFilesExact=true;
 assert.equal(sha(oldPath),oldEvidenceSha);if(report.failure){(report.previousFailures??=[]).push(report.failure);delete report.failure;}report.lastWorkspace=w;report.errors=errors;report.lastMode=mode;save();await page.screenshot({path:path.join(runtime,`graphics-auto-rig-buttons-${mode}.png`)});console.log(JSON.stringify({mode,candidate:candidate.id,delivery:report.delivery?.id,errors}));
}catch(error){report.failure={mode,error:String(error),errors,text:await page?.locator('body').innerText().catch(()=>''),at:new Date().toISOString()};save();if(page)await page.screenshot({path:path.join(runtime,'graphics-auto-rig-buttons-failure.png')}).catch(()=>{});throw error;}finally{await app.close();}
