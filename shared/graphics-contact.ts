/** Saved, app-owned contact review. All paths are registered project-relative files. */
export type GraphicsContactReview = {
  schemaVersion: 1;
  phase: 'analyze' | 'repair';
  status: 'ready' | 'blocked' | 'repaired';
  sourceVersionId: string;
  partVersionIds: string[];
  analysisVersionId?: string;
  reportPath: string;
  regionsPath?: string;
  views: { id: string; label: string; beforePath: string; overlayPath?: string; afterPath?: string }[];
  warnings: string[];
  allowedVertexCount: number;
};

/** Rendering and continuation must use only registered, immutable evidence. */
export function validateContactReview(value: GraphicsContactReview, registeredPaths: string[]): void {
  if (!value || value.schemaVersion !== 1 || !['analyze', 'repair'].includes(value.phase) ||
      !(value.phase === 'analyze' ? ['ready', 'blocked'] : ['repaired', 'blocked']).includes(value.status) ||
      typeof value.sourceVersionId !== 'string' || !value.sourceVersionId ||
      !Array.isArray(value.partVersionIds) || value.partVersionIds.length !== 3 || new Set(value.partVersionIds).size !== 3 ||
      value.partVersionIds.some(id => typeof id !== 'string' || !id) ||
      !Array.isArray(value.warnings) || value.warnings.some(warning => typeof warning !== 'string') ||
      !Number.isSafeInteger(value.allowedVertexCount) || value.allowedVertexCount < 0 ||
      !Array.isArray(value.views) || value.views.length > 30)
    throw Error('접합 검토 기록의 형식이 잘못됐습니다. 기존 원본은 유지됩니다.');
  const paths = new Set(registeredPaths), check = (file: string | undefined) => {
    if (typeof file !== 'string' || !file || !paths.has(file)) throw Error('접합 검토 자료가 등록된 원본 파일과 연결되지 않습니다.');
  };
  check(value.reportPath);
  if (value.regionsPath) check(value.regionsPath);
  if (value.status !== 'blocked' && (!value.regionsPath || !value.allowedVertexCount || !value.views.length))
    throw Error('확인할 접합 영역이나 비교 화면이 없습니다. 보정을 실행하지 않습니다.');
  if (new Set(value.views.map(view => view.id)).size !== value.views.length) throw Error('접합 비교 시점이 중복됩니다.');
  for (const view of value.views) {
    if (!view || typeof view.id !== 'string' || !view.id || typeof view.label !== 'string' || !view.label) throw Error('접합 비교 시점이 없습니다.');
    check(view.beforePath);
    if (view.overlayPath) check(view.overlayPath);
    if (view.afterPath) check(view.afterPath);
    if (value.status === 'ready' && !view.overlayPath || value.status === 'repaired' && !view.afterPath)
      throw Error('접합 영역 또는 전후 비교 화면이 누락됐습니다.');
  }
}
