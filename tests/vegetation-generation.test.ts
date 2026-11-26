import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, generationConditionIssues, parseGenerationSettings } from '../src/shared/features';
import { analyzeLevelDesign, DEFAULT_LEVEL_DESIGN } from '../src/shared/level-design';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import { propValidationIssues } from '../src/shared/props';
import type { AssetBinding, Cell, GenerationSettings, GridMap } from '../src/shared/types';

function room(): GridMap {
  const size=16,rows=Array.from({length:size},(_,row)=>row===0||row===size-1?'#'.repeat(size):`#${'.'.repeat(size-2)}#`);
  rows[0]='#'.repeat(8)+'D'+'#'.repeat(7);
  return {version:5,name:'분리 배치 검증',width:size,height:size,cellSize:2,rows,elevations:Array.from({length:size},()=>Array(size).fill(0)),ramps:[],maxStepHeight:.4,connections:[{id:'north',label:'북쪽',x:8,row:0,direction:0,width:2,height:3,kind:'door'}],assetOverrides:[]};
}
function settings(levelDesign=false): GenerationSettings {
  return {...DEFAULT_SETTINGS,connectionWidth:2,seed:17,designer:{...DEFAULT_DESIGNER,elevation:false,props:false},...(levelDesign?{levelDesign:{...DEFAULT_LEVEL_DESIGN,pattern:'openArena' as const}}:{})};
}
const dressing=(map:GridMap)=>map.fixtures!.filter(f=>f.role==='decoration'||f.role==='vegetation');
const distance=(a:Cell,b:Cell)=>Math.hypot(a.x-b.x,a.row-b.row);

test('vegetation and decoration toggles generate separate roles with independent densities',()=>{
  for(const levelDesign of [false,true])for(const decorations of [false,true])for(const vegetation of [false,true]){
    const s=settings(levelDesign);Object.assign(s.designer!,{decorations,vegetation,fixtureDensity:90,decorationDensity:2,vegetationDensity:7});
    const map=applyGeneratedFeatures(room(),s);
    // 195 flat cells remain after excluding the door's immediate approach.
    assert.equal(map.fixtures!.filter(f=>f.role==='decoration').length,decorations?4:0);
    assert.equal(map.fixtures!.filter(f=>f.role==='vegetation').length,vegetation?14:0);
    assert.deepEqual(generationConditionIssues(map,s),[]);
    if(levelDesign)assert.deepEqual(analyzeLevelDesign(map,s).issues,[]);
  }
});

test('legacy settings retain their custom density and vegetation is disabled by default',()=>{
  const s=settings();Object.assign(s.designer!,{decorations:true,fixtureDensity:6});
  const parsed=parseGenerationSettings(s),map=applyGeneratedFeatures(room(),parsed);
  assert.equal(parsed.designer!.vegetation,false);
  assert.equal(parsed.designer!.decorationDensity,undefined);
  assert.equal(map.fixtures!.filter(f=>f.role==='decoration').length,12);
  assert.equal(map.fixtures!.filter(f=>f.role==='vegetation').length,0);
  parsed.designer!.vegetation=true;parsed.designer!.decorations=false;
  assert.equal(applyGeneratedFeatures(room(),parsed).fixtures!.filter(f=>f.role==='vegetation').length,12);
  for(const field of ['decorationDensity','vegetationDensity'] as const)for(const invalid of [0,101,1.5,NaN]){
    assert.throws(()=>parseGenerationSettings({...s,designer:{...s.designer,[field]:invalid}}),/밀도/);
  }
});

test('both generation paths leave breathing room across decoration and vegetation',()=>{
  for(const levelDesign of [false,true])for(const seed of [3,17,82]){
    const s=settings(levelDesign);Object.assign(s.designer!,{decorations:true,vegetation:true,decorationDensity:5,vegetationDensity:5});s.seed=seed;
    const source=room(),before=structuredClone(source),map=applyGeneratedFeatures(source,s),items=dressing(map);
    assert.equal(items.length,20);
    for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)assert.ok(distance(items[i],items[j])>=2,`adjacent ${items[i].role} and ${items[j].role}: seed ${seed}, levelDesign ${levelDesign}`);
    assert.ok(items.some(c=>c.row<=5));assert.ok(items.some(c=>c.row>=10));
    assert.ok(items.some(c=>c.x<=5));assert.ok(items.some(c=>c.x>=10));
    assert.deepEqual(source,before);assert.deepEqual(map,applyGeneratedFeatures(source,s));
  }
});

