'use strict';

(() => {
  const api = window.autoHitTimer;
  const embedded = new URLSearchParams(window.location.search).get('embedded') === '1';
  document.documentElement.classList.toggle('embedded', embedded);
  if (embedded) document.title = '타격 타이밍 · 백호툴';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const seconds = value => number(value).toFixed(3);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const statusLabels = { draft: '분석 대기', capturing: '동작 촬영 중', analyzing: 'AI 분석 중', review: '검토 필요', failed: '작업 실패', cancelled: '취소됨', saved: '저장 완료' };
  let state = { projectPath: '', connection: {}, ai: {}, actors: [], sources: [], targets: [], groups: [], jobs: [], settings: {} };
  let searchResults = [];
  let searchSelection = new Set();
  let searchMessage = '';
  let searchGeneration = 0;
  let searchPending = false;
  let searchCancelPending = false;
  let searchFailed = false;
  let searchResultMode = '';
  let searchDetails = '';
  let currentTab = 'hits';
  let selectedWindowId = null;
  let currentTime = 0;
  let playing = false;
  let lastPlaybackTime = 0;
  let animationRequest = 0;
  let lastJobId = null;
  let lastPreviewKey = '';
  let preview = null;
  let previewJobId = null;
  let previewFingerprint = '';
  let overrideFields = [];
  let timeSettingsContext = '';
  let timeSettingsOpen = false;
  let pendingOperations = 0;
  let localNotice = null;
  let drag = null;
  let navigationGeneration = 0;
  let stateRevision = 0;

  const projectIdentity = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const job = () => (state.jobs || []).find(item => item.id === state.selectedJobId) || null;
  const duration = item => Math.max(0, number(item?.duration, number(item?.clip?.length)));
  const windows = item => Array.isArray(item?.windows) ? item.windows : [];
  const busyJob = item => ['capturing', 'analyzing'].includes(item?.status);
  const lockedJob = item => busyJob(item) || Boolean(item?.pendingSave);
  const statusLabel = item => item?.pendingSave ? '저장 결과 확인 중' : statusLabels[item?.status] || item?.status || '분석 대기';
  const analysisActive = () => (state.jobs || []).some(busyJob);
  const connectionReady = () => Boolean(state.connection?.ready);
  const searchActive = () => searchPending || Boolean(state.search?.busy);
  const searchContext = () => JSON.stringify([state.projectPath, state.actorId || state.settings?.actorId || '']);
  const canAnalyze = () => connectionReady() && Boolean(state.ai?.available) && state.ai?.authenticated !== false && !analysisActive() && !searchActive();
  const targetFor = item => (state.targets || []).find(target => target.sourceGuid === item?.sourceGuid && target.actionPath === (item?.mode === 'register' ? item?.templatePath : item?.actionPath));
  const targetIdentity = item => JSON.stringify([item?.sourceGuid, item?.mode === 'register' ? item?.templatePath : item?.actionPath]);
  const sameClip = (left, right) => left && right && left.guid === right.guid && String(left.localId) === String(right.localId);
  const fingerprint = item => JSON.stringify([state.actorId, state.settings?.weaponId, state.settings?.weaponBone, item?.windows, item?.reviewed, item?.sourceGuid, item?.actionPath, item?.mode, item?.group, item?.templatePath, item?.copy, item?.outputFolder, item?.timeOverrides]);
  const option = (value, label, selected, disabled = false) => `<option value="${esc(value)}"${String(value) === String(selected ?? '') ? ' selected' : ''}${disabled ? ' disabled' : ''}>${esc(label)}</option>`;
  const emptyInspector = message => `<div class="inspector-empty"><div class="empty-icon" aria-hidden="true">≋</div><h3>아직 선택한 작업이 없습니다</h3><p>${esc(message)}</p></div>`;

  function showNotice(message, kind = 'info') {
    localNotice = message ? { message, kind } : null;
    renderNotice();
  }

  function renderNotice() {
    const notice = localNotice || state.notice;
    const message = typeof notice === 'string' ? notice : notice?.message || notice?.text;
    $('notice').hidden = !message;
    $('notice').className = `notice ${esc(notice?.kind || notice?.type || '')}`;
    $('notice').innerHTML = message ? `<span>${esc(message)}</span><button type="button" class="icon-button" id="dismiss-notice" aria-label="알림 닫기">×</button>` : '';
  }

  function acceptState(next) {
    if (!next || !Array.isArray(next.jobs)) return;
    const previous = job();
    const projectChanged = projectIdentity(state.projectPath) !== projectIdentity(next.projectPath);
    stateRevision++;
    const previousSearchContext = searchContext();
    state = { ...state, ...next };
    if (previousSearchContext !== searchContext()) resetSearch();
    const selected = job();
    if (!projectChanged && previous?.pendingSave && selected?.id === previous.id && !selected.pendingSave && selected.status === 'saved') localNotice = { message: 'Unity 저장 결과를 확인했습니다. 저장된 에셋을 확인하세요.', kind: 'success' };
    if (selected?.pendingSave) preview = null;
    if (previous?.id === selected?.id && targetIdentity(previous) !== targetIdentity(selected)) overrideFields = [];
    const selectionChanged = projectChanged || lastJobId !== (selected?.id || null);
    if (selectionChanged) {
      stopPlayback();
      currentTime = 0;
      selectedWindowId = windows(selected)[0]?.id || null;
      lastJobId = selected?.id || null;
      lastPreviewKey = '';
      preview = null;
      previewJobId = null;
      overrideFields = [];
      timeSettingsContext = '';
      timeSettingsOpen = false;
      drag = null;
    }
    if (projectChanged) {
      searchGeneration++;
      searchResults = [];
      searchSelection.clear();
      searchMessage = '';
      $('animation-query').value = '';
      renderSearch();
    }
    if (preview && (previewJobId !== selected?.id || previewFingerprint !== fingerprint(selected))) preview = null;
    if (selectedWindowId && !windows(selected).some(window => window.id === selectedWindowId)) selectedWindowId = windows(selected)[0]?.id || null;
    currentTime = clamp(currentTime, 0, duration(selected));
    render({ preserveDraft: !selectionChanged });
  }

  async function refreshState() {
    if (!api) return;
    const generation = navigationGeneration;
    const revision = stateRevision;
    const next = await api.getState();
    if (generation === navigationGeneration && revision === stateRevision) acceptState(next);
  }

  async function followNavigation(request) {
    if (!request || typeof request.projectPath !== 'string' ||
      (request.tab !== undefined && !['hits', 'save'].includes(request.tab)) ||
      (request.jobId !== undefined && (typeof request.jobId !== 'string' || !request.jobId))) return;
    const generation = ++navigationGeneration;
    const revision = stateRevision;
    try {
      const next = await api.getState();
      if (generation !== navigationGeneration) return;
      // The service selects the requested job before publishing navigation. A newer
      // state event is authoritative if this read finishes after another change.
      if (revision === stateRevision) acceptState(next);
      if (projectIdentity(state.projectPath) !== projectIdentity(request.projectPath)) {
        showNotice('프로젝트가 변경되어 이전 결과를 열 수 없습니다. 현재 프로젝트에서 다시 선택하세요.', 'error');
        return;
      }
      if (request.jobId && (state.selectedJobId !== request.jobId || job()?.id !== request.jobId)) {
        showNotice('선택한 작업이 변경되어 결과를 열 수 없습니다. 작업 목록에서 다시 선택하세요.', 'error');
        return;
      }
      const tab = request.tab || (request.jobId ? 'hits' : null);
      if (tab) switchTab(tab);
    } catch (error) {
      if (generation === navigationGeneration) showNotice(`작업을 불러오지 못했습니다: ${error?.message || String(error)}`, 'error');
    }
  }

  async function run(label, action, refresh = true) {
    pendingOperations++;
    renderButtons();
    try {
      const result = await action();
      if (refresh) await refreshState();
      return result;
    } catch (error) {
      showNotice(`${label}: ${error?.message || String(error)}`, 'error');
      return undefined;
    } finally {
      pendingOperations--;
      renderButtons();
    }
  }

  function render({ preserveDraft = true } = {}) {
    const focused = document.activeElement;
    const focusId = focused?.id;
    const selection = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
    const draft = preserveDraft && focused?.matches('input:not([type="checkbox"]), textarea') ? focused.value : undefined;
    renderNotice();
    renderProject();
    renderSearch();
    renderJobs();
    renderStage();
    renderHits();
    renderSave();
    renderFooter();
    renderButtons();
    if (draft !== undefined && focusId && $(focusId)) $(focusId).value = draft;
    if (focusId && $(focusId) && document.activeElement !== $(focusId)) {
      $(focusId).focus({ preventScroll: true });
      if (selection && typeof $(focusId).setSelectionRange === 'function') {
        try { $(focusId).setSelectionRange(...selection); } catch { /* Number/select controls do not support ranges. */ }
      }
    }
  }

  function renderProject() {
    const ready = connectionReady();
    const aiReady = state.ai?.available && state.ai?.authenticated !== false;
    const aiText = !state.ai?.available ? 'Codex 연결 필요' : state.ai?.authenticated === false ? 'Codex 로그인 필요' : state.ai?.label || 'Codex 준비됨';
    $('status-chips').innerHTML = `<span class="status-chip ${ready ? 'ready' : 'warn'}" title="${esc(state.connection?.message)}"><span class="dot"></span>${ready ? 'Unity 연결됨' : 'Unity 연결 대기'}</span><span class="status-chip ${aiReady ? 'ready' : 'warn'}" title="${esc(state.ai?.error || aiText)}"><span class="dot"></span>${esc(aiText)}</span>`;
    $('select-project').innerHTML = `<span aria-hidden="true">▱</span> ${state.projectPath ? '프로젝트 변경' : '프로젝트 열기'}`;
    const projectName = String(state.projectPath || '').replace(/[\\/]$/, '').split(/[\\/]/).pop();
    $('project-detail').innerHTML = state.projectPath
      ? `<div class="project-title"><span aria-hidden="true">◇</span><span>${esc(projectName)}</span></div><div class="project-path" title="${esc(state.projectPath)}">${esc(state.projectPath)}</div>${!ready ? `<p class="project-issue">${esc(state.connection?.message || 'Unity에서 프로젝트를 열어 주세요.')}</p>` : ''}<div class="project-actions"><button id="install-integration" class="${ready ? 'text-button' : 'button'}">${ready ? 'Unity 연동 업데이트' : 'Unity 연동 설치 / 복구'}</button></div>`
      : '<p class="project-hint">열려 있는 Unity 프로젝트를 연결해<br>애니메이션과 공격 데이터를 불러옵니다.</p>';
    const actors = state.actors || [];
    const actorId = state.actorId || state.settings?.actorId || '';
    const actor = actors.find(item => String(item.id) === String(actorId));
    const weapons = actor?.weapons || [];
    $('actor-settings').innerHTML = state.projectPath ? `<div class="field"><label for="actor-select">미리보기 캐릭터</label><select id="actor-select" ${!ready ? 'disabled' : ''}>${option('', actors.length ? '캐릭터 선택' : '사용 가능한 캐릭터 없음', actorId)}${actors.map(item => option(item.id, item.label || item.name || item.path, actorId)).join('')}</select></div>${weapons.length ? `<div class="row-fields compact-fields"><div class="field"><label for="weapon-select">미리보기 무기</label><select id="weapon-select">${option('', '기존 활성 무기 전체', state.settings?.weaponId)}${weapons.map(item => option(item.id, item.label || item.name, state.settings?.weaponId)).join('')}</select></div><div class="field"><label for="weapon-bone">부착 본 (선택)</label><input id="weapon-bone" value="${esc(state.settings?.weaponBone || '')}" placeholder="기본 부착 위치"></div></div>` : ''}` : '';
    $('connection-detail').textContent = ready ? `Unity ${state.connection?.unityVersion || ''} · ${projectName}` : state.connection?.message || 'Unity 에디터 연결 대기';
  }

  function resetSearch(message = '') {
    searchGeneration++;
    searchResults = [];
    searchSelection.clear();
    searchMessage = message;
    searchDetails = '';
    searchResultMode = '';
    searchFailed = false;
    searchPending = false;
  }

  function renderSearch() {
    const semantic = $('search-mode').value === 'semantic';
    const active = searchActive();
    $('animation-query-label').textContent = semantic ? '찾고 싶은 동작을 자연어로 설명하세요' : '애니메이션 이름, Animator 상태 또는 경로 검색';
    $('animation-query').placeholder = semantic ? '예: 앞으로 돌진하며 검을 두 번 휘두르는 공격' : '클립 이름, 상태 또는 경로';
    $('search-button').textContent = semantic ? '비슷한 동작 찾기' : '이름 검색';
    $('search-help').textContent = semantic ? 'AI가 클립 이름·상태·경로를 바탕으로 후보를 추천합니다. 실제 동작은 추가 후 미리보기로 확인하세요.' : '클립 이름·Animator 상태·경로로 검색합니다. AI 연결 없이 사용할 수 있습니다.';
    $('search-progress').hidden = !active;
    $('search-progress').textContent = searchCancelPending ? '검색을 취소하고 있습니다…' : state.search?.progressText || '애니메이션 후보를 찾고 있습니다…';
    $('search-form').setAttribute('aria-busy', String(active));
    const container = $('search-results');
    container.hidden = !searchMessage && !searchResults.length;
    const locked = active || pendingOperations > 0 || !connectionReady();
    container.innerHTML = `${searchMessage ? `<p class="search-summary${searchFailed ? ' search-error' : ''}" role="status">${esc(searchMessage)}</p>` : ''}${searchDetails ? `<p class="search-details">${esc(searchDetails)}</p>` : ''}${searchFailed && semantic ? '<button id="use-name-search" type="button" class="text-button">이름으로 검색하기</button>' : ''}` + searchResults.map((clip, index) => `<label class="search-result"><input type="checkbox" data-result="${index}" ${searchSelection.has(index) ? 'checked' : ''} ${locked ? 'disabled' : ''}><span class="result-info"><span class="result-name">${searchResultMode === 'semantic' ? `<span class="result-rank">추천 ${index + 1}</span> ` : ''}${esc(clip.name)}</span>${clip.searchReason ? `<span class="result-reason">${esc(clip.searchReason)}</span>` : ''}<span class="result-meta">${esc(clip.stateName ? `상태 ${clip.stateName} · ` : '')}${seconds(clip.length)} s<br>${esc(clip.path)}${clip.compatible === false ? `<br><span class="result-warning">${esc(clip.reason || '자동 적용 제한')}</span>` : ''}</span></span></label>`).join('') + (searchResults.length ? `<button id="add-search-results" class="button full-width" ${!searchSelection.size || locked ? 'disabled' : ''}>선택한 애니메이션 추가 (${searchSelection.size})</button>` : '');
  }

  function renderJobs() {
    const jobs = state.jobs || [];
    $('job-count').textContent = jobs.length;
    $('job-list').innerHTML = jobs.length ? jobs.map((item, index) => `<div class="job-card ${item.id === state.selectedJobId ? 'active' : ''}" data-job="${esc(item.id)}" role="listitem" tabindex="0" aria-label="${esc(item.clip?.name)} · ${esc(statusLabel(item))}"><div class="job-index">${String(index + 1).padStart(2, '0')}</div><div class="job-info"><div class="job-name" title="${esc(item.clip?.name)}">${esc(item.clip?.name || '애니메이션')}</div><div class="job-meta"><span class="job-status ${esc(item.status)}">${esc(statusLabel(item))}</span><span>·</span><span>${seconds(duration(item))} s</span>${windows(item).length ? `<span>· ${windows(item).length}타</span>` : ''}</div>${lockedJob(item) || item.error ? `<div class="job-progress">${esc(item.error || item.progressText || '작업을 준비하고 있습니다.')}</div>` : ''}</div><button class="icon-button job-remove" data-remove-job="${esc(item.id)}" title="작업 목록에서 제거" aria-label="${esc(item.clip?.name)} 작업 제거" ${lockedJob(item) || analysisActive() ? 'disabled' : ''}>×</button></div>`).join('') : '<div class="empty-list">분석할 애니메이션이 없습니다.<br>원하는 동작을 설명하거나 파일을 놓아 주세요.</div>';
  }

  function renderStage() {
    const selected = job();
    $('stage-title').textContent = selected?.clip?.name || '타격의 순간을 찾아보세요';
    $('stage-subtitle').textContent = selected ? `${selected.clip?.stateName ? `${selected.clip.stateName} · ` : ''}${seconds(duration(selected))}초 · ${statusLabel(selected)}${selected.clip?.path ? ` · ${selected.clip.path}` : ''}` : '애니메이션을 추가하면 두 시점에서 동작을 검토할 수 있습니다.';
    const frames = selected?.frames || [];
    const key = `${selected?.id || 'empty'}:${frames.length}:${frames[0]?.url || ''}:${selected?.status}`;
    if (key !== lastPreviewKey) {
      lastPreviewKey = key;
      if (frames.length) {
        $('preview-area').innerHTML = '<div class="preview-grid composite-preview"><span class="view-label">01 / 사선</span><span class="view-label side-label">02 / 측면</span><img id="composite-frame" alt="동일 시간의 공격 애니메이션 사선 및 측면 미리보기"><span id="frame-stamp" class="frame-stamp"></span></div><div id="preview-banner" class="preview-banner" hidden></div>';
      } else if (selected) {
        const isBusy = busyJob(selected);
        $('preview-area').innerHTML = `<div class="stage-empty"><div class="motion-symbol" aria-hidden="true"><span class="motion-ring"></span><span class="motion-slash"></span><span class="motion-point"></span></div><span class="eyebrow">${isBusy ? 'PREPARING YOUR FRAMES' : 'READY FOR ANALYSIS'}</span><h3>${isBusy ? '공격 동작을 살펴보는 중' : '분석할 준비가 되었습니다'}</h3><p>${esc(selected.error || (isBusy ? selected.progressText || 'Unity에서 미리보기 이미지를 촬영하고 있습니다.' : 'AI 분석을 시작하면 두 시점의 프레임과\n타격 후보 구간을 확인할 수 있습니다.')).replace(/\n/g, '<br>')}</p></div>`;
      } else {
        $('preview-area').innerHTML = '<div class="stage-empty"><div class="motion-symbol" aria-hidden="true"><span class="motion-ring"></span><span class="motion-slash"></span><span class="motion-point"></span></div><span class="eyebrow">FRAME BY FRAME. HIT BY HIT.</span><h3>공격 동작을 판정 구간으로</h3><p>Unity 프로젝트를 연결하고<br>분석할 애니메이션을 추가하세요.</p><div class="workflow"><span>01 <b>동작 입력</b></span><i>→</i><span>02 <b>타이밍 검토</b></span><i>→</i><span>03 <b>SO 저장</b></span></div></div>';
      }
    }
    const total = duration(selected);
    $('seek').max = total || 1;
    $('timeline-ruler').innerHTML = Array.from({ length: 6 }, (_, i) => `<span style="left:${i * 20}%">${(total * i / 5).toFixed(2)}${i === 5 ? ' s' : ''}</span>`).join('');
    renderTimeline();
    updateFrame();
    const footer = selected?.clip?.compatible === false ? selected.clip.reason || '이 애니메이션은 자동 적용을 지원하지 않습니다.' : selected?.analysisStatus === 'no_hit' || selected?.analysisStatus === 'no-hit' ? 'AI가 타격 구간을 찾지 못했습니다. 동작을 확인한 뒤 수동으로 구간을 추가할 수 있습니다.' : '분석 결과는 저장 전 사용자의 검토가 필요합니다. 촬영 주기는 분석 정확도를 보장하지 않습니다.';
    $('stage-bottom').innerHTML = `<span class="dot"></span><span>${esc(footer)}</span>`;
  }

  function renderTimeline() {
    const selected = job();
    const total = duration(selected);
    $('timeline-windows').innerHTML = windows(selected).map((window, index) => `<div class="timeline-window ${window.id === selectedWindowId ? 'selected' : ''} ${window.uncertain ? 'uncertain' : ''}" data-window="${esc(window.id)}" style="left:${total ? clamp(number(window.start) / total * 100, 0, 100) : 0}%;width:${total ? clamp((number(window.end) - number(window.start)) / total * 100, 0, 100) : 0}%" title="${index + 1}타: ${seconds(window.start)}–${seconds(window.end)}초"><div class="timeline-handle start" data-edge="start"></div><span>${index + 1}</span><div class="timeline-handle end" data-edge="end"></div></div>`).join('');
    $('timeline-hint').textContent = windows(selected).length ? '양쪽 경계를 드래그하여 시간을 조정하세요' : '히트 구간을 추가하거나 AI 분석을 시작하세요';
  }

  function nearestFrame(frames, time) {
    let best = frames[0];
    for (const frame of frames) if (Math.abs(number(frame.time) - time) < Math.abs(number(best.time) - time)) best = frame;
    return best;
  }

  function frameLabel(frame) {
    const match = String(frame?.id || '').match(/(?:^|_)f(\d+)$/i);
    return match ? String(Number(match[1])).padStart(4, '0') : String(frame?.id || '—').slice(-12);
  }

  function updateFrame() {
    const selected = job();
    const total = duration(selected);
    const frames = selected?.frames || [];
    const frame = frames.length ? nearestFrame(frames, currentTime) : null;
    const img = $('composite-frame');
    if (img && frame?.url && img.getAttribute('src') !== frame.url) img.src = frame.url;
    if ($('frame-stamp')) { $('frame-stamp').textContent = frame ? `F ${frameLabel(frame)} / ${seconds(frame.time)} s` : ''; $('frame-stamp').title = frame?.id || ''; }
    $('time-readout').innerHTML = `${seconds(currentTime)} <span>/ ${seconds(total)} s</span>`;
    $('frame-readout').textContent = frame ? `FRAME ${frameLabel(frame)}` : 'FRAME —';
    $('frame-readout').title = frame?.id || '';
    $('seek').value = currentTime;
    $('playhead').style.left = `${total ? currentTime / total * 100 : 0}%`;
    const activeHits = windows(selected).filter(window => currentTime >= number(window.start) && currentTime <= number(window.end));
    const banner = $('preview-banner');
    if (banner) {
      banner.hidden = !activeHits.length;
      banner.textContent = activeHits.map(window => `${windows(selected).indexOf(window) + 1}타 판정 구간${window.uncertain ? ' · AI 확인 필요' : ''}`).join(' / ');
    }
  }

  function windowError(window, total) {
    if (!Number.isFinite(Number(window.start)) || !Number.isFinite(Number(window.end))) return '시작과 종료 시간을 숫자로 입력하세요.';
    if (number(window.start) < 0 || number(window.end) > total + .00001) return `0–${seconds(total)}초 범위 안에서 설정하세요.`;
    if (number(window.end) <= number(window.start)) return '종료 시간은 시작 시간보다 커야 합니다.';
    return '';
  }

  function renderHits() {
    const selected = job();
    const hits = windows(selected);
    $('hit-count').textContent = hits.length;
    if (!selected) {
      $('hits-panel').innerHTML = emptyInspector('작업을 선택하면 AI가 찾은 히트 구간과 판단 근거를 확인하고 편집할 수 있습니다.');
      return;
    }
    const target = targetFor(selected);
    const previousHits = target?.windows || [];
    const analysisStatus = typeof selected.analysisStatus === 'string' ? selected.analysisStatus : selected.analysisStatus?.status;
    let callout = selected.pendingSave ? `<div class="callout warning">Unity 저장 결과를 확인하고 있습니다. 확인 전까지 이 작업의 편집·재분석·제거는 잠깁니다.${selected.error ? '<br><br>' + esc(selected.error) : '<br>연결이 복구되면 결과를 자동으로 확인합니다.'}</div>` : selected.error ? `<div class="callout error">${esc(selected.error)}</div>` : '';
    if (['no_hit', 'no-hit', 'no_hits'].includes(analysisStatus)) callout += '<div class="callout warning">AI가 타격 구간을 찾지 못했습니다. 프레임을 확인한 뒤 필요하면 직접 추가하세요.</div>';
    if (['uncertain', 'undetermined', 'unresolved'].includes(analysisStatus)) callout += '<div class="callout warning">AI가 동작을 확실하게 판별하지 못했습니다. 프레임과 판단 근거를 직접 검토하세요.</div>';
    if (selected.clip?.compatible === false) callout += `<div class="callout warning">자동 적용 제한: ${esc(selected.clip.reason || '애니메이션 시간과 공격 실행 시간을 안전하게 대응할 수 없습니다.')}</div>`;
    if (selected.analysisSummary || selected.reason || selected.analysisNotes?.length) callout += `<div class="callout">${esc(selected.analysisSummary || selected.reason || selected.analysisNotes.at(-1))}</div>`;
    $('hits-panel').innerHTML = `<div class="inspector-summary"><strong>${hits.length ? `${hits.length}개의 공격 판정 구간` : '판정 구간 없음'}</strong><button id="add-hit" class="text-button" ${busyJob(selected) || !duration(selected) ? 'disabled' : ''}>＋ 구간 추가</button></div>${callout}${hits.length ? hits.map((window, index) => {
      const error = windowError(window, duration(selected));
      const sourceIndex = window.sourceIndex ?? (previousHits[index]?.sourceIndex ?? (index < previousHits.length ? index : -1));
      return `<article class="hit-card ${window.id === selectedWindowId ? 'selected' : ''}" data-hit-card="${esc(window.id)}"><div class="hit-card-header"><div class="hit-name"><span>${index + 1}</span> HIT ${String(index + 1).padStart(2, '0')}${window.uncertain ? '<span class="hit-confidence">확인 필요</span>' : ''}</div><button class="icon-button" data-delete-hit="${esc(window.id)}" title="히트 구간 삭제" aria-label="${index + 1}타 구간 삭제" ${busyJob(selected) ? 'disabled' : ''}>×</button></div><div class="row-fields"><div class="field"><label for="hit-${esc(window.id)}-start">시작 (초)</label><input id="hit-${esc(window.id)}-start" data-hit-input="${esc(window.id)}" data-boundary="start" type="number" min="0" max="${duration(selected)}" step="0.001" value="${seconds(window.start)}" ${busyJob(selected) ? 'disabled' : ''}></div><div class="field"><label for="hit-${esc(window.id)}-end">종료 (초)</label><input id="hit-${esc(window.id)}-end" data-hit-input="${esc(window.id)}" data-boundary="end" type="number" min="0" max="${duration(selected)}" step="0.001" value="${seconds(window.end)}" ${busyJob(selected) ? 'disabled' : ''}></div></div><p class="hit-duration">유지 ${seconds(number(window.end) - number(window.start))} s</p>${error ? `<p class="hit-error">${esc(error)}</p>` : ''}${target ? `<div class="field hit-mapping"><label for="hit-${esc(window.id)}-source">데미지 · 피드백 값 연결</label><select id="hit-${esc(window.id)}-source" data-hit-source="${esc(window.id)}">${option(-1, '새 타격 · 기본 공격 값 상속', sourceIndex)}${previousHits.map((old, i) => option(old.sourceIndex ?? i, `기존 ${i + 1}타 유지 (${seconds(old.start)}–${seconds(old.end)}s)`, sourceIndex)).join('')}</select></div>` : ''}${window.reason ? `<p class="hit-reason">${esc(window.reason)}</p>` : ''}</article>`;
    }).join('') : '<div class="empty-list">AI 분석을 시작하거나<br>현재 시간에 히트 구간을 추가하세요.</div>'}<div class="review-box"><label class="review-check"><input id="reviewed-check" type="checkbox" ${selected.reviewed ? 'checked' : ''} ${busyJob(selected) ? 'disabled' : ''}><span><strong>히트 구간과 타격 수를 검토했습니다</strong><small>프레임, 판정 경계와 기존 타격의 대응을 확인합니다.</small></span></label></div>`;
  }

  function renderSave() {
    const selected = job();
    if (!selected) {
      $('save-panel').innerHTML = emptyInspector('검토한 히트 구간을 기존 공격 데이터에 적용하거나 템플릿을 이용해 새 공격으로 등록합니다.');
      return;
    }
    const isNew = selected.mode === 'register';
    const sources = state.sources || [];
    const sourceTargets = (state.targets || []).filter(target => !selected.sourceGuid || target.sourceGuid === selected.sourceGuid);
    const groups = (state.groups || []).filter(group => !selected.sourceGuid || group.sourceGuid === selected.sourceGuid);
    const group = groups.find(item => String(item.id) === String(selected.group));
    const target = targetFor(selected);
    const targetOptions = sourceTargets.map(item => {
      const status = item.supported === false ? ' · 지원 제외' : item.needsClipAssignment ? ` · 클립 없음${isNew ? '' : ' · 저장 시 연결'}` : '';
      return option(item.actionPath, `${item.label || item.actionPath}${status}`, isNew ? selected.templatePath : selected.actionPath);
    }).join('');
    const changesClip = target?.needsClipAssignment || (target?.currentClip && !sameClip(target.currentClip, selected.clip));
    const clipAssignment = !isNew && changesClip && target.supported !== false
      ? `<div id="clip-assignment-notice" class="callout" style="margin-top:12px">${target.currentClip ? `기존 클립 <strong>${esc(target.currentClip.name)}</strong>을 교체합니다.` : '이 공격 상태에 애니메이션 클립이 없습니다.'}<br>저장하면 <strong>${esc(target.animationName)}</strong> 상태에 분석한 <strong>${esc(selected.clip?.name)}</strong> 클립을 연결하고 히트 구간을 적용합니다. 상태 이름과 전이는 유지합니다.</div>` : '';
    const currentClip = target?.currentClip ? `<p class="field-note" style="margin-top:7px;overflow-wrap:anywhere">현재 클립: ${esc(target.currentClip.name)}<br>${esc(target.currentClip.path)}</p>` : '';
    const attackDuration = target ? `<p id="attack-duration-change" class="field-note" style="margin-top:8px">공격 길이: ${seconds(target.duration)} s → ${seconds(duration(selected))} s<br>저장할 공격 길이를 분석한 클립에 맞춥니다.</p>` : '';
    const savedAssets = selected.savedAssets || [];
    $('save-panel').innerHTML = `${selected.pendingSave ? `<div class="callout warning">이전 저장 요청의 결과를 확인하고 있습니다.${selected.error ? '<br><br>' + esc(selected.error) : '<br>Unity 연결이 복구되면 결과를 자동으로 확인합니다.'}</div>` : ''}<div class="save-mode" role="group" aria-label="저장 방식"><button data-save-mode="update" class="${!isNew ? 'active' : ''}">기존 공격 수정</button><button data-save-mode="register" class="${isNew ? 'active' : ''}">새 공격 등록</button></div><div class="field"><label for="source-select">대상 폼 / ScriptableObject</label><select id="source-select">${option('', sources.length ? '대상 폼을 선택하세요' : '공격 데이터가 없습니다', selected.sourceGuid)}${sources.map(item => option(item.guid, item.label || item.name || item.guid, selected.sourceGuid)).join('')}</select></div>${isNew ? `<div class="field"><label for="group-select">등록할 공격 종류</label><select id="group-select">${option('', '공격 종류 선택', selected.group)}${groups.map(item => option(item.id, `${item.label}${item.supported === false ? ' · 지원 제외' : ''}`, selected.group)).join('')}</select></div><div class="field"><label for="template-select">기존 공격 템플릿</label><select id="template-select">${option('', '밸런스 · 피드백을 복사할 공격 선택', selected.templatePath)}${targetOptions}</select><p class="field-note">템플릿을 복사하고 새 애니메이션과 히트 구간을 연결합니다. 목록형 공격은 단계 추가, 단일 공격은 생성·교체합니다.</p></div>` : `<div class="field"><label for="target-select">수정할 공격 단계</label><select id="target-select">${option('', '공격 단계 선택', selected.actionPath)}${targetOptions}</select></div>`}${target?.animationName ? `<p class="field-note" style="margin-top:8px">현재 상태: ${esc(target.animationName)} · ${target.needsClipAssignment ? '클립 없음' : seconds(target.duration) + ' s'}</p>` : ''}${target?.supported === false || group?.supported === false ? `<div class="callout warning" style="margin-top:12px">${esc(target?.reason || group?.reason || '이 공격은 별도 판정 로직을 사용하므로 자동 적용을 지원하지 않습니다.')}</div>` : ''}${currentClip}${clipAssignment}${attackDuration}${renderOverrideFields(selected)}<hr class="form-separator"><label class="checkbox-field"><input id="copy-check" type="checkbox" ${selected.copy ? 'checked' : ''}> 복사본에 저장</label><p class="field-note" style="margin-top:7px">${selected.copy ? 'ScriptableObject를 복제하고, 변경이 필요한 Animator Controller도 함께 복제합니다.' : '선택한 원본을 수정합니다. Unity Undo와 변경 전 스냅샷을 제공합니다.'}</p>${selected.copy ? `<div class="field"><label for="output-folder">복사본 저장 폴더</label><input id="output-folder" value="${esc(selected.outputFolder || '')}" placeholder="Assets/AutoHitTimer/Generated"><p class="field-note">Unity 프로젝트의 Assets 내부 경로</p></div>` : ''}<div class="callout" style="margin-top:15px;margin-bottom:0">기존 타격의 데미지와 피드백을 유지합니다. 신규 타격은 기본 공격 값을 상속하며, 타수 증가에 따른 피해 변화를 저장 전에 검토합니다.</div>${renderDiff(selected)}<div class="review-box"><label class="review-check"><input id="save-reviewed-check" type="checkbox" ${selected.reviewed ? 'checked' : ''} ${busyJob(selected) ? 'disabled' : ''}><span><strong>저장할 구간과 타격 대응을 확인했습니다</strong><small>타격 수, 값 상속 및 보정한 시간 설정을 함께 검토합니다.</small></span></label></div>${savedAssets.length ? `<hr class="form-separator"><div class="diff-title">저장된 에셋</div>${savedAssets.map(asset => { const path = typeof asset === 'string' ? asset : asset.path; return `<div class="saved-asset"><span>${esc(path || asset.label || '에셋')}</span>${path ? `<button class="text-button" data-reveal-asset="${esc(path)}">열기 ↗</button>` : ''}</div>`; }).join('')}` : ''}`;
  }

  function renderOverrideFields(selected) {
    const existing = selected.timeOverrides || [];
    const fields = [...(targetFor(selected)?.timeSettings || []), ...overrideFields];
    for (const item of existing) if (!fields.some(field => field.path === item.path)) fields.push({ ...item, label: item.path, min: item.path === 'Feedback.Slash.SlashVFXStartTime' ? -1 : 0 });
    if (!fields.length) return '';
    const context = selected.id + ':' + targetIdentity(selected);
    timeSettingsOpen = context === timeSettingsContext ? $('time-settings')?.open ?? timeSettingsOpen : false;
    timeSettingsContext = context;
    const labels = {
      'Execution.ComboTransitionTime': '다음 콤보 전환',
      'Execution.Movement.MovementStartTime': '이동 시작',
      'Execution.Movement.MovementEndTime': '이동 종료',
      'Execution.Movement.TargetApproach.ApproachEndTime': '타겟 접근 종료',
      'Execution.Movement.TargetApproach.RotationEndTime': '타겟 회전 종료',
      'Feedback.Trail.TrailStartTime': '트레일 시작',
      'Feedback.Trail.TrailEndTime': '트레일 종료',
      'Feedback.Slash.SlashVFXStartTime': '슬래시 이펙트 시작'
    };
    const settings = [...new Map(fields.map(item => [item.path, item])).values()].map(item => ({
      ...item, max: duration(selected), value: existing.find(override => override.path === item.path)?.value ?? item.value ?? ''
    }));
    const invalid = item => item.value !== '' && (number(item.value) < number(item.min) || number(item.value) > item.max);
    return '<details id="time-settings" style="margin-top:16px"' + (timeSettingsOpen || settings.some(invalid) ? ' open' : '') + '><summary class="diff-title">공격 시간 설정 (' + settings.length + '개)</summary><p class="field-note">콤보 전환, 이동과 이펙트 시간을 수정할 수 있습니다. 분석한 클립 길이 안에서 설정하세요.</p>' + settings.map(item => {
      const path = item.path;
      return '<div class="field"><label for="override-' + esc(path) + '">' + esc(labels[path] || item.label || path) + ' (초)</label><input id="override-' + esc(path) + '" data-time-override="' + esc(path) + '" type="number" min="' + number(item.min) + '" max="' + item.max + '" step="0.001" value="' + esc(item.value) + '"' + (invalid(item) ? ' aria-invalid="true"' : '') + '><p class="' + (invalid(item) ? 'hit-error' : 'field-note') + '">허용 범위 ' + number(item.min) + '–' + seconds(item.max) + '초</p></div>';
    }).join('') + '</details>';
  }

  function renderDiff(selected) {
    if (!preview || previewJobId !== selected.id) return '';
    const issues = preview.issues || [];
    const beforeCount = preview.hitCountBefore ?? preview.before?.windows?.length ?? '?';
    const afterCount = preview.hitCountAfter ?? windows(selected).length;
    let summary = preview.summary;
    if (typeof summary === 'object') summary = Object.entries(summary || {}).map(([key, value]) => key + ': ' + (typeof value === 'object' ? JSON.stringify(value) : value)).join('\n');
    const mapping = preview.mapping;
    const clipAssignment = preview.clipAssignment;
    const affectedAttacks = preview.affectedAttacks || [];
    const durationChange = Number.isFinite(preview.before?.duration) && Number.isFinite(preview.after?.duration)
      ? '<div id="duration-diff" class="diff-counts">공격 길이 <strong>' + seconds(preview.before.duration) + ' s</strong><span>→</span><strong>' + seconds(preview.after.duration) + ' s</strong></div>' : '';
    const damage = Number.isFinite(preview.damageBefore) && Number.isFinite(preview.damageAfter)
      ? '<div class="diff-counts">기본 피해 계수 <strong>' + esc(preview.damageBefore) + '</strong><span>→</span><strong>' + esc(preview.damageAfter) + '</strong></div><p class="field-note" style="margin-top:7px">' + esc(preview.damageNote) + '</p>' : '';
    return '<div class="diff-box"><div class="diff-title">' + (preview.canApply ? '변경 내용 검토' : '적용 전 확인 필요') + '</div><p class="diff-summary">' + esc(summary || '확정한 히트 구간과 대상의 변경 내용을 확인하세요.').replace(/\n/g, '<br>') + '</p><div class="diff-counts">타격 수 <strong>' + esc(beforeCount) + '</strong><span>→</span><strong>' + esc(afterCount) + '</strong></div>' + damage +
      (mapping ? '<p class="field-note" style="margin-top:10px">기존 값 유지 ' + esc(mapping.retained ?? mapping.preserved ?? mapping.kept ?? 0) + '개 · 제거 ' + esc(mapping.removed ?? 0) + '개 · 신규 상속 ' + esc(mapping.added ?? 0) + '개</p>' : '') +
      (preview.proposedStateName ? '<div class="diff-detail">새 Animator 상태: ' + esc(preview.proposedStateName) + '</div>' : '') +
      durationChange +
      (affectedAttacks.length ? '<div id="shared-state-notice" class="callout warning"><strong>같은 Animator 상태를 사용하는 공격</strong><ul>' + affectedAttacks.map(item => '<li>' + esc(item.sourceName) + ' / ' + esc(item.label) + '</li>').join('') + '</ul>이 Controller를 사용하는 해당 공격들의 재생 클립도 바뀝니다. 각 공격의 히트 구간과 시간 설정은 별도로 수정해야 합니다.</div>' : '') +
      (clipAssignment ? '<div id="clip-assignment-diff" class="diff-detail"><strong>' + (clipAssignment.previousClipName ? '기존 클립 교체' : '기존 상태에 클립 연결') + '</strong><br>상태: ' + esc(clipAssignment.stateName) + '<br>' + esc(clipAssignment.previousClipName || '클립 없음') + ' → ' + esc(clipAssignment.clipName) + (clipAssignment.previousClipPath ? '<br>기존: ' + esc(clipAssignment.previousClipPath) : '') + (clipAssignment.clipPath ? '<br>연결: ' + esc(clipAssignment.clipPath) : '') + '<br>' + (selected.copy ? '복제한 Animator Controller에 클립을 연결합니다.' : '원본 Animator Controller에 클립을 연결합니다.') + '</div>' : '') +
      (issues.length ? '<ul class="diff-issues">' + issues.map(issue => '<li>' + esc(typeof issue === 'string' ? issue : issue.message || issue.reason || JSON.stringify(issue)) + '</li>').join('') + '</ul>' : '') +
      (preview.before || preview.after ? '<details class="diff-detail"><summary>변경 데이터 자세히 보기</summary><div>' + esc(JSON.stringify({ before: preview.before, after: preview.after }, null, 2)) + '</div></details>' : '') + '</div>';
  }

  function renderFooter() {
    const selected = job();
    if (!selected) {
      $('inspector-footer').innerHTML = '<button class="button primary" disabled>검토 후 저장</button><p>히트 타이밍은 초 단위로 기록됩니다.</p>';
      return;
    }
    if (selected.pendingSave) {
      $('inspector-footer').innerHTML = '<button class="button primary" disabled>Unity 저장 결과 확인 중</button><p>Unity 연결이 복구되면 저장 결과를 자동으로 확인합니다.</p>';
      return;
    }
    if (currentTab === 'hits') {
      $('inspector-footer').innerHTML = `<button id="go-save" class="button primary">저장 대상 선택 <span aria-hidden="true">→</span></button><p>분석과 편집만으로 게임 데이터가 변경되지 않습니다.</p>`;
    } else {
      const canApply = preview?.canApply && selected.reviewed && previewJobId === selected.id;
      $('inspector-footer').innerHTML = `<button id="${canApply ? 'apply-change' : 'preview-change'}" class="button primary">${canApply ? selected.copy ? '검토한 복사본 저장' : selected.mode === 'register' ? '검토한 공격 등록' : '검토한 변경 적용' : '변경 내용 검토'}</button><p>${!selected.reviewed ? '위의 검토 완료를 체크한 뒤 변경 내용을 확인하세요.' : canApply ? '저장 직전에 원본 변경 여부를 다시 확인합니다.' : 'SO · 타격 수 · 데미지 변화를 확인한 뒤 저장합니다.'}</p>`;
    }
  }

  function renderButtons() {
    const selected = job();
    const locked = pendingOperations > 0;
    $('select-project').disabled = locked || analysisActive();
    $('refresh-catalog').disabled = !state.projectPath || locked || analysisActive();
    $('search-button').disabled = !connectionReady() || locked || state.busy || analysisActive() || searchActive() || searchCancelPending;
    $('cancel-search').hidden = !searchActive() && !searchCancelPending;
    $('cancel-search').disabled = searchCancelPending;
    $('search-mode').disabled = locked || searchCancelPending;
    $('animation-query').disabled = locked || searchActive() || searchCancelPending;
    $('drop-zone').disabled = !connectionReady() || locked || searchActive() || searchCancelPending;
    if ($('actor-select')) $('actor-select').disabled = !connectionReady() || locked;
    if ($('add-search-results')) $('add-search-results').disabled = !searchSelection.size || !connectionReady() || locked || searchActive();
    for (const checkbox of document.querySelectorAll('[data-result]')) checkbox.disabled = !connectionReady() || locked || searchActive();
    $('analyze-all').disabled = !canAnalyze() || !state.actorId || locked || !(state.jobs || []).some(item => !item.pendingSave && ['draft', 'failed', 'cancelled'].includes(item.status));
    $('cancel-analysis').hidden = !analysisActive();
    $('cancel-analysis').disabled = locked;
    $('analyze-selected').hidden = !selected;
    $('analyze-selected').disabled = !selected || !canAnalyze() || !state.actorId || locked || Boolean(selected.pendingSave);
    $('analyze-selected').innerHTML = `<span aria-hidden="true">✦</span> ${selected?.frames?.length ? '다시 분석' : 'AI 분석'}`;
    const hasFrames = Boolean(selected?.frames?.length);
    $('play-pause').disabled = !hasFrames;
    $('previous-frame').disabled = !hasFrames;
    $('next-frame').disabled = !hasFrames;
    $('seek').disabled = !duration(selected);
    if ($('preview-change')) $('preview-change').disabled = locked || !connectionReady() || state.busy || !selected?.reviewed || !windows(selected).length || !selected?.sourceGuid || !(selected?.mode === 'register' ? selected.group && selected.templatePath : selected?.actionPath) || windows(selected).some(window => windowError(window, duration(selected)));
    if ($('apply-change')) $('apply-change').disabled = locked || !connectionReady() || state.busy || !selected?.reviewed;
    if ($('install-integration')) $('install-integration').disabled = locked || state.busy || analysisActive() || searchActive();
    if (lockedJob(selected)) for (const control of document.querySelectorAll('#hits-panel input, #hits-panel select, #hits-panel button, #save-panel input, #save-panel select, #save-panel button')) control.disabled = true;
  }

  async function patchJob(patch) {
    const selected = job();
    if (!selected || lockedJob(selected)) return;
    preview = null;
    if (targetIdentity({ ...selected, ...patch }) !== targetIdentity(selected)) patch = { ...patch, timeOverrides: [] };
    if (Object.keys(patch).some(key => !['timeOverrides', 'reviewed'].includes(key))) overrideFields = [];
    await run('작업 수정 실패', () => api.updateJob(selected.id, patch));
    render();
  }

  async function patchWindows(next) {
    await patchJob({ windows: next, reviewed: false });
  }

  function switchTab(tab) {
    if (!['hits', 'save'].includes(tab)) return;
    currentTab = tab;
    for (const name of ['hits', 'save']) {
      $(`tab-${name}`).classList.toggle('active', name === tab);
      $(`tab-${name}`).setAttribute('aria-selected', String(name === tab));
      $(`${name}-panel`).hidden = name !== tab;
    }
    renderFooter();
    renderButtons();
  }

  function stopPlayback() {
    playing = false;
    if (animationRequest) cancelAnimationFrame(animationRequest);
    animationRequest = 0;
    $('play-pause').textContent = '▶';
    $('play-pause').classList.remove('playing');
    $('play-pause').setAttribute('aria-label', '재생');
  }

  function togglePlayback() {
    if (!job()?.frames?.length) return;
    if (playing) return stopPlayback();
    if (currentTime >= duration(job())) currentTime = 0;
    playing = true;
    lastPlaybackTime = performance.now();
    $('play-pause').textContent = 'Ⅱ';
    $('play-pause').classList.add('playing');
    $('play-pause').setAttribute('aria-label', '일시 정지');
    const tick = now => {
      if (!playing) return;
      currentTime += (now - lastPlaybackTime) / 1000 * number($('playback-speed').value, 1);
      lastPlaybackTime = now;
      if (currentTime >= duration(job())) { currentTime = duration(job()); stopPlayback(); }
      updateFrame();
      if (playing) animationRequest = requestAnimationFrame(tick);
    };
    animationRequest = requestAnimationFrame(tick);
  }

  function stepFrame(direction) {
    stopPlayback();
    const frames = [...(job()?.frames || [])].sort((a, b) => number(a.time) - number(b.time));
    const next = direction > 0 ? frames.find(frame => number(frame.time) > currentTime + .0001) : frames.reverse().find(frame => number(frame.time) < currentTime - .0001);
    currentTime = next ? number(next.time) : direction > 0 ? duration(job()) : 0;
    updateFrame();
  }

  function selectHit(id, seek = true) {
    selectedWindowId = id;
    const hit = windows(job()).find(item => item.id === id);
    if (seek && hit) { stopPlayback(); currentTime = number(hit.start); updateFrame(); }
    renderTimeline();
    renderHits();
  }

  async function searchAnimations() {
    if (!connectionReady()) { showNotice('먼저 Unity 프로젝트를 연결해 주세요.'); return; }
    if (pendingOperations || state.busy || analysisActive() || searchActive() || searchCancelPending) return;
    const query = $('animation-query').value.trim();
    const mode = $('search-mode').value;
    resetSearch();
    if (!query) {
      searchMessage = mode === 'semantic' ? '찾고 싶은 동작을 설명해 주세요. 예: 앞으로 돌진하며 검을 두 번 휘두르는 공격' : '클립 이름, Animator 상태 또는 경로를 입력해 주세요.';
      renderSearch();
      $('animation-query').focus();
      return;
    }
    const generation = searchGeneration;
    const context = searchContext();
    searchPending = true;
    renderSearch();
    renderButtons();
    try {
      const result = await api.searchAnimations(query, { mode });
      if (generation !== searchGeneration || context !== searchContext()) return;
      searchResults = Array.isArray(result) ? result : result?.clips || result?.animations || result?.results || [];
      searchResultMode = result?.mode || mode;
      searchSelection = new Set();
      searchMessage = result?.summary || (searchResults.length ? `${searchResults.length}개의 후보를 찾았습니다. 추가할 애니메이션을 선택하세요.` : '일치하는 애니메이션이 없습니다. 다른 동작이나 이름으로 검색해 보세요.');
      searchDetails = `${Number.isFinite(result?.searchedCount) ? `${result.searchedCount}개 후보 검토 · ` : ''}${searchResults.length}개 결과${result?.truncated ? ' · 추가 후보가 있어 상위 결과만 표시합니다.' : ''}`;
    } catch (error) {
      if (generation !== searchGeneration || context !== searchContext()) return;
      const cancelled = error?.code === 'CANCELLED' || error?.name === 'AbortError';
      searchFailed = !cancelled;
      searchMessage = cancelled ? '검색을 취소했습니다.' : `검색하지 못했습니다: ${error?.message || String(error)}${mode === 'semantic' ? ' 이름으로 찾기도 사용할 수 있습니다.' : ''}`;
    } finally {
      if (generation === searchGeneration) searchPending = false;
      renderSearch();
      renderButtons();
    }
  }

  async function cancelSearch(message = '검색을 취소했습니다.') {
    const active = searchActive();
    resetSearch(message);
    if (active && !searchCancelPending) {
      searchCancelPending = true;
      renderSearch();
      renderButtons();
      try { await api.cancelAnimationSearch(); }
      catch (error) { showNotice(`검색 취소 실패: ${error?.message || String(error)}`, 'error'); }
      finally { searchCancelPending = false; }
    }
    renderSearch();
    renderButtons();
  }

  async function importFiles(files) {
    if (!connectionReady()) { showNotice('먼저 Unity 프로젝트를 연결해 주세요.'); return; }
    if (pendingOperations || searchActive() || searchCancelPending) return;
    const paths = Array.from(files).map(file => api.filePath(file)).filter(Boolean);
    if (!paths.length) return;
    if (paths.some(path => !/\.(fbx|anim)$/i.test(path))) { showNotice('FBX 또는 ANIM 파일만 추가할 수 있습니다.', 'error'); return; }
    resetSearch();
    const generation = searchGeneration;
    const context = searchContext();
    renderSearch();
    const result = await run('애니메이션 파일 가져오기 실패', () => api.importFiles(paths));
    if (generation !== searchGeneration || context !== searchContext()) return;
    const clips = Array.isArray(result) ? result : result?.clips || result?.animations || [];
    if (clips.length === 1) await run('작업 추가 실패', () => api.addJobs(clips));
    else if (clips.length > 1) {
      searchResults = clips;
      searchSelection = new Set();
      searchMessage = `${clips.length}개의 클립을 가져왔습니다. 추가할 애니메이션을 선택하세요.`;
      renderSearch();
      showNotice(`${clips.length}개의 클립을 찾았습니다. 분석할 클립을 선택해 주세요.`);
    }
  }

  $('search-form').addEventListener('submit', event => { event.preventDefault(); searchAnimations(); });
  $('animation-query').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); searchAnimations(); } });
  $('search-mode').addEventListener('change', () => cancelSearch(''));
  $('cancel-search').addEventListener('click', () => cancelSearch());
  $('select-project').addEventListener('click', async () => { await cancelSearch(''); await run('프로젝트 선택 실패', () => api.selectProject()); });
  $('refresh-catalog').addEventListener('click', () => run('목록 새로고침 실패', () => api.refreshCatalog()));
  $('drop-zone').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
  $('drop-zone').addEventListener('dragover', event => { event.preventDefault(); if (connectionReady()) $('drop-zone').classList.add('dragging'); });
  $('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('dragging'));
  $('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); importFiles(event.dataTransfer.files); });
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('drop', event => event.preventDefault());
  $('analyze-all').addEventListener('click', () => run('순차 분석 시작 실패', () => api.analyzeJobs((state.jobs || []).filter(item => !item.pendingSave && ['draft', 'failed', 'cancelled'].includes(item.status)).map(item => item.id))));
  $('analyze-selected').addEventListener('click', () => { if (job()) { preview = null; run('분석 시작 실패', () => api.analyzeJobs([job().id])); } });
  $('cancel-analysis').addEventListener('click', () => run('분석 취소 실패', () => api.cancelAnalysis()));
  $('tab-hits').addEventListener('click', () => switchTab('hits'));
  $('tab-save').addEventListener('click', () => switchTab('save'));
  $('play-pause').addEventListener('click', togglePlayback);
  $('previous-frame').addEventListener('click', () => stepFrame(-1));
  $('next-frame').addEventListener('click', () => stepFrame(1));
  $('seek').addEventListener('input', event => { stopPlayback(); currentTime = number(event.target.value); updateFrame(); });

  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (button?.disabled) return;
    if (button?.id === 'dismiss-notice') { localNotice = null; state.notice = null; renderNotice(); }
    if (button?.id === 'install-integration') await run('Unity 연동 설치 실패', () => api.installIntegration());
    if (button?.id === 'use-name-search') { $('search-mode').value = 'name'; await cancelSearch(''); $('animation-query').focus(); }
    if (button?.id === 'add-search-results') {
      const generation = searchGeneration;
      const result = await run('작업 추가 실패', () => api.addJobs([...searchSelection].map(index => searchResults[index])));
      if (result !== undefined && generation === searchGeneration) { resetSearch(); renderSearch(); }
    }
    if (button?.dataset.removeJob) { await run('작업 제거 실패', () => api.removeJob(button.dataset.removeJob)); return; }
    const card = event.target.closest('[data-job]');
    if (card && !button) await run('작업 선택 실패', () => api.selectJob(card.dataset.job));
    if (button?.id === 'add-hit') {
      const selected = job();
      if (!selected) return;
      const start = clamp(currentTime, 0, Math.max(0, duration(selected) - .001));
      const next = { id: crypto.randomUUID(), start: Math.round(start * 1000) / 1000, end: Math.round(Math.min(duration(selected), start + .12) * 1000) / 1000, sourceIndex: -1, reason: '사용자가 추가한 구간', uncertain: false };
      selectedWindowId = next.id;
      await patchWindows([...windows(selected), next]);
    }
    if (button?.dataset.deleteHit) await patchWindows(windows(job()).filter(window => window.id !== button.dataset.deleteHit));
    const hitCard = event.target.closest('[data-hit-card]');
    if (hitCard && !event.target.closest('input,select,button')) selectHit(hitCard.dataset.hitCard);
    if (button?.id === 'go-save') switchTab('save');
    if (button?.dataset.saveMode) await patchJob({ mode: button.dataset.saveMode, reviewed: false });
    if (button?.dataset.revealAsset) await run('에셋 열기 실패', () => api.revealAsset(button.dataset.revealAsset), false);
    if (button?.id === 'preview-change') {
      const selected = job();
      if (!selected) return;
      const beforeProject = projectIdentity(state.projectPath);
      const beforeFingerprint = fingerprint(selected);
      const result = await run('변경 내용 확인 실패', () => api.previewChange({ jobId: selected.id, mode: selected.mode || 'update', sourceGuid: selected.sourceGuid, actionPath: selected.actionPath, group: selected.group, templatePath: selected.templatePath, copy: Boolean(selected.copy), outputFolder: selected.outputFolder, timeOverrides: selected.timeOverrides || [] }));
      if (result && projectIdentity(state.projectPath) === beforeProject && job()?.id === selected.id && fingerprint(job()) === beforeFingerprint) {
        preview = result;
        overrideFields = [...(Array.isArray(result.editableTimeSettings) ? result.editableTimeSettings : []), ...(Array.isArray(result.requiredTimeOverrides) ? result.requiredTimeOverrides : [])];
        previewJobId = selected.id;
        previewFingerprint = fingerprint(job());
        renderSave(); renderFooter(); renderButtons();
      }
    }
    if (button?.id === 'apply-change' && preview?.canApply && job()?.reviewed) {
      const changeId = preview.changeId;
      const result = await run('변경 저장 실패', () => api.applyChange(changeId));
      if (result !== undefined) { preview = null; showNotice('검토한 공격 데이터를 저장했습니다.', 'success'); renderSave(); renderFooter(); renderButtons(); }
    }
  });

  document.addEventListener('change', async event => {
    const input = event.target;
    if (input.dataset.result !== undefined) {
      const index = Number(input.dataset.result);
      if (input.checked) searchSelection.add(index); else searchSelection.delete(index);
      renderSearch();
    }
    if (input.id === 'actor-select') { const actorId = input.value; await cancelSearch(''); await run('캐릭터 선택 실패', () => api.updateSettings({ actorId, weaponId: '', weaponBone: '' })); }
    if (input.id === 'weapon-select') await run('무기 선택 실패', () => api.updateSettings({ weaponId: input.value }));
    if (input.id === 'weapon-bone') await run('무기 위치 변경 실패', () => api.updateSettings({ weaponBone: input.value.trim() }));
    if (input.dataset.hitInput) {
      if (input.value === '' || !Number.isFinite(Number(input.value))) { showNotice('유효한 시간을 숫자로 입력해 주세요.', 'error'); renderHits(); return; }
      const changed = windows(job()).map(window => window.id === input.dataset.hitInput ? { ...window, [input.dataset.boundary]: Number(input.value), uncertain: false } : window);
      await patchWindows(changed);
    }
    if (input.dataset.hitSource) await patchWindows(windows(job()).map(window => window.id === input.dataset.hitSource ? { ...window, sourceIndex: Number(input.value) } : window));
    if (input.id === 'reviewed-check' || input.id === 'save-reviewed-check') await patchJob({ reviewed: input.checked });
    if (input.id === 'source-select') await patchJob({ sourceGuid: input.value, actionPath: '', templatePath: '', group: 'combo', reviewed: false });
    if (input.id === 'group-select' && input.value) await patchJob({ group: input.value, reviewed: false });
    if (input.id === 'target-select' || input.id === 'template-select') {
      const selected = job();
      const target = (state.targets || []).find(item => item.sourceGuid === selected?.sourceGuid && item.actionPath === input.value);
      const mapped = windows(selected).map((window, index) => ({ ...window, sourceIndex: target?.windows?.[index]?.sourceIndex ?? (index < (target?.windows?.length || 0) ? index : -1) }));
      await patchJob({ [input.id === 'target-select' ? 'actionPath' : 'templatePath']: input.value, windows: mapped, reviewed: false });
    }
    if (input.id === 'copy-check') await patchJob({ copy: input.checked });
    if (input.id === 'output-folder') await patchJob({ outputFolder: input.value.trim() });
    if (input.dataset.timeOverride) {
      if (input.value === '' || !Number.isFinite(Number(input.value))) { showNotice('시간을 숫자로 입력해 주세요.', 'error'); return; }
      await patchJob({ timeOverrides: [...(job()?.timeOverrides || []).filter(item => item.path !== input.dataset.timeOverride), { path: input.dataset.timeOverride, value: Number(input.value) }] });
    }
  });

  $('timeline').addEventListener('pointerdown', event => {
    const selected = job();
    if (!selected || !duration(selected)) return;
    const windowElement = event.target.closest('[data-window]');
    const edge = event.target.dataset.edge;
    if (windowElement && edge && !lockedJob(selected)) {
      event.preventDefault();
      stopPlayback();
      selectedWindowId = windowElement.dataset.window;
      drag = { id: selectedWindowId, edge, next: windows(selected).map(window => ({ ...window })), rect: $('timeline').getBoundingClientRect(), jobId: selected.id };
      $('timeline').setPointerCapture(event.pointerId);
      return;
    }
    if (windowElement) { selectHit(windowElement.dataset.window); return; }
    stopPlayback();
    const rect = $('timeline').getBoundingClientRect();
    currentTime = clamp((event.clientX - rect.left) / rect.width * duration(selected), 0, duration(selected));
    updateFrame();
  });
  $('timeline').addEventListener('pointermove', event => {
    if (!drag || drag.jobId !== job()?.id) return;
    const hit = drag.next.find(window => window.id === drag.id);
    const total = duration(job());
    const time = Math.round(clamp((event.clientX - drag.rect.left) / drag.rect.width * total, 0, total) * 1000) / 1000;
    hit[drag.edge] = drag.edge === 'start' ? clamp(time, 0, number(hit.end) - .001) : clamp(time, number(hit.start) + .001, total);
    hit.uncertain = false;
    currentTime = hit[drag.edge];
    const element = Array.from($('timeline-windows').children).find(child => child.dataset.window === hit.id);
    if (element) { element.style.left = `${number(hit.start) / total * 100}%`; element.style.width = `${(number(hit.end) - number(hit.start)) / total * 100}%`; }
    updateFrame();
  });
  const finishDrag = async () => {
    if (!drag) return;
    const completed = drag;
    drag = null;
    if (completed.jobId === job()?.id) await patchWindows(completed.next);
  };
  $('timeline').addEventListener('pointerup', finishDrag);
  $('timeline').addEventListener('pointercancel', () => { drag = null; renderTimeline(); });
  document.addEventListener('keydown', event => {
    if (event.target.closest('input,select,textarea,button,[contenteditable="true"]')) return;
    if (event.key === 'Enter' && event.target.dataset.job) { run('작업 선택 실패', () => api.selectJob(event.target.dataset.job)); return; }
    if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stepFrame(event.key === 'ArrowLeft' ? -1 : 1); }
  });

  render();
  if (!api) showNotice('데스크톱 연결을 찾을 수 없습니다. AutoHitTimer 앱을 통해 실행해 주세요.', 'error');
  else {
    const unsubscribes = [
      api.onState(acceptState),
      api.onNavigate?.(followNavigation),
      api.onVisibility?.(visible => { if (visible === false) stopPlayback(); }),
    ];
    window.addEventListener('beforeunload', () => {
      navigationGeneration++;
      stopPlayback();
      for (const unsubscribe of unsubscribes) if (typeof unsubscribe === 'function') unsubscribe();
    });
    run('앱 상태를 불러오지 못했습니다', refreshState, false);
  }
})();
