import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {_electron as electron} from 'playwright';
import electronBinary from 'electron';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const out=path.resolve('artifacts/runtime/qa-20261018-textured-preview');fs.mkdirSync(out,{recursive:true});
const evidence=path.join(out,'report.json');
const previous=fs.existsSync(evidence)?read(evidence):null;
const root=previous?.root??fs.mkdtempSync(path.join(os.tmpdir(),'ps-textured-preview-'));
const report={root,paid:0,productionGPT:0,events:[],...(previous??{})};
const save=()=>fs.writeFileSync(evidence,JSON.stringify(report,null,2));
const audit=read('artifacts/runtime/qa-20261018-production.json');
const w=audit.before.records.find(r=>r.kind==='graphics'&&r.data.projectId.startsWith('caae83af')).data;
const v=w.versions.find(v=>v.id.startsWith('b52c1b3e'));
const originals=v.files.map(f=>({...f,absolute:path.join(process.env.APPDATA,'partsmith/projects',w.projectId,f.path)}));
for(const f of originals)assert.equal(sha(f.absolute),f.sha256);
report.originals=originals;save();
const blend=originals.find(f=>f.path.endsWith('.blend')).absolute;
const fixture=path.join(root,'sidecar-textured');fs.mkdirSync(fixture,{recursive:true});
if(!fs.existsSync(path.join(fixture,'fixture.json'))){
 const script=path.join(root,'sidecar.py');
 fs.writeFileSync(script,`import bpy,json,os\nout=${JSON.stringify(fixture.replaceAll('\\','/'))}\nimages=[]\nfor i,img in enumerate(bpy.data.images):\n if img.source!='FILE' or not img.packed_file: continue\n dest=os.path.join(out,'texture-'+str(i)+'.png')\n img.save_render(dest)\n img.filepath=dest\n images.append({'name':img.name,'path':dest,'size':list(img.size)})\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.export_scene.fbx(filepath=os.path.join(out,'textured.fbx'),use_selection=True,path_mode='RELATIVE',embed_textures=False,add_leaf_bones=False,bake_anim=False)\njson.dump({'images':images,'materials':[m.name for m in bpy.data.materials]},open(os.path.join(out,'fixture.json'),'w'),indent=2)\n`);
 execFileSync('C:/Program Files/Blender Foundation/Blender 5.0/blender.exe',['--factory-startup','-b',blend,'--python',script],{timeout:120000,windowsHide:true,stdio:['ignore',fs.openSync(path.join(out,'sidecar.log'),'w'),fs.openSync(path.join(out,'sidecar-errors.log'),'w')]});
}
report.fixture=read(path.join(fixture,'fixture.json'));report.fixtureFiles=fs.readdirSync(fixture).filter(n=>/\.(fbx|png)$/.test(n)).map(n=>({path:path.join(fixture,n),sha256:sha(path.join(fixture,n))}));save();
const env={...process.env,PARTSMITH_DATA:path.join(root,'profile'),PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
const version=read('package.json').version;
const sourceMode=process.env.PARTSMITH_QA_SOURCE==='1',restartOnly=process.argv[2]==='inspect-sidecar-restart',inspectOnly=['inspect-sidecar','inspect-sidecar-restart'].includes(process.argv[2]);
report.build={version,appAsarSha256:sha(path.resolve(`release/${version}/win-unpacked/resources/app.asar`)),planarWorkerSha256:sha(path.resolve(`release/${version}/win-unpacked/resources/integrations/blender/graphics_planar_repair.py`))};save();
const bootstrap=path.join(root,'qa-source.cjs');
if(sourceMode)fs.writeFileSync(bootstrap,`const{app}=require('electron');app.setAppPath(${JSON.stringify(process.cwd())});process.chdir(${JSON.stringify(process.cwd())});require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});`);
const app=await electron.launch({executablePath:sourceMode?electronBinary:path.resolve(`release/${version}/win-unpacked/Partsmith.exe`),args:sourceMode?[bootstrap]:[],env,timeout:30000});let page;
try{
 report.package=await app.evaluate(({app,BrowserWindow,session})=>{global.fetch=async()=>{throw Error('External network forbidden')};session.defaultSession.webRequest.onBeforeRequest((r,cb)=>cb({cancel:/^https?:/.test(r.url)}));for(const win of BrowserWindow.getAllWindows()){win.webContents.setBackgroundThrottling(false);win.showInactive();}return{version:app.getVersion(),data:app.getPath('userData'),packaged:app.isPackaged};});
 assert.equal(path.resolve(report.package.data),path.resolve(env.PARTSMITH_DATA));assert.equal(report.package.version,version);assert.equal(report.package.packaged,!sourceMode);
 page=await app.firstWindow();page.setDefaultTimeout(15000);await page.setViewportSize({width:1440,height:1000});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const state=()=>page.evaluate(()=>window.desktop.call({type:'state'}));
 const workspace=async()=>{const s=await state();return s.graphicsWorkspaces.find(w=>w.projectId===report.projectId);};
 const click=async l=>{await l.scrollIntoViewIfNeeded();await l.click();};
 const wait=async predicate=>{const end=Date.now()+180000;while(Date.now()<end){const w=await workspace();if(predicate(w))return w;await new Promise(r=>setTimeout(r,300));}throw Error('Preview timeout');};
 const capture=async name=>{const data=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));fs.writeFileSync(path.join(out,name),Buffer.from(data,'base64'));};
 if(!report.projectId){
  await click(page.getByRole('button',{name:/^새 오브젝트 만들기/}));await click(page.getByRole('dialog').getByRole('button',{name:'새 프로젝트 만들기',exact:true}));
  const dialog=page.getByRole('dialog');await dialog.locator('input').first().fill('텍스처 미리보기 격리 검증');const demo=dialog.getByRole('checkbox');if(await demo.isChecked())await demo.uncheck();await click(dialog.getByRole('button',{name:/프로젝트 만들기/}));
  report.projectId=(await state()).projects[0].id;save();
  const create=page.getByTestId('graphics-create-dialog');await create.waitFor();await click(create.getByRole('button',{name:'사물',exact:true}));await click(create.getByRole('button',{name:'상자·용기',exact:true}));await create.getByLabel('이름',{exact:true}).fill('재질 보존 상자');await click(create.getByRole('button',{name:'오브젝트 만들기',exact:true}));
  report.objectId=(await wait(w=>w?.objects.length===1)).objects[0].id;save();
 }else{await click(page.locator(`[data-project-id="${report.projectId}"]`).getByTestId('project-open'));await click(page.getByTestId('graphics-object-'+report.objectId));}
 report.results??=[];
 if(inspectOnly){
  const record=report.results.find(r=>r.name==='fbx-sidecars');assert(record);
  const before=await workspace(),oldTasks=structuredClone(before.tasks),candidate=before.versions.find(v=>v.id===record.versionId);assert(candidate);
  const history=page.locator('.gs-version-history');if(await history.getAttribute('open')===null)await click(history.locator('summary'));await click(page.getByTestId('graphics-version-'+candidate.id));
  await click(page.getByRole('button',{name:'수정하기',exact:true}));await click(page.getByRole('button',{name:'빠진 면 검사',exact:true}));
  const panel=page.getByTestId('graphics-planar-review');await panel.waitFor();
  const button=panel.getByRole('button',{name:/^이 원본(의 빠진 면 검사| 다시 검사)$/});assert.equal(await button.count(),1);
  if(!restartOnly)await click(button);
  else {
   assert(report.appReinspection);assert.deepEqual(before.planarInspections?.[candidate.id],report.appReinspection.inspection);assert.deepEqual(before.tasks,report.finalTasks);
   await new Promise(r=>setTimeout(r,2000));
   const idle=await workspace();assert.deepEqual(idle.tasks,before.tasks);assert.deepEqual(idle.planarInspections,before.planarInspections);assert.deepEqual(idle.objects[0].accepted,before.objects[0].accepted);
   report.packagedRestart={build:report.build,tasksUnchanged:true,inspectionUnchanged:true,adoptionUnchanged:true,noAutomaticRetry:true,at:new Date().toISOString()};save();
  }
  const after=await wait(w=>!!w.planarInspections?.[candidate.id]||w.tasks.slice(oldTasks.length).some(t=>t.status==='failed'));
  assert(after.planarInspections?.[candidate.id],after.tasks.at(-1)?.message);
  assert.deepEqual(after.tasks.slice(0,oldTasks.length),oldTasks);
  const inspection=after.planarInspections[candidate.id],companions=candidate.files.filter(f=>!['preview','report'].includes(f.kind)&&/\.(png|jpe?g)$/i.test(f.path));
  assert.equal(inspection.sourceManifestVersion,1);assert.deepEqual(inspection.sourceCompanions,companions);assert.equal(inspection.sourceSha256,candidate.files.find(f=>f.path.endsWith('.fbx')).sha256);
  assert.deepEqual(after.objects[0].accepted,before.objects[0].accepted);for(const f of candidate.files)assert.equal(sha(path.join(root,'profile/projects',report.projectId,f.path)),f.sha256);
  await panel.getByText(/저장된 검사 ·/).waitFor();await capture('fbx-sidecars-reinspection-ready.png');
  if(!restartOnly)report.appReinspection={mode:sourceMode?'source':'packaged',package:report.package,build:report.build,versionId:candidate.id,inspection,task:after.tasks.at(-1),olderTasksPreserved:true,adoptionPreserved:true,at:new Date().toISOString()};save();
 }
 if(!inspectOnly)for(const [name,files] of [['fbx-sidecars',report.fixtureFiles.map(f=>f.path)],['blend-packed',[blend]]]){
  if(report.results.some(r=>r.name===name))continue;
  const details=page.locator('.gs-import-details');if(await details.getAttribute('open')===null)await click(details.locator('summary'));await page.getByLabel('가져올 자료의 역할').selectOption('model');
  await app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files});},files);
  const before=await workspace();let candidate=before.versions.find(v=>files.every(p=>v.files.some(f=>f.sha256===sha(p)))),imported=before;
  if(!candidate){await click(page.getByTestId('graphics-import'));imported=await wait(w=>w.versions.length>before.versions.length);candidate=imported.versions.at(-1);}
  assert.deepEqual(imported.objects[0].accepted,before.objects[0].accepted);
  const summary=page.locator('.gs-version-history > summary');if(await page.locator('.gs-version-history').getAttribute('open')===null)await click(summary);await click(page.getByTestId('graphics-version-'+candidate.id));
  const beforeFiles=structuredClone(candidate.files.filter(f=>!['preview','report'].includes(f.kind)));for(const f of beforeFiles)assert.equal(sha(path.join(root,'profile/projects',report.projectId,f.path)),f.sha256);
  imported=await wait(w=>w.versions.find(v=>v.id===candidate.id).files.some(f=>f.kind==='preview'));
  const after=imported.versions.find(v=>v.id===candidate.id);assert.deepEqual(after.files.slice(0,beforeFiles.length),beforeFiles);assert.deepEqual(imported.objects[0].accepted,before.objects[0].accepted);
  const preview=after.files.find(f=>f.kind==='preview'),absolute=path.join(root,'profile/projects',report.projectId,preview.path),binary=fs.readFileSync(absolute),json=JSON.parse(binary.subarray(20,20+binary.readUInt32LE(12)).toString('utf8'));
  await page.getByTestId('viewport-wire-toggle').waitFor({timeout:30000});assert.equal(await page.locator('.viewport-error').count(),0);
  await capture(name+'-textured.png');
  const result={name,versionId:after.id,originalFiles:beforeFiles,files:after.files,glb:{materials:json.materials?.length??0,images:json.images??[],textures:json.textures?.length??0,baseColorTextured:(json.materials??[]).filter(m=>m.pbrMetallicRoughness?.baseColorTexture).length},adoptionPreserved:true,tasks:imported.tasks.length};
  assert(result.glb.baseColorTextured>0);assert(result.glb.images.every(i=>Number.isInteger(i.bufferView)&&!i.uri));
  for(const f of beforeFiles)assert.equal(sha(path.join(root,'profile/projects',report.projectId,f.path)),f.sha256);
  report.results.push(result);save();
 }
 for(const f of originals)assert.equal(sha(f.absolute),f.sha256);for(const f of report.fixtureFiles)assert.equal(sha(f.path),f.sha256);
 const final=await workspace();report.finalTasks=final.tasks;report.finalJobs=(await state()).projects[0].jobs;save();assert(final.tasks.every(t=>t.localOnly&&t.taskId==='LOCAL_PLANAR_INSPECT'));assert(report.finalJobs.every(j=>j.operation==='convert'||j.kind==='convert')); assert.deepEqual(errors,[]);report.errors=errors;report.previewPassedAt=new Date().toISOString();
 report.scope='Packaged preview33 DOM imports and actual textured canvas checks; no adoption, production generation, API or rig AI';
 report.observedIssue='Initial native imports scheduled three automatic local inspections: discarded zero-sidecar fixture failed, valid four-sidecar fixture failed before the fix, packed BLEND was interrupted at app shutdown. appReinspection, when present, records a separate explicit post-fix inspection and preserves those older records.';
 report.limitations=['One chest material only; no universal material compatibility claim','FBX sidecar fixture re-exported the same packed chest locally, with images saved to PNG; not an exact texture byte-equivalence claim against original JPG maps','Original packed BLEND and all four registered production files kept exact SHA256','Production task input was not submitted; original native source remains registered alongside preview-kind GLB'];
 delete report.failure;save();
}catch(error){report.failure={message:String(error),body:await page?.locator('body').innerText().catch(()=>''),at:new Date().toISOString()};save();throw error;}finally{await app.close();}
