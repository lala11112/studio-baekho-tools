import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialProject, gradePrice, validateProject, previewSp, eligibleItemIds, patchItem, acknowledgeDescription, reviewItem, updatePolicies, adoptPolicies, repairReferenceIds, updateIconStyle } from '../engine/four-tiger-items/domain';
import { itemPatchSchema, projectSchema, type Grade, type IconVersion } from '../shared/four-tiger-items';

const now = '2026-10-12T00:00:00.000Z';
const initial = () => createInitialProject({projectId:'11111111-1111-4111-8111-111111111111', name:'사인검 초안', now});
// Transcribed independently from fe533a25 initial-content-draft, not imported from product seed.
const expected = [
  ['IT_WOOD_01','새싹 부적','maxSp:10'], ['IT_WOOD_02','숨결 매듭','spRegen:3'],
  ['IT_WOOD_03','깊은 뿌리','maxSp:20,normalDamage:0.08'], ['IT_WOOD_04','다시 피는 가지','spRegen:8'],
  ['IT_FIRE_01','불씨 장식','normalDamage:0.08'], ['IT_FIRE_02','붉은 인장','switchDamage:0.12'],
  ['IT_FIRE_03','타오르는 매듭','normalDamage:0.18'], ['IT_FIRE_04','이어지는 불꽃','normalDamage:0.3'],
  ['IT_EARTH_01','흙빛 부적','maxHp:0.08'], ['IT_EARTH_02','가벼운 디딤','dodgeSpCost:-2'],
  ['IT_EARTH_03','단단한 매듭','maxHp:0.18'], ['IT_EARTH_04','움직이는 산','dodgeSpCost:-4'],
  ['IT_METAL_01','빛나는 조각','switchDamage:0.08'], ['IT_METAL_02','맞물린 고리','switchSpCost:-1'],
  ['IT_METAL_03','정련된 인장','switchDamage:0.2'], ['IT_METAL_04','오색 연결고리','normalDamage:0.15,switchDamage:0.25'],
  ['IT_WATER_01','물방울 장식','spRegen:2'], ['IT_WATER_02','깊은 물병','maxSp:15'],
  ['IT_WATER_03','흐르는 매듭','dodgeSpCost:-3,switchSpCost:-1'], ['IT_WATER_04','끊임없는 물결','spRegen:5,switchSpCost:-2'],
];

