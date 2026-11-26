import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, generationConditionIssues, parseGenerationSettings } from '../src/shared/features';
import { buildManifest, DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { captureRegion, mergeGeneratedRegion, pasteRegion } from '../src/shared/editing';
import { applyRoomPreset } from '../src/shared/room-presets';
import { generateVariants } from '../src/shared/variants';
import { teleportIssues, teleportReservedCells } from '../src/shared/teleport';
import { imagePrompt, directLayoutPrompt } from '../electron/services/prompts';
import { publicProject } from '../electron/services/validation';
import { serializeProject } from '../electron/services/projects';
import { furnishExistingMap, rearrangeMapProps } from '../src/shared/furnishing';
import type { AssetBinding, GenerationSettings, GridMap, ProjectFile } from '../src/shared/types';

const bindings: AssetBinding[] = (['floor','wall','door'] as const).map((role,i)=>({id:role,label:role,role,prefabGuid:String(i+1).repeat(32),prefabPath:`Assets/${role}.prefab`,scale:{x:1,y:1,z:1},offset:{x:0,y:0,z:0},rotationY:0}));
function room():GridMap {return {version:4,name:'Teleport room',width:8,height:8,cellSize:2,maxStepHeight:.4,rows:['#D######','#......#','#......#','#......#','#......#','#......#','#......#','########'],elevations:Array.from({length:8},()=>Array(8).fill(0)),ramps:[],connections:[{id:'north',label:'North',kind:'door',x:1,row:0,direction:0,width:2,height:3}],assetOverrides:[]};}
function settings(count=1):GenerationSettings{return {...DEFAULT_SETTINGS,conceptMode:'manual',prompt:'안전한 순간이동 장소를 가진 방',width:8,height:8,connectionCount:1,connectionWidth:2,seed:12,designer:{...DEFAULT_DESIGNER,elevation:false,props:false,teleports:true,teleportCount:count}};}
function project(map=room()):ProjectFile{return {formatVersion:1,map,settings:settings(),bindings:structuredClone(bindings)};}

test('teleport settings are opt-in, strictly parsed, and retained by room presets',()=>{
  assert.equal(parseGenerationSettings({...DEFAULT_SETTINGS,designer:{}}).designer?.teleports,false);
  assert.equal(parseGenerationSettings({...DEFAULT_SETTINGS,designer:{}}).designer?.teleportCount,1);
  for(const teleportCount of [0,65,1.5,NaN])assert.throws(()=>parseGenerationSettings({...settings(),designer:{...settings().designer,teleportCount}}),/1~64/);
  assert.throws(()=>parseGenerationSettings({...settings(),designer:{teleports:'yes'}}));
  const s=applyRoomPreset(settings(4),'shop');assert.equal(s.designer?.teleports,true);assert.equal(s.designer?.teleportCount,4);
  assert.equal(applyGeneratedFeatures(room(),{...settings(),designer:{...settings().designer!,teleports:false}}).markers?.length,0);
});

test('completed generated destinations survive save, independent clone and manifest export',()=>{
  const map=applyGeneratedFeatures(room(),settings(3),undefined,bindings),p=project(map);p.settings=settings(3);
  assert.equal(map.markers?.length,3);assert.deepEqual(validateMap(map,bindings).filter(i=>i.severity==='error'),[]);
  assert.deepEqual(generationConditionIssues(map,p.settings),[]);
  const reopened=parseProjectFile(JSON.parse(serializeProject(publicProject(p))));
  assert.deepEqual(reopened.map.markers,map.markers);
  reopened.settings.designer!.headroom=5;
  const manifest=buildManifest(reopened.map,reopened.bindings);
  assert.deepEqual(manifest.markers[0].clearance,{radius:.4,height:2});
  assert.equal(manifest.markers[0].kind,'teleport');assert.equal(manifest.markers[0].position.y,0);
  manifest.markers[0].clearance!.radius=4;assert.equal(reopened.map.markers![0].clearance!.radius,.4);
  for(const clearance of [undefined,{radius:0,height:2},{radius:.4,height:21},{radius:.4,height:2,extra:true}]){
    const bad=structuredClone(p);bad.map.markers![0].clearance=clearance;assert.throws(()=>parseProjectFile(bad));
  }
  const bad=structuredClone(p);bad.map.markers![0].offset.y=1;assert.throws(()=>buildManifest(bad.map,bad.bindings),/순간이동/);
});

test('teleport clearance is deep-copied with rotated region markers',()=>{
  const map=room();map.markers=[{id:'landing',label:'도착',kind:'teleport',contentKey:'arrival',x:2,row:2,direction:0,offset:{x:.2,y:0,z:0},clearance:{radius:.4,height:2}}];
  const captured=captureRegion(map,{x:1,row:1,width:3,height:3});
  const copied=pasteRegion(map,captured,{x:4,row:4},{rotate90:1});
  assert.equal(copied.markers!.length,2);const m=copied.markers![1];assert.equal(m.direction,90);assert.equal(m.offset.z,-.2);
  assert.deepEqual(m.clearance,map.markers[0].clearance);assert.deepEqual(teleportIssues(copied,bindings),[]);
  m.clearance!.radius=1;assert.equal(map.markers[0].clearance!.radius,.4);
});

test('partial regeneration protects outside landing footprints and fills the total target',()=>{
  const map=room();map.markers=[{id:'outside',label:'보존',kind:'teleport',contentKey:'keep',x:2,row:3,direction:90,offset:{x:.5,y:0,z:0},clearance:{radius:.8,height:2}}];
  const rect={x:3,row:2,width:4,height:4},candidate=room();candidate.rows[3]='#..#...#';
  const before=structuredClone(map);const result=mergeGeneratedRegion(map,candidate,rect,m=>applyGeneratedFeatures(m,settings(2),rect,bindings),bindings);
  assert.equal(result.rows[3][3],'.');assert.deepEqual(result.markers?.find(m=>m.id==='outside'),before.markers![0]);
  assert.equal(result.markers?.length,2);assert.deepEqual(teleportIssues(result,bindings),[]);assert.deepEqual(map,before);
  assert.ok(teleportReservedCells(map).some(c=>c.x===3&&c.row===3));
  const locked=structuredClone(result);locked.lockedCells=locked.markers!.map(m=>({x:m.x,row:m.row}));
  assert.throws(()=>applyGeneratedFeatures(locked,settings(1),rect,bindings),/순간이동/);
  assert.deepEqual(map,before);
});

test('terrain prompts reserve safe floor without asking AI to emit markers',()=>{
  for(const prompt of [imagePrompt(settings(2)),directLayoutPrompt(settings(2))]){
    assert.match(prompt,/Teleport destinations/);assert.match(prompt,/2 destinations/);assert.match(prompt,/No enemy-distance requirement/);assert.match(prompt,/do not emit marker coordinates/);
  }
});

test('automatic furnishing and rearrangement preserve the entire saved landing area',()=>{
  const map=room();map.width=map.height=16;map.rows=['########D#######',...Array(14).fill('#..............#'),'################'];
  map.elevations=Array.from({length:16},()=>Array(16).fill(0));map.connections[0].x=8;
  map.markers=[{id:'arrival',label:'도착',kind:'teleport',contentKey:'keep',x:5,row:7,direction:90,offset:{x:.5,y:0,z:0},clearance:{radius:.8,height:2}}];
  const asset:AssetBinding={id:'crate',label:'Crate',role:'prop',prefabGuid:'a'.repeat(32),prefabPath:'Assets/crate.prefab',scale:{x:1,y:1,z:1},rotationY:0,offset:{x:0,y:0,z:0},
    prop:{category:'storage',tags:[],blocksMovement:true,size:{x:1.2,y:1,z:1.2},placement:'floor',roomTypes:['shop'],weight:1,composition:{usage:'storage',family:'crates',member:'either',arrangement:'either'}}};
  const s:GenerationSettings={...settings(),width:16,height:16,designer:{...settings().designer!,preset:'shop',props:true,propLayout:'grouped',propCoverage:5},levelDesign:{pattern:'openArena',characterRadius:.4,dodgeDistance:3}};
  const catalog=[...bindings,asset],before=structuredClone(map);
  const furnished=furnishExistingMap(map,s,catalog,{props:true,decorations:false});
  assert.ok(furnished.addedProps>0,JSON.stringify(furnished.issues));
  const rearranged=rearrangeMapProps(furnished.map,s,catalog,{props:true,decorations:false});
  const reserved=new Set(teleportReservedCells(map).map(c=>`${c.x},${c.row}`));assert.ok(reserved.size>1);
  for(const result of [furnished,rearranged]){
    assert.deepEqual(result.map.markers,map.markers);assert.deepEqual(teleportIssues(result.map,catalog),[]);
    assert.ok(result.map.propInstances?.every(p=>p.cells.every(c=>!reserved.has(`${c.x},${c.row}`))));
  }
  assert.deepEqual(map,before);
});

test('image and direct variant batches retain generated safe destinations',async()=>{
  for(const generationMethod of ['image','direct'] as const){
    const p=project();p.settings={...settings(2),generationMethod};let counter=0;
    const create=async(s:GenerationSettings)=>{const map=room();if(counter++)map.rows[5]='#.....##';return applyGeneratedFeatures(map,s,undefined,bindings);};
    const variants=await generateVariants(p,2,{generateImage:async()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',extractLayout:async s=>create(s),generateLayout:create,isCancelled:()=>false});
    assert.equal(variants.filter(v=>v.status==='ready').length,2,JSON.stringify(variants.map(v=>v.error)));
    for(const v of variants){assert.equal(v.project!.map.markers?.filter(m=>m.kind==='teleport').length,2);assert.deepEqual(teleportIssues(v.project!.map,bindings),[]);}
    assert.equal(p.map.markers,undefined);
  }
});
