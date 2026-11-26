import { effectivePropCompositions, getCompositionIssues } from './prop-composition';
import { getPropCoverageReport } from './props';
import type { AssetBinding, GenerationRegion, GenerationSettings, GridMap, ValidationIssue } from './types';
import { effectivePropBehavior } from './prop-behavior';

/** Read-only outcome diagnostics also work after the generated map crosses Electron IPC. */
export function compositionGenerationIssues(map: GridMap, settings: GenerationSettings, bindings: AssetBinding[], region?: GenerationRegion): ValidationIssue[] {
  if (settings.designer?.propLayout !== 'grouped') return [];
  const d = settings.designer, theme = settings.levelDesign?.theme?.trim().toLowerCase();
  const issues = getCompositionIssues(bindings, settings);
  const active = (role: AssetBinding['role']) => role === 'prop' ? d.props : role === 'decoration' ? d.decorations && (d.decorationDensity ?? d.fixtureDensity) > 0 : role === 'vegetation' && d.vegetation && (d.vegetationDensity ?? d.fixtureDensity) > 0;
  if (!['prop', 'decoration', 'vegetation'].some(role => active(role as AssetBinding['role']))) return issues;
  const eligible = bindings.filter(b => active(b.role) && !b.wallMount && b.prop?.size && b.prop.weight > 0
    && b.prop.placement === 'floor' && effectivePropBehavior(b) !== 'surfaceAccessory' && (b.role !== 'prop' || b.prop.blocksMovement) && b.prop.roomTypes.includes(d.preset)
    && (!theme || !b.prop.tags.length || b.prop.tags.some(tag => tag.toLowerCase() === theme))
    && effectivePropCompositions(b).some(c => ['equipment', 'storage', 'natural'].includes(c.usage) && c.family.trim()));
  if (!eligible.length) issues.push({ severity: 'warning', code: 'grouped-props-no-catalog', message: '크기와 용도가 확인된 바닥 소품 군집이 없습니다. 배치할 역할·크기·용도·호환 계열을 확인하세요.' });
  if (d.props) {
    const coverage = getPropCoverageReport(map, settings, bindings, region);
    if (coverage.unmet && coverage.actualPercent !== null) issues.push({ severity: 'warning', code: 'room-composition-coverage',
      message: `소품 점유율 ${coverage.actualPercent.toFixed(1)}% / 목표 ${coverage.targetPercent}%. 중심 장면·보조 묶음·여백을 유지하면서 원본 크기·통행·설비 앞과 의자 뒤의 사용 공간을 만족하는 배치만 적용했습니다.` });
  }
  const inside = (c: { x: number; row: number }) => !region || c.x >= region.x && c.row >= region.row && c.x < region.x + region.width && c.row < region.row + region.height;
  let floors = 0;
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) if (inside({ x, row }) && '.P'.includes(map.rows[row][x])) floors++;
  for (const role of ['decoration', 'vegetation'] as const) {
    if (!active(role)) continue;
    const density = (role === 'decoration' ? d.decorationDensity : d.vegetationDensity) ?? d.fixtureDensity;
    const target = Math.ceil(floors * density / 100);
    const actual = (map.propInstances ?? []).filter(p => (p.role ?? (p.blocksMovement ? 'prop' : 'decoration')) === role && p.cells.some(inside)).length
      + (map.fixtures ?? []).filter(f => !f.wall && f.role === role && inside(f)).length;
    if (actual < target) issues.push({ severity: 'warning', code: 'room-composition-count', message: `${role === 'decoration' ? '장식' : '식생'} ${actual}개 / 목표 ${target}개. 중심·보조 장면과 여백, 호환 부품·원본 크기·통행·설비와 좌석의 사용 공간을 지키는 배치만 적용했습니다.` });
  }
  return issues;
}
