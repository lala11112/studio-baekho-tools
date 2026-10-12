import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../src/shared/types';

const api: DesktopAPI = {
  getCodexStatus: () => ipcRenderer.invoke('baekho:codex-status'),
  startCodexLogin: () => ipcRenderer.invoke('baekho:codex-login'),
  selectCodexExecutable: () => ipcRenderer.invoke('baekho:codex-select'),
  generateImage: settings => ipcRenderer.invoke('baekho:generate-image', settings),
  extractLayout: (settings, imageDataUrl) => ipcRenderer.invoke('baekho:extract-layout', settings, imageDataUrl),
  cancelGeneration: () => ipcRenderer.invoke('baekho:cancel-generation'),
  scanProject: () => ipcRenderer.invoke('baekho:scan-project'),
  saveProject: project => ipcRenderer.invoke('baekho:save-project', project),
  openProject: () => ipcRenderer.invoke('baekho:open-project'),
  exportBundle: project => ipcRenderer.invoke('baekho:export-bundle', project),
};

contextBridge.exposeInMainWorld('baekho', Object.freeze(api));
