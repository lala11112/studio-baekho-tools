import { contextBridge, ipcRenderer } from "electron";
import type { Command } from "../shared/types";
import type { StudioBounds, StudioTarget, StudioNativeTool } from "../shared/studio";
contextBridge.exposeInMainWorld("studio", Object.freeze({
  summary: () => ipcRenderer.invoke("studio:summary"),
  showCombat: (bounds: StudioBounds, target?: StudioTarget) => ipcRenderer.invoke("studio:show-combat", bounds, target),
  hideCombat: () => ipcRenderer.invoke("studio:hide-combat"),
  resizeCombat: (bounds: StudioBounds) => ipcRenderer.invoke("studio:resize-combat", bounds),
  chooseCombatProject: () => ipcRenderer.invoke("studio:choose-combat-project"),
  showTool: (tool: StudioNativeTool, bounds: StudioBounds, target?: StudioTarget) => ipcRenderer.invoke("studio:show-tool", tool, bounds, target),
  hideTools: () => ipcRenderer.invoke("studio:hide-tools"),
  resizeTool: (tool: StudioNativeTool, bounds: StudioBounds) => ipcRenderer.invoke("studio:resize-tool", tool, bounds),
  chooseHitTimerProject: () => ipcRenderer.invoke("studio:choose-hit-timer-project"),
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
