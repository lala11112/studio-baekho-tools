import {test} from "node:test";
import assert from "node:assert/strict";
import {validateAnatomicalRig} from "../engine/rig-inspect";
import type {WorkbenchRequest} from "../shared/workbench";
const request:WorkbenchRequest={step:"rig",prompt:"Rabbit",rigProfile:"quadruped",rigControls:{ears:true,tail:true}};
function scene() {
  return {objects:[{invalidWeightVertices:0}],rigs:[{type:"generic",bones:[
    ...["front_left","front_right","hind_left","hind_right"].flatMap(limb=>[0,1,2].map(i=>({name:`${limb}_${i}`,parent:i?`${limb}_${i-1}`:null,limb,deform:true,weightedVertices:10}))),
    ...["ear_left","ear_right","tail"].map(control=>({name:control,parent:null,control,deform:true,weightedVertices:5}))
  ]}]};
}
test("quadruped requires four connected deform chains and genuinely weighted ear/tail controls",()=>{
  const good=scene();assert.doesNotThrow(()=>validateAnatomicalRig(request,good));
  const missingLeg=scene();missingLeg.rigs[0].bones.splice(0,3);assert.throws(()=>validateAnatomicalRig(request,missingLeg),/네 다리/);
  const disconnected=scene();disconnected.rigs[0].bones[2].parent=null;assert.throws(()=>validateAnatomicalRig(request,disconnected),/네 다리/);
  const unweighted=scene();unweighted.rigs[0].bones.at(-1)!.weightedVertices=0;assert.throws(()=>validateAnatomicalRig(request,unweighted),/tail/);
  const helper=scene();helper.rigs[0].bones.at(-2)!.deform=false;assert.throws(()=>validateAnatomicalRig(request,helper),/ear_right/);
});
test("rig toggles reject unwanted controls, malformed weights and Humanoid-only evidence while legacy is unchanged",()=>{
  assert.throws(()=>validateAnatomicalRig({...request,rigControls:{ears:false,tail:true}},scene()),/ear_left/);
  const bad=scene();bad.objects[0].invalidWeightVertices=1;assert.throws(()=>validateAnatomicalRig(request,bad),/정규화/);
  const human=scene();human.rigs[0].type="humanoid";assert.throws(()=>validateAnatomicalRig(request,human),/Generic/);
  assert.doesNotThrow(()=>validateAnatomicalRig({step:"rig",prompt:"Legacy"},{}));
});
