const path = require('node:path');
const fs = require('node:fs');
const { packager } = require('@electron/packager');
const manifest = require('../package.json');
const distributionRoot = path.resolve(__dirname, '../dist');
const outputRoot = path.resolve(distributionRoot, manifest.version);
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version) || path.dirname(outputRoot) !== distributionRoot) throw new Error('Invalid local package output version.');
// The app uses only Electron and Node built-ins. Keep pnpm's development symlinks
// out of the portable app; revisit bundling if runtime dependencies are added.
if (Object.keys(manifest.dependencies || {}).length) throw new Error('Configure runtime dependency bundling before packaging this app.');
packager({
  dir: path.resolve(__dirname, '..'), out: outputRoot,
  name: 'Baekho Studio', executableName: 'Baekho Studio', platform: 'win32', arch: 'x64',
  asar: true, overwrite: process.argv.includes('--replace'), prune: false,
  ignore: [/^\/node_modules($|\/)/, /^\/dist($|\/)/, /^\/test-artifacts($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/],
  win32metadata: { CompanyName: 'Studio Baekho', FileDescription: 'Baekho Studio — Combat Lab', ProductName: 'Baekho Studio' }
}).then(paths => {
  // Ship the Unity connection kit next to the app, so another PC/project does
  // not need this checkout or an absolute file: dependency into it.
  const repository = path.resolve(__dirname, '../..');
  for (const destination of paths) {
    const kit = path.join(destination, 'UnityIntegration');
    for (const folder of ['Packages', 'Integrations', 'scripts']) {
      fs.cpSync(path.join(repository, folder), path.join(kit, folder), {
        recursive: true, filter: source => !source.split(path.sep).includes('Tests~')
      });
    }
    fs.mkdirSync(path.join(kit, 'docs'), { recursive: true });
    for (const document of ['reusing-combat-lab.md', 'desktop-bridge.md', 'combat-lab-v2.md', 'combat-lab-v2-validation.md']) {
      fs.copyFileSync(path.join(repository, 'docs', document), path.join(kit, 'docs', document));
    }
    fs.writeFileSync(path.join(kit, 'README.md'), '# Unity 연결 설치\n\n이 폴더에서 PowerShell을 열고 실행하세요.\n\n```powershell\n./scripts/Install-CombatLab.ps1 -UnityProject "C:/path/to/MyGame" -Adapter Example\n```\n\nUnity 6000.3 이상이 필요합니다. 예제로 연결을 확인한 뒤 게임별 어댑터를 구현하세요. [설치·업데이트·게임 연결 가이드](docs/reusing-combat-lab.md)를 참고하세요.\n\n## Four-Tiger-Sword v2\n\n검증에 사용한 게임 체크아웃에는 v2 카메라·캐릭터 시계·실제 명중 연결이 통합돼 있습니다. 다른 체크아웃에서 FourTigerSword 어댑터를 사용하려면 해당 게임 런타임 변경도 먼저 통합해야 합니다. 이 배포 폴더는 공통 패키지와 Editor 어댑터를 제공하며 게임 전투 소스를 자동 이식하지 않습니다. 기존 커스텀 연결은 설치 전 변경 내용을 검토하세요.\n\n[실행부 검토용 패치와 해시](Integrations/FourTigerSword/RuntimeIntegration/README.md), [Combat Lab v2 사용법과 실행부 선행조건](docs/combat-lab-v2.md), [실제 검증 결과와 한계](docs/combat-lab-v2-validation.md)를 확인하세요.\n', 'utf8');
  }
  process.stdout.write(paths.join('\n') + '\n');
}).catch(error => { console.error(error); process.exitCode = 1; });
