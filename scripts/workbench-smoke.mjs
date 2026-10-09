/** Real Electron UI/IPC/store with an explicitly mocked authoring executor. No generation or paid requests. */
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = process.cwd();
const fixture = path.resolve(
  "artifacts/runtime",
  `workbench-ui-${randomUUID()}`,
);
const harness = path.join(fixture, "harness");
const invocationPath = path.join(fixture, "calls.jsonl");
const draftReleasePath = path.join(fixture, "draft-reviewed.txt");
fs.mkdirSync(path.join(harness, "dist-electron"), { recursive: true });
fs.mkdirSync("artifacts/screenshots", { recursive: true });
const old = fs.readFileSync("scripts/production-smoke.mjs", "utf8");
const glbFunction = old
  .slice(
    old.indexOf("function tinyGlb()"),
    old.indexOf("fs.writeFileSync(modelPath"),
  )
  .replace("function tinyGlb()", "function baseGlb()");
const mockFile = path.join(fixture, "mock-executor.ts");
const mockChatGptFile = path.join(fixture, "mock-chatgpt-browser.ts");
fs.writeFileSync(
  mockChatGptFile,
  `export class ChatGptBrowser {
  ready = false;
  constructor() {} close() {}
  async status() { return {available:true, ready:this.ready, reason:this.ready?'MOCK ChatGPT login only':'MOCK login required', url:'https://chatgpt.com/'}; }
  async open() { this.ready=true; return this.status(); }
  workerConnection() { return {}; }
  stageReceipt() { return {charges:[],downloads:[]}; }
}`,
);
fs.writeFileSync(
  mockFile,
  `import fs from 'node:fs'; import path from 'node:path'; import {nativeImage} from 'electron';
${glbFunction}
function tinyGlb(){
  const original=baseGlb(),size=original.readUInt32LE(12),doc=JSON.parse(original.toString('utf8',20,20+size));
  const bin=original.subarray(28+size),uv=Buffer.from(new Float32Array([0,0,1,0,0,1]).buffer);
  const png=nativeImage.createFromBitmap(Buffer.from([90,120,180,255]),{width:1,height:1}).toPNG();
  const binary=Buffer.concat([bin,uv,png,Buffer.alloc((4-png.length%4)%4)]);
  const uvView=doc.bufferViews.length;doc.bufferViews.push({buffer:0,byteOffset:bin.length,byteLength:uv.length});
  const uvIndex=doc.accessors.length;doc.accessors.push({bufferView:uvView,componentType:5126,count:3,type:'VEC2'});
  const imageView=doc.bufferViews.length;doc.bufferViews.push({buffer:0,byteOffset:bin.length+uv.length,byteLength:png.length});
  doc.images=[{bufferView:imageView,mimeType:'image/png'}];doc.textures=[{source:0}];doc.materials=[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}];
  doc.meshes[0].primitives[0].attributes.TEXCOORD_0=uvIndex;doc.meshes[0].primitives[0].material=0;doc.buffers[0].byteLength=binary.length;
  const text=JSON.stringify(doc),json=Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text)/4)*4,' '));
  const out=Buffer.alloc(28+json.length+binary.length);out.write('glTF');out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(json.length,12);out.writeUInt32LE(0x4e4f534a,16);json.copy(out,20);out.writeUInt32LE(binary.length,20+json.length);out.writeUInt32LE(0x004e4942,24+json.length);binary.copy(out,28+json.length);return out;
}
export class CodexWorkbenchExecutor {
  constructor() {} shutdown() {}
  async probe(){return {codex:{available:true,authenticated:true},capabilities:{studio:true},message:'MOCK ONLY'};}
  async recover(ctx,onProgress){
    onProgress('MOCK: preserved files are being checked automatically');
    await new Promise(r=>setTimeout(r,1800));
    return this.execute({...ctx,recovered:true},onProgress);
  }
  async execute(ctx,onProgress){
    fs.appendFileSync(${JSON.stringify(invocationPath)},JSON.stringify(ctx.job.request)+'\\n');
    onProgress('UI TEST: synthetic fixtures, no real generation');
    await new Promise(r=>setTimeout(r,100));
    const step=ctx.job.step; let count=0;
    if(step==='separate'&&!ctx.recovered) return {status:'needs_input',summary:'MOCK transient download timeout',candidates:[],checks:[],recovery:{kind:'retry',reason:'MOCK transient download timeout'}};
    const write=(name,data,kind,role)=>{fs.writeFileSync(path.join(ctx.workspace,name),data);return {path:name,kind,...(role?{role}:{})};};
    const pic=(role)=>{count++;const bytes=Buffer.alloc(32*32*4); for(let i=0;i<bytes.length;i+=4){bytes[i]=count*17;bytes[i+1]=ctx.workbench.jobs.length*13;bytes[i+2]=count*11;const pixel=i/4,x=pixel%32,y=Math.floor(pixel/32);bytes[i+3]=(x>=4&&x<28&&y>=4&&y<28)?255:0;}return write('MOCK-'+count+'.png',nativeImage.createFromBitmap(bytes,{width:32,height:32}).toPNG(),'image',role);};
    const model=(i,role)=>{const bytes=tinyGlb();bytes.writeFloatLE(i+0.2,28+bytes.readUInt32LE(12));return write('MOCK-'+i+'.glb',bytes,'model',role);};
    const objects=[{id:'body',name:'MOCK Body',category:'body',separate:true},{id:'coat',name:'MOCK Coat',category:'clothing',separate:true},{id:'hair',name:'MOCK Hair',category:'hair',separate:true}];
    let candidates;
    if(step==='concept') candidates=[0,1,2,3].map(i=>({id:'candidate-'+i,label:'MOCK image '+(i+1),artifacts:[pic()]}));
    else if(step==='model') candidates=[{id:'candidate-0',label:'MOCK single model',artifacts:[model(0,ctx.job.request.role),pic()]}];
    else {
      let artifacts=[];
      if(step==='separate') {
        const req=ctx.job.request,base=ctx.workbench.jobs.find(j=>j.id===req.baseJobId);
        const previous=(base?.candidates[0]??base?.draftCandidates?.[0])?.artifacts.filter(a=>a.kind==='image')??[];
        const previousRoot=base?path.join(path.dirname(ctx.workspace),base.id):'';
        const changed=[];
        for(const role of ['head','hair','body']) for(const view of ['front','back','left','right']) {
          const old=previous.find(a=>a.role===role&&(a.view??'front')===view);
          const target=(!req.role||req.role===role)&&(!req.view||req.view===view);
          if(old&&(!target||req.reuseExisting)) {
            const source=path.join(previousRoot,path.basename(old.path));
            const name='MOCK-kept-'+role+'-'+view+'.png';
            artifacts.push({...write(name,fs.readFileSync(source),'image',role),view});
          } else if(target) {artifacts.push({...pic(role),view});changed.push(role+':'+view);}
        }
        fs.appendFileSync(path.join(ctx.workspace,'MOCK-generated.jsonl'),JSON.stringify(changed)+'\\n');
        ctx.onDraft?.({status:'completed',summary:'MOCK two photos ready',candidates:[{id:'draft',label:'MOCK saved photos',artifacts:artifacts.filter(a=>a.view==='front'&&a.role!=='body')}],checks:[{name:'original_alignment_and_scale_preserved',passed:false}]});
        const draftDeadline=Date.now()+20000;
        while(!fs.existsSync(${JSON.stringify(draftReleasePath)})&&Date.now()<draftDeadline) await new Promise(r=>setTimeout(r,50));
      }
      else if(step==='surface') artifacts=['head','hair','body'].map((r,i)=>model(i,r));
      else if(['assembly','rig','animation'].includes(step)) artifacts=[model(5),pic(),write('MOCK.blend',Buffer.from('BLENDER-MOCK-UI-ONLY'),'blend')];
      else if(step==='reference') {const frames=[0,1,2].map(time=>{const entries={time};for(const view of ['front','side','back']){const a=pic(view);artifacts.push(a);entries[view]=a.path;}return entries;});artifacts.push(write('frames.json',JSON.stringify({schemaVersion:1,motion:ctx.job.request.motion,duration:2,fps:12,camera:'fixed',frames}),'frames'));}
      else artifacts=[write('export.fbx',Buffer.from('MOCK EXPORT'),'export'),write('report.json','{}','report')];
      candidates=[{id:'version',label:'MOCK '+step,artifacts,objects}];
    }
    return {status:'completed',summary:'Explicit synthetic UI fixture: human review required.',candidates,checks:[{name:'MOCK fixture only',passed:true},...(step==='separate'?[{name:'original_position_and_scale_preserved',passed:false},{name:'clean_peripheral_alpha',passed:false}]:[])]};
  }
}`,
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
      name: "mock-workbench-only",
      setup(b) {
        b.onResolve({ filter: /workbench-executor$/ }, () => ({
          path: mockFile,
        }));
        b.onResolve({ filter: /chatgpt-browser$/ }, () => ({
          path: mockChatGptFile,
        }));
      },
    },
  ],
});
fs.copyFileSync(
  "dist-electron/preload.cjs",
  path.join(harness, "dist-electron/preload.cjs"),
);
fs.cpSync("dist", path.join(harness, "dist"), { recursive: true });
fs.mkdirSync(path.join(harness, "node_modules/sql.js/dist"), {
  recursive: true,
});
fs.copyFileSync(
  "node_modules/sql.js/dist/sql-wasm.wasm",
  path.join(harness, "node_modules/sql.js/dist/sql-wasm.wasm"),
);
fs.writeFileSync(
  path.join(harness, "package.json"),
  JSON.stringify({
    name: "partsmith-guided-test",
    version: "0.5.1",
    main: "dist-electron/main.cjs",
  }),
);
let app, page;
const errors = [];
const invocations = () =>
  fs.existsSync(invocationPath)
    ? fs
        .readFileSync(invocationPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
async function launch() {
  app = await electron.launch({
    executablePath: electronPath,
    args: [harness],
    env: {
      ...process.env,
      PARTSMITH_DATA: path.join(fixture, "data"),
      NODE_PATH: path.join(root, "node_modules"),
    },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".home");
}
const call = (c) => page.evaluate((c) => window.desktop.call(c), c);
const state = () => call({ type: "state" });
const approval = {
  accepted: true,
  studioCreditLimit: 1000,
  imageCreditLimit: 0,
};
async function assertImagesDecoded(testId, expected) {
  const images = page.getByTestId(testId).locator("img");
  assert.equal(await images.count(), expected, `${testId}: image count`);
  const diagnostics = await images.evaluateAll(async (elements) =>
    Promise.all(
      elements.map(async (element) => {
        try {
          await element.decode();
        } catch {}
        if (element.naturalWidth > 0 && element.naturalHeight > 0) return null;
        const response = await fetch(element.src);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
          src: element.src,
          complete: element.complete,
          width: element.naturalWidth,
          status: response.status,
          type: response.headers.get("content-type"),
          length: bytes.length,
          signature: Array.from(bytes.slice(0, 12)),
        };
      }),
    ),
  );
  assert.deepEqual(
    diagnostics.filter(Boolean),
    [],
    `${testId}: every image must decode`,
  );
}
async function jobDone() {
  for (let i = 0; i < 100; i++) {
    const w = (await state()).workbenches[0];
    const j = w?.jobs?.[0];
    if (j && j.status !== "running") {
      assert.equal(j.status, "review", j.summary);
      return j;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out waiting for mock action");
}
try {
  await launch();
  await page
    .getByRole("button", { name: "새 프로젝트", exact: true })
    .first()
    .click();
  await page
    .locator(".modal input[type=text],.modal input:not([type])")
    .first()
    .fill("단계별 제작 검증 · MOCK");
  await page
    .getByRole("button", { name: "프로젝트 만들기", exact: true })
    .click();
  await page.getByTestId("workbench").waitFor();
  const project = (await state()).projects[0];
  assert.equal(invocations().length, 0);
  assert.equal(
    await page.getByTestId("workbench-provider").inputValue(),
    "chatgpt-web",
  );
  await page
    .getByTestId("workbench-concept-prompt")
    .fill("MOCK disconnected request must not start");
  await page.getByTestId("workbench-approve").check();
  await page.getByTestId("workbench-execute-concept").click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").textContent(), /먼저 웹 로그인/);
  assert.equal(
    invocations().length,
    0,
    "Login preflight must not start a worker",
  );
  assert.equal(
    (await state()).workbenches.flatMap((workbench) => workbench.jobs).length,
    0,
    "Login preflight must not leave an unsent job stranded in recovery",
  );
  await page.getByTestId("workbench-chatgpt-open").click();
  await page.getByTestId("workbench-chatgpt-connection-status").waitFor();
  assert.match(
    await page.getByTestId("workbench-chatgpt-connection-status").textContent(),
    /MOCK ChatGPT login only/,
  );
  await page.getByTestId("workbench-chatgpt-status").click();
  assert.equal(
    invocations().length,
    0,
    "Connecting or checking login must never generate",
  );
  await page.getByTestId("workbench-provider").selectOption("codex");
  assert.match(
    await page.getByTestId("workbench-image-backend-help").textContent(),
    /다른 경로/,
  );
  await page.getByTestId("workbench-provider").selectOption("chatgpt-web");
  await page
    .getByTestId("workbench-concept-prompt")
    .fill("MOCK UI test. Four distinct options, no real request.");
  await page.getByTestId("workbench-approve").check();
  await page.getByTestId("workbench-execute-concept").click();
  await jobDone();
  await page.getByTestId("workbench-candidate-3").waitFor();
  assert.equal(invocations().length, 1);
  assert.equal(invocations()[0].imageBackend, "chatgpt-web");
  assert.deepEqual((await state()).workbenches[0].selections, {});
  await page.screenshot({
    path: "artifacts/screenshots/workbench-mock-candidates.png",
  });
  await page.getByTestId("workbench-select-1").click();
  const execute = async (request) => {
    await call({
      type: "workbench.action",
      id: project.id,
      action: { kind: "execute", request, approval },
    });
    return jobDone();
  };
  const accept = async (job) =>
    call({
      type: "workbench.action",
      id: project.id,
      action: { kind: "accept", jobId: job.id },
    });
  await page.getByTestId("workbench-step-parts").click();
  assert.equal(
    await page.getByTestId("workbench-group-separation-views").count(),
    0,
  );
  assert.match(
    await page.getByTestId("workbench-separation-batch-help").textContent(),
    /파츠마다 ChatGPT 웹 채팅에 정면·후면·좌·우 멀티뷰를 한 번 요청/,
  );
  assert.equal(
    await page.getByTestId("workbench-separation-backend").inputValue(),
    "chatgpt-web",
  );
  assert.match(
    await page.getByTestId("workbench-separation-batch-help").textContent(),
    /방향별 독립 이미지 4장/,
  );
  await page.getByTestId("workbench-approve").check();
  await page.getByTestId("workbench-execute-separate").click();
  await page.getByTestId("workbench-recovery").waitFor();
  assert.match(
    await page.getByTestId("workbench-recovery").textContent(),
    /자동 복구/,
  );
  await page.getByTestId("workbench-recovery").screenshot({
    path: "artifacts/screenshots/workbench-auto-recovery.png",
  });
  await page
    .getByTestId("workbench-separation-head-front")
    .locator("img")
    .waitFor();
  assert(await page.getByTestId("workbench-tab-model").isDisabled());
  assert.equal(await page.getByTestId("workbench-accept-separate").count(), 0);
  assert.equal(
    await page
      .getByTestId("workbench-separation-body-front")
      .locator("img")
      .count(),
    0,
  );
  await assertImagesDecoded("workbench-separation-views", 2);
  await page.getByTestId("workbench-separation-views").screenshot({
    path: "artifacts/screenshots/workbench-partial-photos.png",
  });
  fs.writeFileSync(
    draftReleasePath,
    "UI observed partial photos before completion",
  );
  await jobDone();
  assert(
    invocations()
      .filter((request) => request.step === "separate")
      .every((request) => request.separationStrategy === "part-multiview-v1"),
    "New separation and recovery must receive the same frozen grouped strategy",
  );
  assert(
    invocations()
      .filter((request) => request.step === "separate")
      .every((request) => request.imageBackend === "chatgpt-web"),
    "Separation and recovery preserve the selected ChatGPT backend",
  );
  await page.getByTestId("workbench-visual-warnings").waitFor();
  assert(await page.getByTestId("workbench-accept-separate").isEnabled());
  await assertImagesDecoded("workbench-separation-views", 12);
  await page.waitForFunction(() => {
    const labels = [
      ...document.querySelectorAll(
        '[data-testid="workbench-native-image-size"]',
      ),
    ];
    return (
      labels.length === 12 &&
      labels.every((n) => n.textContent.includes("원본 32 × 32"))
    );
  });
  assert.equal(
    await page.getByTestId("workbench-sheet-resolution-note").count(),
    0,
  );
  const alignedImages = await page
    .getByTestId("workbench-separation-views")
    .locator("img")
    .evaluateAll((nodes) =>
      nodes.map((n) => ({
        width: n.naturalWidth,
        height: n.naturalHeight,
        src: n.getAttribute("src"),
      })),
    );
  assert(
    alignedImages.every(
      (n) =>
        n.width === 2048 && n.height === 2048 && n.src.includes("/normalized/"),
    ),
    "All part previews must use the same normalized 2048 canvas",
  );
  const beforeAlignmentCalls = invocations().length;
  await page.getByTestId("workbench-normalize-images").click();
  assert.equal(
    invocations().length,
    beforeAlignmentCalls,
    "Local alignment must not invoke generation",
  );
  await page.getByTestId("workbench-visual-warnings").screenshot({
    path: "artifacts/screenshots/workbench-visual-warnings.png",
  });
  await page.getByTestId("workbench-accept-separate").click();
  assert.equal(
    invocations().length,
    3,
    "Selecting separation must not generate models",
  );
  for (const role of ["head", "hair", "body"]) {
    const j = await execute({
      step: "model",
      role,
      prompt: "MOCK",
      polygonCount: 6000,
    });
    assert.equal(j.candidates.length, 1);
    await call({
      type: "workbench.action",
      id: project.id,
      action: { kind: "accept", jobId: j.id },
    });
  }
  await page.getByTestId("workbench-tab-model").click();
  await page.getByTestId("workbench-model-role").selectOption("head");
  const firstModel = page.getByTestId("workbench-single-model");
  await firstModel.locator("img").waitFor();
  assert.equal(await firstModel.locator(".wb-model").count(), 0);
  const callsBeforePreview = invocations().length;
  await page.getByTestId("workbench-preview3d-single").click();
  await firstModel.locator(".wb-model canvas").waitFor();
  await page.getByTestId("workbench-preview3d-single").click();
  await firstModel.locator("img").waitFor();
  assert.equal(invocations().length, callsBeforePreview);
  await page.screenshot({
    path: "artifacts/screenshots/workbench-model-photo-first.png",
  });
  const beforeMeshEdit = (await state()).workbenches[0];
  const headModel = beforeMeshEdit.selections["model:head"];
  await page.getByTestId("workbench-model-edit-scope").selectOption("part");
  await page.getByTestId("workbench-credit-limit").fill("1000");
  await page.getByTestId("workbench-approve").check();
  assert(await page.getByTestId("workbench-execute-model").isDisabled());
  await page
    .getByTestId("workbench-model-edit-target")
    .fill("MOCK left ear region");
  await page
    .getByTestId("workbench-model-prompt")
    .fill("MOCK: refine the selected region only");
  await page.getByTestId("workbench-approve").check();
  await page.getByTestId("workbench-execute-model").click();
  const meshEdit = await jobDone();
  assert.equal(meshEdit.request.baseJobId, headModel.jobId);
  assert.equal(meshEdit.request.modelEditScope, "part");
  assert.equal(meshEdit.request.modelEditTarget, "MOCK left ear region");
  assert.match(meshEdit.request.prompt, /selected region/);
  assert.equal(meshEdit.candidates.length, 1);
  assert.deepEqual(
    (await state()).workbenches[0].selections["model:head"],
    headModel,
  );
  await page.getByTestId("workbench-accept-model").click();
  await page.screenshot({
    path: "artifacts/screenshots/workbench-mesh-edit.png",
  });
  const beforeReroll = (await state()).workbenches[0];
  const oldSeparation = beforeReroll.jobs.find(
    (j) => j.id === beforeReroll.selections.separate.jobId,
  );
  const oldImages = oldSeparation.candidates[0].artifacts.filter(
    (a) => a.kind === "image",
  );
  assert.equal(oldImages.length, 12);
  await page.getByTestId("workbench-tab-separate").click();
  await page.getByTestId("workbench-separation-backend").selectOption("codex");
  await page.getByTestId("workbench-edit-head-left").click();
  await page
    .getByTestId("workbench-separate-prompt")
    .fill("MOCK: shorten only the left head view; preserve every other photo.");
  await page.getByTestId("workbench-approve").check();
  await page.getByTestId("workbench-execute-separate").click();
  const rerolled = await jobDone();
  assert.equal(rerolled.request.role, "head");
  assert.equal(rerolled.request.view, "left");
  assert.equal(rerolled.request.baseJobId, oldSeparation.id);
  assert.equal(rerolled.request.reuseExisting, false);
  assert.equal(
    rerolled.request.imageBackend,
    "codex",
    "A new targeted reroll uses the explicitly selected route",
  );
  assert.equal(
    (await state()).workbenches[0].selections.separate.jobId,
    oldSeparation.id,
  );
  const newImages = rerolled.candidates[0].artifacts.filter(
    (a) => a.kind === "image",
  );
  for (const old of oldImages) {
    const next = newImages.find(
      (a) => a.role === old.role && a.view === old.view,
    );
    assert(next);
    if (old.role === "head" && old.view === "left")
      assert.notEqual(next.sha256, old.sha256);
    else assert.equal(next.sha256, old.sha256);
  }
  const generated = JSON.parse(
    fs
      .readFileSync(
        path.join(
          fixture,
          "data",
          "projects",
          project.id,
          "workbench",
          beforeReroll.id,
          "jobs",
          rerolled.id,
          "MOCK-generated.jsonl",
        ),
        "utf8",
      )
      .trim(),
  );
  assert.deepEqual(generated, ["head:left"]);
  await page.getByTestId("workbench-accept-separate").click();
  const afterReroll = (await state()).workbenches[0];
  assert.equal(afterReroll.selections["model:head"], undefined);
  assert.deepEqual(
    afterReroll.selections["model:hair"],
    beforeReroll.selections["model:hair"],
  );
  assert.deepEqual(
    afterReroll.selections["model:body"],
    beforeReroll.selections["model:body"],
  );
  await assertImagesDecoded("workbench-separation-views", 12);
  await page.getByTestId("workbench-separation-views").screenshot({
    path: "artifacts/screenshots/workbench-four-view-reroll.png",
  });
  await accept(
    await execute({
      step: "model",
      role: "head",
      prompt: "",
      polygonCount: 6000,
    }),
  );
  await accept(await execute({ step: "surface", prompt: "MOCK" }));
  const initial = await execute({ step: "assembly", prompt: "MOCK assemble" });
  await accept(initial);
  await page.getByTestId("workbench-step-assembly").click();
  await page
    .getByTestId("workbench-objects")
    .getByRole("checkbox")
    .last()
    .check();
  await page
    .getByTestId("workbench-assembly-prompt")
    .fill("MOCK: make selected hair shorter.");
  await page.getByTestId("workbench-execute-assembly").click();
  const edit = await jobDone();
  assert.equal(edit.request.baseJobId, initial.id);
  assert(edit.request.objectIds.length > 0);
  await page.getByTestId("workbench-accept-assembly").click();
  await page.screenshot({
    path: "artifacts/screenshots/workbench-mock-assembly.png",
  });
  await call({
    type: "workbench.action",
    id: project.id,
    action: { kind: "revert", jobId: initial.id },
  });
  assert.equal(
    (await state()).workbenches[0].selections.assembly.jobId,
    initial.id,
  );
  await page.getByTestId("workbench-step-rig").click();
  await page
    .getByTestId("workbench-rig-targets")
    .getByRole("switch")
    .nth(1)
    .check();
  await page.getByTestId("workbench-execute-rig").click();
  const rig = await jobDone();
  assert(rig.request.rigTargets.some((t) => t.extraBones));
  assert(rig.request.rigTargets.some((t) => !t.extraBones));
  await page.getByTestId("workbench-accept-rig").click();
  await page.screenshot({
    path: "artifacts/screenshots/workbench-mock-rig.png",
  });
  await assert.rejects(
    () => execute({ step: "animation", motion: "wave", prompt: "MOCK" }),
    /채택/,
  );
  const reference = await execute({
    step: "reference",
    motion: "wave",
    prompt: "MOCK",
    fps: 12,
    duration: 2,
  });
  const before = invocations().length;
  assert(!(await state()).workbenches[0].selections["reference:wave"]);
  await accept(reference);
  assert.equal(invocations().length, before);
  await page.getByTestId("workbench-step-motion").click();
  await page.getByTestId("workbench-motion-name").fill("wave");
  await page.getByTestId("workbench-sequence").waitFor();
  await page.getByLabel("참조 동작 시점").fill("1");
  await page.getByAltText("정면 1.00초 동작").waitFor();
  assert.equal(
    await page.getByTestId("workbench-sequence").locator("img").count(),
    3,
  );
  await page.screenshot({
    path: "artifacts/screenshots/workbench-mock-reference.png",
  });
  await accept(
    await execute({ step: "animation", motion: "wave", prompt: "MOCK author" }),
  );
  const count = invocations().length;
  await app.close();
  app = undefined;
  await launch();
  await page.locator(".project-card").first().click();
  await page.getByTestId("workbench").waitFor();
  assert.equal(invocations().length, count, "Restart must not call authoring");
  assert((await state()).workbenches[0].selections["animation:wave"]);
  await assert.rejects(
    () =>
      call({ type: "production.start", runId: "old", budgetAccepted: true }),
    /자동 제작 작업이 없습니다/,
  );
  assert.equal(
    invocations().length,
    count,
    "An unknown legacy run must not start authoring",
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    "artifacts/workbench-smoke.json",
    JSON.stringify(
      {
        passed: true,
        realElectron: true,
        mockExecutor: true,
        candidateSelection: true,
        manualStageGates: true,
        objectEdit: true,
        rigToggles: true,
        versionRevert: true,
        referenceGate: true,
        automaticRecoveryWithoutClick: true,
        partialPhotosBeforeCompletion: true,
        visualWarningsAllowUserReview: true,
        incompletePhotosBlockModelGeneration: true,
        modelPhotoFirstAndOptional3D: true,
        firstConceptOnlyFourCandidates: true,
        singleModelResult: true,
        existingModelPartialEditRequest: true,
        fourViewsPerPart: true,
        independentMultiviewDefaultWithoutSheetToggle: true,
        promptTargetsOnePartView: true,
        rerollPreservesElevenImages: true,
        partialAndAllTwelveImagesDecoded: true,
        longWindowsInheritedImagePathsDecoded: true,
        aligned2048PreviewsAndLocalOnlyAlignment: true,
        nativeResolutionDistinctFrom2048Preview: true,
        rerollKeepsOtherModelSelections: true,
        sameTimeMultiview: true,
        restartNoAutoRun: true,
        legacyAutoStartDisabled: true,
        workerCalls: count,
        paidRequests: 0,
        actualCharacterQualityVerified: false,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Guided Electron smoke passed; mocked outputs, zero remote requests.",
  );
} finally {
  if (app) await app.close();
}
