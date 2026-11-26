import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSET_ROLES, DEFAULT_DESIGNER, DESIGNER_PRESETS, applyGeneratedFeatures, ceilingEligibleCells, exposedCliffFaces, fixturePosition, generationConditionIssues, interiorPitRegions, parseGenerationSettings, reapplyLighting } from '../src/shared/features';
import { buildManifest, DEFAULT_SETTINGS, edgeHeight, parseProjectFile, validateMap } from '../src/shared/map';
import { publicProject, validateSettings } from '../electron/services/validation';
import { imagePrompt, layoutPrompt } from '../electron/services/prompts';
import type { AssetBinding, DesignerSettings, GridMap, ProjectFile } from '../src/shared/types';

const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const bindings:AssetBinding[]=ASSET_ROLES.map((role,i)=>({id:role,label:role,role,prefabGuid:(i+1).toString(16).padStart(32,'0'),prefabPath:`Assets/${role}.prefab`,scale:{x:1,y:1,z:1},offset:{x:0,y:0,z:0},rotationY:0}));
function room():GridMap{return{version:4,name:'Feature room',width:8,height:8,cellSize:2,maxStepHeight:.4,rows:['#D######','#......#','#......#','#......#','#......#','#......#','#......#','########'],elevations:Array.from({length:8},()=>Array(8).fill(0)),ramps:[],connections:[{id:'north',label:'North',x:1,row:0,direction:0,width:2,height:3,kind:'door'}],assetOverrides:[]};}
function options(changes:Partial<DesignerSettings>={}){return{...DEFAULT_SETTINGS,connectionWidth:2,width:8,height:8,connectionCount:1,designer:{...DEFAULT_DESIGNER,elevation:false,props:false,...changes}};}
function project(map=room()):ProjectFile{return{formatVersion:1,map,settings:options(),bindings:[]};}
function bridgeRoom():GridMap{const m=room();m.rows[2]='#..__..#';m.rows[3]='#..BB..#';m.rows[4]='#..__..#';m.bridges=[{x:3,row:3,direction:90},{x:4,row:3,direction:90}];m.elevations=m.elevations.map(r=>r.map(()=>2));return m;}
test('v5 completed pit sides satisfy requested cliffs after replacing legacy faces',()=>{
  const m=room();m.rows[3]='#..__..#';const settings=options({cliffs:true,cliffCount:1,cliffSize:2,structureFill:true});
  const result=applyGeneratedFeatures(m,settings);
  assert.equal(result.version,5);assert.ok(result.structureFills?.some(f=>f.purpose==='pitSide'));assert.equal(result.cliffs?.some(c=>c.x===3&&c.row===2&&c.direction===180),false);
  assert.deepEqual(generationConditionIssues(result,settings).filter(i=>i.severity==='error'),[]);
});
test('feature refresh never downgrades existing v5 data when structure fill is disabled',()=>{
  const m=room();m.version=5;m.propInstances=[];
  assert.equal(applyGeneratedFeatures(m,DEFAULT_SETTINGS).version,5);
  const updated=applyGeneratedFeatures(m,options({structureFill:false}));
  assert.equal(updated.version,5);assert.deepEqual(updated.propInstances,[]);
  assert.equal(parseProjectFile(project(updated)).map.version,5);
});
const errors=(m:GridMap)=>validateMap(m).filter(i=>i.severity==='error');

test('designer settings share one strict parser across IPC and files; legacy remains opt-in',()=>{
  assert.equal(validateSettings,parseGenerationSettings);
  assert.equal(parseGenerationSettings(DEFAULT_SETTINGS).designer,undefined);
  assert.equal(parseGenerationSettings({...DEFAULT_SETTINGS,designer:{ceilings:true}}).designer?.ceilingHeight,4);
  for(const designer of [{preset:'corridor'},{bridges:1},{cliffSize:0},{fixtureDensity:101},{headroom:Infinity},{unexpected:true},{elevation:false,slopes:true},{ceilings:true,ceilingHeight:1,headroom:2}])assert.throws(()=>parseGenerationSettings({...DEFAULT_SETTINGS,designer}));
  assert.deepEqual(Object.keys(DESIGNER_PRESETS),['battle','boss','reward','start','shop']);
});

