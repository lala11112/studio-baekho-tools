'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { atomicJson, readJson } = require('./store.cjs');
const { fault } = require('./domain.cjs');
const COMMANDS = new Set(['status', 'actors', 'search', 'import', 'capture', 'targets', 'previewChange', 'apply', 'saveStatus', 'cancel']);
function contained(root, target) { const relative = path.relative(root, target); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); }
function projectRoot(projectPath) {
  try {
    const root = fs.realpathSync(projectPath);
    for (const item of ['Assets', 'ProjectSettings/ProjectVersion.txt']) if (!contained(root, fs.realpathSync(path.join(root, item)))) throw new Error();
    if (!fs.statSync(path.join(root, 'Assets')).isDirectory() || !fs.statSync(path.join(root, 'ProjectSettings/ProjectVersion.txt')).isFile()) throw new Error();
    return root;
  } catch { throw fault('Assets와 ProjectSettings가 있는 Unity 프로젝트 루트를 선택하세요.', 'INVALID_PROJECT'); }
}
class ProjectClient {
  constructor(projectPath) { this.projectPath = projectRoot(projectPath); this.bridgePath = path.join(this.projectPath, 'Library', 'AutoHitTimerBridge'); }
  safePath(...segments) {
    let result = this.projectPath;
    for (const segment of segments) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(segment) || segment === '..') throw fault('유효하지 않은 경로입니다.');
      result = path.join(result, segment);
      try { if (!contained(this.projectPath, fs.realpathSync(result))) throw fault('프로젝트 밖의 연결 경로는 사용할 수 없습니다.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return result;
  }
  heartbeat() {
    try {
      const value = readJson(this.safePath('Library', 'AutoHitTimerBridge', 'status.json'), 256 * 1024);
      const age = Date.now() - value.timestampUtcMs;
      if (value.protocolVersion !== 1 || path.resolve(value.projectPath).toLowerCase() !== this.projectPath.toLowerCase()) throw new Error('다른 프로젝트 또는 호환되지 않는 브리지입니다.');
      if (!Number.isFinite(age) || age < -5000 || age > 15000) throw new Error('Unity 응답이 오래되었습니다. 에디터와 컴파일 상태를 확인하세요.');
      return { ...value, ready: value.ready === true, message: value.message || (value.ready ? 'Unity 연결됨' : 'Unity가 준비될 때까지 기다리세요.') };
    } catch (error) { return { ready: false, message: error.code === 'ENOENT' ? 'Unity에서 프로젝트를 열고 연결 모듈을 설치하세요.' : error.message }; }
  }
  async command(command, payload = {}, { timeoutMs = 30000, signal, id = randomUUID() } = {}) {
    if (!COMMANDS.has(command)) throw fault('지원하지 않는 Unity 명령입니다.');
    if (!/^[a-f0-9-]{32,36}$/i.test(id)) throw fault('요청 ID가 올바르지 않습니다.');
    if (signal?.aborted) throw fault('작업을 취소했습니다.', 'CANCELLED');
    const folder = this.safePath('Library', 'AutoHitTimerBridge', 'requests');
    const requestPath = this.safePath('Library', 'AutoHitTimerBridge', 'requests', `${id}.json`);
    const responsePath = this.safePath('Library', 'AutoHitTimerBridge', 'responses', `${id}.json`);
    fs.mkdirSync(folder, { recursive: true });
    atomicJson(requestPath, { protocolVersion: 1, id, command, payloadJson: JSON.stringify(payload), expiresUtcMs: Date.now() + timeoutMs }, 1024 * 1024);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        this.safePath('Library', 'AutoHitTimerBridge', 'responses', `${id}.json`);
        const reply = readJson(responsePath, 16 * 1024 * 1024);
        if (reply.protocolVersion !== 1 || reply.id !== id || typeof reply.ok !== 'boolean') throw fault('Unity 응답 형식이 올바르지 않습니다.', 'INVALID_RESPONSE');
        if (!reply.ok) throw fault(reply.error?.message || String(reply.error || 'Unity 작업 실패'), reply.error?.code || 'UNITY_ERROR');
        if (typeof reply.resultJson !== 'string') throw fault('Unity 응답 데이터가 없습니다.', 'INVALID_RESPONSE');
        return JSON.parse(reply.resultJson);
      } catch (error) { if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error; }
      if (signal?.aborted || Date.now() >= deadline) break;
      await delay(100);
    }
    let withdrawn = false;
    try { fs.unlinkSync(requestPath); withdrawn = true; } catch { /* Claimed requests are not retried. */ }
    if (signal?.aborted) throw fault('작업을 취소했습니다.', 'CANCELLED');
    throw Object.assign(fault(withdrawn ? 'Unity 연결 시간이 초과되어 실행 전 요청을 철회했습니다.' : 'Unity 응답 시간이 초과되었습니다. 이미 실행되었을 수 있어 자동 재전송하지 않았습니다.', withdrawn ? 'TIMEOUT' : 'TIMEOUT_UNCERTAIN'), { requestId: id });
  }
  response(id) {
    if (!/^[a-f0-9-]{32,36}$/i.test(id)) throw fault('유효하지 않은 요청 ID입니다.');
    try {
      const reply = readJson(this.safePath('Library', 'AutoHitTimerBridge', 'responses', `${id}.json`));
      if (reply.id !== id || reply.protocolVersion !== 1 || typeof reply.ok !== 'boolean') throw fault('저장 영수증 형식이 올바르지 않습니다.');
      return reply.ok ? { complete: true, result: JSON.parse(reply.resultJson) } : { complete: true, error: reply.error?.message || 'Unity 저장에 실패했습니다.', code: reply.error?.code };
    } catch (error) { if (['ENOENT', 'EBUSY', 'EACCES', 'EPERM'].includes(error.code)) return { complete: false }; throw error; }
  }
  requestOutstanding(id) {
    if (!/^[a-f0-9-]{32,36}$/i.test(id)) throw fault('유효하지 않은 요청 ID입니다.');
    return ['requests', 'processing'].some(folder => fs.existsSync(this.safePath('Library', 'AutoHitTimerBridge', folder, `${id}.json`)));
  }
  mediaPath(filename) {
    const target = fs.realpathSync(filename);
    const root = fs.realpathSync(this.safePath('Library', 'AutoHitTimerBridge'));
    if (!contained(root, target) || !/\.png$/i.test(target) || !fs.statSync(target).isFile()) throw fault('허용되지 않은 미리보기 파일입니다.');
    return target;
  }
}
module.exports = { ProjectClient, projectRoot, contained };
