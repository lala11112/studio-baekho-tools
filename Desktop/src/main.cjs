const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { ProjectClient } = require('./project-client.cjs');
const { createMediaResponse } = require('./media-response.cjs');
const { CodexCandidateGenerator } = require('./ai-candidates.cjs');

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
const candidateGenerator = new CodexCandidateGenerator();
let aiJob = null, aiStatusPromise = null, aiStatusCheckedAt = 0;
let aiConnection = { available: false, authenticated: false, provider: 'codex', label: 'Codex 연결 확인 중', error: '' };
async function aiStatus(force = false) {
  if (!aiStatusPromise && (force || !aiStatusCheckedAt || Date.now() - aiStatusCheckedAt > 30000)) {
    aiStatusPromise = candidateGenerator.status().then(value => { aiConnection = value; })
      .catch(() => { aiConnection = { available: false, authenticated: false, provider: 'codex', label: 'Codex 연결 확인 필요', error: 'Codex 설치와 로그인을 확인하세요.' }; })
      .finally(() => { aiStatusCheckedAt = Date.now(); aiStatusPromise = null; });
  }
  if (aiStatusPromise) await aiStatusPromise;
  return { ...aiConnection, generating: !!aiJob };
}

function selectProject(projectPath) {
  const canonical = ProjectClient.validateProject(projectPath);
  if (client?.projectPath === canonical) return;
  if (aiJob) throw new Error('AI 후보 생성을 마치거나 취소한 뒤 프로젝트를 바꾸세요.');
  const previousStatus = client?.getStatus();
  if (previousStatus?.connected && previousStatus.running) throw new Error('현재 프로젝트의 실험을 마치거나 취소한 뒤 프로젝트를 바꾸세요.');
  client = new ProjectClient(canonical); catalog = { adapters: [] }; catalogPromise = null; catalogNeedsRefresh = true; media.clear(); generation++;
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ projectPath: canonical }, null, 2));
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
    connection, catalog, ai, runs: target ? target.listRuns() : [] };
}
function boundedRequest(request) {
  if (!request || typeof request !== 'object' || request.schemaVersion !== 1 || !Array.isArray(request.candidates))
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
          !Array.isArray(candidate.values) || !candidate.values.length)
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
    for (const candidate of selection.request.candidates) {
      if (candidate.values.length !== action.parameters.length) throw new Error('공격 수치 구조가 변경되었습니다. 후보를 다시 생성하세요.');
      for (const spec of action.parameters) {
        const parameter = candidate.values.find(value => value.id === spec.id);
        if (!parameter || parameter.value < spec.minimum || parameter.value > spec.maximum)
          throw new Error(`${action.label || id}: ${spec.label || spec.id} 허용 범위를 확인하고 후보를 다시 생성하세요.`);
      }
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
  for (const row of result.report.results || []) {
    row.videoUrl = '';
    if (!row.videoPath) continue;
    const filename = String(row.videoPath).replace(/\\/g, '/').split('/').pop();
    try {
      target.resolveVideo(runId, filename);
      const previous = [...media].find(([, grant]) => grant.generation === generation && grant.runId === runId && grant.filename === filename);
      const token = previous?.[0] || randomUUID();
      // Stable URLs keep report polling from restarting video playback. Refresh LRU position.
      media.delete(token); media.set(token, { generation, runId, filename });
      row.videoUrl = `baekho-media://video/${token}`;
    } catch { row.videoUnavailable = true; }
  }
  // A report refresh should not retain media grants for every historical refresh forever.
  while (media.size > 120) media.delete(media.keys().next().value);
  return result;
}
const handlers = {
  bootstrap: snapshot, refresh: snapshot, describe,
  aiStatus: () => aiStatus(true),
  cancelGeneration: () => { if (aiJob) aiJob.controller.abort(); return { cancelled: !!aiJob }; },
  generateCandidates: async ({ adapterId, sourceGuid, actionId, goal, count } = {}) => {
    const target = requireProject(), currentGeneration = generation;
    if (aiJob) throw new Error('이미 AI 후보를 생성하고 있습니다.');
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 4000 || !Number.isInteger(count) || count < 2 || count > 12)
      throw new Error('원하는 타격감을 입력하고 후보 개수를 2~12개로 정하세요.');
    const status = target.getStatus();
    if (!status.connected || status.running || status.isPlaying || status.isCompiling)
      throw new Error('Unity가 연결된 편집 모드에서 후보를 생성하세요.');
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
      const generated = await candidateGenerator.generate({ goal: goal.trim(), count, parameters: action.parameters,
        adapterLabel: adapter.displayName, sourceLabel: path.basename(source.label), actionLabel: action.label }, { signal: job.controller.signal });
      if (job.controller.signal.aborted) throw new Error('AI 후보 생성을 취소했습니다.');
      if (generation !== currentGeneration || client !== target) throw new Error('프로젝트가 변경되었습니다. 다시 생성하세요.');
      return { ...structuredClone(action.defaultRequest), actionId: selectedId, candidates: generated.candidates,
        generation: { provider: generated.provider, model: generated.model || '', goal: goal.trim(), count, createdUtc: generated.createdUtc } };
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
    if (url.hostname !== 'app' || !['/index.html', '/styles.css', '/app.js'].includes(url.pathname))
      return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(rendererRoot, url.pathname.slice(1))).href);
  });
  protocol.handle('baekho-media', async request => {
    try {
      const url = new URL(request.url), grant = media.get(url.pathname.slice(1));
      if (url.hostname !== 'video' || !grant || grant.generation !== generation) return new Response('Not found', { status: 404 });
      const video = requireProject().resolveVideo(grant.runId, grant.filename);
      return await createMediaResponse(video, request);
    } catch { return new Response('Video unavailable', { status: 404 }); }
  });
}
function createWindow() {
  window = new BrowserWindow({ title: 'Baekho Studio', width: 1440, height: 980, minWidth: 1024, minHeight: 720,
    backgroundColor: '#10161d', show: !testMode, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false }
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
      const provided = argument('--project');
      const saved = fs.existsSync(settingsPath()) ? JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) : {};
      if (provided || saved.projectPath) selectProject(provided || saved.projectPath);
    } catch (error) { console.error(error.message); }
    installProtocols(); installIpc(); createWindow();
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => aiJob?.controller.abort());
}
