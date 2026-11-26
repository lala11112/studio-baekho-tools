import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {connectUnityMcp,DEFAULT_UNITY_ENDPOINT,type UnityMcpClient} from '../electron/services/unity-mcp';

// Real generated boss assets, runtime combat and existing economy/encounter regressions.
// All test assets are UUID-owned and cleaned by the Editor harness; saved scenes are restored.
const play=process.argv.includes('--play');let client:UnityMcpClient|null=null,suitePending=false,generatedPending=false;
let previousGeneratedJobId:string|undefined,generatedJobId:string|undefined;
const expectedRoot=path.resolve(process.argv.find(arg=>arg.startsWith('--expected-root='))?.slice('--expected-root='.length)
 ??path.join('..','Four-Tiger-Sword','Four-Tiger-Sword'));
const report:Record<string,any>={status:'running',startedAt:new Date().toISOString(),playRequested:play};
const unwrap=(r:any)=>{if(r?.success===false)throw new Error(r.error??r.message);return r?.data??r;};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function connect(){await client?.close().catch(()=>{});client=await connectUnityMcp(DEFAULT_UNITY_ENDPOINT);const instances=unwrap(await client.readResource('mcpforunity://instances')).instances;assert.equal(instances.length,1);await client.callTool('set_active_instance',{instance:instances[0].id});const info=unwrap(await client.readResource('mcpforunity://project/info'));assert.equal(path.resolve(info.projectRoot).toLowerCase(),expectedRoot.toLowerCase(),'Unity project must match the expected nested game root.');}
async function execute(code:string){const r=unwrap(await client!.callTool('execute_code',{action:'execute',code},120000));if(r.errors)throw new Error(JSON.stringify(r.errors));return r.result;}
async function read(code:string){for(let i=0;;i++){try{return await execute(code);}catch(error){if(i>=10)throw error;await delay(1000);await connect().catch(()=>{});}}}
async function until<T>(readValue:()=>Promise<T>,done:(v:T)=>boolean,ms=150000){const deadline=Date.now()+ms;for(;;){const v=await readValue();if(done(v))return v;if(Date.now()>deadline)throw new Error('Unity regression timed out.');await delay(1000);}}
const snapshot='return new {playing=UnityEditor.EditorApplication.isPlaying,scenes=System.Linq.Enumerable.Range(0,UnityEngine.SceneManagement.SceneManager.sceneCount).Select(i=>UnityEngine.SceneManagement.SceneManager.GetSceneAt(i)).Select(s=>new {s.path,s.isDirty,s.isLoaded,active=s==UnityEngine.SceneManagement.SceneManager.GetActiveScene()}).ToArray()};';
async function restoreSuite(){
 // Confirm the Editor's explicit stop operation before restoring saved scenes.
 await client!.callTool('manage_editor',{action:'stop'});
 await until(()=>read('return !UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode && !UnityEditor.EditorApplication.isCompiling;'),Boolean,60000);
 await execute('var setup=UnityEditor.SessionState.GetString("BaekhoEnemyForge.BossSuiteSetup","");if(!string.IsNullOrEmpty(setup)){UnityEditor.SceneManagement.EditorSceneManager.RestoreSceneManagerSetup(Newtonsoft.Json.JsonConvert.DeserializeObject<UnityEditor.SceneManagement.SceneSetup[]>(setup));UnityEditor.SessionState.EraseString("BaekhoEnemyForge.BossSuiteSetup");}return true;');suitePending=false;
}
try{
 await mkdir('artifacts',{recursive:true});await connect();report.before=await execute(snapshot);assert.equal(report.before.playing,false);
 report.edit=await execute('return new {combat=BossCombatRegression.Run(),rewards=BossMusicRewardRegression.Run(),economy=ShopEconomyRegression.Run(),encounter=DungeonStageEncounterRegression.Run()};');
 console.log(JSON.stringify({edit:report.edit}));
 report.generated=await execute('return StudioBaekho.EnemyForge.BaekhoEnemyForgeBossRegression.Run();');assert.equal(report.generated.passed,true);console.log(JSON.stringify({generatedChecks:report.generated.checks}));
 if(play){
  assert.ok(report.before.scenes.every((s:any)=>!s.isLoaded||s.path&&!s.isDirty),'Save scenes before Play Mode tests.');
  previousGeneratedJobId=(await read('return StudioBaekho.EnemyForge.BaekhoEnemyForgeBossRegression.Status();')).jobId;
  let started:any;generatedPending=true;
  try{started=await execute('return StudioBaekho.EnemyForge.BaekhoEnemyForgeBossRegression.StartPlayMode();');}catch{started=await read('return StudioBaekho.EnemyForge.BaekhoEnemyForgeBossRegression.Status();');}
  assert.ok(started.jobId&&started.jobId!==previousGeneratedJobId,'Generated-boss regression must start a new durable job.');generatedJobId=started.jobId;
  report.generatedPlay=await until(()=>read('return StudioBaekho.EnemyForge.BaekhoEnemyForgeBossRegression.Status();'),r=>r.state==='completed'||r.state==='failed');
  generatedPending=false;assert.equal(report.generatedPlay.jobId,started.jobId);assert.equal(report.generatedPlay.state,'completed',report.generatedPlay.error);assert.equal(report.generatedPlay.scenesPreserved,true);assert.equal(report.generatedPlay.cleaned,true);
  console.log(JSON.stringify({generatedPlayChecks:report.generatedPlay.checks}));
  suitePending=true;
  try{await execute('UnityEditor.SessionState.SetString("BaekhoEnemyForge.BossSuiteSetup",Newtonsoft.Json.JsonConvert.SerializeObject(UnityEditor.SceneManagement.EditorSceneManager.GetSceneManagerSetup()));UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene,UnityEditor.SceneManagement.NewSceneMode.Single);UnityEditor.EditorApplication.EnterPlaymode();return true;');}catch{/* A domain reload may consume only the response; do not start again. */}
  await until(()=>read('return UnityEditor.EditorApplication.isPlaying && !UnityEditor.EditorApplication.isCompiling;'),Boolean,60000);
  report.music=await execute('return BossMusicRewardRegression.RunMusic();');
  await execute('UnityEngine.Application.runInBackground=true;return EnemyBrainRegression.StartPlayMode();');
  report.brains=await until(async()=>JSON.parse(await read('UnityEditor.EditorApplication.QueuePlayerLoopUpdate();return EnemyBrainRegression.PlayModeStatus();')),r=>r.status!=='running');
  assert.equal(report.brains.status,'passed',report.brains.status);await restoreSuite();
 }
 report.after=await read(snapshot);assert.deepEqual(report.after,report.before,'Original scene configuration must be restored.');report.status='passed';
 console.log(JSON.stringify({passed:true,edit:report.edit,generatedChecks:report.generated.checks,generatedPlayChecks:report.generatedPlay?.checks,music:report.music,brains:report.brains},null,2));
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;console.error(error);}
finally{
 if(generatedPending)try{
  const current=await read('return StudioBaekho.EnemyForge.BaekhoEnemyForgeBossRegression.Status();');
  if(current.jobId&&current.jobId!==previousGeneratedJobId&&(!generatedJobId||current.jobId===generatedJobId)){
   await execute(`var job=StudioBaekho.EnemyForge.BaekhoEnemyForgeBossRegression.Status();if((string)job["jobId"]==${JSON.stringify(current.jobId)})return StudioBaekho.EnemyForge.BaekhoEnemyForgeBossRegression.Cancel();return job;`);
   report.generatedPlayRecovery=await until(()=>read('return StudioBaekho.EnemyForge.BaekhoEnemyForgeBossRegression.Status();'),r=>r.jobId===current.jobId&&(r.state==='completed'||r.state==='failed'),60000);
  }
 }catch(error){report.restoreError=String(error);report.status='failed';process.exitCode=1;}
 if(suitePending)try{await restoreSuite();}catch(error){report.restoreError=String(error);report.status='failed';process.exitCode=1;}
 report.finishedAt=new Date().toISOString();await writeFile('artifacts/boss-unity-report.json',JSON.stringify(report,null,2));await client?.close();
}
