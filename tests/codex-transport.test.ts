import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { CodexTransport } from '../electron/services/codex-transport';
import type { RpcObject } from '../electron/services/codex-transport';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: RpcObject[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.sent.push(JSON.parse(chunk.toString()) as RpcObject);
      callback();
    },
  });
  killed = false;
  kill(): boolean { this.killed = true; this.emit('exit', 0); return true; }
  deliver(value: RpcObject): void { this.stdout.write(`${JSON.stringify(value)}\n`); }
}

function harness(t: TestContext, timeout = 1000) {
  const child = new FakeChild();
  const spawn = t.mock.method(childProcess, 'spawn', (() => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  const transport = new CodexTransport('C:/mock/codex.exe', 'C:/mock/workspace', timeout);
  t.after(() => { transport.close(); spawn.mock.restore(); syncBuiltinESMExports(); });
  return { child, transport, spawn };
}

test('transport starts a private hidden stdio server and forces ChatGPT authentication', t => {
  const credentialKeys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'];
  const original = credentialKeys.map(key => [key, process.env[key]] as const);
  for (const key of credentialKeys) process.env[key] = 'inherited-test-value-must-not-reach-child';
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { spawn } = harness(t);
  const [executable, args, options] = spawn.mock.calls[0].arguments as unknown as [string, string[], { windowsHide: boolean; cwd: string; env: NodeJS.ProcessEnv }];
  assert.equal(executable, 'C:/mock/codex.exe');
  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, 'C:/mock/workspace');
  assert.ok(args.includes('app-server'));
  assert.equal(args.includes('--stdio'), false, 'Use the documented default stdio transport without alpha-only aliases');
  assert.equal(args.includes('--listen'), false);
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes('model_provider="openai"'));
  for (const key of credentialKeys) assert.equal(options.env[key], undefined);
  for (const feature of ['plugins', 'apps', 'shell_tool', 'unified_exec', 'multi_agent', 'code_mode']) {
    const index = args.indexOf(feature);
    assert.ok(index > 0 && args[index - 1] === '--disable', `${feature} must be disabled`);
  }
  assert.ok(args.includes('web_search="disabled"'));
});

test('transport completes initialize before sending initialized notification', async t => {
  const { child, transport } = harness(t);
  const ready = transport.initialize();
  assert.equal(child.sent.length, 1);
  assert.equal(child.sent[0].method, 'initialize');
  child.deliver({ id: child.sent[0].id, result: { userAgent: 'mock' } });
  await ready;
  assert.deepEqual(child.sent[1], { method: 'initialized' });
});

test('transport handles fragmented UTF-8, multiple JSONL frames, and out-of-order replies', async t => {
  const { child, transport } = harness(t);
  const notifications: RpcObject[] = [];
  const unsubscribe = transport.onNotification((_method, params) => notifications.push(params));
  const first = transport.request('first', {});
  const second = transport.request('second', {});
  child.deliver({ id: child.sent[1].id, result: { second: true } });
  assert.deepEqual(await second, { second: true });
  const frame = Buffer.from(`${JSON.stringify({ id: child.sent[0].id, result: { text: '한글 응답' } })}\n${JSON.stringify({ method: 'turn/completed', params: { threadId: 'test' } })}\n`);
  const split = frame.indexOf(Buffer.from('한')) + 1;
  child.stdout.write(frame.subarray(0, split));
  child.stdout.write(frame.subarray(split, split + 1));
  child.stdout.write(frame.subarray(split + 1));
  assert.deepEqual(await first, { text: '한글 응답' });
  assert.deepEqual(notifications, [{ threadId: 'test' }]);
  unsubscribe();
  child.deliver({ method: 'turn/completed', params: { threadId: 'ignored' } });
  assert.equal(notifications.length, 1);
});

test('transport reports RPC failure without exposing server error content', async t => {
  const { child, transport } = harness(t);
  const pending = transport.request('account/read', {});
  child.deliver({ id: child.sent[0].id, error: { code: -1, message: 'sensitive-token-for-test' } });
  await assert.rejects(pending, error => error instanceof Error && !error.message.includes('sensitive-token-for-test'));
});

test('transport expires stalled requests and ignores their late replies', async t => {
  const { child, transport } = harness(t, 10);
  const timedOut = transport.request('first', {});
  const oldId = child.sent[0].id;
  await assert.rejects(timedOut, /시간이 초과/);
  const next = transport.request('second', {});
  child.deliver({ id: oldId, result: { stale: true } });
  child.deliver({ id: child.sent[1].id, result: { current: true } });
  assert.deepEqual(await next, { current: true });
});

test('transport rejects pending requests and notifies close once when its process exits', async t => {
  const { child, transport } = harness(t);
  let closes = 0;
  transport.onClose(() => { closes++; });
  const pending = transport.request('account/read', {});
  child.emit('exit', 1);
  child.emit('error', new Error('secret process detail'));
  await assert.rejects(pending, /연결이 종료/);
  await assert.rejects(transport.request('model/list', {}), /닫혀/);
  assert.equal(closes, 1);
});

test('transport rejects malformed JSONL and terminates the private process', async t => {
  const { child, transport } = harness(t);
  const pending = transport.request('account/read', {});
  child.stdout.write('{broken json}\n');
  await assert.rejects(pending, /응답을 읽을 수 없습니다/);
  assert.equal(child.killed, true);
});

test('transport stops a buffered frame batch when a notification closes the connection', t => {
  const { child, transport } = harness(t);
  transport.onNotification(() => transport.close());
  const frames = [
    { method: 'turn/completed', params: { threadId: 'job' } },
    { id: 'late-approval', method: 'item/commandExecution/requestApproval', params: {} },
  ].map(packet => JSON.stringify(packet)).join('\n') + '\n';
  assert.doesNotThrow(() => child.stdout.write(frames));
  assert.equal(child.killed, true);
  assert.equal(child.sent.length, 0);
});

test('transport bounds an unterminated response before JSON parsing', async t => {
  const { child, transport } = harness(t);
  const pending = transport.request('account/read', {});
  child.stdout.write(Buffer.alloc(48 * 1024 * 1024 + 1, 120));
  await assert.rejects(pending, /허용 크기를 초과/);
  assert.equal(child.killed, true);
});

test('transport denies server execution, writes, permission escalation, tools, and token sharing', t => {
  const { child } = harness(t);
  const requests = [
    'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
    'item/tool/call', 'item/tool/requestUserInput', 'account/chatgptAuthTokens/refresh',
  ];
  requests.forEach((method, index) => child.deliver({ id: `server-${index}`, method, params: {} }));
  assert.deepEqual(child.sent[0], { id: 'server-0', result: { decision: 'decline' } });
  assert.deepEqual(child.sent[1], { id: 'server-1', result: { decision: 'decline' } });
  assert.deepEqual(child.sent[2], { id: 'server-2', result: { permissions: {}, scope: 'turn' } });
  assert.deepEqual(child.sent[3], { id: 'server-3', result: { contentItems: [], success: false } });
  assert.deepEqual(child.sent[4], { id: 'server-4', result: { answers: {} } });
  assert.equal((child.sent[5].error as RpcObject).code, -32601);
});
