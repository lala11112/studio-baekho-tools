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
const app = await electron.launch({ executablePath: path.resolve(process.env.PARTSMITH_EXECUTABLE ?? "release/0.6.16/win-unpacked/Partsmith.exe") });
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
      fs.writeFileSync('artifacts/runtime/rabbit-refinement-dispatch.json',JSON.stringify({appVersion:'0.6.15',trigger:'workbench-execute-assembly',surfaceSelection:w.selections.surface,job},null,2));
      console.log(JSON.stringify({assemblyJobId:job.id,status:job.status,dependencies:job.dependencies}));
    }
    else if(command.action==='show-assembly') {
      await page.getByTestId('workbench-step-assembly').click();
      await page.screenshot({path:'artifacts/runtime/rabbit-assembly-live.png'});
      const after=await call({type:'state'}), w=after.workbenches.find(w=>w.projectId===project.id);
      console.log(JSON.stringify({selection:w.selections.assembly,jobs:w.jobs.filter(j=>j.step==='assembly').map(j=>({id:j.id,status:j.status,summary:j.summary,candidates:j.candidates,checks:j.checks}))}));
    }
    else if(command.action==='start-rabbit-rig') {
      const base=workbench.jobs.find(j=>j.id==='94716773-5d3b-4c05-9a48-52a2d256aab4');
      if(project.id!=='26122336-8a7c-48b5-b15f-fa193ca157fd' || workbench.activeJobId ||
         base?.status!=='review' || !base.candidates.some(c=>c.id==='rabbit_local_repair_v2') ||
         workbench.jobs.some(j=>j.step==='rig')) throw Error('Exact accepted rabbit revision required; never duplicate rig work');
      await page.getByTestId('workbench-step-assembly').click();
      if(!workbench.selections.assembly) await page.getByTestId('workbench-accept-assembly').click();
      await page.getByTestId('workbench-step-rig').click();
      await page.getByTestId('workbench-rig-profile').selectOption('quadruped');
      await page.getByTestId('workbench-rig-ears').check();
      await page.getByTestId('workbench-rig-tail').check();
      await page.getByTestId('workbench-rig-prompt').fill('채택한 보정본 rabbit_local_repair_v2.blend를 기준으로 실제 네 발 토끼 리그를 만들어 주세요. Unity Generic용 뼈대이며 골반·척추·목·머리와 앞다리 2개/뒷다리 2개 각각의 관절, 발 제어가 필요합니다. 네 다리는 토끼의 실제 해부학적 굽힘 방향과 관절 위치를 고려해 독립적으로 포즈를 잡을 수 있게 하세요. 왼쪽 귀·오른쪽 귀를 각각 숙이거나 벌릴 수 있는 뿌리/중간 또는 끝 제어, 짧은 꼬리의 흔들기 제어도 만들어 주세요. 귀와 꼬리는 몸체 메시의 영역으로 식별해 실제 웨이트를 연결하고 억지로 새 메시로 교체하지 마세요. 수염은 기존 16가닥과 별도 오브젝트를 유지하며 머리를 자연스럽게 따라갑니다. 수염 독립 뼈는 추가하지 않습니다. 보정된 볼·수염 외형, UV, 4K 텍스처, 중립 자세의 실제 메시 좌표와 기존 오브젝트 ID를 보존하세요. 모든 정점에 정규화된 실제 웨이트를 넣고, 한쪽 다리나 귀를 움직일 때 반대편이나 몸통 전체가 끌려오지 않도록 합니다. 각 다리 굽힘 4개와 양쪽 귀·꼬리 단독 포즈를 실제 Blender에서 검사하고 해당 렌더 및 수치 보고서를 남기세요. 발/귀/꼬리 관통·찢어짐·몸통 붕괴를 직접 보고 수정하세요. 편집 가능한 packed blend, 스킨 포함 GLB, FBX+동반 4096 텍스처를 새 버전으로 저장하고 FBX 재임포트로 뼈·웨이트·텍스처를 검증하세요. 최종 파일은 중립 자세로 되돌려 저장하세요. 포즈 테스트는 리깅 검사일 뿐이며 Idle/Jump 등 제작 애니메이션, 물리 시뮬레이션, Tripo 작업, 다음 단계는 실행하지 마세요. 기존 텍스처의 작은 색 차이 같은 미수정 외형 한계는 보고서에 그대로 기록하세요.');
      await page.getByTestId('workbench-execute-rig').click();
      await page.waitForTimeout(700);
      const after=await call({type:'state'}), w=after.workbenches.find(w=>w.projectId===project.id), job=w.jobs.find(j=>j.step==='rig');
      if(!job || w.selections.assembly?.jobId!==base.id) throw Error('App did not dispatch rigging');
      fs.writeFileSync('artifacts/runtime/rabbit-rig-dispatch.json',JSON.stringify({appVersion:'0.6.15',trigger:'workbench-execute-rig',assemblySelection:w.selections.assembly,job},null,2));
      console.log(JSON.stringify({rigJobId:job.id,status:job.status,request:job.request,dependencies:job.dependencies}));
    }
    else if(command.action==='start-rabbit-reference') {
      const motion=command.motion;
      if(!['Rabbit_Idle','Rabbit_Jump'].includes(motion) || workbench.activeJobId ||
        workbench.jobs.some(j=>j.step==='reference' && j.request.motion===motion)) throw Error('Exact new idle/jump reference scope required; do not duplicate generation');
      const rig=workbench.jobs.find(j=>j.id==='a79d117c-027f-468f-b4c1-445e31c97117');
      if(rig?.status!=='review' || !rig.candidates.some(c=>c.id==='rabbit-rig-v3')) throw Error('Reviewed rabbit rig required');
      await page.getByTestId('workbench-step-rig').click();
      if(!workbench.selections.rig) await page.getByTestId('workbench-accept-rig').click();
      const idle=motion==='Rabbit_Idle';
      await page.getByTestId('workbench-step-motion').click();
      await page.getByTestId('workbench-tab-reference').click();
      await page.getByTestId('workbench-motion-name').fill(motion);
      await page.getByTestId('workbench-motion-duration').fill('2');
      await page.getByTestId('workbench-motion-fps').fill('30');
      await page.getByTestId('workbench-reference-count').fill(idle?'3':'5');
      await page.getByTestId('workbench-reference-times').fill(idle?'0, 1, 2':'0, 0.4, 0.9, 1.4, 2');
      await page.getByTestId('workbench-motion-loop').setChecked(idle);
      await page.getByTestId('workbench-motion-prompt').fill(`채택한 둥근 흰색 네 발 토끼의 ${idle?'대기 반복':'제자리 점프'} 2D 동작 참조 원본을 생성하세요. ${idle?'0초 편안한 중립/1초 약한 들숨과 귀 미세 움직임/2초 0초 자세로 복귀. 네 발 접지는 고정하고 체형이 바뀌지 않게 합니다.':'0초 중립/0.4초 몸을 낮춰 도약 준비/0.9초 정점에서 네 발 모두 공중, 뒷다리와 앞다리는 자연스럽게 접힘/1.4초 같은 자리로 착지하여 충격 흡수/2초 처음 중립으로 복귀. X/Z 이동·전진 점프 없이 수직으로 뜁니다.'} 각 시점마다 정면·토끼의 왼쪽 측면·후면 독립 원본을 하나씩, 총 ${idle?9:15}장 생성합니다. 동일 시점의 세 방향은 몸통 높이, 네 발의 굽힘/접지, 좌우 귀 각도와 꼬리 위치가 같은 하나의 자세여야 합니다. 고정 카메라·동일 배율/캔버스/바닥선, 전신과 점프 높이가 잘리지 않는 여백, 깨끗한 단색 배경. 원래 얼굴·볼·수염·분홍 귀 안쪽/코·검은 눈·둥근 몸체를 보존합니다. 실제 imagegen 원본을 사용하고 시트/크롭/거울 복사/Blender 렌더로 대신하지 마세요. 정면 생성 뒤 그 원본과 캐릭터 참조를 측면·후면에 사용해 동일 포즈를 맞추세요. 0초와2초도 독립 원본으로 생성하되 반복/복귀 자세를 맞추세요. 각 원본 저장 직후 부분 결과를 보존하세요. 이미지별 방향과 시간, 실제 프롬프트를 보고서에 기록하고 불일치는 솔직히 남기세요. 사용자 검토 전 3D 애니메이션이나 다음 단계는 절대 실행하지 마세요.`);
      const refPrompt=page.getByTestId('workbench-motion-prompt');
      await refPrompt.fill((await refPrompt.inputValue())+' 카메라 방향을 엄격히 지키세요. 측면 생성에는 공급된 neutral_left 원본의 정확한 90도 프로필 카메라를 함께 사용하고, 같은 시점 정면은 포즈 정보만 참고합니다. 사선 정면이나3/4로 바꾸면 안 됩니다. 후면도 neutral_back의 정확한180도 카메라입니다. 점프 시 세 방향 모두 땅에서 같은 높이로 떠 있고, 동일한 발 접지/공중 상태여야 합니다. 큰 외형 불일치나 잘못된 방향은 오류로 남기고, 단순 배경 명암 차이는 그 영향만 구체적으로 기록하세요.');
      await page.getByTestId('workbench-approve').check();
      await page.getByTestId('workbench-execute-reference').click();
      await page.waitForTimeout(700);
      const after=await call({type:'state'}), w=after.workbenches.find(w=>w.projectId===project.id), job=w.jobs.find(j=>j.step==='reference'&&j.request.motion===motion);
      if(!job || w.selections.rig?.candidateId!=='rabbit-rig-v3') throw Error('Reference button dispatch failed');
      fs.writeFileSync(`artifacts/runtime/rabbit-${motion}-reference-dispatch.json`,JSON.stringify({appVersion:'0.6.16',trigger:'workbench-execute-reference',rigSelection:w.selections.rig,job},null,2));
      console.log(JSON.stringify({referenceJobId:job.id,status:job.status,request:job.request}));
    }
    else if(command.action==='show-reference') {
      await page.getByTestId('workbench-step-motion').click();
      await page.getByTestId('workbench-tab-reference').click();
      if(command.motion) await page.getByTestId('workbench-motion-name').fill(command.motion);
      await page.screenshot({path:'artifacts/runtime/rabbit-reference-live.png'});
      const after=await call({type:'state'}), w=after.workbenches.find(w=>w.projectId===project.id);
      console.log(JSON.stringify(w.jobs.filter(j=>j.step==='reference').map(j=>({id:j.id,motion:j.request.motion,status:j.status,summary:j.summary,candidates:j.candidates.length}))));
    }
    else if(command.action==='show-rig') {
      await page.getByTestId('workbench-step-rig').click();
      await page.screenshot({path:'artifacts/runtime/rabbit-rig-live.png'});
      const after=await call({type:'state'}), w=after.workbenches.find(w=>w.projectId===project.id), job=w.jobs.find(j=>j.step==='rig');
      console.log(JSON.stringify({selection:w.selections.rig,jobId:job?.id,status:job?.status,summary:job?.summary,checks:job?.checks}));
    }
    else if(command.action==='inspect-reference') {
      const job=workbench.jobs.find(j=>j.id===command.jobId&&j.step==='reference');
      if(!job || workbench.activeJobId) throw Error('Idle existing reference required');
      await page.getByTestId('workbench-step-motion').click();await page.getByTestId('workbench-tab-reference').click();
      await page.getByTestId('workbench-motion-name').fill(job.request.motion);
      await page.getByTestId('workbench-inspect-saved').click();
    }
    else if(command.action==='recheck-existing-assembly' || command.action==='recheck-existing-rig' || command.action==='recheck-existing-reference') {
      const step=command.action==='recheck-existing-reference'?'reference':command.action==='recheck-existing-rig'?'rig':'assembly';
      const job=workbench.jobs.find(j=>j.step===step);
      if(workbench.activeJobId || job?.id!==command.jobId || !['needs_input','failed','cancelled'].includes(job.status))
        throw Error('Exact stopped existing assembly job required');
      await page.getByTestId(`workbench-step-${step==='reference'?'motion':step}`).click();
      if(step==='reference') { await page.getByTestId('workbench-tab-reference').click(); await page.getByTestId('workbench-motion-name').fill(job.request.motion); }
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
