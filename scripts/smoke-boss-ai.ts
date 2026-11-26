import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AiService} from '../electron/services/ai';
import {UnityService} from '../electron/services/unity';
import {CodexTransport,type CodexRpc,type RpcObject} from '../electron/services/codex-transport';
import {bossIssues,validateBlueprint} from '../src/shared/blueprint';
import type {AiConceptResult,AiProgress,AssetRef,Catalog,EnemyBlueprint,ModelAnalysis} from '../src/shared/types';

// One real planner turn, existing attacks only. This check cannot build a prefab or publish code.
// A verified result may be reused; --force explicitly requests another real inference.
const artifact=path.resolve('artifacts/boss-ai-integration.json');
const unity=new UnityService();
const progress:AiProgress[]=[];
const startedAt=new Date().toISOString();
const report:Record<string,unknown>={status:'running',startedAt,prefabBuilt:false};
let plannerTurns=0;
let replayedTurns=0;
const replayIndex=process.argv.indexOf('--replay-planner');
const replayId=replayIndex<0?'':process.argv[replayIndex+1];
if(replayIndex>=0&&!/^a[0-9a-f]{32}$/.test(replayId??''))throw new Error('--replay-planner requires an existing captured boss concept draft ID.');
let capturedResponse:unknown;

class SinglePlannerRpc implements CodexRpc {
  private threads=0;
  constructor(private readonly actual:CodexRpc) {}
  request(method:string,params:RpcObject):Promise<RpcObject> {
    if(method==='thread/start'&&++this.threads>1)throw new Error('Boss smoke permits one planner thread and no attack-code inference.');
    if(method==='turn/start') {
      if(plannerTurns>=1)throw new Error('Boss smoke permits one real planner turn; automatic additional inference is blocked.');
      plannerTurns++;
    }
    return this.actual.request(method,params);
  }
  onNotification(listener:(method:string,params:RpcObject)=>void){return this.actual.onNotification(listener);}
  onClose(listener:()=>void){return this.actual.onClose(listener);}
  close(){this.actual.close();}
}

/** Explicit recovery using an unmodified captured real response. No turn reaches the model. */
class CapturedPlannerRpc implements CodexRpc {
  private readonly listeners=new Set<(method:string,params:RpcObject)=>void>();
  constructor(private readonly actual:CodexRpc) {}
  request(method:string,params:RpcObject):Promise<RpcObject> {
    if(method==='thread/start')return Promise.resolve({thread:{id:'captured-live-boss-planner'}});
    if(method==='turn/start') {
      if(params.threadId!=='captured-live-boss-planner'||replayedTurns++>0||!capturedResponse)
        throw new Error('Captured boss replay refuses additional inference or a missing captured response.');
      setImmediate(()=>{
        for(const listener of this.listeners)listener('turn/completed',{threadId:'captured-live-boss-planner',turn:{
          id:'captured-boss-turn',status:'completed',items:[{id:'captured-boss-message',type:'agentMessage',phase:'final_answer',text:JSON.stringify(capturedResponse)}]
        }});
      });
      return Promise.resolve({turn:{id:'captured-boss-turn'}});
    }
    if(method==='thread/unload'&&params.threadId==='captured-live-boss-planner')return Promise.resolve({});
    return this.actual.request(method,params);
  }
  onNotification(listener:(method:string,params:RpcObject)=>void){this.listeners.add(listener);const stop=this.actual.onNotification(listener);return()=>{this.listeners.delete(listener);stop();};}
  onClose(listener:()=>void){return this.actual.onClose(listener);}
  close(){this.actual.close();}
}

const readActions=new Set(['catalog','analyze_model','validate_configuration','compiler_info','ready']);
const ai=new AiService({
  dataDirectory:path.resolve('artifacts/boss-ai-data'),getProjectRoot:()=>unity.root,
  unity:(action,payload)=>{
    if(!readActions.has(action))throw new Error(`Boss smoke refuses Unity mutation: ${action}`);
    return unity.call(action,payload);
  },
  connect:async(runtime,directory)=>{
    const actual=new CodexTransport(runtime.executable,directory);
    await actual.initialize();return replayId?new CapturedPlannerRpc(actual):new SinglePlannerRpc(actual);
  },
  compile:async()=>{throw new Error('Boss smoke refuses new attack source compilation.');},
  onProgress:value=>{progress.push(value);process.stdout.write(`[${value.stage}] ${value.message}\n`);}
});

