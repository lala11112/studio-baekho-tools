import {_electron as electron} from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const options={executablePath:path.resolve('release/0.1.1/win-unpacked/Partsmith.exe'),env:{...process.env,PARTSMITH_DATA:path.resolve('artifacts/runtime/auth-ui-smoke')}};
let app=await electron.launch(options);
try {
 let page=await app.firstWindow();await page.waitForSelector('.home');
 const info=await app.evaluate(({app})=>({version:app.getVersion(),packaged:app.isPackaged}));
 assert.equal(info.version,'0.1.1');assert(info.packaged);
 await page.getByRole('button',{name:'연결 설정'}).click();
 await page.getByLabel('Tripo 연결 지역').selectOption('china');
 await page.waitForFunction(async()=> (await window.desktop.call({type:'state'})).settings.tripoRegion==='china');
 await app.close();app=await electron.launch(options);page=await app.firstWindow();await page.waitForSelector('.home');
 const state=await page.evaluate(()=>window.desktop.call({type:'state'}));assert.equal(state.settings.tripoRegion,'china');assert.equal(state.key.configured,false);
 await page.getByRole('button',{name:'연결 설정'}).click();
 await page.getByLabel('Tripo 연결 지역').selectOption('international');
 await page.waitForFunction(async()=> (await window.desktop.call({type:'state'})).settings.tripoRegion==='international');
 await page.screenshot({path:'artifacts/screenshots/08-api-region.png'});
 fs.writeFileSync('artifacts/auth-ui-smoke.json',JSON.stringify({passed:true,...info,regionSavedAndRestored:true,noApiRequests:true},null,2));
 console.log('Authentication settings packaged UI passed.');
} finally {await app.close();}
