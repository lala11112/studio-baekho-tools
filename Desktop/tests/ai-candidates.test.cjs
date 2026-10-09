'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CodexCandidateGenerator, validateGenerationInput, validateCandidates } = require('../src/ai-candidates.cjs');

function input(count = 3) {
  return {
    goal: '묵직한 검 공격이지만 조작감은 빠르게 유지하고 싶어요.', count,
    adapterLabel: 'Four Tiger Sword', sourceLabel: 'WaterFromAction',
    parameters: [
      { id: 'knockbackMultiplier', label: '밀쳐내기', unit: '배', description: '공격 넉백 배율', minimum: 0, maximum: 2, baseline: 1 },
      { id: 'cameraShakeMultiplier', label: '카메라 흔들림', unit: '배', description: '카메라 흔들림 배율', minimum: 0, maximum: 3, baseline: 1 },
      { id: 'hitStopDuration', label: '히트스톱', unit: '초', description: '플레이어 전체 타격 정지 시간', minimum: 0, maximum: 0.3, baseline: 0.08 }
    ]
  };
}

function response(count = 3) {
  return {
    candidates: Array.from({ length: count }, (_, index) => ({
      label: `후보 ${index + 1}`, rationale: '정지 시간을 조금 늘려 무게감을 기대하지만 조작 흐름을 영상으로 확인해야 합니다.',
      values: [
        { id: 'hitStopDuration', value: 0.04 + index * 0.01 },
        { id: 'cameraShakeMultiplier', value: 0.5 + index * 0.1 },
        { id: 'knockbackMultiplier', value: 0.6 + index * 0.1 }
      ]
    }))
  };
}

function mockProcess(onInput) {
  const calls = [];
  function mockSpawn(executable, args, options) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null));
      return true;
    };
    const call = { executable, args, options, child, input: '' };
    child.stdin.on('data', chunk => { call.input += chunk.toString('utf8'); });
    child.stdin.on('finish', () => setImmediate(() => {
      try { onInput(call); } catch (error) { child.emit('error', error); }
    }));
    calls.push(call);
    return child;
  }
  return { calls, spawn: mockSpawn };
}

function complete(call, value = response()) {
  fs.writeFileSync(call.args[call.args.indexOf('--output-last-message') + 1], JSON.stringify(value));
  call.child.stdout.write('{"type":"turn.completed"}\n');
  call.child.emit('close', 0);
}

test('validates every input parameter and the user-selected 2–12 count before invoking AI', () => {
  assert.equal(validateGenerationInput(input(12)).count, 12);
  for (const value of [null, {}, { ...input(), count: 1 }, { ...input(), count: 13 }, { ...input(), count: 2.5 },
    { ...input(), goal: '' }, { ...input(), goal: 'x'.repeat(4001) }, { ...input(), parameters: [] },
    { ...input(), parameters: [input().parameters[0], input().parameters[0]] },
    { ...input(), parameters: [{ ...input().parameters[0], baseline: NaN }] },
    { ...input(), parameters: [{ ...input().parameters[0], minimum: Infinity }] },
    { ...input(), parameters: [{ ...input().parameters[0], maximum: 0.2 }] },
    { ...input(), parameters: [{ ...input().parameters[0], id: '../bad' }] },
    { ...input(), parameters: [{ ...input().parameters[0], minimum: 1, maximum: 1 }] }
  ]) assert.throws(() => validateGenerationInput(value), { code: 'AI_INVALID_INPUT' });
});

test('valid response preserves AI numbers and rationales and assigns safe stable candidate IDs', () => {
  const value = response(12);
  const candidates = validateCandidates(value, input(12));
  assert.equal(candidates.length, 12);
  assert.equal(candidates[0].id, 'ai-01');
  assert.equal(candidates[11].id, 'ai-12');
  assert.deepEqual(candidates[0].values, [value.candidates[0].values[2], value.candidates[0].values[1], value.candidates[0].values[0]]);
  assert.equal(candidates[0].rationale, value.candidates[0].rationale);
});

