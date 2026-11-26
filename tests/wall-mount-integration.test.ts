import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProject } from '../electron/services/projects';
import { removeAssetBindings } from '../src/shared/asset-deletion';
import { captureRegion, mergeGeneratedRegion, pasteRegion } from '../src/shared/editing';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, generationConditionIssues, reapplyLighting } from '../src/shared/features';
import { buildManifest, DEFAULT_SETTINGS, parseBindings, parseProjectFile, validateMap } from '../src/shared/map';
import { importPropCatalogBindings } from '../src/shared/prop-catalog-import';
import { insertPropInstance, parsePropBoundsCatalog, placeProps, propCatalogPrompt, snapshotPropCatalog, suggestPropDefinition } from '../src/shared/props';
import { DEFAULT_STRUCTURE_SETTINGS, synchronizeStructures } from '../src/shared/structures';
import type { AssetBinding, GenerationSettings, GridMap, ProjectFile } from '../src/shared/types';
import { DEFAULT_WALL_SETTINGS, defaultWallMount, placeWallMounts, wallMountIssues } from '../src/shared/wall-mounts';

const base=(id:string,role:AssetBinding['role'],index:number):AssetBinding=>({id,label:id,role,prefabGuid:String(index).repeat(32),prefabPath:`Assets/${id}.prefab`,scale:{x:1,y:1,z:1},offset:{x:0,y:0,z:0},rotationY:0});
function lamp():AssetBinding{
  const b=base('wall_lamp','light',4);b.bounds={center:{x:.7,y:.2,z:.15},size:{x:.6,y:.4,z:.3}};b.wallMount=defaultWallMount(b);return b;
}
const catalog=()=>[base('floor','floor',1),base('wall','wall',2),base('door','door',3),lamp()];
const settings=():GenerationSettings=>({...DEFAULT_SETTINGS,connectionWidth:2,width:8,height:8,connectionCount:1,seed:27,designer:{...DEFAULT_DESIGNER,elevation:false,props:false,structureFill:true,wallMounts:{...DEFAULT_WALL_SETTINGS,enabled:true,runs:false,density:35}}});
function room():GridMap{return synchronizeStructures({version:5,name:'Wall Integration',width:8,height:8,cellSize:2,maxStepHeight:.4,rows:['####D###',...Array(6).fill('#......#'),'########'],elevations:Array.from({length:8},()=>Array(8).fill(0)),ramps:[],connections:[{id:'entry',label:'Entry',x:4,row:0,direction:0,width:2,height:3,kind:'door'}],assetOverrides:[],structureSettings:{...DEFAULT_STRUCTURE_SETTINGS}});}
function project():ProjectFile{const bindings=catalog();const placed=placeWallMounts(room(),settings(),bindings);assert.ok(placed.addedSingles>0);return{formatVersion:1,map:placed.map,settings:settings(),bindings};}

test('catalog v2 imports pivot bounds and wall light metadata while v1 remains unchanged',()=>{
  const b=lamp(),entry={guid:b.prefabGuid,size:b.bounds!.size,bounds:b.bounds,wallMount:b.wallMount};
  const parsed=parsePropBoundsCatalog({version:2,assets:[entry]});
  const imported=importPropCatalogBindings([],parsed,[{guid:b.prefabGuid,path:b.prefabPath,name:b.label}],'light').bindings[0];
  assert.equal(imported.role,'light');assert.equal(imported.prop,undefined);assert.deepEqual(imported.bounds,b.bounds);assert.deepEqual(imported.wallMount,b.wallMount);
  assert.deepEqual(parseBindings([imported]),[imported]);
  assert.deepEqual(parsePropBoundsCatalog({version:1,assets:[{guid:b.prefabGuid,size:b.bounds!.size}]}),{version:1,assets:[{guid:b.prefabGuid,size:b.bounds!.size}]});
  assert.throws(()=>parsePropBoundsCatalog({version:2,assets:[{...entry,bounds:{...b.bounds,size:{x:9,y:9,z:9}}}]}));
  assert.throws(()=>parsePropBoundsCatalog({version:2,assets:[{...entry,wallMount:{...b.wallMount,execute:'untrusted'}}]}));
});

test('save, recovery normalization and Unity manifest retain resolved wall poses without pivot recentering',()=>{
  const p=project(),before=structuredClone(p),loaded=parseProjectFile(normalizeProject(p));
  assert.deepEqual(loaded.map.fixtures,p.map.fixtures);assert.deepEqual(loaded.bindings,p.bindings);
  assert.deepEqual(wallMountIssues(loaded.map,loaded.bindings),[]);
  const manifest=buildManifest(loaded.map,loaded.bindings);
  for(const f of loaded.map.fixtures!.filter(f=>f.wall)){
    const item=manifest.placements.find(i=>i.id===`fixture-${f.id}`)!;assert.equal(item.surface,'pivot');assert.equal(item.centerXZ,undefined);
    assert.deepEqual(item.position,f.wall!.position);assert.equal(item.rotation.y,f.wall!.rotationY);
  }
  loaded.map.fixtures![0].wall!.position.x+=1;assert.deepEqual(p,before,'parsed nested wall fields must be detached');
});

