import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {_electron as electron, chromium} from 'playwright';
import binary from 'electron';
const out=path.resolve('artifacts/runtime/qa-20261018-multipart-rig-app');
const b=JSON.parse(fs.readFileSync(path.join(out,'baseline.json'))),file=path.join(out,'report.json');
const r=JSON.parse(fs.readFileSync(file));
const mode=process.argv[2]??'prepare',source=process.env.PARTSMITH_QA_SOURCE==='1';
assert(['prepare','run','poll'].includes(mode));
if(mode==='run'){assert(source,'Rig execution requires current source/resources');assert(!r.dispatchedAt,'Exactly one dispatch');}
if(mode==='poll')assert(r.runId&&r.cdpPort,'Read-only poll requires saved run ID and live app endpoint');
const observation={mode,source,at:new Date().toISOString(),events:[]};r.runs.push(observation);
const save=()=>fs.writeFileSync(file,JSON.stringify(r,null,2));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for(const f of b.files)assert.equal(sha(f.path),f.sha256);
const terminal=run=>!!run&&['review','failed','cancelled','blocked'].includes(run.state);
let app,page,observer,mayClose=mode==='prepare';
if(mode==='poll'){
 observer=await chromium.connectOverCDP(`http://127.0.0.1:${r.cdpPort}`);
 page=observer.contexts()[0].pages().find(p=>!p.url().startsWith('devtools:'));
 assert(page,'Existing app page required; poll never launches another app');
}else{
 const env={...process.env,PARTSMITH_DATA:b.profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
 const bootstrap=path.join(path.dirname(b.profile),'multipart-rig-source.cjs');
 if(source)fs.writeFileSync(bootstrap,`const{app}=require('electron');app.setAppPath(${JSON.stringify(process.cwd())});process.chdir(${JSON.stringify(process.cwd())});require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});`);
 r.cdpPort=19341;save();
 app=await electron.launch({executablePath:source?binary:path.resolve('release/0.7.0-preview.41/win-unpacked/Partsmith.exe'),args:[...(source?[bootstrap]:[]),`--remote-debugging-port=${r.cdpPort}`],env});
 observation.runtime=await app.evaluate(({app,session,BrowserWindow})=>{global.fetch=async()=>{throw Error('External forbidden')};session.defaultSession.webRequest.onBeforeRequest((q,cb)=>cb({cancel:/^https?:/.test(q.url)}));for(const w of BrowserWindow.getAllWindows()){w.showInactive();w.webContents.setBackgroundThrottling(false);}return{version:app.getVersion(),isPackaged:app.isPackaged,pid:process.pid};});
 page=await app.firstWindow();
}
const ws=async()=>(await page.evaluate(()=>window.desktop.call({type:'state'}))).graphicsWorkspaces.find(w=>w.projectId===b.projectId);
const click=async locator=>{await locator.scrollIntoViewIfNeeded();await locator.click();};
try{
 page.setDefaultTimeout(15000);
 if(mode!=='poll'){
  await page.setViewportSize({width:1440,height:1100});
  await click(page.locator(`[data-project-id="${b.projectId}"]`).getByTestId('project-open'));
  await click(page.getByTestId('graphics-object-'+b.objectId));
  await click(page.getByRole('navigation',{name:'제작 단계',exact:true}).getByRole('button',{name:/리깅|리그/}).first());
  await page.getByTestId('graphics-auto-rig').waitFor();
  if(await page.getByRole('button',{name:'설치 상태 확인',exact:true}).count()){await click(page.getByRole('button',{name:'설치 상태 확인',exact:true}));await page.getByText('설치 준비됨',{exact:true}).waitFor({timeout:45000});}
  await page.getByRole('combobox',{name:'자동 리깅 원본',exact:true}).selectOption(r.sourceId);
  await page.getByLabel('모델 앞 방향',{exact:true}).selectOption(r.frontAxis);
  const fingers=page.getByLabel('손가락도 자동 감지');if(!await fingers.isChecked())await fingers.check();
  await page.waitForFunction(()=>Number(document.querySelector('.viewport')?.getAttribute('data-mesh-count'))===3);
  assert.equal(await page.locator('.viewport-error').count(),0);
  assert.equal(await page.getByTestId('auto-rig-source-id').innerText(),r.sourceId);
  assert.equal(await page.getByTestId('auto-rig-preview-mismatch').count(),0);
  assert(await page.getByTestId('auto-rig-run').isEnabled());
  observation.before=await ws();
  assert.deepEqual(observation.before.objects.find(o=>o.id===b.objectId).accepted,b.workspace.objects.find(o=>o.id===b.objectId).accepted);
  if(mode==='run'){r.dispatchedAt=new Date().toISOString();mayClose=false;save();await click(page.getByTestId('auto-rig-run'));}
 }
 if(mode==='run'||mode==='poll'){
  const started=Date.now();let lastLog=0;
  // No observation deadline may stop a live app/Blender. Continue the same ID.
  for(;;){
   const w=await ws();
   if(!r.runId){const fresh=(w.autoRigRuns??[]).filter(x=>!(b.workspace.autoRigRuns??[]).some(y=>y.id===x.id));assert(fresh.length<=1,'More than one new run');if(fresh.length===1)r.runId=fresh[0].id;}
   const current=(w.autoRigRuns??[]).find(x=>x.id===r.runId);
   if(mode==='poll')assert(current,'Saved run ID missing; no new preparation permitted');
   observation.current=current;save();
   if(Date.now()-lastLog>30000){lastLog=Date.now();console.log(JSON.stringify({runId:r.runId,state:current?.state,message:current?.message,elapsedMs:Date.now()-started}));}
   if(terminal(current)){mayClose=mode==='run';break;}
   if(Date.now()-started>1800000&&!observation.observationWindowExceededAt){observation.observationWindowExceededAt=new Date().toISOString();save();console.log('Observation window exceeded; keeping same live app/run and continuing.');}
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
 }
 observation.after=await ws();
 for(const f of b.files)assert.equal(sha(f.path),f.sha256);
 assert.deepEqual(observation.after.objects.find(o=>o.id===b.objectId).accepted,b.workspace.objects.find(o=>o.id===b.objectId).accepted);
 await page.screenshot({path:path.join(out,mode+(source?'-source':'')+'.png')});
 observation.passedAt=new Date().toISOString();save();
}catch(error){
 observation.failure=String(error);observation.body=await page?.locator('body').innerText().catch(()=>null);save();
 await page?.screenshot({path:path.join(out,mode+'-failure.png')}).catch(()=>{});
 if(r.dispatchedAt&&!terminal(observation.current)){
  console.error('Observation failed; live app is retained. Attach read-only poll to saved endpoint.');
  // Keep Playwright owner alive; an error must not kill its child process.
  await new Promise(()=>{});
 }
 throw error;
}finally{
 if(app&&mayClose)await app.close();
 // A poll attaches to another live owner: never call app/browser close here.
 if(observer)process.exit(0); // Observer owns no app process; disconnect by exiting only this CLI.
}
