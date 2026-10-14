'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const api = {};
for (const name of ['getState', 'selectProject', 'connectProject', 'installIntegration', 'refreshCatalog', 'searchAnimations', 'importFiles', 'addJobs', 'selectJob', 'updateJob', 'updateSettings', 'analyzeJobs', 'cancelAnalysis', 'removeJob', 'previewChange', 'applyChange', 'revealAsset']) {
  api[name] = async (...args) => {
    const result = await ipcRenderer.invoke('aht:' + name, ...args);
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  };
}
api.filePath = file => webUtils.getPathForFile(file);
function subscribe(channel, callback, normalize) {
  if (typeof callback !== 'function') throw new TypeError('A subscription callback is required.');
  const listener = (_event, value) => { const payload = normalize(value); if (payload !== undefined) callback(payload); };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
api.onState = callback => subscribe('aht:state', callback, value => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
api.onNavigate = callback => subscribe('aht:navigate', callback, value => {
  if (!value || typeof value !== 'object' || typeof value.projectPath !== 'string' || value.projectPath.length > 32768 || value.projectPath.includes('\0')) return undefined;
  if (value.jobId !== undefined && (typeof value.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.jobId))) return undefined;
  if (value.tab !== undefined && !['hits', 'save'].includes(value.tab)) return undefined;
  return { projectPath: value.projectPath, ...(value.jobId !== undefined ? { jobId: value.jobId } : {}), ...(value.tab ? { tab: value.tab } : {}) };
});
api.onVisibility = callback => subscribe('aht:visibility', callback, value => typeof value === 'boolean' ? value : undefined);
contextBridge.exposeInMainWorld('autoHitTimer', Object.freeze(api));
