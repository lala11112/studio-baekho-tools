// Idle-only app upgrade checks and local part preparation; no API submission/adoption.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const file='artifacts/runtime/graphics-independent-head-live.json',r=JSON.parse(fs.readFileSync(file,'utf8')),mode=process.argv[2];
assert(['snapshot-close','verify','prepare-source','compare','inspect'].includes(mode));
const save=()=>fs.writeFileSync(file,JSON.stringify(r,null,2)),hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const b=await chromium.connectOverCDP('http://127.0.0.1:'+fs.readFileSync(path.join(r.profile,'DevToolsActivePort'),'utf8').split('\n')[0]);const p=b.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(p);p.setDefaultTimeout(15000);
const state=()=>p.evaluate(()=>window.desktop.call({type:'state'})),workspace=async()=>(await state()).graphicsWorkspaces.find(w=>w.projectId===r.projectId);
const open=async()=>{if(!await p.getByTestId('graphics-object-'+r.objectId).isVisible()){const project=p.locator(`[data-project-id="${r.projectId}"]`).getByTestId('project-open');if(!await project.isVisible())await p.getByRole('button',{name:'모든 프로젝트',exact:true}).click();await project.click();await p.getByTestId('graphics-object-'+r.objectId).click();}await p.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'2 모델',exact:true}).click();};
try{
 let spaces=(await state()).graphicsWorkspaces,w=spaces.find(w=>w.projectId===r.projectId);assert(w);
 if(mode==='snapshot-close'){
  assert(!spaces.some(w=>w.tasks.some(t=>['running','awaiting_approval','submission_unknown'].includes(t.status))));
  r.upgradeBefore=spaces;r.upgradeFiles=spaces.flatMap(w=>w.versions.flatMap(v=>v.files.map(f=>({path:path.join(r.profile,'projects',w.projectId,f.path),sha256:f.sha256}))));
  r.upgradeBackendHash=hash(path.join(r.profile,'projects',r.projectId,'project.json'));r.upgradeStartedAt=new Date().toISOString();save();await p.close();console.log('Idle snapshot saved; closed main app.');
 }else{
  if(mode==='verify'){
   assert.deepEqual(spaces,r.upgradeBefore);assert.equal(hash(path.join(r.profile,'projects',r.projectId,'project.json')),r.upgradeBackendHash);for(const f of r.upgradeFiles)assert.equal(hash(f.path),f.sha256);
   assert((await p.locator('body').innerText()).includes('preview.20'));r.upgradeVerifiedAt=new Date().toISOString();save();await open();console.log('preview20 exact restart preservation verified.');
  }
  if(mode==='prepare-source'){
   assert(!w.tasks.some(t=>['running','awaiting_approval','submission_unknown'].includes(t.status)));assert(!w.versions.some(v=>v.partSource?.providerVersionId===r.completedModel.versionId),'Already prepared; inspect existing result');
   r.sourcePreparationBefore=spaces;save();await open();await p.getByTestId('graphics-version-'+r.completedModel.versionId).click();await p.getByTestId('graphics-prepare-part-source').click();r.sourcePreparationStartedAt=new Date().toISOString();save();
  }
  if(mode==='compare'){
   const derived=w.versions.find(v=>v.partSource?.providerVersionId===r.completedModel.versionId);assert(derived,'Finish app local preparation first');
   const t=w.tasks.find(t=>t.id===r.modelTaskId);assert.equal(t.status,'review');assert.equal(w.objects.find(o=>o.id===r.objectId).accepted['model:part-head'],'ce10dcc9-125d-4760-8f44-88162e29899c');
   for(const old of r.sourcePreparationBefore.find(w=>w.projectId===r.projectId).versions)assert.deepEqual(w.versions.find(v=>v.id===old.id),old);
   for(const f of r.upgradeFiles)assert.equal(hash(f.path),f.sha256);assert.equal(hash(path.join(r.profile,'projects',r.projectId,'project.json')),r.upgradeBackendHash);
   await open();await p.getByTestId('graphics-version-'+derived.id).click();if(!await p.getByTestId('graphics-head-comparison').isVisible())await p.getByTestId('graphics-compare-heads').click();await p.locator('[data-testid="graphics-head-comparison-canvas"][data-ready="true"]').waitFor();
   const compare=p.getByTestId('graphics-head-comparison');assert.equal(await compare.getByLabel('머리 비교 기준 버전').inputValue(),'ce10dcc9-125d-4760-8f44-88162e29899c');
   const canvas=compare.getByTestId('graphics-head-comparison-canvas');
   for(const [label,name]of [['정면','front'],['왼쪽','side'],['후면','back']]){await compare.getByRole('button',{name:label,exact:true}).click();await canvas.scrollIntoViewIfNeeded();await canvas.screenshot({path:`artifacts/runtime/graphics-independent-head-${name}-compare.png`});}
   await compare.getByRole('button',{name:'정면',exact:true}).click();await p.getByTestId('graphics-preview-actions').scrollIntoViewIfNeeded();
   r.preparedHead=derived;r.localPreparationVerifiedAt=new Date().toISOString();r.sourceReport=JSON.parse(fs.readFileSync(path.join(r.profile,'projects',r.projectId,derived.partSource.reportPath),'utf8'));save();console.log(JSON.stringify({prepared:derived.id,report:r.sourceReport,oldFilesPreserved:true,backendUnchanged:true}));
  }
  w=await workspace();const t=w.tasks.find(t=>t.id===r.modelTaskId);console.log(JSON.stringify({id:t.id,status:t.status,message:t.message,outputs:t.outputVersionIds,accepted:w.objects.find(o=>o.id===r.objectId).accepted}));
 }
}finally{await b.close();}
