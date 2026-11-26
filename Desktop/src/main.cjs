const { app, BrowserWindow, nativeTheme, protocol, net, ipcMain, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const { ProjectClient } = require('./project-client.cjs');
const { createMediaResponse } = require('./media-response.cjs');
const { CodexCandidateGenerator, ClaudeCodeCandidateGenerator } = require('./ai-candidates.cjs');
const tuning = require('../renderer/tuning-contract.js');

app.setName('Baekho Studio');
protocol.registerSchemesAsPrivileged([
  { scheme: 'baekho', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'baekho-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
const argument = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const diagnosticPath = argument('--diagnostic-output');
const testMode = !!diagnosticPath;
const diagnosticConsoleErrors = [];
if (testMode) app.setPath('userData', path.resolve(path.dirname(diagnosticPath), 'electron-profile'));
let window, client = null, catalog = { adapters: [] }, catalogPromise = null, catalogNeedsRefresh = true;
let generation = 0;
const media = new Map();
const rendererRoot = path.join(__dirname, '../renderer');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const windowBackground = { light: '#f4f6f8', dark: '#10151d' };
let settings = {};
const candidateGenerators = { codex: new CodexCandidateGenerator(), claude: new ClaudeCodeCandidateGenerator() };
const AI_PROVIDER_PREFERENCES = ['auto', 'codex', 'claude'];
let aiJob = null, aiStatusPromise = null, aiStatusCheckedAt = 0;
let aiConnection = { available: false, authenticated: false, provider: 'codex', label: 'AI 연결 확인 중', error: '' };
function loadKnowledge(recipeId = '') {
  const guide = fs.readFileSync(path.join(__dirname, '../knowledge/combat-feel-guide.md'), 'utf8');
  const recipeSnapshot = fs.readFileSync(path.join(__dirname, '../knowledge/recipe-library.json'), 'utf8');
  const library = JSON.parse(recipeSnapshot);
  if (library.schemaVersion !== 1 || !Array.isArray(library.recipes)) throw new Error('타격감 지식 파일 형식이 올바르지 않습니다.');
  const selected = recipeId ? library.recipes.find(recipe => recipe.id === recipeId) : null;
  if (recipeId && !selected) throw new Error('선택한 타격감 레시피를 찾을 수 없습니다.');
  return { version: library.version, guide, recipes: library.recipes, selectedRecipe: selected, recipeSnapshot,
    hash: createHash('sha256').update(guide).update(recipeSnapshot).digest('hex') };
}
function loadObservations(target, observationRef, identity, referenceCandidate) {
  if (!observationRef) return null;
  if (typeof observationRef.runId !== 'string' || typeof observationRef.candidateId !== 'string') throw new Error('참고할 측정 기록을 다시 선택하세요.');
  const { report } = target.loadReport(observationRef.runId);
  if (report.adapterId !== identity.adapterId || report.sourceGuid !== identity.sourceGuid || (report.actionId || 'normal-combo') !== identity.actionId ||
      identity.sourceHash && report.sourceDependencyHash !== identity.sourceHash) throw new Error('측정 기록의 동작 또는 원본 버전이 현재 후보와 다릅니다.');
  const rows = [...report.results, report.controlResult].filter(row => row?.candidate?.id === observationRef.candidateId);
  if (!rows.length) throw new Error('참고할 후보의 측정 기록이 없습니다.');
  const configuration = candidate => JSON.stringify({ values: (identity.parameters ? tuning.effectiveValues(candidate || { values: [] }, identity.parameters, identity.curves || []) : [...(candidate?.values || [])]).map(value => ({ id: value.id, value: Math.fround(value.value) })).sort((a, b) => a.id.localeCompare(b.id)),
    curves: tuning.activePatch(candidate || { values: [] }).curves.map(curve => ({ id: curve.id, keys: curve.keys.map(key => ({ time: Math.fround(key.time), value: Math.fround(key.value) })) })).sort((a, b) => a.id.localeCompare(b.id)) });
  const referenceValues = identity.parameters ? tuning.effectiveValues(referenceCandidate || { values: [] }, identity.parameters, identity.curves || []) : [];
  const measuredValues = rows.map(row => new Map((row.metrics?.appliedValues || []).map(value => [value.id, value.value])));
  const inheritedValuesVerified = referenceValues.length > 0 && measuredValues.every(values => referenceValues.every(value => Number.isFinite(values.get(value.id))));
  const authoredMatch = configuration(referenceCandidate) === configuration(rows[0].candidate);
  const measuredMatch = inheritedValuesVerified && measuredValues.every(values => referenceValues.every(value => Math.fround(value.value) === Math.fround(values.get(value.id))));
  const observations = { schemaVersion: 1, runId: report.runId, sourceHash: report.sourceDependencyHash,
    sourceContextHash: report.sourceContextHash || '',
    measuredCandidateId: rows[0].candidate.id, measuredRevision: rows[0].candidate.revision || 1,
    referenceCandidateId: referenceCandidate?.id || '', referenceRevision: referenceCandidate?.revision || 1,
    referenceMatchesMeasuredConfiguration: !authoredMatch ? false : inheritedValuesVerified ? measuredMatch : null,
    referenceValuesVerifiedFromAppliedValues: inheritedValuesVerified,
    note: 'These observations measure only the named candidate at the recorded revision. Edited or descendant candidates remain untested.',
    repeats: rows.map(row => ({ repeatIndex: row.repeatIndex || 1, status: row.status,
      metrics: Object.fromEntries(['attackRequests', 'hits', 'damageDealt', 'damageTaken', 'firstHitSeconds', 'elapsedSeconds'].map(key => [key, row.metrics?.[key]])),
      appliedValues: row.metrics?.appliedValues || [], notes: row.metrics?.notes || [],
      events: (row.metrics?.events || []).filter(event => /^(confirmed-impact|hitstop-|camera-begin|camera-end|camera-return-|value-limited)/.test(event.kind)),
      capture: row.capture ? Object.fromEntries(['precisionStatus', 'capturedFrameCount', 'medianIntervalUs', 'maxIntervalUs', 'gapsOver33333Us'].map(key => [key, row.capture[key]])) : null,
      fixtureValidation: row.fixtureValidation || null })) };
  if (Buffer.byteLength(JSON.stringify(observations)) > 128 * 1024) throw new Error('참고 측정 기록이 128KiB를 넘습니다. 단일 동작·타격으로 시험 범위를 나눠 다시 생성하세요.');
  return observations;
}
const aiProviderPreference = () => AI_PROVIDER_PREFERENCES.includes(settings.aiProvider) ? settings.aiProvider : 'auto';
async function providerStatus(provider) {
  try { return { ...await candidateGenerators[provider].status(), provider }; }
  catch {
    const name = provider === 'claude' ? 'Claude Code' : 'Codex';
    return { available: false, authenticated: false, provider, label: `${name} 연결 확인 필요`, error: `${name} 설치와 로그인을 확인하세요.` };
  }
}
// Explicit choice uses only that CLI. Auto prefers Codex and falls back to a logged-in Claude Code.
async function resolveAiConnection(preference) {
  if (preference !== 'auto') return providerStatus(preference);
  const codex = await providerStatus('codex');
  if (codex.available && codex.authenticated) return codex;
  const claude = await providerStatus('claude');
  if (claude.available && claude.authenticated) return claude;
  if (codex.available) return codex;
  if (claude.available) return claude;
  return { available: false, authenticated: false, provider: 'codex', label: 'AI 연결 필요',
    error: 'Codex 또는 Claude Code CLI를 설치하고 로그인한 뒤 연결 정보를 새로고침하세요.' };
}
async function aiStatus(force = false) {
  if (!aiStatusPromise && (force || !aiStatusCheckedAt || Date.now() - aiStatusCheckedAt > 30000)) {
    const preference = aiProviderPreference();
    const pending = resolveAiConnection(preference).then(value => { if (aiProviderPreference() === preference) aiConnection = value; })
      .finally(() => { aiStatusCheckedAt = Date.now(); if (aiStatusPromise === pending) aiStatusPromise = null; });
    aiStatusPromise = pending;
  }
  if (aiStatusPromise) await aiStatusPromise;
  return { ...aiConnection, preference: aiProviderPreference(), generating: !!aiJob };
}

function saveSettings(changes) {
  const next = { ...settings, ...changes };
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(file + '.tmp', file);
  settings = next;
}

function selectProject(projectPath) {
  const canonical = ProjectClient.validateProject(projectPath);
  if (client?.projectPath === canonical) return;
  if (aiJob) throw new Error('AI 후보 생성을 마치거나 취소한 뒤 프로젝트를 바꾸세요.');
  const previousStatus = client?.getStatus();
  if (previousStatus?.connected && previousStatus.running) throw new Error('현재 프로젝트의 실험을 마치거나 취소한 뒤 프로젝트를 바꾸세요.');
  const nextClient = new ProjectClient(canonical);
  saveSettings({ projectPath: canonical });
  client = nextClient; catalog = { adapters: [] }; catalogPromise = null; catalogNeedsRefresh = true; media.clear(); generation++;
}
function requireProject() { if (!client) throw new Error('먼저 Unity 프로젝트 폴더를 선택하세요.'); return client; }
async function describe() {
  const target = requireProject(), currentGeneration = generation;
  if (!target.getStatus().connected) throw new Error('Unity 프로젝트를 열고 연결 코드의 컴파일이 끝날 때까지 기다려 주세요.');
  if (!catalogPromise) {
    const pending = target.describe().then(value => {
      if (generation === currentGeneration) { catalog = value; catalogNeedsRefresh = false; }
      return value;
    }).finally(() => { if (catalogPromise === pending) catalogPromise = null; });
    catalogPromise = pending;
  }
  return catalogPromise;
}
async function snapshot() {
  const target = client, currentGeneration = generation;
  const ai = await aiStatus();
  let connection = target?.getStatus() ?? { connected: false, running: false, status: '프로젝트를 선택하세요', error: '' };
  // A domain reload or Editor restart can replace adapters and their schemas.
  // Refresh once when the Editor is ready again, retaining the cached catalog
  // while disconnected so selections and reports remain visible.
  if (!connection.connected || connection.isCompiling) catalogNeedsRefresh = true;
  if (target && connection.connected && !connection.running && !connection.isPlaying && !connection.isCompiling && catalogNeedsRefresh) {
    try { await describe(); } catch (error) { connection = { ...connection, error: error.message }; }
  }
  // The native project chooser can complete while describe is waiting on Unity.
  if (generation !== currentGeneration) return snapshot();
  return { projectPath: target?.projectPath ?? '', projectName: target ? path.basename(target.projectPath) : '',
    connection, catalog, ai, knowledge: loadKnowledge(), runs: target ? target.listRuns() : [] };
}
function boundedRequest(request) {
  if (!request || typeof request !== 'object' || ![1, 2].includes(request.schemaVersion) || !Array.isArray(request.candidates))
    throw new Error('올바른 실험 JSON을 선택하세요.');
  if (request.actionId != null && (typeof request.actionId !== 'string' || (request.actionId !== '' && !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(request.actionId))))
    throw new Error('실험의 공격·스킬 ID가 올바르지 않습니다.');
  if (Buffer.byteLength(JSON.stringify(request)) > 1000000) throw new Error('실험 요청이 너무 큽니다.');
  return request;
}
function boundedCombinedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.schemaVersion !== 1 ||
      typeof request.adapterId !== 'string' || !request.adapterId || typeof request.sourceGuid !== 'string' || !request.sourceGuid ||
      !Array.isArray(request.selections) || request.selections.length < 1 || request.selections.length > 32)
    throw new Error('하나의 폼에서 합칠 동작 1~32개와 각 동작의 후보를 선택하세요.');
  if (Buffer.byteLength(JSON.stringify(request)) > 1000000) throw new Error('합친 SO 저장 요청이 너무 큽니다.');
  const actions = new Set();
  for (const selection of request.selections) {
    const action = boundedRequest(selection?.request);
    if (action.adapterId !== request.adapterId || action.sourceGuid !== request.sourceGuid)
      throw new Error('하나의 SO에는 같은 어댑터와 같은 원본 폼의 동작만 합칠 수 있습니다.');
    const id = action.actionId || 'normal-combo';
    if (actions.has(id)) throw new Error('같은 동작을 두 번 선택할 수 없습니다.');
    actions.add(id);
    if (!Number.isFinite(action.durationSeconds) || action.durationSeconds < 3 || action.durationSeconds > 60 ||
        !Number.isInteger(action.seed) || action.seed < -2147483648 || action.seed > 2147483647 || typeof action.recordVideo !== 'boolean' ||
        action.candidates.length < 1 || action.candidates.length > 12)
      throw new Error('각 동작의 실험 설정과 후보 목록을 확인하세요.');
    const candidates = new Set();
    for (const candidate of action.candidates) {
      if (!candidate || typeof candidate.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(candidate.id) || candidates.has(candidate.id) ||
          !Array.isArray(candidate.values) || (!candidate.values.length && action.schemaVersion === 1))
        throw new Error('각 동작의 후보 ID와 수치가 올바르지 않습니다.');
      candidates.add(candidate.id);
      const parameters = new Set();
      for (const parameter of candidate.values) {
        if (!parameter || typeof parameter.id !== 'string' || !parameter.id || parameters.has(parameter.id) || !Number.isFinite(parameter.value))
          throw new Error('각 후보에는 중복 없는 유한한 수치가 필요합니다.');
        parameters.add(parameter.id);
      }
    }
    if (typeof selection.candidateId !== 'string' || !candidates.has(selection.candidateId))
      throw new Error('모든 동작에서 저장할 후보를 하나씩 선택하세요.');
  }
  return request;
}
function validateCombinedCatalog(request, description) {
  const adapter = description.adapters.find(item => item.id === request.adapterId);
  if (adapter?.supportsCombinedExport !== true) throw new Error('이 어댑터는 여러 동작을 하나의 SO로 저장하는 기능을 지원하지 않습니다. Unity 연결을 업데이트하세요.');
  const source = adapter.sources?.find(item => item.guid === request.sourceGuid);
  if (!source) throw new Error('합칠 공격의 원본 폼을 현재 프로젝트에서 찾을 수 없습니다.');
  for (const selection of request.selections) {
    const id = selection.request.actionId || 'normal-combo';
    const action = Array.isArray(source.actions) && source.actions.length
      ? source.actions.find(item => item.id === id)
      : id === 'normal-combo' ? { ...source, id, available: !source.error, unavailableReason: source.error } : null;
    if (!action || action.available === false || !Array.isArray(action.parameters) || !action.parameters.length)
      throw new Error(action?.unavailableReason || '선택한 동작을 지금 사용할 수 없습니다. 동작 목록을 새로고침하세요.');
    if (!(action.supportedRequestVersions || [action.defaultRequest?.schemaVersion || 1]).includes(selection.request.schemaVersion)) throw new Error('이 동작이 실험 JSON 버전을 지원하지 않습니다.');
    const parameters = selection.request.schemaVersion === 1 && action.legacyParameters?.length ? action.legacyParameters : action.parameters;
    for (const candidate of selection.request.candidates) {
      if (selection.request.schemaVersion === 1 && candidate.values.length !== parameters.length) throw new Error('공격 수치 구조가 변경되었습니다. 후보를 다시 생성하세요.');
      for (const parameter of candidate.values) {
        const spec = parameters.find(item => item.id === parameter.id);
        if (!spec || !tuning.validValue(parameter.value, spec)) throw new Error(`${action.label || id}: ${parameter.id} 허용 범위를 확인하고 후보를 다시 생성하세요.`);
      }
      const curveIds = new Set();
      for (const curve of candidate.curves || []) { const spec = (action.curves || []).find(item => item.id === curve?.id); if (!spec || curveIds.has(curve.id)) throw new Error('곡선 ID를 확인하세요.'); curveIds.add(curve.id); tuning.validateKeys(curve.keys, spec); }
    }
  }
}
async function chooseAssetPath(target, title, name) {
  const requireIdle = () => {
    if (client !== target) throw new Error('프로젝트가 변경되었습니다. 현재 프로젝트에서 다시 저장하세요.');
    const status = target.getStatus();
    if (!status.connected || status.running || status.isPlaying || status.isCompiling) throw new Error('Unity 편집 모드에서 프리셋을 저장하세요.');
  };
  requireIdle();
  const result = await dialog.showSaveDialog(window, { title,
    defaultPath: path.join(target.projectPath, 'Assets', name), filters: [{ name: 'Unity asset', extensions: ['asset'] }] });
  if (result.canceled) return null;
  requireIdle();
  const filename = path.basename(result.filePath);
  const assets = fs.realpathSync(path.join(target.projectPath, 'Assets'));
  const parent = fs.realpathSync(path.dirname(result.filePath));
  const parentRelative = path.relative(assets, parent);
  const relative = path.relative(target.projectPath, result.filePath).split(path.sep).join('/');
  let existing = false;
  for (const destination of [result.filePath, result.filePath + '.meta']) {
    try { fs.lstatSync(destination); existing = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!relative.startsWith('Assets/') || relative.includes('../') || existing || !/\.asset$/i.test(filename) ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(filename) || /[. ]$/.test(filename) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename) ||
      path.isAbsolute(parentRelative) || parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`))
    throw new Error('프로젝트 Assets 안의 새로운 .asset 파일로 저장하세요. 기존 파일은 덮어쓰지 않습니다.');
  return relative;
}
async function loadReport(runId) {
  const target = requireProject();
  const result = target.loadReport(runId);
  const grantFile = (filename, kind) => {
    kind === 'image' ? target.resolveImage(runId, filename, result.report) : target.resolveVideo(runId, filename, result.report);
    const previous = [...media].find(([, grant]) => grant.generation === generation && grant.runId === runId && grant.filename === filename && (grant.kind || 'video') === kind);
    const token = previous?.[0] || randomUUID();
    media.delete(token); media.set(token, { generation, runId, filename, kind });
    return `baekho-media://${kind}/${token}`;
  };
  for (const row of [...(result.report.results || []), result.report.controlResult].filter(Boolean)) {
    row.videoUrl = '';
    if (row.videoPath) {
      const filename = String(row.videoPath).replace(/\\/g, '/').split('/').pop();
      try { row.videoUrl = grantFile(filename, 'video'); } catch { row.videoUnavailable = true; }
    }
    for (const frame of (row.capture?.frames || []).slice(0, 48)) if (frame.imagePath) {
      try { frame.imageUrl = grantFile(frame.imagePath, 'image'); } catch { frame.imageUnavailable = true; }
    }
    if (row.capture?.framesPath) {
      try { row.capture.timelineFrames = target.loadCaptureTimeline(runId, row.capture); }
      catch { row.capture.timelineUnavailable = true; }
    }
  }
  // A report refresh should not retain media grants for every historical refresh forever.
  while (media.size > 2048) media.delete(media.keys().next().value);
  return result;
}
const handlers = {
  bootstrap: snapshot, refresh: snapshot, describe,
  setTheme: theme => {
    if (theme !== 'light' && theme !== 'dark') throw new Error('화면 모드를 다시 선택하세요.');
    saveSettings({ theme });
    nativeTheme.themeSource = theme;
    window?.setBackgroundColor(windowBackground[theme]);
  },
  aiStatus: () => aiStatus(true),
  setAiProvider: async provider => {
    if (!AI_PROVIDER_PREFERENCES.includes(provider)) throw new Error('AI 엔진을 다시 선택하세요.');
    if (aiJob) throw new Error('AI 후보 생성을 마치거나 취소한 뒤 AI 엔진을 바꾸세요.');
    saveSettings({ aiProvider: provider });
    aiStatusPromise = null;
    return aiStatus(true);
  },
  cancelGeneration: () => { if (aiJob) aiJob.controller.abort(); return { cancelled: !!aiJob }; },
  generateCandidates: async ({ adapterId, sourceGuid, actionId, goal, count, schemaVersion, mode, strategy, referenceCandidate, feedback, lockedIds, recipeId, observationRef } = {}) => {
    const target = requireProject(), currentGeneration = generation;
    if (aiJob) throw new Error('이미 AI 후보를 생성하고 있습니다.');
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 4000 || !Number.isInteger(count) || count < 2 || count > 12)
      throw new Error('원하는 타격감을 입력하고 후보 개수를 2~12개로 정하세요.');
    const status = target.getStatus();
    if (!status.connected || status.running || status.isPlaying || status.isCompiling)
      throw new Error('Unity가 연결된 편집 모드에서 후보를 생성하세요.');
    const ai = await aiStatus();
    const candidateGenerator = candidateGenerators[ai.provider];
    if (!candidateGenerator || !ai.available || !ai.authenticated) throw new Error(ai.error || 'AI 연결과 로그인을 확인하세요.');
    if (aiJob) throw new Error('이미 AI 후보를 생성하고 있습니다.');
    const job = { controller: new AbortController() }; aiJob = job;
    try {
      const description = await describe();
      const adapter = description.adapters.find(item => item.id === adapterId);
      const source = adapter?.sources.find(item => item.guid === sourceGuid);
      if (!source || (source.error && !source.actions?.length)) throw new Error(source?.error || '생성할 공격 데이터를 다시 선택하세요.');
      const selectedId = actionId || 'normal-combo';
      if (typeof selectedId !== 'string') throw new Error('테스트할 동작을 다시 선택하세요.');
      const action = Array.isArray(source.actions) && source.actions.length
        ? source.actions.find(item => item.id === selectedId)
        : selectedId === 'normal-combo' ? { ...source, id: selectedId, label: '일반 공격 전체 콤보', available: true } : null;
      if (!action) throw new Error('선택한 공격 또는 스킬을 현재 프로젝트에서 찾을 수 없습니다.');
      if (action.available === false || !action.defaultRequest) throw new Error(action.unavailableReason || '아직 테스트할 수 없는 동작입니다.');
      const version = schemaVersion || action.defaultRequest.schemaVersion;
      if (!(action.supportedRequestVersions || [action.defaultRequest.schemaVersion]).includes(version)) throw new Error('이 어댑터가 지원하지 않는 실험 버전입니다.');
      const knowledge = version === 2 ? loadKnowledge(recipeId) : null;
      const observations = version === 2 ? loadObservations(target, observationRef, { adapterId, sourceGuid, actionId: selectedId, sourceHash: action.defaultRequest.sourceHash, parameters: action.parameters, curves: action.curves }, referenceCandidate) : null;
      const generated = await candidateGenerator.generate({ goal: goal.trim(), count, parameters: version === 1 && action.legacyParameters?.length ? action.legacyParameters : action.parameters,
        schemaVersion: version, curves: version === 2 ? action.curves || [] : [], context: typeof action.context === 'string' ? { description: action.context } : action.context || {},
        mode, strategy, referenceCandidate, feedback, lockedIds, recipeId, knowledge, observations,
        adapterLabel: adapter.displayName, sourceLabel: path.basename(source.label), actionLabel: action.label }, { signal: job.controller.signal });
      if (job.controller.signal.aborted) throw new Error('AI 후보 생성을 취소했습니다.');
      if (generation !== currentGeneration || client !== target) throw new Error('프로젝트가 변경되었습니다. 다시 생성하세요.');
      return { ...structuredClone(action.defaultRequest), schemaVersion: version, actionId: selectedId, candidates: generated.candidates,
        generation: { provider: generated.provider, model: generated.model || '', goal: goal.trim(), count, createdUtc: generated.createdUtc,
          ...(version === 2 ? { mode: mode || 'explore', strategy: strategy || 'coherent', referenceCandidate,
            referenceCandidateId: referenceCandidate?.id || '', feedback: feedback || '', lockedIds: lockedIds || [], recipeId: recipeId || '',
            guideVersion: knowledge.version, guideHash: knowledge.hash, guideSnapshot: knowledge.guide, recipesSnapshot: knowledge.recipeSnapshot,
            observationsJson: observations ? JSON.stringify(observations) : '' } : {}) } };
    } finally { if (aiJob === job) aiJob = null; }
  },
  chooseProject: async () => {
    const status = client?.getStatus();
    if (status?.connected && status.running) throw new Error('실험을 마치거나 취소한 뒤 프로젝트를 바꾸세요.');
    const result = await dialog.showOpenDialog(window, { title: 'Assets와 ProjectSettings가 있는 Unity 프로젝트 선택', properties: ['openDirectory'] });
    if (!result.canceled) selectProject(result.filePaths[0]);
    return snapshot();
  },
  run: async request => {
    if (aiJob) throw new Error('AI 후보 생성이 끝난 뒤 실험을 실행하세요.');
    const target = requireProject(); boundedRequest(request);
    const status = target.getStatus();
    if (!status.connected || status.running || status.isPlaying || status.isCompiling)
      throw new Error('Unity가 연결된 편집 모드에서 실행하세요. 다른 실험이 끝날 때까지 기다려 주세요.');
    const result = await target.command('start', request, { timeoutMs: 20000 });
    return { ...result, runId: path.basename(result.directory) };
  },
  cancel: () => requireProject().command('cancel'),
  loadReport,
  exportPreset: async ({ request, candidateId } = {}) => {
    boundedRequest(request);
    if (typeof candidateId !== 'string' || !request.candidates.some(c => c.id === candidateId)) throw new Error('저장할 후보를 선택하세요.');
    const target = requireProject();
    const assetPath = await chooseAssetPath(target, '새 전투 프리셋 SO 저장', 'CombatPreset.asset');
    if (!assetPath) return { cancelled: true };
    return target.command('export', { request, candidateId, assetPath });
  },
  exportCombinedPreset: async ({ request } = {}) => {
    request = structuredClone(boundedCombinedRequest(request));
    if (aiJob) throw new Error('AI 후보 생성이 끝난 뒤 저장하세요.');
    const target = requireProject(), currentGeneration = generation;
    const status = target.getStatus();
    if (!status.connected || status.running || status.isPlaying || status.isCompiling) throw new Error('Unity 편집 모드에서 폼 SO를 저장하세요.');
    const description = await describe();
    if (client !== target || generation !== currentGeneration) throw new Error('프로젝트가 변경되었습니다. 현재 프로젝트에서 다시 저장하세요.');
    validateCombinedCatalog(request, description);
    const assetPath = await chooseAssetPath(target, '선택한 공격들을 하나의 폼 SO로 저장', 'CombinedCombatForm.asset');
    if (!assetPath) return { cancelled: true };
    return target.command('export-combined', { request, assetPath });
  },
  saveRequest: async request => {
    boundedRequest(request);
    const result = await dialog.showSaveDialog(window, { title: '실험 JSON 저장', defaultPath: 'combat-experiment.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled) return { cancelled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(request, null, 2), 'utf8'); return { path: result.filePath };
  },
  loadRequest: async () => {
    const result = await dialog.showOpenDialog(window, { title: '실험 JSON 불러오기', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled) return null;
    if (fs.statSync(result.filePaths[0]).size > 1000000) throw new Error('실험 파일이 너무 큽니다.');
    return boundedRequest(JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8').replace(/^\uFEFF/, '')));
  },
  saveJudgment: ({ runId, candidateId, feedback } = {}) => requireProject().saveJudgment(runId, { selectedCandidateId: candidateId, feedback }),
  revealRun: runId => {
    const target = requireProject(); target.loadReport(runId);
    shell.showItemInFolder(path.join(target.projectPath, 'CombatLabResults', runId, 'report.json'));
  }
};
function installIpc() {
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`baekho:${name}`, async (event, ...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          !event.senderFrame.url.startsWith('baekho://app/')) throw new Error('허용되지 않은 앱 요청입니다.');
      return handler(...args);
    });
  }
}
function installProtocols() {
  protocol.handle('baekho', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app' || !['/index.html', '/styles.css', '/app.js', '/tuning-contract.js'].includes(url.pathname))
      return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(rendererRoot, url.pathname.slice(1))).href);
  });
  protocol.handle('baekho-media', async request => {
    try {
      const url = new URL(request.url), grant = media.get(url.pathname.slice(1));
      if (!['video', 'image'].includes(url.hostname) || !grant || (grant.kind || 'video') !== url.hostname || grant.generation !== generation) return new Response('Not found', { status: 404 });
      const video = url.hostname === 'image' ? requireProject().resolveImage(grant.runId, grant.filename) : requireProject().resolveVideo(grant.runId, grant.filename);
      return await createMediaResponse(video, request);
    } catch { return new Response('Video unavailable', { status: 404 }); }
  });
}
function createWindow() {
  window = new BrowserWindow({ title: 'Baekho Studio', width: 1440, height: 980, minWidth: 1024, minHeight: 720,
    backgroundColor: windowBackground[nativeTheme.themeSource], show: !testMode, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false, offscreen: process.argv.includes('--diagnostic-v2') }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('baekho://app/')) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  if (testMode) window.webContents.on('console-message', details => {
    if (details.level === 'error') diagnosticConsoleErrors.push(details.message);
  });
  window.loadURL('baekho://app/index.html');
  if (testMode) window.webContents.once('did-finish-load', () => runDiagnostic().catch(async error => {
    fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
    fs.writeFileSync(diagnosticPath, JSON.stringify({ ok: false, error: error.stack }, null, 2)); app.exit(1);
  }));
}

// Explicit developer-only diagnostic mode; never runs for a normal app launch.
async function runDiagnostic() {
  if (process.argv.includes('--diagnostic-v2')) {
    await require('./v2-diagnostic.cjs')({ window, app, diagnosticPath, diagnosticConsoleErrors, loadKnowledge });
    return;
  }
  if (process.argv.includes('--diagnostic-multi')) {
    await require('./multi-action-diagnostic.cjs')({ window, app, dialog, diagnosticPath, diagnosticConsoleErrors });
    return;
  }
  await require('./diagnostic.cjs')({ window, app, diagnosticPath, diagnosticConsoleErrors });
}
if (!testMode && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    try {
      if (fs.existsSync(settingsPath())) settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {};
    } catch (error) { console.error(error.message); }
    nativeTheme.themeSource = settings.theme === 'dark' ? 'dark' : 'light';
    try {
      const project = argument('--project') || settings.projectPath;
      if (project) selectProject(project);
    } catch (error) { console.error(error.message); }
    installProtocols(); installIpc(); createWindow();
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => aiJob?.controller.abort());
}
