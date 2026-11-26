'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ClaudeCodeAnalyzer, AiRouter } = require('../src/ai.cjs');
const { Controller } = require('../src/controller.cjs');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
function streamLines(result) {
  return [
    { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [], skills: ['network-connect-usage'] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '', ...result }
  ].map(line => JSON.stringify(line)).join('\n') + '\n';
}
const HOST_ENV = { CLAUDECODE: '1', CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SESSION_ID: 'host', CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
  CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_PID: '42', CLAUDE_CODE_OAUTH_TOKEN: 'user-token', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://gateway.example', PATH: 'C:/bin' };
function mockClaude({ stdout, code = 0, env = { ...HOST_ENV, CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'aht-unused-claude-config') } } = {}) {
  const calls = [];
  const analyzer = new ClaudeCodeAnalyzer({ executable: 'mock-claude', env,
    spawn(executable, args, spawnOptions) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.kill = () => setImmediate(() => child.emit('close', null));
      const call = { executable, args, ...spawnOptions, cwdExisted: fs.existsSync(spawnOptions.cwd) }; calls.push(call);
      child.stdin.end = input => {
        call.input = input;
        setImmediate(() => { child.stdout.emit('data', Buffer.from(typeof stdout === 'function' ? stdout(call) : stdout)); child.emit('close', code); });
      };
      return child;
    }
  });
  return { analyzer, calls };
}
async function withFrames(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-claude-frames-'));
  try {
    const frames = [0, .2, .4].map((time, index) => {
      const file = path.join(directory, `f${index}.png`);
      fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from([index])]));
      return { id: `f${index}`, time, path: file };
    });
    return await callback(frames);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('Claude Code analysis sends inline images to a tool-less, isolated print session', () => withFrames(async frames => {
  const { analyzer, calls } = mockClaude({ stdout: streamLines({ structured_output: { status: 'hits', summary: '두 번째 프레임 주변 베기', windows: [{ startFrameId: 'f1', endFrameId: 'f2', reason: '검이 앞으로 지나감', uncertain: false }] } }) });
  const result = await analyzer.analyze({ clip: { name: 'Slash', length: .4 }, frames });
  assert.equal(result.status, 'hits');
  assert.deepEqual(result.windows.map(window => [window.start, window.end]), [[.2, .4]]);
  assert.equal(result.model, 'Claude Code default');
  const call = calls[0];
  assert.equal(call.executable, 'mock-claude');
  assert.equal(call.shell, false);
  assert.equal(call.cwdExisted, true);
  assert.equal(fs.existsSync(call.cwd), false, 'temporary working directory is removed');
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_PID'])
    assert.equal(call.env[key], undefined, `${key} from a host Claude Code session is not inherited`);
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL', 'PATH']) assert.equal(call.env[key], HOST_ENV[key], `${key} user configuration is kept`);
  for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(call.args.includes(flag), flag);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], '');
  assert.equal(call.args[call.args.indexOf('--input-format') + 1], 'stream-json');
  const schema = JSON.parse(call.args[call.args.indexOf('--json-schema') + 1]);
  assert.deepEqual(schema.properties.windows.items.properties.startFrameId.enum, ['f0', 'f1', 'f2']);
  assert.ok(!call.args.includes('--model'));
  const lines = call.input.trim().split('\n');
  assert.equal(lines.length, 1);
  const message = JSON.parse(lines[0]);
  assert.equal(message.type, 'user');
  const content = message.message.content;
  assert.match(content[0].text, /attack animation/);
  const images = content.filter(block => block.type === 'image');
  assert.equal(images.length, 3);
  assert.deepEqual(images.map(image => Buffer.from(image.source.data, 'base64').at(-1)), [0, 1, 2], 'images keep manifest order');
  assert.ok(images.every(image => image.source.media_type === 'image/png'));
  assert.deepEqual(content.filter(block => block.type === 'text').slice(1).map(block => block.text.split(' ')[1]), ['f0', 'f1', 'f2']);
}));

