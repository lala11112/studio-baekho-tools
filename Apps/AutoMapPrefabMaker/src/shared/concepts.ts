import type { ConceptGenerationContext, GenerationSettings, GridMap, MapConcept } from './types';
import { mapStructureErrors } from './map';

export const conceptMode = (settings: GenerationSettings): 'ai' | 'manual' => settings.conceptMode ?? 'manual';

export function parseConceptText(value: unknown, source: MapConcept['source'] = 'ai'): string {
  const limit = source === 'ai' ? 2000 : 6000;
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error(`${source === 'ai' ? 'AI' : '직접 입력'} 컨셉은 1~${limit.toLocaleString('en-US')}자의 문구여야 합니다.`);
  return value.trim();
}

export function parseMapConcept(value: unknown): MapConcept {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('맵 컨셉 정보가 올바르지 않습니다.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['source', 'text'].includes(key)) || (record.source !== 'ai' && record.source !== 'manual'))
    throw new Error('맵 컨셉의 작성 주체를 확인해 주세요.');
  const source = record.source as MapConcept['source'];
  return { source, text: parseConceptText(record.text, source) };
}

export function assertManualConcept(settings: GenerationSettings): void {
  if (conceptMode(settings) === 'manual') parseConceptText(settings.prompt, 'manual');
}

/** A request has a resolved brief even though editable preferences may be empty. */
export function assertResolvedConceptSettings(settings: GenerationSettings): void {
  if (!settings.prompt.trim() || settings.prompt.length > 6000) throw new Error('맵 생성에 사용할 컨셉을 먼저 작성해 주세요.');
}

export function conceptForRequest(settings: GenerationSettings, concept: MapConcept): GenerationSettings {
  return { ...structuredClone(settings), prompt: parseMapConcept(concept).text };
}

/** Strip only known legacy request suffixes when recovering a concept from an old draft. */
export function legacyConcept(settings: GenerationSettings): MapConcept | undefined {
  const text = settings.prompt.split(/\[BAEKHO (?:REGION CONTEXT|MAP VARIANT \d+\/\d+)\]/)[0].trim();
  return text ? { source: 'manual', text: parseConceptText(text, 'manual') } : undefined;
}

export function parseConceptGenerationContext(value: unknown): ConceptGenerationContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('컨셉 작성 참고 정보가 올바르지 않습니다.');
  const context = value as Record<string, unknown>;
  if (Object.keys(context).some(key => !['previousConcepts', 'candidateIndex', 'candidateCount', 'currentMap'].includes(key))) throw new Error('컨셉 작성 참고 정보가 올바르지 않습니다.');
  const result: ConceptGenerationContext = {};
  if (context.previousConcepts !== undefined) {
    if (!Array.isArray(context.previousConcepts) || context.previousConcepts.length > 7) throw new Error('이전 컨셉은 최대 7개까지 참고할 수 있습니다.');
    result.previousConcepts = context.previousConcepts.map(text => parseConceptText(text));
  }
  if (context.candidateIndex !== undefined || context.candidateCount !== undefined) {
    const index = context.candidateIndex, count = context.candidateCount;
    if (!Number.isInteger(index) || !Number.isInteger(count) || Number(count) < 2 || Number(count) > 8 || Number(index) < 0 || Number(index) >= Number(count)) throw new Error('컨셉 후보 번호를 확인해 주세요.');
    result.candidateIndex = Number(index); result.candidateCount = Number(count);
  }
  if (context.currentMap !== undefined) {
    const errors = mapStructureErrors(context.currentMap);
    if (errors.length) throw new Error(`컨셉 참고 맵이 올바르지 않습니다: ${errors[0]}`);
    result.currentMap = structuredClone(context.currentMap as GridMap);
  }
  return result;
}