test('flat ceilings clear the highest ramp landing and explicit wall heights meet their plane',()=>{
  const map=room();map.rows[1]='#..R...#';map.ramps=[{x:3,row:1,direction:90,rise:2}];for(let row=1;row<=6;row++)for(let x=4;x<=6;x++)map.elevations[row][x]=2;
  const generated=applyGeneratedFeatures(map,options({ceilings:true,elevation:true}));
  assert.equal(new Set(generated.ceilings?.map(c=>c.undersideY)).size,1);
  assert.equal(generated.ceilings?.[0].undersideY,6);
  for(const w of generated.wallHeights??[])assert.equal(w.height+map.elevations[w.row][w.x],6);
  assert.deepEqual(errors(generated),[]);
  const low=structuredClone(generated);low.ceilings!.find(c=>c.x===3&&c.row===1)!.undersideY=3;
  assert.ok(errors(low).some(i=>i.message.includes('여유 높이')));
  generated.ceilings=generated.ceilings!.filter(c=>c.x!==2||c.row!==2);assert.deepEqual(errors(generated),[],'partial ceiling openings are supported');
});

test('derived flat ceiling and wall bounds support the full allowed elevation and clearance range',()=>{
  const map=room();map.elevations=map.elevations.map(row=>row.map(()=>100));map.elevations[7][7]=-100;
  const generated=applyGeneratedFeatures(map,options({ceilings:true,ceilingHeight:20,wallHeight:20,headroom:20}));
  assert.equal(generated.ceilings![0].undersideY,120);assert.equal(generated.wallHeights!.find(w=>w.x===7&&w.row===7)!.height,220);
  assert.deepEqual(errors(generated),[]);assert.doesNotThrow(()=>parseProjectFile(project(generated)));assert.doesNotThrow(()=>buildManifest(generated,bindings));
  // A saved in-progress ramp may temporarily have its high edge above the terrain matrix range.
  const editing=room();editing.rows[1]='#..R...#';editing.elevations[1][3]=100;editing.ramps=[{x:3,row:1,direction:90,rise:10}];
  const tall=applyGeneratedFeatures(editing,options({ceilings:true,ceilingHeight:20,elevation:true}));assert.equal(tall.ceilings![0].undersideY,130);assert.doesNotThrow(()=>parseProjectFile(project(tall)));
});

test('bridge cells replace floors, only traverse their axis, and export deck top above void',()=>{
  const map=bridgeRoom();assert.deepEqual(errors(map),[]);
  assert.equal(edgeHeight(map,3,3,1,0),2);assert.equal(edgeHeight(map,3,3,0,1),null);
  const manifest=buildManifest(map,bindings),placed=manifest.placements.find(p=>p.id==='bridge-3-3')!;
  assert.equal(placed.surface,'top');assert.equal(placed.position.y,2);assert.equal(placed.rotation.y,90);
  assert.equal(manifest.placements.some(p=>p.id==='floor-3-3'),false);
  assert.equal(manifest.placements.some(p=>p.role==='cliff'),false);
});

test('bridges reject missing metadata, side land, turns and either unmatched landing even with alternate paths',()=>{
  for(const mutate of [(m:GridMap)=>{m.bridges=[];},(m:GridMap)=>{m.rows[2]='#..._..#';},(m:GridMap)=>{m.bridges![1].direction=0;},(m:GridMap)=>{m.elevations[3][5]=3;},(m:GridMap)=>{m.rows[3]='#..BB_.#';}]){const m=bridgeRoom();mutate(m);assert.ok(errors(m).length);}
});

