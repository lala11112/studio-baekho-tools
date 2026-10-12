import type {
  AssetVersion,
  GraphicsKind,
  GraphicsObject,
  GraphicsTask,
  GraphicsTaskDefinition,
  GraphicsWorkspace,
} from "./graphics";

/** Reserved approvals stay counted even after a cancellation or an ambiguous submission. */
export function graphicsTripoReserved(workspace: GraphicsWorkspace): number {
  return workspace.tasks.reduce((sum, task) => sum + (task.paidApproval?.provider === "Tripo API" ? task.paidApproval.credits : 0), 0);
}

export function graphicsApprovalState(
  task: GraphicsTask,
  at: number,
): "execute" | "refresh" | "blocked" {
  if (task.status !== "awaiting_approval") return "blocked";
  if (task.cost?.expiresAt !== undefined && task.cost.expiresAt <= at) {
    return task.quoteId && task.cost.provider === "Tripo API"
      ? "refresh"
      : "blocked";
  }
  if (
    typeof task.cost?.credits === "number" &&
    Number.isFinite(task.cost.credits) &&
    task.cost.credits >= 0
  )
    return "execute";
  // Native images consume the configured Codex account; a missing paid-service quote is different.
  if (
    task.cost?.provider === "Codex" &&
    ["codex-image", "astra"].includes(findGraphicsTask(task.taskId)?.executor ?? "")
  )
    return "execute";
  return "blocked";
}

export function graphicsMultiviewProblem(
  settings: GraphicsObject["settings"],
  versions: AssetVersion[],
): string | undefined {
  const ids = ["front", "left", "back", "right"].map(
    (direction) => settings[`${direction}VersionId`],
  );
  if (
    ids.some(
      (id) =>
        typeof id !== "string" ||
        !versions.some(
          (version) =>
            version.id === id &&
            version.files.some((file) =>
              /\.(png|jpe?g|webp)$/i.test(file.path),
            ),
        ),
    )
  ) {
    return "정면·왼쪽·후면·오른쪽에 사용할 독립 원본 이미지를 각각 지정하세요.";
  }
  if (new Set(ids).size !== 4)
    return "네 방향에는 서로 다른 원본 이미지를 지정하세요. 같은 이미지를 여러 방향으로 제출하지 않습니다.";
  return undefined;
}

const ready = new Set(["A01", "A02", "A03", "A05", "N01", "X04", "X05"]);
const verified = new Set([...ready, "I01", "M01", "M05", "T01", "T03"]);
const verifiedScope: Record<string, string> = {
  I01: "대검 이미지 1장의 실제 앱 생성·원본 수집·재시작 보존을 확인했습니다. 다른 개수와 대상의 외형은 직접 검토하세요.",
  M01: "실제 대검 이미지로 P2 모델 1개 생성·FBX 수집·앱 등록을 확인했습니다. 후보당 100 API 크레딧이며 원본별 외형과 실제 면 수를 검토하세요.",
  M05: "앱 버튼으로 Astra의 대검 칼날 폭 보정과 원본·UV·4K 맵 보존을 확인했습니다. 현재 연결은 토폴로지를 유지하는 형태·비율 보정입니다.",
  T01: "실제 P2 대검의 Smart UV 처리·FBX 수집과 최종 UV 존재를 확인했습니다. 예상 20 API 크레딧이며 UV 품질은 모델별 검토가 필요합니다.",
  T03: "실제 대검에 텍스처를 생성해 4096px PBR 맵 3개와 Unity 가져오기를 확인했습니다. 출력 해상도와 외형은 결과별로 검토하세요.",
};
const image = new Set(["I01", "I02", "I03", "I05", "I06", "I07"]);
const tripo = new Set(["M01", "M02", "M03", "M10", "T01", "T03"]);
export const graphicsAstraTasks = new Set(["M05", "R01", "R02", "R03", "N04", "N05", "N06"]);
export const graphicsVideoTasks = new Set(["N02"]);
const localScope: Record<string, string> = {
  N01: "채택한 모델·리그에서 두 측면을 2048px로 로컬 렌더합니다. 전신 여백을 계산하며 원본과 기존 디자인을 유지합니다. GPT·유료 생성 없음.",
  A05: "현재 구현: BLEND·FBX·GLB 모델의 배율·피벗 정리. 이미지 크기·여백 정리는 아직 지원하지 않습니다.",
  X04: "현재 구현: BLEND·FBX·GLB 모델에서 FBX·GLB 작업 사본 내보내기. 이미지 내보내기와 기타 형식 변환은 아직 지원하지 않습니다.",
  X05: "정적 모델·이미지 또는 호환되는 채택 리그와 클립을 Unity 관리 폴더로 가져옵니다. 원본과 사용자 프리팹 설정을 보존합니다. 실제 Play Mode는 실행하지 않습니다.",
};
const pendingReasons: Record<string, string> = {
  A: "이 작업의 자동 실행과 결과 검증은 아직 연결되지 않았습니다.",
  I: "영역·일관성·원본 보존을 확인하는 이미지 작업 경로가 준비 중입니다.",
  S: "2D 원본·피벗·프레임 검사와 엔진 출력 경로가 준비 중입니다.",
  U: "실제 UI 에셋과 Unity UI 계층의 생성·검사 경로가 준비 중입니다.",
  M: "기존 메시를 보존하는 작업별 편집·결과 검사 경로가 준비 중입니다.",
  E: "모듈 규격·배치·접합을 검사하는 환경 작업 경로가 준비 중입니다.",
  T: "재질·UV·원본 텍스처 보존을 검사하는 작업 경로가 준비 중입니다.",
  R: "이 작업 공간의 뼈·웨이트·실제 변형 검증 연결이 준비 중입니다.",
  N: "동작별 참조·클립·접지 검사를 갖춘 실행 연결이 준비 중입니다.",
  V: "Unity 효과 생성·컴파일·실제 재생 검사가 준비 중입니다.",
  X: "이 출력 유형의 원본 보존과 Unity 검증 연결이 준비 중입니다.",
};

