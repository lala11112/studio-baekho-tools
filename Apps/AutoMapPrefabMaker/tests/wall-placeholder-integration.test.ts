import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProject } from '../electron/services/projects';
import { removeAssetBindings } from '../src/shared/asset-deletion';
import { captureRegion, mergeGeneratedRegion, pasteRegion } from '../src/shared/editing';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, generationConditionIssues, parseGenerationSettings } from '../src/shared/features';
import { resolveFixtureBinding } from '../src/shared/light-bindings';
import { buildManifest, DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { DEFAULT_STRUCTURE_SETTINGS, synchronizeStructures } from '../src/shared/structures';
import type { AssetBinding, GenerationSettings, GridMap, ProjectFile } from '../src/shared/types';
import { editWallMount, wallMountIssues } from '../src/shared/wall-mounts';
import { placeholderWallBinding, WALL_PLACEHOLDER_KINDS } from '../src/shared/wall-placeholders';

const settings = ():GenerationSettings => ({...DEFAULT_SETTINGS,width:8,height:8,connectionCount:1,seed:27,designer:{...DEFAULT_DESIGNER,elevation:false,props:false,structureFill:true,wallMounts:{enabled:true,singles:true,runs:true,density:30,runDensity:100}}});
function room():GridMap{return synchronizeStructures({version:5,name:'Temporary wall layout',width:8,height:8,cellSize:2,maxStepHeight:.4,rows:['####D###',...Array(6).fill('#......#'),'########'],elevations:Array.from({length:8},()=>Array(8).fill(0)),ramps:[],connections:[{id:'entry',label:'Entry',x:4,row:0,direction:0,width:2,height:3,kind:'door'}],assetOverrides:[],structureSettings:{...DEFAULT_STRUCTURE_SETTINGS}});}
function project():ProjectFile{return {formatVersion:1,map:applyGeneratedFeatures(room(),settings()),settings:settings(),bindings:[]};}
const realBindings=():AssetBinding[]=>WALL_PLACEHOLDER_KINDS.map((kind,index)=>{const b=placeholderWallBinding(kind);b.id=`real_${kind}`;b.prefabGuid=(index+1).toString(16).repeat(32);b.prefabPath=`Assets/${kind}.prefab`;b.label=kind;if(b.wallMount!.kind!=='single')b.wallMount!.family='native_pipe';return b;});
const structuralBindings=():AssetBinding[]=>['floor','wall','door'].map((role,index)=>({id:role,label:role,role:role as AssetBinding['role'],prefabGuid:(index+10).toString(16).repeat(32),prefabPath:`Assets/${role}.prefab`,scale:{x:1,y:1,z:1},offset:{x:0,y:0,z:0},rotationY:0}));

test('fresh generation with no catalog creates placeholders, including door lights, and round trips without fabricated assets',()=>{
  const p=project();assert.ok(p.map.fixtures!.length>0);assert.ok(p.map.fixtures!.some(f=>f.wall?.placeholder==='doorLight'));
  assert.ok(p.map.fixtures!.some(f=>f.wall?.runId));assert.ok(p.map.fixtures!.every(f=>f.wall?.placeholder&&!f.bindingId&&!f.wall.bindingReference));
  assert.deepEqual(p.bindings,[]);assert.deepEqual(generationConditionIssues(p.map,p.settings).filter(i=>i.severity==='error'),[]);
  assert.deepEqual(validateMap(p.map).filter(i=>i.severity==='error'),[]);assert.deepEqual(wallMountIssues(p.map,[]),[]);
  const loaded=parseProjectFile(JSON.parse(JSON.stringify(normalizeProject(p))));assert.deepEqual(loaded.map.fixtures,p.map.fixtures);assert.deepEqual(loaded.bindings,[]);
  const old=structuredClone(p.map.fixtures);loaded.map.fixtures![0].wall!.position.y+=1;assert.deepEqual(p.map.fixtures,old);
  assert.throws(()=>buildManifest(p.map,[]),/임시 벽 부착물.*실제 프리팹/);
});

test('registering matching real assets does not silently resolve placeholders, but explicit replacement makes a valid native manifest',()=>{
  const p=project(),bindings=[...structuralBindings(),...realBindings()];
  for(const f of p.map.fixtures!)assert.equal(resolveFixtureBinding(p.map,bindings,f),undefined);
  assert.throws(()=>buildManifest(p.map,bindings),/임시 벽 부착물/);
  let map=p.map;for(const f of p.map.fixtures!)map=editWallMount(map,f.id,{bindingId:`real_${f.wall!.placeholder}`},bindings);
  assert.ok(map.fixtures!.every(f=>!f.wall?.placeholder&&f.bindingId));assert.deepEqual(wallMountIssues(map,bindings),[]);
  const manifest=buildManifest(map,bindings);for(const f of map.fixtures!){const placement=manifest.placements.find(v=>v.id===`fixture-${f.id}`)!;assert.equal(placement.surface,'pivot');assert.deepEqual(placement.position,f.wall!.position);}
  assert.ok(p.map.fixtures!.every(f=>f.wall?.placeholder),'replacement leaves source map untouched');
});

test('temporary walls survive region rotation, regeneration and unrelated asset deletion',()=>{
  const p=project(),region={x:0,row:0,width:8,height:8},snapshot=captureRegion(p.map,region);
  const rotated=pasteRegion(p.map,snapshot,{x:0,row:0},{rotate90:1});assert.deepEqual(wallMountIssues(rotated,[]),[]);assert.equal(rotated.fixtures!.filter(f=>f.wall?.placeholder).length,p.map.fixtures!.length);
  assert.deepEqual(mergeGeneratedRegion(p.map,room(),region).fixtures,p.map.fixtures);
  p.bindings=realBindings();const deleted=removeAssetBindings(p,[p.bindings[0].id]);assert.deepEqual(deleted.project.map.fixtures,p.map.fixtures);
});

test('fallback can be explicitly disabled and malformed or ambiguous placeholder references cannot be saved',()=>{
  const config=settings();config.designer!.wallMounts!.placeholderFallback=false;assert.equal(applyGeneratedFeatures(room(),config,undefined,[]).fixtures?.filter(f=>f.wall).length??0,0);
  assert.equal(parseGenerationSettings(config).designer!.wallMounts!.placeholderFallback,false);
  assert.throws(()=>parseGenerationSettings({...config,designer:{...config.designer,wallMounts:{...config.designer!.wallMounts,placeholderFallback:'yes'}}}));
  const p=project();p.map.fixtures![0].bindingId='real_asset';assert.throws(()=>parseProjectFile(p),/임시 부착물/);
});
