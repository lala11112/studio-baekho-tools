'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fault } = require('./domain.cjs');
const { readJson } = require('./store.cjs');

function executable(environment = process.env) {
  for (const directory of String(environment.PATH || environment.Path || '').split(path.delimiter)) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'codex.exe' : 'codex');
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  const root = path.join(environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  try {
    const candidates = fs.readdirSync(root).map(item => path.join(root, item, 'codex.exe')).filter(item => fs.existsSync(item));
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  } catch { /* normal unavailable condition */ }
  throw fault('Codex CLI를 찾지 못했습니다. Codex 설치와 로그인을 확인하세요.', 'AI_UNAVAILABLE');
}
function configuredModel(environment = process.env) {
  // Read only a top-level model choice. Never import credentials, tools, hooks, or MCP configuration.
  try {
    const text = fs.readFileSync(path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
    const top = text.split(/^\s*\[/m)[0];
    const match = /^\s*model\s*=\s*["']([a-zA-Z0-9_.:/-]{1,100})["']/m.exec(top);
    return match?.[1] || '';
  } catch { return ''; }
}
function processError(text) {
  if (/not logged in|unauthoriz|authentication|401|login required/i.test(text)) return fault('Codex 로그인이 필요합니다.', 'AI_AUTH_REQUIRED');
  if (/usage limit|rate limit|quota|429|credits/i.test(text)) return fault('Codex 사용 한도에 도달했습니다. 나중에 다시 분석하세요.', 'AI_USAGE_LIMIT');
  if (/image.*not support|does not support.*image|invalid model|model.*not found/i.test(text)) return fault('설정된 Codex 모델의 이미지 입력을 사용할 수 없습니다. Codex 모델 설정을 확인하세요.', 'AI_MODEL_UNAVAILABLE');
  if (/network|connect|timeout|dns|502|503/i.test(text)) return fault('AI 서비스 연결에 실패했습니다.', 'AI_CONNECTION_FAILED');
  return fault('Codex 분석에 실패했습니다. 로그인·연결 상태를 확인한 뒤 다시 실행하세요.', 'AI_PROCESS_FAILED');
}
function schema(frames) {
  return { type: 'object', additionalProperties: false, required: ['status', 'summary', 'windows'], properties: {
    status: { type: 'string', enum: ['hits', 'no-hit', 'uncertain'] }, summary: { type: 'string' },
    windows: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false,
      required: ['startFrameId', 'endFrameId', 'reason', 'uncertain'], properties: {
        startFrameId: { type: 'string', enum: frames.map(frame => frame.id) },
        endFrameId: { type: 'string', enum: frames.map(frame => frame.id) },
        reason: { type: 'string' }, uncertain: { type: 'boolean' }
      } }
    }
  } };
}
function validateResult(result, frames) {
  if (!result || !['hits', 'no-hit', 'uncertain'].includes(result.status) || typeof result.summary !== 'string' ||
      !Array.isArray(result.windows) || result.windows.length > 64 || (result.status === 'no-hit' && result.windows.length) ||
      (result.status === 'hits' && !result.windows.length)) throw fault('AI의 판정 결과 형식이 올바르지 않습니다.', 'AI_INVALID_OUTPUT');
  const byId = new Map(frames.map(frame => [frame.id, frame]));
  const windows = result.windows.map(window => {
    const first = byId.get(window.startFrameId), last = byId.get(window.endFrameId);
    if (!first || !last || last.time <= first.time || typeof window.reason !== 'string' || typeof window.uncertain !== 'boolean')
      throw fault('AI가 유효한 시작·종료 프레임을 반환하지 않았습니다.', 'AI_INVALID_OUTPUT');
    return { start: first.time, end: last.time, reason: window.reason.slice(0, 2000), uncertain: window.uncertain || result.status === 'uncertain', sourceIndex: -1 };
  });
  return { status: result.status, summary: result.summary.slice(0, 4000), windows };
}
function prompt({ clip, frames, refinement, hint }) {
  return [
    'You are reviewing a 3D game attack animation, not executing code. Analyze the supplied real sampled animation images.',
    'Each image contains synchronized oblique and side views of ONE frame. Images are in the exact order of the frame manifest below.',
    'Find visually plausible active damage-contact windows: the damaging forward cut, thrust, kick, or strike. Exclude windup, return/recovery, idle and decorative motion. Multiple distinct strikes need separate windows.',
    'There is no target collision or game simulation in these pictures. You are proposing active windows for human review, never claiming measured collision or guaranteed game correctness.',
    'Report no-hit for no attack; report uncertain if occluded, ambiguous, incomplete, or impossible to judge. Never invent a strike from the animation name or requested count.',
    'Return ONLY the schema JSON. Boundaries must use the supplied frame IDs; end time must be after start. Use Korean for summary and reasoning.',
    refinement ? 'This is a refinement around one previously proposed strike. Return at most ONE corrected window for that strike. The manifest includes original context frames and dense boundary samples. Preserve uncertainty if the contact cannot be inferred.' :
      'This is a full-coverage coarse pass. The chunk overlaps adjacent chunks; include visible windows at boundaries and mark truncated windows uncertain. Avoid merging visibly separate strikes.',
    JSON.stringify({ clip: { name: clip.name, length: clip.length }, phase: refinement ? 'refinement' : 'coarse', hint: hint || null,
      frames: frames.map(frame => ({ id: frame.id, time: frame.time })) })
  ].join('\n\n');
}
class CodexAnalyzer {
  constructor(options = {}) { this.spawn = options.spawn || spawn; this.environment = options.env || process.env; this.cli = options.executable || null; this.timeoutMs = options.timeoutMs || 300000; }
  run(args, { input = '', cwd = os.tmpdir(), signal, timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(fault('분석을 취소했습니다.', 'CANCELLED'));
      let child, output = '', bytes = 0, failure, settled = false, grace;
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(result); };
      const stop = error => { if (failure || settled) return; failure = error; child?.kill(); grace = setTimeout(() => finish(error), 3000); };
      const cancel = () => stop(fault('분석을 취소했습니다.', 'CANCELLED'));
      const timer = setTimeout(() => stop(fault('AI 분석 제한 시간을 초과했습니다. 기존 결과는 보존했습니다.', 'AI_TIMEOUT')), timeoutMs);
      try {
        child = this.spawn(this.cli || executable(this.environment), args, { cwd, env: this.environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const collect = data => { bytes += data.length; if (bytes > 4 * 1024 * 1024) return stop(fault('AI 응답 크기가 제한을 초과했습니다.', 'AI_RESPONSE_TOO_LARGE')); output += data.toString('utf8'); };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        child.once('error', () => finish(fault('Codex 프로세스를 시작하지 못했습니다.', 'AI_UNAVAILABLE')));
        child.once('close', code => finish(failure, { code, output }));
        child.stdin.on('error', () => {});
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        child.stdin.end(input, 'utf8');
      } catch (error) { finish(error); }
    });
  }
  async status() {
    try {
      const result = await this.run(['login', 'status'], { timeoutMs: 15000 });
      const authenticated = result.code === 0 && /logged in/i.test(result.output) && !/not logged in/i.test(result.output);
      return { available: true, authenticated, label: authenticated ? 'Codex 연결됨' : 'Codex 로그인 필요', model: configuredModel(this.environment), error: authenticated ? '' : 'Codex에 로그인하세요.' };
    } catch (error) { return { available: false, authenticated: false, label: 'Codex 연결 필요', error: error.message }; }
  }
  async analyze({ clip, frames, refinement = false, hint }, { signal } = {}) {
    if (!frames?.length || frames.length > 100) throw fault('AI 입력 프레임 수는 1~100개여야 합니다.');
    if (new Set(frames.map(frame => frame.id)).size !== frames.length) throw fault('프레임 ID가 중복되었습니다.');
    for (const frame of frames) {
      const stat = fs.lstatSync(frame.path);
      if (!Number.isFinite(frame.time) || frame.time < 0 || frame.time > clip.length + 0.00001 || !stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
        throw fault('촬영 프레임이 유효하지 않습니다.');
    }
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'aht-ai-'));
    try {
      const schemaPath = path.join(directory, 'schema.json'), outputPath = path.join(directory, 'response.json');
      fs.writeFileSync(schemaPath, JSON.stringify(schema(frames)), 'utf8');
      const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
        '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'multi_agent', '--config', 'web_search="disabled"',
        '--json', '--color', 'never', '--output-schema', schemaPath, '--output-last-message', outputPath];
      const model = configuredModel(this.environment);
      if (model) args.push('--model', model);
      for (const frame of frames) args.push('--image', frame.path);
      args.push('-');
      const result = await this.run(args, { cwd: directory, signal, input: prompt({ clip, frames, refinement, hint }) });
      if (result.code !== 0) throw processError(result.output);
      let parsed;
      try { parsed = readJson(outputPath, 1024 * 1024); }
      catch { throw fault('AI 응답을 읽지 못했습니다.', 'AI_INVALID_OUTPUT'); }
      const response = validateResult(parsed, frames);
      response.model = model || 'Codex default';
      response.createdUtc = new Date().toISOString();
      return response;
    } finally {
      // This path is our own direct child of the canonical temporary root, never caller input.
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith('aht-ai-')) {
        try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2 }); } catch { /* Antivirus locks are harmless. */ }
      }
    }
  }
}
module.exports = { CodexAnalyzer, validateResult, schema, prompt, executable, configuredModel };