// Names, inputs and review criteria follow docs/graphics-studio/02-전체-작업-선택표.md.
const definitions = [
  {
    id: "A01",
    name: "자료 가져오기·분류",
    group: "A 자료와 대상",
    inputs: "파일·종류·역할",
    output: "내부 복사본, 원본 해시, 수정/외형/스타일/동작 참조 구분",
  },
  {
    id: "A02",
    name: "오브젝트 묶음 만들기",
    group: "A 자료와 대상",
    inputs: "대상 이름·종류·개수",
    output: "별도 대상과 관계, 생성 작업은 별도 실행",
  },
  {
    id: "A03",
    name: "참고 자료 연결",
    group: "A 자료와 대상",
    inputs: "대상·참조 버전·역할",
    output: "캐릭터→무기처럼 다른 대상 참조, 원본 보존",
  },
  {
    id: "A04",
    name: "다른 형식의 작업 원본 준비",
    group: "A 자료와 대상",
    inputs: "기존 파일·목적",
    output: "편집/표시/업로드용 사본, 변환 손실·제약 표시",
  },
  {
    id: "A05",
    name: "크기·축·피벗 정리",
    group: "A 자료와 대상",
    inputs: "이미지/모델·단위·기준점",
    output: "일관된 기준, 적용 전후 비교",
  },
  {
    id: "A06",
    name: "이름·폴더·묶음 정리",
    group: "A 자료와 대상",
    inputs: "선택 에셋·명명 규칙",
    output: "파일 연결 보존, 미리보기 후 적용",
  },
  {
    id: "A07",
    name: "작업 조합 저장·적용",
    group: "A 자료와 대상",
    inputs: "선택 작업·설정",
    output: "재사용 프리셋, 입력·지원 조건은 매번 확인",
  },
  {
    id: "A08",
    name: "사용자 정의 작업",
    group: "A 자료와 대상",
    inputs: "자연어·대상·참조",
    output: "실행 범위와 지원 여부 제시, 가능한 도구로 자동 수행",
  },
  {
    id: "I01",
    name: "새 디자인 생성",
    group: "I 디자인과 참고 이미지",
    inputs: "대상·설명·스타일·개수",
    output: "요청한 오브젝트의 독립 원본",
  },
  {
    id: "I02",
    name: "참조 기반 디자인",
    group: "I 디자인과 참고 이미지",
    inputs: "참조·출력 대상·유지 특징",
    output: "참고 대상과 새 출력 대상 분리",
  },
  {
    id: "I03",
    name: "기존 이미지 수정",
    group: "I 디자인과 참고 이미지",
    inputs: "원본·수정 지시·유지 범위",
    output: "원본과 새 수정본, 차이 비교",
  },
  {
    id: "I04",
    name: "특정 영역만 수정",
    group: "I 디자인과 참고 이미지",
    inputs: "원본·영역 설명/마스크",
    output: "바깥 영역 보존 검사, 선택 영역 표시",
  },
  {
    id: "I05",
    name: "색상·재질·스타일 변형",
    group: "I 디자인과 참고 이미지",
    inputs: "원본·변형 범위·개수",
    output: "형태 보존 조건과 변형별 버전",
  },
  {
    id: "I06",
    name: "옷·무기·장비 디자인",
    group: "I 디자인과 참고 이미지",
    inputs: "캐릭터 참조·장비 종류",
    output: "장비 단독/착용 참고 중 선택, 별도 대상 연결",
  },
  {
    id: "I07",
    name: "필요한 방향 만들기",
    group: "I 디자인과 참고 이미지",
    inputs: "원본·정면/후면/좌/우/추가 시점",
    output: "방향별 원본과 일관성, 좌우 규칙 명시",
  },
  {
    id: "I08",
    name: "파츠별 참고 이미지",
    group: "I 디자인과 참고 이미지",
    inputs: "전체 이미지·분리 대상·방향",
    output: "선택 파츠만 분리, 몸통 누락·추정 영역 확인",
  },
  {
    id: "I09",
    name: "배경 제거·전신 여백 정리",
    group: "I 디자인과 참고 이미지",
    inputs: "이미지·투명/단색·여백",
    output: "원본 보존, 귀·발·얇은 부분 안 잘림",
  },
  {
    id: "I10",
    name: "크기·중심·비교 시트 정리",
    group: "I 디자인과 참고 이미지",
    inputs: "독립 원본들·기준·배치",
    output: "정렬 사본/비교 시트, 독립 생성 원본과 구분",
  },
  {
    id: "I11",
    name: "디테일·분해·치수 참고",
    group: "I 디자인과 참고 이미지",
    inputs: "원본·부위·기준 치수",
    output: "제작용 설명 이미지, 보이지 않는 부분 추정 표시",
  },
  {
    id: "I12",
    name: "해상도 보완·이미지 복원",
    group: "I 디자인과 참고 이미지",
    inputs: "원본·목표·보존 조건",
    output: "AI 추가 디테일과 단순 리사이즈 구분",
  },
  {
    id: "S01",
    name: "캐릭터 스프라이트",
    group: "S 2D 게임 에셋",
    inputs: "디자인·시점·캔버스·피벗",
    output: "투명 원본, 기준 크기",
  },
  {
    id: "S02",
    name: "아이템·능력 아이콘",
    group: "S 2D 게임 에셋",
    inputs: "참조·의미·크기·세트 수",
    output: "세트 스타일·작은 크기 가독성",
  },
  {
    id: "S03",
    name: "초상화·표정 세트",
    group: "S 2D 게임 에셋",
    inputs: "인물 참조·표정 목록",
    output: "인물 동일성·표정별 원본",
  },
  {
    id: "S04",
    name: "게임 배경 이미지",
    group: "S 2D 게임 에셋",
    inputs: "구도·용도·카메라 비율",
    output: "플레이/문자 영역과 배경 분리",
  },
  {
    id: "S05",
    name: "패럴랙스 레이어",
    group: "S 2D 게임 에셋",
    inputs: "배경·깊이 구간·이동 범위",
    output: "레이어·가려진 영역 보완·이동 미리보기",
  },
  {
    id: "S06",
    name: "타일·반복 이미지",
    group: "S 2D 게임 에셋",
    inputs: "타일 크기·연결 형태·스타일",
    output: "반복 경계·모서리·변형 타일 검토",
  },
  {
    id: "S07",
    name: "프레임 시트 만들기·분할",
    group: "S 2D 게임 에셋",
    inputs: "프레임/시트·순서·간격",
    output: "독립 프레임과 시트·메타데이터",
  },
  {
    id: "S08",
    name: "프레임 정렬·알파·피벗 정리",
    group: "S 2D 게임 에셋",
    inputs: "프레임·기준 크기·접지점",
    output: "흔들림·크롭·접지 일관성",
  },
  {
    id: "S09",
    name: "아틀라스 묶기",
    group: "S 2D 게임 에셋",
    inputs: "이미지 세트·패딩·회전 여부",
    output: "아틀라스와 원본 대응표, 원본 유지",
  },
  {
    id: "S10",
    name: "픽셀 아트 정리",
    group: "S 2D 게임 에셋",
    inputs: "팔레트·픽셀 격자·이미지",
    output: "임의 스무딩 없음, 최근접 확대·일관성",
  },
  {
    id: "S11",
    name: "2D 뼈대·변형 준비",
    group: "S 2D 게임 에셋",
    inputs: "레이어/스프라이트·관절·변형 범위",
    output: "2D 본·스킨·메시와 엔진 호환, 3D 리그와 구분",
  },
  {
    id: "S12",
    name: "2D 본 애니메이션",
    group: "S 2D 게임 에셋",
    inputs: "2D 리그·동작 지시·참조",
    output: "실제 2D 클립과 변형, 플립북과 별도 방식",
  },
  {
    id: "U01",
    name: "버튼·패널·프레임 디자인",
    group: "U UI 그래픽과 엔진 UI",
    inputs: "스타일·용도·크기",
    output: "실제 분리 에셋, 레이아웃 예시와 구분",
  },
  {
    id: "U02",
    name: "UI 상태 세트",
    group: "U UI 그래픽과 엔진 UI",
    inputs: "기본 디자인·필요 상태",
    output: "기본/호버/누름/선택/비활성 중 지정한 것만",
  },
  {
    id: "U03",
    name: "게이지·배지·슬롯",
    group: "U UI 그래픽과 엔진 UI",
    inputs: "형태·채움 방식·숫자 영역",
    output: "채움 마스크·테두리·내용 영역",
  },
  {
    id: "U04",
    name: "9슬라이스 준비",
    group: "U UI 그래픽과 엔진 UI",
    inputs: "패널·보존 테두리·크기 범위",
    output: "슬라이스 값과 확대 검사",
  },
  {
    id: "U05",
    name: "텍스트·폰트 구성",
    group: "U UI 그래픽과 엔진 UI",
    inputs: "실제 문자열·언어·폰트",
    output: "편집 가능한 텍스트, 한글 누락·가독성 검사",
  },
  {
    id: "U06",
    name: "화면 배치 구성",
    group: "U UI 그래픽과 엔진 UI",
    inputs: "에셋·레이아웃 지시·화면 비율",
    output: "실제 UI 계층·앵커·정렬",
  },
  {
    id: "U07",
    name: "Unity UI 만들기",
    group: "U UI 그래픽과 엔진 UI",
    inputs: "UI 구성·uGUI/UITK 선택",
    output: "프리팹/문서·스타일·필요 이미지, 게임 로직 제외",
  },
  {
    id: "U08",
    name: "해상도·입력 상태 검사",
    group: "U UI 그래픽과 엔진 UI",
    inputs: "UI 결과·검사할 화면 규격",
    output: "잘림·겹침·누름 상태·안전 영역 보고",
  },
  {
    id: "M01",
    name: "단일 이미지 모델링",
    group: "M 3D 모델 제작과 보정",
    inputs: "채택 이미지·모델·면 수·개수",
    output: "실제 모델 원본, 멀티뷰 강제 없음",
  },
  {
    id: "M02",
    name: "멀티뷰 모델링",
    group: "M 3D 모델 제작과 보정",
    inputs: "채택 방향들·실제 슬롯 대응",
    output: "업로드 방향 매핑과 원본, 임의 좌우 교환 금지",
  },
  {
    id: "M03",
    name: "설명 기반 모델링",
    group: "M 3D 모델 제작과 보정",
    inputs: "대상 설명·규격·제공 모델",
    output: "텍스트 지원 API 또는 명시적 로컬 방식",
  },
  {
    id: "M04",
    name: "기본 형상·규격 모델",
    group: "M 3D 모델 제작과 보정",
    inputs: "형상·치수·반복 규칙",
    output: "로컬 절차 모델, AI 이미지 단계 불필요",
  },
  {
    id: "M05",
    name: "형태·비율 보정",
    group: "M 3D 모델 제작과 보정",
    inputs: "기존 편집 모델·참조·지시",
    output: "기존 메시 기반 새 버전, 실루엣 비교",
  },
  {
    id: "M06",
    name: "부위 수정·부분 재생성",
    group: "M 3D 모델 제작과 보정",
    inputs: "모델·영역·지시·가능 경로",
    output: "로컬 수정/공식 부분 편집 구분, 미지원이면 중단",
  },
  {
    id: "M07",
    name: "파츠 분리",
    group: "M 3D 모델 제작과 보정",
    inputs: "모델·원하는 파츠·경계",
    output: "의미 파츠와 단순 연결 분리 구분",
  },
  {
    id: "M08",
    name: "여러 파츠 조립",
    group: "M 3D 모델 제작과 보정",
    inputs: "모델들·배치/전체 참조",
    output: "상대 위치·스케일·접합 확인, 결합과 용접 구분",
  },
  {
    id: "M09",
    name: "메시 결함 정리",
    group: "M 3D 모델 제작과 보정",
    inputs: "모델·정리 항목",
    output: "구멍·노멀·중복·자가 교차 등 처리 전후 검사",
  },
  {
    id: "M10",
    name: "리토폴로지·면 수 정리",
    group: "M 3D 모델 제작과 보정",
    inputs: "모델·방식·목표·외형 보존",
    output: "실제 면 수·UV/리그 영향, 삼각/쿼드 구분",
  },
  {
    id: "M11",
    name: "대칭·변형·규칙 반복",
    group: "M 3D 모델 제작과 보정",
    inputs: "모델·축·범위·반복 수",
    output: "규칙에 따른 새 버전, 원본 비대칭 보존 여부",
  },
  {
    id: "M12",
    name: "장비 장착 맞춤",
    group: "M 3D 모델 제작과 보정",
    inputs: "장비·캐릭터·장착 위치",
    output: "크기·각도·손잡이·관통 검토, 장착점 기록",
  },
  {
    id: "M13",
    name: "의상·몸체 맞춤",
    group: "M 3D 모델 제작과 보정",
    inputs: "의상/캐릭터·핏·보존 조건",
    output: "변형 가능한 의상 메시, 표면 관통·리그 영향",
  },
  {
    id: "M14",
    name: "머리카락·털 구조 준비",
    group: "M 3D 모델 제작과 보정",
    inputs: "외형 참조·메시/카드 방식·예산",
    output: "실제 메시/카드·알파·엔진 표현, 이미지에만 추가 금지",
  },
  {
    id: "E01",
    name: "건축 모듈 세트",
    group: "E 환경과 모듈",
    inputs: "벽/바닥/기둥 등 목록·격자",
    output: "모듈별 모델과 접합 규격",
  },
  {
    id: "E02",
    name: "모듈 접합 보정",
    group: "E 환경과 모듈",
    inputs: "모듈들·치수·스냅 기준",
    output: "경계·피벗·스케일·틈 검사",
  },
  {
    id: "E03",
    name: "자연물·식생 에셋",
    group: "E 환경과 모듈",
    inputs: "형태·종류·스타일·면 수",
    output: "줄기/잎/알파 카드 방식, 실루엣",
  },
  {
    id: "E04",
    name: "지형 조각·암석 세트",
    group: "E 환경과 모듈",
    inputs: "범위·치수·높이/형태 참조",
    output: "모델·재질·접합, 전체 월드 자동 완성 아님",
  },
  {
    id: "E05",
    name: "배치용 변형 세트",
    group: "E 환경과 모듈",
    inputs: "원본·색/크기/형상 변형 범위",
    output: "변형별 파일, 무의미한 동일 후보 제외",
  },
  {
    id: "E06",
    name: "오브젝트 배치 구성",
    group: "E 환경과 모듈",
    inputs: "에셋들·영역·간격·규칙",
    output: "편집 가능한 배치, 원본 참조·충돌 검사",
  },
  {
    id: "E07",
    name: "환경 외형 통일",
    group: "E 환경과 모듈",
    inputs: "선택 에셋·스타일 기준",
    output: "재질·색·규격 보정, 모델 무조건 재생성 금지",
  },
  {
    id: "E08",
    name: "조명·분위기 미리보기",
    group: "E 환경과 모듈",
    inputs: "에셋·조명 의도·엔진 설정",
    output: "미리보기 씬, 텍스처에 조명을 몰래 굽지 않음",
  },
  {
    id: "T01",
    name: "UV 생성",
    group: "T UV와 재질",
    inputs: "모델·Smart UV/로컬 방식",
    output: "실제 UV와 펼침 미리보기, 방식 표시",
  },
  {
    id: "T02",
    name: "UV 재배치·패킹",
    group: "T UV와 재질",
    inputs: "UV 모델·여백·밀도·타일",
    output: "패킹과 AI UV 전개 구분, 기존 텍스처 영향",
  },
  {
    id: "T03",
    name: "모델 텍스처 생성",
    group: "T UV와 재질",
    inputs: "모델·UV·스타일/이미지·해상도",
    output: "실제 텍스처·재질 연결·해상도",
  },
  {
    id: "T04",
    name: "텍스처 부분 수정",
    group: "T UV와 재질",
    inputs: "기존 맵·영역·지시",
    output: "유지 영역·이음새 검사, 새 버전",
  },
  {
    id: "T05",
    name: "재질·색상 변형",
    group: "T UV와 재질",
    inputs: "모델/재질·색·광택·개수",
    output: "형상 보존, 필요한 맵만 변경",
  },
  {
    id: "T06",
    name: "PBR 맵 준비",
    group: "T UV와 재질",
    inputs: "표면 참조·필요 채널",
    output: "실제 생성된 맵만 표시, 측정/추정 구분",
  },
  {
    id: "T07",
    name: "베이크",
    group: "T UV와 재질",
    inputs: "고/저밀도 모델·케이지·맵",
    output: "노멀/AO 등 결과와 베이크 오류 검사",
  },
  {
    id: "T08",
    name: "타일 재질·데칼",
    group: "T UV와 재질",
    inputs: "표면 디자인·반복/투명·크기",
    output: "반복 경계·알파·투영 결과",
  },
  {
    id: "T09",
    name: "재질 슬롯·맵 연결 정리",
    group: "T UV와 재질",
    inputs: "모델·텍스처 폴더·채널 규칙",
    output: "누락 연결·색 공간·알파·노멀 방향 확인",
  },
  {
    id: "T10",
    name: "엔진 재질 만들기",
    group: "T UV와 재질",
    inputs: "모델·실제 맵·렌더 파이프라인",
    output: "Unity 재질과 모델 연결, 원본 맵 보존",
  },
  {
    id: "T11",
    name: "라이트맵 준비·베이크",
    group: "T UV와 재질",
    inputs: "씬·조명·UV·대상 플랫폼",
    output: "베이크용 UV·조명 데이터·이음새, 일반 텍스처와 구분",
  },
  {
    id: "R01",
    name: "사람형 뼈대 만들기",
    group: "R 리깅과 변형",
    inputs: "모델·체형·기준 포즈",
    output: "뼈 계층·좌우·관절 배치, Humanoid 적합성",
  },
  {
    id: "R02",
    name: "동물·비인간 뼈대",
    group: "R 리깅과 변형",
    inputs: "모델·사족/날개/다족/사용자 정의",
    output: "Generic 기본, 부위별 실제 포즈 검사",
  },
  {
    id: "R03",
    name: "스키닝·웨이트",
    group: "R 리깅과 변형",
    inputs: "모델·뼈대·보존 영역",
    output: "모든 대상 정점의 유효 웨이트·변형 검사",
  },
  {
    id: "R04",
    name: "관절·웨이트 수정",
    group: "R 리깅과 변형",
    inputs: "기존 리그·문제 지시",
    output: "기존 리그 기반 국소 보정, 전후 비교",
  },
  {
    id: "R05",
    name: "귀·꼬리·날개 제어",
    group: "R 리깅과 변형",
    inputs: "선택 부위·컨트롤 수/목적",
    output: "선택 부위 뼈·웨이트·가동 범위 검사",
  },
  {
    id: "R06",
    name: "옷·머리카락·장식 리깅",
    group: "R 리깅과 변형",
    inputs: "오브젝트 목록·부착/변형 방식",
    output: "오브젝트별 선택, 뼈·웨이트·관통 검사",
  },
  {
    id: "R07",
    name: "IK·조작 컨트롤",
    group: "R 리깅과 변형",
    inputs: "기존 리그·팔다리·목적",
    output: "조작용 리그와 게임용 변형 뼈 분리",
  },
  {
    id: "R08",
    name: "표정·블렌드셰이프",
    group: "R 리깅과 변형",
    inputs: "얼굴 모델·표정 목록",
    output: "형태별 결과·눈/입 관통·엔진 대응",
  },
  {
    id: "R09",
    name: "소켓·장착점 만들기",
    group: "R 리깅과 변형",
    inputs: "모델/리그·손/허리 등 위치",
    output: "이름·축·자세별 장착 상태",
  },
  {
    id: "R10",
    name: "리그 재사용·호환 정리",
    group: "R 리깅과 변형",
    inputs: "원본/대상 리그·매핑",
    output: "뼈 이름뿐 아니라 계층·바인드 포즈 검사",
  },
  {
    id: "N01",
    name: "동작 입력 이미지 준비",
    group: "N 애니메이션과 동작 참조",
    inputs: "채택 이미지/리그·측면·여백",
    output: "선택 원본 또는 실제 렌더, 귀·발·큰 동작 여백",
  },
  {
    id: "N02",
    name: "AI 동작 영상 생성",
    group: "N 애니메이션과 동작 참조",
    inputs: "입력 이미지·동작·길이·해상도",
    output: "원본 영상과 실제 설정·비용, 자동 채택 없음",
  },
  {
    id: "N03",
    name: "동작 참고 구간 추출",
    group: "N 애니메이션과 동작 참조",
    inputs: "채택 영상·구간·시간",
    output: "원본 연결 프레임·타이밍, 새 이미지 생성 없음",
  },
  {
    id: "N04",
    name: "참조 기반 3D 동작",
    group: "N 애니메이션과 동작 참조",
    inputs: "리그·채택 영상/프레임·추가 지시",
    output: "참조와 실제 키프레임, 대기/점프 등 클립별 작업",
  },
  {
    id: "N05",
    name: "텍스트 기반 3D 동작",
    group: "N 애니메이션과 동작 참조",
    inputs: "리그·동작 설명·시간·규칙",
    output: "사용자 선택 방식. 참조 영상 분석 결과로 표시 금지",
  },
  {
    id: "N06",
    name: "기존 동작 수정",
    group: "N 애니메이션과 동작 참조",
    inputs: "애니메이션 편집본·지시·기존 참조",
    output: "기존 액션에서 지정 구간 수정, 다른 클립 보존",
  },
  {
    id: "N07",
    name: "루프·접지·관통 보정",
    group: "N 애니메이션과 동작 참조",
    inputs: "동작·연결/접지 조건",
    output: "끝/시작 연결·발 미끄러짐·관통 검사",
  },
  {
    id: "N08",
    name: "길이·속도·구간 편집",
    group: "N 애니메이션과 동작 참조",
    inputs: "클립·시작/끝·시간 비율",
    output: "국소/전체 시간 수정, 원본 보존",
  },
  {
    id: "N09",
    name: "제자리·루트 모션 변환",
    group: "N 애니메이션과 동작 참조",
    inputs: "클립·선택 방식·이동축",
    output: "루트 이동과 실제 발 접지 비교",
  },
  {
    id: "N10",
    name: "리타게팅",
    group: "N 애니메이션과 동작 참조",
    inputs: "동작·대상 리그·매핑",
    output: "실제 비율 보정·발/손 접촉, 이름 매칭만으로 성공 금지",
  },
  {
    id: "N11",
    name: "보조 움직임",
    group: "N 애니메이션과 동작 참조",
    inputs: "클립·귀/꼬리/옷 등 대상·강도",
    output: "주동작 유지, 베이크 여부·엔진 제약 명시",
  },
  {
    id: "N12",
    name: "2D 동작·플립북 제작",
    group: "N 애니메이션과 동작 참조",
    inputs: "원본/영상/3D동작·필요 프레임",
    output: "AI 영상/3D 렌더/이미지 방식 구분, 프레임 일관성",
  },
  {
    id: "N13",
    name: "게임 연출 동작 구성",
    group: "N 애니메이션과 동작 참조",
    inputs: "오브젝트·클립·카메라·효과·시간",
    output: "엔진용 연출 타임라인과 미리보기, 게임 로직·일반 영상 편집 제외",
  },
  {
    id: "V01",
    name: "효과 디자인",
    group: "V 이펙트와 셰이더",
    inputs: "효과 설명·색·동작·게임 화면",
    output: "컨셉/참고, 실제 엔진 효과와 구분",
  },
  {
    id: "V02",
    name: "효과 텍스처·마스크",
    group: "V 이펙트와 셰이더",
    inputs: "형태·알파·반복·크기",
    output: "연기/불꽃/광선 등 필요한 맵",
  },
  {
    id: "V03",
    name: "효과 플립북",
    group: "V 이펙트와 셰이더",
    inputs: "영상/프레임·길이·루프·시트",
    output: "실제 프레임 순서·알파·시트 정의",
  },
  {
    id: "V04",
    name: "트레일·빔·충격파 메시",
    group: "V 이펙트와 셰이더",
    inputs: "형태·축·길이·UV 규칙",
    output: "효과용 메시·UV·미리보기",
  },
  {
    id: "V05",
    name: "파티클 효과 구성",
    group: "V 이펙트와 셰이더",
    inputs: "입력 에셋·방출·수명·크기",
    output: "Unity Particle System 프리팹, 실제 재생",
  },
  {
    id: "V06",
    name: "효과 셰이더 구성",
    group: "V 이펙트와 셰이더",
    inputs: "의도·맵·렌더 파이프라인",
    output: "셰이더/그래프·재질·컴파일 및 표현 검사",
  },
  {
    id: "V07",
    name: "효과 동작·타이밍 조합",
    group: "V 이펙트와 셰이더",
    inputs: "파티클/메시/클립·시간",
    output: "여러 요소의 시작/끝·반복·이벤트 순서",
  },
  {
    id: "V08",
    name: "캐릭터·장비에 효과 연결",
    group: "V 이펙트와 셰이더",
    inputs: "대상·소켓·효과·발동 미리보기",
    output: "장착 프리팹·축·스케일·동작 상태",
  },
  {
    id: "V09",
    name: "효과 성능 최적화",
    group: "V 이펙트와 셰이더",
    inputs: "실제 효과·목표 장치·예산",
    output: "측정 원인과 전후 비교, 외형 변경은 승인",
  },
  {
    id: "V10",
    name: "고급 효과 구성",
    group: "V 이펙트와 셰이더",
    inputs: "GPU/상호작용 요구·입력",
    output: "VFX Graph 등 설치·지원 검증 후 실행, 미지원 기기 표시",
  },
  {
    id: "X01",
    name: "LOD 만들기",
    group: "X 게임용 준비와 출력",
    inputs: "모델·단계·목표·보존 특성",
    output: "단계별 메시·재질·스킨 호환·거리 미리보기",
  },
  {
    id: "X02",
    name: "충돌체 만들기",
    group: "X 게임용 준비와 출력",
    inputs: "모델·정적/동적·형태·정밀도",
    output: "단순/볼록/분리 충돌체, 런타임 제약",
  },
  {
    id: "X03",
    name: "최적화 검사·적용",
    group: "X 게임용 준비와 출력",
    inputs: "에셋·목표 플랫폼·성능 예산",
    output: "병목과 제안, 원본 보존·외형 영향 표시",
  },
  {
    id: "X04",
    name: "원본·작업본 내보내기",
    group: "X 게임용 준비와 출력",
    inputs: "선택 버전·형식·축·단위",
    output: "FBX/blend/GLB/OBJ/PNG 등 지원 포맷만, 동반 파일 보존",
  },
  {
    id: "X05",
    name: "Unity 에셋 가져오기",
    group: "X 게임용 준비와 출력",
    inputs: "에셋·프로젝트·관리 폴더",
    output: "모델·텍스처·프리팹 유지, 재생은 별도",
  },
  {
    id: "X06",
    name: "Unity 클립·Animator 구성",
    group: "X 게임용 준비와 출력",
    inputs: "리그·채택 클립·매핑",
    output: "Generic/Humanoid·클립·기본 컨트롤러, 게임 로직 제외",
  },
  {
    id: "X07",
    name: "Unity 재생·표시 검사",
    group: "X 게임용 준비와 출력",
    inputs: "관리 씬·검사 대상·클립",
    output: "실제 렌더/움직임 증거, 기존 사용자 씬 복원",
  },
  {
    id: "X08",
    name: "2D 엔진 설정",
    group: "X 게임용 준비와 출력",
    inputs: "이미지/시트·픽셀 단위·피벗",
    output: "Sprite·슬라이스·아틀라스·필요 타일 설정",
  },
  {
    id: "X09",
    name: "미리보기·턴테이블",
    group: "X 게임용 준비와 출력",
    inputs: "모델/효과·카메라·조명·길이",
    output: "결과 확인용 PNG/MP4, 생성 원본과 구분",
  },
  {
    id: "X10",
    name: "패키지·백업 만들기",
    group: "X 게임용 준비와 출력",
    inputs: "선택 대상·출력 범위",
    output: "원본·버전·설정·출처·복원 검사, 비밀 키 제외",
  },
];

