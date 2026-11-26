# 사인검 Auto Hit Timer 어댑터

`com.studiobaekho.auto-hit-timer` 패키지를 설치한 사인검 프로젝트의 `Assets/Editor/AutoHitTimer/`에 이 폴더의 `Editor/*.cs`를 복사한다. 사인검의 `Assembly-CSharp` 타입을 참조하므로 별도 asmdef를 만들지 않는다. 런타임 게임 코드는 변경하지 않는다.

어댑터 ID는 `four-tiger-sword`다. 현재 프로젝트의 모든 `WeaponActionDataSO`를 검색하고 저장 대상은 SO GUID와 실제 직렬화 경로(`Actions.ComboSteps.Array.data[0]` 등)로 식별한다. 일반 콤보, 공중 마무리, 반격은 모든 폼, 스킬은 화·금 폼, 궁극기는 금 폼을 지원한다. 다른 특수 판정은 사유를 반환한다.

## 저장 계약

- `PreviewChange`에 `actorId`, `clip: {guid, localId, sourceFingerprint}`, `sourceGuid`, `mode`, `windows: [{start, end, sourceIndex}]`를 보낸다. `sourceFingerprint`는 촬영 결과의 원본 해시이며 누락·변경 시 재분석을 요구한다(`expectedClipHash`로 별도 전달 가능). 기존 히트 대응은 0부터 시작하며 새 히트는 `sourceIndex: -1`이다. 동일 기존 항목의 중복 대응은 금지한다. 단타에서 다단타로 전환하면 새 이벤트의 `Damage`와 `PoiseDamage`는 0이며 덮어쓰기 옵션은 꺼진다. 기존 다단타를 한 타로 줄여도 해당 이벤트의 피해·피드백을 보존한다.
- `update`는 `actionPath`를, `register`는 `group`, `templatePath`와 선택적 `stateName`을 받는다. 등록 시 템플릿은 같은 SO의 기존 공격을 선택한다. 목록형은 끝에 추가하고 공중·반격은 기존 단일 항목을 생성 또는 교체한다. 새 Animator 상태는 기본 레이어에 고유 이름으로 생성한다.
- `update`는 기존 Animator 상태의 클립을 선택한 클립으로 교체하며 `Motion`이 비어 있으면 연결한다. `Targets`의 `currentClip`, `needsClipAssignment`와 미리보기의 `clipAssignment: {stateName, clipName, clipPath, previousClipName, previousClipPath}`, `controllerChanged`로 변경 대상을 표시한다. 중첩 상태도 기존 상태 이름·전환·설정과 밸런스 값을 유지한다. 같은 클립이면 Controller를 수정하지 않는다. Blend Tree와 기존 속도·오프셋·미러링·상태 중복 제한은 유지한다.
- 클립 연결·교체는 SO와 Controller를 함께 백업·저장·Undo·롤백한다. 복사 저장에서는 두 에셋을 복사하고 복사된 Controller의 상태만 수정한다. 검토 이후 상태가 변경되거나 다른 클립이 연결되면 저장을 거부한다.
- `affectedAttacks`는 같은 Animator 상태를 참조하는 다른 공격 목록이다. 해당 Controller를 사용하는 공격들의 재생 클립도 함께 바뀌므로 미리보기에 표시하며, 다른 공격의 히트 구간·시간 설정은 자동 수정하지 않는다.
- 등록과 수정 모두 `timeOverrides: [{path, value}]`로 공격 종료(`Execution.Duration`)·콤보(`Execution.ComboTransitionTime`)·이동·타겟 접근/회전·트레일·슬래시 시작 시간을 수정한다. `Targets.capabilities.attackTiming`이 true인 연결 모듈에서 종료 시간 편집을 지원한다. 대상의 `timeSettings`와 미리보기의 `editableTimeSettings`는 `min`, `max`, `exclusiveMin`, `active`, `unit`을 포함한다. 비활성 항목은 `active:false,max:null`로 반환하고 기존 값을 보존한다. `requiredTimeOverrides`는 사용 중인 시간의 범위·순서 위반을 표시한다. `before`는 실제 변경 대상이며 목록 추가는 빈 객체다. `template`과 `mapping`은 복사 원본의 타격 대응을 표시한다.
- 시간 단위는 속도 배율 전 초다. 같은 클립의 기존 공격 수정은 기존 종료 시간을 유지하고, 등록·다른 클립·빈 상태 연결은 클립 길이를 기본값으로 사용한다. 명시한 Duration override가 우선한다. `0 < Duration <= clip.length`, 모든 히트 종료 `<= Duration`, 일반 콤보 `0 <= ComboTransitionTime <= Duration`를 검사한다. 사용 중인 이동·트레일·절대 슬래시 시간도 Duration 이내여야 하며 `-1` 슬래시 자동 시점은 유지한다. 마지막 히트보다 이른 콤보는 허용하되 `warnings`에 타격 생략 가능성을 반환한다. `before/after`의 `duration`과 `comboTransitionTime`으로 변경을 비교한다. Blend Tree, Override Controller, 상태 속도 파라미터, 시간 파라미터, 오프셋, 연속 동일 상태 재사용은 적용을 막는다.
- `copy: true`의 기본 출력 폴더는 `Assets/StudioBaekho/AutoHitTimer/Results`다. 필요한 폴더는 적용 때 생성한다. SO를 복제하고 새 상태 등록 또는 클립 변경이 있으면 Controller도 복제한다. 반환된 에셋을 게임에 연결한다. Controller의 미저장 편집이 있으면 먼저 Unity에서 저장해야 복사할 수 있다.
- `Apply: {changeId}`는 직전 미리보기의 SO·Controller·클립 스냅샷을 재검사한다. 동일 ID의 재요청은 최초 완료 결과를 반환한다. Unity 도메인이 다시 로드되어 스냅샷이 달라지면 재검토가 필요할 수 있다.
- `SaveStatus: {changeId}`는 디스크 변경 기록만 읽어 `missing`, `preview`, `applying`, `recovery-required`, `rolled-back`, `complete`를 반환한다. `complete`에는 최초 저장 결과가 포함된다. 저장 성공 직후 연결이 끊겨도 다시 적용하지 않고 이 결과를 복구할 수 있다. 진행 중·복구 필요 상태에서는 `Apply`를 재전송하지 않는다.

