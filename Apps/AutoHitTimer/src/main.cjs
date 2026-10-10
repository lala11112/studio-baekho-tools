'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Store } = require('./store.cjs');
const { Controller } = require('./controller.cjs');
const { contained } = require('./project-client.cjs');
const { installIntegration } = require('./install.cjs');

app.setName('AutoHitTimer');
app.setPath('userData', path.join(app.getPath('appData'), 'StudioBaekho', 'AutoHitTimer'));
protocol.registerSchemesAsPrivileged([{ scheme: 'aht-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let window, controller, timer, quitting = false, mediaProject = '';
const media = new Map();
function publicState() {
  const result = structuredClone(controller.state);
  if (mediaProject !== result.projectPath) { media.clear(); mediaProject = result.projectPath; }
  for (const job of result.jobs) {
    for (const frame of job.frames || []) {
      const token = createHash('sha256').update(String(frame.path)).digest('hex');
      media.set(token, frame.path); frame.url = `aht-media://frame/${token}.png`; delete frame.path;
    }
    // Previous drafts remain on disk; do not repeatedly transmit their full image manifests.
    job.versions = (job.versions || []).map(version => ({ savedUtc: version.savedUtc, windows: version.windows, analysisStatus: version.analysisStatus }));
  }
  return result;
}
function publish() { if (window && !window.isDestroyed()) window.webContents.send('aht:state', publicState()); }
function handle(name, callback) {
  ipcMain.handle('aht:' + name, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: { message: '허용되지 않은 요청입니다.', code: 'FORBIDDEN' } };
    try { const value = await callback(...args); return { ok: true, value }; }
    catch (error) { return { ok: false, error: { message: error.message || '작업에 실패했습니다.', code: error.code || 'ERROR' } }; }
  });
}
function kitRoot() { return app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'UnityIntegration') : path.resolve(__dirname, '../../..'); }

async function start() {
  const store = new Store(app.getPath('userData'));
  controller = new Controller({ store, install: project => installIntegration(project, kitRoot()) });
  controller.on('state', publish);
  protocol.handle('aht-media', request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'frame' || !/^\/[a-f0-9]{64}\.png$/.test(url.pathname) || request.method !== 'GET') return new Response(null, { status: 404 });
      const registered = media.get(url.pathname.slice(1, -4));
      if (!registered || !controller.client) return new Response(null, { status: 404 });
      const filename = controller.client.mediaPath(registered);
      const stat = fs.statSync(filename);
      if (stat.size > 8 * 1024 * 1024) return new Response(null, { status: 413 });
      return new Response(fs.readFileSync(filename), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response(null, { status: 404 }); }
  });
  handle('getState', () => publicState());
  handle('selectProject', async () => {
    controller.idle(); const selected = await dialog.showOpenDialog(window, { title: 'Unity 프로젝트 폴더', properties: ['openDirectory'] });
    if (!selected.canceled) await controller.connectProject(selected.filePaths[0]);
    return publicState();
  });
  for (const name of ['connectProject', 'installIntegration', 'refreshCatalog', 'searchAnimations', 'importFiles', 'addJobs', 'selectJob', 'updateJob', 'updateSettings', 'analyzeJobs', 'cancelAnalysis', 'removeJob', 'previewChange', 'applyChange']) {
    handle(name, async (...args) => { const result = await controller[name](...args); return result === controller.state ? publicState() : result; });
  }
  handle('revealAsset', filename => {
    if (!controller.client || typeof filename !== 'string') throw new Error('저장된 에셋을 선택하세요.');
    const target = fs.realpathSync(path.resolve(controller.state.projectPath, filename));
    if (!contained(controller.state.projectPath, target) || !controller.state.jobs.some(job => job.savedAssets.some(asset => path.resolve(controller.state.projectPath, asset.path).toLowerCase() === target.toLowerCase()))) throw new Error('현재 작업의 저장 결과만 열 수 있습니다.');
    shell.showItemInFolder(target); return { opened: true };
  });
  window = new BrowserWindow({ width: 1550, height: 980, minWidth: 950, minHeight: 700, backgroundColor: '#111318', show: false,
    title: 'AutoHitTimer · 스튜디오 백호', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  await window.loadFile(path.join(__dirname, '../renderer/index.html')); window.show();
  const saved = store.preferences();
  if (saved.projectPath) { try { await controller.connectProject(saved.projectPath); } catch (error) { controller.state.notice = error.message; publish(); } }
  else { await controller.refreshCatalog(); }
  timer = setInterval(() => controller.poll(), 2000);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('AutoHitTimer 시작 실패', error.message); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    clearInterval(timer);
    // Only analysis is cancellable. Apply has a persisted request identity to
    // reconcile on the next launch and does not belong to the capture lifecycle.
    if (!quitting && controller?.abortController) {
      event.preventDefault(); quitting = true;
      controller.cancelAnalysis().then(() => controller.shutdown()).finally(() => app.quit());
    }
  });
}
