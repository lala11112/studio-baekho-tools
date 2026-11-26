'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tuning = require('../renderer/tuning-contract.js');

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
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_RESPONSE_BYTES) throw fault('AI 요청이 1MiB를 넘습니다. 동작이나 타격 대상을 나눠 생성하세요.', 'AI_INVALID_INPUT');
  const goal = boundedText(input.goal, 4000, '원하는 타격감');
  if (!Number.isInteger(input.count) || input.count < MIN_CANDIDATES || input.count > MAX_CANDIDATES) {
    throw fault(`비교할 후보 수는 ${MIN_CANDIDATES}~${MAX_CANDIDATES}개로 선택하세요.`, 'AI_INVALID_INPUT');
  }
  if (!Array.isArray(input.parameters) || input.parameters.length < 1 || (input.schemaVersion !== 2 && input.parameters.length > 64)) {
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
      minimum: parameter.minimum, maximum: parameter.maximum, baseline: parameter.baseline,
      ...(input.schemaVersion === 2 ? {
        targetId: boundedText(parameter.targetId, 128, '조정 대상', true), group: boundedText(parameter.group, 100, '항목 그룹', true),
        kind: parameter.kind || 'number', options: Array.isArray(parameter.options) ? parameter.options.slice(0, 32).map(value => boundedText(value, 200, '선택지')) : [],
        suggestedMinimum: parameter.suggestedMinimum, suggestedMaximum: parameter.suggestedMaximum, useSuggestedRange: parameter.useSuggestedRange === true
      } : {})
    };
  });
  if (input.schemaVersion === 2 && !Array.isArray(input.curves || [])) throw fault('곡선 목록 형식이 올바르지 않습니다.', 'AI_INVALID_INPUT');
  const curves = input.schemaVersion === 2 ? (input.curves || []).map(curve => {
    if (!curve || !PARAMETER_ID.test(curve.id) || ids.has(curve.id) || !Number.isFinite(curve.minimum) || !Number.isFinite(curve.maximum) ||
        curve.minimum > curve.maximum || !Number.isFinite(curve.maximumTime) || curve.maximumTime <= 0) throw fault('곡선 명세가 올바르지 않습니다.', 'AI_INVALID_INPUT');
    ids.add(curve.id);
    const result = { id: curve.id, label: boundedText(curve.label || curve.id, 200, '곡선 이름'),
      targetId: boundedText(curve.targetId, 128, '곡선 대상', true), group: boundedText(curve.group, 100, '곡선 그룹', true),
      description: boundedText(curve.description, 1500, '곡선 설명', true), timeUnit: boundedText(curve.timeUnit, 100, '시간 단위', true),
      minimum: curve.minimum, maximum: curve.maximum, maximumTime: curve.maximumTime, keys: curve.keys || [] };
    if (!Array.isArray(result.keys) || result.keys.some(key => !Number.isFinite(key?.time) || !Number.isFinite(key?.value))) throw fault('원본 곡선 키 형식이 올바르지 않습니다.', 'AI_INVALID_INPUT');
    return result;
  }) : [];
  for (const parameter of parameters) if (!['number', 'enum', 'boolean'].includes(parameter.kind || 'number') || !tuning.validValue(parameter.baseline, parameter)) throw fault('선택형 매개변수의 기준값이 올바르지 않습니다.', 'AI_INVALID_INPUT');
  if (parameters.every(parameter => parameter.minimum === parameter.maximum) && !curves.length) {
    throw fault('모든 매개변수가 고정되어 있어 서로 다른 후보를 만들 수 없습니다.', 'AI_INVALID_INPUT');
  }
  return {
    goal, count: input.count, parameters,
    ...(input.schemaVersion === 2 ? generationContext(input, parameters, curves, ids) : {}),
    adapterLabel: boundedText(input.adapterLabel, 300, '어댑터 이름', true),
    sourceLabel: boundedText(input.sourceLabel, 300, '공격 데이터 이름', true),
    actionLabel: boundedText(input.actionLabel, 300, '테스트 동작 이름', true)
  };
}

