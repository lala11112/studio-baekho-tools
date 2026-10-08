// Endpoint-specific official documentation, checked 2026-10-08. Account entitlement is NOT implied.
export const catalog = {
  checkedAt: "2026-10-08",
  accountVerified: false,
  image: [
    { id: "seedream_v5", label: "Seedream v5", sizes: ["2K", "3K"] },
    { id: "banana2", label: "Banana 2", sizes: ["1K", "2K", "4K"] },
    {
      id: "chat_image_2",
      label: "Chat Image 2",
      sizes: ["1024x1024", "1024x1536", "2048x2048"],
    },
  ],
  model: [
    { id: "P2-20260801", label: "Smart Mesh P2.0 · Preview" },
    { id: "P1-20260311", label: "Smart Mesh P1" },
    { id: "v3.1-20260211", label: "Tripo H v3.1" },
    { id: "v3.0-20250812", label: "Tripo H v3.0" },
  ],
  rig: [{ id: "v1.0-20240301", label: "Tripo Humanoid / Mixamo" }],
  segment: [
    { id: "v2.0-20260430", label: "Semantic v2 · Beta" },
    { id: "v1.0-20250506", label: "Segment v1" },
  ],
  retopology: [
    { id: "v2.0", label: "Smart Retopology v2" },
    { id: "v1.0", label: "Standard Retopology v1" },
  ],
  texture: [
    { id: "v3.5-20260815", label: "Texture v3.5" },
    { id: "v3.0-20250812", label: "Texture v3.0" },
    { id: "v2.5-20250123", label: "Texture v2.5" },
  ],
  animation: [
    { id: "preset:biped:idle", label: "대기 (Idle)" },
    { id: "preset:biped:walk", label: "걷기 (Walk)" },
  ],
  sources: [
    "https://developers.tripo3d.ai/en/docs/generation-text-to-image",
    "https://developers.tripo3d.ai/en/docs/generation-image-to-image",
    "https://developers.tripo3d.ai/en/docs/generation-image-to-model/p",
    "https://developers.tripo3d.ai/en/docs/mesh-segment",
    "https://developers.tripo3d.ai/en/docs/tripo-cli",
    "https://developers.tripo3d.ai/en/docs/mesh-complete",
    "https://developers.tripo3d.ai/en/docs/mesh-decimate",
    "https://developers.tripo3d.ai/en/docs/models-convert",
    "https://developers.tripo3d.ai/en/docs/models-texture",
    "https://developers.tripo3d.ai/en/docs/animations-rig",
  ],
  note: "공식 문서에 등재된 모델입니다. 계정별 허용 모델을 조회하는 API는 확인되지 않았습니다. 승인한 첫 요청의 응답으로 접근 여부를 확인합니다.",
};
