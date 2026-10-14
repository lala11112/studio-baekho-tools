import './style.css';
import './connections.css';
import './designer.css';
import './variants.css';
import { createVariantGallery } from './variants';
import { generateVariants, variantSettings, type MapVariant } from './shared/variants';
import { createDesigner, EXTRA_ROLES } from './designer';
import { DEFAULT_DESIGNER, applyGeneratedFeatures, generationConditionIssues } from './shared/features';
import { mergeGeneratedRegion } from './shared/editing';
import { defaultAssetScale, matchesScaleScope, scaleAssets, type ScaleScope } from './shared/asset-scaling';
import { buildManifest, createDemoMap, DEFAULT_SETTINGS, FLOOR_THICKNESS_RATIO, MAX_BINDINGS, resolveBinding, validateMap, parseProjectFile, cellHasRole, connectionAt, connectionCells, maximumConnectionWidth, updateConnectionGeometry } from './shared/map';
import type { AssetBinding, AssetRole, CodexStatus, GridMap, MapConnection, PrefabAsset, ProjectFile, Tile } from './shared/types';
import { mountPreview, type PreviewState } from './preview';
import { applyRoomPreset, resolveGenerationSettings, setCustomRoomSize } from './shared/room-presets';
import { renderGenerationControls, updateGenerationControl } from './generation-controls';
import { renderPropLibraryFields, handlePropField } from './prop-library';
import { suggestPropDefinition, snapshotPropCatalog, applyPropBoundsCatalog, propValidationIssues, assertWholeProps, replacePropInstance, insertPropInstance, removePropInstance } from './shared/props';
import { synchronizeStructures } from './shared/structures';
import { analyzeLevelDesign } from './shared/level-design';

const api = window.baekho;
const root = document.querySelector<HTMLDivElement>('#app')!;
let project: ProjectFile = { formatVersion: 1, map: createDemoMap(), settings: applyRoomPreset(DEFAULT_SETTINGS,'medium'), bindings: [] };
let assets: PrefabAsset[] = [];
let projectPath = '';
let view: '3d' | 'grid' | 'image' | 'variants' = '3d';
let variantCount = 3;
let candidates: MapVariant[] = [];
const savedCandidateIds = new Set<string>();
let brush: Tile = '.';
let editMode: 'select' | 'paint' | 'height' = 'select';
let brushHeight = 0;
let selected: { x: number; row: number } | null = null;
let rightTab: 'cell' | 'assets' | 'connections' | 'design' = 'cell';
let newAssetRole: AssetRole = 'floor', newAssetGuid = '';
let bulkScope: ScaleScope = 'tiles', bulkMode: 'set' | 'multiply' = 'set';
const bulkAxes = { x: '2', y: '', z: '2' };
let busy = false, isSample = true, dirty = false;
let codex: CodexStatus = { state: 'missing', message: '설치된 Codex 연결을 확인하고 있습니다.', models: [] };
let codexChecking = false, codexDialogOpen = false, loginPending = false;
let loginDeadline = 0;
let loginTimer: ReturnType<typeof setTimeout> | undefined;
let status = '샘플 맵을 둘러보거나 새 AI 설계도를 생성하세요.';
let statusError = false;
let preview: ReturnType<typeof mountPreview> | undefined;
let previewState: PreviewState | undefined;
type EditSnapshot = Pick<ProjectFile, 'map' | 'bindings' | 'settings' | 'blueprintDataUrl' | 'generationDraft'>;
const history: EditSnapshot[] = [], future: EditSnapshot[] = [];
const roles: { role: AssetRole; label: string; symbol: string; note: string }[] = [
  { role: 'floor', label: '바닥', symbol: '▱', note: '통행 셀 아래 배치' },
  { role: 'wall', label: '벽', symbol: '▥', note: '한 셀을 채우는 벽 블록' },
  { role: 'door', label: '문', symbol: 'Π', note: '기본 통과 방향 +Z' },
  { role: 'prop', label: '소품', symbol: '◇', note: '통행을 막는 장식' },
  { role: 'stair', label: '계단', symbol: '▤', note: '+Z 방향으로 오르는 계단. 오름폭과 프리팹 크기를 맞추세요' },
  ...EXTRA_ROLES,
];
const colors: Record<Tile, string> = { _: '#e9ece4', '.': '#cdd4c2', '#': '#647662', D: '#c5a46d', P: '#ba896b', R:'#937aa4', B:'#b58b56' };
const tileLabels: Record<Tile, string> = { '.': '바닥', '#': '벽', D: '문', P: '소품', R:'계단', B:'다리', _: '지우기' };
const directions = [{ value:0, label:'↑ 북쪽 / +Z', arrow:'↑', dx:0, dr:-1 }, { value:90, label:'→ 동쪽 / +X', arrow:'→', dx:1, dr:0 }, { value:180, label:'↓ 남쪽 / −Z', arrow:'↓', dx:0, dr:1 }, { value:270, label:'← 서쪽 / −X', arrow:'←', dx:-1, dr:0 }] as const;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const snapshot = (): EditSnapshot => structuredClone({ map: project.map, bindings: project.bindings, settings: project.settings, blueprintDataUrl: project.blueprintDataUrl, generationDraft: project.generationDraft });
const disabled = () => busy ? 'disabled' : '';
let generationCancelled = false;
let recovery: ProjectFile | null = null;
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
const detailState = new Map<string, boolean>();
function detailKey(detail: HTMLDetailsElement) {
  const scope = detail.closest<HTMLElement>('[data-asset-card]')?.dataset.assetCard ?? (detail.closest('.left-panel') ? 'create' : `inspect:${rightTab}`);
  return `${scope}:${detail.querySelector('summary')?.firstChild?.textContent?.split('·')[0].trim()}`;
}
const designer = createDesigner({
  project: () => project, selected: () => selected, busy: () => busy, render, notify,
  select: cell => { selected = { x: cell.x, row: cell.row }; rightTab = 'design'; },
  commit: edit => {
    const before = snapshot();
    try { edit(); project.map=synchronizeStructures(project.map);const propErrors=propValidationIssues(project.map).filter(i=>i.severity==='error');if(propErrors.length)throw new Error(propErrors[0].message); project = parseProjectFile(project); history.push(before); if (history.length > 50) history.shift(); future.length = 0; dirty = true; queueRecovery(); render(); }
    catch (e) { Object.assign(project, before); throw e; }
  },
  openComparison: async () => { const result = await requireDesktop().openComparisonProject(); if (result) view = '3d'; return result; },
  regenerate: () => runGeneration('region'),
});
const gallery = createVariantGallery({
  busy: () => busy, render,
  apply: candidate => {
    if (busy || candidate.status !== 'ready' || !candidate.project) return;
    try {
      const checked = parseProjectFile(structuredClone(candidate.project));
      markHistory(); project = checked; isSample = false; selected = null; designer.reset(); previewState = undefined; view = '3d';
      notify(`${candidate.label}를 편집 화면에 적용했습니다. 되돌리기로 이전 맵을 복원할 수 있습니다.`); render();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  },
  save: async selectedCandidates => {
    if (busy) return;
    await task(async () => {
      const chosen = selectedCandidates.filter(candidate => candidate.status === 'ready' && candidate.project);
      if (!chosen.length) throw new Error('저장할 후보를 먼저 체크하세요.');
      const path = await requireDesktop().saveProjects(chosen.map(candidate => structuredClone(candidate.project!)));
      if (path) {
        chosen.forEach(candidate => savedCandidateIds.add(candidate.id));
        notify(`${chosen.length}개 후보 저장 완료: ${path} — 압축을 풀면 각 맵을 프로젝트로 열 수 있습니다.`);
      } else notify('후보 저장을 취소했습니다. 선택한 후보는 그대로 남아 있습니다.');
    }, '선택한 맵 후보를 묶어 저장합니다…');
  },
});
function queueRecovery() {
  if (!api || !dirty) return;
  clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => { void api.saveRecovery(structuredClone(project)).catch(error => notify(`자동 복구 저장 실패: ${String(error)}`, true)); }, 1200);
}
async function runGeneration(mode: 'all' | 'region' | 'image' | 'extract') {
  if (busy) return;
  if (codex.state !== 'ready') { openCodexDialog(); return; }
  const region = mode === 'region' ? designer.selection() : mode === 'extract' ? project.generationDraft?.region ?? null : null;
  if (mode === 'region' && !region) { notify('다시 만들 영역을 먼저 선택하세요.', true); return; }
  if (!region && project.map.lockedCells?.length) { notify('보호한 영역이 있습니다. 선택 영역 재생성을 사용하거나 잠금을 해제하세요.', true); return; }
  generationCancelled = false;
  await task(async () => {
    let settings = structuredClone(mode === 'extract' && project.generationDraft ? project.generationDraft.settings : project.settings);
    if(mode!=='extract'&&!region)settings=resolveGenerationSettings({...settings,sizeResolved:false});
    const catalog=structuredClone(mode==='extract'&&project.generationDraft?.catalog?project.generationDraft.catalog:snapshotPropCatalog(project.bindings));
    if (region) {
      settings.width = project.map.width; settings.height = project.map.height;
      settings.cellSize = project.map.cellSize; settings.maxStepHeight = project.map.maxStepHeight;
      settings.connectionCount = project.map.connections.length;
      settings.sizeMode='custom';settings.sizeResolved=true;
      assertWholeProps(project.map,region);
      const within = (c: { x: number; row: number }) => c.x >= region.x && c.x < region.x + region.width && c.row >= region.row && c.row < region.row + region.height;
      const zones = (project.map.zones ?? []).filter(within);
      const heightRows = project.map.elevations.map(values => {
        const runs: { value: number; count: number }[] = [];
        for (const value of values) { const last = runs.at(-1); if (last?.value === value) last.count++; else runs.push({ value, count: 1 }); }
        return runs.map(run => run.count === 1 ? String(run.value) : `${run.value}*${run.count}`).join(',');
      });
      const context = {
        region, rows: project.map.rows, heightRows,
        ramps: project.map.ramps.map(r => [r.x, r.row, r.direction, r.rise]),
        bridges: project.map.bridges?.map(b => [b.x, b.row, b.direction]),
        connections: project.map.connections,
        lockedCells: project.map.lockedCells?.filter(within), zones,
      };
      settings.prompt = `${settings.prompt.split('[BAEKHO REGION CONTEXT]')[0].trim()}\n[BAEKHO REGION CONTEXT]\nRevise only the unlocked selected region; preserve all outside cells and external doors. Reconnect every region boundary to the unchanged map. heightRows use comma-separated heights with value*count run lengths. Ramp tuples are [x,row,direction,rise]; bridge tuples are [x,row,direction]. Use zone coordinates to guide the area purpose. Never create corridors. Current map: ${JSON.stringify(context)}`;
      if (settings.prompt.length > 6000) throw new Error('현재 맵 정보와 설명이 부분 재생성 한도를 넘습니다. 맵 설명을 줄이거나 영역 복사·높이 도구로 편집해 주세요.');
    }
    let image = mode === 'extract' ? (project.generationDraft?.imageDataUrl ?? project.blueprintDataUrl) : undefined;
    if (!image) {
      notify('1/3 · 선택한 조건으로 설계도를 생성하고 있습니다…');
      image = await requireDesktop().generateImage(settings, region ?? undefined,catalog);
      if (generationCancelled) return;
      project.generationDraft = { imageDataUrl: image, settings: structuredClone(settings), catalog:structuredClone(catalog), ...(region ? { region: { ...region } } : {}) };
      dirty = true; queueRecovery();
    }
    if (mode === 'image') { view = 'image'; notify('설계도 초안을 만들었습니다. 배치 만들기로 이어서 진행할 수 있습니다.'); return; }
    if (generationCancelled) return;
    notify('2/3 · 설계도에서 지형과 연결을 분석하고 있습니다…');
    const candidate = await requireDesktop().extractLayout(settings, image, region ?? undefined,catalog);
    if (generationCancelled) return;
    notify('3/3 · 생성 조건과 이동 경로를 확인하고 있습니다…');
    const result = region ? mergeGeneratedRegion(project.map, candidate, region, merged => applyGeneratedFeatures(merged, settings, region,catalog)) : candidate;
    const errors = [...validateMap(result), ...(region ? generationConditionIssues(result, settings, region) : []),...(settings.levelDesign?analyzeLevelDesign(result,settings).issues:[])].filter(i => i.severity === 'error');
    if (errors.length) throw new Error(errors.slice(0, 3).map(i => i.message).join(' '));
    markHistory(); project.map = result;
    if (!region) {project.blueprintDataUrl = image; project.settings=settings;}
    delete project.generationDraft;
    isSample = false; selected = null; designer.reset(); view = '3d';
    notify(region ? '선택 영역을 다시 만들었습니다. 보호 영역과 외부 연결문을 유지했습니다.' : '맵을 생성했습니다. 천장·조명·게임 지점을 확인하고 에셋을 연결하세요.');
  }, '맵 생성을 준비하고 있습니다…');
}

