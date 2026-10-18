/** Read-only current-package startup check. Never dispatches an app action. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extractFile} from '@electron/asar';
import {_electron as electron} from 'playwright';
const version=JSON.parse(fs.readFileSync('package.json','utf8')).version;
const executable=path.resolve(`release/${version}/win-unpacked/Partsmith.exe`);
const profile=path.join(process.env.APPDATA,'partsmith');
const env={...process.env,PARTSMITH_DATA:profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:executable,env,timeout:30000});
const report={at:new Date().toISOString(),version,executable,paidSubmissions:0,productionGPT:0,arpAI:0,errors:[]};
try{
 report.runtime=await app.evaluate(({app,BrowserWindow})=>({version:app.getVersion(),packaged:app.isPackaged,data:app.getPath('userData'),windows:BrowserWindow.getAllWindows().map(w=>({title:w.getTitle(),visible:w.isVisible()}))}));
 assert.equal(report.runtime.version,version);assert.equal(report.runtime.packaged,true);assert.equal(path.resolve(report.runtime.data),path.resolve(profile));
 const page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));await page.locator('.home').waitFor({timeout:30000});
 const s=await page.evaluate(()=>window.desktop.call({type:'state'}));
 assert.equal(path.resolve(s.dataDir),path.resolve(profile));
 report.workspaces=s.graphicsWorkspaces.length;report.projects=s.projects.length;
 report.active=s.graphicsWorkspaces.flatMap(w=>w.tasks).filter(t=>['running','submitting','preparing'].includes(t.status)).map(t=>({id:t.id,status:t.status}));
 assert.deepEqual(report.active,[]);assert.deepEqual(report.errors,[]);
 report.sourceWorkerSha=createHash('sha256').update(fs.readFileSync('integrations/blender/pipeline.py')).digest('hex');
 report.packagedWorkerSha=createHash('sha256').update(fs.readFileSync(path.resolve(`release/${version}/win-unpacked/resources/integrations/blender/pipeline.py`))).digest('hex');
 assert.equal(report.sourceWorkerSha,report.packagedWorkerSha);
 const digest=data=>createHash('sha256').update(data).digest('hex');
 const asar=path.resolve(`release/${version}/win-unpacked/resources/app.asar`);
 report.packageSha=digest(fs.readFileSync(asar));
 report.mainSha=digest(fs.readFileSync('dist-electron/main.cjs'));
 assert.equal(digest(extractFile(asar,'dist-electron/main.cjs')),report.mainSha);
 report.nativeResources={};
 for(const file of ['graphics_planar_repair.py','tripo_part_preservation.py']){
  const original=digest(fs.readFileSync(path.join('integrations/blender',file)));
  assert.equal(digest(fs.readFileSync(path.join(path.dirname(asar),'integrations/blender',file))),original);
  report.nativeResources[file]=original;
 }
 report.passed=true;
}catch(error){report.failure=String(error);throw error;}
finally{fs.writeFileSync('artifacts/runtime/qa-20261018-production-launch.json',JSON.stringify(report,null,2));await app.close();}
console.log(JSON.stringify(report));
