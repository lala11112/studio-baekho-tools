'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { ProjectClient } = require('./project-client.cjs');
const { CodexAnalyzer } = require('./ai.cjs');
const { fault, newJob, validateWindows, frameChunks, refinementTimes, mergeWindows } = require('./domain.cjs');

const EDITABLE = new Set(['windows', 'reviewed', 'sourceGuid', 'actionPath', 'mode', 'group', 'templatePath', 'copy', 'outputFolder', 'timeOverrides', 'stateName']);
class Controller extends EventEmitter {
  constructor({ store, clientFactory = project => new ProjectClient(project), ai = new CodexAnalyzer(), install } = {}) {
    super(); this.store = store; this.clientFactory = clientFactory; this.ai = ai; this.install = install;
    this.state = { projectPath: '', connection: { ready: false, message: 'Unity 프로젝트를 선택하세요.' }, ai: { available: false, authenticated: false, label: 'Codex 확인 전' },
      actors: [], actorId: '', sources: [], targets: [], groups: [], jobs: [], selectedJobId: '', settings: {}, busy: false, notice: '' };
    this.preview = null; this.previewRevision = 0; this.abortController = null; this.applying = false; this.queuePromise = null;
  }
  changed(persist = true) {
    if (persist && this.state.projectPath) this.store.save(this.state.projectPath, { settings: this.state.settings, jobs: this.state.jobs, selectedJobId: this.state.selectedJobId });
    this.emit('state', this.state); return this.state;
  }
  idle() { if (this.state.busy || this.applying) throw fault('진행 중인 작업이 끝난 뒤 변경하세요.', 'BUSY'); }
  invalidatePreview() { this.preview = null; this.previewRevision++; }
  job(id = this.state.selectedJobId) { const job = this.state.jobs.find(item => item.id === id); if (!job) throw fault('작업을 선택하세요.'); return job; }
  saveResolved(job) { if (job.pendingSave) throw fault('이전 저장의 결과를 확인 중입니다. Unity 연결을 복구한 뒤 다시 시도하세요.', 'SAVE_PENDING'); }
  saved(job, result) {
    job.status = 'saved'; job.savedAssets = result.assets || []; job.savedUtc = new Date().toISOString();
    job.progressText = result.summary || '저장 완료'; job.error = ''; job.pendingSave = null;
    if (!job.copy && result.actionPath) { job.actionPath = result.actionPath; job.mode = 'update'; }
  }
  connected() { if (!this.client || !this.state.connection.ready) throw fault('Unity 연결과 편집 모드를 확인하세요.', 'UNITY_DISCONNECTED'); return this.client; }
  contextKey() { return [this.state.actorId, this.state.settings.weaponId || '', this.state.settings.weaponBone || ''].join('|'); }
  async connectProject(projectPath) {
    this.idle(); const client = this.clientFactory(projectPath); const saved = this.store.load(client.projectPath);
    this.client = client; this.invalidatePreview();
    Object.assign(this.state, { projectPath: client.projectPath, settings: saved.settings || {}, jobs: saved.jobs || [], selectedJobId: saved.selectedJobId || '',
      actors: [], sources: [], targets: [], groups: [], actorId: saved.settings?.actorId || '', notice: saved.recoveryError || '', connection: client.heartbeat() });
    this.store.savePreferences({ projectPath: client.projectPath }); this.changed();
    await this.refreshCatalog(); return this.state;
  }
  async refreshCatalog() {
    if (!this.client) { this.state.ai = await this.ai.status(); return this.changed(false); }
    this.state.connection = this.client.heartbeat(); this.changed(false);
    const aiPromise = this.ai.status().then(value => { this.state.ai = value; this.changed(false); });
    try {
      if (this.state.connection.ready) {
        const actorResult = await this.client.command('actors'); this.state.actors = actorResult.actors || [];
        if (!this.state.actors.some(actor => actor.id === this.state.actorId)) {
          this.invalidatePreview();
          this.state.actorId = this.state.actors.length === 1 ? this.state.actors[0].id : '';
          this.state.settings.actorId = this.state.actorId;
        }
        if (this.state.actorId) {
          const result = await this.client.command('targets', { actorId: this.state.actorId, adapterId: 'four-tiger-sword' });
          this.state.sources = result.sources || []; this.state.targets = result.targets || []; this.state.groups = result.groups || [];
          for (const job of this.state.jobs) {
            if (job.pendingSave) continue;
            const actionPath = job.mode === 'register' ? job.templatePath : job.actionPath;
            const target = this.state.targets.find(item => item.sourceGuid === job.sourceGuid && item.actionPath === actionPath);
            if (!target?.snapshot || job.expectedSnapshot === target.snapshot) continue;
            if (job.expectedSnapshot) {
              job.reviewed = false;
              this.invalidatePreview();
              this.state.notice = 'Unity의 최신 공격 데이터를 불러왔습니다. 히트 대응과 시간 설정을 다시 확인하세요.';
            }
            job.expectedSnapshot = target.snapshot;
          }
        } else { this.state.sources = []; this.state.targets = []; this.state.groups = []; }
      }
    } catch (error) { this.state.notice = error.message; }
    await aiPromise; return this.changed();
  }
  poll() {
    if (!this.client) return;
    const next = this.client.heartbeat();
    if (next.ready !== this.state.connection.ready || next.message !== this.state.connection.message) {
      this.state.connection = next; this.changed(false);
    }
    if (this.applying || this.recovering || !next.ready) return;
    const pending = this.state.jobs.filter(item => item.pendingSave?.requestId);
    if (!pending.length) return;
    this.recovering = true;
    this.recoveryPromise = this.reconcileSaves(this.client, pending)
      .catch(error => { this.state.notice = error.message; this.changed(false); })
      .finally(() => { this.recovering = false; });
  }
  async reconcileSaves(client, jobs) {
    const recovered = [];
    for (const job of jobs) {
      if (this.client !== client) return;
      const pending = job.pendingSave;
      if (!pending) continue;
      const receipt = client.response(pending.requestId);
      if (receipt.complete && !receipt.error) { this.saved(job, receipt.result); recovered.push(job); }
      else {
        if (client.requestOutstanding?.(pending.requestId)) continue;
        // A bridge error after a crash does not prove the adapter failed to save.
        // Query its durable journal without reissuing the mutation.
        const status = await client.command('saveStatus', { adapterId: 'four-tiger-sword', changeId: pending.changeId });
        if (this.client !== client || job.pendingSave !== pending) return;
        if (status.status === 'complete') { this.saved(job, status.result); recovered.push(job); }
        else if (['preview', 'rolled-back'].includes(status.status)) {
          job.pendingSave = null; job.error = status.error || receipt.error || '이전 저장은 적용되지 않았습니다. 변경 내용을 다시 확인한 뒤 저장하세요.';
          job.progressText = '이전 저장 미적용 확인';
        } else {
          const message = '저장 복구가 필요합니다. Unity의 Tools → Studio Baekho → Auto Hit Timer → Recover Interrupted Save를 확인하세요.';
          if (job.error === message) continue;
          job.error = message; job.progressText = 'Unity 저장 복구 대기';
        }
      }
      this.changed();
    }
    if (!recovered.length) return;
    await this.refreshCatalog();
    if (this.client !== client) return;
    for (const job of recovered) if (!job.copy && job.status === 'saved')
      job.expectedSnapshot = this.state.targets.find(target => target.sourceGuid === job.sourceGuid && target.actionPath === job.actionPath)?.snapshot || '';
    this.changed();
  }
  async updateSettings(patch) {
    this.idle();
    const old = this.contextKey();
    for (const key of ['actorId', 'weaponId', 'weaponBone']) if (key in patch) this.state.settings[key] = String(patch[key] || '');
    this.state.actorId = this.state.settings.actorId || '';
    if (old !== this.contextKey()) { this.invalidatePreview(); for (const job of this.state.jobs) job.reviewed = false; }
    this.changed(); return this.refreshCatalog();
  }
  async installIntegration() {
    this.idle(); if (!this.client) throw fault('먼저 Unity 프로젝트를 선택하세요.');
    const result = await this.install(this.state.projectPath);
    this.state.notice = result.message; this.changed(); return result;
  }
  async searchAnimations(query) { return this.connected().command('search', { query: String(query || '').slice(0, 300), actorId: this.state.actorId }); }
  async importFiles(paths) {
    this.idle(); const client = this.connected();
    if (!Array.isArray(paths) || !paths.length || paths.length > 100) throw fault('애니메이션 파일을 1~100개 선택하세요.');
    const clips = [];
    for (const path of paths) { const result = await client.command('import', { path, actorId: this.state.actorId }, { timeoutMs: 120000 }); clips.push(...(result.clips || [])); }
    return { clips };
  }
  addJobs(clips) {
    this.idle(); if (!Array.isArray(clips) || !clips.length || clips.length > 100 || this.state.jobs.length + clips.length > 300) throw fault('작업은 한 번에 100개, 프로젝트당 300개까지 추가할 수 있습니다.');
    const added = clips.map(newJob); this.state.jobs.push(...added); this.state.selectedJobId = added[0].id;
    return this.changed();
  }
  selectJob(id) { this.job(id); this.state.selectedJobId = id; this.invalidatePreview(); return this.changed(); }
  updateJob(id, patch) {
    if (this.applying) throw fault('저장 중에는 편집할 수 없습니다.');
    const job = this.job(id);
    this.saveResolved(job);
    if (['capturing', 'analyzing'].includes(job.status)) throw fault('이 작업의 분석이 끝난 뒤 편집하세요.');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fault('편집 내용이 올바르지 않습니다.');
    for (const key of Object.keys(patch)) if (!EDITABLE.has(key)) throw fault('지원하지 않는 편집 항목입니다.');
    const changed = Object.keys(patch).some(key => key !== 'reviewed');
    if (patch.windows) patch = { ...patch, windows: validateWindows(patch.windows, job.duration) };
    if ('mode' in patch && !['update', 'register'].includes(patch.mode)) throw fault('저장 모드가 올바르지 않습니다.');
    if ('group' in patch && !['combo', 'air', 'counter', 'skill', 'ultimate'].includes(patch.group)) throw fault('공격 종류가 올바르지 않습니다.');
    if ('copy' in patch && typeof patch.copy !== 'boolean') throw fault('저장 옵션이 올바르지 않습니다.');
    if ('reviewed' in patch && typeof patch.reviewed !== 'boolean') throw fault('검토 상태가 올바르지 않습니다.');
    for (const key of ['sourceGuid', 'actionPath', 'templatePath', 'outputFolder', 'stateName']) if (key in patch && (typeof patch[key] !== 'string' || patch[key].length > 600)) throw fault('입력 길이를 확인하세요.');
    if (patch.timeOverrides && (!Array.isArray(patch.timeOverrides) || patch.timeOverrides.length > 64 || patch.timeOverrides.some(item => typeof item.path !== 'string' || !Number.isFinite(item.value)))) throw fault('시간 보정값을 확인하세요.');
    Object.assign(job, patch);
    this.invalidatePreview();
    if (changed) { job.reviewed = false; this.preview = null; if (job.status === 'saved') job.status = 'review'; }
    const target = this.state.targets.find(value => value.sourceGuid === job.sourceGuid && value.actionPath === job.actionPath);
    if ('sourceGuid' in patch || 'actionPath' in patch) job.expectedSnapshot = target?.snapshot || '';
    return this.changed();
  }
  removeJob(id) { this.idle(); this.saveResolved(this.job(id)); this.state.jobs = this.state.jobs.filter(job => job.id !== id); if (this.state.selectedJobId === id) this.state.selectedJobId = this.state.jobs[0]?.id || ''; this.preview = null; return this.changed(); }
  analyzeJobs(ids) {
    this.idle(); this.connected(); if (!this.state.actorId) throw fault('미리보기 캐릭터를 선택하세요.');
    if (!Array.isArray(ids) || !ids.length) throw fault('분석할 작업을 선택하세요.');
    const jobs = [...new Set(ids)].map(id => this.job(id));
    jobs.forEach(job => this.saveResolved(job));
    this.abortController = new AbortController(); this.state.busy = true; this.invalidatePreview(); this.changed();
    this.queuePromise = this.runQueue(jobs, this.abortController.signal).finally(() => { this.state.busy = false; this.abortController = null; this.changed(); });
    // Keep the event-driven UI responsive; job failures are recorded in runQueue.
    this.queuePromise.catch(error => { this.state.notice = error.message; this.changed(false); });
    return { started: true };
  }
  async runQueue(jobs, signal) {
    for (const job of jobs) {
      if (signal.aborted) break;
      try {
        if (job.windows.length || job.frames.length) {
          job.versions.push({ savedUtc: new Date().toISOString(), windows: job.windows, frames: job.frames, analysisStatus: job.analysisStatus, contextKey: job.contextKey });
          if (job.versions.length > 5) job.versions.shift();
        }
        job.status = 'capturing'; job.error = ''; job.reviewed = false; job.progressText = 'Unity에서 두 시점의 동작 촬영'; this.changed();
        const capture = await this.capture(job, 24, null, signal);
        job.contextKey = this.contextKey(); job.status = 'analyzing'; job.windows = []; job.analysisNotes = []; this.changed();
        const chunks = frameChunks(job.frames); const candidates = []; let uncertain = false;
        for (let index = 0; index < chunks.length; index++) {
          job.progressText = `AI 전체 동작 분석 ${index + 1}/${chunks.length}`; this.changed();
          const result = await this.ai.analyze({ clip: job.clip, frames: chunks[index] }, { signal });
          candidates.push(...result.windows); uncertain ||= result.status === 'uncertain'; job.analysisNotes.push(result.summary); job.model = result.model;
          job.windows = mergeWindows(candidates, job.duration); this.changed();
        }
        let windows = mergeWindows(candidates, job.duration);
        if (windows.length) {
          const times = refinementTimes(windows, job.duration);
          job.progressText = '후보 경계를 60fps로 재촬영'; this.changed();
          await this.capture(job, 60, times, signal, capture.sessionId);
          const refined = [];
          for (let index = 0; index < windows.length; index++) {
            const window = windows[index];
            job.progressText = `AI 타격 경계 확인 ${index + 1}/${windows.length}`; this.changed();
            let frames = job.frames.filter(frame => frame.time >= window.start - 0.17 && frame.time <= window.end + 0.17);
            // Keep all dense boundary frames; sample only the interior when a long strike exceeds the input budget.
            if (frames.length > 96) {
              const boundary = frames.filter(frame => Math.abs(frame.time - window.start) <= 0.17 || Math.abs(frame.time - window.end) <= 0.17);
              const interior = frames.filter(frame => !boundary.includes(frame));
              const slots = Math.max(0, 96 - boundary.length);
              const sampled = slots ? interior.filter((_, item) => item % Math.max(1, Math.ceil(interior.length / slots)) === 0).slice(0, slots) : [];
              frames = [...boundary.slice(0, 96), ...sampled].sort((a, b) => a.time - b.time);
            }
            const result = await this.ai.analyze({ clip: job.clip, frames, refinement: true, hint: { start: window.start, end: window.end } }, { signal });
            if (result.windows.length > 1) throw fault('경계 확인 결과가 여러 타격으로 나뉘었습니다. 초안을 직접 확인하세요.', 'AI_INVALID_OUTPUT');
            if (result.windows.length) refined.push(result.windows[0]);
            else if (result.status === 'uncertain') refined.push({ ...window, uncertain: true, reason: result.summary });
            uncertain ||= result.status === 'uncertain'; job.analysisNotes.push(result.summary);
          }
          windows = mergeWindows(refined, job.duration);
        }
        job.windows = windows; job.analysisStatus = uncertain || windows.some(item => item.uncertain) ? 'uncertain' : windows.length ? 'hits' : 'no-hit';
        job.status = 'review'; job.progressText = windows.length ? `${windows.length}개 타격 후보 · 확인 후 저장` : '타격 후보 없음 · 전체 동작을 확인하세요.';
        this.changed();
      } catch (error) {
        job.status = signal.aborted || error.code === 'CANCELLED' ? 'cancelled' : 'failed'; job.error = error.message; job.progressText = ''; this.changed();
        if (signal.aborted || ['AI_USAGE_LIMIT', 'AI_AUTH_REQUIRED', 'UNITY_DISCONNECTED', 'TIMEOUT_UNCERTAIN', 'EDITOR_BUSY', 'EDITOR_RELOAD', 'EDITOR_CLOSED', 'PLAY_MODE', 'EXPIRED'].includes(error.code)) break;
      }
    }
  }
  async capture(job, fps, requestedTimes, signal, sessionId) {
    const times = requestedTimes || [...Array.from({ length: Math.ceil(job.clip.length * fps) }, (_, index) => index / fps), job.clip.length];
    let response;
    for (let start = 0; start < times.length; start += 480) {
      job.progressText = `Unity ${fps}fps 촬영 ${Math.floor(start / 480) + 1}/${Math.ceil(times.length / 480)}`;
      this.changed();
      response = await this.client.command('capture', { actorId: this.state.actorId, weaponId: this.state.settings.weaponId || '', weaponBone: this.state.settings.weaponBone || '',
        clip: job.clip, fps, times: times.slice(start, start + 480), ...(sessionId ? { sessionId } : {}) }, { timeoutMs: 600000, signal });
      this.acceptCapture(job, response, !!requestedTimes || start > 0);
      sessionId = response.sessionId;
      this.changed();
    }
    return response;
  }
  acceptCapture(job, capture, merge = false) {
    if (!capture || !Array.isArray(capture.frames) || !capture.frames.length || !Number.isFinite(capture.duration) || Math.abs(capture.duration - job.clip.length) > 0.002) throw fault('Unity 촬영 결과가 유효하지 않습니다.');
    if (merge && job.clip.sourceFingerprint && capture.clip?.sourceFingerprint !== job.clip.sourceFingerprint) throw fault('촬영 중 애니메이션이 변경되었습니다. 다시 분석하세요.', 'CLIP_CHANGED');
    if (capture.clip) job.clip = { ...job.clip, ...capture.clip };
    const frames = capture.frames.map(frame => {
      if (typeof frame.id !== 'string' || !Number.isFinite(frame.time) || frame.time < 0 || frame.time > capture.duration + 0.001) throw fault('촬영 프레임 시간이 유효하지 않습니다.');
      return { id: frame.id, time: frame.time, path: this.client.mediaPath(frame.path) };
    });
    const byTime = new Map((merge ? job.frames : []).map(frame => [frame.time.toFixed(6), frame]));
    for (const frame of frames) byTime.set(frame.time.toFixed(6), frame);
    job.frames = [...byTime.values()].sort((a, b) => a.time - b.time); job.duration = capture.duration; job.sessionId = capture.sessionId;
  }
  async cancelAnalysis() {
    this.abortController?.abort();
    if (this.client) { try { await this.client.command('cancel', {}, { timeoutMs: 10000 }); } catch (error) { this.state.notice = error.message; } }
    return this.changed(false);
  }
  async previewChange(options = {}) {
    this.idle(); this.connected(); const job = this.job();
    if (job.pendingSave) throw fault('이전 저장의 결과를 확인 중입니다. Unity 연결을 복구하세요. 저장 요청은 재전송하지 않습니다.');
    if (!job.reviewed) throw fault('미리보기와 타격 구간을 확인한 뒤 검토 완료를 표시하세요.');
    if (job.contextKey !== this.contextKey()) throw fault('현재 캐릭터·무기로 동작을 다시 촬영하고 확인하세요.');
    const windows = validateWindows(job.windows, job.duration, { allowEmpty: false });
    if (options.jobId && options.jobId !== job.id) throw fault('선택한 작업이 변경되었습니다.');
    const input = { ...job, windows, actorId: this.state.actorId, adapterId: 'four-tiger-sword' };
    // Never serialize frames or saved versions into a bridge request.
    const payload = {};
    for (const key of ['actorId', 'adapterId', 'clip', 'sourceGuid', 'actionPath', 'mode', 'group', 'templatePath', 'stateName', 'windows', 'timeOverrides', 'copy', 'outputFolder', 'expectedSnapshot']) payload[key] = input[key];
    const revision = this.previewRevision, context = this.contextKey();
    const result = await this.client.command('previewChange', payload);
    if (revision !== this.previewRevision || context !== this.contextKey() || this.state.selectedJobId !== job.id || !job.reviewed)
      throw fault('변경 내용을 불러오는 동안 편집 내용이 바뀌었습니다. 다시 확인하세요.', 'STALE_PREVIEW');
    this.preview = result.canApply ? { changeId: result.changeId, jobId: job.id, context, revision } : null;
    return result;
  }
  async applyChange(changeId) {
    this.idle(); this.connected();
    if (!this.preview || this.preview.changeId !== changeId || this.preview.jobId !== this.state.selectedJobId || this.preview.revision !== this.previewRevision || this.preview.context !== this.contextKey() || !this.job().reviewed) throw fault('변경 내용을 다시 확인하세요.');
    const job = this.job(); this.saveResolved(job);
    const requestId = randomUUID();
    // Persist the request identity before dispatch, including a crash during registration or copy saving.
    job.pendingSave = { changeId, requestId };
    this.changed();
    this.applying = true; this.state.busy = true; this.changed(false);
    try {
      const result = await this.client.command('apply', { changeId, adapterId: 'four-tiger-sword' }, { timeoutMs: 120000, id: requestId });
      this.saved(job, result);
      this.preview = null; this.changed(); await this.refreshCatalog();
      if (!job.copy) {
        if (result.actionPath) { job.actionPath = result.actionPath; job.mode = 'update'; }
        job.expectedSnapshot = this.state.targets.find(target => target.sourceGuid === job.sourceGuid && target.actionPath === job.actionPath)?.snapshot || '';
      }
      return result;
    } catch (error) {
      let receipt;
      try { receipt = this.client.response(requestId); } catch { /* Keep uncertain requests for recovery. */ }
      if (receipt?.complete && !receipt.error) this.saved(job, receipt.result);
      else if (error.code === 'TIMEOUT') { job.pendingSave = null; job.error = error.message; }
      else { job.error = error.message; job.progressText = 'Unity 저장 결과 확인 대기'; }
      throw error;
    } finally { this.preview = null; this.applying = false; this.state.busy = false; this.changed(); }
  }
  async shutdown() { this.abortController?.abort(); if (this.queuePromise) await this.queuePromise; }
}
module.exports = { Controller };
