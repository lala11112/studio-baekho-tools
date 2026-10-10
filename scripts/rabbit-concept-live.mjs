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
const app = await electron.launch({ executablePath: path.resolve("release/0.6.4/win-unpacked/Partsmith.exe") });
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
  const job=workbench.jobs.find(j=>j.request.executionMode==="codex-session");
  const info={projectId:project.id,workbenchId:workbench.id,jobId:job.id,
    workspace:path.join(state.dataDir,"projects",project.id,"workbench",workbench.id,"jobs",job.id),
    status:job.status,external:job.externalExecution,candidates:job.candidates,selection:workbench.selections.concept};
  fs.mkdirSync("artifacts/runtime",{recursive:true});
  fs.writeFileSync("artifacts/runtime/rabbit-session.json",JSON.stringify(info,null,2));
  console.log(JSON.stringify({jobId:job.id,status:job.status,external:job.externalExecution?.state,candidates:job.candidates.length,selection:info.selection}));
  return info;
};
await snapshot();
console.log("READY: accepts JSON lines with action reserve, receive, state, screenshot, close. Never sends browser requests.");
for await (const line of readline.createInterface({input:process.stdin})) {
  try {
    const command=JSON.parse(line), info=await snapshot();
    if(command.action==="reserve") await call({type:"workbench.action",id:project.id,
      action:{kind:"external-reserve",jobId:info.jobId,requestHash:info.external.requestHash}});
    else if(command.action==="receive") await page.getByTestId("workbench-external-receive").click();
    else if(command.action==="select-rounded") await page.getByTestId("workbench-select-0").click();
    else if(command.action==="turnaround") {
      await page.getByTestId("workbench-concept-mode").selectOption("turnaround");
      await page.getByTestId("workbench-approve").check();
      await page.getByTestId("workbench-execute-concept").click();
      await page.getByTestId("workbench-external-receive").waitFor();
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