test('pit count and size include underlying void continuity below bridges, and conditions never flatten geography',()=>{
  const source=bridgeRoom(),before=structuredClone(source),settings=options({bridges:true,cliffs:true,bridgeHeight:2,cliffCount:1,cliffSize:4});
  const map=applyGeneratedFeatures(source,settings);
  assert.equal(interiorPitRegions(map).length,1);assert.equal(interiorPitRegions(map)[0].length,6);
  assert.deepEqual(generationConditionIssues(map,settings),[]);assert.deepEqual(source,before);
  assert.ok(generationConditionIssues(map,options({bridges:true,cliffs:true,cliffCount:2})).some(i=>i.message.includes('낭떠러지')));
  assert.ok(generationConditionIssues(map,options()).some(i=>i.message.includes('다리 끄기')));
});

test('cliff faces expose only land rims, never bridge support, with measured downward fit',()=>{
  const map=bridgeRoom();map.cliffs=exposedCliffFaces(map,5);
  assert.ok(map.cliffs.length);assert.equal(map.cliffs.some(c=>map.rows[c.row][c.x]==='B'),false);
  const manifest=buildManifest(map,bindings);
  for(const p of manifest.placements.filter(p=>p.role==='cliff')){const[,x,row]=p.id.split('-').map(Number);assert.equal(p.fitHeight,map.rows[row][x]==='#'?5:4.76);assert.equal(p.position.y,-3);assert.equal(p.surface,'bottom');}
  map.cliffs.push({x:3,row:3,direction:0,depth:5});assert.ok(errors(map).some(i=>i.message.includes('절벽')));
});

test('deterministic fixtures, markers and links occupy distinct cells and remain authorable without prefab slots',()=>{
  const settings=options({ceilings:true,lights:true,columns:true,gates:true,enemies:true,rewards:true,events:true,enemyCount:3,rewardCount:2,eventCount:1,fixtureDensity:3});
  const map=applyGeneratedFeatures(room(),settings);assert.deepEqual(map,applyGeneratedFeatures(room(),settings));assert.deepEqual(errors(map),[]);
  const occupied=[...(map.fixtures??[]),...(map.markers??[])].map(c=>`${c.x},${c.row}`);assert.equal(new Set(occupied).size,occupied.length);
  const light=map.fixtures!.find(f=>f.role==='light')!;assert.equal(light.anchor,'ceiling');assert.equal(fixturePosition(map,light).y,4);
  assert.doesNotThrow(()=>parseProjectFile(project(map)));assert.throws(()=>buildManifest(map,[]),/프리팹/);
  const manifest=buildManifest(map,bindings);assert.equal(manifest.markers.length,6);
  const trigger=manifest.placements.find(p=>p.role==='switch')!;assert.equal(trigger.linkedId,'fixture-gate-1');assert.ok(manifest.placements.some(p=>p.id===trigger.linkedId));
  assert.ok(manifest.placements.filter(p=>p.id.startsWith('fixture-')).every(p=>p.surface==='pivot'));
  assert.equal(manifest.placements.some(p=>['enemy','reward','event'].includes(p.role)),false);
});

test('fixture anchors, links and offsets validate against actual map supports',()=>{
  const map=applyGeneratedFeatures(room(),options({ceilings:true,lights:true,gates:true,fixtureDensity:1}));
  const light=map.fixtures!.find(f=>f.role==='light')!;map.ceilings=map.ceilings!.filter(c=>c.x!==light.x||c.row!==light.row);
  assert.ok(errors(map).some(i=>i.message.includes('천장 기준점')));
  light.anchor='wall';assert.ok(errors(map).some(i=>i.message.includes('벽 기준점')));
  light.anchor='floor';light.offset.x=2;assert.ok(errors(map).some(i=>i.message.includes('오프셋')));
  map.fixtures!.find(f=>f.role==='switch')!.linkedId='missing';assert.ok(errors(map).some(i=>i.message.includes('연결 대상')));
});

