'use strict';

// The desktop process owns this client. The renderer never receives filesystem access.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const MAX_JSON_BYTES = 10 * 1024 * 1024;
const COMMANDS = new Set(['describe', 'start', 'cancel', 'export', 'export-combined']);
const FINISHED = new Set(['completed', 'no-hits', 'failed', 'cancelled', 'interrupted']);
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,127}$/;
const CANDIDATE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function fault(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertSegment(value, label) {
  if (typeof value !== 'string' || !SEGMENT.test(value) || value.endsWith('.') || value.endsWith(' ') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw fault(`${label} 형식이 올바르지 않습니다.`, 'INVALID_PATH');
  }
  return value;
}

// Open/read/close promptly: do not keep a Windows handle around while Unity atomically replaces JSON.
function readJson(filename, maxBytes = MAX_JSON_BYTES) {
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw fault('JSON 파일 크기가 허용 범위를 벗어났습니다.', 'INVALID_JSON');
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > maxBytes || bytes > stat.size) throw fault('읽는 동안 JSON 파일이 변경되었습니다.', 'INVALID_JSON');
    return JSON.parse(buffer.subarray(0, bytes).toString('utf8').replace(/^\uFEFF/, ''));
  } finally { fs.closeSync(fd); }
}

function atomicJson(filename, value) {
  const data = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(data, 'utf8') > MAX_JSON_BYTES) throw fault('요청이 너무 큽니다.', 'INVALID_JSON');
  const temporary = `${filename}.${randomUUID().replaceAll('-', '')}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function videoBasename(value) {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.includes('..')) return null;
  const name = parts.at(-1);
  return name && SEGMENT.test(name) && /\.(mp4|webm)$/i.test(name) ? name : null;
}

function validCandidate(candidate) {
  return candidate && typeof candidate === 'object' && typeof candidate.id === 'string' &&
    CANDIDATE_ID.test(candidate.id) && Array.isArray(candidate.values);
}

class ProjectClient {
  static validateProject(projectPath) {
    if (typeof projectPath !== 'string' || !projectPath.trim() || projectPath.includes('\0')) {
      throw fault('Unity 프로젝트 폴더를 선택하세요.', 'INVALID_PROJECT');
    }
    try {
      const root = fs.realpathSync(path.resolve(projectPath));
      const assets = fs.realpathSync(path.join(root, 'Assets'));
      const version = fs.realpathSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'));
      if (!fs.statSync(root).isDirectory() || !fs.statSync(assets).isDirectory() ||
          !fs.statSync(version).isFile() || !contained(root, assets) || !contained(root, version)) {
        throw new Error('Invalid Unity project');
      }
      return root;
    } catch {
      throw fault('Assets와 ProjectSettings/ProjectVersion.txt가 있는 Unity 프로젝트 루트를 선택하세요.', 'INVALID_PROJECT');
    }
  }

  constructor(projectPath) {
    this.projectPath = ProjectClient.validateProject(projectPath);
    this.bridgePath = path.join(this.projectPath, 'Library', 'CombatLabBridge');
    this.resultsPath = path.join(this.projectPath, 'CombatLabResults');
  }

  // Verify each existing ancestor before creating or opening anything. Junctions are resolved as well.
  _safePath(...segments) {
    let current = this.projectPath;
    for (const segment of segments) {
      assertSegment(segment, '파일 이름');
      current = path.join(current, segment);
      try {
        const resolved = fs.realpathSync(current);
        if (!contained(this.projectPath, resolved)) throw fault('프로젝트 밖의 연결 경로는 사용할 수 없습니다.', 'INVALID_PATH');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return current;
  }

  getStatus() {
    const result = {
      connected: false, running: false, status: 'Unity 연결 대기', unityVersion: '',
      isPlaying: false, isCompiling: false, error: '', timestampUtcMs: 0, directory: ''
    };
    try {
      const value = readJson(this._safePath('Library', 'CombatLabBridge', 'status.json'), 256 * 1024);
      if (!value || value.protocolVersion !== 1) throw fault('Unity 브리지 버전이 호환되지 않습니다.', 'PROTOCOL_MISMATCH');
      if (typeof value.projectPath !== 'string' || !samePath(fs.realpathSync(value.projectPath), this.projectPath)) {
        throw fault('브리지의 프로젝트 경로가 선택한 프로젝트와 다릅니다.', 'PROJECT_MISMATCH');
      }
      if (typeof value.timestampUtcMs !== 'number' || !Number.isFinite(value.timestampUtcMs)) {
        throw fault('Unity 연결 시각이 올바르지 않습니다.', 'INVALID_STATUS');
      }
      const age = Date.now() - value.timestampUtcMs;
      const fresh = age >= -5000 && age <= 15000;
      return {
        connected: fresh, running: value.running === true,
        status: fresh ? String(value.status || '대기 중') : 'Unity 다시 연결 중 · 컴파일 또는 Play Mode 전환을 기다리는 중',
        unityVersion: typeof value.unityVersion === 'string' ? value.unityVersion : '',
        isPlaying: value.isPlaying === true, isCompiling: value.isCompiling === true,
        error: fresh ? String(value.error || '') : 'Unity 응답이 오래되었습니다. 연결이 복구되면 최신 상태를 확인합니다.',
        timestampUtcMs: value.timestampUtcMs, directory: typeof value.directory === 'string' ? value.directory : ''
      };
    } catch (error) {
      result.error = error.code === 'ENOENT' ? 'Unity에서 이 프로젝트를 열고 Combat Lab 브리지가 로드될 때까지 기다리세요.' : error.message;
      return result;
    }
  }

  async command(name, payload = {}, options = {}) {
    if (!COMMANDS.has(name)) throw fault('지원하지 않는 Unity 명령입니다.', 'INVALID_COMMAND');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fault('명령 데이터가 올바르지 않습니다.', 'INVALID_PAYLOAD');
    const timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw fault('명령 제한 시간은 1~120000ms입니다.', 'INVALID_TIMEOUT');
    const status = this.getStatus();
    if (!status.connected) throw fault(status.error || status.status, 'UNITY_DISCONNECTED');
    const id = randomUUID().replaceAll('-', '');
    const directory = this._safePath('Library', 'CombatLabBridge', 'requests');
    fs.mkdirSync(directory, { recursive: true });
    const requestPath = this._safePath('Library', 'CombatLabBridge', 'requests', `${id}.json`);
    const responsePath = this._safePath('Library', 'CombatLabBridge', 'responses', `${id}.json`);
    atomicJson(requestPath, { id, protocolVersion: 1, command: name,
      payloadJson: JSON.stringify(payload), expiresUtcMs: Date.now() + timeoutMs });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        this._safePath('Library', 'CombatLabBridge', 'responses', `${id}.json`);
        const response = readJson(responsePath);
        if (!response || response.id !== id || typeof response.ok !== 'boolean') throw fault('Unity 응답 형식이 올바르지 않습니다.', 'INVALID_RESPONSE');
        if (!response.ok) throw fault(String(response.error || 'Unity 명령이 실패했습니다.'), 'UNITY_COMMAND_FAILED');
        if (typeof response.payloadJson !== 'string') throw fault('Unity 응답 데이터가 올바르지 않습니다.', 'INVALID_RESPONSE');
        try { return JSON.parse(response.payloadJson); }
        catch { throw fault('Unity 응답 JSON을 읽을 수 없습니다.', 'INVALID_RESPONSE'); }
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EBUSY' && error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(150, Math.max(1, deadline - Date.now())));
    }
    // Unlink and Unity's rename-to-processing compete atomically. A missing request may already have executed.
    let withdrawn = false;
    try {
      this._safePath('Library', 'CombatLabBridge', 'requests', `${id}.json`);
      fs.unlinkSync(requestPath);
      withdrawn = true;
    } catch { /* Never touch processing or another caller's request. */ }
    throw fault(withdrawn
      ? 'Unity 응답 시간이 초과되어 실행 전 요청을 철회했습니다. 연결 상태를 확인하세요.'
      : 'Unity 응답 시간이 초과되었습니다. 요청이 이미 실행되었을 수 있습니다. 자동 재전송하지 않았습니다. 연결 복구 후 실행 상태와 결과를 확인하세요.',
    withdrawn ? 'COMMAND_TIMEOUT_WITHDRAWN' : 'COMMAND_TIMEOUT_UNCERTAIN');
  }

  async describe() {
    const description = await this.command('describe');
    if (!description || !Array.isArray(description.adapters)) throw fault('프로젝트 설명 형식이 올바르지 않습니다.', 'INVALID_RESPONSE');
    return description;
  }

  _runDirectory(runId) {
    assertSegment(runId, '실험 ID');
    const root = fs.realpathSync(this._safePath('CombatLabResults'));
    const run = fs.realpathSync(this._safePath('CombatLabResults', runId));
    if (samePath(root, run) || !contained(root, run) || !fs.statSync(run).isDirectory()) {
      throw fault('실험 폴더 경로가 올바르지 않습니다.', 'INVALID_PATH');
    }
    return run;
  }

  _runFile(runId, filename) {
    assertSegment(filename, '파일 이름');
    const directory = this._runDirectory(runId);
    const target = path.join(directory, filename);
    try {
      if (!contained(directory, fs.realpathSync(target))) throw fault('실험 폴더 밖의 파일은 사용할 수 없습니다.', 'INVALID_PATH');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
  }

  loadReport(runId) {
    const report = readJson(this._runFile(runId, 'report.json'));
    if (!report || report.schemaVersion !== 1 || report.runId !== runId || !Array.isArray(report.results) ||
        typeof report.startedUtc !== 'string' || !Number.isFinite(Date.parse(report.startedUtc)) ||
        report.results.some(result => !result || !validCandidate(result.candidate) || typeof result.status !== 'string') ||
        new Set(report.results.map(result => result.candidate.id)).size !== report.results.length) {
      throw fault('실험 보고서 형식이 올바르지 않습니다.', 'INVALID_REPORT');
    }
    let request = null;
    try {
      const value = readJson(this._runFile(runId, 'request.json'));
      if (value?.schemaVersion === 1 && Array.isArray(value.candidates) && value.candidates.every(validCandidate) &&
          new Set(value.candidates.map(candidate => candidate.id)).size === value.candidates.length &&
          report.results.every(result => value.candidates.some(candidate => candidate.id === result.candidate.id))) request = value;
    } catch (error) {
      if (error.code === 'INVALID_PATH') throw error;
      // A missing/truncated legacy request does not prevent reading the completed report.
    }
    let judgment = null;
    try {
      const value = readJson(this._runFile(runId, 'judgment.json'), 256 * 1024);
      const selectedId = value?.selectedCandidateId;
      const index = selectedId === null ? null : report.results.findIndex(result => result.candidate.id === selectedId);
      if (value?.schemaVersion === 1 && value.runId === runId && value.sourceGuid === (report.sourceGuid || '') &&
          (selectedId === null || (typeof selectedId === 'string' && index >= 0)) && value.selectedCandidateIndex === index &&
          typeof value.feedback === 'string' && value.feedback.length <= 20000 &&
          typeof value.createdUtc === 'string' && Number.isFinite(Date.parse(value.createdUtc))) {
        judgment = { schemaVersion: 1, runId, sourceGuid: value.sourceGuid, selectedCandidateId: selectedId,
          selectedCandidateIndex: index, feedback: value.feedback, createdUtc: value.createdUtc };
      }
    } catch { /* Optional old or partially written judgments never prevent report viewing. */ }
    return { report, request, runId, judgment };
  }

  listRuns() {
    let entries;
    try { entries = fs.readdirSync(this._safePath('CombatLabResults'), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const live = this.getStatus();
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const { report, request } = this.loadReport(entry.name);
        const count = request?.candidates.length ?? report.results.length;
        const complete = report.results.filter(result => FINISHED.has(result.status)).length;
        const statuses = new Set(report.results.map(result => result.status));
        const current = live.connected && live.running && live.directory &&
          samePath(path.resolve(live.directory), this._runDirectory(entry.name));
        let status = current ? 'running' : 'incomplete';
        if (!current) {
          if (statuses.has('failed')) status = 'failed';
          else if (statuses.has('cancelled') || statuses.has('interrupted')) status = 'cancelled';
          else if (count > 0 && complete === count) status = statuses.has('no-hits') ? 'no-hits' : 'completed';
        }
        runs.push({ id: entry.name, startedUtc: report.startedUtc, candidateCount: count, completedCount: complete, status,
          adapterId: request?.adapterId || report.adapterId || '', sourceGuid: request?.sourceGuid || report.sourceGuid || '',
          actionId: request?.actionId || report.actionId || 'normal-combo' });
      } catch { /* An incomplete write or an unrelated directory must not hide other runs. */ }
    }
    return runs.sort((a, b) => Date.parse(b.startedUtc) - Date.parse(a.startedUtc) || b.id.localeCompare(a.id));
  }

  resolveVideo(runId, filename) {
    assertSegment(filename, '영상 파일 이름');
    if (!/\.(mp4|webm)$/i.test(filename)) throw fault('지원하지 않는 영상 형식입니다.', 'INVALID_VIDEO');
    const { report } = this.loadReport(runId);
    if (!report.results.some(result => videoBasename(result.videoPath) === filename)) {
      throw fault('이 실험 보고서에 등록된 영상이 아닙니다.', 'INVALID_VIDEO');
    }
    const target = fs.realpathSync(this._runFile(runId, filename));
    if (!fs.statSync(target).isFile()) throw fault('영상 파일이 아닙니다.', 'INVALID_VIDEO');
    return target;
  }

  saveJudgment(runId, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.feedback !== 'string' || value.feedback.length > 20000) {
      throw fault('평가 내용은 20000자 이내의 문자열이어야 합니다.', 'INVALID_JUDGMENT');
    }
    const { report } = this.loadReport(runId);
    const selectedId = value.selectedCandidateId === '' || value.selectedCandidateId == null ? null : value.selectedCandidateId;
    const index = selectedId === null ? null : report.results.findIndex(result => result.candidate.id === selectedId);
    if (index === -1 || (value.selectedCandidateIndex != null && value.selectedCandidateIndex !== index)) {
      throw fault('이 실험의 후보를 선택하세요.', 'INVALID_JUDGMENT');
    }
    const judgment = {
      schemaVersion: 1, runId, sourceGuid: report.sourceGuid || '', selectedCandidateId: selectedId,
      selectedCandidateIndex: index, feedback: value.feedback, createdUtc: new Date().toISOString()
    };
    const target = this._runFile(runId, 'judgment.json');
    atomicJson(target, judgment);
    return { ...judgment, path: target };
  }
}

module.exports = { ProjectClient };
