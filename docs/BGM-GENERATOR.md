# BGM 생성기

`codex/bgm-generator`는 BGM 기능을 보관하는 독립 브랜치입니다. 실제 통합 앱은 `integration/baekho-bgm`에 있으며 최신 Auto-3D-Tool(57a6aee), 기존 Combat Lab·AutoHitTimer 및 BGM을 한 창에서 엽니다. 원본 기능 브랜치와 main은 변경하지 않습니다.

제공된 통합본은 **백호툴 - 3D·BGM 통합** 바탕화면 바로가기 또는 `Launch-Baekho.vbs`로 실행합니다. 전용 `Data` 폴더를 사용하고 기존 앱·데이터와 분리합니다. `App` 안 실행 파일을 직접 열면 기존 공용 데이터 경로를 사용하므로 제공된 실행기를 사용하세요. 기존 데이터 사본은 `OriginalDataSnapshot`에 보관합니다.

## 사용

1. 백호툴 홈 또는 도구에서 **BGM 만들기**를 엽니다.
2. 장르·감정 토글을 고르고 장면, 악기, 빠르기 등을 자연어로 적습니다. 여러 토글을 함께 선택할 수 있습니다.
3. 표시된 예상 비용을 확인하고 생성 버튼을 누르면 **약 30초 후보 3곡**을 요청합니다.
4. 후보별 오디오 플레이어로 듣고 한 곡을 선택합니다.
5. **선택한 곡 내보내기**로 MP3를 저장합니다. 앱에 보관된 원본 MP3를 그대로 복사하며 WAV로 변환하지 않습니다.

기존 `FAL_KEY` 환경 변수를 Electron 메인 프로세스에서만 읽습니다. 키를 입력하거나 표시하는 웹 UI, 평문 키 저장, 신규 인증 발급은 없습니다. Windows 환경 변수를 설정한 뒤에는 앱을 다시 실행해야 합니다. 소스·로그·GitHub에 실제 키를 넣지 마세요.

## 저장 및 복구

기본 보관 위치는 `%APPDATA%\partsmith\bgm`입니다. 앱의 기존 `BAEKHO_DATA` / `PARTSMITH_DATA` 설정을 사용하면 그 아래 `bgm` 폴더에 저장합니다. 생성 기록, 요청 ID, 선택 상태 및 MP3가 남아 앱 재실행과 임시 URL 만료 후에도 다시 내보낼 수 있습니다.

생성 실패는 후보별로 표시합니다. 확정 실패 후보의 재시도는 새 유료 요청이며 버튼을 직접 눌러야 합니다. 성공한 곡은 다시 생성하지 않습니다. 통신 오류로 접수 여부가 불명확하면 자동 재제출하지 않습니다. 요청 ID가 있으면 같은 요청의 상태 확인과 다운로드를 계속할 수 있습니다. 앱을 닫아도 fal 서버에서 이미 시작한 작업이 취소되는 것은 아닙니다.

## 모델과 비용

- Google **Lyria 3**, fal endpoint `fal-ai/lyria3`.
- 공식 안내: 30초 MP3, 44.1 kHz / 192 kbps. 실제 검증의 첫 파일은 플레이어 기준 30.77초였으므로 약 30초로 표시하며 원본을 임의로 잘라내지 않습니다.
- 2026-10-14 확인 단가 **USD 0.04 / audio**, 기본 3회 **USD 0.12** 예상.
- 화면의 누적 금액은 제출 전에 예약한 보수적인 예상 금액입니다. 실패·결과 불명 요청도 포함합니다. API 응답에서 실제 결제 확정액을 제공하지 않아 이를 확정 청구액으로 표시하지 않습니다. 실제 결제는 fal 사용 내역에서 확인합니다.
- 기본 누적 예상 비용 상한은 USD 4.99입니다. 이번 실제 검증 예산 USD 5 미만을 지킵니다.
- 장르·감정·보컬 없는 연주 지시는 프롬프트에 결합합니다. 지원하지 않는 duration/count/seed/negative_prompt 필드는 보내지 않습니다. 보컬 배제와 완전한 루프 연결은 모델 결과를 들어 확인해야 합니다.
- SynthID 표식이 포함될 수 있습니다. 상업 이용 표시가 독점 저작권이나 모든 제3자 권리의 정리를 보장하는 것은 아닙니다.

공식 근거: [모델·가격](https://fal.ai/models/fal-ai/lyria3), [입출력 문서](https://fal.ai/models/fal-ai/lyria3/api), [API 약관](https://fal.ai/legal/api-services).

## 개발 및 검증

```powershell
npm ci
npm run build
npm start
node --import tsx --test tests/bgm.test.ts tests/bgm-media.test.ts
```

`node scripts/bgm-live-smoke.mjs`는 저장된 검증 프로필의 결과를 확인합니다. `--generate`를 명시한 경우에만 실제 3회 생성을 시도하며, 이미 유료 요청 의도 파일이나 결과가 있으면 재제출을 거부합니다. 일반 테스트는 네트워크 경계를 모의 처리하며 과금하지 않습니다. 실제 검증 프로필과 MP3는 `artifacts/runtime` 아래 로컬에만 보관하고 git에 포함하지 않습니다.

통합 검증은 `node scripts/baekho-bgm-integration-smoke.mjs --packaged "release/win-unpacked/Baekho Tools.exe" --source-bgm "기존 검증 프로필/bgm"`입니다. 원본을 복사한 격리 프로필에서만 실행하며 네트워크와 생성 IPC를 차단하고 네 도구, 최신 3D 화면, 세 곡 재생·선택·내보내기·재시작을 검사합니다. 이 스크립트에는 유료 생성 모드가 없습니다.
