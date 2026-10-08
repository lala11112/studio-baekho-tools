/**
 * TEST ONLY: real Electron/IPC/SQLite/orchestrator; CodexWorker is replaced at
 * esbuild bundle time. No Tripo, Studio, video service, or Codex request is sent.
 * This never certifies generated character quality or a real production run.
 */
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = process.cwd();
const fixtureRoot = path.resolve(
  "artifacts/runtime",
  "production-ui-" + randomUUID(),
);
const harness = path.join(fixtureRoot, "harness");
const data = path.join(fixtureRoot, "data");
const controlPath = path.join(fixtureRoot, "control.json");
const invocationPath = path.join(fixtureRoot, "mock-invocations.jsonl");
const referencePath = path.join(fixtureRoot, "MOCK-reference.png");
const modelPath = path.join(fixtureRoot, "MOCK-triangle.glb");
const reportPath = path.resolve("artifacts/production-smoke.json");
fs.mkdirSync(path.join(harness, "dist-electron"), { recursive: true });
fs.mkdirSync("artifacts/screenshots", { recursive: true });

function tinyGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  // A real, tiny skinned triangle with a translation clip. It is explicitly a
  // format fixture; it is never presented as a generated character or rig.
  const binary = Buffer.alloc(212);
  Buffer.from(positions.buffer).copy(binary);
  Buffer.from(indices.buffer).copy(binary, 36);
  Buffer.from(new Uint16Array(12).buffer).copy(binary, 44);
  Buffer.from(
    new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]).buffer,
  ).copy(binary, 68);
  Buffer.from(
    new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).buffer,
  ).copy(binary, 116);
  Buffer.from(new Float32Array([0, 1]).buffer).copy(binary, 180);
  Buffer.from(new Float32Array([0, 0, 0, 0, 0.25, 0]).buffer).copy(binary, 188);
  const json = Buffer.from(
    JSON.stringify({
      asset: {
        version: "2.0",
        generator: "Partsmith production-smoke MOCK FIXTURE",
      },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0, skin: 0 }, { name: "MOCK-Joint" }],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 },
              indices: 1,
            },
          ],
        },
      ],
      skins: [{ joints: [1], skeleton: 1, inverseBindMatrices: 4 }],
      animations: [
        {
          name: "MOCK-translation",
          channels: [{ sampler: 0, target: { node: 1, path: "translation" } }],
          samplers: [{ input: 5, output: 6, interpolation: "LINEAR" }],
        },
      ],
      buffers: [{ byteLength: binary.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
        { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
        { buffer: 0, byteOffset: 44, byteLength: 24, target: 34962 },
        { buffer: 0, byteOffset: 68, byteLength: 48, target: 34962 },
        { buffer: 0, byteOffset: 116, byteLength: 64 },
        { buffer: 0, byteOffset: 180, byteLength: 8 },
        { buffer: 0, byteOffset: 188, byteLength: 24 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
        { bufferView: 2, componentType: 5123, count: 3, type: "VEC4" },
        { bufferView: 3, componentType: 5126, count: 3, type: "VEC4" },
        { bufferView: 4, componentType: 5126, count: 1, type: "MAT4" },
        {
          bufferView: 5,
          componentType: 5126,
          count: 2,
          type: "SCALAR",
          min: [0],
          max: [1],
        },
        { bufferView: 6, componentType: 5126, count: 2, type: "VEC3" },
      ],
    }),
  );
  const padding = (4 - (json.length % 4)) % 4;
  const padded = Buffer.concat([json, Buffer.alloc(padding, 0x20)]);
  const glb = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length);
  glb.write("glTF", 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(glb, 20);
  glb.writeUInt32LE(binary.length, 20 + padded.length);
  glb.writeUInt32LE(0x004e4942, 24 + padded.length);
  binary.copy(glb, 28 + padded.length);
  return glb;
}
fs.writeFileSync(modelPath, tinyGlb());
const setMode = (mode) =>
  fs.writeFileSync(controlPath, JSON.stringify({ mode }));
setMode("hold");

