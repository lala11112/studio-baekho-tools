/** One explicit inspection of the saved multipart rig. No new rig, correction or adoption. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';

const base=JSON.parse(fs.readFileSync('artifacts/runtime/qa-20261018-multipart-rig-app/baseline.json','utf8'));
const out=path.resolve('artifacts/runtime/qa-20261018-multipart-ornament-app');fs.mkdirSync(out,{recursive:true});
const reportFile=path.join(out,'inspection.json');assert(!fs.existsSync(reportFile),'Inspect the saved run; never restart by rerunning this script');
const project=path.join(base.profile,'projects',base.projectId),workspaceFile=path.join(project,'graphics/workspace.json');
const before=JSON.parse(fs.readFileSync(workspaceFile,'utf8')),candidateId='f92bdc05-85c2-4cbe-a78c-5585836d9137';
const candidate=before.versions.find(v=>v.id===candidateId);assert(candidate);
assert.equal(candidate.autoRig.sourceSha256,'1c9544e836a2295a70561caaf30d1bc6b05edd6d85dc5e02b2c1879e6d0f4d57');
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalFiles=[...base.files,...candidate.files.map(f=>({...f,path:path.join(project,f.path)}))];
for(const f of originalFiles)assert.equal(sha(f.path),f.sha256);
const report={at:new Date().toISOString(),profile:base.profile,projectId:base.projectId,objectId:base.objectId,candidateId,before,originalFiles,events:[],AI:0,paidAPI:0,productionGPT:0};
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2));save();
const env={...process.env,PARTSMITH_DATA:base.profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.resolve('release/0.7.0-preview.42/win-unpacked/Partsmith.exe'),args:['--remote-debugging-port=19345'],env});
let page,terminal=false;
try{
 report.runtime=await app.evaluate(({app,session,BrowserWindow})=>{global.fetch=async()=>{throw Error('External forbidden')};session.defaultSession.webRequest.onBeforeRequest((q,cb)=>cb({cancel:/^https?:/.test(q.url)}));for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);return {version:app.getVersion(),packaged:app.isPackaged};});
 assert.deepEqual(report.runtime,{version:'0.7.0-preview.42',packaged:true});
 page=await app.firstWindow();await page.setViewportSize({width:1440,height:1100});
 const state=async()=>(await page.evaluate(()=>window.desktop.call({type:'state'}))).graphicsWorkspaces.find(w=>w.projectId===base.projectId);
 const click=async(locator,label)=>{await locator.scrollIntoViewIfNeeded();assert(await locator.isVisible());assert(await locator.isEnabled());await locator.click();report.events.push({label,at:new Date().toISOString()});save();};
 await click(page.locator(`[data-project-id="${base.projectId}"]`).getByTestId('project-open'),'open existing isolated project');
 await click(page.getByTestId('graphics-object-'+base.objectId),'select multipart object');
 await click(page.getByRole('navigation',{name:'제작 단계',exact:true}).getByRole('button',{name:/리깅/}).first(),'rig settings');
 const history=page.locator('.gs-version-history');if(!await history.getAttribute('open'))await click(history.locator('summary'),'open result history');
 await click(page.getByTestId('graphics-version-'+candidateId),'show exact saved rig');
 const panel=page.getByTestId('graphics-auto-rig');
 const detail=panel.locator('details').filter({has:page.locator('summary',{hasText:'선택 영역만 가중치 보정'})});
 await click(detail.locator('summary'),'open bounded correction');
 assert.deepEqual(await state(),before);
 await page.screenshot({path:path.join(out,'before-inspection.png')});
 report.inspectionClickedAt=new Date().toISOString();save();
 await click(detail.getByRole('button',{name:'부위·뼈 영향 검사',exact:true}),'ONE local source inspection');
 let last=0;
 for(;;){const w=await state(),added=w.autoRigRuns.filter(r=>!before.autoRigRuns.some(old=>old.id===r.id));assert(added.length<=1);if(added.length){report.run=added[0];assert.equal(report.run.operation,'inspect');assert.equal(report.run.sourceVersionId,candidateId);save();if(report.run.state!=='running'){terminal=true;report.after=w;break;}if(Date.now()-last>15000){last=Date.now();console.log(JSON.stringify({runId:report.run.id,state:report.run.state,message:report.run.message}));}}await page.waitForTimeout(500);}
 assert.equal(report.run.state,'review',report.run.error);assert.deepEqual(report.after.versions,before.versions);assert.deepEqual(report.after.tasks,before.tasks);assert.deepEqual(report.after.objects,before.objects);assert.deepEqual(report.after.deliveries,before.deliveries);
 for(const old of before.autoRigRuns)assert.deepEqual(report.after.autoRigRuns.find(r=>r.id===old.id),old);
 for(const f of originalFiles)assert.equal(sha(f.path),f.sha256);
 await page.screenshot({path:path.join(out,'inspection-ready.png')});report.passedAt=new Date().toISOString();save();
}catch(error){report.failure=String(error);save();if(!terminal){console.error('Keep same app/handle for observation; no repeated dispatch');await new Promise(()=>{});}throw error;}
finally{if(terminal)await app.close();}
