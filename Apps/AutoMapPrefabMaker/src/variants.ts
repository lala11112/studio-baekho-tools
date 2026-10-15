import './variants.css';
import { mountPreview, type PreviewHandle, type PreviewState } from './preview';
import type { GenerationSettings, GridMap, Tile } from './shared/types';
import type { MapVariant, VariantStatus } from './shared/variants';
import { analyzeLevelDesign } from './shared/level-design';
import { ROOM_PRESETS } from './shared/room-presets';

export interface VariantGalleryHooks {
  busy: () => boolean;
  render: () => void;
  apply: (candidate: MapVariant) => void | Promise<void>;
  save: (candidates: MapVariant[]) => void | Promise<void>;
  remove?: (id: string) => void;
}

const escape = (value: unknown): string => String(value).replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const statusLabels: Record<VariantStatus, string> = {
  waiting: '대기 중', image: '설계도 생성 중', extract: '맵 분석 중', ready: '완료', error: '생성 실패', cancelled: '취소됨',
};
const tileColors: Record<Tile, string> = { _: '#edf0e8', '.': '#d6dacb', '#': '#637764', D: '#2b8e86', P: '#bb8663', R: '#b399bd', B: '#b69562' };
const ready = (candidate: MapVariant): boolean => candidate.status === 'ready' && !!candidate.project;
const blueprint = (candidate?: MapVariant): string | undefined => {
  const source = candidate?.project?.blueprintDataUrl;
  return source?.startsWith('data:image/png;base64,') ? source : undefined;
};
const meters = (number: number): string => Number(number.toFixed(2)).toString();

/** Small, actual geometry thumbnails remain useful even when blueprint images look alike. */
function floorPlan(map: GridMap): string {
  const heights = map.rows.flatMap((row, rowIndex) => [...row].flatMap((tile, x) => tile !== '_' ? [map.elevations[rowIndex][x]] : []));
  const minimum = Math.min(0, ...heights), maximum = Math.max(0, ...heights), range = maximum - minimum;
  let cells = '';
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const tile = map.rows[row][x] as Tile;
    if (tile === '_') continue;
    const elevated = range && '.DB'.includes(tile) ? (map.elevations[row][x] - minimum) / range : 0;
    const fill = elevated > 0 ? `hsl(86 20% ${79 - elevated * 18}%)` : tileColors[tile] ?? '#d6dacb';
    cells += `<rect x="${x + .045}" y="${row + .045}" width=".91" height=".91" rx=".06" fill="${fill}"/>`;
  }
  for (const port of map.connections) {
    const dx = port.direction === 90 ? 1 : port.direction === 270 ? -1 : 0;
    const dy = port.direction === 180 ? 1 : port.direction === 0 ? -1 : 0;
    cells += `<path d="M ${port.x + .5} ${port.row + .5} l ${dx * .75} ${dy * .75}" stroke="#126b62" stroke-width=".2" stroke-linecap="round"/>`;
  }
  return `<svg class="variant-floorplan" viewBox="0 0 ${map.width} ${map.height}" role="img" aria-label="${escape(map.name)} 실제 맵 배치"><rect width="${map.width}" height="${map.height}" fill="#edf0e8"/>${cells}</svg>`;
}

function stats(map: GridMap, settings?: GenerationSettings): string {
  const floors = [...map.rows.join('')].filter(tile => '.DPR'.includes(tile)).length;
  const report=settings?.levelDesign?analyzeLevelDesign(map,settings):undefined;
  const summary=report?`<p class="variant-detail-note">${escape(settings?.sizeMode==='preset'&&settings.roomPreset?ROOM_PRESETS[settings.roomPreset].label:'사용자 지정')} · ${escape(report.recipe.label)} · 통행 면적 ${meters(report.walkableArea)}m²<br>${escape(report.recipe.intent)} · 입구 여유 ${meters(report.recipe.entryClearance)}m · 회피 공간 ${report.combatCells.length}셀 · 양쪽 우회 소품 ${report.obstacleChoices.length}개${report.issues.length?` · 문제 ${report.issues.length}개`:''}</p>`:'';
  return `<dl class="variant-stats"><div><dt>연결문</dt><dd>${map.connections.length}</dd></div><div><dt>바닥</dt><dd>${floors}<small>셀</small></dd></div><div><dt>천장</dt><dd>${map.ceilings?.length ?? 0}<small>셀</small></dd></div></dl>${summary}`;
}

