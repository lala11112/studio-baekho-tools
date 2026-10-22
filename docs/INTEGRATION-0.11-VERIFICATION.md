# 백호툴 0.11.0 통합 검증

검증일: 2026-10-14~15 UTC (학교 PC DESKTOP-06의 현지 날짜 2026-10-15).
대상: `integration/baekho-bgm`, 기준 `c576c64d26a1c89dd9414107a90f52fe9e8ebc89`.

## 원격 비교와 통합 범위

새 clone에서 모든 원격 브랜치를 fetch하고 커밋 조상 관계, diff와 파일 내용을 비교했다. 마지막 fetch에서도 아래 head는 변하지 않았다. 기존 타격감·타격 타이밍의 기본 기능은 이미 통합돼 있었으며, 이번에는 각 브랜치의 추가 수정만 병합했다.

| 원격 브랜치 | 확인한 head | 이번 추가 내용 | 방식 |
| --- | --- | --- | --- |
| Auto-3D-Tool | `d37f0cb40d199b7377368bdcd052ca27a7cc8aab` | 활성 UV 내보내기, 보정된 빈 면의 로컬 표면 복구 | merge `2b6b4db` |
| feature/AutoFeelTuner | `68a5e15f7d79bf8a83a33aa652d73dbc928b424f` | 콤보 전체 실행 시 첫 타만 반복되는 문제 수정 | merge `1348254` |
| feature/AutoHitTimer | `8fbad2d933a8dde914ebfe19d99d183b45c9040c` | 자연어 애니메이션 검색, 취소·상태 처리 | merge `fa9aa6f` 및 통합 호스트 보완 |
| feature/AutoMapPrefabMaker | `5843861492ab6d8d5f2f152301aa4eddf198c621` | 지도 제작기 0.5.1 전체 | 원격 트리를 `Apps/AutoMapPrefabMaker`에 가져와 독립 창 연결 |

`main`, `AutoEnemyPrefabMaker`, `docs/baekho-tool-guidelines`, `integration/baekho-studio`, 사인검 아이템 `16775d5`, BGM `fa53929`는 기준 통합본에 이미 포함돼 있어 다시 덮어쓰지 않았다. 확인한 새 기능 후보 중 보류한 기능은 없다. 지도 브랜치는 루트 구조가 다른 독립 앱이므로 Git 조상 관계를 허위로 병합하지 않고 원본 경로를 하위 폴더에 보존했다.

## 통합 시 보존한 동작

- 기존 3D·사인검 아이템·BGM·타격감·타격 타이밍 메뉴를 유지하고 지도 메뉴를 추가했다.
- 지도는 별도 창, `map-forge:` IPC, 별도 세션과 `<통합 프로필>/map-forge` 데이터 경로를 사용한다. Node 접근은 꺼져 있고 IPC는 해당 창의 신뢰한 메인 프레임에서만 허용한다.
- 지도 창을 다시 열면 기존 창과 미저장 초안을 유지한다. 지도 창이 열려 있으면 통합 앱을 먼저 닫지 않으며, 지도 자체의 저장 여부 확인을 거친다.
- 지도 저장·열기·복구·프리팹 검색·ZIP 내보내기와 독립 앱 실행 경로를 보존했다. 패키지에 Unity importer의 다섯 C# 파일을 포함했다.
- 자연어 검색 중에도 호스트가 작업 중임을 표시하고 검색 취소와 종료 정리를 지원한다. 새 상태 초기화 함수를 기존 렌더러 테스트 픽스처에도 반영했다.
- 새 checkout의 `npm run dev`에서 지도 빌드가 없으면 실패하던 연결 문제를 코드 리뷰에서 발견해 `scripts/build-map.mjs`를 개발·배포 빌드가 함께 실행하도록 수정했다.
- 3D 복구 UI 검사에서 React 상태 변경 직후 이전 DOM을 읽는 경합을 발견했다. 취소/실패 화면 갱신을 기다린 뒤 같은 검증을 수행하도록 테스트만 수정했다.
- package 버전 충돌은 통합 앱 버전을 유지하고 최종 0.11.0으로 갱신했다. AutoHitTimer README는 `docs/auto-hit-timer.md`에 보존했다. 기능을 삭제해 해결한 충돌은 없다.

## 실제 실행한 검증