test('slope uses independent prefab role and native rise while disabled slopes restore stair role',()=>{
  const map=room();map.rows[1]='#..R...#';map.ramps=[{x:3,row:1,direction:90,rise:2}];for(let row=1;row<=6;row++)for(let x=4;x<=6;x++)map.elevations[row][x]=2;
  const generated=applyGeneratedFeatures(map,options({elevation:true,slopes:true}));
  const sourceBindings=structuredClone(bindings);sourceBindings.find(b=>b.role==='slope')!.stairNativeRise=.5;
  const manifest=buildManifest(generated,sourceBindings);const slope=manifest.placements.find(p=>p.role==='slope')!;assert.equal(slope.scale.y,4);assert.equal(slope.surface,'bottom');
  assert.equal(applyGeneratedFeatures(generated,options({elevation:true,slopes:false})).ramps[0].kind,'stair');
});

test('v3 migration preserves root scales, adds no content and leaves wall fitting unspecified',()=>{
  const input=project({...room(),version:3});input.settings=DEFAULT_SETTINGS;input.bindings=structuredClone(bindings);input.bindings.find(b=>b.role==='wall')!.scale.y=7;
  const parsed=parseProjectFile(input);assert.equal(parsed.map.version,4);assert.deepEqual(parsed.map.wallHeights,[]);assert.equal(parsed.settings.designer,undefined);
  assert.equal(parsed.map.fixtures?.length,0);const wall=buildManifest(parsed.map,parsed.bindings).placements.find(p=>p.role==='wall')!;assert.equal(wall.scale.y,7);assert.equal(wall.fitHeight,undefined);
});

test('v4 project roundtrip preserves independent data, retry region and settings without aliasing',()=>{
  const input=project(applyGeneratedFeatures(room(),options({ceilings:true,lights:true})));input.map.lockedCells=[{x:1,row:1}];input.map.zones=[{x:2,row:2,kind:'combat'}];
  input.generationDraft={imageDataUrl:PNG,settings:options(),region:{x:1,row:2,width:3,height:4}};
  const parsed=parseProjectFile(input);assert.deepEqual(publicProject(parsed),parsed);assert.deepEqual(parseProjectFile(JSON.parse(JSON.stringify(parsed))),parsed);
  parsed.map.fixtures![0].offset.y=99;assert.notEqual(input.map.fixtures![0].offset.y,99);
  assert.throws(()=>parseProjectFile({...input,generationDraft:{...input.generationDraft,region:{x:7,row:0,width:2,height:2}}}),/region/);
  for(const malformed of [{ceilings:[{x:1,row:1,undersideY:NaN}]},{bridges:[{x:1,row:1,direction:45}]},{fixtures:[{...input.map.fixtures![0],unexpected:true}]},{zones:[{x:1,row:1,kind:'corridor'}]},{headroom:0}])assert.throws(()=>parseProjectFile({...input,map:{...input.map,...malformed}}));
});

test('blueprint is cutaway even with ceiling, and generation prompt excludes corridor presets',()=>{
  const settings=options({ceilings:true,bridges:true,cliffs:true});
  assert.match(imagePrompt(settings),/KEEP THE CEILING HIDDEN/);assert.match(imagePrompt(settings),/exactly 1 distinct straight bridge spans/);
  assert.match(layoutPrompt(settings),/version must be 4/);assert.match(layoutPrompt(settings),/do not generate corridors/);assert.match(layoutPrompt(settings),/second playable layer underneath/);
  const region={x:2,row:2,width:3,height:3};
  assert.match(imagePrompt(options(),region),/same existing boundary-compatible height/);
  assert.match(imagePrompt(options(),region),/Preserve existing outside and locked bridges/);
  assert.match(layoutPrompt(options(),region),/including custom kind, label, width and height/);
});

