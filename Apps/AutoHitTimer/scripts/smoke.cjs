'use strict';

// Exercises the real sandboxed preload and renderer with an explicitly mocked
// Unity/Codex bridge. This is UI verification, never an AI accuracy result.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateWindows, newJob } = require('../src/domain.cjs');

if (process.env.AHT_SMOKE_MEDIA_PROJECT) runRealMedia();
else if (process.env.AHT_SMOKE_REAL_MAIN === '1') runRealMain();
else {
const output = process.env.AHT_SMOKE_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'auto-hit-timer-ui-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'electron-data'));
app.disableHardwareAcceleration();
let window;
const calls = [];
const errors = [];
const clip = { guid: 'a'.repeat(32), localId: '7400000', name: '[모의] Sword_Slash_01', path: 'Assets/Mock/Slash.fbx', length: 1.2, stateName: 'Attack_Slash_01', compatible: true };
const sourceGuid = 'b'.repeat(32);
const initialState = { projectPath: '', connection: { ready: false, message: 'Unity 프로젝트를 선택하세요.' }, ai: { available: false, authenticated: false, label: 'Codex 확인 전' }, actors: [], actorId: '', sources: [], targets: [], groups: [], jobs: [], selectedJobId: '', settings: {}, busy: false, notice: '' };
let state = structuredClone(initialState);
let saveCount = 0;
let requireTimeOverrides = false;
let previewValid = false;

function frameData(time) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512"><rect width="1024" height="512" fill="#19232c"/><path d="M0 405H1024M512 0V512" stroke="#3a4a56"/><g stroke="#90a4b2" stroke-width="14" stroke-linecap="round" fill="none"><circle cx="250" cy="160" r="28"/><path d="M250 190V310M250 224L182 285M250 230L336 205M250 310L210 390M250 310L294 390"/><circle cx="765" cy="160" r="28"/><path d="M765 190V310M765 224L755 292M765 230L833 227M765 310L733 390M765 310L791 390"/></g><path d="M335 205L405 ${100 + time * 40}M833 227L900 ${170 + time * 40}" stroke="#e9b767" stroke-width="7"/><text x="24" y="480" fill="#778f9f" font-size="18" font-family="sans-serif">MOCK UI FIXTURE · NOT UNITY CAPTURE / AI RESULT</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function loadedState() {
  const item = newJob(clip);
  item.id = 'fixture-job'; item.status = 'review'; item.frames = [0, .2, .4, .6, .8, 1, 1.2].map((time, i) => ({ id: `f${i}`, time, url: frameData(time) }));
  item.windows = [{ id: 'hit-one', start: .25, end: .43, sourceIndex: -1, reason: '모의 결과: 검을 휘두르는 구간. 실제 AI 분석이 아닙니다.', uncertain: false }, { id: 'hit-two', start: .72, end: .9, sourceIndex: -1, reason: '모의 결과: 두 번째 타격 후보.', uncertain: true }];
  item.analysisStatus = 'uncertain';
  return { ...structuredClone(initialState), projectPath: 'C:\\Mock\\FourTigerSword', connection: { ready: true, message: '모의 Unity 연결', unityVersion: '6000.3.10f1' }, ai: { available: true, authenticated: true, label: 'Codex 모의 연결' }, actorId: 'actor-1', actors: [{ id: 'actor-1', label: '[모의] 플레이어 캐릭터', weapons: [{ id: 'weapon-1', label: '[모의] 사인검', bone: 'RightHand' }] }], sources: [{ guid: sourceGuid, label: '[모의] 금 폼', type: 'MetalWeaponActionDataSO' }], targets: [{ sourceGuid, actionPath: 'Actions[0]', group: 'combo', label: '일반 공격 1단계', animationName: 'Attack_Slash_01', duration: 1.2, supported: true, snapshot: 'mock-snapshot', windows: [{ start: .2, end: .45, sourceIndex: 0 }, { start: .7, end: .92, sourceIndex: 2 }] }], groups: [{ sourceGuid, id: 'combo', label: '일반 콤보', supported: true }, { sourceGuid, id: 'skill', label: '스킬', supported: true }], jobs: [item], selectedJobId: item.id, settings: { actorId: 'actor-1' } };
}

