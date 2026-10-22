import { useState } from 'react';
import type { GraphicsAction, GraphicsWorkspace } from '../shared/graphics';
import type { GraphicsStorageReport } from '../shared/graphics-storage';
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
export function GraphicsStoragePanel({ onAction }: { onAction: (action: GraphicsAction) => Promise<unknown> }) {
  const [report, setReport] = useState<GraphicsStorageReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function inspect() {
    setLoading(true); setError('');
    try {
      const result = await onAction({ kind: 'inspect-storage' }) as GraphicsWorkspace;
      if (!result?.storageReport) throw Error('저장 공간 조사 결과를 받지 못했습니다.');
      setReport(result.storageReport);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }
  return <section className="gs-storage" aria-label="저장 공간 현황">
    <p>자동 삭제 OFF · 파일을 읽거나 변경하지 않고 크기 정보만 조사합니다. GPT·유료 서비스 호출은 없습니다.</p>
    <button disabled={loading} onClick={() => void inspect()}>{loading ? '용량 조사 중…' : '저장 공간 조사'}</button>
    {error && <p role="alert">{error}</p>}
    {report && <>
      <h3>조사한 파일 합계 {size(report.totalBytes)}</h3>
      <p>파일 크기 기준 · 휴지통·임시 폴더·Unity 프로젝트 제외. 하드링크·파일 압축에 따른 실제 디스크 할당량과 다를 수 있습니다.</p>
      {report.roots.map(root => <p key={root.path}><strong>{root.label}: {size(root.bytes)}</strong><br /><code>{root.path}</code>{root.incomplete && ' · 일부 읽기 실패'}</p>)}
      <div className="gs-storage-rows">{report.categories.filter(row => row.files > 0).map(row => <article key={row.id}>
        <strong>{row.label}</strong><b>{size(row.bytes)}</b><small>{row.files.toLocaleString()}개 파일 · {row.note}</small>
      </article>)}</div>
      <p>조사 시각 {new Date(report.measuredAt).toLocaleString('ko-KR')} · 건너뛴 연결 {report.skippedLinks}개 · 읽기 실패 {report.unreadable}개</p>
      <p>원본·보관본은 정리 대상이 아닙니다. 오래된 배포본과 캐시도 사용 여부를 별도로 확인해야 합니다. 이 화면에서는 삭제하지 않습니다.</p>
    </>}
  </section>;
}
