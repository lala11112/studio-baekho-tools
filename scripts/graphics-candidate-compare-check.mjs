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
const entry = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
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
const task=(id,ids,date,taskId='I01',objectId='object')=>({id,objectId,taskId,createdAt:date,updatedAt:date,status:'review',inputVersionIds:[],settings:{count:2},instruction:'',requestHash:id,outputVersionIds:ids,backendJobIds:[],message:'Fixture only',localOnly:false});
const initial={schemaVersion:1,id:'ws',projectId:'p',revision:1,objects:[{...object,settings:{faceLimit:77777}}],versions,tasks:[task('old-batch',['old-a','old-b'],'2026-10-12'),task('new-batch',['new-a','new-b'],'2026-10-13'),{...task('model-batch',['measured'],'2026-10-13','M01'),settings:{faceLimit:5000}},task('postprocess-batch',['postprocess'],'2026-10-13','T01')],deliveries:[]};
const project={id:'p',name:'격리 후보 비교',assets:[],parts:[]};
function Harness(){const[workspace,setWorkspace]=useState(initial);window.workspace=workspace;window.refreshFixture=()=>setWorkspace(w=>({...w,versions:[...w.versions]}));
window.textureFixture=kind=>{const id='texture-'+kind,creation=defaultCreation('prop'),accepted=kind==='missing'?{}:{'design:main':'old-a'};if(kind.includes('part')){creation.attributes.composition='parts';creation.parts=[{id:'head',label:'머리',enabled:true,instruction:'',faceLimit:5000,count:1}];creation.activePartId='head';if(kind==='part')accepted['design:part-head']='new-a';}setWorkspace({...initial,objects:[{...object,id,creation,accepted}],versions:versions.map(v=>({...v,objectId:id,...(kind==='part'&&v.id==='new-a'?{slot:'part-head'}:{})})),tasks:[]});};
window.videoFixture=()=>setWorkspace({...initial,objects:[{...object,id:'video-object',accepted:{}}],versions:[version('video-a','동작 후보 1','2026-10-13','motion-reference','video-object'),version('video-b','동작 후보 2','2026-10-13','motion-reference','video-object')],tasks:[task('video-batch',['video-a','video-b'],'2026-10-13','N02','video-object')]});
return <div className="app"><aside className="sidebar">Partsmith fixture</aside><div className="app-body"><header className="topbar">격리 UI 확인</header><GraphicsStudio project={project} workspace={workspace} busy={false} onAction={async action=>{window.actions.push(action);if(action.kind!=='accept')throw Error('Service/production actions forbidden');setWorkspace(w=>({...w,objects:w.objects.map(o=>o.id===action.objectId?{...o,accepted:{...o.accepted,'design:main':action.versionId}}:o)}));}}/></div></div>}
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
  for (const width of [1280, 960, 853]) {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      deviceScaleFactor: 1.5,
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(root, "index.html")).href);
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
    assert.deepEqual(errors, []);
    reports.push({
      width,
      scale: 1.5,
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
