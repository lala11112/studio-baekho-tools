import { parsePropDefinition, propWorldSize, suggestPropDefinition } from './shared/props';
import { resolveFixtureBinding } from './shared/light-bindings';
import { effectivePropComposition } from './shared/prop-composition';
import { effectivePropBehavior } from './shared/prop-behavior';
import type { AssetBinding, ProjectFile, PropComposition, PropDefinition, RoomPurpose } from './shared/types';

const escape = (s: string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const purposes: [RoomPurpose,string][] = [['battle','전투방'],['boss','보스방'],['start','시작방'],['reward','보상방'],['shop','상점방']];
const behaviors: [NonNullable<PropDefinition['behavior']>, string][] = [['workSurface','책상·탁자'],['seat','좌석'],['floorEquipment','독립 설비·자립형 화면'],['surfaceAccessory','받침이 필요한 탁상 소품'],['generic','일반 바닥 소품']];

/** Uses delegated change events: dataset.propBinding identifies the binding, propField identifies the field. */
export function renderPropLibraryFields(binding: AssetBinding, disabled = false): string {
  if(!['prop','decoration','vegetation'].includes(binding.role))return '';
  const p=binding.prop??suggestPropDefinition(binding),off=disabled?' disabled':'',attrs=(field:string)=>`data-prop-binding="${escape(binding.id)}" data-prop-field="${field}"${off}`;
  const worldSize = p.size ? propWorldSize({ ...binding, prop: p }, 0) : undefined;
  const longest = worldSize ? Math.max(worldSize.x, worldSize.z) : 0;
  const sizeClass = longest >= 4 ? '대형' : longest >= 2 ? '중형' : '소형';
  const composition = effectivePropComposition(binding);
  const unitySets = p.unitySets ?? [], usesUnity = !p.composition && unitySets.length > 0;
  const choices = (field: string, value: string, values: [string, string][]) => `<select ${attrs(field)}>${values.map(([key, label]) => `<option value="${key}" ${value === key ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  return `<details class="prop-library"><summary>소품 종류·점유 크기·배치 조건</summary>
    ${binding.role==='decoration'||binding.role==='vegetation'?`<label class="field"><span>에셋 분류</span><select ${attrs('role')}>${[['decoration','장식'],['vegetation','식생']].map(([role,label])=>`<option value="${role}" ${binding.role===role?'selected':''}>${label}</option>`).join('')}</select></label><p class="caption">이 에셋을 사용하는 배치물 전체에 분류를 적용합니다. 프리팹 모양·크기·통행 설정은 유지합니다.</p>`:''}
    <label class="field"><span>종류 ${binding.prop?'':'(이름으로 제안)'}</span><input ${attrs('category')} value="${escape(p.category)}" maxlength="80" placeholder="상자, 가구, 식생 등"></label>
    <label class="field"><span>테마 태그 · 쉼표로 구분</span><input ${attrs('tags')} value="${escape(p.tags.join(', '))}" placeholder="공장, 폐허"></label>
    <label class="field"><span>물건의 기능</span>${choices('behavior', p.behavior ?? 'automatic', [['automatic',`자동 제안 · ${behaviors.find(([kind]) => kind === effectivePropBehavior(binding))?.[1] ?? '일반 바닥 소품'}`], ...behaviors])}</label>
    <p class="caption" data-prop-behavior>좌석은 책상 앞에 놓습니다. 받침이 필요한 탁상 소품은 자동 바닥 배치에서 생략합니다. 스탠드가 있는 화면은 독립 설비로 지정하세요. 이 조건은 Unity 세트에도 적용됩니다.</p>
    <label class="field"><span>원본 프리팹의 정면 각도 (도)</span><input type="number" ${attrs('frontYaw')} step="1" min="-360" max="360" value="${p.frontYaw ?? ''}" placeholder="기본: 기존 Y 보정 후 +Z"></label>
    <p class="caption">원본 +Z는 0°, +X는 90°, −Z는 180°, −X는 −90°입니다. 화면·작업면이 향하는 쪽을 지정하세요. 비워 두면 기존 Y 회전 보정을 사용합니다. 변경은 다음 자동 배치에 적용됩니다.</p>
    <fieldset class="prop-composition"><legend>구역별 묶음 구성</legend>
      <label class="field"><span>용도 설정</span>${choices('composition.mode', p.composition ? 'manual' : 'automatic', [['automatic',unitySets.length ? 'Unity 세트 사용' : '자동 제안 사용'],['manual','직접 지정']])}</label>
      ${unitySets.length ? `<p class="caption" data-unity-prop-sets>Unity 세트 ${unitySets.length}개: ${unitySets.map(set => escape(set.label)).join(', ')}. ${usesUnity ? '같은 세트에서 함께 쓸 소품을 고르고 위치와 방향은 앱이 정합니다.' : '현재는 앱에서 직접 지정한 묶음 설정을 우선합니다. Unity 세트 사용을 선택하면 목록을 다시 적용합니다.'}</p>` : ''}
      ${!usesUnity ? `<label class="field"><span>소품 용도</span>${choices('composition.usage', composition.usage, [['equipment','장비·설비'],['storage','적재·보관'],['natural','자연물'],['floorDetail','바닥 장식'],['edge','가장자리 난간'],['unknown','확인 필요'],['excluded','자동 배치 제외']])}</label>
      <label class="field"><span>함께 배치할 묶음 계열</span><input ${attrs('composition.family')} value="${escape(composition.family)}" maxlength="80" placeholder="예: equipment, storage"></label>
      <label class="field"><span>묶음 안의 역할</span>${choices('composition.member', composition.member, [['either','주·보조 모두 가능'],['anchor','주 소품'],['companion','보조 소품']])}</label>
      <label class="field"><span>묶음 배치 형태</span>${choices('composition.arrangement', composition.arrangement, [['either','벽면·독립 모두 가능'],['wall','벽면 설비'],['island','독립 묶음']])}</label>` : ''}
      <p class="caption" data-prop-composition-state="${p.composition ? 'manual' : usesUnity ? 'unity' : 'automatic'}">${usesUnity ? 'Unity에서 목록을 수정한 뒤 표시된 프리팹 가져오기를 다시 누르면 세트를 갱신합니다. 기존 맵에는 자동 소품 재정리를 실행하세요. 크기·통행·방 용도·가중치 조건은 그대로 검사합니다.' : `${p.composition ? '직접 지정한 용도와 묶음은 크기를 다시 가져와도 유지됩니다.' : '이름·종류·크기로 용도를 제안합니다. 항목을 수정하면 직접 지정으로 저장됩니다.'} 같은 용도와 묶음 계열의 소품끼리 구성하며, 확인이 필요한 소품은 구역별 자동 배치에서 제외합니다. ${unitySets.length ? 'Unity 세트 사용' : '자동 제안 사용'}을 선택하면 직접 지정을 초기화합니다.`}</p>
    </fieldset>
    <label class="field"><span>원본 크기 X · Y · Z (m)</span><input ${attrs('size')} value="${p.size?`${p.size.x}, ${p.size.y}, ${p.size.z}`:''}" placeholder="가로, 높이, 깊이 · 예: 2, 1, 3"></label>
    <p class="caption" data-prop-size-state="${p.size?'measured':'unmeasured'}">${worldSize?`측정 크기 · 배율 반영 X ${Number(worldSize.x.toFixed(3))} × Y ${Number(worldSize.y.toFixed(3))} × Z ${Number(worldSize.z.toFixed(3))}m${binding.role==='prop'?` · ${sizeClass}`:''}. 자동 배치에서 소품을 축소하지 않습니다.`:'크기 미확정 · 임시 표시. 공간을 검증하는 자동 배치에서 제외됩니다. Unity 크기 파일을 가져오거나 세 치수를 함께 입력하세요.'}</p>
    <p class="caption">ㄱ자·곡선 등 원래 프리팹 모양은 유지합니다. 배치는 전체를 감싸는 직사각형을 기준으로 검사하며, 오목하게 빈 부분도 점유 영역에 포함합니다.</p>
    <label class="field"><span>배치 위치</span><select ${attrs('placement')}>${[['floor','바닥'],['wall','벽'],['ceiling','천장']].map(([v,l])=>`<option value="${v}" ${p.placement===v?'selected':''}>${l}</option>`).join('')}</select></label>
    <label><input type="checkbox" ${attrs('blocksMovement')} ${p.blocksMovement?'checked':''}> 통행을 막음</label>
    <label class="field"><span>출현 가중치 · 0은 자동 배치 제외</span><input type="number" ${attrs('weight')} min="0" max="10000" step="0.1" value="${p.weight}"></label>
    <div class="field"><span>사용 가능한 방</span>${purposes.map(([r,l])=>`<label><input type="checkbox" ${attrs(`roomTypes.${r}`)} ${p.roomTypes.includes(r)?'checked':''}> ${l}</label>`).join('')}</div>
  </details>`;
}

/** Returns a checked detached binding, so the caller can commit a single undoable edit. */
export function handlePropField(binding: AssetBinding, field: string, value: string | boolean): AssetBinding {
  if(!['prop','decoration','vegetation'].includes(binding.role))throw new Error('소품·장식·식생 에셋에서만 배치 조건을 편집할 수 있습니다.');
  const p:PropDefinition=structuredClone(binding.prop??suggestPropDefinition(binding));
  if(field==='composition.mode') {
    if(value==='automatic')delete p.composition;
    else if(value==='manual')p.composition=effectivePropComposition(binding);
    else throw new Error('알 수 없는 용도 설정입니다.');
  } else if(field.startsWith('composition.')) {
    const composition = effectivePropComposition(binding), key = field.slice(12);
    if(key==='usage')composition.usage=String(value) as PropComposition['usage'];
    else if(key==='family')composition.family=String(value).trim();
    else if(key==='member')composition.member=String(value) as PropComposition['member'];
    else if(key==='arrangement')composition.arrangement=String(value) as PropComposition['arrangement'];
    else throw new Error('알 수 없는 묶음 설정입니다.');
    p.composition=composition;
  } else if(field==='behavior') {
    if(value==='automatic')delete p.behavior;
    else p.behavior=String(value) as PropDefinition['behavior'];
  } else if(field==='frontYaw') {
    if(!String(value).trim())delete p.frontYaw;
    else p.frontYaw=Number(value);
  } else if(field==='category')p.category=String(value).trim();
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

/** Reclassifies a shared asset and its placements without changing authored geometry or metadata. */
export function reclassifyPropBinding(project: ProjectFile, bindingId: string, role: string): ProjectFile {
  const binding=project.bindings.find(item=>item.id===bindingId);
  if(!binding||!['decoration','vegetation'].includes(binding.role)||role!=='decoration'&&role!=='vegetation')throw new Error('장식과 식생 에셋 사이에서만 분류를 바꿀 수 있습니다.');
  const next=structuredClone(project);
  if(binding.role===role)return next;
  const resolvedFixtures=new Map((project.map.fixtures??[]).filter(fixture=>fixture.role==='decoration'||fixture.role==='vegetation').map(fixture=>[fixture.id,resolveFixtureBinding(project.map,project.bindings,fixture)?.id]));
  next.bindings.find(item=>item.id===bindingId)!.role=role;
  for(const prop of next.map.propInstances??[])if(prop.bindingId===bindingId)prop.role=role;
  for(const fixture of next.map.fixtures??[]){
    const resolved=resolvedFixtures.get(fixture.id);
    // Both role pools change size; pin every previously resolved automatic choice before either pool changes.
    if(!fixture.bindingId&&resolved)fixture.bindingId=resolved;
    if(fixture.bindingId===bindingId)fixture.role=role;
  }
  for(const override of next.map.assetOverrides)if(override.bindingId===bindingId)override.role=role;
  return next;
}
