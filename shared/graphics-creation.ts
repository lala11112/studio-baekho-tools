import type { AssetVersion, GraphicsKind, GraphicsObject } from './graphics';
import { isGraphicsClipName } from './graphics';
import { defaultPhysicalSize, normalizePhysicalSize, type PhysicalSize } from './graphics-size';
import { DEFAULT_MODEL_FACE_LIMIT, DEFAULT_TRIPO_MODEL, changeModelGeometry, modelGeometryProblem, requireModelGeometry } from './graphics-model-geometry';

export type CreationStage = 'design' | 'model' | 'surface' | 'assembly' | 'rig' | 'animation' | 'unity';
export type CreationValues = Record<string, string | number | boolean>;
/** Empty string is an explicit cleared choice, distinct from absent legacy defaults. */
export function toggleCreationChoice(current: string | number | boolean | undefined, selected: string): string {
  return String(current) === selected ? '' : selected;
}
export type PartSpec = { id: string; label: string; enabled: boolean; instruction: string; faceLimit: number | ''; count: number };
export type PartsCompositionStrategy = 'whole-then-split' | 'independent-parts';
export type CreationSpec = {
  schemaVersion: 1; subject: string; attributes: CreationValues; instruction: string; locks: string[];
  stageSettings: Partial<Record<CreationStage, { instruction: string; values: CreationValues }>>;
  parts: PartSpec[]; activePartId?: string;
  physicalSize?: PhysicalSize;
  clipSettings?: Record<string, { instruction: string; values: CreationValues }>;
};
export type OptionDefinition = { id: string; label: string; values: { value: string; label: string }[]; subjects?: string[]; advanced?: boolean };
export const creationStages: { id: CreationStage; label: string }[] = [
  { id: 'design', label: '이미지' }, { id: 'model', label: '모델' }, { id: 'surface', label: '재질' },
  { id: 'assembly', label: '조립·수정' }, { id: 'rig', label: '리깅' }, { id: 'animation', label: '애니메이션' }, { id: 'unity', label: 'Unity 전달' },
];
export type CreationSubjectGroup = 'living' | 'objects' | 'equipment' | 'architecture' | 'nature';
export type CreationSubject = { id: string; label: string; kind: GraphicsKind; group: CreationSubjectGroup; family?: string; defaults?: CreationValues; legacy?: boolean };
export const creationSubjectGroups: { id: CreationSubjectGroup; label: string; description: string }[] = [
  { id: 'living', label: '생물', description: '인간형 캐릭터, 동물, 크리처' },
  { id: 'objects', label: '사물', description: '가구, 생활용품, 용기, 도구, 기계, 음식, 장식품' },
  { id: 'equipment', label: '무기·장비', description: '무기, 의상, 방어구, 장신구' },
  { id: 'architecture', label: '건물·건축 부품', description: '개별 건물과 부품을 제작합니다. 전체 레벨 배치나 플레이 가능한 내부를 자동 완성하지 않습니다.' },
  { id: 'nature', label: '자연환경', description: '바위, 식물, 지형 조각 등 개별 오브젝트' },
];
const subject = (id: string, label: string, kind: GraphicsKind, group: CreationSubjectGroup, family?: string, defaults?: CreationValues): CreationSubject => ({ id, label, kind, group, family, defaults });
export const creationSubjects: CreationSubject[] = [
  subject('human', '인간형 캐릭터', 'character', 'living'), subject('animal', '동물', 'character', 'living'), subject('creature', '크리처', 'character', 'living'),
  subject('furniture', '가구', 'prop', 'objects', 'prop', { propType: 'furniture' }),
  subject('everyday', '생활용품', 'prop', 'objects', 'prop', { propType: 'everyday' }),
  subject('box', '상자·용기', 'prop', 'objects'),
  subject('tool', '도구', 'prop', 'objects', 'prop', { propType: 'tool' }),
  subject('machine', '기계', 'prop', 'objects', 'prop', { propType: 'machine' }),
  subject('food', '음식', 'prop', 'objects', 'prop', { propType: 'food' }),
  subject('decoration', '장식품', 'prop', 'objects', 'prop', { propType: 'decoration' }),
  subject('prop', '직접 설명할 사물', 'prop', 'objects'),
  subject('weapon', '검·총·활·방패', 'weapon', 'equipment'), subject('armor', '의상·방어구', 'weapon', 'equipment'),
  subject('accessory', '장신구', 'weapon', 'equipment', 'armor', { equipmentType: 'accessory' }),
  subject('building', '단독 건물', 'environment', 'architecture', undefined, { buildingType: 'house' }),
  ...[['wall', '벽'], ['floor', '바닥'], ['roof', '지붕'], ['door', '문·창문'], ['stairs', '계단'], ['column', '기둥'], ['fence', '울타리']].map(([id, label]) => subject(id, label, 'environment', 'architecture', 'building', { buildingType: id })),
  subject('rock', '바위·광물', 'prop', 'nature'),
  ...[['tree', '나무'], ['shrub', '관목'], ['grass', '풀·꽃']].map(([id, label]) => subject(id, label, 'environment', 'nature', 'plant', { plantType: id })),
  subject('terrain', '지형 조각', 'environment', 'nature', 'building', { buildingType: 'terrain' }),
  { ...subject('plant', '식물', 'environment', 'nature'), legacy: true },
];
export const isBiologicalSubject = (id: string): boolean => creationSubjects.find(s => s.id === id)?.group === 'living';
export const optionAppliesToSubject = (option: OptionDefinition, id: string): boolean => !option.subjects || option.subjects.includes(id) || Boolean(creationSubjects.find(s => s.id === id)?.family && option.subjects.includes(creationSubjects.find(s => s.id === id)!.family!));
export const creationLockAppliesToSubject = (id: string, target: string): boolean => !['face', 'body', 'hair'].includes(id) || isBiologicalSubject(target);
const option = (id: string, label: string, choices: string[], subjects?: string[], advanced = false): OptionDefinition => ({ id, label, values: choices.map(pair => { const [value, label] = pair.split(':'); return { value, label }; }), subjects, advanced });
export const creationOptions: OptionDefinition[] = [
  option('style', '어떤 표현으로 만들까요?', ['stylized:스타일화', 'lowpoly:로우폴리 표현', 'anime:애니풍', 'realistic:사실적']),
  option('mood', '디자인 분위기', ['neutral:기본', 'cute:귀여움', 'heavy:묵직함', 'sleek:날렵함', 'ancient:고풍스러움', 'future:미래적', 'horror:공포']),
  option('material', '주요 재질', ['reference:참조 유지', 'stone:돌', 'metal:금속', 'wood:나무', 'cloth:천', 'leather:가죽', 'skin:피부', 'fur:털', 'glass:유리', 'crystal:수정']),
  option('wear', '사용감', ['new:새것', 'used:약간 낡음', 'old:오래됨', 'broken:파손'], undefined, true),
  option('detail', '장식과 세부 묘사', ['simple:간결', 'normal:보통', 'complex:복잡'], undefined, true),
  option('shape', '전체 형태', ['rounded:둥근', 'angular:각진', 'flat:납작한', 'long:길쭉한'], ['rock', 'box', 'prop']),
  option('surface', '표면 요철', ['smooth:매끈', 'rough:약간 거침', 'rugged:울퉁불퉁'], ['rock', 'prop', 'building']),
  option('cracks', '균열', ['none:없음', 'few:적게', 'many:많게'], ['rock', 'building'], true),
  option('moss', '이끼', ['none:없음', 'some:일부', 'many:많게'], ['rock', 'building'], true),
  option('mineral', '광물 노출', ['none:없음', 'vein:광맥', 'crystal:수정 덩어리'], ['rock'], true),
  option('lid', '뚜껑', ['none:없음', 'closed:닫힘', 'open:열림'], ['box']),
  option('container', '용기 형태', ['crate:나무 상자', 'chest:보물 상자', 'metal:금속 상자', 'barrel:통', 'jar:항아리'], ['box']),
  option('hinge', '경첩·가동부', ['none:없음', 'hinge:경첩', 'sliding:미닫이'], ['box', 'building', 'furniture', 'machine'], true),
  option('interior', '내부 공간', ['solid:외형만', 'hollow:속이 빈 구조'], ['box', 'building'], true),
  option('weaponType', '무기 종류', ['sword:검', 'greatsword:대검', 'axe:도끼', 'spear:창', 'mace:둔기', 'bow:활', 'gun:총기', 'shield:방패'], ['weapon']),
  option('blade', '날·머리 모양', ['straight:곧게', 'curved:휘게', 'broad:넓게', 'serrated:톱니'], ['weapon'], true),
  option('grip', '손잡이', ['one:한손', 'two:양손', 'reference:참조 유지'], ['weapon']),
  option('body', '체형', ['balanced:균형', 'slim:마름', 'muscular:근육질', 'round:둥근'], ['human', 'animal', 'creature']),
  option('proportions', '신체 비율', ['normal:일반', 'chibi:짧은 등신', 'tall:긴 등신'], ['human'], true),
  option('face', '얼굴', ['reference:참조 유지', 'soft:부드럽게', 'sharp:또렷하게', 'round:둥글게'], ['human'], true),
  option('hair', '머리카락', ['reference:참조 유지', 'none:없음', 'short:짧게', 'long:길게', 'ponytail:묶은 머리'], ['human']),
  option('clothing', '의상', ['reference:참조 유지', 'casual:일상복', 'fantasy:판타지 의상', 'armor:갑옷', 'uniform:제복'], ['human'], true),
  option('bodyStructure', '몸 구조', ['quadruped:네 발', 'biped:두 발', 'bird:새', 'fish:물고기', 'insect:곤충'], ['animal', 'creature']),
  option('ears', '귀', ['reference:참조 유지', 'short:짧게', 'long:길게', 'none:없음'], ['animal', 'creature'], true),
  option('tail', '꼬리', ['none:없음', 'short:짧게', 'long:길게', 'fluffy:풍성하게'], ['animal', 'creature'], true),
  option('wings', '날개', ['none:없음', 'feather:깃털', 'membrane:피막'], ['animal', 'creature'], true),
  option('covering', '몸 표면', ['fur:털', 'scales:비늘', 'shell:껍질', 'skin:피부'], ['animal', 'creature'], true),
  option('equipmentType', '장비 종류', ['top:상의', 'bottom:하의', 'suit:전신복', 'armor:갑옷', 'shoes:신발', 'accessory:장신구'], ['armor']),
  option('fit', '착용 형태', ['fitted:밀착', 'loose:헐렁함', 'reference:참조 유지'], ['armor'], true),
  option('propType', '소품 종류', ['furniture:가구', 'everyday:생활용품', 'tool:도구', 'machine:기계', 'food:음식', 'decoration:장식품', 'custom:직접 설명'], ['prop']),
  option('buildingType', '환경 부품', ['wall:벽', 'floor:바닥', 'roof:지붕', 'door:문·창문', 'stairs:계단', 'column:기둥', 'fence:울타리', 'house:건물', 'terrain:지형 조각'], ['building']),
  option('modular', '연결 방식', ['single:단독', 'repeat:반복 연결', 'corner:모서리 연결'], ['building'], true),
  option('plantType', '식물 종류', ['tree:나무', 'shrub:관목', 'grass:풀', 'flower:꽃'], ['plant']),
  option('foliage', '잎 밀도', ['sparse:드문드문', 'normal:보통', 'dense:빽빽하게'], ['plant']),
  option('season', '계절', ['summer:여름', 'spring:봄', 'autumn:가을', 'winter:겨울'], ['plant'], true),
];
export const creationLocks = [
  { id: 'face', label: '얼굴' }, { id: 'body', label: '체형·비율' }, { id: 'hair', label: '머리카락' },
  { id: 'color', label: '색' }, { id: 'detail', label: '장식' }, { id: 'topology', label: '메시 구조' },
  { id: 'materials', label: '원본 재질' }, { id: 'rig', label: '뼈 구조' },
];
export const humanParts = (): PartSpec[] => [
  { id: 'head', label: '머리', enabled: true, instruction: '얼굴·귀·목 연결부. 머리카락 제외.', faceLimit: 5000, count: 1 },
  { id: 'body', label: '몸통', enabled: true, instruction: '몸통·팔·손·손가락·다리·발과 의상. 머리와 머리카락 제외.', faceLimit: 5000, count: 1 },
  { id: 'hair', label: '머리카락', enabled: true, instruction: '채택한 헤어스타일 전체. 두피·얼굴·몸 제외.', faceLimit: 5000, count: 1 },
];
/** Absence retains the original independent-part workflow; reading never migrates saved data. */
export function creationCompositionStrategy(spec: CreationSpec): PartsCompositionStrategy | undefined {
  if (spec.attributes.composition !== 'parts') return undefined;
  return spec.attributes.compositionStrategy === 'whole-then-split' ? 'whole-then-split' : 'independent-parts';
}
export const isWholeThenSplitCreation = (spec: CreationSpec): boolean => creationCompositionStrategy(spec) === 'whole-then-split';
/** Explicit recipe selection changes only the editable specification, never results or execution. */
export function setHumanPartsCreation(spec: CreationSpec, strategy: PartsCompositionStrategy): CreationSpec {
  const next = structuredClone(spec);
  next.attributes = { ...next.attributes, composition: 'parts', compositionStrategy: strategy };
  const defaults = humanParts().map(part => ({ ...part, faceLimit: strategy === 'whole-then-split' ? '' as const : part.faceLimit }));
  next.parts = [...defaults.map(part => ({ ...part, ...next.parts.find(saved => saved.id === part.id), enabled: true })), ...next.parts.filter(part => !defaults.some(item => item.id === part.id))];
  if (!next.activePartId || !next.parts.some(part => part.id === next.activePartId && part.enabled)) next.activePartId = 'head';
  return next;
}
/** Whole generation and split/assembly operate on main; surface operations use the explicit selected part. */
export function creationPartForTask(spec: CreationSpec, taskId: string): PartSpec | undefined {
  if (spec.attributes.composition !== 'parts' || !spec.activePartId || ['I01', 'I02', 'M07', 'M08'].includes(taskId)) return undefined;
  const stage = stageForTask(taskId);
  if (!['design', 'model', 'surface', 'assembly'].includes(stage) || stage === 'model' && isWholeThenSplitCreation(spec)) return undefined;
  return spec.parts.find(part => part.id === spec.activePartId && part.enabled);
}
/** Select an exact displayed source in the editable draft; never adopt or execute it. */
export function selectMissingSurfaceRepair(spec: CreationSpec, source: Pick<AssetVersion, 'id' | 'slot' | 'role'>, mesh?: { sourceId?: string; sourceName?: string }): CreationSpec {
  if (!['model', 'material'].includes(source.role)) throw Error('리깅 전 모델 또는 파트를 선택하세요.');
  const partId = source.slot.startsWith('part-') ? source.slot.slice(5) : undefined;
  if (partId && !spec.parts.some(part => part.id === partId && part.enabled)) throw Error('보완할 원본에 해당하는 파트를 선택하세요.');
  if (!partId && spec.attributes.composition === 'parts') throw Error('분리된 파트의 원본을 선택하세요.');
  const next = structuredClone(spec), assembly = next.stageSettings.assembly;
  next.activePartId = partId;
  next.stageSettings.assembly = { instruction: assembly?.instruction ?? '', values: {
    ...assembly?.values, assemblyMode: 'repair', count: 1, sourceVersionId: source.id, meshSelectionVersionId: source.id,
    editMeshIds: JSON.stringify(mesh?.sourceId ? [mesh.sourceId] : []),
    editMeshNames: JSON.stringify(!mesh?.sourceId && mesh?.sourceName ? [mesh.sourceName] : []),
    repairMaxAddedFaces: assembly?.values.repairMaxAddedFaces ?? 1500,
    repairMaxAddedVertices: assembly?.values.repairMaxAddedVertices ?? 1000,
  } };
  return next;
}
function missingSurfaceRepairProblem(spec: CreationSpec, settings: CreationValues): string | undefined {
  if (!String(settings.sourceVersionId ?? '').trim()) return '미리보기에서 보완할 원본 파트를 선택하세요.';
  if (spec.attributes.composition === 'parts' && !spec.parts.some(part => part.id === spec.activePartId && part.enabled)) return '빠진 면을 보완할 파트를 선택하세요.';
  for (const [key, label, fallback, min] of [['repairMaxAddedFaces', '추가 면 상한', 1500, 1], ['repairMaxAddedVertices', '추가 정점 상한', 1000, 0]] as const) {
    const value = settings[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > 4000) return `${label}은 ${min}–4,000 사이의 정수로 입력하세요.`;
  }
  return undefined;
}
const stageDefaults: Record<CreationStage, CreationValues> = {
  design: { count: 2, designMode: 'new', direction: 'front', framing: 'full', pose: 'natural', background: 'solid', perspective: 'orthographic', margin: 'full', multiview: false, viewFront: true, viewBack: true, viewLeft: true, viewRight: true },
  model: { count: 1, modelMethod: 'tripo', model: DEFAULT_TRIPO_MODEL, inputMode: 'image', faceLimit: DEFAULT_MODEL_FACE_LIMIT, quad: true, scale: 1, symmetry: true },
  surface: { count: 1, surfaceOperation: 'texture', textureMode: 'tripo', uvMode: 'keep', textureSize: 4096, color: '#808080', roughness: .65, metallic: 0, emission: 0, opacity: 1 },
  assembly: { count: 1, assemblyMode: 'correct' },
  rig: { count: 1, rigType: 'none', rigEars: false, rigTail: false, rigHair: false, rigClothing: false, rigWings: false, rigAccessories: false },
  animation: { count: 1, animationMode: 'text', clipName: 'Idle', motionPreset: 'idle', duration: 2, fps: 30, loop: true, rootMotion: false, motionSourceView: 'left' },
  unity: { count: 1, deliveryMode: 'unity', scale: 1, pivot: 'keep', exportFormat: 'both', collider: 'none', lodEnabled: false, lodRatio: .5, deliveryTextureSize: 0, deliveryCompression: 'none' },
};
export function defaultCreation(kind: GraphicsKind): CreationSpec {
  const subject = ({ character: 'human', weapon: 'weapon', prop: 'prop', environment: 'building' } as Record<string, string>)[kind] ?? 'prop';
  return { schemaVersion: 1, subject, instruction: '', attributes: { style: 'stylized', composition: 'whole' }, locks: [], physicalSize: defaultPhysicalSize(),
    stageSettings: Object.fromEntries(creationStages.map(({ id }) => [id, { instruction: '', values: { ...stageDefaults[id], ...(id === 'design' && kind === 'character' ? { pose: 'a' } : {}) } }])), parts: [] };
}
/** Start a new object with the chosen subject. No service execution or reference mutation. */
export function creationForSubject(subjectId: string): CreationSpec {
  const target = creationSubjects.find(s => s.id === subjectId);
  if (!target) throw Error('만들 대상을 선택하세요.');
  const spec = defaultCreation(target.kind);
  spec.subject = target.id;
  Object.assign(spec.attributes, target.defaults);
  spec.stageSettings.design!.values.pose = target.id === 'human' ? 'a' : isBiologicalSubject(target.id) ? 'natural' : '';
  return spec;
}
/** Subject-scoped options never leak into the next target, while explicit free text is retained. */
function applicableAttributes(spec: CreationSpec): CreationValues {
  return Object.fromEntries(Object.entries(spec.attributes).filter(([key]) => {
    const optionId = key.startsWith('custom.') ? key.slice('custom.'.length) : key;
    const definition = creationOptions.find(o => o.id === optionId);
    return !definition || optionAppliesToSubject(definition, spec.subject);
  }));
}
/** Used only for an existing object's editable subject preset; caller decides whether a new object is required. */
export function changeCreationSubject(spec: CreationSpec, subjectId: string): CreationSpec {
  const target = creationSubjects.find(s => s.id === subjectId);
  if (!target) throw Error('만들 대상을 선택하세요.');
  const next = structuredClone(spec);
  next.subject = subjectId;
  next.attributes = { ...applicableAttributes(next), ...target.defaults };
  next.locks = next.locks.filter(id => creationLockAppliesToSubject(id, subjectId));
  const design = next.stageSettings.design;
  if (design && spec.subject !== subjectId) {
    design.values.pose = subjectId === 'human' ? 'a' : isBiologicalSubject(subjectId) ? 'natural' : '';
    if (!isBiologicalSubject(subjectId) && ['upper', 'face'].includes(String(design.values.framing))) design.values.framing = 'full';
  }
  return next;
}
/** Read-only compatibility. Legacy settings are copied, never rewritten on open. */
export function effectiveCreation(object: GraphicsObject): CreationSpec {
  if (object.creation) return structuredClone(object.creation);
  const spec = defaultCreation(object.kind); spec.instruction = object.instruction;
  // Legacy objects retain their earlier scale until the common size control is explicitly saved.
  delete spec.physicalSize;
  for (const { id } of creationStages) {
    for (const key of Object.keys(stageDefaults[id])) if (object.settings[key] !== undefined) spec.stageSettings[id]!.values[key] = object.settings[key];
    if (!['design', 'model'].includes(id)) spec.stageSettings[id]!.values.count = 1;
  }
  for (const [key, value] of Object.entries(object.settings)) {
    const stage = /^(front|left|right|back)VersionId$/.test(key) ? 'model' : /^(motion|actionName|clipName)/.test(key) ? 'animation' : undefined;
    if (stage) spec.stageSettings[stage]!.values[key] = value;
  }
  if (object.settings.model === 'P1-20260311' && object.settings.quad === undefined) spec.stageSettings.model!.values.quad = false;
  return spec;
}
export function creationSettings(object: GraphicsObject, stage: CreationStage): CreationValues {
  const spec = effectiveCreation(object);
  return stageValues(spec, stage);
}
function stageValues(spec: CreationSpec, stage: CreationStage): CreationValues {
  const saved = spec.stageSettings[stage]?.values;
  return { ...stageDefaults[stage], ...(stage === 'model' && saved?.model === 'P1-20260311' ? { quad: false } : {}), ...(stage === 'rig' && spec.subject === 'human' && saved?.rigType === 'humanoid' ? { rigFingers: true } : {}), ...saved };
}
/** Batch provider/topology changes and their visible face-target adjustments in one draft update. */
export function updateCreationModelGeometry(spec: CreationSpec, change: CreationValues, adjustToSelection = false): { spec: CreationSpec; notice?: string } {
  const next = structuredClone(spec), current = stageValues(spec, 'model');
  const stage = next.stageSettings.model ?? { instruction: '', values: {} }, notices: string[] = [];
  if (adjustToSelection) {
    const result = changeModelGeometry(current, change);
    stage.values = { ...stage.values, ...result.patch };
    if (result.notice && creationCompositionStrategy(spec) !== 'independent-parts') notices.push(result.notice);
    if (!isWholeThenSplitCreation(spec)) next.parts = next.parts.map(part => {
      const result = changeModelGeometry({ ...current, faceLimit: part.faceLimit }, change);
      if (result.notice) notices.push(`${part.label}: ${result.notice}`);
      return result.patch.faceLimit !== undefined ? { ...part, faceLimit: result.patch.faceLimit as number | '' } : part;
    });
    if (!notices.length && result.notice) notices.push(result.notice);
  } else if (creationCompositionStrategy(spec) === 'independent-parts' && spec.activePartId && change.faceLimit !== undefined) {
    next.parts = next.parts.map(part => part.id === spec.activePartId ? { ...part, faceLimit: change.faceLimit as number | '' } : part);
    stage.values = { ...stage.values, ...Object.fromEntries(Object.entries(change).filter(([key]) => key !== 'faceLimit')) };
  } else stage.values = { ...stage.values, ...change };
  next.stageSettings.model = stage;
  return { spec: next, notice: notices.join(' ') || undefined };
}
export function creationInstruction(object: GraphicsObject, stage: CreationStage): string { return effectiveCreation(object).stageSettings[stage]?.instruction ?? ''; }
const stageRouteChoice: Record<CreationStage, [string, string]> = {
  design: ['designMode', '이미지 제작 방식'], model: ['modelMethod', '제작 방식'], surface: ['surfaceOperation', '이번에 할 작업'],
  assembly: ['assemblyMode', '이번에 할 작업'], rig: ['rigType', 'Unity 리그 종류'], animation: ['animationMode', '이번에 만들 결과'], unity: ['deliveryMode', '전달 방식'],
};
/** Saving incomplete options is allowed; only execution requires these choices. */
export function creationSelectionProblem(spec: CreationSpec, stage: CreationStage): string | undefined {
  const s = stageValues(spec, stage);
  const required = [stageRouteChoice[stage]];
  if (stage === 'model') {
    if (s.modelMethod !== 'local') required.push(['inputMode', '모델에 사용할 이미지']);
    if (creationCompositionStrategy(spec) !== 'independent-parts') required.push(['faceLimit', '목표 면 수']);
  } else if (stage === 'surface') {
    if (s.surfaceOperation === 'uv') required.push(['uvMode', 'UV 방식']);
    else { required.push(['textureMode', '표면 제작 방식']); if (s.textureMode !== 'local') required.push(['textureReference', '텍스처 참조']); }
  } else if (stage === 'unity' && s.deliveryMode !== 'files') required.push(['collider', '충돌체'], ['deliveryCompression', '전달본 압축']);
  const missing = required.find(([key]) => s[key] === '');
  if (missing) return `${missing[1]} 선택이 필요합니다.`;
  if (['design', 'model', 'surface', 'assembly'].includes(stage) && spec.attributes.composition === '') return '모델 구성 선택이 필요합니다. 이미지 또는 모델 단계에서 선택하세요.';
  if (stage === 'surface' && spec.attributes.composition === 'parts' && !spec.parts.some(part => part.id === spec.activePartId && part.enabled)) return 'UV·텍스처를 적용할 파트를 선택하세요.';
  if (stage === 'assembly' && s.assemblyMode === 'repair') return missingSurfaceRepairProblem(spec, s);
  if (stage === 'model') {
    const part = creationCompositionStrategy(spec) === 'independent-parts' ? spec.parts.find(p => p.id === spec.activePartId && p.enabled) : undefined;
    return modelGeometryProblem({ ...s, ...(part ? { faceLimit: part.faceLimit } : {}) });
  }
  return undefined;
}
export function creationTaskId(spec: CreationSpec, stage: CreationStage): string {
  const s = stageValues(spec, stage);
  if (s[stageRouteChoice[stage][0]] === '') return '';
  if (stage === 'design') return ({ new: 'I01', reference: 'I02', revision: 'I03', variation: 'I05', equipment: 'I06', multiview: 'I07', parts: 'I08' } as Record<string, string>)[String(s.designMode)] ?? 'I01';
  if (stage === 'model') return s.modelMethod === 'local' ? 'M04' : s.modelMethod === 'astra' ? 'M15' : s.inputMode === 'multiview' ? 'M02' : 'M01';
  if (stage === 'surface') return s.surfaceOperation === 'uv' ? s.uvMode === 'tripo' ? 'T01' : 'T02' : s.textureMode === 'local' ? 'T05' : 'T03';
  if (stage === 'assembly') return s.assemblyMode === 'assemble' ? 'M08' : s.assemblyMode === 'separate' ? 'M07' : s.assemblyMode === 'repair' ? 'M09' : s.assemblyMode === 'partial' ? 'M06' : 'M05';
  if (stage === 'rig') return s.rigType === 'humanoid' ? 'R01' : s.rigType === 'existing' ? 'R03' : 'R02';
  if (stage === 'animation') return ({ source: 'N01', video: 'N02', reference: 'N04', text: 'N05', revision: 'N06' } as Record<string, string>)[String(s.animationMode)] ?? 'N05';
  return s.deliveryMode === 'files' ? 'X04' : 'X05';
}
export function stageForTask(taskId: string): CreationStage {
  if (taskId.startsWith('I')) return 'design';
  if (taskId.startsWith('T')) return 'surface';
  if (['M05', 'M06', 'M07', 'M08', 'M09'].includes(taskId)) return 'assembly';
  if (taskId.startsWith('M')) return 'model';
  if (taskId.startsWith('R')) return 'rig';
  if (taskId.startsWith('N')) return 'animation';
  return 'unity';
}
export function summarizeCreation(spec: CreationSpec): string[] {
  return [creationSubjects.find(s => s.id === spec.subject)?.label ?? spec.subject,
    ...creationOptions.filter(o => optionAppliesToSubject(o, spec.subject)).flatMap(o => {
      const v = spec.attributes[o.id]; if (v === undefined || v === '') return [];
      return [`${o.label}: ${o.values.find(x => x.value === v)?.label ?? String(v)}`];
    }), ...Object.entries(applicableAttributes(spec)).filter(([key, value]) => key.startsWith('custom.') && String(value).trim()).map(([, value]) => String(value))];
}
export function validateCreation(value: CreationSpec, kind: GraphicsKind): CreationSpec {
  if (!value || value.schemaVersion !== 1 || creationSubjects.find(s => s.id === value.subject)?.kind !== kind) throw Error('대상 종류와 제작 프리셋을 확인하세요.');
  const values = (v: CreationValues) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 100 || Object.entries(v).some(([k,x]) => k.length > 100 || !['string','number','boolean'].includes(typeof x) || typeof x === 'number' && !Number.isFinite(x) || typeof x === 'string' && x.length > 2000)) throw Error('제작 옵션 값이 잘못됐습니다.'); };
  const text = (s: unknown) => { if (typeof s !== 'string' || s.length > 12000) throw Error('제작 지시는 12,000자 이내로 입력하세요.'); };
  values(value.attributes); text(value.instruction);
  if (value.physicalSize !== undefined) normalizePhysicalSize(value.physicalSize);
  if (!Array.isArray(value.locks) || value.locks.some(x => !creationLocks.some(l => l.id === x))) throw Error('유지 잠금 항목을 확인하세요.');
  if (!value.stageSettings || typeof value.stageSettings !== 'object' || Object.keys(value.stageSettings).some(k => !creationStages.some(s => s.id === k))) throw Error('제작 단계 설정을 확인하세요.');
  for (const s of Object.values(value.stageSettings)) { if (!s) throw Error('단계 설정이 없습니다.'); text(s.instruction); values(s.values); if (s.values.count !== undefined && (!Number.isInteger(s.values.count) || Number(s.values.count) < 1 || Number(s.values.count) > 4)) throw Error('후보 수는 1–4개입니다.'); }
  if (value.clipSettings) {
    if (Array.isArray(value.clipSettings) || Object.keys(value.clipSettings).length > 100) throw Error('저장할 클립 설정은 최대 100개입니다.');
    for (const [name, s] of Object.entries(value.clipSettings)) {
      if (!isGraphicsClipName(name) || ['__proto__','constructor','prototype'].includes(name) || !s) throw Error('클립 설정의 이름을 확인하세요.');
      text(s.instruction); values(s.values);
      if (s.values.count !== undefined && (!Number.isInteger(s.values.count) || Number(s.values.count) < 1 || Number(s.values.count) > 4)) throw Error('클립 후보 수는 1–4개입니다.');
    }
  }
  if (!Array.isArray(value.parts) || value.parts.length > 12 || new Set(value.parts.map(p => p.id)).size !== value.parts.length) throw Error('파츠는 중복 없이 최대 12개입니다.');
  for (const p of value.parts) { if (!/^[a-z][a-z0-9-]{0,39}$/.test(p.id) || !p.label?.trim() || p.label.length > 60 || typeof p.enabled !== 'boolean' || p.faceLimit !== '' && !Number.isSafeInteger(p.faceLimit) || !Number.isInteger(p.count) || p.count < 1 || p.count > 4) throw Error('파츠 이름·면 수·후보 수를 확인하세요.'); text(p.instruction); }
  if (value.activePartId && !value.parts.some(p => p.id === value.activePartId && p.enabled)) throw Error('현재 파츠를 확인하세요.');
  return structuredClone(value);
}
const imageLabels: Record<string, Record<string, string>> = {
  direction: { front: '정면', back: '후면', left: '대상 자체의 왼쪽 측면', right: '대상 자체의 오른쪽 측면', diagonal: '대각선 3/4', top: '위에서', bottom: '아래에서' },
  framing: { full: '전신/오브젝트 전체', upper: '상반신', face: '얼굴', part: '지정 부위' },
  pose: { natural: '자연스러운 기본 자세', a: 'A 포즈', t: 'T 포즈', custom: '추가 지시의 자세' },
  background: { solid: '단색 배경', transparent: '투명 배경 원본', custom: '추가 지시의 배경' },
  perspective: { orthographic: '모델링 참고용, 원근 왜곡 최소화', natural: '자연스러운 원근감' },
  margin: { full: '전신과 끝부분이 잘리지 않는 충분한 여백', motion: '동작을 위한 넓은 상하좌우 여백' },
};
/** Deterministic option compilation. No model call, no execution on option changes. */
export function compileCreation(object: GraphicsObject, taskId: string): { settings: CreationValues; instruction: string; spec: CreationSpec } {
  const spec = validateCreation(effectiveCreation(object), object.kind), stage = stageForTask(taskId), settings = creationSettings(object, stage);
  // A05 uses the common size contract only, not the Unity delivery route/collider/compression choices.
  const selectionProblem = taskId === 'A05' ? undefined : creationSelectionProblem(spec, stage);
  if (selectionProblem) throw Error(selectionProblem);
  if (taskId === 'M09') {
    const repairProblem = missingSurfaceRepairProblem(spec, settings);
    if (repairProblem) throw Error(repairProblem);
    settings.repairMaxAddedFaces ??= 1500;
    settings.repairMaxAddedVertices ??= 1000;
    settings.count = 1;
  }
  if (taskId === 'M07' && spec.subject === 'human' && isWholeThenSplitCreation(spec) && ['head', 'body', 'hair'].some(id => !spec.parts.some(part => part.id === id && part.enabled))) throw Error('전체 모델 분리에는 머리·몸통·머리카락 세 파트를 모두 선택하세요.');
  // Cleared optional descriptions must not become default wording in the frozen request.
  for (const key of ['direction', 'framing', 'pose', 'background', 'perspective', 'margin', 'motionPreset'])
    if (settings[key] === '') delete settings[key];
  if (!isBiologicalSubject(spec.subject)) {
    delete settings.pose;
    if (['upper', 'face'].includes(String(settings.framing))) delete settings.framing;
  }
  const part = creationPartForTask(spec, taskId);
  settings.subject = spec.subject;
  if (stage === 'rig') {
    if (taskId === 'R01' && spec.subject === 'human') settings.rigFingers = settings.rigFingers !== false;
    else delete settings.rigFingers;
  }
  if (stage !== 'design' && spec.physicalSize !== undefined) settings.physicalSize = JSON.stringify(normalizePhysicalSize(spec.physicalSize));
  if (stage === 'design') settings.imageSchedule = 'parallel-native-4';
  for (const [key, value] of Object.entries(applicableAttributes(spec))) if (value !== '') settings[`attr.${key}`] = value;
  const locks = spec.locks.filter(id => creationLockAppliesToSubject(id, spec.subject));
  for (const lock of locks) settings[`lock.${lock}`] = true;
  const free = [spec.instruction, spec.stageSettings[stage]?.instruction, ...Object.entries(applicableAttributes(spec)).filter(([k]) => k.startsWith('custom.')).map(([, v]) => String(v))].filter(Boolean).join('\n');
  settings.freeInstruction = (['T02','T05'].includes(taskId) ? spec.stageSettings[stage]?.instruction ?? '' : free).slice(0, 12000);
  settings.requestedParts = JSON.stringify(spec.parts.filter(p => p.enabled));
  const partWork = part;
  if (partWork) { settings.partId = part.id; settings.partLabel = part.label; if (stage === 'model') { settings.count = part.count; settings.faceLimit = part.faceLimit; } }
  if (['M01', 'M02', 'M03', 'M04', 'M15'].includes(taskId)) Object.assign(settings, requireModelGeometry(settings, taskId));
  const descriptions = [...summarizeCreation(spec), spec.instruction, spec.stageSettings[stage]?.instruction].filter(Boolean);
  if (stage === 'design') for (const [key, labels] of Object.entries(imageLabels)) if (settings[key] !== undefined) descriptions.push(`${key}: ${labels[String(settings[key])] ?? String(settings[key])}`);
  if (partWork) descriptions.push(`제작 대상 파츠만: ${part.label}. ${part.instruction}. 전체 디자인의 비율·색·스타일을 유지하고 다른 파츠는 생성하지 마세요.`);
  if (taskId === 'M09') descriptions.push('선택한 리깅 전 원본 파트의 기존 면·정점·UV·재질을 보존하고, 명시한 빠진 영역에만 새 면을 추가합니다. 의도한 목 접합 경계는 유지하세요. 결과는 별도 버전으로 검토하고 채택한 다음 UV·텍스처를 준비합니다.');
  if (isWholeThenSplitCreation(spec) && stage === 'model') descriptions.push('분리 전 전체 모델을 한 번에 제작합니다. 목표 면 수는 머리·몸통(팔다리·손가락·의상 포함)·머리카락 전체의 합계이며 파트마다 새로 적용하지 않습니다. 후속 단계에서 세 파트로 분리한 뒤 각 파트의 UV와 텍스처를 준비합니다.');
  if (taskId === 'R01' && spec.subject === 'human') descriptions.push(`몸통과 팔다리는 Unity Humanoid용으로 리깅합니다. ${settings.rigFingers ? '양손 손가락 본을 포함합니다.' : '선택적 손가락 본은 만들지 않습니다.'}${settings.rigHair !== true ? ' 머리카락은 Head 본을 따라 움직이며 별도 머리카락 보조 본을 만들지 않습니다.' : ''} 표정과 물리는 이 요청에 포함하지 않습니다.`);
  if (locks.length) descriptions.push(`유지할 특징: ${locks.map(id => creationLocks.find(l => l.id === id)!.label).join(', ')}. 변경 지시와 충돌하면 무시하지 말고 원인을 보고하세요. 외형 보존을 자동 검증했다고 주장하지 마세요.`);
  if (stage === 'animation') descriptions.push([settings.motionPreset ? `동작: ${settings.motionPreset}` : '', settings.rootMotion ? '이동 동작' : '제자리', settings.loop ? '반복' : '단발'].filter(Boolean).join(', '));
  return { settings, instruction: descriptions.join('\n'), spec };
}
