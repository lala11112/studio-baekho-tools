import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {AiService} from '../electron/services/ai';
import {parseConcept} from '../electron/services/ai-concept';
import {emptyBlueprint,defaultBossConfig,defaultBossPhase} from '../src/shared/blueprint';
import type {AttackDefinition,Catalog,ModelAnalysis} from '../src/shared/types';
import type {CodexRpc,RpcObject} from '../electron/services/codex-transport';
import {candidate} from './ai-fixture';

const analysis:ModelAnalysis={bounds:{min:[-1,0,-1],max:[1,2,1],center:[0,1,0],size:[2,2,2]},hpBarPosition:[0,2.2,0],vfxPosition:[0,1,0],warnings:[]};
const definition:AttackDefinition={typeId:'MonsterDefaultAttackSO',name:'기본 공격',category:'normal',description:'근접 타격',previewSupported:true,
  fields:[{path:'animName',label:'상태',type:'string'},{path:'damage',label:'배율',type:'number',min:0},{path:'attackSpeed',label:'속도',type:'number',min:.01},{path:'minimumRange',label:'최소거리',type:'number',min:0},{path:'executeRange',label:'실행거리',type:'number',min:0},{path:'engageRange',label:'선택거리',type:'number',min:0}],
  defaults:{animName:'Attack',damage:1,attackSpeed:1,minimumRange:0,executeRange:2,engageRange:4}};
const configured=()=>({status:'configured_existing',summary:'근접 공격으로 구성했습니다.',name:'',description:'',typeName:'',files:[],defaultsJson:'{}',previewJson:'{"shapes":[]}',previewSupported:false,existingTypeId:definition.typeId,existingValuesJson:'{"damage":1.4}'});
function concept(attacks=[{typeId:definition.typeId,valuesJson:'{"damage":1.6}',prompt:'강한 근접 타격'}]){
  return {summary:'느리고 강인한 근접 몬스터입니다.',reasons:['체력과 공격력을 높이고 이동 속도를 낮췄습니다.'],warnings:[],statsJson:'{"maxHp":500,"baseAtk":40}',componentsJson:'{"NavMeshAgent":{"m_Speed":2},"FanVisionSensor":{"_range":15}}',attacks,hpBarPosition:[0,2.25,0],vfxPosition:[0,1.2,0]};
}
function catalog():Catalog{
  const template=emptyBlueprint();template.stats={maxHp:100,baseAtk:10,combatRange:8,combatExitRange:12};template.components={NavMeshAgent:{m_Speed:4},FanVisionSensor:{_range:20},SphereCollider:{m_Radius:1},EnemyDeathFade:{_delay:1}};
  template.animation.states.Attack={guid:'1'.repeat(32),localId:'1',path:'Assets/attack.anim',name:'Attack'};
  return {projectRoot:'',unityVersion:'6000',assets:[],attacks:[structuredClone(definition)],template,warnings:[],statsFields:[{path:'maxHp',label:'체력',type:'number',min:1},{path:'baseAtk',label:'공격력',type:'number',min:0},{path:'combatRange',label:'진입',type:'number',min:0},{path:'combatExitRange',label:'이탈',type:'number',min:0}],componentFields:{NavMeshAgent:[{path:'m_Speed',label:'속도',type:'number',min:0}],FanVisionSensor:[{path:'_range',label:'감지',type:'number',min:0}]}};
}

