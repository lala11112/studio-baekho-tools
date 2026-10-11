import type { WorkbenchCheck, WorkbenchStep } from "./workbench";

// This is an explicit compatibility list, not a general worker-controlled severity override.
// File integrity, missing parts, role validity and duplicate files stay blocking.
// Surface currently requests base color, not a separate PBR channel-generation operation.
const surfaceReviewChecks: Record<string,string> = {
  visual_review: "모델 표면의 외형을 확인해 주세요.",
  native_texture_channels: "서비스에서 제공한 텍스처 채널을 확인해 주세요.",
};
// Provider targets describe desired density/topology, not file validity. Keep
// these measured deviations false and visible; never accept arbitrary warnings.
const modelTargetChecks: Record<string,string> = {
  model_polygon_target: "목표와 실제 면 수를 확인해 주세요.",
  model_quad_ratio: "쿼드와 삼각형의 실제 구성을 확인해 주세요.",
  "정확한 목표 면 수": "목표와 실제 면 수를 확인해 주세요.",
  "전체 쿼드": "쿼드와 삼각형의 실제 구성을 확인해 주세요.",
};
const isModelTargetReview = (check: WorkbenchCheck) =>
  Object.hasOwn(modelTargetChecks, check.name) &&
  check.severity === "warning" && check.visualCategory === undefined &&
  !!check.detail?.trim();
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
      /^(?:separate[-_:](?:head|hair|body)(?:[-_](?:front|back|left|right))?[:/]|(?:head|hair|body)[:/])\s*/,
      "",
    );
const visualCategories: Record<
  NonNullable<WorkbenchCheck["visualCategory"]>,
  string
> = {
  alignment: "원본과 크기·정렬·비율을 확인해 주세요.",
  alpha_edges: "투명 배경과 파츠 가장자리를 확인해 주세요.",
  appearance: "원본과 외형이 같은지 확인해 주세요.",
  view_consistency: "방향별 형태와 비율이 자연스럽게 이어지는지 확인해 주세요.",
  semantic_isolation: "다른 파츠가 섞여 있는지 확인해 주세요.",
};
// Older workers invented view-specific labels for visual judgement. Compatibility is
// deliberately limited to subjective image appearance, never file or geometry validity.
const legacyViewObservation =
  /^(front|back|left|right)(?:_view)?_(geometry|appearance|silhouette|anatomy|proportions)_(convincing|consistent|matches_reference)$/;
const isVisualObservation = (check: WorkbenchCheck) => {
  const key = visualKey(check.name);
  if (check.visualCategory !== undefined)
    return (
      key === "visual_quality" &&
      Object.hasOwn(visualCategories, check.visualCategory)
    );
  return (
    Object.hasOwn(separationVisualChecks, key) ||
    legacyViewObservation.test(key)
  );
};
const isAssemblyAppearanceReview = (check: WorkbenchCheck) =>
  (check.name === "visual_quality" || check.name === "remaining_visual_limits") &&
  (check.visualCategory === undefined || check.visualCategory === "appearance");
// A completed FK rig can have a documented motion range for user review.
// This compatibility warning never substitutes for the separate skin/pose checks.
const isRigLimitsReview = (check: WorkbenchCheck) =>
  check.name === "remaining_limitations" && check.severity === "warning" &&
  check.visualCategory === undefined;
const isReferenceVisualReview = (check: WorkbenchCheck) =>
  check.name === "visual_quality" &&
  ["appearance", "alignment", "view_consistency"].includes(check.visualCategory ?? "");

export function blocksWorkbenchCheck(
  step: WorkbenchStep,
  check: WorkbenchCheck,
): boolean {
  if (
    !check ||
    typeof check.name !== "string" ||
    typeof check.passed !== "boolean" ||
    (check.detail !== undefined &&
      (typeof check.detail !== "string" || check.detail.length > 600)) ||
    (check.visualCategory !== undefined &&
      !(["assembly", "animation", "reference"].includes(step)
        ? Object.hasOwn(visualCategories, check.visualCategory)
        : isVisualObservation(check)))
  )
    return true;
  return (
    check.passed !== true &&
    !(step === "model" && isModelTargetReview(check)) &&
    !(step === "rig" && isRigLimitsReview(check)) &&
    !(step === "reference" && isReferenceVisualReview(check)) &&
    !(step === "assembly" && isAssemblyAppearanceReview(check)) &&
    !(step === "animation" && check.name === "visual_quality" && check.visualCategory === "appearance") &&
    !(step === "separate" && isVisualObservation(check)) &&
    !(step === "surface" && (Object.hasOwn(surfaceReviewChecks,check.name) ||
      (check.name === "visual_quality" && check.visualCategory === "appearance")))
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
  const key = visualKey(check.name);
  const legacyView = legacyViewObservation.exec(key);
  const directionNames: Record<string, string> = {
    front: "정면",
    back: "후면",
    left: "왼쪽",
    right: "오른쪽",
  };
  const label =
    check.visualCategory &&
    Object.hasOwn(visualCategories, check.visualCategory)
      ? visualCategories[check.visualCategory]
      : ((key === "remaining_limitations" ? "리깅 제어 방식과 관절 변형 범위를 확인해 주세요." : undefined) ?? modelTargetChecks[key] ?? surfaceReviewChecks[key] ?? separationVisualChecks[key] ??
        (legacyView
          ? `${directionNames[legacyView[1]]} 사진의 형태·비율을 확인해 주세요.`
          : check.name));
  return check.detail?.trim() ? `${label} ${check.detail.trim()}` : label;
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
