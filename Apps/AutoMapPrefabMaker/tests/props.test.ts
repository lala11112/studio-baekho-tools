import assert from 'node:assert/strict';
import test from 'node:test';
import { applyImportedPropBounds, applyPropBoundsCatalog, assertWholeProps, parsePropDefinition, parsePropInstance, placeProps, preparePropBoundsImport, propDataErrors, propPosition, propValidationIssues, propWorldSize, replacePropInstance, snapshotPropCatalog, suggestPropDefinition } from '../src/shared/props';
import { handlePropField, renderPropLibraryFields } from '../src/prop-library';
import type { AssetBinding, GenerationSettings, GridMap, PropInstance } from '../src/shared/types';

const map=():GridMap=>({version:5,name:'Props',width:8,height:8,cellSize:2,rows:['########','#......#','#.P....#','#......#','#......#','#......#','#......#','########'],elevations:Array.from({length:8},()=>Array(8).fill(0)),ramps:[],connections:[],assetOverrides:[],maxStepHeight:.4});
const settings:GenerationSettings={prompt:'방',width:8,height:8,cellSize:2,elevationStep:2,maxStepHeight:.4,connectionCount:1,codexModel:'',seed:123,levelDesign:{pattern:'openArena',characterRadius:.4,dodgeDistance:3}};
const binding=(id='crate'):AssetBinding=>({id,label:id,role:'prop',prefabGuid:'1'.repeat(32),prefabPath:`Assets/${id}.prefab`,scale:{x:1,y:1,z:1},offset:{x:0,y:0,z:0},rotationY:0,prop:{category:'상자',tags:[],blocksMovement:true,size:{x:3,y:1,z:2},placement:'floor',roomTypes:['battle'],weight:1}});

test('prop definitions and instances reject unknown keys and invalid physical dimensions',()=>{
  assert.throws(()=>parsePropDefinition({...binding().prop,size:{x:0,y:1,z:2}}));
  assert.throws(()=>parsePropDefinition({...binding().prop,roomTypes:['battle','battle']}));
  assert.throws(()=>parsePropDefinition({...binding().prop,code:'execute'}));
  const p=placeProps(map(),settings,[binding()]).map.propInstances![0];
  assert.deepEqual(parsePropInstance(p,8,8),p);
  assert.throws(()=>parsePropInstance({...p,cells:[...p.cells,p.cells[0]]},8,8));
  assert.throws(()=>parsePropInstance({...p,cells:[{x:7,row:7}]},8,8));
  assert.match(propDataErrors({width:8,height:8,propInstances:[p,p]}).join(),/중복/);
});

test('filename suggestions distinguish Korean and English props without inventing size',()=>{
  assert.equal(suggestPropDefinition({...binding('책장'),prefabPath:'Assets/Furniture/책장.prefab'}).category,'가구');
  assert.equal(suggestPropDefinition({...binding('Barrel_Oak')}).category,'통');
  assert.equal(suggestPropDefinition({...binding('unknown')}).category,'미분류');
  assert.equal(suggestPropDefinition(binding()).size,undefined);
  assert.equal(suggestPropDefinition({...binding(),role:'decoration'}).blocksMovement,false);
});

test('Unity bounds import updates matching props only and preserves all other data',()=>{
  const original=binding(),other={...binding('wall'),role:'wall' as const};delete other.prop;
  const result=applyPropBoundsCatalog([original,other],{version:1,assets:[{guid:'1'.repeat(32),size:{x:4,y:2,z:3}}]});
  assert.equal(result.updated,1);assert.deepEqual(result.bindings[0].prop?.size,{x:4,y:2,z:3});assert.deepEqual(result.bindings[1],other);assert.equal(original.prop?.size?.x,3);
  assert.throws(()=>applyPropBoundsCatalog([original],{version:1,assets:[{guid:'bad',size:{x:1,y:1,z:1}}]}));
  assert.throws(()=>applyPropBoundsCatalog([original],{version:1,assets:[{guid:'1'.repeat(32),size:{x:1,y:1,z:1}},{guid:'1'.repeat(32),size:{x:2,y:1,z:1}}]}));
});