async function generatedSnapshot(root:string):Promise<Record<string,string>> {
  const hashes:Record<string,string>={};
  async function scan(folder:string):Promise<void> {
    for(const entry of await readdir(folder,{withFileTypes:true}).catch(()=>[])) {
      if(entry.isSymbolicLink())continue;
      const target=path.join(folder,entry.name);
      if(entry.isDirectory())await scan(target);
      else if(entry.isFile())hashes[path.relative(root,target).replace(/\\/g,'/')]=createHash('sha256').update(await readFile(target)).digest('hex');
    }
  }
  for(const relative of ['Assets/_Project/Scripts/Enemy/Generated','Assets/_Project/Generated/Enemies','Assets/_Project/Generated/Bosses'])await scan(path.join(root,relative));
  return Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b)));
}

async function rejectPendingInstalls(root:string):Promise<void> {
  const folder=path.join(root,'Library/BaekhoEnemyForge/CodeDrafts');
  for(const entry of await readdir(folder,{withFileTypes:true}).catch(()=>[])) {
    if(!entry.isDirectory()||entry.isSymbolicLink()||!/^a[0-9a-f]{32}$/.test(entry.name))continue;
    const journal=await readFile(path.join(folder,entry.name,'journal.json'),'utf8').then(JSON.parse).catch(()=>null);
    assert.ok(!journal||journal.version!==1||path.resolve(journal.projectRoot)!==path.resolve(root)
      ||['completed','rolled_back'].includes(journal.state),`Resolve pending attack installation before read-only smoke: ${entry.name}`);
  }
}

const sameAsset=(a:AssetRef,b:AssetRef)=>a.guid===b.guid&&a.localId===b.localId;
function verifyDefaultReferences(catalog:Catalog):number {
  const keys=new Set(catalog.assets.map(a=>`${a.guid}:${a.localId}`));
  assert.equal(keys.size,catalog.assets.length,'Catalog asset references must be unique.');
  let references=0;
  function visit(value:unknown):void {
    if(!value||typeof value!=='object')return;
    const object=value as Record<string,unknown>;
    if(typeof object.guid==='string'&&typeof object.localId==='string') {
      assert.ok(keys.has(`${object.guid}:${object.localId}`),`Existing default reference is absent from catalog assets: ${object.path}`);
      references++;return;
    }
    for(const child of Object.values(object))visit(child);
  }
  visit(catalog.template);visit(catalog.attacks.map(a=>a.defaults));
  return references;
}
function verifyResult(result:AiConceptResult,input:EnemyBlueprint,item:AssetRef,fire:number,analysis:ModelAnalysis):void {
  const b=result.blueprint;validateBlueprint(b);
  assert.equal(b.kind,'boss');assert.equal(b.version,3);assert.ok(b.boss);
  assert.equal(b.name,input.name);assert.deepEqual(b.model,input.model);assert.deepEqual(b.template,input.template);
  assert.deepEqual(b.modelTransform,input.modelTransform);assert.deepEqual(b.animation,input.animation);
  assert.equal(b.stats.maxHp,3000);assert.equal(b.stats.baseAtk,150);assert.equal(b.stats.baseDef,50);
  assert.equal(b.selfDestruct,null);assert.equal(b.attacks.length,2);
  assert.deepEqual(b.attacks.map(a=>a.typeId),['MonsterDefaultAttackSO','MonsterDashAttackSO']);
  assert.equal(new Set(b.attacks.map(a=>a.id)).size,2);
  assert.equal(result.attacks.length,2);
  assert.ok(result.attacks.every(a=>a.configuredExisting===true&&a.files.length===0),'Only existing attacks may be configured.');
  assert.equal(b.boss.enableWeakness,true);assert.equal(b.boss.weaknessElement,fire);assert.equal(b.boss.weakDamageMult,1.5);
  assert.equal(b.boss.enableResistance,false);assert.deepEqual(b.boss.statusImmunityList,['Silence']);
  assert.equal(b.boss.initialShield,0);assert.equal(b.boss.reward.gold,75);
  assert.equal(b.boss.reward.items.length,1);assert.ok(sameAsset(b.boss.reward.items[0],item));
  assert.deepEqual(b.boss.phases.map(p=>p.phaseMaxHp),[1500,1500]);
  const [first,second]=b.boss.phases;
  assert.equal(first.atkMultiplier,1);assert.equal(first.defMultiplier,1);assert.equal(first.shield,null);
  assert.equal(second.atkMultiplier,1.5);assert.equal(second.defMultiplier,1.2);assert.equal(second.shield,100);
  const ids=new Set(b.attacks.map(a=>a.id));
  for(const phase of b.boss.phases) {
    assert.equal(phase.music.mode,'keep');assert.equal(phase.music.clip,null);
    assert.equal(phase.pattern.mode,'sequence');assert.equal(phase.pattern.loop,true);
    assert.deepEqual(phase.pattern.steps.map(s=>s.kind),['attack','wait','attack']);
    assert.equal(phase.pattern.steps[0].attackId,b.attacks[0].id);
    assert.equal(phase.pattern.steps[1].attackId,null);assert.equal(phase.pattern.steps[1].waitSeconds,.4);
    assert.equal(phase.pattern.steps[2].attackId,b.attacks[1].id);
    if(phase.skillIds!==null)for(const id of phase.skillIds)assert.ok(ids.has(id),`Unknown phase skill: ${id}`);
    for(const step of phase.pattern.steps)if(step.kind==='attack')assert.ok(ids.has(step.attackId!),`Unknown sequence attack: ${step.attackId}`);
  }
  assert.deepEqual(bossIssues(b),[],'Phase references and boss settings must be coherent.');
  assert.deepEqual(b.components.SphereCollider,input.components.SphereCollider);
  assert.deepEqual(b.components.EnemyDeathFade,input.components.EnemyDeathFade);
  assert.ok(analysis.bounds);assert.ok(b.hpBarPosition[1]>analysis.bounds.max[1]);
  for(let axis=0;axis<3;axis++)assert.ok(b.vfxPosition[axis]>=analysis.bounds.min[axis]&&b.vfxPosition[axis]<=analysis.bounds.max[axis]);
}

