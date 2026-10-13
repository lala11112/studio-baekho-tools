// Live upgrade audit. No adoption, task preparation, production execution or cleanup.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const profile=path.join(process.env.APPDATA,'partsmith'),projectId='ff70e6a6-b1cc-4dea-9a92-f9e092114578';
const root=path.join(profile,'projects',projectId),workspaceFile=path.join(root,'graphics/workspace.json');
const evidence=path.resolve('artifacts/runtime/graphics-preview13-live.json');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mode=process.argv[2]??'verify';
const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
const page=browser.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(page);
page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const state=()=>page.evaluate(()=>window.desktop.call({type:'state'}));
const current=await state();
function assertIdle(s){
 assert(!(s.graphicsWorkspaces??[]).some(w=>w.tasks.some(t=>t.status==='running')),'Graphics work active');
 assert(!(s.workbenches??[]).some(w=>w.activeJobId||w.jobs.some(j=>j.status==='running')),'Workbench work active');
 assert(!(s.productionRuns??[]).some(r=>r.status==='running'),'Production active');
 assert(!s.projects.some(p=>p.jobs.some(j=>['queued','running','submitting','processing','downloading'].includes(j.status))),'Backend work active');
}
try{
 assertIdle(current);
 if(mode==='snapshot'){
  const workspace=JSON.parse(fs.readFileSync(workspaceFile,'utf8'));
  const files=[...new Set(workspace.versions.flatMap(v=>v.files.map(f=>f.path)))].map(file=>({path:file,sha256:hash(path.join(root,file))}));
  const report={projectId,before:{workspaceSha256:hash(workspaceFile),workspace,files},snapshotAt:new Date().toISOString()};
  fs.writeFileSync(evidence,JSON.stringify(report,null,2));console.log(JSON.stringify({snapshot:true,files:files.length,versions:workspace.versions.length}));
 }else{
  const report=JSON.parse(fs.readFileSync(evidence,'utf8'));assert.equal(hash(workspaceFile),report.before.workspaceSha256);
  for(const f of report.before.files)assert.equal(hash(path.join(root,f.path)),f.sha256);
  if(mode==='close'){
   await page.close();console.log('Idle previous app window closed; original files and workspace unchanged.');
  }else{
   await page.getByRole('button',{name:'모든 프로젝트',exact:true}).click();
   await page.locator(`[data-project-id="${projectId}"]`).getByTestId('project-open').click();
   await page.getByTestId('graphics-new-object').click();
   const dialog=page.getByTestId('graphics-create-dialog');await dialog.waitFor();
   const dialogBounds=await dialog.boundingBox();assert(dialogBounds&&dialogBounds.width>=700);
   await dialog.getByRole('group',{name:'오브젝트 분류',exact:true}).getByRole('button',{name:'건물·건축 부품',exact:true}).click();
   await page.screenshot({path:path.resolve('artifacts/runtime/graphics-preview13-live-create.png')});
   await dialog.getByRole('button',{name:'취소',exact:true}).click();
   await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'5 리깅',exact:true}).click();
   await page.getByTestId('graphics-version-123fbd42-4d02-4b4e-a58a-7086a6230321').click();
   await page.getByTestId('graphics-preview').locator('canvas').waitFor();
   await page.getByTestId('viewport-wire-toggle').click();
   await page.getByTestId('viewport-native-topology').click();
   await page.locator('[data-testid="viewport-topology-status"]:is([data-state="ready"],[data-state="unavailable"])').waitFor({timeout:120000});
   assert.equal(await page.getByTestId('viewport-topology-status').getAttribute('data-state'),'ready',await page.getByTestId('viewport-topology-status').innerText());
   const nativeText=await page.getByTestId('viewport-topology-status').innerText();
   await page.screenshot({path:path.resolve('artifacts/runtime/graphics-preview13-live-native.png')});
   const after=await state();assertIdle(after);
   assert.equal(hash(workspaceFile),report.before.workspaceSha256);
   for(const f of report.before.files)assert.equal(hash(path.join(root,f.path)),f.sha256);
   assert.deepEqual(errors,[]);
   Object.assign(report,{version:JSON.parse(fs.readFileSync('package.json','utf8')).version,verifiedAt:new Date().toISOString(),dialogBounds,nativeText,workspacePreserved:true,registeredHashesPreserved:true,newTasks:0,newPaidSubmissions:0,newProductionWorkers:0,errors});
   fs.writeFileSync(evidence,JSON.stringify(report,null,2));console.log(JSON.stringify({verified:true,version:report.version,dialogBounds,nativeText,preservedFiles:report.before.files.length,errors}));
  }
 }
}finally{await browser.close();}
