import type { GenerationSettings, RoomPresetId } from './shared/types';
import { ROOM_PRESETS, applyRoomPreset } from './shared/room-presets';
import { DEFAULT_LEVEL_DESIGN } from './shared/level-design';
import { parseGenerationSettings } from './shared/features';

const esc=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function renderGenerationControls(settings:GenerationSettings,busy:boolean):string {
  const disabled=busy?'disabled':'',preset=settings.roomPreset&&ROOM_PRESETS[settings.roomPreset],design=settings.levelDesign;
  const input=(field:string,label:string,value:number,min:number,max:number,step:number)=>`<label class="field"><span>${label}</span><input data-generation-control="${field}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" ${disabled}></label>`;
  return `<section class="designer-settings"><label class="field"><span>방 규격 · 기본 구성</span><select data-generation-control="preset" ${disabled}><option value="custom" ${settings.sizeMode!=='preset'?'selected':''}>사용자 지정 크기</option>${Object.values(ROOM_PRESETS).map(p=>`<option value="${p.id}" ${settings.sizeMode==='preset'&&settings.roomPreset===p.id?'selected':''}>${p.label} · ${p.min*settings.cellSize}~${p.max*settings.cellSize}m</option>`).join('')}</select></label><p class="caption">${preset&&settings.sizeMode==='preset'?`각 축 ${preset.min}~${preset.max}셀에서 후보별 크기를 결정합니다. 현재 맵은 유지합니다.`:'직접 치수를 입력하면 방 용도는 유지하고 크기만 지정합니다.'}</p>
  <details class="feature-group"><summary>레벨디자인 · 재현 시드</summary><label class="field"><span>공간 분석</span><select data-generation-control="enabled" ${disabled}><option value="true" ${design?'selected':''}>근접·회피 설계 적용</option><option value="false" ${!design?'selected':''}>기존 지형 생성</option></select></label>${design?`<label class="field"><span>전투 공간 패턴</span><select data-generation-control="pattern" ${disabled}>${[['auto','기능에 맞게 자동'],['openArena','열린 전투장'],['flankingArena','장애물 양쪽 우회'],['raisedArena','고지에 두 접근로']].map(([v,t])=>`<option value="${v}" ${design.pattern===v?'selected':''}>${t}</option>`).join('')}</select></label><div class="pair">${input('characterRadius','캐릭터 반경 (m)',design.characterRadius,.1,3,.1)}${input('dodgeDistance','회피 거리 (m)',design.dodgeDistance,.25,20,.25)}</div><label class="field"><span>소품 테마 태그 (선택)</span><input data-generation-control="theme" maxlength="80" value="${esc(design.theme??'')}" ${disabled}></label>`:''}<label class="field"><span>생성 시드 · 비우면 자동</span><input data-generation-control="seed" type="number" min="0" max="4294967295" value="${settings.seed??''}" ${disabled}></label></details></section>`;
}
export function updateGenerationControl(source:GenerationSettings,field:string,value:string):GenerationSettings {
  if(field==='preset')return value==='custom'?{...structuredClone(source),sizeMode:'custom',sizeResolved:false}:applyRoomPreset(source,value as RoomPresetId);
  const settings=structuredClone(source);settings.sizeResolved=false;
  if(field==='enabled'){if(value==='true')settings.levelDesign={...DEFAULT_LEVEL_DESIGN};else delete settings.levelDesign;}
  else if(field==='seed'){if(!value.trim())delete settings.seed;else settings.seed=Number(value);}
  else if(settings.levelDesign){if(field==='theme')settings.levelDesign.theme=value.trim();else if(field==='pattern')settings.levelDesign.pattern=value as NonNullable<GenerationSettings['levelDesign']>['pattern'];else if(field==='characterRadius'||field==='dodgeDistance')settings.levelDesign[field]=Number(value);}
  return parseGenerationSettings(settings);
}
