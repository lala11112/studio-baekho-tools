import {contextBridge,ipcRenderer} from 'electron';
import type {DesktopApi} from '../src/shared/types';
const invoke=(name:string,...args:unknown[])=>ipcRenderer.invoke(`forge:${name}`,...args);
const api:DesktopApi={
  connect:()=>invoke('connect'),chooseProject:()=>invoke('choose-project'),installBridge:p=>invoke('install',p),catalog:()=>invoke('catalog'),
  validate:b=>invoke('validate',b),build:b=>invoke('build',b),save:b=>invoke('save',b),open:()=>invoke('open'),searchAssets:(query,kinds)=>invoke('assets-search',query,kinds),
  animationInfo:controller=>invoke('animation-info',controller),analyzeModel:blueprint=>invoke('analyze-model',blueprint),
  previewOpen:b=>invoke('preview-open',b),previewFrame:r=>invoke('preview-frame',r),previewClose:s=>invoke('preview-close',s),
  aiStatus:()=>invoke('ai-status'),aiLogin:()=>invoke('ai-login'),aiSelectExecutable:()=>invoke('ai-select'),aiGenerate:r=>invoke('ai-generate',r),aiGenerateConcept:r=>invoke('ai-concept',r),aiCancel:()=>invoke('ai-cancel'),
  onProgress:callback=>{const listener=(_event:unknown,p:any)=>callback(p);ipcRenderer.on('forge:progress',listener);return()=>ipcRenderer.removeListener('forge:progress',listener);},
  reveal:p=>invoke('reveal',p)
};contextBridge.exposeInMainWorld('forge',api);
