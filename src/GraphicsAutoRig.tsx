import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { importedModelSourceProblem, type AssetVersion, type GraphicsObject } from '../shared/graphics';
import type { AutoRigIsland, AutoRigRepair } from '../shared/graphics-auto-rig';
import './graphics-auto-rig.css';

export type AutoRigView = {
  ready: boolean; checked: boolean; readiness: string[];
  running: boolean; state?: string; progress?: string; error?: string;
  sourceLabel?: string; sourceSha256?: string; runId?: string;
  recoverable: boolean; candidate?: AssetVersion; adopted: boolean;
  videos: { label: string; url: string }[];
  checks: { label: string; passed: boolean }[];
  warnings?: string[];
  poses?: { name: string; label: string; maximumStretch?: number; warning?: string }[];
  bones: string[]; islands: AutoRigIsland[];
  correctionAvailable: boolean;
  highlightReady?: boolean;
  hasMotionPreview?: boolean;
  inspectionId?: string;
};
export type AutoRigDraft = { versionId: string; frontAxis: '+X' | '-X' | '+Y' | '-Y'; fingers: boolean };
type Props = {
  object: GraphicsObject; versions: AssetVersion[]; view: AutoRigView; disabled: boolean;
  onCheck: () => Promise<void>; onRun: (draft: AutoRigDraft) => Promise<void>;
  onCancel: () => Promise<void>; onRecover: () => Promise<void>; onInspect: () => Promise<void>;
  onShow: (version: AssetVersion) => void; onAdopt: () => Promise<void>; onUnity: () => void;
  onCorrect: (selection: AutoRigRepair) => Promise<void>;
  onRegion?: (selection: AutoRigIsland | undefined) => void;
  footerHost?: HTMLElement | null;
  previewVersionId?: string;
};