export const graphicsCatalog: GraphicsTaskDefinition[] = definitions.map(
  (entry) => ({
    ...entry,
    executor: ready.has(entry.id)
      ? "local"
      : image.has(entry.id)
        ? "codex-image"
        : tripo.has(entry.id)
          ? "tripo"
          : graphicsAstraTasks.has(entry.id) ? "astra"
          : graphicsVideoTasks.has(entry.id) ? "runway" : "none",
    status: verified.has(entry.id)
      ? "ready"
      : image.has(entry.id) || tripo.has(entry.id) || graphicsAstraTasks.has(entry.id) || graphicsVideoTasks.has(entry.id)
        ? "unverified"
        : "planned",
    reason: ready.has(entry.id)
      ? localScope[entry.id]
      : verifiedScope[entry.id] ?? (image.has(entry.id)
        ? entry.id === "I01"
          ? "새 디자인 1장: 실제 앱 생성·원본 수집·재시작 보존 확인. CLI 기록 누락 시 저장 실행 기록만 조회해 복구했습니다. 다른 개수·대상의 품질은 개별 검토가 필요합니다."
          : "앱의 참조/수정 이미지 실행 경로가 연결되었습니다. 이 작업 공간에서 해당 작업의 실제 생성·수집·품질 검증은 아직 완료되지 않았습니다."
        : tripo.has(entry.id)
          ? "API 실행 경로가 연결되었습니다. 계정 지원·실제 생성 품질은 아직 검증되지 않았으며 제출 전 비용 승인이 필요합니다."
          : graphicsAstraTasks.has(entry.id)
            ? "Blender + Astra가 고정한 원본을 새 버전으로 작업합니다. 뼈·웨이트·클립의 로컬 검사를 거쳐 등록하며 외형과 동작은 직접 검토하세요. 실제 제작 품질은 개별 검증이 필요합니다."
            : graphicsVideoTasks.has(entry.id)
              ? "선택한 측면 원본으로 Runway 720p 영상을 만듭니다. 비용은 실행 전에 표시하고 원본·프레임을 수집합니다. 새 작업 공간의 실제 생성 검증 전입니다."
              : pendingReasons[entry.id[0]]),
  }),
);

