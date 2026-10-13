import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { compileCreation } from "../shared/graphics-creation";
import type {
  AssetVersion,
  GraphicsAction,
  GraphicsTask,
  GraphicsObject,
} from "../shared/graphics";
import {
  filterGraphicsTasks,
  findGraphicsTask,
  graphicsCatalog,
  graphicsApprovalState,
  graphicsMultiviewProblem,
  recommendedGraphicsTasks,
} from "../shared/graphics-catalog";

test("approval states allow explicit native account usage and refresh expired API quotes without treating unknown paid cost as approval", () => {
  const task: GraphicsTask = {
    id: "t",
    objectId: "o",
    taskId: "I01",
    createdAt: "",
    updatedAt: "",
    status: "awaiting_approval",
    inputVersionIds: [],
    settings: {},
    instruction: "new prop",
    requestHash: "h",
    outputVersionIds: [],
    backendJobIds: [],
    message: "",
    localOnly: false,
    cost: { provider: "Codex", credits: null, basis: "account usage" },
  };
  assert.equal(graphicsApprovalState(task, 1000), "execute");
  assert.equal(
    graphicsApprovalState(
      {
        ...task,
        taskId: "M01",
        cost: { provider: "Tripo API", credits: null, basis: "unknown" },
      },
      1000,
    ),
    "blocked",
  );
  assert.equal(
    graphicsApprovalState(
      {
        ...task,
        taskId: "M01",
        quoteId: "q",
        cost: {
          provider: "Tripo API",
          credits: 100,
          expiresAt: 999,
          basis: "published",
        },
      },
      1000,
    ),
    "refresh",
  );
  assert.equal(
    graphicsApprovalState(
      {
        ...task,
        taskId: "A05",
        localOnly: true,
        cost: { provider: "로컬", credits: 0, basis: "local" },
      },
      1000,
    ),
    "execute",
  );
  assert.equal(
    graphicsApprovalState({ ...task, status: "running" }, 1000),
    "blocked",
  );
  assert.equal(
    graphicsApprovalState(
      {
        ...task,
        taskId: "M01",
        cost: { provider: "Codex", credits: null, basis: "wrong adapter" },
      },
      1000,
    ),
    "blocked",
  );
});

test("multiview mapping requires four distinct image originals and preserves explicit left/right slots", () => {
  const versions: AssetVersion[] = ["front", "left", "back", "right"].map(
    (direction) => ({
      id: direction,
      objectId: "o",
      role: "design",
      slot: "main",
      label: direction,
      files: [
        {
          path: `${direction}.png`,
          kind: "image",
          bytes: 1,
          sha256: direction,
        },
      ],
      createdAt: "",
      sourceVersionIds: [],
      provenance: { type: "import" },
      warnings: [],
    }),
  );
  const settings = {
    frontVersionId: "front",
    leftVersionId: "left",
    backVersionId: "back",
    rightVersionId: "right",
  };
  assert.equal(graphicsMultiviewProblem(settings, versions), undefined);
  assert.match(
    graphicsMultiviewProblem(
      { ...settings, leftVersionId: "right" },
      versions,
    )!,
    /서로 다른/,
  );
  assert.match(
    graphicsMultiviewProblem({ ...settings, rightVersionId: "" }, versions)!,
    /각각 지정/,
  );
  assert.match(
    graphicsMultiviewProblem(
      settings,
      versions.map((version) => ({
        ...version,
        files: [{ ...version.files[0], path: `${version.id}.fbx` }],
      })),
    )!,
    /원본 이미지/,
  );
  assert.equal(settings.leftVersionId, "left");
  assert.equal(settings.rightVersionId, "right");
});