test('all 20 original proposals retain names, effects, grades, units and unapproved status', () => {
  const p=initial();
  assert.deepEqual(p.items.map(i=>[i.itemId,i.name,i.effects.map(e=>`${e.stat}:${e.amount}`).join(',')]),expected);
  assert.equal(new Set(p.items.map(i=>`${i.element}:${i.grade}`)).size,20);
  assert.deepEqual([1,2,3,4].map(g=>gradePrice(g as Grade)),[20,40,80,160]);
  for(const [n,item] of p.items.entries()) {
    assert.equal(item.grade,n%4+1); assert.equal(item.purchasePrice,gradePrice(item.grade));
    assert.equal(item.review.state,'draft'); assert.equal(item.selectedIconVersion,null);
    for(const e of item.effects) {
      const timed=['IT_WOOD_04','IT_FIRE_04','IT_EARTH_04'].includes(item.itemId);
      assert.equal(e.trigger,timed?'formSwitchSucceeded':'whileOwned');
      assert.equal(e.durationSeconds,timed?3:null); assert.equal(e.targetForms,'all');
      assert.equal(e.stackLimit,1); assert.equal(e.removeOnItemLoss,true);
      assert.equal(e.unit,['maxHp','normalDamage','switchDamage'].includes(e.stat)?'ratio':e.stat==='spRegen'?'SPPerSecond':'SP');
    }
  }
  assert.equal(projectSchema.safeParse(p).success,true);
  assert.equal(validateProject(p,'release').canExport,false);
  assert.equal(validateProject(p,'draft').canExport,true);
});
test('proposal arithmetic and candidate diagnostics do not invent extra items or lifetime bans',()=>{
  const p=initial();
  assert.deepEqual(previewSp(p,'wood',false),{maxSp:145,regenPerSecond:30,dodgeCost:15,switchCost:6,proposal:true});
  assert.deepEqual(previewSp(p,'wood',true),{maxSp:145,regenPerSecond:38,dodgeCost:11,switchCost:6,proposal:true});
  assert.equal(eligibleItemIds(p,[],'wood').length,4);
  assert.equal(eligibleItemIds(p,['IT_WOOD_01','IT_WOOD_02','IT_WOOD_03'],'wood').length,1);
  assert.equal(eligibleItemIds(p,['IT_WOOD_01','IT_WOOD_02','IT_WOOD_03','IT_WOOD_04'],'wood').length,0);
  assert.equal(eligibleItemIds(p,['IT_WOOD_04'],'wood',4).length,0);
  assert.equal(eligibleItemIds(p,[],'wood',4).length,1);
});
test('IDs are filename safe and unique, but Korean display names stay unrestricted',()=>{
  for(const id of ['../A','C:\\A','CON','it_fire_01','IT_FIRE_01']) {
    const p=initial();p.items[0].itemId=id;
    assert.ok(validateProject(p,'release').issues.some(i=>i.field==='itemId'&&i.severity==='error'));
  }
  const p=initial();const next=patchItem(p,p.items[0].candidateKey,{name:'새싹 부적 / 테스트'},now);
  assert.equal(next.items[0].name,'새싹 부적 / 테스트'); assert.equal(p.items[0].name,'새싹 부적');
});
test('structured input forbids nonfinite values, foreign fields and impossible effect contracts',()=>{
  const effect=initial().items[0].effects[0];
  for(const amount of [NaN,Infinity]) assert.equal(itemPatchSchema.safeParse({effects:[{...effect,amount}]}).success,false);
  for(const patch of [{purchasePrice:1},{review:{state:'adopted'}},{candidateKey:'x'}]) assert.equal(itemPatchSchema.safeParse(patch).success,false);
  for(const effects of [[{...effect,unit:'ratio'}],[{...effect,stat:'cooldown'}],[{...effect,targetForms:[]}],[{...effect,durationSeconds:3}]]) {
    assert.equal(itemPatchSchema.safeParse({effects}).success,false);
  }
});
test('editing effects invalidates reviews and stale descriptions need explicit acknowledgement',()=>{
  let p=initial();const key=p.items[0].candidateKey;
  p=reviewItem(p,key,'reviewData','',now); const old=p.items[0].contentRevision;
  p=patchItem(p,key,{effects:[{...p.items[0].effects[0],amount:15}]},now);
  assert.equal(p.items[0].contentRevision,old+1);assert.equal(p.items[0].descriptionStale,true);
  assert.equal(p.items[0].review.dataRevision,null);
  assert.throws(()=>reviewItem(p,key,'reviewData','',now),/설명/);
  p=acknowledgeDescription(p,key,true,now);assert.match(p.items[0].description,/15/);
  p=reviewItem(p,key,'reviewData','',now);assert.equal(p.items[0].review.dataRevision,p.items[0].contentRevision);
});
test('adoption needs explicit current data, icon and every policy review; edits revoke it',()=>{
  let p=initial();const key=p.items[0].candidateKey;const i=p.items[0];
  const icon:IconVersion={versionId:'v1',jobId:'j1',contentRevision:i.contentRevision,promptHash:'a'.repeat(64),sourcePath:'icons/a/source.png',thumbnailPath:'icons/a/icon-256.png',sourceSha256:'b'.repeat(64),thumbnailSha256:'c'.repeat(64),width:1024,height:1024,hasAlpha:true,prompt:'test',tool:'imagegen',observedModel:null,createdAt:now};
  i.icons.push(icon);i.selectedIconVersion='v1';
  assert.throws(()=>reviewItem(p,key,'adopt','',now));
  p=reviewItem(p,key,'reviewData','',now);p=reviewItem(p,key,'reviewIcon','',now);
  assert.equal(p.items[0].review.state,'reviewed');assert.throws(()=>reviewItem(p,key,'adopt','',now),/정책/);
  p=adoptPolicies(p,Object.keys(p.ruleProfile.proposed) as (keyof typeof p.ruleProfile.proposed)[],now);
  p=reviewItem(p,key,'adopt','확인',now);assert.equal(p.items[0].review.state,'adopted');
  const changed=updatePolicies(p,{maxSpCap:180},now);assert.equal(changed.ruleProfile.revision,p.ruleProfile.revision+1);assert.equal(changed.items[0].review.state,'draft');
  assert.equal(updateIconStyle(p,'새 화풍',now).items[0].review.state,'draft');
});
test('ID references follow immutable candidates only after explicit repair',()=>{
  let p=initial();const key=p.items[0].candidateKey;
  p=patchItem(p,key,{itemId:'IT_WOOD_NEW'},now);assert.equal(p.items[0].iconKey,'icon.IT_WOOD_NEW');
  assert.ok(validateProject(p,'release').issues.some(i=>i.code==='REFERENCE_STALE'));
  p=repairReferenceIds(p,now);assert.equal(p.synergyReferences[0].items[0].itemId,'IT_WOOD_NEW');
  assert.equal(p.synergyReferences[0].items[0].candidateKey,key);
});
test('unsupported notes and unconfirmed policies cannot become release content',()=>{
  const p=initial();p.items[0].unsupportedEffectNotes='쿨타임 -1초';
  assert.ok(validateProject(p,'release').issues.some(i=>i.code==='UNSUPPORTED_EFFECT'));
  assert.ok(validateProject(p,'release').issues.some(i=>i.code==='POLICY_REVIEW_REQUIRED'));
  const changed=updatePolicies(p,{regenCap:25,minDodgeCost:18},now);
  assert.equal(previewSp(changed,'wood',true).regenPerSecond,25);assert.equal(previewSp(changed,'wood',true).dodgeCost,18);
});
