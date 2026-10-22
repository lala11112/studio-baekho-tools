import './style.css';
import './connections.css';
import './designer.css';
import './variants.css';
import { createVariantGallery } from './variants';
import { generateVariants, variantSettings, type MapVariant } from './shared/variants';
import { createDesigner, EXTRA_ROLES } from './designer';
import { DEFAULT_DESIGNER, applyGeneratedFeatures, generationConditionIssues, parseGenerationSettings } from './shared/features';
import { assertManualConcept, conceptMode, conceptForRequest, legacyConcept, parseConceptText } from './shared/concepts';
import { mergeGeneratedRegion } from './shared/editing';
import { defaultAssetScale, matchesScaleScope, scaleAssets, type ScaleScope } from './shared/asset-scaling';
import { buildManifest, createDemoMap, DEFAULT_SETTINGS, FLOOR_THICKNESS_RATIO, MAX_BINDINGS, resolveBinding, validateMap, parseProjectFile, cellHasRole, connectionAt, connectionCells, maximumConnectionWidth, updateConnectionGeometry, addMapConnection } from './shared/map';
import type { AssetBinding, AssetRole, CodexStatus, GridMap, MapConcept, MapConnection, PrefabAsset, ProjectFile, Tile, UnityBuildStatus, UnityConnectionStatus, ValidationIssue } from './shared/types';
import { mountPreview, type PreviewState } from './preview';
import { applyRoomPreset, resolveGenerationSettings, setCustomRoomSize } from './shared/room-presets';
import { renderGenerationControls, renderConnectionSizeControls, renderConceptControls, renderConceptResult, updateGenerationControl } from './generation-controls';
import { renderPropLibraryFields, handlePropField, reclassifyPropBinding } from './prop-library';
import { suggestPropDefinition, snapshotPropCatalog, preparePropBoundsImport, applyImportedPropBounds, type PropBoundsCatalog, propValidationIssues, getPropCoverageReport, replacePropInstance, insertPropInstance, removePropInstance } from './shared/props';
import { getCompositionIssues } from './shared/prop-composition';
import { synchronizeStructures } from './shared/structures';
import { analyzeLevelDesign } from './shared/level-design';
import { furnishExistingMap, rearrangeMapProps, type FurnishingResult } from './shared/furnishing';
import { importPropCatalogBindings } from './shared/prop-catalog-import';
import { importUnityAssetCatalogBindings } from './shared/unity-asset-catalog';
import { removeAssetBindings } from './shared/asset-deletion';
import { renderWallMountFields, handleWallMountField } from './wall-mount-ui';
import { wallMountIssues } from './shared/wall-mounts';
import { wallMountGenerationIssues } from './shared/wall-mount-diagnostics';

const api = window.baekho;
const root = document.querySelector<HTMLDivElement>('#app')!;
let project: ProjectFile = { formatVersion: 1, map: createDemoMap(), settings: applyRoomPreset(DEFAULT_SETTINGS,'medium'), bindings: [] };
let assets: PrefabAsset[] = [];
let projectPath = '';
let importedPropCatalog: PropBoundsCatalog | null = null;
let unityCatalogReport: { summary: string; counts: { label: string; added: number; updated: number }[]; details: { path: string; reason: string }[]; warnings: string[] } | null = null;
let propCatalogRole: 'prop' | 'decoration' | 'vegetation' | 'light' = 'prop';
let furnishProps = true, furnishDecorations = true, rearrangeUnknown = false;
let furnishingResult: { map: GridMap; result: FurnishingResult | ReturnType<typeof rearrangeMapProps> } | undefined;
let wallGenerationReport: { map: GridMap; count: number; temporary: number; issues: ValidationIssue[] } | undefined;
let view: '3d' | 'grid' | 'image' | 'variants' = '3d';
let variantCount = 3;
let candidates: MapVariant[] = [];
const savedCandidateIds = new Set<string>();
let brush: Tile = '.';
let editMode: 'select' | 'paint' | 'height' = 'select';
let brushHeight = 0;
let selected: { x: number; row: number } | null = null;
let rightTab: 'cell' | 'assets' | 'connections' | 'design' = 'cell';
let renderedRightTab: 'cell' | 'assets' | 'connections' | 'design' = rightTab;
let newAssetRole: AssetRole = 'floor', newAssetGuid = '';
let bulkScope: ScaleScope = 'tiles', bulkMode: 'set' | 'multiply' = 'set';
type DeleteScope = AssetRole | 'all' | 'props';
let bulkDeleteScope: DeleteScope = 'prop';
let pendingAssetDeletion: { ids: string[]; label: string; placements: number } | null = null;
const bulkAxes = { x: '2', y: '', z: '2' };
let busy = false, isSample = true, dirty = false;
let taskCancelable = true;
const DEFAULT_UNITY_ENDPOINT = 'http://127.0.0.1:8080/mcp';
let unityEndpoint = DEFAULT_UNITY_ENDPOINT;
try { unityEndpoint = localStorage.getItem('baekho.unityEndpoint') || DEFAULT_UNITY_ENDPOINT; } catch { /* Storage is optional in browser previews. */ }
let unityConnection: UnityConnectionStatus | undefined;
let unityBuild: UnityBuildStatus | undefined;
let unityWorking = false;
let unityStage: UnityBuildStatus['stage'] | undefined;
const unitySupported = () => !!api?.getUnityStatus && !!api?.prepareUnityIntegration && !!api?.startUnityPrefabBuild && !!api?.getUnityPrefabBuild;
const unresolvedUnityBuild = () => unityBuild?.state === 'running' || unityBuild?.state === 'unknown';
function resetUnityConnection() {
  unityConnection = undefined;
  unityCatalogReport = null;
  if (!unresolvedUnityBuild()) unityBuild = undefined;
}
let codex: CodexStatus = { state: 'missing', message: '설치된 Codex 연결을 확인하고 있습니다.', models: [] };
let codexChecking = false, codexDialogOpen = false, loginPending = false;
let loginDeadline = 0;
let loginTimer: ReturnType<typeof setTimeout> | undefined;
let status = '샘플 맵을 둘러보거나 새 AI 설계도를 생성하세요.';
let statusError = false;
let preview: ReturnType<typeof mountPreview> | undefined;
let previewState: PreviewState | undefined;
type EditSnapshot = Pick<ProjectFile, 'map' | 'bindings' | 'settings' | 'blueprintDataUrl' | 'generationDraft' | 'concept'>;
let attemptConcept: MapConcept | undefined;
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
const snapshot = (): EditSnapshot => structuredClone({ map: project.map, bindings: project.bindings, settings: project.settings, blueprintDataUrl: project.blueprintDataUrl, generationDraft: project.generationDraft, concept: project.concept });
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
    try { edit(); project.map=synchronizeStructures(project.map);const propErrors=[...propValidationIssues(project.map),...wallMountIssues(project.map,project.bindings)].filter(i=>i.severity==='error');if(propErrors.length)throw new Error(propErrors[0].message); project = parseProjectFile(project); history.push(before); if (history.length > 50) history.shift(); future.length = 0; dirty = true; queueRecovery(); render(); }
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
      markHistory(); project = checked; attemptConcept = undefined; isSample = false; selected = null; designer.reset(); previewState = undefined; view = '3d';
      wallGenerationReport = { map: checked.map, count: checked.map.fixtures?.filter(f => f.wall).length ?? 0, temporary: checked.map.fixtures?.filter(f => f.wall?.placeholder).length ?? 0, issues: wallMountGenerationIssues(checked.map, checked.settings, checked.bindings) };
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
  generationCancelled = false; attemptConcept = undefined;
  await task(async () => {
    const draft = mode === 'extract' ? project.generationDraft : undefined;
    let settings = parseGenerationSettings(structuredClone(draft?.settings ?? project.settings));
    if(mode!=='extract'&&!region)settings=resolveGenerationSettings({...settings,sizeResolved:false});
    const preferences = structuredClone(draft?.preferences ?? (draft ? { ...draft.settings, prompt: project.settings.prompt, conceptMode: project.settings.conceptMode } : settings));
    const catalog=structuredClone(mode==='extract'&&project.generationDraft?.catalog?project.generationDraft.catalog:snapshotPropCatalog(project.bindings));
    const conceptCatalog = structuredClone(project.bindings);
    if (region && !draft) {
      settings.width = project.map.width; settings.height = project.map.height;
      settings.cellSize = project.map.cellSize; settings.maxStepHeight = project.map.maxStepHeight;
      settings.connectionCount = project.map.connections.length;
      delete settings.connectionWidth; delete settings.connectionHeight;
      settings.sizeMode='custom';settings.sizeResolved=true;
    }
    let concept: MapConcept | undefined;
    if (mode === 'extract') {
      concept = draft?.concept ?? (draft ? legacyConcept(draft.settings) : project.concept ?? legacyConcept(settings));
      if (!concept) throw new Error('이 설계도의 컨셉 기록이 없습니다. 새 설계도를 생성해 주세요.');
      if (!draft) settings = conceptForRequest(settings, concept);
    } else {
      assertManualConcept(settings);
      if (conceptMode(settings) === 'manual') concept = { source: 'manual', text: parseConceptText(settings.prompt, 'manual') };
      else if (region && project.concept) concept = structuredClone(project.concept);
      else {
        notify('컨셉 작성 · 선택한 조건에 맞는 맵 컨셉을 작성하고 있습니다…');
        const text = await requireDesktop().generateConcept({ ...settings, prompt: '' }, conceptCatalog, region ? { currentMap: structuredClone(project.map) } : undefined);
        if (generationCancelled) return;
        concept = { source: 'ai', text: parseConceptText(text) };
      }
      settings = conceptForRequest(settings, concept);
    }
    attemptConcept = mode === 'extract' ? undefined : structuredClone(concept); render();
    if (region && !draft) {
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
      project.generationDraft = { imageDataUrl: image, settings: structuredClone(settings), preferences, concept: structuredClone(concept), catalog:structuredClone(catalog), ...(region ? { region: { ...region } } : {}) };
      attemptConcept = undefined;
      dirty = true; queueRecovery();
    }
    if (mode === 'image') { view = 'image'; notify('설계도 초안을 만들었습니다. 배치 만들기로 이어서 진행할 수 있습니다.'); return; }
    if (generationCancelled) return;
    notify('2/3 · 설계도에서 지형과 연결을 분석하고 있습니다…');
    const candidate = await requireDesktop().extractLayout(settings, image, region ?? undefined,catalog);
    if (generationCancelled) return;
    notify('3/3 · 생성 조건과 이동 경로를 확인하고 있습니다…');
    const result = region ? mergeGeneratedRegion(project.map, candidate, region, merged => applyGeneratedFeatures(merged, settings, region,catalog), catalog) : candidate;
    const errors = [...validateMap(result, catalog), ...generationConditionIssues(result, settings, region ?? undefined),...(settings.levelDesign?analyzeLevelDesign(result,settings).issues:[])].filter(i => i.severity === 'error');
    if (errors.length) throw new Error(errors.slice(0, 3).map(i => i.message).join(' '));
    const wallIssues = wallMountGenerationIssues(result, settings, catalog, region ?? undefined);
    const wallCount = result.fixtures?.filter(f => f.wall && (!region || f.x >= region.x && f.row >= region.row && f.x < region.x + region.width && f.row < region.row + region.height)).length ?? 0;
    const temporaryWallCount = result.fixtures?.filter(f => f.wall?.placeholder && (!region || f.x >= region.x && f.row >= region.row && f.x < region.x + region.width && f.row < region.row + region.height)).length ?? 0;
    markHistory(); project.map = result;
    wallGenerationReport = { map: result, count: wallCount, temporary: temporaryWallCount, issues: wallIssues };
    if (!region) {project.blueprintDataUrl = image; project.settings=preferences;}
    if (!region || !project.concept) project.concept=structuredClone(concept);
    delete project.generationDraft;
    attemptConcept = undefined;
    isSample = false; selected = null; designer.reset(); view = '3d';
    const complete = region ? '선택 영역을 다시 만들었습니다. 보호 영역과 외부 연결문을 유지했습니다.' : '맵을 생성했습니다. 천장·조명·게임 지점을 확인하고 에셋을 연결하세요.';
    notify(`${complete} 벽 부착물 ${wallCount}개${temporaryWallCount ? ` · 임시 ${temporaryWallCount}개` : ''}.${wallIssues.length ? ` ${wallIssues[0].message} 오른쪽 벽 배치 결과를 확인하세요.` : ''}`);
  }, '맵 생성을 준비하고 있습니다…');
  if (generationCancelled) { attemptConcept=undefined; notify('맵 생성을 취소했습니다. 기존 맵과 저장된 설계도 초안은 유지됩니다.'); render(); }
}

