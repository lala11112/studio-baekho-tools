import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {installIntegration,projectFile} from '../electron/services/files';
import {validatedUnityEndpoint} from '../electron/services/unity-mcp';
test('integration install preserves meta and refuses user-edited sources',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'enemy-forge-files-'));try{
  const unity=path.join(root,'project'),resources=path.join(root,'resources');await mkdir(path.join(unity,'Assets'),{recursive:true});await mkdir(path.join(unity,'ProjectSettings'));await writeFile(path.join(unity,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 6000.3.10f1');await mkdir(path.join(resources,'Editor'),{recursive:true});
  await writeFile(path.join(resources,'Editor/BaekhoEnemyForgeBridge.cs'),'// v1');await installIntegration(unity,resources);
  const installed=path.join(unity,'Assets/Baekho/EnemyForge/Editor/BaekhoEnemyForgeBridge.cs');await writeFile(installed+'.meta','guid: unique');await writeFile(path.join(resources,'Editor/BaekhoEnemyForgeBridge.cs'),'// v2');await installIntegration(unity,resources);assert.equal(await readFile(installed,'utf8'),'// v2');assert.equal(await readFile(installed+'.meta','utf8'),'guid: unique');
  await writeFile(installed,'// user changes');await assert.rejects(installIntegration(unity,resources),/보존/);assert.equal(await readFile(installed,'utf8'),'// user changes');
  await assert.rejects(projectFile(unity,'../outside.cs'),/프로젝트 밖/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Unity connector accepts local endpoints only',()=>{assert.equal(validatedUnityEndpoint(),'http://127.0.0.1:8080/mcp');for(const url of ['https://example.com/mcp','http://example.com/mcp','http://user@127.0.0.1:8080/mcp','file:///test'])assert.throws(()=>validatedUnityEndpoint(url));});

test('runtime integration installs outside Editor and protects edited files before any write',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'enemy-forge-runtime-files-'));try{
  const unity=path.join(root,'project'),resources=path.join(root,'resources');await mkdir(path.join(unity,'Assets'),{recursive:true});await mkdir(path.join(unity,'ProjectSettings'));await writeFile(path.join(unity,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 6000.3.10f1');
  for(const directory of ['Editor','Runtime'])await mkdir(path.join(resources,directory),{recursive:true});
  await writeFile(path.join(resources,'Editor/BaekhoEnemyForgeBridge.cs'),'// editor v1');await writeFile(path.join(resources,'Runtime/BaekhoEnemyForgeDirectionParameters.cs'),'// runtime v1');await installIntegration(unity,resources);
  const runtime=path.join(unity,'Assets/Baekho/EnemyForge/Runtime/BaekhoEnemyForgeDirectionParameters.cs'),editor=path.join(unity,'Assets/Baekho/EnemyForge/Editor/BaekhoEnemyForgeBridge.cs');
  assert.equal(await readFile(runtime,'utf8'),'// runtime v1');await writeFile(runtime+'.meta','guid: runtime');await writeFile(runtime,'// custom runtime');await writeFile(path.join(resources,'Editor/BaekhoEnemyForgeBridge.cs'),'// editor v2');
  await assert.rejects(installIntegration(unity,resources),/보존/);assert.equal(await readFile(editor,'utf8'),'// editor v1');assert.equal(await readFile(runtime+'.meta','utf8'),'guid: runtime');
 }finally{await rm(root,{recursive:true,force:true});}
});
