'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROCESS_BYTES = 2 * 1024 * 1024;
const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = 12;
const PARAMETER_ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

function fault(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedText(value, limit, label, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim())) {
    throw fault(`${label} 형식 또는 길이가 올바르지 않습니다.`, 'AI_INVALID_INPUT');
  }
  return value.trim();
}

function validateGenerationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('AI 생성 요청이 올바르지 않습니다.', 'AI_INVALID_INPUT');
  const goal = boundedText(input.goal, 4000, '원하는 타격감');
  if (!Number.isInteger(input.count) || input.count < MIN_CANDIDATES || input.count > MAX_CANDIDATES) {
    throw fault(`비교할 후보 수는 ${MIN_CANDIDATES}~${MAX_CANDIDATES}개로 선택하세요.`, 'AI_INVALID_INPUT');
  }
  if (!Array.isArray(input.parameters) || input.parameters.length < 1 || input.parameters.length > 64) {
    throw fault('조정할 매개변수가 없거나 너무 많습니다.', 'AI_INVALID_INPUT');
  }
  const ids = new Set();
  const parameters = input.parameters.map(parameter => {
    if (!parameter || typeof parameter.id !== 'string' || !PARAMETER_ID.test(parameter.id) || ids.has(parameter.id) ||
        !Number.isFinite(parameter.minimum) || !Number.isFinite(parameter.maximum) || !Number.isFinite(parameter.baseline) ||
        parameter.minimum > parameter.maximum || parameter.baseline < parameter.minimum || parameter.baseline > parameter.maximum) {
      throw fault('프로젝트 매개변수의 ID, 범위 또는 기준값이 올바르지 않습니다.', 'AI_INVALID_INPUT');
    }
    ids.add(parameter.id);
    return {
      id: parameter.id, label: boundedText(parameter.label || parameter.id, 200, '매개변수 이름'),
      description: boundedText(parameter.description, 1500, '매개변수 설명', true),
      unit: boundedText(parameter.unit, 100, '매개변수 단위', true),
      minimum: parameter.minimum, maximum: parameter.maximum, baseline: parameter.baseline
    };
  });
  if (parameters.every(parameter => parameter.minimum === parameter.maximum)) {
    throw fault('모든 매개변수가 고정되어 있어 서로 다른 후보를 만들 수 없습니다.', 'AI_INVALID_INPUT');
  }
  return {
    goal, count: input.count, parameters,
    adapterLabel: boundedText(input.adapterLabel, 300, '어댑터 이름', true),
    sourceLabel: boundedText(input.sourceLabel, 300, '공격 데이터 이름', true),
    actionLabel: boundedText(input.actionLabel, 300, '테스트 동작 이름', true)
  };
}

function outputSchema(input) {
  return {
    type: 'object', additionalProperties: false, required: ['candidates'],
    properties: {
      candidates: {
        type: 'array', minItems: input.count, maxItems: input.count,
        items: {
          type: 'object', additionalProperties: false, required: ['label', 'rationale', 'values'],
          properties: {
            label: { type: 'string', minLength: 1, maxLength: 100 },
            rationale: { type: 'string', minLength: 1, maxLength: 1500 },
            values: {
              type: 'array', minItems: input.parameters.length, maxItems: input.parameters.length,
              items: {
                type: 'object', additionalProperties: false, required: ['id', 'value'],
                properties: {
                  id: { type: 'string', enum: input.parameters.map(parameter => parameter.id) },
                  value: { type: 'number' }
                }
              }
            }
          }
        }
      }
    }
  };
}

function validateCandidates(response, input) {
  const spec = validateGenerationInput(input);
  if (!response || !Array.isArray(response.candidates) || response.candidates.length !== spec.count) {
    throw fault('AI가 요청한 개수의 후보를 반환하지 않았습니다. 다시 생성해 주세요.', 'AI_INVALID_OUTPUT');
  }
  const candidates = response.candidates.map((candidate, index) => {
    if (!candidate || typeof candidate.label !== 'string' || !candidate.label.trim() || candidate.label.length > 100 ||
        typeof candidate.rationale !== 'string' || !candidate.rationale.trim() || candidate.rationale.length > 1500 ||
        !Array.isArray(candidate.values) || candidate.values.length !== spec.parameters.length) {
      throw fault('AI 후보의 이름, 설명 또는 매개변수 목록이 올바르지 않습니다. 다시 생성해 주세요.', 'AI_INVALID_OUTPUT');
    }
    const values = new Map();
    for (const item of candidate.values) {
      const parameter = spec.parameters.find(parameter => parameter.id === item?.id);
      if (!parameter || values.has(item.id) || !Number.isFinite(item.value) || item.value < parameter.minimum || item.value > parameter.maximum) {
        throw fault('AI가 허용 범위를 벗어나거나 중복된 수치를 반환했습니다. 다시 생성해 주세요.', 'AI_INVALID_OUTPUT');
      }
      values.set(item.id, item.value);
    }
    return {
      id: `ai-${String(index + 1).padStart(2, '0')}`, label: candidate.label.trim(), rationale: candidate.rationale.trim(),
      values: spec.parameters.map(parameter => ({ id: parameter.id, value: values.get(parameter.id) }))
    };
  });
  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < i; j++) {
      const indistinguishable = candidates[i].values.every((value, index) => {
        const parameter = spec.parameters[index];
        return Math.abs(value.value - candidates[j].values[index].value) <= Math.max(1e-10, (parameter.maximum - parameter.minimum) * 1e-6);
      });
      if (indistinguishable) throw fault('AI 후보 사이에 같은 수치가 있습니다. 구분되는 후보를 다시 생성해 주세요.', 'AI_INVALID_OUTPUT');
    }
  }
  return candidates;
}