test('bounds imported before prop registration are retained and applied when matching props are added',()=>{
  const source={version:1,assets:[{guid:'1'.repeat(32),size:{x:4,y:2,z:3}}]};
  const prepared=preparePropBoundsImport([],source,[{guid:'1'.repeat(32),path:'Assets/crate.prefab',name:'crate'}]);
  assert.deepEqual(prepared.bindings,[]);assert.equal(prepared.updated,0);assert.equal(prepared.available,1);assert.equal(prepared.missing,0);
  const original=binding();delete original.prop;
  const added=applyImportedPropBounds(original,prepared.catalog);
  assert.deepEqual(added.prop,{...suggestPropDefinition(original),size:{x:4,y:2,z:3}});
  assert.equal(original.prop,undefined);
  const decoration={...original,role:'decoration' as const};
  assert.equal(applyImportedPropBounds(decoration,prepared.catalog).prop?.blocksMovement,false);
  source.assets[0].size.x=99;assert.equal(prepared.catalog.assets[0].size.x,4);
  added.prop!.size!.x=88;assert.equal(prepared.catalog.assets[0].size.x,4);
});

test('bounds preparation filters measurements by the connected project and reports missing registered props',()=>{
  const original=binding(),unmatched={...binding('other'),prefabGuid:'2'.repeat(32)},wall={...binding('wall'),role:'wall' as const};
  const source={version:1,assets:[{guid:'1'.repeat(32),size:{x:4,y:2,z:3}},{guid:'2'.repeat(32),size:{x:9,y:9,z:9}}]};
  const prepared=preparePropBoundsImport([original,unmatched,wall],source,[{guid:'1'.repeat(32),path:'Assets/crate.prefab',name:'crate'}]);
  assert.equal(prepared.updated,1);assert.equal(prepared.available,1);assert.equal(prepared.missing,1);
  assert.deepEqual(prepared.catalog.assets,[source.assets[0]]);
  assert.deepEqual(prepared.bindings[0].prop?.size,{x:4,y:2,z:3});
  assert.deepEqual(prepared.bindings[1],unmatched);assert.deepEqual(prepared.bindings[2],wall);
  assert.equal(source.assets.length,2);assert.equal(original.prop?.size?.x,3);
  const noRegisteredMatch=preparePropBoundsImport([unmatched],source,[{guid:'1'.repeat(32),path:'Assets/crate.prefab',name:'crate'}]);
  assert.equal(noRegisteredMatch.updated,0);assert.equal(noRegisteredMatch.available,1);assert.equal(noRegisteredMatch.missing,1);
  assert.deepEqual(noRegisteredMatch.bindings,[unmatched]);
});

test('bounds preparation distinguishes an unscanned project from a scan with no matching prefabs',()=>{
  const source={version:1,assets:[{guid:'1'.repeat(32),size:{x:4,y:2,z:3}}]};
  assert.equal(preparePropBoundsImport([],source,null).available,1);
  assert.throws(()=>preparePropBoundsImport([],source,[]),/Unity 프로젝트.*일치/);
  assert.throws(()=>preparePropBoundsImport([],source,[{guid:'2'.repeat(32),path:'Assets/other.prefab',name:'other'}]),/같은 프로젝트/);
  assert.throws(()=>preparePropBoundsImport([],{version:1,assets:[]},null),/측정된 프리팹이 없습니다/);
  const original=binding(),before=structuredClone(original);
  assert.throws(()=>preparePropBoundsImport([original],{version:1,assets:[...source.assets,{guid:'bad',size:{x:1,y:1,z:1}}]},null),/GUID/);
  assert.deepEqual(original,before);
});

test('retained bounds match case-insensitive GUIDs and detach metadata without changing manual settings',()=>{
  const original=binding();original.prefabGuid='A'.repeat(32);original.prop!.tags=['공장'];original.scale={x:2,y:3,z:4};original.offset={x:1,y:2,z:3};original.rotationY=90;
  const source={version:1,assets:[{guid:'a'.repeat(32),size:{x:4,y:2,z:3}}]};
  const prepared=preparePropBoundsImport([original],source,[{guid:'A'.repeat(32),path:original.prefabPath,name:original.label}]);
  assert.equal(prepared.updated,1);assert.equal(prepared.missing,0);assert.equal(prepared.available,1);
  assert.deepEqual(prepared.bindings[0],{...original,prop:{...original.prop,size:{x:4,y:2,z:3}}});
  const added=applyImportedPropBounds(original,prepared.catalog);
  assert.deepEqual(added,prepared.bindings[0]);
  added.prop!.tags.push('추가');added.prop!.roomTypes.push('shop');added.scale.x=90;
  assert.deepEqual(original.prop!.tags,['공장']);assert.deepEqual(original.prop!.roomTypes,['battle']);assert.equal(original.scale.x,2);
  prepared.bindings[0].prop!.tags.push('준비');assert.deepEqual(original.prop!.tags,['공장']);
  const legacy=applyPropBoundsCatalog([original],source);legacy.bindings[0].prop!.tags.push('이전');assert.deepEqual(original.prop!.tags,['공장']);
});

