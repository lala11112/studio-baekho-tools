/** Live feature verification. --install updates only hash-owned Enemy Forge integration scripts. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {UnityService} from '../electron/services/unity';
import {connectUnityMcp,DEFAULT_UNITY_ENDPOINT,type UnityMcpClient} from '../electron/services/unity-mcp';
import {installIntegration} from '../electron/services/files';
import {compileCandidate} from '../electron/services/ai-code';
import type {Catalog,CompilerInfo,EnemyBlueprint} from '../src/shared/types';

const output=path.resolve('artifacts');
const expectedRoot=path.resolve(process.argv.find(arg=>arg.startsWith('--expected-root='))?.slice('--expected-root='.length)
  ??path.join('..','Four-Tiger-Sword','Four-Tiger-Sword'));
const unity=new UnityService();
let client:UnityMcpClient|null=null,sessionId='',temporary='';
const report:Record<string,any>={startedAt:new Date().toISOString(),status:'running'};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const unwrap=(value:any)=>{if(value?.success===false)throw new Error(value.error??value.message??JSON.stringify(value));return value?.data??value;};
const sceneSnapshotCode='var scenes=new System.Collections.Generic.List<object>();for(int i=0;i<UnityEngine.SceneManagement.SceneManager.sceneCount;i++){var s=UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);var hierarchy=s.GetRootGameObjects().SelectMany(g=>g.GetComponentsInChildren<UnityEngine.Transform>(true)).OrderBy(t=>t.GetInstanceID()).Select(t=>new{id=t.GetInstanceID(),parent=t.parent?t.parent.GetInstanceID():0,name=t.name,active=t.gameObject.activeSelf,layer=t.gameObject.layer,position=t.localPosition.ToString("R"),rotation=t.localRotation.ToString("R"),scale=t.localScale.ToString("R"),components=t.GetComponents<UnityEngine.Component>().Select(c=>c?c.GetType().FullName:"missing").ToArray()}).ToArray();string hierarchyHash;using(var sha=System.Security.Cryptography.SHA256.Create())hierarchyHash=System.BitConverter.ToString(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(Newtonsoft.Json.JsonConvert.SerializeObject(hierarchy)))).Replace("-","");scenes.Add(new{path=s.path,isDirty=s.isDirty,isLoaded=s.isLoaded,isActive=s==UnityEngine.SceneManagement.SceneManager.GetActiveScene(),objects=hierarchy.Length,hierarchyHash});}return new{scenes,playing=UnityEditor.EditorApplication.isPlaying};';
async function connectClient(instanceId:string){
  await client?.close();client=await connectUnityMcp(DEFAULT_UNITY_ENDPOINT);
  await client.callTool('set_active_instance',{instance:instanceId});
}
async function execute(code:string){
  assert.ok(client);const response=unwrap(await client.callTool('execute_code',{action:'execute',code},120_000));
  if(response.errors)throw new Error(JSON.stringify(response.errors));
  return response.result;
}
async function waitReady(instanceId:string){
  const deadline=Date.now()+180_000;
  while(Date.now()<deadline){
    try{const state=await unity.call('ready');if(state.hasErrors)throw new Error(`Unity compilation failed: ${JSON.stringify(state.errors)}`);if(state.ready)return state;}
    catch(error){if(/compilation failed/i.test(String(error)))throw error;await unity.connect().catch(()=>undefined);await connectClient(instanceId).catch(()=>undefined);}
    await sleep(1000);
  }
  throw new Error('Unity did not finish compilation and reload within three minutes.');
}
function checkAnalysis(analysis:any){
  assert.ok(analysis.bounds,JSON.stringify(analysis.warnings));
  const {min,max,center,size}=analysis.bounds;
  assert.ok(analysis.hpBarPosition[1]>max[1]);
  for(let axis=0;axis<3;axis++){
    assert.ok(analysis.vfxPosition[axis]>=min[axis]-.0001&&analysis.vfxPosition[axis]<=max[axis]+.0001);
    assert.ok(Math.abs(center[axis]-(min[axis]+max[axis])*.5)<.001);
    assert.ok(Math.abs(size[axis]-(max[axis]-min[axis]))<.001);
  }
}
try{
  await mkdir(output,{recursive:true});
  const connection=await unity.connect();report.connection=connection;
  assert.equal(path.resolve(connection.projectRoot).toLowerCase(),expectedRoot.toLowerCase(),'Connected Unity project must exactly match the expected nested root.');
  await connectClient(connection.instanceId);
  const before=await execute(sceneSnapshotCode);report.before=before;
  assert.equal(before.playing,false,'Exit Play Mode before live feature verification.');
  if(before.scenes.some((scene:any)=>scene.isLoaded&&scene.isDirty))console.log('Preserving pre-existing unsaved scene state; no scene saves or scene-content changes will be performed.');
  const dependencies:string[]=await execute('return UnityEditor.AssetDatabase.GetDependencies("Assets/_Project/Prefabs/Drone.prefab", true).Where(p=>p.StartsWith("Assets/",System.StringComparison.Ordinal)&&System.IO.File.Exists(p)).ToArray();');
  const sourceFiles=new Map<string,string>();
  for(const file of [...dependencies,...before.scenes.filter((scene:any)=>scene.isLoaded&&scene.path).map((scene:any)=>scene.path)])
    sourceFiles.set(file,sha(await readFile(path.resolve(connection.projectRoot,file))));
  report.sourceHashes=Object.fromEntries(sourceFiles);
  if(process.argv.includes('--install')){
    console.log('Installing hash-owned Editor and Runtime integration scripts into confirmed Four-Tiger-Sword project.');
    await installIntegration(connection.projectRoot,path.resolve('unity-integration'));
    try{await unity.call('refresh');}catch(error){console.warn(`Waiting across Unity reload: ${String(error)}`);}
    report.compilation=await waitReady(connection.instanceId);
    await connectClient(connection.instanceId);
    console.log('Integration compilation complete.');
  }else report.compilation=await waitReady(connection.instanceId);
  const catalog=await unity.call('catalog') as Catalog;
  const blueprint=structuredClone(catalog.template);
  assert.ok(blueprint.animation.move?.children.length&&blueprint.animation.move.children.length>=5,'Original Drone movement tree must import all five children.');
  report.catalog={assets:catalog.assets.length,attacks:catalog.attacks.length,moveChildren:blueprint.animation.move.children.length};
  const info=await unity.call('animation_info',{controller:blueprint.animation.controller});
  assert.equal(info.move.children.length,blueprint.animation.move.children.length);
  assert.ok(info.parameters.some((parameter:any)=>parameter.name==='DirX'&&parameter.type==='Float'));
  const defaults=await unity.call('animation_info',{controller:null});assert.equal(defaults.parameters.length,2);
  report.animationInfo=info;
  const configuration=structuredClone(blueprint);configuration.model=null;
  configuration.animation.states={Idle:null,Move:null,Groggy:null};delete configuration.animation.move;
  report.configurationValidation=await unity.call('validate_configuration',{blueprint:configuration});
  assert.equal(report.configurationValidation.valid,true,JSON.stringify(report.configurationValidation));
  console.log('Running structural, movement, alias, and disposable asset regression fixtures.');
  report.structural=await unity.call('regression');assert.match(report.structural,/^PASS:/);
  report.animation=await execute('return StudioBaekho.EnemyForge.BaekhoEnemyForgeAnimation.RunRegression();');assert.equal(report.animation.passed,true);
  report.driver=await execute('return StudioBaekho.EnemyForge.BaekhoEnemyForgeAnimation.RunDriverRegression();');assert.equal(report.driver.passed,true);
  report.animationAssets=await execute('return StudioBaekho.EnemyForge.BaekhoEnemyForgeAnimation.RunAssetRegression();');assert.equal(report.animationAssets.passed,true);
  report.builds=await unity.call('regression',{build:true});assert.equal(report.builds.passed,true);assert.equal(report.builds.alternateModelBuilt,true);
  const analysis=await unity.call('analyze_model',{blueprint});checkAnalysis(analysis);report.modelAnalysis=analysis;
  const transformed=structuredClone(blueprint);
  transformed.modelTransform={position:[2,.5,-3],rotation:[0,65,0],scale:[1.5,2,.6]};
  const transformedAnalysis=await unity.call('analyze_model',{blueprint:transformed});checkAnalysis(transformedAnalysis);
  assert.ok(transformedAnalysis.bounds.size[1]>analysis.bounds.size[1]*1.9);
  report.transformedModelAnalysis=transformedAnalysis;
  blueprint.hpBarPosition=analysis.hpBarPosition;blueprint.vfxPosition=analysis.vfxPosition;
  sessionId=(await unity.call('preview_open',{blueprint})).sessionId;
  const frames:{name:string;parameters:number[];bytes:number;hash:string;warning?:string}[]=[];
  for(const [name,parameters]of [['center',[0,0]],['right',[1,0]],['left',[-1,0]],['forward',[0,1]],['back',[0,-1]],['diagonal',[.5,.5]]] as const){
    const frame=await unity.call('preview_frame',{sessionId,sequence:frames.length+1,time:.35,yaw:25,pitch:12,zoom:1,clip:null,blueprint,attackId:null,showHitboxes:false,state:'Move',moveParameters:[...parameters]});
    assert.ok(!frame.warning||!/(미리보기:|Avatar|본 경로|Legacy)/.test(frame.warning),frame.warning);
    const dataUrl=await unity.previewImage(frame.imagePath,sessionId);
    const bytes=Buffer.from(dataUrl.substring(dataUrl.indexOf(',')+1),'base64');assert.ok(bytes.length>1000);
    await writeFile(path.join(output,`features-move-${name}.jpg`),bytes);
    frames.push({name,parameters:[...parameters],bytes:bytes.length,hash:sha(bytes),warning:frame.warning});
  }
  assert.ok(new Set(frames.map(frame=>frame.hash)).size>=5,'Directional values must change actual rendered poses.');
  assert.notEqual(frames[1].hash,frames[2].hash,'Right and left movement must render different poses.');
  assert.notEqual(frames[3].hash,frames[4].hash,'Forward and backward movement must render different poses.');
  report.previewFrames=frames;
  await unity.call('preview_close',{sessionId});sessionId='';
  const player=await execute('var a=UnityEditor.Compilation.CompilationPipeline.GetAssemblies(UnityEditor.Compilation.AssembliesType.Player).First(x=>x.name=="Assembly-CSharp");return new{editorPath=UnityEditor.EditorApplication.applicationPath,references=a.allReferences.Where(System.IO.File.Exists).ToArray(),defines=a.defines,languageVersion="9.0",hasErrors=UnityEditor.EditorUtility.scriptCompilationFailed,runtimeIncluded=a.sourceFiles.Any(f=>f.Replace("\\\\","/").EndsWith("/EnemyForge/Runtime/BaekhoEnemyForgeDirectionParameters.cs")),sourceFiles=a.sourceFiles.Where(f=>f.Contains("EnemyForge")).ToArray()};');
  assert.equal(player.runtimeIncluded,true,'Player assembly must include the runtime direction driver.');
  assert.ok(!player.defines.includes('UNITY_EDITOR'));
  assert.ok(player.references.every((reference:string)=>!path.basename(reference).startsWith('UnityEditor')));
  player.references=player.references.map((reference:string)=>path.resolve(connection.projectRoot,reference));
  temporary=await mkdtemp(path.join(tmpdir(),'enemy-forge-runtime-compile-'));
  await compileCandidate(temporary,[{className:'BaekhoEnemyForgeDirectionParameters',source:await readFile('unity-integration/Runtime/BaekhoEnemyForgeDirectionParameters.cs','utf8')}],player as CompilerInfo);
  report.playerCompilation={runtimeIncluded:player.runtimeIncluded,sourceFiles:player.sourceFiles,standaloneRuntimeCompile:true,editorReferences:false};
  const after=await execute(sceneSnapshotCode);report.after=after;
  assert.deepEqual(after,before,'Open scenes and dirty flags must be identical after all fixtures.');
  for(const [file,hash]of sourceFiles)assert.equal(sha(await readFile(path.resolve(connection.projectRoot,file))),hash,`Source asset changed: ${file}`);
  report.sourcesUnchanged=[...sourceFiles.keys()];report.status='passed';
  console.log(JSON.stringify({passed:true,report:path.join(output,'unity-features-report.json'),moveChildren:report.catalog.moveChildren,assetCases:report.animationAssets.cases,buildChecks:report.builds.checks,previewFrames:frames.length,playerRuntimeCompiled:true,sourcesUnchanged:sourceFiles.size},null,2));
}catch(error){
  report.status='failed';report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;console.error(report.error);
}finally{
  if(sessionId)await unity.call('preview_close',{sessionId}).catch(()=>undefined);
  if(temporary){assert.equal(path.dirname(temporary).toLowerCase(),path.resolve(tmpdir()).toLowerCase());assert.ok(path.basename(temporary).startsWith('enemy-forge-runtime-compile-'));await rm(temporary,{recursive:true,force:true});}
  report.finishedAt=new Date().toISOString();await mkdir(output,{recursive:true});await writeFile(path.join(output,'unity-features-report.json'),JSON.stringify(report,null,2));
  await unity.dispose();await client?.close();
}
