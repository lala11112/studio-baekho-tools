import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScanResult } from '../src/shared/types';
import { CodexService } from './services/codex';
import { createPageTrustChecker } from './services/page-trust';
import { scanUnityProject } from './services/unity-project';
import { atomicWrite, createExportBundle, readProject, serializeProject } from './services/projects';

let window: BrowserWindow | null = null;
let currentScan: ScanResult | null = null;
let nativeOperation = false;
let ai: CodexService;
const productionPage = path.join(__dirname, '../dist/index.html');

function developmentUrl(): string | null {
  if (app.isPackaged || !process.env.BAEKHO_DEV_URL) return null;
  const candidate = new URL(process.env.BAEKHO_DEV_URL);
  if (candidate.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(candidate.hostname)
    || candidate.port !== '5173' || candidate.username || candidate.password || (candidate.pathname !== '/' && candidate.pathname !== '/index.html')) {
    throw new Error('BAEKHO_DEV_URL must be a localhost URL on port 5173.');
  }
  return candidate.href;
}

const devUrl = developmentUrl();
const trustedPage = createPageTrustChecker(productionPage, devUrl);

function assertSender(event: IpcMainInvokeEvent): void {
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id
    || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame || !trustedPage(event.senderFrame.url)) {
    throw new Error('허용되지 않은 앱 요청입니다.');
  }
}

function handle(channel: string, callback: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertSender(event);
    return callback(...args);
  });
}

async function nativeAction<T>(operation: () => Promise<T>): Promise<T> {
  if (nativeOperation) throw new Error('파일 작업이 진행 중입니다. 열린 창을 완료한 뒤 다시 시도해 주세요.');
  nativeOperation = true;
  try { return await operation(); }
  finally { nativeOperation = false; }
}

function registerHandlers(): void {
  handle('baekho:codex-status', () => ai.getStatus());
  handle('baekho:codex-login', async () => { await shell.openExternal(await ai.startLogin()); });
  handle('baekho:codex-select', () => nativeAction(async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Codex 실행 파일 선택', properties: ['openFile'],
      filters: [{ name: 'Codex executable', extensions: ['exe'] }],
    });
    if (result.canceled || !result.filePaths[0]) return ai.getStatus();
    return ai.selectExecutable(result.filePaths[0]);
  }));
  handle('baekho:generate-image', settings => ai.generateImage(settings));
  handle('baekho:extract-layout', (settings, dataUrl) => ai.extractLayout(settings, dataUrl));
  handle('baekho:cancel-generation', () => ai.cancel());
  handle('baekho:scan-project', () => nativeAction(async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Unity 프로젝트 폴더 선택', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    currentScan = null;
    const scan = await scanUnityProject(result.filePaths[0]);
    currentScan = scan;
    return scan;
  }));
  handle('baekho:save-project', value => nativeAction(async () => {
    const serialized = serializeProject(value);
    const result = await dialog.showSaveDialog(window!, {
      title: 'Baekho 프로젝트 저장', defaultPath: 'Map.baekho.json',
      filters: [{ name: 'Baekho project', extensions: ['json'] }], properties: ['showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return null;
    await atomicWrite(result.filePath, serialized);
    return result.filePath;
  }));
  handle('baekho:open-project', () => nativeAction(async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Baekho 프로젝트 열기', filters: [{ name: 'Baekho project', extensions: ['json'] }], properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const project = await readProject(result.filePaths[0]);
    currentScan = null;
    return project;
  }));
  handle('baekho:export-bundle', value => nativeAction(async () => {
    const importerPath = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'unity-importer/Editor/BaekhoMapImporter.cs');
    const importer = await readFile(importerPath, 'utf8').catch(() => { throw new Error('Unity 가져오기 스크립트가 없습니다. 앱 설치 또는 빌드를 확인해 주세요.'); });
    const runtimePath = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'unity-importer/Runtime/BaekhoMapConnection.cs');
    const runtimeScript = await readFile(runtimePath, 'utf8').catch(() => { throw new Error('Unity 연결문 런타임 스크립트가 없습니다. 앱 설치 또는 빌드를 확인해 주세요.'); });
    const bundle = await createExportBundle(value, currentScan, importer, runtimeScript);
    const result = await dialog.showSaveDialog(window!, {
      title: 'Unity 프리팹 제작 번들 내보내기', defaultPath: 'BaekhoMap.zip',
      filters: [{ name: 'Unity import bundle', extensions: ['zip'] }], properties: ['showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return null;
    await atomicWrite(result.filePath, bundle);
    return result.filePath;
  }));
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1480, height: 980, minWidth: 1050, minHeight: 720, show: false,
    title: 'Baekho Map Forge', backgroundColor: '#f1f2ee', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    if (!window || window.isDestroyed()) return;
    const response = dialog.showMessageBoxSync(window, {
      type: 'warning', title: 'Baekho Map Forge', buttons: ['취소', '닫기'], defaultId: 0, cancelId: 0,
      message: '저장되지 않은 변경 사항이나 진행 중인 작업이 있습니다.',
      detail: '닫으면 저장하지 않은 내용이 사라지고 진행 중인 AI 요청이 취소됩니다.',
    });
    // Electron's preventDefault overrides the renderer's unload prevention.
    if (response === 1) event.preventDefault();
  });
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { ai.cancel(); currentScan = null; window = null; });
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(productionPage);
}

void app.whenReady().then(() => {
  ai = new CodexService({ dataDirectory: path.join(app.getPath('userData'), 'codex') });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  registerHandlers();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { ai.cancel(); if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => ai?.close());
