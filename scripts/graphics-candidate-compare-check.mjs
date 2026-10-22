import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(path.resolve("package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const { PNG } = require("pngjs");
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "partsmith-candidate-compare-"),
);
for (const [name, width, height, color] of [
  ["old-a", 80, 120, [110, 100, 80]],
  ["old-b", 120, 80, [80, 120, 110]],
  ["new-a", 80, 120, [200, 130, 110]],
  ["new-b", 120, 80, [100, 150, 210]],
]) {
  const png = new PNG({ width, height });
  for (let p = 0; p < png.data.length; p += 4) png.data.set([...color, 255], p);
  fs.writeFileSync(path.join(root, name + ".png"), PNG.sync.write(png));
}
fs.copyFileSync(path.join(root, "new-a.png"), path.join(root, "left.png"));
fs.copyFileSync(path.join(root, "new-b.png"), path.join(root, "right.png"));
const entry = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Box,Boxes,Folder,ImagePlus,Scissors,Settings,ShieldCheck,Sparkles,Workflow} from 'lucide-react';
import ${JSON.stringify(path.resolve("src/style.css"))};
import {GraphicsStudio} from ${JSON.stringify(path.resolve("src/GraphicsStudio.tsx"))};
import {defaultCreation} from ${JSON.stringify(path.resolve("shared/graphics-creation.ts"))};
const base=${JSON.stringify(pathToFileURL(root + path.sep).href)};
window.desktop={assetUrl:(_id,file)=>base+file};window.actions=[];window.reportReads=[];window.reportAborts=[];
const originalFetch=window.fetch.bind(window);window.fetch=(url,options)=>{if(!String(url).endsWith('.report.json'))return originalFetch(url,options);const id=String(url).split('/').at(-1).split('.')[0];window.reportReads.push(id);options?.signal?.addEventListener('abort',()=>window.reportAborts.push(id));return new Promise(resolve=>setTimeout(()=>resolve(new Response(JSON.stringify({faces:2345,triangles:3456,nativeSourceSha256:id==='invalid'?'wrong-hash':'native-'+id}),{status:200})),id==='slow'?250:0));};
const object={id:'object',name:'후보 비교 fixture',kind:'prop',createdAt:'2026-10-13',selectedTasks:[],instruction:'',settings:{},references:[],accepted:{'design:main':'old-a'}};
const version=(id,label,date,role='design',objectId='object')=>({id,objectId,role,slot:'main',label,createdAt:date,sourceVersionIds:[],provenance:{type:'codex',jobId:'separate-child-'+id},warnings:[],files:[{path:id+(role==='design'?'.png':role==='model'?'.blend':'.mp4'),kind:role==='design'?'image':role==='model'?'blend':'video',bytes:20,sha256:id.repeat(12)}]});
const versions=[version('old-a','디자인 1','2026-10-12'),version('old-b','디자인 2','2026-10-12'),version('new-a','디자인 1','2026-10-13'),version('new-b','디자인 2','2026-10-13'),version('model','모델 원본','2026-10-13','model')];
const measured=id=>({...version(id,id,'2026-10-13','model'),files:[{path:id+'.fbx',kind:'model',bytes:20,sha256:'native-'+id},{path:id+'.report.json',kind:'report',bytes:100,sha256:'report-'+id}]});
versions.push(measured('measured'),{...measured('postprocess'),sourceVersionIds:['measured']},measured('invalid'),measured('slow'));
versions.push(version('long-label','귀와 꼬리 웨이트를 보정하고 발 접지를 유지한 매우 긴 결과 버전 이름 · 원본과 수정본 비교를 위한 추가 설명이 있는 모델','2026-10-13','model'));
const task=(id,ids,date,taskId='I01',objectId='object')=>({id,objectId,taskId,createdAt:date,updatedAt:date,status:'review',inputVersionIds:[],settings:{count:2},instruction:'',requestHash:id,outputVersionIds:ids,backendJobIds:[],message:'Fixture only',localOnly:false});
const initial={schemaVersion:1,id:'ws',projectId:'p',revision:1,objects:[{...object,settings:{faceLimit:77777}}],versions,tasks:[task('old-batch',['old-a','old-b'],'2026-10-12'),task('new-batch',['new-a','new-b'],'2026-10-13'),{...task('model-batch',['measured'],'2026-10-13','M01'),settings:{faceLimit:5000}},task('postprocess-batch',['postprocess'],'2026-10-13','T01')],deliveries:[]};
const project={id:'p',name:'격리 후보 비교',assets:[],parts:[]};
const legacySteps=[['단계별 에셋 제작',Workflow],['Tripo 작업실',Sparkles],['이미지 스튜디오',ImagePlus],['파츠 준비',Scissors],['조립 작업실',Boxes],['리깅 · 애니메이션',Workflow],['Unity로 보내기',Box]];
function SidebarFixture(){return <aside className="sidebar">
  <button className="brand"><div className="brand-mark"><Boxes size={24}/></div><span>partsmith<small>CHARACTER WORKBENCH</small></span></button>
  <div className="workspace-label">개인 작업 공간 <span className="badge neutral">LOCAL</span></div>
  <button className="nav"><Folder size={18}/> 모든 프로젝트</button>
  <div className="nav-label">에셋 제작</div>
  <button className="nav selected"><Workflow size={18}/><span>Unity 그래픽 제작</span></button>
  <details className="manual-tools"><summary>기존 작업 · 수동 도구</summary>{legacySteps.map(([label,Icon],i)=><button key={label} className="nav"><Icon size={18}/><span>{label}</span><small>0{i+1}</small></button>)}</details>
  <div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={18}/><div>내 컴퓨터에 저장<small>키는 프로젝트와 별도 보관</small></div></div>
  <button className="nav"><Settings size={18}/> 연결 설정<span className="connection-dot online"/></button>
  <div className="version">PROTOTYPE <span>v${JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version}</span></div></div>
</aside>}
function Harness(){const[workspace,setWorkspace]=useState(initial),[forcedBusy,setForcedBusy]=useState(false);window.setBusyFixture=setForcedBusy;window.workspace=workspace;window.refreshFixture=()=>setWorkspace(w=>({...w,versions:[...w.versions]}));window.resetFixture=()=>setWorkspace(initial);window.exportClicks=0;
window.compactFixture=()=>{const creation=defaultCreation('character');creation.subject='animal';creation.attributes={style:'stylized',shape:'round',legs:'four',ears:'long',tail:'short',composition:'whole'};setWorkspace({...initial,objects:[{...object,id:'compact-model',name:'흰 네발 토끼',kind:'character',creation,accepted:{'design:main':'new-a','model:main':'model'}}],versions:versions.filter(v=>['new-a','model'].includes(v.id)).map(v=>({...v,objectId:'compact-model',...(v.id==='model'?{preview:'new-a.png'}:{})})),tasks:[]});};
window.textureFixture=kind=>{const id='texture-'+kind,creation=defaultCreation('prop'),accepted=kind==='missing'?{}:{'design:main':'old-a'};if(kind.includes('part')){creation.attributes.composition='parts';creation.parts=[{id:'head',label:'머리',enabled:true,instruction:'',faceLimit:5000,count:1}];creation.activePartId='head';if(kind==='part')accepted['design:part-head']='new-a';}setWorkspace({...initial,objects:[{...object,id,creation,accepted}],versions:versions.map(v=>({...v,objectId:id,...(kind==='part'&&v.id==='new-a'?{slot:'part-head'}:{})})),tasks:[]});};
window.videoFixture=()=>setWorkspace({...initial,objects:[{...object,id:'video-object',accepted:{}}],versions:[version('video-a','동작 후보 1','2026-10-13','motion-reference','video-object'),version('video-b','동작 후보 2','2026-10-13','motion-reference','video-object')],tasks:[task('video-batch',['video-a','video-b'],'2026-10-13','N02','video-object')]});
window.motionSourceFixture=()=>setWorkspace({...initial,objects:[{...object,id:'motion-source-object',accepted:{}}],versions:[{...version('motion-source','측면 원본 묶음','2026-10-13','design','motion-source-object'),slot:'motion-source',files:['left.png','right.png'].map(path=>({path,kind:'image',bytes:20,sha256:path}))}],tasks:[]});
window.actionFixture=mode=>{const id='action-'+mode,creation=defaultCreation('character');creation.stageSettings.animation={instruction:'참고 동작을 유지합니다.',values:{animationMode:'video',clipName:'Idle',count:1,motionPreset:'idle',duration:2,fps:30}};const job=(id,clip,date,status)=>({...task(id,[],date,'N02','action-'+mode),settings:{clipName:clip,count:1},status,message:status==='failed'?'도구 연결 확인에 실패했습니다. 기존 입력과 비용 기록을 유지합니다.':'기존 원본을 확인하는 중입니다.',errorCode:status==='failed'?'CONNECTION_FAILED':undefined});const tasks=mode==='failed'?[job('old-idle','Idle','2026-10-12','failed'),job('latest-idle','Idle','2026-10-13','failed'),job('latest-jump','Jump','2026-10-13','failed')]:[{...job('current-native','Idle','2026-10-13',mode==='cost'?'awaiting_approval':'running'),...(mode==='permission'?{runtimeApproval:{id:'permission-1',title:'영상 도구 접근 확인',detail:'선택한 원본과 연결된 영상 도구에 접근합니다.',executionId:'exec-1',requestedAt:'2026-10-13',fields:[{id:'access',label:'접근 범위',required:true,options:[{value:'selected',label:'선택한 자료만'}]}]}}:mode==='cost'?{cost:{provider:'Runway',credits:24,basis:'fixture cost only'}}:{})}];setWorkspace({...initial,objects:[{...object,id,kind:'character',creation,accepted:{}}],versions:[],tasks});};
return <div className="app"><SidebarFixture/><div className="app-body"><header className="topbar">작업 공간 · 격리 UI 확인</header><GraphicsStudio project={project} workspace={workspace} busy={forcedBusy} onExportProject={()=>window.exportClicks++} onOpenSettings={()=>{}} onAction={async action=>{window.actions.push(action);if(action.kind==='runtime-approval'){setWorkspace(w=>({...w,tasks:w.tasks.map(t=>t.id===action.taskId?{...t,runtimeApproval:undefined}:t)}));return;}if(action.kind==='recover')return;if(action.kind!=='accept')throw Error('Service/production actions forbidden');setWorkspace(w=>({...w,objects:w.objects.map(o=>o.id===action.objectId?{...o,accepted:{...o.accepted,'design:main':action.versionId}}:o)}));}}/></div></div>}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
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
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const reports = [];
try {
  for (const width of [1426, 1280, 960, 853]) {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      deviceScaleFactor: 1.5,
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(root, "index.html")).href);
    await page.getByTestId("graphics-object-object").waitFor();
    const inspectShell = () =>
      page.locator(".sidebar").evaluate((sidebar) => {
        const bounds = sidebar.getBoundingClientRect(),
          failures = [];
        const visible = (element) => {
          const details = element.closest("details:not([open])");
          if (details && !element.closest("summary")) return false;
          const r = element.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const elements = [
          ...sidebar.querySelectorAll(
            ".brand, .brand > span, .brand small, .workspace-label, .nav, .nav > span:not(.connection-dot), .nav small, .manual-tools summary, .local-note, .local-note > div, .version, .version span",
          ),
        ].filter(visible);
        for (const element of elements) {
          const r = element.getBoundingClientRect();
          if (
            element.scrollWidth > element.clientWidth + 1 ||
            r.left < bounds.left - 1 ||
            r.right > bounds.right + 1
          )
            failures.push({
              kind: "element-overflow",
              text: element.textContent,
              client: element.clientWidth,
              scroll: element.scrollWidth,
            });
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          );
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            for (const t of range.getClientRects())
              if (
                t.left < r.left - 1 ||
                t.right > r.right + 1 ||
                t.top < r.top - 1 ||
                t.bottom > r.bottom + 1
              )
                failures.push({
                  kind: "text-overflow",
                  text: walker.currentNode.textContent,
                  container: element.className || element.tagName,
                });
          }
        }
        return {
          manualOpen: sidebar.querySelector("details").open,
          checkedElements: elements.length,
          navCount: elements.filter((e) => e.matches(".nav")).length,
          failures,
        };
      });
    const shellClosed = await inspectShell();
    assert.deepEqual(shellClosed.failures, []);
    assert.equal(shellClosed.manualOpen, false);
    await page.locator(".manual-tools summary").click();
    const shellOpen = await inspectShell();
    assert.deepEqual(shellOpen.failures, []);
    assert.equal(shellOpen.manualOpen, true);
    assert.equal(shellOpen.navCount, 10);
    await page.screenshot({
      path: path.join(root, "shell-expanded-" + width + ".png"),
    });
    await page.locator(".manual-tools summary").click();
    const shell = { closed: shellClosed, expanded: shellOpen };
    await page.evaluate(() => window.compactFixture());
    await page.getByTestId("graphics-object-compact-model").waitFor();
    await page
      .getByRole("navigation", { name: "제작 단계" })
      .getByRole("button", { name: "4 조립·수정", exact: true })
      .click();
    await page.getByTestId("graphics-version-model").click();
    await page.locator(".gs-main").evaluate((element) => {
      element.scrollTop = 0;
    });
    const compact = await page.evaluate(() => {
      const rect = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          bottom: r.bottom,
          right: r.right,
        };
      };
      return {
        sidebar: rect(".sidebar"),
        objectList: rect(".gs-objects"),
        header: rect(".gs-header"),
        topbar: rect(".topbar"),
        stage: rect(".gs-creation-stages button"),
        execute: rect(".gs-creation-execute"),
        button: rect('[data-testid="graphics-prepare"]'),
        settings: rect(".gs-instruction"),
        result: rect(".gs-result"),
        preview: rect(".gs-preview"),
        font: getComputedStyle(document.querySelector(".graphics-studio"))
          .fontSize,
        secondary: getComputedStyle(
          document.querySelector(".gs-creation-execute small"),
        ).fontSize,
        createOpen: document.querySelector(".gs-create-disclosure").open,
        optionsOpen: document.querySelector(".gs-current-options details").open,
        overflow:
          document.querySelector(".gs-main").scrollWidth >
          document.querySelector(".gs-main").clientWidth,
      };
    });
    assert.equal(compact.createOpen, false);
    assert.equal(compact.optionsOpen, false);
    assert.equal(compact.font, "13px");
    assert.equal(compact.secondary, "12px");
    assert(
      compact.stage.height <= 32 && compact.button.height <= 32,
      JSON.stringify(compact),
    );
    assert(compact.preview.y <= 265, JSON.stringify(compact));
    assert(
      compact.button.y >= 0 &&
        compact.button.right <= width &&
        compact.button.bottom <= 800,
    );
    assert.equal(compact.overflow, false);
    if (width > 1020) {
      assert(compact.settings.width <= 310);
      assert(compact.result.width > compact.settings.width);
    }
    await page.screenshot({
      path: path.join(root, "compact-model-" + width + ".png"),
    });
    await page.locator(".gs-current-options summary").click();
    assert.equal(
      await page
        .locator(".gs-current-options details")
        .evaluate((element) => element.open),
      true,
    );
    await page.locator(".gs-current-options summary").click();
    await page.locator(".gs-create-disclosure > summary").click();
    assert(await page.getByLabel("이름", { exact: true }).isVisible());
    await page.locator(".gs-create-disclosure > summary").click();
    await page
      .getByRole("button", { name: "프로젝트 백업", exact: true })
      .click();
    assert.equal(await page.evaluate(() => window.exportClicks), 1);
    await page.evaluate(() => window.setBusyFixture(true));
    assert(
      await page
        .getByRole("button", { name: "프로젝트 백업", exact: true })
        .isDisabled(),
    );
    await page.evaluate(() => window.setBusyFixture(false));
    assert.equal(await page.evaluate(() => window.actions.length), 0);
    await page
      .getByRole("navigation", { name: "제작 단계" })
      .getByRole("button", { name: "5 리깅", exact: true })
      .click();
    const ear = page.getByRole("checkbox", { name: "귀", exact: true });
    await ear.scrollIntoViewIfNeeded();
    const checkboxFlow = await ear.evaluate((input) => {
      const parent = input.parentElement,
        box = input.getBoundingClientRect(),
        label = parent.getBoundingClientRect();
      return {
        display: getComputedStyle(parent).display,
        inside: box.top >= label.top && box.bottom <= label.bottom,
        hittable:
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ) === input,
      };
    });
    assert.deepEqual(checkboxFlow, {
      display: "flex",
      inside: true,
      hittable: true,
    });
    await ear.check();
    assert.equal(await page.evaluate(() => window.actions.length), 0);
    assert.equal(
      await page
        .locator(".gs-creation-execute")
        .evaluate((element) => getComputedStyle(element).position),
      "static",
    );
    assert.equal(
      await page
        .locator(".gs-result")
        .evaluate((element) => getComputedStyle(element).position),
      "static",
    );
    await page
      .getByRole("navigation", { name: "제작 단계" })
      .getByRole("button", { name: "7 Unity 전달", exact: true })
      .click();
    const pivot = page.getByLabel("피벗", { exact: true });
    await pivot.scrollIntoViewIfNeeded();
    assert(
      await pivot.evaluate((select) => {
        const r = select.getBoundingClientRect(),
          p = select.parentElement.getBoundingClientRect();
        return (
          r.left >= p.left &&
          r.right <= p.right + 1 &&
          r.height >= 30 &&
          select.scrollWidth <= select.clientWidth
        );
      }),
    );
    await page.evaluate(() => window.resetFixture());
    const versionList = page.locator(".gs-version-list");
    await versionList.scrollIntoViewIfNeeded();
    const rowFlow = await versionList
      .locator(":scope > button")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const r = button.getBoundingClientRect(),
            text = button
              .querySelector(":scope > span")
              .getBoundingClientRect();
          return {
            id: button.dataset.testid,
            y: r.y,
            bottom: r.bottom,
            height: r.height,
            textTop: text.top,
            textBottom: text.bottom,
            contained:
              text.top >= r.top &&
              text.bottom <= r.bottom &&
              text.left >= r.left &&
              text.right <= r.right,
            shrink: getComputedStyle(button).flexShrink,
          };
        }),
      );
    assert(
      rowFlow.every(
        (row) => row.contained && row.shrink === "0" && row.height > 40,
      ),
      JSON.stringify(rowFlow),
    );
    assert(
      rowFlow.every(
        (row, index) => index === 0 || row.y >= rowFlow[index - 1].bottom,
      ),
    );
    const lastRow = versionList.locator(":scope > button").last();
    await lastRow.scrollIntoViewIfNeeded();
    assert(
      await lastRow.evaluate((button) => {
        const r = button.getBoundingClientRect(),
          list = button.parentElement.getBoundingClientRect(),
          hit = document.elementFromPoint(
            r.x + r.width / 2,
            r.y + r.height / 2,
          );
        return (
          r.y >= list.y - 1 &&
          r.bottom <= list.bottom + 1 &&
          button.contains(hit)
        );
      }),
    );
    const flow = {
      rowHeights: rowFlow.map((row) => row.height),
      allTextContained: true,
      rowsDoNotOverlap: true,
      lastRowReachable: true,
      checkboxFlow,
      selectContained: true,
      executeOverlaysContent: false,
    };
    await page.screenshot({
      path: path.join(root, "content-flow-" + width + ".png"),
    });
    const comparison = page.getByTestId("graphics-candidate-comparison");
    await comparison.waitFor();
    assert.equal(
      await comparison.getAttribute("data-batch-id"),
      "task:new-batch:image",
    );
    assert.equal(await comparison.locator(".gs-candidate-card").count(), 2);
    await comparison.scrollIntoViewIfNeeded();
    await comparison.locator("img").evaluateAll(async (images) => {
      await Promise.all(images.map((image) => image.decode()));
    });
    const grid = await comparison
      .locator(".gs-candidate-card")
      .evaluateAll((cards) =>
        cards.map((card) => {
          const rect = card.getBoundingClientRect(),
            image = card.querySelector("img");
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            right: rect.right,
            fit: getComputedStyle(image).objectFit,
            natural: [image.naturalWidth, image.naturalHeight],
          };
        }),
      );
    assert.equal(grid[0].y, grid[1].y);
    assert(grid[0].x < grid[1].x && grid[1].right <= width);
    assert(grid.every((card) => card.fit === "contain" && card.width > 100));
    assert.deepEqual(
      grid.map((card) => card.natural),
      [
        [80, 120],
        [120, 80],
      ],
    );
    assert.equal(
      await page
        .getByTestId("graphics-preview")
        .locator("img")
        .getAttribute("src"),
      pathToFileURL(path.join(root, "new-a.png")).href,
    );
    await page.screenshot({
      path: path.join(root, "candidates-" + width + ".png"),
    });
    await comparison
      .getByRole("button", {
        name: "후보 2 · 디자인 2 미리보기 선택",
        exact: true,
      })
      .click();
    assert.equal(
      await page
        .getByTestId("graphics-preview")
        .locator("img")
        .getAttribute("src"),
      pathToFileURL(path.join(root, "new-b.png")).href,
    );
    assert.equal(await page.evaluate(() => window.actions.length), 0);
    assert.equal(
      await page.evaluate(
        () => window.workspace.objects[0].accepted["design:main"],
      ),
      "old-a",
    );
    await page
      .getByRole("button", { name: "이미지 크게 보기", exact: true })
      .click();
    assert.equal(
      await page.getByRole("dialog").locator("img").getAttribute("src"),
      pathToFileURL(path.join(root, "new-b.png")).href,
    );
    await page
      .getByRole("button", { name: "이미지 닫기", exact: true })
      .click();
    await page
      .getByLabel("비교할 제작 작업", { exact: true })
      .selectOption("task:old-batch:image");
    assert.equal(
      await comparison.getByTestId("graphics-candidate-old-a").count(),
      1,
    );
    assert.equal(
      await comparison.getByTestId("graphics-candidate-new-a").count(),
      0,
    );
    await page
      .getByLabel("비교할 제작 작업", { exact: true })
      .selectOption("task:new-batch:image");
    await comparison
      .getByRole("button", {
        name: "후보 2 · 디자인 2 미리보기 선택",
        exact: true,
      })
      .click();
    assert.equal(await page.evaluate(() => window.actions.length), 0);
    await page.getByTestId("graphics-accept-version").click();
    assert.deepEqual(await page.evaluate(() => window.actions), [
      { kind: "accept", objectId: "object", versionId: "new-b" },
    ]);
    await page.getByTestId("graphics-version-model").click();
    assert.equal(await comparison.count(), 0);
    assert.equal(await page.getByTestId("graphics-version-old-a").count(), 1);
    assert.equal(await page.getByTestId("graphics-version-new-a").count(), 1);
    assert.equal(
      await page.getByTestId("graphics-target-faces").innerText(),
      "미설정",
    );
    assert.equal(
      await page.getByTestId("graphics-measured-faces").innerText(),
      "미측정",
    );
    assert.equal(
      await page.getByTestId("graphics-measured-triangles").innerText(),
      "미측정",
    );
    assert.deepEqual(await page.evaluate(() => window.reportReads), []);
    await page.getByTestId("graphics-version-measured").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="graphics-measured-faces"]')
          ?.textContent === "2,345",
    );
    assert.equal(
      await page.getByTestId("graphics-target-faces").innerText(),
      "5,000",
    );
    assert.equal(
      await page.getByTestId("graphics-measured-triangles").innerText(),
      "3,456",
    );
    await page
      .getByTestId("graphics-model-statistics")
      .scrollIntoViewIfNeeded();
    assert(
      await page
        .getByTestId("graphics-model-statistics")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    );
    await page.screenshot({
      path: path.join(root, "model-statistics-" + width + ".png"),
    });
    await page.evaluate(() => window.refreshFixture());
    await page.waitForTimeout(30);
    assert.deepEqual(await page.evaluate(() => window.reportReads), [
      "measured",
    ]);
    await page.getByTestId("graphics-version-postprocess").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="graphics-measured-faces"]')
          ?.textContent === "2,345",
    );
    assert.equal(
      await page.getByTestId("graphics-target-faces").innerText(),
      "5,000",
    );
    assert(
      (
        await page.getByTestId("graphics-model-statistics").innerText()
      ).includes("목표 면수 (원본)"),
    );
    await page.getByTestId("graphics-version-invalid").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="graphics-measured-faces"]')
          ?.textContent === "미측정",
    );
    await page.getByTestId("graphics-version-slow").click();
    await page.waitForFunction(() => window.reportReads.includes("slow"));
    await page.getByTestId("graphics-version-model").click();
    await page.waitForTimeout(350);
    assert.equal(
      await page.getByTestId("graphics-measured-faces").innerText(),
      "미측정",
    );
    assert((await page.evaluate(() => window.reportAborts)).includes("slow"));
    assert.equal(await page.evaluate(() => window.actions.length), 1);
    const openTexture = async (kind) => {
      await page.evaluate((kind) => window.textureFixture(kind), kind);
      await page.getByTestId("graphics-object-texture-" + kind).waitFor();
      await page
        .getByRole("navigation", { name: "제작 단계" })
        .getByRole("button", { name: "3 재질", exact: true })
        .click();
      await page.getByTestId("graphics-texture-reference").waitFor();
    };
    await openTexture("whole");
    const textureReference = page.getByTestId("graphics-texture-reference");
    assert.equal(
      await page
        .getByRole("button", { name: "채택 이미지 사용", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await textureReference.locator("img").getAttribute("data-version-id"),
      "old-a",
    );
    assert(
      (await textureReference.innerText()).includes("이미지와 설명 중 하나"),
    );
    await textureReference.scrollIntoViewIfNeeded();
    assert(
      await textureReference.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    );
    await page.screenshot({
      path: path.join(root, "texture-reference-" + width + ".png"),
    });
    await page
      .getByRole("button", { name: "설명만 사용", exact: true })
      .click();
    assert.equal(await textureReference.locator("img").count(), 0);
    assert((await textureReference.innerText()).includes("설명만 전송합니다"));
    await page
      .getByRole("button", { name: "채택 이미지 사용", exact: true })
      .click();
    assert.equal(
      await textureReference.locator("img").getAttribute("data-version-id"),
      "old-a",
    );
    await openTexture("missing");
    assert.equal(await textureReference.locator("img").count(), 0);
    assert(
      (await textureReference.innerText()).includes(
        "디자인 이미지가 없어 설명만",
      ),
    );
    await openTexture("missing-part");
    assert.equal(await textureReference.locator("img").count(), 0);
    assert((await textureReference.innerText()).includes("머리 파츠에"));
    await openTexture("part");
    assert.equal(
      await textureReference.locator("img").getAttribute("data-version-id"),
      "new-a",
    );
    await page
      .getByRole("button", { name: "로컬 기본 재질", exact: true })
      .click();
    assert.equal(await textureReference.count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "채택 이미지 사용", exact: true })
        .count(),
      0,
    );
    assert.equal(await page.evaluate(() => window.actions.length), 1);
    await page.evaluate(() => window.motionSourceFixture());
    const sideComparison = page.getByTestId(
      "graphics-motion-source-comparison",
    );
    await sideComparison.waitFor();
    await sideComparison.scrollIntoViewIfNeeded();
    await sideComparison
      .locator("img")
      .evaluateAll((images) =>
        Promise.all(images.map((image) => image.decode())),
      );
    assert.equal(
      await page.getByTestId("graphics-candidate-comparison").count(),
      0,
    );
    assert.deepEqual(
      await sideComparison.locator("figcaption").allTextContents(),
      ["왼쪽 측면", "오른쪽 측면"],
    );
    const sideFrames = await sideComparison
      .locator("img")
      .evaluateAll((images) =>
        images.map((image) => {
          const r = image.getBoundingClientRect(),
            p = image.parentElement.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            fit: getComputedStyle(image).objectFit,
            contained:
              r.left >= p.left &&
              r.right <= p.right &&
              r.top >= p.top &&
              r.bottom <= p.bottom,
            natural: [image.naturalWidth, image.naturalHeight],
          };
        }),
      );
    assert(
      sideFrames.every((image) => image.contained && image.fit === "contain"),
    );
    assert.equal(sideFrames[0].y, sideFrames[1].y);
    assert(sideFrames[0].x < sideFrames[1].x);
    assert.deepEqual(
      sideFrames.map((image) => image.natural),
      [
        [80, 120],
        [120, 80],
      ],
    );
    assert.deepEqual(
      await page.evaluate(() => window.workspace.objects[0].accepted),
      {},
    );
    assert.equal(await page.evaluate(() => window.actions.length), 1);
    await page.screenshot({
      path: path.join(root, "motion-source-comparison-" + width + ".png"),
    });
    if (width === 1280) {
      await page.evaluate(() => window.videoFixture());
      await page
        .getByRole("navigation", { name: "제작 단계" })
        .getByRole("button", { name: "6 애니메이션", exact: true })
        .click();
      const videos = page
        .getByTestId("graphics-candidate-comparison")
        .locator("video");
      assert.equal(await videos.count(), 2);
      assert.deepEqual(
        await videos.evaluateAll((items) =>
          items.map((video) => ({
            controls: video.controls,
            autoplay: video.autoplay,
            fit: getComputedStyle(video).objectFit,
          })),
        ),
        [
          { controls: true, autoplay: false, fit: "contain" },
          { controls: true, autoplay: false, fit: "contain" },
        ],
      );
    }
    for (const mode of ["failed", "permission", "cost", "running"]) {
      await page.evaluate((value) => window.actionFixture(value), mode);
      await page.getByTestId("graphics-object-action-" + mode).waitFor();
      await page
        .getByRole("navigation", { name: "제작 단계" })
        .getByRole("button", { name: "6 애니메이션", exact: true })
        .click();
      assert.match(
        await page.getByTestId("graphics-prepare").innerText(),
        /동작 영상 생성/,
      );
      assert.equal(
        await page
          .locator(".gs-main .gs-history, .gs-main .gs-catalog")
          .count(),
        0,
      );
      const baselineActions = await page.evaluate(() => window.actions.length);
      await page
        .locator(".gs-main")
        .evaluate((element) => (element.scrollTop = element.scrollHeight));
      const visibleCommand = await page
        .getByTestId("graphics-prepare")
        .evaluate((button) => {
          const r = button.getBoundingClientRect(),
            content = document
              .querySelector(".gs-main")
              .getBoundingClientRect();
          return {
            visible:
              r.y >= 0 &&
              r.bottom <= window.innerHeight &&
              document.elementFromPoint(
                r.x + r.width / 2,
                r.y + r.height / 2,
              ) === button,
            separate:
              document.querySelector(".gs-command-area").getBoundingClientRect()
                .bottom <=
              content.top + 1,
          };
        });
      assert.deepEqual(visibleCommand, { visible: true, separate: true });
      if (mode === "failed") {
        assert.equal(
          await page.getByTestId("graphics-current-task-old-idle").count(),
          0,
        );
        assert.equal(
          await page
            .getByLabel("현재 작업 상태", { exact: true })
            .locator('[role="alert"]')
            .count(),
          2,
        );
        assert(await page.getByTestId("graphics-prepare").isEnabled());
        await page.getByTestId("graphics-recover-latest-idle").click();
        assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
          kind: "recover",
          taskId: "latest-idle",
        });
        await page.getByLabel("보조 메뉴", { exact: true }).click();
        await page
          .getByRole("button", { name: "작업 기록 3개", exact: true })
          .click();
        assert.equal(
          await page
            .getByRole("dialog", { name: "작업 기록", exact: true })
            .locator(".gs-history > details")
            .count(),
          3,
        );
        await page
          .getByRole("button", { name: "보조 화면 닫기", exact: true })
          .click();
      } else if (mode === "permission") {
        assert(await page.getByTestId("graphics-prepare").isDisabled());
        const card = page.getByTestId(
          "graphics-runtime-approval-current-native",
        );
        assert(await card.isVisible());
        assert.equal(
          await page
            .getByTestId("graphics-current-task-current-native")
            .getAttribute("aria-busy"),
          "false",
        );
        assert.equal(await card.locator(".gs-progress-spinner").count(), 0);
        await page.screenshot({
          path: path.join(root, "permission-form-" + width + ".png"),
        });
        assert(
          await card
            .getByRole("button", { name: "확인하고 계속", exact: true })
            .isDisabled(),
        );
        await card
          .getByLabel("접근 범위", { exact: true })
          .selectOption("selected");
        assert.equal(
          await page.evaluate(() => window.actions.length),
          baselineActions,
        );
        await card
          .getByRole("button", { name: "확인하고 계속", exact: true })
          .click();
        assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), {
          kind: "runtime-approval",
          taskId: "current-native",
          approvalId: "permission-1",
          answer: { accepted: true, values: { access: "selected" } },
        });
        assert.equal(await card.count(), 0);
      } else if (mode === "cost") {
        assert(await page.getByTestId("graphics-prepare").isDisabled());
        await page
          .getByRole("button", { name: "비용·입력 확인", exact: true })
          .click();
        await page
          .getByTestId("graphics-cost-current-native")
          .scrollIntoViewIfNeeded();
        assert(
          await page.getByTestId("graphics-approve-current-native").isVisible(),
        );
        assert.equal(
          await page.evaluate(() => window.actions.length),
          baselineActions,
        );
      } else {
        assert(await page.getByTestId("graphics-prepare").isDisabled());
        assert.match(
          await page
            .getByTestId("graphics-current-task-current-native")
            .innerText(),
          /진행 중/,
        );
        const runningTask = page.getByTestId(
          "graphics-current-task-current-native",
        );
        assert.equal(await runningTask.getAttribute("aria-busy"), "true");
        assert.equal(
          await runningTask.locator(".gs-progress-spinner").count(),
          1,
        );
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(
          await runningTask
            .locator(".gs-progress-spinner")
            .evaluate((icon) => getComputedStyle(icon).animationName),
          "none",
        );
        await page.emulateMedia({ reducedMotion: "no-preference" });
      }
      await page.screenshot({
        path: path.join(root, "action-" + mode + "-" + width + ".png"),
      });
    }
    await page.getByLabel("보조 메뉴", { exact: true }).click();
    await page
      .getByRole("button", { name: "기능 지원 현황", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("dialog", { name: "기능 지원 현황", exact: true })
        .locator("[data-task-id]")
        .count(),
      117,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .getByRole("dialog", { name: "기능 지원 현황", exact: true })
        .count(),
      0,
    );
    assert.deepEqual(errors, []);
    reports.push({
      width,
      scale: 1.5,
      shell,
      compact,
      flow,
      actionArea: {
        visibleAfterScrolling: true,
        noOverlap: true,
        latestPerClipFailure: true,
        explicitRuntimeAnswer: true,
        separateCostApproval: true,
        auxiliaryDialogs: true,
      },
      motionSourceComparison: {
        directions: ["left", "right"],
        fullImages: true,
        noAutoAcceptance: true,
      },
      grid,
      distinctBatches: true,
      previewOnlyBeforeAcceptance: true,
      explicitAcceptanceOnly: true,
      modelStatistics: {
        frozenTarget: true,
        ancestorTarget: true,
        legacyUnmeasured: true,
        nativeHashRequired: true,
        noRerenderRead: true,
        obsoleteReadAborted: true,
      },
      textureReference: {
        adoptedOnly: true,
        explicitText: true,
        missingFallsBackToText: true,
        exactPartOnly: true,
        noActionOnChoice: true,
      },
      errors,
    });
    await context.close();
  }
  fs.writeFileSync(
    path.join(root, "report.json"),
    JSON.stringify(reports, null, 2),
  );
  console.log(
    JSON.stringify({
      root,
      reports,
      paidOrGenerationCalls: 0,
      videoCheck:
        "controls/layout only; no media playback or service verification",
    }),
  );
} finally {
  await browser.close();
}