test('boss concept preserves stable phase attack references across generated attack IDs',async()=>{
  const f=await fixture();
  try{
    Object.assign(f.current,{kind:'boss',boss:defaultBossConfig()});Object.assign(f.data.template,{kind:'boss',boss:defaultBossConfig()});f.data.boss={immunities:[],items:[]};
    const settings=defaultBossConfig();settings.phases.push(defaultBossPhase(1));settings.phases[1].pattern={mode:'sequence',loop:true,steps:[{kind:'attack',attackId:'attack_1',waitSeconds:0},{kind:'wait',attackId:null,waitSeconds:.4},{kind:'attack',attackId:'attack_2',waitSeconds:0}]};settings.phases[1].shield=120;
    f.rpc.output=(_prompt,turn)=>turn===1?{...concept([{typeId:definition.typeId,valuesJson:'{}',prompt:'베기'},{typeId:'',valuesJson:'{}',prompt:'새로운 돌진'}]),bossJson:JSON.stringify(settings)}:configured();
    const original=structuredClone(f.current),result=await f.service.generateConcept({prompt:'2페이즈 보스',blueprint:f.current});
    assert.deepEqual(f.current,original);assert.equal(result.blueprint.kind,'boss');assert.deepEqual(result.blueprint.attacks.map(a=>a.id),['attack_1','attack_2']);assert.equal(result.blueprint.boss!.phases[1].pattern.steps[2].attackId,'attack_2');assert.equal(result.blueprint.boss!.phases[1].shield,120);
    assert.ok(f.rpc.calls.some(c=>c.method==='turn/start'&&String((c.params.input as any[])[0].text).includes('BOSS CONTRACT')));
  }finally{await f.close();}
});
test('boss concept rejects invented music, missing phase attacks and unknown combat settings before generation',async()=>{
  const f=await fixture();Object.assign(f.current,{kind:'boss',boss:defaultBossConfig()});Object.assign(f.data.template,{kind:'boss',boss:defaultBossConfig()});
  try{
    const settings=defaultBossConfig();settings.phases[0].pattern={mode:'sequence',loop:true,steps:[{kind:'attack',attackId:'missing',waitSeconds:0}]};
    assert.throws(()=>parseConcept({...concept(),bossJson:JSON.stringify(settings)},f.current,f.data,analysis),/유효한 공격/);
    settings.phases[0].pattern.steps[0].attackId='attack_1';settings.phases[0].music={mode:'play',clip:{guid:'f'.repeat(32),localId:'8300000',path:'Assets/invented.wav',name:'invented'},volume:1,fadeSeconds:.5};
    assert.throws(()=>parseConcept({...concept(),bossJson:JSON.stringify(settings)},f.current,f.data,analysis),/없는 BGM/);
    assert.throws(()=>parseConcept({...concept(),bossJson:'{"teleport":true}'},f.current,f.data,analysis),/허용되지 않은 보스/);
    assert.equal(f.compiles(),0);
  }finally{await f.close();}
});
class Rpc implements CodexRpc{
  notifications=new Set<(m:string,p:RpcObject)=>void>();closes=new Set<()=>void>();calls:{method:string;params:RpcObject}[]=[];turns=0;threads=0;deferAt=0;rejectUnload=false;
  output:(prompt:string,turn:number)=>unknown=()=>concept();
  async request(method:string,params:RpcObject):Promise<RpcObject>{
    this.calls.push({method,params});
    if(method==='config/read')return {config:{mcp_servers:{Unity:{enabled:true}}}};
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='model/list')return {data:[]};
    if(method==='thread/start')return {thread:{id:`thread${++this.threads}`}};
    if(method==='thread/unload'&&this.rejectUnload)throw new Error('CLI cannot unload this ephemeral thread.');
    if(method==='turn/start'){
      const turn=++this.turns,id=`turn${turn}`,threadId=params.threadId;
      const prompt=String((params.input as any[])[0].text);
      if(this.deferAt!==turn)setImmediate(()=>{for(const notify of this.notifications)notify('turn/completed',{threadId,turn:{id,status:'completed',items:[{id:`item${turn}`,type:'agentMessage',phase:'final_answer',text:JSON.stringify(this.output(prompt,turn))}]}});});
      return {turn:{id}};
    }
    return {};
  }
  onNotification(listener:(m:string,p:RpcObject)=>void){this.notifications.add(listener);return()=>{this.notifications.delete(listener);};}
  onClose(listener:()=>void){this.closes.add(listener);return()=>{this.closes.delete(listener);};}
  close(){for(const fn of this.closes)fn();this.closes.clear();}
}
async function fixture(options:{registrationError?:string;configurationFailures?:number;configurationTransportError?:string}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'enemy-concept-'));const folder=path.join(root,'Assets','_Project','Scripts','Enemy');await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'EnemyAction.cs'),'public abstract class EnemyAction {}');await writeFile(path.join(folder,'MonsterSkillData.cs'),'public abstract class MonsterSkillData {}');
  const data=catalog();data.projectRoot=root;
  const current=structuredClone(data.template);current.name='MyMonster';current.modelTransform.scale=[2,2,2];current.stats.maxHp=9999;current.components.NavMeshAgent.m_Speed=30;current.components.SphereCollider.m_Radius=7;current.components.EnemyDeathFade._delay=10;current.hpBarPosition=[3,8,4];current.vfxPosition=[2,3,4];current.anchors={hpBar:'manual',vfx:'manual'};
  const rpc=new Rpc();const actions:string[]=[];let compiles=0;
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},discover:async()=>({executable:'mock',version:'test'}),connect:async()=>rpc,compile:async()=>{compiles++;},unity:async(action,payload)=>{
    actions.push(action);
    if(action==='catalog')return structuredClone(data);
    if(action==='analyze_model')return structuredClone(analysis);
    if(action==='compiler_info')return {hasErrors:false,languageVersion:'9.0'};
    if(action==='validate_configuration'){
      if(options.configurationTransportError)throw new Error(options.configurationTransportError);
      if(options.configurationFailures){options.configurationFailures--;return {valid:false,issues:[{severity:'error',path:'attack',message:'타격 구간이 전체 시간 안에 있어야 합니다.'}]};}
      return {valid:true,issues:[]};
    }
    if(action==='validate')return {valid:true,issues:[]};
    if(action==='validate_attack'){
      if(options.registrationError)throw new Error(options.registrationError);
      const typeId=String(payload?.typeId);if(!data.attacks.some(item=>item.typeId===typeId))data.attacks.push({...structuredClone(definition),typeId,generated:true,defaults:{...definition.defaults,animName:'Attack_Test'}});
      return {valid:true};
    }
    return {ready:true,hasErrors:false};
  }});
  return {root,folder,data,current,rpc,service,actions,compiles:()=>compiles,close:async()=>{service.dispose();await rm(root,{recursive:true,force:true});}};
}

