'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installIntegration } = require('../src/install.cjs');

// An independent inventory makes an omitted obsolete module a regression.
const retiredPackage = [
  'Editor/AutoHitTimerEffectScene.cs', 'Editor/AutoHitTimerEffectScene.cs.meta',
  'Editor/AutoHitTimerEffects.cs', 'Editor/AutoHitTimerEffects.cs.meta',
  'Editor/AutoHitTimerPreviewRendering.cs', 'Editor/AutoHitTimerPreviewRendering.cs.meta',
  'Editor/AutoHitTimerViewport.cs', 'Editor/AutoHitTimerViewport.cs.meta',
  'Editor/AutoHitTimerViewportPipe.cs', 'Editor/AutoHitTimerViewportPipe.cs.meta',
  'Editor/URP.meta',
  'Editor/URP/AutoHitTimerUrpPreviewRendering.cs', 'Editor/URP/AutoHitTimerUrpPreviewRendering.cs.meta',
  'Editor/URP/StudioBaekho.AutoHitTimer.Editor.URP.asmdef',
  'Editor/URP/StudioBaekho.AutoHitTimer.Editor.URP.asmdef.meta',
  'Tests/Editor/AutoHitTimerEffectTests.cs', 'Tests/Editor/AutoHitTimerEffectTests.cs.meta'
];
const retiredAdapter = ['FourTigerSlashMapping.cs', 'FourTigerSlashMapping.cs.meta'];
const currentAdapter = '// timing-only adapter';

function write(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aht-install-cleanup-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('aht-install-cleanup-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const project = path.join(directory, 'project'), kit = path.join(directory, 'kit');
  const stagingPackage = path.join(project, 'AutoHitTimerIntegration', 'Package');
  const stagingAdapter = path.join(project, 'AutoHitTimerIntegration', 'Adapter');
  const liveAdapter = path.join(project, 'Assets', 'StudioBaekho', 'AutoHitTimer', 'Editor');
  const request = path.join(project, 'Library', 'AutoHitTimerInstall.json');
  write(path.join(project, 'Assets', 'Game', 'WeaponActionDataSO.cs'), '// game source');
  write(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.10f1');
  write(path.join(kit, 'Packages', 'com.studiobaekho.auto-hit-timer', 'Editor', 'AutoHitTimerBridge.cs'), '// timing-only bridge');
  write(path.join(kit, 'Packages', 'com.studiobaekho.auto-hit-timer', 'Tests', 'Editor', 'KeptOutOfInstall.cs'), '// test');
  write(path.join(kit, 'Integrations', 'FourTigerSword', 'AutoHitTimer', 'Editor', 'FourTigerAdapter.cs'), currentAdapter);
  write(path.join(kit, 'Installer', 'Editor', 'AutoHitTimerBootstrap.cs'), '// bootstrap');
  return { directory, project, kit, stagingPackage, stagingAdapter, liveAdapter, request };
}

function seedObsolete(f) {
  for (const name of retiredPackage) write(path.join(f.stagingPackage, name), '// retired module');
  for (const base of [f.stagingAdapter, f.liveAdapter]) {
    for (const name of retiredAdapter) write(path.join(base, name), '// retired adapter');
    write(path.join(base, 'FourTigerAdapter.cs'), '// stale adapter using IAutoHitTimerEffectAdapter');
  }
}

function assertClean(f) {
  for (const name of retiredPackage) assert.equal(fs.existsSync(path.join(f.stagingPackage, name)), false, name);
  for (const base of [f.stagingAdapter, f.liveAdapter]) {
    for (const name of retiredAdapter) assert.equal(fs.existsSync(path.join(base, name)), false, path.join(base, name));
    assert.equal(fs.readFileSync(path.join(base, 'FourTigerAdapter.cs'), 'utf8'), currentAdapter);
  }
}

test('rollback installation removes every retired module and preserves unrelated files on repeat', t => {
  const f = fixture(t);
  seedObsolete(f);
  const unrelated = [
    path.join(f.stagingPackage, 'Editor', 'UserTool.cs'),
    path.join(f.stagingPackage, 'Editor', 'URP', 'UserRenderer.cs'),
    path.join(f.stagingPackage, 'Tests', 'Editor', 'UserTest.cs'),
    path.join(f.stagingAdapter, 'UserAdapter.cs'),
    path.join(f.liveAdapter, 'UserAdapter.cs'),
    path.join(f.project, 'Assets', 'Game', 'UserData.asset')
  ];
  for (const filename of unrelated) write(filename, 'user-owned contents');
  for (let iteration = 0; iteration < 2; iteration++) {
    assert.match(installIntegration(f.project, f.kit).message, /설치 요청/);
    assertClean(f);
    for (const filename of unrelated) assert.equal(fs.readFileSync(filename, 'utf8'), 'user-owned contents');
    assert.equal(fs.existsSync(path.join(f.stagingPackage, 'Tests', 'Editor', 'KeptOutOfInstall.cs')), false);
    assert.equal(JSON.parse(fs.readFileSync(f.request, 'utf8')).adapter, 'four-tiger-sword');
  }
});

test('bootstrap request is published only after the live adapter replacement and obsolete cleanup', t => {
  const f = fixture(t);
  seedObsolete(f);
  const originalRename = fs.renameSync;
  let observedRequest = false;
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (path.resolve(to) === f.request) {
      observedRequest = true;
      assertClean(f);
      assert.equal(fs.existsSync(f.request), false);
      assert.equal(fs.readFileSync(path.join(f.project, 'Assets', 'StudioBaekho', 'AutoHitTimerBootstrap', 'Editor', 'AutoHitTimerBootstrap.cs'), 'utf8'), '// bootstrap');
    }
    return originalRename.call(this, from, to);
  });
  installIntegration(f.project, f.kit);
  assert.equal(observedRequest, true);
});

