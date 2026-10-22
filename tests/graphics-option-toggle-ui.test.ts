import { revealGraphicsControl, openGraphicsInspection } from './graphics-ui-disclosures';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { _electron as electron } from "playwright";
import electronBinary from "electron";

test("creation choices deselect explicitly, persist empty values and block incomplete requests without toggling navigation or acceptance", { timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-option-toggle-ui-"));
  const entry = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {GraphicsStudio} from ${JSON.stringify(path.resolve("src/GraphicsStudio.tsx"))};
    import {defaultCreation,validateCreation} from ${JSON.stringify(path.resolve("shared/graphics-creation.ts"))};
    const createdAt='2026-10-13T00:00:00Z';
    const object=(id,name)=>({id,name,kind:'prop',createdAt,selectedTasks:[],instruction:'A rounded stone prop',settings:{},references:[],accepted:{},creation:defaultCreation('prop')});
    const target=object('target','옵션을 확인할 소품');target.creation.instruction='A rounded stone prop';target.accepted={'design:main':'original'};
    const version=(id)=>({id,objectId:'target',role:'design',slot:'main',label:id==='original'?'채택한 원본':'검토할 다른 원본',files:[{path:id+'.png',kind:'image',sha256:'a'.repeat(64),bytes:1}],createdAt,sourceVersionIds:[],provenance:{type:'import'},warnings:[]});
    const initial={schemaVersion:1,id:'p',projectId:'p',revision:0,objects:[object('other','다른 소품'),target],versions:[version('original'),version('alternative')],tasks:[],deliveries:[]};
    const project={schemaVersion:1,id:'p',name:'Isolated option toggle fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt,updatedAt:createdAt,revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    window.desktop={assetUrl:()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='};
    window.actions=JSON.parse(localStorage.getItem('actions')??'[]');
    function Harness(){
      const [workspace,setWorkspace]=useState(()=>JSON.parse(localStorage.getItem('workspace')??JSON.stringify(initial)));window.workspace=workspace;
      const action=async(value)=>{
        window.actions.push(structuredClone(value));localStorage.setItem('actions',JSON.stringify(window.actions));
        if(!['update-object','accept'].includes(value.kind))throw Error('Execution is forbidden in the isolated option-only fixture: '+value.kind);
        const next=structuredClone(workspace);next.revision++;
        const object=next.objects.find(o=>o.id===value.objectId);
        if(value.kind==='update-object'){
          if(value.patch.creation)validateCreation(value.patch.creation,object.kind);
          Object.assign(object,value.patch);
        }
        if(value.kind==='accept'){
          const version=next.versions.find(v=>v.id===value.versionId);
          object.accepted[version.role+':'+version.slot]=version.id;
        }
        localStorage.setItem('workspace',JSON.stringify(next));setWorkspace(next);return next;
      };
      return <GraphicsStudio project={project} workspace={workspace} busy={false} onAction={action}/>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `;
  await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, format: "iife", outfile: path.join(root, "ui.js"), jsx: "automatic", logLevel: "silent" });
  fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'; img-src \'self\' data:"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root, "main.cjs"), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, "profile"))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(path.join(root, "index.html"))});});`);
  const app = await electron.launch({ executablePath: electronBinary as unknown as string, args: [path.join(root, "main.cjs")] });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.getByTestId("graphics-studio").waitFor();
    await page.getByTestId("graphics-object-target").click();
    const choices = (name: string) => page.getByTestId("graphics-creation-options").getByRole("group", { name: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:\\s*·?\\s*미선택)?$") });
    const button = (group: string, name: string) => choices(group).getByRole("button", { name, exact: true });
    const stage = (name: string) => page.getByRole("navigation", { name: "제작 단계" }).getByRole("button", { name, exact: true });
    const savedTarget = () => page.evaluate(() => (window as any).workspace.objects.find((object: any) => object.id === "target"));
    const actions = () => page.evaluate(() => (window as any).actions);
    const assertPreparationReady = async () => {
      const explicitPrepare = page.getByTestId("graphics-prepare");
      assert.equal(await (await explicitPrepare.count() ? explicitPrepare : page.getByTestId("graphics-guide-primary")).isEnabled(), true, "Valid settings must allow preparing the current stage");
    };
    const assertPreparationBlocked = async () => {
      const explicitPrepare = page.getByTestId("graphics-prepare");
      if (await explicitPrepare.count()) assert.equal(await explicitPrepare.isDisabled(), true);
      else assert.equal(await page.getByTestId("graphics-guide-primary").isDisabled(), true);
      assert((await actions()).every((action: any) => action.kind === "update-object"), "Missing required settings must never prepare or execute work");
    };
    const save = async () => {
      const revision = await page.evaluate(() => (window as any).workspace.revision);
      const saveButton = page.locator("button").filter({ hasText: /^옵션 저장$/ });
      await revealGraphicsControl(saveButton);
      await saveButton.click();
      await page.waitForFunction(value => (window as any).workspace.revision > value, revision);
    };

    // Optional attributes can be cleared and selected again without generation.
    assert.equal(await button("어떤 표현으로 만들까요?", "스타일화").getAttribute("aria-pressed"), "true");
    await button("어떤 표현으로 만들까요?", "스타일화").click();
    assert.equal(await button("어떤 표현으로 만들까요?", "스타일화").getAttribute("aria-pressed"), "false");
    assert.match(await choices("어떤 표현으로 만들까요?").innerText(), /미선택/);
    await button("어떤 표현으로 만들까요?", "사실적").click();
    assert.equal(await button("어떤 표현으로 만들까요?", "사실적").getAttribute("aria-pressed"), "true");
    assert.equal(await button("어떤 표현으로 만들까요?", "스타일화").getAttribute("aria-pressed"), "false");
    await button("어떤 표현으로 만들까요?", "스타일화").click();
    assert.equal(await button("어떤 표현으로 만들까요?", "스타일화").getAttribute("aria-pressed"), "true");
    assert.equal(await button("어떤 표현으로 만들까요?", "사실적").getAttribute("aria-pressed"), "false");
    await button("어떤 표현으로 만들까요?", "스타일화").click();
    await assertPreparationReady();

    // Technical controls remain available behind a native keyboard disclosure.
    const appearanceDetails = page.getByTestId("graphics-creation-options").locator('details').filter({ has: page.getByText("세부 외형 · 구도 옵션", { exact: true }) });
    assert.equal(await appearanceDetails.getAttribute('open'), null);
    const appearanceSummary = appearanceDetails.locator('summary');
    await appearanceSummary.focus();
    await page.keyboard.press('Enter');
    assert.notEqual(await appearanceDetails.getAttribute('open'), null);
    assert.equal(await button("방향", "정면").getAttribute("aria-pressed"), "true");
    await button("방향", "정면").click();
    assert.equal(await button("방향", "정면").getAttribute("aria-pressed"), "false");
    assert.match(await choices("방향").innerText(), /미선택/);
    await button("방향", "후면").click();
    assert.equal(await button("방향", "후면").getAttribute("aria-pressed"), "true");
    await button("방향", "정면").click();
    assert.equal(await button("방향", "후면").getAttribute("aria-pressed"), "false");
    await page.getByText("수정할 때 유지할 특징", { exact: true }).click();
    const lock = page.getByRole("checkbox", { name: "색 유지", exact: true });
    await lock.click(); assert.equal(await lock.isChecked(), true);
    await lock.click(); assert.equal(await lock.isChecked(), false);
    assert.deepEqual(await actions(), [], "Changing choices or checkboxes only edits the draft");
    await save();
    assert.equal((await savedTarget()).creation.attributes.style, "");
    assert.deepEqual((await savedTarget()).creation.locks, []);

    // Required routing remains explicitly empty through save, navigation and reload.
    await button("이미지 제작 방식", "새 이미지").click();
    assert.equal(await button("이미지 제작 방식", "새 이미지").getAttribute("aria-pressed"), "false");
    assert.match(await choices("이미지 제작 방식").innerText(), /미선택/);
    await assertPreparationBlocked();
    assert.equal(await page.getByTestId("graphics-guide-primary").isEnabled(), true, "Choosing an existing image stays available while missing settings block new generation");
    assert.match(await page.getByTestId("graphics-guide-primary").innerText(), /이 이미지 사용/);
    await save();
    assert.equal((await savedTarget()).creation.stageSettings.design.values.designMode, "");
    assert((await actions()).every((action: any) => action.kind === "update-object"));
    await stage("1 이미지").click(); await stage("1 이미지").click();
    assert.equal(await stage("1 이미지").getAttribute("aria-current"), "step");
    await assertPreparationBlocked();
    await page.getByTestId("graphics-object-target").click(); await page.getByTestId("graphics-object-target").click();
    assert.equal(await page.getByTestId("graphics-object-target").getAttribute("aria-pressed"), "true");
    assert.equal(await button("이미지 제작 방식", "새 이미지").getAttribute("aria-pressed"), "false");
    await page.getByTestId("graphics-object-other").click();
    await choices("이미지 제작 방식").getByRole("button", { name: "새 이미지", exact: true, pressed: true }).waitFor();
    await page.getByTestId("graphics-object-target").click();
    await choices("이미지 제작 방식").getByRole("button", { name: "새 이미지", exact: true, pressed: false }).waitFor();
    assert.equal(await button("이미지 제작 방식", "새 이미지").getAttribute("aria-pressed"), "false");
    await page.reload();
    await page.getByTestId("graphics-object-target").click();
    await choices("이미지 제작 방식").getByRole("button", { name: "새 이미지", exact: true, pressed: false }).waitFor();
    assert.equal((await savedTarget()).creation.stageSettings.design.values.designMode, "");
    assert.equal((await savedTarget()).creation.attributes.style, "");
    assert.equal(await button("어떤 표현으로 만들까요?", "스타일화").getAttribute("aria-pressed"), "false");
    assert.equal(await button("이미지 제작 방식", "새 이미지").getAttribute("aria-pressed"), "false");
    await assertPreparationBlocked();
    await button("이미지 제작 방식", "새 이미지").click();
    assert.equal(await button("이미지 제작 방식", "새 이미지").getAttribute("aria-pressed"), "true");
    await assertPreparationReady();
    await save();

    // Topology clears explicitly; numeric values are independent and remain empty when cleared.
    await stage("2 모델").click(); await stage("2 모델").click();
    assert.equal(await stage("2 모델").getAttribute("aria-current"), "step");
    assert.equal(await button("메시 형태", "쿼드").getAttribute("aria-pressed"), "true");
    await button("메시 형태", "쿼드").click();
    assert.equal(await button("메시 형태", "쿼드").getAttribute("aria-pressed"), "false");
    assert.match(await choices("메시 형태").innerText(), /미선택/);
    await page.getByRole("spinbutton", { name: "목표 면 수", exact: true }).fill("");
    assert.equal(await page.getByRole("spinbutton", { name: "목표 면 수", exact: true }).inputValue(), "");
    await save();
    assert.equal((await savedTarget()).creation.stageSettings.model.values.faceLimit, "");
    await page.reload(); await page.getByTestId("graphics-object-target").click(); await stage("2 모델").click();
    assert.equal(await page.getByRole("spinbutton", { name: "목표 면 수", exact: true }).inputValue(), "");
    assert.equal(await button("메시 형태", "쿼드").getAttribute("aria-pressed"), "false");
    await button("메시 형태", "쿼드").click();
    await page.getByRole("spinbutton", { name: "목표 면 수", exact: true }).fill("5000");
    assert.equal(await page.getByRole("spinbutton", { name: "목표 면 수", exact: true }).inputValue(), "5000");
    assert.equal(await button("메시 형태", "쿼드").getAttribute("aria-pressed"), "true");
    await page.getByRole("spinbutton", { name: "목표 면 수", exact: true }).fill("");
    await save();
    assert.equal((await savedTarget()).creation.stageSettings.model.values.faceLimit, "", "Clearing the numeric input must also preserve the empty sentinel, never Number('') = 0");
    await page.getByRole("spinbutton", { name: "목표 면 수", exact: true }).fill("10000");
    assert.equal(await page.getByRole("spinbutton", { name: "목표 면 수", exact: true }).inputValue(), "10000");
    await save();

    // Repeated preview selection and acceptance retain their previous, non-toggle semantics.
    await revealGraphicsControl(page.getByTestId("graphics-version-alternative"));
    await page.getByTestId("graphics-version-alternative").click(); await page.getByTestId("graphics-version-alternative").click();
    assert.equal(await page.getByTestId("graphics-version-alternative").getAttribute("aria-pressed"), "true");
    const accepted = page.getByTestId("graphics-accept-version");
    await revealGraphicsControl(accepted);
    assert.equal(await accepted.isEnabled(), true);
    await accepted.click();
    await page.waitForFunction(() => (window as any).workspace.objects.find((object: any) => object.id === "target").accepted['design:main'] === 'alternative');
    assert.equal(await stage("2 모델").getAttribute("aria-current"), "step", "Adoption opens the next settings without preparing work");
    await revealGraphicsControl(page.getByTestId("graphics-version-alternative"));
    await page.getByTestId("graphics-version-alternative").click();
    await revealGraphicsControl(accepted);
    assert.equal(await accepted.isDisabled(), true);
    assert.equal(await accepted.innerText(), "현재 채택 버전");
    await page.getByTestId("graphics-version-alternative").click();
    assert.equal(await page.getByTestId("graphics-version-alternative").getAttribute("aria-pressed"), "true");
    assert.equal((await savedTarget()).accepted["design:main"], "alternative");
    const finalActions = await actions();
    assert.equal(finalActions.filter((action: any) => action.kind === "accept").length, 1);
    assert(finalActions.every((action: any) => ["update-object", "accept"].includes(action.kind)));
    assert.equal(finalActions.filter((action: any) => ["prepare", "approve", "recover"].includes(action.kind)).length, 0);
    assert.deepEqual(await page.evaluate(() => (window as any).workspace.tasks), []);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith("graphics-option-toggle-ui-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
