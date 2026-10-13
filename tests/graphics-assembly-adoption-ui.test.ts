import test from 'node:test';
import assert from 'node:assert/strict';

test('assembly adoption is explicit beside the preview and in details while individual parts and legacy main remain separate', { timeout: 60000 }, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { build } = await import('esbuild'), { _electron: electron } = await import('playwright'), { default: electronBinary } = await import('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-adoption-ui-'));
  const version = (id: string, slot: string, jobId: string) => ({ id, objectId: 'human', role: 'model', slot, label: id, files: [], createdAt: '', sourceVersionIds: [], provenance: { type: 'local', jobId }, warnings: [] });
  const task = (id: string, outputs: string[]) => ({ id, objectId: 'human', taskId: 'M08', status: 'review', inputVersionIds: [], outputVersionIds: outputs, settings: {}, instruction: '', requestHash: '', backendJobIds: [], createdAt: '', updatedAt: '', localOnly: true, message: '' });
  const initial = { schemaVersion: 1, id: 'ws', projectId: 'p', revision: 0, objects: [{ id: 'human', name: 'Human', kind: 'character', createdAt: '', selectedTasks: [], settings: {}, instruction: '', references: [], accepted: {} }],
    versions: [version('assembled', 'main', 'assembly'), version('placed-head', 'part-head', 'assembly'), version('placed-body', 'part-body', 'assembly'), version('legacy-main', 'main', 'legacy')], tasks: [task('assembly', ['assembled', 'placed-head', 'placed-body']), task('legacy', ['legacy-main'])], deliveries: [] };
  const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{GraphicsStudio}from${JSON.stringify(path.resolve('src/GraphicsStudio.tsx'))};import${JSON.stringify(path.resolve('src/style.css'))};
    window.desktop={assetUrl:()=>'',call:()=>{throw Error('Unexpected desktop request')}};window.actions=[];
    const project={schemaVersion:1,id:'p',name:'Assembly adoption fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt:'',updatedAt:'',revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    function Harness(){const[workspace,setWorkspace]=useState(${JSON.stringify(initial)});window.setAccepted=accepted=>setWorkspace(current=>({...current,objects:[{...current.objects[0],accepted}]}));const action=async value=>{window.actions.push(value);return workspace;};return <GraphicsStudio project={project} workspace={workspace} busy={false} onAction={action}/>;}createRoot(document.getElementById('root')).render(<Harness/>);`;
  await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'iife', outfile: path.join(root, 'ui.js'), jsx: 'automatic', logLevel: 'silent' });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`);
  const app = await electron.launch({ executablePath: electronBinary as unknown as string, args: [path.join(root, 'main.cjs')] });
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(8000);
    await page.getByTestId('graphics-version-assembled').click();
    assert.equal(await page.getByTestId('graphics-accept-preview').innerText(), '이 조립과 파트 채택');
    assert.equal(await page.getByTestId('graphics-accept-version').innerText(), '이 조립과 파트 채택');
    assert.match(await page.getByTestId('graphics-preview-actions').innerText(), /이후 파트 UV도 이 배치를 사용/);
    assert.equal(await page.evaluate(() => (window as any).actions.length), 0);
    await page.getByTestId('graphics-accept-preview').click();
    assert.deepEqual(await page.evaluate(() => (window as any).actions), [{ kind: 'accept', objectId: 'human', versionId: 'assembled' }]);
    await page.evaluate(() => (window as any).setAccepted({ 'model:main': 'assembled' }));
    assert.equal(await page.getByTestId('graphics-accept-preview').isEnabled(), true, 'main adoption alone must not claim its parts are adopted');
    await page.evaluate(() => (window as any).setAccepted({ 'model:main': 'assembled', 'model:part-head': 'placed-head', 'model:part-body': 'placed-body' }));
    await page.waitForFunction(() => (document.querySelector('[data-testid="graphics-accept-preview"]') as HTMLButtonElement).disabled);
    assert.equal(await page.getByTestId('graphics-accept-preview').innerText(), '현재 채택한 조립·파트');
    await page.getByTestId('graphics-version-legacy-main').click();
    assert.equal(await page.getByTestId('graphics-accept-preview').innerText(), '이 모델 채택');
    await page.evaluate(() => (window as any).setAccepted({}));
    await page.getByTestId('graphics-version-placed-head').click();
    assert.equal(await page.getByTestId('graphics-accept-preview').innerText(), '이 모델 채택');
    assert.equal(await page.evaluate(() => (window as any).actions.length), 1); assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