const selected = () => state.jobs.find(item => item.id === state.selectedJobId);
const publish = () => window.webContents.send('aht:state', structuredClone(state));
const handlers = {
  getState: () => state,
  selectProject: () => { state = loadedState(); publish(); return state; },
  connectProject: () => state,
  installIntegration: () => ({ message: '모의 연동 설치' }),
  refreshCatalog: () => state,
  searchAnimations: () => ({ clips: [clip, { ...clip, localId: '7400002', name: '[모의] Sword_Slash_02' }] }),
  importFiles: () => ({ clips: [clip] }),
  addJobs: clips => { const jobs = clips.map(newJob); state.jobs.push(...jobs); state.selectedJobId = jobs[0].id; publish(); return state; },
  selectJob: id => { state.selectedJobId = id; previewValid = false; publish(); return state; },
  updateJob: (id, patch) => {
    const item = state.jobs.find(value => value.id === id);
    if ('mode' in patch) assert(['update', 'register'].includes(patch.mode));
    if ('group' in patch) assert(['combo', 'air', 'counter', 'skill', 'ultimate'].includes(patch.group));
    if (patch.windows) patch.windows = validateWindows(patch.windows, item.duration);
    if (patch.timeOverrides) assert(Array.isArray(patch.timeOverrides));
    Object.assign(item, patch);
    if (Object.keys(patch).some(key => key !== 'reviewed')) item.reviewed = false;
    previewValid = false; publish(); return state;
  },
  updateSettings: patch => { Object.assign(state.settings, patch); state.actorId = state.settings.actorId; publish(); return state; },
  analyzeJobs: () => ({ started: true }),
  cancelAnalysis: () => state,
  removeJob: id => { state.jobs = state.jobs.filter(item => item.id !== id); state.selectedJobId = state.jobs[0]?.id || ''; publish(); return state; },
  previewChange: options => {
    assert(selected().reviewed, 'Preview must require review');
    assert(['update', 'register'].includes(options.mode));
    assert(Array.isArray(options.timeOverrides));
    const missing = requireTimeOverrides && !options.timeOverrides.some(item => item.path === 'Feedback.Slash.SlashVFXStartTime' && item.value === -1);
    previewValid = !missing;
    return { changeId: 'mock-change', canApply: !missing, summary: '모의 변경 검토 · 원본 및 AI 분석은 실행하지 않습니다.', hitCountBefore: 2, hitCountAfter: selected().windows.length, damageBefore: 2, damageAfter: 3, damageNote: '모의 기본 피해 계수 합계', mapping: { retained: 2, removed: 0, added: 0 }, issues: missing ? ['슬래시 이펙트 시간을 보정하세요.'] : [], requiredTimeOverrides: missing ? [{ path: 'Feedback.Slash.SlashVFXStartTime', label: '슬래시 시작', value: 3, min: -1, max: 1.2 }] : [], before: { animation: 'Attack_Slash_01' }, after: { animation: 'Attack_Slash_01' }, proposedStateName: options.mode === 'register' ? 'AHT_Sword_Slash_01' : '' };
  },
  applyChange: id => { assert(previewValid); assert.equal(id, 'mock-change'); saveCount++; selected().status = 'saved'; selected().savedAssets = [{ path: 'Assets/Mock/Result.asset' }]; publish(); return { assets: selected().savedAssets }; },
  revealAsset: () => ({ opened: true })
};

for (const [name, callback] of Object.entries(handlers)) ipcMain.handle('aht:' + name, async (_event, ...args) => {
  calls.push({ name, args });
  try { return { ok: true, value: structuredClone(await callback(...args)) }; }
  catch (error) { return { ok: false, error: { message: error.message } }; }
});