test('Claude Code uses the configured model and falls back to JSON result text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-claude-config-'));
  try {
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [] } }));
    const { analyzer, calls } = mockClaude({ env: { CLAUDE_CONFIG_DIR: root }, stdout: streamLines({ result: '```json\n{"matches":[{"index":0,"score":0.8,"reason":"찌르기 이름입니다."}]}\n```' }) });
    const result = await analyzer.rankAnimations({ query: '찌르기', clips: [{ name: 'Thrust', length: 1 }] });
    assert.deepEqual(result, { matches: [{ index: 0, score: .8, reason: '찌르기 이름입니다.' }], model: 'opus' });
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'opus');
    assert.equal(JSON.parse(calls[0].input).message.content.length, 1, 'search sends metadata only');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Claude Code errors map to the existing AI fault codes', () => withFrames(async frames => {
  const auth = mockClaude({ code: 1, stdout: streamLines({ is_error: true, result: 'Not logged in · Please run /login' }) }).analyzer;
  await assert.rejects(auth.analyze({ clip: { length: .4 }, frames }), { code: 'AI_AUTH_REQUIRED', message: /Claude Code 로그인/ });
  const limit = mockClaude({ code: 1, stdout: streamLines({ is_error: true, result: 'Claude AI usage limit reached' }) }).analyzer;
  await assert.rejects(limit.analyze({ clip: { length: .4 }, frames }), { code: 'AI_USAGE_LIMIT' });
  const retries = mockClaude({ code: 1, stdout: streamLines({ is_error: true, subtype: 'error_max_structured_output_retries' }) }).analyzer;
  await assert.rejects(retries.analyze({ clip: { length: .4 }, frames }), { code: 'AI_INVALID_OUTPUT' });
  const crash = mockClaude({ code: 1, stdout: 'error: unknown option\n' }).analyzer;
  await assert.rejects(crash.analyze({ clip: { length: .4 }, frames }), { code: 'AI_PROCESS_FAILED' });
  const invalid = mockClaude({ stdout: streamLines({ structured_output: { status: 'hits', summary: '', windows: [] } }) }).analyzer;
  await assert.rejects(invalid.analyze({ clip: { length: .4 }, frames }), { code: 'AI_INVALID_OUTPUT' });
}));

test('Claude Code status reads auth status JSON', async () => {
  const loggedIn = mockClaude({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }) });
  assert.equal((await loggedIn.analyzer.status()).authenticated, true);
  assert.deepEqual(loggedIn.calls[0].args, ['auth', 'status', '--json']);
  const loggedOut = mockClaude({ code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }) });
  const status = await loggedOut.analyzer.status();
  assert.deepEqual([status.available, status.authenticated, status.label], [true, false, 'Claude Code 로그인 필요']);
});

function fakeAnalyzer(name, status) {
  return { calls: [], async status() { return status; }, async analyze(input) { this.calls.push(input); return { name }; },
    async analyzeTiming() { return { name }; }, async rankAnimations() { return { matches: [], model: name }; } };
}
test('AI router prefers ready Codex in auto mode, falls back to Claude Code and honors explicit choice', async () => {
  const ready = label => ({ available: true, authenticated: true, label });
  const codex = fakeAnalyzer('codex', { available: false, authenticated: false, label: 'Codex 연결 필요' });
  const claude = fakeAnalyzer('claude', ready('Claude Code 연결됨'));
  const router = new AiRouter({ provider: 'unknown', analyzers: { codex, claude } });
  assert.equal(router.provider, 'auto');
  const status = await router.status();
  assert.equal(status.provider, 'claude');
  assert.equal(status.selection, 'auto');
  assert.deepEqual(Object.keys(status.providers), ['codex', 'claude']);
  assert.deepEqual(await router.analyze({}), { name: 'claude' });

  const both = new AiRouter({ analyzers: { codex: fakeAnalyzer('codex', ready('Codex 연결됨')), claude } });
  assert.deepEqual(await both.analyze({}), { name: 'codex' }, 'auto resolves lazily and prefers Codex');
  both.setProvider('claude');
  assert.deepEqual(await both.analyzeTiming({}), { name: 'claude' });
  assert.equal((await both.status()).provider, 'claude');
  assert.throws(() => both.setProvider('gpt'), /지원하지 않는 AI 엔진/);
});

test('controller persists the AI engine choice without dropping the last project', async () => {
  let preferences = { projectPath: 'C:/Game' };
  const store = { load: () => ({ jobs: [], settings: {} }), save() {}, preferences: () => ({ ...preferences }), savePreferences(value) { preferences = value; } };
  const router = new AiRouter({ analyzers: { codex: fakeAnalyzer('codex', { available: true, authenticated: false, label: 'Codex 로그인 필요' }), claude: fakeAnalyzer('claude', { available: true, authenticated: true, label: 'Claude Code 연결됨' }) } });
  const controller = new Controller({ store, ai: router });
  const state = await controller.setAiProvider('claude');
  assert.deepEqual(preferences, { projectPath: 'C:/Game', aiProvider: 'claude' });
  assert.deepEqual([state.ai.provider, state.ai.selection, state.ai.label], ['claude', 'claude', 'Claude Code 연결됨']);
  await assert.rejects(controller.setAiProvider('other'), /지원하지 않는 AI 엔진/);
  assert.equal(router.provider, 'claude');
});
