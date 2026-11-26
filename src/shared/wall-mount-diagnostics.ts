import type { AssetBinding, Cell, GenerationRegion, GenerationSettings, GridMap, ValidationIssue } from './types';
import { DEFAULT_WALL_SETTINGS, placeWallMounts, wallMountDependencies } from './wall-mounts';

export interface WallMountReadiness {
  enabled: boolean;
  configured: number;
  measured: number;
  /** At least one enabled category can use built-in planning objects. */
  temporaryFallback: boolean;
  issues: ValidationIssue[];
}

const warning = (code: string, message: string): ValidationIssue => ({ severity: 'warning', code, message });
const measured = (binding: AssetBinding) => !!(binding.bounds || binding.prop?.size || binding.wallMount?.collisionBoxes.length);
const configFor = (settings: GenerationSettings) => ({ ...DEFAULT_WALL_SETTINGS, ...settings.designer?.wallMounts });
const applies = (binding: AssetBinding, settings: ReturnType<typeof configFor>) => !!binding.wallMount
  && (binding.wallMount.kind === 'single' ? settings.singles && settings.density > 0 : settings.runs && settings.runDensity > 0);
const selected = (binding: AssetBinding) => (binding.wallMount?.probability ?? 0) > 0 && (binding.prop?.weight ?? 1) > 0;
const deduplicate = (issues: ValidationIssue[]) => [...new Map(issues.map(issue => [`${issue.code}:${issue.message}`, issue])).values()];

/** Reports the saved choices without enabling placement or changing asset roles. */
export function getWallMountReadiness(settings: GenerationSettings, bindings: AssetBinding[]): WallMountReadiness {
  const config = configFor(settings), configured = bindings.filter(binding => binding.wallMount);
  const ready = configured.filter(measured), issues: ValidationIssue[] = [];
  const temporaryFallback = config.enabled && config.placeholderFallback !== false && (
    config.singles && config.density > 0 && !configured.some(binding => binding.wallMount!.kind === 'single')
    || config.runs && config.runDensity > 0 && !configured.some(binding => binding.wallMount!.kind !== 'single')
  );
  const result: WallMountReadiness = { enabled: config.enabled, configured: configured.length, measured: ready.length, temporaryFallback, issues };
  if (!config.enabled) {
    if (configured.length) issues.push(warning('wall-disabled', '벽 부착 에셋이 등록되어 있지만 생성 시 벽 부착물 배치가 꺼져 있습니다. 생성 조건에서 켜 주세요.'));
    return result;
  }
  if (!configured.length) {
    if (temporaryFallback) return result;
    if (!config.singles || config.density <= 0) {
      if (!config.runs || config.runDensity <= 0) {
        issues.push(warning('wall-category', '벽 부착물의 배치 종류가 꺼져 있거나 목표 점유율이 0%입니다. 개별 장식 또는 배관·케이블 배치와 목표 점유율을 확인하세요.'));
        return result;
      }
    }
    issues.push(warning('wall-catalog', '벽 부착물로 등록된 프리팹이 없고 임시 배치도 꺼져 있습니다. 임시 벽 부착물 사용을 켜거나 에셋의 ‘벽 부착 자동 배치에 사용’을 켜고 Unity의 BaekhoWallModule을 설정한 v2 크기 JSON을 가져오세요.'));
    return result;
  }
  if (ready.length !== configured.length) issues.push(warning('wall-unmeasured', '크기가 측정되지 않은 벽 부착물은 배치하지 않았습니다. Unity 크기 파일을 가져오거나 충돌 상자를 지정해 주세요.'));
  const applicable = configured.filter(binding => applies(binding, config));
  if (!applicable.length && !temporaryFallback) {
    issues.push(warning('wall-category', '등록한 벽 부착물에 해당하는 배치 종류가 꺼져 있거나 목표 점유율이 0%입니다. 개별 장식 또는 배관·케이블 배치와 목표 점유율을 확인하세요.'));
  } else if (applicable.length && applicable.every(binding => !selected(binding))) {
    issues.push(warning('wall-selection', '현재 배치 종류에 해당하는 벽 부착물의 설치 확률 또는 선택 가중치가 모두 0입니다. 사용할 에셋의 값을 0보다 크게 지정하세요.'));
  }
  return result;
}

/** Replays only the local planner to explain an empty result; the supplied map stays untouched. */
export function wallMountGenerationIssues(map: GridMap, settings: GenerationSettings, bindings: AssetBinding[], region?: GenerationRegion): ValidationIssue[] {
  const readiness = getWallMountReadiness(settings, bindings), issues = [...readiness.issues], config = configFor(settings);
  if (!readiness.enabled) return issues;
  const inside = (cell: Cell) => !region || cell.x >= region.x && cell.x < region.x + region.width && cell.row >= region.row && cell.row < region.row + region.height;
  const mounted = map.fixtures?.filter(fixture => fixture.wall && wallMountDependencies(fixture).some(inside)) ?? [];
  const temporaryCount = mounted.filter(fixture => fixture.wall!.placeholder).length;
  if (temporaryCount) issues.push(warning('wall-placeholder', `임시 벽 부착물 ${temporaryCount}개가 배치되어 있습니다. 배치를 확인한 뒤 실제 프리팹으로 교체하세요. Unity로 내보내기 전에는 임시 부착물을 교체하거나 제거해야 합니다.`));
  if (config.runs && config.runOrientation === 'both' && config.connectRuns !== false && mounted.some(f => f.wall!.runId)
    && !(config.runLayout === 'composed' && config.runHeight?.mode === 'fixed')
    && !mounted.some(f => f.wall!.runId && f.wall!.sockets.some(s => Math.abs(s.direction.y) > .99) && f.wall!.sockets.some(s => Math.abs(s.direction.y) < .01))) {
    issues.push(warning('wall-junction-empty', '가로·세로 연결이 켜져 있지만 연결된 엘보·T자 분기가 없습니다. 같은 세트의 연결 부품·연결점 규격·벽의 빈 공간과 잠금 또는 수동 수정된 구간을 확인한 뒤 현재 맵 자동 배치를 실행해 주세요.'));
  }
  if (!readiness.temporaryFallback && !bindings.some(binding => applies(binding, config) && measured(binding) && selected(binding))) return issues;
  if (mounted.length) return issues;
  const planned = placeWallMounts(map, settings, bindings, region);
  issues.push(...planned.issues);
  if (planned.addedSingles || planned.addedModules) {
    issues.push(warning('wall-generation-empty', `벽 부착물 자동 배치가 켜져 있지만 생성 결과에 부착물이 없습니다. 현재 조건에서는 ${planned.addedSingles + planned.addedModules}개를 설치할 수 있습니다. ‘현재 맵에 벽 부착물 자동 배치’를 실행해 주세요.`));
  } else if (!planned.issues.length) {
    issues.push(warning('wall-generation-empty', '벽 부착물을 배치할 벽면 또는 연결 부품을 찾지 못했습니다. 벽면 크기·설치 높이와 같은 세트의 직선·코너·끝마감을 확인하세요.'));
  }
  return deduplicate(issues);
}