test('rejects missing/unknown/duplicate IDs, nonfinite/out-of-range values, and malformed descriptions', () => {
  const mutations = [
    value => { value.candidates.pop(); },
    value => { value.candidates[0].values.pop(); },
    value => { value.candidates[0].values[0].id = 'unknown'; },
    value => { value.candidates[0].values[0].id = 'knockbackMultiplier'; },
    value => { value.candidates[0].values[0].value = NaN; },
    value => { value.candidates[0].values[0].value = Infinity; },
    value => { value.candidates[0].values[0].value = '0.08'; },
    value => { value.candidates[0].values[0].value = 0.31; },
    value => { value.candidates[0].values[0].value = -0.01; },
    value => { value.candidates[0].label = ''; },
    value => { value.candidates[0].rationale = 'x'.repeat(1501); },
    value => { value.candidates[0] = null; }
  ];
  for (const mutate of mutations) {
    const value = response();
    mutate(value);
    assert.throws(() => validateCandidates(value, input()), { code: 'AI_INVALID_OUTPUT' });
  }
});

test('rejects every duplicated or numerically indistinguishable candidate instead of faking diversity', () => {
  const value = response();
  value.candidates[2].values = structuredClone(value.candidates[0].values);
  assert.throws(() => validateCandidates(value, input()), { code: 'AI_INVALID_OUTPUT' });
  value.candidates[2].values[0].value += 1e-10;
  assert.throws(() => validateCandidates(value, input()), { code: 'AI_INVALID_OUTPUT' });
});

test('runs the authenticated CLI with stdin, strict schema, isolated directory, disabled tools, and no model override', async () => {
  let capturedSchema;
  const mock = mockProcess(call => {
    capturedSchema = JSON.parse(fs.readFileSync(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
    complete(call);
  });
  const generator = new CodexCandidateGenerator({ spawn: mock.spawn, executable: 'mock-codex.exe', env: { PATH: 'test-path' } });
  const result = await generator.generate(input());
  const call = mock.calls[0];
  assert.equal(result.provider, 'codex');
  assert.equal(result.candidates.length, 3);
  assert.ok(Number.isFinite(Date.parse(result.createdUtc)));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(path.basename(call.options.cwd).startsWith('baekho-ai-'), true);
  assert.equal(fs.existsSync(call.options.cwd), false, 'temporary schema/response removed after success');
  assert.deepEqual(call.options.env, { PATH: 'test-path' });
  assert.equal(call.args[0], 'exec');
  assert.equal(call.args.at(-1), '-');
  assert.ok(call.args.includes('--ignore-user-config'));
  assert.ok(call.args.includes('--ephemeral'));
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(call.args[call.args.indexOf('--config') + 1], 'web_search="disabled"');
  for (const feature of ['shell_tool', 'apps', 'multi_agent']) assert.equal(call.args[call.args.indexOf(feature) - 1], '--disable');
  assert.equal(call.args.includes('--model'), false);
  assert.equal(call.args.includes('--ignore-rules'), false);
  assert.equal(call.args.some(arg => arg.includes('bypass')), false);
  assert.ok(call.input.includes(input().goal));
  assert.ok(call.input.includes('Never claim to have played'));
  assert.equal(capturedSchema.additionalProperties, false);
  assert.equal(capturedSchema.properties.candidates.minItems, 3);
  assert.equal(capturedSchema.properties.candidates.maxItems, 3);
  assert.deepEqual(capturedSchema.properties.candidates.items.properties.values.items.properties.id.enum,
    input().parameters.map(parameter => parameter.id));
});

test('status reads CLI login state and never returns its raw account output', async () => {
  const mock = mockProcess(call => {
    assert.deepEqual(call.args, ['login', 'status']);
    call.child.stderr.write('Logged in using ChatGPT (private-user@example.test)');
    call.child.emit('close', 0);
  });
  const result = await new CodexCandidateGenerator({ spawn: mock.spawn, executable: 'mock' }).status();
  assert.equal(result.available, true);
  assert.equal(result.authenticated, true);
  assert.equal(JSON.stringify(result).includes('private-user'), false);
  const failed = mockProcess(call => { call.child.stderr.write('Not logged in'); call.child.emit('close', 1); });
  assert.equal((await new CodexCandidateGenerator({ spawn: failed.spawn, executable: 'mock' }).status()).authenticated, false);
});

test('missing process is reported without leaking OS error details', async () => {
  const generator = new CodexCandidateGenerator({ executable: 'mock', spawn() { throw new Error('private-secret-path'); } });
  const status = await generator.status();
  assert.equal(status.available, false);
  assert.equal(status.authenticated, false);
  assert.equal(status.error.includes('private-secret'), false);
  await assert.rejects(generator.generate(input()), { code: 'AI_UNAVAILABLE' });
});

test('malformed and missing final JSON fail without a heuristic candidate fallback', async () => {
  for (const body of ['not-json', '', '{"candidates":[]}']) {
    const mock = mockProcess(call => {
      if (body) fs.writeFileSync(call.args[call.args.indexOf('--output-last-message') + 1], body);
      call.child.emit('close', 0);
    });
    await assert.rejects(new CodexCandidateGenerator({ spawn: mock.spawn, executable: 'mock' }).generate(input()), { code: 'AI_INVALID_OUTPUT' });
    assert.equal(fs.existsSync(mock.calls[0].options.cwd), false);
  }
});

test('sanitizes authentication, quota, connection, and other process failures', async () => {
  for (const [message, code] of [
    ['401 authentication failed sk-private-secret', 'AI_AUTH_REQUIRED'],
    ['usage limit exceeded sk-private-secret', 'AI_USAGE_LIMIT'],
    ['network connection failed sk-private-secret', 'AI_CONNECTION_FAILED'],
    ['unexpected failure sk-private-secret', 'AI_PROCESS_FAILED']
  ]) {
    const mock = mockProcess(call => { call.child.stderr.write(message); call.child.emit('close', 1); });
    await assert.rejects(new CodexCandidateGenerator({ spawn: mock.spawn, executable: 'mock' }).generate(input()), error => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes('sk-private-secret'), false);
      return true;
    });
    assert.equal(fs.existsSync(mock.calls[0].options.cwd), false);
  }
});

