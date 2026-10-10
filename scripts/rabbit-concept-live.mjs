// Live user-approved concept handoff. No fixtures, browser mocks or automatic image submission.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const name = "흰 토끼 · 실제 제작 검증";
const prompt = `게임용 3D 캐릭터 제작을 위한 서로 다른 토끼 디자인 원본 이미지 정확히 2장을 생성해 주세요. 한 요청 안에서 각각 별도의 독립 이미지 파일로 만들어 주세요. 한 장 안에 두 토끼를 넣거나 시트/콜라주로 만들지 마세요.
공통 조건: 스타일화된 흰색 네 발 동물 토끼. 자연스러운 네 발 체형, 둥근 몸통, 긴 귀와 부드러운 분홍색 귀 안쪽, 작은 분홍 코, 짧고 둥근 꼬리, 검은 눈. 옷·장식·소품 없음. 털은 게임용으로 깔끔한 표면과 은은한 질감으로 표현하고 낱개 털이나 실사 털 시뮬레이션은 피하세요. 네 발을 바닥에 둔 편안한 중립 자세이며 사람처럼 서 있으면 안 됩니다. 머리부터 귀 끝·꼬리·발까지 전신이 잘리지 않게, 밝은 단색 배경과 고른 조명, 같은 크기의 캔버스와 같은 확대 비율, 토끼 한 마리가 화면 중앙에 배치된 정면에 가까운 3/4 시점으로 보여 주세요. 텍스트와 워터마크 없음. 고품질 원본으로 생성하세요.
후보 1: 작고 둥근 얼굴과 통통한 몸, 곧게 선 긴 귀로 귀여운 인상.
후보 2: 조금 더 날렵한 얼굴과 탄력 있는 뒷다리, 귀 끝이 살짝 벌어진 생동감 있는 인상.
각 결과 옆의 설명으로 후보 1과 후보 2를 구분하되 이미지 안에는 번호를 쓰지 마세요. 실제 이미지 두 장을 생성하고, 하나의 이미지를 복제하거나 자르지 마세요.`;
const app = await electron.launch({ executablePath: path.resolve(process.env.PARTSMITH_EXECUTABLE ?? "release/0.6.14/win-unpacked/Partsmith.exe") });
const page = await app.firstWindow();
await page.waitForSelector(".home");
const call = c => page.evaluate(c => window.desktop.call(c), c);
let state = await call({type:"state"});
let project = state.projects.find(p => p.name === name);
if (!project) {
  await page.getByRole("button",{name:"새 프로젝트",exact:true}).first().click();
  await page.locator(".modal input[type=text],.modal input:not([type])").first().fill(name);
  await page.getByRole("button",{name:"프로젝트 만들기",exact:true}).click();
} else {
  await page.locator(`[data-testid="project-card"][data-project-id="${project.id}"]`).getByTestId("project-open").click();
}
await page.getByTestId("workbench").waitFor();
state = await call({type:"state"});
project = state.projects.find(p=>p.name===name);
let workbench = state.workbenches.find(w=>w.projectId===project.id);
if (!workbench?.jobs.length) {
  await page.getByTestId("workbench-external-concept").check();
  await page.getByTestId("workbench-concept-count").fill("2");
  await page.getByTestId("workbench-concept-prompt").fill(prompt);
  await page.getByTestId("workbench-approve").check();
  await page.getByTestId("workbench-execute-concept").click();
  await page.getByTestId("workbench-external-receive").waitFor();
}
const snapshot = async () => {
  state = await call({type:"state"});
  workbench = state.workbenches.find(w=>w.projectId===project.id);
  const job=workbench.jobs.find(j=>j.externalExecution);
  const info={projectId:project.id,workbenchId:workbench.id,jobId:job.id,
    workspace:path.join(state.dataDir,"projects",project.id,"workbench",workbench.id,"jobs",job.id),
    status:job.status,external:job.externalExecution,candidates:job.candidates,selection:workbench.selections.concept,
    wholeReference:workbench.selections['whole-reference']};
  fs.mkdirSync("artifacts/runtime",{recursive:true});
  fs.writeFileSync("artifacts/runtime/rabbit-session.json",JSON.stringify(info,null,2));
  console.log(JSON.stringify({jobId:job.id,status:job.status,external:job.externalExecution?.state,candidates:job.candidates.length,selection:info.selection,wholeReference:info.wholeReference}));
  return info;
};
await snapshot();
console.log("READY: JSON commands control the Partsmith app. Explicit run/reply starts its Chrome worker.");
for await (const line of readline.createInterface({input:process.stdin})) {
  try {
    const command=JSON.parse(line), info=await snapshot();
    if(command.action==="reserve") await call({type:"workbench.action",id:project.id,
      action:{kind:"external-reserve",jobId:info.jobId,requestHash:info.external.requestHash}});
    else if(command.action==="receive") await page.getByTestId("workbench-external-receive").click();
    else if(command.action==="show-surface") {
      await page.getByTestId("workbench-step-surface").click();
      await page.locator(".wb-model").first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
      await page.screenshot({path:"artifacts/runtime/rabbit-surface-live.png"});
    }
    else if(command.action==='start-rabbit-refine') {
      const surface=workbench.jobs.find(j=>j.id==='18e8e770-ad5c-4f7e-9cfc-ad310bbdf3d1');
      if(project.id!=='26122336-8a7c-48b5-b15f-fa193ca157fd' || workbench.activeJobId ||
         surface?.status!=='review' || !surface.candidates.some(c=>c.id==='surface-1') ||
         workbench.jobs.some(j=>j.step==='assembly')) throw Error('Exact idle rabbit surface required; never duplicate refinement');
      await page.getByTestId('workbench-step-surface').click();
      if(!workbench.selections.surface) await page.getByTestId('workbench-accept-surface').click();
      await page.getByTestId('workbench-step-assembly').click();
      await page.getByTestId('workbench-assembly-prompt').fill('채택한 토끼의 수염과 볼만 Blender + Astra로 보정해 주세요. 수염의 점선처럼 깨지고 거친 경계, 볼의 접히거나 찌그러져 보이는 표면을 실제 모델과 참조에서 검사하고 국소 수정하세요. 전체 둥근 체형·얼굴 인상·눈·코·귀·발·꼬리·비율을 유지하세요. 정면/후면/좌/우 원본 모두를 확인하되 원본의 스타일을 보존하세요. 입력 중 textured 폴더의 실제 텍스처 FBX와 원본 4096×4096 basecolor JPEG가 기준이며 uv.fbx는 이전 체크포인트입니다. 4K 해상도와 UV를 보존하고 필요한 얼굴 국소 수정 외에는 텍스처를 변경하지 마세요. 수정 전후 동일 카메라/조명의 얼굴 및 수염 확대 비교, 전신 정면·측면·후면 렌더를 저장하고 직접 비교·검사하세요. 편집 가능한 packed .blend, FBX+동반 텍스처, GLB 미리보기와 실제 변경/검사 보고서를 새 버전으로 저장하세요. 원본은 수정하지 마세요. 리깅/애니메이션/다음 단계/Tripo 작업은 하지 마세요. 문제가 남으면 숨기지 말고 보고하세요.');
      await page.getByTestId('workbench-execute-assembly').click();
      await page.waitForTimeout(700);
      const after=await call({type:'state'});
      const w=after.workbenches.find(w=>w.projectId===project.id);
      const job=w.jobs.find(j=>j.step==='assembly');
      if(!job || w.selections.surface?.jobId!==surface.id) throw Error('App did not dispatch refinement');
      fs.writeFileSync('artifacts/runtime/rabbit-refinement-dispatch.json',JSON.stringify({appVersion:'0.6.14',trigger:'workbench-execute-assembly',surfaceSelection:w.selections.surface,job},null,2));
      console.log(JSON.stringify({assemblyJobId:job.id,status:job.status,dependencies:job.dependencies}));
    }
    else if(command.action==='show-assembly') {
      await page.getByTestId('workbench-step-assembly').click();
      await page.screenshot({path:'artifacts/runtime/rabbit-assembly-live.png'});
      const after=await call({type:'state'}), w=after.workbenches.find(w=>w.projectId===project.id);
      console.log(JSON.stringify({selection:w.selections.assembly,jobs:w.jobs.filter(j=>j.step==='assembly').map(j=>({id:j.id,status:j.status,summary:j.summary,candidates:j.candidates,checks:j.checks}))}));
    }
    else if(command.action==='recheck-existing-assembly') {
      const job=workbench.jobs.find(j=>j.step==='assembly');
      if(workbench.activeJobId || job?.id!==command.jobId || !['needs_input','failed','cancelled'].includes(job.status))
        throw Error('Exact stopped existing assembly job required');
      await page.getByTestId('workbench-step-assembly').click();
      await page.getByTestId('workbench-retry').click();
    }
    else if(command.action==='refine-reviewed-rabbit' || command.action==='correct-stopped-rabbit') {
      const base=workbench.jobs.find(j=>j.step==='assembly');
      const stopped=command.action==='correct-stopped-rabbit';
      if(workbench.activeJobId || base?.id!==command.baseJobId ||
         (stopped ? base.status!=='needs_input' : base.status!=='review' || base.candidates.length!==1) ||
         typeof command.prompt!=='string' || !command.prompt.trim())
        throw Error('Exact stopped/reviewed rabbit revision and scoped correction required');
      await page.getByTestId('workbench-step-assembly').click();
      await page.getByTestId('workbench-assembly-prompt').fill(command.prompt);
      await page.getByTestId('workbench-execute-assembly').click();
      await page.waitForTimeout(700);
      const after=await call({type:'state'}), w=after.workbenches.find(w=>w.projectId===project.id), job=w.jobs.find(j=>j.step==='assembly');
      if(job?.id===base.id || (!stopped && job?.request.baseJobId!==base.id)) throw Error('App did not start a versioned revision');
      console.log(JSON.stringify({assemblyJobId:job.id,baseJobId:job.request.baseJobId,status:job.status}));
    }
    else if(command.action==='run-surface') {
      const current=workbench.jobs.find(j=>j.id===info.jobId);
      if(current.step!=='surface' || command.jobId!==info.jobId || command.costApproved!==true ||
        current.request.externalSurface?.textureResolution!=='4K' || current.approval.studioCreditLimit!==40)
        throw Error('Exact approved surface job required');
      await page.getByTestId('workbench-step-surface').click();
      await page.getByTestId('workbench-codex-run').click();
    }
    else if(command.action==='approve-tripo') {
      const current=workbench.jobs.find(j=>j.id===command.jobId);
      const approval=current?.externalExecution?.worker?.approval;
      if(current?.status!=='running' || !approval || command.approvalId!==approval.id ||
         approval.title!=='cua_repl 접근 확인' || approval.detail!=='Allow Browser use to access https://studio.tripo3d.ai/' ||
         approval.fields.length!==0 || current.approval.studioCreditLimit!==40)
        throw Error('Only the explicitly user-authorized Tripo site request for this rabbit is supported');
      await page.getByTestId('workbench-step-surface').click();
      await page.getByTestId('workbench-codex-approve').click();
    }
    else if(command.action==='reply') {
      if(command.jobId!==info.jobId || typeof command.text!=='string') throw Error('Exact job and reply required');
      await page.getByTestId('workbench-step-surface').click();
      await page.getByTestId('workbench-codex-reply').fill(command.text);
      await page.getByTestId('workbench-codex-run').click();
    }
    else if(command.action==="select-rounded") await page.getByTestId("workbench-select-0").click();
    else if(command.action==="select-version") {
      const selectedJob=workbench.jobs.find(j=>j.id===command.jobId && j.status==='review');
      if(!selectedJob?.candidates.some(c=>c.id===command.candidateId)) throw Error('Reviewed candidate not found');
      await call({type:'workbench.action',id:project.id,action:{kind:'select',jobId:command.jobId,candidateId:command.candidateId}});
    }
    else if(command.action==='surface-settings' || command.action==='prepare-surface') {
      if(!workbench.selections['model:whole']) throw Error('Accept the whole model first');
      const {uvCost,textureCost,resolution,removeLighting}=command;
      if(![uvCost,textureCost].every(n=>Number.isSafeInteger(n)&&n>=0) ||
        !['2K','4K','8K'].includes(resolution) || typeof removeLighting!=='boolean') throw Error('Observed surface settings required');
      await page.getByTestId('workbench-step-surface').click();
      await page.getByTestId('workbench-external-surface').check();
      await page.getByTestId('workbench-observed-uv-cost').fill(String(uvCost));
      await page.getByTestId('workbench-observed-texture-cost').fill(String(textureCost));
      await page.getByTestId('workbench-texture-resolution').selectOption(resolution);
      await page.getByTestId('workbench-remove-lighting').setChecked(removeLighting);
      await page.getByTestId('workbench-credit-limit').fill(String(uvCost+textureCost));
      if(command.action==='prepare-surface') {
        if(command.costApproved!==true) throw Error('Explicit surface cost approval is required');
        await page.getByTestId('workbench-approve').check();
        await page.getByTestId('workbench-execute-surface').click();
        await page.getByTestId('workbench-external-receive').waitFor();
      }
      await page.screenshot({path:'artifacts/runtime/rabbit-surface-app.png'});
    }
    else if(command.action==='model-settings' || command.action==='prepare-model') {
      if(!info.wholeReference) throw Error('Accept the four-view set first');
      await page.getByTestId('workbench-step-parts').click();
      await page.getByTestId('workbench-model-input').selectOption('whole');
      await page.getByTestId('workbench-external-model').check();
      const count=command.generationCount ?? 1;
      if(!Number.isSafeInteger(count) || count<1 || count>16) throw Error('Invalid approved candidate count');
      await page.getByTestId('workbench-model-count').fill(String(count));
      const polygonCount=command.polygonCount ?? 10000;
      if(!Number.isSafeInteger(polygonCount) || polygonCount<500 || polygonCount>25000) throw Error('Invalid observed P2 polygon target');
      await page.getByTestId('workbench-polygon-count').fill(String(polygonCount));
      await page.getByTestId('workbench-studio-topology').selectOption('quad');
      await page.getByTestId('workbench-observed-model-cost').fill('100');
      await page.getByTestId('workbench-credit-limit').fill('100');
      if(command.action==='prepare-model') {
        if(command.costApproved!==true) throw Error('Explicit approval of observed 100-credit scope is required');
        await page.getByTestId('workbench-approve').check();
        await page.getByTestId('workbench-execute-model').click();
        await page.getByTestId('workbench-external-receive').waitFor();
      }
      await page.screenshot({path:'artifacts/runtime/rabbit-model-app.png'});
    }
    else if(command.action==='model-review') {
      await page.getByTestId('workbench-step-parts').click();
      const gallery=page.locator('.wb-candidates');
      await gallery.scrollIntoViewIfNeeded();
      await gallery.screenshot({path:'artifacts/runtime/rabbit-models-app-review.png'});
      const images=await gallery.locator('img').evaluateAll(items=>items.map(i=>({width:i.naturalWidth,height:i.naturalHeight,complete:i.complete})));
      await page.getByTestId('workbench-preview3d-0').click();
      await page.getByTestId('workbench-preview3d-1').click();
      await page.waitForTimeout(1500);
      await gallery.screenshot({path:'artifacts/runtime/rabbit-models-app-3d.png'});
      console.log(JSON.stringify({images,canvases:await gallery.locator('canvas').count(),selectedModel:workbench.selections['model:whole']??null}));
    }
    else if(command.action==="turnaround") {
      await page.getByTestId("workbench-concept-mode").selectOption("turnaround");
      await page.getByTestId("workbench-approve").check();
      await page.getByTestId("workbench-execute-concept").click();
      await page.getByTestId("workbench-external-receive").waitFor();
    }
    else if(command.action==="repair-views") {
      if(info.status!=="review" || info.candidates.length!==1) throw Error('A reviewed base view set is required');
      const repairPrompt=fs.readFileSync('artifacts/runtime/rabbit-view-repair-prompt.txt','utf8');
      await call({type:'workbench.action',id:project.id,action:{kind:'execute',
        request:{step:'concept',conceptMode:'turnaround',provider:'gpt',imageBackend:'chatgpt-web',executionMode:'codex-session',
          generationCount:1,baseJobId:info.jobId,baseCandidateId:info.candidates[0].id,prompt:repairPrompt},
        approval:{accepted:true,studioCreditLimit:0,imageCreditLimit:0}}});
    }
    else if(command.action==="screenshot") {
      const gallery=page.locator('.wb-whole-views');
      if(await gallery.count()) {
        await gallery.scrollIntoViewIfNeeded();
        await gallery.screenshot({path:'artifacts/runtime/rabbit-four-views-app.png'});
        const dimensions=await gallery.locator('img').evaluateAll(images=>images.map(i=>({width:i.naturalWidth,height:i.naturalHeight,complete:i.complete})));
        fs.writeFileSync('artifacts/runtime/rabbit-view-display.json',JSON.stringify(dimensions,null,2));
      }
      await page.screenshot({path:"artifacts/runtime/rabbit-concept-app.png"});
    }
    else if(command.action==="close") { await app.close(); break; }
    await snapshot();
  } catch(error) { console.log(JSON.stringify({error:error.message})); }
}
