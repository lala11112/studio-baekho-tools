/** Existing generated triple-sphere attack only. No AI inference, bridge install, source edits or scene saves. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {connectUnityMcp,DEFAULT_UNITY_ENDPOINT,type UnityMcpClient} from '../electron/services/unity-mcp';

const output=path.resolve('artifacts/runtime-smoke.json');
const runPlay=process.argv.includes('--play');
const explicitType=process.argv.find(argument=>argument.startsWith('--type='))?.slice('--type='.length);
const sample=await readFile('artifacts/ai-integration.json','utf8').then(JSON.parse).catch(()=>null);
const typeId=explicitType??sample?.result?.typeId;
if(typeof typeId!=='string'||!/^Baekho\.Generated\.[A-Za-z0-9_.]+$/.test(typeId))
  throw new Error('먼저 scripts/smoke-ai.ts로 3연사 샘플을 생성하거나 --type=정규타입명을 지정하세요.');

let client:UnityMcpClient|null=null;
let instanceId='';
let playPending=false;
let interrupted=false;
const startedAt=new Date().toISOString();
const report:Record<string,unknown>={startedAt,typeId,playModeRequested:runPlay};
process.on('SIGINT',()=>{interrupted=true;});
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const unwrap=(response:any)=>{
  if(response?.success===false)throw new Error(response.error??response.message??JSON.stringify(response));
  return response?.data??response;
};
async function connect(){
  await client?.close();client=await connectUnityMcp(DEFAULT_UNITY_ENDPOINT);
  const instances=unwrap(await client.readResource('mcpforunity://instances')).instances??[];
  assert.equal(instances.length,1,'이 검증은 Unity Editor가 하나만 열려 있을 때 실행하세요.');
  instanceId=instances[0].id;await client.callTool('set_active_instance',{instance:instanceId});
}
async function execute(code:string){
  if(!client)await connect();
  const response=unwrap(await client!.callTool('execute_code',{action:'execute',code},120_000));
  if(response.errors)throw new Error(JSON.stringify(response.errors));
  return response.result;
}
async function status(){
  for(let attempt=0;;attempt++){
    try{return await execute('return StudioBaekho.EnemyForge.BaekhoEnemyForgePlayModeRegression.Status();');}
    catch(error){
      if(attempt>=5)throw error;
      // Reading status may reconnect across Play Mode domain reloads; mutation requests are never replayed.
      try{await connect();}catch{/* Editor may still be reloading. */}
      await sleep(1000);
    }
  }
}
const sceneSnapshotCode='var scenes=new System.Collections.Generic.List<object>();for(int i=0;i<UnityEngine.SceneManagement.SceneManager.sceneCount;i++){var s=UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);scenes.Add(new{path=s.path,isDirty=s.isDirty,isLoaded=s.isLoaded,isActive=s==UnityEngine.SceneManagement.SceneManager.GetActiveScene()});}return new{scenes,playing=UnityEditor.EditorApplication.isPlaying};';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
try{
  await mkdir(path.dirname(output),{recursive:true});await connect();
  const project=unwrap(await client!.readResource('mcpforunity://project/info'));
  if(sample?.projectRoot&&!explicitType)assert.equal(path.resolve(project.projectRoot).toLowerCase(),path.resolve(sample.projectRoot).toLowerCase(),'생성 샘플의 프로젝트와 연결된 Unity가 다릅니다.');
  report.project=project;
  const before=await execute(sceneSnapshotCode);assert.equal(before.playing,false,'Unity의 Play Mode를 먼저 종료하세요.');
  assert.ok(before.scenes.every((scene:any)=>!scene.isLoaded||(!scene.isDirty&&scene.path)),'열린 씬을 먼저 저장하세요. 검증은 씬을 자동 저장하지 않습니다.');
  const hashes:Record<string,string>={};
  for(const scene of before.scenes.filter((scene:any)=>scene.isLoaded))hashes[scene.path]=sha(await readFile(path.join(project.projectRoot,scene.path)));
  report.before={...before,sourceHashes:hashes};
  report.editMode=await execute(`return new{builtins=StudioBaekho.EnemyForge.BaekhoEnemyForgeRuntimeRegression.RunBuiltins(),generated=StudioBaekho.EnemyForge.BaekhoEnemyForgeRuntimeRegression.RunGeneratedProjectile(${JSON.stringify(typeId)})};`);
  assert.equal((report.editMode as any).builtins.passed,true);assert.equal((report.editMode as any).generated.passed,true);
  if(runPlay){
    if(interrupted)throw new Error('검증이 취소되었습니다.');
    playPending=true;
    // If this response is lost during reload, query status instead of starting another test.
    try{await execute(`return StudioBaekho.EnemyForge.BaekhoEnemyForgePlayModeRegression.Start(${JSON.stringify(typeId)});`);}
    catch(error){console.warn(`시작 응답 확인 중: ${String(error)}. 기존 작업의 상태를 조회합니다.`);}
    const deadline=Date.now()+190_000;
    for(;;){
      if(interrupted)throw new Error('검증이 취소되었습니다. 원래 씬 복구를 기다립니다.');
      const current=await status();
      if(current.typeId!==typeId||Date.parse(current.startedUtc??'')<Date.parse(startedAt)-1000)
        throw new Error('현재 실행에서 시작된 PlayMode 검증을 확인할 수 없습니다.');
      if(current.state==='completed'||current.state==='failed'){
        playPending=false;report.playMode=current;assert.equal(current.state,'completed',current.error??'PlayMode 검증 실패');
        assert.equal(current.cases.length,5);assert.ok(current.cases.every((test:any)=>test.passed));break;
      }
      if(Date.now()>deadline)throw new Error('PlayMode 검증 제한 시간이 지났습니다.');
      await sleep(1000);
    }
  }
  const after=await execute(sceneSnapshotCode);assert.equal(after.playing,false);assert.deepEqual(after.scenes,before.scenes,'검증 후 씬 구성이 달라졌습니다.');
  const afterHashes:Record<string,string>={};
  for(const [scene,hash]of Object.entries(hashes)){afterHashes[scene]=sha(await readFile(path.join(project.projectRoot,scene)));assert.equal(afterHashes[scene],hash,`씬 파일이 변경되었습니다: ${scene}`);}
  report.after={...after,sourceHashes:afterHashes};report.status='passed';
  console.log(JSON.stringify({passed:true,editMode:report.editMode,playMode:report.playMode??'not requested; add --play for five actual runtime cases',report:output},null,2));
}catch(error){
  report.status='failed';report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;console.error(report.error);
}finally{
  if(playPending){
    try{
      await execute('if(UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode)UnityEditor.EditorApplication.ExitPlaymode();return true;');
      const deadline=Date.now()+60_000;
      while(Date.now()<deadline){const current=await status();if(current.state==='completed'||current.state==='failed'){report.recovery=current;break;}await sleep(1000);}
    }catch(error){report.recoveryError=String(error);console.error('Unity 씬 복구 상태를 확인하세요:',error);}
  }
  report.finishedAt=new Date().toISOString();await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2),'utf8');
  await client?.close();
}