test('concept rebuilds supported settings while preserving identity, model, animation and manual geometry',async()=>{
  const f=await fixture();const original=structuredClone(f.current);
  try{
    const result=await f.service.generateConcept({prompt:'느리고 튼튼한 몬스터',blueprint:f.current});
    assert.deepEqual(f.current,original);assert.equal(result.blueprint.name,'MyMonster');assert.deepEqual(result.blueprint.modelTransform,original.modelTransform);assert.deepEqual(result.blueprint.animation,original.animation);
    assert.equal(result.blueprint.stats.maxHp,500);assert.equal(result.blueprint.stats.combatRange,8);assert.equal(result.blueprint.components.NavMeshAgent.m_Speed,2);assert.equal(result.blueprint.components.FanVisionSensor._range,15);
    assert.equal(result.blueprint.components.SphereCollider.m_Radius,7);assert.equal(result.blueprint.components.EnemyDeathFade._delay,10);assert.deepEqual(result.blueprint.hpBarPosition,[3,8,4]);assert.deepEqual(result.blueprint.vfxPosition,[2,3,4]);
    assert.equal(result.blueprint.attacks[0].values.damage,1.6);assert.equal(result.attacks[0].configuredExisting,true);assert.equal(f.compiles(),0);assert.equal(f.rpc.turns,1);assert.ok(f.actions.includes('validate_configuration'));
    const start=f.rpc.calls.find(call=>call.method==='thread/start')!.params;assert.equal(start.sandbox,'read-only');assert.equal(start.approvalPolicy,'never');assert.equal(start.model,undefined);assert.deepEqual((start.config as any).mcp_servers,{Unity:{enabled:false}});
  }finally{await f.close();}
});
test('concept uses natural-language attack pipeline when analysis has no normal attack',async()=>{
  const f=await fixture();f.rpc.output=(_prompt,turn)=>turn===1?concept([]):configured();
  try{
    const result=await f.service.generateConcept({prompt:'공격이 없는 야수의 주력 공격도 만들어줘',blueprint:f.current});
    assert.equal(f.rpc.turns,2);assert.equal(result.blueprint.attacks.length,1);assert.equal(result.blueprint.attacks[0].values.damage,1.4);assert.match(result.warnings.join('\n'),/일반 공격이 없어/);assert.equal(f.compiles(),0);
  }finally{await f.close();}
});
test('ephemeral thread cleanup rejection cannot discard a successful concept or repeat inference',async()=>{
  const f=await fixture();f.rpc.rejectUnload=true;
  try{
    const result=await f.service.generateConcept({prompt:'기존 공격 수호자',blueprint:f.current});assert.equal(result.blueprint.stats.maxHp,500);assert.equal(result.attacks.length,1);assert.equal(f.rpc.turns,1);
    const cleanup=f.rpc.calls.filter(call=>call.method==='thread/unload');assert.equal(cleanup.length,1);assert.equal(f.actions.at(-1),'validate_configuration');
  }finally{await f.close();}
});
test('missing catalog capability generates and registers additive attack before applying complete concept',async()=>{
  const f=await fixture();f.rpc.output=(prompt,turn)=>turn===1?concept([{typeId:'',valuesJson:'{}',prompt:'표적을 향해 새로운 탄환을 발사해줘'}]):candidate(prompt.match(/namespace (Baekho\.Generated\.a[0-9a-f]{32})/)![1]);
  try{
    const result=await f.service.generateConcept({prompt:'원거리 탄환 야수',blueprint:f.current});
    assert.equal(f.compiles(),1);assert.equal(f.rpc.turns,2);assert.match(result.blueprint.attacks[0].typeId,/^Baekho\.Generated\./);assert.equal(result.blueprint.animation.states.Attack_Test,null);assert.match(result.warnings.join('\n'),/Attack_Test/);
    const journal=JSON.parse(await readFile(path.join(f.root,'Library','BaekhoEnemyForge','CodeDrafts',result.attacks[0].attackId,'journal.json'),'utf8'));assert.equal(journal.state,'completed');
  }finally{await f.close();}
});
test('concept validates AI data before attack generation and shares two design repair attempts',async()=>{
  const f=await fixture();f.rpc.output=()=>({...concept(),statsJson:'{"unknownStat":12}'});
  try{
    await assert.rejects(f.service.generateConcept({prompt:'잘못된 능력치',blueprint:f.current}),/검증을 통과하지 못/);assert.equal(f.rpc.turns,3);assert.equal(f.compiles(),0);assert.deepEqual(await readdir(f.folder),['EnemyAction.cs','MonsterSkillData.cs']);
  }finally{await f.close();}
});
test('Unity semantic rejection repairs concept before installing attack code',async()=>{
  const f=await fixture({configurationFailures:1});
  try{
    const result=await f.service.generateConcept({prompt:'타격 시간이 유효한 수호자',blueprint:f.current});assert.equal(result.attacks.length,1);assert.equal(f.rpc.turns,2);assert.equal(f.compiles(),0);
    assert.match(String((f.rpc.calls.filter(call=>call.method==='turn/start')[1].params.input as any[])[0].text),/타격 구간/);
  }finally{await f.close();}
});
test('ambiguous semantic validation transport failure never requests another concept inference',async()=>{
  const f=await fixture({configurationTransportError:'MCP connection closed'});
  try{
    await assert.rejects(f.service.generateConcept({prompt:'수호자',blueprint:f.current}),/MCP connection/);assert.equal(f.rpc.turns,1);assert.equal(f.compiles(),0);assert.deepEqual(await readdir(f.folder),['EnemyAction.cs','MonsterSkillData.cs']);
  }finally{await f.close();}
});
test('automatic anchor proposals are checked against model bounds and manual anchors remain exact',()=>{
  const c=catalog(),current=structuredClone(c.template);current.anchors={hpBar:'auto',vfx:'manual'};current.vfxPosition=[8,9,10];
  const plan=parseConcept({...concept(),hpBarPosition:[0,-20,0],vfxPosition:[0,1,0]},current,c,analysis);
  assert.deepEqual(plan.blueprint.hpBarPosition,analysis.hpBarPosition);assert.deepEqual(plan.blueprint.vfxPosition,[8,9,10]);assert.match(plan.warnings.join('\n'),/모델 범위를 벗어나/);
  const valid=parseConcept(concept(),current,c,analysis);assert.deepEqual(valid.blueprint.hpBarPosition,[0,2.25,0]);
  current.anchors.vfx='auto';
  const lateral=parseConcept({...concept(),vfxPosition:[1.2,1,0]},current,c,analysis);assert.deepEqual(lateral.blueprint.vfxPosition,analysis.vfxPosition);assert.match(lateral.warnings.join('\n'),/피격 효과/);
  delete current.anchors;current.hpBarPosition=[5,6,7];assert.deepEqual(parseConcept(concept(),current,c,analysis).blueprint.hpBarPosition,[5,6,7]);
});
test('invalid range and unknown attack fields are rejected before concept side effects',()=>{
  const c=catalog();
  assert.throws(()=>parseConcept({...concept(),statsJson:'{"combatRange":20,"combatExitRange":10}'},c.template,c,analysis),/이탈 거리/);
  assert.throws(()=>parseConcept(concept([{typeId:definition.typeId,valuesJson:'{"executeRange":10}',prompt:'사거리 오류'}]),c.template,c,analysis),/최소거리/);
  assert.throws(()=>parseConcept(concept([{typeId:definition.typeId,valuesJson:'{"invented":3}',prompt:'없는 필드'}]),c.template,c,analysis),/허용되지 않은/);
});
test('later attack failure preserves original blueprint and keeps prior validated attack reusable',async()=>{
  const f=await fixture(),original=structuredClone(f.current);f.rpc.output=(prompt,turn)=>turn===1?concept([{typeId:'',valuesJson:'{}',prompt:'새 공격 하나'},{typeId:'',valuesJson:'{}',prompt:'핵심 변경 공격'}]):turn===2?candidate(prompt.match(/namespace (Baekho\.Generated\.a[0-9a-f]{32})/)![1]):{status:'needs_core_changes',summary:'핵심 FSM 변경이 필요합니다.'};
  try{
    await assert.rejects(f.service.generateConcept({prompt:'여러 공격',blueprint:f.current}),/이미 등록한 공격 1개/);assert.deepEqual(f.current,original);assert.equal(f.rpc.turns,3);assert.equal(f.compiles(),1);
    const ids=await readdir(path.join(f.folder,'Generated'));assert.equal(ids.length,1);
  }finally{await f.close();}
});
test('cancelling a child attack cancels the entire concept and preserves original blueprint',async()=>{
  const f=await fixture(),original=structuredClone(f.current);f.rpc.output=()=>concept([{typeId:'',valuesJson:'{}',prompt:'오래 걸리는 새 공격'}]);f.rpc.deferAt=2;
  try{
    const running=f.service.generateConcept({prompt:'새로운 몬스터',blueprint:f.current});while(f.rpc.turns<2)await new Promise(resolve=>setTimeout(resolve,5));f.service.cancel();
    await assert.rejects(running,/취소|연결/);assert.deepEqual(f.current,original);assert.equal(f.compiles(),0);assert.deepEqual(await readdir(f.folder),['EnemyAction.cs','MonsterSkillData.cs']);
  }finally{await f.close();}
});
test('ambiguous child registration preserves recovery journal without replaying concept or attack inference',async()=>{
  const f=await fixture({registrationError:'MCP connection closed'}),original=structuredClone(f.current);
  f.rpc.output=(prompt,turn)=>turn===1?concept([{typeId:'',valuesJson:'{}',prompt:'새 공격 구현'}]):candidate(prompt.match(/namespace (Baekho\.Generated\.a[0-9a-f]{32})/)![1]);
  try{
    await assert.rejects(f.service.generateConcept({prompt:'새 공격이 필요한 야수',blueprint:f.current}),/복구 기록/);assert.deepEqual(f.current,original);assert.equal(f.rpc.turns,2);assert.equal(f.compiles(),1);
    const [id]=await readdir(path.join(f.folder,'Generated'));assert.ok(id);
    const journal=JSON.parse(await readFile(path.join(f.root,'Library','BaekhoEnemyForge','CodeDrafts',id,'journal.json'),'utf8'));assert.equal(journal.state,'recovery_required');
  }finally{await f.close();}
});