test('wall light generation is independent of generic light and floor decoration toggles',()=>{
  const b=lamp();b.wallMount!.sites=['doorTop'];const bindings=[...catalog().slice(0,3),b];
  const map=applyGeneratedFeatures(room(),settings(),undefined,bindings);
  assert.ok(map.fixtures?.some(f=>f.wall?.doorId==='entry'));
  assert.deepEqual(generationConditionIssues(map,settings()).filter(i=>i.severity==='error'),[]);
  const again=reapplyLighting(map,{...settings(),designer:{...settings().designer!,lights:true}},undefined,bindings);
  assert.deepEqual(again.fixtures,map.fixtures,'legacy lighting must not delete or duplicate managed door lights');
});

test('generation snapshots retain wall lights and decorations while floor placement excludes them',()=>{
  const light=lamp(),b={...lamp(),id:'wall_decoration',role:'decoration' as const};b.prop={...suggestPropDefinition(b),size:b.bounds!.size};
  const snapshot=snapshotPropCatalog([light,b]);assert.deepEqual(snapshot,[light,b]);assert.equal(propCatalogPrompt(snapshot),'');
  const map=room();map.fixtures=[{id:'floor_decoration',role:'decoration',x:3,row:3,direction:0,offset:{x:0,y:0,z:0},anchor:'floor'}];
  const placed=placeProps(map,settings(),snapshot);assert.equal(placed.map.propInstances?.length??0,0);assert.deepEqual(placed.map.fixtures,map.fixtures);
  const generated=applyGeneratedFeatures(room(),settings(),undefined,snapshot);assert.ok(generated.fixtures?.some(f=>f.wall&&f.bindingId==='wall_lamp'));
});

test('manual floor placement rejects collision with mounted objects without changing the source',()=>{
  const p=project(),before=structuredClone(p.map),at=p.map.fixtures!.find(f=>!f.wall!.doorId)!;
  const tall=base('cabinet','prop',5);tall.prop={...suggestPropDefinition(tall),size:{x:1.98,y:3.9,z:1.98}};
  assert.throws(()=>insertPropInstance(p.map,at,tall.id,settings(),[...p.bindings,tall]),/겹|충돌/);assert.deepEqual(p.map,before);
});

test('managed-only lighting catalogs still protect references to legacy lights',()=>{
  const map=room();map.fixtures=[{id:'old_light',role:'light',x:1,row:0,direction:180,offset:{x:0,y:0,z:0},anchor:'wall'},{id:'control',role:'switch',x:2,row:2,direction:0,offset:{x:0,y:0,z:0},linkedId:'old_light'}];
  assert.throws(()=>reapplyLighting(map,settings(),undefined,[lamp()]),/참조/);
});

test('regular generation preserves both ceiling and mounted light registrations',()=>{
  const ceiling=base('ceiling_light','light',6);ceiling.lightAnchor='ceiling';
  const config=settings();config.designer={...config.designer!,ceilings:true,lights:true,lightPlacement:'ceiling'};
  const all=[...catalog(),ceiling],snapshot=snapshotPropCatalog(all);
  assert.ok(snapshot.some(b=>b.id===ceiling.id));
  const generated=applyGeneratedFeatures(room(),config,undefined,snapshot);
  assert.ok(generated.fixtures?.some(f=>f.wall));assert.ok(generated.fixtures?.some(f=>f.role==='light'&&!f.wall&&f.anchor==='ceiling'));
  assert.equal(propCatalogPrompt(snapshot),'');
});

test('whole region copy rotates wall support and world bounds while rejecting partial and mirrored copies',()=>{
  const p=project(),rect={x:0,row:0,width:8,height:8},snapshot=captureRegion(p.map,rect);
  const rotated=pasteRegion(p.map,snapshot,{x:0,row:0},{rotate90:1});
  assert.deepEqual(validateMap(rotated).filter(i=>i.severity==='error'),[]);assert.deepEqual(wallMountIssues(rotated,p.bindings),[]);
  assert.equal(rotated.fixtures!.filter(f=>f.wall).length,p.map.fixtures!.length);
  assert.throws(()=>pasteRegion(p.map,snapshot,{x:0,row:0},{mirrorX:true}),/대칭/);
  const f=p.map.fixtures![0];assert.throws(()=>captureRegion(p.map,{x:f.x,row:f.row,width:1,height:1}),/지지 벽/);
});

test('regional regeneration preserves mounted fixtures and their supporting cells',()=>{
  const p=project(),candidate=room();const result=mergeGeneratedRegion(p.map,candidate,{x:0,row:0,width:8,height:8});
  assert.deepEqual(result.fixtures,p.map.fixtures);assert.deepEqual(wallMountIssues(result,p.bindings),[]);
});

test('deleting a mounted asset removes its objects, preserves floors, and honors support locks',()=>{
  const p=project(),before=structuredClone(p),result=removeAssetBindings(p,['wall_lamp']);
  assert.equal(result.removedWallFixtures,p.map.fixtures!.length);assert.equal(result.project.map.fixtures?.length,0);assert.deepEqual(result.project.map.rows,p.map.rows);assert.deepEqual(p,before);
  p.map.lockedCells=[p.map.fixtures![0].wall!.support[0]];assert.throws(()=>removeAssetBindings(p,['wall_lamp']),/잠긴/);
});
