/** Synthetic original-download fixture; tests packaged collection UI, never service generation. */
import fs from "node:fs";import os from "node:os";import path from "node:path";
import assert from "node:assert/strict";import {_electron as electron} from "playwright";
import {Store} from "../engine/store";import {Engine} from "../engine/engine";import {WorkbenchEngine} from "../engine/workbench";
import {ChromeJobLedger} from "../engine/chrome-job-ledger";import {NativeDownloadCollector} from "../engine/native-download";import {collectImageResult} from "../engine/chrome-image-result";
const data=fs.mkdtempSync(path.join(os.tmpdir(),"partsmith-collect-package-")),store=new Store(data);await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
const engine=new WorkbenchEngine(store,{execute:async()=>{throw Error("unused");}},{externalRunner:{run:async()=>({status:"needs_input",summary:"Synthetic saved response fixture"}),verifyReceipt(){}}});
const project=new Engine(store,{} as any).create("수집 UI 검사 · 합성 원본");
const w=engine.action(project.id,{kind:"execute",request:{step:"concept",provider:"gpt",executionMode:"codex-app",generationCount:1,prompt:"Synthetic fixture only"},approval:{accepted:true,studioCreditLimit:0,imageCreditLimit:0}});
await engine.wait(w.id);const job=engine.get(w.id).jobs[0],workspace=path.join(store.directory(project.id),`workbench/${w.id}/jobs/${job.id}`);
const packet=JSON.parse(fs.readFileSync(path.join(workspace,"external-request.json"),"utf8"));
const ledgerFile=path.join(data,"workbench-chrome-journals",w.id,`${job.id}.json`),ledger=new ChromeJobLedger(ledgerFile,packet,job.externalExecution!.requestHash);
ledger.begin({phase:"images",observedCost:0,sourceModelId:"",url:"https://chatgpt.com/"});ledger.complete({phase:"images",resultId:"package-test",url:"https://chatgpt.com/c/package-test"});
// Host defaults use the OS Downloads path. Fixture collection uses a private folder,
// then stores only the binding expected by that host; no real downloads are read.
const downloads=path.join(data,"fixture-downloads");fs.mkdirSync(downloads);
const stateFile=ledgerFile.replace(/\.json$/,".downloads.json"),collector=new NativeDownloadCollector(downloads,workspace,"image",stateFile),ticket=collector.prepare("images","https://chatgpt.com/c/package-test");
fs.writeFileSync(path.join(downloads,"synthetic.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64"));collector.collect(ticket.id);
collectImageResult(workspace,packet,job.externalExecution!.requestHash,"https://chatgpt.com/c/package-test",collector,[{ticketId:ticket.id}]);
engine.shutdown();store.db.close();
const launch=async()=>{
 const app=await electron.launch({executablePath:path.resolve("release/0.6.24/win-unpacked/Partsmith.exe"),env:{...process.env,PARTSMITH_DATA:data}});
 const actualDownloads=await app.evaluate(({app})=>app.getPath("downloads"));
 const saved=JSON.parse(fs.readFileSync(stateFile,"utf8"));saved.downloads=actualDownloads;fs.writeFileSync(stateFile,JSON.stringify(saved));
 const page=await app.firstWindow();page.setDefaultTimeout(15000);
 await page.locator(`[data-testid="project-card"][data-project-id="${project.id}"]`).getByTestId("project-open").click();return {app,page};
};
let {app,page}=await launch();
assert(await page.getByTestId("workbench-external-recover").isEnabled());
await page.getByTestId("workbench-external-receive").click();await page.getByTestId("workbench-select-0").waitFor();
await app.close();({app,page}=await launch());
const state=await page.evaluate(()=>(window as any).desktop.call({type:"state"}));const bench=state.workbenches.find((v:any)=>v.id===w.id);
assert.equal(bench.jobs[0].status,"review");assert.deepEqual(bench.selections,{});assert(!bench.activeJobId);assert.equal(bench.jobs[0].externalExecution.worker.attempt,1);
assert(!fs.existsSync(path.join(workspace,"app-worker-1")));
await app.close();console.log(JSON.stringify({version:"0.6.24",synthetic:true,savedReceiptButton:true,recoveryButton:true,restart:true,newWorkerCalls:0,paidSubmissions:0,data}));
