'use strict';

const api = window.baekho;
const $ = id => document.getElementById(id);
const list = value => Array.isArray(value) ? value.filter(Boolean) : [];
const copy = value => JSON.parse(JSON.stringify(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const tuning = globalThis.CombatTuning;
const fmt = value => finite(value) ? Number(value.toFixed(4)).toString() : '—';
// Unity serializes float32 values as doubles. Display meaningful precision
// without changing the original AI-generated request values.
const inputNumber = value => finite(value) ? Number(value.toPrecision(7)).toString() : '';
const node = (tag, value, className) => {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = String(value ?? '');
  if (className) element.className = className;
  return element;
};
const option = (select, label, value) => { const item = node('option', label); item.value = value; select.append(item); };
const parameterName = spec => ({ 'Normal combo knockback': '일반 공격 넉백', 'Normal combo camera impulse': '타격 카메라 반응', 'Player hit stop': '플레이어 히트스톱', 'Hit stop': '히트스톱', Mode: '적용 방식', Duration: '지속 시간', Delay: '시작 지연', Frequency: '진동 주파수', Amplitude: '진동 크기', Clock: '시간 기준', Scope: '정지 대상', Stacking: '중첩 방식', TargetWeight: '피격 대상 비중', FovOffset: '시야각 변화', ReturnDuration: '복귀 시간', Position: '위치 이동', Rotation: '회전', Strength: '충격 세기', Attack: '가속', Release: '감쇠', Envelope: '세기 곡선' })[spec.label] || spec.label || spec.id;
const targetName = id => String(id || '').replace(/^step\.(\d+)/, (_, n) => `${Number(n) + 1}단계`).replace(/\.hit\.(\d+)/, (_, n) => ` · ${Number(n) + 1}타격`);
const enumName = value => ({ Inherit: '원본 유지', Off: '끄기', Override: '직접 설정', Global: '전체', Attacker: '공격자', Victim: '피격자', Both: '공격자와 피격자', Scaled: '게임 시간', Unscaled: '실시간', World: '월드 방향', Local: '로컬 방향', Screen: '화면 방향', Additive: '더하기', Max: '큰 값 우선', Replace: '교체' })[value] || value;
const captureStatusName = value => ({ complete: '완전 캡처', incomplete: '불완전 캡처', truncated: '캡처 일부 누락', disabled: '캡처 해제', 'missing-hit': '대상 명중 없음' })[value] || value || '기록 없음';
const unitName = spec => spec.unit === '× baseline' ? '기준 배율' : spec.unit === 'seconds' || spec.unit === 's' ? '초' : spec.unit || '';
const candidateName = (candidate, index = 0) => candidate?.label || candidate?.id || `후보 ${index + 1}`;
const actionIdOf = request => request?.actionId || 'normal-combo';
const actionName = id => ({ 'normal-combo': '일반 공격 전체 콤보', heavy: '강공격', skill: '스킬', ultimate: '궁극기' })[id] || (/^normal-\d+$/.test(id || '') ? `일반 공격 ${id.slice(7)}타` : id || '일반 공격 전체 콤보');
const compactSourceLabel = label => typeof label === 'string' ? label.split(' / Assets/')[0] : '';
function sourceActions(source) {
  return list(source?.actions).length ? list(source.actions) : source ? [{ ...source, id: 'normal-combo', label: '일반 공격 전체 콤보', available: !source.error, unavailableReason: source.error }] : [];
}
const state = {
  snapshot: null, catalog: { adapters: [] }, selection: null, request: null, source: null,
  busy: 0, refreshing: false, starting: false, cancelRequested: false,
  activeRunId: null, selectedRunId: null, reportBundle: null, reportSignature: '',
  reportLoading: false, reportGeneration: 0, view: 'setup', lastHistoryKey: '',
  wasRunning: false, projectGeneration: 0, generating: false, generationCancelled: false,
  requestOrigin: 'draft', generatedSignature: '',
  selectedActions: [], actionDrafts: Object.create(null), actionPanels: new Map(), selectionControls: [],
};

function message(text, error = false) {
  $('messageText').textContent = text;
  $('message').classList.toggle('error', error);
  $('message').hidden = !text;
}
async function operation(action, options = {}) {
  state.busy++;
  updateControls();
  try { return await action(); }
  catch (error) { message(error?.message || String(error), true); return undefined; }
  finally { state.busy--; updateControls(); if (options.refresh) await refresh(); }
}
function showView(view) {
  const changed = state.view !== view;
  state.view = view;
  for (const name of ['setup', 'compare']) {
    const selected = name === view;
    $(`${name}Panel`).hidden = !selected;
    $(`${name}Tab`).classList.toggle('active', selected);
    $(`${name}Tab`).setAttribute('aria-selected', String(selected));
  }
  if (view === 'setup') stop();
  if (changed) window.scrollTo({ top: 0 });
}
function dateLabel(date, withTime = true) {
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(parsed) : '날짜 정보 없음';
}
function runStatus(run) {
  const status = String(run.status || '').toLowerCase();
  if (status === 'conditions-mismatch') return '조건 불일치';
  if (status === 'conditions-unavailable') return '조건 확인 불가';
  if (status === 'incomplete') return '미완료';
  if (status === 'no-hits') return '명중 없음';
  if (status.includes('cancel')) return '취소됨';
  if (status.includes('fail') || status.includes('error')) return '오류';
  if (status.includes('run') || status.includes('progress')) return '실행 중';
  if (status.includes('complete') || status.includes('success')) return '완료';
  return run.completedCount >= run.candidateCount && run.candidateCount > 0 ? '완료' : run.status || '결과';
}
function running() { return state.starting || Boolean(state.snapshot?.connection?.running) || Boolean(state.activeRunId && state.wasRunning); }
function generating() { return state.generating || Boolean(state.snapshot?.ai?.generating); }
function locked() { const connection = state.snapshot?.connection; return state.busy > 0 || running() || generating() || Boolean(connection?.isPlaying || connection?.isCompiling); }
function generationSignature() { return JSON.stringify([state.request?.adapterId, state.request?.sourceGuid, actionIdOf(state.request), $('goal').value.trim(), Number($('candidateTotal').value)]); }
function requestReady() { return list(state.request?.candidates).length > 0 && state.generatedSignature === generationSignature(); }
function adapters() { return list(state.catalog?.adapters); }
function locate(request) {
  const adapter = adapters().find(item => item.id === request?.adapterId);
  const source = list(adapter?.sources).find(item => item.guid === request?.sourceGuid);
  const action = sourceActions(source).find(item => item.id === actionIdOf(request));
  return { adapter, source, action };
}
function currentAction() { return locate(state.selection).action; }
function parametersOf(action, version) { return list(version === 1 && action?.legacyParameters?.length ? action.legacyParameters : action?.parameters); }
function currentParameters() { return parametersOf(currentAction(), state.request?.schemaVersion); }
function currentCurves() { return list(currentAction()?.curves); }
const conditionKeys = ['durationSeconds', 'seed', 'recordVideo', 'includeSourceControl', 'scenarioMode', 'precisionCapture', 'precisionTargetId', 'repeatCount'];
function conditionsOf(request) { return Object.fromEntries(conditionKeys.filter(key => request?.[key] !== undefined).map(key => [key, request[key]])); }
function designOptions() { return { mode: $('generationMode').value, strategy: $('generationStrategy').value,
  recipeId: $('recipeId').value, referenceCandidateId: $('referenceCandidate').value, feedback: $('refineFeedback').value,
  lockedIds: state.actionDrafts[state.selection?.actionId]?.options?.lockedIds || [] }; }
function markEdited(candidate, spec, request = state.request) {
  candidate.origin = 'manual'; candidate.revision = (candidate.revision || 0) + 1;
  if (spec?.id.endsWith('.mode') && candidate.values.find(item => item.id === spec.id)?.value === 0) {
    candidate.values = candidate.values.filter(item => item.id === spec.id || !tuning.channelContains(spec.id, item.id));
    candidate.curves = (candidate.curves || []).filter(item => !tuning.channelContains(spec.id, item.id));
  }
  if (spec && !spec.id.endsWith('.mode')) {
    const modeId = tuning.owningMode(spec.id, spec.targetId);
    const mode = list(locate(request).action?.parameters).find(item => item.id === modeId);
    const entry = mode && list(candidate.values).find(item => item.id === mode.id);
    if (entry) entry.value = 2;
    else if (mode) candidate.values.push({ id: mode.id, value: 2 });
    if (spec.id.endsWith('.camera.motion.fovOffset')) {
      const flagId = spec.id.slice(0, -'fovOffset'.length) + 'useFeelZoom';
      if (list(locate(request).action?.parameters).some(item => item.id === flagId)) {
        const flag = candidate.values.find(item => item.id === flagId);
        if (flag) flag.value = 0; else candidate.values.push({ id: flagId, value: 0 });
      }
    }
  }
  const draft = state.actionDrafts[actionIdOf(request)];
  if (draft) { draft.candidateId = ''; draft.observedRunId ||= draft.runId; draft.runId = null; }
  updateControls();
}
function reportTarget(bundle) {
  const report = bundle.report || {}, identity = { ...report, ...bundle.request }, target = locate(identity);
  return { ...target,
    actionLabel: report.actionLabel || target.action?.label || actionName(actionIdOf(identity)),
    sourceLabel: compactSourceLabel(report.sourceLabel || target.source?.label || identity.sourceGuid || '') };
}
function sourceError(source) { return list(source?.actions).length ? '' : source?.error; }
function actionAvailable() { const action = currentAction(); return Boolean(state.request && state.source && !sourceError(state.source) && action && action.available !== false && action.defaultRequest); }
function multiAction() { return state.selectedActions.length > 1; }
function clearActionDrafts() { state.selectedActions = []; state.actionDrafts = Object.create(null); }
function draftSignature(draft) { return JSON.stringify([draft.request?.adapterId, draft.request?.sourceGuid, actionIdOf(draft.request), draft.goal.trim(), Number(draft.count)]); }
function draftReady(draft) {
  const target = locate(draft?.request);
  return Boolean(draft && list(draft.request?.candidates).length > 0 && draft.generatedSignature === draftSignature(draft)
    && target.action?.available !== false && target.action?.defaultRequest && !sourceError(target.source));
}
function saveFocusedDraft() {
  if (!state.request || !state.selectedActions.includes(actionIdOf(state.request))) return;
  const id = actionIdOf(state.request), old = state.actionDrafts[id];
  state.actionDrafts[id] = Object.assign(old || {}, { request: state.request, requestOrigin: state.requestOrigin,
    generatedSignature: state.generatedSignature, goal: $('goal').value, count: Number($('candidateTotal').value),
    schema: old?.schema ?? JSON.stringify(currentAction()), candidateId: old?.candidateId || '', options: designOptions() });
}
function focusAction(id) {
  saveFocusedDraft();
  const draft = state.actionDrafts[id];
  if (!draft) return;
  state.request = draft.request; state.selection = { adapterId: draft.request.adapterId, sourceGuid: draft.request.sourceGuid, actionId: id };
  state.source = locate(state.selection).source || null;
  state.requestOrigin = draft.requestOrigin; state.generatedSignature = draft.generatedSignature;
  $('goal').value = draft.goal; $('candidateTotal').value = draft.count;
  $('duration').value = draft.request.durationSeconds; $('seed').value = draft.request.seed; $('recordVideo').checked = draft.request.recordVideo;
  for (const key of ['includeSourceControl', 'precisionCapture']) $(key).checked = draft.request[key] ?? false;
  $('scenarioMode').value = draft.request.scenarioMode || 'live'; $('repeatCount').value = draft.request.repeatCount || 1;
  $('precisionTargetId').value = draft.request.precisionTargetId || '';
  drawDesignOptions(draft);
  drawSelectors(); drawCandidates(); updateControls();
}
function actionConflict(ids) { return ids.includes('normal-combo') && ids.some(id => /^normal-\d+$/.test(id)); }
function toggleAction(id, selected) {
  if (locked()) return;
  saveFocusedDraft();
  const next = selected ? [...new Set([...state.selectedActions, id])] : state.selectedActions.filter(item => item !== id);
  if (next.length > 32) { message('한 번에 함께 저장할 동작은 최대 32개입니다.', true); drawActionSelection(); return; }
  if (actionConflict(next)) { message('일반 공격 전체 콤보와 개별 일반 공격은 같은 수치를 변경하므로 함께 선택할 수 없습니다. 전체 콤보를 해제한 뒤 개별 공격을 선택하세요.', true); drawActionSelection(); return; }
  const action = sourceActions(state.source).find(item => item.id === id);
  if (selected && (!action?.defaultRequest || action.available === false)) { message(action?.unavailableReason || '아직 테스트할 수 없는 동작입니다.', true); drawActionSelection(); return; }
  if (selected && !state.actionDrafts[id]) {
    const conditions = conditionsOf(state.request);
    const request = { ...copy(action.defaultRequest), ...conditions, ...state.selection, actionId: id, candidates: [] };
    state.actionDrafts[id] = { request, requestOrigin: 'draft', generatedSignature: '', goal: '묵직하지만 콤보 흐름은 끊기지 않는 타격감', count: 4, schema: JSON.stringify(action), candidateId: '' };
  }
  state.selectedActions = next;
  if (!selected) delete state.actionDrafts[id];
  if (!next.length) {
    state.request = null; state.generatedSignature = ''; state.selection.actionId = '';
    drawSelectors(); drawCandidates(); drawActionPanels(); updateControls(); message('테스트할 동작을 선택하세요.'); return;
  }
  focusAction(next.includes(state.selection?.actionId) ? state.selection.actionId : next[0]);
  drawActionPanels(); message(''); updateControls();
}
function drawActionSelection() {
  const host = $('actionSelection'); host.replaceChildren(); state.selectionControls = [];
  for (const action of sourceActions(state.source)) {
    const label = node('label', undefined, 'action-choice'), input = node('input'); input.type = 'checkbox'; input.checked = state.selectedActions.includes(action.id);
    input.setAttribute('data-action-id', action.id);
    input.setAttribute('aria-label', action.label || actionName(action.id));
    const available = action.available !== false && Boolean(action.defaultRequest);
    input.disabled = locked() || !available;
    label.title = available ? action.label || actionName(action.id) : action.unavailableReason || '준비가 필요한 동작입니다.';
    label.classList.toggle('selected', input.checked);
    input.addEventListener('change', () => toggleAction(action.id, input.checked));
    label.append(input, node('span', `${action.label || actionName(action.id)}${available ? '' : ' · 준비 필요'}`)); host.append(label);
    state.selectionControls.push({ input, available });
  }
  if (!sourceActions(state.source).length) host.append(node('span', '프로젝트를 연결하면 동작을 선택할 수 있습니다.', 'fine-print'));
}
function combinedRequest() {
  saveFocusedDraft();
  if (!multiAction()) throw new Error('함께 저장할 동작을 두 개 이상 선택하세요.');
  const adapter = locate(state.selection).adapter;
  if (adapter?.supportsCombinedExport !== true) throw new Error('이 프로젝트 어댑터는 여러 동작을 하나의 SO로 저장하는 기능을 지원하지 않습니다. Unity 연결 패키지와 어댑터를 업데이트하세요.');
  if (actionConflict(state.selectedActions)) throw new Error('전체 콤보와 개별 일반 공격을 함께 저장할 수 없습니다.');
  const selections = state.selectedActions.map(id => {
    const draft = state.actionDrafts[id];
    if (!draftReady(draft)) throw new Error(`${actionName(id)}의 현재 목표에 맞춰 후보를 생성하세요.`);
    if (!list(draft.request.candidates).some(candidate => candidate.id === draft.candidateId)) throw new Error(`${actionName(id)}의 최종 후보를 선택하세요.`);
    if (draft.request.adapterId !== state.selection.adapterId || draft.request.sourceGuid !== state.selection.sourceGuid || actionIdOf(draft.request) !== id) throw new Error('같은 원본의 동작만 함께 저장할 수 있습니다.');
    return { request: copy(validate(draft.request)), candidateId: draft.candidateId };
  });
  return { schemaVersion: 1, adapterId: state.selection.adapterId, sourceGuid: state.selection.sourceGuid, selections };
}
function replaceRequest(request, origin = 'draft') {
  if (request && (request.adapterId !== state.selection?.adapterId || request.sourceGuid !== state.selection?.sourceGuid)) clearActionDrafts();
  state.request = request ? copy(request) : null;
  if (request) state.selection = { adapterId: request.adapterId, sourceGuid: request.sourceGuid, actionId: actionIdOf(request) };
  state.requestOrigin = origin;
  state.generatedSignature = origin === 'draft' ? '' : generationSignature();
  state.source = locate(state.selection).source || null;
  if (request) {
    const id = actionIdOf(request);
    if (!state.selectedActions.includes(id)) {
      if (actionConflict([...state.selectedActions, id])) clearActionDrafts();
      state.selectedActions.push(id);
    }
    const old = state.actionDrafts[id];
    state.actionDrafts[id] = { ...old, request: state.request, requestOrigin: origin, generatedSignature: state.generatedSignature,
      goal: $('goal').value, count: Number($('candidateTotal').value), schema: JSON.stringify(currentAction()), candidateId: '', runId: null, options: old?.options || {} };
  }
  drawSelectors();
  drawCandidates();
  $('duration').value = state.request?.durationSeconds ?? 10;
  $('seed').value = state.request?.seed ?? 1701;
  $('recordVideo').checked = state.request?.recordVideo ?? true;
  for (const key of ['includeSourceControl', 'precisionCapture']) $(key).checked = state.request?.[key] ?? false;
  $('scenarioMode').value = state.request?.scenarioMode || 'live'; $('repeatCount').value = state.request?.repeatCount || 1;
  $('precisionTargetId').value = state.request?.precisionTargetId || '';
  drawDesignOptions(state.actionDrafts[actionIdOf(request)]);
  drawActionPanels();
  updateControls();
}
function chooseSource(adapterId, sourceGuid, actionId) {
  clearActionDrafts();
  const adapter = adapters().find(item => item.id === adapterId) || adapters()[0];
  const sources = list(adapter?.sources);
  const source = sources.find(item => item.guid === sourceGuid) || sources[0];
  const actions = sourceActions(source);
  const action = actions.find(item => item.id === actionId) || actions.find(item => item.available !== false && item.defaultRequest) || actions[0];
  // Selection must survive even when an adapter has no sources or an action
  // cannot yet create a request. Otherwise refresh silently picks adapter 0.
  state.selection = { adapterId: adapter?.id || '', sourceGuid: source?.guid || '', actionId: action?.id || '' };
  if (action?.defaultRequest) {
    replaceRequest({ ...action.defaultRequest, adapterId: adapter.id, sourceGuid: source.guid, actionId: action.id, candidates: [] });
  }
  else {
    replaceRequest(null);
  }
  message('');
}
function reconcileSelection(previousAction) {
  saveFocusedDraft();
  const { adapter, source, action } = locate(state.selection);
  if (!adapter || (state.selection?.sourceGuid && !source) || (!source && list(adapter.sources).length)
      || (!state.request && action?.defaultRequest)) {
    chooseSource(state.selection?.adapterId, state.selection?.sourceGuid, state.selection?.actionId);
    return;
  }
  state.source = source || null;
  for (const id of [...state.selectedActions]) {
    const draft = state.actionDrafts[id], current = sourceActions(source).find(item => item.id === id);
    if (!current) { state.selectedActions = state.selectedActions.filter(item => item !== id); delete state.actionDrafts[id]; continue; }
    const schema = JSON.stringify(current);
    if (draft && draft.schema !== schema) {
      draft.generatedSignature = ''; draft.candidateId = ''; draft.runId = null; draft.schema = schema;
      if (state.selection?.actionId === id) state.generatedSignature = '';
    }
  }
  if (!action && sourceActions(source).length) {
    if (state.selectedActions.length) { focusAction(state.selectedActions[0]); drawActionPanels(); }
    else chooseSource(state.selection?.adapterId, state.selection?.sourceGuid);
    return;
  }
  if (previousAction !== JSON.stringify(action)) {
    state.generatedSignature = '';
    drawCandidates();
  }
  drawSelectors();
  drawActionPanels();
}
function drawSelectors() {
  const all = adapters();
  const selectedAdapter = all.find(item => item.id === state.selection?.adapterId);
  $('adapter').replaceChildren();
  if (!all.length) option($('adapter'), '연결된 어댑터 없음', '');
  all.forEach(item => option($('adapter'), item.displayName || item.id, item.id));
  $('adapter').value = selectedAdapter?.id || '';
  $('source').replaceChildren();
  const sources = list(selectedAdapter?.sources);
  if (!sources.length) option($('source'), '사용 가능한 공격 데이터 없음', '');
  sources.forEach(item => option($('source'), item.label || item.guid, item.guid));
  $('source').value = state.source?.guid || '';
  $('action').replaceChildren();
  const actions = sourceActions(state.source), selectedAction = currentAction();
  if (!actions.length) option($('action'), '사용 가능한 동작 없음', '');
  actions.forEach(item => option($('action'), `${item.label || actionName(item.id)}${item.available === false ? ' · 준비 필요' : ''}`, item.id));
  $('action').value = selectedAction?.id || '';
  const connected = state.snapshot?.connection?.connected;
  $('sourceHelp').textContent = !connected ? 'Unity Editor에서 선택한 프로젝트를 열고 Combat Lab 연결 패키지를 확인하세요.'
    : selectedAdapter?.error || (!all.length ? '등록된 프로젝트 어댑터가 없습니다. 연결 패키지와 프로젝트용 어댑터를 설치하세요. 처음 연결하는 프로젝트는 Example 어댑터로 동작을 확인할 수 있습니다.'
      : !state.source ? '이 어댑터의 실험 데이터가 없습니다. Unity에서 해당 어댑터가 사용하는 데이터를 만든 뒤 연결 정보를 새로고침하세요.'
        : !actionAvailable() ? selectedAction?.unavailableReason || state.source.error || '선택한 동작을 현재 프로젝트에서 찾을 수 없습니다. 연결 정보를 새로고침하세요.'
          : `${selectedAction.label || actionName(selectedAction.id)} · ${currentParameters().length}개 항목 · 원본 해시 ${state.request?.sourceHash?.slice(0, 12) || 'v1'} · 실험용 복사본에 적용`);
  $('sourceHelp').classList.toggle('unavailable', Boolean(connected) && (!actionAvailable() || Boolean(selectedAdapter?.error)));
  $('adapterSetup').hidden = all.length > 0;
  drawActionSelection();
}
function drawCandidates() {
  const host = $('candidates');
  host.replaceChildren();
  $('editorCandidate').replaceChildren();
  const candidates = list(state.request?.candidates);
  host.classList.toggle('many-candidates', candidates.length > 4);
  $('candidateCount').textContent = `${candidates.length}개`;
  if (!candidates.length) {
    const empty = node('div', undefined, 'empty-state candidate-empty');
    empty.append(node('span', '⌁', 'empty-icon'), node('h3', state.source ? '어떤 타격감을 비교할까요?' : '프로젝트에서 시작하세요'), node('p', state.source ? '원하는 감각과 후보 수를 정하고 AI 후보 생성을 누르세요.' : 'Unity 프로젝트를 연결하면 AI가 사용할 공격 데이터를 불러옵니다.'));
    host.append(empty);
    return;
  }
  const specs = currentParameters();
  candidates.forEach((candidate, index) => {
    option($('editorCandidate'), candidateName(candidate, index), candidate.id);
    host.append(candidateCard(candidate, index, specs, state.requestOrigin));
  });
  const selectedId = state.actionDrafts[state.selection?.actionId]?.candidateId;
  if (candidates.some(candidate => candidate.id === selectedId)) $('editorCandidate').value = selectedId;
  drawDesignOptions(state.actionDrafts[state.selection?.actionId]);
}
function observationReference(draft, reference) {
  const bundle = state.reportBundle, report = bundle?.report;
  if (!draft?.request || !report || draft.request.schemaVersion !== 2 || report.adapterId !== draft.request.adapterId || report.sourceGuid !== draft.request.sourceGuid ||
      actionIdOf(report) !== actionIdOf(draft.request) || draft.request.sourceHash && report.sourceDependencyHash !== draft.request.sourceHash) return null;
  if (reference.id === 'source-reference') return report.controlResult ? { runId: report.runId, candidateId: report.controlResult.candidate.id } : null;
  const measured = list(report.results).find(row => row.candidate.id === reference.id);
  const linkedRun = draft.runId === report.runId || draft.observedRunId === report.runId;
  const sameGeneration = Boolean(draft.request.generation?.createdUtc && draft.request.generation.createdUtc === bundle.request?.generation?.createdUtc);
  if (measured && (linkedRun || sameGeneration || matchingCandidates([reference], [measured.candidate]))) return { runId: report.runId, candidateId: measured.candidate.id };
  const ancestor = draft.request.generation?.referenceCandidateId;
  return ancestor && list(report.results).some(row => row.candidate.id === ancestor) ? { runId: report.runId, candidateId: ancestor } : null;
}
function drawDesignOptions(draft) {
  const options = draft?.options || {}, previous = options.referenceCandidateId || '';
  for (const [id, fallback] of [['generationMode', 'explore'], ['generationStrategy', 'coherent'], ['refineFeedback', '']]) {
    const key = { generationMode: 'mode', generationStrategy: 'strategy', refineFeedback: 'feedback' }[id];
    $(id).value = options[key] || fallback;
  }
  $('referenceCandidate').replaceChildren(); option($('referenceCandidate'), '현재 원본값', '');
  list(draft?.request?.candidates).forEach((candidate, index) => option($('referenceCandidate'), candidateName(candidate, index), candidate.id));
  $('referenceCandidate').value = previous;
  $('recipeId').replaceChildren(); option($('recipeId'), '가이드 전체', '');
  list(state.snapshot?.knowledge?.recipes).forEach(recipe => option($('recipeId'), recipe.label || recipe.id, recipe.id));
  $('recipeId').value = options.recipeId || '';
  $('gameContext').textContent = typeof currentAction()?.context === 'string' ? currentAction().context : JSON.stringify(currentAction()?.context || {});
  const reference = list(draft?.request?.candidates).find(candidate => candidate.id === previous) || { id: 'source-reference' };
  const observation = observationReference(draft, reference);
  $('observationHint').textContent = observation ? `참고 실험 ${observation.runId} · 측정 후보 ${observation.candidateId}. 수정된 후보는 미검증 상태로 AI에 전달합니다.` : '연결된 실측 기록이 없습니다. AI는 현재 설정과 가이드로 가설을 작성합니다.';
  const locks = $('parameterLocks'); locks.replaceChildren();
  for (const spec of [...currentParameters(), ...currentCurves()]) {
    const label = node('label'), input = node('input'); input.type = 'checkbox'; input.checked = (options.lockedIds || []).includes(spec.id);
    input.disabled = locked();
    input.addEventListener('change', () => {
      const selectedDraft = state.actionDrafts[state.selection?.actionId]; if (!selectedDraft) return;
      const ids = new Set(selectedDraft.options?.lockedIds || []); input.checked ? ids.add(spec.id) : ids.delete(spec.id);
      selectedDraft.options = { ...designOptions(), lockedIds: [...ids] }; selectedDraft.generatedSignature = ''; state.generatedSignature = ''; updateControls();
    });
    label.append(input, node('span', `${spec.targetId ? `${targetName(spec.targetId)} · ` : ''}${spec.group || ''} ${parameterName(spec)}`)); locks.append(label);
  }
}
function candidateCard(candidate, index, specs, origin, request = state.request) {
    const card = node('article', undefined, 'candidate-card');
    const head = node('div', undefined, 'candidate-head');
    const title = node('h3', candidateName(candidate, index), 'candidate-title');
    head.append(node('span', index + 1, 'candidate-letter'), title);
    const tag = node('span', `${candidate.origin || origin} · r${candidate.revision || 1}`, 'candidate-tag'); head.append(tag);
    card.append(head);
    if (candidate.rationale) card.append(node('p', candidate.rationale, 'candidate-rationale'));
    const body = node('div', undefined, 'candidate-body');
    const inputs = new Map();
    const deltas = new Map();
    const curveEditors = new Map();
    const refreshMode = spec => { const id = tuning.owningMode(spec.id, spec.targetId), input = inputs.get(id), descriptor = specs.find(item => item.id === id); if (input) {
      const value = candidate.values.find(item => item.id === id)?.value ?? descriptor.baseline; input.value = String(value);
      if (deltas.has(id)) deltas.get(id).textContent = value === descriptor.baseline ? '현재와 동일' : `변경 ${fmt(value - descriptor.baseline)}`;
    } };
    const groups = new Map();
    const groupHost = spec => {
      if (request?.schemaVersion !== 2) return body;
      const key = `${spec.targetId || ''}/${spec.group || ''}`;
      if (!groups.has(key)) {
        const section = node('details', undefined, 'parameter-group');
        section.open = [...list(candidate.values), ...list(candidate.curves)].some(item => [...specs, ...list(locate(request).action?.curves)].some(other => other.id === item.id && other.targetId === spec.targetId && other.group === spec.group));
        section.append(node('summary', `${targetName(spec.targetId)} · ${spec.group || '설정'}`)); body.append(section); groups.set(key, section);
      }
      return groups.get(key);
    };
    for (const spec of specs) {
      const parameter = list(candidate.values).find(value => value.id === spec.id);
      const label = node('div', undefined, 'parameter');
      label.title = `${spec.description || parameterName(spec)}\n허용 범위: ${spec.minimum}–${spec.maximum} ${unitName(spec)}`;
      const top = node('span', undefined, 'parameter-top');
      top.append(node('span', `${spec.targetId ? `${targetName(spec.targetId)} · ` : ''}${spec.group ? `${spec.group} · ` : ''}${parameterName(spec)}`), node('span', unitName(spec), 'parameter-unit'));
      const editable = request?.schemaVersion === 2;
      const value = node(editable ? spec.kind === 'enum' ? 'select' : 'input' : 'output', editable ? undefined : inputNumber(parameter?.value) || '—', 'parameter-value');
      if (editable) {
        inputs.set(spec.id, value);
        if (spec.kind === 'enum') { list(spec.options).forEach((label, i) => option(value, enumName(label), i)); value.value = parameter?.value ?? spec.baseline; }
        else if (spec.kind === 'boolean') { value.type = 'checkbox'; value.checked = (parameter?.value ?? spec.baseline) === 1; }
        else { value.type = 'number'; value.step = 'any'; value.min = spec.minimum; value.max = spec.maximum; value.value = inputNumber(parameter?.value ?? spec.baseline); }
        value.disabled = locked();
        value.addEventListener('input', () => {
          let target = list(candidate.values).find(item => item.id === spec.id);
          if (!target) { target = { id: spec.id, value: spec.baseline }; candidate.values.push(target); }
          target.value = spec.kind === 'boolean' ? Number(value.checked) : value.value === '' ? NaN : Number(value.value);
          value.classList.toggle('invalid', !tuning.validValue(target.value, spec)); markEdited(candidate, spec, request);
          refreshMode(spec);
          if (spec.id.endsWith('.mode') && target.value === 0) {
            for (const other of specs) if (other.id !== spec.id && tuning.channelContains(spec.id, other.id)) { const input = inputs.get(other.id); if (input) { input.value = inputNumber(other.baseline); input.checked = other.baseline === 1; } }
            for (const curve of list(locate(request).action?.curves)) if (tuning.channelContains(spec.id, curve.id) && curveEditors.has(curve.id)) curveEditors.get(curve.id).value = list(curve.keys).map(key => `${inputNumber(key.time)}, ${inputNumber(key.value)}`).join('\n');
          }
          tag.textContent = `${candidate.origin} · r${candidate.revision}`;
          delta.textContent = finite(target.value) ? `변경 ${fmt(target.value - spec.baseline)}` : '값을 입력하세요';
        });
      }
      value.setAttribute('aria-label', `${candidateName(candidate, index)} ${parameterName(spec)}`);
      const range = node('span', undefined, 'parameter-range');
      const delta = node('span', '', 'delta');
      deltas.set(spec.id, delta);
      range.append(node('span', `현재 ${fmt(spec.baseline)}${spec.useSuggestedRange ? ` · 권장 ${fmt(spec.suggestedMinimum)}–${fmt(spec.suggestedMaximum)}` : ''}`), delta);
      const changed = finite(parameter?.value) && Math.abs(parameter.value - spec.baseline) > 0.000001;
      value.classList.toggle('changed', changed);
      delta.textContent = changed ? `${parameter.value > spec.baseline ? '+' : ''}${fmt(parameter.value - spec.baseline)}` : '현재와 동일';
      label.append(top, value, range); groupHost(spec).append(label);
    }
    if (request?.schemaVersion === 2) for (const spec of list(locate(request).action?.curves)) {
      const details = node('details', undefined, 'curve-editor'), summary = node('summary', `${parameterName(spec)} · 선형 키`);
      const editor = node('textarea'); editor.rows = 4; editor.setAttribute('aria-label', `${candidateName(candidate, index)} ${spec.label || spec.id} 곡선 키`);
      curveEditors.set(spec.id, editor);
      const curve = list(candidate.curves).find(item => item.id === spec.id);
      editor.value = (curve?.keys || spec.keys || []).map(key => `${inputNumber(key.time)}, ${inputNumber(key.value)}`).join('\n');
      const error = node('p', '한 줄에 시간, 값 · 2–16개 · 선형 보간', 'fine-print');
      editor.disabled = locked();
      editor.addEventListener('change', () => {
        const keys = editor.value.trim().split(/\n/).map(line => { const pair = line.split(',').map(Number); return { time: pair[0], value: pair.length === 2 ? pair[1] : NaN }; });
        try {
          tuning.validateKeys(keys, spec); candidate.curves ||= []; let target = candidate.curves.find(item => item.id === spec.id);
          if (target) target.keys = keys; else candidate.curves.push({ id: spec.id, keys });
          error.textContent = '선형 곡선 변경됨'; error.classList.remove('error'); markEdited(candidate, spec, request); refreshMode(spec); tag.textContent = `${candidate.origin} · r${candidate.revision}`;
          if (spec.id.endsWith('.camera.motion.fovOffset')) {
            const flagId = spec.id.slice(0, -'fovOffset'.length) + 'useFeelZoom';
            if (inputs.has(flagId)) { inputs.get(flagId).checked = false; error.textContent += ' · FOV 중복 연출을 막기 위해 Feel 줌을 해제했습니다.'; }
          }
        } catch (exception) { error.textContent = exception.message; error.classList.add('error'); }
      });
      details.append(summary, editor, error); groupHost(spec).append(details);
    }
    card.append(body, node('div', request?.schemaVersion === 2 ? '절대값 직접 편집 · 변경한 채널은 직접 설정으로 적용' : 'v1 원래 배율 의미 유지 · 읽기 전용', 'candidate-foot'));
    return card;
}
function drawActionPanels() {
  const multi = multiAction();
  $('singleActionDesign').hidden = multi; $('multiActionDesign').hidden = !multi;
  $('singleActionLaunch').hidden = multi; $('singleActionPreset').hidden = multi; $('combinedPreset').hidden = !multi;
  const host = $('multiActionDesign'); host.replaceChildren(); state.actionPanels.clear();
  if (!multi) return;
  for (const id of state.selectedActions) {
    const draft = state.actionDrafts[id], action = locate(draft?.request).action;
    if (!draft) continue;
    const section = node('section', undefined, 'action-design panel'); section.setAttribute('data-action-id', id); section.setAttribute('aria-label', `${action?.label || actionName(id)} 후보 만들기`);
    const heading = node('div', undefined, 'action-design-heading');
    heading.append(node('h3', action?.label || actionName(id)), node('span', `${list(draft.request?.candidates).length}개 후보`, 'muted'));
    const row = node('div', undefined, 'ai-goal-row'), goalLabel = node('label', '원하는 타격감', 'field goal-field'), goal = node('textarea');
    goal.rows = 2; goal.maxLength = 4000; goal.value = draft.goal; goal.setAttribute('aria-label', `${action?.label || actionName(id)} 원하는 타격감`); goalLabel.append(goal);
    goal.setAttribute('data-control', 'goal');
    const countLabel = node('label', '비교할 후보 수', 'field count-field'), count = node('input'); count.type = 'number'; count.min = 2; count.max = 12; count.step = 1; count.value = draft.count;
    count.setAttribute('aria-label', `${action?.label || actionName(id)} 후보 수`); countLabel.append(count, node('span', '2–12개', 'fine-print')); row.append(goalLabel, countLabel);
    count.setAttribute('data-control', 'count');
    const actions = node('div', undefined, 'ai-actions'), status = node('span', '', 'ai-status'), buttons = node('div', undefined, 'inline-actions');
    const cancel = node('button', '생성 취소', 'danger-button small'), generate = node('button', 'AI 후보 생성', 'primary small'); buttons.append(cancel, generate); actions.append(status, buttons);
    generate.setAttribute('data-control', 'generate');
    const candidates = node('div', undefined, 'candidates'); candidates.classList.toggle('many-candidates', list(draft.request.candidates).length > 4);
    list(draft.request.candidates).forEach((candidate, index) => candidates.append(candidateCard(candidate, index, parametersOf(action, draft.request.schemaVersion), draft.requestOrigin, draft.request)));
    if (!list(draft.request.candidates).length) candidates.append(node('p', '이 동작의 목표와 후보 수를 정하고 AI 후보를 생성하세요.', 'fine-print'));
    const hint = node('p', '', 'fine-print');
    const footer = node('div', undefined, 'action-design-footer'), winnerLabel = node('label', '이 동작의 최종 후보', 'field'), winner = node('select');
    option(winner, '최종 후보를 선택하세요', ''); list(draft.request.candidates).forEach((candidate, index) => option(winner, candidateName(candidate, index), candidate.id)); winner.value = draft.candidateId;
    winner.setAttribute('aria-label', `${action?.label || actionName(id)} 최종 후보`); winnerLabel.append(winner);
    winner.setAttribute('data-control', 'winner');
    const run = node('button', '이 동작 후보 비교 실행', 'subtle small'), resultsButton = node('button', '비교 결과 보기', 'text-button'), saveJson = node('button', 'JSON 저장', 'text-button');
    run.setAttribute('data-control', 'run');
    footer.append(winnerLabel, run, resultsButton, saveJson); section.append(heading, row, actions, candidates, hint, footer); host.append(section);
    const changed = () => {
      const current = state.actionDrafts[id]; if (!current) return;
      current.goal = goal.value; current.count = Number(count.value); current.candidateId = ''; winner.value = '';
      if (state.selection?.actionId === id) { $('goal').value = goal.value; $('candidateTotal').value = count.value; }
      updateControls();
    };
    goal.addEventListener('input', changed); count.addEventListener('input', changed);
    generate.addEventListener('click', () => generateAction(id)); cancel.addEventListener('click', cancelCandidateGeneration);
    run.addEventListener('click', () => operation(() => runAction(id), { refresh: true }));
    resultsButton.addEventListener('click', () => operation(() => openReport(state.actionDrafts[id]?.runId)));
    saveJson.addEventListener('click', () => operation(async () => {
      focusAction(id);
      if (!requestReady()) throw new Error('현재 목표에 맞춰 이 동작의 후보를 생성하세요.');
      const result = await api.saveRequest(validate(state.request));
      if (result && !result.cancelled) message(`실험 JSON을 저장했습니다: ${result.path}`);
    }));
    winner.addEventListener('change', () => { if (state.actionDrafts[id]) state.actionDrafts[id].candidateId = winner.value; updateControls(); });
    state.actionPanels.set(id, { goal, count, generate, cancel, status, candidates, hint, winner, run, resultsButton, saveJson });
  }
}
function updateActionControls(disabled, connected, ai) {
  state.selectionControls.forEach(({ input, available }) => { input.disabled = disabled || !available; });
  for (const [id, controls] of state.actionPanels) {
    const draft = state.actionDrafts[id], action = locate(draft?.request).action;
    if (!draft) continue;
    const ready = draftReady(draft), count = Number(draft?.count), working = generating() && state.generatingActionId === id;
    const available = action?.available !== false && Boolean(action?.defaultRequest);
    controls.goal.disabled = controls.count.disabled = disabled;
    controls.generate.disabled = disabled || !connected || !available || !ai.available || !ai.authenticated || !draft.goal.trim() || !Number.isInteger(count) || count < 2 || count > 12;
    controls.generate.textContent = working ? 'AI가 후보를 작성 중…' : list(draft.request.candidates).length ? 'AI 후보 다시 생성' : 'AI 후보 생성';
    controls.cancel.hidden = !working; controls.cancel.disabled = !working || state.generationCancelled;
    controls.cancel.textContent = state.generationCancelled ? '취소 요청됨' : '생성 취소';
    controls.status.textContent = working ? '이 동작의 후보를 작성하고 있습니다.' : !available ? action?.unavailableReason || '이 동작을 현재 테스트할 수 없습니다.' : ai.error || (ai.available && ai.authenticated ? `${ai.label || 'AI 연결됨'} · 이 동작만의 목표를 입력하세요.` : 'AI 연결과 로그인을 확인하세요.');
    const stale = list(draft.request.candidates).length > 0 && !ready;
    controls.candidates.classList.toggle('stale', stale); controls.hint.classList.toggle('stale-hint', stale);
    controls.hint.textContent = stale ? '목표, 후보 수 또는 공격 데이터가 바뀌었습니다. 이 동작의 후보를 다시 생성하세요.' : ready ? '후보를 비교한 뒤 최종 후보 하나를 선택하세요. 모든 동작의 선택을 하나의 SO에 저장합니다.' : '';
    controls.winner.disabled = disabled || !ready; controls.winner.value = draft.candidateId;
    controls.run.disabled = disabled || !connected || !ready;
    controls.saveJson.disabled = disabled || !ready;
    controls.resultsButton.hidden = !draft.runId; controls.resultsButton.disabled = disabled;
  }
  const count = state.selectedActions.length;
  if (multiAction()) $('candidateCount').textContent = `${count}개 동작`;
  $('jsonActionHelp').textContent = state.selection?.actionId ? `${currentAction()?.label || actionName(state.selection.actionId)} · 현재 선택한 동작의 JSON을 저장합니다. 불러오기는 JSON에 기록된 동작에 적용됩니다.` : '불러온 후보는 읽기 전용으로 표시합니다.';
  const completed = state.selectedActions.filter(id => draftReady(state.actionDrafts[id]) && list(state.actionDrafts[id].request.candidates).some(candidate => candidate.id === state.actionDrafts[id].candidateId)).length;
  const supported = locate(state.selection).adapter?.supportsCombinedExport === true;
  $('combinedSummary').textContent = `${count}개 동작 중 ${completed}개 최종 후보 선택`;
  $('combinedHint').textContent = !supported ? '여러 동작을 함께 저장하려면 Unity 연결 패키지와 프로젝트 어댑터를 업데이트하세요.' : '각 동작에서 고른 후보를 같은 원본의 복사본에 적용해 새 스크립터블 오브젝트 하나로 저장합니다.';
  $('exportCombinedPreset').disabled = disabled || !connected || !multiAction() || completed !== count || !supported;
  $('cancelMultiRun').hidden = !multiAction() || !running(); $('cancelMultiRun').disabled = state.busy > 0 || state.starting || !connected || state.cancelRequested;
  $('cancelMultiRun').textContent = state.cancelRequested ? '취소 요청됨' : '실행 취소';
  $('exportReportPreset').hidden = multiAction(); $('useReportCandidate').hidden = !multiAction();
  $('useReportCandidate').disabled = disabled || !reportDraft() || !$('winner').value;
}
function matchingCandidates(expected, recorded) {
  if (!Array.isArray(expected) || !Array.isArray(recorded) || expected.length !== recorded.length) return false;
  const uniqueIds = items => items.every(item => typeof item?.id === 'string') && new Set(items.map(item => item.id)).size === items.length;
  if (!uniqueIds(expected) || !uniqueIds(recorded)) return false;
  return expected.every(candidate => {
    const actual = recorded.find(item => item.id === candidate.id);
    if (!actual || (candidate.label ?? '') !== (actual.label ?? '') || (candidate.rationale ?? '') !== (actual.rationale ?? '')) return false;
    const values = candidate.values, applied = actual.values;
    if (!Array.isArray(values) || !Array.isArray(applied) || values.length !== applied.length || !uniqueIds(values) || !uniqueIds(applied)) return false;
    const sameValues = values.every(value => {
      const result = applied.find(item => item.id === value.id);
      // Unity's request DTO stores float32 values and may reorder serialized
      // fields. Compare the actual runtime values rather than JSON spelling.
      return result && finite(value.value) && finite(result.value) && Math.fround(value.value) === Math.fround(result.value);
    });
    const normalizeCurves = curves => list(curves).map(curve => ({ id: curve.id, keys: list(curve.keys).map(key => ({ time: Math.fround(key.time), value: Math.fround(key.value) })) })).sort((a, b) => a.id.localeCompare(b.id));
    return sameValues && JSON.stringify(normalizeCurves(candidate.curves)) === JSON.stringify(normalizeCurves(actual.curves));
  });
}
function reportDraft() {
  const request = state.reportBundle?.request, id = actionIdOf(request), draft = state.actionDrafts[id];
  return request && state.selectedActions.includes(id) && draftReady(draft) && request.adapterId === draft.request.adapterId && request.sourceGuid === draft.request.sourceGuid
    && matchingCandidates(draft.request.candidates, request.candidates) ? draft : null;
}
function validate(request) {
  // An unavailable selection intentionally has no draft request. Report its
  // setup problem when validating that draft; malformed imported objects must
  // still fail the schema check independently of the current selection.
  if (request === null && state.request === null) {
    const { adapter, source, action } = locate(state.selection);
    const reason = adapter?.error || sourceError(source)
      || (action && (action.available === false || !action.defaultRequest) ? action.unavailableReason || '아직 테스트할 수 없는 동작입니다.' : '');
    if (reason) throw new Error(reason);
  }
  if (!request || ![1, 2].includes(request.schemaVersion)) throw new Error('지원하는 실험 JSON 형식(schemaVersion 1 또는 2)이 아닙니다.');
  const { adapter, source, action } = locate(request);
  if (!adapter || !source) throw new Error('이 실험의 어댑터 또는 공격 데이터를 현재 프로젝트에서 찾을 수 없습니다. 해당 프로젝트에 연결한 뒤 불러오세요.');
  if (sourceError(source)) throw new Error(sourceError(source));
  if (!action) throw new Error('이 실험의 공격 또는 스킬을 현재 프로젝트에서 찾을 수 없습니다.');
  if (action.available === false || !action.defaultRequest) throw new Error(action.unavailableReason || '아직 테스트할 수 없는 동작입니다.');
  if (!(action.supportedRequestVersions || [action.defaultRequest.schemaVersion]).includes(request.schemaVersion)) throw new Error('선택한 동작이 이 실험 JSON 버전을 지원하지 않습니다.');
  if (!finite(request.durationSeconds) || request.durationSeconds < 3 || request.durationSeconds > 60) throw new Error('후보당 실행 시간은 3–60초로 입력하세요.');
  if (!Number.isInteger(request.seed) || request.seed < -2147483648 || request.seed > 2147483647) throw new Error('난수 시드는 32비트 정수로 입력하세요.');
  if (typeof request.recordVideo !== 'boolean') throw new Error('영상 녹화 설정은 true 또는 false여야 합니다.');
  if (request.schemaVersion === 2 && (!['fixed', 'live'].includes(request.scenarioMode) || ![1, 3].includes(request.repeatCount) ||
      typeof request.includeSourceControl !== 'boolean' || typeof request.precisionCapture !== 'boolean' ||
      typeof request.precisionTargetId !== 'string' || request.precisionTargetId.length > 128)) throw new Error('v2 실행 조건이 올바르지 않습니다.');
  if (request.schemaVersion === 2 && request.precisionCapture && !request.recordVideo) throw new Error('명중 정밀 캡처에는 플레이 영상 녹화가 필요합니다.');
  if (!Array.isArray(request.candidates) || request.candidates.length < 1 || request.candidates.length > 12) throw new Error('실험에는 후보 1–12개가 필요합니다.');
  const ids = new Set();
  const specs = parametersOf(action, request.schemaVersion);
  if (!specs.length) throw new Error('이 공격의 조절 항목을 불러오지 못했습니다. 연결 정보를 새로고침하세요.');
  request.candidates.forEach((candidate, index) => {
    if (!candidate || typeof candidate.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(candidate.id) || ids.has(candidate.id)) throw new Error('후보 ID는 중복 없는 영문, 숫자, 밑줄, 하이픈 1–64자여야 합니다.');
    ids.add(candidate.id);
    if (request.schemaVersion === 2) {
      if (candidate.isSourceControl || !Array.isArray(candidate.values) || new Set(candidate.values.map(item => item.id)).size !== candidate.values.length) throw new Error('원본 기준은 사용자 후보로 추가할 수 없으며 수치 ID는 중복할 수 없습니다.');
      for (const entry of candidate.values) { const spec = specs.find(item => item.id === entry?.id); if (!spec || !tuning.validValue(entry.value, spec)) throw new Error(`${entry?.id}: 수치 형식 또는 범위를 확인하세요.`); }
      const curveIds = new Set();
      for (const curve of candidate.curves || []) { const spec = list(action.curves).find(item => item.id === curve?.id); if (!spec || curveIds.has(curve.id)) throw new Error('곡선 ID가 없거나 중복됐습니다.'); curveIds.add(curve.id); tuning.validateKeys(curve.keys, spec); }
      return;
    }
    if (!Array.isArray(candidate.values) || candidate.values.length !== specs.length) throw new Error(`${candidateName(candidate, index)}: 모든 조절 항목이 정확히 한 번씩 필요합니다.`);
    for (const spec of specs) {
      const values = candidate.values.filter(value => value?.id === spec.id);
      if (values.length !== 1 || !finite(values[0]?.value) || values[0].value < spec.minimum || values[0].value > spec.maximum) throw new Error(`${candidateName(candidate, index)}: ${parameterName(spec)} 값은 ${fmt(spec.minimum)}–${fmt(spec.maximum)} ${unitName(spec)} 범위여야 합니다.`);
    }
  });
  return request;
}
function updateControls() {
  saveFocusedDraft();
  const connection = state.snapshot?.connection || {};
  const ai = state.snapshot?.ai || {};
  const isRunning = running();
  const isGenerating = generating();
  const disabled = locked();
  const connected = Boolean(connection.connected);
  const ready = requestReady() && actionAvailable();
  const count = Number($('candidateTotal').value);
  const validGoal = $('goal').value.trim().length > 0 && Number.isInteger(count) && count >= 2 && count <= 12;
  // Keep cancellation reachable while disabling all other design inputs.
  $('designFields').disabled = false;
  $('designFields').querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = disabled; });
  $('chooseProject').disabled = state.busy > 0 || isGenerating || (connected && (isRunning || Boolean(connection.isPlaying)));
  $('runExperiment').disabled = disabled || !connected || !ready;
  $('cancelRun').hidden = !isRunning;
  $('cancelRun').disabled = state.busy > 0 || state.starting || !connected || state.cancelRequested;
  $('cancelRun').textContent = state.cancelRequested ? '취소 요청됨' : '실행 취소';
  $('exportEditorPreset').disabled = disabled || !connected || !ready;
  $('editorCandidate').disabled = disabled || !ready;
  $('exportReportPreset').disabled = disabled || !connected || !state.reportBundle?.request || !$('winner').value;
  $('repeatSelected').disabled = disabled || !connected || state.reportBundle?.request?.schemaVersion !== 2 || !$('winner').value;
  $('saveJudgment').disabled = state.busy > 0 || !state.selectedRunId;
  $('exportRequest').disabled = disabled || !ready;
  $('refreshCatalog').disabled = disabled || !connected;
  $('generateCandidates').disabled = disabled || !connected || !actionAvailable() || !validGoal || !ai.available || !ai.authenticated;
  $('generateCandidates').textContent = isGenerating ? 'AI가 후보를 작성 중…' : list(state.request?.candidates).length ? 'AI 후보 다시 생성' : 'AI 후보 생성';
  $('cancelGeneration').hidden = !isGenerating;
  $('cancelGeneration').disabled = !isGenerating || state.generationCancelled;
  $('cancelGeneration').textContent = state.generationCancelled ? '취소 요청됨' : '생성 취소';
  if (ai.preference && document.activeElement !== $('aiProvider')) $('aiProvider').value = ai.preference;
  $('aiProvider').disabled ||= !api || state.changingProvider;
  $('aiStatus').textContent = state.changingProvider ? 'AI 엔진 연결을 확인하고 있습니다.' : isGenerating ? 'AI가 현재 수치와 허용 범위를 읽고 후보를 작성하고 있습니다.' : ai.error || (ai.available && ai.authenticated ? `${ai.label || 'AI 연결됨'} · 원하는 감각을 입력하세요.` : ai.available ? `${ai.provider === 'claude' ? 'Claude Code' : 'Codex'} 로그인이 필요합니다. 로그인 후 연결 정보를 새로고침하세요.` : 'AI 연결을 확인하세요. 연결 정보 새로고침으로 다시 확인할 수 있습니다.');
  $('aiStatus').classList.toggle('unavailable', !isGenerating && (!ai.available || !ai.authenticated));
  const stale = list(state.request?.candidates).length > 0 && !ready;
  $('candidates').classList.toggle('stale', stale);
  $('candidateHint').textContent = stale ? '실험 대상, 목표 또는 후보 수가 바뀌었습니다. 현재 표시된 후보는 이전 제안입니다. AI 후보를 다시 생성하세요.' : ready ? state.requestOrigin === 'ai' ? 'AI 제안은 가설입니다. 직접 편집한 뒤 같은 조건에서 비교할 수 있습니다.' : state.requestOrigin === 'manual' ? '직접 편집 후보입니다. 펼친 채널의 절대값과 선형 곡선을 조정하고 원본 기준과 비교하세요.' : 'JSON에서 불러온 후보입니다. v2 수치와 곡선은 직접 편집할 수 있습니다.' : 'AI가 선택한 공격·스킬의 허용 범위 안에서 수치를 정합니다. 생성된 후보를 확인한 뒤 실험을 실행하세요.';
  $('candidateHint').classList.toggle('stale-hint', stale);
  const status = connection.isCompiling ? 'Unity 컴파일 중' : isRunning ? '실험 실행 중' : connection.isPlaying ? 'Unity 플레이 모드' : connected ? 'Unity 연결됨' : 'Unity 연결 대기';
  $('connectionLabel').textContent = status;
  $('connectionDot').className = 'status-dot ' + (connection.isCompiling || isRunning || connection.isPlaying ? 'busy' : connected ? 'connected' : connection.error ? 'error' : '');
  $('connectionLabel').title = connection.error || connection.unityVersion || '';
  $('liveStatus').textContent = isGenerating ? 'AI 후보 생성 중' : isRunning ? connection.status || '실험 준비 중' : connection.error ? '연결 확인 필요' : connected ? '실험 준비' : '연결 대기';
  $('liveStatus').classList.toggle('running', isRunning || isGenerating);
  const candidates = list(state.request?.candidates);
  $('addManualCandidate').disabled = disabled || state.request?.schemaVersion !== 2 || candidates.length >= 12;
  for (const id of ['scenarioMode', 'repeatCount', 'includeSourceControl', 'precisionCapture', 'precisionTargetId']) $(id).disabled = disabled || state.request?.schemaVersion !== 2;
  $('precisionCapture').disabled ||= !state.request?.recordVideo;
  $('runSummary').textContent = isGenerating ? `${count}개 후보의 수치를 AI가 작성 중` : isRunning ? connection.status || '실험 준비 중' : stale ? '새로운 목표로 AI 후보를 다시 생성하세요' : candidates.length ? `${candidates.length}개 후보 · 후보당 ${fmt(state.request.durationSeconds)}초` : state.source ? '원하는 감각을 입력하고 AI 후보를 생성하세요' : '프로젝트 연결을 기다리는 중';
  $('runDetail').textContent = isGenerating ? '생성이 끝나면 후보별 수치와 제안 이유를 확인할 수 있습니다.' : isRunning ? 'Unity에서 같은 조건으로 순서대로 플레이하고 있습니다.' : connection.isCompiling ? 'Unity 컴파일이 끝나면 실행할 수 있습니다.' : connection.isPlaying ? 'Unity의 플레이 모드를 종료한 뒤 실행하세요.' : !connected ? 'Unity Editor에서 대상 프로젝트를 열고 연결 패키지를 확인하세요.' : !ready ? 'AI로 후보를 만들거나 원본값 후보를 추가해 직접 조정하세요.' : `${state.request?.recordVideo ? '영상 + 전투 이벤트' : '전투 이벤트'} · ${state.request?.scenarioMode === 'fixed' ? '고정 대상' : '자동 전투'} · ${state.request?.repeatCount || 1}회 반복 · ${state.request?.includeSourceControl ? '원본 기준 별도 실행' : '후보만 실행'}`;
  $('footerConnection').textContent = connection.unityVersion ? `Unity ${connection.unityVersion} · 로컬 연결` : 'Unity 실행 · 데스크톱 제어';
  updateActionControls(disabled, connected, ai);
  persistDrafts();
}
function persistDrafts() {
  if (!state.snapshot?.projectPath || !Object.values(state.actionDrafts).some(draft => draft.request?.candidates?.length)) return;
  try { globalThis.localStorage?.setItem(`combat-lab-drafts:${state.snapshot.projectPath}`, JSON.stringify({ schemaVersion: 2, selectedActions: state.selectedActions, drafts: state.actionDrafts })); } catch { /* Quota or disabled local storage must not prevent editing. */ }
}
function restoreDrafts() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(`combat-lab-drafts:${state.snapshot.projectPath}`) || 'null');
    if (value?.schemaVersion !== 2 || !Array.isArray(value.selectedActions) || !value.drafts) return;
    const valid = value.selectedActions.filter(id => { const draft = value.drafts[id]; return draft?.request && locate(draft.request).action && JSON.stringify(locate(draft.request).action) === draft.schema; });
    if (valid.length) clearActionDrafts();
    for (const id of valid) {
      const draft = value.drafts[id], target = locate(draft?.request);
      if (!draft?.request || !target.action || JSON.stringify(target.action) !== draft.schema) continue;
      state.actionDrafts[id] = draft; if (!state.selectedActions.includes(id)) state.selectedActions.push(id);
    }
    const restored = value.selectedActions.find(id => state.actionDrafts[id]);
    if (restored) focusAction(restored);
  } catch { /* Invalid saved drafts never prevent project connection. */ }
}
function drawHistory() {
  const runs = list(state.snapshot?.runs);
  $('historyCount').textContent = runs.length;
  $('resultsBadge').textContent = runs.length;
  const key = JSON.stringify(runs) + state.selectedRunId;
  if (key === state.lastHistoryKey) return;
  state.lastHistoryKey = key;
  $('history').replaceChildren();
  if (!runs.length) { $('history').append(node('p', '첫 실험을 실행하면 여기에 기록이 쌓입니다.', 'sidebar-empty')); return; }
  runs.forEach(run => {
    const button = node('button', undefined, 'history-item' + (run.id === state.selectedRunId ? ' active' : ''));
    button.title = run.id;
    button.append(node('span', dateLabel(run.startedUtc), 'history-name'));
    if (run.actionId) {
      const target = locate(run);
      const label = `${target.source?.label ? `${compactSourceLabel(target.source.label)} · ` : ''}${target.action?.label || actionName(run.actionId)}`;
      const action = node('span', label, 'history-action'); action.title = label; button.append(action);
    }
    const meta = node('span', undefined, 'history-meta');
    meta.append(node('span', `${run.completedCount ?? 0}/${run.candidateCount ?? 0}개 후보`), node('span', runStatus(run), 'history-status'));
    button.append(meta);
    button.addEventListener('click', () => operation(() => openReport(run.id)));
    $('history').append(button);
  });
}
function applySnapshot(snapshot) {
  if (!snapshot) return;
  const previousAction = JSON.stringify(currentAction());
  const catalogChanged = JSON.stringify(state.catalog) !== JSON.stringify(snapshot.catalog || state.catalog);
  const connectionChanged = state.snapshot?.connection?.connected !== snapshot.connection?.connected;
  const projectChanged = state.snapshot?.projectPath !== snapshot.projectPath;
  state.snapshot = snapshot;
  if (!state.generating && !snapshot.ai?.generating) state.generationCancelled = false;
  if (projectChanged) {
    state.projectGeneration++;
    state.request = null; state.source = null; state.selection = null; state.catalog = { adapters: [] };
    state.requestOrigin = 'draft'; state.generatedSignature = '';
    clearActionDrafts();
    state.activeRunId = null; state.selectedRunId = null; state.reportBundle = null; state.reportSignature = ''; state.wasRunning = false;
    state.reportGeneration++; state.lastHistoryKey = ''; state.cancelRequested = false;
    stop(); videos.forEach(video => { video.removeAttribute('src'); video.load(); });
    $('reportContent').hidden = true; $('compareEmpty').hidden = false;
    showView('setup');
  }
  $('projectName').textContent = snapshot.projectName || '프로젝트 연결';
  $('projectPath').textContent = snapshot.projectPath || 'Unity 프로젝트를 선택하세요';
  $('projectPath').title = snapshot.projectPath || '';
  if (snapshot.catalog) state.catalog = snapshot.catalog;
  if (catalogChanged) state.lastHistoryKey = '';
  if (!state.selection || projectChanged || catalogChanged || connectionChanged) reconcileSelection(previousAction);
  if (projectChanged) restoreDrafts();
  if (snapshot.connection?.running && !state.activeRunId) {
    const directory = String(snapshot.connection.directory || '').replaceAll('\\', '/').split('/').pop();
    state.activeRunId = directory || list(snapshot.runs).find(run => runStatus(run) === '실행 중')?.id || null;
    state.wasRunning = true;
  }
  if (!snapshot.connection?.running && snapshot.connection?.connected && !state.starting) state.cancelRequested = false;
  drawHistory(); updateControls();
}
async function refresh() {
  if (state.refreshing || state.busy > 0 || !api) return;
  state.refreshing = true;
  const generation = state.projectGeneration;
  try {
    const snapshot = await api.refresh();
    if (generation !== state.projectGeneration) return;
    const previouslyRunning = state.wasRunning;
    applySnapshot(snapshot);
    const observedRunning = Boolean(snapshot?.connection?.running);
    const canConfirmCompletion = Boolean(snapshot?.connection?.connected) && !snapshot?.connection?.isCompiling;
    state.wasRunning = observedRunning || (previouslyRunning && !canConfirmCompletion);
    if (state.activeRunId && (state.wasRunning || previouslyRunning)) {
      if (!state.wasRunning || !state.selectedRunId || state.selectedRunId === state.activeRunId) {
        await openReport(state.activeRunId, { quiet: true, switchView: !state.wasRunning });
      }
    }
    if (previouslyRunning && !state.wasRunning) state.activeRunId = null;
    updateControls();
  } catch (error) {
    $('connectionLabel').textContent = '연결 확인 실패';
    $('connectionLabel').title = error?.message || String(error);
    $('connectionDot').className = 'status-dot error';
  } finally { state.refreshing = false; }
}

