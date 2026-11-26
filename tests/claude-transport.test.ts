import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeCodeTransport, parseClaudeResult, type ClaudeRunner } from '../electron/services/claude-transport';
import type { RpcObject } from '../electron/services/codex-transport';

const success = (structured: unknown) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: structured });

function waitTurn(transport: ClaudeCodeTransport, threadId: string): Promise<RpcObject> {
  return new Promise(resolve => { const stop = transport.onNotification((method, params) => { if (method === 'turn/completed' && params.threadId === threadId) { stop(); resolve(params.turn as RpcObject); } }); });
}

test('parseClaudeResult prefers structured output, falls back to fenced JSON and maps errors', () => {
  assert.deepEqual(parseClaudeResult(success({ ok: 1 })), { ok: 1 });
  assert.deepEqual(parseClaudeResult(JSON.stringify({ type: 'result', is_error: false, result: '```json\n{"ok":2}\n```' })), { ok: 2 });
  assert.throws(() => parseClaudeResult(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })), /로그인/);
  assert.throws(() => parseClaudeResult('garbage'), /읽을 수 없습니다/);
});

test('turns run tool-less schema-constrained print mode and resume the same session for repairs', async () => {
  const calls: { args: string[]; input: string; cwd: string }[] = [];
  const runner: ClaudeRunner = async (_exe, args, input, cwd) => { calls.push({ args, input, cwd }); return { stdout: success({ attempt: calls.length }), code: 0 }; };
  const transport = new ClaudeCodeTransport('claude.exe', 'C:/data', runner);
  const thread = (await transport.request('thread/start', { cwd: 'C:/stage', model: 'sonnet', baseInstructions: 'BASE', developerInstructions: 'DEV' })).thread as RpcObject;
  const threadId = String(thread.id);
  const schema = { type: 'object' };
  for (const expected of [1, 2]) {
    const done = waitTurn(transport, threadId);
    const turn = (await transport.request('turn/start', { threadId, input: [{ type: 'text', text: `prompt ${expected}` }], outputSchema: schema })).turn as RpcObject;
    const completed = await done;
    assert.equal(completed.id, turn.id);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(JSON.parse(String(((completed.items as RpcObject[])[0]).text)), { attempt: expected });
  }
  const [first, second] = calls;
  assert.equal(first.input, 'prompt 1');
  assert.equal(first.cwd, 'C:/stage');
  for (const flag of ['-p', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(first.args.includes(flag), flag);
  assert.equal(first.args[first.args.indexOf('--tools') + 1], '');
  assert.equal(first.args[first.args.indexOf('--json-schema') + 1], JSON.stringify(schema));
  assert.equal(first.args[first.args.indexOf('--system-prompt') + 1], 'BASE\n\nDEV');
  assert.equal(first.args[first.args.indexOf('--model') + 1], 'sonnet');
  const session = first.args[first.args.indexOf('--session-id') + 1];
  assert.match(session, /^[0-9a-f-]{36}$/);
  assert.equal(second.args[second.args.indexOf('--resume') + 1], session);
  assert.ok(!second.args.includes('--session-id'));
  transport.close();
});

test('interrupt aborts the running process and reports an interrupted turn', async () => {
  const runner: ClaudeRunner = (_exe, _args, _input, _cwd, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ stdout: '', code: null })));
  const transport = new ClaudeCodeTransport('claude.exe', 'C:/data', runner);
  const threadId = String(((await transport.request('thread/start', {})).thread as RpcObject).id);
  const done = waitTurn(transport, threadId);
  const turnId = ((await transport.request('turn/start', { threadId, input: [{ type: 'text', text: 'x' }] })).turn as RpcObject).id;
  await new Promise(resolve => setImmediate(resolve));
  await transport.request('turn/interrupt', { threadId, turnId });
  assert.equal((await done).status, 'interrupted');
  transport.close();
});

test('account status maps Claude Code auth state', async () => {
  for (const [loggedIn, expected] of [[true, 'claude'], [false, undefined]] as const) {
    const runner: ClaudeRunner = async (_exe, args) => { assert.deepEqual(args, ['auth', 'status', '--json']); return { stdout: JSON.stringify({ loggedIn, authMethod: 'claude.ai' }), code: loggedIn ? 0 : 1 }; };
    const transport = new ClaudeCodeTransport('claude.exe', 'C:/data', runner);
    const account = (await transport.request('account/read', {})).account as RpcObject | null;
    assert.equal(account?.type, expected);
  }
});

test('AiService switches to the Claude Code engine and persists the choice', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const { AiService } = await import('../electron/services/ai');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'enemy-ai-provider-'));
  const providers: string[] = [];
  const runner: ClaudeRunner = async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), code: 0 });
  const options = { dataDirectory: directory, getProjectRoot: () => directory, onProgress: () => {}, unity: async () => ({}),
    discover: async (provider: string) => { providers.push(provider); return { executable: 'claude.exe', version: '2.1.0' }; },
    connect: async () => new ClaudeCodeTransport('claude.exe', directory, runner) };
  const service = new AiService(options);
  try {
    const status = await service.setProvider('claude');
    assert.equal(status.state, 'ready');
    assert.equal(status.provider, 'claude');
    assert.ok(status.models?.some(model => model.id === 'opus'));
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'ai-provider.json'), 'utf8')), { provider: 'claude' });
    const restored = new AiService(options);
    assert.equal(await restored.currentProvider(), 'claude');
    restored.dispose();
    assert.deepEqual(providers, ['claude']);
  } finally { service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
