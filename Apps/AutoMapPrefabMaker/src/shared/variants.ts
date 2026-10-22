import { generationConditionIssues, parseGenerationSettings } from './features';
import { parseProjectFile, validateMap } from './map';
import { resolveGenerationSettings } from './room-presets';
import { analyzeLevelDesign } from './level-design';
import { assertManualConcept, conceptForRequest, conceptMode, parseConceptText } from './concepts';
import { wallMountGenerationIssues } from './wall-mount-diagnostics';
import type { AssetBinding, ConceptGenerationContext, GenerationSettings, GridMap, MapConcept, ProjectFile } from './types';

export type VariantStatus = 'waiting' | 'concept' | 'image' | 'extract' | 'ready' | 'error' | 'cancelled';
export interface MapVariant {
  id: string;
  /** Zero-based position in this batch. */
  index: number;
  label: string;
  status: VariantStatus;
  /** The human-readable brief, without structural variation instructions. */
  concept?: MapConcept;
  project?: ProjectFile;
  error?: string;
  warnings?: string[];
}
export interface VariantDependencies {
  generateConcept?: (settings: GenerationSettings, catalog?: AssetBinding[], context?: ConceptGenerationContext) => Promise<string>;
  generateImage: (settings: GenerationSettings, catalog?: AssetBinding[]) => Promise<string>;
  /** The extraction service already applies the selected local feature layers. */
  extractLayout: (settings: GenerationSettings, image: string, catalog?: AssetBinding[]) => Promise<GridMap>;
  isCancelled: () => boolean;
  /** Every notification is an independent snapshot, safe for the UI to retain. */
  onUpdate?: (variants: MapVariant[]) => void;
}

const designs = [
  ['치우친 열린 공간형', 'Favor a broad usable floor area offset toward the preferred side, with a shallower opposite edge and unequal perimeter setbacks. Keep a generous continuous movement area.'],
  ['서로 다른 모서리형', 'Favor one broad corner expansion near the preferred side and a smaller, differently shaped setback on another edge. Keep both directly joined to the same open floor.'],
  ['엇갈린 외곽형', 'Favor shallow, unequal wall recesses staggered along the preferred side and its clockwise neighbor. Vary their depth and spacing rather than repeating opposing bays.'],
  ['완만한 확장형', 'Favor a broad room that widens toward the preferred side, with different stepped edges on either flank. Keep the narrow end wide enough for circulation and requested door openings.'],
  ['불규칙 꺾임형', 'Favor a few unequal grid-aligned bends in the perimeter, with the largest bend near the preferred side and a different contour opposite it. Preserve one wide connected interior without narrow necks.'],
  ['한쪽 돌출형', 'Favor one wide, shallow expansion on the preferred side and a differently placed short inset elsewhere. Join the expansion fully to the usable floor rather than forming another room.'],
  ['크기가 다른 여유 공간형', 'Favor two unequal floor expansions on adjacent edges, with the larger one toward the preferred side. Use different widths and offsets while preserving a broad continuous interior.'],
  ['엇갈린 지형형', 'Favor unequal placement of already permitted terrain features toward the preferred side and its clockwise neighbor, leaving different approach lengths and open retreat space. If no terrain features are enabled, vary shallow perimeter setbacks instead.'],
] as const;

/** A stable orientation salt avoids making every asymmetric candidate favor west. */
function preferredSide(settings: GenerationSettings, index: number): string {
  let salt = settings.seed ?? 0;
  salt = Math.imul(salt ^ salt >>> 16, 0x45d9f3b);
  salt ^= salt >>> 16;
  return ['north', 'east', 'south', 'west'][((salt >>> 0) + index) % 4];
}

function assertCount(count: number): void {
  if (!Number.isInteger(count) || count < 2 || count > 8) throw new Error('후보 개수는 2~8개의 정수로 입력하세요.');
}

/** Variation instructions preserve toggles/counts and resolve range-based dimensions before either AI phase. */
export function variantSettings(settings: GenerationSettings, index: number, count: number): GenerationSettings {
  assertCount(count);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('후보 번호가 생성 범위를 벗어났습니다.');
  const source = resolveGenerationSettings(parseGenerationSettings(structuredClone(settings)), index);
  return appendVariation(source, index, count);
}

