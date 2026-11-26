import assert from 'node:assert/strict';
import test from 'node:test';
import { imagePrompt, layoutPrompt } from '../electron/services/prompts';
import { applyGeneratedFeatures, DEFAULT_DESIGNER, generationConditionIssues, parseGenerationSettings } from '../src/shared/features';
import { mergeGeneratedRegion } from '../src/shared/editing';
import { analyzeLevelDesign, DEFAULT_LEVEL_DESIGN } from '../src/shared/level-design';
import { DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { getPropCoverageReport, insertPropInstance, placeProps, propValidationIssues, propWorldSize } from '../src/shared/props';
import type { AssetBinding, GenerationSettings, GridMap } from '../src/shared/types';

function room():GridMap {
  const width=20,height=20,rows=Array.from({length:height},(_,row)=>row===0||row===height-1?'#'.repeat(width):`#${'.'.repeat(width-2)}#`);
  rows[0]='#'.repeat(10)+'D'+'#'.repeat(9);
  return {version:5,name:'Balanced generation',width,height,cellSize:2,maxStepHeight:.4,rows,elevations:Array.from({length:height},()=>Array(width).fill(0)),ramps:[],connections:[{id:'north',label:'북쪽',x:10,row:0,direction:0,width:2,height:3,kind:'door'}],assetOverrides:[]};
}
const setTile=(map:GridMap,x:number,row:number,tile:string)=>{map.rows[row]=map.rows[row].slice(0,x)+tile+map.rows[row].slice(x+1);};
function settings(levelDesign=true):GenerationSettings {
  return {...DEFAULT_SETTINGS,connectionWidth:2,width:20,height:20,connectionCount:1,seed:29,designer:{...DEFAULT_DESIGNER,elevation:false,props:true,propLayout:'balanced',propCoverage:12},...(levelDesign?{levelDesign:{...DEFAULT_LEVEL_DESIGN}}:{})};
}
function binding(id:string,size={x:1.2,y:1,z:1.2}):AssetBinding {
  return {id,label:id,role:'prop',prefabGuid:'1'.repeat(32),prefabPath:`Assets/${id}.prefab`,scale:{x:1,y:1,z:1},rotationY:0,offset:{x:0,y:0,z:0},prop:{category:id,tags:[],blocksMovement:true,size,placement:'floor',roomTypes:['battle'],weight:1}};
}
const catalog=()=>[binding('large',{x:4,y:1,z:3}),binding('medium',{x:2.4,y:1,z:2}),binding('small')];
function assertNoMirroredProps(map:GridMap,context:string):void {
  const centers=map.propInstances!.map(p=>({x:(Math.min(...p.cells.map(c=>c.x))+Math.max(...p.cells.map(c=>c.x)))/2,row:(Math.min(...p.cells.map(c=>c.row))+Math.max(...p.cells.map(c=>c.row)))/2}));
  for(let i=0;i<centers.length;i++)for(const previous of centers.slice(0,i)){
    const current=centers[i],sameX=Math.abs(current.x-previous.x)<.01,sameRow=Math.abs(current.row-previous.row)<.01;
    const reflectedX=Math.abs(current.x+previous.x-(map.width-1))<.01,reflectedRow=Math.abs(current.row+previous.row-(map.height-1))<.01;
    assert.ok(!(reflectedX&&sameRow||sameX&&reflectedRow||reflectedX&&reflectedRow),`${context} produced a reflected obstacle pair`);
  }
}

test('balanced generation fills measured props without AI P cells and ignores AI object count',()=>{
  const source=room(),before=structuredClone(source),s=settings(),assets=catalog();
  const result=applyGeneratedFeatures(source,s,undefined,assets);
  assert.ok((result.propInstances?.length??0)>1);
  assert.ok(result.propInstances!.some(p=>p.bindingId==='large'));
  assert.deepEqual(source,before);
  assert.deepEqual(result,applyGeneratedFeatures(source,s,undefined,assets.reverse()));
  const intentions=room();
  for(const c of [{x:2,row:5},{x:15,row:5},{x:2,row:14},{x:15,row:14}])setTile(intentions,c.x,c.row,'P');
  assert.deepEqual(applyGeneratedFeatures(intentions,s,undefined,assets),result);
  assert.deepEqual(generationConditionIssues(result,s),[]);
  assert.deepEqual(analyzeLevelDesign(result,s).issues,[]);
  assert.deepEqual(propValidationIssues(result,assets),[]);
});

test('balanced composition prefers unequal obstacle positions over reflected pairs while retaining safe measured coverage',()=>{
  const source=room(),before=structuredClone(source),assets=[binding('square',{x:2.4,y:1,z:2.4})];
  for(const seed of [0,1,2,3,4]){
    const s=settings();s.seed=seed;s.designer!.propCoverage=1;s.levelDesign!.pattern='openArena';
    const result=applyGeneratedFeatures(source,s,undefined,assets),props=result.propInstances!;
    assert.equal(props.length,3);
    assertNoMirroredProps(result,`seed ${seed}`);
    const report=getPropCoverageReport(result,s,assets);
    assert.ok(report.occupiedArea>=report.targetArea);assert.ok(report.occupiedArea-report.targetArea<2.4*2.4);
    for(const prop of props)assert.deepEqual(prop.size,propWorldSize(assets[0],prop.direction));
    assert.deepEqual(result,applyGeneratedFeatures(source,s,undefined,assets));
    assert.deepEqual(generationConditionIssues(result,s),[]);
    assert.deepEqual(analyzeLevelDesign(result,s).issues,[]);
    assert.deepEqual(propValidationIssues(result,assets),[]);
  }
  assert.deepEqual(source,before);
});

test('balanced mirror scoring uses rotated footprint centers for three-cell and mixed-size obstacles',()=>{
  const square=binding('square',{x:4.1,y:1,z:4.1}),rectangle=binding('rectangle',{x:4.1,y:1,z:1.2});
  const catalogs=[[square],[rectangle],[rectangle,binding('medium',{x:2.4,y:1,z:3.4}),binding('small')]];
  for(const assets of catalogs)for(const seed of [0,3]){
    const source=room(),before=structuredClone(source),s=settings();s.seed=seed;s.designer!.propCoverage=3;s.levelDesign!.pattern='openArena';
    const result=applyGeneratedFeatures(source,s,undefined,assets),props=result.propInstances!;
    assertNoMirroredProps(result,`${assets.map(asset=>asset.id).join(',')}, seed ${seed}`);
    assert.ok(props.length>=3);assert.equal(new Set(props.map(p=>p.bindingId)).size,assets.length);
    if(assets[0]===square)assert.ok(props.every(p=>p.cells.length===9));
    else {
      const rectangles=props.filter(p=>p.bindingId===rectangle.id);
      assert.ok(rectangles.some(p=>p.size.x>p.size.z));assert.ok(rectangles.some(p=>p.size.x<p.size.z));
    }
    for(const prop of props)assert.deepEqual(prop.size,propWorldSize(assets.find(asset=>asset.id===prop.bindingId)!,prop.direction));
    const report=getPropCoverageReport(result,s,assets);
    assert.ok(report.occupiedArea+1e-6>=report.targetArea);
    assert.ok(report.occupiedArea-report.targetArea<Math.max(...assets.map(asset=>asset.prop!.size!.x*asset.prop!.size!.z)));
    assert.deepEqual(result,applyGeneratedFeatures(source,s,undefined,[...assets].reverse()));
    assert.deepEqual(generationConditionIssues(result,s),[]);
    assert.deepEqual(analyzeLevelDesign(result,s).issues,[]);
    assert.deepEqual(propValidationIssues(result,assets),[]);
    assert.deepEqual(source,before);
  }
});

test('balanced mirror avoidance remains a preference when the only editable safe cell reflects an authored prop',()=>{
  const s=settings(),asset=binding('fixed');s.designer!.preset='shop';s.levelDesign!.pattern='openArena';asset.prop!.roomTypes.push('shop');
  const source=insertPropInstance(room(),{x:6,row:10},asset.id,s,[asset]),before=structuredClone(source);
  const fixed=source.propInstances![0],region={x:13,row:10,width:1,height:1};
  const result=placeProps(source,s,[asset],region,[],{tactical:true}).map;
  assert.equal(result.propInstances!.length,2);
  assert.deepEqual(result.propInstances!.find(p=>p.id===fixed.id),fixed);
  assert.ok(result.propInstances!.some(p=>p.x===13&&p.row===10));
  assert.deepEqual(propValidationIssues(result,[asset]),[]);
  assert.deepEqual(analyzeLevelDesign(result,s).issues,[]);
  assert.deepEqual(source,before);
});

test('balanced legacy settings without a level recipe still place props and relocate generated content safely',()=>{
  const s=settings(false);Object.assign(s.designer!,{columns:true,enemies:true,enemyCount:3,fixtureDensity:1});
  const result=applyGeneratedFeatures(room(),s,undefined,catalog());
  assert.ok(result.propInstances!.length>0);
  assert.equal(result.markers?.length,3);
  assert.ok(result.fixtures!.some(f=>f.role==='column'));
  assert.equal(s.levelDesign,undefined);
  assert.deepEqual(validateMap(result).filter(i=>i.severity==='error'),[]);
  assert.deepEqual(analyzeLevelDesign(result,{...s,levelDesign:{...DEFAULT_LEVEL_DESIGN}}).issues,[]);
});

test('balanced missing-size fallback retains raw proxies when measured dressing is available',()=>{
  const source=room();setTile(source,3,6,'P');setTile(source,15,12,'P');
  const unknown=binding('unknown');delete unknown.prop!.size;
  const decoration={...binding('pot'),role:'decoration' as const};decoration.prop!.blocksMovement=false;
  const s=settings();s.designer!.decorations=true;s.designer!.decorationDensity=1;
  const result=applyGeneratedFeatures(source,s,undefined,[unknown,decoration]);
  assert.equal(result.rows[6][3],'P');assert.equal(result.rows[12][15],'P');
  assert.equal(result.propInstances?.filter(p=>(p.role??'prop')==='prop').length??0,0);
  assert.ok(result.propInstances!.some(p=>p.role==='decoration'));
  assert.deepEqual(generationConditionIssues(result,s),[]);
});

test('balanced zero-placement results satisfy generation conditions but legacy required props still fail',()=>{
  const s=settings(),result=applyGeneratedFeatures(room(),s,undefined,[binding('oversized',{x:100,y:1,z:100})]);
  assert.equal(result.propInstances?.length??0,0);
  assert.deepEqual(generationConditionIssues(result,s),[]);
  assert.ok(analyzeLevelDesign(result,s).issues.some(i=>i.code==='flanking-routes'&&i.severity==='warning'));
  assert.deepEqual(analyzeLevelDesign(result,s).issues.filter(i=>i.severity==='error'),[]);
  assert.ok(analyzeLevelDesign(result,{...s,designer:{...s.designer!,propLayout:'legacy'}}).issues.some(i=>i.code==='flanking-routes'&&i.severity==='error'));
  assert.ok(generationConditionIssues(result,{...s,designer:{...s.designer!,propLayout:'legacy'}}).some(i=>i.message.includes('장애물')));
});

test('direct balanced region regeneration preserves a crossing prop, explicit dressing and original locks',()=>{
  const source=room(),asset=binding('fixed',{x:3.6,y:1,z:1.2});setTile(source,2,7,'P');
  const fixed=placeProps(source,{...settings(),designer:{...settings().designer!,propLayout:'legacy'}},[asset]).map;
  fixed.fixtures=[{id:'manual-pot',role:'decoration',bindingId:'pot',x:6,row:12,direction:90,offset:{x:.2,y:0,z:.1}}];
  fixed.lockedCells=[{x:15,row:15}];
  const before=structuredClone(fixed),region={x:3,row:3,width:10,height:12};
  const result=applyGeneratedFeatures(fixed,settings(),region,[...catalog(),asset]);
  assert.deepEqual(result.propInstances!.find(p=>p.id===before.propInstances![0].id),before.propInstances![0]);
  assert.deepEqual(result.fixtures!.find(f=>f.id==='manual-pot'),before.fixtures![0]);
  assert.deepEqual(result.lockedCells,before.lockedCells);
  for(let row=0;row<20;row++)for(let x=0;x<20;x++)if(x<region.x||x>=region.x+region.width||row<region.row||row>=region.row+region.height){assert.equal(result.rows[row][x],before.rows[row][x]);assert.equal(result.elevations[row][x],before.elevations[row][x]);}
  assert.deepEqual(fixed,before);
});

test('region merge validates newly generated measured dressing and legacy props inside the editable area',()=>{
  for(const propLayout of ['balanced','legacy'] as const){
    const original=room(),candidate=room(),region={x:3,row:3,width:14,height:14},s=settings();
    Object.assign(s.designer!,{propLayout,decorations:true,vegetation:true,decorationDensity:1,vegetationDensity:1});
    s.levelDesign!.pattern='openArena';
    if(propLayout==='legacy'){setTile(candidate,5,6,'P');setTile(candidate,14,13,'P');}
    const decoration={...binding('pot'),role:'decoration' as const};decoration.prop!.blocksMovement=false;
    const vegetation={...binding('plant'),role:'vegetation' as const};vegetation.prop!.blocksMovement=false;
    const assets=[...catalog(),decoration,vegetation];
    const result=mergeGeneratedRegion(original,candidate,region,merged=>applyGeneratedFeatures(merged,s,region,assets));
    assert.ok(result.propInstances!.some(p=>p.role==='decoration'));
    assert.ok(result.propInstances!.some(p=>p.role==='vegetation'));
    assert.ok(result.propInstances!.some(p=>(p.role??'prop')==='prop'));
    assert.deepEqual(generationConditionIssues(result,s,region),[]);
    assert.ok(generationConditionIssues(result,{...s,designer:{...s.designer!,props:false}},region).some(i=>i.message.includes('장애물 끄기')));
    assert.ok(generationConditionIssues(result,{...s,designer:{...s.designer!,decorations:false}},region).some(i=>i.message.includes('decoration 끄기')));
    if(propLayout==='legacy')assert.equal(result.propInstances!.filter(p=>(p.role??'prop')==='prop').length,2);
  }
});

test('region conditions ignore preserved authored and locked measured objects while counting generated ones',()=>{
  const original=room(),asset=binding('manual');setTile(original,5,7,'P');setTile(original,11,11,'P');
  const fixed=placeProps(original,{...settings(),designer:{...settings().designer!,propLayout:'legacy'}},[asset]).map;
  fixed.propInstances![0].authored=true;
  fixed.lockedCells=[fixed.propInstances![1].cells[0]];
  const s=settings();s.designer!.props=false;s.levelDesign!.pattern='openArena';
  const region={x:3,row:3,width:14,height:14};
  const result=mergeGeneratedRegion(fixed,room(),region,merged=>applyGeneratedFeatures(merged,s,region,catalog()));
  for(const prop of fixed.propInstances!)assert.deepEqual(result.propInstances!.find(p=>p.id===prop.id),prop);
  assert.deepEqual(generationConditionIssues(result,s,region),[]);
});

test('new prop settings are optional, strict and do not recompose a saved map on parsing',()=>{
  const legacy=parseGenerationSettings({...settings(),designer:{...DEFAULT_DESIGNER,elevation:false}});
  assert.equal(legacy.designer!.propLayout,undefined);assert.equal(legacy.designer!.propCoverage,undefined);
  for(const propLayout of ['balanced','legacy'] as const)for(const propCoverage of [1,12,30])assert.equal(parseGenerationSettings({...settings(),designer:{...settings().designer!,propLayout,propCoverage}}).designer!.propCoverage,propCoverage);
  for(const propCoverage of [0,31,1.5,NaN,'12',null])assert.throws(()=>parseGenerationSettings({...settings(),designer:{...settings().designer!,propCoverage}}),/점유율/);
  for(const propLayout of ['auto',true,1,null])assert.throws(()=>parseGenerationSettings({...settings(),designer:{...settings().designer!,propLayout}}),/구성 방식/);
  const map=room();setTile(map,3,6,'P');
  const loaded=parseProjectFile({formatVersion:1,map,settings:settings(),bindings:catalog()});
  assert.deepEqual(loaded.map.rows,map.rows);assert.equal(loaded.map.propInstances,undefined);
});

test('balanced prompts delegate count to measured coverage while legacy prompts retain exact quantities',()=>{
  const s=settings();s.designer!.propCoverage=18;
  for(const prompt of [imagePrompt,layoutPrompt]){
    const balanced=prompt(s);assert.match(balanced,/18% target floor coverage/);assert.match(balanced,/returning zero P cells is allowed/);assert.doesNotMatch(balanced,/retaining the exact object count/);
    const legacy=prompt({...s,designer:{...s.designer!,propLayout:undefined}});assert.match(legacy,/retaining the exact object count/);assert.doesNotMatch(legacy,/AUTOMATIC BALANCED COMPOSITION/);
    const disabled=prompt({...s,designer:{...s.designer!,props:false}});assert.match(disabled,/Blocking props P: DISABLED, no P cells/);
    const region=prompt(s,{x:3,row:3,width:10,height:12});assert.match(region,/ONLY to this selected editable region/);
  }
});