test('cancellation stops an in-flight process, cleans up files, and pre-cancel never starts a process', async () => {
  const controller = new AbortController();
  const mock = mockProcess(() => controller.abort());
  const generator = new CodexCandidateGenerator({ spawn: mock.spawn, executable: 'mock' });
  await assert.rejects(generator.generate(input(), { signal: controller.signal }), { code: 'AI_CANCELLED' });
  assert.equal(mock.calls[0].child.killed, true);
  assert.equal(fs.existsSync(mock.calls[0].options.cwd), false);
  await assert.rejects(generator.generate(input(), { signal: controller.signal }), { code: 'AI_CANCELLED' });
  assert.equal(mock.calls.length, 1);
});

test('timeout kills a hung process and cleans up its temporary directory', async () => {
  const mock = mockProcess(() => {});
  await assert.rejects(new CodexCandidateGenerator({ spawn: mock.spawn, executable: 'mock', timeoutMs: 25 }).generate(input()), { code: 'AI_TIMEOUT' });
  assert.equal(mock.calls[0].child.killed, true);
  assert.equal(fs.existsSync(mock.calls[0].options.cwd), false);
});

test('limits both process event output and final JSON file size', async () => {
  const noisy = mockProcess(call => call.child.stdout.write('x'.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(new CodexCandidateGenerator({ spawn: noisy.spawn, executable: 'mock' }).generate(input()), { code: 'AI_RESPONSE_TOO_LARGE' });
  assert.equal(noisy.calls[0].child.killed, true);
  const large = mockProcess(call => {
    fs.writeFileSync(call.args[call.args.indexOf('--output-last-message') + 1], 'x'.repeat(1024 * 1024 + 1));
    call.child.emit('close', 0);
  });
  await assert.rejects(new CodexCandidateGenerator({ spawn: large.spawn, executable: 'mock' }).generate(input()), { code: 'AI_RESPONSE_TOO_LARGE' });
});
