import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import electronPath from "electron";

// Offline real Electron windows. Every HTTPS response is intercepted in an
// isolated, non-persistent test session; no account, credentials or generation.
const root = process.cwd();
const directory = path.join(
  root,
  "artifacts/runtime/chatgpt-auth-smoke",
  randomUUID(),
);
fs.mkdirSync(directory, { recursive: true });
const entry = path.join(directory, "fixture.cjs");
await build({
  stdin: {
    resolveDir: root,
    loader: "js",
    contents: String.raw`
import {app,BrowserWindow,session} from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ChatGptBrowser} from './electron/chatgpt-browser';

async function main(){
const root=process.cwd(),directory=process.env.PARTSMITH_CHATGPT_AUTH_FIXTURE_DIR;
app.setPath('userData',path.join(directory,'user-data'));
process.env.PARTSMITH_CHATGPT_TEST='1';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(predicate,label,timeout=8000)=>{const end=Date.now()+timeout;while(Date.now()<end){const result=await predicate();if(result)return result;await pause(50);}throw Error('Timed out: '+label);};
const composer='<form><div contenteditable="true" aria-label="ChatGPT에게 물어보세요" style="height:70px;border:1px solid #aaa"></div><button aria-label="보내기" onclick="window.sendCount=(window.sendCount||0)+1">보내기</button></form>';
const pending='<button>로그인</button><input type="password" aria-label="Password">';
let failRoot=false, signedIn=false;
const html=()=>'<html><body><main>'+(signedIn?composer:pending)+'</main><script>window.sendCount=0;addEventListener("message",event=>{if(event.origin==="https://chatgpt.com"&&event.data==="fixture-auth-complete")document.querySelector("main").innerHTML='+JSON.stringify(composer)+';});</script></body></html>';
const server=http.createServer((request,response)=>{if(failRoot){request.socket.destroy();return;}response.setHeader('Content-Type','text/html; charset=utf-8');response.setHeader('Cache-Control','no-store');response.end(html());});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await app.whenReady();
const fixtureUrl='http://127.0.0.1:'+server.address().port+'/';
const testSession=session.fromPartition('partsmith-chatgpt-test');
const requests=[];
testSession.protocol.handle('https',request=>{
 const url=new URL(request.url);requests.push({host:url.hostname,path:url.pathname});
 let body='<main><h1>Offline authentication fixture</h1><button>Log in</button></main>';
 if(url.pathname==='/fixture-disallowed')body='<main><h1>Access blocked</h1><p>Error 403: disallowed_useragent</p></main>';
 if(url.hostname==='chatgpt.com'&&url.pathname==='/auth/callback')body='<script>window.opener.opener.postMessage("fixture-auth-complete",'+JSON.stringify(fixtureUrl.slice(0,-1))+');window.close();</script>';
 return new Response('<!doctype html><html><body>'+body+'</body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}});
});
let browser;
const checks=[];
const make=timeout=>new ChatGptBrowser({fixtureUrl,loadTimeoutMs:timeout,ledgerDirectory:path.join(directory,'ledgers')});
const state=async value=>wait(async()=>{const status=await browser.status();return status.state===value&&status;},'state '+value);
const primary=()=>BrowserWindow.getAllWindows().find(win=>win.getTitle().includes('Partsmith'));
const openPopup=async(win,url)=>{const ids=new Set(BrowserWindow.getAllWindows().map(item=>item.id));await win.webContents.executeJavaScript('window.open('+JSON.stringify(url)+',"_blank");void 0',true);return wait(()=>BrowserWindow.getAllWindows().find(item=>!ids.has(item.id)),'new authentication popup');};
const loaded=async(win,host)=>wait(()=>{if(win.isDestroyed())return false;const url=win.webContents.getURL();return !win.webContents.isLoadingMainFrame()&&url.includes(host);},'popup loaded');
const assertSanitized=status=>{const serialized=JSON.stringify(status);assert(!serialized.includes('fixture-secret-value'));assert(!serialized.includes('fixture-fragment'));if(status.diagnostic){assert(!status.diagnostic.path.includes('?'));assert(!status.diagnostic.path.includes('#'));}};
try{
 browser=make(2500);
 assert.equal((await browser.status()).state,'closed');
 const opening=await browser.open(false);assert.equal(opening.state,'loading');
 await state('login_required');
 const mainWin=primary();assert(mainWin);
 const first=await openPopup(mainWin,'https://accounts.google.com/signin/fixture?state=fixture-secret-value#fixture-fragment');
 await loaded(first,'accounts.google.com');
 const second=await openPopup(first,'https://auth.openai.com/fixture-auth?code=fixture-secret-value');
 await loaded(second,'auth.openai.com');
 assert.equal(first.webContents.session,mainWin.webContents.session);
 assert.equal(second.webContents.session,mainWin.webContents.session);
 assert.equal(first.webContents.getLastWebPreferences().nodeIntegration,false);
 assert.equal(second.webContents.getLastWebPreferences().contextIsolation,true);
 assert.equal(second.webContents.getLastWebPreferences().sandbox,true);
 assertSanitized(await browser.status());
 checks.push('Main and nested authentication popups open with identical session and hardened renderer preferences');

 await second.webContents.executeJavaScript('location.href="https://chatgpt.com/auth/callback?code=fixture-secret-value#fixture-fragment"');
 await wait(()=>second.isDestroyed(),'callback closes popup');
 first.close();
 await state('ready');
 assert.equal(await mainWin.webContents.executeJavaScript('window.sendCount'),0);
 checks.push('Offline callback returns to parent; ready state refreshes without Send or automatic generation');

 const blank=await openPopup(mainWin,'about:blank');
 assert.equal(blank.webContents.session,mainWin.webContents.session);
 await blank.webContents.executeJavaScript('location.href="https://accounts.google.com/blank-child?state=fixture-secret-value"');
 await loaded(blank,'accounts.google.com');
 const blankNested=await openPopup(blank,'about:blank');
 await blankNested.webContents.executeJavaScript('location.href="https://auth.openai.com/blank-nested"');
 await loaded(blankNested,'auth.openai.com');
 assert.equal(blankNested.webContents.session,mainWin.webContents.session);
 blankNested.close();blank.close();
 await state('ready');
 checks.push('Temporary about:blank popup and nested blank popup can navigate to allowed authentication hosts');

 const before=BrowserWindow.getAllWindows().length;
 await mainWin.webContents.executeJavaScript('window.open("https://blocked.example/forbidden?token=fixture-secret-value#fixture-fragment","_blank")',true);
 let failure=await state('failed');assert.equal(failure.diagnostic.code,'BLOCKED_POPUP');assert.equal(failure.diagnostic.host,'blocked.example');assertSanitized(failure);
 assert.equal(BrowserWindow.getAllWindows().length,before);
 assert(!requests.some(item=>item.host==='blocked.example'));
 signedIn=true;await browser.reconnect(false);await state('ready');
 checks.push('Blocked popup is cancelled before navigation, shows only sanitized diagnostic, and explicit reconnect recovers');

 const guardedBlank=await openPopup(mainWin,'about:blank');
 await guardedBlank.webContents.executeJavaScript('location.href="https://blocked.example/blank-escape?token=fixture-secret-value#fixture-fragment"');
 failure=await state('failed');assert.equal(failure.diagnostic.code,'BLOCKED_NAVIGATION');assertSanitized(failure);
 assert(!requests.some(item=>item.host==='blocked.example'));
 await browser.reconnect(false);await state('ready');
 checks.push('Navigation guard also protects a previously allowed blank popup; blocked target is never requested');

 const denied=await openPopup(mainWin,'https://accounts.google.com/fixture-disallowed');
 await loaded(denied,'accounts.google.com');
 failure=await state('failed');assert.equal(failure.diagnostic.code,'DISALLOWED_USERAGENT');assertSanitized(failure);
 await browser.reconnect(false);await state('ready');
 checks.push('Actual rendered disallowed_useragent fixture is reported unsupported without spoofing or alternate sign-in');

 await browser.close();browser=make(500);
 await browser.open(false);await state('ready');
 const empty=await openPopup(primary(),'about:blank');
 failure=await state('failed');assert.equal(failure.diagnostic.code,'BLANK_TIMEOUT');assertSanitized(failure);
 await browser.reconnect(false);await state('ready');
 assert(empty.isDestroyed());
 checks.push('Unnavigated blank popup times out visibly and explicit reconnect closes it');

 await browser.close();failRoot=true;browser=make(2500);
 assert.equal((await browser.open(false)).state,'loading');
 failure=await state('failed');assert.match(failure.diagnostic.code,/^LOAD_FAILED_/);assertSanitized(failure);
 failRoot=false;await browser.reconnect(false);await state('ready');
 assert.equal(await primary().webContents.executeJavaScript('window.sendCount'),0);
 checks.push('Failed first load remains diagnosable and explicit reconnect reloads successfully without sending');

 const workspace=path.join(directory,'active-worker');fs.mkdirSync(workspace);
 const connection=await browser.workerConnection({imageBackend:'chatgpt-web',runId:'auth-active-worker',stageId:'concept',attempt:1,workspace,webPrompt:'Fixture only; never send',referencePaths:[]});
 const connectedWindow=primary(),connectedUrl=connectedWindow.webContents.getURL();
 assert.equal((await browser.reconnect(false)).canReconnect,false);
 assert.equal(connectedWindow.webContents.getURL(),connectedUrl);
 assert.equal(await connectedWindow.webContents.executeJavaScript('window.sendCount'),0);
 assert.equal(browser.stageReceipt('auth-active-worker','concept').submission,undefined);
 await connection.close();
 checks.push('Explicit reconnect is refused while a worker bridge is active; page and one-submission journal remain unchanged');

 assert(requests.every(item=>['accounts.google.com','auth.openai.com','chatgpt.com'].includes(item.host)));
 fs.writeFileSync(path.join(root,'artifacts/chatgpt-auth-smoke.json'),JSON.stringify({date:new Date().toISOString(),liveChatGpt:false,realGoogleLogin:false,network:'loopback and intercepted HTTPS only',checks},null,2));
 console.log(JSON.stringify({ok:true,checks}));
}finally{
 if(browser)await browser.close();
 testSession.protocol.unhandle('https');
 server.closeAllConnections();
 await new Promise(resolve=>server.close(resolve));
 app.quit();
}
}
main().catch(error=>{console.error(error);app.exit(1);});
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
  env: { ...process.env, PARTSMITH_CHATGPT_AUTH_FIXTURE_DIR: directory },
  windowsHide: true,
});
const timeout = setTimeout(() => child.kill(), 60000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
clearTimeout(timeout);
if (exit !== 0) throw Error(`ChatGPT authentication fixture failed (${exit})`);
