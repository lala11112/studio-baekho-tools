import { useState } from 'react';
import type { AssetVersion } from '../shared/graphics';

type Props = {
  projectId: string;
  version: AssetVersion;
  disabled: boolean;
  accepted: boolean;
  sourceAvailable: boolean;
  procedureRecoveryAvailable: boolean;
  onPrepareRepair: () => void;
  onPrepareReconstruct: () => void;
  onRecoverProcedure: () => void;
  onKeepSource: () => void;
  onAccept: () => void;
  onImage: (path: string, label: string) => void;
};

/** The host registers and validates every view; no paths or front directions are guessed here. */
export function GraphicsContactReview({ projectId, version, disabled, accepted, sourceAvailable, procedureRecoveryAvailable, onPrepareRepair, onPrepareReconstruct, onRecoverProcedure, onKeepSource, onAccept, onImage }: Props) {
  const review = version.contact!;
  const analyzing = review.phase === 'analyze';
  const reconstructing = review.phase === 'reconstruct';
  const blocked = review.status === 'blocked';
  const procedureCompatibilityIssue = reconstructing && blocked && review.warnings.some(warning => /loop_total|읽기\s*전용\s*속성|read[- ]?only/i.test(warning));
  const canRecoverProcedure = procedureCompatibilityIssue && procedureRecoveryAvailable;
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const [loadedImages, setLoadedImages] = useState<string[]>([]);
  const registered = (path?: string) => Boolean(path && version.files.some(file => file.path === path));
  const imageRegistered = (path?: string) => registered(path) && /\.(png|jpe?g|webp)$/i.test(path!);
  const requiredImages = review.views.flatMap(view => [view.beforePath, analyzing ? view.overlayPath : view.afterPath]);
  const missingViews = !review.views.length || requiredImages.some(path => !imageRegistered(path));
  const canReview = registered(review.reportPath) && !missingViews && !failedImages.length && requiredImages.every(path => path && loadedImages.includes(path));
  const ready = analyzing && review.status === 'ready' && review.allowedVertexCount > 0 && registered(review.regionsPath);
  const repaired = !analyzing && review.status === 'repaired';
  function picture(path: string | undefined, label: string) {
    if (!imageRegistered(path)) return <p className="gs-warning" role="status">등록된 비교 이미지를 확인할 수 없습니다.</p>;
    return <button type="button" className="gs-contact-image" onClick={() => onImage(path!, label)} aria-label={`${label} 크게 보기`}>
      <img src={window.desktop.assetUrl(projectId, path!)} alt={label}
        onLoad={() => setLoadedImages(current => current.includes(path!) ? current : [...current, path!])}
        onError={() => setFailedImages(current => current.includes(path!) ? current : [...current, path!])} />
    </button>;
  }
  return <section className="gs-contact-review" aria-label="목·헤어 접합 검토" data-testid="graphics-contact-review" data-phase={review.phase}>
    <header data-testid="graphics-contact-heading"><div><h3>{procedureCompatibilityIssue ? 'Blender 호환 오류로 보정이 중단됐습니다' : blocked ? '허용 범위에서 진행할 수 없어 중단했습니다' : analyzing ? '수정 영역을 확인하세요' : reconstructing ? '목·헤어 구조 보정 전후를 비교하세요' : '접합 보정 전후를 비교하세요'}</h3>
      <p>{blocked ? '아래 이유를 확인하세요. 기존 조립·파트와 채택 상태는 유지됩니다.' : analyzing ? '초록색 영역의 정점 위치만 보정합니다. 표시된 범위를 확인한 다음 실행을 준비하세요.' : '같은 카메라·조명·배율로 기록한 원본과 수정 후보입니다. 파일 검사와 외형 채택은 별개입니다.'}</p></div>
      <span className={`gs-tag${review.status === 'blocked' ? '' : ' gs-ready'}`}>{review.status === 'blocked' ? '보정 중단 · 범위 확인 필요' : analyzing ? '영역 검사 통과 · 외형 검토 대기' : accepted ? '조립·파트 채택됨' : '보존 검사 통과 · 외형 검토 대기'}</span>
    </header>
    {analyzing && !blocked && <div className="gs-contact-legend" aria-label="수정 영역 범례">
      <span><i className="is-allowed" />초록 · 수정 허용 영역 ({review.allowedVertexCount.toLocaleString()}개 정점)</span>
      <span><i className="is-protected" />빨강 · 보호 영역</span>
      <p>얼굴·귀·헤어 바깥 윤곽·의상은 보호합니다. 허용 영역 밖의 형상, 전체 배치, 면 연결, UV·재질은 유지합니다.</p>
    </div>}
    {analyzing && blocked && <div className="gs-result-notes" data-testid="graphics-contact-reconstruct-scope">
      <strong>목·헤어 안쪽의 면을 보완하는 보정을 준비할 수 있습니다</strong>
      <p>얼굴·귀·몸통·의상은 유지합니다. 목 연결부와 머리 가까이의 헤어 일부를 조금 조절하고, 필요한 안쪽 면을 추가합니다. 연결 부근의 헤어 윤곽은 일부 달라질 수 있습니다.</p>
      <p>이전 분석 기록과 기존 모델을 재사용합니다. Astra 보정은 최대 1회이며, 변경 부위의 UV는 다시 확인해야 합니다. 보정 결과는 새 후보로 보관합니다.</p>
    </div>}
    {reconstructing && !blocked && <p className="gs-warning" data-testid="graphics-contact-reconstructed-notice">원본 면은 유지하며 목·헤어의 허용 부위 조절과 안쪽 면 추가를 검사했습니다. 보호 영역 검사는 외형 품질을 보장하지 않으며, 새 면의 UV·텍스처는 별도 검토가 필요합니다.</p>}
    {canRecoverProcedure && <div className="gs-result-notes" data-testid="graphics-contact-procedure-recovery-note">
      <strong>저장된 보정 절차의 호환 오류만 복구합니다</strong>
      <p>Blender의 읽기 전용 속성 오류를 수정해 같은 보정 절차를 이어 실행합니다. 새로운 보정 판단이나 GPT 호출은 없으며, 기존 원본과 채택 상태를 유지합니다.</p>
      <p>로컬 복구는 한 번만 실행합니다. 생성된 후보는 보존 검사를 통과한 뒤 별도로 검토·채택합니다.</p>
    </div>}
    {review.warnings.length > 0 && <div className="gs-contact-warnings" role={review.status === 'blocked' ? 'alert' : undefined}><strong>검토할 사항</strong><ul>{review.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    {review.views.length > 0 && <p className="gs-fine">{blocked ? '검토 이미지' : '비교 시점'} {review.views.length}개 · 아래 이미지 영역을 스크롤해 확인하세요. 이미지를 누르면 크게 볼 수 있습니다.</p>}
    <div className="gs-contact-views" tabIndex={review.views.length ? 0 : undefined} role="region" aria-label="접합 비교 이미지 · 내부 스크롤" data-testid="graphics-contact-views">{review.views.map(view => <section key={view.id} className="gs-contact-view" aria-label={view.label}>
      <h4>{view.label}</h4><div className="gs-contact-pair">
        <figure><figcaption>보정 전 · 기존 조립</figcaption>{picture(view.beforePath, `${view.label} · 보정 전`)}</figure>
        {(!blocked || (analyzing ? view.overlayPath : view.afterPath)) && <figure><figcaption>{analyzing ? '제안한 수정 영역' : '보정 후 · 새 후보'}</figcaption>{picture(analyzing ? view.overlayPath : view.afterPath, `${view.label} · ${analyzing ? '수정 영역' : '보정 후'}`)}</figure>}
      </div>
    </section>)}</div>
    {!blocked && (missingViews || failedImages.length > 0 || !registered(review.reportPath)) && <p className="gs-warning" role="alert">비교 파일을 모두 표시하지 못해 보정·채택을 잠갔습니다. 저장된 결과와 파일 경로를 확인하세요. 새 작업은 자동으로 실행하지 않습니다.</p>}
    {!blocked && !missingViews && !failedImages.length && !canReview && <p role="status">비교 이미지를 불러오는 중입니다.</p>}
    <div className="gs-contact-actions">
      <button type="button" data-testid="graphics-contact-keep" disabled={disabled || !sourceAvailable} onClick={onKeepSource}>기존 결과 유지</button>
      {analyzing && blocked && <button type="button" className="gs-primary" data-testid="graphics-contact-reconstruct" disabled={disabled || !sourceAvailable || !registered(review.reportPath)} onClick={onPrepareReconstruct}>목·헤어 구조 보정 준비</button>}
      {canRecoverProcedure && <button type="button" className="gs-primary" data-testid="graphics-contact-recover-procedure" disabled={disabled || !sourceAvailable || !registered(review.reportPath)} onClick={onRecoverProcedure}>호환 오류 복구 · 추가 GPT 없음</button>}
      {ready && <button type="button" className="gs-primary" data-testid="graphics-contact-repair" disabled={disabled || !canReview} onClick={onPrepareRepair}>이 영역만 보정</button>}
      {repaired && <button type="button" className="gs-primary" data-testid="graphics-contact-accept" disabled={disabled || !canReview || accepted} onClick={onAccept}>{accepted ? '현재 채택한 조립·파트' : '수정한 조립·파트 채택'}</button>}
    </div>
    {!blocked && <p className="gs-fine">{analyzing ? '보정 버튼은 실행할 입력·사용량 카드만 준비합니다. Astra 영역 분석 최대 1회 + 보정 최대 1회, 자동 재시도 없음. 추가 Tripo·fal 비용은 없으며 GPT 사용량이 발생합니다.' : '채택하면 이 조립과 같은 작업의 파트를 함께 반영합니다. 이전 원본과 채택 기록은 보존하며 다음 작업은 자동으로 시작하지 않습니다.'}</p>}
    {analyzing && blocked && <p className="gs-fine">구조 보정 준비는 입력·사용량 카드만 엽니다. 실행 전 앱에서 확인하며, 추가 Tripo·fal 비용 없이 GPT 사용량이 발생합니다. 자동 재시도·자동 채택·UV·텍스처 실행은 없습니다.</p>}
    {review.status === 'blocked' && <p className="gs-warning">{procedureCompatibilityIssue ? '보정 절차 실행 중 호환 오류가 발생한 기록입니다. 기존 원본과 채택 상태는 유지됩니다.' : '보호 영역이나 수정 범위를 확정하지 못했거나, 허용 범위 내에서 해결되지 않아 보정을 중단했습니다.'} UV·텍스처·리깅으로 자동 진행하지 않습니다.</p>}
  </section>;
}
