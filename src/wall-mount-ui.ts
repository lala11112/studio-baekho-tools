import { defaultWallMount, DEFAULT_WALL_SETTINGS } from './shared/wall-mounts';
import { getWallMountReadiness } from './shared/wall-mount-diagnostics';
import { placeholderWallBinding, wallPlaceholderLabel } from './shared/wall-placeholders';
import { countWallPlaceholders } from './shared/wall-replacement';
import type { AssetBinding, GenerationSettings, GridMap, MapFixture, WallMountDefinition, WallMountSettings, WallMountSite } from './shared/types';

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const sites: [WallMountSite, string][] = [['wall', '일반 벽면'], ['doorTop', '문 위'], ['doorSide', '문 옆'], ['upper', '벽 상단'], ['lower', '벽 하단'], ['corner', '모서리']];
const kinds: [WallMountDefinition['kind'], string][] = [['single', '개별 부착물'], ['straight', '연속 부품 · 직선'], ['innerCorner', '연속 부품 · 안쪽 코너'], ['outerCorner', '연속 부품 · 바깥 코너'], ['endCap', '연속 부품 · 끝마감'], ['elbow', '연속 부품 · 벽면 엘보'], ['tee', '연속 부품 · 벽면 T자']];

export function renderWallMountFields(binding: AssetBinding, disabled = false): string {
  if (!['decoration', 'light'].includes(binding.role)) return '';
  const mount = binding.wallMount ?? defaultWallMount(binding), off = disabled ? ' disabled' : '';
  const attr = (field: string) => `data-wall-binding="${escape(binding.id)}" data-wall-field="${field}"${off}`;
  const option = (value: string, text: string, selected: string) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${text}</option>`;
  return `<details class="wall-mount-library" ${binding.wallMount ? 'open' : ''}><summary>벽 부착물 · 문 조명 · 배관</summary>
    <label><input type="checkbox" ${attr('enabled')} ${binding.wallMount ? 'checked' : ''}> 벽 부착 자동 배치에 사용</label>
    ${binding.wallMount ? `<label class="field"><span>설치 방식</span><select ${attr('kind')}>${kinds.map(([value, text]) => option(value, text, mount.kind)).join('')}</select></label>
    <div class="field"><span>설치 가능한 위치</span><div class="toggle-grid">${sites.map(([site, text]) => `<label><input type="checkbox" ${attr(`sites.${site}`)} ${mount.sites.includes(site) ? 'checked' : ''}> ${text}</label>`).join('')}</div></div>
    <label class="field"><span>높이 기준</span><select ${attr('heightMode')}>${[['center', '설치 가능한 벽면 중앙에서 보정'], ['floor', '바닥 · 문 위는 개구부 상단 기준'], ['top', '벽 상단에서 아래로']].map(([value, text]) => option(value, text, mount.heightMode)).join('')}</select></label>
    <label class="field"><span>${mount.heightMode === 'center' ? '중앙 높이 보정' : mount.heightMode === 'top' ? '상단 아래 거리' : '설치 높이'} (m)</span><input type="number" ${attr('height')} value="${mount.height}" min="-100" max="100" step="0.1"></label>
    <label class="field"><span>최소 반복 간격 (m)</span><input type="number" ${attr('spacing')} value="${mount.spacing}" min="0.05" max="100" step="0.1"></label>
    <label class="field"><span>설치 확률 (%) · 문 위는 문마다 검사</span><input type="number" ${attr('probability')} value="${mount.probability}" min="0" max="100" step="1"></label>
    ${mount.sites.includes('doorSide') ? `<label class="field"><span>문 옆 설치 방향</span><select ${attr('doorSide')}>${[['left', '왼쪽'], ['right', '오른쪽'], ['both', '양쪽']].map(([value, text]) => option(value, text, mount.doorSide)).join('')}</select></label>` : ''}
    ${mount.sites.includes('doorTop') ? '<p class="caption">문 위는 상부 마감 벽면에 설치합니다. 개구부 바로 위 0.25m는 바닥 기준·높이 0.25로 설정하세요. 중앙은 상부 마감 중앙, 상단은 전체 벽 상단을 기준으로 합니다.</p>' : ''}
    ${mount.kind !== 'single' ? `<label class="field"><span>연결 세트 ID</span><input ${attr('family')} value="${escape(mount.family)}" maxlength="80" placeholder="예: factory_pipe_100"></label><p class="caption">같은 세트의 직선·코너·끝마감·엘보·T자를 조립합니다. 원본 배율을 유지하며 길이를 늘이거나 줄이지 않습니다.</p>` : ''}
    ${['elbow', 'tee'].includes(mount.kind) ? `<p class="caption" data-wall-junction-note>벽면 엘보와 T자는 평평한 벽에 붙입니다. 부착점 +Z는 방 안쪽이며, 연결점은 로컬 XY 면에서 관 끝 바깥쪽을 향하게 만드세요. 엘보는 직각 연결점 2개, T자는 좌우와 위 또는 아래 연결점 3개가 필요합니다. 벽 자체의 안쪽·바깥쪽 모서리 부품과 구분해 등록하세요.</p>` : ''}
    <p class="caption" data-wall-geometry="${escape(binding.id)}">${binding.bounds ? `원본 크기 ${binding.bounds.size.x} × ${binding.bounds.size.y} × ${binding.bounds.size.z}m` : binding.prop?.size ? '등록한 원본 크기 사용' : '크기 미확정 · Unity 크기 JSON을 가져오세요'} · 부착점 ${mount.mounts.length}개 · 연결점 ${mount.sockets.length}개 · 충돌 상자 ${mount.collisionBoxes.length}개</p>
    <p class="caption">조명·액자·표지판·환기구·선반도 같은 규칙으로 설치합니다. 부착점의 +Z는 방 안쪽, 배관 연결점의 +Z는 부품 바깥쪽을 향하게 만드세요. 정확한 기준점과 연결점은 Unity의 BaekhoWallModule에서 등록한 뒤 크기 JSON으로 가져옵니다.</p>` : '<p class="caption">개별 벽등, 문 위 조명·표지판, 문 옆 스위치, 액자·선반, 연결형 배관을 등록할 수 있습니다.</p>'}
  </details>`;
}

/** Detached values let the caller validate and commit the entire change once. */
export function handleWallMountField(binding: AssetBinding, field: string, value: string | boolean): AssetBinding {
  if (!['decoration', 'light'].includes(binding.role)) throw new Error('조명과 장식 에셋에서 벽 부착 조건을 설정할 수 있습니다.');
  const next = structuredClone(binding);
  if (field === 'enabled') { if (value === true) next.wallMount = defaultWallMount(binding); else delete next.wallMount; return next; }
  if (!next.wallMount) throw new Error('먼저 벽 부착 자동 배치를 켜세요.');
  const mount = next.wallMount;
  if (field === 'kind') { if (!kinds.some(([kind]) => kind === value)) throw new Error('설치 방식을 확인하세요.'); mount.kind = value as WallMountDefinition['kind']; }
  else if (field === 'family') { const name = String(value).trim(); if (name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new Error('연결 세트 ID는 80자 이하로 입력하세요.'); mount.family = name; }
  else if (field.startsWith('sites.')) { const site = field.slice(6) as WallMountSite; if (!sites.some(([candidate]) => candidate === site)) throw new Error('설치 위치를 확인하세요.'); mount.sites = value === true ? [...new Set([...mount.sites, site])] : mount.sites.filter(item => item !== site); if (!mount.sites.length) throw new Error('설치 위치를 하나 이상 선택하세요.'); }
  else if (field === 'heightMode') { if (!['center', 'floor', 'top'].includes(String(value))) throw new Error('높이 기준을 확인하세요.'); mount.heightMode = value as WallMountDefinition['heightMode']; }
  else if (field === 'doorSide') { if (!['left', 'right', 'both'].includes(String(value))) throw new Error('문 옆 설치 방향을 확인하세요.'); mount.doorSide = value as WallMountDefinition['doorSide']; }
  else if (['height', 'spacing', 'probability'].includes(field)) { const n = Number(value); if (!Number.isFinite(n) || n > 100 || n < (field === 'height' ? -100 : field === 'spacing' ? .05 : 0)) throw new Error('설치 높이·간격·확률 범위를 확인하세요.'); if (field === 'height') mount.height = n; else if (field === 'spacing') mount.spacing = n; else mount.probability = n; }
  else throw new Error('알 수 없는 벽 부착 설정입니다.');
  return next;
}

/** Update a detached height policy; the caller validates the complete generation settings before committing. */
export function handleWallHeightSetting(settings: WallMountSettings, field: string, value: string): WallMountSettings {
  const next = structuredClone(settings);
  const distance = () => {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || number < 0 || number > 100) throw new Error('배관 높이와 거리는 0~100m로 입력하세요.');
    return number;
  };
  const reference = () => {
    if (value !== 'floor' && value !== 'top') throw new Error('배관 높이 기준을 확인하세요.');
    return value;
  };
  if (field === 'runLayout') {
    if (value !== 'legacy' && value !== 'composed') throw new Error('배관 구도 방식을 확인하세요.');
    next.runLayout = value;
  } else if (field === 'runHeightMode') {
    if (value === 'asset') delete next.runHeight;
    else if (value === 'fixed') {
      const height = next.runHeight?.min ?? 2;
      next.runHeight = { mode: 'fixed', reference: next.runHeight?.reference ?? 'floor', min: height, max: height };
    } else if (value === 'random' || value === 'auto') next.runHeight = { mode: value, reference: next.runHeight?.reference ?? 'floor', min: next.runHeight?.min ?? 1, max: Math.max(next.runHeight?.max ?? 3, next.runHeight?.min ?? 1) };
    else throw new Error('가로 배관 높이 방식을 확인하세요.');
  } else if (field.startsWith('runHeight')) {
    if (!next.runHeight) throw new Error('먼저 지정 높이 또는 범위 내 무작위를 선택하세요.');
    if (field === 'runHeightReference') next.runHeight.reference = reference();
    else if (field === 'runHeightValue' && next.runHeight.mode === 'fixed') next.runHeight.min = next.runHeight.max = distance();
    else if (field === 'runHeightMin' && next.runHeight.mode === 'random') next.runHeight.min = distance();
    else if (field === 'runHeightMax' && next.runHeight.mode === 'random') next.runHeight.max = distance();
    else throw new Error('가로 배관 높이 항목을 확인하세요.');
  } else if (field === 'verticalRangeMode') {
    if (value === 'full') delete next.verticalRange;
    else if (value === 'custom') next.verticalRange ??= { reference: 'floor', start: 0, end: 3 };
    else throw new Error('세로 배관 범위 방식을 확인하세요.');
  } else if (field.startsWith('verticalRange')) {
    if (!next.verticalRange) throw new Error('먼저 세로 배관의 지정 범위를 선택하세요.');
    if (field === 'verticalRangeReference') next.verticalRange.reference = reference();
    else if (field === 'verticalRangeStart') next.verticalRange.start = distance();
    else if (field === 'verticalRangeEnd') next.verticalRange.end = distance();
    else throw new Error('세로 배관 범위 항목을 확인하세요.');
  } else throw new Error('벽 부착물 설정을 확인하세요.');
  return next;
}

export function renderWallMountSettings(value: WallMountSettings | undefined, disabled = false, currentMap = false): string {
  const settings = { ...DEFAULT_WALL_SETTINGS, ...value }, off = disabled ? 'disabled' : '';
  const check = (field: 'enabled' | 'singles' | 'runs' | 'placeholderFallback' | 'connectRuns', text: string) => `<label><input type="checkbox" data-d-control="wall-setting:${field}" ${(field === 'placeholderFallback' || field === 'connectRuns' ? settings[field] !== false : settings[field]) ? 'checked' : ''} ${off}> ${text}</label>`;
  const select = (field: string, label: string, selected: string, choices: string[][]) => `<label class="field"><span>${label}</span><select data-d-control="wall-setting:${field}" ${off}>${choices.map(([key, text]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
  const number = (field: string, label: string, value: number) => `<label class="field"><span>${label} (m)</span><input type="number" data-d-control="wall-setting:${field}" value="${value}" min="0" max="100" step="0.1" ${off}></label>`;
  const references = [['floor', '인접 바닥에서 위로'], ['top', '벽 상단에서 아래로']], height = settings.runHeight, vertical = settings.verticalRange;
  return `<details class="feature-group" data-wall-settings="${currentMap ? 'current' : 'generation'}" open><summary>${currentMap ? '현재 맵 · 벽 부착물 추가' : '벽 부착물 자동 배치'}</summary>
    ${check('enabled', '생성 시 벽 부착물 배치')}<div class="tool-buttons">${check('singles', '벽등·문 조명·개별 장식')}${check('runs', '배관·케이블·연속 부품')}</div>
    ${select('runLayout', '배관·케이블 구도', settings.runLayout ?? 'legacy', [['legacy', '기존 벽면별 배치'], ['composed', '정돈된 산업 설비 · 경로 먼저 설계']])}
    <label class="field"><span>배관·케이블 배치 방향</span><select data-d-control="wall-setting:runOrientation" ${off}>${[['horizontal', '가로 · 벽을 따라 연결'], ['vertical', '세로 · 벽을 타고 상승'], ['both', '가로와 세로 함께']].map(([orientation, text]) => `<option value="${orientation}" ${(settings.runOrientation ?? 'horizontal') === orientation ? 'selected' : ''}>${text}</option>`).join('')}</select></label>
    ${select('runHeightMode', '가로 배치 높이', height?.mode ?? 'asset', [['auto', '자동 · 벽 높이와 장애물에 맞춤'], ['asset', '프리팹 기본값'], ['fixed', '지정 높이'], ['random', '범위 내 무작위']])}
    ${height && height.mode !== 'auto' ? `${select('runHeightReference', '가로 높이 기준', height.reference, references)}${height.mode === 'fixed' ? number('runHeightValue', '부착점 높이·거리', height.min) : `<div class="pair">${number('runHeightMin', '최소 거리', height.min)}${number('runHeightMax', '최대 거리', height.max)}</div>`}<p class="caption">지정 높이는 정확히 유지합니다. 정돈된 구도의 범위 모드는 부품 길이로 조립 가능한 높이 안에서만 전환합니다. 설치할 수 없는 구간은 이유를 표시합니다.</p>` : height?.mode === 'auto' ? '<p class="caption">벽 높이와 설비·문 주변 여유에 맞춰 높이를 선택합니다. 정돈된 구도에서 가로·세로 연결을 켜면 엘보와 원본 길이의 세로 부품으로 높이가 다른 가로 구간을 연결합니다.</p>' : ''}
    ${select('verticalRangeMode', '세로 배관 높이 범위', vertical ? 'custom' : 'full', [['full', '전체 높이'], ['custom', '지정 범위']])}
    ${vertical ? `${select('verticalRangeReference', '세로 범위 기준', vertical.reference, references)}<div class="pair">${number('verticalRangeStart', '시작 거리', vertical.start)}${number('verticalRangeEnd', '끝 거리', vertical.end)}</div><p class="caption">시작 거리보다 끝 거리를 크게 입력하세요. 벽 상단 기준은 두 거리 사이의 아래쪽 구간입니다. 끝마감을 포함해 범위 안에 배치하며, 원본 부품 길이로 채우고 남는 길이는 여백으로 둡니다.</p>` : ''}
    ${check('connectRuns', '가로·세로 배관 연결 (엘보·T자)')}<p class="caption">‘가로와 세로 함께’에서 같은 세트의 엘보·T자로 연결합니다. 끄면 가로와 세로를 각각 끝마감한 구간으로 배치합니다.</p>
    ${check('placeholderFallback', '프리팹이 없으면 임시 벽 부착물로 배치')}<p class="caption">등록한 프리팹을 우선 사용하고, 없는 종류는 임시 벽등·문 위 조명·패널·환기구·배관으로 배치를 확인합니다. 임시 부착물을 선택하면 실제 프리팹으로 교체할 수 있습니다.</p>
    <div class="pair"><label class="field"><span>개별 목표 점유율 (%)</span><input type="number" data-d-control="wall-setting:density" value="${settings.density}" min="1" max="100" step="1" ${off}></label><label class="field"><span>연속 배치 목표 (%)</span><input type="number" data-d-control="wall-setting:runDensity" value="${settings.runDensity}" min="1" max="100" step="1" ${off}></label></div>
    <p class="caption">${settings.runLayout === 'composed' ? '실제로 조립한 경로 길이를 목표로 삼습니다. 긴 주 경로와 설비 주변 가지를 우선하고 벽면 여백을 남깁니다.' : '가로는 벽 길이, 세로는 설치 가능한 벽면 수를 기준으로 합니다.'}</p>
    ${currentMap ? `<button data-d-action="place-wall-mounts" class="primary full" ${off}>현재 맵에 벽 부착물 자동 배치</button><p class="caption">전체 맵의 사용 가능한 벽과 문에 목표까지 추가합니다. 기존 배치와 잠금을 유지하며, AI 호출 없이 실행하고 되돌릴 수 있습니다.</p><button data-d-action="reapply-wall-runs" class="secondary full" ${off}>현재 설정으로 자동 배관 재배치</button><p class="caption">자동 배관·케이블에 현재 구도·방향·높이·밀도를 적용합니다. 수동 편집·복사·잠금·시설 참조가 있는 연결 구간은 보존하며, 한 번의 되돌리기로 복원합니다.</p><p class="caption">설정 변경만으로 기존 배관이 이동하지 않습니다. 다음 자동 생성에도 넣으려면 위의 ‘생성 시 벽 부착물 배치’를 켜세요.</p>` : '<p class="caption">에셋에서 벽면·문 위·문 옆·모서리와 높이·간격을 지정하세요. 조명은 프리팹의 광원 설정을 유지합니다.</p>'}</details>`;
}

export function renderWallMountReadiness(settings: GenerationSettings, bindings: AssetBinding[]): string {
  const readiness = getWallMountReadiness(settings, bindings);
  const fallback = settings.designer?.wallMounts?.placeholderFallback !== false;
  return `<div class="wall-mount-readiness" data-wall-readiness role="status"><p class="caption"><strong>벽용 등록 ${readiness.configured}개 · 크기 확인 ${readiness.measured}개 · 생성 배치 ${readiness.enabled ? '켜짐' : '꺼짐'}</strong></p><p class="caption" data-wall-fallback-status>임시 부착물 ${fallback ? '사용 · 프리팹 없이도 배치 확인 가능' : '꺼짐 · 등록된 벽용 프리팹만 사용'}</p><p class="caption">일반 ‘장식’ 에셋은 자동으로 벽에 붙지 않습니다. 실제 프리팹을 사용하려면 에셋의 ‘벽 부착 자동 배치에 사용’을 켜고 실제 크기를 등록하세요.</p>${readiness.issues.length ? `<ul>${readiness.issues.map(issue => `<li>${escape(issue.message)}</li>`).join('')}</ul>` : ''}</div>`;
}

export function renderWallFixtureEditor(fixture: MapFixture, bindings: AssetBinding[], disabled = false, map?: GridMap, bulkBindingId = ''): string {
  if (!fixture.wall) return '';
  const wall = fixture.wall, binding = bindings.find(item => item.id === fixture.bindingId), off = disabled ? 'disabled' : '';
  const definition = wall.placeholder ? placeholderWallBinding(wall.placeholder).wallMount : binding?.wallMount;
  const candidates = bindings.filter(item => item.role === fixture.role && item.wallMount && (item.wallMount.sites.includes(wall.site) || wall.site === 'corner' && ['innerCorner', 'outerCorner'].includes(item.wallMount.kind)) && (item.bounds || item.prop?.size || item.wallMount.collisionBoxes.length) && (definition?.kind === 'single' ? item.wallMount.kind === 'single' : item.wallMount.kind === definition?.kind && (wall.placeholder || item.wallMount.family === definition?.family)));
  const sameKind = wall.placeholder && map ? countWallPlaceholders(map, wall.placeholder) : 0;
  const vertical = wall.sockets.some(socket => Math.abs(socket.direction.y) > .9), horizontal = wall.sockets.some(socket => Math.hypot(socket.direction.x, socket.direction.z) > .9);
  const orientation = vertical && horizontal ? ' · 가로·세로 연결' : vertical ? ' · 세로 부품' : '';
  return `<div data-wall-fixture-editor="${escape(fixture.id)}"><p class="caption"><strong>${escape(wall.placeholder ? wallPlaceholderLabel(wall.placeholder) : binding?.label ?? '벽 부착물')}</strong> · ${sites.find(([site]) => site === wall.site)?.[1] ?? wall.site}${wall.runId ? ' · 연결 구간' : ''}${orientation}${wall.doorId ? ' · 문 위치 추종' : ''}${wall.authored ? ' · 수동 수정 보호' : ''}</p>
    ${wall.placeholder ? '<p class="caption" data-wall-placeholder-note>배치 확인용 임시 형상입니다. 실제 프리팹을 등록한 뒤 아래에서 선택하세요. 원래 설치점을 기준으로 교체하고 크기와 충돌을 다시 검사합니다. 임시 조명에는 게임 광원이 없습니다.</p>' : ''}
    <label class="field"><span>선택한 하나에 사용할 프리팹</span><select data-d-control="wall-edit:bindingId" ${off}>${wall.placeholder ? '<option value="" selected>임시 유지 · 실제 프리팹 선택</option>' : candidates.some(item => item.id === fixture.bindingId) ? '' : `<option value="${escape(fixture.bindingId ?? '')}" selected disabled>${escape(binding?.label ?? fixture.bindingId ?? '기존 프리팹')} · 설치 조건 확인</option>`}${candidates.map(item => `<option value="${escape(item.id)}" ${item.id === fixture.bindingId ? 'selected' : ''}>${escape(item.label)}</option>`).join('')}</select></label>
    ${wall.placeholder && !candidates.length ? '<p class="caption">교체할 수 있는 벽용 프리팹이 아직 없습니다. 같은 종류와 설치 위치의 조명 또는 장식을 등록하세요.</p>' : ''}
    ${wall.placeholder && map ? `<div data-wall-bulk-editor="${escape(wall.placeholder)}"><label class="field"><span>같은 종류 전체에 사용할 프리팹</span><select data-d-control="wall-bulk-binding" ${off}><option value="" ${!bulkBindingId ? 'selected' : ''}>전체 교체할 실제 프리팹 선택</option>${candidates.map(item => `<option value="${escape(item.id)}" ${item.id === bulkBindingId ? 'selected' : ''}>${escape(item.label)}</option>`).join('')}</select></label><button data-d-action="replace-wall-placeholders" class="primary full" style="word-break:keep-all" ${disabled || !sameKind || !candidates.some(item => item.id === bulkBindingId) ? 'disabled' : ''}>같은 종류 ${sameKind}개 한 번에 교체</button><p class="caption">맵 전체의 ${escape(wallPlaceholderLabel(wall.placeholder))}만 교체합니다. 설치 조건·잠금·겹침을 모두 검사하고, 한 개라도 교체할 수 없으면 기존 배치를 유지합니다. 한 번의 되돌리기로 복원할 수 있습니다.</p></div>` : ''}
    <p class="caption">현재 설치 높이 Y ${Number(wall.position.y.toFixed(4))}m</p><label class="field"><span>높이 이동량 (m)</span><input type="number" data-d-control="wall-edit:height" value="0" min="-100" max="100" step="0.1" ${off}></label>
    <div class="pair"><label class="field"><span>벽을 따라 이동 (m)</span><input type="number" data-d-control="wall-edit:along" value="0" min="-100" max="100" step="0.1" ${off}></label><label class="field"><span>벽에서 띄우기 (m)</span><input type="number" data-d-control="wall-edit:distance" value="0" min="-100" max="100" step="0.05" ${off}></label></div>
    <p class="caption">이동량은 현재 위치에서 더할 거리이며 유효한 벽면과 실제 겹침을 검사합니다.${wall.runId ? ' 높이와 이동은 연결 구간 전체에 적용합니다. 단독 수정은 먼저 연결에서 분리하세요.' : ''}</p>
    ${wall.runId ? `<button data-d-action="detach-wall-fixture" class="full" ${off}>연결에서 분리</button>` : ''}<button data-d-action="delete-wall-fixture" class="danger full" ${off}>벽 부착물 제거</button></div>`;
}