test('region generation applies counts only to unlocked selected cells and preserves all other layers',()=>{
  const source=applyGeneratedFeatures(room(),options({ceilings:true,lights:true,fixtureDensity:1}));
  source.lockedCells=[{x:4,row:4}];source.zones=[{x:5,row:5,kind:'combat'},{x:6,row:6,kind:'reward'}];
  source.fixtures!.push({id:'locked-decoration',role:'decoration',x:4,row:4,direction:90,offset:{x:0,y:0,z:0}});
  source.markers=[{id:'enemy-1',label:'Outside enemy',kind:'enemy',contentKey:'keep',x:3,row:1,direction:0,offset:{x:0,y:0,z:0}},
    {id:'locked-enemy',label:'Locked enemy',kind:'enemy',contentKey:'locked',x:4,row:4,direction:180,offset:{x:0,y:0,z:0}}];
  const before=structuredClone(source),region={x:4,row:4,width:3,height:3},settings=options({enemies:true,rewards:true,enemyCount:2,rewardCount:1,gates:true});
  const result=applyGeneratedFeatures(source,settings,region);
  const active=(c:{x:number;row:number})=>c.x>=4&&c.row>=4&&c.x<=6&&c.row<=6&&(c.x!==4||c.row!==4);
  for(const layer of ['ceilings','wallHeights','cliffs','fixtures','markers'] as const)assert.deepEqual(result[layer]?.filter(c=>!active(c)),source[layer]?.filter(c=>!active(c)),layer);
  for(const key of ['rows','elevations','connections','zones','lockedCells','headroom'] as const)assert.deepEqual(result[key],source[key],key);
  assert.equal(result.markers!.filter(m=>active(m)&&m.kind==='enemy').length,2);
  assert.equal(result.markers!.filter(m=>active(m)&&m.kind==='reward').length,1);
  assert.equal(result.ceilings!.filter(active).length,0);assert.deepEqual(generationConditionIssues(result,settings,region),[]);
  assert.equal(new Set(result.markers!.map(m=>m.id)).size,result.markers!.length,'preserved outside IDs cannot collide with regenerated content');
  const gate=result.fixtures!.find(f=>active(f)&&f.role==='gate')!,trigger=result.fixtures!.find(f=>active(f)&&f.role==='switch')!;assert.equal(trigger.linkedId,gate.id);
  assert.deepEqual(errors(result),[]);assert.deepEqual(source,before);
});

test('whole and region allocators prioritize combat, reward and rest zones over neutral locations',()=>{
  const map=room();map.zones=[{x:5,row:6,kind:'combat'},{x:6,row:6,kind:'combat'},{x:4,row:6,kind:'reward'},
    {x:1,row:6,kind:'rest'},{x:2,row:6,kind:'rest'},{x:3,row:6,kind:'rest'}];
  const settings=options({ceilings:true,lights:true,fixtureDensity:1,enemies:true,rewards:true,rests:true,enemyCount:2,rewardCount:1});
  for(const region of [undefined,{x:1,row:5,width:6,height:2}]){
    const result=applyGeneratedFeatures(map,settings,region),zone=(c:{x:number;row:number})=>map.zones!.find(z=>z.x===c.x&&z.row===c.row)?.kind;
    for(const marker of result.markers!)assert.equal(zone(marker),marker.kind==='enemy'?'combat':'reward');
    for(const fixture of result.fixtures!.filter(f=>['rest','merchant','altar'].includes(f.role)))assert.equal(zone(fixture),'rest');
    assert.deepEqual(result.zones,map.zones);assert.deepEqual(generationConditionIssues(result,settings,region),[]);
  }
});

test('region shortages and invalid rectangles fail atomically instead of consuming outside or locked cells',()=>{
  const map=room();map.lockedCells=[{x:5,row:5}];const before=structuredClone(map),settings=options({enemies:true,enemyCount:2});
  assert.throws(()=>applyGeneratedFeatures(map,settings,{x:5,row:5,width:2,height:1}),/선택한 잠금 해제 영역.*부족/);
  assert.throws(()=>applyGeneratedFeatures(map,settings,{x:7,row:7,width:2,height:2}),/재생성 영역/);
  assert.deepEqual(map,before);
});

