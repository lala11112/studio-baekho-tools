import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiService } from '../electron/services/ai';
import type { CodexRpc, RpcObject } from '../electron/services/codex-transport';
import type { AttackDefinition, EnemyBlueprint } from '../src/shared/types';
import {emptyBlueprint} from '../src/shared/blueprint';
import { candidate } from './ai-fixture';
import { installCandidate, parseGeneratedAttack, writeJournal } from '../electron/services/ai-code';

class MockCodex implements CodexRpc{
  notifications=new Set<(m:string,p:RpcObject)=>void>();closes=new Set<()=>void>();calls:{method:string;params:RpcObject}[]=[];turns=0;namespace='';defer=false;
  output:(namespace:string,turn:number)=>unknown=(namespace)=>candidate(namespace);
  async request(method:string,params:RpcObject):Promise<RpcObject>{
    this.calls.push({method,params});
    if(method==='config/read')return {config:{mcp_servers:{Unity:{url:'http://localhost'},unrelated:{command:'ignored'}}}};
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='model/list')return {data:[{model:'configured-model',displayName:'기본 모델'}]};
    if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start'){
      const text=String((params.input as any[])[0].text);const namespace=text.match(/namespace (Baekho\.Generated\.a[0-9a-f]{32})/)?.[1];if(namespace)this.namespace=namespace;
      const id=`turn${++this.turns}`;
      if(!this.defer)setImmediate(()=>{for(const fn of this.notifications)fn('turn/completed',{threadId:'thread',turn:{id,status:'completed',items:[{id:`item${id}`,type:'agentMessage',phase:'final_answer',text:JSON.stringify(this.output(this.namespace,this.turns))}]}});});
      return {turn:{id}};
    }
    return {};
  }
  onNotification(listener:(m:string,p:RpcObject)=>void){this.notifications.add(listener);return()=>{this.notifications.delete(listener);};}
  onClose(listener:()=>void){this.closes.add(listener);return()=>{this.closes.delete(listener);};}
  close(){for(const fn of this.closes)fn();this.closes.clear();}
}
const blueprint={} as EnemyBlueprint;
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'enemy-ai-service-'));
  await mkdir(path.join(root,'Assets','_Project','Scripts','Enemy'),{recursive:true});
  await writeFile(path.join(root,'Assets','_Project','Scripts','Enemy','EnemyAction.cs'),'public abstract class EnemyAction {}');
  await writeFile(path.join(root,'Assets','_Project','Scripts','Enemy','MonsterSkillData.cs'),'public abstract class MonsterSkillData {}');
  return root;
}
function existingCatalog(){
  const definition:AttackDefinition={typeId:'MonsterDefaultAttackSO',name:'기본 공격',category:'normal',description:'단타',previewSupported:true,fields:[{path:'animName',label:'State',type:'string'},{path:'damage',label:'Damage',type:'number',min:0},{path:'attackSpeed',label:'Speed',type:'number',min:.01}],defaults:{animName:'Attack',damage:.5,attackSpeed:1}};
  const template=emptyBlueprint();template.animation.states.Attack={guid:'1'.repeat(32),localId:'1',path:'Assets/attack.anim',name:'Attack'};
  return {attacks:[definition],assets:[],template};
}
const configured=(values:unknown,type='MonsterDefaultAttackSO')=>({status:'configured_existing',summary:'기존 단타 설정으로 구성했습니다.',name:'',description:'',typeName:'',files:[],defaultsJson:'{}',previewJson:'{"shapes":[]}',previewSupported:false,existingTypeId:type,existingValuesJson:JSON.stringify(values)});
test('existing attack settings are validated and returned without compiling or installing new code',async()=>{
  const root=await fixture();const rpc=new MockCodex();rpc.output=()=>configured({damage:.7});let compiles=0,refreshes=0;const validations:any[]=[];
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},discover:async()=>({executable:'fake',version:'test'}),connect:async()=>rpc,compile:async()=>{compiles++;},unity:async(action,payload)=>{
    if(action==='compiler_info')return {hasErrors:false,languageVersion:'9.0'};if(action==='catalog')return existingCatalog();if(action==='validate'){validations.push(payload?.blueprint);return {valid:true,issues:[]};}if(action==='refresh')refreshes++;return {ready:true,hasErrors:false};
  }});
  try{
    const result=await service.generate({prompt:'단타 피해 배율을 0.7로',blueprint});
    assert.equal(result.configuredExisting,true);assert.deepEqual(result.existingValues,{animName:'Attack',damage:.7,attackSpeed:1});assert.deepEqual(result.files,[]);assert.equal(compiles,0);assert.equal(refreshes,0);assert.equal(rpc.turns,1);assert.equal(validations[0].attacks[0].values.damage,.7);
    assert.deepEqual(await readdir(path.join(root,'Assets','_Project','Scripts','Enemy')),['EnemyAction.cs','MonsterSkillData.cs']);
    assert.match(String((rpc.calls.find(c=>c.method==='turn/start')?.params.input as any[])?.[0]?.text),/existing.*FIRST/i);
  }finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