/** Resolved conditions are shared by concept, blueprint and extraction without choosing sizes twice. */
function appendVariation(source: GenerationSettings, index: number, count: number): GenerationSettings {
  const variation = `\n\n[BAEKHO MAP VARIANT ${index + 1}/${count}]\nPreferred side: ${preferredSide(source, index)}. Apply this preference only to unfixed geometry.\n${designs[index][1]}\nThis is a structural variation within the user's design brief. The original brief and explicit generation settings take priority over every suggestion here, including explicitly requested symmetry, fixed silhouettes and door locations. Preserve all selected feature toggles, exact counts, dimensions, heights and door requirements. Do not add disabled features or change the room purpose. Favor natural asymmetry in unfixed perimeter contours and permitted terrain placement; do not achieve it by compromising safe entry, dodge clearance or reachable routes. Keep safe rooms suitable for their purpose. Never create corridors, connecting passages, separate rooms, neighboring modules or stacked playable floors. Vary the permitted room silhouette and terrain arrangement, not merely names, lighting, decoration or camera angle. If the brief fixes a suggested feature, keep it fixed and vary only other permitted geometry.`;
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
  const automatic = conceptMode(snapshot.settings) === 'ai';
  if (!automatic) assertManualConcept(snapshot.settings);
  // Preflight every manual prompt before the first paid call; AI briefs are checked when they arrive.
  const baseSettings = structuredClone(snapshot.settings);
  if ((baseSettings.roomPreset || baseSettings.levelDesign) && baseSettings.seed === undefined) baseSettings.seed = crypto.getRandomValues(new Uint32Array(1))[0];
  // A new batch chooses each candidate afresh; extraction retries use its resolved request.
  if (baseSettings.roomPreset || baseSettings.levelDesign) baseSettings.sizeResolved = false;
  const resolved = Array.from({ length: count }, (_, index) => resolveGenerationSettings(parseGenerationSettings(structuredClone(baseSettings)), index));
  const requests = automatic ? [] : resolved.map((settings, index) => appendVariation(settings, index, count));
  const batchId = crypto.randomUUID();
  const variants: MapVariant[] = resolved.map((_, index) => ({
    id: `variant_${batchId}_${index + 1}`, index, label: `${index + 1}번 · ${designs[index][0]}`, status: 'waiting',
  }));
  const emit = () => deps.onUpdate?.(structuredClone(variants));
  const geometry = new Set<string>();
  const previousConcepts: string[] = [];
  const cancelRemaining = (start: number) => {
    for (let index = start; index < variants.length; index++) if (variants[index].status !== 'ready' && variants[index].status !== 'error') {
      variants[index].status = 'cancelled'; delete variants[index].project; delete variants[index].error;
    }
    emit();
  };
  emit();
  for (let index = 0; index < variants.length; index++) {
    if (deps.isCancelled()) { cancelRemaining(index); break; }
    const variant = variants[index];
    try {
      let settings: GenerationSettings;
      if (automatic) {
        variant.status = 'concept'; emit();
        if (deps.isCancelled()) { cancelRemaining(index); break; }
        if (!deps.generateConcept) throw new Error('AI 컨셉 작성 기능을 사용할 수 없습니다. 앱을 다시 시작해 주세요.');
        const text = await deps.generateConcept({ ...structuredClone(resolved[index]), prompt: '' }, structuredClone(snapshot.bindings), {
          previousConcepts: [...previousConcepts], candidateIndex: index, candidateCount: count,
        });
        if (deps.isCancelled()) { cancelRemaining(index); break; }
        variant.concept = { source: 'ai', text: parseConceptText(text) };
        previousConcepts.push(variant.concept.text);
        emit();
        if (deps.isCancelled()) { cancelRemaining(index); break; }
        settings = appendVariation(conceptForRequest(resolved[index], variant.concept), index, count);
      } else {
        variant.concept = { source: 'manual', text: parseConceptText(snapshot.settings.prompt, 'manual') };
        settings = requests[index];
      }
      variant.status = 'image'; emit();
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      const image = await deps.generateImage(structuredClone(settings), structuredClone(snapshot.bindings));
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      variant.status = 'extract'; emit();
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      const map = structuredClone(await deps.extractLayout(structuredClone(settings), image, structuredClone(snapshot.bindings)));
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      const errors = validateMap(map, snapshot.bindings).filter(issue => issue.severity === 'error');
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
      const savedSettings = settings.roomPreset || settings.levelDesign ? { ...resolved[index], prompt: snapshot.settings.prompt } : structuredClone(snapshot.settings);
      const project = parseProjectFile({ formatVersion: 1, map, settings: savedSettings, bindings: structuredClone(snapshot.bindings), blueprintDataUrl: image, concept: variant.concept });
      const key = variantGeometryKey(project.map);
      if (geometry.has(key)) throw new Error('앞서 생성한 후보와 지형이 같습니다. 중복 후보로 제외했으며 자동으로 다시 생성하지 않습니다.');
      geometry.add(key);
      const wallWarnings = wallMountGenerationIssues(map, settings, snapshot.bindings).map(issue => issue.message);
      if (wallWarnings.length) variant.warnings = wallWarnings;
      variant.project = project; variant.status = 'ready';
    } catch (error) {
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      variant.status = 'error'; variant.error = error instanceof Error ? error.message : String(error);
    }
    emit();
  }
  return structuredClone(variants);
}