test('region terrain conditions count crossing bridge and pit groups once and ignore unrelated outside terrain',()=>{
  const map=bridgeRoom();map.cliffs=exposedCliffFaces(map,4);
  const crossing={x:3,row:2,width:1,height:3},settings=options({bridges:true,cliffs:true,bridgeCount:1,cliffCount:1,cliffSize:4});
  assert.deepEqual(generationConditionIssues(map,settings,crossing),[]);
  assert.ok(generationConditionIssues(map,options({...settings.designer,bridgeCount:2}),crossing).some(i=>i.message.includes('다리 2개')));
  assert.ok(generationConditionIssues(map,options({...settings.designer,cliffCount:2}),crossing).some(i=>i.message.includes('낭떠러지')));
  assert.ok(generationConditionIssues(map,options({...settings.designer,bridgeHeight:3}),crossing).some(i=>i.message.includes('상판 높이')));
  assert.deepEqual(generationConditionIssues(map,options(),{x:1,row:5,width:1,height:1}),[],'outside pit/bridge remain legal when local toggles are off');
  assert.ok(generationConditionIssues(map,options({props:true}),{x:1,row:5,width:1,height:1}).some(i=>i.message.includes('장애물 켜기')));
  assert.ok(generationConditionIssues(map,options({elevation:true}),{x:1,row:5,width:1,height:1}).some(i=>i.message.includes('높이 지형 켜기')));
});

test('region terrain checks exclude locked cells and preserve connection-cell features',()=>{
  const map=room();map.rows[5]='#P.....#';map.lockedCells=[{x:1,row:5}];
  assert.deepEqual(generationConditionIssues(map,options(),{x:1,row:5,width:2,height:1}),[]);
  map.lockedCells=[];assert.ok(generationConditionIssues(map,options(),{x:1,row:5,width:2,height:1}).some(i=>i.message.includes('장애물 끄기')));
  map.ceilings=[{x:1,row:0,undersideY:4}];
  const result=applyGeneratedFeatures(map,options(),{x:1,row:0,width:2,height:2});assert.deepEqual(result.ceilings,map.ceilings);
  assert.deepEqual(generationConditionIssues(result,options(),{x:1,row:0,width:2,height:2}),[]);
});

test('region height checks include a selected ramp high edge even when both landings are outside',()=>{
  const map=room();map.rows[1]='#..R...#';map.ramps=[{x:3,row:1,direction:90,rise:2}];for(let row=1;row<=6;row++)for(let x=4;x<=6;x++)map.elevations[row][x]=2;
  const region={x:3,row:1,width:1,height:1};
  assert.deepEqual(generationConditionIssues(map,options({elevation:true}),region),[]);
  assert.ok(generationConditionIssues(map,options({elevation:false}),region).some(i=>i.message.includes('높이 지형 끄기')));
});


test('automatic fixture prefab choice survives unrelated deletion and regional layer reordering', () => {
  const map=room();map.fixtures=[
    {id:'inside',role:'light',x:2,row:2,direction:0,offset:{x:0,y:0,z:0}},
    {id:'protected',role:'light',x:3,row:3,direction:0,offset:{x:0,y:0,z:0}},
  ];
  map.lockedCells=[{x:3,row:3}];
  const variants=[...bindings,{...bindings.find(b=>b.role==='light')!,id:'light-two',label:'Light two',prefabGuid:'f'.repeat(32),prefabPath:'Assets/light-two.prefab'}];
  const original=buildManifest(map,variants).placements.find(p=>p.id==='fixture-protected')!;
  assert.equal(original.prefabGuid,'f'.repeat(32));
  const regenerated=applyGeneratedFeatures(map,options({ceilings:true,lights:true,fixtureDensity:1}),{x:2,row:2,width:2,height:2});
  assert.deepEqual(buildManifest(regenerated,variants).placements.find(p=>p.id==='fixture-protected'),original);
  map.fixtures=map.fixtures.slice(1);
  assert.deepEqual(buildManifest(map,variants).placements.find(p=>p.id==='fixture-protected'),original);
});

