import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../src/shared/types';

const api: DesktopAPI = {
  getCodexStatus: () => ipcRenderer.invoke('map-forge:codex-status'),
  startCodexLogin: () => ipcRenderer.invoke('map-forge:codex-login'),
  selectCodexExecutable: () => ipcRenderer.invoke('map-forge:codex-select'),
  generateImage: (settings, region, catalog) => ipcRenderer.invoke('map-forge:generate-image', settings, region, catalog),
  extractLayout: (settings, imageDataUrl, region, catalog) => ipcRenderer.invoke('map-forge:extract-layout', settings, imageDataUrl, region, catalog),
  cancelGeneration: () => ipcRenderer.invoke('map-forge:cancel-generation'),
  scanProject: () => ipcRenderer.invoke('map-forge:scan-project'),
  importPropCatalog: () => ipcRenderer.invoke('map-forge:import-prop-catalog'),
  saveProject: project => ipcRenderer.invoke('map-forge:save-project', project),
  saveProjects: projects => ipcRenderer.invoke('map-forge:save-projects', projects),
  openProject: () => ipcRenderer.invoke('map-forge:open-project'),
  openComparisonProject: () => ipcRenderer.invoke('map-forge:open-comparison-project'),
  saveRecovery: project => ipcRenderer.invoke('map-forge:save-recovery', project),
  loadRecovery: () => ipcRenderer.invoke('map-forge:load-recovery'),
  exportBundle: project => ipcRenderer.invoke('map-forge:export-bundle', project),
};

contextBridge.exposeInMainWorld('baekho', Object.freeze(api));
