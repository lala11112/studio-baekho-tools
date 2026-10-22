import { ipcMain, type BrowserWindow } from "electron";
import { FourTigerError } from "../shared/four-tiger-items";
import {
  FourTigerItemsService,
  executeFourTigerCall,
  fourTigerMethodSchemas,
} from "../engine/four-tiger-items/service";
export function installFourTigerItemsIpc(
  window: BrowserWindow,
  service: FourTigerItemsService,
): () => void {
  const channels = Object.keys(fourTigerMethodSchemas).map((method) => {
    const channel = `four-tiger-items:${method}`;
    ipcMain.handle(channel, async (event, input: unknown) => {
      try {
        return {
          ok: true,
          value: await executeFourTigerCall(
            service,
            method,
            input,
            event.sender === window.webContents &&
              event.senderFrame === window.webContents.mainFrame,
          ),
        };
      } catch (error) {
        return {
          ok: false,
          code: error instanceof FourTigerError ? error.code : "IO_ERROR",
          error:
            error instanceof FourTigerError
              ? error.message
              : "작업을 완료하지 못했습니다. 저장된 초안을 확인하세요.",
        };
      }
    });
    return channel;
  });
  return () => channels.forEach((channel) => ipcMain.removeHandler(channel));
}
