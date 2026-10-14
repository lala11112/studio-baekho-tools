'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { Store, readJson, atomicJson } = require('./store.cjs');
const { Controller } = require('./controller.cjs');
const { ProjectClient, contained } = require('./project-client.cjs');
const { installIntegration } = require('./install.cjs');

const projectFile = project => createHash('sha256').update(project.toLowerCase()).digest('hex') + '.json';
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
function trustedDocument(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'aht:' && url.hostname === 'app' && !url.port && !url.username && !url.password && url.pathname === '/index.html';
  } catch { return false; }
}
// Check every existing ancestor, including Windows junctions, before reading or
// creating migration files. Neither a source nor a destination may redirect us.
function safePath(root, ...segments) {
  const target = path.resolve(root, ...segments);
  if (!contained(path.resolve(root), target)) throw new Error('데이터 폴더 밖의 경로는 사용할 수 없습니다.');
  let current = path.parse(target).root;
  for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('연결된 데이터 경로는 사용할 수 없습니다.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
function exists(filename) { try { fs.lstatSync(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function validatePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.projectPath !== undefined && (typeof value.projectPath !== 'string' || value.projectPath.length > 32768 || value.projectPath.includes('\0'))))
    throw new Error('프로젝트 선택 설정을 읽을 수 없습니다.');
  return value;
}
function validateDraft(value, filename) {
  if (!value || value.schemaVersion !== 1 || typeof value.project !== 'string' || !path.isAbsolute(value.project) || value.project.includes('\0') ||
      !Array.isArray(value.jobs) || value.jobs.length > 300 ||
      projectFile(value.project) !== path.basename(filename)) throw new Error('저장된 작업의 프로젝트 정보가 올바르지 않습니다.');
  return value;
}
function summarize(state, error = '') {
  return {
    projectPath: state.projectPath || '', projectName: state.projectPath ? path.basename(state.projectPath) : '',
    connected: state.connection?.ready === true, busy: state.busy === true,
    error: error || state.notice || (!state.connection?.ready && state.projectPath ? state.connection?.message || '' : ''),
    jobs: (Array.isArray(state.jobs) ? state.jobs : []).filter(job => job && typeof job.id === 'string').map(job => ({
      id: job.id, clipName: String(job.clip?.name || '애니메이션'), status: String(job.status || 'draft'),
      analysisStatus: String(job.analysisStatus || ''), reviewed: job.reviewed === true, pendingSave: Boolean(job.pendingSave),
      hitCount: Array.isArray(job.windows) ? job.windows.length : 0, frameCount: Array.isArray(job.frames) ? job.frames.length : 0,
      savedAssetCount: Array.isArray(job.savedAssets) ? job.savedAssets.length : 0,
      createdUtc: String(job.createdUtc || ''), ...(job.savedUtc ? { savedUtc: String(job.savedUtc) } : {}), error: String(job.error || '')
    }))
  };
}

// The integrated host owns Electron lifecycle, privileges, windows and userData.
function createAutoHitTimerService({ getWindow, getWebContents, dataRoot, legacyDataRoot, kitRoot } = {}) {
  if (typeof getWindow !== 'function' || typeof getWebContents !== 'function' ||
      typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || typeof kitRoot !== 'string' || !path.isAbsolute(kitRoot) ||
      (legacyDataRoot !== undefined && (typeof legacyDataRoot !== 'string' || !path.isAbsolute(legacyDataRoot))))
    throw new Error('AutoHitTimer requires a parent window, trusted view and absolute data/kit paths.');
  if (legacyDataRoot && samePath(dataRoot, legacyDataRoot)) throw new Error('통합 데이터와 기존 데이터는 서로 다른 폴더를 사용해야 합니다.');
  let controller = null, initialized = false, activation = null, timer = null, shutdownPromise = null, closing = false, startupError = '', mediaProject = '';
  const media = new Map(), pendingOperations = new Set();
  const rendererRoot = path.join(__dirname, '../renderer');
  const migrationMarker = () => safePath(dataRoot, 'legacy-import.json');
  function readPreferences(root) {
    const filename = safePath(root, 'preferences.json');
    return exists(filename) ? validatePreferences(readJson(filename, 64 * 1024)) : {};
  }
  class IsolatedStore extends Store {
    filename(project) { return safePath(this.directory, 'projects', projectFile(project)); }
    preferences() { return readPreferences(this.directory); }
    savePreferences(value) { atomicJson(safePath(this.directory, 'preferences.json'), validatePreferences(value)); }
  }
  function summaryRoot() {
    if (exists(safePath(dataRoot, 'preferences.json')) || exists(migrationMarker()) || !legacyDataRoot) return dataRoot;
    return legacyDataRoot;
  }
  function getSummary() {
    if (controller) return summarize(controller.state, startupError);
    let projectPath = '', jobs = [], connection = { ready: false }, error = '';
    try {
      const root = summaryRoot(), preferences = readPreferences(root);
      projectPath = preferences.projectPath || '';
      if (projectPath) {
        // Constructors and heartbeat only validate/read; Store.load intentionally
        // is not used because its corruption recovery can write backup files.
        const client = new ProjectClient(projectPath); projectPath = client.projectPath; connection = client.heartbeat();
        const filename = safePath(root, 'projects', projectFile(projectPath));
        if (exists(filename)) {
          jobs = structuredClone(validateDraft(readJson(filename), filename).jobs);
          // A disk checkpoint does not prove that its former process is alive.
          // Leave the original untouched and avoid claiming cancellation of a
          // separate standalone instance; activation owns actual recovery.
          for (const job of jobs) if (['capturing', 'analyzing'].includes(job?.status)) job.status = 'interrupted';
        }
      }
    } catch (failure) { error = failure.message; }
    return summarize({ projectPath, connection, busy: false, jobs }, error);
  }
  function migrateLegacy() {
    safePath(dataRoot);
    if (!legacyDataRoot || exists(migrationMarker())) return;
    safePath(legacyDataRoot);
    const files = [];
    const preferences = safePath(legacyDataRoot, 'preferences.json');
    if (exists(preferences)) { validatePreferences(readJson(preferences, 64 * 1024)); files.push(['preferences.json', preferences]); }
    const projects = safePath(legacyDataRoot, 'projects');
    if (exists(projects)) {
      if (!fs.statSync(projects).isDirectory()) throw new Error('기존 작업 폴더를 읽을 수 없습니다.');
      const entries = fs.readdirSync(projects, { withFileTypes: true });
      if (entries.length > 2048) throw new Error('기존 작업 파일 수가 허용 범위를 초과했습니다.');
      for (const entry of entries) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const source = safePath(legacyDataRoot, 'projects', entry.name);
        validateDraft(readJson(source), source); files.push([path.join('projects', entry.name), source]);
      }
    }
    // Validate the whole inventory before copying. COPYFILE_EXCL preserves every
    // existing integrated file, even when another activation completed first.
    for (const [relative] of files) safePath(dataRoot, relative);
    for (const [relative, source] of files) {
      const destination = safePath(dataRoot, relative);
      if (exists(destination)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      try { fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    atomicJson(migrationMarker(), { schemaVersion: 1, completedUtc: new Date().toISOString() });
  }
  function publicState() {
    const result = structuredClone(controller.state);
    if (mediaProject !== result.projectPath) { media.clear(); mediaProject = result.projectPath; }
    for (const job of result.jobs) {
      for (const frame of job.frames || []) {
        const token = createHash('sha256').update(String(frame.path)).digest('hex');
        media.set(token, frame.path); frame.url = `aht-media://frame/${token}.png`; delete frame.path;
      }
      job.versions = (job.versions || []).map(version => ({ savedUtc: version.savedUtc, windows: version.windows, analysisStatus: version.analysisStatus }));
    }
    return result;
  }
  function send(channel, value) {
    const contents = getWebContents();
    if (!contents || contents.isDestroyed?.()) return;
    if (contents.isLoadingMainFrame?.()) contents.once('did-finish-load', () => {
      if (!contents.isDestroyed?.() && contents === getWebContents()) contents.send(channel, value);
    });
    else contents.send(channel, value);
  }
  function publish() { if (controller && !closing) send('aht:state', publicState()); }
  function activate() {
    if (closing) return Promise.reject(new Error('도구를 종료하고 있습니다.'));
    if (activation) return activation;
    activation = (async () => {
      try { migrateLegacy(); } catch (error) { startupError = '기존 데이터 가져오기 실패: ' + error.message; }
      safePath(dataRoot);
      const store = new IsolatedStore(dataRoot);
      controller = new Controller({ store, install: project => installIntegration(project, kitRoot) });
      controller.on('state', publish);
      try {
        const saved = readPreferences(dataRoot);
        if (saved.projectPath) await controller.connectProject(saved.projectPath);
        else await controller.refreshCatalog();
      } catch (error) { controller.state.notice = error.message; publish(); }
      if (startupError) { controller.state.notice = startupError; publish(); }
      if (!closing) timer = setInterval(() => {
        try { controller.poll(); } catch (error) { controller.state.notice = error.message; publish(); }
      }, 2000);
    })();
    return activation;
  }
  async function chooseProject() {
    await activate(); controller.idle();
    const selected = await dialog.showOpenDialog(getWindow(), { title: 'Unity 프로젝트 폴더', properties: ['openDirectory'] });
    if (!selected.canceled && selected.filePaths?.[0]) {
      controller.idle();
      const canonical = new ProjectClient(selected.filePaths[0]).projectPath;
      if (canonical !== controller.state.projectPath) await controller.connectProject(canonical);
    }
  }
  async function navigate({ projectPath, jobId, tab } = {}) {
    if (tab !== undefined && !['hits', 'save'].includes(tab)) throw new Error('알 수 없는 타격 타이밍 화면입니다.');
    if (jobId !== undefined && (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(jobId))) throw new Error('작업 ID가 올바르지 않습니다.');
    await activate();
    if (projectPath !== undefined && projectPath !== controller.state.projectPath)
      throw new Error('프로젝트가 변경되었습니다. 목록을 새로고침한 뒤 현재 프로젝트의 작업을 다시 선택하세요.');
    if (jobId !== undefined) {
      controller.job(jobId);
      if (jobId !== controller.state.selectedJobId) controller.selectJob(jobId);
    }
    publish();
    send('aht:navigate', { projectPath: controller.state.projectPath, ...(jobId !== undefined ? { jobId } : {}), ...(tab ? { tab } : {}) });
  }
  function setVisible(visible) { send('aht:visibility', Boolean(visible)); }
  function hasActiveWork() { return Boolean(controller && (controller.state.busy || controller.applying || controller.abortController)); }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closing = true; if (timer) clearInterval(timer); timer = null;
    shutdownPromise = (async () => {
      if (activation) await activation.catch(() => {});
      if (!controller) return;
      const cancellation = controller.abortController ? controller.cancelAnalysis() : Promise.resolve();
      // Pending saves belong to the controller's durable receipt/journal flow.
      // Shutdown never reissues an apply or removes an unresolved pendingSave.
      await Promise.allSettled([cancellation, controller.shutdown(), controller.recoveryPromise, ...pendingOperations]);
      controller.removeListener('state', publish);
    })();
    return shutdownPromise;
  }
  function handle(name, callback) {
    ipcMain.handle('aht:' + name, async (event, ...args) => {
      const contents = getWebContents();
      if (!contents || contents.isDestroyed?.() || event.sender !== contents || event.senderFrame !== contents.mainFrame || !trustedDocument(event.senderFrame?.url))
        return { ok: false, error: { message: '허용되지 않은 요청입니다.', code: 'FORBIDDEN' } };
      if (closing) return { ok: false, error: { message: '도구를 종료하고 있습니다.', code: 'CLOSING' } };
      const operation = (async () => { await activate(); return callback(...args); })();
      pendingOperations.add(operation);
      try { return { ok: true, value: await operation }; }
      catch (error) { return { ok: false, error: { message: error.message || '작업에 실패했습니다.', code: error.code || 'ERROR' } }; }
      finally { pendingOperations.delete(operation); }
    });
  }
  function initialize() {
    if (initialized) return;
    if (app.isReady && !app.isReady()) throw new Error('Initialize AutoHitTimer after Electron is ready.');
    initialized = true;
    protocol.handle('aht', request => {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || !['/index.html', '/styles.css', '/embedded.css', '/app.js'].includes(url.pathname) || !['GET', 'HEAD'].includes(request.method))
        return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(path.join(rendererRoot, url.pathname.slice(1))).href);
    });
    protocol.handle('aht-media', request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'frame' || !/^\/[a-f0-9]{64}\.png$/.test(url.pathname) || request.method !== 'GET') return new Response(null, { status: 404 });
        const registered = media.get(url.pathname.slice(1, -4));
        if (!registered || !controller?.client) return new Response(null, { status: 404 });
        const filename = controller.client.mediaPath(registered);
        const stat = fs.statSync(filename);
        if (stat.size > 8 * 1024 * 1024) return new Response(null, { status: 413 });
        return new Response(fs.readFileSync(filename), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
      } catch { return new Response(null, { status: 404 }); }
    });
    handle('getState', () => publicState());
    handle('selectProject', async () => { await chooseProject(); return publicState(); });
    for (const name of ['connectProject', 'installIntegration', 'refreshCatalog', 'searchAnimations', 'importFiles', 'addJobs', 'selectJob', 'updateJob', 'updateSettings', 'analyzeJobs', 'cancelAnalysis', 'removeJob', 'previewChange', 'applyChange'])
      handle(name, async (...args) => { const result = await controller[name](...args); return result === controller.state ? publicState() : result; });
    handle('revealAsset', filename => {
      if (!controller.client || typeof filename !== 'string') throw new Error('저장된 에셋을 선택하세요.');
      const target = fs.realpathSync(path.resolve(controller.state.projectPath, filename));
      if (!contained(controller.state.projectPath, target) || !controller.state.jobs.some(job => job.savedAssets?.some(asset => path.resolve(controller.state.projectPath, asset.path).toLowerCase() === target.toLowerCase())))
        throw new Error('현재 작업의 저장 결과만 열 수 있습니다.');
      shell.showItemInFolder(target); return { opened: true };
    });
  }
  return Object.freeze({ initialize, activate, getSummary, chooseProject, navigate, setVisible, hasActiveWork, shutdown });
}

function startStandalone() {
  app.setName('AutoHitTimer');
  app.setPath('userData', path.join(app.getPath('appData'), 'StudioBaekho', 'AutoHitTimer'));
  protocol.registerSchemesAsPrivileged([
    { scheme: 'aht', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'aht-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ]);
  let window, quitting = false;
  const service = createAutoHitTimerService({ getWindow: () => window, getWebContents: () => window?.webContents,
    dataRoot: app.getPath('userData'), kitRoot: app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'UnityIntegration') : path.resolve(__dirname, '../../..') });
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    service.initialize();
    window = new BrowserWindow({ width: 1550, height: 980, minWidth: 950, minHeight: 700, backgroundColor: '#111318', show: false,
      title: 'AutoHitTimer · 스튜디오 백호', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    await window.loadURL('aht://app/index.html'); window.show();
    await service.activate();
  }).catch(error => { dialog.showErrorBox('AutoHitTimer 시작 실패', error.message); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    service.shutdown().finally(() => app.quit());
  });
}
module.exports = { createAutoHitTimerService };
if (require.main === module) startStandalone();
