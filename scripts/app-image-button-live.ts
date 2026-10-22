/** Live verification: use only Partsmith UI; no direct service or result-file edits. */
import {_electron as electron} from "playwright";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
const version=process.env.PARTSMITH_CHECK_VERSION??"0.6.24";
const app=await electron.launch({executablePath:path.resolve(`release/${version}/win-unpacked/Partsmith.exe`)});
const page=await app.firstWindow();page.setDefaultTimeout(15000);
const state=()=>page.evaluate(()=>(window as any).desktop.call({type:"state"}));
assert(!(await state()).workbenches.some((w:any)=>w.activeJobId));
await page.getByRole("button",{name:"새 프로젝트",exact:true}).click();
await page.getByRole("dialog").getByRole("textbox").fill("앱 실행 검증 · 이미지 원본 수집");
await page.getByRole("dialog").getByRole("checkbox").uncheck();
await page.getByRole("button",{name:"프로젝트 만들기"}).click();
console.log("Project created through app UI");
console.log((await page.locator("body").innerText()).slice(0,1800));
fs.writeFileSync("artifacts/runtime/app-image-live-start.json",JSON.stringify({version,pid:app.process().pid}));
await new Promise<void>(resolve=>app.on("close",()=>resolve()));