// Report videos share a logical timeline. Their media offsets are only applied
// for first-hit alignment; raw video comparison always begins at media time 0.
const videos = [], selectors = [], videoSlots = [];
let results = [], loaded = [], playing = false, playbackGeneration = 0, comparisonLimit = null;
const resultName = (result, index = 0) => `${result?.candidate?.isSourceControl ? '원본 기준 · ' : ''}${candidateName(result?.candidate, index)}${result?.repeatIndex ? ` · ${result.repeatIndex}회` : ''}`;
const resultKey = result => result?.repeatIndex ? `${result.candidate.id}:repeat:${result.repeatIndex}` : result?.candidate?.id;
let precisionTime = 0, precisionReportId = '';
function selected(index) { return selectors[index] ? results[Number(selectors[index].value)] : undefined; }
function selectedCandidateIds() { return selectors.map((select, index) => resultKey(selected(index))).filter(Boolean); }
function updateAudioOptions() {
  const sound = $('sound'), previous = sound.value;
  sound.replaceChildren(); option(sound, '음소거', 'none');
  selectors.forEach((select, index) => option(sound, `${index + 1} · ${candidateName(selected(index)?.candidate, Number(select.value))}`, String(index)));
  sound.value = Array.from(sound.options).some(item => item.value === previous) ? previous : 'none';
  videos.forEach((video, index) => { video.muted = sound.value !== String(index); });
}
function paintAlignment() {
  const missing = selectors.some((select, index) => !finite(selected(index)?.metrics?.firstHitSeconds) || selected(index).metrics.firstHitSeconds < 0);
  $('playbackStatus').textContent = $('align').checked ? missing ? '첫 명중 이벤트가 없는 후보는 영상 시작을 기준으로 표시합니다.' : '0초가 추정 첫 명중 시점입니다. 이벤트와 영상 오프셋을 반영합니다.' : '영상 시작을 기준으로 함께 재생합니다. 1/60초 이동은 가변 프레임 영상의 정확한 프레임 이동을 보장하지 않습니다.';
}
function drawVideoGrid(count, preferredIds = []) {
  stop();
  videos.forEach(video => { video.removeAttribute('src'); video.load(); });
  videos.length = 0; selectors.length = 0; videoSlots.length = 0; loaded = [];
  $('videoGrid').replaceChildren();
  const actualCount = Math.min(12, results.length, Math.max(0, count));
  $('videoGrid').classList.toggle('many-videos', actualCount > 4);
  $('videoGrid').classList.toggle('single-video', actualCount === 1);
  const chosen = new Set();
  for (let index = 0; index < actualCount; index++) {
    const card = node('article', undefined, 'video-card'), heading = node('div', undefined, 'video-heading');
    const select = node('select'), video = node('video'), stage = node('div', undefined, 'video-stage');
    const empty = node('span', '영상 없음', 'video-empty'), caption = node('p', '', 'video-caption');
    select.id = `selectCandidate${index + 1}`; select.setAttribute('aria-label', `${index + 1}번 비교 후보`);
    results.forEach((result, resultIndex) => option(select, resultName(result, resultIndex), resultIndex));
    let selectedIndex = results.findIndex(result => resultKey(result) === preferredIds[index]);
    if (selectedIndex < 0 || chosen.has(selectedIndex)) selectedIndex = results.findIndex((result, resultIndex) => !chosen.has(resultIndex));
    chosen.add(selectedIndex); select.value = String(selectedIndex);
    heading.append(node('span', index + 1, 'side-badge' + (index % 2 ? ' alt' : '')), select);
    video.id = `videoCandidate${index + 1}`; video.preload = 'metadata'; video.playsInline = true; video.muted = true;
    video.playbackRate = Number($('rate').value);
    stage.append(video, empty); card.append(heading, stage, caption); $('videoGrid').append(card);
    const slot = { video, select, empty, caption, selectedIndex };
    videos.push(video); selectors.push(select); videoSlots.push(slot); loaded.push(false);
    video.addEventListener('loadedmetadata', () => { if (videos[index] !== video || !video.getAttribute('src')) return; loaded[index] = true; empty.hidden = true; seekTo(bounds().min); paintPlayback(); });
    video.addEventListener('seeked', () => { if (videos[index] === video) paintPlayback(); });
    video.addEventListener('error', () => { if (videos[index] !== video || !video.getAttribute('src')) return; loaded[index] = false; stop(); empty.hidden = false; empty.textContent = '영상을 열 수 없습니다'; paintPlayback(); });
    video.addEventListener('ended', () => { if (videos[index] !== video) return; stop(); paintPlayback(); });
    select.addEventListener('change', () => {
      const next = Number(select.value), previous = slot.selectedIndex;
      const otherIndex = videoSlots.findIndex((other, otherSlotIndex) => otherSlotIndex !== index && Number(other.select.value) === next);
      if (otherIndex >= 0) { videoSlots[otherIndex].select.value = String(previous); videoSlots[otherIndex].selectedIndex = previous; loadVideo(otherIndex); }
      slot.selectedIndex = next; loadVideo(index); updateAudioOptions(); paintAlignment();
    });
  }
  videos.forEach((video, index) => loadVideo(index));
  updateAudioOptions(); paintAlignment(); paintPlayback();
  $('compareCountHelp').textContent = results.length ? `${results.length}개 결과 중 ${actualCount}개 영상을 함께 비교합니다.` : '기록된 결과를 기다리고 있습니다.';
}
function drawComparisonCount(preferredIds = []) {
  const countSelect = $('compareCount'), maximum = Math.min(12, results.length), minimum = Math.min(2, maximum);
  countSelect.replaceChildren();
  for (let count = minimum; count <= maximum && count > 0; count++) option(countSelect, `${count}개`, count);
  const count = Math.max(minimum, Math.min(maximum, comparisonLimit ?? maximum));
  countSelect.value = String(count); countSelect.disabled = maximum <= minimum;
  drawVideoGrid(count, preferredIds);
}
function offset(index) {
  const result = selected(index);
  const firstHit = result?.metrics?.firstHitSeconds;
  return $('align').checked && finite(firstHit) && firstHit >= 0 ? Math.max(0, firstHit + (finite(result.videoTimeOffsetSeconds) ? result.videoTimeOffsetSeconds : 0)) : 0;
}
function activeVideos() { return videos.map((video, index) => ({ video, index })).filter(item => loaded[item.index] && finite(item.video.duration) && item.video.duration > 0); }
function bounds() {
  const active = activeVideos();
  return active.length ? { min: Math.max(...active.map(item => -offset(item.index))), max: Math.min(...active.map(item => item.video.duration - offset(item.index))) } : { min: 0, max: 0 };
}
function logicalTime() { const first = activeVideos()[0]; return first ? first.video.currentTime - offset(first.index) : 0; }
function stop() { playing = false; playbackGeneration++; videos.forEach(video => video.pause()); $('play').textContent = '함께 재생'; }
function paintPlayback() {
  const range = bounds();
  const valid = activeVideos().length > 0 && range.max > range.min;
  $('seek').min = range.min; $('seek').max = Math.max(range.min + 0.001, range.max); $('seek').value = logicalTime();
  $('seek').disabled = !valid;
  for (const id of ['play', 'restart', 'previous', 'next']) $(id).disabled = !valid;
  $('position').textContent = valid ? `${logicalTime().toFixed(2)} / ${range.max.toFixed(2)} s` : '재생할 영상 없음';
}
function seekTo(value) {
  const range = bounds();
  if (range.max <= range.min) { paintPlayback(); return; }
  const time = Math.min(range.max, Math.max(range.min, value));
  activeVideos().forEach(({ video, index }) => { video.currentTime = Math.min(video.duration, Math.max(0, time + offset(index))); });
  paintPlayback();
}
function loadVideo(index) {
  stop(); loaded[index] = false;
  const video = videos[index], result = selected(index), slot = videoSlots[index];
  video.removeAttribute('src'); video.load();
  slot.empty.hidden = false;
  slot.empty.textContent = result?.videoUrl ? '영상 불러오는 중' : '이 후보의 녹화 영상이 없습니다';
  slot.caption.textContent = `${resultName(result, Number(selectors[index].value))} · ${result?.status || '결과 없음'}`;
  if (typeof result?.videoUrl === 'string' && result.videoUrl.startsWith('baekho-media:')) { video.src = result.videoUrl; video.load(); }
  video.playbackRate = Number($('rate').value);
  paintPlayback();
}
async function play() {
  if (playing) { stop(); return; }
  const range = bounds();
  if (logicalTime() >= range.max - 0.05) seekTo(range.min);
  const generation = ++playbackGeneration;
  try {
    await Promise.all(activeVideos().map(({ video }) => video.play()));
    if (generation !== playbackGeneration) { videos.forEach(video => video.pause()); return; }
    playing = activeVideos().length > 0; $('play').textContent = playing ? '일시 정지' : '함께 재생';
  } catch (error) { stop(); $('playbackStatus').textContent = `영상을 재생할 수 없습니다: ${error.message}`; }
}
function tick() {
  if (playing) {
    const time = logicalTime(), range = bounds();
    if (time >= range.max - 0.025) stop();
    else activeVideos().slice(1).forEach(({ video, index }) => { const expected = time + offset(index); if (Math.abs(video.currentTime - expected) > 0.12 && !video.seeking) video.currentTime = Math.min(video.duration, Math.max(0, expected)); });
    paintPlayback();
  }
  requestAnimationFrame(tick);
}
function drawTable(hostId, rows) {
  const table = node('table'), head = node('thead'), header = node('tr');
  header.append(node('th', '항목'));
    results.forEach((result, index) => header.append(node('th', resultName(result, index))));
  head.append(header); table.append(head);
  const body = node('tbody');
  rows.forEach(row => { const tr = node('tr'); tr.append(node('td', row.label)); row.values.forEach((value, index) => tr.append(node('td', value, row.changed?.[index] ? 'changed' : ''))); body.append(tr); });
  table.append(body); $(hostId).replaceChildren(table);
}
function drawReport(bundle, preserveSelections = false) {
  const report = bundle.report;
  const selectedIds = preserveSelections ? selectedCandidateIds() : [];
  if (!preserveSelections) comparisonLimit = null;
  results = [...(report.controlResult ? [{ ...report.controlResult, candidate: { ...report.controlResult.candidate, isSourceControl: true } }] : []), ...list(report.results)];
  $('reportContent').hidden = false; $('compareEmpty').hidden = true;
  $('reportTitle').textContent = `${dateLabel(report.startedUtc)} 실험`;
  const target = reportTarget(bundle);
  const { actionLabel, sourceLabel } = target;
  $('reportMeta').textContent = `${report.runId || bundle.runId} · ${sourceLabel ? `${sourceLabel} · ` : ''}${actionLabel} · Seed ${report.seed ?? '—'} · ${results.length}개 기록 · 원본 해시 ${report.sourceDependencyHash?.slice(0, 12) || '정보 없음'}`;
  const winner = $('winner').value;
  drawComparisonCount(selectedIds);
  $('winner').replaceChildren(); option($('winner'), '후보 선택', '');
  const winnerIds = new Set();
  results.filter(result => !result.candidate?.isSourceControl).forEach((result, index) => {
    if (!winnerIds.has(result.candidate?.id)) { option($('winner'), candidateName(result.candidate, index), result.candidate?.id || ''); winnerIds.add(result.candidate?.id); }
  });
  $('winner').value = results.some(result => result.candidate?.id === winner) ? winner : '';
  const definitions = [['상태', result => runStatus(result)], ['공격 요청', result => fmt(result.metrics?.attackRequests)], ['명중 이벤트', result => fmt(result.metrics?.hits)], ['가한 피해', result => fmt(result.metrics?.damageDealt)], ['받은 피해', result => fmt(result.metrics?.damageTaken)], ['첫 명중 · 초', result => finite(result.metrics?.firstHitSeconds) && result.metrics.firstHitSeconds >= 0 ? fmt(result.metrics.firstHitSeconds) : '없음'], ['실행 시간 · 초', result => fmt(result.metrics?.elapsedSeconds)]];
  drawTable('metrics', definitions.map(([label, get]) => ({ label, values: results.map(get) })));
  const specs = parametersOf(target.action, bundle.request?.schemaVersion || 1);
  const ids = [...new Set(results.flatMap(result => [...list(result.candidate?.values), ...list(result.metrics?.appliedValues)].map(value => value.id).filter(Boolean)))];
  const tuningIds = new Set([...specs.map(spec => spec.id), ...results.flatMap(result => list(result.candidate?.values).map(value => value.id))]);
  const parameterRow = id => {
    const values = results.map(result => { const applied = list(result.metrics?.appliedValues).find(value => value.id === id), requested = list(result.candidate?.values).find(value => value.id === id); return { value: applied?.value ?? requested?.value, applied: Boolean(applied), requested: requested?.value }; });
    const spec = specs.find(item => item.id === id);
    return { label: spec ? parameterName(spec) : id, values: values.map(value => `${fmt(value.value)}${value.applied ? ' (실제)' : ' (요청)'}${value.applied && finite(value.requested) && Math.fround(value.requested) !== Math.fround(value.value) ? ` · 요청 ${fmt(value.requested)}` : ''}`), changed: values.map(value => finite(value.value) && finite(values[0]?.value) && value.value !== values[0].value) };
  };
  drawTable('parameters', ids.filter(id => tuningIds.has(id)).map(parameterRow));
  const runtimeIds = ids.filter(id => !tuningIds.has(id));
  $('runtimeDetails').hidden = !runtimeIds.length;
  drawTable('runtimeParameters', runtimeIds.map(parameterRow));
  $('runNotes').replaceChildren();
  if (bundle.request?.generation?.guideVersion) $('runNotes').append(node('p', `참고 가이드 ${bundle.request.generation.guideVersion} · ${bundle.request.generation.guideHash?.slice(0, 12)} · ${bundle.request.generation.mode || 'explore'} · ${bundle.request.generation.recipeId || '전체 레시피'}`));
  if (report.sourceContext) {
    const context = node('details'); context.append(node('summary', `실행 전 원본 맥락 · ${report.sourceContextHash?.slice(0, 12) || '해시 없음'}`), node('p', report.sourceContextCapturedUtc || '', 'fine-print'), node('pre', typeof report.sourceContext === 'string' ? report.sourceContext : JSON.stringify(report.sourceContext, null, 2))); $('runNotes').append(context);
  }
  list(report.notes).forEach(note => $('runNotes').append(node('p', note)));
  results.forEach((result, index) => {
    $('runNotes').append(node('strong', candidateName(result.candidate, index)));
    const rationale = result.candidate?.rationale || list(bundle.request?.candidates).find(candidate => candidate.id === result.candidate?.id)?.rationale;
    if (rationale) $('runNotes').append(node('p', `${bundle.request?.generation ? 'AI 제안 이유 (실험 전 예상)' : '후보 설명'}: ${rationale}`));
    if (result.error) $('runNotes').append(node('p', result.error, 'run-note-error'));
    list(result.metrics?.notes).forEach(note => $('runNotes').append(node('p', note)));
    const events = list(result.metrics?.events);
    const limits = [...new Set(events.filter(event => event.kind === 'value-limited').map(event => event.detail))];
    limits.forEach(detail => {
      const requested = /requested=([^; ]+)/.exec(detail)?.[1], applied = /applied=([^; ]+)/.exec(detail)?.[1];
      $('runNotes').append(node('p', `실행 중 적용 제한 · 요청 ${requested || '—'} → 실제 ${applied || '—'} · ${detail}`, 'run-note-error'));
    });
    if (events.length) { const details = node('details'); details.append(node('summary', `전투 이벤트 ${events.length}개`), node('pre', events.map(event => `${fmt(event.realTime)}s real / ${fmt(event.gameTime)}s game · ${event.kind || ''} · ${event.detail || ''} · ${fmt(event.value)}${event.kind === 'camera-output' ? ` · 최종 위치 ${JSON.stringify(event.position)} · 회전 ${JSON.stringify(event.rotation)} · FOV ${fmt(event.fov)}` : ''}`).join('\n'))); $('runNotes').append(details); }
  });
  drawPrecision(bundle);
  updateControls();
}
function drawPrecision(bundle) {
  const control = bundle.report.controlResult, select = $('precisionCandidate'), previous = select.value;
  if (precisionReportId !== bundle.report.runId) { precisionTime = 0; precisionReportId = bundle.report.runId; }
  select.replaceChildren();
  list(bundle.report.results).forEach((result, index) => option(select, resultName(result, index), index));
  select.value = Array.from(select.options).some(option => option.value === previous) ? previous : '0';
  $('precisionPanel').hidden = !control && !bundle.report.results.some(result => result.capture);
  const draw = () => {
    const host = $('precisionGrid'); host.replaceChildren();
    const chosen = bundle.report.results[Number(select.value)], rows = [control, chosen];
    const panels = [];
    const paintAll = () => {
      $('precisionStatus').textContent = `${control ? '원본 기준과 선택 후보' : '원본 기준 없음'} · 공통 명중 기준 ${precisionTime >= 0 ? '+' : ''}${(precisionTime * 1000).toFixed(1)}ms · 가장 가까운 실제 캡처`;
      panels.forEach(panel => panel.paint());
    };
    rows.forEach((result, rowIndex) => {
      const card = node('article', undefined, 'precision-card'); card.append(node('strong', rowIndex === 0 ? '원본 그대로' : resultName(result)));
      const frames = list(result?.capture?.frames).filter(frame => frame.imageUrl && finite(frame.relativeTimeSeconds) && frame.kind !== 'terminalHold');
      const image = node('img'); image.alt = rowIndex === 0 ? '원본 명중 캡처' : '후보 명중 캡처';
      const output = node('p', '', 'fine-print'), controls = node('div', undefined, 'inline-actions');
      let index = 0;
      const paint = () => {
        if (!frames.length) { image.hidden = true; output.textContent = `정밀 캡처 없음 · ${captureStatusName(result?.capture?.precisionStatus)}`; return; }
        index = nearestCaptureIndex(frames, precisionTime);
        const frame = frames[index];
        if (image.src !== frame.imageUrl) { image.hidden = true; image.src = frame.imageUrl; }
        else image.hidden = !image.complete || !image.naturalWidth;
        const interval = index > 0 ? (frame.unityRealtimeUs - frames[index - 1].unityRealtimeUs) / 1000 : null;
        const errorMs = (frame.relativeTimeSeconds - precisionTime) * 1000;
        output.textContent = `캡처 ${index + 1}/${frames.length} · 명중 ${(frame.relativeTimeSeconds * 1000).toFixed(1)}ms · 정렬 오차 ${errorMs >= 0 ? '+' : ''}${errorMs.toFixed(1)}ms · 직전 간격 ${interval == null ? '—' : `${interval.toFixed(1)}ms`} · ${captureStatusName(result.capture.precisionStatus)}`;
      };
      for (const [label, delta] of [['이전 캡처', -1], ['다음 캡처', 1]]) { const button = node('button', label, 'subtle small'); button.disabled = !frames.length;
        button.addEventListener('click', () => { const target = Math.min(frames.length - 1, Math.max(0, index + delta)); precisionTime = frames[target].relativeTimeSeconds; paintAll(); }); controls.append(button); }
      const zero = node('button', '명중 시점', 'subtle small'); zero.disabled = !frames.length;
      zero.addEventListener('click', () => { precisionTime = 0; paintAll(); }); controls.append(zero);
      image.addEventListener('load', () => { image.hidden = false; });
      image.addEventListener('error', () => { output.textContent = '캡처 이미지를 읽지 못했습니다.'; image.hidden = true; });
      card.append(image, controls, output); host.append(card); panels.push({ paint });
    });
    paintAll();
  };
  select.onchange = draw; draw();
}
function nearestCaptureIndex(frames, time) {
  let best = 0, distance = Infinity;
  frames.forEach((frame, index) => { const current = Math.abs(frame.relativeTimeSeconds - time); if (current < distance - 1e-9) { best = index; distance = current; } });
  return best;
}
function stepCaptured(direction) {
  stop();
  const first = activeVideos()[0]; if (!first) return;
  const frames = list(selected(first.index)?.capture?.timelineFrames || selected(first.index)?.capture?.frames).filter(frame => frame.kind !== 'terminalHold' && finite(frame.mediaPtsUs));
  const current = first.video.currentTime;
  const next = direction > 0 ? frames.find(frame => frame.mediaPtsUs / 1000000 > current + 0.00001)
    : [...frames].reverse().find(frame => frame.mediaPtsUs / 1000000 < current - 0.00001);
  if (next) { seekTo(next.mediaPtsUs / 1000000 - offset(first.index)); $('playbackStatus').textContent = '기록된 캡처 시각으로 이동했습니다. 영상 디코더의 표시 프레임은 PNG 정밀 캡처와 다를 수 있습니다.'; }
  else if (frames.length) $('playbackStatus').textContent = '이 방향에 기록된 캡처가 없습니다.';
  else { seekTo(logicalTime() + direction / 60); $('playbackStatus').textContent = '캡처 시각 자료 없음 · 1/60초만 이동했습니다. 정확한 프레임 이동이 아닙니다.'; }
}
async function openReport(runId, options = {}) {
  if (state.reportLoading) return;
  state.reportLoading = true;
  const generation = state.reportGeneration;
  try {
    const bundle = await api.loadReport(runId);
    if (generation !== state.reportGeneration || !bundle?.report) return;
    const switching = state.selectedRunId !== runId || !state.reportBundle;
    if (switching) { $('feedback').value = ''; $('winner').value = ''; $('runtimeDetails').open = false; }
    state.selectedRunId = runId;
    state.reportBundle = bundle;
    const signature = JSON.stringify(bundle.report);
    if (signature !== state.reportSignature) { state.reportSignature = signature; drawReport(bundle, !switching); }
    if (switching) {
      const judgment = bundle.judgment;
      $('feedback').value = typeof judgment?.feedback === 'string' ? judgment.feedback : '';
      $('winner').value = results.some(result => result.candidate?.id === judgment?.selectedCandidateId) ? judgment.selectedCandidateId : '';
      updateControls();
    }
    if (options.switchView !== false) showView('compare');
    drawHistory();
  } catch (error) { if (!options.quiet) throw error; }
  finally { state.reportLoading = false; }
}

