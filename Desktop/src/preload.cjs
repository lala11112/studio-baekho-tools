const { contextBridge, ipcRenderer } = require('electron');
const methods = ['bootstrap', 'chooseProject', 'refresh', 'describe', 'run', 'cancel',
  'loadReport', 'exportPreset', 'exportCombinedPreset', 'saveRequest', 'loadRequest', 'saveJudgment', 'revealRun',
  'aiStatus', 'generateCandidates', 'cancelGeneration'];
const api = {};
for (const method of methods) api[method] = (...args) => ipcRenderer.invoke(`baekho:${method}`, ...args);
contextBridge.exposeInMainWorld('baekho', Object.freeze(api));
