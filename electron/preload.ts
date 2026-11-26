import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../src/shared/types';

const api: DesktopAPI = {
  getClaudeStatus: () => ipcRenderer.invoke('baekho:claude-status'),
  selectClaudeExecutable: () => ipcRenderer.invoke('baekho:claude-select'),
  getAiPreferences: () => ipcRenderer.invoke('baekho:ai-preferences-get'),
  setAiPreferences: preferences => ipcRenderer.invoke('baekho:ai-preferences-set', preferences),
  getCodexStatus: () => ipcRenderer.invoke('baekho:codex-status'),
  startCodexLogin: () => ipcRenderer.invoke('baekho:codex-login'),
  selectCodexExecutable: () => ipcRenderer.invoke('baekho:codex-select'),
  generateConcept: (settings, catalog, context) => ipcRenderer.invoke('baekho:generate-concept', settings, catalog, context),
  generateImage: (settings, region, catalog, context) => ipcRenderer.invoke('baekho:generate-image', settings, region, catalog, context),
  extractLayout: (settings, imageDataUrl, region, catalog) => ipcRenderer.invoke('baekho:extract-layout', settings, imageDataUrl, region, catalog),
  generateLayout: (settings, region, catalog, context) => ipcRenderer.invoke('baekho:generate-layout', settings, region, catalog, context),
  onGenerationProgress: listener => {
    const receive = (_event: Electron.IpcRendererEvent, progress: import('../src/shared/types').GenerationProgress) => listener(progress);
    ipcRenderer.on('baekho:generation-progress', receive);
    return () => { ipcRenderer.removeListener('baekho:generation-progress', receive); };
  },
  recordGenerationStage: event => ipcRenderer.invoke('baekho:generation-stage', event),
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