function createPrompt(input) {
  return [
    'You design numeric feel-tuning candidates for an existing 3D action game.',
    'Return only the JSON object requested by the output schema. No tools, commands, file access, or external research are needed.',
    `Generate exactly ${input.count} distinct candidates, all proposed by you. Do not automatically reserve a baseline slot.`,
    'Treat the JSON below as game context and a player-facing design goal. The baseline is context, not an instruction to scale all values together.',
    'Stay within EVERY supplied minimum/maximum. Include every supplied parameter ID exactly once per candidate; invent no IDs.',
    'Choose coherent, practically distinguishable alternatives around the goal. Avoid extreme values unless the goal warrants them.',
    'Use Korean for each short label and rationale. Explain the intended feel and its tradeoff. These are hypotheses to test, not claims of tested quality.',
    'You have no gameplay observation or video in this request. Never claim to have played, measured, or validated a candidate.',
    JSON.stringify(input, null, 2)
  ].join('\n\n');
}

function resolveCodexExecutable(environment = process.env) {
  const envPath = environment.PATH || environment.Path || '';
  const names = process.platform === 'win32' ? ['codex.exe'] : ['codex'];
  for (const directory of envPath.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* Next PATH directory. */ }
    }
  }
  if (process.platform === 'win32') {
    const local = environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const root = path.join(local, 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(root, entry.name, 'codex.exe'))
        .filter(filename => { try { return fs.statSync(filename).isFile(); } catch { return false; } })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidates.length) return candidates[0];
    } catch { /* A machine without Codex is a normal unavailable state. */ }
  }
  throw fault('Codex CLI를 찾을 수 없습니다. Codex를 설치하고 로그인한 뒤 앱을 다시 실행하세요.', 'AI_UNAVAILABLE');
}

function safeProcessError(output) {
  // CLI output can contain account details and credentials. Never forward it into IPC or logs.
  if (/not logged in|unauthoriz|authentication|401|login required|please log in/i.test(output)) {
    return fault('Codex 로그인이 필요합니다. Codex에서 로그인한 뒤 다시 생성해 주세요.', 'AI_AUTH_REQUIRED');
  }
  if (/usage limit|rate limit|quota|429|credits|exceeded.*limit/i.test(output)) {
    return fault('Codex 사용 한도에 도달했습니다. 한도가 초기화된 뒤 다시 생성해 주세요.', 'AI_USAGE_LIMIT');
  }
  if (/network|connect|timeout|timed out|dns|502|503|504/i.test(output)) {
    return fault('AI 서비스에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 생성해 주세요.', 'AI_CONNECTION_FAILED');
  }
  return fault('Codex에서 후보를 생성하지 못했습니다. Codex 로그인과 연결 상태를 확인한 뒤 다시 생성해 주세요.', 'AI_PROCESS_FAILED');
}

class CodexCandidateGenerator {
  constructor(options = {}) {
    this._spawn = options.spawn || spawn;
    this._environment = { ...(options.env || process.env) };
    this._executable = options.executable || null;
    this._timeoutMs = options.timeoutMs ?? 180000;
    if (!Number.isFinite(this._timeoutMs) || this._timeoutMs < 1 || this._timeoutMs > 600000) throw new TypeError('Invalid AI process timeout');
  }

  _resolveExecutable() {
    return this._executable || resolveCodexExecutable(this._environment);
  }

