import type { GraphicsKind, GraphicsObject } from './graphics';
import { isGraphicsClipName } from './graphics';

export type CreationStage = 'design' | 'model' | 'surface' | 'assembly' | 'rig' | 'animation' | 'unity';
export type CreationValues = Record<string, string | number | boolean>;
export type PartSpec = { id: string; label: string; enabled: boolean; instruction: string; faceLimit: number; count: number };
export type CreationSpec = {
  schemaVersion: 1; subject: string; attributes: CreationValues; instruction: string; locks: string[];
  stageSettings: Partial<Record<CreationStage, { instruction: string; values: CreationValues }>>;
  parts: PartSpec[]; activePartId?: string;
  clipSettings?: Record<string, { instruction: string; values: CreationValues }>;
};
export type OptionDefinition = { id: string; label: string; values: { value: string; label: string }[]; subjects?: string[]; advanced?: boolean };
export const creationStages: { id: CreationStage; label: string }[] = [
  { id: 'design', label: '이미지' }, { id: 'model', label: '모델' }, { id: 'surface', label: '재질' },
  { id: 'assembly', label: '조립·수정' }, { id: 'rig', label: '리깅' }, { id: 'animation', label: '애니메이션' }, { id: 'unity', label: 'Unity 전달' },
];
export const creationSubjects: { id: string; label: string; kind: GraphicsKind }[] = [
  { id: 'human', label: '인간형 캐릭터', kind: 'character' }, { id: 'animal', label: '동물', kind: 'character' },
  { id: 'creature', label: '크리처', kind: 'character' }, { id: 'weapon', label: '무기', kind: 'weapon' },
  { id: 'armor', label: '의상·장비', kind: 'weapon' }, { id: 'rock', label: '바위·광물', kind: 'prop' },
  { id: 'box', label: '상자·용기', kind: 'prop' }, { id: 'prop', label: '가구·소품', kind: 'prop' },
  { id: 'building', label: '건축·환경', kind: 'environment' }, { id: 'plant', label: '식물', kind: 'environment' },
];
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
  option('hinge', '경첩·가동부', ['none:없음', 'hinge:경첩', 'sliding:미닫이'], ['box', 'building'], true),
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
  option('propType', '소품 종류', ['furniture:가구', 'tool:도구', 'food:음식', 'decoration:장식품', 'custom:직접 설명'], ['prop']),
  option('buildingType', '환경 부품', ['wall:벽', 'floor:바닥', 'door:문', 'stairs:계단', 'column:기둥', 'house:건물', 'terrain:지형 조각'], ['building']),
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
  { id: 'body', label: '몸통', enabled: true, instruction: '몸통·팔·손·다리·발. 머리와 머리카락 제외.', faceLimit: 10000, count: 1 },
  { id: 'hair', label: '머리카락', enabled: true, instruction: '채택한 헤어스타일 전체. 두피·얼굴·몸 제외.', faceLimit: 5000, count: 1 },
];
const stageDefaults: Record<CreationStage, CreationValues> = {
  design: { count: 2, designMode: 'new', direction: 'front', framing: 'full', pose: 'natural', background: 'solid', perspective: 'orthographic', margin: 'full', multiview: false, viewFront: true, viewBack: true, viewLeft: true, viewRight: true },
  model: { count: 1, modelMethod: 'tripo', inputMode: 'image', faceLimit: 10000, quad: true, scale: 1, symmetry: true },
  surface: { count: 1, surfaceOperation: 'texture', textureMode: 'tripo', uvMode: 'keep', textureSize: 4096, color: '#808080', roughness: .65, metallic: 0, emission: 0, opacity: 1 },
  assembly: { count: 1, assemblyMode: 'correct' },
  rig: { count: 1, rigType: 'none', rigEars: false, rigTail: false, rigHair: false, rigClothing: false, rigWings: false, rigAccessories: false },
  animation: { count: 1, animationMode: 'text', clipName: 'Idle', motionPreset: 'idle', duration: 2, fps: 30, loop: true, rootMotion: false, motionSourceView: 'left' },
  unity: { count: 1, deliveryMode: 'unity', scale: 1, pivot: 'keep', exportFormat: 'both', collider: 'none', lodEnabled: false, lodRatio: .5, deliveryTextureSize: 0, deliveryCompression: 'none' },
};
export function defaultCreation(kind: GraphicsKind): CreationSpec {
  const subject = ({ character: 'human', weapon: 'weapon', prop: 'prop', environment: 'building' } as Record<string, string>)[kind] ?? 'prop';
  return { schemaVersion: 1, subject, instruction: '', attributes: { style: 'stylized', composition: 'whole' }, locks: [],
    stageSettings: Object.fromEntries(creationStages.map(({ id }) => [id, { instruction: '', values: { ...stageDefaults[id], ...(id === 'design' && kind === 'character' ? { pose: 'a' } : {}) } }])), parts: [] };
}
/** Read-only compatibility. Legacy settings are copied, never rewritten on open. */
export function effectiveCreation(object: GraphicsObject): CreationSpec {
  if (object.creation) return structuredClone(object.creation);
  const spec = defaultCreation(object.kind); spec.instruction = object.instruction;
  for (const { id } of creationStages) {
    for (const key of Object.keys(stageDefaults[id])) if (object.settings[key] !== undefined) spec.stageSettings[id]!.values[key] = object.settings[key];
    if (!['design', 'model'].includes(id)) spec.stageSettings[id]!.values.count = 1;
  }
  for (const [key, value] of Object.entries(object.settings)) {
    const stage = /^(front|left|right|back)VersionId$/.test(key) ? 'model' : /^(motion|actionName|clipName)/.test(key) ? 'animation' : undefined;
    if (stage) spec.stageSettings[stage]!.values[key] = value;
  }
  return spec;
}
export function creationSettings(object: GraphicsObject, stage: CreationStage): CreationValues {
  const spec = effectiveCreation(object);
  return { ...stageDefaults[stage], ...spec.stageSettings[stage]?.values };
}
export function creationInstruction(object: GraphicsObject, stage: CreationStage): string { return effectiveCreation(object).stageSettings[stage]?.instruction ?? ''; }
export function creationTaskId(spec: CreationSpec, stage: CreationStage): string {
  const s = { ...stageDefaults[stage], ...spec.stageSettings[stage]?.values };
  if (stage === 'design') return ({ new: 'I01', reference: 'I02', revision: 'I03', variation: 'I05', equipment: 'I06', multiview: 'I07', parts: 'I08' } as Record<string, string>)[String(s.designMode)] ?? 'I01';
  if (stage === 'model') return s.modelMethod === 'local' ? 'M04' : s.modelMethod === 'astra' ? 'M15' : s.inputMode === 'multiview' ? 'M02' : 'M01';
  if (stage === 'surface') return s.surfaceOperation === 'uv' ? s.uvMode === 'tripo' ? 'T01' : 'T02' : s.textureMode === 'local' ? 'T05' : 'T03';
  if (stage === 'assembly') return s.assemblyMode === 'assemble' ? 'M08' : s.assemblyMode === 'separate' ? 'M07' : s.assemblyMode === 'partial' ? 'M06' : 'M05';
  if (stage === 'rig') return s.rigType === 'humanoid' ? 'R01' : s.rigType === 'existing' ? 'R03' : 'R02';
  if (stage === 'animation') return ({ source: 'N01', video: 'N02', reference: 'N04', text: 'N05', revision: 'N06' } as Record<string, string>)[String(s.animationMode)] ?? 'N05';
  return s.deliveryMode === 'files' ? 'X04' : 'X05';
}
export function stageForTask(taskId: string): CreationStage {
  if (taskId.startsWith('I')) return 'design';
  if (taskId.startsWith('T')) return 'surface';
  if (['M05', 'M06', 'M07', 'M08'].includes(taskId)) return 'assembly';
  if (taskId.startsWith('M')) return 'model';
  if (taskId.startsWith('R')) return 'rig';
  if (taskId.startsWith('N')) return 'animation';
  return 'unity';
}
export function summarizeCreation(spec: CreationSpec): string[] {
  return [creationSubjects.find(s => s.id === spec.subject)?.label ?? spec.subject,
    ...creationOptions.filter(o => !o.subjects || o.subjects.includes(spec.subject)).flatMap(o => {
      const v = spec.attributes[o.id]; if (v === undefined || v === '') return [];
      return [`${o.label}: ${o.values.find(x => x.value === v)?.label ?? String(v)}`];
    }), ...Object.entries(spec.attributes).filter(([key, value]) => key.startsWith('custom.') && String(value).trim()).map(([, value]) => String(value))];
}
export function validateCreation(value: CreationSpec, kind: GraphicsKind): CreationSpec {
  if (!value || value.schemaVersion !== 1 || creationSubjects.find(s => s.id === value.subject)?.kind !== kind) throw Error('대상 종류와 제작 프리셋을 확인하세요.');
  const values = (v: CreationValues) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 100 || Object.entries(v).some(([k,x]) => k.length > 100 || !['string','number','boolean'].includes(typeof x) || typeof x === 'number' && !Number.isFinite(x) || typeof x === 'string' && x.length > 2000)) throw Error('제작 옵션 값이 잘못됐습니다.'); };
  const text = (s: unknown) => { if (typeof s !== 'string' || s.length > 12000) throw Error('제작 지시는 12,000자 이내로 입력하세요.'); };
  values(value.attributes); text(value.instruction);
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
  for (const p of value.parts) { if (!/^[a-z][a-z0-9-]{0,39}$/.test(p.id) || !p.label?.trim() || p.label.length > 60 || typeof p.enabled !== 'boolean' || !Number.isInteger(p.faceLimit) || p.faceLimit < 100 || p.faceLimit > 1000000 || !Number.isInteger(p.count) || p.count < 1 || p.count > 4) throw Error('파츠 이름·면 수·후보 수를 확인하세요.'); text(p.instruction); }
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
  const part = spec.attributes.composition === 'parts' && spec.activePartId ? spec.parts.find(p => p.id === spec.activePartId && p.enabled) : undefined;
  settings.subject = spec.subject;
  if (stage === 'design') settings.imageSchedule = 'parallel-native-4';
  for (const [key, value] of Object.entries(spec.attributes)) settings[`attr.${key}`] = value;
  for (const lock of spec.locks) settings[`lock.${lock}`] = true;
  const free = [spec.instruction, spec.stageSettings[stage]?.instruction, ...Object.entries(spec.attributes).filter(([k]) => k.startsWith('custom.')).map(([, v]) => String(v))].filter(Boolean).join('\n');
  settings.freeInstruction = (['T02','T05'].includes(taskId) ? spec.stageSettings[stage]?.instruction ?? '' : free).slice(0, 12000);
  settings.requestedParts = JSON.stringify(spec.parts.filter(p => p.enabled));
  const partWork = part && !['I01','I02','M07','M08'].includes(taskId) && ['design','model','surface','assembly'].includes(stage);
  if (partWork) { settings.partId = part.id; settings.partLabel = part.label; if (stage === 'model') { settings.count = part.count; settings.faceLimit = part.faceLimit; } }
  const descriptions = [...summarizeCreation(spec), spec.instruction, spec.stageSettings[stage]?.instruction].filter(Boolean);
  if (stage === 'design') for (const [key, labels] of Object.entries(imageLabels)) descriptions.push(`${key}: ${labels[String(settings[key])] ?? String(settings[key] ?? '')}`);
  if (partWork) descriptions.push(`제작 대상 파츠만: ${part.label}. ${part.instruction}. 전체 디자인의 비율·색·스타일을 유지하고 다른 파츠는 생성하지 마세요.`);
  if (spec.locks.length) descriptions.push(`유지할 특징: ${spec.locks.map(id => creationLocks.find(l => l.id === id)!.label).join(', ')}. 변경 지시와 충돌하면 무시하지 말고 원인을 보고하세요. 외형 보존을 자동 검증했다고 주장하지 마세요.`);
  if (stage === 'animation') descriptions.push(`동작: ${settings.motionPreset ?? '직접 설명'}, ${settings.rootMotion ? '이동 동작' : '제자리'}, ${settings.loop ? '반복' : '단발'}`);
  return { settings, instruction: descriptions.join('\n'), spec };
}
