'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createMediaResponse } = require('../src/media-response.cjs');

function fixture(t, size = 256 * 1024 + 7, extension = '.mp4') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'combat-lab-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, `video${extension}`);
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  fs.writeFileSync(filename, bytes);
  return { filename, bytes };
}

test('full response streams video bytes with exact length and MIME', async t => {
  const { filename, bytes } = fixture(t);
  const response = await createMediaResponse(filename);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('content-range'), null);
  const reader = response.body.getReader();
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    assert.ok(value.byteLength <= 64 * 1024, 'stream chunks remain bounded');
    chunks.push(Buffer.from(value));
  }
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test('bounded, open-ended and suffix byte ranges match actual file slices', async t => {
  const { filename, bytes } = fixture(t);
  const cases = [
    ['bytes=0-0', 0, 0], ['bytes=10-99', 10, 99], ['bytes=65530-65545', 65530, 65545],
    ['bytes=220000-', 220000, bytes.length - 1], ['bytes=-47', bytes.length - 47, bytes.length - 1],
    ['bytes=7-99999999999999999999999999999', 7, bytes.length - 1],
    ['bytes=-99999999999999999999999999999', 0, bytes.length - 1], ['BYTES=0002-0005', 2, 5]
  ];
  for (const [range, start, end] of cases) {
    const response = await createMediaResponse(filename, { headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1), range);
  }
});

test('invalid, multiple and unsatisfiable ranges return an empty 416', async t => {
  const { filename, bytes } = fixture(t, 100);
  for (const range of [
    '', 'bytes=', 'bytes=-', 'bytes=-0', 'bytes=5-4', 'bytes=100-', 'bytes=99999999999999999999999-',
    'bytes=0-1,3-4', 'items=0-1', 'bytes=1.5-9', 'bytes=0--1', 'bytes=word-9', `bytes=${'9'.repeat(600)}-`
  ]) {
    const response = await createMediaResponse(filename, { headers: { range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
    assert.equal(response.headers.get('content-length'), '0');
    assert.equal(response.body, null);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});

test('HEAD returns full metadata with no body, including when Range is present', async t => {
  const { filename, bytes } = fixture(t, 9876, '.webm');
  const response = await createMediaResponse(filename, { method: 'HEAD', headers: new Headers({ Range: 'bytes=0-9' }) });
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('content-type'), 'video/webm');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-range'), null);
});

test('empty files have a zero-length 200 and no satisfiable ranges', async t => {
  const { filename } = fixture(t, 0);
  const full = await createMediaResponse(filename);
  assert.equal(full.status, 200);
  assert.equal(full.body, null);
  assert.equal(full.headers.get('content-length'), '0');
  const partial = await createMediaResponse(filename, { headers: { range: 'bytes=0-' } });
  assert.equal(partial.status, 416);
  assert.equal(partial.headers.get('content-range'), 'bytes */0');
});

test('unsupported methods do not read or mutate media files', async t => {
  const { filename, bytes } = fixture(t, 1024);
  const response = await createMediaResponse(filename, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.deepEqual(fs.readFileSync(filename), bytes);
});

test('consumer cancellation releases the file stream', async t => {
  const { filename } = fixture(t, 2 * 1024 * 1024);
  const response = await createMediaResponse(filename, { headers: { range: 'bytes=0-' } });
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.length > 0);
  await reader.cancel();
  // Native stream close is asynchronous; a second independent request must still read normally.
  const next = await createMediaResponse(filename, { headers: { range: 'bytes=1-2' } });
  assert.deepEqual(Buffer.from(await next.arrayBuffer()), Buffer.from([1, 2]));
});
