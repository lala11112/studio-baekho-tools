import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../src/shared/types';

const api: DesktopAPI = {
  getCodexStatus: () => ipcRenderer.invoke('baekho:codex-status'),
  startCodexLogin: () => ipcRenderer.invoke('baekho:codex-login'),
  selectCodexExecutable: () => ipcRenderer.invoke('baekho:codex-select'),
  generateConcept: (settings, catalog, context) => ipcRenderer.invoke('baekho:generate-concept', settings, catalog, context),
  generateImage: (settings, region, catalog) => ipcRenderer.invoke('baekho:generate-image', settings, region, catalog),
  extractLayout: (settings, imageDataUrl, region, catalog) => ipcRenderer.invoke('baekho:extract-layout', settings, imageDataUrl, region, catalog),
  cancelGeneration: () => ipcRenderer.invoke('baekho:cancel-generation'),
  scanProject: () => ipcRenderer.invoke('baekho:scan-project'),
  importPropCatalog: () => ipcRenderer.invoke('baekho:import-prop-catalog'),
  importUnityAssetCatalog: endpoint => ipcRenderer.invoke('baekho:import-unity-asset-catalog', endpoint),
  saveProject: project => ipcRenderer.invoke('baekho:save-project', project),
  saveProjects: projects => ipcRenderer.invoke('baekho:save-projects', projects),
  openProject: () => ipcRenderer.invoke('baekho:open-project'),
  openComparisonProject: () => ipcRenderer.invoke('baekho:open-comparison-project'),
  saveRecovery: project => ipcRenderer.invoke('baekho:save-recovery', project),
  loadRecovery: () => ipcRenderer.invoke('baekho:load-recovery'),
  exportBundle: project => ipcRenderer.invoke('baekho:export-bundle', project),
  getUnityStatus: endpoint => ipcRenderer.invoke('baekho:unity-status', endpoint),
  prepareUnityIntegration: endpoint => ipcRenderer.invoke('baekho:unity-prepare', endpoint),
  startUnityPrefabBuild: (project, endpoint) => ipcRenderer.invoke('baekho:unity-build-start', project, endpoint),
  getUnityPrefabBuild: requestId => ipcRenderer.invoke('baekho:unity-build-status', requestId),
};

contextBridge.exposeInMainWorld('baekho', Object.freeze(api));
