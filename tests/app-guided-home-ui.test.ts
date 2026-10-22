import test from 'node:test';
import assert from 'node:assert/strict';

test('home requires project choice, opens only preparation, and settings returns to project', { timeout: 60000 }, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { build } = await import('esbuild'), { _electron: electron } = await import('playwright');
  const { default: binary } = await import('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'partsmith-home-'));
  const project = { id:'p', name:'내 프로젝트', demo:false, updatedAt:'2026-10-15', parts:[], jobs:[], assets:[], builds:[], assemblies:[], revision:0 };
  const fixture = { projects:[project], key:{configured:false, storage:'none'}, settings:{tripoRegion:'international', blenderPath:'', unityPath:'', unityEditorPath:''}, dataDir:root };
  await build({ stdin:{ contents:`import React from 'react';import{createRoot}from'react-dom/client';import{App}from${JSON.stringify(path.resolve('src/App.tsx'))};import${JSON.stringify(path.resolve('src/style.css'))};window.calls=[];window.desktop={assetUrl:()=>'',call:async c=>{window.calls.push(c);if(c.type==='state')return ${JSON.stringify(fixture)};throw Error('Unexpected mutation '+c.type);}};createRoot(document.getElementById('root')).render(<App/>);`, loader:'tsx', resolveDir:process.cwd() }, plugins:[{name:'graphics-stub',setup(b){b.onResolve({filter:/\/GraphicsStudio$/},()=>({path:'stub',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export function GraphicsStudio({project,entryIntent,onOpenSettings}){return <main className="graphics-studio"><h1>{project.name}</h1><p data-testid="intent">{entryIntent?.kind}</p><button onClick={()=>onOpenSettings('tripo')}>필요한 연결 설정</button></main>}`,loader:'tsx',resolveDir:process.cwd()}));}}], bundle:true, format:'iife', outfile:path.join(root,'ui.js'), jsx:'automatic',logLevel:'silent' });
  fs.writeFileSync(path.join(root,'index.html'), '<html lang="ko"><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:800,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root,'index.html'))});});`);
  const app = await electron.launch({executablePath:binary as unknown as string,args:[path.join(root,'main.cjs')]});
  try {
    const page = await app.firstWindow();
    await page.getByRole('button',{name:'새 오브젝트 만들기',exact:false}).click();
    assert.equal(await page.getByRole('dialog').isVisible(),true);
    assert.equal((await page.evaluate(()=> (window as any).calls)).some((c:any)=>c.type==='project.create'),false);
    await page.getByRole('dialog').getByRole('button',{name:'내 프로젝트'}).click();
    assert.equal(await page.getByTestId('intent').textContent(),'new');
    assert.equal(await page.locator('.sidebar').isVisible(),false);
    await page.getByRole('button',{name:'필요한 연결 설정'}).click();
    assert.equal(await page.locator('#connection-tripo').isVisible(),true);
    assert.equal(await page.locator('#connection-tripo').getAttribute('class'),'surface provider-highlight');
    await page.getByRole('button',{name:'내 프로젝트 작업으로 돌아가기',exact:false}).click();
    assert.equal(await page.getByTestId('intent').textContent(),'new');
    await page.getByRole('button',{name:'Partsmith 홈'}).click();
    await page.getByRole('button',{name:'이미지·모델로 시작',exact:false}).click();
    assert.equal(await page.getByTestId('intent').textContent(),'import');
    await page.getByRole('button',{name:'Partsmith 홈'}).click();
    await page.getByRole('button',{name:'마지막 작업 이어하기',exact:false}).click();
    assert.equal(await page.getByTestId('intent').textContent(),'resume');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false);
    assert.deepEqual((await page.evaluate(()=> (window as any).calls)).filter((c:any)=>c.type!=='state'),[]);
  } finally { await app.close(); }
});
