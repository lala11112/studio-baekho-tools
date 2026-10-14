import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import fs from "node:fs";
import path from "node:path";
import { BgmService } from "../engine/bgm";
import type { BgmInput } from "../shared/bgm";
import { serveBgmMedia } from "./bgm-media";

export function installBgmHost(window: BrowserWindow, root: string) {
  // Open BGM storage only when used: a damaged ledger must not block other tools.
  let service: BgmService | undefined;
  const getService = () => service ??= new BgmService({ root: path.join(root, "bgm"), getKey: () => process.env.FAL_KEY });
  protocol.handle("bgm-media", request => serveBgmMedia(request, id => getService().localFile(id)));
  const handlers = {
    state: () => getService().state(),
    generate: (input: BgmInput) => getService().generate(input),
    refresh: (id: string) => getService().refresh(id),
    retry: (id: string) => getService().retry(id),
    select: (id: string) => getService().select(id),
    export: async (id: string) => {
      const file = getService().localFile(id);
      const candidate = getService().state().candidates.find(c => c.id === id)!;
      const result = await dialog.showSaveDialog(window, {
        title: "선택한 BGM 내보내기",
        defaultPath: path.join(app.getPath("downloads"), `BGM-${candidate.createdAt.slice(0, 10)}-${candidate.index}.mp3`),
        filters: [{ name: "MP3 오디오", extensions: ["mp3"] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const destination = result.filePath.toLowerCase().endsWith(".mp3") ? result.filePath : `${result.filePath}.mp3`;
      fs.copyFileSync(file, destination);
      return { canceled: false, path: destination };
    },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`bgm:${name}`, async (event, argument: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        return { ok: false, error: "허용되지 않은 호출자" };
      }
      try {
        const value = await (handler as (argument: unknown) => unknown)(argument);
        return { ok: true, value };
      } catch (error) {
        const raw = error instanceof Error ? error.message : "BGM 작업을 완료하지 못했습니다.";
        const key = process.env.FAL_KEY;
        return { ok: false, error: key ? raw.split(key).join("[REDACTED]") : raw };
      }
    });
  }
  return { getService };
}
