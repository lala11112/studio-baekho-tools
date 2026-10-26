import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AiService} from '../electron/services/ai';
import {UnityService} from '../electron/services/unity';
import type {AiAttackResult, Catalog} from '../src/shared/types';

// This is an opt-in live integration check. --force requests a new inference even if a valid sample exists.
const artifact=path.resolve('artifacts/ai-integration.json');
const prompt='현재 프로젝트 코드에 맞는 새 일반 공격을 구현해 주세요. 1초간 준비한 뒤 플레이어가 있던 방향으로 구형 탄환 3발을 0.15초 간격으로 발사합니다. 속도 8m/s, 최대 수명 3초, 반경 0.12m, 피해는 ATK의 0.3배입니다. 발사 순간 방향을 고정하고 탄환은 벽에 닿으면 제거합니다. 이전 위치부터 다음 위치까지 swept cast로 벽 통과와 빠른 탄환의 피격 누락을 방지하고 소유자 자신은 무시합니다. 공격이 중단되거나 패링되면 발사한 탄환 전부를 정리합니다. 탄환이 남아 있는 동안 액션은 완료 처리하지 마세요. 별도 이펙트 에셋 없이 기본 구형 외형을 사용하고 StageTransientObject.Track으로 추적합니다. Animator 상태명 기본값은 기존 Drone 클립에 매핑할 Attack으로 지정합니다. 사용자 설정에는 준비시간·발사간격·탄환수·속도·반경·수명·피해배율을 노출해 주세요. 가능하면 실제 타이밍과 예상 전방 궤적을 미리보기 메타데이터로 제공해 주세요.';
const unity=new UnityService();
const progress:{stage:string;message:string;attempt?:number}[]=[];
const ai=new AiService({dataDirectory:path.resolve('artifacts/ai-data'),getProjectRoot:()=>unity.root,unity:(action,payload)=>unity.call(action,payload),onProgress:p=>{progress.push(p);process.stdout.write(`[${p.stage}] ${p.message}\n`);}});
const startedAt=new Date().toISOString();
try{
  await mkdir(path.dirname(artifact),{recursive:true});
  const connection=await unity.connect();
  const before=await unity.call('catalog') as Catalog;
  const compilerBefore=await unity.call('compiler_info');assert.equal(compilerBefore.hasErrors,false);
  const status=await ai.status();assert.equal(status.state,'ready',status.message);
  let result:AiAttackResult|undefined;
  if(!process.argv.includes('--force')){
    const previous=await readFile(artifact,'utf8').then(JSON.parse).catch(()=>null);
    if(previous?.status==='passed'&&previous?.projectRoot===connection.projectRoot&&before.attacks.some(a=>a.typeId===previous.result?.typeId))result=previous.result;
  }
  const reused=!!result;
  result??=await ai.generate({prompt,blueprint:before.template});
  const after=await unity.call('catalog') as Catalog;
  const definition=after.attacks.find(a=>a.typeId===result!.typeId);
  assert.ok(definition,'Generated type must be visible in the validated catalog.');
  if(!result.configuredExisting)assert.equal(definition.generated,true);
  assert.ok(definition.fields.some(field=>field.path==='animName'));
  assert.equal((result.existingValues??definition.defaults).animName,'Attack');
  const compilerAfter=await unity.call('compiler_info');assert.equal(compilerAfter.hasErrors,false);
  const sourceFiles=result.files.filter(file=>file.endsWith('.cs'));
  if(result.configuredExisting)assert.equal(result.files.length,0,'Existing settings must not install code.');
  else assert.ok(sourceFiles.length>=2);
  const sources=await Promise.all(sourceFiles.map(file=>readFile(file,'utf8')));
  if(!result.configuredExisting){assert.ok(sources.some(source=>source.includes('EnemyAction')));assert.ok(sources.some(source=>source.includes('MonsterSkillData')));}
  const report={status:'passed',startedAt,finishedAt:new Date().toISOString(),projectRoot:connection.projectRoot,unityVersion:connection.unityVersion,codexVersion:status.version,reused,result,definition,sourceFiles,progress};
  await writeFile(artifact,JSON.stringify(report,null,2),'utf8');
  process.stdout.write(`AI attack ${result.configuredExisting?'configured':'registered'}: ${result.typeId}\nReport: ${artifact}\n`);
}catch(error){
  await mkdir(path.dirname(artifact),{recursive:true});
  await writeFile(artifact,JSON.stringify({status:'failed',startedAt,finishedAt:new Date().toISOString(),error:error instanceof Error?error.message:String(error),progress},null,2),'utf8');
  process.stderr.write(`${error instanceof Error?error.stack:String(error)}\n`);process.exitCode=1;
}finally{ai.dispose();await unity.dispose();}