export function findGraphicsTask(
  id: string,
): GraphicsTaskDefinition | undefined {
  return graphicsCatalog.find((task) => task.id === id);
}

/** Recommendations never select tasks or request new outputs. Existing models skip image/model generation. */
export function recommendedGraphicsTasks(
  kind: GraphicsKind,
  versions: AssetVersion[],
): string[] {
  const hasModel = versions.some((version) =>
    ["model", "material", "rig", "animation"].includes(version.role),
  );
  if (hasModel)
    return kind === "character"
      ? ["A01", "A03", "A05", "T09", "R01", "R02", "N05", "X04", "X05"]
      : ["A01", "A03", "A05", "T09", "X02", "X04", "X05"];
  const base = ["A01", "A03"];
  if (kind === "sprite") return [...base, "S01", "S02", "S07", "S08", "X08"];
  if (kind === "ui") return [...base, "U01", "U02", "U04", "U07", "U08"];
  if (kind === "vfx") return [...base, "V01", "V02", "V05", "V06", "X05"];
  if (kind === "environment")
    return [...base, "I01", "M01", "E01", "E02", "T03", "X05"];
  if (kind === "weapon")
    return [...base, "I02", "M01", "M12", "R09", "X04", "X05"];
  return [...base, "I01", "I02", "M01", "A05", "T03", "X04", "X05"];
}

export function filterGraphicsTasks(
  query: string,
  ids?: readonly string[],
): GraphicsTaskDefinition[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return graphicsCatalog.filter(
    (task) =>
      (!ids || ids.includes(task.id)) &&
      words.every((word) =>
        [
          task.id,
          task.name,
          task.group,
          task.inputs,
          task.output,
          task.reason ?? "",
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(word),
      ),
  );
}
