import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeGraphicsNative } from "./graphics-native";
import { CodexRunwayConnection } from "./runway-client";
import { runProcess } from "./local";
import { readUnityTarget } from "./graphics-unity";
import type { Tripo } from "./tripo";
import type { Settings } from "../shared/types";
import type { GraphicsWorkspace } from "../shared/graphics";

/** Read-only capability/account metadata. There is deliberately no generation turn or submit method here. */
export async function probeGraphicsConnections(settings: Settings, tripo: Tripo, keyConfigured: boolean): Promise<NonNullable<GraphicsWorkspace["connections"]>> {
  const item = (name: string, available: boolean, message: string) => ({ name, available, message, checkedAt: new Date().toISOString() });
  const checked = await Promise.allSettled([
    (async () => { const r = await probeGraphicsNative(); return item("Codex 이미지", r.available && r.imageGeneration && r.authenticated, r.message); })(),
    (async () => {
      if (!keyConfigured) return item("Tripo API", false, "앱 설정에서 국제/중국 지역에 맞는 API 키를 연결하세요. Studio 구독 크레딧과 별도입니다.");
      try { const r = await tripo.balance(); return item("Tripo API", true, `계정 인증 확인 · API 잔액 ${typeof r.balance === "number" ? r.balance : "미확인"}크레딧. 이 진단은 생성·결제를 실행하지 않습니다. 작업별 비용은 실행 카드에서 확인하세요.`); }
      catch (e) { return item("Tripo API", false, e instanceof Error ? e.message : "API 인증 확인 실패"); }
    })(),
    (async () => {
      const connection = new CodexRunwayConnection(), controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        await connection.open(os.tmpdir(), controller.signal, async () => ({ accepted: false, values: {} }));
        const account = await connection.call("whoami", { rationale: "Partsmith 연결 진단: 계정 인증·모델 목록만 확인. 업로드·생성·결제 없음." });
        return item("Runway", account.authenticated === true, account.authenticated ? `계정 연결 확인 · 잔액 ${Number.isFinite(account.credits?.total) ? account.credits.total : "미확인"} · N02에서 측면 원본·비용을 확인한 뒤 실행합니다. 이 진단은 업로드·생성을 하지 않습니다.` : "Runway 플러그인 계정 로그인이 필요합니다.");
      } catch { return item("Runway", false, "계정 메타데이터를 확인하지 못했습니다. 플러그인 로그인/권한을 확인하세요. 자동 재시도·생성은 하지 않았습니다."); }
      finally { clearTimeout(timer); connection.close(); }
    })(),
    (async () => {
      if (!fs.existsSync(settings.blenderPath)) return item("Blender", false, "앱 설정에서 Blender 실행 파일을 선택하세요.");
      const version = (await runProcess(settings.blenderPath, ["--version"], 15000)).split(/\r?\n/)[0];
      return item("Blender", true, `${version} · 로컬 실행 파일 확인. 실행 중인 Blender 장면은 변경하지 않았습니다.`);
    })(),
    (async () => {
      try { const p = readUnityTarget(settings.unityPath); return item("Unity", true, `${p.unityVersion} · ${p.pipeline.toUpperCase()} · PC. 실제 에셋 가져오기와 표시는 별도 검사입니다.`); }
      catch { return item("Unity", false, "앱 설정에서 Unity 프로젝트를 연결하세요."); }
    })(),
  ]);
  const names = ["Codex 이미지", "Tripo API", "Runway", "Blender", "Unity"];
  return checked.map((r, index) => r.status === "fulfilled" ? r.value : item(names[index], false, "연결 확인을 완료하지 못했습니다. 생성은 실행하지 않았습니다."));
}
