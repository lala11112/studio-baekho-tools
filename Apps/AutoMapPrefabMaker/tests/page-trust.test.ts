import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageTrustChecker } from '../electron/services/page-trust';

const WINDOWS_PAGE = String.raw`C:\Users\YOONYO~1\AppData\Local\Temp\Baekho Map Forge\resources\app.asar\dist\index.html`;
const WINDOWS_URL = 'file:///C:/Users/YOONYO~1/AppData/Local/Temp/Baekho%20Map%20Forge/resources/app.asar/dist/index.html';

test('portable IPC trusts the same Windows file when Chromium leaves a short-path tilde unescaped', () => {
  const trusted = createPageTrustChecker(WINDOWS_PAGE, null, 'win32');
  assert.equal(trusted(WINDOWS_URL), true);
  assert.equal(trusted(WINDOWS_URL.replace('YOONYO~1', 'YOONYO%7E1')), true);
  assert.equal(trusted(WINDOWS_URL.replace('YOONYO~1', 'YOONYO%7e1')), true);
  assert.equal(trusted(`${WINDOWS_URL}?view=map#editor`), true);
});

test('Windows file trust handles spaces, Korean names, literal percent and hash characters', () => {
  const trusted = createPageTrustChecker(String.raw`C:\프로젝트 폴더\100% 완료\맵#1\index.html`, null, 'win32');
  const url = 'file:///C:/프로젝트%20폴더/100%25%20완료/맵%231/index.html';
  assert.equal(trusted(url), true);
  assert.equal(trusted(new URL(url).href), true);
  assert.equal(trusted(url.replace('%25', '%2525')), false, 'Percent escapes must be decoded exactly once');
  assert.equal(trusted(url.replace('%23', '%2523')), false, 'An encoded percent sign is not a hash character');
  assert.equal(trusted(url.replace('%25', '%')), false, 'Malformed percent escapes must fail closed');
});

test('Windows file trust compares drive and path casing after path normalization', () => {
  const trusted = createPageTrustChecker(WINDOWS_PAGE, null, 'win32');
  assert.equal(trusted(WINDOWS_URL.toLowerCase()), true);
  assert.equal(trusted(WINDOWS_URL.toUpperCase()), true);
  assert.equal(trusted(WINDOWS_URL.replace('/dist/index.html', '/dist/./index.html')), true);
  assert.equal(trusted(WINDOWS_URL.replace('/dist/index.html', '/other/../dist/index.html')), true);
});

test('production trust rejects different files, escaped traversal and encoded path separators', () => {
  const trusted = createPageTrustChecker(WINDOWS_PAGE, null, 'win32');
  for (const url of [
    WINDOWS_URL.replace('/C:/', '/D:/'),
    WINDOWS_URL.replace('/dist/index.html', '/other/index.html'),
    WINDOWS_URL.replace('/dist/index.html', '/dist/%2e%2e/other/index.html'),
    WINDOWS_URL.replace('/dist/index.html', '/dist/%2E%2E/%2E%2E/index.html'),
    WINDOWS_URL.replace('/dist/index.html', '/dist%2Findex.html'),
    WINDOWS_URL.replace('/dist/index.html', '/dist%5Cindex.html'),
    WINDOWS_URL.replace('/dist/index.html', '/dist/index%2Ehtml.evil'),
    `${WINDOWS_URL}/`,
    `${WINDOWS_URL}%00`,
  ]) assert.equal(trusted(url), false, url);
});

test('production trust rejects remote file hosts, credentials, web URLs and malformed URLs', () => {
  const trusted = createPageTrustChecker(WINDOWS_PAGE, null, 'win32');
  for (const url of [
    WINDOWS_URL.replace('file:///', 'file://remote.example/'),
    WINDOWS_URL.replace('file:///', 'file://user:password@remote.example/'),
    WINDOWS_URL.replace('file:///', 'https://localhost/'),
    'http://localhost:5173/',
    'https://example.test/index.html',
    'data:text/html,<h1>Map</h1>',
    'javascript:alert(1)',
    'about:blank',
    'not a URL',
    '',
  ]) assert.equal(trusted(url), false, url);
});

test('Posix production paths retain case sensitivity and share safe URL decoding', () => {
  const trusted = createPageTrustChecker('/tmp/Map Forge/맵%1/app.asar/dist/index.html', null, 'linux');
  const url = 'file:///tmp/Map%20Forge/맵%251/app.asar/dist/index.html';
  assert.equal(trusted(url), true);
  assert.equal(trusted(`${url}#editor`), true);
  assert.equal(trusted(url.replace('/Map%20Forge/', '/map%20forge/')), false);
  assert.equal(trusted(url.replace('/dist/index.html', '/dist%2findex.html')), false);
  assert.equal(trusted(url.replace('file:///', 'file://remote.example/')), false);
});

test('development trust permits only the configured origin and the two app entry paths', () => {
  const trusted = createPageTrustChecker(WINDOWS_PAGE, 'http://localhost:5173/', 'win32');
  for (const url of [
    'http://localhost:5173/',
    'http://localhost:5173/index.html',
    'http://localhost:5173/index.html?view=map#editor',
  ]) assert.equal(trusted(url), true, url);
  for (const url of [
    WINDOWS_URL,
    'https://localhost:5173/',
    'http://localhost:5174/',
    'http://localhost/',
    'http://127.0.0.1:5173/',
    'http://localhost.evil.test:5173/',
    'http://localhost:5173/other.html',
    'http://localhost:5173/index.html/child',
    'http://localhost:5173/%2e%2e/other.html',
    'http://localhost:5173/%69ndex.html',
    'http://user:password@localhost:5173/',
  ]) assert.equal(trusted(url), false, url);
});

test('development origin can explicitly use loopback IP without trusting other host spellings', () => {
  const trusted = createPageTrustChecker('/app/dist/index.html', 'http://127.0.0.1:5173/index.html', 'linux');
  assert.equal(trusted('http://127.0.0.1:5173/'), true);
  assert.equal(trusted('http://127.0.0.1:5173/index.html'), true);
  assert.equal(trusted('http://localhost:5173/'), false);
  assert.equal(trusted('http://[::1]:5173/'), false);
});
