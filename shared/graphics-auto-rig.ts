import type { GraphicsFile } from './graphics';
import type { HumanBoneBinding, UnityRigContract } from './graphics-rig';

export type AutoRigOperation = 'rig' | 'inspect' | 'repair';
export type AutoRigFront = 'neg-y' | 'pos-y' | 'pos-x' | 'neg-x';
export type AutoRigRepair = {
  mesh: string; islandId: string;
  kind: 'normalize' | 'remove-influence' | 'rigid-bind';
  bones?: string[]; targetBone?: string;
};
export type AutoRigIsland = {
  mesh: string; islandId: string; vertices: number;
  vertexIndices?: number[];
  bones: { name: string; meanWeight: number; maxWeight: number }[];
  label?: string; warnings?: string[];
};
export type AutoRigInspection = {
  islands: AutoRigIsland[]; boneNames: string[];
  humanBones: HumanBoneBinding[];
  checks: { id: string; passed: boolean; message?: string }[];
  warnings: string[];
  poses?: { name: string; label: string; maximumStretch?: number; warning?: string }[];
};
export type AutoRigReadiness = {
  available: boolean; checkedAt: string; message: string;
  blenderVersion?: string; addonVersion?: string; aiVersion?: string;
};
export type AutoRigPartPolicy = { schemaVersion: 1; requiredParts: string[]; headBoundParts: string[] };
export function validateAutoRigPartPolicy(value: unknown): AutoRigPartPolicy {
  const p=value as AutoRigPartPolicy;
  const ids=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=100&&v.every((s,i)=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(s)&&!s.startsWith('part-')&&(i===0||v[i-1]<s));
  if(!p||Object.keys(p).some(k=>!['schemaVersion','requiredParts','headBoundParts'].includes(k))||p.schemaVersion!==1||!ids(p.requiredParts)||!p.requiredParts.length||!ids(p.headBoundParts)||p.headBoundParts.some(id=>!p.requiredParts.includes(id)))throw Error('고정한 자동 리그 파트 정책이 잘못됐습니다.');
  return {schemaVersion:1,requiredParts:[...p.requiredParts],headBoundParts:[...p.headBoundParts]};
}
export function validateAutoRigPartReport(policy: AutoRigPartPolicy|undefined, report: any) {
  if(policy===undefined){if(report.partPolicy!==undefined)throw Error('요청하지 않은 파트 정책이 결과에 있습니다.');return;}
  const p=validateAutoRigPartPolicy(policy);
  if(JSON.stringify(report.partPolicy)!==JSON.stringify(p)||!Array.isArray(report.partChecks)||report.partChecks.length!==p.requiredParts.length)throw Error('결과의 파트 정책·검사가 고정 요청과 다릅니다.');
  const meshIds=new Set<string>();
  for(let i=0;i<p.requiredParts.length;i++){
    const c=report.partChecks[i];
    if(c?.partId!==p.requiredParts[i]||c.present!==true||c.headBound!==p.headBoundParts.includes(c.partId)||!Array.isArray(c.meshIds)||!c.meshIds.length||c.meshIds.some((id:unknown,j:number)=>typeof id!=='string'||!id.length||id.length>1000||j>0&&c.meshIds[j-1]>=id||meshIds.has(id)))throw Error('필수 파트의 정확한 메시·머리 연결 검사가 없습니다.');
    for(const id of c.meshIds)meshIds.add(id);
  }
  for(const id of ['partIdentity','partExport','headBinding'])if(report.inspection?.checks?.filter((c:any)=>c.id===id&&c.passed===true).length!==1)throw Error('필수 파트의 원본·내보내기·머리 연결 검사가 통과하지 않았습니다.');
}
export type AutoRigRun = {
  id: string; objectId: string; sourceVersionId: string; source: GraphicsFile;
  operation: AutoRigOperation; state: 'running' | 'review' | 'blocked' | 'failed' | 'cancelled';
  createdAt: string; updatedAt: string; message: string; error?: string;
  settings: { frontAxis: AutoRigFront; fingers: boolean };
  repairs: AutoRigRepair[]; inspectionRunId?: string;
  files: GraphicsFile[]; reportFile?: GraphicsFile; requestHash?: string; toolSha256?: string;
  inspection?: AutoRigInspection; candidateVersionId?: string;
  partPolicy?: AutoRigPartPolicy;
  toolDependencies?: Record<string,string>;
};
export type AutoRigMetadata = {
  schemaVersion: 1; runId: string; reportFile: GraphicsFile;
  sourceSha256: string; exportFbx: GraphicsFile; contract: UnityRigContract;
  /** Exact X04 file copy; original run/report proof stays on the validated parent. */
  derivedFromVersionId?: string;
  partPolicy?: AutoRigPartPolicy;
};
export type AutoRigAction =
  | { kind: 'probe-auto-rig' }
  | { kind: 'start-auto-rig'; objectId: string; versionId: string; frontAxis: AutoRigFront; fingers: boolean }
  | { kind: 'inspect-auto-rig'; objectId: string; versionId: string }
  | { kind: 'repair-auto-rig'; objectId: string; versionId: string; inspectionRunId: string; repairs: AutoRigRepair[] }
  | { kind: 'recover-auto-rig' | 'cancel-auto-rig'; objectId: string; runId: string };

export function autoRigOrientation(front: AutoRigFront): number[][] {
  const angle = front === 'neg-y' ? 0 : front === 'pos-y' ? Math.PI : front === 'pos-x' ? -Math.PI / 2 : Math.PI / 2;
  const c = Math.round(Math.cos(angle)), s = Math.round(Math.sin(angle));
  return [[c,-s,0,0],[s,c,0,0],[0,0,1,0],[0,0,0,1]];
}
export function validateAutoRigRepairs(inspection: AutoRigInspection, repairs: AutoRigRepair[]): AutoRigRepair[] {
  if (!Array.isArray(repairs) || !repairs.length || repairs.length > 32) throw Error('보정할 부위와 방식을 선택하세요.');
  const used = new Set<string>();
  const touched = new Map<string,Set<number>>();
  return repairs.map(value => {
    if (!value || !['normalize','remove-influence','rigid-bind'].includes(value.kind)) throw Error('지원하는 웨이트 보정 방식을 선택하세요.');
    const key = JSON.stringify([value.mesh, value.islandId]);
    if (used.has(key) || !inspection.islands.some(item => item.mesh === value.mesh && item.islandId === value.islandId)) throw Error('검사한 부위를 한 번씩만 선택하세요.');
    used.add(key);
    const island=inspection.islands.find(item=>item.mesh===value.mesh&&item.islandId===value.islandId)!;
    const vertices=touched.get(value.mesh)??new Set<number>();
    if(island.vertexIndices?.some(index=>vertices.has(index)))throw Error('겹치는 부위는 한 번에 보정할 수 없습니다.');
    for(const index of island.vertexIndices??[])vertices.add(index);
    touched.set(value.mesh,vertices);
    if (value.kind === 'rigid-bind' && (!value.targetBone || !inspection.boneNames.includes(value.targetBone))) throw Error('검사된 실제 본을 선택하세요.');
    if (value.kind === 'remove-influence' && (!value.bones?.length || new Set(value.bones).size !== value.bones.length || value.bones.some(bone => !inspection.boneNames.includes(bone)))) throw Error('제거할 실제 본 영향을 선택하세요.');
    return { mesh:value.mesh,islandId:value.islandId,kind:value.kind,...(value.kind==='rigid-bind'?{targetBone:value.targetBone}:{}),...(value.kind==='remove-influence'?{bones:[...value.bones!]}:{}) };
  });
}