test('unknown existing types consume a validation repair without compiling or touching source files',async()=>{
  const root=await fixture();const rpc=new MockCodex();rpc.output=(_namespace,turn)=>configured({damage:.8},turn===1?'UnknownType':'MonsterDefaultAttackSO');let compiles=0;
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},discover:async()=>({executable:'fake',version:'test'}),connect:async()=>rpc,compile:async()=>{compiles++;},unity:async(action)=>action==='catalog'?existingCatalog():action==='validate'?{valid:true,issues:[]}:{hasErrors:false}});
  try{const result=await service.generate({prompt:'기존 공격 설정',blueprint});assert.equal(result.typeId,'MonsterDefaultAttackSO');assert.equal(rpc.turns,2);assert.equal(compiles,0);}
  finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
test('AI pipeline uses isolated read-only Codex, compiles then registers a new type',async()=>{
  const root=await fixture();const rpc=new MockCodex();const stages:string[]=[];const actions:string[]=[];let compiled=0;
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:p=>stages.push(p.stage),discover:async()=>({executable:'fake',version:'test'}),connect:async()=>rpc,compile:async()=>{compiled++;},unity:async(action)=>{
    actions.push(action);if(action==='compiler_info')return {editorPath:'fake',references:[],defines:[],languageVersion:'9.0',hasErrors:false};if(action==='ready')return {ready:true,hasErrors:false};if(action==='validate_attack')return {valid:true};return {};
  }});
  try{
    const result=await service.generate({prompt:'앞으로 탄환 3발을 발사',blueprint});
    assert.equal(compiled,1);assert.match(result.typeId,/^Baekho\.Generated\.a[0-9a-f]{32}\.TestAttackSO$/);assert.ok(stages.includes('completed'));assert.ok(actions.indexOf('refresh')<actions.indexOf('validate_attack'));
    const start=rpc.calls.find(c=>c.method==='thread/start')!.params;
    assert.equal(start.sandbox,'read-only');assert.equal(start.approvalPolicy,'never');assert.equal(start.model,undefined);
    assert.deepEqual((start.config as any).mcp_servers,{Unity:{enabled:false},unrelated:{enabled:false}});
    assert.ok(rpc.calls.find(c=>c.method==='turn/start')!.params.outputSchema);
    const journal=JSON.parse(await readFile(path.join(root,'Library','BaekhoEnemyForge','CodeDrafts',result.attackId,'journal.json'),'utf8'));assert.equal(journal.state,'completed');
  }finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
test('compiler failures repair at most twice and never install failed sources',async()=>{
  const root=await fixture();const rpc=new MockCodex();let attempts=0;
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},discover:async()=>({executable:'fake',version:'test'}),connect:async()=>rpc,compile:async()=>{attempts++;throw new Error('CS0000 test diagnostic');},unity:async()=>({hasErrors:false})});
  try{
    await assert.rejects(service.generate({prompt:'invalid',blueprint}),/검증을 통과/);assert.equal(attempts,3);assert.equal(rpc.turns,3);
    assert.deepEqual(await readdir(path.join(root,'Assets','_Project','Scripts','Enemy')),['EnemyAction.cs','MonsterSkillData.cs']);
  }finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
