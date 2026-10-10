const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, atomicJson, readJson } = require('../src/store.cjs');
const { ProjectClient } = require('../src/project-client.cjs');

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-test-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.mkdirSync(path.join(folder, 'Assets')); fs.mkdirSync(path.join(folder, 'ProjectSettings'));
  fs.writeFileSync(path.join(folder, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.3.10f1');
  return folder;
}
test('interrupted analysis becomes an explicit recoverable cancelled draft', t => {
  const folder = fixture(t), store = new Store(path.join(folder, 'user'));
  store.save(folder, { jobs: [{ status: 'analyzing', frames: [{ id: 'f' }], windows: [{ start: .1, end: .2 }] }], settings: { actorId: 'actor' } });
  const loaded = store.load(folder);
  assert.equal(loaded.jobs[0].status, 'cancelled'); assert.equal(loaded.jobs[0].frames.length, 1); assert.equal(loaded.jobs[0].windows.length, 1);
  const filename = store.filename(folder); fs.writeFileSync(filename, '{');
  assert.match(store.load(folder).recoveryError, /복구 사본/); assert.equal(fs.readFileSync(filename, 'utf8'), '{');
  store.save(folder, { jobs: [], settings: {} });
  const backups = fs.readdirSync(path.dirname(filename)).filter(name => name.endsWith('.corrupt'));
  assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(path.dirname(filename), backups[0]), 'utf8'), '{');
});
test('bridge envelopes correlate ID and preserve the receipt', async t => {
  const folder = fixture(t), client = new ProjectClient(folder);
  const poll = setInterval(() => {
    const requests = path.join(client.bridgePath, 'requests');
    if (!fs.existsSync(requests)) return;
    for (const name of fs.readdirSync(requests).filter(name => name.endsWith('.json'))) {
      const request = readJson(path.join(requests, name));
      atomicJson(path.join(client.bridgePath, 'responses', name), { id: request.id, protocolVersion: 1, ok: true, resultJson: JSON.stringify({ accepted: request.command }) });
      fs.unlinkSync(path.join(requests, name));
    }
  }, 20);
  t.after(() => clearInterval(poll));
  assert.deepEqual(await client.command('status', {}, { timeoutMs: 1000 }), { accepted: 'status' });
  assert.equal(fs.readdirSync(path.join(client.bridgePath, 'responses')).length, 1);
});
test('unclaimed timeout is withdrawn without retry; requests are capped at 1MiB', async t => {
  const client = new ProjectClient(fixture(t));
  await assert.rejects(client.command('status', {}, { timeoutMs: 20 }), { code: 'TIMEOUT' });
  assert.deepEqual(fs.readdirSync(path.join(client.bridgePath, 'requests')), []);
  await assert.rejects(client.command('search', { query: 'a'.repeat(1024 * 1024) }), /크기 제한/);
});
test('heartbeat rejects a foreign or stale project', t => {
  const folder = fixture(t), client = new ProjectClient(folder);
  const file = path.join(client.bridgePath, 'status.json');
  const value = { protocolVersion: 1, projectPath: folder, timestampUtcMs: Date.now(), ready: true };
  atomicJson(file, value); assert.equal(client.heartbeat().ready, true);
  atomicJson(file, { ...value, timestampUtcMs: Date.now() - 60000 }); assert.equal(client.heartbeat().ready, false);
  atomicJson(file, { ...value, projectPath: path.dirname(folder) }); assert.equal(client.heartbeat().ready, false);
});
