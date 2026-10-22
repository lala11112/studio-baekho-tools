// Actual automatic start via app controls in a new isolated profile. No paid endpoints.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';
import binary from 'electron';
import {Store} from '../engine/store.ts';
import {Engine} from '../engine/engine.ts';
import {defaultCreation} from '../shared/graphics-creation.ts';
const evidence=path.resolve('artifacts/runtime/graphics-auto-rig-start-live.json');
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
let record;
if(!fs.existsSync(evidence)){
 const source=read('artifacts/runtime/graphics-external-rig-fixture.json');
 assert.equal(sha(source.sourcePath),source.source.sha256);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-auto-rig-start-')),profile=path.join(root,'profile');
 const store=new Store(profile);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
 store.settings={...store.settings,blenderPath:'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe'};
 const project=new Engine(store,{}).create('앱 자동 리깅 시작 · 격리 검증');
 store.write(project.id,'assets/human.fbx',fs.readFileSync(source.sourcePath));
 const file={...source.source,path:'assets/human.fbx'};
 const creation=defaultCreation('character');creation.subject='human';creation.parts=[];
 const v={id:'static-human',objectId:'human',role:'model',slot:'main',label:'기존 전체 인간형 원본 사본',files:[file],createdAt:new Date().toISOString(),sourceVersionIds:[],provenance:{type:'import'},warnings:[]};
 const w={schemaVersion:1,id:project.id,projectId:project.id,revision:1,objects:[{id:'human',name:'자동 리깅 검증',kind:'character',createdAt:v.createdAt,selectedTasks:[],instruction:'',settings:{},references:[],accepted:{'model:main':v.id},creation}],versions:[v],tasks:[],deliveries:[]};
 store.put('graphics',project.id,w);store.write(project.id,'graphics/workspace.json',JSON.stringify(w,null,2));
 record={root,profile,projectId:project.id,projectRoot:store.directory(project.id),source:file,sourceOriginal:source.sourcePath,createdAt:new Date().toISOString(),events:[]};
 fs.writeFileSync(evidence,JSON.stringify(record,null,2));
}else record=read(evidence);
assert(path.basename(record.root).startsWith('ps-auto-rig-start-'));
assert.equal(sha(record.sourceOriginal),record.source.sha256);
// The real imported model includes a local GLB preview; attach that exact existing
// preview to this minimal fixture so the front-axis choice is visually reviewable.
if(!record.preview){
 const old=read('artifacts/runtime/graphics-external-rig-fixture.json');
 const source=old.productionOriginals.find(f=>/model\.glb$/i.test(f.path));assert(source);assert.equal(sha(source.path),source.sha256);
 const store=new Store(record.profile);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
 const w=store.get('graphics',record.projectId),v=w.versions.find(v=>v.id==='static-human');
 const file={path:'assets/human-preview.glb',sha256:source.sha256,bytes:fs.statSync(source.path).size,kind:'glb'};
 store.write(record.projectId,file.path,fs.readFileSync(source.path));v.files.push(file);w.revision++;
 store.put('graphics',record.projectId,w);store.write(record.projectId,'graphics/workspace.json',JSON.stringify(w,null,2));
 record.preview=file;fs.writeFileSync(evidence,JSON.stringify(record,null,2));
}
const bootstrap=path.join(record.root,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`const {app}=require('electron');app.setAppPath(${JSON.stringify(process.cwd())});process.chdir(${JSON.stringify(process.cwd())});global.fetch=async()=>{throw Error('No network in isolated rig validation')};app.on('browser-window-created',(_,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);w.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:/^https?:/.test(d.url)}))});require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});`);
const env={...process.env,PARTSMITH_DATA:record.profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:binary,args:[bootstrap],env,timeout:30000});
try{
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const workspace=async()=>{const s=await page.evaluate(()=>window.desktop.call({type:'state'}));assert.equal(path.resolve(s.dataDir),path.resolve(record.profile));return s.graphicsWorkspaces.find(w=>w.projectId===record.projectId);};
 await page.getByRole('button',{name:'새 프로젝트',exact:true}).waitFor();
 await page.locator(`[data-project-id="${record.projectId}"]`).getByTestId('project-open').click();
 await page.getByTestId('graphics-studio').waitFor();await page.getByTestId('graphics-object-human').click();
 await page.getByRole('navigation',{name:'제작 단계',exact:true}).getByRole('button',{name:/리깅|리그/}).first().click();
 let w=await workspace();
 const retry=process.argv.includes('--retry-after-fix');
 if(retry){assert.equal(w.autoRigRuns?.at(-1)?.state,'failed');const previous=w.autoRigRuns.at(-1);assert.notEqual(sha(path.join(record.projectRoot,'graphics/auto-rig',previous.id,'worker.py')),sha('integrations/blender/graphics_auto_rig.py'),'Only explicit retry after implementation correction');}
 if(!(w.autoRigRuns??[]).length||retry){
  await page.getByRole('button',{name:'설치 상태 확인',exact:true}).click();
  await page.getByText('설치 준비됨',{exact:true}).waitFor({timeout:45000});
  await page.getByRole('combobox',{name:'자동 리깅 원본',exact:true}).selectOption('static-human');
  await page.getByLabel('모델 앞 방향',{exact:true}).selectOption('+X');
  await page.getByTestId('auto-rig-run').click();
  record.events.push({kind:retry?'explicit-retry-after-code-fix':'clicked-start',at:new Date().toISOString()});fs.writeFileSync(evidence,JSON.stringify(record,null,2));
 }
 const end=Date.now()+10*60*1000;
 while(Date.now()<end){w=await workspace();const run=w.autoRigRuns?.at(-1);if(run&&run.state!=='running')break;await new Promise(r=>setTimeout(r,1000));}
 const run=w.autoRigRuns?.at(-1);assert(run);record.run=run;record.workspace=w;record.errors=errors;record.events.push({kind:'result',at:new Date().toISOString(),state:run.state});
 fs.writeFileSync(evidence,JSON.stringify(record,null,2));
 await page.screenshot({path:path.resolve('artifacts/runtime/graphics-auto-rig-start-app.png')});
 assert.equal(run.state,'review',run.error);assert.equal(w.autoRigRuns.filter(r=>r.state==='review').length,1);
 assert.equal(w.tasks.length,0);assert.deepEqual(w.objects[0].accepted,{'model:main':'static-human'});
 assert.equal(sha(record.sourceOriginal),record.source.sha256);
 console.log(JSON.stringify({run:run.id,state:run.state,candidate:run.candidateVersionId,errors}));
}finally{await app.close();}
