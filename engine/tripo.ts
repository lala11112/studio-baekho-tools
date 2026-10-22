import fs from "node:fs";
import path from "node:path";
export type TripoRegion = "international" | "china";
export const tripoEndpoints = {
  international: "https://openapi.tripo3d.ai/v3",
  china: "https://openapi.tripo3d.com/v3",
} as const;
export class TripoError extends Error {
  constructor(
    message: string,
    public definitive = false,
  ) {
    super(message);
  }
}
export class Tripo {
  constructor(
    private getKey: () => string,
    private transport: typeof fetch = fetch,
    private getRegion: () => TripoRegion = () => "international",
  ) {}
  async request(
    endpoint: string,
    body?: unknown,
    form?: FormData,
  ): Promise<any> {
    const key = this.getKey();
    const region = this.getRegion();
    const base = tripoEndpoints[region];
    if (!base)
      throw new TripoError("지원하지 않는 Tripo 연결 지역입니다.", true);
    if (!key) throw new TripoError("설정에서 Tripo API 키를 입력하세요.", true);
    let r: Response;
    try {
      r = await this.transport(base + endpoint, {
        method: body || form ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          ...(!form && body ? { "Content-Type": "application/json" } : {}),
        },
        body: form ?? (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(60000),
        // A redirect must not replay a paid POST, even to another provider URL.
        redirect: "error",
      });
    } catch {
      throw new TripoError(
        "네트워크 응답을 확인하지 못했습니다. 제출 요청은 자동 재시도하지 않습니다.",
      );
    }
    let json: any;
    try {
      json = await r.json();
    } catch {
      throw new TripoError(`Tripo 응답 형식 오류 (${r.status})`);
    }
    if (!r.ok || json.code !== 0)
      throw new TripoError(
        `Tripo 오류 HTTP ${r.status} / code ${String(json.code)}${r.status === 401 ? ` · ${region === "international" ? "국제(.ai)" : "중국(.com)"} 서버 인증 실패. 키를 발급한 지역과 연결 지역이 같은지 확인하세요. Client ID가 아닌 API 키가 필요합니다.` : json.code === 2010 || r.status === 402 ? " · API 크레딧을 확인하세요." : ""}`,
        (r.status >= 400 && r.status < 500) ||
          (r.ok && typeof json.code === "number"),
      );
    return json.data;
  }
  balance() {
    return this.request("/account/balance");
  }
  task(id: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("잘못된 작업 ID");
    return this.request("/tasks/" + id);
  }
  async upload(file: string) {
    const bytes = fs.readFileSync(file);
    if (bytes.length > 150 * 1024 * 1024) throw new Error("업로드 최대 150 MB");
    const form = new FormData();
    form.append("file", new Blob([bytes]), path.basename(file));
    const data = await this.request("/files", undefined, form);
    if (typeof data?.file_token !== "string" || !data.file_token.trim())
      throw new Error("유효한 파일 토큰이 없습니다.");
    return data.file_token as string;
  }
  async submit(endpoint: string, payload: unknown) {
    const data = await this.request(endpoint, payload);
    if (
      typeof data?.task_id !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(data.task_id)
    )
      throw new TripoError(
        "유효한 작업 ID 없는 제출 응답 · 자동 재제출하지 않습니다.",
      );
    return data;
  }
  async download(url: string): Promise<Uint8Array> {
    // Only HTTPS public provider storage, no credentials and no redirects to arbitrary destinations.
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      !/(^|\.)(tripo3d\.(ai|com)|amazonaws\.com|aliyuncs\.com|cloudfront\.net)$/.test(
        u.hostname,
      )
    )
      throw new Error("허용되지 않은 결과 다운로드 도메인: " + u.hostname);
    const r = await this.transport(u, {
      signal: AbortSignal.timeout(120000),
      redirect: "error",
    });
    if (!r.ok || !r.body) throw new Error("결과 다운로드 실패");
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 200 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("결과가 200 MB를 초과합니다.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}
