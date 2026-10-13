import type { AssetVersion, GraphicsTask, GraphicsWorkspace } from './graphics';

export type HumanBoneBinding = { boneName: string; humanName: string };
export type UnityRigContract = {
  schemaVersion: 1; versionId: string; producerVersionId: string; producerTaskId: string;
  rigType: 'humanoid' | 'generic'; fingers: boolean; hairBinding: 'head' | 'controls';
  requiredParts: string[]; humanBones: HumanBoneBinding[];
};
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
  const visited=new Set<string>(), found:{task:GraphicsTask;version:AssetVersion}[]=[];
  const walk=(version:AssetVersion)=>{
    if(visited.has(version.id))return;visited.add(version.id);
    const producers=workspace.tasks.filter(task=>task.objectId===rig.objectId&&task.outputVersionIds.includes(version.id)&&['R01','R02'].includes(task.taskId));
    if(producers.length>1)throw Error('리그 버전의 제작 작업 연결이 중복됐습니다.');
    if(producers.length){found.push({task:producers[0],version});return;}
    for(const id of version.sourceVersionIds){const source=workspace.versions.find(item=>item.id===id&&item.objectId===rig.objectId);if(source)walk(source);}
  };
  walk(rig);
  if(found.length!==1){if(rig.provenance.type==='codex')throw Error('채택한 리그의 원본 리그 계약을 확정하지 못했습니다. 현재 설정으로 추정하지 않습니다.');return undefined;}
  return rigContractForProducer(found[0].task,rig.id,found[0].version.id);
}
export function validateUnityRigContract(versions: AssetVersion[], value?: UnityRigContract): UnityRigContract | undefined {
  if(!value)return undefined;
  if(value.schemaVersion!==1||!versions.some(version=>version.role==='rig'&&version.id===value.versionId)||!value.producerTaskId||!value.producerVersionId||!['humanoid','generic'].includes(value.rigType)||typeof value.fingers!=='boolean'||!['head','controls'].includes(value.hairBinding)||!Array.isArray(value.requiredParts)||value.requiredParts.some(part=>typeof part!=='string'||!part)||new Set(value.requiredParts).size!==value.requiredParts.length||JSON.stringify(value.humanBones)!==JSON.stringify(value.rigType==='humanoid'?humanoidBoneMap(value.fingers):[]))throw Error('Unity 리그 계약의 정확한 버전·본 매핑이 잘못됐습니다.');
  return structuredClone(value);
}
