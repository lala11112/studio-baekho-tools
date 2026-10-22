import type { AssetBinding, AssetRole, DesignerSettings, FixtureRole, GridMap, MapFixture, ProjectFile } from './shared/types';
import { ASSET_ROLES, DIRECTIONS, DEFAULT_DESIGNER, DESIGNER_PRESETS, MAX_CEILING_Y, MAX_WALL_HEIGHT, exposedCliffFaces, parseGenerationSettings, ceilingEligibleCells, reapplyLighting, structureSettingsFor } from './shared/features';
import { cellHasRole, connectionCells, parseProjectFile, resolveBinding } from './shared/map';
import { captureRegion, pasteRegion, compareModules, type RegionSnapshot } from './shared/editing';
import { fixtureBindings, resolveFixtureBinding } from './shared/light-bindings';
import { automaticCeilingY, highestFloorSurface, configureStructures, synchronizeStructures, setPitBottom, structurePitRegions } from './shared/structures';
import { analyzeLevelDesign, type LevelDesignReport } from './shared/level-design';
import { DEFAULT_WALL_SETTINGS, editWallMount, insertWallMount, placeWallMounts, reapplyWallRuns } from './shared/wall-mounts';
import { renderWallMountSettings, renderWallMountReadiness, renderWallFixtureEditor, handleWallHeightSetting } from './wall-mount-ui';
import { wallPlaceholderLabel } from './shared/wall-placeholders';
import { replaceWallPlaceholders } from './shared/wall-replacement';

type Cell = { x: number; row: number };
type Region = Cell & { width: number; height: number };
type Deps = {
  project: () => ProjectFile; selected: () => Cell | null; select: (cell: Cell) => void;
  commit: (edit: () => void) => void; render: () => void; notify: (message: string, error?: boolean) => void;
  busy: () => boolean; openComparison: () => Promise<ProjectFile | null>; regenerate: () => Promise<void>;
};
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const EXTRA_ROLES: { role: AssetRole; label: string; symbol: string; note: string }[] = [
  ['ceiling', '천장', '▔', '아랫면이 천장 높이에 맞춰집니다'], ['bridge', '다리 상판', '═', '상판 윗면이 셀 높이에 맞춰집니다. 아래 통행면 없음'],
  ['cliff', '절벽 벽면', '▥', '깊이에 맞춰 Y 크기를 조정합니다. 바깥 방향은 +Z'], ['slope', '경사로', '◩', '계단처럼 낮은 쪽에서 +Z로 상승'],
  ['deadzone', '데드존', '▨', '원본 Collider와 Trigger를 하부 영역에 맞춥니다. 피해·리스폰 동작은 프리팹이 처리합니다'],
  ['light', '천장·벽·문 조명', '✦', '벽등·문 조명·천장등의 원본 광원 설정을 유지합니다. 벽 부착점의 +Z는 방 안쪽'], ['railing', '난간', '╫', '원본 +Z가 가장자리 바깥 방향'],
  ['column', '기둥', '▥', '프리팹 루트 기준 배치'], ['arch', '아치', '∩', '프리팹 루트 기준 배치'],
  ['water', '물', '≈', '수면 프리팹. 수영 등은 게임에서 처리'], ['hazard', '용암·독늪', '△', '위험 바닥 프리팹. 피해 처리는 게임에서 연결'],
  ['trap', '함정', '◇', '원본 함정 프리팹의 동작 사용'], ['gate', '잠금문', 'Π', '잠금문 프리팹'], ['switch', '레버·스위치', '↯', '게임 지점의 연결 키로 문과 연동'],
  ['secretDoor', '비밀문', '▣', '비밀문 프리팹. 통로는 생성하지 않습니다'], ['rest', '휴식처', '○', '휴식처 프리팹'], ['merchant', '상인 자리', '◈', '상인 자리 프리팹'],
  ['altar', '제단', '▰', '제단 프리팹'], ['decoration', '장식', '✧', '가구·소품 등 장식 프리팹'],
  ['vegetation', '식생', '♣', '풀·관목·나무 등 식생 프리팹'],
].map(([role, label, symbol, note]) => ({ role: role as AssetRole, label, symbol, note }));
const fixtureRoles = EXTRA_ROLES.filter(r => !['ceiling', 'bridge', 'cliff', 'slope', 'deadzone'].includes(r.role));
const groups: { label: string; fields: [keyof DesignerSettings, string][] }[] = [
  { label: '지형', fields: [['elevation', '높낮이·계단'], ['bridges', '다리 설치'], ['cliffs', '낭떠러지 만들기'], ['slopes', '경사로']] },
  { label: '건축물', fields: [['ceilings', '천장 만들기'], ['structureFill', '구조 틈 자동 마감'], ['railings', '난간'], ['columns', '기둥'], ['arches', '아치']] },
  { label: '조명·장식·식생', fields: [['lights', '조명 자동 배치'], ['props', '장애 소품'], ['decorations', '장식'], ['vegetation', '식생'], ['water', '물 구역']] },
  { label: '게임 요소', fields: [['enemies', '몬스터 지점'], ['rewards', '보상 지점'], ['events', '이벤트 지점'], ['hazards', '용암·독늪'], ['traps', '함정'], ['gates', '잠금문·스위치'], ['secrets', '비밀문'], ['rests', '휴식처'], ['merchants', '상인'], ['altars', '제단']] },
];
const numericFields: [keyof DesignerSettings, string, number, number, number, keyof DesignerSettings | null][] = [
  ['ceilingHeight', '최고 바닥 위 여유 높이 (m)', .25, 20, .25, 'ceilings'], ['wallHeight', '기본 벽 높이 (m)', .25, 20, .25, null],
  ['bridgeCount', '다리 개수', 1, 8, 1, 'bridges'], ['bridgeHeight', '다리 상판 높이 (m)', .25, 20, .25, 'bridges'],
  ['cliffCount', '낭떠러지 개수', 1, 8, 1, 'cliffs'], ['cliffSize', '낭떠러지 크기 (셀)', 1, 8, 1, 'cliffs'], ['cliffDepth', '절벽 깊이 (m)', .25, 20, .25, 'cliffs'],
  ['enemyCount', '몬스터 지점 수', 1, 64, 1, 'enemies'], ['rewardCount', '보상 지점 수', 1, 64, 1, 'rewards'], ['eventCount', '이벤트 지점 수', 1, 64, 1, 'events'],
  ['fixtureDensity', '조명·기타 배치 밀도 (%)', 1, 100, 1, null],
  ['decorationDensity', '장식 배치 밀도 (%)', 1, 100, 1, 'decorations'], ['vegetationDensity', '식생 배치 밀도 (%)', 1, 100, 1, 'vegetation'],
  ['headroom', '캐릭터 높이 (m)', .25, 10, .1, null],
];
const presetNames = { battle: '일반 전투방', boss: '보스방', reward: '보상방', start: '시작방', shop: '상점방' };
const storageKey = 'baekho-designer-templates-v4';

