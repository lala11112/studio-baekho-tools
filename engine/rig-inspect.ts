import type {WorkbenchRequest} from "../shared/workbench";

type Bone = {name:string; parent:string|null; limb?:string; control?:string; deform?:boolean; weightedVertices?:number};
type Rig = {type?:string; bones:Bone[]};
export function validateAnatomicalRig(request: WorkbenchRequest, inspection: {
  rigs?:Rig[]; objects?:{parentBone?:string|null; invalidWeightVertices?:number}[];
}) {
  const rigs=inspection.rigs??[], bones=rigs.flatMap(r=>r.bones);
  const weighted=(b:Bone)=>b.deform===true && Number.isInteger(b.weightedVertices) && b.weightedVertices!>0;
  if(request.rigProfile==="quadruped") {
    const limbs=["front_left","front_right","hind_left","hind_right"];
    const valid=rigs.some(r=>r.type==="generic" && limbs.every(limb=>{
      const chain=r.bones.filter(b=>b.limb===limb && weighted(b));
      return chain.some(a=>chain.some(b=>b.parent===a.name && chain.some(c=>c.parent===b.name)));
    }));
    if(!valid) throw Error("네 발 Generic 리그의 네 다리에 연결된 실제 변형 뼈·웨이트가 필요합니다.");
    if(inspection.objects?.some(o=>!o.parentBone && o.invalidWeightVertices!==0))
      throw Error("네 발 리그의 웨이트가 누락되었거나 정규화되지 않았습니다.");
  }
  if(request.rigControls) {
    for(const [control,enabled] of [["ear_left",request.rigControls.ears],["ear_right",request.rigControls.ears],["tail",request.rigControls.tail]] as const) {
      const found=bones.filter(b=>b.control===control);
      if(enabled && !found.some(weighted)) throw Error(`요청한 ${control} 제어의 실제 변형 뼈·웨이트가 없습니다.`);
      if(!enabled && found.length) throw Error(`끄기로 설정한 ${control} 독립 제어가 생성됐습니다.`);
    }
  }
}
