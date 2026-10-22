import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { _electron as electron } from "playwright";
import electronBinary from "electron";

test(
  "legacy UI previews without creating, links only selected items and confirms collection unlink",
  { timeout: 90000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-legacy-ui-"));
    const entry = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {GraphicsStudio} from ${JSON.stringify(path.resolve("src/GraphicsStudio.tsx"))};
    const createdAt='2026-10-13T00:00:00Z';
    const object={id:'rabbit',name:'흰 네 발 토끼',kind:'character',createdAt,selectedTasks:[],instruction:'',settings:{},references:[],accepted:{'design:main':'original'}};
    const version=(id,objectId,label,type)=>({id,objectId,role:'design',slot:'main',label,files:[{path:id+'.png',kind:'image',sha256:'a'.repeat(64),bytes:1}],createdAt,sourceVersionIds:[],provenance:{type},warnings:[]});
    const original=version('original','rabbit','원래 토끼','import');
    const candidates=[version('legacy-one','legacy','이전 토끼 정면','legacy'),version('legacy-two','legacy','이전 토끼 측면','legacy')];
    const initial={schemaVersion:1,id:'p',projectId:'p',revision:0,objects:[object],versions:[original],tasks:[],deliveries:[]};
    const project={schemaVersion:1,id:'p',name:'토끼 프로젝트',style:'',height:1,unityPath:'',unityFolder:'',createdAt,updatedAt:createdAt,revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    window.desktop={assetUrl:()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='};window.actions=[];
    function Harness(){
      const [workspace,setWorkspace]=useState(initial);window.workspace=workspace;
      window.addDependency=()=>setWorkspace(current=>({...current,objects:current.objects.map(o=>o.id==='rabbit'?{...o,references:[{versionId:'legacy-one',role:'appearance'}]}:o)}));
      window.clearDependency=()=>setWorkspace(current=>({...current,objects:current.objects.map(o=>({...o,references:[]}))}));
      const action=async(value)=>{
        window.actions.push(value);
        if(value.kind==='inspect-legacy')return {...workspace,legacyPreview:{versions:candidates.filter(v=>!workspace.versions.some(saved=>saved.id===v.id)),fingerprint:'preview-fingerprint',objectName:'토끼 프로젝트 · 기존 결과'}};
        const next=structuredClone(workspace);next.revision++;
        if(value.kind==='import-legacy'){
          next.objects.push({...object,id:'legacy',name:'토끼 프로젝트 · 기존 결과',kind:'prop',accepted:{}});
          next.versions.push(...candidates.filter(v=>value.versionIds.includes(v.id)));
        }
        if(value.kind==='unlink-legacy'){
          next.objects=next.objects.filter(o=>o.id!==value.objectId);
          next.versions=next.versions.filter(v=>v.objectId!==value.objectId);
        }
        setWorkspace(next);return next;
      };
      return <GraphicsStudio project={project} workspace={workspace} busy={false} onAction={action}/>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `;
    await build({
      stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx" },
      bundle: true,
      format: "iife",
      outfile: path.join(root, "ui.js"),
      jsx: "automatic",
      logLevel: "silent",
    });
    fs.writeFileSync(
      path.join(root, "index.html"),
      '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'; img-src \'self\' data:"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(root, "main.cjs"),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, "profile"))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});win.loadFile(${JSON.stringify(path.join(root, "index.html"))});});`,
    );
    const app = await electron.launch({
      executablePath: electronBinary as unknown as string,
      args: [path.join(root, "main.cjs")],
    });
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByTestId("graphics-object-rabbit").click();
      assert.equal(
        await page.getByTestId("graphics-unlink-legacy").count(),
        0,
        "production object never exposes collection unlink",
      );
      const baseline = await page.evaluate(() => (window as any).workspace);
      await page
        .getByRole("button", { name: "기존 프로젝트 자료 연결", exact: true })
        .click();
      let dialog = page.getByRole("dialog", {
        name: "연결할 기존 자료 선택",
        exact: true,
      });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("checkbox").count(), 2);
      assert.equal(
        await page.getByTestId("graphics-confirm-legacy-link").isDisabled(),
        true,
      );
      assert.deepEqual(
        await page.evaluate(() => (window as any).workspace),
        baseline,
      );
      assert.equal(await page.getByTestId("graphics-object-legacy").count(), 0);
      await dialog.getByRole("button", { name: "취소", exact: true }).click();
      assert.deepEqual(
        await page.evaluate(() => (window as any).workspace),
        baseline,
      );
      await page
        .getByRole("button", { name: "기존 프로젝트 자료 연결", exact: true })
        .click();
      await page
        .getByRole("checkbox", { name: "이전 토끼 정면 연결", exact: true })
        .check();
      await page.getByTestId("graphics-confirm-legacy-link").click();
      await page.getByTestId("graphics-object-legacy").click();
      const linked = await page.evaluate(() => (window as any).workspace);
      assert.deepEqual(linked.objects[0], baseline.objects[0]);
      assert.deepEqual(linked.versions[0], baseline.versions[0]);
      assert.deepEqual(
        linked.versions.map((v: any) => v.id),
        ["original", "legacy-one"],
      );
      const linkAction = await page.evaluate(() =>
        (window as any).actions.find((a: any) => a.kind === "import-legacy"),
      );
      assert.deepEqual(linkAction, {
        kind: "import-legacy",
        versionIds: ["legacy-one"],
        fingerprint: "preview-fingerprint",
      });
      await page.getByTestId("graphics-unlink-legacy").click();
      dialog = page.getByRole("dialog", {
        name: "기존 오브젝트 연결 해제",
        exact: true,
      });
      await dialog.waitFor();
      assert.match(
        await dialog.innerText(),
        /원본 파일과 기존 프로젝트의 작업 기록은 보관/,
      );
      await dialog.getByRole("button", { name: "취소", exact: true }).click();
      assert.deepEqual(
        await page.evaluate(() => (window as any).workspace),
        linked,
      );
      await page.evaluate(() => (window as any).addDependency());
      await page.getByTestId("graphics-unlink-legacy").click();
      assert.equal(
        await page.getByTestId("graphics-confirm-legacy-unlink").isDisabled(),
        true,
      );
      assert.match(await dialog.getByRole("alert").innerText(), /참조/);
      await dialog.getByRole("button", { name: "취소", exact: true }).click();
      await page.evaluate(() => (window as any).clearDependency());
      await page.getByTestId("graphics-unlink-legacy").click();
      await page.getByTestId("graphics-confirm-legacy-unlink").click();
      await page
        .getByTestId("graphics-object-legacy")
        .waitFor({ state: "detached" });
      const final = await page.evaluate(() => ({
        workspace: (window as any).workspace,
        actions: (window as any).actions,
      }));
      assert.deepEqual(final.workspace.objects, baseline.objects);
      assert.deepEqual(final.workspace.versions, baseline.versions);
      assert.equal(
        final.actions.filter((a: any) => a.kind === "unlink-legacy").length,
        1,
      );
      assert(
        final.actions.every((a: any) =>
          ["inspect-legacy", "import-legacy", "unlink-legacy"].includes(a.kind),
        ),
      );
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
