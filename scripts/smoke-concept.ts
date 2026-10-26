import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AiService} from '../electron/services/ai';
import {UnityService} from '../electron/services/unity';
import {CodexTransport,type CodexRpc,type RpcObject} from '../electron/services/codex-transport';
import type {AiConceptResult,AiProgress,Catalog,EnemyBlueprint,ModelAnalysis} from '../src/shared/types';

// Live Codex inference, configuration only. It never builds or places a prefab.
// Repeat runs reuse a previously verified result unless --force is supplied.
const artifact=path.resolve('artifacts/concept-integration.json');
const prompt='성문을 지키는 느리고 튼튼한 돌 수호자를 만들어줘. 최대 체력은 600, 공격력은 35, 방어력은 20, 치명타 확률은 5%로 하고 공통 공격 대기는 2.4초로 해줘. 이동 속도는 1.8m/s, 가속도는 4, 회전 속도는 초당 120도로 설정해줘. 감지 거리는 14m, 시야 반각은 55도, 근접 전방위 감지는 2.5m, 목표 기억 시간은 3초로 해줘. 전투 진입 거리는 10m, 이탈 거리는 16m가 좋겠어. 공격은 현재 카탈로그에 있는 일반 단타와 돌진 공격 두 개만 재사용해줘. 단타는 공격력의 1.2배 피해이고 0.35초에 판정이 시작돼 0.15초 유지되며 전체 시간은 0.8초야. 돌진은 0.6초 준비하고 속도 7m/s로 0.4초 돌진한 뒤 0.5초 회복하며 피해 배율은 1.5야. 두 공격은 최소거리 0, 실행거리 2m, 선택거리 6m, 공격속도 1, 선택가중치 1로 하고 상태명은 둘 다 이미 연결된 Attack을 사용해줘. 기존 설정만으로 충분하므로 새 공격 소스는 필요 없어. 체력바는 모델 머리 위, 피격 효과는 몸통 안의 자연스러운 위치에 놓아줘. 이름과 모델, 모델 배치, 애니메이션은 유지해줘.';
const unity=new UnityService(),progress:AiProgress[]=[];
const replayIndex=process.argv.indexOf('--replay-planner'),replayId=replayIndex<0?'':process.argv[replayIndex+1];
if(replayIndex>=0&&!/^a[0-9a-f]{32}$/.test(replayId??''))throw new Error('--replay-planner requires an existing concept draft ID.');
let savedPlanner:unknown;
/** Replay only a captured REAL planner response, while status/model/config use the real CLI.
 * This is explicit integration-test recovery after an unload RPC failed; never request another turn. */
class SavedPlannerRpc implements CodexRpc{
  private listeners=new Set<(method:string,params:RpcObject)=>void>();private turns=0;
  constructor(private actual:CodexRpc){}
  async request(method:string,params:RpcObject):Promise<RpcObject>{
    if(method==='thread/start')return {thread:{id:'saved-live-planner'}};
    if(method==='turn/start'){
      if(++this.turns>1||params.threadId!=='saved-live-planner'||!savedPlanner)throw new Error('Saved-response recovery refuses additional inference.');
      setImmediate(()=>{for(const listener of this.listeners)listener('turn/completed',{threadId:'saved-live-planner',turn:{id:'saved-turn',status:'completed',items:[{id:'saved-message',type:'agentMessage',phase:'final_answer',text:JSON.stringify(savedPlanner)}]}});});
      return {turn:{id:'saved-turn'}};
    }
    if(method==='thread/unload'&&params.threadId==='saved-live-planner')throw new Error('Saved live ephemeral thread has already been unloaded.');
    return this.actual.request(method,params);
  }
  onNotification(listener:(method:string,params:RpcObject)=>void){this.listeners.add(listener);const stop=this.actual.onNotification(listener);return()=>{this.listeners.delete(listener);stop();};}
  onClose(listener:()=>void){return this.actual.onClose(listener);}
  close(){this.actual.close();}
}
const ai=new AiService({dataDirectory:path.resolve('artifacts/ai-data'),getProjectRoot:()=>unity.root,unity:(action,payload)=>unity.call(action,payload),
  ...(replayId?{connect:async(runtime:{executable:string},directory:string)=>{const actual=new CodexTransport(runtime.executable,directory);await actual.initialize();return new SavedPlannerRpc(actual);}}:{}),
  onProgress:value=>{progress.push(value);process.stdout.write(`[${value.stage}] ${value.message}\n`);}});
