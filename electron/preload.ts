import { contextBridge, ipcRenderer } from "electron";
import type { Command } from "../shared/types";
import type { StudioBounds, StudioTarget } from "../shared/studio";
contextBridge.exposeInMainWorld("studio", Object.freeze({
  summary: () => ipcRenderer.invoke("studio:summary"),
  showCombat: (bounds: StudioBounds, target?: StudioTarget) => ipcRenderer.invoke("studio:show-combat", bounds, target),
  hideCombat: () => ipcRenderer.invoke("studio:hide-combat"),
  resizeCombat: (bounds: StudioBounds) => ipcRenderer.invoke("studio:resize-combat", bounds),
  chooseCombatProject: () => ipcRenderer.invoke("studio:choose-combat-project"),
}));
contextBridge.exposeInMainWorld("desktop", {
  call: async (command: Command) => {
    const r = await ipcRenderer.invoke("partsmith:command", command);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  assetUrl: (projectId: string, file: string) =>
    `asset://project/${encodeURIComponent(projectId)}/${file.split(/[\\/]/).map(encodeURIComponent).join("/")}`,
});
