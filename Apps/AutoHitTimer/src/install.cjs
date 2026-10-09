'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { projectRoot, contained } = require('./project-client.cjs');
const { atomicJson } = require('./store.cjs');

function copyTree(source, destination, project) {
  if (!contained(project, destination)) throw new Error('설치 경로가 프로젝트 밖입니다.');
  let current = destination;
  while (contained(project, current) && current !== project) {
    if (fs.existsSync(current) && !contained(project, fs.realpathSync(current))) throw new Error('프로젝트 밖으로 연결된 설치 경로입니다.');
    current = path.dirname(current);
  }
  fs.cpSync(source, destination, { recursive: true, filter: filename => !filename.split(path.sep).some(part => part === 'Tests~' || part === 'Tests') });
}
function installIntegration(projectPath, kitRoot) {
  const project = projectRoot(projectPath);
  const definitions = fs.readdirSync(path.join(project, 'Assets'), { recursive: true });
  if (!definitions.some(filename => path.basename(filename) === 'WeaponActionDataSO.cs'))
    throw new Error('사인검 WeaponActionDataSO 소스가 있는 프로젝트가 필요합니다. 다른 게임에는 전용 어댑터를 작성해야 합니다.');
  const packageSource = path.join(kitRoot, 'Packages', 'com.studiobaekho.auto-hit-timer');
  const adapterSource = path.join(kitRoot, 'Integrations', 'FourTigerSword', 'AutoHitTimer', 'Editor');
  const installerSource = path.join(kitRoot, 'Installer', 'Editor');
  for (const folder of [packageSource, adapterSource, installerSource]) if (!fs.existsSync(folder)) throw new Error('Unity 연결 키트가 없습니다: ' + folder);
  const staging = path.join(project, 'AutoHitTimerIntegration');
  copyTree(packageSource, path.join(staging, 'Package'), project);
  copyTree(adapterSource, path.join(staging, 'Adapter'), project);
  copyTree(installerSource, path.join(project, 'Assets', 'StudioBaekho', 'AutoHitTimerBootstrap', 'Editor'), project);
  const library = path.join(project, 'Library');
  if (fs.existsSync(library) && !contained(project, fs.realpathSync(library))) throw new Error('프로젝트 밖으로 연결된 Library는 사용할 수 없습니다.');
  atomicJson(path.join(library, 'AutoHitTimerInstall.json'), { schemaVersion: 1, requestedUtc: new Date().toISOString(), adapter: 'four-tiger-sword' });
  return { message: '연결 모듈 설치 요청을 준비했습니다. Unity에서 파일을 새로고침하면 Package Manager가 설치하며, 컴파일 후 다시 연결하세요.' };
}
module.exports = { installIntegration };
if (require.main === module) {
  try { console.log(installIntegration(process.argv[2], process.argv[3] || path.resolve(__dirname, '../../..')).message); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
