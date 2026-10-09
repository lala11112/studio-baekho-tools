const { contextBridge, ipcRenderer } = require('electron');
const methods = ['bootstrap', 'chooseProject', 'refresh', 'describe', 'run', 'cancel',
  'loadReport', 'exportPreset', 'exportCombinedPreset', 'saveRequest', 'loadRequest', 'saveJudgment', 'revealRun',
  'aiStatus', 'generateCandidates', 'cancelGeneration'];
const api = {};
for (const method of methods) api[method] = (...args) => ipcRenderer.invoke(`baekho:${method}`, ...args);
// Never expose Electron's event (and its sender) to the renderer.
function subscribe(channel, callback, normalize) {
  if (typeof callback !== 'function') throw new TypeError('A subscription callback is required.');
  const listener = (_event, value) => {
    const payload = normalize(value);
    if (payload !== undefined) callback(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
api.onNavigate = callback => subscribe('baekho:navigate', callback, value => {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.projectPath !== 'string' || value.projectPath.length > 32768 || value.projectPath.includes('\0')) return undefined;
  if (value.runId !== undefined && (typeof value.runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,127}$/.test(value.runId))) return undefined;
  if (value.tab !== undefined && !['setup', 'compare'].includes(value.tab)) return undefined;
  return { projectPath: value.projectPath, ...(value.runId ? { runId: value.runId } : {}), ...(value.tab ? { tab: value.tab } : {}) };
});
api.onVisibility = callback => subscribe('baekho:visibility', callback, value => typeof value === 'boolean' ? value : undefined);
contextBridge.exposeInMainWorld('baekho', Object.freeze(api));
