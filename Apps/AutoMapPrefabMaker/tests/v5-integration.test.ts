import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManifest, DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { captureRegion, mergeGeneratedRegion, pasteRegion } from '../src/shared/editing';
import { configureStructures, DEFAULT_STRUCTURE_SETTINGS } from '../src/shared/structures';
import { insertPropInstance, placeProps, propPosition, propValidationIssues, removePropInstance } from '../src/shared/props';
import { normalizeProject, serializeProject } from '../electron/services/projects';
import type { AssetBinding, AssetRole, GenerationSettings, GridMap, ProjectFile } from '../src/shared/types';

const settings:GenerationSettings={...DEFAULT_SETTINGS,width:10,height:10,connectionCount:1,sizeMode:'custom',seed:47};
function floor():GridMap {
  return {version:5,name:'V5 integration',width:10,height:10,cellSize:2,rows:['####D#####',...Array(8).fill('#........#'),'##########'],elevations:Array.from({length:10},()=>Array(10).fill(0)),ramps:[],connections:[{id:'entry',label:'입구',x:4,row:0,direction:0,width:2,height:3,kind:'default'}],assetOverrides:[],maxStepHeight:.4};
}
function asset(role:AssetRole,id:string=role):AssetBinding {
  const guid=Array.from(id).reduce((n,c)=>n+c.charCodeAt(0),0).toString(16).padStart(32,'0');
  return {id,label:id,role,prefabGuid:guid,prefabPath:`Assets/${id}.prefab`,scale:{x:1,y:1,z:1},offset:{x:0,y:0,z:0},rotationY:0,
    ...(['prop','decoration'].includes(role)?{prop:{category:'가구',tags:[],blocksMovement:role==='prop',size:{x:3,y:1,z:2},placement:'floor' as const,roomTypes:['battle' as const],weight:1}}:{})};
}
const bindings=()=>['floor','wall','door','ceiling','deadzone','cliff','prop'].map(role=>asset(role as AssetRole));
function furnished():GridMap {const map=floor();map.rows[2]='#.P......#';return placeProps(map,settings,[asset('prop')]).map;}

test('v5 project save/recovery retains measured instances, catalog and automatic structures',()=>{
  const source=furnished();source.rows[5]='#...._...#';source.ceilings=[{x:2,row:2,undersideY:4}];
  const map=configureStructures(source,DEFAULT_STRUCTURE_SETTINGS),project:ProjectFile={formatVersion:1,map,settings,bindings:bindings()};
  const loaded=normalizeProject(JSON.parse(serializeProject(project)));
  assert.equal(loaded.map.version,5);assert.deepEqual(loaded.map.propInstances,map.propInstances);assert.deepEqual(loaded.map.structureSettings,map.structureSettings);
  assert.deepEqual(loaded.map.pitBottoms,map.pitBottoms);assert.deepEqual(loaded.map.structureFills,map.structureFills);assert.deepEqual(loaded.bindings,project.bindings);
  assert.equal(loaded.map.ceilings![0].heightMode,'auto');assert.deepEqual(validateMap(loaded.map).filter(i=>i.severity==='error'),[]);
});

test('v5 export emits one stable measured prefab and exactly fitted pit and structural geometry',()=>{
  const source=furnished();source.rows[5]='#...._...#';const map=configureStructures(source,DEFAULT_STRUCTURE_SETTINGS),library=bindings();
  const manifest=buildManifest(map,library),prop=manifest.placements.filter(p=>p.id.startsWith('prop-instance-'));
  assert.equal(manifest.schemaVersion,5);assert.equal(prop.length,1);assert.equal(manifest.placements.filter(p=>p.role==='prop').length,1);
  assert.deepEqual(prop[0].position,propPosition(map,map.propInstances![0],library.find(b=>b.id==='prop')));assert.equal(prop[0].fitSize,undefined);assert.equal(prop[0].centerXZ,true);assert.deepEqual(prop[0].scale,{x:1,y:1,z:1});
  for(const fill of map.structureFills!){
    const placed=manifest.placements.find(p=>p.id===`fill-${fill.id}`)!;
    const trim=(fill.purpose==='pitSide'||fill.purpose==='heightGap') ? .24 : 0;
    assert.deepEqual(placed.fitSize,{...fill.size,y:fill.size.y-trim});
    assert.deepEqual(placed.position,{...fill.position,y:fill.position.y-trim/2});
    assert.equal(placed.position.y-placed.fitSize!.y/2,fill.position.y-fill.size.y/2);
  }
  const bottom=map.pitBottoms![0],pit=manifest.placements.find(p=>p.id===`pit-${bottom.x}-${bottom.row}`)!;assert.equal(pit.position.y,bottom.y-bottom.thickness/2);assert.equal(pit.fitSize?.y,1);
  const reordered=buildManifest(map,[asset('prop','newVariant'),...library.reverse()]);assert.deepEqual(reordered.placements.find(p=>p.id===prop[0].id),prop[0]);
});