test('retained bounds leave other roles and missing measurements unchanged as detached bindings',()=>{
  const original=binding(),catalog=preparePropBoundsImport([],{version:1,assets:[{guid:'1'.repeat(32),size:{x:4,y:2,z:3}}]},null).catalog;
  const wall={...original,role:'wall' as const},unmatched={...original,prefabGuid:'2'.repeat(32)};
  for(const candidate of [wall,unmatched]){
    const added=applyImportedPropBounds(candidate,catalog);assert.deepEqual(added,candidate);assert.notEqual(added,candidate);
    added.prop!.tags.push('추가');assert.deepEqual(candidate.prop!.tags,[]);
  }
  const withoutCatalog=applyImportedPropBounds(original,null);assert.deepEqual(withoutCatalog,original);assert.notEqual(withoutCatalog,original);
});

test('measured props occupy multiple cells without shrinking and retain a stable prefab ID',()=>{
  const original=map(),placed=placeProps(original,settings,[binding()]).map,p=placed.propInstances![0];
  assert.equal(original.propInstances,undefined);assert.equal(original.rows[2],'#.P....#');
  assert.deepEqual(p.cells,[{x:2,row:2},{x:3,row:2}]);assert.deepEqual(p.size,{x:3,y:1,z:2});assert.equal(p.bindingId,'crate');assert.equal(placed.rows[2],'#.PP...#');
  assert.deepEqual(propValidationIssues(placed,[binding()]),[]);
  assert.deepEqual(placeProps(placed,settings,[binding('another'),binding()]).map.propInstances,placed.propInstances);
  assert.throws(()=>assertWholeProps(placed,{x:2,row:2,width:1,height:1}),/일부/);
});

test('selection is seeded, catalog order independent, and catalog snapshots are detached',()=>{
  const a=binding('a'),b=binding('b');b.prop!.weight=4;
  assert.deepEqual(placeProps(map(),settings,[a,b]),placeProps(map(),settings,[b,a]));
  const snapshot=snapshotPropCatalog([a,b]);a.prop!.size!.x=99;assert.equal(snapshot[0].prop?.size?.x,3);
  assert.equal(placeProps(map(),settings,[{...a,prop:undefined}]).map.propInstances,undefined);
});

test('source size includes asset scale and rotation, not the decorative mesh top in ceiling logic',()=>{
  const b=binding();b.scale={x:2,y:3,z:1};b.rotationY=90;const size=propWorldSize(b)!;
  assert.ok(Math.abs(size.x-2)<1e-9);assert.equal(size.y,3);assert.ok(Math.abs(size.z-6)<1e-9);
  const p=placeProps(map(),settings,[binding()]).map.propInstances![0],m=map();p.anchor='ceiling';m.ceilings=[{x:2,row:2,undersideY:7}];assert.equal(propPosition(m,p).y,6);m.ceilings[0].undersideY=10;assert.equal(propPosition(m,p).y,9);
});

test('missing measurement, insufficient ceiling and occupied reserved area reject mandatory intents',()=>{
  const unknown=binding();delete unknown.prop!.size;assert.throws(()=>placeProps(map(),settings,[unknown]),/크기 정보/);
  const low=map();low.ceilings=Array.from({length:64},(_,i)=>({x:i%8,row:Math.floor(i/8),undersideY:.5}));assert.throws(()=>placeProps(low,settings,[binding()]),/천장/);
  assert.throws(()=>placeProps(map(),settings,[binding()],undefined,[{x:2,row:2}]),/프리팹/);
  const theme={...settings,levelDesign:{...settings.levelDesign!,theme:'forest'}},b=binding();b.prop!.tags=['factory'];assert.throws(()=>placeProps(map(),theme,[b]));
});