test("graphics catalog preserves all 116 reviewed tasks and declares the added Astra model path separately", () => {
  const text = fs.readFileSync(
    path.resolve("docs/graphics-studio/02-전체-작업-선택표.md"),
    "utf8",
  );
  const expected = text
    .split(/\r?\n/)
    .filter((line) => /^\| [A-Z]\d{2} \|/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((column) => column.trim()),
    );
  assert.equal(expected.length, 116);
  assert.equal(graphicsCatalog.length, 117);
  assert.equal(new Set(graphicsCatalog.map((task) => task.id)).size, 117);
  const originalIds = new Set(expected.map(([id]) => id));
  assert.deepEqual(
    graphicsCatalog
      .filter((task) => !originalIds.has(task.id))
      .map((task) => ({
        id: task.id,
        name: task.name,
        executor: task.executor,
        status: task.status,
      })),
    [
      {
        id: "M15",
        name: "Blender + Astra 모델 제작",
        executor: "astra",
        status: "unverified",
      },
    ],
  );
  for (const [id, name, inputs, output] of expected) {
    const task = findGraphicsTask(id);
    assert(task, id);
    assert.deepEqual(
      { name: task.name, inputs: task.inputs, output: task.output },
      { name, inputs, output },
    );
  }
  assert.equal(findGraphicsTask("I02")?.name, "참조 기반 디자인");
  assert.equal(findGraphicsTask("I03")?.name, "기존 이미지 수정");
  assert.equal(findGraphicsTask("I07")?.status, "unverified");
});

test("catalog distinguishes connected unverified paths from local and unavailable paths", () => {
  const ready = graphicsCatalog
    .filter((task) => task.status === "ready")
    .map((task) => task.id);
  assert.deepEqual(ready, [
    "A01",
    "A02",
    "A03",
    "A05",
    "I01",
    "M01",
    "M05",
    "T01",
    "T03",
    "N01",
    "X04",
    "X05",
  ]);
  const connected = graphicsCatalog
    .filter((task) => task.status === "unverified")
    .map((task) => task.id);
  assert.deepEqual(connected, [
    "I02",
    "I03",
    "I05",
    "I06",
    "I07",
    "I08",
    "M02",
    "M03",
    "M04",
    "M06",
    "M07",
    "M08",
    "M10",
    "T02",
    "T05",
    "R01",
    "R02",
    "R03",
    "N02",
    "N04",
    "N05",
    "N06",
    "M15",
  ]);
  assert(
    graphicsCatalog
      .filter((task) => task.status !== "ready")
      .every((task) => task.reason && task.reason.length > 10),
  );
  assert(
    graphicsCatalog
      .filter((task) => task.status === "planned")
      .every((task) => task.executor === "none"),
  );
});

test("recommendations preserve a supplied model and search covers inputs and review criteria", () => {
  const model: AssetVersion = {
    id: "model",
    objectId: "o",
    role: "model",
    slot: "main",
    label: "Existing",
    files: [],
    createdAt: "2026-10-12T00:00:00Z",
    sourceVersionIds: [],
    provenance: { type: "import" },
    warnings: [],
  };
  for (const kind of ["character", "weapon", "prop", "environment"] as const) {
    const recommended = recommendedGraphicsTasks(kind, [model]);
    assert(!recommended.includes("I01"));
    assert(!recommended.includes("M01"));
    assert(recommended.includes("X05"));
    assert(recommended.every((id) => findGraphicsTask(id)));
  }
  assert(recommendedGraphicsTasks("ui", []).includes("U07"));
  assert(recommendedGraphicsTasks("sprite", []).includes("S08"));
  assert(recommendedGraphicsTasks("vfx", []).includes("V05"));
  assert.deepEqual(
    filterGraphicsTasks("i03 기존").map((task) => task.id),
    ["I03"],
  );
  assert(filterGraphicsTasks("Humanoid").some((task) => task.id === "R01"));
  assert.deepEqual(
    filterGraphicsTasks("", ["A01", "X05"]).map((task) => task.id),
    ["A01", "X05"],
  );
});