const evaluate = expression => window.webContents.executeJavaScript(expression);
async function until(expression, label) {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timed out: ' + label);
}
const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
async function change(id, value) {
  await evaluate(`(() => {const input=document.getElementById(${JSON.stringify(id)});if(!input)throw new Error('Missing '+${JSON.stringify(id)});${typeof value === 'boolean' ? `input.checked=${value}` : `input.value=${JSON.stringify(String(value))}`};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await new Promise(resolve => setTimeout(resolve, 70));
}
async function screenshot(name) { await new Promise(resolve => setTimeout(resolve, 200)); fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG()); }

async function main() {
  window = new BrowserWindow({ width: 1550, height: 980, show: false, webPreferences: { preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true } });
  window.removeMenu();
  window.webContents.on('console-message', (_event, ...args) => { const details = args[0]; if (details?.level === 'error') errors.push(details.message); else if (args[0] === 3) errors.push(args[1]); });
  window.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer exit: ' + details.reason));
  await window.loadFile(path.resolve(__dirname, '../renderer/index.html'));
  await until('document.getElementById("job-count").textContent === "0"', 'empty state');
  await screenshot('01-empty');
  await click('select-project');
  await until('document.getElementById("job-count").textContent === "1" && !!document.getElementById("composite-frame")', 'loaded fixture');
  assert.equal(await evaluate('document.querySelectorAll(".hit-card").length'), 2);
  assert.equal(await evaluate('document.getElementById("analyze-selected").disabled'), false);
  await screenshot('02-mock-review');
  await click('next-frame');
  assert.match(await evaluate('document.getElementById("time-readout").textContent'), /0\.200/);
  await click('previous-frame');
  await click('play-pause');
  assert.equal(await evaluate('document.getElementById("play-pause").getAttribute("aria-label")'), '일시 정지');
  await click('play-pause');
  await change('hit-hit-one-start', .23);
  assert.equal(selected().windows[0].start, .23);
  await click('add-hit');
  await until('document.querySelectorAll(".hit-card").length === 3', 'manual hit addition');
  const manual = selected().windows.find(item => item.reason === '사용자가 추가한 구간');
  await evaluate(`document.querySelector('[data-delete-hit="${manual.id}"]').click()`);
  await until('document.querySelectorAll(".hit-card").length === 2', 'manual hit removal');
  await click('tab-save');
  await change('source-select', sourceGuid);
  assert.equal(selected().group, 'combo');
  await change('target-select', 'Actions[0]');
  assert.deepEqual(selected().windows.map(item => item.sourceIndex), [0, 2], 'Preserve sparse HitEvents indices');
  await change('save-reviewed-check', true);
  await until('!document.getElementById("preview-change").disabled', 'reviewed preview');
  await click('preview-change');
  await until('!!document.getElementById("apply-change")', 'change preview');
  assert.equal(saveCount, 0, 'Preview must not save');
  assert.match(await evaluate('document.getElementById("save-panel").textContent'), /기본 피해 계수/);
  await screenshot('03-mock-save-diff');
  await click('apply-change');
  await until('document.getElementById("save-panel").textContent.includes("저장된 에셋")', 'saved assets');
  assert.equal(saveCount, 1);
  selected().pendingSave = { changeId: 'uncertain-change', requestId: 'c'.repeat(32) };
  selected().error = '모의 지연 응답';
  publish();
  await until('document.getElementById("inspector-footer").textContent.includes("저장 결과 확인 중")', 'pending save lock');
  assert.equal(await evaluate('document.getElementById("analyze-selected").disabled'), true);
  assert.equal(await evaluate('document.getElementById("source-select").disabled'), true);
  assert.equal(await evaluate('document.querySelector("[data-remove-job]").disabled'), true);
  await click('tab-hits');
  assert.equal(await evaluate('document.getElementById("add-hit").disabled'), true);
  assert.equal(await evaluate('document.getElementById("hit-hit-one-start").disabled'), true);
  selected().pendingSave = null; selected().error = ''; selected().status = 'saved'; publish();
  await until('document.getElementById("notice").textContent.includes("저장 결과를 확인했습니다")', 'late save receipt notice');
  await click('tab-save');
  await evaluate('document.querySelector("[data-save-mode=register]").click()');
  await until('!!document.getElementById("template-select")', 'register mode');
  assert.equal(selected().mode, 'register');
  await change('template-select', 'Actions[0]');
  requireTimeOverrides = true;
  await change('save-reviewed-check', true);
  await click('preview-change');
  await until('!!document.getElementById("override-Feedback.Slash.SlashVFXStartTime")', 'time override editor');
  assert.equal(await evaluate('document.getElementById("override-Feedback.Slash.SlashVFXStartTime").min'), '-1');
  await change('override-Feedback.Slash.SlashVFXStartTime', -1);
  assert.deepEqual(selected().timeOverrides, [{ path: 'Feedback.Slash.SlashVFXStartTime', value: -1 }]);
  assert.equal(await evaluate('!!document.getElementById("override-Feedback.Slash.SlashVFXStartTime")'), true, 'Override remains editable when preview invalidates');
  await change('save-reviewed-check', true);
  await click('preview-change');
  await until('!!document.getElementById("apply-change")', 'register after time correction');
  window.setContentSize(950, 820);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'No horizontal overflow at narrow width');
  await screenshot('04-mock-narrow');
  await evaluate('document.getElementById("animation-query").value="Slash";document.getElementById("search-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
  await until('document.querySelectorAll("[data-result]").length === 2', 'multi-clip results');
  await evaluate('document.querySelector("[data-result=\\"0\\"]").click()');
  await click('add-search-results');
  await until('document.getElementById("job-count").textContent === "2"', 'queued search selection');
  assert.equal(saveCount, 1, 'Register preview and search must not auto-save');
  assert.deepEqual(errors, [], 'Renderer console errors');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ kind: 'mock-ui-smoke', actualUnityCapture: false, actualAiAnalysis: false, checks: ['empty state', 'real sandboxed preload IPC', 'composite preview', 'playback and frame step', 'manual hit edit/add/delete', 'sparse existing hit mapping', 'review gate', 'damage and mapping diff', 'explicit apply only', 'uncertain save editing/removal/reanalysis lock', 'late receipt success notice', 'registration mode', 'negative time sentinel', 'override draft persistence', '950px responsive layout', 'multiple search result selection'], calls: calls.map(call => call.name), screenshots: ['01-empty.png', '02-mock-review.png', '03-mock-save-diff.png', '04-mock-narrow.png'] }, null, 2));
  console.log('MOCK UI SMOKE PASSED: ' + output);
  app.exit(0);
}

app.whenReady().then(main).catch(error => { console.error(error.stack); app.exit(1); });
}

function runRealMain() {
  const output = process.env.AHT_SMOKE_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'auto-hit-timer-real-main-'));
  const isolatedAppData = path.join(output, 'isolated-appdata');
  const recovery = Boolean(process.env.AHT_SMOKE_RECOVERY);
  const journalRecovery = process.env.AHT_SMOKE_RECOVERY === 'journal';
  const unsentRecovery = process.env.AHT_SMOKE_RECOVERY === 'unsent';
  fs.mkdirSync(isolatedAppData, { recursive: true });
  // main.cjs derives userData and its instance lock from appData. Isolate both
  // before loading it, so a user's existing app and saved project stay untouched.
  app.setPath('appData', isolatedAppData);
  app.disableHardwareAcceleration();
  BrowserWindow.prototype.show = function hideTestWindow() {};
  // Startup/recovery verification must not depend on or touch a user's login.
  require('../src/ai.cjs').CodexAnalyzer.prototype.status = async () => ({ available: false, authenticated: false, label: '시작 테스트 · AI 연결 생략' });
  let recoveryProject;
  const recoveryCommands = [];
  if (recovery) {
    recoveryProject = path.join(output, 'MockUnityProject');
    fs.mkdirSync(path.join(recoveryProject, 'Assets'), { recursive: true });
    fs.mkdirSync(path.join(recoveryProject, 'ProjectSettings'), { recursive: true });
    fs.writeFileSync(path.join(recoveryProject, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.10f1\n');
    recoveryProject = fs.realpathSync(recoveryProject);
    const requestId = require('node:crypto').randomUUID();
    const responses = path.join(recoveryProject, 'Library', 'AutoHitTimerBridge', 'responses');
    fs.mkdirSync(responses, { recursive: true });
    const recoveredResult = { assets: [{ path: 'Assets/MockRecovered.asset' }], actionPath: 'Actions[2]', summary: '모의 저장 영수증 복구 완료' };
    if (!unsentRecovery) fs.writeFileSync(path.join(responses, requestId + '.json'), JSON.stringify({ protocolVersion: 1, id: requestId, ok: !journalRecovery, resultJson: JSON.stringify(recoveredResult), ...(journalRecovery ? { error: { code: 'INTERRUPTED', message: '모의 에디터 종료: 실제 결과는 어댑터 journal에 보존됨' } } : {}) }));
    const savedJob = newJob({ guid: 'a'.repeat(32), localId: '7400000', name: '[모의] 복구 작업', length: 1 });
    Object.assign(savedJob, { mode: 'register', copy: false, status: 'review', pendingSave: { changeId: 'd'.repeat(32), requestId }, reviewed: true, sourceGuid: 'b'.repeat(32), contextKey: 'actor-1||' });
    const store = new (require('../src/store.cjs').Store)(path.join(isolatedAppData, 'StudioBaekho', 'AutoHitTimer'));
    store.savePreferences({ projectPath: recoveryProject });
    store.save(recoveryProject, { settings: { actorId: 'actor-1' }, jobs: [savedJob], selectedJobId: savedJob.id });
    // Simulate only the bridge's read-only catalog/status responses. Any apply
    // command is recorded and fails the no-replay assertion below.
    const bridgePath = path.dirname(responses);
    const tickBridge = () => {
      fs.writeFileSync(path.join(bridgePath, 'status.json'), JSON.stringify({ protocolVersion: 1, projectPath: recoveryProject, ready: true, timestampUtcMs: Date.now(), unityVersion: '6000.3.10f1', message: '모의 복구 브리지' }));
      const requests = path.join(bridgePath, 'requests');
      if (!fs.existsSync(requests)) return;
      for (const filename of fs.readdirSync(requests).filter(name => name.endsWith('.json'))) {
        const request = JSON.parse(fs.readFileSync(path.join(requests, filename), 'utf8'));
        recoveryCommands.push(request.command);
        const result = request.command === 'actors' ? { actors: [{ id: 'actor-1', label: '[모의] 복구 캐릭터' }] }
          : request.command === 'targets' ? { sources: [], targets: [], groups: [] }
          : request.command === 'saveStatus' ? { status: unsentRecovery ? 'preview' : 'complete', result: recoveredResult } : {};
        fs.writeFileSync(path.join(responses, filename), JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, resultJson: JSON.stringify(result) }));
        fs.unlinkSync(path.join(requests, filename));
      }
    };
    tickBridge();
    setInterval(tickBridge, 25);
  }
  const errors = [];
  const timeout = setTimeout(() => { console.error('Real main startup timed out'); app.exit(1); }, 20000);
  app.on('browser-window-created', (_event, testWindow) => {
    testWindow.webContents.on('console-message', (_consoleEvent, ...args) => { if (args[0]?.level === 'error') errors.push(args[0].message); else if (args[0] === 3) errors.push(args[1]); });
    testWindow.webContents.once('did-finish-load', async () => {
      try {
        const readFacts = () => testWindow.webContents.executeJavaScript(`(async()=>({title:document.title,bridge:typeof window.autoHitTimer?.getState,state:await window.autoHitTimer.getState(),jobs:document.getElementById('job-count').textContent,selectDisabled:document.getElementById('select-project').disabled}))()`);
        let facts = await readFacts();
        if (recovery) for (let count = 0; count < 150 && (!facts.state.jobs[0] || facts.state.jobs[0].pendingSave); count++) { await new Promise(resolve => setTimeout(resolve, 50)); facts = await readFacts(); }
        assert.equal(facts.bridge, 'function');
        if (recovery) {
          assert.equal(facts.state.projectPath, recoveryProject);
          assert.equal(facts.state.jobs[0].status, unsentRecovery ? 'review' : 'saved');
          assert.equal(facts.state.jobs[0].mode, unsentRecovery ? 'register' : 'update');
          assert.equal(facts.state.jobs[0].actionPath, unsentRecovery ? '' : 'Actions[2]');
          assert.equal(facts.state.jobs[0].pendingSave, null);
          if (unsentRecovery) assert.deepEqual(facts.state.jobs[0].savedAssets, []);
          else assert.equal(facts.state.jobs[0].savedAssets[0].path, 'Assets/MockRecovered.asset');
          assert(!recoveryCommands.includes('apply'), 'Startup must not re-dispatch a recovered apply');
          if (journalRecovery || unsentRecovery) assert(recoveryCommands.includes('saveStatus'), 'Missing or interrupted bridge responses must consult the journal');
        } else {
          assert.equal(facts.state.projectPath, '');
          assert.deepEqual(facts.state.jobs, []);
          assert.equal(facts.jobs, '0');
        }
        assert.equal(testWindow.isVisible(), false);
        assert(app.getPath('userData').startsWith(isolatedAppData));
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ kind: recovery ? unsentRecovery ? 'real-main-recovery-before-dispatch' : journalRecovery ? 'real-main-recovery-with-mock-journal' : 'real-main-recovery-with-mock-receipt' : 'real-main-startup-smoke', actualEntryPoint: 'src/main.cjs', actualUnityCapture: false, actualAiAnalysis: false, mockedAiStatus: true, isolatedUserData: app.getPath('userData'), visible: testWindow.isVisible(), recoveryCommands, facts, errors }, null, 2));
        clearTimeout(timeout);
        console.log('REAL MAIN STARTUP SMOKE PASSED: ' + output);
        app.exit(0);
      } catch (error) { clearTimeout(timeout); console.error(error.stack); app.exit(1); }
    });
  });
  require('../src/main.cjs');
}

function runRealMedia() {
  const project = fs.realpathSync(process.env.AHT_SMOKE_MEDIA_PROJECT);
  const output = process.env.AHT_SMOKE_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'auto-hit-timer-real-media-'));
  const isolatedAppData = path.join(output, 'isolated-appdata');
  fs.mkdirSync(isolatedAppData, { recursive: true });
  app.setPath('appData', isolatedAppData);
  app.disableHardwareAcceleration();
  BrowserWindow.prototype.show = function hideTestWindow() {};
  const read = name => JSON.parse(fs.readFileSync(path.join(project, name), 'utf8').replace(/^\uFEFF/, ''));
  const capture = read('real-capture.json');
  const refinement = read('real-refinement.json');
  const analysis = read('real-ai-refined.json');
  const actors = read('real-ui-actors.json').actors;
  assert(actors[0]?.id, 'Record the real test project actor manifest before this check');
  const savedJob = newJob(capture.clip);
  const merged = new Map([...capture.frames, ...refinement.frames].map(frame => [frame.time.toFixed(6), frame]));
  Object.assign(savedJob, { status: 'review', frames: [...merged.values()].sort((a, b) => a.time - b.time), duration: capture.duration,
    windows: validateWindows(analysis.windows, capture.duration), analysisStatus: analysis.status, analysisNotes: [analysis.summary], model: analysis.model,
    reviewed: false, contextKey: `${actors[0].id}||`, sessionId: capture.sessionId });
  const store = new (require('../src/store.cjs').Store)(path.join(isolatedAppData, 'StudioBaekho', 'AutoHitTimer'));
  store.savePreferences({ projectPath: project });
  store.save(project, { settings: { actorId: actors[0].id, weaponId: '', weaponBone: '' }, jobs: [savedJob], selectedJobId: savedJob.id });
  const errors = [];
  const commands = [];
  const { ProjectClient } = require('../src/project-client.cjs');
  const command = ProjectClient.prototype.command;
  ProjectClient.prototype.command = function recordCommand(name, ...args) { commands.push(name); assert(!['apply', 'capture', 'previewChange', 'import'].includes(name), 'Media review must not change or recapture assets'); return command.call(this, name, ...args); };
  require('../src/ai.cjs').CodexAnalyzer.prototype.analyze = async () => { throw new Error('AI analysis must not be re-run in media review'); };
  const timeout = setTimeout(() => { console.error('Real media startup timed out'); app.exit(1); }, 25000);
  app.on('browser-window-created', (_event, testWindow) => {
    testWindow.webContents.on('console-message', (_consoleEvent, ...args) => { if (args[0]?.level === 'error') errors.push(args[0].message); else if (args[0] === 3) errors.push(args[1]); });
    testWindow.webContents.once('did-finish-load', async () => {
      try {
        const evaluate = text => testWindow.webContents.executeJavaScript(text);
        let loaded = false;
        for (let count = 0; count < 150 && !loaded; count++) {
          loaded = await evaluate(`(() => {const image=document.getElementById('composite-frame');return Boolean(image?.complete && image.naturalWidth && image.src.startsWith('aht-media:') && document.getElementById('actor-select')?.value && !document.getElementById('refresh-catalog').disabled)})()`);
          if (!loaded) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert(loaded, 'Actual aht-media image must decode');
        const time = (analysis.windows[0].start + analysis.windows[0].end) / 2;
        await evaluate(`(() => {const seek=document.getElementById('seek');seek.value=${time};seek.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await new Promise(resolve => setTimeout(resolve, 600));
        const facts = await evaluate(`(async()=>{const image=document.getElementById('composite-frame');return {state:await window.autoHitTimer.getState(),image:{src:image.src,width:image.naturalWidth,height:image.naturalHeight,complete:image.complete},hitText:document.getElementById('hits-panel').textContent,time:document.getElementById('time-readout').textContent}})()`);
        assert.equal(facts.state.projectPath, project);
        assert.equal(facts.image.width, 1024);
        assert.equal(facts.image.height, 512);
        assert.equal(facts.state.jobs[0].analysisStatus, analysis.status);
        assert.match(facts.time, /0\.550/);
        assert.match(facts.hitText, /확인 필요/);
        assert.equal(testWindow.isVisible(), false);
        assert(app.getPath('userData').startsWith(isolatedAppData));
        assert.deepEqual(errors, []);
        const screenshot = path.join(output, 'real-unity-ai-review.png');
        const image = await testWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        assert(!image.isEmpty(), 'Rendered screenshot must contain pixels');
        fs.writeFileSync(screenshot, image.toPNG());
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ kind: 'real-main-media-protocol', actualEntryPoint: 'src/main.cjs', reusedRealUnityCapture: true, reusedRealAiAnalysis: true, newAiInvocations: 0, assetMutations: 0, project, isolatedUserData: app.getPath('userData'), screenshot, image: facts.image, analysis, commandNames: commands, errors, frameCount: savedJob.frames.length, selectedTime: time }, null, 2));
        clearTimeout(timeout);
        console.log('REAL MEDIA PROTOCOL SMOKE PASSED: ' + output);
        app.exit(0);
      } catch (error) { clearTimeout(timeout); console.error(error.stack); app.exit(1); }
    });
  });
  // The production main and media handler are unchanged. Offscreen compositing
  // makes a hidden-window screenshot reflect the latest DOM instead of the last
  // OS surface, without exposing a test window on the user's desktop.
  const Module = require('node:module');
  const originalLoad = Module._load;
  const mainPath = path.resolve(__dirname, '../src/main.cjs');
  const offscreenWindow = new Proxy(BrowserWindow, { construct(Target, args) { return new Target({ ...args[0], webPreferences: { ...args[0].webPreferences, offscreen: true } }); } });
  Module._load = function loadForHiddenMedia(request, parent, isMain) {
    const result = originalLoad.call(this, request, parent, isMain);
    return request === 'electron' && parent?.filename === mainPath
      ? new Proxy(result, { get(target, property) { return property === 'BrowserWindow' ? offscreenWindow : Reflect.get(target, property); } }) : result;
  };
  try { require('../src/main.cjs'); } finally { Module._load = originalLoad; }
}