const startedAt=new Date().toISOString();
async function sourceSnapshot(root:string):Promise<Record<string,string>>{
  const hashes:Record<string,string>={};
  async function scan(folder:string):Promise<void>{
    for(const entry of await readdir(folder,{withFileTypes:true}).catch(()=>[])){
      if(entry.isSymbolicLink())continue;
      const file=path.join(folder,entry.name);
      if(entry.isDirectory())await scan(file);
      else if(entry.isFile()&&(entry.name.endsWith('.cs')||entry.name.endsWith('.enemyattack.json')))hashes[path.relative(root,file).replace(/\\/g,'/')]=createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await scan(path.join(root,'Assets','_Project','Scripts','Enemy','Generated'));return Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b)));
}
function verifyResult(result:AiConceptResult,input:EnemyBlueprint,analysis:ModelAnalysis):void{
  const b=result.blueprint;
  assert.equal(b.name,input.name);assert.deepEqual(b.model,input.model);assert.deepEqual(b.modelTransform,input.modelTransform);assert.deepEqual(b.animation,input.animation);
  assert.equal(b.stats.maxHp,600);assert.equal(b.stats.baseAtk,35);assert.equal(b.stats.baseDef,20);assert.equal(b.stats.criticalChance,.05);assert.equal(b.stats.attackCooldown,2.4);
  assert.equal(b.components.NavMeshAgent.m_Speed,1.8);assert.equal(b.components.NavMeshAgent.m_Acceleration,4);assert.equal(b.components.NavMeshAgent.m_AngularSpeed,120);
  assert.equal(b.components.FanVisionSensor._range,14);assert.equal(b.components.FanVisionSensor._halfAngle,55);assert.equal(b.components.FanVisionSensor._proximityRange,2.5);assert.equal(b.components.Enemy._targetMemoryDuration,3);
  assert.equal(b.attacks.length,2);assert.ok(b.attacks.some(attack=>attack.typeId==='MonsterDefaultAttackSO'));assert.ok(b.attacks.some(attack=>attack.typeId==='MonsterDashAttackSO'));
  assert.ok(result.attacks.every(attack=>attack.configuredExisting&&attack.files.length===0));
  assert.deepEqual(b.components.SphereCollider,input.components.SphereCollider);assert.deepEqual(b.components.EnemyDeathFade,input.components.EnemyDeathFade);
  assert.ok(analysis.bounds);assert.ok(b.hpBarPosition[1]>analysis.bounds.max[1]);
  for(let axis=0;axis<3;axis++)assert.ok(b.vfxPosition[axis]>=analysis.bounds.min[axis]&&b.vfxPosition[axis]<=analysis.bounds.max[axis]);
  assert.notDeepEqual(b.hpBarPosition,input.hpBarPosition);assert.notDeepEqual(b.vfxPosition,input.vfxPosition);
}
try{
  await mkdir(path.dirname(artifact),{recursive:true});
  const connection=await unity.connect();const ready=await unity.call('ready');assert.equal(ready.ready,true,'Unity must finish integration installation before this live check.');assert.equal(ready.hasErrors,false);
  const catalog=await unity.call('catalog') as Catalog;
  let input=structuredClone(catalog.template);input.name='ConceptSmokeGuardian';input.anchors={hpBar:'auto',vfx:'auto'};input.hpBarPosition=[0,-123,0];input.vfxPosition=[123,-123,123];input.stats.maxHp=9999;input.components.NavMeshAgent.m_Speed=99;
  if(replayId){
    const draft=path.join(connection.projectRoot,'Library','BaekhoEnemyForge','ConceptDrafts',replayId),saved=JSON.parse(await readFile(path.join(draft,'request.json'),'utf8'));
    assert.equal(saved.prompt,prompt,'Only the exact captured smoke prompt may be resumed.');assert.equal(saved.blueprint.name,input.name);assert.deepEqual(saved.blueprint.model,input.model);assert.deepEqual(saved.blueprint.animation,input.animation);
    input=saved.blueprint;savedPlanner=JSON.parse(await readFile(path.join(draft,'response-0.json'),'utf8'));
  }
  const original=structuredClone(input),analysis=await unity.call('analyze_model',{blueprint:input}) as ModelAnalysis;
  const before=await sourceSnapshot(connection.projectRoot);
  const status=await ai.status();assert.equal(status.state,'ready',status.message);
  let result:AiConceptResult|undefined;
  if(!process.argv.includes('--force')&&!replayId){
    const previous=await readFile(artifact,'utf8').then(JSON.parse).catch(()=>null);
    if(previous?.status==='passed'&&previous.projectRoot===connection.projectRoot&&previous.prompt===prompt&&JSON.stringify(previous.input)===JSON.stringify(input))result=previous.result;
  }
  const reused=!!result;result??=await ai.generateConcept({prompt,blueprint:input});
  assert.deepEqual(input,original,'Live service must not mutate the caller blueprint.');verifyResult(result,input,analysis);
  const validation=await unity.call('validate_configuration',{blueprint:result.blueprint});assert.equal(validation.valid,true,JSON.stringify(validation.issues));
  let projectileReuse:unknown;
  if(process.argv.includes('--projectile')&&!replayId){
    const existing=catalog.attacks.find(attack=>attack.generated&&attack.fields.some(field=>field.path==='projectileCount')&&attack.fields.some(field=>field.path==='shotInterval'));
    assert.ok(existing,'A previously registered configurable burst projectile must be available for --projectile.');
    const ranged=structuredClone(input);ranged.name='ConceptSmokeSentinel';
    const rangedPrompt=`연약하지만 시야가 넓은 원거리 감시 포탑을 만들어줘. 최대 체력 140, 공격력 18, 이동속도 0으로 하고 감지거리 20m, 시야 반각 90도, 근접감지는 3m로 해줘. 공격은 카탈로그에 이미 등록된 ${existing.typeId} (${existing.name}) 하나만 재사용해줘. 이 공격은 1초 준비 후 탄환 3발을 0.15초 간격으로 쏘며 속도 8m/s, 수명3초, 피해배율0.3으로 설정해줘. 상태명은 Attack을 사용하고 실행거리8m, 선택거리12m, 최소거리0, 선호거리6m, 가중치1로 해줘. 기존 설정만 바꾸면 충분하므로 새 코드나 새 공격 타입을 만들지 마. 체력바는 모델 머리 위, 피격 효과는 몸통 내부에 맞춰줘. 이름과 모델, 모델 배치, 기존 애니메이션은 유지해줘.`;
    const rangedResult=await ai.generateConcept({prompt:rangedPrompt,blueprint:ranged});
    assert.equal(rangedResult.blueprint.name,ranged.name);assert.deepEqual(rangedResult.blueprint.model,ranged.model);assert.deepEqual(rangedResult.blueprint.animation,ranged.animation);
    assert.equal(rangedResult.blueprint.stats.maxHp,140);assert.equal(rangedResult.blueprint.components.NavMeshAgent.m_Speed,0);assert.equal(rangedResult.blueprint.components.FanVisionSensor._range,20);
    assert.equal(rangedResult.blueprint.attacks.length,1);assert.equal(rangedResult.blueprint.attacks[0].typeId,existing.typeId);assert.equal(rangedResult.blueprint.attacks[0].values.projectileCount,3);assert.equal(rangedResult.blueprint.attacks[0].values.shotInterval,.15);
    assert.ok(rangedResult.attacks.every(attack=>attack.configuredExisting&&attack.files.length===0));
    const rangedValidation=await unity.call('validate_configuration',{blueprint:rangedResult.blueprint});assert.equal(rangedValidation.valid,true,JSON.stringify(rangedValidation.issues));
    projectileReuse={prompt:rangedPrompt,result:rangedResult,validation:rangedValidation};
  }
  const after=await sourceSnapshot(connection.projectRoot);assert.deepEqual(after,before,'Existing attacks must not install or change generated source.');
  const compiler=await unity.call('compiler_info');assert.equal(compiler.hasErrors,false);
  const inference=replayId?{mode:'captured_live_planner_replay',draftId:replayId,realResponseCaptured:true,newInferenceRequested:false,retryBlockedBy:'rate_limit',cleanupRejectionTolerated:true}:{mode:'live',newInferenceRequested:!reused};
  const report={status:'passed',startedAt,finishedAt:new Date().toISOString(),projectRoot:connection.projectRoot,unityVersion:connection.unityVersion,codexVersion:status.version,reused,inference,prompt,input,analysis,result,validation,projectileReuse,generatedSourceCount:Object.keys(after).length,generatedSourcesUnchanged:true,prefabBuilt:false,progress};
  await writeFile(artifact,JSON.stringify(report,null,2),'utf8');process.stdout.write(`Live concept verified: ${result.summary}\nReport: ${artifact}\n`);
}catch(error){
  await mkdir(path.dirname(artifact),{recursive:true});await writeFile(artifact,JSON.stringify({status:'failed',startedAt,finishedAt:new Date().toISOString(),error:error instanceof Error?error.message:String(error),progress},null,2),'utf8');
  process.stderr.write(`${error instanceof Error?error.stack:String(error)}\n`);process.exitCode=1;
}finally{ai.dispose();await unity.dispose();}