const mockSource = [
  'import fs from "node:fs"; import path from "node:path"; import {createHash} from "node:crypto";',
  "export class CodexWorker {",
  "constructor(options) { this.receipts=new Map(); }",
  'stageReceipt(runId,stageId,attempt){return this.receipts.get([runId,stageId,attempt].join("/"))??{charges:[],downloads:[]};}',
  'async probe(){return {codex:{available:true,authenticated:true,version:"MOCK TEST WORKER",message:"UI test fixture only"},capabilities:{studio:true,video:true,motion:true},message:"MOCK TEST: no external requests"};}',
  "async run(task){",
  "const {run,stage,signal}=task;",
  'const dependenciesSatisfied=stage.dependsOn.every(id=>run.stages.find(item=>item.id===id)?.status==="completed");if(!dependenciesSatisfied)throw new Error("TEST: unresolved dependency executed");',
  'fs.appendFileSync(process.env.PARTSMITH_SMOKE_INVOCATIONS,JSON.stringify({stageId:stage.id,kind:stage.kind,attempt:stage.attempt,mocked:true,dependenciesSatisfied})+"\\n");',
  'task.onEvent({type:"thread.started",threadId:"MOCK-UI-TEST-"+stage.id});',
  'const mode=JSON.parse(fs.readFileSync(process.env.PARTSMITH_SMOKE_CONTROL,"utf8")).mode;',
  'if(mode==="hold"){await new Promise((resolve,reject)=>{if(signal.aborted)return reject(new Error("MOCK worker stopped"));signal.addEventListener("abort",()=>reject(new Error("MOCK worker stopped; remote cancel not asserted")),{once:true});});}',
  'const folder="stages/"+stage.id+"/attempt-"+stage.attempt;fs.mkdirSync(path.join(run.workspace,folder),{recursive:true});',
  'const artifacts=[];const add=(name,kind,role,source)=>{const relative=folder+"/"+name;fs.copyFileSync(source,path.join(run.workspace,relative));artifacts.push({path:relative,kind,...(role?{role}:{})});};',
  'const report=folder+"/MOCK-report.json";fs.writeFileSync(path.join(run.workspace,report),JSON.stringify({mocked:true,realGenerationVerified:false,stageId:stage.id}));',
  'artifacts.push({path:report,kind:"report",role:"review"});',
  'if(stage.kind==="separate"){for(const role of ["body","head","hair"])add(role+".png","image",role,process.env.PARTSMITH_SMOKE_IMAGE);}',
  'else if(stage.kind==="animation-reference"){add("MOCK-single-still.png","image",stage.role||"front",process.env.PARTSMITH_SMOKE_IMAGE);}',
  'else {add("MOCK-model.glb","model",stage.role||"final",process.env.PARTSMITH_SMOKE_MODEL);add("MOCK-preview.png","image","preview",process.env.PARTSMITH_SMOKE_IMAGE);}',
  'this.receipts.set([run.id,stage.id,stage.attempt].join("/"),{charges:stage.charged?[{state:"observed",cost:1}]:[],downloads:artifacts.filter(a=>a.kind==="model").map(a=>{const bytes=fs.readFileSync(path.join(run.workspace,a.path));return {state:"completed",file:a.path,sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};})});',
  'return {threadId:"MOCK-UI-TEST-"+stage.id,result:{status:"completed",summary:stage.kind==="animation-reference"?"MOCK TEST: a single still is deliberately missing the required animation sequence and manifest":"MOCK TEST fixture, not real generated production",artifacts,checks:stage.requiredChecks.map(name=>({name,passed:true}))}};',
  "} shutdown(){} }",
].join("\n");