async function runVariantGeneration() {
  if (busy) return;
  if (codex.state !== 'ready') { openCodexDialog(); return; }
  // Validate the snapshot and requests before replacing an earlier gallery or starting AI work.
  let source: ProjectFile;
  try {
    source = parseProjectFile(structuredClone(project));
    for (let index = 0; index < variantCount; index++) variantSettings(source.settings, index, variantCount);
  }
  catch (error) { notify(error instanceof Error ? error.message : String(error), true); return; }
  if (candidates.some(candidate => candidate.status === 'ready' && !savedCandidateIds.has(candidate.id))) {
    const dialog = document.querySelector<HTMLDialogElement>('#replace-variants-dialog')!;
    dialog.returnValue = 'cancel';
    const answer = new Promise<boolean>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'replace'), { once: true }));
    dialog.showModal();
    if (!await answer || busy) return;
  }
  generationCancelled = false; savedCandidateIds.clear(); view = 'variants';
  await task(async () => {
    const desktop = requireDesktop();
    candidates = await generateVariants(source, variantCount, {
      generateImage: (settings,catalog) => desktop.generateImage(settings,undefined,catalog),
      extractLayout: (settings, image,catalog) => desktop.extractLayout(settings, image,undefined,catalog),
      isCancelled: () => generationCancelled,
      onUpdate: updated => {
        candidates = updated; gallery.setCandidates(candidates);
        const ready = candidates.filter(candidate => candidate.status === 'ready').length;
        const current = candidates.find(candidate => candidate.status === 'image' || candidate.status === 'extract');
        notify(current ? `후보 ${current.index + 1}/${variantCount} · ${current.status === 'image' ? '설계도 생성' : '배치 분석'} 중… · ${ready}개 완성` : `후보 ${ready}/${variantCount}개 완성`);
        render();
      },
    });
    gallery.setCandidates(candidates);
    const ready = candidates.filter(candidate => candidate.status === 'ready').length;
    const failed = candidates.filter(candidate => candidate.status === 'error').length;
    notify(`${generationCancelled ? '생성을 취소했습니다. ' : ''}${ready}개 후보 완성${failed ? ` · ${failed}개 실패` : ''}. ${ready ? '마음에 드는 후보를 체크하고 선택한 맵을 저장하세요.' : '후보별 안내를 확인해 주세요.'}`, !ready);
  }, `${variantCount}개 맵 후보 생성을 준비합니다…`);
}

function codexLabel() { return codexChecking ? 'Codex 확인 중…' : codex.state === 'ready' ? 'Codex 연결됨' : 'Codex 연결'; }
function codexModelOptions() { return codex.models.map(model => `<option value="${escape(model.id)}">${escape(model.name)}${model.isDefault ? ' · 기본' : ''}</option>`).join(''); }
function renderCodexDialog() {
  return `<h2>Codex 연결</h2><p>이 컴퓨터의 Codex와 ChatGPT 로그인을 사용해 설계도를 생성하고 분석합니다.</p><div class="codex-connection ${codex.state === 'ready' ? 'connected' : ''}"><strong>${codexChecking ? '<span class="spinner"></span> 연결 확인 중' : codex.state === 'ready' ? '✓ ChatGPT 계정 연결됨' : '연결 설정'}</strong><p id="codex-status" role="status">${escape(codex.message)}</p>${codex.version ? `<small>${escape(codex.version)}</small>` : ''}</div>${loginPending ? '<p class="caption">브라우저에서 로그인을 마치면 자동으로 연결 상태를 확인합니다.</p>' : ''}<p class="caption">Codex가 설치되어 있어야 합니다. 자동으로 찾지 못하면 codex.exe를 선택하세요. 생성에는 인터넷 연결이 필요하며, 계정의 Codex 사용 한도가 적용됩니다.</p><div class="row codex-actions"><button data-action="codex-select" ${codexChecking || loginPending ? 'disabled' : ''}>실행 파일 선택</button><button data-action="codex-refresh" ${codexChecking ? 'disabled' : ''}>새로고침</button>${codex.state !== 'ready' ? `<button class="primary" data-action="codex-login" ${codexChecking || loginPending || codex.state === 'missing' ? 'disabled' : ''}>ChatGPT 로그인</button>` : ''}<button data-action="close-codex">닫기</button></div>`;
}
function updateCodexControls() {
  const button = document.querySelector<HTMLButtonElement>('[data-action="codex"]');
  if (button) button.innerHTML = `<span class="status-dot" style="background:${codex.state === 'ready' ? '#638a58' : '#bb9871'}"></span>${codexLabel()}`;
  const dialog = document.querySelector('#codex-dialog');
  if (dialog) dialog.innerHTML = renderCodexDialog();
  const models = document.querySelector('#codex-models');
  if (models) models.innerHTML = codexModelOptions();
}
function closeCodexDialog() {
  codexDialogOpen = false;
  clearTimeout(loginTimer);
  document.querySelector<HTMLDialogElement>('#codex-dialog')?.close();
}
async function refreshCodex(selectExecutable = false) {
  if (codexChecking) return;
  codexChecking = true; updateCodexControls();
  try { codex = await (selectExecutable ? requireDesktop().selectCodexExecutable() : requireDesktop().getCodexStatus()); }
  catch (error) { codex = { state: 'error', message: error instanceof Error ? error.message : String(error), models: [] }; }
  finally {
    codexChecking = false;
    if (codex.state === 'ready') loginPending = false;
    if (loginPending && Date.now() >= loginDeadline) { loginPending = false; codex.message = '로그인 대기 시간이 지났습니다. 브라우저에서 로그인을 마쳤다면 새로고침해 주세요.'; }
    updateCodexControls();
    clearTimeout(loginTimer);
    if (loginPending && codexDialogOpen) loginTimer = setTimeout(() => { void refreshCodex(); }, 3000);
  }
}
function openCodexDialog() {
  codexDialogOpen = true;
  document.querySelector<HTMLDialogElement>('#codex-dialog')!.showModal();
  void refreshCodex();
}

