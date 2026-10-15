import { parsePropDefinition, suggestPropDefinition } from './shared/props';
import type { AssetBinding, PropDefinition, RoomPurpose } from './shared/types';

const escape = (s: string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const purposes: [RoomPurpose,string][] = [['battle','전투방'],['boss','보스방'],['start','시작방'],['reward','보상방'],['shop','상점방']];

/** Uses delegated change events: dataset.propBinding identifies the binding, propField identifies the field. */
export function renderPropLibraryFields(binding: AssetBinding, disabled = false): string {
  if(binding.role!=='prop'&&binding.role!=='decoration')return '';
  const p=binding.prop??suggestPropDefinition(binding),off=disabled?' disabled':'',attrs=(field:string)=>`data-prop-binding="${escape(binding.id)}" data-prop-field="${field}"${off}`;
  return `<details class="prop-library"><summary>소품 종류·점유 크기·배치 조건</summary>
    <label class="field"><span>종류 ${binding.prop?'':'(이름으로 제안)'}</span><input ${attrs('category')} value="${escape(p.category)}" maxlength="80" placeholder="상자, 가구, 식생 등"></label>
    <label class="field"><span>테마 태그 · 쉼표로 구분</span><input ${attrs('tags')} value="${escape(p.tags.join(', '))}" placeholder="공장, 폐허"></label>
    <label class="field"><span>원본 크기 X · Y · Z (m)</span><input ${attrs('size')} value="${p.size?`${p.size.x}, ${p.size.y}, ${p.size.z}`:''}" placeholder="가로, 높이, 깊이 · 예: 2, 1, 3"></label>
    <p class="caption">${p.size?'배율을 곱한 실제 점유 크기로 검사합니다. 자동 배치에서 소품을 축소하지 않습니다.':'크기 미등록: 공간을 검증하는 자동 배치에서 제외됩니다. Unity 크기 파일을 가져오거나 세 치수를 함께 입력하세요.'}</p>
    <label class="field"><span>배치 위치</span><select ${attrs('placement')}>${[['floor','바닥'],['wall','벽'],['ceiling','천장']].map(([v,l])=>`<option value="${v}" ${p.placement===v?'selected':''}>${l}</option>`).join('')}</select></label>
    <label><input type="checkbox" ${attrs('blocksMovement')} ${p.blocksMovement?'checked':''}> 통행을 막음</label>
    <label class="field"><span>출현 가중치 · 0은 자동 배치 제외</span><input type="number" ${attrs('weight')} min="0" max="10000" step="0.1" value="${p.weight}"></label>
    <div class="field"><span>사용 가능한 방</span>${purposes.map(([r,l])=>`<label><input type="checkbox" ${attrs(`roomTypes.${r}`)} ${p.roomTypes.includes(r)?'checked':''}> ${l}</label>`).join('')}</div>
  </details>`;
}

/** Returns a checked detached binding, so the caller can commit a single undoable edit. */
export function handlePropField(binding: AssetBinding, field: string, value: string | boolean): AssetBinding {
  if(binding.role!=='prop'&&binding.role!=='decoration')throw new Error('소품 또는 장식 에셋에서만 배치 조건을 편집할 수 있습니다.');
  const p:PropDefinition=structuredClone(binding.prop??suggestPropDefinition(binding));
  if(field==='category')p.category=String(value).trim();
  else if(field==='tags')p.tags=[...new Set(String(value).split(',').map(s=>s.trim()).filter(Boolean))];
  else if(field==='blocksMovement')p.blocksMovement=value===true;
  else if(field==='placement')p.placement=value as PropDefinition['placement'];
  else if(field==='weight')p.weight=Number(value);
  else if(field==='size') {
    if(!String(value).trim())delete p.size;
    else {const parts=String(value).trim().split(/[\s,×xX]+/).map(Number);if(parts.length!==3)throw new Error('원본 크기를 가로 X, 높이 Y, 깊이 Z의 세 숫자로 입력해 주세요.');p.size={x:parts[0],y:parts[1],z:parts[2]};}
  } else if(field.startsWith('size.')) {
    const axis=field.slice(5) as 'x'|'y'|'z';if(!['x','y','z'].includes(axis)||!p.size)throw new Error('먼저 X, Y, Z 원본 크기를 모두 입력해 주세요.');p.size[axis]=Number(value);
  } else if(field.startsWith('roomTypes.')) {
    const room=field.slice(10) as RoomPurpose;if(!purposes.some(([r])=>r===room))throw new Error('알 수 없는 방 용도입니다.');p.roomTypes=value===true?[...new Set([...p.roomTypes,room])]:p.roomTypes.filter(r=>r!==room);
  } else throw new Error('알 수 없는 소품 설정입니다.');
  return {...structuredClone(binding),prop:parsePropDefinition(p)};
}