저장 변경은 Unity Undo에 기록된다. 확인된 원본 저장은 대상 SO 및 필요한 Controller의 기존 편집도 함께 저장한다. 변경 전 에셋 파일과 적용 후 SO JSON은 `Library/AutoHitTimer/four-tiger-sword/`에 보존한다. 일반 저장 실패는 원복하고 앱 종료 등으로 중단된 저장은 `Tools > Studio Baekho > Auto Hit Timer > Recover Interrupted Save`에서 복구한다. `Library` 삭제 시 이 로컬 복구 기록도 삭제되므로 버전 관리의 대체물이 아니다.

## 검증

원본 게임과 분리된 검증용 프로젝트에서 시작 씬을 먼저 저장한 뒤 `Tools > Studio Baekho > Auto Hit Timer > Run Adapter Regression` 또는 batchmode의 `-executeMethod StudioBaekho.AutoHitTimer.FourTigerSword.FourTigerAutoHitTimerRegression.Run`을 실행한다. 기존 미저장 씬은 자동으로 저장하거나 폐기하지 않는다. 자체 임시 폴더와 씬을 생성해 매핑·상속값·타수 변경·시간 검증·지원 범위·동시 편집 충돌·중복 저장·Undo·복사 등록·고유 상태 생성을 검사하고 임시 에셋을 제거한다. 실제 AI 이미지 분석의 정확도 검증과는 별개다.
