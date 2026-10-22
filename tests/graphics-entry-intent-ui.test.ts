import test from 'node:test';
import assert from 'node:assert/strict';

for (const intent of ['new', 'import'] as const) {
  test(`home ${intent} opens target selection after creating the first project without a graphics workspace`, { timeout: 60000 }, async () => {
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
    const { build } = await import('esbuild'), { _electron: electron } = await import('playwright');
    const { default: binary } = await import('electron');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `partsmith-entry-${intent}-`));
    const project = { id: 'first-project', name: '새 프로젝트', demo: false, updatedAt: '2026-10-18', parts: [], jobs: [], assets: [], builds: [], assemblies: [], revision: 0 };
    const fixture = { projects: [], graphicsWorkspaces: [], key: { configured: false, storage: 'none' }, settings: { tripoRegion: 'international', blenderPath: '', unityPath: '', unityEditorPath: '' }, dataDir: root };
    await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{App}from${JSON.stringify(path.resolve('src/App.tsx'))};import${JSON.stringify(path.resolve('src/style.css'))};window.calls=[];const state=${JSON.stringify(fixture)};window.desktop={assetUrl:()=>'',call:async c=>{window.calls.push(c);if(c.type==='state')return structuredClone(state);if(c.type==='project.create'){const project=${JSON.stringify(project)};state.projects.push(project);return structuredClone(project);}throw Error('Unexpected command '+c.type);}};createRoot(document.getElementById('root')).render(<App/>);`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'iife', outfile: path.join(root, 'ui.js'), jsx: 'automatic', logLevel: 'silent' });
    fs.writeFileSync(path.join(root, 'index.html'), '<html lang="ko"><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
    fs.writeFileSync(path.join(root, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`);
    const app = await electron.launch({ executablePath: binary as unknown as string, args: [path.join(root, 'main.cjs')] });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.getByRole('button', { name: intent === 'new' ? '새 오브젝트 만들기' : '이미지·모델로 시작', exact: false }).click();
      await page.getByRole('dialog').getByRole('button', { name: '새 프로젝트 만들기', exact: false }).click();
      await page.getByRole('dialog').getByRole('button', { name: '프로젝트 만들기', exact: false }).click();
      const target = page.getByRole('dialog', { name: '새 오브젝트 만들기', exact: true });
      await target.waitFor({ state: 'visible', timeout: 10000 });
      assert.match(await target.innerText(), /만들 대상을 선택하세요/);
      assert.equal(await target.getByRole('button', { name: '오브젝트 만들기', exact: true }).isEnabled(), false);
      await target.getByRole('button', { name: '취소', exact: true }).click();
      await target.waitFor({ state: 'hidden' });
      // Refresh reads cannot create a graphics workspace or consume the cancelled intent again.
      await page.waitForFunction(() => (window as any).calls.filter((c: any) => c.type === 'state').length >= 3);
      assert.equal(await page.getByRole('dialog').count(), 0);
      const mutations = (await page.evaluate(() => (window as any).calls)).filter((c: any) => c.type !== 'state');
      assert.deepEqual(mutations, [{ type: 'project.create', name: '새 프로젝트', demo: false }]);
      assert.deepEqual(errors, []);
    } finally { await app.close(); }
  });
}
