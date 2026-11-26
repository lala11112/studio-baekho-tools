'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');

// The caller must authorize and canonicalize the local path with ProjectClient.resolveVideo.
// Explicit HTTP byte ranges are needed for Chromium seeking on the custom media scheme;
// forwarding Range to Electron's file: fetch does not reliably produce a seekable response.
async function createMediaResponse(filename, request = {}) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Length': '0' } });
  }
  const extension = path.extname(filename).toLowerCase();
  const type = extension === '.mp4' ? 'video/mp4' : extension === '.webm' ? 'video/webm' : extension === '.png' ? 'image/png' : null;
  if (!type) throw new Error('Unsupported video format.');
  let handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('Invalid video file.');
    const size = stat.size;
    const headers = {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(size),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    };
    // Range is defined for GET only; HEAD describes the full representation without reading it.
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    const range = new Headers(request.headers || {}).get('range');
    let start = 0, end = size - 1, status = 200;
    if (range !== null) {
      const selected = parseSingleRange(range, size);
      if (!selected) {
        return new Response(null, { status: 416, headers: {
          ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0'
        } });
      }
      ({ start, end } = selected);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = String(end - start + 1);
    }
    if (size === 0) return new Response(null, { status, headers });
    const stream = handle.createReadStream({ start, end, autoClose: true, highWaterMark: 64 * 1024 });
    const body = Readable.toWeb(stream, {
      // Count bytes rather than chunks so the Web Stream cannot prefetch thousands of chunks.
      strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength }
    });
    const response = new Response(body, { status, headers });
    // The stream owns the handle and closes it on EOF, error, or consumer cancellation.
    handle = null;
    return response;
  } finally {
    if (handle) await handle.close();
  }
}

function parseSingleRange(header, size) {
  if (header.length > 512 || size === 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return null;
    return { start: Number(suffix >= total ? 0n : total - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]);
  const requestedEnd = match[2] ? BigInt(match[2]) : total - 1n;
  if (start >= total || requestedEnd < start) return null;
  return { start: Number(start), end: Number(requestedEnd >= total ? total - 1n : requestedEnd) };
}

module.exports = { createMediaResponse };
