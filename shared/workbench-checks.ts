import type { WorkbenchCheck, WorkbenchStep } from "./workbench";

// This is an explicit compatibility list, not a general worker-controlled severity override.
// File integrity, missing parts, role validity, duplicate files and all other stages stay blocking.
const separationVisualChecks: Record<string, string> = {
  original_position_and_scale_preserved: "원본과 크기·위치가 다를 수 있습니다.",
  original_alignment_and_scale_preserved:
    "원본과 정렬·크기가 다를 수 있습니다.",
  original_scale_preserved: "원본과 크기가 다를 수 있습니다.",
  original_position_preserved: "원본과 위치가 다를 수 있습니다.",
  relative_scale_preserved: "파츠 사이 크기 비율을 확인해 주세요.",
  relative_proportions_preserved: "파츠 사이 비율을 확인해 주세요.",
  clean_peripheral_alpha: "투명 배경의 가장자리를 확인해 주세요.",
  clean_alpha_edges: "투명 배경의 가장자리를 확인해 주세요.",
  transparent_background: "배경 투명도를 확인해 주세요.",
  transparent_background_preserved: "배경 투명도를 확인해 주세요.",
  clean_part_boundaries: "파츠 경계를 확인해 주세요.",
  semantic_separation_quality: "머리·머리카락·몸통 분리 모양을 확인해 주세요.",
  semantic_part_isolation: "다른 파츠가 섞여 있는지 확인해 주세요.",
  semantic_isolation: "다른 파츠가 섞여 있는지 확인해 주세요.",
  no_cross_part_contamination: "다른 파츠가 섞여 있는지 확인해 주세요.",
  no_hair_on_head: "머리 사진에 머리카락이 남아 있는지 확인해 주세요.",
  no_skin_in_hair: "머리카락 사진에 피부가 남아 있는지 확인해 주세요.",
  no_skin_on_hair: "머리카락 사진에 피부가 남아 있는지 확인해 주세요.",
  no_head_or_hair_on_body:
    "몸통 사진에 머리나 머리카락이 남아 있는지 확인해 주세요.",
  appearance_matches_reference: "원본과 외형이 같은지 확인해 주세요.",
  silhouette_matches_reference: "원본과 윤곽이 같은지 확인해 주세요.",
  proportions_match_reference: "원본과 비율이 같은지 확인해 주세요.",
  identity_preserved: "원본 캐릭터의 특징이 유지됐는지 확인해 주세요.",
  source_identity_preserved: "원본 캐릭터의 특징이 유지됐는지 확인해 주세요.",
  colors_preserved: "원본 색상이 유지됐는지 확인해 주세요.",
  visual_quality: "분리 이미지의 외형을 확인해 주세요.",
};
const visualKey = (name: string) =>
  name
    .toLowerCase()
    .replace(
      /^(?:separate[-_:](?:head|hair|body)[:/]|(?:head|hair|body)[:/])\s*/,
      "",
    );

export function blocksWorkbenchCheck(
  step: WorkbenchStep,
  check: WorkbenchCheck,
): boolean {
  if (
    !check ||
    typeof check.name !== "string" ||
    typeof check.passed !== "boolean"
  )
    return true;
  return (
    check.passed !== true &&
    !(
      step === "separate" &&
      Object.hasOwn(separationVisualChecks, visualKey(check.name))
    )
  );
}

export function normalizeWorkbenchChecks(
  step: WorkbenchStep,
  checks: WorkbenchCheck[],
): WorkbenchCheck[] {
  return checks.map((check) => ({
    ...check,
    ...(!check.passed
      ? {
          severity: blocksWorkbenchCheck(step, check)
            ? ("error" as const)
            : ("warning" as const),
        }
      : {}),
  }));
}

export function workbenchCheckLabel(check: WorkbenchCheck): string {
  return separationVisualChecks[visualKey(check.name)] ?? check.name;
}

export function workbenchWarningMessages(
  step: WorkbenchStep,
  checks: WorkbenchCheck[],
): string[] {
  return [
    ...new Set(
      checks
        .filter((check) => !check.passed && !blocksWorkbenchCheck(step, check))
        .map(workbenchCheckLabel),
    ),
  ];
}
