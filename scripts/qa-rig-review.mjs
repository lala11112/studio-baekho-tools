/** Read-only review of a saved automatic rig through actual app DOM; no AI execution. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import{createHash}from'node:crypto';
import{_electron as electron}from'playwright';import binary from'electron';
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const fixture=read('artifacts/runtime/graphics-auto-rig-start-live.json'),out=path.resolve('artifacts/runtime/qa-20261018-rig');fs.mkdirSync(out,{recursive:true});
const workspaceFile=path.join(fixture.projectRoot,'graphics/workspace.json'),before=read(workspaceFile),beforeSha=sha(workspaceFile);
const candidate=before.versions.find(v=>v.id===fixture.run.candidateVersionId);assert(candidate?.id.startsWith('b005b7d1'));
for(const f of candidate.files)assert.equal(sha(path.join(fixture.projectRoot,f.path)),f.sha256);
const version=read('package.json').version,packaged=process.env.PARTSMITH_QA_PACKAGED==='1';
const bootstrap=path.join(fixture.root,'qa-review-bootstrap.cjs');fs.writeFileSync(bootstrap,`const{app}=require('electron');app.setAppPath(${JSON.stringify(process.cwd())});process.chdir(${JSON.stringify(process.cwd())});global.fetch=async()=>{throw Error('QA network forbidden')};app.on('browser-window-created',(_,w)=>{w.webContents.setBackgroundThrottling(false);w.once('ready-to-show',()=>w.showInactive())});require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});`);
const env={...process.env,PARTSMITH_DATA:fixture.profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:packaged?path.resolve(`release/${version}/win-unpacked/Partsmith.exe`):binary,args:packaged?[]:[bootstrap],env,timeout:30000});
const evidence={candidate:candidate.id,packaged,events:[],errors:[],paidSubmissions:0,productionGPT:0,arpAI:0};
const save=()=>fs.writeFileSync(path.join(out,packaged?'packaged.json':'source.json'),JSON.stringify(evidence,null,2));
try{
 evidence.metadata=await app.evaluate(({app,BrowserWindow,session})=>{global.fetch=async()=>{throw Error('QA network forbidden')};session.defaultSession.webRequest.onBeforeRequest((r,cb)=>cb({cancel:/^https?:/.test(r.url)}));for(const w of BrowserWindow.getAllWindows()){w.webContents.setBackgroundThrottling(false);w.showInactive();}return{data:app.getPath('userData'),version:app.getVersion(),packaged:app.isPackaged};});
 assert.equal(path.resolve(evidence.metadata.data),path.resolve(fixture.profile));assert.equal(evidence.metadata.packaged,packaged);if(packaged)assert.equal(evidence.metadata.version,version);
 const page=await app.firstWindow();page.setDefaultTimeout(15000);await page.setViewportSize({width:1440,height:1000});page.on('pageerror',e=>evidence.errors.push(e.message));
 const click=async(l,label)=>{await l.click();evidence.events.push(label);save();};
 const capture=async name=>{const png=await app.evaluate(async({BrowserWindow})=>Promise.race([BrowserWindow.getAllWindows()[0].webContents.capturePage().then(p=>p.toPNG().toString('base64')),new Promise((_,reject)=>setTimeout(()=>reject(Error('Capture timeout')),10000))]));fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(png,'base64'));};
 await click(page.locator(`[data-project-id="${fixture.projectId}"]`).getByTestId('project-open'),'open isolated human project');
 await click(page.getByTestId('graphics-object-human'),'select saved human');
 await click(page.getByRole('navigation',{name:'제작 단계',exact:true}).getByRole('button',{name:/리깅|리그/}).first(),'rig stage');
 const history=page.locator('.gs-version-history');if((await history.getAttribute('open'))===null)await click(history.locator('summary'),'open history');
 await click(page.getByTestId('graphics-version-'+candidate.id),'show exact saved candidate');
 await click(page.getByTestId('auto-rig-review').getByRole('button',{name:'3D 결과 보기',exact:true}),'show saved automatic rig');
 const viewport=page.locator('.inspection-viewport').first(),playback=viewport.locator('.playback');await playback.locator('select').waitFor();
 evidence.clips=await playback.locator('option').allTextContents();assert.equal(evidence.clips.length,4);
 evidence.influences=Number(await viewport.getAttribute('data-full-skin-influences'));assert(evidence.influences>4);
 for(let i=0;i<evidence.clips.length;i++){await playback.locator('select').selectOption({label:evidence.clips[i]});await click(viewport.getByRole('button',{name:'단색 보기',exact:true}),'solid '+evidence.clips[i]);await new Promise(r=>setTimeout(r,350));await capture('pose-'+i);assert.equal(await viewport.locator('.viewport-error').count(),0);}
 await click(viewport.getByTestId('viewport-wire-toggle'),'toggle wire');await click(playback.locator('button'),'pause clip');await click(playback.locator('button'),'resume clip');
 assert.deepEqual(evidence.errors,[]);assert.equal(sha(workspaceFile),beforeSha);
 for(const f of candidate.files)assert.equal(sha(path.join(fixture.projectRoot,f.path)),f.sha256);
 evidence.workspaceAndFilesUnchanged=true;evidence.passedAt=new Date().toISOString();save();console.log(JSON.stringify({packaged,clips:evidence.clips,influences:evidence.influences,unchanged:true}));
}catch(e){evidence.failure=String(e);save();throw e;}finally{await app.close();}