export function createDesigner(deps: Deps) {
  let area: Region | null = null, origin: Cell | null = null, clipboard: RegionSnapshot | null = null;
  let rotation: 0 | 1 | 2 | 3 = 0, mirrorX = false, mirrorZ = false;
  let showCeilings = false, showFixtures = true, showMarkers = true, showCharacter = false;
  let showDeadzone = false, showDesign = false;
  let fixtureRole: FixtureRole = 'light', fixtureAnchor: 'floor' | 'wall' | 'ceiling' = 'ceiling';
  let markerKind: 'enemy' | 'reward' | 'event' = 'enemy', chosenFixture = '', chosenMarker = '';
  let toolHeight = 4, zone: 'combat' | 'reward' | 'rest' = 'combat';
  let comparison: ProjectFile | null = null, portA = '', portB = '';
  let templateName = '', selectedTemplate = '';
  let pendingCeiling: { x:number; row:number; y:number } | null = null;
  let wallBindingId = '';
  let wallBulkBindingId = '';
  let wallResult: { map: GridMap; result: ReturnType<typeof placeWallMounts>; placeholders: number; real: number } | undefined;
  let wallReapplyResult: { map: GridMap; result: ReturnType<typeof reapplyWallRuns> } | undefined;
  const settings = () => ({ ...DEFAULT_DESIGNER, ...deps.project().settings.designer,
    propLayout: deps.project().settings.designer?.propLayout ?? 'legacy' as const });
  const structureSettings = () => ({ ...structureSettingsFor(deps.project().settings), ...deps.project().map.structureSettings });
  const designReport = (): LevelDesignReport | undefined => {
    try { return analyzeLevelDesign(deps.project().map, deps.project().settings); } catch { return undefined; }
  };
  const disabled = () => deps.busy() ? 'disabled' : '';
  const selection = (): Region | null => area ?? (deps.selected() ? { ...deps.selected()!, width: 1, height: 1 } : null);
  const cells = () => {
    const r = selection(); if (!r) throw new Error('먼저 셀 또는 영역을 선택해 주세요.');
    const map = deps.project().map;
    if (r.x < 0 || r.row < 0 || r.x + r.width > map.width || r.row + r.height > map.height) throw new Error('선택 영역이 맵 밖입니다.');
    return Array.from({ length: r.width * r.height }, (_, i) => ({ x: r.x + i % r.width, row: r.row + Math.floor(i / r.width) }));
  };
  const isLocked = (cell: Cell) => !!deps.project().map.lockedCells?.some(c => c.x === cell.x && c.row === cell.row);
  const editableCells = () => cells().filter(c => !isLocked(c));
  const label = (role: string) => EXTRA_ROLES.find(r => r.role === role)?.label ?? role;
  const wallJunctionCount = () => (deps.project().map.fixtures ?? []).filter(fixture => fixture.wall && (['pipeElbow', 'pipeTee'].includes(fixture.wall.placeholder ?? '') || ['elbow', 'tee'].includes(deps.project().bindings.find(binding => binding.id === fixture.bindingId)?.wallMount?.kind ?? ''))).length;
  function templates(): Record<string, { settings: ProjectFile['settings']; bindings: ProjectFile['bindings']; region?: RegionSnapshot }> {
    try { const raw = JSON.parse(localStorage.getItem(storageKey) ?? '{}'); return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; } catch { return {}; }
  }
  function number(field: string, text: string, value: number, min: number, max: number, step = .25) {
    return `<label class="field"><span>${text}</span><input type="number" data-d-control="${field}" value="${value}" min="${min}" max="${max}" step="${step}" ${disabled()}></label>`;
  }
  function renderGeneration() {
    const d = settings();
    return `<section class="designer-settings"><label class="field"><span>방 용도 프리셋</span><select data-d-control="preset" ${disabled()}>${Object.entries(presetNames).map(([key, name]) => `<option value="${key}" ${d.preset === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
      ${groups.map((group, i) => `<details class="feature-group" ${i < 2 ? 'open' : ''}><summary>${group.label}<span>${group.fields.filter(([key]) => d[key] === true).length}개 켜짐</span></summary><div class="toggle-grid">${group.fields.map(([key, name]) => `<label class="feature-toggle"><input type="checkbox" data-d-feature="${key}" ${d[key] ? 'checked' : ''} ${disabled()}><span>${name}</span></label>`).join('')}</div></details>`).join('')}
      ${d.props ? `<details class="feature-group" open><summary>소품 공간 구성</summary><label class="field"><span>배치 방식</span><select data-d-control="prop-layout" ${disabled()}><option value="grouped" ${d.propLayout === 'grouped' ? 'selected' : ''}>구역별 묶음 구성</option><option value="balanced" ${d.propLayout === 'balanced' ? 'selected' : ''}>자동 균형 구성</option><option value="legacy" ${d.propLayout === 'legacy' ? 'selected' : ''}>기존 개수 유지</option></select></label>${d.propLayout !== 'legacy' ? number('setting:propCoverage', '목표 바닥 점유율 (%)', d.propCoverage ?? 12, 1, 30, 1) + (d.propLayout === 'grouped' ? '<p class="caption">같은 용도의 주 소품과 보조 소품을 벽면 설비·독립 묶음으로 구성합니다. 묶음 안에서는 방향과 간격을 맞추고, 묶음 사이에는 출입·회피·우회 공간을 확보합니다. 크기나 용도가 확인되지 않은 소품은 제외되며 공간이 부족하면 묶음을 줄이거나 생략합니다.</p>' : '<p class="caption">큰 소품을 먼저 놓고 중·소형을 주변에 구성합니다. 실제 크기를 유지하며 출입·회피·우회 공간을 확보합니다. 공간이 부족하면 목표에 미달할 수 있습니다.</p>') : '<p class="caption">AI가 지정한 소품 개수를 유지하고, 측정된 프리팹 크기에 맞춰 위치를 찾습니다.</p>'}<p class="caption">새 맵 생성과 선택 영역 재생성에 적용됩니다.</p></details>` : ''}
      <details class="feature-group" open><summary>조명 설치 방식</summary><label class="field"><span>자동 배치 위치</span><select data-d-control="light-placement" ${disabled()}>${([['auto','자동 · 천장 우선, 없으면 벽'],['ceiling','천장 조명'],['wall','벽 조명'],['both','천장과 벽 함께']] as const).map(([value,text])=>`<option value="${value}" ${(d.lightPlacement ?? 'auto') === value ? 'selected' : ''}>${text}</option>`).join('')}</select></label><p class="caption">방 전체에 간격을 두고 분산합니다. 문 위·문 옆 등 설치 규칙을 지정한 조명은 아래 벽 부착물 설정으로 배치합니다.</p></details>
      ${renderWallMountSettings(d.wallMounts, deps.busy())}
      ${renderWallMountReadiness(deps.project().settings, deps.project().bindings)}
      <details class="feature-group"><summary>높이 · 개수 · 밀도</summary><div class="pair">${numericFields.filter(([, , , , , condition]) => !condition || d[condition]).map(([key, name, min, max, step]) => number(`setting:${key}`, name, Number(d[key] ?? (key === 'decorationDensity' || key === 'vegetationDensity' ? d.fixtureDensity : undefined)), min, max, step)).join('')}</div></details>
      <details class="feature-group"><summary>구조 마감 기본값</summary><label class="field"><span>낭떠러지 하부</span><select data-d-control="pit-default" ${disabled()}><option value="deadzone" ${d.pitBottomKind !== 'floor' ? 'selected' : ''}>데드존</option><option value="floor" ${d.pitBottomKind === 'floor' ? 'selected' : ''}>마감 바닥</option></select></label><label class="field"><span>높이 차이의 수직면</span><select data-d-control="gap-default" ${disabled()}><option value="wall" ${d.gapRole !== 'cliff' ? 'selected' : ''}>벽</option><option value="cliff" ${d.gapRole === 'cliff' ? 'selected' : ''}>절벽 벽면</option></select></label></details>
      <p class="caption">조건은 다음 생성에 적용됩니다. 자동 천장은 가장 높은 바닥·계단 끝·다리 상판 위로 여유 높이를 확보합니다. 맵 사이 통로는 Unity에서 만듭니다.</p></section>`;
  }
  function renderToolbar() {
    return `<div class="designer-toolbar">${[['ceiling', '천장', showCeilings], ['deadzone', '데드존', showDeadzone], ['design', '설계 분석', showDesign], ['fixtures', '배치물', showFixtures], ['markers', '게임 지점', showMarkers], ['character', '캐릭터 크기', showCharacter]].map(([key, text, on]) => `<button data-d-action="view-${key}" class="${on ? 'selected' : ''}" aria-pressed="${on}">${text}</button>`).join('')}<span class="spacer"></span><small>Shift + 셀 선택: 영역</small></div>`;
  }
  function renderCellExtras() {
    const cell = deps.selected(); if (!cell) return '';
    const map = deps.project().map, ceiling = map.ceilings?.find(c => c.x === cell.x && c.row === cell.row), wall = map.wallHeights?.find(c => c.x === cell.x && c.row === cell.row);
    const ramp = map.ramps.find(c => c.x === cell.x && c.row === cell.row), bridge = map.bridges?.find(c => c.x === cell.x && c.row === cell.row);
    const bottom = map.pitBottoms?.find(c => c.x === cell.x && c.row === cell.row);
    const mode = (kind: string, current?: 'auto' | 'manual') => `<label class="field"><span>${kind === 'ceiling' ? '천장' : '벽'} 높이 기준</span><select data-d-control="${kind}-mode" ${disabled()}><option value="manual" ${current !== 'auto' ? 'selected' : ''}>수동 높이 유지</option><option value="auto" ${current === 'auto' ? 'selected' : ''}>최고 바닥 자동 추종</option></select></label>`;
    return `<div class="section-line"></div><h3>천장 · 구조</h3><p class="caption">최고 바닥 ${highestFloorSurface(map)}m + 여유 ${structureSettings().ceilingClearance}m = 자동 천장 Y ${automaticCeilingY(map, structureSettings().ceilingClearance)}m</p><div class="pair">${number('ceiling-y', '천장 아랫면 Y (m)', ceiling?.undersideY ?? (pendingCeiling?.x === cell.x && pendingCeiling?.row === cell.row ? pendingCeiling.y : automaticCeilingY(map, structureSettings().ceilingClearance)), -MAX_CEILING_Y, MAX_CEILING_Y)}<button data-d-action="${ceiling ? 'remove-cell-ceiling' : 'add-cell-ceiling'}" ${disabled()}>${ceiling ? '천장 제거' : '천장 추가'}</button></div>
      ${ceiling ? mode('ceiling', ceiling.heightMode) : '<p class="caption">기본 높이로 추가하면 자동 추종합니다. Y를 직접 입력하면 수동 높이로 추가합니다.</p>'}
      ${map.rows[cell.row][cell.x] === '#' ? number('wall-height', '벽 높이 (m)', wall?.height ?? settings().wallHeight, .25, MAX_WALL_HEIGHT) + mode('wall', wall?.heightMode) : ''}
      ${bottom ? `<h3>연결된 낭떠러지 하부</h3><label class="field"><span>마감 종류</span><select data-d-control="pit-kind" ${disabled()}><option value="deadzone" ${bottom.kind === 'deadzone' ? 'selected' : ''}>데드존</option><option value="floor" ${bottom.kind === 'floor' ? 'selected' : ''}>마감 바닥</option></select></label><div class="pair">${number('pit-y', '하단 윗면 Y (m)', bottom.y, -1000, 1000)}${number('pit-thickness', '두께 (m)', bottom.thickness, .01, 100, .1)}</div><p class="caption">다리 아래까지 연결된 구덩이 전체에 적용합니다. 하나라도 잠긴 셀이 있으면 유지합니다.</p>` : structurePitRegions(map).some(pit => pit.some(c => c.x === cell.x && c.row === cell.row)) ? '<p class="caption">구조 틈 채우기를 적용하면 이 구덩이의 하부 종류·높이·두께를 편집할 수 있습니다.</p>' : ''}
      ${ramp ? `<label class="field"><span>오름길 모양</span><select data-d-control="ramp-kind" ${disabled()}><option value="stair" ${ramp.kind !== 'slope' ? 'selected' : ''}>계단</option><option value="slope" ${ramp.kind === 'slope' ? 'selected' : ''}>경사로</option></select></label>` : ''}
      ${bridge ? `<label class="field"><span>다리 방향</span><select data-d-control="bridge-direction" ${disabled()}>${[0, 90, 180, 270].map(v => `<option value="${v}" ${bridge.direction === v ? 'selected' : ''}>${v}°</option>`).join('')}</select></label>` : ''}
      <button data-d-action="${isLocked(cell) ? 'unlock' : 'lock'}" ${disabled()}>${isLocked(cell) ? '영역 잠금 해제' : '영역 보호 · 잠금'}</button>`;
  }
  function renderStructureTools() {
    const map = deps.project().map, s = structureSettings();
    return `<details class="feature-group" open><summary>현재 맵 구조 마감</summary>${number('current-clearance', '최고 바닥 위 여유 높이 (m)', s.ceilingClearance, .25, 20)}<p class="caption">최고 바닥 ${highestFloorSurface(map)}m · 계산된 자동 천장 Y ${automaticCeilingY(map, s.ceilingClearance)}m</p><div class="tool-buttons"><button data-d-action="adopt-auto-ceiling" ${disabled()}>최고 바닥 기준으로 맞추기</button><button data-d-action="fill-structures" ${disabled()}>구조 틈 채우기</button></div><p class="caption">맞추기는 기존 천장·벽을 자동 추종으로 바꿉니다. 틈 채우기는 문 위·옆, 단차, 낭떠러지 하부를 마감합니다. 잠긴 셀과 뚫어 둔 천장은 유지합니다.</p></details>`;
  }
  function renderDesignReport() {
    const map = deps.project().map, report = designReport();
    if (!report) return '<details class="feature-group" open><summary>레벨디자인 검토</summary><p class="caption">왼쪽 설계 패턴과 활성화된 지형 조건을 확인해 주세요. 현재 조합은 분석할 수 없습니다.</p></details>';
    const obstacleDetails=report.obstacleChoices.length?`<p class="caption">양쪽 우회 동선이 있는 소품 ${report.obstacleChoices.length}개 · 장애물을 사이에 두고 접근 방향을 선택할 수 있습니다.</p><div class="object-list">${report.obstacleChoices.map((obstacle,index)=>`<button data-d-action="design-obstacle" data-id="${index}" ${disabled()}>소품 (${obstacle.cells[0].x}, ${obstacle.cells[0].row}) · 양쪽 우회 · 직선 대비 +${Number(obstacle.detourMeters.toFixed(1))}m</button>`).join('')}</div>`:'';
    return `<details class="feature-group" open><summary>레벨디자인 검토 · ${escape(report.recipe.label)}</summary><p class="caption">${escape(report.recipe.intent)}</p><p class="caption">외곽 ${map.width * map.cellSize} × ${map.height * map.cellSize}m · 실제 통행 면적 ${Number(report.walkableArea.toFixed(2))}m²<br>출입 경로 ${report.routes.length}개 · 회피 공간 ${report.combatCells.length ? '확보' : report.recipe.combatRequired ? '부족' : '검사 제외'} · 진입 여유 ${report.recipe.entryClearance}m</p>${obstacleDetails}<button data-d-action="view-design" class="full" aria-pressed="${showDesign}">${showDesign ? '경로·회피 공간 표시 끄기' : '경로·회피 공간 표시'}</button><div class="object-list">${report.issues.map((issue, index) => `<button data-d-action="design-issue" data-id="${index}" ${disabled()}>${escape(issue.message)}${issue.cells?.length ? ` · ${issue.cells[0].x}, ${issue.cells[0].row}` : ''}</button>`).join('')}</div><p class="caption">${report.issues.length ? `${report.issues.length}개 항목을 확인하세요. 항목을 누르면 문제 위치를 선택합니다.` : '현재 공간 규칙을 통과했습니다. 실제 게임 컨트롤러로 전투 속도와 재미를 확인하세요.'}</p></details>`;
  }
  function renderWallTools() {
    const bindings = deps.project().bindings.filter(binding => ['light', 'decoration'].includes(binding.role) && binding.wallMount?.kind === 'single' && (binding.bounds || binding.prop?.size || binding.wallMount.collisionBoxes.length));
    if (!bindings.some(binding => binding.id === wallBindingId)) wallBindingId = bindings[0]?.id ?? '';
    const report = wallResult?.map === deps.project().map ? wallResult.result : undefined;
    const reapplied = wallReapplyResult?.map === deps.project().map ? wallReapplyResult.result : undefined;
    const currentRunCount = new Set((deps.project().map.fixtures ?? []).flatMap(fixture => fixture.wall?.runId ? [fixture.wall.runId] : [])).size;
    return `${renderWallMountSettings(settings().wallMounts, deps.busy(), true)}
      ${reapplied ? `<div data-wall-reapply-result role="status"><p class="caption"><strong>${reapplied.unchanged ? '배관 재배치 변경 없음' : '자동 배관 재배치 완료'}</strong></p><p class="caption">재배치 ${reapplied.regeneratedRuns}구간 · 보존 ${reapplied.preservedRuns}구간 · 제외 ${reapplied.skippedRuns}구간</p>${reapplied.issues.length ? `<ul>${reapplied.issues.map(issue => `<li>${escape(issue.message)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      ${renderWallMountReadiness(deps.project().settings, deps.project().bindings)}
      ${report ? `<div data-wall-placement-result role="status"><p class="caption"><strong>${report.unchanged ? '추가 배치 없음' : !report.addedSingles && !report.addedModules ? '배관 갱신 완료' : `개별 부착물 ${report.addedSingles}개 · 연결 부품 ${report.addedModules}개 추가`}</strong> · 현재 연결 구간 ${currentRunCount}개</p><p class="caption">추가한 임시 부착물 ${wallResult!.placeholders}개 · 실제 프리팹 ${wallResult!.real}개</p><p class="caption">현재 맵의 엘보·T자 연결부 ${wallJunctionCount()}개</p>${report.issues.length ? `<ul>${report.issues.map(issue => `<li>${escape(issue.message)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      <details class="feature-group" open><summary>벽 부착물 직접 설치</summary><label class="field"><span>벽등·문 조명·개별 부착 프리팹</span><select data-d-control="wall-binding" ${disabled()}><option value="">벽 부착 에셋 선택</option>${bindings.map(binding => `<option value="${escape(binding.id)}" ${binding.id === wallBindingId ? 'selected' : ''}>${escape(binding.label)}</option>`).join('')}</select></label><button data-d-action="insert-wall-fixture" class="full" ${!deps.selected() || !wallBindingId || deps.busy() ? 'disabled' : ''}>선택 벽·문에 부착물 설치</button><p class="caption">벽, 벽에 인접한 바닥 또는 문을 선택하세요. 에셋의 설치 위치·높이와 실제 크기를 검사합니다. 연속 부품은 자동 배치로 조립합니다.</p></details>`;
  }
  function renderInspector() {
    const r = selection(), map = deps.project().map, fixture = map.fixtures?.find(f => f.id === chosenFixture), marker = map.markers?.find(m => m.id === chosenMarker);
    const options = (value: string, items: [string, string][]) => items.map(([v, l]) => `<option value="${escape(v)}" ${v === value ? 'selected' : ''}>${escape(l)}</option>`).join('');
    const objectEdit = (item: NonNullable<typeof fixture> | NonNullable<typeof marker>, prefix: string) => `<div class="pair">${number(`${prefix}:x`, '셀 X', item.x, 0, map.width - 1, 1)}${number(`${prefix}:row`, '셀 행', item.row, 0, map.height - 1, 1)}</div><label class="field"><span>방향</span><select data-d-control="${prefix}:direction" ${disabled()}>${options(String(item.direction), [0, 90, 180, 270].map(n => [String(n), `${n}°`]))}</select></label><div class="transform-fields">${(['x', 'y', 'z'] as const).map(axis => number(`${prefix}:offset.${axis}`, `보정 ${axis.toUpperCase()} (m)`, item.offset[axis], -100, 100, .1)).join('')}</div>`;
    return `<p class="eyebrow">DESIGNER TOOLS</p><h2>영역과 배치물</h2><p class="caption">격자에서 Shift + 클릭하거나 영역 크기를 입력하세요.</p>${renderStructureTools()}${renderDesignReport()}${renderWallTools()}
      <details class="feature-group" open><summary>영역 편집 ${r ? `· ${r.width} × ${r.height}` : ''}</summary>${r ? `<div class="pair">${number('area-width', '선택 가로', r.width, 1, map.width - r.x, 1)}${number('area-height', '선택 세로', r.height, 1, map.height - r.row, 1)}</div><div class="tool-buttons"><button data-d-action="copy" ${disabled()}>영역 복사</button><button data-d-action="paste" ${!clipboard || deps.busy() ? 'disabled' : ''}>선택 셀에 붙이기</button><button data-d-action="rotate" ${disabled()}>회전 ${rotation * 90}°</button><button data-d-action="mirror-x" aria-pressed="${mirrorX}">좌우 대칭 ${mirrorX ? '✓' : ''}</button><button data-d-action="mirror-z" aria-pressed="${mirrorZ}">상하 대칭 ${mirrorZ ? '✓' : ''}</button><button data-d-action="lock" ${disabled()}>영역 잠금</button><button data-d-action="unlock" ${disabled()}>잠금 해제</button></div>${number('tool-height', '일괄 적용 높이 (m)', toolHeight, -100, MAX_WALL_HEIGHT)}<div class="tool-buttons"><button data-d-action="area-floor" ${disabled()}>바닥 높이</button><button data-d-action="area-ceiling" ${disabled()}>평천장 높이</button><button data-d-action="area-wall" ${disabled()}>벽 높이</button><button data-d-action="area-open" ${disabled()}>천장 뚫기</button><button data-d-action="area-cliff" ${disabled()}>절벽면 만들기</button></div><label class="field"><span>구역 용도</span><select data-d-control="zone" ${disabled()}>${options(zone, [['combat', '전투'], ['reward', '보상'], ['rest', '휴식']])}</select></label><div class="tool-buttons"><button data-d-action="zone" ${disabled()}>용도 칠하기</button><button data-d-action="clear-zone" ${disabled()}>용도 지우기</button></div><button data-d-action="regenerate" class="secondary full" ${disabled()}>선택 영역만 AI 재생성</button>` : '<p class="caption">먼저 맵의 셀을 선택해 주세요.</p>'}</details>
      <details class="feature-group" open><summary>천장과 조명 보정</summary><button data-d-action="fill-pit-ceilings" class="full" ${disabled()}>낭떠러지 위 천장 메우기</button><button data-d-action="regenerate-lights" class="full" ${disabled()}>현재 맵 조명 다시 배치</button><p class="caption">천장 메우기는 최고 바닥 기준의 자동 높이를 사용합니다. 조명 재배치는 왼쪽 설치 방식과 밀도를 사용하며 잠긴 셀을 유지합니다.</p></details><details class="feature-group" open><summary>조명 · 구조물 · 배치물 선택</summary><label class="field"><span>배치할 종류</span><select data-d-control="fixture-role" ${disabled()}>${options(fixtureRole, fixtureRoles.map(f => [f.role, f.label]))}</select></label><label class="field"><span>부착 기준</span><select data-d-control="fixture-anchor" ${disabled()}>${options(fixtureAnchor, [['floor', '바닥'], ['wall', '벽면'], ['ceiling', '천장 아랫면']])}</select></label><button data-d-action="add-fixture" class="full" ${!deps.selected() || deps.busy() ? 'disabled' : ''}>선택 셀에 설치</button>
      <div class="object-list">${(map.fixtures ?? []).map(f => `<button data-d-action="select-fixture" data-id="${f.id}" class="${f.id === chosenFixture ? 'selected' : ''}">${escape(f.wall?.placeholder ? wallPlaceholderLabel(f.wall.placeholder) : f.wall ? deps.project().bindings.find(b => b.id === f.bindingId)?.label ?? label(f.role) : label(f.role))} · ${f.x}, ${f.row}</button>`).join('')}</div>
      ${fixture?.wall ? renderWallFixtureEditor(fixture, deps.project().bindings, deps.busy() || fixture.wall.support.some(isLocked), map, wallBulkBindingId) : fixture ? `<label class="field"><span>사용할 프리팹</span><select data-d-control="fixture:bindingId" ${disabled()}><option value="">역할별 자동 선택</option>${options(fixture.bindingId ?? '', fixtureBindings(deps.project().bindings, fixture).map(b => [b.id, b.label]))}</select></label><label class="field"><span>연결할 배치물</span><select data-d-control="fixture:linkedId" ${disabled()}><option value="">연결 없음</option>${options(fixture.linkedId ?? '', (map.fixtures ?? []).filter(f => f.id !== fixture.id).map(f => [f.id, `${label(f.role)} · ${f.x}, ${f.row}`]))}</select></label><label class="field"><span>부착 기준</span><select data-d-control="fixture:anchor" ${disabled()}>${options(fixture.anchor ?? 'floor', [['floor', '바닥'], ['wall', '벽면'], ['ceiling', '천장']])}</select></label>${objectEdit(fixture, 'fixture')}<button data-d-action="delete-fixture" class="danger full" ${disabled()}>배치물 제거</button>` : ''}<p class="caption">조명은 원본 프리팹의 빛 설정을 사용합니다. 에셋 연결 전에는 설치 위치로 표시됩니다.</p></details>
      <details class="feature-group" open><summary>게임 지점</summary><label class="field"><span>지점 종류</span><select data-d-control="marker-kind" ${disabled()}>${options(markerKind, [['enemy', '몬스터'], ['reward', '보상'], ['event', '이벤트']])}</select></label><button data-d-action="add-marker" class="full" ${!deps.selected() || deps.busy() ? 'disabled' : ''}>선택 셀에 지점 추가</button><div class="object-list">${(map.markers ?? []).map(m => `<button data-d-action="select-marker" data-id="${m.id}" class="${m.id === chosenMarker ? 'selected' : ''}">${escape(m.label)} · ${m.x}, ${m.row}</button>`).join('')}</div>
      ${marker ? `<label class="field"><span>표시 이름</span><input data-d-control="marker:label" maxlength="80" value="${escape(marker.label)}" ${disabled()}></label><label class="field"><span>게임 연결 키</span><input data-d-control="marker:contentKey" maxlength="120" value="${escape(marker.contentKey)}" placeholder="예: boss_01 또는 gate_A" ${disabled()}></label>${objectEdit(marker, 'marker')}<button data-d-action="delete-marker" class="danger full" ${disabled()}>지점 제거</button>` : ''}<p class="caption">지점의 종류·이름·연결 키를 Unity로 내보냅니다. 게임 동작은 Unity에서 연결합니다.</p></details>
      <details class="feature-group"><summary>내 제작 템플릿</summary><input data-d-control="template-name" maxlength="60" value="${escape(templateName)}" placeholder="템플릿 이름"><button data-d-action="save-template" class="full" ${disabled()}>조건 · 에셋 · 선택 영역 저장</button><select data-d-control="template-choice"><option value="">저장한 템플릿</option>${Object.keys(templates()).map(name => `<option ${name === selectedTemplate ? 'selected' : ''} value="${escape(name)}">${escape(name)}</option>`).join('')}</select><div class="tool-buttons"><button data-d-action="load-template" ${!selectedTemplate || deps.busy() ? 'disabled' : ''}>불러오기</button><button data-d-action="delete-template" ${!selectedTemplate || deps.busy() ? 'disabled' : ''}>삭제</button></div><p class="caption">이 PC에 보관합니다. 영역은 붙여넣기로 배치하며 GUID가 같은 Unity 에셋을 연결해 주세요.</p></details>
      <details class="feature-group" open><summary>두 맵 연결 확인</summary><button data-d-action="compare-open" class="full" ${disabled()}>비교할 맵 열기</button>${comparison ? `<p class="caption">${escape(comparison.map.name)}</p><label class="field"><span>현재 맵 연결문</span><select data-d-control="port-a">${options(portA, map.connections.map(c => [c.id, c.label]))}</select></label><label class="field"><span>비교 맵 연결문</span><select data-d-control="port-b">${options(portB, comparison.map.connections.map(c => [c.id, c.label]))}</select></label><p class="caption">${comparisonResult().issues.map(i => escape(i.message)).join('<br>') || '연결 규격이 호환됩니다. 실제 메시 충돌은 Unity에서 확인하세요.'}</p><button data-d-action="compare-close">비교 닫기</button>` : ''}</details>`;
  }
  function comparisonResult() {
    try { if (!comparison) return { issues: [] }; return compareModules(deps.project().map, portA, comparison.map, portB); }
    catch (e) { return { issues: [{ severity: 'error' as const, message: e instanceof Error ? e.message : String(e) }] }; }
  }
  function ensureLockedBindingsUnchanged(before: ProjectFile, after: ProjectFile) {
    const signature = (binding: AssetBinding | undefined) => binding ? JSON.stringify([binding.id, binding.role, binding.prefabGuid, binding.prefabPath,
      binding.scale.x, binding.scale.y, binding.scale.z, binding.offset.x, binding.offset.y, binding.offset.z, binding.rotationY, binding.stairNativeRise ?? 1, binding.lightAnchor ?? null, binding.bounds ?? null, binding.wallMount ?? null]) : '';
    const assertSame = (oldBinding: AssetBinding | undefined, newBinding: AssetBinding | undefined) => {
      if (signature(oldBinding) !== signature(newBinding)) throw new Error('이 템플릿은 잠긴 셀의 에셋 또는 배치 설정을 바꿉니다. 먼저 해당 셀의 잠금을 해제해 주세요.');
    };
    for (const cell of before.map.lockedCells ?? []) for (const role of ASSET_ROLES) {
      if (cellHasRole(before.map, cell.x, cell.row, role)) assertSame(resolveBinding(before.map, before.bindings, cell.x, cell.row, role),
        resolveBinding(after.map, after.bindings, cell.x, cell.row, role));
    }
    const fixtureBinding = (project: ProjectFile, fixture: MapFixture) => resolveFixtureBinding(project.map, project.bindings, fixture);
    for (const fixture of before.map.fixtures ?? []) if (isLocked(fixture) || fixture.wall?.support.some(isLocked)) {
      const next = after.map.fixtures?.find(item => item.id === fixture.id);
      assertSame(fixtureBinding(before, fixture), next ? fixtureBinding(after, next) : undefined);
      if (fixture.bindingId !== next?.bindingId) throw new Error('이 템플릿은 잠긴 배치물의 프리팹 지정을 바꿉니다. 먼저 잠금을 해제해 주세요.');
    }
  }
  async function click(button: HTMLElement): Promise<boolean> {
    const action = button.dataset.dAction; if (!action) return false;
    if (deps.busy()) return true;
    try {
      const map = deps.project().map;
      if (action.startsWith('view-')) { if (action === 'view-ceiling') showCeilings = !showCeilings; if (action === 'view-deadzone') showDeadzone = !showDeadzone; if (action === 'view-design') showDesign = !showDesign; if (action === 'view-fixtures') showFixtures = !showFixtures; if (action === 'view-markers') showMarkers = !showMarkers; if (action === 'view-character') showCharacter = !showCharacter; deps.render(); return true; }
      if (action === 'adopt-auto-ceiling' || action === 'fill-structures') {
        const s = structureSettings();
        const result = action === 'adopt-auto-ceiling' ? configureStructures(map, s)
          : synchronizeStructures({ ...structuredClone(map), version: 5, structureSettings: s });
        deps.commit(() => { deps.project().map = result; });
        deps.notify(action === 'adopt-auto-ceiling' ? '잠금 해제된 천장·벽을 최고 바닥 기준 자동 추종으로 맞췄습니다.' : '문·단차·낭떠러지 구조를 마감했습니다. 기존 수동 높이를 유지했습니다.');
      }
      else if (action === 'design-issue') {
        const issue = designReport()?.issues[Number(button.dataset.id)];
        if (issue?.cells?.length) { area = null; origin = { x: issue.cells[0].x, row: issue.cells[0].row }; deps.select(origin); showDesign = true; }
      }
      else if (action === 'design-obstacle') {
        const obstacle = designReport()?.obstacleChoices[Number(button.dataset.id)];
        if (obstacle?.cells.length) { area = null; origin = { ...obstacle.cells[0] }; deps.select(origin); showDesign = true; }
      }
      else if (action === 'fill-pit-ceilings') {
        if (!map.ceilings?.length) throw new Error('먼저 방에 천장을 추가하세요. 최고 바닥 기준으로 낭떠러지를 덮습니다.');
        const existing = new Set(map.ceilings.map(c => `${c.x},${c.row}`));
        const missing = ceilingEligibleCells(map).filter(c => map.rows[c.row][c.x] === '_' && !existing.has(`${c.x},${c.row}`) && !isLocked(c));
        if (!missing.length) { deps.notify('메울 수 있는 낭떠러지 천장이 없습니다. 잠금 상태도 확인해 주세요.'); return true; }
        const s = structureSettings(), undersideY = automaticCeilingY(map, s.ceilingClearance);
        deps.commit(() => { map.version = 5; map.structureSettings = s; map.ceilings!.push(...missing.map(c => ({ ...c, undersideY, heightMode: 'auto' as const }))); deps.project().map = synchronizeStructures(map); });
        showCeilings = true; deps.notify(`낭떠러지 ${missing.length}셀 위에 천장을 이어 만들었습니다.`);
      }
      else if (action === 'regenerate-lights') {
        const nextSettings = { ...deps.project().settings, designer: { ...settings(), lights: true } };
        const result = reapplyLighting(map, nextSettings, undefined, deps.project().bindings);
        deps.commit(() => { deps.project().map = result; deps.project().settings = nextSettings; });
        showFixtures = true; deps.notify('조명을 방 전체의 천장·벽에 분산 배치했습니다. 잠긴 조명은 유지했습니다.');
      }
      else if (action === 'place-wall-mounts') {
        const result = placeWallMounts(map, { ...deps.project().settings, designer: { ...settings(), wallMounts: { ...DEFAULT_WALL_SETTINGS, ...settings().wallMounts, enabled: true } } }, deps.project().bindings);
        const additions = (result.map.fixtures ?? []).filter(fixture => fixture.wall && !map.fixtures?.some(old => old.id === fixture.id));
        const placeholders = additions.filter(fixture => fixture.wall?.placeholder).length, real = additions.length - placeholders;
        if (!result.unchanged) deps.commit(() => { deps.project().map = result.map; });
        wallReapplyResult = undefined; wallResult = { map: deps.project().map, result, placeholders, real }; showFixtures = true;
        deps.notify(result.unchanged ? '추가할 수 있는 벽 부착물이 없습니다. 배치 결과에서 크기·연결 부품·공간을 확인하세요.' : !result.addedSingles && !result.addedModules ? `배관 연결을 갱신했습니다. 현재 엘보·T자 연결부 ${wallJunctionCount()}개입니다.` : `벽 부착물 ${result.addedSingles}개와 연결 부품 ${result.addedModules}개를 추가했습니다. 임시 ${placeholders}개 · 실제 프리팹 ${real}개 · 엘보·T자 연결부 ${wallJunctionCount()}개`);
      }
      else if (action === 'reapply-wall-runs') {
        const result = reapplyWallRuns(map, { ...deps.project().settings, designer: { ...settings(), wallMounts: { ...DEFAULT_WALL_SETTINGS, ...settings().wallMounts } } }, deps.project().bindings);
        if (!result.unchanged) deps.commit(() => { deps.project().map = result.map; });
        wallResult = undefined; wallReapplyResult = { map: deps.project().map, result }; showFixtures = true;
        if (chosenFixture && !deps.project().map.fixtures?.some(f => f.id === chosenFixture)) chosenFixture = '';
        deps.notify(result.unchanged ? result.reason ? result.issues[0]?.message ?? '현재 설정으로 재배치할 자동 배관이 없습니다.' : '현재 설정이 이미 적용되어 있습니다.' : `자동 배관 ${result.regeneratedRuns}구간 재배치 · ${result.preservedRuns}구간 보존 · ${result.skippedRuns}구간 제외. 한 번의 되돌리기로 복원할 수 있습니다.`);
      }
      else if (action === 'insert-wall-fixture') {
        const cell = deps.selected(); if (!cell || !wallBindingId) return true;
        const result = insertWallMount(map, cell, wallBindingId, deps.project().bindings);
        const added = result.fixtures?.find(item => !map.fixtures?.some(old => old.id === item.id));
        deps.commit(() => { deps.project().map = result; }); if (added) chosenFixture = added.id;
        showFixtures = true; deps.notify('실제 크기와 부착 위치를 검사해 설치했습니다.');
      }
      else if (action === 'replace-wall-placeholders') {
        const kind = map.fixtures?.find(fixture => fixture.id === chosenFixture)?.wall?.placeholder;
        if (!kind || !wallBulkBindingId) throw new Error('교체할 임시 부착물과 실제 프리팹을 선택해 주세요.');
        const result = replaceWallPlaceholders(map, kind, wallBulkBindingId, deps.project().bindings);
        if (result.replaced) deps.commit(() => { deps.project().map = result.map; });
        deps.notify(`${wallPlaceholderLabel(kind)} ${result.replaced}개를 실제 프리팹으로 교체했습니다. 한 번의 되돌리기로 복원할 수 있습니다.`);
      }
      else if (action === 'delete-wall-fixture' || action === 'detach-wall-fixture') {
        const result = editWallMount(map, chosenFixture, action === 'delete-wall-fixture' ? { remove: true } : { detach: true }, deps.project().bindings);
        deps.commit(() => { deps.project().map = result; }); if (action === 'delete-wall-fixture') chosenFixture = '';
        deps.notify(action === 'delete-wall-fixture' ? '벽 부착물을 제거하고 남은 연결 구간을 검사했습니다.' : '부품을 연결 구간에서 분리했습니다.');
      }
      else if (action === 'copy') { const r = selection(); if (!r) throw new Error('복사할 영역을 선택해 주세요.'); clipboard = captureRegion(map, r); deps.notify('영역을 복사했습니다. 붙일 셀과 회전·대칭을 선택하세요.'); }
      else if (action === 'rotate') rotation = ((rotation + 1) % 4) as typeof rotation;
      else if (action === 'mirror-x') mirrorX = !mirrorX;
      else if (action === 'mirror-z') mirrorZ = !mirrorZ;
      else if (action === 'paste') { if (!clipboard || !deps.selected()) return true; const result = pasteRegion(map, clipboard, deps.selected()!, { rotate90: rotation, mirrorX, mirrorZ }); deps.commit(() => { deps.project().map = result; }); }
      else if (action === 'lock' || action === 'unlock') { const targets = cells(); deps.commit(() => { const remaining = (map.lockedCells ?? []).filter(c => !targets.some(t => t.x === c.x && t.row === c.row)); map.lockedCells = action === 'lock' ? [...remaining, ...targets] : remaining; }); }
      else if (action.startsWith('area-') || action === 'zone' || action === 'clear-zone') {
        const targets = editableCells(), has = (c: Cell) => targets.some(t => t.x === c.x && t.row === c.row);
        if (!targets.length) throw new Error('선택 영역이 잠겨 있습니다. 먼저 잠금을 해제해 주세요.');
        if (action === 'area-floor' && map.connections.some(port => { const footprint = connectionCells(map,port); return footprint.some(has) && !footprint.every(has); })) throw new Error('연결문 전체를 선택하고 잠금을 해제한 뒤 높이를 바꿔 주세요.');
        if (action === 'area-floor' && (toolHeight < -100 || toolHeight > 100)) throw new Error('바닥 높이는 −100~100m입니다.');
        if (action === 'area-wall' && (toolHeight < .25 || toolHeight > MAX_WALL_HEIGHT)) throw new Error(`벽 높이는 0.25~${MAX_WALL_HEIGHT}m입니다.`);
        deps.commit(() => {
          if (action === 'area-ceiling' || action === 'area-wall') map.version = 5;
          if (action === 'area-floor') targets.forEach(c => { if (map.rows[c.row][c.x] !== '_') map.elevations[c.row][c.x] = toolHeight; });
          if (action === 'area-ceiling' || action === 'area-open') map.ceilings = [...(map.ceilings ?? []).filter(c => !has(c)), ...(action === 'area-ceiling' ? ceilingEligibleCells(map).filter(has).map(c => ({ ...c, undersideY: toolHeight, heightMode: 'manual' as const })) : [])];
          if (action === 'area-open') map.assetOverrides = map.assetOverrides.filter(o => o.role !== 'ceiling' || !has(o));
          if (action === 'area-wall') map.wallHeights = [...(map.wallHeights ?? []).filter(c => !has(c)), ...targets.filter(c => map.rows[c.row][c.x] === '#').map(c => ({ ...c, height: toolHeight, heightMode: 'manual' as const }))];
          if (action === 'area-cliff') map.cliffs = [...(map.cliffs ?? []).filter(c => !has(c)), ...exposedCliffFaces(map, settings().cliffDepth).filter(has)];
          if (action === 'zone' || action === 'clear-zone') map.zones = [...(map.zones ?? []).filter(c => !has(c)), ...(action === 'zone' ? targets.filter(c => '.DRB'.includes(map.rows[c.row][c.x])).map(c => ({ ...c, kind: zone })) : [])];
        });
      } else if (action === 'add-cell-ceiling' || action === 'remove-cell-ceiling') {
        const c = deps.selected(); if (!c) return true; if (isLocked(c)) throw new Error('잠긴 셀입니다.');
        if (action === 'add-cell-ceiling' && !ceilingEligibleCells(map).some(t => t.x === c.x && t.row === c.row)) throw new Error('방 내부 바닥 또는 낭떠러지 위에 천장을 설치하세요.');
        const manual = pendingCeiling?.x === c.x && pendingCeiling?.row === c.row, s = structureSettings();
        const y = manual ? pendingCeiling!.y : automaticCeilingY(map, s.ceilingClearance);
        if (!Number.isFinite(y) || Math.abs(y) > MAX_CEILING_Y) throw new Error('천장 높이를 확인하세요.');
        deps.commit(() => { map.version = 5; map.structureSettings = s; map.ceilings = (map.ceilings ?? []).filter(t => t.x !== c.x || t.row !== c.row); if (action === 'add-cell-ceiling') map.ceilings.push({ ...c, undersideY: y, heightMode: manual ? 'manual' : 'auto' }); else map.assetOverrides = map.assetOverrides.filter(o => o.role !== 'ceiling' || o.x !== c.x || o.row !== c.row); deps.project().map = synchronizeStructures(map); });
        pendingCeiling = null;
      } else if (action === 'add-fixture' || action === 'add-marker') {
        const c = deps.selected(); if (!c) return true; if (isLocked(c)) throw new Error('잠긴 셀입니다.');
        const tile = map.rows[c.row][c.x]; if ((action === 'add-marker' && !'.DB'.includes(tile)) || (action === 'add-fixture' && fixtureAnchor === 'floor' && !'.DPB'.includes(tile)) || (action === 'add-fixture' && fixtureAnchor === 'wall' && tile !== '#')) throw new Error('통행 가능한 바닥을 선택해 주세요.');
        if (action === 'add-fixture' && fixtureAnchor === 'ceiling' && !map.ceilings?.some(t => t.x === c.x && t.row === c.row)) throw new Error('천장에 부착하려면 해당 셀에 천장이 필요합니다.');
        deps.commit(() => {
          if (action === 'add-fixture') { chosenFixture = `fixture_${crypto.randomUUID()}`; (map.fixtures ??= []).push({ id: chosenFixture, role: fixtureRole, ...c, direction: fixtureAnchor === 'wall' ? Number(Object.entries(DIRECTIONS).find(([, [dx,dr]]) => '.DPRB'.includes(map.rows[c.row+dr]?.[c.x+dx] ?? '_'))?.[0] ?? 0) as MapFixture['direction'] : 0, offset: { x: 0, y: 0, z: 0 }, anchor: fixtureAnchor }); }
          else { chosenMarker = `marker_${crypto.randomUUID()}`; (map.markers ??= []).push({ id: chosenMarker, label: `${{ enemy: '몬스터', reward: '보상', event: '이벤트' }[markerKind]} 지점`, kind: markerKind, contentKey: '', ...c, direction: 0, offset: { x: 0, y: 0, z: 0 } }); }
        });
      } else if (action === 'select-fixture' || action === 'select-marker') { const item = action === 'select-fixture' ? map.fixtures?.find(f => f.id === button.dataset.id) : map.markers?.find(f => f.id === button.dataset.id); if (item) { if (action === 'select-fixture') { chosenFixture = item.id; wallBulkBindingId = ''; } else chosenMarker = item.id; area = null; origin = { x: item.x, row: item.row }; deps.select(item); } }
      else if (action === 'delete-fixture' || action === 'delete-marker') {
        const item = action === 'delete-fixture' ? map.fixtures?.find(f => f.id === chosenFixture) : map.markers?.find(f => f.id === chosenMarker);
        if (!item) return true;
        if (action === 'delete-fixture' && 'wall' in item && item.wall) { const result = editWallMount(map, item.id, { remove: true }, deps.project().bindings); deps.commit(() => { deps.project().map = result; }); chosenFixture = ''; deps.render(); return true; }
        if (isLocked(item)) throw new Error('잠긴 셀입니다.');
        if (action === 'delete-fixture' && map.fixtures?.some(f => f.linkedId === chosenFixture && isLocked(f))) throw new Error('잠긴 배치물이 이 시설을 참조하고 있습니다. 참조 배치물의 잠금을 먼저 해제해 주세요.');
        deps.commit(() => {
          if (action === 'delete-fixture') {
            map.fixtures = (map.fixtures ?? []).filter(f => f.id !== chosenFixture).map(f => {
              if (f.linkedId !== chosenFixture) return f;
              const next = { ...f }; delete next.linkedId; return next;
            });
          } else map.markers = (map.markers ?? []).filter(f => f.id !== chosenMarker);
        });
      }
      else if (action === 'regenerate') await deps.regenerate();
      else if (action === 'compare-open') { const loaded = await deps.openComparison(); if (loaded) { comparison = loaded; portA = map.connections[0]?.id ?? ''; portB = loaded.map.connections[0]?.id ?? ''; } }
      else if (action === 'compare-close') comparison = null;
      else if (action === 'save-template') { const name = templateName.trim(); if (!name || name.length > 60 || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('템플릿 이름을 입력해 주세요.'); const saved = templates(); saved[name] = { settings: structuredClone(deps.project().settings), bindings: structuredClone(deps.project().bindings), ...(selection() ? { region: captureRegion(map, selection()!) } : {}) }; localStorage.setItem(storageKey, JSON.stringify(saved)); selectedTemplate = name; deps.notify('제작 템플릿을 이 PC에 저장했습니다.'); }
      else if (action === 'load-template') {
        const saved = templates()[selectedTemplate]; if (!saved) return true;
        const keepBinding = (id: string, role: AssetRole) => Array.isArray(saved.bindings) && saved.bindings.some(binding => binding.id === id && binding.role === role);
        const checked = parseProjectFile({ ...deps.project(), settings: saved.settings, bindings: saved.bindings, map: {
          ...map, assetOverrides: map.assetOverrides.filter(item => keepBinding(item.bindingId, item.role)),
          fixtures: map.fixtures?.map(fixture => {
            const next = { ...fixture };
            if (next.bindingId && !keepBinding(next.bindingId, next.role)) delete next.bindingId;
            return next;
          }),
        } });
        ensureLockedBindingsUnchanged(deps.project(), checked);
        deps.commit(() => { deps.project().settings = checked.settings; deps.project().bindings = checked.bindings; deps.project().map = checked.map; clipboard = saved.region ?? null; });
        deps.notify('조건과 에셋을 불러왔습니다. 저장한 영역은 붙여넣기로 배치하세요.');
      }
      else if (action === 'delete-template') { const saved = templates(); delete saved[selectedTemplate]; localStorage.setItem(storageKey, JSON.stringify(saved)); selectedTemplate = ''; }
      deps.render();
    } catch (e) { deps.notify(e instanceof Error ? e.message : String(e), true); deps.render(); }
    return true;
  }
  function change(input: HTMLInputElement): boolean {
    const key = input.dataset.dControl, feature = input.dataset.dFeature;
    if (!key && !feature) return false; if (deps.busy()) return true;
    try {
      const map = deps.project().map;
      if (key === 'wall-bulk-binding') { wallBulkBindingId = input.value; deps.render(); return true; }
      if (key?.startsWith('wall-setting:')) {
        const field = key.slice(13), d = settings();
        let wallMounts = { ...DEFAULT_WALL_SETTINGS, ...d.wallMounts };
        if (['enabled', 'singles', 'runs', 'placeholderFallback', 'connectRuns'].includes(field)) wallMounts[field as 'enabled' | 'singles' | 'runs' | 'placeholderFallback' | 'connectRuns'] = input.checked;
        else if (field === 'runOrientation') { if (!['horizontal', 'vertical', 'both'].includes(input.value)) throw new Error('배관의 가로·세로 배치 방향을 확인하세요.'); wallMounts.runOrientation = input.value as 'horizontal' | 'vertical' | 'both'; }
        else if (field === 'density' || field === 'runDensity') { const value = Number(input.value); if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('벽 부착물 밀도는 1~100%의 정수로 입력하세요.'); wallMounts[field] = value; }
        else wallMounts = handleWallHeightSetting(wallMounts, field, input.value);
        const checked = parseGenerationSettings({ ...deps.project().settings, designer: { ...d, wallMounts } });
        deps.commit(() => { deps.project().settings = checked; }); return true;
      }
      if (key?.startsWith('wall-edit:')) {
        const field = key.slice(10);
        if (!['height', 'along', 'distance', 'bindingId'].includes(field)) throw new Error('벽 부착물 편집 항목을 확인하세요.');
        if (field === 'bindingId' && !input.value) return true;
        const result = editWallMount(map, chosenFixture, field === 'bindingId' ? { bindingId: input.value } : { [field]: Number(input.value) }, deps.project().bindings);
        deps.commit(() => { deps.project().map = result; }); return true;
      }
      if (feature || key === 'preset' || key === 'light-placement' || key === 'prop-layout' || key === 'pit-default' || key === 'gap-default' || key?.startsWith('setting:')) {
        const d = settings();
        if (key === 'light-placement') d.lightPlacement = input.value as DesignerSettings['lightPlacement'];
        if (key === 'prop-layout') d.propLayout = input.value as NonNullable<DesignerSettings['propLayout']>;
        if (key === 'pit-default') d.pitBottomKind = input.value as DesignerSettings['pitBottomKind'];
        if (key === 'gap-default') d.gapRole = input.value as DesignerSettings['gapRole'];
        if (feature) (d as unknown as Record<string, unknown>)[feature] = input.checked;
        if (key?.startsWith('setting:')) (d as unknown as Record<string, unknown>)[key.slice(8)] = Number(input.value);
        if (key === 'preset') { const { propLayout, propCoverage, wallMounts } = d; Object.assign(d, DESIGNER_PRESETS[input.value as keyof typeof DESIGNER_PRESETS], { propLayout, propCoverage, wallMounts }); }
        const checked = parseGenerationSettings({ ...deps.project().settings, designer: d, ...(key === 'preset' ? { connectionCount: input.value === 'battle' ? 4 : 1 } : {}) });
        deps.commit(() => { deps.project().settings = checked; }); return true;
      }
      if (key === 'current-clearance') {
        const value = Number(input.value); if (!Number.isFinite(value) || value < .25 || value > 20) throw new Error('최고 바닥 위 여유 높이는 0.25~20m입니다.');
        const result = synchronizeStructures({ ...structuredClone(map), version: 5, structureSettings: { ...structureSettings(), ceilingClearance: value } });
        deps.commit(() => { deps.project().map = result; });
      }
      else if (key === 'ceiling-mode' || key === 'wall-mode') {
        const c = deps.selected(); if (!c) return true; if (isLocked(c)) throw new Error('잠긴 셀입니다.');
        if (!['auto', 'manual'].includes(input.value)) throw new Error('자동 또는 수동 높이를 선택하세요.');
        const result = structuredClone(map); result.version = 5; result.structureSettings = structureSettings();
        if (key === 'ceiling-mode') { const ceiling = result.ceilings?.find(t => t.x === c.x && t.row === c.row); if (ceiling) ceiling.heightMode = input.value as 'auto' | 'manual'; }
        else { const existing = result.wallHeights?.find(t => t.x === c.x && t.row === c.row); if (existing) existing.heightMode = input.value as 'auto' | 'manual'; else if (result.rows[c.row][c.x] === '#') (result.wallHeights ??= []).push({ ...c, height: settings().wallHeight, heightMode: input.value as 'auto' | 'manual' }); }
        const updated = synchronizeStructures(result); deps.commit(() => { deps.project().map = updated; });
      }
      else if (key === 'pit-kind' || key === 'pit-y' || key === 'pit-thickness') {
        const c = deps.selected(); if (!c) return true;
        if (key === 'pit-kind' && !['floor', 'deadzone'].includes(input.value)) throw new Error('데드존 또는 마감 바닥을 선택하세요.');
        const result = setPitBottom(map, c, key === 'pit-kind' ? { kind: input.value as 'floor' | 'deadzone' } : key === 'pit-y' ? { y: Number(input.value) } : { thickness: Number(input.value) });
        deps.commit(() => { deps.project().map = result; });
      }
      else if (key === 'fixture-role') { fixtureRole = input.value as FixtureRole; fixtureAnchor = fixtureRole === 'light' ? (map.ceilings?.length ? 'ceiling' : 'wall') : 'floor'; }
      else if (key === 'fixture-anchor') fixtureAnchor = input.value as typeof fixtureAnchor;
      else if (key === 'wall-binding') wallBindingId = input.value;
      else if (key === 'marker-kind') markerKind = input.value as typeof markerKind;
      else if (key === 'tool-height') { const n = Number(input.value); if (!Number.isFinite(n) || n < -100 || n > MAX_WALL_HEIGHT) throw new Error(`높이는 −100~${MAX_WALL_HEIGHT}m입니다.`); toolHeight = n; }
      else if (key === 'zone') zone = input.value as typeof zone;
      else if (key === 'template-name') templateName = input.value;
      else if (key === 'template-choice') selectedTemplate = input.value;
      else if (key === 'port-a') portA = input.value;
      else if (key === 'port-b') portB = input.value;
      else if (key === 'area-width' || key === 'area-height') { const r = selection(); if (!r) return true; const n = Number(input.value), max = key === 'area-width' ? map.width - r.x : map.height - r.row; if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('선택 크기가 맵 범위를 벗어났습니다.'); area = { ...r, [key === 'area-width' ? 'width' : 'height']: n }; }
      else if (key?.startsWith('fixture:') || key?.startsWith('marker:')) {
        const [prefix, field] = key.split(':'), item = prefix === 'fixture' ? map.fixtures?.find(f => f.id === chosenFixture) : map.markers?.find(m => m.id === chosenMarker);
        if (!item) return true; if (isLocked(item)) throw new Error('잠긴 셀입니다.');
        if (prefix === 'fixture' && 'wall' in item && item.wall) throw new Error('벽 부착물 전용 편집에서 높이·위치·프리팹을 변경하세요.');
        const next = structuredClone(item) as typeof item & { bindingId?: string; linkedId?: string; anchor?: string; label?: string; contentKey?: string };
        if (field === 'bindingId' || field === 'linkedId') { if (input.value) next[field] = input.value; else delete next[field]; }
        else if (field === 'anchor') { next.anchor = input.value; if (prefix === 'fixture' && next.bindingId && !fixtureBindings(deps.project().bindings, next as MapFixture).some(b => b.id === next.bindingId)) delete next.bindingId; }
        else if (field === 'label' || field === 'contentKey') { const v = input.value.trim(); if ((!v && field === 'label') || /[\u0000-\u001f]/.test(v)) throw new Error('표시 이름과 연결 키를 확인하세요.'); next[field] = v; }
        else { const v = Number(input.value); if (!Number.isFinite(v) || Math.abs(v) > 10000) throw new Error('유효한 숫자를 입력해 주세요.'); if (field === 'x' || field === 'row') { if (!Number.isInteger(v) || v < 0 || v >= (field === 'x' ? map.width : map.height)) throw new Error('맵 안의 셀 좌표를 입력하세요.'); next[field] = v; } else if (field === 'direction') { if (![0,90,180,270].includes(v)) throw new Error('방향을 확인하세요.'); next.direction = v as MapFixture['direction']; } else if (field.startsWith('offset.')) next.offset[field.slice(7) as 'x'|'y'|'z'] = v; }
        if (isLocked(next)) throw new Error('이동할 셀이 잠겨 있습니다.');
        deps.commit(() => { Object.assign(item, next); if (!next.bindingId && 'bindingId' in item) delete (item as MapFixture).bindingId; if (!next.linkedId && 'linkedId' in item) delete (item as MapFixture).linkedId; });
      } else {
        const c = deps.selected(); if (!c) return true; if (isLocked(c)) throw new Error('잠긴 셀입니다.');
        const n = Number(input.value);
        if (key === 'ceiling-y' && !map.ceilings?.some(t => t.x === c.x && t.row === c.row)) { if (!Number.isFinite(n) || Math.abs(n) > MAX_CEILING_Y) throw new Error(`천장 높이는 −${MAX_CEILING_Y}~${MAX_CEILING_Y}m입니다.`); pendingCeiling = { ...c, y:n }; deps.render(); return true; }
        if (key !== 'ramp-kind' && (!Number.isFinite(n) || n < -MAX_CEILING_Y || n > (key === 'bridge-direction' ? 270 : MAX_WALL_HEIGHT))) throw new Error('높이 또는 방향을 확인하세요.');
        deps.commit(() => {
          if (key === 'ceiling-y') { const existing = map.ceilings?.find(t => t.x === c.x && t.row === c.row); if (existing) { map.version = 5; existing.undersideY = n; existing.heightMode = 'manual'; } }
          if (key === 'wall-height') { if (n < .25 || n > MAX_WALL_HEIGHT) throw new Error(`벽 높이는 0.25~${MAX_WALL_HEIGHT}m 범위입니다.`); map.version = 5; map.wallHeights = [...(map.wallHeights ?? []).filter(t => t.x !== c.x || t.row !== c.row), { ...c, height: n, heightMode: 'manual' }]; }
          if (key === 'ramp-kind') { const ramp = map.ramps.find(t => t.x === c.x && t.row === c.row); if (ramp) { ramp.kind = input.value as 'stair'|'slope'; map.assetOverrides = map.assetOverrides.filter(o => o.x !== c.x || o.row !== c.row || !['stair','slope'].includes(o.role)); } }
          if (key === 'bridge-direction') { const bridge = map.bridges?.find(t => t.x === c.x && t.row === c.row); if (bridge) bridge.direction = n as MapFixture['direction']; }
        });
      }
      deps.render();
    } catch (e) { deps.notify(e instanceof Error ? e.message : String(e), true); deps.render(); }
    return true;
  }
  return {
    renderGeneration, renderToolbar, renderInspector, renderCellExtras, renderWallTools, click, change, selection, isLocked,
    pick(cell: Cell, extend = false) { if (extend && origin) area = { x: Math.min(cell.x, origin.x), row: Math.min(cell.row, origin.row), width: Math.abs(cell.x - origin.x) + 1, height: Math.abs(cell.row - origin.row) + 1 }; else { origin = { ...cell }; area = null; } },
    selectFixture(id: string) { chosenFixture = id; wallBulkBindingId = ''; }, selectMarker(id: string) { chosenMarker = id; },
    reset() { area = null; origin = null; chosenFixture = ''; chosenMarker = ''; comparison = null; clipboard = null; pendingCeiling = null; wallBindingId = ''; wallBulkBindingId = ''; wallResult = undefined; wallReapplyResult = undefined; },
    previewOptions() { const result = comparisonResult(); return { showCeilings, showDeadzone, showFixtures, showMarkers, showCharacter, ...(showDesign ? { designReport: designReport() } : {}), characterHeight: settings().headroom, selectedFixture: chosenFixture, selectedMarker: chosenMarker, ...(comparison && 'transform' in result && result.transform ? { comparison: { map: comparison.map, bindings:comparison.bindings, transform: result.transform } } : {}) }; },
  };
}
