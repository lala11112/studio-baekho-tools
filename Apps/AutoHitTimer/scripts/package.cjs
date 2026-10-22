'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { packager } = require('@electron/packager');
const manifest = require('../package.json');
const repository = path.resolve(__dirname, '../../..');
packager({ dir: path.resolve(__dirname, '..'), out: path.resolve(__dirname, '../dist', manifest.version), name: 'AutoHitTimer', executableName: 'AutoHitTimer',
  platform: 'win32', arch: 'x64', asar: true, overwrite: true, prune: false,
  ignore: [/^\/node_modules($|\/)/, /^\/dist($|\/)/, /^\/test-artifacts($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/],
  win32metadata: { CompanyName: 'Studio Baekho', FileDescription: 'AI attack timing authoring for Unity', ProductName: 'AutoHitTimer' }
}).then(destinations => {
  for (const destination of destinations) {
    const kit = path.join(destination, 'UnityIntegration');
    for (const folder of ['Packages/com.studiobaekho.auto-hit-timer', 'Integrations/FourTigerSword/AutoHitTimer', 'Installer'])
      fs.cpSync(path.join(repository, folder), path.join(kit, folder), { recursive: true, filter: source => !source.split(path.sep).some(part => part === 'Tests~' || part === 'Tests') });
    fs.mkdirSync(path.join(kit, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(repository, 'scripts/Install-AutoHitTimer.ps1'), path.join(kit, 'scripts/Install-AutoHitTimer.ps1'));
    fs.copyFileSync(path.join(repository, 'README.md'), path.join(kit, 'README.md'));
    fs.mkdirSync(path.join(kit, 'Apps/AutoHitTimer'), { recursive: true });
    fs.copyFileSync(path.join(repository, 'Apps/AutoHitTimer/VALIDATION.md'), path.join(kit, 'Apps/AutoHitTimer/VALIDATION.md'));
  }
  console.log(destinations.join('\n'));
}).catch(error => { console.error(error); process.exitCode = 1; });
