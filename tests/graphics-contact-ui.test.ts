import test from 'node:test';
import assert from 'node:assert/strict';

test('contact review uses exact assembly and analysis IDs, forbids analysis adoption, and preserves saved state', { timeout: 90000 }, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { build } = await import('esbuild'), { _electron: electron } = await import('playwright'), { default: electronBinary } = await import('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-review-ui-'));
  const file = (name: string) => ({ path: name, bytes: 1, sha256: 'a'.repeat(64), kind: name.endsWith('.png') ? 'image' : 'report' });
  const version = (id: string, slot = 'main', jobId = 'assembly') => ({ id, objectId: 'human', role: 'model', slot, label: id, files: [] as ReturnType<typeof file>[], createdAt: '', sourceVersionIds: [], provenance: { type: 'local', jobId }, warnings: [] });
  const task = (id: string, taskId: string, outputs: string[], settings: Record<string, unknown> = {}) => ({ id, objectId: 'human', taskId, status: 'review', inputVersionIds: [], outputVersionIds: outputs, settings, instruction: '', requestHash: '', backendJobIds: [], createdAt: '', updatedAt: '', localOnly: true, message: '여러 파츠 조립 완료 · 채택하세요.' });
  const views = [
    { id: 'whole', label: '전체 · 방향 미확인', beforePath: 'whole-before.png', overlayPath: 'whole-overlay.png', afterPath: 'whole-after.png' },
    { id: 'neck', label: '목 연결부 · +X 방향', beforePath: 'neck-before.png', overlayPath: 'neck-overlay.png', afterPath: 'neck-after.png' },
  ];
  const contactVersion = (id: string, phase: 'analyze' | 'repair', status: 'ready' | 'blocked' | 'repaired') => ({
    ...version(id, phase === 'analyze' ? 'contact-review' : 'main', id),
    files: [file('contact.json'), file('regions.json'), ...views.flatMap(view => [file(view.beforePath), file(view.overlayPath), file(view.afterPath)])],
    contact: { schemaVersion: 1, phase, status, sourceVersionId: 'assembled', partVersionIds: ['head', 'body', 'hair'], reportPath: 'contact.json', regionsPath: 'regions.json', views: status === 'blocked' ? [] : views, warnings: status === 'blocked' ? ['보호 영역과 겹쳐 보정을 중단했습니다.'] : ['목 연결부를 확대해 확인하세요.'], allowedVertexCount: status === 'blocked' ? 0 : 28 },
  });
  const missing = contactVersion('missing', 'repair', 'repaired'); missing.files = missing.files.filter(item => item.path !== 'neck-after.png');
  const blocked = contactVersion('blocked', 'analyze', 'blocked');
  blocked.contact.views = Array.from({ length: 13 }, (_, index) => ({ ...views[0], id: `reference-${index}`, label: `원본 검토 ${index + 1}` }));
  const initial = { schemaVersion: 1, id: 'ws', projectId: 'p', revision: 7, objects: [{ id: 'human', name: 'Human', kind: 'character', createdAt: '', selectedTasks: [], settings: {}, instruction: '', references: [], accepted: { 'model:main': 'old', 'model:part-head': 'old-head' } }],
    versions: [version('assembled'), version('head', 'part-head'), version('body', 'part-body'), version('hair', 'part-hair'), contactVersion('analysis', 'analyze', 'ready'), blocked, contactVersion('repaired', 'repair', 'repaired'), version('repaired-head', 'part-head', 'repair'), version('repaired-body', 'part-body', 'repair'), version('repaired-hair', 'part-hair', 'repair'), missing],
    tasks: [task('assembly', 'M08', ['assembled', 'head', 'body', 'hair']), task('analysis', 'M06', ['analysis'], { contactPhase: 'analyze' }), task('blocked', 'M06', ['blocked'], { contactPhase: 'analyze' }), task('repair', 'M06', ['repaired', 'repaired-head', 'repaired-body', 'repaired-hair'], { contactPhase: 'repair' })], deliveries: [] };
  const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{GraphicsStudio}from${JSON.stringify(path.resolve('src/GraphicsStudio.tsx'))};import${JSON.stringify(path.resolve('src/style.css'))};
    window.actions=[];window.assetRequests=[];window.desktop={assetUrl:(projectId,path)=>{window.assetRequests.push({projectId,path});return './pixel.png?path='+encodeURIComponent(path)},call:()=>{throw Error('Unexpected desktop request')}};
    const project={schemaVersion:1,id:'p',name:'Contact fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt:'',updatedAt:'',revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    function Harness(){const[workspace,setWorkspace]=useState(${JSON.stringify(initial)});window.workspace=workspace;window.setAccepted=accepted=>setWorkspace(current=>({...current,objects:[{...current.objects[0],accepted}]}));const action=async value=>{window.actions.push(value);return workspace;};return <GraphicsStudio project={project} workspace={workspace} busy={false} onAction={action}/>;}createRoot(document.getElementById('root')).render(<Harness/>);`;
  await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'iife', outfile: path.join(root, 'ui.js'), jsx: 'automatic', logLevel: 'silent' });
  fs.writeFileSync(path.join(root, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNTkAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`);
  const app = await electron.launch({ executablePath: electronBinary as unknown as string, args: [path.join(root, 'main.cjs')] });
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
    const actions = () => page.evaluate(() => (window as any).actions);
    await page.getByTestId('graphics-version-assembled').click();
    assert.equal(await page.getByTestId('graphics-contact-analyze').isEnabled(), true);
    assert.deepEqual(await actions(), []);
    await page.getByTestId('graphics-contact-analyze').click();
    assert.deepEqual(await actions(), [{ kind: 'prepare-contact', versionId: 'assembled', phase: 'analyze' }]);
    await page.getByTestId('graphics-version-analysis').click();
    assert.equal(await page.getByTestId('graphics-current-task-assembly').count(), 0, 'old assembly success must not be the current contact status');
    assert.match(await page.getByTestId('graphics-current-task-analysis').innerText(), /분석 완료 · 영역 검토/);
    assert.doesNotMatch(await page.getByTestId('graphics-current-task-analysis').innerText(), /채택하세요/);
    assert.equal(await page.getByTestId('graphics-prepare').count(), 0, 'contact review must not expose unrelated generic preparation');
    assert.equal(await page.getByTestId('graphics-accept-preview').count(), 0);
    assert.equal(await page.getByTestId('graphics-accept-version').count(), 0);
    assert.equal(await page.getByTestId('graphics-contact-accept').count(), 0);
    assert.equal(await page.getByText('이 결과 더 보정', { exact: true }).count(), 0);
    await page.waitForFunction(() => !(document.querySelector('[data-testid="graphics-contact-repair"]') as HTMLButtonElement)?.disabled);
    assert.match(await page.getByTestId('graphics-contact-review').innerText(), /전체 · 방향 미확인/);
    assert.deepEqual(await page.getByTestId('graphics-contact-review').locator('img').evaluateAll(elements => elements.map(element => new URL((element as HTMLImageElement).src).searchParams.get('path'))), ['whole-before.png', 'whole-overlay.png', 'neck-before.png', 'neck-overlay.png']);
    await page.getByTestId('graphics-contact-repair').click();
    assert.deepEqual((await actions()).at(-1), { kind: 'prepare-contact', versionId: 'analysis', phase: 'repair' });
    await page.getByTestId('graphics-version-blocked').click();
    assert.match(await page.getByTestId('graphics-contact-current').innerText(), /영역 분석 완료 · 보정 불가/);
    assert.match(await page.getByTestId('graphics-current-task-blocked').innerText(), /영역 분석 완료 · 보정 불가/);
    assert.doesNotMatch(await page.getByTestId('graphics-current-task-blocked').innerText(), /채택하세요/);
    assert.equal(await page.getByTestId('graphics-current-task-assembly').count(), 0);
    assert.equal(await page.getByTestId('graphics-current-task-analysis').count(), 0);
    assert.equal(await page.getByTestId('graphics-contact-repair').count(), 0);
    assert.equal(await page.getByTestId('graphics-contact-accept').count(), 0);
    assert.match(await page.getByTestId('graphics-contact-review').innerText(), /보호 영역과 겹쳐/);
    assert.doesNotMatch(await page.getByTestId('graphics-contact-review').innerText(), /비교 파일을 모두 표시하지 못해/);
    assert.equal(await page.getByTestId('graphics-contact-views').evaluate(element => element.clientHeight <= 480 && element.scrollHeight > element.clientHeight), true, '13 reference views must scroll inside a bounded region');
    await page.getByTestId('graphics-contact-keep').click();
    assert.equal(await page.getByTestId('graphics-version-assembled').getAttribute('aria-pressed'), 'true');
    assert.equal((await actions()).length, 2);
    assert.deepEqual(await page.evaluate(() => (window as any).workspace), initial, 'navigation/preparation must not mutate originals, acceptance or settings');
    await page.getByTestId('graphics-version-missing').click();
    assert.equal(await page.getByTestId('graphics-contact-accept').isDisabled(), true);
    await page.getByTestId('graphics-version-repaired').click();
    await page.waitForFunction(() => !(document.querySelector('[data-testid="graphics-contact-accept"]') as HTMLButtonElement)?.disabled);
    assert.deepEqual(await page.getByTestId('graphics-contact-review').locator('img').evaluateAll(elements => elements.map(element => new URL((element as HTMLImageElement).src).searchParams.get('path'))), ['whole-before.png', 'whole-after.png', 'neck-before.png', 'neck-after.png']);
    await page.getByTestId('graphics-contact-accept').click();
    assert.deepEqual((await actions()).at(-1), { kind: 'accept', objectId: 'human', versionId: 'repaired' });
    await page.getByTestId('graphics-version-repaired-head').click();
    assert.equal(await page.getByTestId('graphics-accept-preview').count(), 0);
    assert.equal(await page.getByTestId('graphics-accept-version').count(), 0);
    assert.equal(await page.getByText('이 결과 더 보정', { exact: true }).count(), 0);
    await page.getByTestId('graphics-contact-part-review').click();
    assert.equal(await page.getByTestId('graphics-version-repaired').getAttribute('aria-pressed'), 'true');
    assert.equal((await actions()).length, 3, 'returning to the assembly is inspection only');
    await page.waitForFunction(() => !(document.querySelector('[data-testid="graphics-contact-accept"]') as HTMLButtonElement)?.disabled);
    await page.evaluate(() => (window as any).setAccepted({ 'model:main': 'repaired' }));
    assert.equal(await page.getByTestId('graphics-contact-accept').isEnabled(), true, 'main-only adoption must not hide unadopted repaired parts');
    await page.evaluate(() => (window as any).setAccepted({ 'model:main': 'repaired', 'model:part-head': 'repaired-head', 'model:part-body': 'repaired-body', 'model:part-hair': 'repaired-hair' }));
    await page.waitForFunction(() => (document.querySelector('[data-testid="graphics-contact-accept"]') as HTMLButtonElement).disabled);
    for (const [width, zoom] of [[1280, 1], [800, 1.5]]) {
      await app.evaluate(({ BrowserWindow }, { width, zoom }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(width, 1000); window.webContents.setZoomFactor(zoom); }, { width, zoom });
      await page.getByTestId('graphics-contact-accept').scrollIntoViewIfNeeded();
      assert.equal(await page.getByTestId('graphics-contact-review').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `review overflow at ${width}/${zoom}`);
      const box = await page.getByTestId('graphics-contact-accept').boundingBox();
      assert.ok(box && box.x >= 0 && box.width > 100);
    }
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});

test('unverified head comparison cameras have axis labels rather than anatomical claims', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync('src/HeadComparison.tsx', 'utf8');
  assert.match(source, /\['\+X 방향', 1, 0, 0\]/);
  assert.doesNotMatch(source, /\['정면', 1, 0, 0\]/);
  assert.match(source, /얼굴 방향은 아직 확인되지 않아/);
  const viewport = fs.readFileSync('src/Viewport.tsx', 'utf8');
  assert.match(viewport, /view\(0, 0, 1\)\}>\+Z 방향/);
  assert.doesNotMatch(viewport, /view\(0, 0, 1\)\}>정면/);
  assert.match(viewport, /모델의 얼굴·정면 방향이 확인되지 않아/);
});
