import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const blender = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';

test('native append-only reconstruction confines topology and hair displacement while preserving protected source data', { skip: !fs.existsSync(blender), timeout: 240_000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-contact-reconstruct-native-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('ps-contact-reconstruct-native-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.resolve('scripts/graphics-contact-reconstruct-check.py'), '--', root, path.resolve('integrations/blender')], { encoding: 'utf8', windowsHide: true, timeout: 230_000, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout.slice(-7000) + result.stderr.slice(-5000));
  const report = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  assert.equal(report.passed, true);
  assert(report.count >= 16);
  assert.equal(report.productionCalls, 0);
});
