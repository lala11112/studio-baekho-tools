import type { AssetVersion, GraphicsTask, GraphicsWorkspace } from './graphics';

export type HumanBoneBinding = { boneName: string; humanName: string };
export type UnityRigContract = {
  schemaVersion: 1 | 2; versionId: string; producerVersionId: string; producerTaskId: string;
  rigType: 'humanoid' | 'generic'; fingers: boolean; hairBinding: 'head' | 'controls';
  requiredParts: string[]; humanBones: HumanBoneBinding[];
  exportPolicy?: 'auto-rig-fbx';
};
export type ExternalRigMetadata = { schemaVersion: 1; handoffId: string; reportPath: string; reportSha256?: string; sourceSha256?: string; returnedFbxSha256?: string; contract: UnityRigContract };
export type UnityRigReceipt = { rigType: 'humanoid'; versionId: string; sourceSha256: string; avatarValid: boolean; avatarHuman: boolean; humanBones: HumanBoneBinding[]; parts: { meshName: string; meshId: string; partId: string; vertices: number; boneCount: number; normalizedWeights: boolean }[] };
/** Canonical host-owned mapping; Unity's name guessing is never a rig contract. */
export function humanoidBoneMap(fingers = false): HumanBoneBinding[] {
  const result = [['pelvis','Hips'],['spine','Spine'],['chest','Chest'],['neck','Neck'],['head','Head']].map(([boneName,humanName])=>({boneName,humanName}));
  for (const [side,prefix] of [['L','Left'],['R','Right']]) {
    for (const [bone,human] of [['upper_arm','UpperArm'],['forearm','LowerArm'],['hand','Hand'],['thigh','UpperLeg'],['shin','LowerLeg'],['foot','Foot']]) result.push({boneName:`${bone}.${side}`,humanName:prefix+human});
    if(fingers) for(const [bone,human] of [['thumb','Thumb'],['index','Index'],['middle','Middle'],['ring','Ring'],['little','Little']])
      for(const [index,joint] of ['Proximal','Intermediate','Distal'].entries()) result.push({boneName:`${bone}.0${index+1}.${side}`,humanName:prefix+human+joint});
  }
  return result;
}
export function rigContractForProducer(task: GraphicsTask, versionId: string, producerVersionId = versionId): UnityRigContract {
  if(!['R01','R02'].includes(task.taskId))throw Error('리그 종류를 확정한 원본 제작 작업이 없습니다.');
  const humanoid=task.taskId==='R01', fingers=humanoid&&task.settings.rigFingers===true;
  return {schemaVersion:1,versionId,producerVersionId,producerTaskId:task.id,rigType:humanoid?'humanoid':'generic',fingers,
    hairBinding:task.settings.rigHair===true?'controls':'head',
    requiredParts:(task.objectSnapshot?.creation?.parts??[]).filter(part=>part.enabled).map(part=>part.id).sort(),
    humanBones:humanoid?humanoidBoneMap(fingers):[]};
}
/** Exact accepted version ancestry, independent of today's editable object controls. */
export function freezeUnityRigContract(workspace: GraphicsWorkspace, versions: AssetVersion[]): UnityRigContract | undefined {
  const selected=versions.filter(version=>version.role==='rig');
  if(selected.length>1)throw Error('Unity 리그 계약에는 정확한 리그 버전 한 개가 필요합니다.');
  if(!selected.length)return undefined;
  const rig=selected[0], object=workspace.objects.find(item=>item.id===rig.objectId);
  if(object?.accepted[`rig:${rig.slot}`]!==rig.id)throw Error('Unity로 보낼 정확한 리그 버전을 먼저 채택하세요.');
  const externalFound: ExternalRigMetadata[]=[];
  const autoFound: UnityRigContract[]=[];
  let missingSource=false;
  const visited=new Set<string>(), found:{task:GraphicsTask;version:AssetVersion}[]=[];
  const walk=(version:AssetVersion)=>{
    if(visited.has(version.id))return;visited.add(version.id);
    if(version.autoRig){
      const meta=version.autoRig;
      if(version.externalRig||meta.schemaVersion!==1||!meta.runId||!meta.reportFile||meta.contract?.schemaVersion!==2||meta.contract.versionId!==version.id||meta.contract.producerVersionId!==version.id)throw Error('자동 리그 계약의 출처가 잘못됐습니다.');
      autoFound.push(validateUnityRigContract([version],meta.contract)!);return;
    }
    const external=(version as AssetVersion & {externalRig?:ExternalRigMetadata}).externalRig;
    if(external){
      if(external.schemaVersion!==1||!external.handoffId||!external.reportPath||external.contract?.schemaVersion!==2||external.contract.versionId!==version.id||external.contract.producerVersionId!==version.id)throw Error('외부 리그 계약의 출처가 잘못됐습니다.');
      validateUnityRigContract([version],external.contract);externalFound.push(external);return;
    }
    const producers=workspace.tasks.filter(task=>task.objectId===rig.objectId&&task.outputVersionIds.includes(version.id)&&['R01','R02'].includes(task.taskId));
    if(producers.length>1)throw Error('리그 버전의 제작 작업 연결이 중복됐습니다.');
    if(producers.length){
      const upstreamSeen=new Set<string>();
      const hasAutoSource=(item:AssetVersion):boolean=>{
        if(upstreamSeen.has(item.id))return false;upstreamSeen.add(item.id);
        return !!item.autoRig||item.sourceVersionIds.some(id=>{const parent=workspace.versions.find(v=>v.id===id&&v.objectId===rig.objectId);return !!parent&&hasAutoSource(parent);});
      };
      if(hasAutoSource(version))throw Error('자동 리그의 원본 계약을 이전 R01/R02 매핑으로 바꿀 수 없습니다.');
      found.push({task:producers[0],version});return;
    }
    for(const id of version.sourceVersionIds){const source=workspace.versions.find(item=>item.id===id&&item.objectId===rig.objectId);if(source)walk(source);else missingSource=true;}
  };
  walk(rig);
  if(autoFound.length){
    if(missingSource||autoFound.length!==1||externalFound.length||found.length)throw Error('자동 리그 계약의 제작 출처가 누락되거나 중복됐습니다.');
    return validateUnityRigContract([rig],{...autoFound[0],versionId:rig.id,exportPolicy:'auto-rig-fbx'});
  }
  if(externalFound.length){if(externalFound.length!==1||found.length)throw Error('외부 리그 계약의 제작 출처가 중복됐습니다.');return validateUnityRigContract([rig],{...externalFound[0].contract,versionId:rig.id});}
  if(found.length!==1){if(rig.provenance.type==='codex')throw Error('채택한 리그의 원본 리그 계약을 확정하지 못했습니다. 현재 설정으로 추정하지 않습니다.');return undefined;}
  return rigContractForProducer(found[0].task,rig.id,found[0].version.id);
}
export function validateUnityRigContract(versions: AssetVersion[], value?: UnityRigContract): UnityRigContract | undefined {
  if(!value)return undefined;
  if(value.exportPolicy!==undefined&&(value.exportPolicy!=='auto-rig-fbx'||value.schemaVersion!==2))throw Error('Unity 리그 내보내기 계약이 잘못됐습니다.');
  if(![1,2].includes(value.schemaVersion)||!versions.some(version=>version.role==='rig'&&version.id===value.versionId)||!value.producerTaskId||!value.producerVersionId||!['humanoid','generic'].includes(value.rigType)||typeof value.fingers!=='boolean'||!['head','controls'].includes(value.hairBinding)||!Array.isArray(value.requiredParts)||value.requiredParts.some(part=>typeof part!=='string'||!part)||new Set(value.requiredParts).size!==value.requiredParts.length||(value.schemaVersion===1?JSON.stringify(value.humanBones)!==JSON.stringify(value.rigType==='humanoid'?humanoidBoneMap(value.fingers):[]):!validExternalHumanBones(value)))throw Error('Unity 리그 계약의 정확한 버전·본 매핑이 잘못됐습니다.');
  const result=structuredClone(value);
  if(result.schemaVersion===2)result.humanBones=result.humanBones.map(({boneName,humanName})=>({boneName,humanName}));
  return result;
}
/** Explicit schema 2 mapping preserves external names and unmapped intermediary bones. */
export function validExternalHumanBones(value: UnityRigContract): boolean {
 if(value.rigType!=='humanoid'||!Array.isArray(value.humanBones))return false;
 const allowed=new Set([...humanoidBoneMap(true).map(b=>b.humanName),'UpperChest','LeftShoulder','RightShoulder','LeftToes','RightToes','LeftEye','RightEye','Jaw']);
 const human=value.humanBones.map(b=>b?.humanName),names=value.humanBones.map(b=>b?.boneName);
 const completeOptionalFingers=['Left','Right'].every(side=>['Thumb','Index','Middle','Ring','Little'].every(finger=>['Intermediate','Distal'].every((joint,index)=>!human.includes(side+finger+joint)||human.includes(side+finger+['Proximal','Intermediate'][index]))));
 return completeOptionalFingers&&names.every(n=>typeof n==='string'&&n.trim().length>0)&&new Set(names).size===names.length&&new Set(human).size===human.length&&human.every(n=>allowed.has(n))&&humanoidBoneMap(value.fingers).every(b=>human.includes(b.humanName));
}
