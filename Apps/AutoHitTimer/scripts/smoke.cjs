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
const clip = { guid: 'a'.repeat(32), localId: '7400000', name: '[모의] Sword_Slash_01', path: 'Assets/Mock/Slash.fbx', length: 1.5, stateName: 'Attack_Slash_01', compatible: true };
const oldClip = { ...clip, localId: '7400009', name: '[모의] Sword_Old', path: 'Assets/Mock/Old.fbx', length: 1.833 };
const timeSettings = [
  ['Execution.ComboTransitionTime', '다음 콤보 전환', 1.7],
  ['Execution.Movement.MovementStartTime', '이동 시작', .1],
  ['Execution.Movement.MovementEndTime', '이동 종료', .7],
  ['Execution.Movement.TargetApproach.ApproachEndTime', '타겟 접근 종료', .6],
  ['Execution.Movement.TargetApproach.RotationEndTime', '타겟 회전 종료', .5],
  ['Feedback.Trail.TrailStartTime', '트레일 시작', .2],
  ['Feedback.Trail.TrailEndTime', '트레일 종료', .8],
  ['Feedback.Slash.SlashVFXStartTime', '슬래시 이펙트 시작', .3],
  ['Execution.Duration', '공격 종료 · 이동 복귀', 1.833]
].map(([path, label, value]) => ({ path, label, value, min: path === 'Feedback.Slash.SlashVFXStartTime' ? -1 : 0, max: 1.833 }));
const sourceGuid = 'b'.repeat(32);
const initialState = { projectPath: '', connection: { ready: false, message: 'Unity 프로젝트를 선택하세요.' }, ai: { available: false, authenticated: false, label: 'AI 확인 전' }, actors: [], actorId: '', sources: [], targets: [], groups: [], jobs: [], selectedJobId: '', settings: {}, busy: false, search: { busy: false, progressText: '' }, notice: '' };
initialState.capabilities = { attackTiming: true };
let state = structuredClone(initialState);
let saveCount = 0;
let requireTimeOverrides = false;
let previewValid = false;
let previewAssignment = null;
let searchMock = 'success';
let finishSearch;
const searchResponse = mode => ({ clips: [{ ...clip, ...(mode === 'semantic' ? { searchScore: .91, searchReason: 'Slash 상태와 검 경로가 베기 설명과 연관됩니다. 실제 돌진 여부는 확인이 필요합니다.' } : {}) }, { ...clip, localId: '7400002', name: '[모의] Sword_Slash_02', ...(mode === 'semantic' ? { searchScore: .72, searchReason: '두 번째 베기 클립 이름이 연속 공격의 후보입니다.' } : {}) }], mode, summary: mode === 'semantic' ? '검 베기와 관련된 후보 2개를 찾았습니다. 동작 방향은 미리보기에서 확인하세요.' : '이름이 일치하는 클립 2개를 찾았습니다.', searchedCount: 140, truncated: false });

function frameData(time) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512"><rect width="1024" height="512" fill="#19232c"/><path d="M0 405H1024M512 0V512" stroke="#3a4a56"/><g stroke="#90a4b2" stroke-width="14" stroke-linecap="round" fill="none"><circle cx="250" cy="160" r="28"/><path d="M250 190V310M250 224L182 285M250 230L336 205M250 310L210 390M250 310L294 390"/><circle cx="765" cy="160" r="28"/><path d="M765 190V310M765 224L755 292M765 230L833 227M765 310L733 390M765 310L791 390"/></g><path d="M335 205L405 ${100 + time * 40}M833 227L900 ${170 + time * 40}" stroke="#e9b767" stroke-width="7"/><text x="24" y="480" fill="#778f9f" font-size="18" font-family="sans-serif">MOCK UI FIXTURE · NOT UNITY CAPTURE / AI RESULT</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function loadedState() {
  const item = newJob(clip);
  item.id = 'fixture-job'; item.status = 'review'; item.frames = [0, .2, .4, .6, .8, 1, 1.2].map((time, i) => ({ id: `f${i}`, time, url: frameData(time) }));
  item.windows = [{ id: 'hit-one', start: .25, end: .43, sourceIndex: -1, reason: '모의 결과: 검을 휘두르는 구간. 실제 AI 분석이 아닙니다.', uncertain: false }, { id: 'hit-two', start: .72, end: .9, sourceIndex: -1, reason: '모의 결과: 두 번째 타격 후보.', uncertain: true }];
  item.analysisStatus = 'uncertain';
  return { ...structuredClone(initialState), projectPath: 'C:\\Mock\\FourTigerSword', connection: { ready: true, message: '모의 Unity 연결', unityVersion: '6000.3.10f1' }, ai: { available: true, authenticated: true, label: 'Codex 모의 연결' }, actorId: 'actor-1', actors: [{ id: 'actor-1', label: '[모의] 플레이어 캐릭터', weapons: [{ id: 'weapon-1', label: '[모의] 사인검', bone: 'RightHand' }] }], sources: [{ guid: sourceGuid, label: '[모의] 금 폼', type: 'MetalWeaponActionDataSO' }], targets: [{ sourceGuid, actionPath: 'Actions[0]', group: 'combo', label: '일반 공격 1단계', animationName: 'Attack_Slash_01', duration: 1.833, currentClip: structuredClone(clip), timeSettings: structuredClone(timeSettings), supported: true, snapshot: 'mock-snapshot', windows: [{ start: .2, end: .45, sourceIndex: 0 }, { start: .7, end: .92, sourceIndex: 2 }] }, { sourceGuid, actionPath: 'Actions[1]', group: 'combo', label: '일반 공격 2단계', animationName: 'Attack_Empty', duration: 1.1, currentClip: null, timeSettings: timeSettings.map(item => ({ ...item, value: item.path === 'Execution.ComboTransitionTime' ? .9 : item.value })), needsClipAssignment: true, supported: true, snapshot: 'mock-empty-snapshot', windows: [{ start: .2, end: .45, sourceIndex: 0 }, { start: .7, end: .92, sourceIndex: 2 }] }, { sourceGuid, actionPath: 'Actions[2]', group: 'combo', label: '일반 공격 3단계', animationName: 'Attack_Replace', duration: 1.833, currentClip: structuredClone(oldClip), timeSettings: structuredClone(timeSettings), supported: true, snapshot: 'mock-replace-snapshot', windows: [{ start: .2, end: .45, sourceIndex: 0 }, { start: .7, end: .92, sourceIndex: 2 }] }], groups: [{ sourceGuid, id: 'combo', label: '일반 콤보', supported: true }, { sourceGuid, id: 'skill', label: '스킬', supported: true }], jobs: [item], selectedJobId: item.id, settings: { actorId: 'actor-1' } };
}