function generationContext(input, parameters, curves, ids) {
  const mode = input.mode || 'explore', strategy = input.strategy || 'coherent';
  if (!['explore', 'refine', 'factorial'].includes(mode) || !['coherent', 'one-factor', 'factorial', 'camera-only', 'hitstop-only', 'combined'].includes(strategy)) throw fault('후보 생성 방식이 올바르지 않습니다.', 'AI_INVALID_INPUT');
  if ((mode === 'factorial' || strategy === 'factorial') && ![2, 4, 8].includes(input.count)) throw fault('요인 조합 비교는 1–3개 요인의 낮음/높음 조합인 후보 2·4·8개로 생성하세요.', 'AI_INVALID_INPUT');
  if (!Array.isArray(input.lockedIds || []) || (input.lockedIds || []).some(id => !ids.has(id)) || new Set(input.lockedIds || []).size !== (input.lockedIds || []).length) throw fault('잠근 항목 ID가 올바르지 않습니다.', 'AI_INVALID_INPUT');
  const baseline = tuning.sourceCandidate(parameters, curves, 'reference');
  const referenceCandidate = input.referenceCandidate ? { ...input.referenceCandidate,
    values: tuning.effectiveValues(input.referenceCandidate, parameters, curves),
    curves: tuning.activePatch(input.referenceCandidate).curves } : baseline;
  try { tuning.validateCandidate(referenceCandidate, parameters, curves); } catch (error) { throw fault(error.message, 'AI_INVALID_INPUT'); }
  if (input.context != null && (typeof input.context !== 'object' || Array.isArray(input.context))) throw fault('게임 맥락 형식이 올바르지 않습니다.', 'AI_INVALID_INPUT');
  if (input.observations != null && (typeof input.observations !== 'object' || Array.isArray(input.observations) || Buffer.byteLength(JSON.stringify(input.observations)) > 128 * 1024)) throw fault('참고 측정 기록이 128KiB를 넘거나 올바른 객체가 아닙니다.', 'AI_INVALID_INPUT');
  return { schemaVersion: 2, curves, mode, strategy, referenceCandidate, lockedIds: input.lockedIds || [],
    feedback: boundedText(input.feedback, 4000, '개선 피드백', true), context: input.context || {},
    recipeId: boundedText(input.recipeId, 100, '레시피 ID', true), knowledge: input.knowledge || null, observations: input.observations || null };
}

