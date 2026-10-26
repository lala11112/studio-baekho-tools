import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { childOf, configureExistingAttack, installCandidate, parseGeneratedAttack, rollbackCandidate, validateCode } from '../electron/services/ai-code';
import { validatedLoginUrl } from '../electron/services/ai';
import { candidate } from './ai-fixture';
import type {AttackDefinition} from '../src/shared/types';

const attackId='a0123456789abcdef0123456789abcdef';
const namespace=`Baekho.Generated.${attackId}`;
test('code parser keeps additive classes and valid declarative preview',()=>{
  const result=parseGeneratedAttack(candidate(),namespace);
  assert.equal(result.files.length,2);assert.equal(result.defaults.damage,1);assert.equal(result.preview.shapes[0].shape,'sphere');
});
test('code parser rejects automatic execution, disguised namespaces, static state, and filesystem access',()=>{
  for(const injected of ['[UnityEngine.RuntimeInitializeOnLoadMethod] public static void Boot() {}','static TestAction() {}','private static int state = 1;','public static int State { get; } = 1;','public void Bad() { System.IO.File.ReadAllText("x"); }']){
    const value=candidate();value.files[1].source=value.files[1].source.replace('public override void Enter()',`${injected} public override void Enter()`);
    assert.throws(()=>parseGeneratedAttack(value,namespace));
  }
  const additional=candidate();additional.files[1].source+=' namespace Other { public class Injected {} }';
  assert.throws(()=>parseGeneratedAttack(additional,namespace));
  const escaped=candidate();escaped.files[1].source=escaped.files[1].source.replace('base.Enter();','var p = \\u0046ile.ReadAllText("x"); base.Enter();');
  assert.throws(()=>parseGeneratedAttack(escaped,namespace));
});
test('comments and string literals do not trigger source capability checks',()=>{
  const value=candidate();value.files[1].source=value.files[1].source.replace('base.Enter();','// File Process UnityEditor\n string label = "System.IO.File"; base.Enter();');
  assert.doesNotThrow(()=>validateCode(value.files,namespace,'TestAttackSO'));
});
test('SO creation and serialization hooks are rejected while runtime helper cleanup is allowed',()=>{
  for(const hook of ['Awake','OnEnable','OnDisable','OnDestroy','Reset','OnValidate','OnBeforeSerialize','OnAfterDeserialize']){
    const value=candidate();value.files[0].source=value.files[0].source.replace('public float damage',`private void ${hook}() {} public float damage`);
    assert.throws(()=>parseGeneratedAttack(value,namespace),/생명주기|콜백/);
  }
  const callback=candidate();callback.files[1].source=callback.files[1].source.replace(': EnemyAction',': EnemyAction, UnityEngine.ISerializationCallbackReceiver');assert.throws(()=>parseGeneratedAttack(callback,namespace));
  const runtime=candidate();runtime.files.push({className:'ProjectileHelper',source:`namespace ${namespace} { public class ProjectileHelper : UnityEngine.MonoBehaviour { private void Awake() {} private void OnDestroy() {} } }`});
  assert.doesNotThrow(()=>parseGeneratedAttack(runtime,namespace));
});
test('existing settings are schema-allowlisted and merge nested defaults with known asset references',()=>{
  const clip={guid:'1'.repeat(32),localId:'42',path:'Assets/clip.wav',name:'Clip',kind:'AudioClip'};
  const definition:AttackDefinition={typeId:'Existing',name:'Existing',category:'normal',description:'',previewSupported:true,
    fields:[{path:'damage',label:'Damage',type:'number',min:0},{path:'audio',label:'Audio',type:'object',children:[{path:'volume',label:'Volume',type:'number',min:0,max:1},{path:'clip',label:'Clip',type:'asset'}]}],defaults:{damage:1,audio:{volume:.5,clip}}};
  const values=configureExistingAttack(definition,{damage:.7,audio:{volume:.8}},[]);
  assert.deepEqual(values,{damage:.7,audio:{volume:.8,clip}});
  assert.throws(()=>configureExistingAttack(definition,{m_Script:clip},[]),/허용되지 않은/);
  assert.throws(()=>configureExistingAttack(definition,{damage:-1},[]),/숫자 범위/);
  assert.throws(()=>configureExistingAttack(definition,{audio:{clip:{guid:'2'.repeat(32),localId:'99'}}},[]),/카탈로그에 없는/);
});
test('invalid class names, prototype keys and invalid hitbox geometry are rejected',()=>{
  const traversal=candidate();traversal.files[0].className='../Enemy';assert.throws(()=>parseGeneratedAttack(traversal,namespace));
  const defaults=candidate();defaults.defaultsJson='{"__proto__":{"polluted":true}}';assert.throws(()=>parseGeneratedAttack(defaults,namespace));
  const preview=candidate();preview.previewJson='{"shapes":[{"shape":"sphere","start":2,"end":1,"radius":-2}]}';assert.throws(()=>parseGeneratedAttack(preview,namespace));
});
test('owned-file rollback leaves unrelated files and refuses modified generated code',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'enemy-ai-rollback-'));
  try{
    await mkdir(path.join(root,'Assets'),{recursive:true});
    const stage=path.join(root,'Library','stage');const attack=parseGeneratedAttack(candidate(),namespace);
    const journal=await installCandidate(root,stage,attackId,attack);
    const generated=journal.files[0].path;
    await writeFile(`${generated}.meta`,'generated metadata');
    await writeFile(path.join(journal.targetDirectory,'keep.txt'),'user file');
    await rollbackCandidate(journal,stage);
    assert.deepEqual(await readdir(journal.targetDirectory),['keep.txt']);
    assert.equal(JSON.parse(await readFile(path.join(stage,'journal.json'),'utf8')).state,'rolled_back');
    const secondId='affffffffffffffffffffffffffffffff';
    const changed=await installCandidate(root,path.join(root,'Library','stage2'),secondId,attack);
    await writeFile(changed.files[0].path,'user changed this file');
    await assert.rejects(rollbackCandidate(changed,path.join(root,'Library','stage2')),/수정한 생성 파일/);
    assert.equal(await readFile(changed.files[0].path,'utf8'),'user changed this file');
    assert.ok((await readdir(changed.targetDirectory)).includes('TestAction.cs'));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('path and login validation reject alternate destinations',()=>{
  assert.equal(childOf('/project','/project-other/file.cs'),false);
  assert.equal(childOf('/project','/project/../elsewhere.cs'),false);
  assert.throws(()=>validatedLoginUrl('https://chatgpt.com.attacker.test/login'));
  assert.throws(()=>validatedLoginUrl('https://user:secret@chatgpt.com/login'));
  assert.match(validatedLoginUrl('https://auth.openai.com/login'),/^https:\/\/auth\.openai\.com/);
});