| 검증 | 결과 |
| --- | --- |
| 기준 c576c64 전체 루트 테스트 | 897 통과, 38 조건부 제외, 실패 0 |
| 최종 통합 전체 루트 테스트 | **911 통과, 42 조건부 제외, 실패 0** (전체 953) |
| 지도 제작기 테스트 | **231/231 통과** |
| 타격감 테스트 | **118/118 통과** |
| 타격 타이밍 지원 환경 테스트 | **65/65 통과**, 아래 Windows 권한 제한 검사 1개 제외 |
| 통합 Electron 화면 | **15개 검사 통과**, renderer 오류 0 |
| 사인검 아이템 Electron 화면 | **8개 검사 통과**, 수정 저장·메뉴 이동 유지·JSON/PNG 초안/검토 완료 내보내기 포함 |
| BGM 오류 상태 | 키 없음·손상 원장 2개 사례 통과, 유료 호출 0 |
| 추가 통합 Electron 화면 | **6개 검사 통과**: 여섯 메뉴, 지도 창 재사용/격리, 저장/열기/복구/ZIP, 닫기 취소, BGM 모의 내보내기, 자연어 검색 메뉴 |
| Windows 패키지 | electron-builder 폴더 패키지 성공, 패키지 실행 파일에서도 같은 **6개 검사 통과** |
| 최종 빌드 | 지도·루트 TypeScript 및 Vite/Electron 빌드 성공 |
| 새 개발 실행 | 지도 `dist`·`dist-electron`을 별도 테스트 백업으로 이동한 뒤 `scripts/dev.mjs`가 두 출력을 다시 만들고 실제 Electron 창을 여는 것 확인 |
| 별도 코드 리뷰 | 개발 실행 수정 후 남은 중요 발견 사항 없음, `git diff --check` 통과 |

주요 재실행 명령:

```powershell
npm ci
npm run build
node --import tsx --test --test-force-exit --test-concurrency=4 --test-timeout=60000 tests/*.test.ts
npm run test:map
npm run test:combat
node --test --test-skip-pattern='frame grants remain' Apps/AutoHitTimer/tests/*.test.cjs
npm run test:integration
node scripts/four-tiger-items-smoke.mjs
node scripts/bgm-shell-smoke.mjs
node --import tsx scripts/studio-updates-smoke.mjs
node node_modules/electron-builder/cli.js --win dir
node --import tsx scripts/studio-updates-smoke.mjs --packaged 'release/win-unpacked/Baekho Tools.exe'
```

`--test-force-exit`는 기존 테스트의 열린 핸들 때문에 사용했다. 테스트 실패를 무시하는 옵션은 아니다. 자동화 스모크는 격리된 데이터와 테스트 대화상자를 사용한다. 현재 작업의 원시 로그는 작업 폴더 상위 `*-final.log`, `packaged-smoke.log` 등에, 모의 데이터/결과는 ignored `artifacts/integration-runtime`에 보존했다. 기존 추적 스크린샷은 이번 테스트 결과로 교체하지 않았다.

## 검증 한계

- AutoHitTimer 전체 실행은 기준 버전에서도 동일한 파일 심볼릭 링크 생성 `EPERM` 검사 1개가 실패했다. Windows 개발자 모드나 시스템 권한을 바꾸지 않았다. 최종 지원 환경 실행에서 해당 검사 이름만 제외했고, 소스 테스트를 삭제하거나 skip 처리하지 않았다.
- 루트의 42개 제외는 Blender 실행 파일/실제 제작 자료 및 선택적 장시간 검사 등 기존 환경 조건에 따른다. 새 3D 기능의 모의 서비스·파일 보존·UI 검증은 통과했지만 이 PC에서 네이티브 Blender 결과를 새로 생성하지 않았다.
- Unity Editor에서 실제 게임 씬·C# 컴파일·플레이 검증은 하지 않았다. 지도 내보내기는 가짜 `.prefab/.meta` 자료로 검색·바인딩·ZIP 내용까지 검증했다.
- BGM은 합성 MP3 바이트를 기존 후보로 넣어 선택/내보내기와 원장을 검증했다. 음악 생성이나 재생 품질 검증이 아니다. 아이템의 검토/채택은 격리된 픽스처에만 적용했다.
- fal·Tripo·AI 실제 생성은 호출하지 않았다. 비밀키를 출력하거나 소스에 넣지 않았다. 기존 사용자 프로필·다른 프로젝트·바탕화면 설치본은 변경하지 않았다.
- 패키지는 코드 서명 없는 폴더 빌드다. `release/win-unpacked` 전체가 필요하며 자동 설치·기존 설치본 교체는 수행하지 않았다.

## 개발 기록

저장소 AGENTS.md가 지정한 Notion 페이지를 읽으려 했으나 현재 연결에서 404/object_not_found가 반환됐다. Notion에는 게시하지 못했다. 이 문서를 미게시 개발 기록으로 보존하며, 접근 가능한 연결에서 기존 페이지에 날짜·최종 커밋 링크와 함께 추가하면 된다.
