import type { GenerationSettings, MapConcept, RoomPresetId } from './shared/types';
import { conceptMode } from './shared/concepts';
import { ROOM_PRESETS, applyRoomPreset } from './shared/room-presets';
import { DEFAULT_LEVEL_DESIGN } from './shared/level-design';
import { parseGenerationSettings } from './shared/features';

const esc=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function renderConceptControls(settings: GenerationSettings, busy: boolean): string {
  const mode = conceptMode(settings), disabled = busy ? 'disabled' : '';
  return `<section class="concept-controls"><label class="field"><span>맵 컨셉</span><select id="conceptMode" data-generation-control="conceptMode" ${disabled}><option value="ai" ${mode === 'ai' ? 'selected' : ''}>AI 자동 작성</option><option value="manual" ${mode === 'manual' ? 'selected' : ''}>직접 입력</option></select></label>${mode === 'manual' ? `<label class="field"><span>직접 작성할 컨셉</span><textarea id="prompt" maxlength="6000" placeholder="플레이 목표와 플레이어가 판단할 선택을 입력하세요. 예: 진입 후 적의 압박을 파악하고 접근과 이탈 시점을 선택하는 전투." ${disabled}>${esc(settings.prompt)}</textarea></label>` : '<p class="caption">맵 생성 시 AI가 선택한 조건에 맞춰 플레이 목표와 선택 중심의 컨셉을 작성합니다. 여러 후보는 플레이 경험의 초점을 달리합니다.</p>'}</section>`;
}
export function renderConceptResult(concept: MapConcept | undefined, label: string, kind: string): string {
  return concept ? `<section class="concept-result" data-concept-result="${esc(kind)}" aria-label="${esc(label)}"><div><strong>${esc(label)}</strong><span>${concept.source === 'ai' ? 'AI 작성' : '직접 입력'}</span></div><p>${esc(concept.text)}</p></section>` : '';
}
export function renderConnectionSizeControls(settings:GenerationSettings,busy:boolean):string {
  const disabled=busy?'disabled':'',width=settings.connectionWidth??settings.cellSize,height=settings.connectionHeight??3;
  return `<div class="pair"><label class="field"><span>새 연결문 폭 (m)</span><input id="connectionWidth" data-generation-control="connectionWidth" type="number" value="${width}" min="0.25" max="40" step="0.25" ${disabled}></label><label class="field"><span>새 연결문 높이 (m)</span><input id="connectionHeight" data-generation-control="connectionHeight" type="number" value="${height}" min="0.25" max="20" step="0.25" ${disabled}></label></div><p class="caption">다음 맵 생성과 수동 연결문 추가에 적용합니다. 폭 ${width}m는 셀 간격 ${settings.cellSize}m에서 ${Math.ceil(width/settings.cellSize)}셀을 사용합니다. 기존 문은 선택해서 개별 수정할 수 있습니다.</p>`;
}
export function renderGenerationControls(settings:GenerationSettings,busy:boolean):string {
  const disabled=busy?'disabled':'',preset=settings.roomPreset&&ROOM_PRESETS[settings.roomPreset],design=settings.levelDesign;
  const input=(field:string,label:string,value:number,min:number,max:number,step:number)=>`<label class="field"><span>${label}</span><input data-generation-control="${field}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" ${disabled}></label>`;
  return `<section class="designer-settings"><label class="field"><span>방 규격 · 기본 구성</span><select data-generation-control="preset" ${disabled}><option value="custom" ${settings.sizeMode!=='preset'?'selected':''}>사용자 지정 크기</option>${Object.values(ROOM_PRESETS).map(p=>`<option value="${p.id}" ${settings.sizeMode==='preset'&&settings.roomPreset===p.id?'selected':''}>${p.label} · ${p.min*settings.cellSize}~${p.max*settings.cellSize}m</option>`).join('')}</select></label><p class="caption">${preset&&settings.sizeMode==='preset'?`각 축 ${preset.min}~${preset.max}셀에서 후보별 크기를 결정합니다. 현재 맵은 유지합니다.`:'직접 치수를 입력하면 방 용도는 유지하고 크기만 지정합니다.'}</p>
  <details class="feature-group"><summary>레벨디자인 · 재현 시드</summary><label class="field"><span>공간 분석</span><select data-generation-control="enabled" ${disabled}><option value="true" ${design?'selected':''}>근접·회피 설계 적용</option><option value="false" ${!design?'selected':''}>기존 지형 생성</option></select></label>${design?`<label class="field"><span>전투 공간 패턴</span><select data-generation-control="pattern" ${disabled}>${[['auto','기능에 맞게 자동'],['openArena','열린 전투장'],['flankingArena','장애물 양쪽 우회'],['raisedArena','고지에 두 접근로']].map(([v,t])=>`<option value="${v}" ${design.pattern===v?'selected':''}>${t}</option>`).join('')}</select></label><div class="pair">${input('characterRadius','캐릭터 반경 (m)',design.characterRadius,.1,3,.1)}${input('dodgeDistance','회피 거리 (m)',design.dodgeDistance,.25,20,.25)}</div><label class="field"><span>소품 테마 태그 (선택)</span><input data-generation-control="theme" maxlength="80" value="${esc(design.theme??'')}" ${disabled}></label>`:''}<label class="field"><span>생성 시드 · 비우면 자동</span><input data-generation-control="seed" type="number" min="0" max="4294967295" value="${settings.seed??''}" ${disabled}></label></details></section>`;
}
export function updateGenerationControl(source:GenerationSettings,field:string,value:string):GenerationSettings {
  if(field==='preset')return value==='custom'?{...structuredClone(source),sizeMode:'custom',sizeResolved:false}:applyRoomPreset(source,value as RoomPresetId);
  const settings=structuredClone(source);settings.sizeResolved=false;
  if(field==='conceptMode') { if(value!=='ai'&&value!=='manual')throw new Error('컨셉 작성 모드를 확인해 주세요.'); settings.conceptMode=value; }
  else if(field==='connectionWidth'||field==='connectionHeight')settings[field]=Number(value);
  else if(field==='enabled'){if(value==='true')settings.levelDesign={...DEFAULT_LEVEL_DESIGN};else delete settings.levelDesign;}
  else if(field==='seed'){if(!value.trim())delete settings.seed;else settings.seed=Number(value);}
  else if(settings.levelDesign){if(field==='theme')settings.levelDesign.theme=value.trim();else if(field==='pattern')settings.levelDesign.pattern=value as NonNullable<GenerationSettings['levelDesign']>['pattern'];else if(field==='characterRadius'||field==='dodgeDistance')settings.levelDesign[field]=Number(value);}
  return parseGenerationSettings(settings);
}
