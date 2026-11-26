import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {_electron as electron,chromium} from 'playwright';

// Real packaged binaries and real preload IPC. This script never replaces handlers,
// installs an integration, generates assets, signs in, or requests model inference.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'artifacts');
const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const flags=new Set(process.argv.slice(2));
const allowed=new Set(['--unity','--codex','--no-gpu','--unpacked-only','--portable-only']);
assert.ok([...flags].every(flag=>allowed.has(flag)),'Usage: node scripts/smoke-package.mjs [--unity] [--codex] [--no-gpu] [--unpacked-only|--portable-only]');
assert.ok(!(flags.has('--unpacked-only')&&flags.has('--portable-only')),'Choose one package format or omit both flags.');
assert.equal(process.platform,'win32','Windows packaged smoke requires Windows.');
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(output,'package-smoke-'));
const env={...process.env};
for(const key of Object.keys(env))if(/^(?:ELECTRON_RUN_AS_NODE|FORGE_DEV_URL|NODE_OPTIONS|NODE_PATH|OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_BASE_URL|OPENAI_API_BASE|OPENAI_ORG_ID|OPENAI_PROJECT_ID)$/i.test(key))delete env[key];
const windowsRoot=env.SystemRoot||env.SYSTEMROOT||env.WINDIR;
assert.ok(windowsRoot,'SystemRoot is required for process ownership checks.');
const powershell=path.join(windowsRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const taskkill=path.join(windowsRoot,'System32','taskkill.exe');
const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={status:'running',version:metadata.version,startedAt:new Date().toISOString(),checks:[],packages:[]};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
let failure;
let temporaryCleanupAllowed=true;

async function requiredFile(file){assert.ok((await stat(file)).isFile(),`Built file is missing: ${file}`);return file;}
async function resourceManifest(folder,relative=''){
  const files=[];
  for(const entry of await readdir(path.join(folder,relative),{withFileTypes:true})){
    if(entry.isSymbolicLink())throw new Error('Packaged integration resources must not contain symbolic links.');
    const name=path.join(relative,entry.name);
    if(entry.isDirectory())files.push(...await resourceManifest(folder,name));
    else if(entry.isFile()&&/\.(cs|json|md)$/i.test(entry.name))files.push(name);
  }
  return files;
}
const integrationFiles=await resourceManifest(path.join(root,'unity-integration'));
assert.ok(integrationFiles.some(file=>file.endsWith('BaekhoEnemyForgeBridge.cs')));
assert.ok(integrationFiles.some(file=>file.endsWith('BaekhoEnemyForgePreview.cs')));
assert.ok(integrationFiles.some(file=>file.replaceAll('\\','/').endsWith('Runtime/BaekhoEnemyForgeDirectionParameters.cs')));
async function verifyResources(resources){
  const hashes={};
  for(const relative of integrationFiles){
    const source=await readFile(path.join(root,'unity-integration',relative));
    const packaged=await readFile(path.join(resources,'unity-integration',relative));
    assert.equal(digest(packaged),digest(source),`Packaged integration source differs: ${relative}`);hashes[relative.replaceAll('\\','/')]=digest(packaged);
  }
  assert.equal(digest(await readFile(path.join(resources,'README.ko.md'))),digest(await readFile(path.join(root,'README.md'))),'Packaged Korean guide must match source.');
  return {resourcesPath:resources,integrationFiles:hashes,koreanGuideMatches:true};
}
async function inspectRenderer(page,entry){
  page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#app .topbar').waitFor();
  await page.waitForFunction(()=>typeof window.forge?.connect==='function'&&typeof window.forge?.previewFrame==='function');
  const sandbox=await page.evaluate(()=>({require:typeof window.require,process:typeof window.process,api:Object.keys(window.forge)}));
  assert.equal(sandbox.require,'undefined');assert.equal(sandbox.process,'undefined');
  for(const method of ['connect','catalog','validate','build','previewOpen','previewFrame','previewClose','aiStatus','aiGenerate','aiGenerateConcept','aiCancel','save','open','searchAssets','analyzeModel','animationInfo'])assert.ok(sandbox.api.includes(method),`Missing packaged preload method ${method}`);
  assert.equal(await page.locator('.nav-item').count(),7);
  assert.equal(await page.locator('.brand .version').innerText(),metadata.version.split('.').slice(0,2).join('.'));
  assert.equal(await page.locator('[data-kind]').count(),2);
  await page.locator('[data-kind="boss"]').click();await page.waitForFunction(()=>!document.body.classList.contains('busy'));
  assert.equal(await page.locator('[data-kind="boss"]').getAttribute('aria-selected'),'true');assert.equal(await page.locator('.nav-item').count(),9);
  await page.locator('[data-tab="phases"]').click();await page.locator('[data-tab="boss-combat"]').click();
  await page.locator('[data-kind="normal"]').click();await page.waitForFunction(()=>!document.body.classList.contains('busy'));
  entry.renderer={title:await page.title(),url:page.url(),sandbox,errors};
  if(flags.has('--codex')){
    const status=await page.evaluate(()=>window.forge.aiStatus());
    assert.equal(status.state,'ready',status.message);entry.codex={state:status.state,version:status.version,modelCount:status.models?.length??0};
  }
  if(flags.has('--unity')){
    // Use the actual UI connection flow, including catalog load and the Unity-rendered preview.
    await page.locator('[data-action="connect"]').first().click();
    await page.waitForFunction(()=>!document.body.classList.contains('busy'),undefined,{timeout:120000});
    await page.waitForFunction(()=>document.querySelector('.project-status .online')!==null,undefined,{timeout:30000});
    await page.waitForFunction(()=>{const image=document.querySelector('#preview-image');return image instanceof HTMLImageElement&&!image.hidden&&image.complete&&image.naturalWidth>0;},undefined,{timeout:120000});
    const live=await page.evaluate(async()=>{
      const catalog=await window.forge.catalog();const result=await window.forge.validate(catalog.template);
      const analysis=await window.forge.analyzeModel(catalog.template),animation=await window.forge.animationInfo(catalog.template.animation.controller);
      return {projectRoot:catalog.projectRoot,unityVersion:catalog.unityVersion,assets:catalog.assets.length,attacks:catalog.attacks.length,generatedAttacks:catalog.attacks.filter(a=>a.generated).map(a=>({typeId:a.typeId,name:a.name})),valid:result.valid,issues:result.issues,analysis,animation};
    });
    assert.equal(live.valid,true,JSON.stringify(live.issues));assert.ok(live.attacks>=5);assert.ok(live.assets>0);assert.ok(live.analysis.bounds);assert.ok(live.analysis.hpBarPosition[1]>live.analysis.bounds.max[1]);assert.equal(live.animation.move.type,'blend2d');assert.ok(live.animation.move.children.length>=5);entry.unity=live;
    await page.locator('[data-kind="boss"]').click();await page.waitForFunction(()=>!document.body.classList.contains('busy'),undefined,{timeout:120000});
    assert.equal(await page.locator('[data-kind="boss"]').getAttribute('aria-selected'),'true');
    const boss=await page.evaluate(async()=>{
      const catalog=await window.forge.catalog('boss'),validation=await window.forge.validate(catalog.template);
      let preview={state:'unavailable',reason:'보스 템플릿에 표시할 모델이 없습니다.'};
      if(catalog.template.model){
        const opened=await window.forge.previewOpen(catalog.template);
        try{
          const clip=catalog.template.animation.states.Idle??Object.values(catalog.template.animation.states).find(Boolean)??null;
          const frame=await window.forge.previewFrame({sessionId:opened.sessionId,sequence:1,time:0,yaw:25,pitch:12,zoom:1,clip,blueprint:catalog.template,attackId:null,showHitboxes:true,state:'Idle',moveParameters:[0,0]});
          preview={state:'rendered',imageReady:typeof frame.dataUrl==='string'&&frame.dataUrl.startsWith('data:image/'),warning:frame.warning??''};
        }finally{await window.forge.previewClose(opened.sessionId);}
      }
      return {kind:catalog.kind,version:catalog.template.version,blueprintKind:catalog.template.kind,phases:catalog.template.boss?.phases.length??0,immunities:catalog.boss?.immunities.length??0,items:catalog.boss?.items.length??0,attacks:catalog.attacks.length,hasSelfDestruct:catalog.attacks.some(attack=>attack.category==='selfDestruct'),valid:validation.valid,issues:validation.issues,warnings:catalog.warnings,preview};
    });
    assert.equal(boss.kind,'boss');assert.equal(boss.version,3);assert.equal(boss.blueprintKind,'boss');assert.ok(boss.phases>=1);assert.ok(boss.immunities>=1);assert.ok(boss.items>=1);assert.ok(boss.attacks>=1);assert.equal(boss.hasSelfDestruct,false);
    const bossErrors=boss.issues.filter(issue=>issue.severity==='error');
    assert.ok(boss.valid||bossErrors.length>0,'Invalid boss templates must report actionable issues.');
    assert.ok(bossErrors.every(issue=>issue.path.startsWith('animation')&&issue.message.trim()),JSON.stringify(boss.issues));
    await page.locator('[data-action="validate"]').first().click();await page.waitForFunction(()=>!document.body.classList.contains('busy'),undefined,{timeout:120000});
    if(!boss.valid){assert.ok(await page.locator('#issues .issue.error').count()>0);assert.match(await page.locator('#issues').innerText(),/클립|애니메이션|컨트롤러|Avatar|Animator/);}
    if(boss.preview.state==='rendered')assert.equal(boss.preview.imageReady,true);entry.unity.boss=boss;
  }
  await page.locator('[data-tab="attacks"]').click();await page.locator('[data-tab="animation"]').click();await page.locator('[data-tab="appearance"]').click();
  await page.screenshot({path:path.join(output,`package-${entry.format}.png`),fullPage:true});
  assert.deepEqual(errors,[],'Packaged renderer raised errors.');
  entry.screenshot=path.join(output,`package-${entry.format}.png`);entry.status='passed';
}
async function unpacked(){
  const executable=await requiredFile(path.join(root,'release','win-unpacked','Baekho Enemy Forge.exe'));
  const entry={format:'unpacked',executable};report.packages.push(entry);
  Object.assign(entry,await verifyResources(path.join(path.dirname(executable),'resources')));
  const application=await electron.launch({executablePath:executable,args:[`--user-data-dir=${path.join(temporary,'unpacked-user')}`,...(flags.has('--no-gpu')?['--disable-gpu']:[])],env,timeout:60000});
  temporaryCleanupAllowed=false;
  try{
    const facts=await application.evaluate(({app})=>({isPackaged:app.isPackaged,version:app.getVersion(),appPath:app.getAppPath(),resourcesPath:process.resourcesPath}));
    assert.equal(facts.isPackaged,true);assert.equal(facts.version,metadata.version);entry.electron=facts;
    await inspectRenderer(await application.firstWindow(),entry);
  }finally{
    // Playwright owns this exact child. Destroy its windows to bypass an accidental unload prompt.
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.destroy())).catch(()=>undefined);
    await application.close();
    temporaryCleanupAllowed=true;
  }
}
async function reservePort(){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return port;}
async function processSnapshot(environment){
  // Process command lines are deliberately excluded: they can contain other apps' secrets.
  const {stdout}=await execute(powershell,['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],{env:environment,windowsHide:true,timeout:10000,maxBuffer:2*1024*1024});
  const value=JSON.parse(stdout);return new Map((Array.isArray(value)?value:[value]).map(item=>[Number(item.ProcessId),item]));
}
function descendant(snapshot,pid,ancestor){const seen=new Set();while(pid>0&&!seen.has(pid)){if(pid===ancestor)return true;seen.add(pid);pid=Number(snapshot.get(pid)?.ParentProcessId??0);}return false;}
const sameProcess=(current,record)=>!!current&&!!record&&current.ProcessId===record.ProcessId&&current.CreationDate===record.CreationDate;
async function portable(){
  const executable=await requiredFile(path.join(root,'release',`Baekho-Enemy-Forge-${metadata.version}-Windows.exe`));
  const entry={format:'portable',executable,bytes:(await stat(executable)).size};report.packages.push(entry);
  const extraction=await mkdtemp(path.join(temporary,'portable-extract-'));
  const environment={...env};
  for(const key of Object.keys(environment))if(/^(?:TEMP|TMP)$/i.test(key))delete environment[key];
  environment.TEMP=extraction;environment.TMP=extraction;
  // NSIS ExecWait needs a short path for extraction parents that contain spaces.
  const {stdout}=await execute(powershell,['-NoProfile','-NonInteractive','-Command','(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TEMP).ShortPath'],{env:environment,windowsHide:true,timeout:10000});
  environment.TEMP=stdout.trim();environment.TMP=environment.TEMP;
  const port=await reservePort(),endpoint=`http://127.0.0.1:${port}`;
  const launcher=spawn(executable,[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${path.join(temporary,'portable-user')}`,...(flags.has('--no-gpu')?['--disable-gpu']:[])],{cwd:path.dirname(executable),env:environment,windowsHide:true,stdio:'ignore'});
  temporaryCleanupAllowed=false;
  let exited=false,launchError,launcherRecord,browserRecord,browser,page;
  const exit=new Promise(resolve=>{launcher.once('error',error=>{launchError=error;exited=true;resolve();});launcher.once('exit',(code,signal)=>{entry.launcherExit={code,signal};exited=true;resolve();});});
  try{
    launcherRecord=(await processSnapshot(environment)).get(launcher.pid);assert.ok(launcherRecord,'Portable launcher ownership could not be recorded.');
    const deadline=Date.now()+90000;let ready=false;
    while(Date.now()<deadline){if(launchError)throw launchError;if(exited)throw new Error('Portable launcher exited before renderer startup.');try{const response=await fetch(`${endpoint}/json/version`,{signal:AbortSignal.timeout(1000)});if(response.ok&&typeof(await response.json()).webSocketDebuggerUrl==='string'){ready=true;break;}}catch{/* Extraction in progress. */}await delay(400);}
    assert.ok(ready,'Portable executable did not start its private CDP endpoint.');
    browser=await chromium.connectOverCDP(endpoint,{timeout:15000});
    const session=await browser.newBrowserCDPSession();const info=await session.send('SystemInfo.getProcessInfo');const pid=Number(info.processInfo.find(p=>p.type==='browser')?.id);await session.detach();
    const snapshot=await processSnapshot(environment);assert.ok(descendant(snapshot,pid,launcher.pid),'Refusing to operate a browser not owned by the portable launcher.');browserRecord=snapshot.get(pid);entry.launcherPid=launcher.pid;entry.browserPid=pid;
    const pageDeadline=Date.now()+30000;while(!page&&Date.now()<pageDeadline){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('file:'));if(!page)await delay(200);}
    assert.ok(page,'Portable renderer did not open a local page.');
    const localPage=fileURLToPath(page.url());const marker=`${path.sep}app.asar${path.sep}`;const index=localPage.indexOf(marker);assert.ok(index>0,'Portable renderer must load the packaged app.asar.');
    const resources=await realpath(localPage.slice(0,index));Object.assign(entry,await verifyResources(resources));
    assert.ok(resources.toLowerCase().startsWith((await realpath(extraction)).toLowerCase()+path.sep),'Portable resources must belong to the isolated extraction directory.');
    await inspectRenderer(page,entry);
  }finally{
    if(page&&browserRecord&&!page.isClosed())await Promise.race([page.evaluate(()=>window.close()).catch(()=>undefined),delay(1500)]);
    await Promise.race([exit,delay(12000)]);
    if(!exited){
      const snapshot=await processSnapshot(environment);const ownedLauncher=sameProcess(snapshot.get(launcher.pid),launcherRecord);const ownedBrowser=sameProcess(snapshot.get(Number(browserRecord?.ProcessId)),browserRecord);
      const pid=ownedLauncher?launcher.pid:ownedBrowser?Number(browserRecord.ProcessId):null;
      assert.ok(pid,'Refusing cleanup because portable process ownership could not be confirmed.');
      await execute(taskkill,['/PID',String(pid),'/T','/F'],{env:environment,windowsHide:true,timeout:10000});entry.forcedCleanup=true;await Promise.race([exit,delay(5000)]);
    }
    if(browser&&browserRecord)await browser.close().catch(()=>undefined);
    const remaining=await processSnapshot(environment);assert.ok(exited&&!sameProcess(remaining.get(Number(browserRecord?.ProcessId)),browserRecord),'Owned portable processes must stop before removing extraction files.');
    temporaryCleanupAllowed=true;
  }
}
try{
  if(!flags.has('--portable-only')){await unpacked();report.checks.push('Actual unpacked executable, packaged version, renderer, sandboxed preload and matching bundled Unity sources');}
  if(!flags.has('--unpacked-only')){await portable();report.checks.push('Actual portable launcher, isolated extraction, verified owned browser and real renderer/preload');}
  report.status='passed';
}catch(error){failure=error;report.status='failed';report.error=error instanceof Error?error.stack:String(error);}
finally{
  try{
    assert.ok(temporaryCleanupAllowed,'Temporary files were preserved because owned process termination could not be confirmed.');
    const resolved=await realpath(temporary),relative=path.relative(await realpath(output),resolved);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.dirname(resolved)===(await realpath(output))&&path.basename(resolved).startsWith('package-smoke-'),'Temporary cleanup path must remain in this smoke-test workspace.');
    await rm(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:100});report.temporaryDirectoryRemoved=true;
  }catch(error){report.status='failed';report.cleanupError=error instanceof Error?error.message:String(error);failure??=error;}
  report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'package-report.json'),JSON.stringify(report,null,2),'utf8');
}
process.stdout.write(`${report.status.toUpperCase()}: packaged smoke report ${path.join(output,'package-report.json')}\n`);
if(failure){process.stderr.write(`${failure instanceof Error?failure.stack:String(failure)}\n`);process.exitCode=1;}
