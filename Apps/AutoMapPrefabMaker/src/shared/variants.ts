import { generationConditionIssues, parseGenerationSettings } from './features';
import { parseProjectFile, validateMap } from './map';
import { resolveGenerationSettings } from './room-presets';
import { analyzeLevelDesign } from './level-design';
import type { AssetBinding, GenerationSettings, GridMap, ProjectFile } from './types';

export type VariantStatus = 'waiting' | 'image' | 'extract' | 'ready' | 'error' | 'cancelled';
export interface MapVariant {
  id: string;
  /** Zero-based position in this batch. */
  index: number;
  label: string;
  status: VariantStatus;
  project?: ProjectFile;
  error?: string;
}
export interface VariantDependencies {
  generateImage: (settings: GenerationSettings, catalog?: AssetBinding[]) => Promise<string>;
  /** The extraction service already applies the selected local feature layers. */
  extractLayout: (settings: GenerationSettings, image: string, catalog?: AssetBinding[]) => Promise<GridMap>;
  isCancelled: () => boolean;
  /** Every notification is an independent snapshot, safe for the UI to retain. */
  onUpdate?: (variants: MapVariant[]) => void;
}

const designs = [
  ['중앙 집중형', 'Use a broad, balanced central arena. Arrange the permitted terrain features around its center and leave a generous connected playable interior.'],
  ['비대칭 공간형', 'Use an asymmetric single chamber with its broad main usable area offset west and a different outer silhouette. Relocate only permitted terrain features to balance the east side.'],
  ['넓은 가로형', 'Emphasize a broad east-west chamber silhouette with shallow stepped edges. Redistribute the permitted features across its long axis while retaining a generous connected interior.'],
  ['넓은 세로형', 'Emphasize a broad north-south chamber silhouette with a different perimeter and generous central floor. Relocate permitted features along that axis.'],
  ['계단형 외곽', 'Use a diagonally balanced stair-stepped outer perimeter on the square grid, without diagonal movement. Make the broad continuous interior and permitted feature positions differ from a rectangular chamber.'],
  ['팔각 외곽형', 'Approximate a broad octagonal chamber with stepped grid corners. Keep a generous open center and reposition permitted terrain features around the interior edge.'],
  ['확장 모서리형', 'Shape one broad room with unequal expanded corner areas directly joined to the central floor. Keep all joins wide and open; use no separated rooms or connecting passages.'],
  ['엇갈린 공간형', 'Use offset broad recesses in the single-room perimeter and distribute permitted features in an alternating arrangement. Keep the entire interior generously open and connected.'],
] as const;

function assertCount(count: number): void {
  if (!Number.isInteger(count) || count < 2 || count > 8) throw new Error('후보 개수는 2~8개의 정수로 입력하세요.');
}

/** Variation instructions preserve toggles/counts and resolve range-based dimensions before either AI phase. */
export function variantSettings(settings: GenerationSettings, index: number, count: number): GenerationSettings {
  assertCount(count);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('후보 번호가 생성 범위를 벗어났습니다.');
  const source = resolveGenerationSettings(parseGenerationSettings(structuredClone(settings)), index);
  const variation = `\n\n[BAEKHO MAP VARIANT ${index + 1}/${count}]\n${designs[index][1]}\nThis is a structural variation within the user's design brief. The original brief and explicit generation settings take priority over every suggestion here. Preserve all selected feature toggles, exact counts, dimensions, heights and door requirements. Do not add disabled features or change the room purpose. Never create corridors, connecting passages, separate rooms, neighboring modules or stacked playable floors. Vary the permitted room silhouette and terrain arrangement, not merely names, lighting, decoration or camera angle. If the brief fixes a suggested feature, keep it fixed and vary only other permitted geometry.`;
  if (source.prompt.length + variation.length > 6000) throw new Error('맵 설명과 후보별 설계 지시를 합치면 6,000자를 넘습니다. 원래 설명을 줄여 주세요. 설명을 자동으로 자르지는 않습니다.');
  return { ...source, prompt: source.prompt + variation };
}

