// Idle-only follow-up upgrade; never adopts or starts production.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const file='artifacts/runtime/graphics-independent-head-live.json',r=JSON.parse(fs.readFileSync(file,'utf8')),mode=process.argv[2];assert(['close','verify'].includes(mode));
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex'),save=()=>fs.writeFileSync(file,JSON.stringify(r,null,2));
const b=await chromium.connectOverCDP('http://127.0.0.1:'+fs.readFileSync(path.join(r.profile,'DevToolsActivePort'),'utf8').split('\n')[0]);const p=b.contexts()[0].pages().find(p=>p.url().includes('index.html'));assert(p);p.setDefaultTimeout(15000);
try{
 const state=await p.evaluate(()=>window.desktop.call({type:'state'})),spaces=state.graphicsWorkspaces;
 assert(!spaces.some(w=>w.tasks.some(t=>['running','awaiting_approval','submission_unknown'].includes(t.status))));
 if(mode==='close'){
  assert(!r.adoptionUpgrade,'Already upgraded; inspect current app');
  r.adoptionUpgrade={before:spaces,files:spaces.flatMap(w=>w.versions.flatMap(v=>v.files.map(f=>({path:path.join(r.profile,'projects',w.projectId,f.path),sha256:f.sha256})))),backendHash:hash(path.join(r.profile,'projects',r.projectId,'project.json')),startedAt:new Date().toISOString()};save();await p.close();
 }else{
  const before=r.adoptionUpgrade;assert(before);assert.deepEqual(spaces,before.before);for(const f of before.files)assert.equal(hash(f.path),f.sha256);assert.equal(hash(path.join(r.profile,'projects',r.projectId,'project.json')),before.backendHash);assert((await p.locator('body').innerText()).includes('preview.21'));
  if(!await p.getByTestId('graphics-object-'+r.objectId).isVisible()){const project=p.locator(`[data-project-id="${r.projectId}"]`).getByTestId('project-open');if(!await project.isVisible())await p.getByRole('button',{name:'모든 프로젝트',exact:true}).click();await project.click();await p.getByTestId('graphics-object-'+r.objectId).click();}
  await p.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'4 조립·수정',exact:true}).click();await p.getByTestId('graphics-version-a8a984af-a88d-4529-955b-7c9437dfb292').click();
  const button=p.getByTestId('graphics-accept-preview');assert.equal(await button.innerText(),'이 조립과 파트 채택');assert(await button.isEnabled());await button.scrollIntoViewIfNeeded();await p.screenshot({path:'artifacts/runtime/graphics-preview21-assembly-adoption.png'});
  before.verifiedAt=new Date().toISOString();before.productionCalls=0;save();console.log('preview21 live: unchanged workspaces and files; assembly adoption button visible; no adoption/submission');
 }
}finally{await b.close();}
