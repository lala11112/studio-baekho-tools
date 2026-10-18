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
export type AutoRigRun = {
  id: string; objectId: string; sourceVersionId: string; source: GraphicsFile;
  operation: AutoRigOperation; state: 'running' | 'review' | 'blocked' | 'failed' | 'cancelled';
  createdAt: string; updatedAt: string; message: string; error?: string;
  settings: { frontAxis: AutoRigFront; fingers: boolean };
  repairs: AutoRigRepair[]; inspectionRunId?: string;
  files: GraphicsFile[]; reportFile?: GraphicsFile; requestHash?: string; toolSha256?: string;
  inspection?: AutoRigInspection; candidateVersionId?: string;
};
export type AutoRigMetadata = {
  schemaVersion: 1; runId: string; reportFile: GraphicsFile;
  sourceSha256: string; exportFbx: GraphicsFile; contract: UnityRigContract;
  /** Exact X04 file copy; original run/report proof stays on the validated parent. */
  derivedFromVersionId?: string;
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
  return repairs.map(value => {
    if (!value || !['normalize','remove-influence','rigid-bind'].includes(value.kind)) throw Error('지원하는 웨이트 보정 방식을 선택하세요.');
    const key = JSON.stringify([value.mesh, value.islandId]);
    if (used.has(key) || !inspection.islands.some(item => item.mesh === value.mesh && item.islandId === value.islandId)) throw Error('검사한 부위를 한 번씩만 선택하세요.');
    used.add(key);
    if (value.kind === 'rigid-bind' && (!value.targetBone || !inspection.boneNames.includes(value.targetBone))) throw Error('검사된 실제 본을 선택하세요.');
    if (value.kind === 'remove-influence' && (!value.bones?.length || new Set(value.bones).size !== value.bones.length || value.bones.some(bone => !inspection.boneNames.includes(bone)))) throw Error('제거할 실제 본 영향을 선택하세요.');
    return { mesh:value.mesh,islandId:value.islandId,kind:value.kind,...(value.kind==='rigid-bind'?{targetBone:value.targetBone}:{}),...(value.kind==='remove-influence'?{bones:[...value.bones!]}:{}) };
  });
}
