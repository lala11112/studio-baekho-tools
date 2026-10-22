export const BGM_MODEL = "fal-ai/lyria3";
export const BGM_PRICE_USD = 0.04;
export const BGM_PRICE_CHECKED = "2026-10-14";
export const BGM_GENRES = ["오케스트라", "국악 퓨전", "앰비언트", "로파이", "전자음악", "록", "재즈", "어쿠스틱"] as const;
export const BGM_MOODS = ["평온", "긴장", "웅장", "신비", "슬픔", "희망", "경쾌", "어둠"] as const;
export type BgmStatus = "submitting" | "queued" | "generating" | "download-pending" | "ready" | "failed" | "uncertain";
export interface BgmInput { genres: string[]; moods: string[]; description: string }
export interface BgmCandidate {
  id: string; batchId: string; index: number; prompt: string; status: BgmStatus;
  requestId?: string; error?: string; createdAt: string;
  estimatedCostUsd: number; previewUrl?: string; canRetry?: boolean;
}
export interface BgmState {
  configured: boolean; credentialSource: string; storageRoot: string;
  model: string; priceUsd: number; priceCheckedAt: string;
  totalReservedUsd: number; budgetUsd: number;
  candidates: BgmCandidate[]; selectedId?: string;
}
export interface BgmApi {
  state(): Promise<BgmState>;
  generate(input: BgmInput): Promise<BgmState>;
  refresh(id: string): Promise<BgmState>;
  retry(id: string): Promise<BgmState>;
  select(id: string): Promise<BgmState>;
  export(id: string): Promise<{ canceled: boolean; path?: string }>;
}
declare global { interface Window { bgm: BgmApi } }
