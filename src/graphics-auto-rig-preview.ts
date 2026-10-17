import type { AssetVersion, GraphicsFile } from '../shared/graphics';
import type { AutoRigRun } from '../shared/graphics-auto-rig';

export function rigInspectionForCandidate(candidate: AssetVersion | undefined, runs: AutoRigRun[]): AutoRigRun | undefined {
  if(!candidate)return;
  return [...runs].reverse().find(run=>run.operation==='inspect' && run.state==='review' && run.objectId===candidate.objectId && run.sourceVersionId===candidate.id && !!run.inspection);
}

/** Read-only display derivative. Adoption and delivery still use the candidate files. */
export function inspectedRigPreview(candidate: AssetVersion | undefined, inspection: AutoRigRun | undefined): GraphicsFile | undefined {
  if(!candidate || !inspection || inspection.operation!=='inspect' || inspection.state!=='review' || inspection.sourceVersionId!==candidate.id || inspection.objectId!==candidate.objectId) return;
  if(!candidate.files.some(file=>/\.blend$/i.test(file.path) && file.sha256===inspection.source.sha256)) return;
  if(!inspection.inspection?.checks.length || inspection.inspection.checks.some(check=>!check.passed)) return;
  const glbs=inspection.files.filter(file=>/\.glb$/i.test(file.path));
  return glbs.length===1 ? {...glbs[0]} : undefined;
}

export function autoRigPresentation(message: string): string {
  const known: Record<string,string> = {
    'Visual review required; no collision or natural-deformation certification':'겹침과 자연스러운 변형은 실제 동작으로 확인하세요.',
    'FBX mapping uses installed ARP Unity exporter conventions; actual Unity validation remains required':'Unity 본 매핑을 준비했습니다. 실제 Unity 가져오기 검사는 별도입니다.',
    sourceHashBound:'실행 원본 해시 일치',geometryAndUV:'원본 형태·UV 보존',outsideWeights:'선택 밖 가중치 보존',attributes:'메시 속성 보존',materials:'재질 보존',images:'이미지 보존',skeleton:'뼈대 보존',exportedBoneNames:'내보낸 실제 본 이름 확인',
    'Diagnostic motion only; not a natural motion quality guarantee':'검사용 동작입니다. 자연스러운 변형 여부는 직접 확인하세요.',
    'Arms spread':'양팔 벌리기', 'Elbows bend':'양팔꿈치 굽히기', 'Left knee bend':'왼쪽 무릎 굽히기', 'Right knee bend':'오른쪽 무릎 굽히기',
    'Invalid or nonnormalized weight rows':'가중치가 없거나 합이 맞지 않는 정점이 있습니다.',
    'Installed local tools ready':'로컬 도구 설치가 준비되었습니다.',
  };
  if(known[message])return known[message];
  if(/diagnostic.*not.*quality|not.*natural.*guarantee/i.test(message))return '검사용 동작입니다. 자연스러운 변형 여부는 직접 확인하세요.';
  if(/unweighted|nonnormalized/i.test(message))return '가중치가 없거나 합이 맞지 않는 정점을 확인하세요.';
  if(/loose.*vert|wire.*geometry/i.test(message))return '면에 사용되지 않는 정점·선이 남아 있습니다.';
  if(/source.specific|knee.*topology|topology.*knee/i.test(message))return '무릎 형태를 바꾸는 보정은 모델별 검토가 필요합니다.';
  if(/visual.*review|quality.*review|not.*production.*quality/i.test(message))return '검사 통과와 별도로 실제 움직임을 확인하세요.';
  return message;
}
