'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const api = {};
for (const name of ['getState', 'selectProject', 'connectProject', 'installIntegration', 'refreshCatalog', 'searchAnimations', 'cancelAnimationSearch', 'importFiles', 'addJobs', 'selectJob', 'updateJob', 'updateSettings', 'setAiProvider', 'analyzeJobs', 'cancelAnalysis', 'removeJob', 'previewChange', 'applyChange', 'revealAsset']) {
  api[name] = async (...args) => {
    const result = await ipcRenderer.invoke('aht:' + name, ...args);
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  };
}
api.filePath = file => webUtils.getPathForFile(file);
api.onState = callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('aht:state', listener); return () => ipcRenderer.removeListener('aht:state', listener); };
contextBridge.exposeInMainWorld('autoHitTimer', api);