test('ceiling prop export matches bottom-aligned preview placement and tracks automatic roof movement',()=>{
  const map=floor();map.ceilings=Array.from({length:100},(_,i)=>({x:i%10,row:Math.floor(i/10),undersideY:7})).filter(c=>map.rows[c.row][c.x]!=='#');
  const decoration=asset('decoration','hanging');decoration.prop!.size={x:1,y:2,z:1};decoration.prop!.placement='ceiling';decoration.prop!.weight=0;
  const library=[...bindings(),decoration],placed=insertPropInstance(map,{x:2,row:2},decoration.id,settings,library);
  const instance=placed.propInstances![0],exported=buildManifest(placed,library).placements.find(p=>p.id===`prop-instance-${instance.id}`)!;
  assert.deepEqual(exported.position,propPosition(placed,instance,decoration));assert.equal(exported.position.y,5);assert.equal(exported.surface,'bottom');assert.equal(exported.centerXZ,true);
  for(const roof of placed.ceilings!)roof.undersideY=10;assert.equal(propPosition(placed,instance,decoration).y,8);
  const removed=removePropInstance(placed,instance.id);assert.equal(removed.propInstances?.length,0);assert.equal(removed.rows[2][2],'.');
});

test('copy, rotate and mirror transform the entire footprint and filled world geometry',()=>{
  const map=furnished();map.structureFills=[{id:'under-side',x:2,row:3,role:'wall',purpose:'heightGap',direction:90,position:{x:-5,y:-1,z:3},size:{x:2,y:1,z:.2}}];
  const snapshot=captureRegion(map,{x:2,row:2,width:2,height:2});
  const result=pasteRegion(map,snapshot,{x:5,row:5},{rotate90:1}),copy=result.propInstances!.at(-1)!;
  assert.equal(copy.bindingId,'prop');assert.notEqual(copy.id,map.propInstances![0].id);assert.equal(copy.direction,90);assert.deepEqual(copy.size,{x:2,y:1,z:3});
  assert.deepEqual(copy.cells,[{x:6,row:5},{x:6,row:6}]);assert.deepEqual(copy.offset,{x:0,y:0,z:-1});assert.deepEqual(propValidationIssues(result,[asset('prop')]),[]);
  const fill=result.structureFills!.at(-1)!;assert.deepEqual(fill.position,{x:1,y:-1,z:-1});assert.deepEqual(fill.size,{x:.2,y:1,z:2});assert.equal(fill.direction,180);
  const mirrored=pasteRegion(floor(),snapshot,{x:5,row:5},{mirrorX:true});assert.equal(mirrored.propInstances![0].bindingId,'prop');assert.deepEqual(propValidationIssues(mirrored,[asset('prop')]),[]);
  assert.throws(()=>captureRegion(map,{x:2,row:2,width:1,height:2}),/일부/);assert.throws(()=>pasteRegion(map,snapshot,{x:3,row:2}),/일부/);
});

test('partial regeneration protects a complete object if any footprint cell is locked',()=>{
  const original=furnished();original.lockedCells=[{x:3,row:2}];const before=structuredClone(original),candidate=floor();
  const result=mergeGeneratedRegion(original,candidate,{x:2,row:2,width:2,height:2});
  assert.deepEqual(result.propInstances,original.propInstances);assert.equal(result.rows[2].slice(2,4),'PP');assert.deepEqual(original,before);
  const overlap=floor();overlap.rows[2]='#P.......#';const crossing=placeProps(overlap,settings,[asset('prop')]).map;
  assert.throws(()=>mergeGeneratedRegion(original,crossing,{x:1,row:1,width:4,height:3}),/잠금/);
});

test('partial regeneration rejects cut candidate footprints and remaps retained instance IDs',()=>{
  const original=furnished(),candidate=floor();candidate.rows[5]='#....P...#';const generated=placeProps(candidate,settings,[asset('prop')]).map;
  generated.propInstances![0].id=original.propInstances![0].id;
  assert.throws(()=>mergeGeneratedRegion(original,generated,{x:5,row:5,width:1,height:1}),/일부/);
  const result=mergeGeneratedRegion(original,generated,{x:5,row:5,width:2,height:2});
  assert.equal(result.propInstances!.length,2);assert.equal(new Set(result.propInstances!.map(p=>p.id)).size,2);assert.equal(result.propInstances![1].bindingId,'prop');
});

test('legacy v4 loads without enabling automatic ceilings or measured prop reassignment',()=>{
  const map=floor();map.version=4;map.ceilings=[{x:2,row:2,undersideY:3.5}];map.rows[2]='#.P......#';
  const loaded=parseProjectFile({formatVersion:1,map,settings,bindings:bindings()});
  assert.equal(loaded.map.version,4);assert.equal(loaded.map.ceilings![0].undersideY,3.5);assert.equal(loaded.map.ceilings![0].heightMode,undefined);
  assert.equal(loaded.map.propInstances,undefined);assert.equal(loaded.map.structureSettings,undefined);assert.equal(loaded.map.rows[2][2],'P');
  assert.equal(buildManifest(loaded.map,bindings()).placements.find(p=>p.role==='prop')?.centerXZ,undefined);
});

test('v5-only map data cannot masquerade as legacy schema during save or export',()=>{
  for(const version of [3,4] as const){
    for(const extra of [{propInstances:[]},{structureFills:[]},{pitBottoms:[]},{structureSettings:DEFAULT_STRUCTURE_SETTINGS},{ceilings:[{x:2,row:2,undersideY:4,heightMode:'manual'}]},{wallHeights:[{x:0,row:0,height:4,heightMode:'auto'}]}]){
      const map={...floor(),version,...extra};assert.throws(()=>parseProjectFile({formatVersion:1,map,settings,bindings:bindings()}),/version 5/);
    }
  }
  assert.equal(parseProjectFile({formatVersion:1,map:{...floor(),propInstances:[]},settings,bindings:bindings()}).map.version,5);
});
