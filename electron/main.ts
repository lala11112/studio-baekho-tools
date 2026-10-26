import {app,BrowserWindow,ipcMain,dialog,shell} from 'electron';
import path from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {UnityService} from './services/unity';
import {atomicWrite,installIntegration,projectFile,optionalRead,verifyProject} from './services/files';
import {validateBlueprint} from '../src/shared/blueprint';
import {AiService} from './services/ai';
import type {AssetRef,EnemyBlueprint,PreviewFrameRequest,AiAttackRequest,AiConceptRequest} from '../src/shared/types';
let window:BrowserWindow|null=null;const unity=new UnityService();let ai:AiService;let writing=false;
const ownsInstance=app.requestSingleInstanceLock();if(!ownsInstance)app.quit();
app.on('second-instance',()=>{if(window?.isMinimized())window.restore();window?.show();window?.focus();});
const progress=(stage:string,message:string)=>window?.webContents.send('forge:progress',{stage,message});
async function exclusive<T>(fn:()=>Promise<T>):Promise<T>{if(writing)throw new Error('다른 생성 작업이 진행 중입니다.');writing=true;try{return await fn();}finally{writing=false;}}
function handlers(){
  const handle=(name:string,fn:(...args:any[])=>unknown)=>ipcMain.handle(`forge:${name}`,(event,...args)=>{
    if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('허용되지 않는 요청입니다.');return fn(...args);
  });
  handle('connect',()=>exclusive(async()=>{const c=await unity.connect();await ai.recoverPending();await atomicWrite(path.join(app.getPath('userData'),'project.json'),JSON.stringify(c));return c;}));
  handle('choose-project',async()=>{const result=await dialog.showOpenDialog(window!,{title:'Unity 프로젝트 폴더',properties:['openDirectory']});if(result.canceled)return null;const root=result.filePaths[0];await verifyProject(root);unity.selectedRoot=root;return root;});
  handle('install',(root:string)=>exclusive(async()=>{
    if(typeof root!=='string')throw new Error('프로젝트 경로가 필요합니다.');unity.selectedRoot=root;await unity.connect();
    progress('연동 설치','Unity 연동 스크립트를 설치하고 있습니다.');
    await installIntegration(root,app.isPackaged?path.join(process.resourcesPath,'unity-integration'):path.join(app.getAppPath(),'unity-integration'));
    await unity.call('refresh');
    for(let n=0;n<90;n++){await new Promise(r=>setTimeout(r,1000));let s;try{s=await unity.call('ready');}catch(e){if(n===89)throw e;continue;}if(s.hasErrors)throw new Error('Unity 컴파일 오류가 있습니다. 콘솔을 확인하세요.');if(s.ready){progress('완료','Unity 연동이 준비되었습니다.');return;}}
    throw new Error('Unity 컴파일이 완료되지 않았습니다. 잠시 후 연결을 다시 시도하세요.');
  }));
  handle('catalog',()=>unity.call('catalog'));
  handle('animation-info',(controller:AssetRef|null)=>{if(controller!==null&&(!controller||typeof controller.guid!=='string'||typeof controller.localId!=='string'))throw new Error('컨트롤러 참조가 올바르지 않습니다.');return unity.call('animation_info',{controller});});
  handle('analyze-model',(blueprint:EnemyBlueprint)=>{validateBlueprint(blueprint);return unity.call('analyze_model',{blueprint});});
  handle('assets-search',(query:string,kinds:string[])=>{if(typeof query!=='string'||query.length>200||!Array.isArray(kinds)||kinds.some(k=>!['Model','GameObject','AnimationClip','AnimatorController','Material','AudioClip'].includes(k)))throw new Error('에셋 검색 조건이 올바르지 않습니다.');return unity.call('assets_search',{query,kinds,limit:150});});
  handle('validate',(blueprint:EnemyBlueprint)=>{validateBlueprint(blueprint);return unity.call('validate',{blueprint});});
  handle('build',(blueprint:EnemyBlueprint)=>exclusive(()=>unity.build(blueprint,()=>progress('Unity 준비 대기','Play Mode 종료와 컴파일·에셋 갱신 완료를 기다립니다.'))));
  handle('save',async(b:EnemyBlueprint)=>{validateBlueprint(b);const r=await dialog.showSaveDialog(window!,{title:'적 설계 저장',defaultPath:`${b.name}.enemyforge.json`,filters:[{name:'Enemy Forge 설계',extensions:['json']}]});if(r.canceled||!r.filePath)return null;await atomicWrite(r.filePath,JSON.stringify(b,null,2));return r.filePath;});
  handle('open',async()=>{const r=await dialog.showOpenDialog(window!,{title:'적 설계 열기',filters:[{name:'Enemy Forge 설계',extensions:['json']}],properties:['openFile']});if(r.canceled)return null;const file=r.filePaths[0];if((await stat(file)).size>5*1024*1024)throw new Error('설계 파일이 너무 큽니다.');const b=JSON.parse(await readFile(file,'utf8'));validateBlueprint(b);return b;});
  handle('preview-open',(blueprint:EnemyBlueprint)=>{validateBlueprint(blueprint);return unity.call('preview_open',{blueprint});});
  handle('preview-frame',async(r:PreviewFrameRequest)=>{if(!Number.isFinite(r.time)||r.time<0||![r.yaw,r.pitch,r.zoom].every(Number.isFinite)||r.moveParameters!==undefined&&(!Array.isArray(r.moveParameters)||r.moveParameters.length!==2||!r.moveParameters.every(Number.isFinite)))throw new Error('잘못된 미리보기 요청입니다.');validateBlueprint(r.blueprint);const result=await unity.call('preview_frame',r as any);return {...result,dataUrl:await unity.previewImage(result.imagePath,r.sessionId)};});
  handle('preview-close',(sessionId:string)=>unity.call('preview_close',{sessionId}));
  handle('ai-status',()=>ai.status());
  handle('ai-login',async()=>{const url=await ai.login();const parsed=new URL(url);if(parsed.protocol!=='https:'||!['auth.openai.com','auth.chatgpt.com','chatgpt.com'].includes(parsed.hostname))throw new Error('로그인 URL을 확인할 수 없습니다.');await shell.openExternal(url);});
  handle('ai-select',async()=>{const r=await dialog.showOpenDialog(window!,{title:'Codex 실행 파일',filters:[{name:'Codex',extensions:['exe']}],properties:['openFile']});return r.canceled?ai.status():ai.selectExecutable(r.filePaths[0]);});
  handle('ai-generate',(request:AiAttackRequest)=>exclusive(()=>{validateBlueprint(request.blueprint);return ai.generate(request);}));
  handle('ai-concept',(request:AiConceptRequest)=>exclusive(()=>{validateBlueprint(request.blueprint);return ai.generateConcept(request);}));
  handle('ai-cancel',()=>ai.cancel());
  handle('reveal',async(relative:string)=>{if(typeof relative!=='string'||!relative.startsWith('Assets/'))throw new Error('출력 경로를 확인하세요.');shell.showItemInFolder(await projectFile(unity.root,relative));});
}
if(ownsInstance)app.whenReady().then(async()=>{
  let saved:any=null;try{saved=JSON.parse(await optionalRead(path.join(app.getPath('userData'),'project.json'))??'null');}catch{/* A damaged preference must not prevent launching the app. */}unity.selectedRoot=typeof saved?.projectRoot==='string'?saved.projectRoot:'';
  ai=new AiService({dataDirectory:path.join(app.getPath('userData'),'ai'),getProjectRoot:()=>unity.root,unity:(action,payload)=>unity.call(action,payload),onProgress:p=>window?.webContents.send('forge:progress',p)});
  handlers();window=new BrowserWindow({width:1540,height:980,minWidth:1100,minHeight:740,title:'Baekho Enemy Forge',backgroundColor:'#141715',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{const target=process.env.FORGE_DEV_URL;if(!target||!url.startsWith(target+'/'))event.preventDefault();});
  if(!app.isPackaged&&process.env.FORGE_DEV_URL)await window.loadURL(process.env.FORGE_DEV_URL);else await window.loadFile(path.join(__dirname,'../dist/index.html'));
  window.once('ready-to-show',()=>window?.show());window.show();
});
app.on('window-all-closed',()=>{ai?.dispose();void unity.dispose();app.quit();});