function markHistory() { history.push(snapshot()); if (history.length > 50) history.shift(); future.length = 0; dirty = true; queueRecovery(); }
function editMap(edit:()=>void) {
  const before=snapshot();
  try { edit(); project.map=synchronizeStructures(project.map); const errors=propValidationIssues(project.map,project.bindings).filter(i=>i.severity==='error'); if(errors.length)throw new Error(errors.map(i=>i.message).join(' ')); history.push(before); if(history.length>50)history.shift(); future.length=0;dirty=true;queueRecovery(); }
  catch(error){Object.assign(project,before);notify(error instanceof Error?error.message:String(error),true);}
  render();
}
function notify(message: string, error = false) {
  status = message; statusError = error;
  const element = document.querySelector('#status');
  if (element) element.textContent = message;
  document.querySelector('.footer')?.classList.toggle('error', error);
}
function requireDesktop() { if (!api) throw new Error('파일과 AI 기능은 데스크톱 앱에서 사용할 수 있습니다. npm run dev로 실행해 주세요.'); return api; }
async function task(action: () => Promise<void>, message: string) {
  if (busy) return;
  busy = true; status = message; statusError = false; render();
  try { await action(); } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  finally { busy = false; queueRecovery(); render(); }
}
function bindingCard(binding: AssetBinding) {
  const { role, id } = binding;
  const info = roles.find(item => item.role === role)!;
  const options = assets.map(asset => `<option value="${escape(asset.guid)}" ${binding.prefabGuid === asset.guid ? 'selected' : ''}>${escape(asset.path.replace(/^Assets\//, ''))}</option>`).join('');
  const stale = !assets.some(a => a.guid === binding.prefabGuid) ? `<option value="${escape(binding.prefabGuid)}" selected>${escape(binding.prefabPath)} · 다시 연결 필요</option>` : '';
  const placementNote = role === 'light'
    ? '천장용 형광등과 벽용 발광 패널은 원본 루트 기준으로 배치합니다. 벽 패널의 +Z를 발광면으로 맞추세요. 밝기·발광 머티리얼은 원본 프리팹 설정을 사용합니다.'
    : role === 'floor'
    ? `기본 두께는 셀 간격의 12% (${Number((project.map.cellSize * FLOOR_THICKNESS_RATIO).toFixed(4))}m)이며 두께 배율 Y를 곱합니다. Unity에서 윗면을 셀 높이에 맞춥니다. X/Z는 원본에 적용할 절대 배율입니다.`
    : (role === 'stair' || role === 'slope')
      ? '프리팹 아랫면의 중심을 셀 바닥에 맞춥니다. Y 배율은 지정한 오름폭으로 계산하며 X/Z는 원본에 적용할 절대 배율입니다.'
      : 'Unity에서 아랫면을 셀 높이에 자동으로 맞춥니다. 배율은 원본에 적용할 절대 배율입니다.';
  return `<article class="asset-card" data-asset-card="${id}"><div class="asset-top"><span class="asset-icon">${info.symbol}</span><h3>${info.label}</h3><button class="quiet danger" data-action="remove-binding" data-id="${id}" ${disabled()}>삭제</button></div>
    <label class="field"><span>표시 이름</span><input data-binding-label="${id}" maxlength="80" value="${escape(binding.label)}" ${disabled()}></label>
    <select data-binding="${id}" aria-label="${escape(binding.label)} 프리팹" ${disabled()}>${stale}${options}</select>
    ${role === 'light' ? `<label class="field"><span>조명 사용 위치</span><select data-light-anchor="${id}" ${disabled()}><option value="" ${!binding.lightAnchor ? 'selected' : ''}>공용 · 기존 프리팹</option><option value="ceiling" ${binding.lightAnchor === 'ceiling' ? 'selected' : ''}>천장용 형광등</option><option value="wall" ${binding.lightAnchor === 'wall' ? 'selected' : ''}>벽용 발광 패널</option></select></label>` : ''}
    ${renderPropLibraryFields(binding,busy)}<details><summary>크기 · 기준점 조정</summary><p class="subtle">${info.note}. 셀 간격 ${project.map.cellSize}m. ${placementNote} Y 오프셋으로 배치 높이를 추가 조정합니다.</p>
    <div class="transform-fields">${(['scale', 'offset'] as const).map(group => (['x', 'y', 'z'] as const).map(axis => `<label>${group==='scale'&&axis==='y'&&role==='floor'?'두께 배율 Y':(role==='stair'||role==='slope')&&group==='scale'&&axis==='y'?'Y 배율 (자동)':`${group === 'scale' ? '배율' : '오프셋'} ${axis.toUpperCase()}`}<input type="number" step="0.1" data-transform="${id}:${group}:${axis}" value="${binding[group][axis]}" ${busy || ((role==='stair'||role==='slope')&&group==='scale'&&axis==='y')?'disabled':''}></label>`).join('')).join('')}<label class="wide">Y 회전 (도)<input type="number" step="90" data-rotation="${id}" value="${binding.rotationY}" ${disabled()}></label>${(role==='stair'||role==='slope')?`<label class="wide">원본 계단 오름폭 (Y 배율 1, m)<input data-stair-rise="${id}" type="number" min="0.001" max="1000" step="0.1" value="${binding.stairNativeRise??1}" ${disabled()}></label><p class="caption wide">원본 높이를 입력하면 각 계단의 Y 배율을 자동 계산합니다.</p>`:''}</div></details></article>`;
}
function renderBatchScale() {
  const count = project.bindings.filter(binding => matchesScaleScope(binding.role, bulkScope)).length;
  return `<details class="feature-group" open><summary>에셋 배율 일괄 조정<span>${count}개 대상</span></summary>
    <label class="field"><span>조정할 종류</span><select id="bulkScaleScope" ${disabled()}><option value="tiles" ${bulkScope === 'tiles' ? 'selected' : ''}>건축 타일 전체</option><option value="all" ${bulkScope === 'all' ? 'selected' : ''}>모든 에셋</option>${roles.map(r => `<option value="${r.role}" ${bulkScope === r.role ? 'selected' : ''}>${r.label}</option>`).join('')}</select></label>
    <label class="field"><span>적용 방식</span><select id="bulkScaleMode" ${disabled()}><option value="set" ${bulkMode === 'set' ? 'selected' : ''}>입력한 배율로 맞추기</option><option value="multiply" ${bulkMode === 'multiply' ? 'selected' : ''}>현재 배율에 곱하기</option></select></label>
    <div class="transform-fields">${(['x','y','z'] as const).map(axis => `<label>배율 ${axis.toUpperCase()}<input type="number" data-bulk-axis="${axis}" value="${bulkAxes[axis]}" min="0.001" max="10000" step="0.1" placeholder="유지" ${disabled()}></label>`).join('')}</div>
    <button data-action="bulk-scale" class="secondary full" ${!count || busy ? 'disabled' : ''}>${count}개 에셋에 적용</button>
    <button data-action="fit-cell-scale" class="full" ${!count || busy ? 'disabled' : ''}>1m 에셋 X/Z → ${project.map.cellSize}m 셀 맞춤</button>
    <p class="caption">빈 축은 유지합니다. 셀 맞춤은 원본 가로·깊이가 1m인 에셋 기준이며 Y를 유지합니다. 바닥·천장 Y는 두께 배율, 계단과 높이 맞춤 구조물의 Y는 자동 계산됩니다. 공유 에셋 설정이므로 잠긴 셀에도 적용됩니다. 되돌리기로 복원할 수 있습니다.</p></details>`;
}
function renderAssets() {
  return `<p class="eyebrow">ASSET LIBRARY</p><div class="panel-heading"><h2>사용할 에셋</h2><span class="step-num">${project.bindings.length}개</span></div><p class="panel-intro">필요한 만큼 추가하거나 삭제하세요.<br>같은 종류도 여러 프리팹을 등록할 수 있습니다.</p><button class="full" data-action="scan" ${disabled()}>＋ Unity 프로젝트 폴더 연결</button>
    <p class="asset-project" title="${escape(projectPath)}">${projectPath ? `${escape(projectPath.split(/[\\/]/).pop())} · 프리팹 ${assets.length}개` : '아직 연결된 프로젝트가 없습니다'}</p>
    <div class="asset-adder"><label class="field"><span>추가할 에셋의 종류</span><select id="newAssetRole" ${disabled()}>${roles.map(r=>`<option value="${r.role}" ${r.role===newAssetRole?'selected':''}>${r.label}</option>`).join('')}</select></label><label class="field"><span>프리팹</span><select id="newAssetGuid" ${busy || !assets.length?'disabled':''}><option value="">프리팹 선택</option>${assets.map(a=>`<option value="${a.guid}" ${a.guid===newAssetGuid?'selected':''}>${escape(a.path.replace(/^Assets\//,''))}</option>`).join('')}</select></label><button data-action="add-binding" class="secondary full" ${busy || !newAssetGuid || project.bindings.length>=MAX_BINDINGS?'disabled':''}>＋ 에셋 추가</button><p class="caption">최대 ${MAX_BINDINGS}개. 새 소품은 종류·테마·방 용도·크기로 검사하고 가중 선택합니다. 기존 셀 에셋의 순환 선택은 유지합니다.</p></div>
    <button data-action="import-prop-catalog" class="full" ${disabled()}>소품 크기 정보 가져오기</button><p class="caption">Unity에서 Assets → Baekho → Export Prop Bounds Catalog로 내보낸 JSON을 선택하세요. 종류와 배치 조건은 각 소품에서 수정할 수 있습니다. 크기가 없는 새 소품은 공간 검증 자동 배치에서 제외합니다.</p>${renderBatchScale()}<div class="asset-counts">${roles.map(r=>`${r.label} ${project.bindings.filter(b=>b.role===r.role).length}`).join(' · ')}</div>
    ${project.bindings.length ? project.bindings.map(bindingCard).join('') : '<p class="select-empty">등록한 에셋이 없습니다.<br>Unity 폴더 연결 후 위에서 추가하세요.</p>'}`;
}
function cellRoles(_tile: Tile, x = selected?.x, row = selected?.row): AssetRole[] {
  if (x === undefined || row === undefined) return [];
  return roles.map(item => item.role).filter(role => cellHasRole(project.map, x, row, role));
}
function renderCellAssets(x:number,row:number,tile:Tile) {
  const hasProp=project.map.propInstances?.some(p=>p.cells.some(c=>c.x===x&&c.row===row));
  return cellRoles(tile).filter(role=>!(hasProp&&role==='prop')).map(role=>{
    const override=project.map.assetOverrides.find(o=>o.x===x&&o.row===row&&o.role===role);
    const candidates=project.bindings.filter(b=>b.role===role);
    const effective=resolveBinding(project.map, project.bindings,x,row,role);
    return `<label class="field"><span>${roles.find(r=>r.role===role)!.label} 에셋</span><select data-cell-binding="${role}" ${disabled()}><option value="">자동 순환</option>${candidates.map(b=>`<option value="${b.id}" ${b.id===override?.bindingId?'selected':''}>${escape(b.label)}</option>`).join('')}</select><small>적용: ${effective?escape(effective.label):'해당 종류의 에셋을 등록하세요'}</small></label>`;
  }).join('');
}
function renderSelectedProp() {
  if(!selected)return '';
  const prop=project.map.propInstances?.find(p=>p.cells.some(c=>c.x===selected!.x&&c.row===selected!.row));
  const measured=project.bindings.filter(b=>(b.role==='prop'||b.role==='decoration')&&b.prop?.size);
  const choices=measured.map(b=>`<option value="${escape(b.id)}" ${prop?.bindingId===b.id?'selected':''}>${escape(b.label)} · ${escape(b.prop!.category)}</option>`).join('');
  if(prop){const binding=project.bindings.find(b=>b.id===prop.bindingId),locked=prop.cells.some(designer.isLocked);
    return `<div class="section-line"></div><h3>선택한 소품</h3><p><strong>${escape(binding?.label??prop.bindingId)}</strong> · ${escape(prop.category)}</p><p class="caption">점유 ${prop.size.x.toFixed(2)} × ${prop.size.y.toFixed(2)} × ${prop.size.z.toFixed(2)}m (X · Y · Z) / ${prop.cells.length}셀<br>${prop.blocksMovement?'통행 차단':'장식'} · ${prop.anchor==='ceiling'?'천장':prop.anchor==='wall'?'벽':'바닥'} 부착 · ID ${escape(prop.id)}</p>
      <label class="field"><span>프리팹 교체 · 전체 점유 영역을 다시 검사</span><select data-prop-instance-binding="${escape(prop.id)}" ${busy||locked?'disabled':''}>${measured.some(b=>b.id===prop.bindingId)?'':`<option value="${escape(prop.bindingId)}" selected>${escape(binding?.label??prop.bindingId)} · 크기 확인 필요</option>`}${choices}</select></label>
      <button data-action="refit-prop-instance" data-id="${escape(prop.id)}" class="secondary full" ${busy||locked||!binding?.prop?.size?'disabled':''}>현재 프리팹 다시 맞추기</button>
      <button data-action="remove-prop-instance" data-id="${escape(prop.id)}" class="danger full" ${busy||locked?'disabled':''}>이 소품 삭제 · 바닥 유지</button>`;
  }
  if(!'.P'.includes(project.map.rows[selected.row][selected.x]))return '';
  return `<div class="section-line"></div><h3>소품 직접 배치</h3><label class="field"><span>측정된 프리팹</span><select data-insert-prop ${busy||designer.isLocked(selected)?'disabled':''}><option value="">배치할 소품을 선택하세요</option>${choices}</select></label><p class="caption">크기·평탄한 바닥·천장·잠금·통행을 검사한 뒤 하나의 소품으로 배치합니다.${measured.length?'':' 먼저 에셋 탭에서 소품의 원본 크기를 등록하세요.'}</p>`;
}
function renderConnectionEditor() {
  if(!selected) return '';
  const {x,row}=selected, c=connectionAt(project.map,x,row);
  return `<div class="section-line"></div><h3>다른 맵과 잇는 문</h3>${c?`<p class="caption connection-id" title="${c.id}">${escape(c.id)}</p><label class="field"><span>연결문 이름</span><input data-connection="label" maxlength="80" value="${escape(c.label)}" ${disabled()}></label><label class="field"><span>맵 바깥을 향하는 방향</span><select data-connection="direction" ${disabled()}>${directions.map(d=>`<option value="${d.value}" ${d.value===c.direction?'selected':''}>${d.label}</option>`).join('')}</select></label><div class="pair"><label class="field"><span>문 폭 (m)</span><input data-connection="width" type="number" min="0.25" max="${maximumConnectionWidth(project.map,c)}" step="0.25" value="${c.width}" ${disabled()}></label><label class="field"><span>통과 높이 (m)</span><input data-connection="height" type="number" min="0.25" max="20" step="0.25" value="${c.height}" ${disabled()}></label></div><label class="field"><span>연결 종류</span><input data-connection="kind" maxlength="40" value="${escape(c.kind)}" ${disabled()}><small>예: default, cave, wide · 영문/숫자/_/-</small></label><p class="caption">연결 높이 Y=${project.map.elevations[row][x]}m. 위의 바닥 높이로 조절합니다. 화살표 반대쪽은 방 안의 통행 셀, 바깥쪽은 빈 공간이어야 합니다. 폭을 늘리면 옆 셀까지 열고 넓은 문 프리팹 하나를 폭에 맞춥니다. 1셀보다 넓은 문은 ${connectionCells(project.map,c).length}셀을 사용합니다. 가로 방향은 오른쪽, 세로 방향은 아래쪽으로 확장됩니다.</p><button data-action="remove-connection" data-id="${c.id}" class="danger full" ${disabled()}>연결 해제 · 1셀 문으로</button>`:`<p class="caption">방 외곽의 셀을 연결문으로 지정하세요. 시작·끝 구분 없이 여러 문을 만들 수 있습니다.</p><button data-action="add-connection" class="secondary full" ${busy||project.map.connections.length>=1600?'disabled':''}>＋ 이 셀을 연결문으로</button>`}`;
}
function renderConnections() {
  return `<p class="eyebrow">MAP CONNECTIONS</p><div class="panel-heading"><h2>맵 연결문</h2><span class="step-num">${project.map.connections.length}개</span></div><p class="panel-intro">다른 맵과 맞닿을 문과 연결점을 만드세요.<br>복도 없이 문 위치·방향·규격을 내보냅니다.</p><button class="full" data-action="connection-select" ${disabled()}>격자에서 셀 선택 → 연결문 추가</button><div class="connection-list">${project.map.connections.map(c=>`<button class="connection-entry" data-action="select-connection" data-id="${c.id}" ${disabled()}><strong>${directions.find(d=>d.value===c.direction)!.arrow} ${escape(c.label)}</strong><small>셀 ${c.x}, ${c.row} · Y ${project.map.elevations[c.row][c.x]}m · ${c.width} × ${c.height}m<br>${escape(c.kind)}</small></button>`).join('')||'<p class="caption">아직 연결문이 없습니다. 기존 프로젝트의 입구·출구는 바닥으로 전환됩니다. 외곽에 연결문을 지정해 주세요.</p>'}</div><p class="caption">문을 선택하면 이름·방향·폭·높이·종류를 수정할 수 있습니다. Unity 프리팹의 Connections 아래에 연결점이 저장됩니다.</p>`;
}
function renderCellInspector() {
  const cell = selected;
  const tile = cell ? project.map.rows[cell.row][cell.x] as Tile : null;
  const ramp = cell ? project.map.ramps.find(r => r.x === cell.x && r.row === cell.row) : null;
  return `<p class="eyebrow">DIRECT EDIT</p><div class="panel-heading"><h2>공간을 직접 다듬으세요</h2><span class="step-num">XYZ</span></div><p class="panel-intro">3D 또는 격자에서 셀을 선택하고<br>타일과 높이를 직접 수정할 수 있습니다.</p>
  ${cell ? `<div class="selected-coords"><strong>셀 ${cell.x}, ${cell.row}</strong><span>X ${((cell.x-(project.map.width-1)/2)*project.map.cellSize).toFixed(2)} / Y ${project.map.elevations[cell.row][cell.x].toFixed(2)} / Z ${(((project.map.height-1)/2-cell.row)*project.map.cellSize).toFixed(2)} m</span></div>
  <label class="field"><span>셀 종류</span><select id="selectedTile" ${disabled()}>${(Object.keys(tileLabels) as Tile[]).map(t => `<option value="${t}" ${tile===t?'selected':''}>${tileLabels[t]}</option>`).join('')}</select></label>
  <label class="field"><span>바닥 높이 Y (m)</span><input id="selectedHeight" type="number" min="-100" max="100" step="0.25" value="${project.map.elevations[cell.row][cell.x]}" ${disabled()}></label><div class="pair"><button data-action="lower" ${disabled()}>− ${project.settings.elevationStep}m</button><button data-action="raise" ${disabled()}>＋ ${project.settings.elevationStep}m</button></div>
  ${tile === 'R' ? `<div class="section-line"></div><label class="field"><span>계단 오르는 방향</span><select id="rampDirection" ${disabled()}><option value="0" ${ramp?.direction===0?'selected':''}>↑ 북쪽 / +Z</option><option value="90" ${ramp?.direction===90?'selected':''}>→ 동쪽 / +X</option><option value="180" ${ramp?.direction===180?'selected':''}>↓ 남쪽 / −Z</option><option value="270" ${ramp?.direction===270?'selected':''}>← 서쪽 / −X</option></select></label><label class="field"><span>계단 오름폭 (m)</span><input id="rampRise" type="number" min="0.25" max="10" step="0.25" value="${ramp?.rise ?? project.settings.elevationStep}" ${disabled()}></label><p class="caption">${project.map.elevations[cell.row][cell.x]}m에서 ${(project.map.elevations[cell.row][cell.x]+(ramp?.rise ?? project.settings.elevationStep))}m로 연결합니다. 양끝만 통행 연결로 인정합니다.</p>` : ''}` : '<div class="select-empty"><span>◇</span><p>맵에서 수정할 위치를 클릭하세요.<br>빈 셀에도 타일을 추가할 수 있습니다.</p></div>'}
  <label class="field"><span>현재 맵 셀 간격 (m)</span><input id="currentCellSize" type="number" min="0.25" max="10" step="0.25" value="${project.map.cellSize}" ${disabled()}><small>현재 맵의 가로·세로 간격을 즉시 수정</small></label>${renderSelectedProp()}${designer.renderCellExtras()}${renderConnectionEditor()}${cell&&tile&&cellRoles(tile,cell.x,cell.row).length?`<div class="section-line"></div><h3>이 셀의 에셋</h3>${renderCellAssets(cell.x,cell.row,tile)}`:''}
  <div class="section-line"></div><h3>높이 브러시</h3><p class="caption" style="margin:8px 0">여러 셀의 높이를 맞출 때는 격자에서 드래그하세요.</p><label class="field"><span>칠할 높이 Y (m)</span><input id="brushHeight" type="number" min="-100" max="100" step="0.25" value="${brushHeight}" ${disabled()}></label><button data-action="height-brush" class="full ${editMode==='height'?'secondary':''}" ${disabled()}>높이 칠하기</button><p class="caption" style="margin-top:10px">X / 좌우 · Y / 높이 · Z / 앞뒤<br>오른쪽 위 +Z는 격자 화면의 위쪽입니다.</p>
  <div class="section-line"></div><button data-action="assets-tab" class="full">사용할 에셋 (${project.bindings.length}개) →</button>`;
}
function replaceTile(x: number, row: number, tile: Tile) {
  if(project.map.propInstances?.some(p=>p.cells.some(c=>c.x===x&&c.row===row)))throw new Error('소품의 일부 셀을 바꿀 수 없습니다. 선택한 소품을 교체하거나 삭제하세요.');
  if (designer.isLocked({x,row})) { notify('잠긴 셀은 수정하지 않습니다.', true); return; }
  const opening = connectionAt(project.map,x,row);
  if (opening && opening.width > project.map.cellSize && tile !== 'D') { notify('넓은 연결문은 폭을 줄이거나 연결을 해제한 뒤 타일을 바꾸세요.', true); return; }
  const text = project.map.rows[row];
  project.map.rows[row] = text.slice(0,x) + tile + text.slice(x+1);
  if(tile!=='D') project.map.connections=project.map.connections.filter(c=>c.x!==x||c.row!==row);
  project.map.ramps = project.map.ramps.filter(r => r.x !== x || r.row !== row);
  if (tile === 'R') project.map.ramps.push({x,row,direction:0,rise:project.settings.elevationStep});
  project.map.bridges = (project.map.bridges ?? []).filter(b => b.x !== x || b.row !== row);
  if (tile === 'B') project.map.bridges.push({x,row,direction:0});
  if (tile !== '#') project.map.wallHeights = (project.map.wallHeights ?? []).filter(c => c.x !== x || c.row !== row);
  if (tile === '#') project.map.ceilings = (project.map.ceilings ?? []).filter(c => c.x !== x || c.row !== row);
  if (tile === '_') project.map.elevations[row][x] = 0;
  project.map.assetOverrides=project.map.assetOverrides.filter(o=>o.x!==x||o.row!==row||cellRoles(tile,x,row).includes(o.role));
}
function setSelectedHeight(value: number) {
  if (!selected) return;
  if (designer.isLocked(selected)) { notify('높이를 바꾸려면 셀 잠금을 해제하세요.', true); render(); return; }
  if (!Number.isFinite(value) || value < -100 || value > 100) { notify('높이는 −100~100m로 입력해 주세요.', true); render(); return; }
  const port = connectionAt(project.map, selected.x, selected.row);
  const targets = port ? connectionCells(project.map, port) : [selected];
  if (targets.some(designer.isLocked)) { notify('연결문에 잠긴 셀이 있습니다. 먼저 잠금을 해제하세요.', true); return; }
  editMap(()=>{for (const cell of targets) project.map.elevations[cell.row][cell.x] = value;});
}
function render() {
  document.querySelectorAll<HTMLDetailsElement>('.left-panel details,.right-panel details').forEach(detail => detailState.set(detailKey(detail), detail.open));
  gallery.dispose();
  if (preview) { previewState = preview.getState(); preview.dispose(); preview = undefined; }
  const map = project.map;
  const displayImage = project.generationDraft?.imageDataUrl ?? project.blueprintDataUrl;
  const issues = validateMap(map);
  const errors = issues.filter(i => i.severity === 'error');
  let exportIssue = '';
  try { buildManifest(map, project.bindings); } catch (e) { exportIssue = e instanceof Error ? e.message : String(e); }
  const occupied = map.rows.join('').replace(/_/g, '').length;
  const walkable = map.rows.join('').replace(/[^.DRB]/g, '').length;
  const surfaceHeights = map.elevations.flatMap((row,z) => row.filter((_height,x) => map.rows[z][x] !== '_'));
  const low = Math.min(0,...surfaceHeights), high = Math.max(0,...surfaceHeights,...map.ramps.map(r => map.elevations[r.row][r.x]+r.rise));
  if (selected && (selected.x >= map.width || selected.row >= map.height)) selected = null;
  root.innerHTML = `
    <header class="topbar"><div class="brand-mark">b</div><div class="brand">BAEKHO<small>WORLD BUILDING TOOLS</small></div><span class="top-divider"></span><span class="top-title">Map Forge <span class="pill">PREVIEW 0.5.1</span></span><span class="spacer"></span>
      <button data-action="open" ${disabled()}>↗ 프로젝트 열기</button><button data-action="save" ${busy || view === 'variants' ? 'disabled' : ''}>${dirty ? '● ' : ''}저장</button><button data-action="codex" ${disabled()}><span class="status-dot" style="background:${codex.state === 'ready' ? '#638a58' : '#bb9871'}"></span>${codexLabel()}</button>
    </header>
    ${recovery ? '<div class="recovery-note">이전 작업의 자동 복구 사본이 있습니다.<button data-action="recover">복구</button><button data-action="dismiss-recovery">닫기</button></div>' : ''}${!api ? '<div class="browser-note">브라우저 미리보기입니다. 파일 연결과 AI 생성은 데스크톱 앱에서 사용할 수 있습니다.</div>' : ''}
    <main class="main ${view === 'variants' ? 'variants-mode' : ''}">
      <aside class="left-panel"><p class="eyebrow">01 / CREATE</p><div class="panel-heading"><h2>어떤 공간을 만들까요?</h2><span class="step-num">3D</span></div><p class="panel-intro">서로 이어 붙일 입체 맵을 설계하세요.<br>여러 연결문과 높낮이를 함께 만듭니다.</p>
        ${renderGenerationControls(project.settings,busy)}${designer.renderGeneration()}<label class="field"><span>맵 컨셉</span><textarea id="prompt" maxlength="6000" ${disabled()}>${escape(project.settings.prompt)}</textarea></label>
        <div class="pair"><label class="field"><span>새 설계 가로 (셀)</span><input id="width" type="number" min="8" max="40" value="${project.settings.width}" ${disabled()}></label><label class="field"><span>새 설계 세로 (셀)</span><input id="height" type="number" min="8" max="40" value="${project.settings.height}" ${disabled()}></label></div>
        <label class="field"><span>새 생성 셀 간격 (m)</span><input id="cellSize" type="number" min="0.25" max="10" step="0.25" value="${project.settings.cellSize}" ${disabled()}><small>다음 생성에 적용 · 현재 맵 크기는 유지</small></label>
        <div class="pair"><label class="field"><span>기본 고저차 (m)</span><input id="elevationStep" type="number" min="0.25" max="10" step="0.25" value="${project.settings.elevationStep}" ${disabled()}></label><label class="field"><span>걸어넘을 단차 (m)</span><input id="maxStepHeight" type="number" min="0.05" max="1" step="0.05" value="${map.maxStepHeight}" ${disabled()}></label></div>
        <label class="field"><span>AI로 만들 연결문 개수</span><input id="connectionCount" type="number" min="1" max="16" value="${project.settings.connectionCount}" ${disabled()}><small>1~16개 · 실제 배치는 연결문 탭에서 추가·삭제</small></label>
        <details class="advanced"><summary>Codex 모델 설정</summary><label class="field"><span>Codex 모델 (선택)</span><input id="codexModel" list="codex-models" maxlength="100" placeholder="Codex 기본 모델 사용" value="${escape(project.settings.codexModel)}" ${disabled()}><datalist id="codex-models">${codexModelOptions()}</datalist></label><p class="caption">비워 두면 Codex 기본 모델을 사용합니다. 이미지 생성은 Codex의 내장 도구를 사용합니다.</p></details>
        <div class="left-actions"><button class="primary full" data-action="generate" ${disabled()}>${busy ? '<span class="spinner"></span>' : '✦ '}조건으로 맵 생성</button><details class="advanced"><summary>설계도 단계별 작업</summary><button class="full" data-action="generate-image" ${disabled()}>설계도만 생성</button><button class="secondary full" data-action="extract" ${busy || !displayImage ? 'disabled' : ''}>설계도 분석 → 배치 만들기</button></details>${busy ? '<button data-action="cancel" class="danger full">요청 취소</button>' : ''}</div>
        <div class="variant-create"><label class="field"><span>한 번에 비교할 맵 후보</span><select id="variantCount" ${disabled()}>${[2,3,4,5,6,7,8].map(count => `<option value="${count}" ${variantCount === count ? 'selected' : ''}>${count}개</option>`).join('')}</select></label><button class="secondary full" data-action="generate-variants" ${disabled()}>✦ 여러 후보 생성</button><p class="caption">같은 조건으로 방 형태와 배치를 다르게 만듭니다. 후보마다 이미지 생성과 분석을 순서대로 요청합니다. 현재 편집 맵은 유지됩니다.</p></div>
        <p class="generation-state">Codex가 이미지 생성과 배치 분석을 진행합니다.<br>높이와 계단을 포함해 통행 연결성을 검사합니다.</p>
        <div class="step-list"><span class="${project.blueprintDataUrl ? 'complete' : ''}">① 설계도</span><span>→</span><span class="${!isSample ? 'complete' : ''}">② 배치</span><span>→</span><span>③ 프리팹</span></div>
        <div class="section-line"></div><p class="eyebrow">QUICK START</p><p class="caption" style="margin:10px 0">Codex 연결 전에도 샘플 맵을 편집하고<br>에셋 연결과 내보내기를 확인할 수 있어요.</p><button data-action="demo" class="full" ${disabled()}>샘플 맵 불러오기</button>
      </aside>
      <section class="workspace"><div class="workspace-heading"><div><p class="eyebrow" style="margin-bottom:6px">MAP WORKSPACE</p><h1>작은 설계에서, 하나의 세계로.</h1></div><span class="spacer"></span></div>
        <div class="row ${view === 'variants' ? 'hide' : ''}" style="margin-bottom:8px"><input class="map-name" id="mapName" aria-label="맵 이름" maxlength="80" value="${escape(map.name)}" ${disabled()}><span class="pill">${isSample ? '샘플 · AI 생성 전' : '편집 중'}</span><span class="spacer"></span><small class="num">${map.width} × ${map.height}</small></div>
        <nav class="tabs" aria-label="맵 보기"><button class="tab ${view === '3d' ? 'active' : ''}" data-view="3d">◇ 3D 미리보기</button><button class="tab ${view === 'grid' ? 'active' : ''}" data-view="grid">▦ 배치 편집</button><button class="tab ${view === 'image' ? 'active' : ''}" data-view="image">▧ AI 설계도</button><button class="tab ${view === 'variants' ? 'active' : ''}" data-view="variants">후보 비교${candidates.length ? ` · ${candidates.filter(candidate => candidate.status === 'ready').length}/${candidates.length}` : ''}</button><span class="spacer"></span><button data-action="undo" title="되돌리기 (Ctrl+Z)" ${!history.length || busy || view === 'variants' ? 'disabled' : ''}>↶</button><button data-action="redo" title="다시 실행 (Ctrl+Shift+Z)" ${!future.length || busy || view === 'variants' ? 'disabled' : ''}>↷</button></nav>
        ${view === 'variants' ? '' : designer.renderToolbar()}<div class="viewport ${view === 'variants' ? 'variants-viewport' : ''}" id="viewport">${view === 'variants' ? gallery.render() : view === '3d' ? '<div class="preview-host" id="preview"></div><span class="view-badge">블록아웃 · Y 높이 · 실제 에셋은 Unity에서 적용</span><span class="view-hint">클릭 선택 · 드래그 회전 · 휠 확대 · 우클릭 이동</span><span class="view-tag">3D HEIGHT EDITOR</span>' : view === 'grid' ? `<span class="view-badge">${editMode==='select'?'셀 선택':editMode==='height'?`Y = ${brushHeight}m 높이 칠하기`:`${tileLabels[brush]} 배치`} · 숫자는 높이(m)</span><div class="orientation"><strong>↑</strong>+ Z</div><div class="map-svg-wrap"><svg class="map-svg" id="map-svg" role="img" aria-label="편집 가능한 맵 격자" viewBox="0 0 ${map.width} ${map.height}" preserveAspectRatio="xMidYMid meet"></svg></div><div class="brush-toolbar" aria-label="배치 도구"><button data-edit-mode="select" class="${editMode==='select'?'selected':''}">선택</button><button data-edit-mode="height" class="${editMode==='height'?'selected':''}">높이</button>${(Object.keys(tileLabels) as Tile[]).map(tile => `<button class="${editMode==='paint' && tile === brush ? 'selected' : ''}" data-brush="${tile}" title="${tileLabels[tile]}" ${disabled()}>${tileLabels[tile]}</button>`).join('')}</div>` : displayImage ? `<img class="blueprint" src="${escape(displayImage)}" alt="AI가 생성한 고저차 있는 입체 맵 설계도"><span class="view-badge">입체 설계도 · 높이와 계단을 포함해 분석</span>` : '<div class="empty-image"><span class="empty-symbol">▧</span><strong>Your next world starts here.</strong><p>왼쪽에서 높낮이와 맵 컨셉을 입력하고<br>AI 입체 설계도를 생성해 주세요.</p><span class="pill">입체 이미지 → 높이·계단 분석 → 에셋 조립</span></div>'}</div>
        <div class="legend ${view === 'variants' ? 'hide' : ''}">${(['.', '#', 'D', 'P', 'R', 'B'] as Tile[]).map(tile => `<span><i style="background:${colors[tile]}"></i>${tileLabels[tile]}</span>`).join('')}</div>
        <div class="metrics ${view === 'variants' ? 'hide' : ''}"><div class="metric"><span>맵 크기</span><strong class="num">${map.width * map.cellSize} × ${map.height * map.cellSize}<small> m</small></strong></div><div class="metric"><span>높이 범위</span><strong class="num">${low} ~ ${high}<small> m</small></strong></div><div class="metric"><span>통행 면적 / 배치 셀</span><strong class="num">${(walkable*map.cellSize*map.cellSize).toFixed(1)}<small> m² / ${occupied}</small></strong></div></div>
        <div class="bottom-note ${view === 'variants' ? 'hide' : ''}"><span>중앙 원점 · X 좌우 / Y 높이 / Z 앞뒤 · 계단 ${map.ramps.length}개 · 연결문 ${map.connections.length}개</span><span>STUDIO BAEKHO / MAP FORGE</span></div>
      </section>
      <aside class="right-panel ${view === 'variants' ? 'hide' : ''}"><nav class="inspector-tabs"><button data-right-tab="cell" class="${rightTab==='cell'?'selected':''}">셀 편집</button><button data-right-tab="connections" class="${rightTab==='connections'?'selected':''}">연결문</button><button data-right-tab="design" class="${rightTab==='design'?'selected':''}">영역·배치</button><button data-right-tab="assets" class="${rightTab==='assets'?'selected':''}">에셋</button></nav>${rightTab==='cell' ? renderCellInspector() : rightTab==='connections' ? renderConnections() : rightTab==='design' ? designer.renderInspector() : renderAssets()}
        <div class="validation ${errors.length ? 'invalid' : ''}"><strong>${errors.length ? `△ 배치 확인 필요 (${errors.length})` : '✓ 맵 연결문과 내부 경로 연결됨'}</strong><ul>${issues.length ? issues.slice(0,8).map(issue => `<li><button data-action="issue-focus" data-message="${escape(issue.message)}">${escape(issue.message)}</button></li>`).join('') : `<li>걸어넘을 단차 ${map.maxStepHeight}m 기준으로 모든 연결문과 내부 통행 셀이 연결됩니다.</li>`}</ul></div>
        <div class="right-footer"><p class="eyebrow" style="margin-bottom:10px">03 / EXPORT</p><button data-action="export" class="primary full" ${busy || !!exportIssue || !projectPath ? 'disabled' : ''}>Unity 내보내기 ↗</button><p class="caption">${exportIssue ? escape(exportIssue.slice(0,200)) : !projectPath ? '프로젝트를 연결해 에셋 참조를 확인해 주세요.' : '배치 JSON + Unity 가져오기 스크립트를 ZIP으로 저장합니다.'}</p></div>
      </aside>
    </main><footer class="footer ${statusError ? 'error' : ''}"><span>${busy ? '<span class="spinner"></span>' : '●'}</span><span id="status" role="status">${escape(status)}</span><span class="spacer"></span><strong>LOCAL WORKSPACE</strong></footer>
    <dialog id="discard-dialog"><h2>저장하지 않은 변경이 있습니다</h2><p>다른 프로젝트를 열면 현재 작업이 사라집니다. 먼저 저장하려면 돌아가기를 선택해 주세요.</p><form method="dialog"><div class="row"><span class="spacer"></span><button value="cancel" autofocus>돌아가기</button><button value="discard" class="danger">저장하지 않고 열기</button></div></form></dialog>
    <dialog id="replace-variants-dialog"><h2>새 후보 묶음을 만들까요?</h2><p>아직 저장하지 않은 후보가 있습니다. 새로 만들면 현재 후보 목록이 교체됩니다. 보관할 후보는 먼저 선택한 맵 저장으로 저장하세요.</p><form method="dialog"><div class="row"><span class="spacer"></span><button value="cancel" autofocus>돌아가기</button><button value="replace" class="danger">후보 교체하고 생성</button></div></form></dialog>
    <dialog id="codex-dialog">${renderCodexDialog()}</dialog>`;
  const codexDialog = document.querySelector<HTMLDialogElement>('#codex-dialog')!;
  document.querySelectorAll<HTMLDetailsElement>('.left-panel details,.right-panel details').forEach(detail => { const open = detailState.get(detailKey(detail)); if (open !== undefined) detail.open = open; });
  codexDialog.addEventListener('cancel', () => closeCodexDialog());
  if (codexDialogOpen) codexDialog.showModal();
  if (view === '3d') {
    try { preview = mountPreview(document.querySelector('#preview')!, project.map, { ...designer.previewOptions(), bindings:project.bindings, selected, region: designer.selection(), state: previewState, onSelect:(x,row) => { if (busy) return; selected={x,row}; designer.pick(selected); rightTab='cell'; render(); }, onFixtureSelect:id=>{ if(busy)return; designer.selectFixture(id); const f=project.map.fixtures?.find(f=>f.id===id); if(f){selected={x:f.x,row:f.row};designer.pick(selected);} rightTab='design';render(); }, onMarkerSelect:id=>{if(busy)return;designer.selectMarker(id);const m=project.map.markers?.find(m=>m.id===id);if(m){selected={x:m.x,row:m.row};designer.pick(selected);}rightTab='design';render();} }); }
    catch { document.querySelector('#preview')!.innerHTML = '<p class="no-webgl">3D 렌더링을 시작하지 못했습니다.<br>배치 편집 탭에서 맵을 확인할 수 있습니다.</p>'; }
  }
  if (view === 'grid') { drawGrid(); bindGridPainting(); }
  if (view === 'variants') gallery.mount(document.querySelector<HTMLElement>('#viewport')!);
}
function drawGrid() {
  const svg = document.querySelector('#map-svg');
  if (!svg) return;
  const region = designer.selection();
  svg.innerHTML = project.map.rows.map((row,z) => Array.from(row).map((tile,x) => {
    const isSelected = selected?.x === x && selected.row === z;
    const inRegion = region && x >= region.x && z >= region.row && x < region.x + region.width && z < region.row + region.height;
    const locked = designer.isLocked({x,row:z});
    const height = project.map.elevations[z][x];
    const ramp = project.map.ramps.find(r=>r.x===x&&r.row===z);
    const port = connectionAt(project.map,x,z);
    const text = port ? directions.find(d=>d.value===port.direction)!.arrow : tile === 'R' ? ({0:'↑',90:'→',180:'↓',270:'←'}[ramp?.direction ?? 0]) : 'DPB'.includes(tile) ? tile : '';
    return `<g><rect x="${x + 0.03}" y="${z + 0.03}" width=".94" height=".94" rx=".07" fill="${colors[tile as Tile]}" ${isSelected||inRegion?'stroke="#f2cb66" stroke-width=".1"':locked?'stroke="#ad7199" stroke-width=".08"':port?'stroke="#267f96" stroke-width=".08"':''}></rect>${text ? `<text x="${x+.5}" y="${z+.51}" text-anchor="middle" font-size=".38" fill="#ffffff" pointer-events="none">${text}</text>` : ''}${locked?`<text x="${x+.2}" y="${z+.3}" font-size=".22">◆</text>`:''}${tile!=='_'?`<text x="${x+.5}" y="${z+.83}" text-anchor="middle" font-size=".23" fill="${tile==='.'?'#596b50':'#ffffff'}" pointer-events="none">${height}</text>`:''}</g>`;
  }).join('')).join('');
}
function bindGridPainting() {
  const svg = document.querySelector<SVGSVGElement>('#map-svg')!;
  let painting = false, changed = false;
  let before:EditSnapshot|undefined;
  const paint = (event: PointerEvent) => {
    if (!painting || busy) return;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const x = Math.floor(p.x), z = Math.floor(p.y);
    if (x < 0 || z < 0 || x >= project.map.width || z >= project.map.height) return;
    selected = {x,row:z}; rightTab = 'cell';
    if (editMode === 'select') { designer.pick(selected, event.shiftKey || event.type === 'pointermove'); if ((designer.selection()?.width ?? 1)>1 || (designer.selection()?.height ?? 1)>1) rightTab='design'; drawGrid(); return; }
    if (designer.isLocked(selected)) return;
    const port = connectionAt(project.map,x,z), targets = port ? connectionCells(project.map,port) : [selected];
    if (targets.some(designer.isLocked)) return;
    if (editMode === 'paint' && port && port.width > project.map.cellSize && brush !== 'D') { notify('넓은 연결문은 폭을 줄이거나 연결을 해제한 뒤 타일을 바꾸세요.',true); return; }
    if (editMode === 'paint' && project.map.rows[z][x] === brush) return;
    if (editMode === 'height' && (project.map.elevations[z][x] === brushHeight || project.map.rows[z][x] === '_')) return;
    if (!changed) { before=snapshot(); changed = true; }
    try {if (editMode === 'height') for (const cell of targets) project.map.elevations[cell.row][cell.x] = brushHeight;
    else replaceTile(x,z,brush);}catch(error){notify(error instanceof Error?error.message:String(error),true);}
    drawGrid();
  };
  svg.addEventListener('pointerdown', event => { if (event.button !== 0 || busy) return; painting = true; changed = false; svg.setPointerCapture(event.pointerId); paint(event); });
  svg.addEventListener('pointermove', paint);
  const finish = () => { if (painting) { painting = false; if (changed&&before) {try{project.map=synchronizeStructures(project.map);const errors=propValidationIssues(project.map,project.bindings).filter(i=>i.severity==='error');if(errors.length)throw new Error(errors[0].message);history.push(before);if(history.length>50)history.shift();future.length=0;dirty=true;queueRecovery();notify('배치를 수정하고 자동 천장·벽을 갱신했습니다.');}catch(error){Object.assign(project,before);notify(error instanceof Error?error.message:String(error),true);}}render(); } };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);
}
function restore(edit:EditSnapshot) { Object.assign(project,structuredClone(edit)); dirty=true; queueRecovery();render(); }
function undo() { if (busy || !history.length) return; future.push(snapshot()); restore(history.pop()!); }
function redo() { if (busy || !future.length) return; history.push(snapshot()); restore(future.pop()!); }

root.addEventListener('click', async event => {
  if (gallery.click(event.target as HTMLElement)) return;
  const button = (event.target as HTMLElement).closest<HTMLElement>('button');
  if (!button || (button as HTMLButtonElement).disabled) return;
  if (await designer.click(button)) return;
  if (button.dataset.view) { view = button.dataset.view as typeof view; render(); return; }
  if (button.dataset.brush) { brush = button.dataset.brush as Tile; editMode='paint'; render(); return; }
  if (button.dataset.editMode) { editMode = button.dataset.editMode as typeof editMode; rightTab='cell'; render(); return; }
  if (button.dataset.rightTab) { rightTab = button.dataset.rightTab as typeof rightTab; render(); return; }
  const action = button.dataset.action;
  if (busy && action !== 'cancel') return;
  if (selected && designer.isLocked(selected) && ['add-connection','remove-connection','raise','lower'].includes(action ?? '')) {notify('수정하려면 셀 잠금을 해제하세요.',true);return;}
  if(action==='issue-focus'){const match=button.dataset.message?.match(/\((\d+),\s*(\d+)\)/);if(match){selected={x:Number(match[1]),row:Number(match[2])};designer.pick(selected);rightTab='cell';view='grid';render();}return;}
  if(action==='dismiss-recovery'){recovery=null;render();return;}
  if(action==='recover'&&recovery){markHistory();project=recovery;recovery=null;assets=[];projectPath='';selected=null;designer.reset();isSample=false;notify('자동 저장 사본을 복구했습니다. Unity 프로젝트를 다시 연결해 주세요.');render();return;}
  if (action === 'connection-select') { view='grid'; editMode='select'; rightTab='cell'; render(); return; }
  if (action === 'select-connection') {
    const c=project.map.connections.find(c=>c.id===button.dataset.id);
    if(c) { selected={x:c.x,row:c.row}; rightTab='cell'; editMode='select'; render(); } return;
  }
  if (action === 'add-connection' && selected) {
    const {x,row}=selected;
    if(project.map.connections.length>=1600||connectionAt(project.map,x,row))return;
    const facing=directions.find(d=>(project.map.rows[row+d.dr]?.[x+d.dx]??'_')==='_' && '.DR'.includes(project.map.rows[row-d.dr]?.[x-d.dx]??'_'))??directions[0];
    editMap(()=>{replaceTile(x,row,'D');
    project.map.connections.push({ id:`port_${crypto.randomUUID()}`,label:`연결문 ${project.map.connections.length+1}`,x,row,direction:facing.value,width:Math.min(2,project.map.cellSize),height:3,kind:'default' });
    });return;
  }
  if(action==='remove-connection') {
    const connection = project.map.connections.find(c=>c.id===button.dataset.id); if (!connection) return;
    if (connectionCells(project.map,connection).some(designer.isLocked)) { notify('연결문에 잠긴 셀이 있습니다. 먼저 잠금을 해제하세요.',true); return; }
    try {
      const changed = connection.width > project.map.cellSize ? updateConnectionGeometry(project.map, connection.id, { width: project.map.cellSize }) : structuredClone(project.map);
      changed.connections = changed.connections.filter(c=>c.id!==connection.id);
      editMap(()=>{project.map=changed;});
    } catch (error) { notify(error instanceof Error ? error.message : String(error),true); }
    return;
  }
  if (action === 'bulk-scale' || action === 'fit-cell-scale') {
    try {
      const count = project.bindings.filter(binding => matchesScaleScope(binding.role, bulkScope)).length;
      if (!count) { notify('조정할 에셋을 먼저 추가하세요.', true); return; }
      const axes = Object.fromEntries(Object.entries(bulkAxes).filter(([, value]) => value.trim() !== '').map(([axis, value]) => [axis, Number(value)]));
      const changed = scaleAssets(project.bindings, bulkScope, action === 'fit-cell-scale' ? { kind: 'cell', cellSize: project.map.cellSize } : { kind: bulkMode, axes });
      const checked = parseProjectFile({ ...project, bindings: changed });
      markHistory(); project.bindings = checked.bindings;
      notify(`${count}개 에셋의 배율을 조정했습니다. Unity로 다시 내보내면 적용됩니다.`); render();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    return;
  }
  if(action==='add-binding') {
    const asset=assets.find(a=>a.guid===newAssetGuid);
    if(!asset||project.bindings.length>=MAX_BINDINGS)return;
    const binding:AssetBinding={id:`asset_${crypto.randomUUID()}`,label:asset.name.slice(0,80),role:newAssetRole,prefabGuid:asset.guid,prefabPath:asset.path,scale:newAssetRole==='prop'||newAssetRole==='decoration'?{x:1,y:1,z:1}:defaultAssetScale(newAssetRole,project.map.cellSize),offset:{x:0,y:0,z:0},rotationY:0,...((newAssetRole==='stair'||newAssetRole==='slope')?{stairNativeRise:1}:{})};
    if(newAssetRole==='prop'||newAssetRole==='decoration')binding.prop=suggestPropDefinition(binding);
    markHistory(); project.bindings.push(binding);
    notify(`에셋을 추가했습니다. 현재 ${project.bindings.length}개입니다.`); render(); return;
  }
  if(action==='refit-prop-instance') {
    try {
      const prop=project.map.propInstances?.find(p=>p.id===button.dataset.id);if(!prop)return;
      const report=project.settings.levelDesign?analyzeLevelDesign(project.map,project.settings):undefined;
      const changed=replacePropInstance(project.map,prop.id,prop.bindingId,project.settings,project.bindings,report?[...report.reservedEntryCells,...report.combatCells]:[]);
      markHistory();project.map=changed;notify('현재 프리팹 크기로 전체 점유 영역을 다시 검사했습니다.');
    }catch(error){notify(error instanceof Error?error.message:String(error),true);}
    render();return;
  }
  if(action==='remove-prop-instance') {
    try { const changed=removePropInstance(project.map,button.dataset.id??'');markHistory();project.map=changed;notify('소품 전체를 삭제하고 바닥을 유지했습니다.'); }
    catch(error){notify(error instanceof Error?error.message:String(error),true);}
    render();return;
  }
  if(action==='remove-binding') {
    if(!project.bindings.some(b=>b.id===button.dataset.id))return;
    const used=project.map.propInstances?.filter(p=>p.bindingId===button.dataset.id)??[];
    if(used.length){notify(`이 프리팹을 사용하는 소품이 ${used.length}개 있습니다. 소품을 교체하거나 삭제한 뒤 에셋을 삭제하세요.`,true);return;}
    markHistory(); project.bindings=project.bindings.filter(b=>b.id!==button.dataset.id);
    project.map.assetOverrides=project.map.assetOverrides.filter(o=>o.bindingId!==button.dataset.id);
    for (const fixture of project.map.fixtures ?? []) if (fixture.bindingId === button.dataset.id) delete fixture.bindingId;
    notify('에셋을 삭제했습니다. 이 에셋을 지정했던 셀은 자동 순환으로 돌아갑니다. 되돌리기로 복원할 수 있습니다.');render();return;
  }
  if (action === 'assets-tab') { rightTab='assets'; render(); return; }
  if (action === 'height-brush') { editMode='height'; view='grid'; render(); return; }
  if ((action === 'raise' || action === 'lower') && selected) return setSelectedHeight(project.map.elevations[selected.row][selected.x] + project.settings.elevationStep * (action==='raise'?1:-1));
  if (action === 'undo') return undo();
  if (action === 'redo') return redo();
  if (action === 'codex') return openCodexDialog();
  if (action === 'close-codex') return closeCodexDialog();
  if (action === 'codex-refresh') return refreshCodex();
  if (action === 'codex-select') return refreshCodex(true);
  if (action === 'codex-login') {
    if (loginPending || codexChecking) return;
    loginPending = true; loginDeadline = Date.now() + 10 * 60 * 1000; updateCodexControls();
    try { await requireDesktop().startCodexLogin(); await refreshCodex(); }
    catch (error) { loginPending = false; codex = { ...codex, state: 'error', message: error instanceof Error ? error.message : String(error) }; updateCodexControls(); }
    return;
  }
  if (action === 'cancel') { generationCancelled=true; try { await api?.cancelGeneration(); } catch (error) { notify(String(error), true); } return; }
  if (action === 'demo') {
    markHistory(); project.map = createDemoMap(); delete project.generationDraft; designer.reset(); isSample = true; selected=null; project.settings.cellSize = project.map.cellSize; project.settings.maxStepHeight=project.map.maxStepHeight;
    notify('샘플 맵을 불러왔습니다. 데모는 AI 호출 없이 제공됩니다.'); render(); return;
  }
  if (action === 'scan') return task(async () => {
    let result;
    try { result = await requireDesktop().scanProject(); }
    catch (error) { assets = []; projectPath = ''; throw error; }
    if (!result) { notify('폴더 연결을 취소했습니다.'); return; }
    assets = result.assets; projectPath = result.projectPath;
    if(!assets.some(a=>a.guid===newAssetGuid))newAssetGuid='';
    notify(`프리팹 ${assets.length}개를 찾았습니다.${result.warnings.length ? ' ' + result.warnings.join(' ') : ''}`);
  }, 'Unity 프리팹 목록을 읽고 있습니다…');
  if(action==='import-prop-catalog')return task(async()=>{const value=await requireDesktop().importPropCatalog?.();if(!value)return;const result=applyPropBoundsCatalog(project.bindings,value);const checked=parseProjectFile({...project,bindings:result.bindings});markHistory();project.bindings=checked.bindings;notify(`${result.updated}개 소품의 원본 크기를 가져왔습니다.`);},'소품 크기 정보를 가져옵니다…');
  if (action === 'generate') return runGeneration('all');
  if (action === 'generate-variants') return runVariantGeneration();
  if (action === 'generate-image') return runGeneration('image');
  if (action === 'extract') return runGeneration('extract');
  if (action === 'save') return task(async () => {
    const path = await requireDesktop().saveProject(project);
    if (path) { dirty = false; notify(`저장 완료: ${path}`); } else notify('저장을 취소했습니다.');
  }, '프로젝트를 저장합니다…');
  if (action === 'open') {
    if (dirty) {
      const dialog = document.querySelector<HTMLDialogElement>('#discard-dialog')!;
      dialog.returnValue = 'cancel';
      const answer = new Promise<boolean>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), { once:true }));
      dialog.showModal();
      if (!await answer) return;
    }
    return task(async () => {
    const loaded = await requireDesktop().openProject();
    if (loaded) { designer.reset(); project = loaded; assets = []; projectPath = ''; history.length = 0; future.length = 0; dirty = false; isSample = false; view = '3d'; selected=null; notify('프로젝트를 열었습니다. 내보내려면 원본 Unity 프로젝트를 연결해 주세요.'); }
    else notify('열기를 취소했습니다.');
    }, '프로젝트를 불러옵니다…');
  }
  if (action === 'export') return task(async () => {
    const path = await requireDesktop().exportBundle(project);
    notify(path ? `내보내기 완료: ${path} — ZIP 안내문에 따라 Unity에서 프리팹을 생성하세요.` : '내보내기를 취소했습니다.');
  }, 'Unity 가져오기 묶음을 생성합니다…');
});

root.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'prompt') { project.settings.prompt = input.value; dirty = true; queueRecovery(); }
  if (input.id === 'codexModel') { project.settings.codexModel = input.value.trim(); dirty = true; queueRecovery(); }
});
root.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (busy) return;
  queueMicrotask(queueRecovery);
  if (designer.change(input)) return;
  if(input.dataset.generationControl){try{const settings=updateGenerationControl(project.settings,input.dataset.generationControl,input.value);markHistory();project.settings=settings;render();}catch(error){notify(error instanceof Error?error.message:String(error),true);render();}return;}
  if(input.dataset.propBinding&&input.dataset.propField){try{const index=project.bindings.findIndex(b=>b.id===input.dataset.propBinding);if(index<0)return;const binding=handlePropField(project.bindings[index],input.dataset.propField,input.type==='checkbox'?input.checked:input.value);const bindings=project.bindings.map((b,i)=>i===index?binding:b);const checked=parseProjectFile({...project,bindings});markHistory();project.bindings=checked.bindings;render();}catch(error){notify(error instanceof Error?error.message:String(error),true);render();}return;}
  if (selected && designer.isLocked(selected) && (['selectedTile','selectedHeight','rampDirection','rampRise'].includes(input.id) || input.dataset.connection || input.dataset.cellBinding)) { notify('수정하려면 셀 잠금을 해제하세요.',true);render();return; }
  if (input.id === 'variantCount') { const count = Number(input.value); if (Number.isInteger(count) && count >= 2 && count <= 8) variantCount = count; return; }
  if (input.id === 'bulkScaleScope') { bulkScope = input.value as ScaleScope; render(); return; }
  if (input.id === 'bulkScaleMode') { bulkMode = input.value as typeof bulkMode; return; }
  if (input.dataset.bulkAxis) { bulkAxes[input.dataset.bulkAxis as keyof typeof bulkAxes] = input.value; return; }
  if(input.id==='newAssetRole') {newAssetRole=input.value as AssetRole;render();return;}
  if(input.id==='newAssetGuid') {newAssetGuid=input.value;render();return;}
  if(input.id==='connectionCount') {
    const value=Number(input.value);
    if(!Number.isInteger(value)||value<1||value>16){notify('AI 연결문 개수는 1~16개의 정수로 입력해 주세요.',true);render();return;}
    project.settings.connectionCount=value;dirty=true;notify('연결문 개수는 다음 AI 설계와 분석에 적용됩니다.');return;
  }
  if(input.dataset.connection && selected) {
    const c=connectionAt(project.map,selected.x,selected.row);
    if(!c)return;
    if (connectionCells(project.map,c).some(designer.isLocked)) { notify('연결문에 잠긴 셀이 있습니다. 먼저 잠금을 해제하세요.',true); render(); return; }
    const key=input.dataset.connection, value=input.value.trim();
    if(key==='label'||key==='kind') {
      if(!value||value.length>(key==='kind'?40:80)||(key==='kind'?!/^[A-Za-z0-9_-]+$/.test(value):/[\u0000-\u001f\u007f]/.test(value))){notify('연결문 이름과 종류를 확인해 주세요. 종류는 영문·숫자·_·-만 사용할 수 있습니다.',true);render();return;}
      markHistory();c[key]=value;
    } else {
      const number=Number(value);
      if(!Number.isFinite(number)||(key==='direction'?![0,90,180,270].includes(number):number<.25||number>(key==='width'?40:20))){notify('연결문의 방향·폭·높이를 확인해 주세요.',true);render();return;}
      try {
        const changed = updateConnectionGeometry(project.map, c.id, { [key]: number });
        markHistory(); project.map = changed;
        notify('연결문의 개구부와 크기를 함께 조정했습니다.');
      } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    }
    render();return;
  }
  if(input.dataset.propInstanceBinding || input.hasAttribute('data-insert-prop')) {
    if(!input.value||!selected)return;
    try {
      const report=project.settings.levelDesign?analyzeLevelDesign(project.map,project.settings):undefined;
      const reserved=report?[...report.reservedEntryCells,...report.combatCells]:[];
      const changed=input.dataset.propInstanceBinding
        ?replacePropInstance(project.map,input.dataset.propInstanceBinding,input.value,project.settings,project.bindings,reserved)
        :insertPropInstance(project.map,selected,input.value,project.settings,project.bindings,reserved);
      markHistory();project.map=changed;notify('프리팹과 전체 점유 영역을 검사해 소품을 배치했습니다.');
    } catch(error){notify(error instanceof Error?error.message:String(error),true);}
    render();return;
  }
  if(input.dataset.cellBinding && selected) {
    const {x,row}=selected, role=input.dataset.cellBinding as AssetRole;
    if(input.value&&!project.bindings.some(b=>b.id===input.value&&b.role===role))return;
    markHistory();project.map.assetOverrides=project.map.assetOverrides.filter(o=>o.x!==x||o.row!==row||o.role!==role);
    if(input.value)project.map.assetOverrides.push({x,row,role,bindingId:input.value});render();return;
  }
  if (input.dataset.lightAnchor) {
    const binding = project.bindings.find(b => b.id === input.dataset.lightAnchor); if (!binding) return;
    try {
      const changed = structuredClone(project.bindings), item = changed.find(b => b.id === binding.id)!;
      if (input.value) item.lightAnchor = input.value as 'wall' | 'ceiling'; else delete item.lightAnchor;
      const checked = parseProjectFile({ ...project, bindings: changed });
      markHistory(); project.bindings = checked.bindings; render();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); render(); }
    return;
  }
  if(input.dataset.bindingLabel) {
    const b=project.bindings.find(b=>b.id===input.dataset.bindingLabel),value=input.value.trim();
    if(!b)return;
    if(!value||value.length>80||/[\u0000-\u001f\u007f]/.test(value)){notify('에셋 이름은 1~80자로 입력해 주세요.',true);render();return;}
    markHistory();b.label=value;render();return;
  }
  if (input.id==='selectedTile' && selected) { editMap(()=>replaceTile(selected!.x,selected!.row,input.value as Tile)); return; }
  if (input.dataset.stairRise) {
    const binding=project.bindings.find(b=>b.id===input.dataset.stairRise), value=Number(input.value);
    if (!binding) return;
    if (!Number.isFinite(value)||value<=0||value>1000) {notify('원본 계단 오름폭은 0보다 크고 1000m 이하로 입력해 주세요.',true);render();return;}
    markHistory();binding.stairNativeRise=value;render();return;
  }
  if (input.id==='selectedHeight') return setSelectedHeight(Number(input.value));
  if (input.id==='brushHeight') {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < -100 || value > 100) { notify('높이는 −100~100m로 입력해 주세요.',true); render(); return; }
    brushHeight=value; render(); return;
  }
  if (input.id==='rampDirection' || input.id==='rampRise') {
    const cell=selected;
    const ramp=cell && project.map.ramps.find(r=>r.x===cell.x&&r.row===cell.row);
    if (!ramp) return;
    const value=Number(input.value);
    if (!Number.isFinite(value) || (input.id==='rampRise' && (value<.25 || value>10)) || (input.id==='rampDirection' && ![0,90,180,270].includes(value))) { notify('계단 방향 또는 오름폭을 확인해 주세요.',true); render(); return; }
    editMap(()=>{if (input.id==='rampDirection') ramp.direction=value as 0|90|180|270;else ramp.rise=value;}); return;
  }
  if (input.id==='elevationStep' || input.id==='maxStepHeight') {
    const value=Number(input.value), isStep=input.id==='elevationStep';
    if (!Number.isFinite(value) || value < (isStep ? .25 : .05) || value > (isStep ? 10 : 1)) { notify('높이 설정이 허용 범위를 벗어났습니다.',true); render(); return; }
    if (isStep) { project.settings.elevationStep=value; dirty=true; }
    else { markHistory(); project.map.maxStepHeight=value; project.settings.maxStepHeight=value; }
    render(); return;
  }
  if (input.id === 'mapName') { if (input.value.trim()) { markHistory(); project.map.name = input.value.trim(); } render(); return; }
  if (input.id === 'width' || input.id === 'height') {
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < 8 || value > 40) { notify('가로·세로 크기는 8~40 사이 정수로 입력해 주세요.', true); render(); return; }
    markHistory(); project.settings=setCustomRoomSize(project.settings,{[input.id]:value}); notify('사용자 지정 크기로 전환했습니다. 다음 AI 생성에 적용됩니다.'); render();return;
  }
  if (input.id === 'cellSize') {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0.25 || value > 10) { notify('셀 간격은 0.25~10m로 입력해 주세요.', true); render(); return; }
    markHistory(); project.settings=setCustomRoomSize(project.settings,{cellSize:value});render();return;
  }
  if(input.id==='currentCellSize'){const value=Number(input.value);if(!Number.isFinite(value)||value<.25||value>10){notify('셀 간격은 0.25~10m로 입력하세요.',true);render();return;}editMap(()=>{project.map.cellSize=value;});return;}
  if (input.dataset.binding) {
    const asset=assets.find(a=>a.guid===input.value), binding=project.bindings.find(b=>b.id===input.dataset.binding);
    if(!asset||!binding)return;
    markHistory();if(binding.prefabGuid!==asset.guid&&binding.prop){delete binding.prop.size;notify('새 프리팹의 원본 크기를 가져오거나 직접 입력해 주세요.');}binding.prefabGuid=asset.guid;binding.prefabPath=asset.path;render();return;
  }
  if (input.dataset.transform || input.dataset.rotation) {
    const [id, group, axis] = (input.dataset.transform ?? input.dataset.rotation!).split(':');
    const binding = project.bindings.find(b => b.id === id);
    if(!binding)return;
    const value = Number(input.value);
    if (!Number.isFinite(value) || Math.abs(value) > 10000 || (group === 'scale' && value <= 0)) { notify('배율은 양수, 오프셋과 회전은 유효한 숫자로 입력해 주세요.', true); render(); return; }
    markHistory();
    if (input.dataset.rotation) binding.rotationY = value;
    else binding[group as 'scale' | 'offset'][axis as 'x'|'y'|'z'] = value;
    dirty = true; render();
  }
});
window.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || document.querySelector('dialog[open]') || view === 'variants') return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
});
window.addEventListener('beforeunload', event => { if (dirty || busy || candidates.some(candidate => candidate.status === 'ready' && !savedCandidateIds.has(candidate.id))) { event.preventDefault(); event.returnValue = ''; } });
render();
if (api) { void refreshCodex(); void api.loadRecovery().then(value => { recovery=value; if(value)render(); }).catch(error=>notify(`복구 사본을 읽지 못했습니다: ${String(error)}`,true)); }
