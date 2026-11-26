import { generationConditionIssues, parseGenerationSettings } from './features';
import { parseProjectFile, validateMap } from './map';
import { resolveGenerationSettings } from './room-presets';
import { analyzeLevelDesign } from './level-design';
import { assertManualConcept, conceptForRequest, conceptMode, parseConceptText } from './concepts';
import { wallMountGenerationIssues } from './wall-mount-diagnostics';
import { compositionGenerationIssues } from './composition-diagnostics';
import { compareGeometry, summarizeGeometry, variantGeometryKey } from './geometry-similarity';
import { spatialIntent, type ImageGenerationContext } from './spatial-intent';
import type { AssetBinding, ConceptGenerationContext, GenerationSettings, GridMap, MapConcept, ProjectFile } from './types';

export { variantGeometryKey } from './geometry-similarity';

export type VariantStatus = 'waiting' | 'concept' | 'image' | 'extract' | 'layout' | 'ready' | 'error' | 'cancelled';
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
  generateImage: (settings: GenerationSettings, catalog?: AssetBinding[], context?: ImageGenerationContext) => Promise<string>;
  /** The extraction service already applies the selected local feature layers. */
  extractLayout: (settings: GenerationSettings, image: string, catalog?: AssetBinding[]) => Promise<GridMap>;
  /** Direct generation also returns the completed local feature layers. */
  generateLayout?: (settings: GenerationSettings, catalog?: AssetBinding[], context?: ImageGenerationContext) => Promise<GridMap>;
  isCancelled: () => boolean;
  /** Every notification is an independent snapshot, safe for the UI to retain. */
  onUpdate?: (variants: MapVariant[]) => void;
}

function assertCount(count: number): void {
  if (!Number.isInteger(count) || count < 2 || count > 8) throw new Error('후보 개수는 2~8개의 정수로 입력하세요.');
}

/** Resolve once; structural suggestions belong only to the generation request context. */
export function variantSettings(settings: GenerationSettings, index: number, count: number): GenerationSettings {
  assertCount(count);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('후보 번호가 생성 범위를 벗어났습니다.');
  return resolveGenerationSettings(parseGenerationSettings(structuredClone(settings)), index);
}

/** Generate sequentially without retries or mutations to the current project. */
export async function generateVariants(source: ProjectFile, count: number, deps: VariantDependencies): Promise<MapVariant[]> {
  assertCount(count);
  const snapshot = parseProjectFile(structuredClone(source));
  const automatic = conceptMode(snapshot.settings) === 'ai';
  if (!automatic) assertManualConcept(snapshot.settings);
  // Preflight every request before the first paid call; AI briefs are checked when they arrive.
  const baseSettings = structuredClone(snapshot.settings);
  if ((baseSettings.roomPreset || baseSettings.levelDesign) && baseSettings.seed === undefined) baseSettings.seed = crypto.getRandomValues(new Uint32Array(1))[0];
  // A new batch chooses each candidate afresh; extraction retries use its resolved request.
  if (baseSettings.roomPreset || baseSettings.levelDesign) baseSettings.sizeResolved = false;
  const resolved = Array.from({ length: count }, (_, index) => resolveGenerationSettings(parseGenerationSettings(structuredClone(baseSettings)), index));
  const requests = automatic ? [] : resolved;
  const batchId = crypto.randomUUID();
  const variants: MapVariant[] = resolved.map((_, index) => ({
    id: `variant_${batchId}_${index + 1}`, index, label: `${index + 1}번 · ${spatialIntent(resolved[index], index).label}`, status: 'waiting',
  }));
  const emit = () => deps.onUpdate?.(structuredClone(variants));
  const geometry = new Set<string>();
  const previousConcepts: string[] = [];
  const previousStructures: string[] = [];
  const acceptedMaps: { index: number; map: GridMap }[] = [];
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
        settings = conceptForRequest(resolved[index], variant.concept);
      } else {
        variant.concept = { source: 'manual', text: parseConceptText(snapshot.settings.prompt, 'manual') };
        settings = requests[index];
      }
      let image: string | undefined, generated: GridMap;
      const context: ImageGenerationContext = { candidateIndex: index, candidateCount: count, previousStructures: [...previousStructures] };
      if (settings.generationMethod === 'direct') {
        variant.status = 'layout'; emit();
        if (deps.isCancelled()) { cancelRemaining(index); break; }
        if (!deps.generateLayout) throw new Error('맵 직접 생성 기능을 사용할 수 없습니다. 앱을 다시 시작해 주세요.');
        generated = await deps.generateLayout(structuredClone(settings), structuredClone(snapshot.bindings), context);
      } else {
        variant.status = 'image'; emit();
        if (deps.isCancelled()) { cancelRemaining(index); break; }
        image = await deps.generateImage(structuredClone(settings), structuredClone(snapshot.bindings), context);
        if (deps.isCancelled()) { cancelRemaining(index); break; }
        variant.status = 'extract'; emit();
        if (deps.isCancelled()) { cancelRemaining(index); break; }
        generated = await deps.extractLayout(structuredClone(settings), image, structuredClone(snapshot.bindings));
      }
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      const map = structuredClone(generated);
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
      const project = parseProjectFile({ formatVersion: 1, map, settings: savedSettings, bindings: structuredClone(snapshot.bindings), ...(image === undefined ? {} : { blueprintDataUrl: image }), concept: variant.concept });
      const key = variantGeometryKey(project.map);
      if (geometry.has(key)) throw new Error('앞서 생성한 후보와 지형이 같습니다. 중복 후보로 제외했으며 자동으로 다시 생성하지 않습니다.');
      geometry.add(key);
      const wallWarnings = [...wallMountGenerationIssues(map, settings, snapshot.bindings), ...compositionGenerationIssues(map, settings, snapshot.bindings)].map(issue => issue.message);
      const similarityWarnings = acceptedMaps.flatMap(previous => {
        const similarity = compareGeometry(previous.map, map);
        return similarity.similar ? [`${previous.index + 1}번 후보와 구조가 비슷합니다 (윤곽 ${Math.round(similarity.silhouetteSimilarity * 100)}%, ${similarity.matchingRelationships.join('·')} 유사). 후보는 유지하며 자동으로 다시 생성하지 않습니다.`] : [];
      });
      if (wallWarnings.length || similarityWarnings.length) variant.warnings = [...wallWarnings, ...similarityWarnings];
      acceptedMaps.push({ index, map: project.map });
      previousStructures.push(summarizeGeometry(project.map));
      variant.project = project; variant.status = 'ready';
    } catch (error) {
      if (deps.isCancelled()) { cancelRemaining(index); break; }
      variant.status = 'error'; variant.error = error instanceof Error ? error.message : String(error);
    }
    emit();
  }
  return structuredClone(variants);
}