function outputSchema(input) {
  const schema = {
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
  if (input.schemaVersion === 2) {
    const candidate = schema.properties.candidates.items;
    candidate.properties.values.minItems = 0;
    candidate.required.push('curves');
    candidate.properties.curves = { type: 'array', minItems: 0, maxItems: input.curves.length,
      items: { type: 'object', additionalProperties: false, required: ['id', 'keys'], properties: {
        id: { type: 'string', enum: input.curves.map(curve => curve.id).length ? input.curves.map(curve => curve.id) : ['unused'] },
        keys: { type: 'array', minItems: 2, maxItems: 16, items: { type: 'object', additionalProperties: false,
          required: ['time', 'value'], properties: { time: { type: 'number' }, value: { type: 'number' } } } }
      } } };
  }
  return schema;
}

function validateCandidates(response, input) {
  const spec = validateGenerationInput(input);
  if (!response || !Array.isArray(response.candidates) || response.candidates.length !== spec.count) {
    throw fault('AI가 요청한 개수의 후보를 반환하지 않았습니다. 다시 생성해 주세요.', 'AI_INVALID_OUTPUT');
  }
  const candidates = response.candidates.map((candidate, index) => {
    if (!candidate || typeof candidate.label !== 'string' || !candidate.label.trim() || candidate.label.length > 100 ||
        typeof candidate.rationale !== 'string' || !candidate.rationale.trim() || candidate.rationale.length > 1500 ||
        !Array.isArray(candidate.values) || (spec.schemaVersion !== 2 && candidate.values.length !== spec.parameters.length)) {
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
    const result = {
      id: `ai-${String(index + 1).padStart(2, '0')}`, label: candidate.label.trim(), rationale: candidate.rationale.trim(),
      values: spec.parameters.filter(parameter => values.has(parameter.id)).map(parameter => ({ id: parameter.id, value: values.get(parameter.id) }))
    };
    if (spec.schemaVersion === 2) {
      result.curves = candidate.curves;
      result.origin = 'ai'; result.revision = 1;
      try {
        tuning.validateCandidate(result, spec.parameters, spec.curves, true);
        const effective = { ...result, curves: tuning.activePatch(result).curves, values: tuning.effectiveValues(result, spec.parameters, spec.curves) };
        tuning.assertLocks(effective, spec.referenceCandidate, spec.lockedIds);
      }
      catch (error) { throw fault(error.message, 'AI_INVALID_OUTPUT'); }
    }
    return result;
  });
  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < i; j++) {
      const valuesI = spec.schemaVersion === 2 ? tuning.effectiveValues(candidates[i], spec.parameters, spec.curves) : candidates[i].values;
      const valuesJ = spec.schemaVersion === 2 ? tuning.effectiveValues(candidates[j], spec.parameters, spec.curves) : candidates[j].values;
      const indistinguishable = spec.parameters.every(parameter => {
        const left = valuesI.find(value => value.id === parameter.id)?.value ?? parameter.baseline;
        const right = valuesJ.find(value => value.id === parameter.id)?.value ?? parameter.baseline;
        const tolerance = spec.schemaVersion === 2 ? Math.max(1e-8, Math.max(Math.abs(left), Math.abs(right)) * 1e-7)
          : Math.max(1e-10, (parameter.maximum - parameter.minimum) * 1e-6);
        return Math.abs(left - right) <= tolerance;
      });
      const comparableCurves = candidate => spec.schemaVersion === 2 ? [...tuning.activePatch(candidate).curves].sort((a, b) => a.id.localeCompare(b.id)) : candidate.curves;
      if (indistinguishable && JSON.stringify(comparableCurves(candidates[i])) === JSON.stringify(comparableCurves(candidates[j]))) throw fault('AI 후보 사이에 같은 수치가 있습니다. 구분되는 후보를 다시 생성해 주세요.', 'AI_INVALID_OUTPUT');
    }
  }
  if (spec.schemaVersion === 2) validateStrategy(candidates, spec);
  return candidates;
}

function validateStrategy(candidates, spec) {
  const allSpecs = [...spec.parameters, ...spec.curves], references = new Map(spec.referenceCandidate.values.map(value => [value.id, value.value]));
  const effective = candidate => new Map(tuning.effectiveValues(candidate, spec.parameters, spec.curves).map(value => [value.id, value.value]));
  const valueOf = (candidate, values, id) => values.has(id) ? values.get(id) : JSON.stringify(tuning.activePatch(candidate).curves.find(curve => curve.id === id)?.keys || null);
  const maps = candidates.map(effective);
  const allowed = id => spec.strategy === 'camera-only' ? id.includes('.camera.') : spec.strategy === 'hitstop-only' ? id.includes('.hitstop.') : spec.strategy === 'combined' ? id.includes('.camera.') || id.includes('.hitstop.') : true;
  for (const candidate of candidates) {
    if ([...candidate.values, ...(candidate.curves || [])].some(item => !allowed(item.id))) throw fault('원인 분리 전략의 허용 채널 밖 항목이 변경됐습니다. 다시 생성하세요.', 'AI_INVALID_OUTPUT');
  }
  const withoutDependentModes = ids => ids.filter(id => {
    if (id.endsWith('.camera.motion.useFeelZoom') && ids.includes(id.slice(0, -'useFeelZoom'.length) + 'fovOffset')) return false;
    return !id.endsWith('.mode') || !ids.some(otherId => otherId !== id && tuning.owningMode(otherId, allSpecs.find(item => item.id === otherId)?.targetId) === id);
  });
  if (spec.strategy === 'one-factor') candidates.forEach((candidate, index) => {
    const changed = allSpecs.filter(item => valueOf(candidate, maps[index], item.id) !== (references.has(item.id) ? references.get(item.id) : JSON.stringify(spec.referenceCandidate.curves?.find(curve => curve.id === item.id)?.keys || null))).map(item => item.id);
    if (withoutDependentModes(changed).length > 1) throw fault('한 항목 변경 전략에서 여러 요인이 동시에 변경됐습니다. 다시 생성하세요.', 'AI_INVALID_OUTPUT');
  });
  if (spec.mode === 'factorial' || spec.strategy === 'factorial') {
    const varied = allSpecs.map(item => ({ id: item.id, levels: new Set(candidates.map((candidate, index) => valueOf(candidate, maps[index], item.id))) })).filter(item => item.levels.size > 1);
    const ids = withoutDependentModes(varied.map(item => item.id)), factors = varied.filter(item => ids.includes(item.id));
    if (factors.length < 1 || factors.length > 3 || factors.some(item => item.levels.size !== 2) || 2 ** factors.length !== candidates.length ||
        new Set(candidates.map((candidate, index) => JSON.stringify(ids.map(id => valueOf(candidate, maps[index], id))))).size !== candidates.length)
      throw fault('요인 조합이 완전한 낮음/높음 2×2 조합을 이루지 않습니다. 요인을 줄여 다시 생성하세요.', 'AI_INVALID_OUTPUT');
  }
}