test('partial placement preserves outside props and rejects a footprint crossing locks or region',()=>{
  const m=map();m.lockedCells=[{x:3,row:2},{x:2,row:3}];assert.throws(()=>placeProps(m,settings,[binding()]));
  assert.throws(()=>placeProps(map(),settings,[binding()],{x:2,row:2,width:1,height:1}));
  const existing=placeProps(map(),settings,[binding()]).map;
  assert.deepEqual(placeProps(existing,settings,[binding()],{x:5,row:5,width:2,height:2}).map,existing);
});

test('prop replacement rejects terrain and ceiling collisions; decorations become one explicit instance',()=>{
  const m=map();m.rows[2]='#......#';m.fixtures=[{id:'plant',role:'decoration',x:2,row:2,direction:0,offset:{x:0,y:0,z:0}}];
  const b=binding('plant');b.role='decoration';b.prop!.blocksMovement=false;
  const placed=placeProps(m,settings,[b]).map;assert.equal(placed.propInstances?.length,1);assert.equal(placed.fixtures?.length,0);assert.equal(placed.rows[2],'#......#');
  placed.elevations[2][3]=2;assert.ok(propValidationIssues(placed,[b]).some(i=>i.code==='prop-fit'));
});

test('metadata UI edits are validated, preserve source binding and escape display text',()=>{
  const original=binding(),changed=handlePropField(original,'size','4, 2, 3');assert.deepEqual(changed.prop?.size,{x:4,y:2,z:3});assert.equal(original.prop?.size?.x,3);
  assert.deepEqual(handlePropField(original,'tags','forest, green, forest').prop?.tags,['forest','green']);
  assert.throws(()=>handlePropField(original,'roomTypes.battle',false));
  assert.throws(()=>handlePropField(original,'size','1, 2'));
  assert.equal(handlePropField(original,'size','').prop?.size,undefined);
  original.prop!.category='<script>';const html=renderPropLibraryFields(original);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('data-prop-field="size"'));
});

test('explicit prefab replacement preserves instance ID and releases old cells atomically',()=>{
  const original=placeProps(map(),settings,[binding()]).map,small=binding('small');small.prop!.size={x:1,y:1,z:1};
  const replaced=replacePropInstance(original,original.propInstances![0].id,'small',settings,[binding(),small]);
  assert.equal(replaced.propInstances![0].id,original.propInstances![0].id);assert.equal(replaced.propInstances![0].bindingId,'small');
  assert.equal(replaced.propInstances![0].cells.length,1);assert.equal(replaced.rows[2][3],'.');assert.equal(original.rows[2][3],'P');
  const tooBig=binding('giant');tooBig.prop!.size={x:20,y:20,z:20};assert.throws(()=>replacePropInstance(original,original.propInstances![0].id,'giant',settings,[binding(),tooBig]));
  assert.equal(original.propInstances![0].bindingId,'crate');
});

test('validation catches stale scale and bounding offsets after manual library edits',()=>{
  const original=placeProps(map(),settings,[binding()]).map,scaled=binding();scaled.scale.x=2;
  assert.ok(propValidationIssues(original,[scaled]).some(i=>i.code==='prop-scale-changed'));
  original.propInstances![0].offset.x=10;assert.ok(propValidationIssues(original,[binding()]).some(i=>i.code==='prop-fit'));
});

test('floor props fit under ceiling lights and wall attachments stay within the supporting wall',()=>{
  const m=map();m.fixtures=[{id:'light',role:'light',anchor:'ceiling',x:2,row:2,direction:0,offset:{x:0,y:0,z:0}}];
  assert.equal(placeProps(m,settings,[binding()]).map.propInstances?.length,1);
  const wall=map();wall.rows[2]='#......#';wall.fixtures=[{id:'plaque',role:'decoration',anchor:'wall',x:2,row:1,direction:0,offset:{x:0,y:0,z:0}}];
  const b=binding('plaque');b.role='decoration';b.prop!.placement='wall';b.prop!.blocksMovement=false;b.prop!.size={x:1,y:2,z:.2};
  const mounted=placeProps(wall,settings,[b]).map,p=mounted.propInstances![0];assert.equal(propPosition(mounted,p,b).y,1);assert.ok(Math.abs(p.offset.z-.9)<1e-6);assert.deepEqual(propValidationIssues(mounted,[b]),[]);
  b.prop!.size.y=5;assert.throws(()=>placeProps(wall,settings,[b]),/프리팹/);
});