test('dressing keeps requested counts when density leaves insufficient room for gaps',()=>{
  const s=settings();Object.assign(s.designer!,{decorations:true,decorationDensity:100});
  const map=applyGeneratedFeatures(room(),s);
  assert.equal(dressing(map).length,195);
  assert.equal(new Set(dressing(map).map(c=>`${c.x},${c.row}`)).size,195);
});

test('nearby seeds vary decoration and vegetation layout in both generation paths',()=>{
  for(const levelDesign of [false,true]){
    const layouts=new Set<string>();
    for(const seed of [1,2,3]){
      const s=settings(levelDesign);s.seed=seed;Object.assign(s.designer!,{decorations:true,vegetation:true});
      layouts.add(JSON.stringify(dressing(applyGeneratedFeatures(room(),s)).map(c=>[c.role,c.x,c.row])));
    }
    assert.equal(layouts.size,3);
  }
});

test('generated measured dressing fits full rectangles without losing requested counts',()=>{
  const binding=(role:'decoration'|'vegetation'):AssetBinding=>({id:role,label:role,role,prefabGuid:(role==='vegetation'?'2':'3').repeat(32),prefabPath:`Assets/${role}.prefab`,scale:{x:1,y:1,z:1},rotationY:0,offset:{x:0,y:0,z:0},prop:{category:role,tags:[],blocksMovement:false,size:{x:3,y:2,z:4},placement:'floor',roomTypes:['battle'],weight:1}});
  for(const levelDesign of [false,true])for(const mixed of [false,true])for(const seed of [1,2,3]){
    const s=settings(levelDesign);s.seed=seed;Object.assign(s.designer!,{vegetation:true,vegetationDensity:mixed?2:5,decorations:mixed,decorationDensity:2});
    const catalog=[binding('vegetation'),...(mixed?[binding('decoration')]:[])],source=room();
    const placed=applyGeneratedFeatures(source,s,undefined,catalog),instances=placed.propInstances!;
    assert.equal(instances.filter(p=>p.role==='vegetation').length,mixed?4:10);
    assert.equal(instances.filter(p=>p.role==='decoration').length,mixed?4:0);
    assert.ok(instances.every(p=>p.cells.length===4));
    assert.deepEqual(propValidationIssues(placed,catalog),[]);
    assert.deepEqual(analyzeLevelDesign(placed,s).issues,[]);
    assert.deepEqual(generationConditionIssues(placed,s),[]);
    assert.deepEqual(placed,applyGeneratedFeatures(source,s,undefined,catalog));
  }
});

test('legacy catalogs without measured prop metadata preserve ordinary dressing fixtures',()=>{
  const s=settings();Object.assign(s.designer!,{vegetation:true,decorations:true});
  const catalog:AssetBinding[]=(['vegetation','decoration'] as const).map(role=>({id:role,label:role,role,prefabGuid:'2'.repeat(32),prefabPath:`Assets/${role}.prefab`,scale:{x:1,y:1,z:1},rotationY:0,offset:{x:0,y:0,z:0}}));
  const map=applyGeneratedFeatures(room(),s,undefined,catalog);
  assert.equal(dressing(map).length,20);assert.equal(map.propInstances?.length??0,0);
  assert.deepEqual(generationConditionIssues(map,s),[]);
});

test('regional dressing regeneration retains locked and outside vegetation',()=>{
  const s=settings(true);s.designer!.vegetation=true;
  const map=room();map.fixtures=[{id:'locked-plant',role:'vegetation',x:3,row:3,direction:0,offset:{x:.1,y:0,z:0}},{id:'outside-plant',role:'vegetation',x:13,row:13,direction:0,offset:{x:0,y:0,z:0}}];map.lockedCells=[{x:3,row:3}];
  const placed=applyGeneratedFeatures(map,s,{x:1,row:1,width:6,height:12});
  assert.deepEqual(placed.fixtures!.find(f=>f.id==='locked-plant'),map.fixtures[0]);
  assert.deepEqual(placed.fixtures!.find(f=>f.id==='outside-plant'),map.fixtures[1]);
  assert.ok(placed.fixtures!.filter(f=>f.role==='vegetation').length>2);
});