/** Gallery state is separate from the editable project. Only apply() can hand a candidate to it. */
export function createVariantGallery(hooks: VariantGalleryHooks) {
  let candidates: MapVariant[] = [];
  const selected = new Set<string>();
  const cameras = new Map<string, PreviewState>();
  const ceilings = new Map<string, boolean>();
  const modes = new Map<string, '3d' | 'image'>();
  let activeId = '', previewChosen = false;
  let preview: PreviewHandle | undefined, mountedId = '', mountedHost: HTMLElement | undefined;
  let cardScrollTop = 0, galleryScrollTop = 0;

  function dispose(): void {
    if (preview) {
      if (candidates.some(candidate => candidate.id === mountedId)) cameras.set(mountedId, preview.getState());
      preview.dispose(); preview = undefined;
    }
    if (mountedHost) {
      cardScrollTop = mountedHost.querySelector<HTMLElement>('.variant-cards')?.scrollTop ?? cardScrollTop;
      galleryScrollTop = mountedHost.querySelector<HTMLElement>('.variant-gallery-body')?.scrollTop ?? galleryScrollTop;
    }
    mountedHost = undefined; mountedId = '';
  }

  function setCandidates(next: readonly MapVariant[]): void {
    const ids = new Set(next.map(candidate => candidate.id));
    const newBatch = next.length > 0 && !candidates.some(candidate => ids.has(candidate.id));
    candidates = structuredClone([...next]);
    for (const id of selected) if (!candidates.some(candidate => candidate.id === id && ready(candidate))) selected.delete(id);
    for (const store of [cameras, ceilings, modes]) for (const id of store.keys()) if (!ids.has(id)) store.delete(id);
    if (newBatch) { previewChosen = false; cardScrollTop = 0; galleryScrollTop = 0; }
    if (!ids.has(activeId) || !previewChosen) activeId = candidates.find(ready)?.id ?? candidates[0]?.id ?? '';
  }

  function selectedIds(): string[] { return candidates.filter(candidate => ready(candidate) && selected.has(candidate.id)).map(candidate => candidate.id); }

  function card(candidate: MapVariant): string {
    const isReady = ready(candidate), map = candidate.project?.map, image = blueprint(candidate), id = escape(candidate.id);
    return `<article class="variant-card ${activeId === candidate.id ? 'active' : ''} ${selected.has(candidate.id) ? 'chosen' : ''}" data-variant-card="${id}">
      <div class="variant-card-heading"><label class="variant-selection"><input type="checkbox" data-v-action="select" data-id="${id}" ${selected.has(candidate.id) ? 'checked' : ''} ${isReady ? '' : 'disabled'} aria-label="${escape(candidate.label)} 저장 선택"><strong>${escape(candidate.label)}</strong></label><span class="variant-status status-${candidate.status}">${statusLabels[candidate.status]}</span></div>
      <button class="variant-cover" data-v-action="preview" data-id="${id}" aria-label="${escape(candidate.label)} 상세 미리보기" aria-pressed="${activeId === candidate.id}">${map ? floorPlan(map) : `<span class="variant-placeholder ${candidate.status === 'image' || candidate.status === 'extract' ? 'working' : ''}"><span aria-hidden="true">${candidate.status === 'error' ? '△' : candidate.status === 'cancelled' ? '−' : '▧'}</span><small>${statusLabels[candidate.status]}</small></span>`}${image ? `<img class="variant-blueprint-thumb" src="${escape(image)}" alt="${escape(candidate.label)} AI 설계도">` : ''}</button>
      ${map ? `<div class="variant-card-info"><p class="variant-map-name" title="${escape(map.name)}">${escape(map.name)}</p><p class="variant-dimensions">${map.width} × ${map.height}셀 · ${meters(map.width * map.cellSize)} × ${meters(map.height * map.cellSize)}m</p>${stats(map,candidate.project?.settings)}</div>` : `<p class="variant-card-message">${candidate.error ? escape(candidate.error) : candidate.status === 'waiting' ? '차례가 되면 생성합니다.' : candidate.status === 'cancelled' ? '이 후보의 생성이 취소되었습니다.' : '완료되면 실제 맵 배치를 비교할 수 있습니다.'}</p>`}
      <div class="variant-card-actions"><button data-v-action="preview" data-id="${id}" data-v-view="3d" ${isReady ? '' : 'disabled'}>3D 보기</button><button data-v-action="preview" data-id="${id}" data-v-view="image" ${image ? '' : 'disabled'}>설계도</button>${hooks.remove ? `<button class="quiet danger" data-v-action="remove" data-id="${id}" ${hooks.busy() ? 'disabled' : ''} aria-label="${escape(candidate.label)} 제외">제외</button>` : ''}</div>
    </article>`;
  }

  function detail(): string {
    const candidate = candidates.find(item => item.id === activeId);
    if (!candidate) return '';
    const isReady = ready(candidate), map = candidate.project?.map, image = blueprint(candidate);
    const mode = modes.get(candidate.id) ?? '3d';
    return `<section class="variant-detail" aria-label="후보 상세 미리보기">
      <div class="variant-detail-heading"><div><p class="eyebrow">CANDIDATE PREVIEW</p><h3>${escape(candidate.label)}</h3></div><span class="variant-status status-${candidate.status}">${statusLabels[candidate.status]}</span></div>
      <div class="variant-detail-tools"><button data-v-action="mode" data-v-view="3d" class="${mode === '3d' ? 'selected' : ''}" aria-pressed="${mode === '3d'}">3D</button><button data-v-action="mode" data-v-view="image" class="${mode === 'image' ? 'selected' : ''}" aria-pressed="${mode === 'image'}" ${image ? '' : 'disabled'}>설계도</button><span class="spacer"></span><button data-v-action="ceilings" aria-pressed="${ceilings.get(candidate.id) ?? false}" class="${ceilings.get(candidate.id) ? 'selected' : ''}" ${!isReady || mode !== '3d' ? 'disabled' : ''}>천장</button></div>
      <div class="variant-detail-viewport">${isReady && mode === '3d' ? '<div class="variant-preview-host" data-variant-preview></div><span class="variant-preview-hint">드래그 회전 · 휠 확대 · 우클릭 이동</span>' : image && mode === 'image' ? `<img class="variant-detail-image" src="${escape(image)}" alt="${escape(candidate.label)} AI 설계도">` : `<div class="variant-detail-placeholder"><span aria-hidden="true">${candidate.status === 'error' ? '△' : '▧'}</span><strong>${statusLabels[candidate.status]}</strong><p>${escape(candidate.error ?? (candidate.status === 'cancelled' ? '완료된 다른 후보를 선택해 보세요.' : '생성이 완료되면 3D 맵을 둘러볼 수 있습니다.'))}</p></div>`}</div>
      ${map ? `<div class="variant-detail-summary"><strong>${escape(map.name)}</strong><span>${map.width} × ${map.height}셀 · 셀 ${meters(map.cellSize)}m</span></div>${stats(map,candidate.project?.settings)}` : ''}
      <button class="secondary full" data-v-action="apply" data-id="${escape(candidate.id)}" ${!isReady || hooks.busy() ? 'disabled' : ''}>이 맵 편집하기</button><p class="variant-detail-note">편집할 후보를 적용하면 현재 작업 맵으로 열립니다.</p>
    </section>`;
  }

  function render(): string {
    const count = selectedIds().length, complete = candidates.filter(ready).length;
    return `<section class="variant-gallery" aria-label="생성한 맵 후보 비교">
      <div class="variant-gallery-header"><div><h2>맵 후보 비교</h2><p>${candidates.length ? `${complete} / ${candidates.length}개 완료 · 저장할 후보를 체크하세요.` : '여러 가지 배치를 둘러보고 마음에 드는 맵을 골라 보세요.'}</p></div><button class="primary" data-v-action="save" ${!count || hooks.busy() ? 'disabled' : ''}>선택한 ${count}개 저장</button></div>
      <div class="variant-gallery-selection"><span data-variant-selected-count>${count}개 선택</span><button class="quiet" data-v-action="select-all" ${complete ? '' : 'disabled'}>완료 후보 전체 선택</button><button class="quiet" data-v-action="clear-selection" ${count ? '' : 'disabled'}>선택 해제</button></div>
      ${candidates.length ? `<div class="variant-gallery-body"><div class="variant-cards" aria-label="맵 후보 목록">${candidates.map(card).join('')}</div>${detail()}</div>` : '<div class="variant-gallery-empty"><span aria-hidden="true">▦</span><strong>맵 후보를 한눈에 비교하세요</strong><p>왼쪽에서 후보 수를 정하고<br><b>여러 후보 생성</b>을 눌러 시작하세요.</p><small>각 후보의 실제 배치와 3D, 설계도를 확인할 수 있습니다.</small></div>'}
      <p class="variant-storage-note">후보는 저장하기 전까지 현재 앱에만 보관됩니다.</p>
    </section>`;
  }

  function mount(host: HTMLElement): void {
    dispose(); mountedHost = host;
    const cards = host.querySelector<HTMLElement>('.variant-cards'), body = host.querySelector<HTMLElement>('.variant-gallery-body');
    if (cards) cards.scrollTop = cardScrollTop; if (body) body.scrollTop = galleryScrollTop;
    const candidate = candidates.find(item => item.id === activeId), target = host.querySelector<HTMLElement>('[data-variant-preview]');
    if (!target || !candidate?.project || !ready(candidate)) return;
    try {
      mountedId = candidate.id;
      preview = mountPreview(target, candidate.project.map, { state: cameras.get(candidate.id), bindings:candidate.project.bindings, ...(candidate.project.settings.levelDesign?{designReport:analyzeLevelDesign(candidate.project.map,candidate.project.settings)}:{}), showCeilings: ceilings.get(candidate.id) ?? false, showConnectionLabels: false });
      target.querySelector('canvas')?.setAttribute('aria-label', `${candidate.label} 3D 맵 미리보기. 드래그로 회전하고 휠로 확대하세요.`);
    } catch (error) {
      target.innerHTML = `<p class="variant-preview-error">3D 미리보기를 열 수 없습니다.<br>${escape(error instanceof Error ? error.message : error)}<br>카드의 실제 배치와 설계도를 확인하세요.</p>`;
    }
  }

  function click(target: HTMLElement): boolean {
    const control = target.closest<HTMLElement>('[data-v-action]');
    if (!control) return false;
    if ((control as HTMLButtonElement).disabled) return true;
    const action = control.dataset.vAction, id = control.dataset.id;
    const candidate = candidates.find(item => item.id === id);
    if (action === 'select' && candidate && ready(candidate)) {
      if (selected.has(candidate.id)) selected.delete(candidate.id); else selected.add(candidate.id);
    } else if (action === 'select-all') for (const item of candidates.filter(ready)) selected.add(item.id);
    else if (action === 'clear-selection') selected.clear();
    else if (action === 'preview' && candidate) {
      activeId = candidate.id; previewChosen = true;
      if (control.dataset.vView === '3d' || (control.dataset.vView === 'image' && blueprint(candidate))) modes.set(activeId, control.dataset.vView);
    } else if (action === 'mode' && (control.dataset.vView === '3d' || control.dataset.vView === 'image')) {
      if (control.dataset.vView === 'image' && !blueprint(candidates.find(item => item.id === activeId))) return true;
      modes.set(activeId, control.dataset.vView);
    } else if (action === 'ceilings') ceilings.set(activeId, !ceilings.get(activeId));
    else if (action === 'apply' && candidate && ready(candidate)) { if (!hooks.busy()) void hooks.apply(structuredClone(candidate)); return true; }
    else if (action === 'save') {
      const chosen = candidates.filter(item => ready(item) && selected.has(item.id));
      if (!hooks.busy() && chosen.length) void hooks.save(structuredClone(chosen));
      return true;
    } else if (action === 'remove' && candidate) { if (!hooks.busy()) hooks.remove?.(candidate.id); return true; }
    else return true;
    hooks.render(); return true;
  }

  return { setCandidates, render, mount, dispose, click, selectedIds };
}
