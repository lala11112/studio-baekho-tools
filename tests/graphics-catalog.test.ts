import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import type {
  AssetVersion,
  GraphicsAction,
  GraphicsTask,
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

test("graphics catalog contains exactly the 116 reviewed tasks with unchanged meanings", () => {
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
  assert.equal(graphicsCatalog.length, 116);
  assert.equal(new Set(graphicsCatalog.map((task) => task.id)).size, 116);
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
  assert.equal(findGraphicsTask("I07")?.status, "planned");
});

test("catalog distinguishes connected unverified paths from local and unavailable paths", () => {
  const ready = graphicsCatalog
    .filter((task) => task.status === "ready")
    .map((task) => task.id);
  assert.deepEqual(ready, ["A01", "A02", "A03", "A05", "X04", "X05"]);
  const connected = graphicsCatalog
    .filter((task) => task.status === "unverified")
    .map((task) => task.id);
  assert.deepEqual(connected, [
    "I01",
    "I02",
    "I03",
    "M01",
    "M02",
    "M03",
    "M10",
    "T01",
    "T03",
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
  { timeout: 90000 },
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
      `process.on('uncaughtException',error=>{console.error(error.stack);process.exit(1)});const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});w.loadFile(${JSON.stringify(path.join(root, "index.html"))});});`,
    );
    const app = await electron.launch({
      executablePath: electronBinary as unknown as string,
      args: [path.join(root, "main.cjs")],
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByTestId("graphics-studio").waitFor();
      await page.getByTestId("graphics-object-sword").click();
      assert.equal(await page.locator("[data-task-id]").count(), 116);
      await page.getByRole("tab", { name: "추천", exact: true }).click();
      assert.equal(await page.locator('[data-task-id="M01"]').count(), 0);
      assert.equal(await page.locator('[data-task-id="X05"]').count(), 1);
      await page.getByRole("tab", { name: "전체", exact: true }).click();
      await page.getByRole("textbox", { name: "작업 검색" }).fill("I07");
      await page.locator('[data-task-id="I07"] button').click();
      assert.equal(
        await page.getByTestId("graphics-prepare").isDisabled(),
        true,
      );
      await page.getByRole("textbox", { name: "작업 검색" }).fill("I03");
      assert.match(
        await page.getByTestId("graphics-task-list").innerText(),
        /기존 이미지 수정/,
      );
      await page.getByRole("textbox", { name: "작업 검색" }).fill("M01");
      await page.locator('[data-task-id="M01"] button').click();
      await page
        .getByRole("checkbox", { name: "M01 단일 이미지 모델링 작업 선택" })
        .check();
      await page
        .getByLabel("원하는 결과와 유지할 특징")
        .fill("Keep the original geometry and markings");
      await page.getByLabel("출력 배율", { exact: true }).fill("2");
      await page.getByLabel("피벗", { exact: true }).selectOption("bottom");
      await page.getByLabel("출력 형식", { exact: true }).selectOption("fbx");
      await page
        .getByRole("button", { name: "설정 저장", exact: true })
        .click();
      await page.getByRole("status").waitFor();
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
      await page.getByTestId("graphics-prepare").click();
      await page.getByRole("alert").waitFor();
      assert.match(
        await page.getByRole("alert").innerText(),
        /기존 원본과 채택 결과는 유지/,
      );
      assert.equal(await page.getByTestId("graphics-version-old").count(), 1);
      await page.getByRole("textbox", { name: "작업 검색" }).fill("X04");
      await page.locator('[data-task-id="X04"] button').click();
      await page.getByTestId("graphics-prepare").click();
      await page.getByTestId("graphics-cost-quote").waitFor();
      await page
        .getByLabel("원하는 결과와 유지할 특징")
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
      await page.locator(".gs-history summary").click();
      await page
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
      assert.equal(sword.settings.scale, 2);
      assert.equal(sword.settings.pivot, "bottom");
      assert.equal(sword.settings.exportFormat, "fbx");
      assert.equal(sword.settings.textureSize, 4096);
      assert.equal(sword.accepted["model:main"], "new");
      assert.equal(result.workspace.versions.length, 3);
      assert.equal(sword.references.length, 1);
      await page.getByLabel("이름", { exact: true }).fill("Shield");
      await page.getByLabel("종류", { exact: true }).selectOption("weapon");
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
