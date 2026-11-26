import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyBlueprint,validateBlueprint,localIssues,defaultMoveBlend,moveBlendActive} from '../src/shared/blueprint';
test('blueprint rejects unsafe names, wrong versions, duplicate attacks and nonfinite transforms',()=>{
  const base=emptyBlueprint();validateBlueprint(base);
  for(const name of ['../Enemy','CON','enemy.',' enemy','x'.repeat(65)])assert.throws(()=>validateBlueprint({...base,name}));
  validateBlueprint({...base,name:'백호 드론_01'});
  assert.throws(()=>validateBlueprint({...base,version:4}));
  assert.throws(()=>validateBlueprint({...base,modelTransform:{...base.modelTransform,scale:[1,Infinity,1]}}));
  assert.throws(()=>validateBlueprint({...base,attacks:[{id:'a',typeId:'A',values:{}},{id:'a',typeId:'A',values:{}}]}));
});
test('large Unity subasset local IDs survive blueprint JSON round trip',()=>{
  const b=emptyBlueprint();b.model={guid:'f'.repeat(32),localId:'919132149155446097',path:'Assets/한글 모델.fbx',name:'모델'};
  const read=JSON.parse(JSON.stringify(b));validateBlueprint(read);assert.equal(read.model?.localId,'919132149155446097');
});
test('clip mode requires exact attack state mapping; controller checks remain on Unity',()=>{
  const b=emptyBlueprint();b.attacks=[{id:'one',typeId:'MonsterDefaultAttackSO',values:{animName:'Strike'}}];
  assert.ok(localIssues(b).some(i=>i.path==='animation.states.Strike'));
  b.animation.mode='controller';assert.ok(!localIssues(b).some(i=>i.path.startsWith('animation.states')));
});
test('deserialized prototype keys are rejected',()=>{
  const b=JSON.parse(JSON.stringify(emptyBlueprint()));b.stats=JSON.parse('{"__proto__":{"polluted":true}}');assert.throws(()=>validateBlueprint(b));assert.equal(({} as any).polluted,undefined);
});

test('legacy documents keep single Move clips and manual anchor semantics',()=>{
  const b=emptyBlueprint();delete b.animation.move;delete b.anchors;
  const clip={guid:'c'.repeat(32),localId:'7400000',path:'Assets/Move.fbx',name:'Move'};
  b.animation.states.Move=clip;const restored=JSON.parse(JSON.stringify(b));validateBlueprint(restored);
  assert.equal(moveBlendActive(restored),false);assert.equal(restored.anchors,undefined);assert.deepEqual(restored.animation.states.Move,clip);
  assert.ok(!localIssues(restored).some(i=>i.path==='animation.states.Move'));
});

test('direction tree validates parameter identity, rays, clips and playback speeds',()=>{
  const b=emptyBlueprint(),clip={guid:'c'.repeat(32),localId:'7400000',path:'Assets/Move.fbx',name:'Move'};
  b.animation.move=defaultMoveBlend(3);b.animation.move.children.forEach(c=>c.clip=clip);
  assert.equal(moveBlendActive(b),true);assert.deepEqual(localIssues(b).filter(i=>i.path.startsWith('animation.move')),[]);
  const saved=JSON.parse(JSON.stringify(b));validateBlueprint(saved);assert.deepEqual(saved.animation.move,b.animation.move);
  const cases=[
    (v:typeof b)=>{v.animation.move!.parameterX='DirY';},
    (v:typeof b)=>{v.animation.move!.parameterY=v.animation.move!.parameterX;},
    (v:typeof b)=>{v.animation.move!.children[2].position=[0,6];},
    (v:typeof b)=>{v.animation.move!.children[2].position=[0,0];},
    (v:typeof b)=>{v.animation.move!.children[2].clip=null;},
    (v:typeof b)=>{v.animation.move!.children[2].timeScale=0;}
  ];
  for(const mutate of cases){const copy=structuredClone(b);mutate(copy);assert.ok(localIssues(copy).some(i=>i.path.startsWith('animation.move')));}
  b.animation.move.children[0].position=[NaN,0];assert.throws(()=>validateBlueprint(b));
});

test('controller Move is preserved until override and malformed documents do not crash local checks',()=>{
  const b=emptyBlueprint();b.animation.mode='controller';assert.equal(moveBlendActive(b),false);assert.ok(!localIssues(b).some(i=>i.path.startsWith('animation.move')));
  b.animation.move!.overrideController=true;assert.equal(moveBlendActive(b),true);assert.ok(localIssues(b).some(i=>i.path.includes('.clip')));
  assert.equal(localIssues({} as typeof b)[0].severity,'error');
  assert.throws(()=>validateBlueprint({...b,anchors:{hpBar:'unknown',vfx:'auto'}}));
});