function linkOrSkip(t, target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip('This environment cannot create the required symbolic link: ' + error.code);
    return false;
  }
}

test('rollback refuses a retired-file symlink and preserves its outside target', t => {
  const f = fixture(t);
  const outside = path.join(f.directory, 'outside-project', 'effect.cs');
  const retired = path.join(f.stagingPackage, retiredPackage[0]);
  write(outside, 'outside contents');
  fs.mkdirSync(path.dirname(retired), { recursive: true });
  if (!linkOrSkip(t, outside, retired, 'file')) return;
  assert.throws(() => installIntegration(f.project, f.kit), /연결된 경로/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside contents');
  assert.equal(fs.lstatSync(retired).isSymbolicLink(), true);
  assert.equal(fs.existsSync(f.request), false);
});

test('rollback refuses a live-adapter junction outside the project without replacing outside files', t => {
  const f = fixture(t);
  const outside = path.join(f.directory, 'outside-project', 'adapter');
  write(path.join(outside, 'FourTigerSlashMapping.cs'), 'outside slash mapping');
  write(path.join(outside, 'FourTigerAdapter.cs'), 'outside adapter');
  fs.mkdirSync(path.dirname(f.liveAdapter), { recursive: true });
  if (!linkOrSkip(t, outside, f.liveAdapter, process.platform === 'win32' ? 'junction' : 'dir')) return;
  assert.throws(() => installIntegration(f.project, f.kit), /프로젝트 밖으로 연결된 설치 경로/);
  assert.equal(fs.readFileSync(path.join(outside, 'FourTigerSlashMapping.cs'), 'utf8'), 'outside slash mapping');
  assert.equal(fs.readFileSync(path.join(outside, 'FourTigerAdapter.cs'), 'utf8'), 'outside adapter');
  assert.equal(fs.lstatSync(f.liveAdapter).isSymbolicLink(), true);
  assert.equal(fs.existsSync(f.request), false);
});