test(
  "graphics UI dispatches real typed actions, preserves versions and requires durable cost approval",
  { timeout: 180000 },
  async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "partsmith-graphics-ui-"),
    );
    const entry = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {GraphicsStudio} from ${JSON.stringify(path.resolve("src/GraphicsStudio.tsx"))};
    const createdAt='2026-10-12T00:00:00Z';
    const version=(id,objectId,role,label)=>({id,objectId,role,slot:'main',label,files:[{path:id+'.fbx',sha256:'a'.repeat(64),bytes:123,kind:'model'}],createdAt,sourceVersionIds:[],provenance:{type:'import'},warnings:[]});
    const initial={schemaVersion:1,id:'ws',projectId:'p',revision:0,objects:[{id:'sword',name:'Greatsword',kind:'weapon',createdAt,selectedTasks:[],instruction:'keep markings',settings:{model:'P2-20260801',textureSize:4096},references:[],accepted:{'model:main':'old'}},{id:'knight',name:'Knight',kind:'character',createdAt,selectedTasks:[],instruction:'',settings:{},references:[],accepted:{}}],versions:[version('old','sword','model','Original sword'),version('new','sword','model','Revised sword'),version('ref','knight','design','Knight reference')],tasks:[],deliveries:[]};
    const project={schemaVersion:1,id:'p',name:'UI fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt,updatedAt:createdAt,revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    window.desktop={assetUrl:()=>''}; window.graphicsActions=[];
    function Harness(){
      const [workspace,setWorkspace]=useState(initial);
      window.graphicsWorkspace=workspace;
      const action=async(value)=>{
        window.graphicsActions.push(value);
        if(value.kind==='prepare' && value.taskId==='M01') throw Error('Test adapter rejected unsupported quality');
        setWorkspace(current=>{
          const next=structuredClone(current);next.revision++;
          if(value.kind==='update-object') Object.assign(next.objects.find(o=>o.id===value.objectId),value.patch);
          if(value.kind==='create-object') next.objects.push({id:'created',name:value.name,kind:value.objectKind,createdAt,selectedTasks:[],instruction:'',settings:{},references:[],accepted:{}});
          if(value.kind==='accept'){const v=next.versions.find(v=>v.id===value.versionId);next.objects.find(o=>o.id===value.objectId).accepted[v.role+':'+v.slot]=v.id;}
          if(value.kind==='prepare')next.tasks.push({id:'quote',objectId:value.objectId,taskId:value.taskId,createdAt,updatedAt:createdAt,status:'awaiting_approval',inputVersionIds:['new'],settings:{count:1},instruction:'frozen request',requestHash:'frozen-hash',outputVersionIds:[],backendJobIds:[],quoteId:'q',cost:{provider:'STUB',credits:100,basis:'Fixture observed cost',expiresAt:Date.now()+60000},message:'Review cost',localOnly:false});
          if(value.kind==='approve')next.tasks.find(t=>t.id===value.taskId).status='running';
          if(value.kind==='cancel')next.tasks.find(t=>t.id===value.taskId).status='cancelled';
          if(value.kind==='inspect-target')next.target={id:'target',projectPath:'C:/Fixture',unityVersion:'6000.3',pipeline:'urp',platform:'pc',packages:{'com.unity.render-pipelines.universal':'17.0'},inspectedAt:createdAt,fingerprint:'f',warnings:[]};
          if(value.kind==='audit-usage')next.usage={sampledJobs:2,measuredWorkers:1,missingWorkers:1,localExecutions:1,inputTokens:100,cachedInputTokens:80,uncachedInputTokens:20,outputTokens:12,findings:[{severity:'warning',message:'One measurement missing'}]};
          return next;
        });
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
      '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; connect-src \'none\'; img-src \'self\' data:"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(root, "main.cjs"),
      `process.on('uncaughtException',error=>{console.error(error.stack);process.exit(1)});const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(path.join(root, "index.html"))});});`,
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
      await page.getByTestId("graphics-studio").waitFor();
      await page.getByTestId("graphics-object-sword").click();
      assert.equal(await page.locator("[data-task-id]").count(), 0);
      await page.getByLabel("보조 메뉴", { exact: true }).click();
      await page
        .getByRole("button", { name: "기능 지원 현황", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "기능 지원 현황", exact: true })
        .waitFor();
      assert.equal(await page.locator("[data-task-id]").count(), 117);
      await page.getByRole("tab", { name: "추천", exact: true }).click();
      assert.equal(await page.locator('[data-task-id="M01"]').count(), 0);
      assert.equal(await page.locator('[data-task-id="X05"]').count(), 1);
      await page.getByRole("tab", { name: "전체", exact: true }).click();
      await page.getByRole("textbox", { name: "작업 검색" }).fill("I04");
      await page.locator('[data-task-id="I04"] button').click();
      assert.match(
        await page.getByRole("status").innerText(),
        /특정 영역만 수정/,
      );
      assert.equal(
        await page.evaluate(() => (window as any).graphicsActions.length),
        0,
        "Support catalog browsing must not change or execute production settings",
      );
      await page.getByRole("textbox", { name: "작업 검색" }).fill("I03");
      assert.match(
        await page.getByTestId("graphics-task-list").innerText(),
        /기존 이미지 수정/,
      );
      await page
        .getByRole("button", { name: "보조 화면 닫기", exact: true })
        .click();
      await page
        .getByRole("navigation", { name: "제작 단계" })
        .getByRole("button", { name: "7 Unity 전달", exact: true })
        .click();
      await page
        .getByLabel("이 단계 추가 지시 · 선택지에 없는 내용")
        .fill("Keep the original geometry and markings");
      await page.getByLabel("실제 크기 모드", { exact: true }).selectOption("uniform");
      await page.getByLabel("기준 길이 미터", { exact: true }).fill("2");
      await page.getByLabel("크기 피벗", { exact: true }).selectOption("bottom-center");
      await page.getByLabel("출력 형식", { exact: true }).selectOption("fbx");
      await page
        .getByText("이미 가진 이미지 · 모델 · 동작 가져오기", { exact: true })
        .click();
      await page.getByLabel("가져올 자료의 역할").selectOption("rig");
      await page.getByTestId("graphics-import").click();
      await page.getByTestId("graphics-reference-version").selectOption("ref");
      await page.getByLabel("참고 역할", { exact: true }).selectOption("style");
      await page
        .getByRole("button", { name: "참고 연결", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: "Knight reference 참고 연결 해제",
          exact: true,
        })
        .waitFor();
      await page.getByTestId("graphics-version-new").click();
      await page.getByTestId("graphics-accept-version").click();
      await page
        .getByTestId("graphics-accept-version")
        .filter({ hasText: "현재 채택 버전" })
        .waitFor();
      await page
        .getByRole("navigation", { name: "제작 단계" })
        .getByRole("button", { name: "2 모델", exact: true })
        .click();
      await page.getByTestId("graphics-prepare").click();
      await page.getByRole("alert").waitFor();
      assert.match(
        await page.getByRole("alert").innerText(),
        /기존 원본과 채택 결과는 유지/,
      );
      assert.equal(await page.getByTestId("graphics-version-old").count(), 1);
      await page
        .getByRole("navigation", { name: "제작 단계" })
        .getByRole("button", { name: "7 Unity 전달", exact: true })
        .click();
      await page
        .getByRole("button", { name: "FBX · GLB 파일 내보내기", exact: true })
        .click();
      await page.getByTestId("graphics-prepare").click();
      await page.getByTestId("graphics-cost-quote").waitFor();
      await page
        .getByLabel("이 단계 추가 지시 · 선택지에 없는 내용")
        .fill("New unsaved instructions must not change the approved request");
      assert.match(
        await page.getByTestId("graphics-cost-quote").innerText(),
        /frozen request/,
      );
      assert(
        !(await page.getByTestId("graphics-cost-quote").innerText()).includes(
          "New unsaved",
        ),
      );
      await page
        .getByTestId("graphics-cost-quote")
        .getByText("고정된 요청 확인")
        .click();
      assert.deepEqual(
        JSON.parse(
          await page
            .getByTestId("graphics-cost-quote")
            .locator("pre")
            .innerText(),
        ),
        { count: 1 },
      );
      const actionsBefore = await page.evaluate(
        () =>
          (window as unknown as { graphicsActions: GraphicsAction[] })
            .graphicsActions,
      );
      assert(!actionsBefore.some((action) => action.kind === "approve"));
      await page.getByTestId("graphics-approve-quote").click();
      await page
        .getByLabel("현재 작업 상태", { exact: true })
        .getByRole("button", { name: "추적 중지", exact: true })
        .click();
      await page
        .getByRole("button", { name: "프로젝트 검사", exact: true })
        .click();
      await page
        .getByRole("button", { name: "사용량 확인", exact: true })
        .click();
      await page.getByText("One measurement missing").waitFor();
      const result = await page.evaluate(() => ({
        actions: (window as unknown as { graphicsActions: GraphicsAction[] })
          .graphicsActions,
        workspace: (
          window as unknown as {
            graphicsWorkspace: {
              objects: {
                id: string;
                settings: Record<string, unknown>;
                creation: GraphicsObject["creation"];
                accepted: Record<string, string>;
                references: unknown[];
              }[];
              versions: unknown[];
            };
          }
        ).graphicsWorkspace,
      }));
      assert(
        result.actions.some(
          (action) =>
            action.kind === "import" &&
            action.objectId === "sword" &&
            action.role === "rig",
        ),
      );
      assert(
        result.actions.some(
          (action) => action.kind === "approve" && action.taskId === "quote",
        ),
      );
      assert(
        result.actions.some(
          (action) => action.kind === "cancel" && action.taskId === "quote",
        ),
      );
      const sword = result.workspace.objects.find(
        (object) => object.id === "sword",
      )!;
      assert.equal(sword.creation?.physicalSize?.mode, "uniform");
      assert.equal(sword.creation?.physicalSize?.axis, "y");
      assert.equal(sword.creation?.physicalSize?.lengthMeters, 2);
      assert.equal(sword.creation?.physicalSize?.pivot, "bottom-center");
      assert.equal(
        sword.creation?.stageSettings.unity?.values.exportFormat,
        "fbx",
      );
      assert.equal(
        sword.creation?.stageSettings.surface?.values.textureSize,
        4096,
      );
      assert.equal(sword.accepted["model:main"], "new");
      assert.equal(result.workspace.versions.length, 3);
      assert.equal(sword.references.length, 1);
      await page.locator(".gs-create-disclosure > summary").click();
      await page.getByLabel("이름", { exact: true }).fill("Shield");
      await page.getByRole("group", { name: "오브젝트 분류", exact: true }).getByRole("button", { name: "무기·장비", exact: true }).click();
      await page.getByRole("group", { name: "만들 대상 선택", exact: true }).getByRole("button", { name: "검·총·활·방패", exact: true }).click();
      await page
        .getByRole("button", { name: "오브젝트 만들기", exact: true })
        .click();
      await page.getByTestId("graphics-object-created").waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
      assert(
        path
          .resolve(root)
          .startsWith(
            path.join(path.resolve(os.tmpdir()), "partsmith-graphics-ui-"),
          ),
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "graphics UI freezes equipment, directions, side PNG selection and rig controls without executing services",
  { timeout: 180000 },
  async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "partsmith-graphics-settings-ui-"),
    );
    const entry = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {GraphicsStudio} from ${JSON.stringify(path.resolve("src/GraphicsStudio.tsx"))};
    import {compileCreation} from ${JSON.stringify(path.resolve("shared/graphics-creation.ts"))};
    const createdAt='2026-10-13T00:00:00Z';
    const png=(path,letter)=>({path,kind:'image',sha256:letter.repeat(64),bytes:123});
    const version=(id,objectId,slot,files)=>({id,objectId,role:'design',slot,label:id,files,createdAt,sourceVersionIds:[],provenance:{type:'import'},warnings:[]});
    const prior={id:'prior-paid',objectId:'reference',taskId:'M01',createdAt,updatedAt:createdAt,status:'submission_unknown',inputVersionIds:[],settings:{},instruction:'',requestHash:'prior',outputVersionIds:[],backendJobIds:[],message:'Prior uncertain submission',localOnly:false,paidApproval:{requestHash:'prior',provider:'Tripo API',credits:70,approvedAt:createdAt}};
    let current={schemaVersion:1,id:'ws',projectId:'p',revision:0,tripoBudget:{limit:100,configuredAt:createdAt},objects:[
      {id:'reference',name:'Character reference',kind:'character',createdAt,selectedTasks:[],instruction:'',settings:{},references:[],accepted:{'design:main':'foreign'}},
      {id:'target',name:'Target object',kind:'weapon',createdAt,selectedTasks:[],instruction:'Preserve markings',settings:{},references:[{versionId:'foreign',role:'appearance'}],accepted:{'design:main':'accepted-design','design:motion-source':'accepted-sides'}}
    ],versions:[version('foreign','reference','main',[png('foreign.png','f')]),version('accepted-design','target','main',[png('design.png','a')]),version('accepted-sides','target','motion-source',[png('sides/left.png','b'),png('sides/right.png','c'),{path:'sides/render.json',kind:'report',sha256:'d'.repeat(64),bytes:500}]),version('unaccepted','target','other',[png('unaccepted.png','e')]),version('jpeg-only','target','extra',[png('only.jpg','a')])],tasks:[prior],deliveries:[]};
    const project={schemaVersion:1,id:'p',name:'Settings fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt,updatedAt:createdAt,revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    const transparent='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    window.desktop={assetUrl:(_id,file)=>transparent+'#'+file};window.graphicsActions=[];window.graphicsPrepared=[];
    function Harness(){
      const [workspace,setWorkspace]=useState(current);window.graphicsWorkspace=workspace;
      const action=async(value)=>{
        window.graphicsActions.push(structuredClone(value));current=structuredClone(current);current.revision++;
        if(value.kind==='approve')throw Error('Service execution is forbidden in this UI-only fixture');
        if(value.kind==='update-object')Object.assign(current.objects.find(o=>o.id===value.objectId),value.patch);
        if(value.kind==='set-tripo-budget')current.tripoBudget={limit:value.credits,configuredAt:createdAt};
        if(value.kind==='cancel')current.tasks.find(task=>task.id===value.taskId).status='cancelled';
        if(value.kind==='prepare'){
          const object=current.objects.find(o=>o.id===value.objectId),index=window.graphicsPrepared.length;
          window.graphicsPrepared.push({taskId:value.taskId,object:structuredClone(object)});
          const compiled=compileCreation(object,value.taskId),settings=structuredClone(compiled.settings);if(value.taskId==='N02')settings.motionSourceView??='left';
          current.tasks.push({id:'prepared-'+index,objectId:value.objectId,taskId:value.taskId,createdAt,updatedAt:createdAt,status:'awaiting_approval',inputVersionIds:value.taskId==='N02'?[settings.motionSourceVersionId]:[],settings,instruction:compiled.instruction,objectSnapshot:{name:object.name,kind:object.kind,accepted:structuredClone(object.accepted),references:structuredClone(object.references)},requestHash:'frozen-'+index,outputVersionIds:[],backendJobIds:[],message:'UI fixture only',localOnly:false,cost:value.taskId==='N02'?{provider:'Runway',credits:Number(settings.duration??2)*12,basis:'Fixture published estimate'}:{provider:'Codex',credits:null,basis:'Fixture account usage'}});
        }
        setWorkspace(current);
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
      '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; connect-src \'none\'; img-src \'self\' data:"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(root, "main.cjs"),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, "profile"))});app.whenReady().then(()=>{const window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});window.loadFile(${JSON.stringify(path.join(root, "index.html"))});});`,
    );
    const app = await electron.launch({
      executablePath: electronBinary as unknown as string,
      args: [path.join(root, "main.cjs")],
    });
    try {
      const page = await app.firstWindow(),
        errors: string[] = [];
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByTestId("graphics-studio").waitFor();
      await page.getByTestId("graphics-object-target").click();
      const choose = async (id: string) => {
        const choices: Record<string, [string, string]> = {
          I06: ["1 이미지", "참조 캐릭터 장비"],
          I07: ["1 이미지", "멀티뷰"],
          N02: ["6 애니메이션", "AI 동작 영상"],
          R01: ["5 리깅", "Humanoid · 사람형"],
          M15: ["2 모델", "Blender + Astra"],
        };
        const [stage, mode] = choices[id];
        await page
          .getByRole("navigation", { name: "제작 단계" })
          .getByRole("button", { name: stage, exact: true })
          .click();
        await page.getByRole("button", { name: mode, exact: true }).click();
      };
      const prepare = async (index: number) => {
        await page.getByTestId("graphics-prepare").click();
        const card = page.getByTestId(`graphics-cost-prepared-${index}`);
        await card.waitFor();
        return card;
      };
      const cancel = async (index: number) => {
        await page
          .getByTestId(`graphics-cost-prepared-${index}`)
          .getByRole("button", { name: "취소", exact: true })
          .click();
        await page
          .getByTestId(`graphics-cost-prepared-${index}`)
          .waitFor({ state: "detached" });
      };
      const snapshots = () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                graphicsPrepared: { taskId: string; object: GraphicsObject }[];
              }
            ).graphicsPrepared,
        );

      await choose("M15");
      await page
        .getByRole("button", { name: "네 방향 원본", exact: true })
        .click();
      assert.equal(
        await page.getByTestId("graphics-prepare").isDisabled(),
        true,
      );
      await page
        .getByLabel("정면 원본", { exact: true })
        .selectOption("foreign");
      await page
        .getByLabel("후면 원본", { exact: true })
        .selectOption("foreign");
      await page
        .getByLabel("왼쪽 원본", { exact: true })
        .selectOption("accepted-sides");
      await page
        .getByLabel("오른쪽 원본", { exact: true })
        .selectOption("unaccepted");
      assert.equal(
        await page.getByTestId("graphics-prepare").isDisabled(),
        true,
        "Astra multiview also rejects duplicate directions",
      );
      await page
        .getByLabel("후면 원본", { exact: true })
        .selectOption("accepted-design");
      assert.equal(
        await page.getByTestId("graphics-prepare").isEnabled(),
        true,
      );
      assert.equal(
        await page.evaluate(() => (window as any).graphicsActions.length),
        0,
        "Mapping Astra directions alone cannot create a request",
      );

      await choose("I06");
      assert.equal(
        await page.getByLabel("장비 결과", { exact: true }).inputValue(),
        "standalone",
      );
      await page.getByLabel("장비 결과", { exact: true }).selectOption("worn");
      await page.getByLabel("후보 개수", { exact: true }).fill("2");
      await page
        .getByLabel("이 단계 추가 지시 · 선택지에 없는 내용")
        .fill("Matching armor worn by the reference character");
      await prepare(0);
      let captured = (await snapshots())[0];
      assert.equal(captured.taskId, "I06");
      assert.equal(
        compileCreation(captured.object, captured.taskId).settings
          .equipmentOutput,
        "worn",
      );
      assert.equal(
        compileCreation(captured.object, captured.taskId).settings.count,
        2,
      );
      assert.deepEqual(captured.object.references, [
        { versionId: "foreign", role: "appearance" },
      ]);
      await cancel(0);

      await choose("I07");
      for (const name of ["정면", "후면", "좌측", "우측"])
        assert.equal(
          await page.getByRole("checkbox", { name, exact: true }).isChecked(),
          true,
        );
      await page.getByRole("checkbox", { name: "정면", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "정면", exact: true }).check();
      await page.getByRole("checkbox", { name: "후면", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "좌측", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "우측", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "우측", exact: true }).check();
      await page.getByLabel("후보 개수", { exact: true }).fill("3");
      const directions = await prepare(1);
      captured = (await snapshots())[1];
      assert.deepEqual(
        Object.fromEntries(
          ["viewFront", "viewBack", "viewLeft", "viewRight", "count"].map(
            (key) => [
              key,
              compileCreation(captured.object, captured.taskId).settings[key],
            ],
          ),
        ),
        {
          viewFront: true,
          viewBack: false,
          viewLeft: false,
          viewRight: true,
          count: 3,
        },
      );
      await page.getByRole("checkbox", { name: "정면", exact: true }).uncheck();
      await directions.getByText("고정된 요청 확인").click();
      const frozenDirections = JSON.parse(
        await directions.locator("pre").innerText(),
      );
      assert.equal(frozenDirections.viewFront, true);
      assert.equal(frozenDirections.count, 3);
      await cancel(1);

      await choose("N02");
      await page.getByLabel("클립 이름", { exact: true }).fill("Rabbit_Idle");
      await page.getByLabel("클립 이름", { exact: true }).press("Enter");
      const sources = await page
        .getByLabel("영상 입력 원본", { exact: true })
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        );
      assert.deepEqual(sources, ["", "accepted-design", "accepted-sides"]);
      assert.equal(
        await page.getByLabel("영상 측면 방향", { exact: true }).inputValue(),
        "left",
      );
      await page
        .getByLabel("영상 입력 원본", { exact: true })
        .selectOption("accepted-sides");
      assert.equal(
        await page.getByLabel("영상 원본 파일", { exact: true }).inputValue(),
        "sides/left.png",
      );
      assert.deepEqual(
        await page
          .getByLabel("영상 원본 파일", { exact: true })
          .locator("option")
          .evaluateAll((options) =>
            options.map((option) => (option as HTMLOptionElement).value),
          ),
        ["", "sides/left.png", "sides/right.png"],
      );
      await page.getByLabel("동작 길이", { exact: true }).fill("2");
      await page
        .getByRole("checkbox", { name: "반복 동작", exact: true })
        .check();
      let videoCard = await prepare(2);
      captured = (await snapshots())[2];
      assert.equal(
        compileCreation(captured.object, captured.taskId).settings
          .motionSourceVersionId,
        "accepted-sides",
      );
      assert.equal(
        compileCreation(captured.object, captured.taskId).settings
          .motionSourcePath,
        "sides/left.png",
      );
      // The UI displays the left default; the real host normalizes this omitted setting before hashing.
      assert.equal(
        compileCreation(captured.object, captured.taskId).settings
          .motionSourceView ?? "left",
        "left",
      );
      await videoCard.getByText("고정된 요청 확인").click();
      assert.equal(
        JSON.parse(await videoCard.locator("pre").innerText()).motionSourceView,
        "left",
      );
      assert.match(await videoCard.innerText(), /24 크레딧/);
      await cancel(2);
      await page
        .getByLabel("영상 원본 파일", { exact: true })
        .selectOption("sides/right.png");
      await page
        .getByLabel("영상 측면 방향", { exact: true })
        .selectOption("right");
      videoCard = await prepare(3);
      captured = (await snapshots())[3];
      assert.equal(
        compileCreation(captured.object, captured.taskId).settings
          .motionSourcePath,
        "sides/right.png",
      );
      assert.equal(
        compileCreation(captured.object, captured.taskId).settings
          .motionSourceView,
        "right",
      );
      assert.match(
        (await videoCard
          .getByLabel("고정된 입력 버전")
          .locator("img")
          .getAttribute("src"))!,
        /#sides\/right\.png$/,
      );
      assert.equal(
        await videoCard
          .getByLabel("고정된 입력 버전")
          .locator("code")
          .innerText(),
        "c".repeat(64),
      );
      await cancel(3);

      await choose("R01");
      await page.getByRole("checkbox", { name: "귀", exact: true }).check();
      await page.getByRole("checkbox", { name: "꼬리", exact: true }).check();
      await page.getByRole("checkbox", { name: "꼬리", exact: true }).uncheck();
      await page
        .getByRole("checkbox", { name: "머리카락", exact: true })
        .check();
      await page.getByRole("checkbox", { name: "옷", exact: true }).check();
      await page.getByRole("checkbox", { name: "옷", exact: true }).uncheck();
      await page
        .getByRole("checkbox", { name: "장비·소품", exact: true })
        .check();
      await prepare(4);
      captured = (await snapshots())[4];
      assert.deepEqual(
        Object.fromEntries(
          [
            "rigEars",
            "rigTail",
            "rigHair",
            "rigClothing",
            "rigAccessories",
          ].map((key) => [
            key,
            compileCreation(captured.object, captured.taskId).settings[key],
          ]),
        ),
        {
          rigEars: true,
          rigTail: false,
          rigHair: true,
          rigClothing: false,
          rigAccessories: true,
        },
      );
      await cancel(4);
      await page.getByText("Tripo API 누적 승인 한도", { exact: true }).click();
      assert.match(
        await page
          .getByLabel("Tripo API 한도")
          .locator("..")
          .locator("..")
          .innerText(),
        /70 \/ 100 크레딧/,
      );
      await page.getByLabel("Tripo API 한도").fill("300");
      await page
        .getByRole("button", { name: "한도 저장", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Tripo 승인 한도를 저장" })
        .waitFor();
      assert.match(
        await page
          .getByLabel("Tripo API 한도")
          .locator("..")
          .locator("..")
          .innerText(),
        /70 \/ 300 크레딧/,
      );
      const actions = await page.evaluate(
        () =>
          (window as unknown as { graphicsActions: GraphicsAction[] })
            .graphicsActions,
      );
      assert(
        actions.some(
          (action) =>
            action.kind === "set-tripo-budget" && action.credits === 300,
        ),
      );
      assert(!actions.some((action) => action.kind === "approve"));
      for (const [index, action] of actions.entries())
        if (action.kind === "prepare") {
          assert.equal(
            actions[index - 1]?.kind,
            "update-object",
            "Every prepare must first save the visible settings through the typed action",
          );
        }
      const final = await page.evaluate(
        () => (window as any).graphicsWorkspace,
      );
      assert.equal(final.versions.length, 5);
      assert.equal(
        final.objects.find((object: any) => object.id === "target").accepted[
          "design:main"
        ],
        "accepted-design",
      );
      assert.equal(
        final.tasks.find((task: any) => task.id === "prior-paid").status,
        "submission_unknown",
      );
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
      assert(
        path
          .resolve(root)
          .startsWith(
            path.join(
              path.resolve(os.tmpdir()),
              "partsmith-graphics-settings-ui-",
            ),
          ),
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
