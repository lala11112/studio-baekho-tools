import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import electronPath from "electron";

// Offline Electron fixture only. It neither opens ChatGPT nor uses an account.
const root = process.cwd();
const directory = path.join(
  root,
  "artifacts/runtime/chatgpt-browser-smoke",
  randomUUID(),
);
fs.mkdirSync(directory, { recursive: true });
const entry = path.join(directory, "fixture.cjs");
await build({
  stdin: {
    resolveDir: root,
    loader: "js",
    contents: String.raw`
import {app,BrowserWindow} from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
import {ChatGptBrowser} from './electron/chatgpt-browser';
async function main(){
const root=process.cwd(),directory=process.env.PARTSMITH_CHATGPT_FIXTURE_DIR;
app.setPath('userData',path.join(directory,'user-data'));
process.env.PARTSMITH_CHATGPT_TEST='1';
const workspace=path.join(directory,'workspace');fs.mkdirSync(workspace);
const originals=Array.from({length:4},(_,index)=>{const png=new PNG({width:256,height:256});png.data.fill(255-index*40);return PNG.sync.write(png);});const original=originals[0];
const reference=path.join(workspace,'reference.png');fs.writeFileSync(reference,original);
const prompt='Create four separate head images, front back left right';
const response='<div data-turn-key="fixture-turn"><h4>내가 한 말:</h4><div>'+prompt+'</div><h4>ChatGPT 답변:</h4><div data-testid="generated-image-gallery">'+[0,1,2,3].map(index=>'<button data-testid="generated-image-preview" aria-label="생성된 이미지 '+(index+1)+'" onclick="showViewer('+index+')"><img src="/preview-'+index+'.png" alt="생성된 이미지 '+(index+1)+'" width="128" height="128"></button>').join('')+'</div></div>';
function html(conversation=false){return '<!doctype html><html><body><nav>PRIVATE SIDEBAR HISTORY MUST NOT APPEAR</nav><main><section role="region" aria-label="Conversation" id="result">'+(conversation?response:'')+'</section><form onsubmit="event.preventDefault()"><div contenteditable="true" aria-label="ChatGPT에게 물어보세요" style="height:70px;border:1px solid #aaa"></div><input type="file" accept="image/*" aria-label="사진 첨부" multiple style="display:none" onchange="document.getElementById(\'uploaded\').textContent=this.files[0].name"><div id="uploaded"></div><button type="button" aria-label="보내기" onclick="send()">보내기</button><button type="button" aria-label="Regenerate">Regenerate</button></form></main><script>const response='+JSON.stringify(response)+';function send(){document.getElementById("result").innerHTML=response;document.querySelector("[contenteditable]").textContent="";history.pushState({},"","/c/fixture-chat");}function showViewer(index){let el=document.createElement("div");el.setAttribute("role","dialog");el.style="position:fixed;inset:0;background:white;z-index:99";el.innerHTML=\'<h2>이미지 미리 보기</h2><img src="/original-\'+index+\'.png" alt="생성된 이미지 \'+(index+1)+\'" width="256" height="256"><a download="original.png" href="/original-\'+index+\'.png" aria-label="다운로드">다운로드</a><button aria-label="뷰어 닫기" onclick="this.parentElement.remove()">뷰어 닫기</button>\';document.body.appendChild(el);}</script></body></html>'}
const server=http.createServer((request,response)=>{
 if(/^\/(?:original|preview)-[0-3]\.png$/.test(request.url)){response.setHeader('Content-Type','image/png');response.end(originals[Number(request.url.match(/[0-3]/)[0])]);}
 else if(request.url==='/login'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<main><button>로그인</button><input type="password"></main>');}
 else{response.setHeader('Content-Type','text/html; charset=utf-8');response.end(html(request.url?.startsWith('/c/')));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await app.whenReady();
const fixtureUrl='http://127.0.0.1:'+server.address().port+'/';
let browser=new ChatGptBrowser({fixtureUrl,ledgerDirectory:path.join(directory,'ledgers')});
const context={runId:'fixture-run',stageId:'head-multiview',attempt:1,workspace,webPrompt:prompt,referencePaths:[reference]};
const unpack=result=>JSON.parse(result.content[0].text);
const observe=async()=>unpack(await browser.callTool('chatgpt_snapshot'));
const element=(view,kind)=>{const item=view.controls.find(node=>node.kind===kind);assert(item,'Missing '+kind);return {snapshotId:view.snapshotId,element:item.index};};
const checks=[];
try{
 browser.attachRun(context);assert.equal((await browser.open(true)).ready,true);
 let view=unpack(await browser.callTool('chatgpt_navigate',{target:'new'}));
 assert(!view.text.includes('PRIVATE SIDEBAR'));assert(view.controls.some(node=>node.kind==='composer'));
 checks.push('Observed contenteditable composer without role and excludes sidebar history');
 const debuggerApi=BrowserWindow.getAllWindows()[0].webContents.debugger;
 const originalCommand=debuggerApi.sendCommand.bind(debuggerApi);
 debuggerApi.sendCommand=async(method,...args)=>{const result=await originalCommand(method,...args);if(method==='DOM.setFileInputFiles')throw Error('fixture upload response lost');return result;};
 await assert.rejects(browser.callTool('chatgpt_upload_references',element(view,'upload')),/response lost/);
 debuggerApi.sendCommand=originalCommand;
 view=await observe();view=unpack(await browser.callTool('chatgpt_fill_prompt',element(view,'composer')));
 await assert.rejects(browser.callTool('chatgpt_submit',element(view,'send')),/reference upload/);
 assert.equal(browser.stageReceipt(context.runId,context.stageId).submission,undefined);
 view=unpack(await browser.callTool('chatgpt_navigate',{target:'new'}));
 checks.push('Uncertain native upload cannot submit even when a filename is already visible');
 const stale=element(view,'composer');
 view=unpack(await browser.callTool('chatgpt_upload_references',element(view,'upload')));
 assert(view.text.includes('reference.png'));
 await assert.rejects(browser.callTool('chatgpt_fill_prompt',stale),/Stale/);
 view=unpack(await browser.callTool('chatgpt_fill_prompt',element(view,'composer')));
 assert.equal(view.composerText,prompt);
 checks.push('Frozen references uploaded by native file input; exact prompt filled; stale IDs rejected');
 const wc=BrowserWindow.getAllWindows()[0].webContents;
 await wc.executeJavaScript('document.querySelector("[contenteditable]").textContent="Changed after snapshot"');
 await assert.rejects(browser.callTool('chatgpt_submit',element(view,'send')),/Exact frozen prompt/);
 assert.equal(browser.stageReceipt(context.runId,context.stageId).submission,undefined);
 await wc.executeJavaScript('document.querySelector("[contenteditable]").textContent='+JSON.stringify(prompt));
 view=await observe();
 await wc.executeJavaScript('document.getElementById("uploaded").textContent="Uploading reference.png"');
 await assert.rejects(browser.callTool('chatgpt_submit',element(view,'send')),/reference upload/);
 await wc.executeJavaScript('document.getElementById("uploaded").textContent="reference.png"');view=await observe();
 checks.push('Fresh pre-send observation rejects user-edited prompt and still-uploading reference');
 view=unpack(await browser.callTool('chatgpt_submit',element(view,'send')));
 for(let n=0;n<20&&!view.controls.some(node=>node.kind==='image');n++){await new Promise(r=>setTimeout(r,100));view=await observe();}
 assert.equal(browser.stageReceipt(context.runId,context.stageId).submission.state,'observed');
 await assert.rejects(browser.callTool('chatgpt_submit',element(view,'send')),/already submitted/);
 await assert.rejects(browser.callTool('chatgpt_navigate',{target:'new'}),/already submitted/);
 checks.push('One durable send; current generated-image-gallery recognized; repeat submit and new chat blocked');
 for(let imageIndex=0;imageIndex<4;imageIndex++){
 const source=view.controls.find(node=>node.kind==='image'&&node.label==='생성된 이미지 '+(imageIndex+1));assert(source);
 view=unpack(await browser.callTool('chatgpt_click_image',{snapshotId:view.snapshotId,element:source.index}));
 for(let n=0;n<20&&!view.controls.some(node=>node.kind==='download');n++){await new Promise(r=>setTimeout(r,100));view=await observe();}
 await assert.rejects(browser.callTool('chatgpt_download_image',element(view,'download')),/Select a generated image/);
 view=unpack(await browser.callTool('chatgpt_click_image',element(view,'image')));
 view=unpack(await browser.callTool('chatgpt_download_image',element(view,'download')));
 let receipts;
 for(let n=0;n<40;n++){receipts=browser.stageReceipt(context.runId,context.stageId);if(receipts.downloads.filter(item=>item.state==='completed').length===imageIndex+1)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(receipts.downloads.length,imageIndex+1);assert.equal(receipts.downloads[imageIndex].state,'completed');assert.deepEqual(fs.readFileSync(receipts.downloads[imageIndex].file),originals[imageIndex]);
 assert.equal(receipts.downloads[imageIndex].sourcePage,'https://chatgpt.com/c/fixture-chat');assert.match(receipts.downloads[imageIndex].sha256,/^[0-9a-f]{64}$/);
 view=unpack(await browser.callTool('chatgpt_close_viewer',element(view,'close')));
 }
 checks.push('Four independent native PNG downloads retain exact bytes and stage/conversation/hash association; differing preview/viewer identities must be rebound; viewer closes for next image');
 await browser.close();
 browser=new ChatGptBrowser({fixtureUrl,ledgerDirectory:path.join(directory,'ledgers')});
 browser.attachRun({...context,attempt:2,recoveryOnly:true,referencePaths:[]});await browser.open(true);
 await assert.rejects(browser.callTool('chatgpt_navigate',{target:'new'}),/recovery-only/);
 view=unpack(await browser.callTool('chatgpt_navigate',{target:'current'}));
 assert.equal(browser.stageReceipt(context.runId,context.stageId).downloads.length,4);
 await assert.rejects(browser.callTool('chatgpt_fill_prompt',element(view,'composer')),/recovery-only/);
 checks.push('Restart/recovery reopens recorded conversation and preserves original receipts; never sends');
 const win=BrowserWindow.getAllWindows()[0];await win.loadURL(fixtureUrl+'login');
 assert.equal((await browser.status()).requiresInput,true);
 checks.push('Login is a user handoff, never automated');
 await win.loadURL(fixtureUrl);
 browser.attachRun({...context,runId:'ambiguous-stage'});
 browser.ledger.reserve();
 await win.loadURL(fixtureUrl+'c/other');
 await win.webContents.executeJavaScript('document.querySelector("[data-turn-key]").children[1].textContent="Another unrelated prompt"');
 view=await observe();
 assert.equal(browser.stageReceipt('ambiguous-stage',context.stageId).submission.state,'reserved');
 await assert.rejects(browser.callTool('chatgpt_click_image',element(view,'image')),/submitted stage/);
 checks.push('Ambiguous request cannot bind or download a different conversation without matching frozen user prompt');
 fs.writeFileSync(path.join(root,'artifacts/chatgpt-browser-smoke.json'),JSON.stringify({date:new Date().toISOString(),liveChatGpt:false,checks},null,2));
 console.log(JSON.stringify({ok:true,checks}));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));app.quit();}
}
main().catch(error=>{console.error(error);app.exit(1)});
`,
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: entry,
});
const child = spawn(electronPath, [entry], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PARTSMITH_CHATGPT_FIXTURE_DIR: directory },
  windowsHide: true,
});
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
if (exit !== 0) throw Error(`ChatGPT fixture failed (${exit})`);
