import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

// Render the actual App shell; the only host request allowed is a fixture read.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-shell-state-"));
const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {App} from ${JSON.stringify(path.resolve("src/App.tsx"))};
import ${JSON.stringify(path.resolve("src/style.css"))};
import {catalog} from ${JSON.stringify(path.resolve("shared/catalog.ts"))};
const createdAt='2026-10-13T00:00:00Z';
const project={schemaVersion:1,id:'fixture',name:'Shell fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt,updatedAt:createdAt,revision:1,assets:[],parts:[],assemblies:[],builds:[],demo:false,jobs:Array.from({length:4},(_,i)=>({id:'legacy-'+i,status:'success',createdAt,request:{operation:'image',count:1},outputs:[]}))};
const workspace={schemaVersion:1,id:'ws',projectId:project.id,revision:1,objects:[{id:'rabbit',name:'토끼',kind:'character',createdAt,instruction:'',settings:{},selectedTasks:[],references:[],accepted:{}}],versions:[],deliveries:[],tasks:[{id:'video-running',objectId:'rabbit',taskId:'N02',createdAt,updatedAt:createdAt,status:'running',settings:{clipName:'Idle'},inputVersionIds:[],outputVersionIds:[],backendJobIds:[],instruction:'',requestHash:'fixture',localOnly:false,message:'영상 결과를 기다리고 있습니다.'}]};
const state={projects:[project],graphicsWorkspaces:[workspace],settings:{blenderPath:'',unityPath:'',unityEditorPath:''},key:{configured:true,storage:'fixture'},dataDir:'fixture',catalog};
window.hostCalls=[];window.desktop={assetUrl:()=>'',call:async command=>{window.hostCalls.push(command);if(command.type!=='state')throw Error('Production calls forbidden');return state;}};
createRoot(document.getElementById('root')).render(<App/>);`;
await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true,
  format: "iife",
  outfile: path.join(root, "ui.js"),
  logLevel: "silent",
});
fs.writeFileSync(
  path.join(root, "index.html"),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script>',
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1426, height: 864 },
    deviceScaleFactor: 1.5,
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(root, "index.html")).href);
  await page.getByTestId("project-open").click();
  await page.getByTestId("graphics-studio").waitFor();
  assert.equal(await page.locator(".jobs").count(), 0);
  assert.equal(await page.locator(".statusbar").count(), 0);
  const current = page.getByTestId("graphics-current-task-video-running");
  assert.match(await current.innerText(), /Idle.*진행 중/s);
  assert.equal(await current.getAttribute("aria-busy"), "true");
  assert.equal(await current.locator(".gs-progress-spinner").count(), 1);
  assert.equal(
    await current
      .locator(".gs-progress-spinner")
      .evaluate((icon) => getComputedStyle(icon).animationName),
    "gs-progress-spin",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await current
      .locator(".gs-progress-spinner")
      .evaluate((icon) => getComputedStyle(icon).animationName),
    "none",
  );
  await page.screenshot({ path: path.join(root, "graphics-current-only.png") });
  await page.locator(".manual-tools summary").click();
  await page
    .locator(".manual-tools")
    .getByRole("button", { name: "이미지 스튜디오", exact: false })
    .click();
  assert.equal(await page.locator(".jobs").count(), 1);
  assert.match(await page.locator(".jobs > summary").innerText(), /총 4개/);
  assert.equal(await page.locator(".statusbar").count(), 1);
  await page
    .getByRole("button", { name: "Unity 그래픽 제작", exact: true })
    .click();
  await page.getByTestId("graphics-studio").waitFor();
  assert.equal(await page.locator(".jobs, .statusbar").count(), 0);
  const calls = await page.evaluate(() => window.hostCalls);
  assert(calls.every((call) => call.type === "state"));
  assert.deepEqual(errors, []);
  const report = {
    root,
    graphicsLegacyTrayHidden: true,
    graphicsLegacyFooterHidden: true,
    legacyTabRetained: true,
    currentGraphicsTaskVisible: true,
    spinnerClass: "gs-progress-spinner",
    reducedMotion: true,
    productionCalls: 0,
    errors,
  };
  fs.writeFileSync(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