  _run(executable, args, { cwd, input = '', timeoutMs, signal, maxBytes = MAX_PROCESS_BYTES } = {}) {
    if (signal?.aborted) return Promise.reject(fault('AI 후보 생성을 취소했습니다.', 'AI_CANCELLED'));
    return new Promise((resolve, reject) => {
      let child;
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let failure;
      let settled = false;
      let terminationTimer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(terminationTimer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result);
      };
      const stop = error => {
        if (settled || failure) return;
        failure = error;
        try { child?.kill(); } catch { /* Completion/error handlers still clean up. */ }
        terminationTimer = setTimeout(() => finish(failure), 3000);
      };
      const abort = () => stop(fault('AI 후보 생성을 취소했습니다.', 'AI_CANCELLED'));
      const timer = setTimeout(() => stop(fault('AI 후보 생성 시간이 초과되었습니다. 다시 생성해 주세요.', 'AI_TIMEOUT')), timeoutMs ?? this._timeoutMs);
      try {
        child = this._spawn(executable, args, {
          cwd, env: this._environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch { finish(fault('Codex 프로세스를 시작하지 못했습니다. 설치 상태를 확인하세요.', 'AI_UNAVAILABLE')); return; }
      const collect = target => data => {
        bytes += Buffer.byteLength(data);
        if (bytes > maxBytes) { stop(fault('AI 응답 크기가 허용 범위를 초과했습니다. 다시 생성해 주세요.', 'AI_RESPONSE_TOO_LARGE')); return; }
        if (target === 'stdout') stdout += data.toString('utf8');
        else stderr += data.toString('utf8');
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.once('error', () => finish(fault('Codex 프로세스를 시작하지 못했습니다. 설치 상태를 확인하세요.', 'AI_UNAVAILABLE')));
      child.once('close', code => finish(failure, { code, stdout, stderr }));
      child.stdin.on('error', () => { /* Process exit reports the actionable failure without leaking raw stderr. */ });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try { child.stdin.end(input, 'utf8'); }
      catch { stop(fault('AI 요청을 전달하지 못했습니다. 다시 생성해 주세요.', 'AI_PROCESS_FAILED')); }
    });
  }

  async status() {
    let executable;
    try { executable = this._resolveExecutable(); }
    catch (error) { return { available: false, authenticated: false, provider: 'codex', label: 'Codex 연결 필요', error: error.message }; }
    try {
      const result = await this._run(executable, ['login', 'status'], { cwd: os.tmpdir(), timeoutMs: 15000, maxBytes: 65536 });
      const output = result.stdout + result.stderr;
      const authenticated = result.code === 0 && /logged in/i.test(output) && !/not logged in/i.test(output);
      return {
        available: true, authenticated, provider: 'codex', label: authenticated ? 'Codex 연결됨' : 'Codex 로그인 필요',
        error: authenticated ? '' : 'Codex에서 로그인한 뒤 다시 시도하세요.'
      };
    } catch (error) {
      return { available: error.code !== 'AI_UNAVAILABLE', authenticated: false, provider: 'codex', label: 'Codex 연결 확인 필요', error: error.message };
    }
  }

  async generate(input, { signal } = {}) {
    const spec = validateGenerationInput(input);
    if (signal?.aborted) throw fault('AI 후보 생성을 취소했습니다.', 'AI_CANCELLED');
    const executable = this._resolveExecutable();
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'baekho-ai-'));
    const schemaPath = path.join(directory, 'schema.json');
    const outputPath = path.join(directory, 'response.json');
    try {
      fs.writeFileSync(schemaPath, JSON.stringify(outputSchema(spec)), { encoding: 'utf8', flag: 'wx' });
      const args = [
        'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
        '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'multi_agent',
        '--config', 'web_search="disabled"', '--json', '--color', 'never',
        '--output-schema', schemaPath, '--output-last-message', outputPath, '-'
      ];
      const result = await this._run(executable, args, { cwd: directory, input: createPrompt(spec), signal });
      if (result.code !== 0) throw safeProcessError(result.stdout + result.stderr);
      let response;
      try {
        const stat = fs.lstatSync(outputPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESPONSE_BYTES) {
          throw fault('AI 응답 파일 크기 또는 형식이 올바르지 않습니다.', 'AI_RESPONSE_TOO_LARGE');
        }
        response = JSON.parse(fs.readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, ''));
      } catch (error) {
        if (error.code === 'AI_RESPONSE_TOO_LARGE') throw error;
        throw fault('AI의 수치 응답을 읽을 수 없습니다. 다시 생성해 주세요.', 'AI_INVALID_OUTPUT');
      }
      return { candidates: validateCandidates(response, spec), provider: 'codex', createdUtc: new Date().toISOString() };
    } finally {
      // Only delete our own freshly-created temporary child; never a user-supplied path.
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith('baekho-ai-')) {
        try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
        catch { /* Antivirus/process-handle races must not replace a useful generation error. */ }
      }
    }
  }
}

module.exports = { CodexCandidateGenerator, validateGenerationInput, validateCandidates, resolveCodexExecutable, MIN_CANDIDATES, MAX_CANDIDATES };