/** Canonical terrain signature: cosmetic/gameplay layers and metadata cannot disguise duplicate geography. */
export function variantGeometryKey(map: GridMap): string {
  const sorted = (values: unknown[][]) => values.map(value => JSON.stringify(value)).sort();
  return JSON.stringify({
    width: map.width, height: map.height, cellSize: map.cellSize, rows: map.rows,
    elevations: map.elevations.map((row, y) => row.map((value, x) => map.rows[y][x] === '_' ? 0 : value)),
    ramps: sorted(map.ramps.map(r => [r.x, r.row, r.direction, r.rise, r.kind ?? 'stair'])),
    bridges: sorted((map.bridges ?? []).map(b => [b.x, b.row, b.direction % 180])),
    connections: sorted(map.connections.map(c => [c.x, c.row, c.direction, c.width, c.height])),
    ceilings: sorted((map.ceilings ?? []).map(c => [c.x, c.row, c.undersideY])),
    walls: sorted((map.wallHeights ?? []).map(w => [w.x, w.row, w.height])),
    cliffs: sorted((map.cliffs ?? []).map(c => [c.x, c.row, c.direction, c.depth])),
  });
}

/** Generate sequentially without retries or mutations to the current project. */
export async function generateVariants(source: ProjectFile, count: number, deps: VariantDependencies): Promise<MapVariant[]> {
  assertCount(count);
  const snapshot = parseProjectFile(structuredClone(source));
  // Preflight every prompt before the first paid call; never silently trim the user's design.
  const baseSettings = structuredClone(snapshot.settings);
  if ((baseSettings.roomPreset || baseSettings.levelDesign) && baseSettings.seed === undefined) baseSettings.seed = crypto.getRandomValues(new Uint32Array(1))[0];
  // A new batch chooses each candidate afresh; extraction retries use its resolved request.
  if (baseSettings.roomPreset || baseSettings.levelDesign) baseSettings.sizeResolved = false;
  const requests = Array.from({ length: count }, (_, index) => variantSettings(baseSettings, index, count));
  const batchId = crypto.randomUUID();
  const variants: MapVariant[] = requests.map((_, index) => ({
    id: `variant_${batchId}_${index + 1}`, index, label: `${index + 1}번 · ${designs[index][0]}`, status: 'waiting',
  }));
  const emit = () => deps.onUpdate?.(structuredClone(variants));
  const geometry = new Set<string>();
  const cancelRemaining = (start: number) => {
    for (let index = start; index < variants.length; index++) if (variants[index].status !== 'ready' && variants[index].status !== 'error') {
      variants[index].status = 'cancelled'; delete variants[index].project; delete variants[index].error;
    }
    emit();
  };
  emit();
  for (let index = 0; index < variants.length; index++) {
    if (deps.isCancelled()) { cancelRemaining(index); break; }
    const variant = variants[index], settings = requests[index];
    variant.status = 'image'; emit();
    if (deps.isCancelled()) { cancelRemaining(index); break; }
    try {
      const image = await deps.generateImage(structuredClone(settings), structuredClone(snapshot.bindings));
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      variant.status = 'extract'; emit();
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      const map = structuredClone(await deps.extractLayout(structuredClone(settings), image, structuredClone(snapshot.bindings)));
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      const errors = validateMap(map).filter(issue => issue.severity === 'error');
      if (errors.length) throw new Error(errors.slice(0, 3).map(issue => issue.message).join(' '));
      if (map.width !== settings.width || map.height !== settings.height || map.cellSize !== settings.cellSize || map.maxStepHeight !== settings.maxStepHeight || map.connections.length !== settings.connectionCount)
        throw new Error('생성된 맵의 크기, 셀 간격, 이동 단차 또는 연결문 수가 요청 조건과 다릅니다.');
      const conditionErrors = generationConditionIssues(map, settings).filter(issue => issue.severity === 'error');
      if (conditionErrors.length) throw new Error(conditionErrors.slice(0, 3).map(issue => issue.message).join(' '));
      if (settings.levelDesign) {
        const designErrors = analyzeLevelDesign(map, settings).issues.filter(issue => issue.severity === 'error');
        if (designErrors.length) throw new Error(designErrors.slice(0, 3).map(issue => issue.message).join(' '));
      }
      map.name = `${index + 1}번 후보 - ${map.name}`.slice(0, 80).replace(/[. ]+$/, '');
      const savedSettings = settings.roomPreset || settings.levelDesign ? { ...settings, prompt: snapshot.settings.prompt } : structuredClone(snapshot.settings);
      const project = parseProjectFile({ formatVersion: 1, map, settings: savedSettings, bindings: structuredClone(snapshot.bindings), blueprintDataUrl: image });
      const key = variantGeometryKey(project.map);
      if (geometry.has(key)) throw new Error('앞서 생성한 후보와 지형이 같습니다. 중복 후보로 제외했으며 자동으로 다시 생성하지 않습니다.');
      geometry.add(key);
      variant.project = project; variant.status = 'ready';
    } catch (error) {
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      variant.status = 'error'; variant.error = error instanceof Error ? error.message : String(error);
    }
    emit();
  }
  return structuredClone(variants);
}
