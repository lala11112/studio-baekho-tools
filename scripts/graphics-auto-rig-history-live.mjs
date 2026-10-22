/** Read-only DOM review in an existing isolated test profile; frozen absolute paths remain intact. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';
import binary from 'electron';

const runtime=path.resolve('artifacts/runtime'),evidencePath=path.join(runtime,'graphics-auto-rig-history-live.json');
assert(!fs.existsSync(evidencePath),'Keep earlier evidence immutable');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixture=read(path.join(runtime,'graphics-auto-rig-app-fixture.json'));
assert.equal(path.basename(fixture.root),'ps-auto-rig-app-0EC8HU');
const originalWorkspace=path.join(fixture.projectRoot,'graphics/workspace.json'),originalSha=sha(originalWorkspace),before=read(originalWorkspace);
// Saved requests bind absolute paths; reuse this already-isolated profile read-only.
const copyRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ps-auto-rig-history-')),profile=fixture.profile;
const projectRoot=path.join(profile,'projects',fixture.projectId),workspacePath=path.join(projectRoot,'graphics/workspace.json');
const originalInspection=before.autoRigRuns.find(run=>run.operation==='inspect'&&run.sourceVersionId==='existing-arp-copy');
const repair=before.autoRigRuns.find(run=>run.operation==='repair'&&run.sourceVersionId==='existing-arp-copy');
const correctedInspection=before.autoRigRuns.find(run=>run.operation==='inspect'&&run.sourceVersionId===repair.candidateVersionId);
assert(originalInspection&&repair&&correctedInspection);
const registered=[...new Map([...before.versions.flatMap(version=>version.files),...before.autoRigRuns.flatMap(run=>[run.source,...run.files,...(run.reportFile?[run.reportFile]:[])])].map(file=>[file.path,file])).values()];
const fileHashes=registered.map(file=>({path:file.path,sha256:sha(path.join(projectRoot,file.path))}));
const bootstrap=path.join(copyRoot,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`const{app,dialog}=require('electron');app.setAppPath(${JSON.stringify(process.cwd())});process.chdir(${JSON.stringify(process.cwd())});global.fetch=async()=>{throw Error('Network blocked for read-only history review')};dialog.showErrorBox=(a,b)=>{console.error(a,b);app.exit(1)};app.on('browser-window-created',(_,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);w.webContents.session.webRequest.onBeforeRequest((r,cb)=>cb({cancel:/^https?:/.test(r.url)}))});require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});`);
const env={...process.env,PARTSMITH_DATA:profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:binary,args:[bootstrap],env,timeout:30000});
const report={originalFixture:fixture.root,harnessRoot:copyRoot,profile,isolatedProfileReused:true,projectId:fixture.projectId,originalWorkspaceSha256:originalSha,graphicsActions:[],cases:[],paidSubmissions:0,productionGPT:0,newInspections:0,newRepairs:0,newAdoptions:0};
try{
  const page=await app.firstWindow(),errors=[],requests=[];report.requestedUrls=requests;page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(request.url()));page.setDefaultTimeout(15000);
  await page.getByRole('button',{name:'새 프로젝트',exact:true}).waitFor();
  await page.evaluate(()=>{const previous=window.desktop.call.bind(window.desktop);window.__historyGraphicsActions=[];window.desktop.call=async command=>{if(command.type==='graphics.action'){window.__historyGraphicsActions.push(command);throw Error('All graphics mutations forbidden in read-only history review');}return previous(command);};});
  await page.locator(`[data-project-id="${fixture.projectId}"]`).getByTestId('project-open').click();
  await page.getByTestId('graphics-object-'+fixture.objectId).click();
  await page.getByRole('navigation',{name:'제작 단계',exact:true}).getByRole('button',{name:/리깅|리그/}).first().click();
  const history=page.locator('.gs-version-history');if(!await history.evaluate(element=>element.open))await history.locator(':scope > summary').click();
  const selectSaved=async(versionId,inspection)=>{
    const expected=inspection.files.find(file=>/\.glb$/i.test(file.path));assert(expected);
    const expectedUrl=await page.evaluate(({id,file})=>window.desktop.assetUrl(id,file),{id:fixture.projectId,file:expected.path});
    const responsePromise=page.waitForResponse(response=>response.url()===expectedUrl);
    await page.getByTestId('graphics-version-'+versionId).click();
    const review=page.getByTestId('auto-rig-review');await review.waitFor();
    await page.getByTestId('viewport-rig-inspection-preview').waitFor();
    report.expectedPreviewUrl=expectedUrl;
    const response=await responsePromise;
    if(inspection.inspection.islands.some(island=>island.vertexIndices?.length)){
      assert.equal(response.status(),200);
      await page.waitForFunction(()=>document.querySelector('.inspection-viewport')?.getAttribute('data-full-skin-influences')==='12');
    }
    assert(requests.includes(expectedUrl),'Exact candidate inspection GLB was requested');
    const disclosure=page.getByTestId('auto-rig-review').locator('details').filter({has:page.getByText('선택 영역만 가중치 보정 · 선택 사항',{exact:true})});if(!await disclosure.evaluate(element=>element.open))await page.getByText('선택 영역만 가중치 보정 · 선택 사항',{exact:true}).click();
    const island=inspection.inspection.islands.find(item=>item.vertices===8);assert(island);
    await page.getByLabel('보정 대상 부위').selectOption(JSON.stringify([island.mesh,island.islandId]));
    const button=page.getByRole('button',{name:'선택 부위 보정 후보 만들기',exact:true});
    return {review,island,button,expectedUrl,responseStatus:response.status()};
  };
  const old=await selectSaved('existing-arp-copy',originalInspection);
  assert.equal(old.island.vertexIndices,undefined);
  assert.equal(await old.button.isDisabled(),true);
  assert.match(await old.review.innerText(),/이전 검사는 정확한 강조 영역 정보가 없습니다/);
  assert.equal(await page.getByTestId('viewport-rig-region').count(),0);
  await page.screenshot({path:path.join(runtime,'graphics-auto-rig-history-original.png')});
  report.cases.push({versionId:'existing-arp-copy',selectedInspectionRunId:originalInspection.id,skippedRepairRunId:repair.id,previewUrl:old.expectedUrl,previewResponseStatus:old.responseStatus,regionIndicesMissing:true,correctionDisabled:true,reason:'Saved original inspection predates exact region IDs; no reinspection performed'});
  const current=await selectSaved(repair.candidateVersionId,correctedInspection);
  await page.getByTestId('viewport-rig-region').waitFor();
  await page.waitForFunction(()=>{const button=[...document.querySelectorAll('button')].find(element=>element.textContent==='선택 부위 보정 후보 만들기');return button&&!button.disabled;});
  assert.match(await page.getByTestId('viewport-rig-region').innerText(),/8개 원본 정점/);
  assert.equal(await current.button.isEnabled(),true);
  await page.screenshot({path:path.join(runtime,'graphics-auto-rig-history-corrected.png')});
  report.cases.push({versionId:repair.candidateVersionId,selectedInspectionRunId:correctedInspection.id,previewUrl:current.expectedUrl,highlightedNativeVertices:8,correctionEnabled:true,correctionClicked:false});
  report.graphicsActions=await page.evaluate(()=>window.__historyGraphicsActions);assert.deepEqual(report.graphicsActions,[]);
  report.pageErrors=errors;assert.deepEqual(errors,[]);
  const after=read(workspacePath);assert.deepEqual(after,before);assert.equal(sha(originalWorkspace),originalSha);
  for(const file of fileHashes)assert.equal(sha(path.join(projectRoot,file.path)),file.sha256);
  report.workspaceUnchanged=true;report.originalFixtureUnchanged=true;report.registeredFilesUnchanged=fileHashes.length;report.checkedAt=new Date().toISOString();report.passed=true;
  fs.writeFileSync(evidencePath,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(cause){report.passed=false;report.error=cause.stack??String(cause);fs.writeFileSync(evidencePath,JSON.stringify(report,null,2));throw cause;}
finally{await app.close();}