const selected = () => state.jobs.find(item => item.id === state.selectedJobId);
const publish = () => window.webContents.send('aht:state', structuredClone(state));
const handlers = {
  getState: () => state,
  selectProject: () => { state = loadedState(); publish(); return state; },
  connectProject: () => state,
  installIntegration: () => ({ message: '모의 연동 설치' }),
  refreshCatalog: () => state,
  searchAnimations: async (_query, { mode = 'semantic' } = {}) => {
    state.search = { busy: true, progressText: '모의 검색: 140개 후보를 비교하고 있습니다.' }; publish();
    if (searchMock === 'pending') return new Promise(resolve => { finishSearch = () => { state.search = { busy: false, progressText: '' }; publish(); resolve(searchResponse(mode)); }; });
    state.search = { busy: false, progressText: '' }; publish();
    if (searchMock === 'error') throw new Error('모의 Codex 연결 실패');
    if (searchMock === 'empty') return { clips: [], mode, summary: '설명에 맞는 후보를 찾지 못했습니다. 무기와 동작을 다르게 설명해 보세요.', searchedCount: 140, truncated: false };
    return searchResponse(mode);
  },
  cancelAnimationSearch: () => { state.search = { busy: false, progressText: '' }; publish(); return { cancelled: true }; },
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
    const target = state.targets.find(item => item.sourceGuid === options.sourceGuid && item.actionPath === (options.mode === 'register' ? options.templatePath : options.actionPath));
    const changedClip = target?.needsClipAssignment || target?.currentClip && (target.currentClip.guid !== selected().clip.guid || target.currentClip.localId !== selected().clip.localId);
    previewAssignment = options.mode === 'update' && changedClip
      ? { stateName: target.animationName, clipName: selected().clip.name, clipPath: selected().clip.path, previousClipName: target.currentClip?.name || null, previousClipPath: target.currentClip?.path || null } : null;
    const actionDuration = options.timeOverrides.find(item => item.path === 'Execution.Duration')?.value ?? (options.mode === 'update' && !changedClip ? target?.duration : selected().clip.length);
    const editableTimeSettings = (target?.timeSettings || []).map(item => ({ ...item, min: item.path === 'Execution.Movement.MovementStartTime' ? .05 : item.min, max: item.path === 'Execution.Duration' ? selected().clip.length : item.path === 'Execution.Movement.MovementStartTime' ? .18 : actionDuration, value: item.path === 'Execution.Duration' ? actionDuration : item.value }));
    const invalidSettings = editableTimeSettings.filter(item => {
      const value = options.timeOverrides.find(override => override.path === item.path)?.value ?? item.value;
      return value < item.min || value > item.max;
    });
    previewValid = !missing && !invalidSettings.length;
    return { changeId: 'mock-change', canApply: previewValid, editableTimeSettings, clipAssignment: previewAssignment, controllerChanged: Boolean(previewAssignment) || options.mode === 'register', summary: '모의 변경 검토 · 원본 및 AI 분석은 실행하지 않습니다.', hitCountBefore: 2, hitCountAfter: selected().windows.length, damageBefore: 2, damageAfter: 3, damageNote: '모의 기본 피해 계수 합계', mapping: { retained: 2, removed: 0, added: 0 }, issues: missing ? ['슬래시 이펙트 시간을 보정하세요.'] : [], requiredTimeOverrides: missing ? [{ path: 'Feedback.Slash.SlashVFXStartTime', label: '슬래시 시작', value: 3, min: -1, max: selected().clip.length }] : invalidSettings, before: { animation: target?.animationName, duration: target?.duration }, after: { animation: target?.animationName, duration: actionDuration, comboTransitionTime: options.timeOverrides.find(item => item.path === 'Execution.ComboTransitionTime')?.value ?? target?.timeSettings.find(item => item.path === 'Execution.ComboTransitionTime')?.value }, warnings: [options.timeOverrides.find(item => item.path === 'Execution.ComboTransitionTime')?.value < Math.max(...selected().windows.map(hit => hit.end)) ? '마지막 타격 전에 다음 콤보로 전환합니다.' : ''].filter(Boolean), proposedStateName: options.mode === 'register' ? 'AHT_Sword_Slash_01' : '' };
  },
  applyChange: id => {
    assert(previewValid); assert.equal(id, 'mock-change'); saveCount++; selected().status = 'saved';
    selected().savedAssets = [{ path: 'Assets/Mock/Result.asset' }];
    if (previewAssignment) selected().savedAssets.push({ path: 'Assets/Mock/Result.controller' });
    if (!selected().copy) {
      const target = state.targets.find(item => item.sourceGuid === selected().sourceGuid && item.actionPath === selected().actionPath);
      target.needsClipAssignment = false;
      target.currentClip = structuredClone(selected().clip);
      target.duration = selected().timeOverrides.find(item => item.path === 'Execution.Duration')?.value ?? selected().clip.length;
      target.timeSettings = target.timeSettings.map(item => ({ ...item, value: selected().timeOverrides.find(override => override.path === item.path)?.value ?? item.value }));
    }
    publish(); return { assets: selected().savedAssets };
  },
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
const submitSearch = query => evaluate(`document.getElementById('animation-query').value=${JSON.stringify(query)};document.getElementById('search-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
async function change(id, value) {
  await evaluate(`(() => {const input=document.getElementById(${JSON.stringify(id)});if(!input)throw new Error('Missing '+${JSON.stringify(id)});${typeof value === 'boolean' ? `input.checked=${value}` : `input.value=${JSON.stringify(String(value))}`};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await new Promise(resolve => setTimeout(resolve, 70));
}
async function screenshot(name) { await new Promise(resolve => setTimeout(resolve, 200)); fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG()); }

async function timingSmoke() {
  const original = structuredClone(state);
  const item = selected();
  item.sourceGuid = sourceGuid; item.actionPath = 'Actions[0]';
  state.targets[0].duration = 1.5;
  item.timeOverrides = [{ path: 'Execution.ComboTransitionTime', value: 1.4 }, { path: 'Execution.Duration', value: 1.5 }];
  item.timingSuggestions = {
    comboTransition: { time: 1.05, frameId: 'f5', reason: '모의 제안: 마지막 베기 후 다음 동작을 잇는 지점입니다.', uncertain: false },
    actionEnd: { time: 1.25, frameId: 'f6', reason: '모의 제안: 자세가 회복되어 이동으로 돌아갈 수 있습니다.', uncertain: false }
  };
  publish();
  await until('document.querySelectorAll("[data-timing-marker]").length === 2 && document.querySelectorAll("[data-timing-suggestion]").length === 2', 'actual and AI timing markers');
  assert.equal(await evaluate('document.querySelector("[data-apply-timing=actionEnd]").disabled'), true, 'Applying end alone cannot cut the existing combo time');
  assert.equal(await evaluate('document.getElementById("apply-all-timing-suggestions").disabled'), false, 'A valid pair can be adopted atomically');
  await click('apply-all-timing-suggestions');
  await until('document.getElementById("override-Execution.Duration").value === "1.25"', 'adopt both AI timings');
  assert.deepEqual(selected().timeOverrides, [{ path: 'Execution.ComboTransitionTime', value: 1.05 }, { path: 'Execution.Duration', value: 1.25 }]);
  assert.equal(selected().reviewed, false);
  await evaluate('(() => { const seek = document.getElementById("seek"); seek.value = "1.45"; seek.dispatchEvent(new Event("input", {bubbles:true})); })()');
  assert.match(await evaluate('document.getElementById("time-readout").textContent'), /1\.450.*1\.500/, 'Review can seek beyond attack end to the full clip end');
  await evaluate('document.querySelector("[data-timing-marker=comboTransition]").dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowRight", bubbles:true}))');
  await until('document.getElementById("override-Execution.ComboTransitionTime").value === "1.067"', 'keyboard timing marker adjustment');
  const pointer = await evaluate('(() => { const marker = document.querySelector("[data-timing-marker=actionEnd]").getBoundingClientRect(), timeline = document.getElementById("timeline").getBoundingClientRect(); return {startX:Math.round(marker.x+marker.width/2), y:Math.round(marker.y+marker.height-7), endX:Math.round(timeline.x+timeline.width*1.35/1.5)}; })()');
  window.webContents.sendInputEvent({ type: 'mouseMove', x: pointer.startX, y: pointer.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: pointer.startX, y: pointer.y });
  window.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: pointer.endX, y: pointer.y });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: pointer.endX, y: pointer.y });
  await until('Math.abs(Number(document.getElementById("override-Execution.Duration").value) - 1.35) < .01', 'pointer drag changes actual attack end');
  assert.ok(Math.abs(selected().timeOverrides.find(value => value.path === 'Execution.Duration').value - 1.35) < .01);
  await change('override-Execution.ComboTransitionTime', 0);
  assert.equal(await evaluate('!!document.querySelector("[data-early-combo-warning]")'), true, 'Zero allows an immediate combo and must warn when hits remain');
  assert.match(await evaluate('document.getElementById("attack-timings").textContent'), /0초는 즉시 전환/);
  await change('override-Execution.ComboTransitionTime', .5);
  assert.equal(await evaluate('!!document.querySelector("[data-early-combo-warning]")'), true, 'Early manual combo timing warns without preventing editing');
  await click('tab-save');
  await change('override-Execution.Movement.MovementStartTime', .15);
  await change('save-reviewed-check', true); await click('preview-change');
  await until('!!document.getElementById("timing-diff-warnings")', 'manual early combo warning in save diff');
  assert.match(await evaluate('document.getElementById("timing-diff-warnings").textContent'), /마지막 타격/);
  assert.equal(await evaluate('document.getElementById("override-Execution.Movement.MovementStartTime").min'), '0.05', 'Preview correction metadata overrides the original catalog limits');
  assert.equal(await evaluate('document.getElementById("override-Execution.Movement.MovementStartTime").max'), '0.18', 'A stricter preview maximum is preserved within attack end bounds');
  assert.equal(await evaluate('document.getElementById("override-Execution.Movement.MovementStartTime").value'), '0.15', 'Draft numeric override remains stronger than preview values');
  await click('tab-hits');
  await evaluate('document.querySelector("[data-apply-timing=comboTransition]").click()');
  await until('document.getElementById("override-Execution.ComboTransitionTime").value === "1.05"', 'adopt individual combo proposal');
  const proposalBeforeEdit = structuredClone(selected().timingSuggestions);
  await change('override-Execution.Duration', 1.3);
  assert.deepEqual(selected().timingSuggestions, proposalBeforeEdit, 'Manual edits preserve proposal reasoning');
  await screenshot('08-mock-animation-timings');
  selected().timingError = '모의 정밀 분석이 중단되었습니다. 기존 제안과 프레임을 직접 검토하세요.'; publish();
  await until('!!document.getElementById("timing-analysis-error")', 'timing failure remains visible alongside proposal reasoning');
  assert.match(await evaluate('document.getElementById("attack-timings").textContent'), /모의 정밀 분석이 중단.*마지막 베기/);
  selected().timingSuggestions = null; publish();
  await until('document.querySelectorAll("[data-timing-suggestion]").length === 0', 'missing suggestions after timing failure');
  assert.match(await evaluate('document.getElementById("timing-analysis-error").textContent'), /모의 정밀 분석이 중단/);
  selected().timingSuggestions = structuredClone(proposalBeforeEdit); selected().timingError = '';
  selected().timingSuggestions.comboTransition.uncertain = true;
  selected().timingSuggestions.actionEnd.time = null; publish();
  await until('document.querySelector("[data-apply-timing=comboTransition]").disabled && document.querySelector("[data-apply-timing=actionEnd]").disabled', 'uncertain and absent suggestions cannot apply');
  assert.equal(await evaluate('document.querySelectorAll("[data-timing-suggestion]").length'), 1, 'Null proposal has no invented zero-time marker');
  assert.equal(await evaluate('document.getElementById("apply-all-timing-suggestions").disabled'), true);
  selected().timingSuggestions.comboTransition = { time: 1.4, frameId: 'f6', reason: '서로 충돌하는 모의 제안', uncertain: false };
  selected().timingSuggestions.actionEnd = { time: 1.1, frameId: 'f5', reason: '서로 충돌하는 모의 제안', uncertain: false }; publish();
  await until('document.getElementById("apply-all-timing-suggestions").disabled', 'conflicting AI pair blocked');
  state.capabilities.attackTiming = false; publish();
  await until('document.getElementById("override-Execution.Duration").disabled', 'older integration upgrade guard');
  assert.equal(await evaluate('document.querySelector("[data-timing-marker=actionEnd]").disabled'), true);
  assert.match(await evaluate('document.getElementById("attack-timings").textContent'), /Unity 연동 업데이트/);
  state.capabilities.attackTiming = true; selected().pendingSave = { requestId: 'pending-timing-save' }; publish();
  await until('document.getElementById("override-Execution.ComboTransitionTime").disabled', 'pending saves lock timing controls');
  selected().pendingSave = null; state.targets[0].group = 'skill'; publish();
  await until('!document.querySelector("[data-timing-marker=comboTransition]")', 'noncombo target hides combo marker');
  assert.equal(await evaluate('!!document.getElementById("override-Execution.ComboTransitionTime")'), false);
  state.targets[0].timeSettings.find(field => field.path === 'Feedback.Trail.TrailEndTime').active = false;
  state.targets[0].timeSettings.find(field => field.path === 'Feedback.Trail.TrailEndTime').value = 9;
  state.targets[0].snapshot = 'mock-inactive-timing-refresh';
  publish();
  await until('document.getElementById("override-Feedback.Trail.TrailEndTime").value === "9"', 'inactive timing field fixture');
  assert.equal(await evaluate('document.getElementById("override-Feedback.Trail.TrailEndTime").hasAttribute("max")'), false, 'Inactive settings do not inherit attack end bounds');
  assert.equal(await evaluate('document.getElementById("override-Feedback.Trail.TrailEndTime").getAttribute("aria-invalid")'), null);
  selected().windows = [{ ...selected().windows[0], start: .2, end: .533333 }];
  selected().duration = 1.666667; selected().clip.length = 1.666667;
  selected().timeOverrides = [{ path: 'Execution.Duration', value: .533333 }]; publish();
  await until('document.getElementById("override-Execution.Duration").value === "0.533333"', 'fractional last-hit boundary fixture');
  const lowerBoundaryUpdates = calls.filter(call => call.name === 'updateJob').length;
  await evaluate('document.querySelector("[data-timing-marker=actionEnd]").dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowLeft", bubbles:true}))');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(calls.filter(call => call.name === 'updateJob').length, lowerBoundaryUpdates + 1);
  assert.equal(selected().timeOverrides.find(field => field.path === 'Execution.Duration').value, .533333, 'Keyboard millisecond rounding cannot undercut a fractional last-hit end');
  selected().timeOverrides = [{ path: 'Execution.Duration', value: 1.666667 }]; publish();
  await until('document.getElementById("override-Execution.Duration").value === "1.666667"', 'fractional clip-end boundary fixture');
  const upperBoundaryUpdates = calls.filter(call => call.name === 'updateJob').length;
  await evaluate('document.querySelector("[data-timing-marker=actionEnd]").dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowRight", bubbles:true}))');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(calls.filter(call => call.name === 'updateJob').length, upperBoundaryUpdates + 1);
  assert.equal(selected().timeOverrides.find(field => field.path === 'Execution.Duration').value, 1.666667, 'Keyboard millisecond rounding cannot exceed a fractional clip end');
  state = original; publish();
  await until('!document.querySelector("[data-timing-marker=comboTransition]") && !document.getElementById("override-Execution.Duration").disabled', 'restore primary fixture');
  await evaluate('(() => { const seek = document.getElementById("seek"); seek.value = "0"; seek.dispatchEvent(new Event("input", {bubbles:true})); })()');
}

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
  assert.equal(await evaluate('document.getElementById("install-integration").textContent'), 'Unity 연동 업데이트', 'Connected projects can update an older bridge');
  assert.equal(await evaluate('document.querySelectorAll(".hit-card").length'), 2);
  assert.equal(await evaluate('document.getElementById("analyze-selected").disabled'), false);
  await timingSmoke();
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
  assert.equal(await evaluate('document.querySelectorAll("[data-time-override]").length'), 9, 'Hit review exposes attack end and combo alongside supported timing settings');
  assert.equal(await evaluate('document.getElementById("override-Execution.ComboTransitionTime").value'), '1.7');
  assert.equal(await evaluate('document.getElementById("override-Execution.Duration").value'), '1.833', 'Same-clip edits preserve the current attack end until corrected');
  assert.equal(await evaluate('document.getElementById("override-Execution.Duration").max'), '1.5', 'Attack end cannot exceed clip duration');
  assert.equal(await evaluate('document.getElementById("override-Feedback.Slash.SlashVFXStartTime").min'), '-1');
  assert.equal(await evaluate('document.getElementById("override-Execution.Duration").getAttribute("aria-invalid")'), 'true', 'Invalid attack end is exposed prominently');
  await change('override-Execution.ComboTransitionTime', 1.3);
  await change('override-Execution.Duration', 1.5);
  assert.equal(await evaluate('document.getElementById("override-Execution.ComboTransitionTime").getAttribute("aria-invalid")'), null);
  await change('save-reviewed-check', true);
  await until('!document.getElementById("preview-change").disabled', 'reviewed preview');
  await click('preview-change');
  await until('!!document.getElementById("apply-change")', 'change preview');
  assert.equal(saveCount, 0, 'Preview must not save');
  assert.match(await evaluate('document.getElementById("save-panel").textContent'), /기본 피해 계수/);
  assert.match(await evaluate('document.getElementById("duration-diff").textContent'), /1\.833 s.*1\.500 s/);
  assert.equal(await evaluate('!!document.getElementById("clip-assignment-diff")'), false, 'Keeping the same clip only corrects the action duration and settings');
  assert.equal(await evaluate('document.getElementById("override-Execution.ComboTransitionTime").value'), '1.3', 'Draft timing overrides take priority over preview field defaults');
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
  const emptyOption = await evaluate(`(() => {const option = [...document.getElementById('target-select').options].find(item => item.value === 'Actions[1]');return {disabled: option.disabled, label: option.textContent};})()`);
  assert.equal(emptyOption.disabled, false, 'An existing state without Motion must remain selectable');
  assert.match(emptyOption.label, /클립 없음 · 저장 시 연결/);
  await change('target-select', 'Actions[1]');
  assert.deepEqual(selected().timeOverrides, [], 'Changing the target clears timing overrides from the previous attack');
  assert.equal(await evaluate('document.getElementById("override-Execution.ComboTransitionTime").value'), '0.9');
  assert.match(await evaluate('document.getElementById("clip-assignment-notice").textContent'), /Attack_Empty/);
  assert.match(await evaluate('document.getElementById("clip-assignment-notice").textContent'), /Sword_Slash_01/);
  await change('save-reviewed-check', true);
  await click('preview-change');
  await until('!!document.getElementById("clip-assignment-diff")', 'missing clip assignment preview');
  const assignmentDiff = await evaluate('document.getElementById("clip-assignment-diff").textContent');
  assert.match(assignmentDiff, /클립 없음 → \[모의\] Sword_Slash_01/);
  assert.match(assignmentDiff, /복제한 Animator Controller/);
  assert.equal(saveCount, 1, 'Assignment preview must not save');
  assert.equal(state.targets[1].needsClipAssignment, true);
  await change('copy-check', false);
  assert.equal(await evaluate('!!document.getElementById("apply-change")'), false, 'Changing copy mode invalidates the assignment preview');
  await change('save-reviewed-check', true);
  await click('preview-change');
  await until('!!document.getElementById("apply-change")', 'original controller assignment preview');
  assert.match(await evaluate('document.getElementById("clip-assignment-diff").textContent'), /원본 Animator Controller/);
  await evaluate('document.getElementById("clip-assignment-diff").scrollIntoView({block:"center"})');
  await screenshot('05-mock-missing-clip-diff');
  await click('apply-change');
  await until('!document.getElementById("clip-assignment-notice") && document.getElementById("save-panel").textContent.includes("Result.controller")', 'missing clip assignment saved');
  assert.equal(saveCount, 2);
  assert.equal(state.targets[1].needsClipAssignment, false);
  const attachmentPreview = calls.filter(call => call.name === 'previewChange').at(-1).args[0];
  assert.equal(attachmentPreview.mode, 'update');
  assert.equal(attachmentPreview.actionPath, 'Actions[1]');
  assert.equal(attachmentPreview.copy, false);
  await change('target-select', 'Actions[2]');
  assert.match(await evaluate('document.getElementById("clip-assignment-notice").textContent'), /Sword_Old.*교체/);
  assert.match(await evaluate('document.getElementById("attack-duration-change").textContent'), /1\.833 s.*1\.500 s/);
  await change('override-Execution.ComboTransitionTime', 1.3);
  await change('override-Execution.Movement.MovementStartTime', .15);
  await change('copy-check', true);
  await change('save-reviewed-check', true);
  await click('preview-change');
  await until('!!document.getElementById("apply-change")', 'occupied clip replacement copy preview');
  assert.match(await evaluate('document.getElementById("clip-assignment-diff").textContent'), /기존 클립 교체.*Sword_Old → \[모의\] Sword_Slash_01.*Old\.fbx.*복제한 Animator Controller/);
  assert.equal(saveCount, 2, 'Occupied clip replacement preview must not save');
  await click('apply-change');
  await until('document.getElementById("save-panel").textContent.includes("Result.controller") && !document.getElementById("apply-change")', 'occupied clip replacement copied');
  assert.equal(saveCount, 3);
  assert.equal(state.targets[2].currentClip.name, oldClip.name, 'Copy mode leaves the original clip unchanged');
  assert.equal(state.targets[2].duration, 1.833);
  assert.equal(state.targets[2].timeSettings[0].value, 1.7);
  await change('copy-check', false);
  await change('save-reviewed-check', true);
  await click('preview-change');
  await until('!!document.getElementById("apply-change")', 'occupied clip replacement original preview');
  assert.match(await evaluate('document.getElementById("clip-assignment-diff").textContent'), /원본 Animator Controller/);
  await evaluate('document.getElementById("clip-assignment-diff").scrollIntoView({block:"center"})');
  await screenshot('06-mock-existing-attack-edit');
  await click('apply-change');
  await until('!document.getElementById("clip-assignment-notice") && !document.getElementById("apply-change")', 'occupied clip replacement original saved');
  assert.equal(saveCount, 4);
  assert.equal(state.targets[2].animationName, 'Attack_Replace', 'Keep the existing state name');
  assert.equal(state.targets[2].currentClip.name, clip.name);
  assert.equal(state.targets[2].duration, 1.5);
  assert.equal(state.targets[2].timeSettings[0].value, 1.3);
  assert.equal(state.targets[2].timeSettings[1].value, .15);
  assert.deepEqual(calls.filter(call => call.name === 'previewChange').at(-1).args[0].timeOverrides, [{ path: 'Execution.ComboTransitionTime', value: 1.3 }, { path: 'Execution.Movement.MovementStartTime', value: .15 }]);
  await evaluate('document.querySelector("[data-save-mode=register]").click()');
  await until('!!document.getElementById("template-select")', 'register mode');
  assert.equal(selected().mode, 'register');
  await change('template-select', 'Actions[0]');
  assert.deepEqual(selected().timeOverrides, [], 'Changing to a different template clears prior attack timing edits');
  await change('override-Execution.ComboTransitionTime', 1.3);
  requireTimeOverrides = true;
  await change('save-reviewed-check', true);
  await click('preview-change');
  await until('!!document.getElementById("override-Feedback.Slash.SlashVFXStartTime")', 'time override editor');
  assert.equal(await evaluate('document.getElementById("override-Feedback.Slash.SlashVFXStartTime").min'), '-1');
  await change('override-Feedback.Slash.SlashVFXStartTime', -1);
  assert.deepEqual(selected().timeOverrides, [{ path: 'Execution.ComboTransitionTime', value: 1.3 }, { path: 'Feedback.Slash.SlashVFXStartTime', value: -1 }]);
  assert.equal(await evaluate('!!document.getElementById("override-Feedback.Slash.SlashVFXStartTime")'), true, 'Override remains editable when preview invalidates');
  await change('save-reviewed-check', true);
  await click('preview-change');
  await until('!!document.getElementById("apply-change")', 'register after time correction');
  window.setContentSize(950, 820);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'No horizontal overflow at narrow width');
  await screenshot('04-mock-narrow');
  assert.equal(await evaluate('document.getElementById("search-mode").value'), 'semantic');
  assert.equal(await evaluate('document.getElementById("animation-query").maxLength'), 600);
  await submitSearch('앞으로 돌진하며 검을 두 번 휘두르는 공격');
  await until('document.querySelectorAll("[data-result]").length === 2', 'natural Korean search results');
  assert.deepEqual(calls.filter(call => call.name === 'searchAnimations').at(-1).args, ['앞으로 돌진하며 검을 두 번 휘두르는 공격', { mode: 'semantic' }]);
  assert.match(await evaluate('document.getElementById("search-results").textContent'), /검 베기와 관련된 후보 2개.*140개 후보 검토.*추천 1.*실제 돌진 여부/);
  assert.equal(await evaluate('document.getElementById("add-search-results").disabled'), true, 'Search does not select or add results automatically');
  assert.equal(state.jobs.length, 1, 'Search alone does not queue an animation');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Natural search results fit the narrow layout');
  window.setContentSize(1550, 980);
  await new Promise(resolve => setTimeout(resolve, 150));
  await evaluate('window.scrollTo(0,0)');
  await evaluate('document.getElementById("search-form").scrollIntoView({block:"start"})');
  await screenshot('07-mock-natural-search');
  await change('search-mode', 'name');
  assert.equal(await evaluate('document.getElementById("search-results").hidden'), true, 'Changing mode invalidates results');
  state.ai = { available: false, authenticated: false }; publish();
  await submitSearch('Slash');
  await until('document.querySelectorAll("[data-result]").length === 2', 'name search without AI');
  assert.equal(calls.filter(call => call.name === 'searchAnimations').at(-1).args[1].mode, 'name');
  assert.equal(await evaluate('document.querySelectorAll(".result-rank").length'), 0);
  state.ai = { available: true, authenticated: true }; publish();
  searchMock = 'empty';
  await change('search-mode', 'semantic');
  await submitSearch('하늘을 날며 활을 쏘는 동작');
  await until('document.getElementById("search-results").textContent.includes("설명에 맞는 후보를 찾지 못했습니다")', 'empty search explanation');
  assert.equal(await evaluate('document.querySelectorAll("[data-result]").length'), 0);
  assert.equal(await evaluate('!!document.getElementById("add-search-results")'), false);
  searchMock = 'error';
  await submitSearch('검으로 베는 공격');
  await until('!!document.getElementById("use-name-search")', 'semantic failure offers name fallback');
  assert.match(await evaluate('document.getElementById("search-results").textContent'), /모의 Codex 연결 실패/);
  await click('use-name-search');
  assert.equal(await evaluate('document.getElementById("search-mode").value'), 'name');
  searchMock = 'success';
  await submitSearch('Slash');
  await until('document.querySelectorAll("[data-result]").length === 2', 'name fallback result');
  await change('search-mode', 'semantic');
  searchMock = 'pending';
  await submitSearch('회전하면서 검을 휘두르는 공격');
  await until('document.getElementById("search-progress").textContent.includes("140개 후보를 비교")', 'independent search progress');
  assert.equal(await evaluate('document.getElementById("analyze-selected").disabled'), true, 'Search prevents concurrent Unity capture');
  assert.equal(await evaluate('document.getElementById("play-pause").disabled'), false, 'Existing animation review remains available during search');
  assert.equal(state.busy, false, 'Search progress is separate from the global operation lock');
  assert.equal(await evaluate('document.getElementById("drop-zone").disabled'), true, 'Search blocks conflicting file imports');
  await click('cancel-search');
  await until('document.getElementById("search-results").textContent.includes("검색을 취소했습니다") && document.getElementById("cancel-search").hidden', 'search cancelled');
  finishSearch();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await evaluate('document.querySelectorAll("[data-result]").length'), 0, 'Late cancelled search results stay discarded');
  assert.equal(await evaluate('document.getElementById("search-results").textContent.includes("검색을 취소했습니다")'), true);
  await submitSearch('다른 캐릭터로 전환하기 전 검색');
  await until('!document.getElementById("cancel-search").hidden', 'search before actor switch');
  state.actorId = 'actor-2'; state.settings.actorId = 'actor-2'; publish();
  await until('document.getElementById("search-results").hidden', 'actor switch clears results');
  finishSearch();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await evaluate('document.querySelectorAll("[data-result]").length'), 0, 'Old actor search response stays discarded');
  state.actorId = 'actor-1'; state.settings.actorId = 'actor-1'; publish();
  await new Promise(resolve => setTimeout(resolve, 80));
  searchMock = 'success';
  await submitSearch('검을 두 번 휘두르는 공격');
  await until('document.querySelectorAll("[data-result]").length === 2', 'fresh multi-clip results');
  const originalProjectPath = state.projectPath;
  state.projectPath = 'C:\\Mock\\OtherProject'; publish();
  await until('document.getElementById("search-results").hidden', 'project switch clears results');
  state.projectPath = originalProjectPath; publish();
  await new Promise(resolve => setTimeout(resolve, 80));
  await submitSearch('검을 두 번 휘두르는 공격');
  await until('document.querySelectorAll("[data-result]").length === 2', 'multi-clip selection after context reset');
  await evaluate('document.querySelector("[data-result=\\"0\\"]").click()');
  await click('add-search-results');
  await until('document.getElementById("job-count").textContent === "2"', 'queued search selection');
  assert.equal(saveCount, 4, 'Register preview and search must not auto-save');
  assert.deepEqual(errors, [], 'Renderer console errors');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ kind: 'mock-ui-smoke', actualUnityCapture: false, actualAiAnalysis: false, checks: ['empty state', 'real sandboxed preload IPC', 'composite preview', 'playback and frame step', 'manual hit edit/add/delete', 'sparse existing hit mapping', 'review gate', 'damage and mapping diff', 'explicit apply only', 'uncertain save editing/removal/reanalysis lock', 'late receipt success notice', 'missing Motion target selection', 'clip attachment preview with copy/original controller', 'explicit existing-state clip attachment apply', 'existing occupied clip replacement in copy and original modes', 'all attack timing fields editable before preview', 'selected clip duration bounds', 'same clip duration correction', 'timing draft priority and target isolation', 'registration mode', 'negative time sentinel', 'override draft persistence', '950px responsive layout', 'natural Korean query and ranked explanations', 'name search without AI', 'empty search summary', 'AI failure name fallback', 'independent search progress and cancellation', 'late cancelled result rejection', 'actor and project search context invalidation', 'multiple search result selection'], calls: calls.map(call => call.name), screenshots: ['01-empty.png', '02-mock-review.png', '03-mock-save-diff.png', '04-mock-narrow.png', '05-mock-missing-clip-diff.png', '06-mock-existing-attack-edit.png', '07-mock-natural-search.png'] }, null, 2));
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
  const { CodexAnalyzer: StartupCodex, ClaudeCodeAnalyzer: StartupClaude } = require('../src/ai.cjs');
  for (const Analyzer of [StartupCodex, StartupClaude]) Analyzer.prototype.status = async () => ({ available: false, authenticated: false, label: '시작 테스트 · AI 연결 생략' });
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
  require('../src/ai.cjs').CliAnalyzer.prototype.analyze = async () => { throw new Error('AI analysis must not be re-run in media review'); };
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
