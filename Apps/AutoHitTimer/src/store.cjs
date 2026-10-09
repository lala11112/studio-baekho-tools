'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function atomicJson(filename, value, maxBytes = 32 * 1024 * 1024) {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > maxBytes) throw new Error('저장 데이터의 크기 제한을 초과했습니다.');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, text, { flag: 'wx', encoding: 'utf8' }); fs.renameSync(temporary, filename); }
  finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function readJson(filename, maxBytes = 32 * 1024 * 1024) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('유효하지 않은 데이터 파일입니다.');
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
}
class Store {
  constructor(directory) { this.directory = directory; this.writeBlocked = new Set(); }
  filename(project) { return path.join(this.directory, 'projects', createHash('sha256').update(project.toLowerCase()).digest('hex') + '.json'); }
  load(project) {
    try {
      const value = readJson(this.filename(project));
      if (value.schemaVersion !== 1 || !Array.isArray(value.jobs)) throw new Error('초안 형식이 다릅니다.');
      for (const job of value.jobs) {
        if (['capturing', 'analyzing'].includes(job.status)) {
          job.status = 'cancelled'; job.error = '앱이 종료되어 분석이 중단되었습니다. 저장된 프레임과 초안을 확인한 뒤 다시 실행하세요.';
        }
      }
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { settings: {}, jobs: [], selectedJobId: '' };
      const filename = this.filename(project), backup = `${filename}.${randomUUID()}.corrupt`;
      try { fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL); }
      catch { this.writeBlocked.add(filename); throw new Error('초안 복구 사본을 만들지 못했습니다. 원본 보호를 위해 프로젝트 연결을 중단합니다.'); }
      return { settings: {}, jobs: [], selectedJobId: '', recoveryError: '이전 초안을 읽지 못했습니다. 복구 사본: ' + backup };
    }
  }
  save(project, value) {
    const filename = this.filename(project);
    if (this.writeBlocked.has(filename)) throw new Error('초안 원본을 보존하기 위해 저장을 중단했습니다.');
    atomicJson(filename, { schemaVersion: 1, project, ...value });
  }
  preferences() { try { return readJson(path.join(this.directory, 'preferences.json')); } catch { return {}; } }
  savePreferences(value) { atomicJson(path.join(this.directory, 'preferences.json'), value); }
}
module.exports = { Store, atomicJson, readJson };