try {
  await mkdir(path.dirname(artifact),{recursive:true});
  const connection=await unity.connect();report.connection=connection;
  const expectedRoot=path.resolve(process.argv.find(a=>a.startsWith('--expected-root='))?.slice('--expected-root='.length)
    ??path.join('..','Four-Tiger-Sword','Four-Tiger-Sword'));
  assert.equal(path.resolve(connection.projectRoot).toLowerCase(),expectedRoot.toLowerCase(),'Unexpected Unity project.');
  const ready=await unity.call('ready');assert.equal(ready.ready,true,'Unity must be in stable Edit Mode.');assert.equal(ready.hasErrors,false);
  await rejectPendingInstalls(connection.projectRoot);
  const catalog=await unity.call('catalog',{kind:'boss'}) as Catalog;
  assert.equal(catalog.kind,'boss');assert.equal(catalog.template.kind,'boss');assert.ok(catalog.boss?.items.length,'A real catalog reward item is required.');
  report.defaultAssetReferencesChecked=verifyDefaultReferences(catalog);
  for(const type of ['MonsterDefaultAttackSO','MonsterDashAttackSO'])assert.ok(catalog.attacks.some(a=>a.typeId===type&&a.category==='normal'));
  const item=catalog.boss.items[0];
  const fire=catalog.statsFields.find(f=>f.path==='elementType')?.options?.find(o=>o.label==='ELEMENT_FIRE')?.value;
  assert.equal(typeof fire,'number','Fire enum must come from the real Unity schema.');
  let input=structuredClone(catalog.template);input.name='BossAiSmokeGuardian';
  input.animation.states.Attack??=null;
  input.anchors={hpBar:'auto',vfx:'auto'};input.hpBarPosition=[0,-123,0];input.vfxPosition=[123,-123,123];
  input.stats.maxHp=9999;input.stats.baseAtk=999;input.stats.baseDef=999;
  let original=structuredClone(input);
  const prompt=`현재 보스 제작 기능으로 2페이즈 보스를 설정해줘. 최대 체력 3000, 기본 공격력 150, 기본 방어력 50. 공격은 정확히 두 개이며 첫 번째는 기존 MonsterDefaultAttackSO 단타, 두 번째는 기존 MonsterDashAttackSO 돌진만 재사용해. 둘 다 상태명 Attack, 공격속도 1, 최소거리 0, 실행거리 2, 선택거리 6, 가중치 1로 하고 나머지는 유효한 기본값을 유지해. 새 공격 코드/새 패턴 코드/새 타입을 만들지 마. 첫 페이즈 HP1500, 공격력/방어력 배율1, 보호막 유지(null). 둘째 페이즈 HP1500, 공격력 배율1.5, 방어력 배율1.2, 진입 보호막100으로 교체. 두 페이즈 모두 첫 번째 단타→0.4초 대기→두 번째 돌진 순서로 반복하며 두 공격을 스킬셋에 포함해. 각 공격 참조는 요청 목록 순서인 attack_1/attack_2를 사용해. 시작 보호막0, 화속성(ELEMENT_FIRE, enum ${fire}) 약점1.5배를 사용하고 저항은 끄며 상태이상 면역은 Silence 하나만. 보상은 기존 보스 기본 골드를 대체하는 75골드와 다음 실제 아이템 하나를 확정 즉시 지급해: ${JSON.stringify(item)}. 두 페이즈 음악은 keep이고 클립은 null. 이름·템플릿·모델·모델배치·애니메이션 매핑은 그대로 유지해. 체력바는 모델 위, 피격효과는 몸통 내부에 자동 배치해.`;
  if(replayId) {
    const draft=path.join(connection.projectRoot,'Library/BaekhoEnemyForge/ConceptDrafts',replayId);
    const request=JSON.parse(await readFile(path.join(draft,'request.json'),'utf8'));
    assert.equal(request.prompt,prompt,'Replay is restricted to the exact captured boss smoke prompt.');
    // The Unity catalog assigns fresh IDs to imported baseline attacks on each read.
    const comparable=(b:EnemyBlueprint)=>({...b,attacks:b.attacks.map(({id,...attack})=>attack)});
    assert.deepEqual(comparable(request.blueprint),comparable(input),'Replay requires unchanged original settings and content.');
    input=request.blueprint;original=structuredClone(input);
    const raw=await readFile(path.join(draft,'response-0.json'),'utf8');capturedResponse=JSON.parse(raw);
    report.capturedLiveResponse={draftId:replayId,sha256:createHash('sha256').update(raw).digest('hex'),originalInferenceCount:1};
  }
  Object.assign(report,{projectRoot:connection.projectRoot,prompt,input,requestedItem:item,fireElement:fire});
  const analysis=await unity.call('analyze_model',{blueprint:input}) as ModelAnalysis;report.analysis=analysis;
  const before=await generatedSnapshot(connection.projectRoot);
  const status=await ai.status();assert.equal(status.state,'ready',status.message);report.codexVersion=status.version;
  let result:AiConceptResult|undefined;
  if(!process.argv.includes('--force')&&!replayId) {
    const previous=await readFile(artifact,'utf8').then(JSON.parse).catch(()=>null);
    if(previous?.status==='passed'&&previous.projectRoot===connection.projectRoot&&previous.prompt===prompt
      &&JSON.stringify(previous.input)===JSON.stringify(input))result=previous.result;
  }
  const reused=!!result;report.reused=reused;
  result??=await ai.generateConcept({prompt,blueprint:input});report.result=result;
  assert.deepEqual(input,original,'Live AI service mutated its caller blueprint.');
  verifyResult(result,input,item,fire!,analysis);
  assert.equal(plannerTurns,reused||replayId?0:1,'The check must use exactly one live planner turn unless replaying or reusing a verified result.');
  if(replayId)assert.equal(replayedTurns,1,'Captured response must be replayed exactly once.');
  const validation=await unity.call('validate_configuration',{blueprint:result.blueprint});report.validation=validation;
  assert.equal(validation.valid,true,JSON.stringify(validation.issues));
  const after=await generatedSnapshot(connection.projectRoot);
  assert.deepEqual(after,before,'Boss concept must not create/change attack source or generated prefabs/assets.');
  const compiler=await unity.call('compiler_info');assert.equal(compiler.hasErrors,false);
  Object.assign(report,{status:'passed',inputPreserved:true,attackReferencesValid:true,generatedAssetsUnchanged:true,
    generatedFileCount:Object.keys(after).length,inference:{mode:replayId?'captured_live_planner_replay':'live',plannerTurns,replayedTurns,newInferenceRequested:!reused&&!replayId}});
  process.stdout.write(`Boss concept verified (${replayId?'captured live response replay':reused?'verified result reuse':'one live planner turn'}): ${result.summary}\nReport: ${artifact}\n`);
} catch(error) {
  Object.assign(report,{status:'failed',error:error instanceof Error?error.message:String(error)});
  process.stderr.write(`${error instanceof Error?error.stack:String(error)}\n`);process.exitCode=1;
} finally {
  Object.assign(report,{finishedAt:new Date().toISOString(),plannerTurns,progress});
  await mkdir(path.dirname(artifact),{recursive:true});await writeFile(artifact,JSON.stringify(report,null,2),'utf8');
  ai.dispose();await unity.dispose();
}
