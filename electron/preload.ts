import { contextBridge, ipcRenderer } from "electron";
import type { Command } from "../shared/types";
contextBridge.exposeInMainWorld("desktop", {
  call: async (command: Command) => {
    const r = await ipcRenderer.invoke("partsmith:command", command);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  assetUrl: (projectId: string, file: string) =>
    `asset://project/${encodeURIComponent(projectId)}/${file.split(/[\\/]/).map(encodeURIComponent).join("/")}`,
});
