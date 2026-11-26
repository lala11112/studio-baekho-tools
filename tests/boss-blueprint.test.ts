import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyBlueprint,normalizeBlueprint,validateBlueprint,bossIssues,defaultBossPhase,localIssues} from '../src/shared/blueprint';
const attack={id:'slash',typeId:'MonsterDefaultAttackSO',values:{weight:1,animName:'Attack'}};
function boss(){const b=emptyBlueprint('boss');b.attacks=[structuredClone(attack)];return b;}
test('v1 documents migrate only to normal while v3 boss round trips with exact asset IDs',()=>{
 const legacy={...emptyBlueprint(),version:1};delete legacy.kind;
 assert.equal(normalizeBlueprint(legacy).kind,'normal');assert.equal(legacy.version,1);
 assert.throws(()=>normalizeBlueprint({...legacy,boss:boss().boss}));
 const b=boss();b.boss!.phases[0].music={mode:'play',volume:.5,fadeSeconds:.5,clip:{guid:'a'.repeat(32),localId:'919132149155446097',path:'Assets/music.wav',name:'music'}};
 assert.deepEqual(normalizeBlueprint(JSON.parse(JSON.stringify(b))),b);
 assert.throws(()=>validateBlueprint({...b,kind:undefined}));assert.throws(()=>validateBlueprint({...b,kind:'normal'}));
});
test('phase HP, references and effective inherited loadout reject unusable bosses',()=>{
 const b=boss();b.boss!.phases.push(defaultBossPhase(1));assert.deepEqual(bossIssues(b),[]);
 b.boss!.phases[1].phaseMaxHp=0;assert.match(bossIssues(b)[0].message,/0보다/);
 b.boss!.phases[1].phaseMaxHp=500;b.boss!.phases[0].skillIds=['missing'];assert.ok(bossIssues(b).some(i=>i.path.endsWith('skillIds')));
 b.boss!.phases[0].skillIds=[];assert.ok(bossIssues(b).some(i=>/가중치/.test(i.message)));
});
test('sequence attacks ignore weights but need valid references and at least one attack',()=>{
 const b=boss(),p=b.boss!.phases[0];b.attacks[0].values.weight=0;
 p.pattern={mode:'sequence',loop:false,steps:[{kind:'wait',attackId:null,waitSeconds:.4},{kind:'attack',attackId:'slash',waitSeconds:0}]};assert.deepEqual(bossIssues(b),[]);
 b.attacks=[];assert.ok(bossIssues(b).length);b.attacks=[attack];p.pattern.steps.pop();assert.match(bossIssues(b)[0].message,/공격 단계/);
});
test('boss rejects self destruction, unknown immunities, duplicate rewards and nonfinite values',()=>{
 const b=boss();validateBlueprint(b);
 for(const mutate of [
  (v:typeof b)=>{v.selfDestruct=attack;},
  (v:typeof b)=>{v.boss!.statusImmunityList=['Unknown'];},
  (v:typeof b)=>{v.boss!.initialShield=-1;},
  (v:typeof b)=>{v.boss!.phases[0].shield=Infinity;},
  (v:typeof b)=>{v.boss!.phases[0].music.volume=2;},
  (v:typeof b)=>{v.boss!.reward.gold=1.5;},
  (v:typeof b)=>{v.boss!.reward.gold=2147483648;},
  (v:typeof b)=>{v.boss!.phases[0].pattern.steps=[{kind:'wait',attackId:null,waitSeconds:-1}];},
 ]){const v=structuredClone(b);mutate(v);assert.throws(()=>validateBlueprint(v));}
 const item={guid:'c'.repeat(32),localId:'11400000',path:'Assets/item.asset',name:'item'};
 b.boss!.reward.items=[item,item];assert.throws(()=>validateBlueprint(b));
});
test('enabled weakness/resistance conflict and missing music clips are visible errors',()=>{
 const b=boss(),c=b.boss!;c.enableWeakness=c.enableResistance=true;
 assert.ok(bossIssues(b).some(i=>i.path==='boss.weaknessElement'));c.enableResistance=false;
 c.phases[0].music.mode='play';assert.ok(bossIssues(b).some(i=>i.path.endsWith('music.clip')));
 c.phases[0].shield=0;validateBlueprint(b);c.phases[0].shield=null;validateBlueprint(b);
});
test('catalog null Move trees normalize to an absent tree for clip-only models',()=>{
 const b=JSON.parse(JSON.stringify(boss()));b.animation.move=null;
 validateBlueprint(b);assert.equal(normalizeBlueprint(b).animation.move,undefined);
});
test('legacy boss migration preserves the total HP and list order without mutating the input',()=>{
 const legacy:any=structuredClone(boss());legacy.version=2;legacy.stats.maxHp=4800;
 legacy.boss.phases=[100,65,30].map((triggerHpPercent,index)=>{const phase:any=defaultBossPhase(index);delete phase.phaseMaxHp;return {...phase,triggerHpPercent};});
 delete legacy.boss.phaseDownSeconds;delete legacy.boss.phaseHoldSeconds;delete legacy.boss.phaseReviveSeconds;
 const original=structuredClone(legacy),migrated=normalizeBlueprint(legacy);
 assert.equal(migrated.version,3);assert.equal(migrated.stats.maxHp,4800);
 assert.deepEqual(migrated.boss!.phases.map(p=>p.phaseMaxHp),[1680,1680,1440]);
 assert.deepEqual(migrated.boss!.phases.map(p=>p.phaseId),['phase_1','phase_2','phase_3']);
 assert.ok(migrated.boss!.phases.every(p=>!('triggerHpPercent' in p)));
 assert.equal(migrated.boss!.phaseDownSeconds+migrated.boss!.phaseHoldSeconds+migrated.boss!.phaseReviveSeconds,3);
 assert.deepEqual(legacy,original);
 for(const thresholds of [[99,65,30],[100,100,30],[100,20,30],[100,65,0]]){const invalid=structuredClone(legacy);thresholds.forEach((v,i)=>invalid.boss.phases[i].triggerHpPercent=v);assert.throws(()=>normalizeBlueprint(invalid));}
});
test('new boss HP is derived from all ordered phases and invalid HP or timing cannot be saved',()=>{
 const b=boss();b.boss!.phases=[defaultBossPhase(),defaultBossPhase(1),defaultBossPhase(2)];
 [1680,1680,1440].forEach((hp,i)=>b.boss!.phases[i].phaseMaxHp=hp);b.stats.maxHp=99999;
 assert.equal(normalizeBlueprint(b).stats.maxHp,4800);
 const fractional=structuredClone(b);fractional.boss!.phases=[defaultBossPhase(),defaultBossPhase(1)];fractional.boss!.phases[0].phaseMaxHp=.25;fractional.boss!.phases[1].phaseMaxHp=1.5;
 assert.equal(normalizeBlueprint(fractional).stats.maxHp,2);assert.deepEqual(normalizeBlueprint(fractional).boss!.phases.map(p=>p.phaseMaxHp),[.25,1.5]);
 for(const hp of [0,-1,NaN,Infinity,3.5e38]){const invalid=structuredClone(b);invalid.boss!.phases[0].phaseMaxHp=hp;assert.throws(()=>normalizeBlueprint(invalid));}
 for(const key of ['phaseDownSeconds','phaseHoldSeconds','phaseReviveSeconds'] as const){const invalid=structuredClone(b);invalid.boss![key]=-1;assert.throws(()=>normalizeBlueprint(invalid));}
});
test('multiple phases require down and revive clip mappings while a single phase does not',()=>{
 const b=boss();assert.ok(!localIssues(b).some(i=>i.path.includes('PhaseDown')||i.path.includes('PhaseRevive')));
 b.boss!.phases.push(defaultBossPhase(1));
 assert.deepEqual(localIssues(b).filter(i=>i.path.includes('PhaseDown')||i.path.includes('PhaseRevive')).map(i=>i.path),['animation.states.PhaseDown','animation.states.PhaseRevive']);
 const clip={guid:'c'.repeat(32),localId:'7400000',path:'Assets/revive.anim',name:'Revive'};
 b.animation.states.PhaseDown=clip;b.animation.states.PhaseRevive=clip;
 assert.ok(!localIssues(b).some(i=>i.path.includes('PhaseDown')||i.path.includes('PhaseRevive')));
});
