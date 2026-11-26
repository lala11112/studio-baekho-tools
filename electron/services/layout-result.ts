import { mapStructureErrors, validateMap } from '../../src/shared/map';
import { clearGroupedPropHints } from '../../src/shared/grouped-props';
import { analyzeLevelDesign } from '../../src/shared/level-design';
import { applyGeneratedFeatures, generationConditionIssues } from '../../src/shared/features';
import type { AssetBinding, GenerationRegion, GenerationSettings, GenerationStage, GridMap } from '../../src/shared/types';

export type StageRunner = <T>(stage: GenerationStage, operation: () => T | Promise<T>) => Promise<T>;

/** Shared validation for AI-returned map JSON, used by every analysis provider. */
export async function finalizeLayoutText(text: string | undefined, settings: GenerationSettings, region: GenerationRegion | undefined,
  catalog: AssetBinding[] | undefined, method: 'image' | 'direct', stage: StageRunner, label = 'Codex'): Promise<GridMap> {
  const suffix = method === 'image' ? ' 설계도는 유지되므로 다시 분석해 주세요.' : ' 생성 조건을 확인하고 다시 생성해 주세요.';
  const geography = await stage('validation', () => {
    let map: GridMap;
    try { map = JSON.parse(String(text ?? '')) as GridMap; }
    catch { throw new Error(`${label}가 올바른 배치도 JSON을 반환하지 않았습니다.${suffix}`); }
    return normalizeLayout(map, settings, region, catalog, suffix, label);
  });
  // The caller merges protected cells first, then applies and checks region-local features.
  if (region) return geography;
  const generated = await stage('placement', () => applyGeneratedFeatures(geography, settings, undefined, catalog));
  return stage('validation', () => {
    const conditionErrors = [...validateMap(generated, catalog), ...generationConditionIssues(generated, settings), ...(settings.levelDesign ? analyzeLevelDesign(generated, settings).issues : [])].filter(issue => issue.severity === 'error');
    if (conditionErrors.length) throw new Error(`생성 조건을 만족하지 못했습니다: ${conditionErrors.slice(0, 3).map(issue => issue.message).join(' ')}${suffix}`);
    return generated;
  });
}

function normalizeLayout(input: GridMap, settings: GenerationSettings, region: GenerationRegion | undefined, catalog: AssetBinding[] | undefined, suffix: string, label: string): GridMap {
  let map = input;
  const structureErrors = mapStructureErrors(map);
  if (structureErrors.length) throw new Error(`${label} 배치도가 검증을 통과하지 못했습니다: ${structureErrors.slice(0, 3).join(' ')}${suffix}`);
  if (map.width !== settings.width || map.height !== settings.height || map.cellSize !== settings.cellSize || map.maxStepHeight !== settings.maxStepHeight) throw new Error(`${label} 배치도 크기 또는 이동 단차가 요청한 설정과 다릅니다.${suffix}`);
  if (map.connections.length !== settings.connectionCount) throw new Error(`${label} 배치도의 연결문 수가 요청한 설정과 다릅니다.${suffix}`);
  if (map.assetOverrides.length) throw new Error('AI 배치도는 셀 에셋 지정을 포함할 수 없습니다. 에셋은 앱에서 연결해 주세요.');
  if (map.structureSettings || ['ceilings', 'wallHeights', 'cliffs', 'fixtures', 'markers', 'lockedCells', 'zones', 'pitBottoms', 'structureFills', 'propInstances'].some(key => (map as unknown as Record<string, unknown[]>)[key]?.length)) throw new Error('AI 배치도에 허용되지 않는 추가 콘텐츠가 있습니다. 다시 분석해 주세요.');
  const d = settings.designer;
  if (d?.propLayout === 'grouped' && (d.props || d.decorations || d.vegetation)) map = clearGroupedPropHints(map, region);
  const errors = validateMap(map, catalog).filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(`${label} 배치도가 검증을 통과하지 못했습니다: ${errors.slice(0, 3).map(issue => issue.message).join(' ')}${suffix}`);
  return {
    version: 4, name: map.name, width: map.width, height: map.height, cellSize: map.cellSize, rows: [...map.rows],
    elevations: map.elevations.map(row => [...row]), ramps: map.ramps.map(ramp => ({ ...ramp })), maxStepHeight: map.maxStepHeight,
    connections: map.connections.map(connection => ({ ...connection })), assetOverrides: [], bridges: (map.bridges ?? []).map(b => ({ ...b })),
  };
}
