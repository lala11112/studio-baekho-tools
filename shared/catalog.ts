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
    { id: "v3.1-20260211", label: "Tripo H v3.1" },
    { id: "v3.0-20250812", label: "Tripo H v3.0" },
  ],
  rig: [{ id: "v1.0-20240301", label: "Tripo Humanoid / Mixamo" }],
  sources: [
    "https://developers.tripo3d.com/en/docs/generation-text-to-image",
    "https://developers.tripo3d.com/en/docs/generation-image-to-image",
    "https://developers.tripo3d.com/en/docs/generation-image-to-model/standard",
    "https://developers.tripo3d.com/en/docs/animations-rig",
  ],
  note: "공식 문서에 등재된 모델입니다. 계정별 허용 모델을 조회하는 API는 확인되지 않았습니다. 승인한 첫 요청의 응답으로 접근 여부를 확인합니다.",
};
