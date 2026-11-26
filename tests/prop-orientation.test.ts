import assert from 'node:assert/strict';
import test from 'node:test';
import { captureRegion, pasteRegion } from '../src/shared/editing';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { buildManifest, DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import { propFacingOffset, propFrontYaw, propRootYaw, propYaw } from '../src/shared/prop-orientation';
import { insertPropInstance, parsePropDefinition, parsePropInstance, propPosition, propValidationIssues, propWorldSize, replacePropInstance, rotatePropInstance } from '../src/shared/props';
import type { AssetBinding, GridMap, ProjectFile } from '../src/shared/types';

const settings={...DEFAULT_SETTINGS,width:12,height:12,connectionCount:1,designer:{...DEFAULT_DESIGNER,enemies:false},levelDesign:{pattern:'openArena' as const,characterRadius:.4,dodgeDistance:3}};
const room=():GridMap=>({version:5,name:'Orientation',width:12,height:12,cellSize:2,rows:['.....D......',...Array(11).fill('............')],elevations:Array.from({length:12},()=>Array(12).fill(0)),ramps:[],connections:[{id:'entry',label:'Entry',x:5,row:0,direction:0,width:2,height:3,kind:'default'}],assetOverrides:[],maxStepHeight:.4});
const asset=():AssetBinding=>({id:'machine',label:'Machine',role:'prop',prefabGuid:'1'.repeat(32),prefabPath:'Assets/Machine.prefab',rotationY:0,scale:{x:1,y:1,z:1},offset:{x:0,y:0,z:0},prop:{category:'Machine',tags:[],blocksMovement:true,size:{x:2.8,y:1,z:1.2},placement:'floor',roomTypes:['battle'],weight:1}});
const placed=(binding=asset())=>insertPropInstance(room(),{x:5,row:5},binding.id,settings,[binding]);
const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);

test('front calibration preserves old binding behavior and supports native fronts with signed scales',()=>{
  const b=asset(),p={direction:90 as const,yawOffset:7};b.rotationY=-15;
  assert.equal(propYaw(p),97);assert.equal(propRootYaw(p,b),82);assert.equal(propFrontYaw(p,b),97);assert.equal(propFacingOffset(b),0);
  b.prop!.frontYaw=90;close(propFrontYaw(p,b),172);close(propFacingOffset(b),-75);
  b.scale.x=-1;close(propFrontYaw(p,b),352);close(propFacingOffset(b),105);
  b.prop!.frontYaw=0;b.scale.z=-1;close(propFrontYaw(p,b),262);
  close(propFrontYaw({direction:90,yawOffset:propFacingOffset(b)+4},b),94);
});