/** Every mutation is an explicit callback. Rendering and selecting never starts work. */
export function GraphicsAutoRig(props: Props) {
  const { object, versions, view, disabled } = props;
  const sources = versions.filter(version => ['model', 'material'].includes(version.role) && version.slot === 'main' && object.accepted[`${version.role}:main`] === version.id && version.files.some(file => /\.(blend|fbx)$/i.test(file.path)));
  const [sourceId, setSourceId] = useState(sources.length === 1 ? sources[0].id : '');
  const [frontAxis, setFrontAxis] = useState<AutoRigDraft['frontAxis'] | ''>('');
  const [fingers, setFingers] = useState(true);
  const [meshId, setMeshId] = useState('');
  const [bone, setBone] = useState('');
  const [repairKind, setRepairKind] = useState<AutoRigRepair['kind']>('normalize');
  useEffect(()=>{setMeshId('');setBone('');setRepairKind('normalize');props.onRegion?.(undefined);},[view.candidate?.id,view.inspectionId]);
  const selectedIsland = view.islands.find(island => JSON.stringify([island.mesh, island.islandId]) === meshId);
  const source = sources.find(version => version.id === sourceId);
  const sourceProblem = source && importedModelSourceProblem(source);
  const sourcePreviewAvailable = !sourceProblem && !!source?.files.some(file=>/\.glb$/i.test(file.path));
  const sourcePreviewCurrent = !!source && props.previewVersionId === source.id;
  const locked = disabled || view.running;
  const runEnabled = !locked && view.ready && !!source && sourcePreviewAvailable && sourcePreviewCurrent && !!frontAxis;
  const [submitting, setSubmitting] = useState(false);
  const invoke = async (callback: () => Promise<void>) => { if (submitting) return; setSubmitting(true); try { await callback(); } finally { setSubmitting(false); } };
  const primary = view.running ? <div className="gs-auto-rig-running"><strong role="status">{view.progress || '로컬 작업 진행 중'}</strong><button type="button" onClick={() => void props.onCancel()}>작업 중단</button></div> : view.candidate ? view.adopted ? <button type="button" className="gs-primary" disabled={locked} onClick={props.onUnity}>Unity 내보내기 설정</button> : <button type="button" className="gs-primary" data-testid="auto-rig-adopt" disabled={disabled || submitting || view.running} onClick={() => void invoke(props.onAdopt)}>이 리그 사용</button> : <button form="graphics-auto-rig-form" type="submit" className="gs-primary" data-testid="auto-rig-run" disabled={!runEnabled || submitting}>{submitting ? '요청 처리 중' : '이 모델 자동 리깅'}</button>;
  return <div className="gs-auto-rig" data-testid="graphics-auto-rig">
    <header><h3>자동 사람 리깅</h3><p>이 PC의 Auto-Rig Pro로 뼈대와 가중치를 만듭니다.</p><small>로컬 실행 · API 비용 0 · GPT 호출 0</small></header>
    {!!view.warnings?.length && <details><summary>지원 범위와 별도 확인 사항</summary>{view.warnings.map((warning,index)=><p role="note" key={index}>{warning}</p>)}</details>}
    <details open={!view.candidate}><summary>실행 원본·설치 설정</summary>
    <section aria-label="Auto-Rig Pro 설치 확인">
      <strong>{view.checked ? view.ready ? '설치 준비됨' : '설치 확인이 필요합니다' : '먼저 설치를 확인하세요'}</strong>
      {view.readiness.map((message, index) => <p key={index}>{message}</p>)}
      <button type="button" disabled={locked || submitting} onClick={() => void invoke(props.onCheck)}>설치 상태 확인</button>
      <small>구매한 애드온과 AI 파일은 이 PC에 설치되어 있어야 합니다.</small>
    </section>
    <form id="graphics-auto-rig-form" onSubmit={event => { event.preventDefault(); if (runEnabled && frontAxis) void invoke(() => props.onRun({ versionId: source!.id, frontAxis, fingers })); }}>
      <section className="gs-auto-rig-input" aria-label="자동 리깅 원본">
        <label>실행할 전체 모델<select aria-label="자동 리깅 원본" value={sourceId} disabled={locked || submitting} onChange={event => { const selected=sources.find(version=>version.id===event.target.value);setSourceId(event.target.value);setFrontAxis('');if(selected)props.onShow(selected); }}><option value="">전체 모델 선택</option>{sources.map(version => <option key={version.id} value={version.id}>{version.label} · {version.role === 'material' ? '채택 재질 모델' : '채택 모델'}</option>)}</select></label>
        {sources.length > 1 && <small>채택 모델과 재질 모델이 있습니다. 색·텍스처를 포함할 정확한 원본을 선택하세요.</small>}
        {source && <><small data-testid="auto-rig-source-id">{source.id}</small><code>{source.files.find(file => /\.(blend|fbx|glb)$/i.test(file.path))?.sha256}</code></>}
        {source && sourcePreviewAvailable && <button type="button" onClick={()=>props.onShow(source)}>실행 원본 3D 보기</button>}
        {source && sourcePreviewAvailable && !sourcePreviewCurrent && <p role="status" data-testid="auto-rig-preview-mismatch">현재 미리보기와 실행 원본이 다릅니다. ‘실행 원본 3D 보기’로 원본을 확인한 뒤 리깅하세요.</p>}
        {sourceProblem && <p role="alert" data-testid="auto-rig-import-source-warning">{sourceProblem}</p>}
        {!sourcePreviewAvailable && source && !sourceProblem && <p role="alert">이 원본에는 3D 미리보기가 없습니다. 같은 원본의 GLB 미리보기를 먼저 준비해야 앞 방향을 확인하고 실행할 수 있습니다.</p>}
        <label>모델이 바라보는 앞 방향<select aria-label="모델 앞 방향" value={frontAxis} disabled={locked || submitting || !sourcePreviewAvailable} onChange={event => setFrontAxis(event.target.value as AutoRigDraft['frontAxis'])}><option value="">미리보기 축을 보고 선택하세요</option>{(['+X', '-X', '+Y', '-Y'] as const).map(axis => <option key={axis} value={axis}>{axis}</option>)}</select></label>
        <label className="gs-auto-rig-check"><input type="checkbox" checked={fingers} disabled={locked || submitting} onChange={event => setFingers(event.target.checked)} />손가락도 자동 감지</label>
        <small>채택한 사람 형태의 전체 모델을 사용하세요. 결과의 어깨·팔·손가락·양쪽 무릎 움직임을 직접 확인합니다.</small>
      </section>
      {view.candidate && <div className="gs-auto-rig-actions"><button type="submit" data-testid="auto-rig-run-new" disabled={!runEnabled || submitting}>이 설정으로 새 리그 만들기</button><small>기존 리그 결과는 보존하고 새 후보를 만듭니다.</small></div>}
    </form>
    </details>
    {(view.state || view.error) && <section className="gs-auto-rig-status" role="status" aria-live="polite"><strong>최근 작업 · {view.state}</strong><p>{view.progress}</p>{view.sourceLabel && <small>고정 원본: {view.sourceLabel}</small>}{view.sourceSha256 && <code>{view.sourceSha256}</code>}{view.error && <p role="alert">{view.error}</p>}<div className="gs-auto-rig-actions">{view.recoverable && !view.running && <button type="button" disabled={disabled || submitting} onClick={() => void invoke(props.onRecover)}>저장된 결과만 복구</button>}</div><small>중단·재시작 후 자동 재실행하지 않습니다. 복구는 저장된 결과만 확인합니다.</small></section>}
    {view.candidate && <section aria-label="자동 리그 결과 검토" data-testid="auto-rig-review">
      <strong>{view.adopted ? '현재 사용하는 리그' : '새 리그 후보 · 아직 사용하지 않음'}</strong><p>{view.candidate.label}</p>
      <button type="button" onClick={() => props.onShow(view.candidate!)}>3D 결과 보기</button>
      {view.videos.map(video => <label key={video.url}>{video.label}<video controls preload="metadata" src={video.url} /></label>)}
      {!view.videos.length && (view.hasMotionPreview || view.candidate.files.some(file=>/\.glb$/i.test(file.path)) ? <p>중앙 3D 화면에서 검사용 동작을 선택하고 재생하세요. 팔·팔꿈치·양쪽 무릎을 각각 확인합니다.</p> : <p role="alert">저장된 동작 미리보기가 없습니다. 정지 화면만으로 변형 품질을 판단하지 마세요.</p>)}
      <p>전후 비교에서 가슴·장식의 끌림과 양쪽 무릎의 접힘을 확인하세요. 자동 리깅과 수치 검사를 통과해도 자연스러운 변형을 보장하지 않습니다.</p>
      <details><summary>검사 결과 · {view.checks.filter(check => check.passed).length}/{view.checks.length}</summary>{view.checks.map((check, index) => <p key={index}>{check.passed ? '통과' : '확인 필요'} · {check.label}</p>)}</details>
      {!!view.poses?.length && <details><summary>동작별 변형 수치</summary>{view.poses.map(pose => <p key={pose.name}>{pose.label}{pose.maximumStretch == null ? '' : ` · 최대 늘어남 ${pose.maximumStretch.toFixed(3)}`}{pose.warning ? ` · ${pose.warning}` : ''}</p>)}</details>}
      <details><summary>선택 영역만 가중치 보정 · 선택 사항</summary><section>
        <p>연결된 부위와 뼈 영향을 검사한 뒤 선택한 부위만 별도 후보로 보정합니다. 무릎 형태·토폴로지를 자동 교체하지 않습니다.</p>
        <button type="button" disabled={locked || submitting} onClick={() => void invoke(props.onInspect)}>부위·뼈 영향 검사</button>
        <label>대상 부위<select aria-label="보정 대상 부위" value={meshId} disabled={locked} onChange={event => { setMeshId(event.target.value); setBone(''); props.onRegion?.(view.islands.find(island => JSON.stringify([island.mesh,island.islandId]) === event.target.value)); }}><option value="">검사된 연결 부위 선택</option>{view.islands.map((island,index) => <option key={JSON.stringify([island.mesh,island.islandId])} value={JSON.stringify([island.mesh,island.islandId])}>{island.label ?? island.mesh} · 부위 {index+1} · {island.vertices}정점 · 주요 뼈 {island.bones.slice().sort((a,b)=>b.meanWeight-a.meanWeight)[0]?.name ?? '없음'}</option>)}</select></label>
        {selectedIsland && <><small>현재 뼈 영향: {selectedIsland.bones.map(item => `${item.name} ${Math.round(item.meanWeight * 100)}%`).join(' · ')}</small>{selectedIsland.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}</>}
        <label>보정 방식<select aria-label="가중치 보정 방식" value={repairKind} disabled={locked} onChange={event => setRepairKind(event.target.value as AutoRigRepair['kind'])}><option value="normalize">현재 가중치 합 정규화</option><option value="remove-influence">선택한 뼈 영향 제거</option><option value="rigid-bind">선택한 뼈에 부위 전체 고정</option></select></label>
        <label>기준 뼈<select aria-label="보정 기준 뼈" value={bone} disabled={locked} onChange={event => setBone(event.target.value)}><option value="">검사된 뼈 선택</option>{view.bones.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        {repairKind === 'rigid-bind' && <p role="alert">이 부위의 기존 가중치를 선택한 뼈 100%로 바꿉니다. 관절을 가로지르는 부위에는 부적합합니다.</p>}
        {selectedIsland && selectedIsland.vertices > 500 && repairKind === 'rigid-bind' && <p role="alert"><strong>큰 연결 부위 전체를 한 뼈에 고정합니다.</strong> 몸통·팔·다리가 하나로 연결되어 있으면 함께 굳어집니다. 강조된 범위를 확인하세요.</p>}
        {selectedIsland && !selectedIsland.vertexIndices?.length && <p role="alert">이전 검사는 정확한 강조 영역 정보가 없습니다. 부위·뼈 영향 검사를 다시 실행하세요.</p>}
        {!!selectedIsland?.vertexIndices?.length && !view.highlightReady && <small>왼쪽 3D 화면에 정확한 선택 범위가 표시되어야 보정을 시작할 수 있습니다.</small>}
        <button type="button" disabled={locked || submitting || !view.correctionAvailable || !view.highlightReady || !selectedIsland?.vertexIndices?.length || (repairKind !== 'normalize' && !view.bones.includes(bone))} onClick={() => void invoke(() => props.onCorrect({ mesh: selectedIsland!.mesh, islandId: selectedIsland!.islandId, kind: repairKind, ...(repairKind === 'rigid-bind' ? { targetBone: bone } : repairKind === 'remove-influence' ? { bones: [bone] } : {}) }))}>선택 부위 보정 후보 만들기</button>
        {!view.correctionAvailable && <small>이 결과에서 검증된 선택 영역 보정을 지원하지 않습니다.</small>}
      </section></details>
      <small>리그 사용 후 Unity 설정으로 이동합니다. 내보내기·가져오기는 별도로 실행합니다.</small>
    </section>}
    {props.footerHost ? createPortal(primary,props.footerHost) : <div className="gs-auto-rig-footer">{primary}</div>}
  </div>;
}