test('lost refresh response is reconciled without duplicate generation or file removal',async()=>{
  const root=await fixture();const rpc=new MockCodex();let refresh=0;
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},discover:async()=>({executable:'fake',version:'test'}),connect:async()=>rpc,compile:async()=>{},unity:async(action)=>{
    if(action==='compiler_info')return {hasErrors:false};if(action==='ready')return {ready:true,hasErrors:false};if(action==='refresh'){refresh++;throw new Error('lost response');}if(action==='validate_attack')return {valid:true};return {};
  }});
  try{const result=await service.generate({prompt:'새 공격',blueprint});assert.equal(refresh,1);assert.equal(rpc.turns,1);assert.match(await readFile(result.files[0],'utf8'),/MonsterSkillData/);}
  finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
test('real Unity compilation failure rolls back before diagnostic repair and then registers successfully',async()=>{
  const root=await fixture();const rpc=new MockCodex();let refresh=0,compiles=0;
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},discover:async()=>({executable:'fake',version:'test'}),connect:async()=>rpc,compile:async()=>{if(++compiles===2)assert.deepEqual(await readdir(path.join(root,'Assets','_Project','Scripts','Enemy','Generated')),[]);},unity:async(action)=>{
    if(action==='compiler_info')return {hasErrors:false};if(action==='ready')return {ready:true,hasErrors:refresh===1,errors:refresh===1?['CS0001 generated error']:[]};if(action==='refresh'){refresh++;return {}; }if(action==='validate_attack')return {valid:true};return {};
  }});
  try{
    const result=await service.generate({prompt:'새 공격',blueprint});assert.equal(refresh,3);assert.equal(rpc.turns,2);assert.equal(compiles,2);
    assert.equal(JSON.parse(await readFile(path.join(root,'Library','BaekhoEnemyForge','CodeDrafts',result.attackId,'journal.json'),'utf8')).state,'completed');
    assert.match(await readFile(path.join(root,'Library','BaekhoEnemyForge','CodeDrafts',result.attackId,'diagnostic-0.txt'),'utf8'),/Unity 컴파일 실패/);
  }finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
test('registration rejection is repaired after rollback with no duplicate installed type',async()=>{
  const root=await fixture();const rpc=new MockCodex();let registrations=0,refreshes=0;
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},discover:async()=>({executable:'fake',version:'test'}),connect:async()=>rpc,compile:async()=>{},unity:async(action)=>{
    if(action==='validate_attack'){if(++registrations===1)throw new Error('Generated attack defaults violate animation/range/speed constraints.');return {valid:true};}if(action==='refresh')refreshes++;return {ready:true,hasErrors:false};
  }});
  try{const result=await service.generate({prompt:'새 공격',blueprint});assert.equal(rpc.turns,2);assert.equal(registrations,2);assert.equal(refreshes,3);assert.equal((await readdir(path.dirname(result.files[0]))).filter(name=>name.endsWith('.cs')).length,2);}
  finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
test('preflight and actual Unity failures share a single budget of two repairs',async()=>{
  const root=await fixture();const rpc=new MockCodex();let compiles=0,refreshes=0;
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},discover:async()=>({executable:'fake',version:'test'}),connect:async()=>rpc,compile:async()=>{if(++compiles===1)throw new Error('CS preflight failure');},unity:async(action)=>{
    if(action==='ready')return {ready:true,hasErrors:refreshes===1,errors:['actual Unity compiler failure']};
    if(action==='refresh')refreshes++;if(action==='validate_attack')return {valid:false,issues:['registration failure']};return {hasErrors:false};
  }});
  try{await assert.rejects(service.generate({prompt:'세 단계 실패',blueprint}),/검증을 통과하지 못/);assert.equal(rpc.turns,3);assert.equal(compiles,3);assert.equal(refreshes,4);assert.deepEqual(await readdir(path.join(root,'Assets','_Project','Scripts','Enemy','Generated')),[]);}
  finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
test('transport-ambiguous registration failure does not request another AI generation',async()=>{
  const root=await fixture();const rpc=new MockCodex();let refreshes=0;
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},discover:async()=>({executable:'fake',version:'test'}),connect:async()=>rpc,compile:async()=>{},unity:async(action)=>{
    if(action==='validate_attack')throw new Error('MCP connection closed');if(action==='refresh')refreshes++;return {ready:true,hasErrors:false};
  }});
  try{await assert.rejects(service.generate({prompt:'알 수 없는 응답',blueprint}),/복구 기록/);assert.equal(rpc.turns,1);assert.equal(refreshes,1);const [id]=await readdir(path.join(root,'Assets','_Project','Scripts','Enemy','Generated'));assert.ok(id);}
  finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