function createPrompt(input) {
  return [
    'You design numeric feel-tuning candidates for an existing 3D action game.',
    'Return only the JSON object requested by the output schema. No tools, commands, file access, or external research are needed.',
    `Generate exactly ${input.count} distinct candidates, all proposed by you. Do not automatically reserve a baseline slot.`,
    'Treat the JSON below as game context and a player-facing design goal. The baseline is context, not an instruction to scale all values together.',
    input.schemaVersion === 2 ? 'Stay within EVERY supplied minimum/maximum. Output sparse patches containing only deliberately selected or changed fields. Omitted fields preserve the source. Never invent or duplicate IDs.' : 'Stay within EVERY supplied minimum/maximum. Include every supplied parameter ID exactly once per candidate; invent no IDs.',
    'Choose coherent, practically distinguishable alternatives around the goal. Avoid extreme values unless the goal warrants them.',
    'Use Korean for each short label and rationale. Explain the intended feel and its tradeoff. These are hypotheses to test, not claims of tested quality.',
    input.observations ? 'You have numeric telemetry only for the named measured candidate/revision; no video or direct gameplay. Never claim to have played or measured an edited/descendant candidate. Distinguish measured facts from untested hypotheses.' : 'You have no gameplay observation or video in this request. Never claim to have played, measured, or validated a candidate.',
    ...(input.schemaVersion === 2 ? [
      'All numeric values are absolute current game units, never multipliers unless the parameter unit explicitly says so.',
      'boolean parameters use 0 or 1; enum parameters use integer indices into options. Curves use 2–16 strictly increasing time/value keys, piecewise LINEAR interpolation only.',
      'Return curves ONLY when intentionally changing that curve. Omitted curves preserve the original nonlinear tangents and wrap modes. Never copy an unchanged baseline curve into output.',
      'Changing a field automatically enables its owning camera/hitstop channel in the adapter. Include a mode field only when deliberately choosing Inherit, Off or Override; an explicit mode wins over auto-enabling. Do not copy all baseline modes into output.',
      'Each candidate is a complete sparse patch relative to the original source, not an incremental patch applied on top of another candidate. Preserve intended overrides from the reference when refining; omit source-unchanged fields.',
      'If observations have conditions-mismatch or conditions-unavailable status, do not attribute the measured difference to tuning. Treat fixture validation and capture quality as comparison limitations.',
      'Suggested ranges are design guidance; minimum and maximum are hard engine limits. Keep every locked ID exactly equal to referenceCandidate, including curve keys.',
      'In refine mode, use the supplied feedback and reference as the starting point. In factorial mode, construct controlled low/high combinations of at most 3 unlocked factors, holding everything else constant. In one-factor strategy vary only one factor per candidate.',
      'Read the provided local knowledge and selected recipe as design evidence. Adapt them to context; do not treat example numbers as universal constants.',
      'For a NEW hitstop override, explicitly patch supported scope and stacking IDs to the recipe defaults Both (양쪽) and Maximum (더 느리게·더 늦게 종료), unless the user intent or locks require another choice. Do not copy these defaults over an existing reference stop or unrelated preserved channel. Resolve enum indices from the supplied options.'
    ] : []),
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

function isFile(filename) {
  try { return fs.statSync(filename).isFile(); } catch { return false; }
}

// Returns either an executable path or { command, args } when the CLI is an npm
// JavaScript entry point that must be started through node (spawn with
// shell:false cannot launch the npm .cmd shim on Windows).
function resolveClaudeExecutable(environment = process.env) {
  const envPath = environment.PATH || environment.Path || '';
  const directories = envPath.split(path.delimiter).filter(Boolean).map(directory => directory.replace(/^"|"$/g, ''));
  const native = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const directory of directories) {
    const candidate = path.join(directory, native);
    if (isFile(candidate)) return candidate;
  }
  const home = environment.USERPROFILE || environment.HOME || os.homedir();
  // Native installer location, which is not always on PATH for GUI apps.
  for (const candidate of [path.join(home, '.local', 'bin', native), path.join(home, '.claude', 'local', native)]) {
    if (isFile(candidate)) return candidate;
  }
  if (process.platform === 'win32') {
    const npmDirectories = [...directories, path.join(environment.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm')];
    const node = directories.map(directory => path.join(directory, 'node.exe')).find(isFile);
    for (const directory of npmDirectories) {
      const packageRoot = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code');
      const bundled = path.join(packageRoot, 'bin', 'claude.exe');
      if (isFile(bundled)) return bundled;
      const script = path.join(packageRoot, 'cli.js');
      if (node && isFile(script)) return { command: node, args: [script] };
    }
  }
  throw fault('Claude Code CLI를 찾을 수 없습니다. Claude Code를 설치하고 로그인한 뒤 앱을 다시 실행하세요.', 'AI_UNAVAILABLE');
}

function safeProcessError(output, name = 'Codex') {
  // CLI output can contain account details and credentials. Never forward it into IPC or logs.
  if (/unknown option|unrecognized option|unknown argument/i.test(output)) {
    return fault(`${name} 버전이 이 앱이 사용하는 옵션을 지원하지 않습니다. ${name}를 최신 버전으로 업데이트한 뒤 다시 생성해 주세요.`, 'AI_UNAVAILABLE');
  }
  if (/not logged in|unauthoriz|authentication|401|login required|please log in|please run \/login|invalid api key/i.test(output)) {
    return fault(`${name} 로그인이 필요합니다. ${name}에서 로그인한 뒤 다시 생성해 주세요.`, 'AI_AUTH_REQUIRED');
  }
  if (/usage limit|rate limit|quota|429|credits|exceeded.*limit|credit balance/i.test(output)) {
    return fault(`${name} 사용 한도에 도달했습니다. 한도가 초기화된 뒤 다시 생성해 주세요.`, 'AI_USAGE_LIMIT');
  }
  if (/network|connect|timeout|timed out|dns|502|503|504|overloaded|529/i.test(output)) {
    return fault('AI 서비스에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 생성해 주세요.', 'AI_CONNECTION_FAILED');
  }
  return fault(`${name}에서 후보를 생성하지 못했습니다. ${name} 로그인과 연결 상태를 확인한 뒤 다시 생성해 주세요.`, 'AI_PROCESS_FAILED');
}

function createTemporaryDirectory() {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  return { temporaryRoot, directory: fs.mkdtempSync(path.join(temporaryRoot, 'baekho-ai-')) };
}

function removeTemporaryDirectory({ temporaryRoot, directory }) {
  // Only delete our own freshly-created temporary child; never a user-supplied path.
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith('baekho-ai-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch { /* Antivirus/process-handle races must not replace a useful generation error. */ }
  }
}

class CliCandidateGenerator {
  constructor(options = {}) {
    this._spawn = options.spawn || spawn;
    this._environment = { ...(options.env || process.env) };
    this._executable = options.executable || null;
    this._timeoutMs = options.timeoutMs ?? 180000;
    if (!Number.isFinite(this._timeoutMs) || this._timeoutMs < 1 || this._timeoutMs > 600000) throw new TypeError('Invalid AI process timeout');
  }

  get displayName() { return 'AI'; }

  _launch(executable, args) {
    return typeof executable === 'string' ? { command: executable, args } : { command: executable.command, args: [...executable.args, ...args] };
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
      const startFailure = () => fault(`${this.displayName} 프로세스를 시작하지 못했습니다. 설치 상태를 확인하세요.`, 'AI_UNAVAILABLE');
      try {
        const launch = this._launch(executable, args);
        child = this._spawn(launch.command, launch.args, {
          cwd, env: this._childEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch { finish(startFailure()); return; }
      const collect = target => data => {
        bytes += Buffer.byteLength(data);
        if (bytes > maxBytes) { stop(fault('AI 응답 크기가 허용 범위를 초과했습니다. 다시 생성해 주세요.', 'AI_RESPONSE_TOO_LARGE')); return; }
        if (target === 'stdout') stdout += data.toString('utf8');
        else stderr += data.toString('utf8');
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.once('error', () => finish(startFailure()));
      child.once('close', code => finish(failure, { code, stdout, stderr }));
      child.stdin.on('error', () => { /* Process exit reports the actionable failure without leaking raw stderr. */ });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try { child.stdin.end(input, 'utf8'); }
      catch { stop(fault('AI 요청을 전달하지 못했습니다. 다시 생성해 주세요.', 'AI_PROCESS_FAILED')); }
    });
  }

  _childEnvironment() { return this._environment; }
}

class CodexCandidateGenerator extends CliCandidateGenerator {
  get displayName() { return 'Codex'; }

  _resolveExecutable() {
    return this._executable || resolveCodexExecutable(this._environment);
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
    const temporary = createTemporaryDirectory(), { directory } = temporary;
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
      removeTemporaryDirectory(temporary);
    }
  }
}

// Windows limits a whole command line to 32767 UTF-16 units; the schema is passed as an argument.
const MAX_SCHEMA_ARGUMENT = 24000;
const CLAUDE_SYSTEM_PROMPT = 'You generate numeric feel-tuning candidates for a game tuning tool. Answer only with the structured output that matches the supplied JSON schema. Do not use tools.';
// Variables a parent Claude Code session sets for its own children. Inheriting them (for example when the
// app is launched from a Claude Code terminal) would put the CLI into host-managed or bare auth modes.
const CLAUDE_HOST_SESSION_VARIABLES = /^(CLAUDECODE|CLAUDE_CODE_(SIMPLE|ENTRYPOINT|SESSION_ID|CHILD_SESSION|HOST_SESSION_ID|SDK_HAS_HOST_AUTH_REFRESH|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED))$/;

function claudeSchemaArgument(spec) {
  const schema = outputSchema(spec);
  let text = JSON.stringify(schema);
  if (text.length <= MAX_SCHEMA_ARGUMENT) return text;
  // Very large catalogs: drop the ID enums. validateCandidates still rejects unknown IDs.
  const relaxed = JSON.parse(text, (key, value) => key === 'enum' ? undefined : value);
  text = JSON.stringify(relaxed);
  if (text.length > MAX_SCHEMA_ARGUMENT) throw fault('조정할 항목이 너무 많아 Claude Code에 전달할 수 없습니다. 동작이나 타격 대상을 나눠 생성하세요.', 'AI_INVALID_INPUT');
  return text;
}

function parseClaudeResult(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout.trim().replace(/^﻿/, '')); }
  catch { throw fault('AI의 수치 응답을 읽을 수 없습니다. 다시 생성해 주세요.', 'AI_INVALID_OUTPUT'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw fault('AI의 수치 응답을 읽을 수 없습니다. 다시 생성해 주세요.', 'AI_INVALID_OUTPUT');
  return envelope;
}

function claudeStructuredOutput(envelope) {
  if (envelope.structured_output && typeof envelope.structured_output === 'object') return envelope.structured_output;
  // Older CLI versions or a model that answered in text: accept a bare JSON object (optionally fenced).
  if (typeof envelope.result === 'string') {
    const text = envelope.result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw fault('AI 응답 파일 크기 또는 형식이 올바르지 않습니다.', 'AI_RESPONSE_TOO_LARGE');
    try { return JSON.parse(text); } catch { /* Reported below. */ }
  }
  throw fault('AI의 수치 응답을 읽을 수 없습니다. 다시 생성해 주세요.', 'AI_INVALID_OUTPUT');
}

class ClaudeCodeCandidateGenerator extends CliCandidateGenerator {
  get displayName() { return 'Claude Code'; }

  _resolveExecutable() {
    return this._executable || resolveClaudeExecutable(this._environment);
  }

  _childEnvironment() {
    return Object.fromEntries(Object.entries(this._environment).filter(([key]) => !CLAUDE_HOST_SESSION_VARIABLES.test(key)));
  }

  async status() {
    let executable;
    try { executable = this._resolveExecutable(); }
    catch (error) { return { available: false, authenticated: false, provider: 'claude', label: 'Claude Code 연결 필요', error: error.message }; }
    try {
      const result = await this._run(executable, ['auth', 'status', '--json'], { cwd: os.tmpdir(), timeoutMs: 15000, maxBytes: 65536 });
      let authenticated = false;
      // Only the boolean is read; the account e-mail and organization in this output never leave this function.
      try { authenticated = JSON.parse(result.stdout.trim()).loggedIn === true; }
      catch { authenticated = /"loggedIn"\s*:\s*true/.test(result.stdout); }
      return {
        available: true, authenticated, provider: 'claude', label: authenticated ? 'Claude Code 연결됨' : 'Claude Code 로그인 필요',
        error: authenticated ? '' : 'Claude Code에서 로그인(claude auth login)한 뒤 다시 시도하세요.'
      };
    } catch (error) {
      return { available: error.code !== 'AI_UNAVAILABLE', authenticated: false, provider: 'claude', label: 'Claude Code 연결 확인 필요', error: error.message };
    }
  }

  async generate(input, { signal } = {}) {
    const spec = validateGenerationInput(input);
    if (signal?.aborted) throw fault('AI 후보 생성을 취소했습니다.', 'AI_CANCELLED');
    const schema = claudeSchemaArgument(spec);
    const executable = this._resolveExecutable();
    // An empty working directory keeps project CLAUDE.md files and settings out of the request.
    const temporary = createTemporaryDirectory();
    try {
      const args = [
        '-p', '--output-format', 'json', '--json-schema', schema,
        '--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence',
        '--system-prompt', CLAUDE_SYSTEM_PROMPT
      ];
      const result = await this._run(executable, args, { cwd: temporary.directory, input: createPrompt(spec), signal });
      let envelope;
      try { envelope = parseClaudeResult(result.stdout); }
      catch (error) { if (result.code !== 0) throw safeProcessError(result.stdout + result.stderr, this.displayName); throw error; }
      if (result.code !== 0 || envelope.is_error === true || (envelope.subtype && envelope.subtype !== 'success')) {
        throw safeProcessError(`${typeof envelope.result === 'string' ? envelope.result : ''}\n${envelope.subtype || ''}\n${result.stderr}`, this.displayName);
      }
      const response = claudeStructuredOutput(envelope);
      const model = Object.keys(envelope.modelUsage || {}).find(name => /^[\w.:@/-]{1,128}$/.test(name)) || '';
      return { candidates: validateCandidates(response, spec), provider: 'claude', model, createdUtc: new Date().toISOString() };
    } finally {
      removeTemporaryDirectory(temporary);
    }
  }
}

const AI_PROVIDERS = Object.freeze({
  codex: Object.freeze({ id: 'codex', label: 'Codex', Generator: CodexCandidateGenerator }),
  claude: Object.freeze({ id: 'claude', label: 'Claude Code', Generator: ClaudeCodeCandidateGenerator })
});

module.exports = { CodexCandidateGenerator, ClaudeCodeCandidateGenerator, AI_PROVIDERS, validateGenerationInput, validateCandidates, outputSchema, createPrompt,
  resolveCodexExecutable, resolveClaudeExecutable, MIN_CANDIDATES, MAX_CANDIDATES };