test('flat ceilings continue across internal chasms without covering exterior void or requiring a phantom floor',()=>{
  const map=bridgeRoom();map.rows[7]='_______#';
  const eligible=ceilingEligibleCells(map),keys=new Set(eligible.map(c=>`${c.x},${c.row}`));
  assert.ok(keys.has('3,2'));assert.ok(keys.has('4,4'));assert.equal(keys.has('0,7'),false);
  const generated=applyGeneratedFeatures(map,options({ceilings:true,bridges:true,cliffs:true}));
  const ceiling=generated.ceilings!.find(c=>c.x===3&&c.row===2)!;assert.equal(ceiling.undersideY,6);
  assert.equal(new Set(generated.ceilings!.map(c=>c.undersideY)).size,1);
  assert.deepEqual(errors(generated),[]);assert.equal(generated.rows[2][3],'_');
  const manifest=buildManifest(generated,bindings);assert.ok(manifest.placements.some(p=>p.id==='ceiling-3-2'));
  assert.equal(manifest.placements.some(p=>p.id==='floor-3-2'),false);
  generated.ceilings!.push({x:0,row:7,undersideY:6});assert.ok(errors(generated).some(i=>i.message.includes('내부 낭떠러지')));
  const negative=bridgeRoom();negative.elevations=negative.elevations.map(r=>r.map(()=>-10));negative.elevations[2][3]=100;
  assert.deepEqual(errors(applyGeneratedFeatures(negative,options({ceilings:true,bridges:true,cliffs:true}))),[],'pit elevation values are not walkable headroom');
});

test('ceiling lights spread across both axes instead of filling the first rows',()=>{
  const settings=options({ceilings:true,lights:true,lightPlacement:'ceiling',fixtureDensity:14});
  const map=applyGeneratedFeatures(room(),settings),lights=map.fixtures!.filter(f=>f.role==='light');
  assert.equal(lights.length,6);assert.ok(lights.every(f=>f.anchor==='ceiling'&&f.direction===0));
  assert.ok(Math.max(...lights.map(f=>f.x))-Math.min(...lights.map(f=>f.x))>=4);
  assert.ok(Math.max(...lights.map(f=>f.row))-Math.min(...lights.map(f=>f.row))>=4);
  for(const [left,top] of [[true,true],[false,true],[true,false],[false,false]])assert.ok(lights.some(f=>(f.x<3.5)===left&&(f.row<3.5)===top),'every quadrant receives a light');
  assert.deepEqual(map,applyGeneratedFeatures(room(),settings));assert.deepEqual(errors(map),[]);
});

test('wall panels face interior space and distribute around the room when no ceiling exists',()=>{
  const map=applyGeneratedFeatures(room(),options({lights:true,lightPlacement:'auto',fixtureDensity:12})),lights=map.fixtures!.filter(f=>f.role==='light');
  assert.equal(lights.length,5);assert.ok(lights.every(f=>f.anchor==='wall'));
  const faces=new Set(lights.map(f=>f.direction));assert.equal(faces.size,4,'all four wall orientations get panels');
  for(const light of lights){const [dx,dr]=({0:[0,-1],90:[1,0],180:[0,1],270:[-1,0]} as const)[light.direction];assert.equal(map.rows[light.row][light.x],'#');assert.ok('.DPRB'.includes(map.rows[light.row+dr][light.x+dx]));}
  assert.deepEqual(errors(map),[]);
  const both=applyGeneratedFeatures(room(),options({ceilings:true,lights:true,lightPlacement:'both',fixtureDensity:12}));
  assert.ok(both.fixtures!.some(f=>f.anchor==='wall'));assert.ok(both.fixtures!.some(f=>f.anchor==='ceiling'));
});