test('cancellation during Codex generation leaves no installed code',async()=>{
  const root=await fixture();const rpc=new MockCodex();rpc.defer=true;
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},discover:async()=>({executable:'fake',version:'test'}),connect:async()=>rpc,compile:async()=>{},unity:async()=>({hasErrors:false})});
  try{
    const running=service.generate({prompt:'생성 후 취소',blueprint});
    while(!rpc.turns)await new Promise(resolve=>setTimeout(resolve,5));service.cancel();
    await assert.rejects(running,/취소|연결/);assert.deepEqual(await readdir(path.join(root,'Assets','_Project','Scripts','Enemy')),['EnemyAction.cs','MonsterSkillData.cs']);
  }finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
test('recovery rolls back journals interrupted before publication or with only some files present',async()=>{
  for(const absent of [true,false]){
    const root=await fixture();const id='a0123456789abcdef0123456789abcdef';const stage=path.join(root,'Library','BaekhoEnemyForge','CodeDrafts',id);let validations=0;
    const journal=await installCandidate(root,stage,id,parseGeneratedAttack(candidate(),`Baekho.Generated.${id}`));
    for(const file of absent?journal.files:[journal.files[0]])await unlink(file.path);
    journal.state='installing';await writeJournal(stage,journal);
    const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},unity:async(action)=>{if(action==='validate_attack'){validations++;throw new Error('missing type');}return {ready:true,hasErrors:false};}});
    try{
      await service.recoverPending();assert.equal(validations,0);
      assert.equal(JSON.parse(await readFile(path.join(stage,'journal.json'),'utf8')).state,'rolled_back');
      assert.deepEqual(await readdir(path.join(root,'Assets','_Project','Scripts','Enemy','Generated')),[]);
    }finally{service.dispose();await rm(root,{recursive:true,force:true});}
  }
});
test('recovery distinguishes definitive missing-type validation from unknown transport failure',async()=>{
  for(const definitive of [true,false]){
    const root=await fixture();const id='a0123456789abcdef0123456789abcdef';const stage=path.join(root,'Library','BaekhoEnemyForge','CodeDrafts',id);let refreshes=0;
    const journal=await installCandidate(root,stage,id,parseGeneratedAttack(candidate(),`Baekho.Generated.${id}`));
    const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},unity:async(action)=>{
      if(action==='validate_attack')throw new Error(definitive?'The generated MonsterSkillData type did not compile: Missing':'MCP connection closed before receiving a response');
      if(action==='refresh')refreshes++;return {ready:true,hasErrors:false};
    }});
    try{
      if(definitive){await service.recoverPending();assert.equal(refreshes,1);assert.equal(JSON.parse(await readFile(path.join(stage,'journal.json'),'utf8')).state,'rolled_back');}
      else{await assert.rejects(service.recoverPending(),/파일은 보존/);assert.equal(refreshes,0);assert.equal(await readFile(journal.files[0].path,'utf8'),candidate().files[0].source);assert.equal(JSON.parse(await readFile(path.join(stage,'journal.json'),'utf8')).state,'recovery_required');}
    }finally{service.dispose();await rm(root,{recursive:true,force:true});}
  }
});
test('returned transient Unity busy errors preserve an installed candidate for later recovery',async()=>{
  const root=await fixture();const id='a0123456789abcdef0123456789abcdef';const stage=path.join(root,'Library','BaekhoEnemyForge','CodeDrafts',id);
  const journal=await installCandidate(root,stage,id,parseGeneratedAttack(candidate(),`Baekho.Generated.${id}`));
  const service=new AiService({dataDirectory:path.join(root,'codex'),getProjectRoot:()=>root,onProgress:()=>{},unity:async(action)=>{
    if(action==='validate_attack'){const error=new Error('Unity의 컴파일 및 에셋 가져오기가 끝날 때까지 기다려 주세요.');error.name='UnityOperationError';throw error;}return {ready:true,hasErrors:false};
  }});
  try{await assert.rejects(service.recoverPending(),/파일은 보존/);assert.equal(await readFile(journal.files[0].path,'utf8'),candidate().files[0].source);}
  finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