async function runVariantGeneration() {
  if (busy) return;
  if (codex.state !== 'ready') { openCodexDialog(); return; }
  // Validate the snapshot and requests before replacing an earlier gallery or starting AI work.
  let source: ProjectFile;
  try {
    source = parseProjectFile(structuredClone(project));
    assertManualConcept(source.settings);
    if (conceptMode(source.settings) === 'manual') for (let index = 0; index < variantCount; index++) variantSettings(source.settings, index, variantCount);
  }
  catch (error) { notify(error instanceof Error ? error.message : String(error), true); return; }
  if (candidates.some(candidate => candidate.status === 'ready' && !savedCandidateIds.has(candidate.id))) {
    const dialog = document.querySelector<HTMLDialogElement>('#replace-variants-dialog')!;
    dialog.returnValue = 'cancel';
    const answer = new Promise<boolean>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'replace'), { once: true }));
    dialog.showModal();
    if (!await answer || busy) return;
  }
  generationCancelled = false; attemptConcept = undefined; savedCandidateIds.clear(); view = 'variants';
  await task(async () => {
    const desktop = requireDesktop();
    candidates = await generateVariants(source, variantCount, {
      generateConcept: (settings,catalog,context) => desktop.generateConcept(settings,catalog,context),
      generateImage: (settings,catalog) => desktop.generateImage(settings,undefined,catalog),
      extractLayout: (settings, image,catalog) => desktop.extractLayout(settings, image,undefined,catalog),
      isCancelled: () => generationCancelled,
      onUpdate: updated => {
        candidates = updated; gallery.setCandidates(candidates);
        const ready = candidates.filter(candidate => candidate.status === 'ready').length;
        const current = candidates.find(candidate => candidate.status === 'concept' || candidate.status === 'image' || candidate.status === 'extract');
        notify(current ? `후보 ${current.index + 1}/${variantCount} · ${current.status === 'concept' ? '컨셉 작성' : current.status === 'image' ? '설계도 생성' : '배치 분석'} 중… · ${ready}개 완성` : `후보 ${ready}/${variantCount}개 완성`);
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
  try { edit(); project.map=synchronizeStructures(project.map); const errors=[...propValidationIssues(project.map,project.bindings),...wallMountIssues(project.map,project.bindings)].filter(i=>i.severity==='error'); if(errors.length)throw new Error(errors.map(i=>i.message).join(' ')); history.push(before); if(history.length>50)history.shift(); future.length=0;dirty=true;queueRecovery(); }
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
function validateBindingEdit(value: ProjectFile): ProjectFile {
  const checked = parseProjectFile(value), errors = wallMountIssues(checked.map, checked.bindings).filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(`${errors[0].message} 기존 벽 부착물은 전용 편집에서 교체하거나 제거한 뒤 에셋의 크기·설치 설정을 바꿔 주세요.`);
  return checked;
}
async function task(action: () => Promise<void>, message: string, cancelable = true) {
  if (busy) return;
  busy = true; taskCancelable = cancelable; status = message; statusError = false; render();
  try { await action(); } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  finally { busy = false; taskCancelable = true; queueRecovery(); render(); }
}
const unityStageLabels: Record<UnityBuildStatus['stage'], string> = {
  checking: '연결 확인', preparing: '스크립트 준비', compiling: '컴파일 대기', building: '맵 생성·NavMesh 베이크',
  completed: '생성 완료', failed: '생성 실패', unknown: '결과 확인 필요',
};
function renderUnityExport(exportIssue: string) {
  const pending = unresolvedUnityBuild(), stage = unityStage ?? unityBuild?.stage;
  const issue = exportIssue ? escape(exportIssue.slice(0, 200)) : !projectPath ? '프로젝트를 연결해 에셋 참조를 확인해 주세요.' : '맵을 조립하고 NavMesh와 프리팹을 Unity 프로젝트에 저장합니다.';
  return `<div class="right-footer"><p class="eyebrow" style="margin-bottom:10px">03 / UNITY PREFAB</p>
    <button data-action="unity-build" class="primary full" ${busy || pending || !!exportIssue || !projectPath || !unitySupported() ? 'disabled' : ''}>${unityWorking ? '<span class="spinner"></span>' : ''}Unity에 프리팹 생성</button>
    <p class="caption">${!unitySupported() && api ? '최신 데스크톱 앱에서 Unity 자동 생성을 사용할 수 있습니다.' : issue}</p>
    <div class="unity-progress ${unityBuild?.state === 'failed' || unityBuild?.state === 'unknown' ? 'unity-attention' : ''}" data-unity-state="${unityBuild?.state ?? unityConnection?.state ?? 'unchecked'}" role="status" aria-live="polite">
      ${stage ? `<strong data-unity-stage="${stage}">${unityStageLabels[stage]}</strong>` : ''}
      <p data-unity-message>${escape((unityWorking || pending ? unityBuild?.message : unityConnection?.message ?? unityBuild?.message) ?? 'Unity Editor와 MCP 서버를 실행한 뒤 연결을 확인하세요.')}</p>
      ${unityBuild?.error ? `<p class="error-text">${escape(unityBuild.error)}</p>` : ''}
      ${unityBuild?.requestId ? `<small class="unity-request">요청 <span data-unity-request-id>${escape(unityBuild.requestId)}</span></small>` : ''}
      ${unityBuild?.projectPath ? `<small>프로젝트 <span>${escape(unityBuild.projectPath)}</span></small>` : ''}
      ${unityBuild?.prefabPath ? `<small>프리팹 <span data-unity-prefab-path>${escape(unityBuild.prefabPath)}</span></small>` : ''}
      ${unityBuild?.navMeshPath ? `<small>NavMesh <span data-unity-navmesh-path>${escape(unityBuild.navMeshPath)}</span></small>` : ''}
      ${unityConnection?.warnings?.length ? `<p class="caption">${unityConnection.warnings.map(escape).join('<br>')}</p>` : ''}
      ${pending ? `<p class="caption">같은 요청의 상태를 확인합니다. 결과가 확인되기 전에는 새 생성을 시작할 수 없습니다.</p><button data-action="unity-build-status" class="full" ${disabled()}>생성 결과 다시 확인</button>` : ''}
    </div>
    <details class="unity-settings"><summary>Unity MCP 연결 설정</summary><label class="field"><span>이 컴퓨터의 MCP 주소</span><input id="unityEndpoint" type="url" aria-label="Unity MCP 주소" spellcheck="false" value="${escape(unityEndpoint)}" placeholder="${DEFAULT_UNITY_ENDPOINT}" ${busy || pending ? 'disabled' : ''}></label>
      <div class="row"><button data-action="unity-check" ${busy || !unitySupported() ? 'disabled' : ''}>연결 확인</button><button data-action="unity-prepare" ${busy || pending || !projectPath || !unitySupported() ? 'disabled' : ''}>스크립트 준비</button></div>
      ${unityConnection?.projectPath ? `<p class="caption unity-project-path">${escape(unityConnection.projectPath)}</p>` : ''}
      <p class="caption">가져오기와 생성 버튼은 필요한 스크립트를 자동 준비합니다. 프리팹 등록과 크기 조회에는 AI Navigation이 필요하지 않습니다. 맵 생성 시에는 AI Navigation을 설치하세요.</p>
    </details><button data-action="export" class="full" ${busy || !!exportIssue || !projectPath ? 'disabled' : ''}>ZIP으로 내보내기</button>
  </div>`;
}
function showUnityBuild(value: UnityBuildStatus) {
  const changed = JSON.stringify(unityBuild) !== JSON.stringify(value);
  unityBuild = value; unityStage = undefined;
  notify(value.state === 'completed' ? `Unity 프리팹 생성 완료: ${value.prefabPath ?? value.message}` : value.error ?? value.message, value.state === 'failed' || value.state === 'unknown');
  if (changed) render();
}
async function pollUnityBuild() {
  const desktop = requireDesktop(), deadline = Date.now() + 15 * 60 * 1000;
  while (unityBuild?.state === 'running') {
    if (Date.now() >= deadline) {
      showUnityBuild({ ...unityBuild, state: 'unknown', stage: 'unknown', message: '15분 동안 완료 응답을 받지 못했습니다. 같은 요청의 생성 결과를 다시 확인해 주세요.' });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    const current: UnityBuildStatus = unityBuild;
    try { showUnityBuild(await desktop.getUnityPrefabBuild(current.requestId)); }
    catch (error) {
      showUnityBuild({ ...current, state: 'unknown', stage: 'unknown', message: 'Unity 응답을 받지 못했습니다. 연결을 복구한 뒤 같은 요청의 상태를 확인해 주세요.', error: error instanceof Error ? error.message : String(error) });
    }
  }
}
async function runUnityAction(action: 'build' | 'status' | 'check' | 'prepare') {
  if (busy || !unitySupported() || (action === 'build' && unresolvedUnityBuild())) return;
  // The backend owns preparation and compilation so its request ID also survives a lost response.
  unityWorking = true;
  unityStage = action === 'prepare' ? 'preparing' : 'checking';
  await task(async () => {
    try {
      const desktop = requireDesktop();
      if (action === 'build') {
        unityBuild = undefined; unityConnection = undefined;
        showUnityBuild(await desktop.startUnityPrefabBuild(structuredClone(project), unityEndpoint));
        await pollUnityBuild();
      } else if (action === 'status' && unityBuild) {
        const current = unityBuild;
        try { showUnityBuild(await desktop.getUnityPrefabBuild(current.requestId)); }
        catch (error) { showUnityBuild({ ...current, state: 'unknown', stage: 'unknown', message: '같은 요청의 결과를 아직 확인할 수 없습니다.', error: error instanceof Error ? error.message : String(error) }); }
        await pollUnityBuild();
      } else {
        if (!unresolvedUnityBuild()) unityBuild = undefined;
        unityConnection = await (action === 'prepare' ? desktop.prepareUnityIntegration(unityEndpoint) : desktop.getUnityStatus(unityEndpoint));
        unityStage = undefined;
        notify(unityConnection.message, ['disconnected', 'mismatch', 'error'].includes(unityConnection.state));
        if (unityConnection.requestId) {
          const requestId = unityConnection.requestId;
          try { showUnityBuild(await desktop.getUnityPrefabBuild(requestId)); }
          catch (error) { showUnityBuild({ requestId, state: 'unknown', stage: 'unknown', projectPath: unityConnection.projectPath, message: '이전에 시작한 Unity 생성 요청의 결과를 확인해 주세요.', error: error instanceof Error ? error.message : String(error) }); }
          await pollUnityBuild();
        }
      }
    } catch (error) {
      unityConnection = { state: 'error', endpoint: unityEndpoint, projectPath: projectPath || undefined, message: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally { unityWorking = false; unityStage = undefined; }
  }, action === 'prepare' ? 'Unity 스크립트를 준비하고 컴파일을 기다립니다…' : 'Unity 연결을 확인합니다…');
}
function bindingCard(binding: AssetBinding) {
  const { role, id } = binding;
  const info = roles.find(item => item.role === role)!;
  const options = assets.map(asset => `<option value="${escape(asset.guid)}" ${binding.prefabGuid === asset.guid ? 'selected' : ''}>${escape(asset.path.replace(/^Assets\//, ''))}</option>`).join('');
  const stale = !assets.some(a => a.guid === binding.prefabGuid) ? `<option value="${escape(binding.prefabGuid)}" selected>${escape(binding.prefabPath)} · 다시 연결 필요</option>` : '';
  const placementNote = role === 'light'
    ? '벽등·문 위 조명·천장 조명은 원본 프리팹의 광원과 발광 머티리얼 설정을 사용합니다. 벽 부착물은 부착점의 +Z를 방 안쪽으로 맞추세요.'
    : role === 'floor'
    ? `기본 두께는 셀 간격의 12% (${Number((project.map.cellSize * FLOOR_THICKNESS_RATIO).toFixed(4))}m)이며 두께 배율 Y를 곱합니다. Unity에서 윗면을 셀 높이에 맞춥니다. X/Z는 원본에 적용할 절대 배율입니다.`
    : (role === 'stair' || role === 'slope')
      ? '프리팹 아랫면의 중심을 셀 바닥에 맞춥니다. Y 배율은 지정한 오름폭으로 계산하며 X/Z는 원본에 적용할 절대 배율입니다.'
      : 'Unity에서 아랫면을 셀 높이에 자동으로 맞춥니다. 배율은 원본에 적용할 절대 배율입니다.';
  return `<article class="asset-card" data-asset-card="${id}"><div class="asset-top"><span class="asset-icon">${info.symbol}</span><h3>${info.label}</h3><button class="quiet danger" data-action="remove-binding" data-id="${id}" ${disabled()}>삭제</button></div>
    <label class="field"><span>표시 이름</span><input data-binding-label="${id}" maxlength="80" value="${escape(binding.label)}" ${disabled()}></label>
    <select data-binding="${id}" aria-label="${escape(binding.label)} 프리팹" ${disabled()}>${stale}${options}</select>
    ${role === 'light' ? `<label class="field"><span>조명 사용 위치</span><select data-light-anchor="${id}" ${disabled()}><option value="" ${!binding.lightAnchor ? 'selected' : ''}>공용 · 기존 프리팹</option><option value="ceiling" ${binding.lightAnchor === 'ceiling' ? 'selected' : ''}>천장용 조명</option><option value="wall" ${binding.lightAnchor === 'wall' ? 'selected' : ''}>벽용 조명</option></select></label>` : ''}
    ${renderPropLibraryFields(binding,busy)}${renderWallMountFields(binding,busy)}<details><summary>크기 · 기준점 조정</summary><p class="subtle">${info.note}. 셀 간격 ${project.map.cellSize}m. ${placementNote} Y 오프셋으로 배치 높이를 추가 조정합니다.</p>
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
function renderFurnishing() {
  const chosen = project.bindings.filter(binding => !binding.wallMount && (binding.role === 'prop' && furnishProps || binding.role === 'decoration' && furnishDecorations));
  const measured = chosen.filter(binding => binding.prop?.size).length;
  const d = project.settings.designer ?? DEFAULT_DESIGNER;
  const layout = project.settings.designer?.propLayout ?? 'legacy';
  const report = furnishingResult?.map === project.map ? furnishingResult.result : undefined;
  const rearranged = report && 'movedProps' in report ? report as ReturnType<typeof rearrangeMapProps> : undefined;
  return `<details class="feature-group" open><summary>지형 유지 · 소품과 장식 채우기</summary>
    <div class="tool-buttons"><label><input type="checkbox" data-furnish-control="props" ${furnishProps ? 'checked' : ''} ${disabled()}> 소품</label><label><input type="checkbox" data-furnish-control="decorations" ${furnishDecorations ? 'checked' : ''} ${disabled()}> 장식</label></div>
    <label class="field"><span>추가 배치 방식</span><select data-furnish-control="layout" ${disabled()}><option value="grouped" ${layout === 'grouped' ? 'selected' : ''}>구역별 묶음 구성</option><option value="balanced" ${layout === 'balanced' ? 'selected' : ''}>자동 균형 구성</option><option value="legacy" ${layout === 'legacy' ? 'selected' : ''}>기존 개수 유지 · 추가는 균형 구성</option></select></label>
    ${furnishProps ? `<label class="field"><span>소품 목표 바닥 점유율 (%)</span><input type="number" data-furnish-control="coverage" min="1" max="30" step="1" value="${d.propCoverage ?? 12}" ${disabled()}></label>` : ''}
    ${furnishDecorations ? `<label class="field"><span>장식 배치 밀도 (%)</span><input type="number" data-furnish-control="density" min="1" max="100" step="1" value="${d.decorationDensity ?? d.fixtureDensity}" ${disabled()}></label>` : ''}
    <p class="caption">선택한 역할의 에셋 ${chosen.length}종 · 크기 등록 ${measured}종${chosen.length > measured ? ` · 크기 미확정 ${chosen.length - measured}종 제외` : ''}</p>
    <button data-action="furnish-map" class="primary full" ${busy || !measured ? 'disabled' : ''}>현재 맵에 소품·장식 자동 배치</button>
    <p class="caption">지형·출입문·확정된 기존 배치물을 유지하고 목표까지 추가합니다. 미지정 임시 표시는 실측 배치로 전환합니다. 생성 당시 꺼둔 역할도 여기서 선택할 수 있습니다. 실제 크기와 통행·회피 공간을 검사하며, 공간이 부족하면 가능한 만큼 배치합니다. AI 호출 없이 실행하며 되돌릴 수 있습니다.</p>
    <label class="furnishing-choice"><input type="checkbox" data-furnish-control="includeUnknown" ${rearrangeUnknown ? 'checked' : ''} ${disabled()}> 출처 불명 소품도 재정리</label>
    <button data-action="rearrange-props" class="full" ${busy || !measured ? 'disabled' : ''}>자동 소품 재정리</button>
    <p class="caption">자동 생성한 소품과 장식을 구역별 묶음으로 다시 구성합니다. 수동 배치·잠금·직접 지정한 소품은 보존합니다. 출처 불명 소품은 위 항목을 선택한 경우에만 포함합니다. 다음 생성의 배치 방식은 바꾸지 않으며, 되돌리기 한 번으로 복원할 수 있습니다.</p>
    ${report ? `<div data-furnish-result role="status"><p class="caption"><strong>${rearranged ? `묶음 ${rearranged.groupCount}개 · 이동 ${rearranged.movedProps}개 · 보존 ${rearranged.preservedProps}개 · 추가 ${rearranged.addedProps + rearranged.addedDecorations}개 · 제외 ${rearranged.removedProps}개${rearranged.unchanged ? ' · 변경 없음' : ''}` : report.unchanged ? '추가 배치 없음' : `소품 ${report.addedProps}개 · 장식 ${report.addedDecorations}개 추가`}</strong> · 이번 배치에 ${report.usedBindingIds.length}종 사용</p>${report.issues.length ? `<ul>${report.issues.map(issue => `<li>${escape(issue.message)}</li>`).join('')}</ul>` : ''}</div>` : ''}
  </details>`;
}
function deletionTargets() {
  return project.bindings.filter(binding => bulkDeleteScope === 'all'
    || (bulkDeleteScope === 'props' ? ['prop', 'decoration', 'vegetation'].includes(binding.role) : binding.role === bulkDeleteScope));
}
function deletionScopeLabel() {
  return bulkDeleteScope === 'all' ? '모든 에셋' : bulkDeleteScope === 'props' ? '소품·장식·식생' : roles.find(item => item.role === bulkDeleteScope)!.label;
}
function renderBulkAssetDeletion() {
  const count = deletionTargets().length;
  return `<section class="asset-adder asset-deletion" aria-label="에셋 일괄 삭제"><h3>에셋 일괄 삭제</h3>
    <label class="field"><span>삭제할 종류</span><select id="bulkDeleteScope" ${disabled()}><option value="all" ${bulkDeleteScope === 'all' ? 'selected' : ''}>모든 에셋</option><option value="props" ${bulkDeleteScope === 'props' ? 'selected' : ''}>소품·장식·식생 전체</option>${roles.map(item => `<option value="${item.role}" ${bulkDeleteScope === item.role ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label>
    <button class="danger full" data-action="bulk-delete-bindings" ${busy || !count ? 'disabled' : ''}>${deletionScopeLabel()} ${count}개 일괄 삭제…</button>
    <p class="caption">등록 목록과 해당 프리팹에 연결된 소품 배치를 정리합니다. 지형과 기본 배치 지점, Unity 원본 파일은 유지합니다. 삭제 전에 개수를 확인하고, 되돌리기로 복원할 수 있습니다.</p></section>`;
}
function renderAssets() {
  return `<p class="eyebrow">ASSET LIBRARY</p><div class="panel-heading"><h2>등록한 에셋</h2><span class="step-num" data-registered-asset-count="${project.bindings.length}">${project.bindings.length}개</span></div><p class="panel-intro">Unity에 표시한 여러 종류의 프리팹을 한 번에 가져오세요.<br>크기 JSON 가져오기와 개별 추가도 사용할 수 있습니다.</p><button class="full" data-action="scan" ${disabled()}>＋ Unity 프로젝트 폴더 연결</button>
    <p class="asset-project" data-project-prefab-count="${assets.length}" title="${escape(projectPath)}">${projectPath ? `${escape(projectPath.split(/[\\/]/).pop())} · 선택용 목록 ${assets.length}개` : '아직 연결된 프로젝트가 없습니다'}</p><p class="caption">폴더 연결은 선택용 목록만 읽습니다. 실제 등록 수는 위의 ‘등록한 에셋’에서 확인하세요.</p>
    <section class="asset-adder" aria-label="Unity 표시 프리팹 가져오기"><h3>Unity에서 한 번에 가져오기</h3>
      <button class="full" data-action="import-unity-asset-catalog" ${busy || !projectPath || !api?.importUnityAssetCatalog || unresolvedUnityBuild() ? 'disabled' : ''}>표시된 프리팹 가져오기</button>
      <p class="caption">Unity와 MCP를 켜고, 사용할 프리팹 루트의 Baekho Map Asset에서 등록 여부와 종류를 지정하세요. 바닥·벽·문·계단·소품 등 모든 종류를 함께 가져옵니다. 처음에는 아래 ‘Unity MCP 연결 설정 → 스크립트 준비’를 실행하세요.</p>
      <p class="caption">다시 가져오면 새 프리팹을 추가하고 크기·벽 연결 정보를 갱신합니다. 앱에서 수정한 종류·배율·배치 조건은 유지합니다.</p>
      ${unityCatalogReport ? `<div role="status" data-unity-catalog-result><p class="caption">최근 가져오기 결과</p><p>${escape(unityCatalogReport.summary)}</p>${unityCatalogReport.warnings.map(warning => `<p class="caption">${escape(warning)}</p>`).join('')}${unityCatalogReport.counts.length ? `<details><summary>종류별 등록 결과</summary><div class="catalog-details"><table class="catalog-counts"><thead><tr><th>종류</th><th>추가</th><th>갱신</th></tr></thead><tbody>${unityCatalogReport.counts.map(count => `<tr><td>${escape(count.label)}</td><td>${count.added}</td><td>${count.updated}</td></tr>`).join('')}</tbody></table></div></details>` : ''}${unityCatalogReport.details.length ? `<details><summary>제외 항목 ${unityCatalogReport.details.length}개</summary><ul class="catalog-details">${unityCatalogReport.details.map(item => `<li><strong>${escape(item.path)}</strong><br>${escape(item.reason)}</li>`).join('')}</ul></details>` : ''}</div>` : ''}
    </section>
    ${renderBulkAssetDeletion()}
    <div class="asset-adder"><label class="field"><span>추가할 에셋의 종류</span><select id="newAssetRole" ${disabled()}>${roles.map(r=>`<option value="${r.role}" ${r.role===newAssetRole?'selected':''}>${r.label}</option>`).join('')}</select></label><label class="field"><span>프리팹</span><select id="newAssetGuid" ${busy || !assets.length?'disabled':''}><option value="">프리팹 선택</option>${assets.map(a=>`<option value="${a.guid}" ${a.guid===newAssetGuid?'selected':''}>${escape(a.path.replace(/^Assets\//,''))}</option>`).join('')}</select></label><button data-action="add-binding" class="secondary full" ${busy || !newAssetGuid || project.bindings.length>=MAX_BINDINGS?'disabled':''}>＋ 에셋 추가</button><p class="caption">최대 ${MAX_BINDINGS}개. 새 소품은 종류·테마·방 용도·크기로 검사하고 가중 선택합니다. 기존 셀 에셋의 순환 선택은 유지합니다.</p></div>
    <div class="asset-adder"><label class="field"><span>일괄 등록할 새 에셋의 종류</span><select id="propCatalogRole" ${disabled()}>${[['prop','소품'],['decoration','장식'],['vegetation','식생'],['light','조명']].map(([role,label])=>`<option value="${role}" ${propCatalogRole===role?'selected':''}>${label}</option>`).join('')}</select></label><button data-action="import-prop-catalog" class="full" ${disabled()}>크기 가져오기 · 프리팹 일괄 등록</button><p class="caption" data-prop-catalog-count="${importedPropCatalog?.assets.length ?? 0}">Unity의 Project 창에서 사용할 .prefab 파일만 선택하고 Assets → Baekho → Export Prop Bounds Catalog로 내보내세요. 일괄 등록은 JSON에 포함된 프리팹만 처리합니다. 프로젝트 미연결 시 폴더 선택 창이 열립니다. 기존 에셋은 중복 추가하지 않고 소품·장식·식생·조명의 크기와 벽 부착 정보를 갱신하며 종류와 배율은 유지합니다.${importedPropCatalog ? ` 가져온 크기 ${importedPropCatalog.assets.length}개. 등록한 에셋과 크기는 맵에 저장됩니다.` : ''}</p><p class="caption">등록 후 아래 자동 배치 버튼을 누르세요. 소품과 장식을 나누려면 Unity에서 종류별로 선택해 JSON을 각각 내보내고, 위 종류를 바꿔 가져오세요. 크기가 없는 소품은 공간 검증 자동 배치에서 제외합니다.</p></div>${renderBatchScale()}<div class="asset-counts">${roles.map(r=>`${r.label} ${project.bindings.filter(b=>b.role===r.role).length}`).join(' · ')}</div>
    ${renderFurnishing()}${designer.renderWallTools()}${project.bindings.length ? project.bindings.map(bindingCard).join('') : '<p class="select-empty">등록한 에셋이 없습니다.<br>크기 JSON을 가져오거나 프리팹을 추가하세요.</p>'}`;
}
function cellRoles(_tile: Tile, x = selected?.x, row = selected?.row): AssetRole[] {
  if (x === undefined || row === undefined) return [];
  return roles.map(item => item.role).filter(role => cellHasRole(project.map, x, row, role));
}
function renderCellAssets(x:number,row:number,tile:Tile) {
  const hasProp=project.map.propInstances?.some(p=>p.cells.some(c=>c.x===x&&c.row===row));
  return cellRoles(tile).filter(role=>!(hasProp&&['prop','decoration','vegetation'].includes(role))).map(role=>{
    const override=project.map.assetOverrides.find(o=>o.x===x&&o.row===row&&o.role===role);
    const candidates=project.bindings.filter(b=>b.role===role);
    const effective=resolveBinding(project.map, project.bindings,x,row,role);
    return `<label class="field"><span>${roles.find(r=>r.role===role)!.label} 에셋</span><select data-cell-binding="${role}" ${disabled()}><option value="">자동 순환</option>${candidates.map(b=>`<option value="${b.id}" ${b.id===override?.bindingId?'selected':''}>${escape(b.label)}</option>`).join('')}</select><small>적용: ${effective?escape(effective.label):'해당 종류의 에셋을 등록하세요'}</small></label>`;
  }).join('');
}
function renderSelectedProp() {
  if(!selected)return '';
  const prop=project.map.propInstances?.find(p=>p.cells.some(c=>c.x===selected!.x&&c.row===selected!.row));
  const measured=project.bindings.filter(b=>!b.wallMount&&['prop','decoration','vegetation'].includes(b.role)&&b.prop?.size);
  const choices=measured.map(b=>`<option value="${escape(b.id)}" ${prop?.bindingId===b.id?'selected':''}>${roles.find(r=>r.role===b.role)?.label} · ${escape(b.label)} · ${escape(b.prop!.category)}</option>`).join('');
  if(prop){const binding=project.bindings.find(b=>b.id===prop.bindingId),locked=prop.cells.some(designer.isLocked);
    return `<div class="section-line"></div><h3>선택한 소품</h3><p><strong>${escape(binding?.label??prop.bindingId)}</strong> · ${escape(prop.category)}</p><p class="caption" data-selected-prop-size>측정된 배치 크기 ${prop.size.x.toFixed(2)} × ${prop.size.y.toFixed(2)} × ${prop.size.z.toFixed(2)}m (가로 X · 높이 Y · 깊이 Z) / ${prop.cells.length}셀<br>${roles.find(r=>r.role===(prop.role??binding?.role??'prop'))?.label??'소품'} · ${prop.blocksMovement?'통행 차단':'통행 허용'} · ${prop.anchor==='ceiling'?'천장':prop.anchor==='wall'?'벽':'바닥'} 부착 · ID ${escape(prop.id)}</p>
      <label class="field"><span>프리팹 교체 · 전체 점유 영역을 다시 검사</span><select data-prop-instance-binding="${escape(prop.id)}" ${busy||locked?'disabled':''}>${measured.some(b=>b.id===prop.bindingId)?'':`<option value="${escape(prop.bindingId)}" selected>${escape(binding?.label??prop.bindingId)} · 크기 확인 필요</option>`}${choices}</select></label>
      <button data-action="refit-prop-instance" data-id="${escape(prop.id)}" class="secondary full" ${busy||locked||!binding?.prop?.size?'disabled':''}>현재 프리팹 다시 맞추기</button>
      <button data-action="remove-prop-instance" data-id="${escape(prop.id)}" class="danger full" ${busy||locked?'disabled':''}>이 소품 삭제 · 바닥 유지</button>`;
  }
  if(!'.P'.includes(project.map.rows[selected.row][selected.x]))return '';
  return `<div class="section-line"></div>${project.map.rows[selected.row][selected.x]==='P'?'<p class="caption" data-selected-prop-unmeasured><strong>크기 미확정 · 임시 표시</strong><br>이 박스는 실제 프리팹 크기를 나타내지 않습니다. 측정된 프리팹을 선택해 배치하세요.</p>':''}<h3>소품 직접 배치</h3><label class="field"><span>측정된 프리팹</span><select data-insert-prop ${busy||designer.isLocked(selected)?'disabled':''}><option value="">배치할 소품을 선택하세요</option>${choices}</select></label><p class="caption">크기·평탄한 바닥·천장·잠금·통행을 검사한 뒤 하나의 소품으로 배치합니다.${measured.length?'':' 먼저 에셋 탭에서 소품의 원본 크기를 등록하세요.'}</p>`;
}
function renderPropCoverage() {
  if (!project.settings.designer?.props && !project.map.propInstances?.length && !project.map.rows.some(row => row.includes('P'))) return '';
  const selection = designer.selection();
  const region = selection && selection.width * selection.height > 1 ? selection : undefined;
  const report = getPropCoverageReport(project.map, project.settings, project.bindings, region);
  const target = report.mode !== 'legacy' ? ` · 목표 ${report.targetPercent}%${report.mode === 'grouped' ? ' · 구역별 묶음' : ''}` : ' · 기존 개수 유지';
  const actual = report.actualPercent === null ? '계산 불가' : `${report.actualPercent.toFixed(1)}%`;
  return `<div class="validation" data-prop-coverage><strong>${region?'선택 영역':'현재 맵'} 소품 점유율 ${actual}${target}</strong><p class="caption">${report.measurable?`소품 ${report.occupiedArea.toFixed(1)}m² / 바닥 ${report.floorArea.toFixed(1)}m² · 장식·식생 제외`:'크기 미확정 소품은 측정이 필요합니다.'}</p>${report.reasons.length?`<ul>${report.reasons.map(reason=>`<li>${escape(reason)}</li>`).join('')}</ul>`:''}<p class="caption">설정 변경은 다음 생성부터 적용됩니다.</p></div>`;
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
  const rightScroll = renderedRightTab === rightTab ? document.querySelector('.right-panel')?.scrollTop ?? 0 : 0;
  const leftScroll = document.querySelector('.left-panel')?.scrollTop ?? 0;
  renderedRightTab = rightTab;
  document.querySelectorAll<HTMLDetailsElement>('.left-panel details,.right-panel details').forEach(detail => detailState.set(detailKey(detail), detail.open));
  gallery.dispose();
  if (preview) { previewState = preview.getState(); preview.dispose(); preview = undefined; }
  const map = project.map;
  const displayImage = project.generationDraft?.imageDataUrl ?? project.blueprintDataUrl;
  const issues = [...validateMap(map, project.bindings), ...(project.settings.designer?.propLayout === 'grouped' ? getCompositionIssues(project.bindings, project.settings) : [])];
  const errors = issues.filter(i => i.severity === 'error');
  let exportIssue = '';
  try { buildManifest(map, project.bindings); } catch (e) { exportIssue = e instanceof Error ? e.message : String(e); }
  const occupied = map.rows.join('').replace(/_/g, '').length;
  const walkable = map.rows.join('').replace(/[^.DRB]/g, '').length;
  const surfaceHeights = map.elevations.flatMap((row,z) => row.filter((_height,x) => map.rows[z][x] !== '_'));
  const low = Math.min(0,...surfaceHeights), high = Math.max(0,...surfaceHeights,...map.ramps.map(r => map.elevations[r.row][r.x]+r.rise));
  if (selected && (selected.x >= map.width || selected.row >= map.height)) selected = null;
  root.innerHTML = `
    <header class="topbar"><div class="brand-mark">b</div><div class="brand">BAEKHO<small>WORLD BUILDING TOOLS</small></div><span class="top-divider"></span><span class="top-title">Map Forge <span class="pill">PREVIEW 0.8.0</span></span><span class="spacer"></span>
      <button data-action="open" ${disabled()}>↗ 프로젝트 열기</button><button data-action="save" ${busy || view === 'variants' ? 'disabled' : ''}>${dirty ? '● ' : ''}저장</button><button data-action="codex" ${disabled()}><span class="status-dot" style="background:${codex.state === 'ready' ? '#638a58' : '#bb9871'}"></span>${codexLabel()}</button>
    </header>
    ${recovery ? '<div class="recovery-note">이전 작업의 자동 복구 사본이 있습니다.<button data-action="recover">복구</button><button data-action="dismiss-recovery">닫기</button></div>' : ''}${!api ? '<div class="browser-note">브라우저 미리보기입니다. 파일 연결과 AI 생성은 데스크톱 앱에서 사용할 수 있습니다.</div>' : ''}
    <main class="main ${view === 'variants' ? 'variants-mode' : ''}">
      <aside class="left-panel"><p class="eyebrow">01 / CREATE</p><div class="panel-heading"><h2>어떤 공간을 만들까요?</h2><span class="step-num">3D</span></div><p class="panel-intro">서로 이어 붙일 입체 맵을 설계하세요.<br>여러 연결문과 높낮이를 함께 만듭니다.</p>
        ${renderConceptControls(project.settings,busy)}${renderGenerationControls(project.settings,busy)}${designer.renderGeneration()}
        <div class="pair"><label class="field"><span>새 설계 가로 (셀)</span><input id="width" type="number" min="8" max="40" value="${project.settings.width}" ${disabled()}></label><label class="field"><span>새 설계 세로 (셀)</span><input id="height" type="number" min="8" max="40" value="${project.settings.height}" ${disabled()}></label></div>
        <label class="field"><span>새 생성 셀 간격 (m)</span><input id="cellSize" type="number" min="0.25" max="10" step="0.25" value="${project.settings.cellSize}" ${disabled()}><small>다음 생성에 적용 · 현재 맵 크기는 유지</small></label>
        <div class="pair"><label class="field"><span>기본 고저차 (m)</span><input id="elevationStep" type="number" min="0.25" max="10" step="0.25" value="${project.settings.elevationStep}" ${disabled()}></label><label class="field"><span>걸어넘을 단차 (m)</span><input id="maxStepHeight" type="number" min="0.05" max="1" step="0.05" value="${map.maxStepHeight}" ${disabled()}></label></div>
        <label class="field"><span>AI로 만들 연결문 개수</span><input id="connectionCount" type="number" min="1" max="16" value="${project.settings.connectionCount}" ${disabled()}><small>1~16개 · 실제 배치는 연결문 탭에서 추가·삭제</small></label>
        ${renderConnectionSizeControls(project.settings,busy)}
        <details class="advanced"><summary>Codex 모델 설정</summary><label class="field"><span>Codex 모델 (선택)</span><input id="codexModel" list="codex-models" maxlength="100" placeholder="Codex 기본 모델 사용" value="${escape(project.settings.codexModel)}" ${disabled()}><datalist id="codex-models">${codexModelOptions()}</datalist></label><p class="caption">비워 두면 Codex 기본 모델을 사용합니다. 이미지 생성은 Codex의 내장 도구를 사용합니다.</p></details>
        <div class="left-actions"><button class="primary full" data-action="generate" ${disabled()}>${busy ? '<span class="spinner"></span>' : '✦ '}조건으로 맵 생성</button><details class="advanced"><summary>설계도 단계별 작업</summary><button class="full" data-action="generate-image" ${disabled()}>설계도만 생성</button><button class="secondary full" data-action="extract" ${busy || !displayImage ? 'disabled' : ''}>설계도 분석 → 배치 만들기</button></details>${busy && !unityWorking && taskCancelable ? '<button data-action="cancel" class="danger full">요청 취소</button>' : ''}</div>
        <div class="variant-create"><label class="field"><span>한 번에 비교할 맵 후보</span><select id="variantCount" ${disabled()}>${[2,3,4,5,6,7,8].map(count => `<option value="${count}" ${variantCount === count ? 'selected' : ''}>${count}개</option>`).join('')}</select></label><button class="secondary full" data-action="generate-variants" ${disabled()}>✦ 여러 후보 생성</button><p class="caption">${conceptMode(project.settings)==='ai'?'후보마다 다른 컨셉을 작성한 뒤 설계도와 배치를 생성합니다.':'직접 입력한 컨셉 안에서 방 형태와 배치를 다르게 만듭니다.'} 현재 편집 맵은 유지됩니다.</p></div>
        <p class="generation-state">Codex가 컨셉 작성·이미지 생성·배치 분석을 진행합니다.<br>직접 입력을 선택하면 컨셉 작성은 생략합니다.</p>
        <div class="step-list"><span class="${project.blueprintDataUrl ? 'complete' : ''}">① 설계도</span><span>→</span><span class="${!isSample ? 'complete' : ''}">② 배치</span><span>→</span><span>③ 프리팹</span></div>
        <div class="section-line"></div><p class="eyebrow">QUICK START</p><p class="caption" style="margin:10px 0">Codex 연결 전에도 샘플 맵을 편집하고<br>에셋 연결과 내보내기를 확인할 수 있어요.</p><button data-action="demo" class="full" ${disabled()}>샘플 맵 불러오기</button>
      </aside>
      <section class="workspace"><div class="workspace-heading"><div><p class="eyebrow" style="margin-bottom:6px">MAP WORKSPACE</p><h1>작은 설계에서, 하나의 세계로.</h1></div><span class="spacer"></span></div>
        <div class="row ${view === 'variants' ? 'hide' : ''}" style="margin-bottom:8px"><input class="map-name" id="mapName" aria-label="맵 이름" maxlength="80" value="${escape(map.name)}" ${disabled()}><span class="pill">${isSample ? '샘플 · AI 생성 전' : '편집 중'}</span><span class="spacer"></span><small class="num">${map.width} × ${map.height}</small></div>
        <nav class="tabs" aria-label="맵 보기"><button class="tab ${view === '3d' ? 'active' : ''}" data-view="3d">◇ 3D 미리보기</button><button class="tab ${view === 'grid' ? 'active' : ''}" data-view="grid">▦ 배치 편집</button><button class="tab ${view === 'image' ? 'active' : ''}" data-view="image">▧ AI 설계도</button><button class="tab ${view === 'variants' ? 'active' : ''}" data-view="variants">후보 비교${candidates.length ? ` · ${candidates.filter(candidate => candidate.status === 'ready').length}/${candidates.length}` : ''}</button><span class="spacer"></span><button data-action="undo" title="되돌리기 (Ctrl+Z)" ${!history.length || busy || view === 'variants' ? 'disabled' : ''}>↶</button><button data-action="redo" title="다시 실행 (Ctrl+Shift+Z)" ${!future.length || busy || view === 'variants' ? 'disabled' : ''}>↷</button></nav>
        ${view === 'variants' ? '' : designer.renderToolbar()}<div class="viewport ${view === 'variants' ? 'variants-viewport' : ''}" id="viewport">${view === 'variants' ? gallery.render() : view === '3d' ? '<div class="preview-host" id="preview"></div><span class="view-badge">블록아웃 · Y 높이 · 실제 에셋은 Unity에서 적용</span><span class="view-hint">클릭 선택 · 드래그 회전 · 휠 확대 · 우클릭 이동</span><span class="view-tag">3D HEIGHT EDITOR</span>' : view === 'grid' ? `<span class="view-badge">${editMode==='select'?'셀 선택':editMode==='height'?`Y = ${brushHeight}m 높이 칠하기`:`${tileLabels[brush]} 배치`} · 숫자는 높이(m)</span><div class="orientation"><strong>↑</strong>+ Z</div><div class="map-svg-wrap"><svg class="map-svg" id="map-svg" role="img" aria-label="편집 가능한 맵 격자" viewBox="0 0 ${map.width} ${map.height}" preserveAspectRatio="xMidYMid meet"></svg></div><div class="brush-toolbar" aria-label="배치 도구"><button data-edit-mode="select" class="${editMode==='select'?'selected':''}">선택</button><button data-edit-mode="height" class="${editMode==='height'?'selected':''}">높이</button>${(Object.keys(tileLabels) as Tile[]).map(tile => `<button class="${editMode==='paint' && tile === brush ? 'selected' : ''}" data-brush="${tile}" title="${tileLabels[tile]}" ${disabled()}>${tileLabels[tile]}</button>`).join('')}</div>` : displayImage ? `<img class="blueprint" src="${escape(displayImage)}" alt="AI가 생성한 고저차 있는 입체 맵 설계도"><span class="view-badge">입체 설계도 · 높이와 계단을 포함해 분석</span>` : '<div class="empty-image"><span class="empty-symbol">▧</span><strong>Your next world starts here.</strong><p>왼쪽에서 생성 조건을 고르고<br>AI가 컨셉과 입체 설계도를 만들게 해 주세요.</p><span class="pill">입체 이미지 → 높이·계단 분석 → 에셋 조립</span></div>'}</div>
        ${view === 'variants' ? '' : `<div class="concept-results" aria-live="polite">${renderConceptResult(project.concept,'이 맵에 사용한 컨셉','map')}${attemptConcept ? renderConceptResult(attemptConcept,'이번 생성에 선택한 컨셉','attempt') : renderConceptResult(project.generationDraft?.concept,'설계도 초안에 사용한 컨셉','draft')}</div>`}
        <div class="legend ${view === 'variants' ? 'hide' : ''}">${(['.', '#', 'D', 'P', 'R', 'B'] as Tile[]).map(tile => `<span><i style="background:${colors[tile]}"></i>${tileLabels[tile]}</span>`).join('')}<span><i style="background:#bd9878"></i>장식</span><span><i style="background:#76a86f"></i>식생</span></div>
        <div class="metrics ${view === 'variants' ? 'hide' : ''}"><div class="metric"><span>맵 크기</span><strong class="num">${map.width * map.cellSize} × ${map.height * map.cellSize}<small> m</small></strong></div><div class="metric"><span>높이 범위</span><strong class="num">${low} ~ ${high}<small> m</small></strong></div><div class="metric"><span>통행 면적 / 배치 셀</span><strong class="num">${(walkable*map.cellSize*map.cellSize).toFixed(1)}<small> m² / ${occupied}</small></strong></div></div>
        <div class="bottom-note ${view === 'variants' ? 'hide' : ''}"><span>중앙 원점 · X 좌우 / Y 높이 / Z 앞뒤 · 계단 ${map.ramps.length}개 · 연결문 ${map.connections.length}개</span><span>STUDIO BAEKHO / MAP FORGE</span></div>
      </section>
      <aside class="right-panel ${view === 'variants' ? 'hide' : ''}"><nav class="inspector-tabs"><button data-right-tab="cell" class="${rightTab==='cell'?'selected':''}">셀 편집</button><button data-right-tab="connections" class="${rightTab==='connections'?'selected':''}">연결문</button><button data-right-tab="design" class="${rightTab==='design'?'selected':''}">영역·배치</button><button data-right-tab="assets" class="${rightTab==='assets'?'selected':''}">에셋</button></nav>${rightTab==='cell' ? renderCellInspector() : rightTab==='connections' ? renderConnections() : rightTab==='design' ? designer.renderInspector() : renderAssets()}
        ${wallGenerationReport?.map === map ? `<div class="validation" data-wall-generation-result><strong>마지막 생성 · 벽 부착물 ${wallGenerationReport.count}개${wallGenerationReport.temporary ? ` · 임시 ${wallGenerationReport.temporary}개` : ''}</strong>${wallGenerationReport.issues.length ? `<ul>${wallGenerationReport.issues.map(issue => `<li>${escape(issue.message)}</li>`).join('')}</ul>` : `<p class="caption">${wallGenerationReport.count ? '벽 배치 조건 검사를 마쳤습니다.' : '이번 생성에 사용할 벽 부착물이 없습니다. 벽용 에셋 등록과 생성 배치 옵션을 확인하세요.'}</p>`}</div>` : ''}
        ${renderPropCoverage()}<div class="validation ${errors.length ? 'invalid' : ''}"><strong>${errors.length ? `△ 배치 확인 필요 (${errors.length})` : '✓ 맵 연결문과 내부 경로 연결됨'}</strong><ul>${issues.length ? issues.slice(0,8).map(issue => `<li><button data-action="issue-focus" data-message="${escape(issue.message)}">${escape(issue.message)}</button></li>`).join('') : `<li>걸어넘을 단차 ${map.maxStepHeight}m 기준으로 모든 연결문과 내부 통행 셀이 연결됩니다.</li>`}</ul></div>
        ${renderUnityExport(exportIssue)}
      </aside>
    </main><footer class="footer ${statusError ? 'error' : ''}"><span>${busy ? '<span class="spinner"></span>' : '●'}</span><span id="status" role="status">${escape(status)}</span><span class="spacer"></span><strong>LOCAL WORKSPACE</strong></footer>
    <dialog id="discard-dialog"><h2>저장하지 않은 변경이 있습니다</h2><p>다른 프로젝트를 열면 현재 작업이 사라집니다. 먼저 저장하려면 돌아가기를 선택해 주세요.</p><form method="dialog"><div class="row"><span class="spacer"></span><button value="cancel" autofocus>돌아가기</button><button value="discard" class="danger">저장하지 않고 열기</button></div></form></dialog>
    <dialog id="replace-variants-dialog"><h2>새 후보 묶음을 만들까요?</h2><p>아직 저장하지 않은 후보가 있습니다. 새로 만들면 현재 후보 목록이 교체됩니다. 보관할 후보는 먼저 선택한 맵 저장으로 저장하세요.</p><form method="dialog"><div class="row"><span class="spacer"></span><button value="cancel" autofocus>돌아가기</button><button value="replace" class="danger">후보 교체하고 생성</button></div></form></dialog>
    <dialog id="asset-delete-dialog" aria-labelledby="asset-delete-title"><h2 id="asset-delete-title">${escape(pendingAssetDeletion?.label ?? '에셋')} 등록을 삭제할까요?</h2><p data-delete-summary>등록 ${pendingAssetDeletion?.ids.length ?? 0}개 · 연결된 소품·벽 부착물 ${pendingAssetDeletion?.placements ?? 0}개를 삭제합니다.</p><p>바닥·벽·계단·연결문과 기본 배치 지점은 유지합니다. 셀과 배치물에 직접 지정했던 프리팹은 자동 선택으로 돌아갑니다. Unity 프로젝트의 원본 파일은 유지됩니다.</p><p>한 번의 되돌리기(Ctrl+Z)로 등록과 배치를 함께 복원할 수 있습니다.</p><div class="row"><span class="spacer"></span><button type="button" value="cancel" data-action="cancel-delete-bindings" autofocus>취소</button><button type="button" value="delete" data-action="confirm-delete-bindings" class="danger">등록 ${pendingAssetDeletion?.ids.length ?? 0}개 삭제</button></div></dialog>
    <dialog id="codex-dialog">${renderCodexDialog()}</dialog>`;
  const codexDialog = document.querySelector<HTMLDialogElement>('#codex-dialog')!;
  document.querySelectorAll<HTMLDetailsElement>('.left-panel details,.right-panel details').forEach(detail => { const open = detailState.get(detailKey(detail)); if (open !== undefined) detail.open = open; });
  const rightPanel = document.querySelector('.right-panel'), leftPanel = document.querySelector('.left-panel');
  if (rightPanel) rightPanel.scrollTop = rightScroll;
  if (leftPanel) leftPanel.scrollTop = leftScroll;
  codexDialog.addEventListener('cancel', () => closeCodexDialog());
  if (codexDialogOpen) codexDialog.showModal();
  const assetDeleteDialog = document.querySelector<HTMLDialogElement>('#asset-delete-dialog')!;
  assetDeleteDialog.addEventListener('cancel', event => { event.preventDefault(); pendingAssetDeletion = null; render(); });
  if (pendingAssetDeletion) assetDeleteDialog.showModal();
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
  const propCells = new Map((project.map.propInstances ?? []).flatMap(prop => prop.cells.map(cell => [`${cell.x}:${cell.row}`, prop.role ?? project.bindings.find(binding => binding.id === prop.bindingId)?.role ?? 'prop'] as const)));
  const propAnchors = new Set((project.map.propInstances ?? []).map(prop => `${prop.x}:${prop.row}`));
  svg.innerHTML = project.map.rows.map((row,z) => Array.from(row).map((tile,x) => {
    const isSelected = selected?.x === x && selected.row === z;
    const inRegion = region && x >= region.x && z >= region.row && x < region.x + region.width && z < region.row + region.height;
    const locked = designer.isLocked({x,row:z});
    const height = project.map.elevations[z][x];
    const ramp = project.map.ramps.find(r=>r.x===x&&r.row===z);
    const port = connectionAt(project.map,x,z);
    const propRole = propCells.get(`${x}:${z}`),fill = propRole === 'vegetation' ? '#76a86f' : propRole === 'decoration' ? '#bd9878' : colors[tile as Tile];
    const text = port ? directions.find(d=>d.value===port.direction)!.arrow : tile === 'R' ? ({0:'↑',90:'→',180:'↓',270:'←'}[ramp?.direction ?? 0]) : propRole === 'vegetation' || propRole === 'decoration' ? propAnchors.has(`${x}:${z}`) ? propRole === 'vegetation' ? '♣' : '✧' : '' : 'DPB'.includes(tile) ? tile : '';
    return `<g><rect x="${x + 0.03}" y="${z + 0.03}" width=".94" height=".94" rx=".07" fill="${fill}" ${isSelected||inRegion?'stroke="#f2cb66" stroke-width=".1"':locked?'stroke="#ad7199" stroke-width=".08"':port?'stroke="#267f96" stroke-width=".08"':''}></rect>${text ? `<text x="${x+.5}" y="${z+.51}" text-anchor="middle" font-size=".38" fill="#ffffff" pointer-events="none">${text}</text>` : ''}${locked?`<text x="${x+.2}" y="${z+.3}" font-size=".22">◆</text>`:''}${tile!=='_'?`<text x="${x+.5}" y="${z+.83}" text-anchor="middle" font-size=".23" fill="${tile==='.'&&!propRole?'#596b50':'#ffffff'}" pointer-events="none">${height}</text>`:''}</g>`;
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
  const finish = () => { if (painting) { painting = false; if (changed&&before) {try{project.map=synchronizeStructures(project.map);const errors=[...propValidationIssues(project.map,project.bindings),...wallMountIssues(project.map,project.bindings)].filter(i=>i.severity==='error');if(errors.length)throw new Error(errors[0].message);history.push(before);if(history.length>50)history.shift();future.length=0;dirty=true;queueRecovery();notify('배치를 수정하고 자동 천장·벽을 갱신했습니다.');}catch(error){Object.assign(project,before);notify(error instanceof Error?error.message:String(error),true);}}render(); } };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);
}
function restore(edit:EditSnapshot) { Object.assign(project,structuredClone(edit)); attemptConcept=undefined; dirty=true; queueRecovery();render(); }
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
  if (action === 'cancel-delete-bindings') { pendingAssetDeletion = null; render(); return; }
  if (action === 'bulk-delete-bindings') {
    const ids = deletionTargets().map(binding => binding.id);
    if (!ids.length) return;
    try {
      const result = removeAssetBindings(project, ids);
      pendingAssetDeletion = { ids, label: deletionScopeLabel(), placements: result.removedPropInstances + (result.removedWallFixtures ?? 0) };
      render();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    return;
  }
  if (action === 'confirm-delete-bindings') {
    if (!pendingAssetDeletion) return;
    const ids = pendingAssetDeletion.ids;
    pendingAssetDeletion = null;
    try {
      const result = removeAssetBindings(project, ids);
      if (result.removedBindings) {
        markHistory(); project = result.project; furnishingResult = undefined;
        notify(`에셋 등록 ${result.removedBindings}개와 연결된 소품·벽 부착물 ${result.removedPropInstances + (result.removedWallFixtures ?? 0)}개를 삭제했습니다. 지형은 유지했습니다. 되돌리기(Ctrl+Z)로 복원할 수 있습니다.`);
      }
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    render(); return;
  }
  if (selected && designer.isLocked(selected) && ['add-connection','remove-connection','raise','lower'].includes(action ?? '')) {notify('수정하려면 셀 잠금을 해제하세요.',true);return;}
  if(action==='issue-focus'){const match=button.dataset.message?.match(/\((\d+),\s*(\d+)\)/);if(match){selected={x:Number(match[1]),row:Number(match[2])};designer.pick(selected);rightTab='cell';view='grid';render();}return;}
  if(action==='dismiss-recovery'){recovery=null;render();return;}
  if(action==='recover'&&recovery){markHistory();project=recovery;attemptConcept=undefined;recovery=null;assets=[];projectPath='';resetUnityConnection();importedPropCatalog=null;selected=null;designer.reset();isSample=false;notify('자동 저장 사본을 복구했습니다. Unity 프로젝트를 다시 연결해 주세요.');render();return;}
  if (action === 'connection-select') { view='grid'; editMode='select'; rightTab='cell'; render(); return; }
  if (action === 'select-connection') {
    const c=project.map.connections.find(c=>c.id===button.dataset.id);
    if(c) { selected={x:c.x,row:c.row}; rightTab='cell'; editMode='select'; render(); } return;
  }
  if (action === 'add-connection' && selected) {
    const {x,row}=selected;
    if(project.map.connections.length>=1600||connectionAt(project.map,x,row))return;
    const facings=directions.filter(d=>(project.map.rows[row+d.dr]?.[x+d.dx]??'_')==='_' && '.DRB'.includes(project.map.rows[row-d.dr]?.[x-d.dx]??'_'));
    let changed:GridMap|undefined,errorMessage='연결문은 바깥이 빈 공간이고 안쪽에 통행 바닥이 있는 외곽에 추가하세요.';
    for(const facing of facings) {
      try {
        changed=addMapConnection(project.map,{id:`port_${crypto.randomUUID()}`,label:`연결문 ${project.map.connections.length+1}`,x,row,direction:facing.value,width:project.settings.connectionWidth??project.settings.cellSize,height:project.settings.connectionHeight??3,kind:'default'},project.bindings);
        break;
      } catch(error) {errorMessage=error instanceof Error?error.message:String(error);}
    }
    if(changed)editMap(()=>{project.map=changed!;});else notify(errorMessage,true);
    return;
  }
  if(action==='remove-connection') {
    const connection = project.map.connections.find(c=>c.id===button.dataset.id); if (!connection) return;
    if (connectionCells(project.map,connection).some(designer.isLocked)) { notify('연결문에 잠긴 셀이 있습니다. 먼저 잠금을 해제하세요.',true); return; }
    try {
      const changed = connection.width > project.map.cellSize ? updateConnectionGeometry(project.map, connection.id, { width: project.map.cellSize }, project.bindings) : structuredClone(project.map);
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
      const checked = validateBindingEdit({ ...project, bindings: changed });
      markHistory(); project.bindings = checked.bindings;
      notify(`${count}개 에셋의 배율을 조정했습니다. Unity로 다시 내보내면 적용됩니다.`); render();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    return;
  }
  if (action === 'furnish-map') return task(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    const result = furnishExistingMap(project.map, project.settings, project.bindings, { props: furnishProps, decorations: furnishDecorations });
    if (!result.unchanged) {
      const checked = parseProjectFile({ ...project, map: result.map });
      markHistory(); project.map = checked.map;
    }
    furnishingResult = { map: project.map, result };
    notify(result.unchanged ? '추가 배치가 없습니다. 목표 달성 여부와 배치 조건을 확인하세요.' : `지형을 유지하고 소품 ${result.addedProps}개·장식 ${result.addedDecorations}개를 ${result.usedBindingIds.length}종으로 배치했습니다.`);
  }, '지형을 유지하며 소품·장식의 크기와 동선을 검사합니다…');
  if (action === 'rearrange-props') return task(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    const settings = { ...project.settings, designer: { ...DEFAULT_DESIGNER, ...project.settings.designer, propLayout: 'grouped' as const } };
    const result = rearrangeMapProps(project.map, settings, project.bindings, { props: furnishProps, decorations: furnishDecorations, includeUnknown: rearrangeUnknown });
    if (!result.unchanged) {
      const checked = parseProjectFile({ ...project, map: result.map });
      markHistory(); project.map = checked.map;
    }
    furnishingResult = { map: project.map, result };
    notify(result.unchanged ? '재정리할 변경이 없습니다. 보존 대상과 배치 조건을 확인하세요.' : `묶음 ${result.groupCount}개로 재정리했습니다. 이동 ${result.movedProps}개 · 보존 ${result.preservedProps}개 · 추가 ${result.addedProps + result.addedDecorations}개 · 제외 ${result.removedProps}개.`);
  }, '기존 지형과 수동 배치를 보존하며 소품 묶음을 재정리합니다…');
  if(action==='add-binding') {
    const asset=assets.find(a=>a.guid===newAssetGuid);
    if(!asset||project.bindings.length>=MAX_BINDINGS)return;
    const binding:AssetBinding={id:`asset_${crypto.randomUUID()}`,label:asset.name.slice(0,80),role:newAssetRole,prefabGuid:asset.guid,prefabPath:asset.path,scale:['prop','decoration','vegetation'].includes(newAssetRole)?{x:1,y:1,z:1}:defaultAssetScale(newAssetRole,project.map.cellSize),offset:{x:0,y:0,z:0},rotationY:0,...((newAssetRole==='stair'||newAssetRole==='slope')?{stairNativeRise:1}:{})};
    if(['prop','decoration','vegetation'].includes(newAssetRole))binding.prop=suggestPropDefinition(binding);
    const measured = applyImportedPropBounds(binding, importedPropCatalog);
    markHistory(); project.bindings.push(measured);
    notify(`에셋을 추가했습니다. 현재 ${project.bindings.length}개입니다.${measured.prop?.size ? ' 가져온 원본 크기도 적용했습니다.' : ''}`); render(); return;
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
    try {
      const result = removeAssetBindings(project, [button.dataset.id!]);
      markHistory(); project = result.project; furnishingResult = undefined;
      notify(`에셋을 삭제했습니다.${result.removedWallFixtures ? ` 연결된 벽 부착물 ${result.removedWallFixtures}개도 제거했습니다.` : ''} 이 에셋을 지정했던 셀은 자동 순환으로 돌아갑니다. 되돌리기로 복원할 수 있습니다.`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    render();return;
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
    markHistory(); project.map = createDemoMap(); delete project.generationDraft; delete project.concept; delete project.blueprintDataUrl; attemptConcept=undefined; designer.reset(); isSample = true; selected=null; project.settings.cellSize = project.map.cellSize; project.settings.maxStepHeight=project.map.maxStepHeight;
    notify('샘플 맵을 불러왔습니다. 데모는 AI 호출 없이 제공됩니다.'); render(); return;
  }
  if (action === 'scan') return task(async () => {
    let result;
    try { result = await requireDesktop().scanProject(); }
    catch (error) { assets = []; projectPath = ''; resetUnityConnection(); throw error; }
    if (!result) { notify('폴더 연결을 취소했습니다.'); return; }
    assets = result.assets; projectPath = result.projectPath; resetUnityConnection();
    let catalogMessage = '';
    if (importedPropCatalog) {
      const guids = new Set(assets.map(asset => asset.guid.toLowerCase()));
      const matching = importedPropCatalog.assets.filter(asset => guids.has(asset.guid.toLowerCase()));
      importedPropCatalog = matching.length ? { version: importedPropCatalog.version, assets: matching } : null;
      catalogMessage = matching.length ? ` 가져온 크기 ${matching.length}개가 이 프로젝트와 일치합니다.` : ' 가져온 크기가 이 프로젝트와 일치하지 않아 보관 목록을 비웠습니다. 이 프로젝트의 크기 JSON을 가져와 주세요.';
    }
    if(!assets.some(a=>a.guid===newAssetGuid))newAssetGuid='';
    notify(`프로젝트 프리팹 ${assets.length}개를 선택용 목록에 불러왔습니다. 등록된 에셋은 ${project.bindings.length}개입니다.${catalogMessage}${result.warnings.length ? ' ' + result.warnings.join(' ') : ''}`);
  }, 'Unity 프리팹 목록을 읽고 있습니다…');
  if (action === 'import-unity-asset-catalog') return task(async () => {
    const desktop = requireDesktop();
    if (!desktop.importUnityAssetCatalog) throw new Error('이 실행 파일은 Unity 표시 프리팹 가져오기를 지원하지 않습니다. 최신 앱을 실행해 주세요.');
    if (!projectPath) throw new Error('먼저 Unity 프로젝트 폴더를 연결해 주세요.');
    if (unresolvedUnityBuild()) throw new Error('진행 중인 Unity 프리팹 생성의 결과를 먼저 확인해 주세요.');
    unityCatalogReport = null;
    const response = await desktop.importUnityAssetCatalog(unityEndpoint);
    const result = importUnityAssetCatalogBindings(project.bindings, response.catalog, response.scan.assets, project.map.cellSize);
    const checked = validateBindingEdit({ ...project, bindings: result.bindings });
    const errors = propValidationIssues(checked.map, checked.bindings).filter(issue => issue.severity === 'error');
    if (errors.length) throw new Error(`${errors[0].message} 기존 배치와 충돌하여 가져오기를 적용하지 않았습니다.`);
    if (JSON.stringify(checked.bindings) !== JSON.stringify(project.bindings)) {
      markHistory(); project.bindings = checked.bindings;
    }
    assets = response.scan.assets; projectPath = response.scan.projectPath;
    importedPropCatalog = { version: 2, assets: result.catalog.assets.map(entry => ({
      guid: entry.guid, size: structuredClone(entry.size), bounds: structuredClone(entry.bounds),
      ...(entry.wallMount ? { wallMount: structuredClone(entry.wallMount) } : {}),
    })) };
    if (!assets.some(asset => asset.guid === newAssetGuid)) newAssetGuid = '';
    furnishingResult = undefined;
    const counts = roles.flatMap(({ role, label }) => {
      const count = result.byRole[role];
      return count && (count.added || count.updated) ? [{ label, ...count }] : [];
    });
    const summary = `신규 등록 ${result.added}개 · 기존 크기 갱신 ${result.updated}개 · 제외 ${result.skipped.length}개.`;
    unityCatalogReport = { summary, counts, details: result.skipped, warnings: [...new Set([...response.scan.warnings, ...response.warnings])] };
    notify(summary);
  }, 'Unity에 표시된 프리팹과 크기를 가져옵니다. 최초 실행은 스크립트 준비·컴파일을 기다립니다…', false);
  if (action === 'import-prop-catalog') return task(async () => {
    const desktop = requireDesktop();
    if (!desktop.importPropCatalog) throw new Error('이 실행 파일은 소품 크기 가져오기를 지원하지 않습니다. 최신 앱을 다시 실행해 주세요.');
    const value = await desktop.importPropCatalog();
    if (value === null) { notify('소품 크기 가져오기를 취소했습니다.'); return; }
    // Reject invalid JSON before opening a second dialog or changing the connected project.
    preparePropBoundsImport([], value, null);
    let connected = null;
    if (!projectPath) {
      notify('프리팹을 일괄 등록할 Unity 프로젝트 폴더를 선택하세요.');
      connected = await desktop.scanProject();
      if (!connected) { notify('폴더 선택을 취소하여 크기와 프리팹을 등록하지 않았습니다.'); return; }
    }
    const result = importPropCatalogBindings(project.bindings, value, connected?.assets ?? assets, propCatalogRole);
    const checked = validateBindingEdit({ ...project, bindings: result.bindings });
    if (JSON.stringify(checked.bindings) !== JSON.stringify(project.bindings)) {
      markHistory(); project.bindings = checked.bindings;
    }
    if (connected) {
      assets = connected.assets; projectPath = connected.projectPath; resetUnityConnection();
      if (!assets.some(asset=>asset.guid===newAssetGuid)) newAssetGuid = '';
    }
    importedPropCatalog = result.catalog;
    furnishingResult = undefined;
    const missing = result.missing ? ` 파일에 없는 기존 소품·장식·식생 ${result.missing}개의 크기는 유지했습니다.` : '';
    const unmatched = result.unmatched ? ` 프로젝트와 일치하지 않는 ${result.unmatched}개는 제외했습니다.` : '';
    const otherRoles = result.existingOtherRoles ? ` 이미 다른 종류로 등록된 ${result.existingOtherRoles}개는 유지했습니다.` : '';
    const warnings = connected?.warnings.length ? ` ${connected.warnings.join(' ')}` : '';
    notify(`프리팹 크기 ${result.available}개 · 신규 등록 ${result.added}개 · 기존 크기 갱신 ${result.updated}개.${missing}${unmatched}${otherRoles}${warnings}`, result.unmatched > 0);
  }, '크기를 가져오고 프리팹을 일괄 등록합니다…');
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
    if (loaded) { designer.reset(); project = loaded; attemptConcept=undefined; assets = []; projectPath = ''; resetUnityConnection(); importedPropCatalog = null; history.length = 0; future.length = 0; dirty = false; isSample = false; view = '3d'; selected=null; notify('프로젝트를 열었습니다. 내보내려면 원본 Unity 프로젝트를 연결해 주세요.'); }
    else notify('열기를 취소했습니다.');
    }, '프로젝트를 불러옵니다…');
  }
  if (action === 'unity-build') return runUnityAction('build');
  if (action === 'unity-build-status') return runUnityAction('status');
  if (action === 'unity-check') return runUnityAction('check');
  if (action === 'unity-prepare') return runUnityAction('prepare');
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
  if (input.id === 'unityEndpoint') {
    unityEndpoint = input.value.trim() || DEFAULT_UNITY_ENDPOINT;
    try { localStorage.setItem('baekho.unityEndpoint', unityEndpoint); } catch { /* Connection still works without persisted settings. */ }
    resetUnityConnection(); render(); return;
  }
  queueMicrotask(queueRecovery);
  if (input.id === 'bulkDeleteScope') {
    if (['all', 'props', ...roles.map(item => item.role)].includes(input.value)) bulkDeleteScope = input.value as DeleteScope;
    render(); return;
  }
  if (designer.change(input)) return;
  if (input.dataset.wallBinding && input.dataset.wallField) {
    try {
      const index = project.bindings.findIndex(binding => binding.id === input.dataset.wallBinding); if (index < 0) return;
      const binding = handleWallMountField(project.bindings[index], input.dataset.wallField, input.type === 'checkbox' ? input.checked : input.value);
      const checked = validateBindingEdit({ ...project, bindings: project.bindings.map((item, i) => i === index ? binding : item) });
      markHistory(); project.bindings = checked.bindings; render();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); render(); }
    return;
  }
  if(input.dataset.generationControl){try{const settings=updateGenerationControl(project.settings,input.dataset.generationControl,input.value);markHistory();project.settings=settings;render();}catch(error){notify(error instanceof Error?error.message:String(error),true);render();}return;}
  if(input.dataset.propBinding&&input.dataset.propField){
    try{
      const index=project.bindings.findIndex(b=>b.id===input.dataset.propBinding);if(index<0)return;
      if(input.dataset.propField==='role'){
        const checked=validateBindingEdit(reclassifyPropBinding(project,input.dataset.propBinding,input.value));
        markHistory();project.bindings=checked.bindings;project.map=checked.map;
        notify(`에셋과 해당 배치물의 분류를 ${input.value==='vegetation'?'식생':'장식'}으로 바꿨습니다.`);
      }else{
        const binding=handlePropField(project.bindings[index],input.dataset.propField,input.type==='checkbox'?input.checked:input.value);
        const bindings=project.bindings.map((b,i)=>i===index?binding:b),checked=validateBindingEdit({...project,bindings});
        markHistory();project.bindings=checked.bindings;
      }
      render();
    }catch(error){notify(error instanceof Error?error.message:String(error),true);render();}
    return;
  }
  if (selected && designer.isLocked(selected) && (['selectedTile','selectedHeight','rampDirection','rampRise'].includes(input.id) || input.dataset.connection || input.dataset.cellBinding)) { notify('수정하려면 셀 잠금을 해제하세요.',true);render();return; }
  if (input.id === 'variantCount') { const count = Number(input.value); if (Number.isInteger(count) && count >= 2 && count <= 8) variantCount = count; return; }
  if (input.id === 'bulkScaleScope') { bulkScope = input.value as ScaleScope; render(); return; }
  if (input.id === 'bulkScaleMode') { bulkMode = input.value as typeof bulkMode; return; }
  if (input.dataset.bulkAxis) { bulkAxes[input.dataset.bulkAxis as keyof typeof bulkAxes] = input.value; return; }
  if (input.dataset.furnishControl) {
    const field = input.dataset.furnishControl;
    if (field === 'props') furnishProps = input.checked;
    else if (field === 'decorations') furnishDecorations = input.checked;
    else if (field === 'includeUnknown') rearrangeUnknown = input.checked;
    else if (field === 'layout') {
      if (!['legacy', 'balanced', 'grouped'].includes(input.value)) { notify('알 수 없는 소품 배치 방식입니다.', true); render(); return; }
      markHistory();
      project.settings.designer = { ...(project.settings.designer ?? DEFAULT_DESIGNER), propLayout: input.value as NonNullable<NonNullable<ProjectFile['settings']['designer']>['propLayout']> };
    }
    else {
      const value = Number(input.value), maximum = field === 'coverage' ? 30 : 100;
      if (!['coverage', 'density'].includes(field) || !Number.isInteger(value) || value < 1 || value > maximum) { notify(`1~${maximum} 사이의 정수를 입력하세요.`, true); render(); return; }
      markHistory();
      project.settings.designer = { ...(project.settings.designer ?? DEFAULT_DESIGNER), [field === 'coverage' ? 'propCoverage' : 'decorationDensity']: value };
    }
    furnishingResult = undefined;
    render(); return;
  }
  if(input.id==='newAssetRole') {newAssetRole=input.value as AssetRole;render();return;}
  if(input.id==='propCatalogRole') {if(['prop','decoration','vegetation','light'].includes(input.value))propCatalogRole=input.value as typeof propCatalogRole;render();return;}
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
        const changed = updateConnectionGeometry(project.map, c.id, { [key]: number }, project.bindings);
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
      const checked = validateBindingEdit({ ...project, bindings: changed });
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
    if(!asset||!binding||binding.prefabGuid===asset.guid)return;
    const changed = structuredClone(binding);
    if(changed.prop)delete changed.prop.size;
    delete changed.bounds; delete changed.wallMount;
    changed.prefabGuid=asset.guid;changed.prefabPath=asset.path;
    const measured = applyImportedPropBounds(changed, importedPropCatalog);
    try {
      const checked = validateBindingEdit({ ...project, bindings: project.bindings.map(b=>b.id===binding.id?measured:b) });
      markHistory(); project.bindings = checked.bindings;
      if(['prop','decoration','vegetation','light'].includes(measured.role))notify(measured.bounds || measured.prop?.size ? '새 프리팹에 맞는 원본 크기를 자동 적용했습니다.' : '새 프리팹의 원본 크기와 벽 부착 기준점을 가져오거나 직접 설정해 주세요.');
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    render();return;
  }
  if (input.dataset.transform || input.dataset.rotation) {
    const [id, group, axis] = (input.dataset.transform ?? input.dataset.rotation!).split(':');
    const binding = project.bindings.find(b => b.id === id);
    if(!binding)return;
    const value = Number(input.value);
    if (!Number.isFinite(value) || Math.abs(value) > 10000 || (group === 'scale' && value <= 0)) { notify('배율은 양수, 오프셋과 회전은 유효한 숫자로 입력해 주세요.', true); render(); return; }
    try {
      const changed = structuredClone(binding);
      if (input.dataset.rotation) changed.rotationY = value;
      else changed[group as 'scale' | 'offset'][axis as 'x'|'y'|'z'] = value;
      const checked = validateBindingEdit({ ...project, bindings: project.bindings.map(item => item.id === changed.id ? changed : item) });
      markHistory(); project.bindings = checked.bindings;
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    render();
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