test('lighting-only redistribution preserves nonlights, geometry, locked lights and explicit prefab identities',()=>{
  const source=applyGeneratedFeatures(room(),options({ceilings:true,lights:true,fixtureDensity:8}));
  const lights=source.fixtures!.filter(f=>f.role==='light');lights[0].bindingId='custom-fluorescent';source.lockedCells=[{x:lights[0].x,row:lights[0].row}];
  lights[1].bindingId='movable-fluorescent';source.fixtures!.push({id:'other',role:'decoration',x:1,row:1,direction:90,offset:{x:0,y:0,z:0}});
  source.markers=[{id:'reward',label:'Keep',kind:'reward',contentKey:'chest',x:2,row:3,direction:0,offset:{x:0,y:0,z:0}}];
  const before=structuredClone(source),result=reapplyLighting(source,options({lights:true,lightPlacement:'ceiling',fixtureDensity:8}));
  assert.deepEqual(result.fixtures!.find(f=>f.id===lights[0].id),lights[0]);
  assert.equal(result.fixtures!.find(f=>f.id===lights[1].id)?.bindingId,'movable-fluorescent');
  assert.deepEqual(result.fixtures!.filter(f=>f.role!=='light'),source.fixtures!.filter(f=>f.role!=='light'));
  for(const key of ['rows','elevations','ramps','ceilings','wallHeights','markers','connections','lockedCells'] as const)assert.deepEqual(result[key],source[key],key);
  assert.deepEqual(source,before);assert.deepEqual(errors(result),[]);
  const wallResult=reapplyLighting(source,options({lights:true,lightPlacement:'wall',fixtureDensity:8}));
  assert.equal(wallResult.fixtures!.find(f=>f.id===lights[1].id)?.bindingId,undefined,'changing mount type returns to the matching automatic prefab slot');
  assert.equal(wallResult.fixtures!.find(f=>f.id===lights[0].id)?.bindingId,'custom-fluorescent','locked ceiling light retains its mapping');
});

test('lighting redistribution preserves outside region data and fails atomically for missing mounts or inbound links',()=>{
  const source=applyGeneratedFeatures(room(),options({ceilings:true,lights:true,fixtureDensity:10}));
  const before=structuredClone(source),region={x:4,row:4,width:3,height:3};
  const result=reapplyLighting(source,options({lights:true,lightPlacement:'ceiling',fixtureDensity:20}),region);
  assert.deepEqual(result.fixtures!.filter(f=>f.x<4||f.row<4),source.fixtures!.filter(f=>f.x<4||f.row<4));
  assert.throws(()=>reapplyLighting(room(),options({lights:true,lightPlacement:'ceiling'})),/천장이 없습니다/);
  assert.throws(()=>reapplyLighting(room(),options({lights:true,lightPlacement:'wall'}),{x:2,row:2,width:2,height:2}),/실내 벽면이 없습니다/);
  source.fixtures!.push({id:'linked-switch',role:'switch',x:1,row:1,direction:0,offset:{x:0,y:0,z:0},linkedId:source.fixtures![0].id});
  assert.throws(()=>reapplyLighting(source,options({lights:false})),/참조하는 조명/);
  assert.deepEqual(source.rows,before.rows);assert.deepEqual(source.ceilings,before.ceilings);
});

test('light placement preference is strictly parsed while legacy fixture anchors remain unchanged on load',()=>{
  assert.equal(parseGenerationSettings({...DEFAULT_SETTINGS,designer:{lights:true}}).designer!.lightPlacement,'auto');
  for(const value of ['floor','spotlight',null,0])assert.throws(()=>parseGenerationSettings({...DEFAULT_SETTINGS,designer:{lightPlacement:value}}),/lightPlacement/);
  const old=project(room());old.settings=DEFAULT_SETTINGS;old.map.fixtures=[{id:'old-lamp',role:'light',x:2,row:2,direction:90,offset:{x:0,y:0,z:0}}];
  assert.deepEqual(parseProjectFile(old).map.fixtures,old.map.fixtures);assert.equal(parseProjectFile(old).settings.designer,undefined);
});
