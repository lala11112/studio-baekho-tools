import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {connectUnityMcp,DEFAULT_UNITY_ENDPOINT,type UnityMcpClient} from './unity-mcp';
import {atomicWrite,hash,projectFile,optionalRead} from './files';
import {normalizeBlueprint} from '../../src/shared/blueprint';
import type {Connection,EnemyBlueprint,BuildResult} from '../../src/shared/types';
export class UnityOperationError extends Error {
  readonly definitive=true;
  constructor(message:string){super(message);this.name='UnityOperationError';}
}
const unwrap=(r:any)=>{if(r?.success===false)throw new UnityOperationError(r.error??r.message??'Unity 작업 실패');return r?.data??r;};
export class UnityService {
  private client:UnityMcpClient|null=null; connection:Connection|null=null; selectedRoot=''; private tail:Promise<unknown>=Promise.resolve();
  get root(){if(!this.connection)throw new Error('먼저 Unity에 연결하세요.');return this.connection.projectRoot;}
  async connect():Promise<Connection>{
    await this.client?.close();this.connection=null;this.client=await connectUnityMcp(DEFAULT_UNITY_ENDPOINT);
    const instances=unwrap(await this.client.readResource('mcpforunity://instances')).instances??[];
    const matches=instances.length===1?instances:instances.filter((i:any)=>this.selectedRoot&&i.name===path.basename(this.selectedRoot));
    if(matches.length!==1)throw new Error('연결할 Unity 프로젝트 폴더를 선택하세요. 같은 이름의 Editor가 여러 개면 하나만 열어 주세요.');
    await this.client.callTool('set_active_instance',{instance:matches[0].id});
    const info=unwrap(await this.client.readResource('mcpforunity://project/info'));
    if(this.selectedRoot&&path.resolve(this.selectedRoot).toLowerCase()!==path.resolve(info.projectRoot).toLowerCase())throw new Error('선택한 프로젝트와 열린 Unity 프로젝트가 다릅니다.');
    this.connection={projectRoot:info.projectRoot,projectName:info.projectName,unityVersion:info.unityVersion,instanceId:matches[0].id};this.selectedRoot=info.projectRoot;
    return this.connection;
  }
  async call(action:string,payload:Record<string,unknown>={}):Promise<any>{
    const operation=this.tail.then(()=>this.perform(action,payload)).catch(async error=>{
      if(/session.*(?:invalid|expired|terminated|not found)|not connected|fetch failed|ECONN|transport.*closed|HTTP 404/i.test(String(error))){const client=this.client;this.client=null;try{await client?.close();}catch{/* reconnect on next request */}}
      throw error;
    });this.tail=operation.catch(()=>undefined);return operation;
  }
  private async perform(action:string,payload:Record<string,unknown>):Promise<any>{
    if(!this.client)await this.connect();const client=this.client!;
    if(action==='refresh')return unwrap(await client.callTool('refresh_unity',{mode:'force',scope:'all',compile:'request',wait_for_ready:true},120_000));
    if(action==='ready'||action==='compilation_status'){
      const s=unwrap(await client.readResource('mcpforunity://editor/state'));
      let compilation:any={};
      if(!s.compilation?.is_compiling&&!s.compilation?.is_domain_reload_pending){try{compilation=unwrap(await client.callTool('execute_custom_tool',{tool_name:'baekho_enemy_forge',parameters:{action:'compilation_status',expectedProjectRoot:this.root,payload:{}}}));}catch{/* bridge may be reloading */}}
      return {ready:!s.editor?.play_mode?.is_playing&&!s.editor?.play_mode?.is_changing&&!s.compilation?.is_compiling&&!s.compilation?.is_domain_reload_pending&&!s.assets?.is_updating&&!!compilation.ready,hasErrors:!!compilation.hasErrors,errors:compilation.errors??[],isCompiling:!!s.compilation?.is_compiling};
    }
    return unwrap(await client.callTool('execute_custom_tool',{tool_name:'baekho_enemy_forge',parameters:{action,expectedProjectRoot:this.root,payload}},120_000));
  }
  async build(blueprint:EnemyBlueprint,onWaiting:()=>void=()=>undefined):Promise<BuildResult>{
    blueprint=normalizeBlueprint(blueprint);const inputHash=hash(JSON.stringify(blueprint));
    const journal=await projectFile(this.root,'Library/BaekhoEnemyForge/app-build.json',true);
    const prev=JSON.parse(await optionalRead(journal)??'null');
    if(prev?.pending){
      let recovered:BuildResult;
      try{recovered=await this.call('status',{requestId:prev.requestId,inputHash:prev.inputHash});}
      catch(error){
        // Unity writes its receipt before creating any asset. A confirmed absence
        // means this request was never admitted; an unknown transport result does not.
        if(error instanceof UnityOperationError&&error.message.startsWith('No receipt exists for this request.')){
          await atomicWrite(journal,JSON.stringify({...prev,pending:false,error:error.message}));
          throw new Error('이전 생성 요청이 Unity에 접수되지 않은 것을 확인했습니다. 현재 설계로 생성하려면 다시 눌러 주세요.');
        }
        throw error;
      }
      if(recovered.state==='running')throw new Error('이전 생성 요청이 아직 처리 중입니다. 잠시 후 다시 확인하세요.');
      await atomicWrite(journal,JSON.stringify({...prev,pending:false,result:recovered}));
      if(prev.inputHash===inputHash)return recovered;
      if(recovered.state==='completed')throw new Error(`이전 설계의 생성 완료를 확인했습니다: ${recovered.prefabPath}. 현재 변경한 설계를 생성하려면 다시 눌러 주세요.`);
      throw new Error(`이전 생성 요청이 실패했습니다: ${recovered.error??'Unity 결과 확인 필요'}. 현재 설계로 다시 시도할 수 있습니다.`);
    }
    // Admission happens only after Play Mode, imports and script reload have ended.
    const deadline=Date.now()+180000;let waitingReported=false;
    for(;;){
      const state=await this.call('ready');
      if(state.hasErrors)throw new Error(`Unity 컴파일 오류를 먼저 해결하세요. ${(state.errors??[]).join('\n')}`);
      if(state.ready)break;
      if(!waitingReported){onWaiting();waitingReported=true;}
      if(Date.now()>=deadline)throw new Error('Unity 준비를 기다리는 시간이 초과되었습니다. Play Mode를 종료하고 컴파일·에셋 갱신이 끝난 뒤 다시 시도하세요.');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    const requestId=randomUUID();await atomicWrite(journal,JSON.stringify({requestId,inputHash,pending:true}));
    // Do not replay a request whose response was lost; next call queries its receipt.
    try{
      const result=await this.call('build',{requestId,inputHash,inputJson:JSON.stringify(blueprint),blueprint});
      await atomicWrite(journal,JSON.stringify({requestId,inputHash,pending:false,result}));return result;
    }catch(error){
      // Even a returned error can follow an asset save (for example a receipt
      // disk-write failure). Reconcile it rather than guessing when it occurred.
      if(error instanceof UnityOperationError){
        try{
          const receipt=await this.call('status',{requestId,inputHash});
          if(receipt.state!=='running'){await atomicWrite(journal,JSON.stringify({requestId,inputHash,pending:false,result:receipt}));return receipt;}
        }catch(statusError){
          if(statusError instanceof UnityOperationError&&statusError.message.startsWith('No receipt exists for this request.'))await atomicWrite(journal,JSON.stringify({requestId,inputHash,pending:false,error:error.message}));
        }
      }
      throw error;
    }
  }
  async previewImage(imagePath:string,sessionId:string){
    if(!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId))throw new Error('잘못된 미리보기 세션입니다.');
    const rel=path.relative(this.root,path.resolve(imagePath));const file=await projectFile(this.root,rel);
    const allowed=path.resolve(this.root,'Library/BaekhoEnemyForge/Preview',sessionId)+path.sep;
    const ext=path.extname(file).toLowerCase();
    if(!file.toLowerCase().startsWith(allowed.toLowerCase())||!['.png','.jpg'].includes(ext))throw new Error('미리보기 이미지 경로가 올바르지 않습니다.');
    const bytes=await readFile(file);if(bytes.length>8*1024*1024)throw new Error('미리보기 이미지가 너무 큽니다.');return `data:image/${ext==='.jpg'?'jpeg':'png'};base64,${bytes.toString('base64')}`;
  }
  async dispose(){await this.client?.close();this.client=null;}
}