$('dismissMessage').addEventListener('click', () => message(''));
$('setupTab').addEventListener('click', () => showView('setup'));
$('compareTab').addEventListener('click', () => {
  showView('compare');
  if (!state.reportBundle) {
    const latest = list(state.snapshot?.runs)[0];
    if (latest) operation(() => openReport(latest.id));
  }
});
$('goSetup').addEventListener('click', () => showView('setup'));
for (const id of ['setupTab', 'compareTab']) $(id).addEventListener('keydown', event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { const next = id === 'setupTab' ? 'compare' : 'setup'; showView(next); $(next + 'Tab').focus(); event.preventDefault(); } });
$('chooseProject').addEventListener('click', () => operation(async () => { const snapshot = await api.chooseProject(); if (snapshot) { applySnapshot(snapshot); message(''); } }));
$('adapter').addEventListener('change', () => chooseSource($('adapter').value));
$('source').addEventListener('change', () => chooseSource($('adapter').value, $('source').value));
$('action').addEventListener('change', () => state.selectedActions.includes($('action').value) ? focusAction($('action').value) : chooseSource($('adapter').value, $('source').value, $('action').value));
$('goal').addEventListener('input', updateControls);
$('candidateTotal').addEventListener('input', updateControls);
$('refreshCatalog').addEventListener('click', () => operation(async () => {
  const previousAction = JSON.stringify(currentAction());
  const [catalog, ai] = await Promise.all([api.describe(), api.aiStatus()]);
  state.catalog = catalog;
  if (state.snapshot) state.snapshot.ai = ai;
  reconcileSelection(previousAction);
  message('프로젝트와 AI 연결 정보를 새로 불러왔습니다.');
}));
$('generateCandidates').addEventListener('click', () => generateAction(state.selection?.actionId));
$('aiProvider').addEventListener('change', async () => {
  const provider = $('aiProvider').value;
  state.changingProvider = true; updateControls();
  try {
    const ai = await api.setAiProvider(provider);
    if (state.snapshot) state.snapshot.ai = ai;
    message(ai.available && ai.authenticated ? `AI 엔진: ${ai.label}` : ai.error || 'AI 연결과 로그인을 확인하세요.', !(ai.available && ai.authenticated));
  } catch (error) {
    if (state.snapshot?.ai?.preference) $('aiProvider').value = state.snapshot.ai.preference;
    message(error?.message || String(error), true);
  } finally { state.changingProvider = false; updateControls(); }
});
async function generateAction(id) {
  if (locked() || !state.actionDrafts[id]) return;
  focusAction(id);
  if (!actionAvailable()) return;
  const draft = state.actionDrafts[id], schema = draft.schema;
  const count = Number(draft.count), goal = draft.goal.trim();
  if (!goal || !Number.isInteger(count) || count < 2 || count > 12) { message('원하는 감각과 2–12개 사이의 후보 수를 입력하세요.', true); return; }
  const projectGeneration = state.projectGeneration;
  const signature = draftSignature(draft);
  const conditions = conditionsOf(draft.request), options = draft.options || designOptions();
  const referenceCandidate = list(draft.request.candidates).find(candidate => candidate.id === options.referenceCandidateId)
    || (draft.request.schemaVersion === 2 ? tuning.sourceCandidate(currentParameters(), currentCurves(), 'source-reference') : undefined);
  state.generating = true; state.generatingActionId = id; state.generationCancelled = false; updateControls(); message('');
  try {
    const generated = await api.generateCandidates({ adapterId: draft.request.adapterId, sourceGuid: draft.request.sourceGuid, actionId: id, goal, count,
      schemaVersion: draft.request.schemaVersion, ...options, referenceCandidate, observationRef: observationReference(draft, referenceCandidate) });
    if (projectGeneration !== state.projectGeneration || state.generationCancelled || state.actionDrafts[id] !== draft) return;
    if (signature !== draftSignature(draft) || schema !== draft.schema) throw new Error('생성 중에 목표 또는 공격 데이터가 변경되었습니다. 새 목표로 다시 생성하세요.');
    if (generated?.candidates?.length !== count) throw new Error('AI가 요청한 개수의 후보를 반환하지 않았습니다. 다시 생성하세요.');
    if (generated.adapterId !== draft.request.adapterId || generated.sourceGuid !== draft.request.sourceGuid || actionIdOf(generated) !== id) throw new Error('AI 후보의 실험 대상이 현재 선택과 다릅니다. 다시 생성하세요.');
    const request = { ...generated, ...conditions };
    validate(request);
    if (state.selection?.actionId === id) replaceRequest(request, 'ai');
    else { Object.assign(draft, { request: copy(request), requestOrigin: 'ai', generatedSignature: signature, candidateId: '', runId: null }); drawActionPanels(); }
    message(`${locate(request).action?.label || actionName(id)}: AI가 ${count}개 후보의 수치를 작성했습니다. 제안 이유를 확인한 뒤 비교 실행을 누르세요.`);
  } catch (error) {
    message(state.generationCancelled ? 'AI 후보 생성을 취소했습니다.' : error?.message || String(error), !state.generationCancelled);
  } finally {
    state.generating = false; state.generatingActionId = null;
    if (state.snapshot?.ai) state.snapshot.ai.generating = false;
    if (state.generationCancelled) message('AI 후보 생성을 취소했습니다.');
    state.generationCancelled = false; updateControls(); await refresh();
  }
}
$('cancelGeneration').addEventListener('click', cancelCandidateGeneration);
async function cancelCandidateGeneration() {
  if (!generating() || state.generationCancelled) return;
  state.generationCancelled = true; updateControls();
  try { await api.cancelGeneration(); }
  catch (error) { state.generationCancelled = false; message(error?.message || String(error), true); updateControls(); }
}
function updateConditions(key, value) {
  if (state.request) state.request[key] = value;
  for (const draft of Object.values(state.actionDrafts)) if (draft.request) draft.request[key] = value;
  updateControls();
}
$('duration').addEventListener('input', () => updateConditions('durationSeconds', $('duration').value === '' ? NaN : Number($('duration').value)));
$('seed').addEventListener('input', () => updateConditions('seed', $('seed').value === '' ? NaN : Number($('seed').value)));
$('recordVideo').addEventListener('change', () => {
  if (!$('recordVideo').checked && state.request?.schemaVersion === 2) { $('precisionCapture').checked = false; updateConditions('precisionCapture', false); message('영상 녹화를 끄면서 명중 정밀 캡처도 해제했습니다.'); }
  updateConditions('recordVideo', $('recordVideo').checked);
});
$('includeSourceControl').addEventListener('change', () => updateConditions('includeSourceControl', $('includeSourceControl').checked));
$('precisionCapture').addEventListener('change', () => {
  if ($('precisionCapture').checked && !$('recordVideo').checked) { $('recordVideo').checked = true; updateConditions('recordVideo', true); }
  updateConditions('precisionCapture', $('precisionCapture').checked);
});
for (const id of ['scenarioMode', 'precisionTargetId']) $(id).addEventListener('change', () => updateConditions(id, $(id).value));
$('repeatCount').addEventListener('change', () => updateConditions('repeatCount', Number($('repeatCount').value)));
for (const id of ['generationMode', 'generationStrategy', 'recipeId', 'referenceCandidate', 'refineFeedback']) $(id).addEventListener('change', () => { saveFocusedDraft(); if (id === 'referenceCandidate') drawDesignOptions(state.actionDrafts[state.selection?.actionId]); updateControls(); });
$('addManualCandidate').addEventListener('click', () => {
  if (locked() || state.request?.schemaVersion !== 2 || state.request.candidates.length >= 12) return;
  let index = 1; while (state.request.candidates.some(candidate => candidate.id === `manual-${index}`)) index++;
  const candidate = tuning.sourceCandidate(currentParameters(), currentCurves(), `manual-${index}`);
  candidate.values = []; candidate.curves = [];
  candidate.label = `직접 편집 ${index}`; state.request.candidates.push(candidate); state.requestOrigin = 'manual';
  $('candidateTotal').value = Math.max(2, state.request.candidates.length);
  state.generatedSignature = generationSignature(); saveFocusedDraft(); drawCandidates(); drawActionPanels(); updateControls();
});
$('importRequest').addEventListener('click', () => operation(async () => {
  const request = await api.loadRequest();
  if (request) {
    validate(request);
    if (request.schemaVersion === 1 && request.candidates.length < 2) throw new Error('v1 비교 실험에는 후보가 2개 이상 필요합니다.');
    saveFocusedDraft();
    if (request.adapterId === state.selection?.adapterId && request.sourceGuid === state.selection?.sourceGuid && actionConflict([...state.selectedActions, actionIdOf(request)])) throw new Error('전체 콤보와 개별 일반 공격은 함께 선택할 수 없습니다. 충돌하는 동작을 해제한 뒤 불러오세요.');
    $('candidateTotal').value = request.candidates.length;
    if (typeof request.generation?.goal === 'string' && request.generation.goal.trim()) $('goal').value = request.generation.goal;
    replaceRequest(request, 'import'); message('실험 JSON의 후보를 불러왔습니다. v2 후보의 절대값과 곡선을 직접 편집할 수 있습니다.');
    for (const key of conditionKeys) if (request[key] !== undefined) updateConditions(key, request[key]);
  }
}));
$('exportRequest').addEventListener('click', () => operation(async () => { const result = await api.saveRequest(validate(state.request)); if (result && !result.cancelled) message(`실험 JSON을 저장했습니다: ${result.path}`); }));
$('runExperiment').addEventListener('click', () => operation(() => runAction(state.selection?.actionId), { refresh: true }));
async function runAction(id) {
  if (!state.selectedActions.includes(id)) throw new Error('실행할 동작을 선택하세요.');
  focusAction(id);
  if (!requestReady()) throw new Error('현재 목표와 후보 수에 맞춰 AI 후보를 생성하세요.');
  const request = copy(validate(state.request));
  state.starting = true; state.cancelRequested = false; updateControls(); message('');
  try {
    const result = await api.run(request);
    if (state.actionDrafts[id]) state.actionDrafts[id].runId = result.runId;
    drawActionPanels();
    state.activeRunId = result.runId; state.wasRunning = true;
    if (state.snapshot) state.snapshot.connection = { ...state.snapshot.connection, running: true, status: '실험 시작 · Unity 준비 중' };
    message('실험을 시작했습니다. 완료되면 결과 비교가 열립니다.');
  } finally { state.starting = false; }
}
$('cancelRun').addEventListener('click', () => operation(async () => { await api.cancel(); state.cancelRequested = true; message('취소를 요청했습니다. 현재 기록과 Unity 상태를 정리하는 동안 기다려주세요.'); }, { refresh: true }));
$('cancelMultiRun').addEventListener('click', () => operation(async () => { await api.cancel(); state.cancelRequested = true; message('취소를 요청했습니다. 현재 동작의 기록과 Unity 상태를 정리하는 동안 기다려주세요.'); }, { refresh: true }));
async function exportPreset(request, candidateId) {
  if (!candidateId) throw new Error('저장할 후보를 선택하세요.');
  const result = await api.exportPreset({ request: validate(request), candidateId });
  if (result && !result.cancelled) message(`새 프리셋을 저장했습니다: ${result.assetPath}`);
}
$('exportEditorPreset').addEventListener('click', () => operation(() => exportPreset(state.request, $('editorCandidate').value)));
$('editorCandidate').addEventListener('change', () => {
  const draft = state.actionDrafts[state.selection?.actionId];
  if (draft) draft.candidateId = $('editorCandidate').value;
  updateControls();
});
$('exportReportPreset').addEventListener('click', () => operation(() => exportPreset(state.reportBundle?.request, $('winner').value)));
$('exportCombinedPreset').addEventListener('click', () => operation(async () => {
  const result = await api.exportCombinedPreset({ request: combinedRequest() });
  if (result && !result.cancelled) message(`${state.selectedActions.length}개 동작의 선택 후보를 새 SO 하나에 저장했습니다: ${result.assetPath}`);
}));
$('useReportCandidate').addEventListener('click', () => {
  const draft = reportDraft(), candidateId = $('winner').value;
  if (!draft || !list(draft.request.candidates).some(candidate => candidate.id === candidateId)) { message('현재 생성된 후보와 일치하는 비교 결과에서 후보를 선택하세요.', true); return; }
  draft.candidateId = candidateId; drawActionPanels(); updateControls();
  message(`${locate(draft.request).action?.label || actionName(actionIdOf(draft.request))}의 최종 후보를 선택했습니다. 나머지 동작도 선택한 뒤 실험 설계에서 SO 하나로 저장하세요.`);
});
$('winner').addEventListener('change', updateControls);
$('repeatSelected').addEventListener('click', () => operation(async () => {
  const request = copy(state.reportBundle?.request), candidate = list(request?.candidates).find(item => item.id === $('winner').value);
  if (request?.schemaVersion !== 2 || !candidate) throw new Error('v2 결과의 재확인할 후보를 선택하세요.');
  request.candidates = [candidate]; request.repeatCount = 3; request.includeSourceControl = true;
  validate(request); state.starting = true; state.cancelRequested = false; updateControls();
  try {
    const result = await api.run(request); state.activeRunId = result.runId; state.wasRunning = true;
    if (state.snapshot) state.snapshot.connection = { ...state.snapshot.connection, running: true, status: '선택 후보 3회 재확인 중' };
    message('원본 기준과 선택 후보 3회의 새 실험을 시작했습니다.');
  } finally { state.starting = false; }
}, { refresh: true }));
$('saveJudgment').addEventListener('click', () => operation(async () => { const result = await api.saveJudgment({ runId: state.selectedRunId, candidateId: $('winner').value || null, feedback: $('feedback').value }); message(`판단 기록을 저장했습니다: ${result.path}`); }));
$('revealRun').addEventListener('click', () => operation(() => api.revealRun(state.selectedRunId)));
$('compareCount').addEventListener('change', () => { comparisonLimit = Number($('compareCount').value); drawVideoGrid(comparisonLimit, selectedCandidateIds()); });
$('play').addEventListener('click', play);
$('restart').addEventListener('click', () => { stop(); seekTo(bounds().min); });
$('previous').addEventListener('click', () => stepCaptured(-1));
$('next').addEventListener('click', () => stepCaptured(1));
$('seek').addEventListener('input', () => { stop(); seekTo(Number($('seek').value)); });
$('rate').addEventListener('change', () => videos.forEach(video => { video.playbackRate = Number($('rate').value); }));
$('sound').addEventListener('change', () => videos.forEach((video, index) => { video.muted = $('sound').value !== String(index); }));
$('align').addEventListener('change', () => {
  stop(); seekTo(bounds().min);
  paintAlignment();
});

const darkMode = window.matchMedia('(prefers-color-scheme: dark)');
function syncThemeSelection() {
  $(darkMode.matches ? 'themeDark' : 'themeLight').checked = true;
}
syncThemeSelection();
darkMode.addEventListener('change', syncThemeSelection);
for (const input of [$('themeLight'), $('themeDark')]) {
  input.disabled = !api;
  input.addEventListener('change', async () => {
    try {
      await api.setTheme(input.value);
    } catch {
      syncThemeSelection();
      message('화면 모드를 저장할 수 없습니다. 다시 시도하세요.', true);
    }
  });
}

paintPlayback();
requestAnimationFrame(tick);
if (api) {
  operation(async () => { applySnapshot(await api.bootstrap()); }).finally(() => { setInterval(refresh, 1500); });
} else {
  message('데스크톱 연결을 찾을 수 없습니다. Baekho Studio 앱에서 이 화면을 실행하세요.', true);
  updateControls();
}