test('new optional fields round-trip and reject invalid values while old records keep no yaw field',()=>{
  const b=asset(),map=placed(b),p=map.propInstances![0];
  assert.equal(Object.hasOwn(parsePropInstance(p,12,12),'yawOffset'),false);
  b.prop!.behavior='floorEquipment';b.prop!.frontYaw=-90;
  const rotated=rotatePropInstance(map,p.id,23.5,settings,[b]);
  const project:ProjectFile={formatVersion:1,map:rotated,settings,bindings:[b]};
  const loaded=parseProjectFile(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(loaded.map.propInstances,rotated.propInstances);assert.deepEqual(loaded.bindings[0].prop,b.prop);
  assert.throws(()=>parsePropInstance({...p,yawOffset:Infinity},12,12));
  assert.throws(()=>parsePropDefinition({...b.prop,behavior:'anything'}));
  assert.throws(()=>parsePropDefinition({...b.prop,frontYaw:NaN}));
});

test('rotation preserves center and native scale, recomputes bounds, exports exact yaw and refits its pose',()=>{
  const b=asset();b.rotationY=11;
  const source=placed(b),before=structuredClone(source),old=source.propInstances![0],center=propPosition(source,old,b);
  const rotated=rotatePropInstance(source,old.id,32.5,settings,[b]),p=rotated.propInstances![0];
  assert.deepEqual(source,before);assert.equal(propYaw(p),32.5);assert.equal(p.authored,true);assert.equal(p.provenance,'manual');
  assert.deepEqual(propPosition(rotated,p,b),center);assert.deepEqual(p.size,propWorldSize(b,32.5));assert.deepEqual(propValidationIssues(rotated,[b]),[]);
  const floor={...b,id:'floor',role:'floor' as const,prop:undefined,prefabGuid:'2'.repeat(32)};
  const door={...floor,id:'door',role:'door' as const,prefabGuid:'3'.repeat(32)};
  const exported=buildManifest(rotated,[b,floor,door]).placements.find(v=>v.id===`prop-instance-${p.id}`)!;
  assert.equal(exported.rotation.y,43.5);assert.deepEqual(exported.scale,b.scale);
  const refitted=replacePropInstance(rotated,p.id,b.id,settings,[b]);
  assert.equal(propYaw(refitted.propInstances![0]),32.5);assert.deepEqual(propValidationIssues(refitted,[b]),[]);
});

test('a failed rotation preserves locks, neighboring props and all source data atomically',()=>{
  const b=asset(),source=placed(b),p=source.propInstances![0];
  source.lockedCells=p.cells.map(c=>({...c}));const snapshot=structuredClone(source);
  assert.throws(()=>rotatePropInstance(source,p.id,45,settings,[b]),/잠긴/);assert.deepEqual(source,snapshot);
  delete source.lockedCells;
  source.rows=source.rows.map((row,r)=>[...row].map((value,x)=>p.cells.some(c=>c.x===x&&c.row===r)?value:'#').join(''));
  const blocked=structuredClone(source);
  assert.throws(()=>rotatePropInstance(source,p.id,45,settings,[b]),/회전/);assert.deepEqual(source,blocked);
});

test('rotation marks the complete group authored and excludes reserved cells',()=>{
  const b=asset(),source=placed(b),p=source.propInstances![0];p.groupId='work';
  const second=insertPropInstance(source,{x:9,row:9},b.id,settings,[b]);second.propInstances![1].groupId='work';
  const result=rotatePropInstance(second,p.id,8,settings,[b]);
  assert.ok(result.propInstances!.every(v=>v.authored&&v.provenance==='manual'));
  const all=Array.from({length:144},(_,i)=>({x:i%12,row:Math.floor(i/12)}));
  assert.throws(()=>rotatePropInstance(second,p.id,8,settings,[b],all),/회전/);
});

test('rotation preserves raw prop intentions and explicit prop overrides outside its old footprint',()=>{
  for(const explicit of [false,true]){
    const b=asset(),source=placed(b),p=source.propInstances![0],protectedCell={x:5,row:4};
    if(explicit)source.assetOverrides.push({...protectedCell,role:'prop',bindingId:b.id});
    else source.rows[4]=source.rows[4].slice(0,5)+'P'+source.rows[4].slice(6);
    const result=rotatePropInstance(source,p.id,90,settings,[b]);
    assert.ok(result.propInstances![0].cells.every(c=>c.x!==protectedCell.x||c.row!==protectedCell.row));
    assert.equal(result.rows[4][5],source.rows[4][5]);assert.deepEqual(result.assetOverrides,source.assetOverrides);
  }
});

test('overhead fixture bounds reject intersecting rotation without reserving harmless high lights',()=>{
  const b=asset(),source=placed(b),p=source.propInstances![0],light={...asset(),id:'light',role:'light' as const,prop:undefined,bounds:{center:{x:0,y:-.4,z:0},size:{x:20,y:.8,z:20}}};
  source.ceilings=[{x:5,row:5,undersideY:3}];source.fixtures=[{id:'lamp',role:'light',anchor:'ceiling',bindingId:light.id,x:5,row:5,direction:0,offset:{x:0,y:0,z:0}}];
  assert.doesNotThrow(()=>rotatePropInstance(source,p.id,15,settings,[b,light]));
  source.fixtures[0].offset.y=-2.3;const before=structuredClone(source);
  assert.throws(()=>rotatePropInstance(source,p.id,15,settings,[b,light]),/부착물/);assert.deepEqual(source,before);
});

test('region turns and mirrors preserve measured root yaw including binding correction',()=>{
  const b=asset();b.rotationY=17;
  const source=placed(b),rotated=rotatePropInstance(source,source.propInstances![0].id,28,settings,[b]);
  const snapshot=captureRegion(rotated,{x:3,row:3,width:6,height:6}),original=snapshot.propInstances![0];
  const turn=pasteRegion(room(),snapshot,{x:2,row:2},{rotate90:1},[b]).propInstances![0];
  close(propRootYaw(turn,b),propRootYaw(original,b)+90);assert.deepEqual(propValidationIssues(pasteRegion(room(),snapshot,{x:2,row:2},{rotate90:1},[b]),[b]),[]);
  for(const transform of [{mirrorX:true},{mirrorZ:true},{mirrorX:true,mirrorZ:true}]){
    const result=pasteRegion(room(),snapshot,{x:2,row:2},transform,[b]),p=result.propInstances![0];
    assert.deepEqual(propValidationIssues(result,[b]),[]);
    const expected=transform.mirrorX&&transform.mirrorZ?propRootYaw(original,b)+180:transform.mirrorX?-propRootYaw(original,b):180-propRootYaw(original,b);
    close(((propRootYaw(p,b)-expected)%360+360)%360,0);
  }
});

test('paste transforms measured physical centers including binding offsets',()=>{
  const b=asset();b.rotationY=17;b.offset={x:.2,y:0,z:-.15};b.prop!.size={x:2.2,y:1,z:.8};
  const source=placed(b),snapshot=captureRegion(source,{x:3,row:3,width:6,height:6}),p=snapshot.propInstances![0];
  const center=propPosition(snapshot,p,b);
  for(const transform of [{mirrorX:true},{mirrorZ:true},{rotate90:1 as const}]){
    const target=room(),result=pasteRegion(target,snapshot,{x:2,row:2},transform,[b]),actual=propPosition(result,result.propInstances![0],b);
    const local=transform.rotate90?{x:center.z,z:-center.x}:{x:transform.mirrorX?-center.x:center.x,z:transform.mirrorZ?-center.z:center.z};
    // The pasted six-cell square's center is (-2m,+2m) in the twelve-cell destination.
    close(actual.x,local.x-2);close(actual.z,local.z+2);assert.deepEqual(propValidationIssues(result,[b]),[]);
  }
});

test('mirrors reflect an explicit sideways visual front and keep cardinal wall support independent',()=>{
  for(const wallMounted of [false,true]){
    const b=asset(),source=placed(b),p=source.propInstances![0];
    b.rotationY=17;b.prop!.frontYaw=90;p.direction=90;
    // The floor console faces east. The wall-attached version uses the east wall
    // for support and faces west into the room, independently of its support direction.
    p.yawOffset=wallMounted?73:-107;
    if(wallMounted){p.anchor='wall';b.prop!.placement='wall';source.rows[5]=source.rows[5].slice(0,7)+'#'+source.rows[5].slice(8);}
    assert.deepEqual(propValidationIssues(source,[b]),[]);
    const snapshot=captureRegion(source,{x:3,row:3,width:6,height:6}),original=snapshot.propInstances![0],before=structuredClone(snapshot);
    for(const transform of [{mirrorX:true},{mirrorZ:true},{mirrorX:true,rotate90:1 as const},{mirrorX:true,mirrorZ:true}]){
      const result=pasteRegion(room(),snapshot,{x:2,row:2},transform,[b]),copy=result.propInstances![0];
      let expectedFront=propFrontYaw(original,b),expectedDirection=original.direction as number;
      if(transform.mirrorX){expectedFront=-expectedFront;expectedDirection=-expectedDirection;}
      if(transform.mirrorZ){expectedFront=180-expectedFront;expectedDirection=180-expectedDirection;}
      expectedFront+=(transform.rotate90??0)*90;expectedDirection+=(transform.rotate90??0)*90;
      close(propFrontYaw(copy,b),((expectedFront%360)+360)%360);
      assert.equal(copy.direction,((expectedDirection%360)+360)%360);
      const measured=propWorldSize(b,propYaw(copy))!;for(const axis of ['x','y','z'] as const)close(copy.size[axis],measured[axis]);assert.deepEqual(propValidationIssues(result,[b]),[]);
    }
    assert.deepEqual(snapshot,before);
  }
});

test('a visual-front mirror rejects a changed AABB that cannot fit its transformed footprint atomically',()=>{
  const b=asset(),source=placed(b);b.prop!.frontYaw=30;
  const snapshot=captureRegion(source,{x:3,row:3,width:6,height:6}),target=room(),before=structuredClone({snapshot,target});
  assert.throws(()=>pasteRegion(target,snapshot,{x:2,row:2},{mirrorX:true},[b]),/대칭 붙여넣기.*점유 영역/);
  assert.deepEqual({snapshot,target},before);
});