const packageInfo = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.writeFileSync(
  path.join(harness, "package.json"),
  JSON.stringify({
    name: "partsmith-production-smoke",
    version: packageInfo.version,
    main: "dist-electron/main.cjs",
  }),
);
await build({
  entryPoints: ["electron/main.ts"],
  outfile: path.join(harness, "dist-electron/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "sql.js"],
  plugins: [
    {
      name: "production-smoke-worker-only",
      setup(plugin) {
        plugin.onResolve({ filter: /codex-worker$/ }, () => ({
          path: "mock-worker",
          namespace: "production-smoke",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "production-smoke" }, () => ({
          contents: mockSource,
          loader: "js",
        }));
      },
    },
  ],
});
await build({
  entryPoints: ["electron/preload.ts"],
  outfile: path.join(harness, "dist-electron/preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
assert(
  fs.existsSync("dist/index.html"),
  "Run npm run build before production smoke",
);
fs.cpSync("dist", path.join(harness, "dist"), { recursive: true });
fs.mkdirSync(path.join(harness, "node_modules/sql.js/dist"), {
  recursive: true,
});
fs.copyFileSync(
  "node_modules/sql.js/dist/sql-wasm.wasm",
  path.join(harness, "node_modules/sql.js/dist/sql-wasm.wasm"),
);

let app;
let page;
const errors = [];
const launch = async () => {
  app = await electron.launch({
    executablePath: electronPath,
    args: [harness],
    env: {
      ...process.env,
      PARTSMITH_DATA: data,
      PARTSMITH_SMOKE_CONTROL: controlPath,
      PARTSMITH_SMOKE_INVOCATIONS: invocationPath,
      PARTSMITH_SMOKE_IMAGE: referencePath,
      PARTSMITH_SMOKE_MODEL: modelPath,
    },
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.waitForSelector(".home");
};
const call = (command) =>
  page.evaluate((command) => window.desktop.call(command), command);
const readRun = async (id) =>
  (await call({ type: "state" })).productionRuns.find((run) => run.id === id);
const waitRun = async (id, predicate, timeout = 20000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const run = await readRun(id);
    if (predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Timed out waiting for production run: " +
      JSON.stringify(await readRun(id)),
  );
};
const invocations = () =>
  fs.existsSync(invocationPath)
    ? fs
        .readFileSync(invocationPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

let evidence = {
  passed: false,
  workerMocked: true,
  realGenerationVerified: false,
  paidRequestsSent: false,
};
try {
  await launch();
  assert.equal((await call({ type: "state" })).key.configured, false);
  const isolation = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
  }));
  assert.deepEqual(isolation, { require: "undefined", process: "undefined" });
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    context.fillStyle = "#202b29";
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = "#b8ebd1";
    context.font = "bold 22px sans-serif";
    context.fillText("MOCK UI TEST", 35, 130);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  fs.writeFileSync(referencePath, Buffer.from(png, "base64"));
  const project = await call({
    type: "project.create",
    name: "MOCK TEST · 자동 제작 검증",
    demo: false,
  });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, referencePath);
  const source = await call({
    type: "asset.import",
    id: project.id,
    kind: "image",
  });
  await call({ type: "image.select", id: project.id, assetId: source.id });
  await page.locator(".project-card").first().click();
  await page.getByTestId("production-desk").waitFor();

  await page.getByLabel(/정면 캐릭터 이미지/).selectOption(source.id);
  await page
    .getByLabel(/원하는 모습과 검수 기준/)
    .fill(
      "MOCK UI TEST. No real generation. Validate durable automatic stage flow.",
    );
  await page.getByLabel(/만들 동작 \(한 줄에 하나\)/).fill("Idle\nWalk");
  await page.locator(".production-options summary").click();
  await page.getByTestId("production-studio-limit").fill("100");
  await page.getByTestId("production-create").click();
  await page.getByTestId("production-start").waitFor();
  const run = (await call({ type: "state" })).productionRuns.find(
    (current) => current.projectId === project.id,
  );
  assert(run);
  console.log("Production plan created via UI; worker is explicitly mocked.");
  assert.equal(run.status, "ready");
  assert.equal(
    invocations().length,
    0,
    "Preparing a plan must not run a worker",
  );
  await assert.rejects(
    () =>
      call({ type: "production.start", runId: run.id, budgetAccepted: false }),
    /승인|동의|예산|상한|범위/,
  );
  assert.equal(
    invocations().length,
    0,
    "Unapproved start must not run a worker",
  );
  await page.getByTestId("production-start").waitFor();
  // Deliberately selecting only this flow's budget consent.
  await page.getByTestId("production-desk").getByRole("checkbox").check();
  await page.getByTestId("production-start").click();
  await waitRun(
    run.id,
    (current) => current.status === "running" && !!current.activeStageId,
  );
  await page.waitForTimeout(100);
  await page.getByTestId("production-pause").click();
  const paused = await waitRun(
    run.id,
    (current) => current.status === "paused",
  );
  assert.notEqual(paused.status, "completed");
  console.log("Mocked production paused; checking restart recovery.");
  const pausedStage =
    paused.stages.find((stage) => stage.id === paused.activeStageId) ??
    paused.stages.find((stage) => stage.attempt > 0);
  assert(pausedStage);
  assert.equal(invocations().length, 1);
  await page.screenshot({
    path: "artifacts/screenshots/production-mock-paused.png",
  });
  await app.close();
  app = undefined;
  setMode("advance");
  await launch();
  const restored = await readRun(run.id);
  assert.equal(restored.id, run.id);
  assert.equal(
    invocations().length,
    1,
    "App restart must not silently resume worker execution",
  );
  await page.locator(".project-card").first().click();
  await page.getByTestId("production-desk").waitFor();
  await page.getByTestId("production-resume").click();
  assert.equal(
    await page.getByLabel(/원하는 모습과 검수 기준/).inputValue(),
    run.config.brief,
  );
  assert.equal(
    await page.getByLabel(/만들 동작 \(한 줄에 하나\)/).inputValue(),
    run.config.motions.join("\n"),
  );
  const stopped = await waitRun(
    run.id,
    (current) =>
      current.status === "needs_input" || current.status === "failed",
    30000,
  );
  assert.notEqual(stopped.status, "completed");
  console.log("Mocked worker stopped at mandatory evidence validation.");
  const reference = stopped.stages.find(
    (stage) => stage.kind === "animation-reference" && stage.attempt > 0,
  );
  assert(
    reference,
    "The orchestrator must automatically advance to animation reference production without manual per-stage clicks",
  );
  assert.notEqual(
    reference.status,
    "completed",
    "A true checklist and a single still must not certify a multiview animation sequence",
  );
  assert(
    stopped.stages.filter((stage) => stage.status === "completed").length > 2,
  );
  const calls = invocations();
  assert(calls.length > 3);
  assert(
    calls.every((item) => item.dependenciesSatisfied),
    "Every dispatched stage must have completed dependencies",
  );
  assert(
    !calls.some((item) => ["motion-transfer", "unity"].includes(item.kind)),
    "A missing animation sequence must block Astra motion transfer and Unity completion",
  );
  assert(!fs.existsSync(path.join(data, "tripo.key")));
  await page.waitForFunction(() =>
    /입력|확인 필요/.test(
      document.querySelector('[data-testid="production-status"]')
        ?.textContent ?? "",
    ),
  );
  assert.equal(
    await page.locator(".production-checks svg").count(),
    reference.requiredChecks.length,
    "The blocked stage must still show every required quality check",
  );
  assert.equal(
    await page
      .locator(".production-checks svg")
      .evaluateAll((elements) =>
        elements.every((element) =>
          element.classList.contains("lucide-circle"),
        ),
      ),
    true,
    "Unverified worker claims must not render as passed quality checks",
  );
  assert.doesNotMatch(
    await page.locator(".production-checks").innerText(),
    /actual_sequence_frames|timestamp_manifest/,
  );
  await page.screenshot({
    path: "artifacts/screenshots/production-mock-missing-sequence.png",
  });
  await page
    .getByTestId("production-stages")
    .getByRole("button")
    .first()
    .click();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll(".production-artifact img")];
    return (
      images.length >= 3 &&
      images.every((image) => image.complete && image.naturalWidth > 0)
    );
  });
  const generated = stopped.stages.find((stage) => stage.kind === "generate");
  const modelArtifact = generated.artifacts.find(
    (artifact) => artifact.kind === "model",
  );
  const modelResponse = await page.evaluate(
    async ({ projectId, runId, artifactPath }) => {
      const response = await fetch(
        window.desktop.assetUrl(
          projectId,
          "production/" + runId + "/" + artifactPath,
        ),
      );
      return {
        status: response.status,
        bytes: (await response.arrayBuffer()).byteLength,
      };
    },
    { projectId: project.id, runId: run.id, artifactPath: modelArtifact.path },
  );
  assert.equal(modelResponse.status, 200);
  assert.equal(modelResponse.bytes, modelArtifact.bytes);
  assert.deepEqual(errors, []);
  evidence = {
    ...evidence,
    passed: true,
    scope:
      "Actual Electron UI/IPC/SQLite/orchestrator with TEST-ONLY mocked CodexWorker and mocked Studio receipts",
    isolatedStore: true,
    rendererIsolated: true,
    planDoesNotExecute: true,
    approvalEnforced: true,
    pausePersists: true,
    restartDoesNotAutoResubmit: true,
    restoredConfigVisible: true,
    automaticStageProgression: true,
    missingAnimationSequenceBlocksCompletion: true,
    unverifiedChecksRemainUnmarked: true,
    recordedArtifactsServed: true,
    completedMockStages: stopped.stages
      .filter((stage) => stage.status === "completed")
      .map((stage) => stage.kind),
    observedWorkerKinds: calls.map((item) => item.kind),
    finalStatus: stopped.status,
    errors,
  };
  console.log(
    "Production UI smoke passed. Worker MOCKED; no real generation or paid requests.",
  );
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  if (page && !page.isClosed())
    await page
      .screenshot({ path: "artifacts/screenshots/production-mock-failure.png" })
      .catch(() => {});
  throw error;
} finally {
  fs.writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
  if (app) await app.close();
}
