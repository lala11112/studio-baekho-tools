import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { discoverCodex, inspectRuntime } from '../electron/services/codex-runtime';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baekho-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen: string[] = [];
  const options = { env: {} as NodeJS.ProcessEnv, platform: 'win32' as const, arch: 'x64', inspect: async (candidate: string) => {
    seen.push(candidate); return { executable: candidate, version: 'test' };
  } };
  const file = async (...parts: string[]) => {
    const target = path.join(root, ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'fixture - never executed');
    return target;
  };
  return { root, options, seen, file };
}

test('a valid manual native selection takes priority over automatic installs', async t => {
  const f = await fixture(t);
  const chosen = await f.file('manual', 'codex.exe');
  await f.file('path', 'codex.exe');
  f.options.env.PATH = path.join(f.root, 'path');
  assert.equal((await discoverCodex(chosen, f.options))?.executable, chosen);
  assert.deepEqual(f.seen, [chosen]);
});

test('removed manual selection recovers through current PATH', async t => {
  const f = await fixture(t);
  const native = await f.file('current', 'codex.exe');
  f.options.env.Path = `"${path.dirname(native)}"`;
  assert.equal((await discoverCodex(path.join(f.root, 'removed', 'codex.exe'), f.options))?.executable, native);
});

test('existing but invalid manual executable is not silently replaced', async t => {
  const f = await fixture(t);
  const selected = await f.file('invalid.exe');
  await f.file('path', 'codex.exe');
  f.options.env.PATH = path.join(f.root, 'path');
  const seen: string[] = [];
  assert.equal(await discoverCodex(selected, { ...f.options, inspect: async candidate => { seen.push(candidate); return null; } }), null);
  assert.deepEqual(seen, [selected]);
});

test('desktop installation is discovered from this PC LocalAppData without PATH', async t => {
  const f = await fixture(t);
  f.options.env.LOCALAPPDATA = path.join(f.root, 'Local');
  const old = await f.file('Local', 'OpenAI', 'Codex', 'bin', 'old-hash', 'codex.exe');
  const current = await f.file('Local', 'OpenAI', 'Codex', 'bin', 'new-hash', 'codex.exe');
  await utimes(old, 1, 1);
  await utimes(current, 2, 2);
  assert.equal((await discoverCodex(undefined, f.options))?.executable, current);
});

test('automatic discovery prefers the current desktop install over an older PATH CLI and falls back if inspection fails', async t => {
  const f = await fixture(t);
  f.options.env.LOCALAPPDATA = path.join(f.root, 'Local');
  const desktop = await f.file('Local', 'OpenAI', 'Codex', 'bin', 'current-hash', 'codex.exe');
  const pathCli = await f.file('old-cli', 'codex.exe');
  f.options.env.PATH = path.dirname(pathCli);
  assert.equal((await discoverCodex(undefined, f.options))?.executable, desktop);
  assert.deepEqual(f.seen, [desktop]);
  const fallbackSeen: string[] = [];
  const fallback = await discoverCodex(undefined, { ...f.options, inspect: async candidate => {
    fallbackSeen.push(candidate);
    return candidate === desktop ? null : { executable: candidate, version: 'test' };
  } });
  assert.equal(fallback?.executable, pathCli);
  assert.deepEqual(fallbackSeen, [desktop, pathCli]);
});

test('npm cmd wrapper locates official optional native package without executing the wrapper', async t => {
  const f = await fixture(t);
  const shim = await f.file('npm', 'codex.cmd');
  const native = await f.file('npm', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  f.options.env.PATH = path.dirname(shim);
  assert.equal((await discoverCodex(undefined, f.options))?.executable, native);
  assert.deepEqual(f.seen, [native]);
});

test('npm PowerShell wrapper supports legacy vendor layout and AppData fallback', async t => {
  const f = await fixture(t);
  f.options.env.APPDATA = path.join(f.root, 'Roaming');
  await f.file('Roaming', 'npm', 'codex.ps1');
  const native = await f.file('Roaming', 'npm', 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe');
  assert.equal((await discoverCodex(undefined, f.options))?.executable, native);
  assert.deepEqual(f.seen, [native]);
});

test('npm nested optional arm64 package is discovered using the current architecture', async t => {
  const f = await fixture(t);
  await f.file('npm', 'codex.cmd');
  const native = await f.file('npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe');
  f.options.env.PATH = path.join(f.root, 'npm');
  assert.equal((await discoverCodex(undefined, { ...f.options, arch: 'arm64' }))?.executable, native);
});

test('wrapper-only installation returns missing and never inspects script contents', async t => {
  const f = await fixture(t);
  const shim = await f.file('npm', 'codex.cmd');
  f.options.env.PATH = path.dirname(shim);
  assert.equal(await discoverCodex(undefined, f.options), null);
  assert.deepEqual(f.seen, []);
  if (process.platform === 'win32') assert.equal(await inspectRuntime(shim), null);
});
