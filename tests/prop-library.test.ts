import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePropField, reclassifyPropBinding, renderPropLibraryFields } from '../src/prop-library';
import { createDemoMap, DEFAULT_SETTINGS } from '../src/shared/map';
import { resolveFixtureBinding } from '../src/shared/light-bindings';
import type { AssetBinding, MapFixture, ProjectFile } from '../src/shared/types';
import { applyPropBoundsCatalog } from '../src/shared/props';

const binding=(id:string,role:AssetBinding['role']='decoration'):AssetBinding=>({
  id,label:id,role,prefabGuid:'1'.repeat(32),prefabPath:`Assets/${id}.prefab`,
  scale:{x:1,y:1,z:1},offset:{x:0,y:0,z:0},rotationY:0,
  prop:{category:'식물',tags:['폐허'],blocksMovement:false,size:{x:2,y:1,z:3},placement:'floor',roomTypes:['battle'],weight:2},
});
const fixture=(id:string,x:number,bindingId?:string):MapFixture=>({id,role:'decoration',x,row:2,direction:90,offset:{x:.1,y:.2,z:.3},anchor:'floor',...(bindingId?{bindingId}:{})});

test('shared decoration classification migrates measured and resolved fixtures without altering shape or metadata',()=>{
  const project:ProjectFile={formatVersion:1,map:createDemoMap(),settings:{...DEFAULT_SETTINGS},bindings:[binding('plant'),binding('vase'),binding('banner'),binding('moss','vegetation'),binding('bush','vegetation')]};
  const auto=fixture('auto-plant',4),explicit=fixture('explicit-plant',7,'plant'),vase=fixture('other-vase',5),banner=fixture('other-banner',6);
  const moss={...fixture('other-moss',4),role:'vegetation' as const},bush={...fixture('other-bush',5),role:'vegetation' as const};
  project.map.fixtures=[auto,explicit,vase,banner,moss,bush];
  project.map.propInstances=[{id:'measured-plant',bindingId:'plant',role:'decoration',x:5,row:5,direction:90,offset:{x:.2,y:.1,z:-.2},cells:[{x:5,row:5},{x:6,row:5}],size:{x:3,y:1,z:2},blocksMovement:false,category:'식물'}];
  project.map.assetOverrides=[{x:4,row:2,role:'decoration',bindingId:'plant'}];
  const original=structuredClone(project),next=reclassifyPropBinding(project,'plant','vegetation');
  assert.equal(resolveFixtureBinding(project.map,project.bindings,auto)?.id,'plant');
  assert.deepEqual([vase,banner,moss,bush].map(item=>resolveFixtureBinding(project.map,project.bindings,item)?.id),['vase','banner','moss','bush']);
  assert.deepEqual(next.bindings[0],{...original.bindings[0],role:'vegetation'});
  assert.deepEqual(next.bindings[1],original.bindings[1]);
  assert.deepEqual(next.map.propInstances![0],{...original.map.propInstances![0],role:'vegetation'});
  assert.deepEqual(next.map.fixtures,[{...auto,role:'vegetation',bindingId:'plant'},{...explicit,role:'vegetation'},{...vase,bindingId:'vase'},{...banner,bindingId:'banner'},{...moss,bindingId:'moss'},{...bush,bindingId:'bush'}]);
  assert.deepEqual(next.map.fixtures!.map(item=>resolveFixtureBinding(next.map,next.bindings,item)?.id),['plant','plant','vase','banner','moss','bush']);
  assert.deepEqual(next.map.assetOverrides,[{x:4,row:2,role:'vegetation',bindingId:'plant'}]);
  assert.deepEqual(project,original);
  assert.deepEqual(reclassifyPropBinding(next,'plant','decoration').bindings[0],original.bindings[0]);
  assert.throws(()=>reclassifyPropBinding(project,'plant','prop'));
  assert.throws(()=>reclassifyPropBinding({...project,bindings:[binding('obstacle','prop')]},'obstacle','vegetation'));
});

test('vegetation assets expose placement fields, classification and conservative shape guidance',()=>{
  const plant=binding('plant','vegetation'),html=renderPropLibraryFields(plant);
  assert.match(html,/data-prop-field="role"/);
  assert.match(html,/value="vegetation" selected/);
  assert.match(html,/전체를 감싸는 직사각형/);
  assert.match(html,/오목하게 빈 부분도 점유 영역/);
  assert.equal(handlePropField(plant,'weight','3').prop?.weight,3);
  assert.doesNotMatch(renderPropLibraryFields(binding('obstacle','prop')),/data-prop-field="role"/);
});

test('functional role and native front are editable independently of group settings and survive measurement refresh', () => {
  const source = binding('Monitor', 'prop'), before = structuredClone(source);
  const functional = handlePropField(handlePropField(source, 'behavior', 'floorEquipment'), 'frontYaw', '180');
  assert.equal(functional.prop?.behavior, 'floorEquipment');
  assert.equal(functional.prop?.frontYaw, 180);
  assert.deepEqual(source, before);
  const refreshed = applyPropBoundsCatalog([functional], { version: 1, assets: [{ guid: source.prefabGuid, size: { x: 1, y: 2, z: .3 } }] }).bindings[0];
  assert.equal(refreshed.prop?.behavior, 'floorEquipment');
  assert.equal(refreshed.prop?.frontYaw, 180);
  const html = renderPropLibraryFields(refreshed);
  assert.match(html, /data-prop-field="behavior"/);
  assert.match(html, /data-prop-field="frontYaw"/);
  assert.match(html, /받침이 필요한 탁상 소품/);
  assert.equal(handlePropField(refreshed, 'behavior', 'automatic').prop?.behavior, undefined);
  assert.equal(handlePropField(refreshed, 'frontYaw', '').prop?.frontYaw, undefined);
  assert.throws(() => handlePropField(source, 'behavior', 'flying'));
  assert.throws(() => handlePropField(source, 'frontYaw', 'not-a-number'));
  assert.throws(() => handlePropField(source, 'frontYaw', 'Infinity'));
});
