import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('native T02 T05 and N01 match registered sidecars by normalized name and reject missing or ambiguous maps', { timeout: 180000 }, t => {
  const blender = process.env.PARTSMITH_TEST_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
  if (!fs.existsSync(blender)) return t.skip('Blender unavailable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sidecar-name-'));
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.resolve('tests/graphics-sidecar-name-fixture.py'), '--', root], { windowsHide: true, encoding: 'utf8', timeout: 170000 });
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-8000));
  const report = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  assert.equal(report.passed, true); assert.equal(report.checks.length, 11);
  assert.equal(report.originalsExact, true); assert.equal(report.stagedInputsExact, true);
});
