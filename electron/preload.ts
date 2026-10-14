import { contextBridge, ipcRenderer } from "electron";
import type { Command } from "../shared/types";
import type { StudioBounds, StudioTarget, StudioNativeTool } from "../shared/studio";
import type { BgmInput } from "../shared/bgm";
import type { FourTigerItemsApi } from "../shared/four-tiger-items";
async function bgmCall(name: string, argument?: unknown) {
  const result = await ipcRenderer.invoke(`bgm:${name}`, argument);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld("bgm", Object.freeze({
  state: () => bgmCall("state"),
  generate: (input: BgmInput) => bgmCall("generate", input),
  refresh: (id: string) => bgmCall("refresh", id),
  retry: (id: string) => bgmCall("retry", id),
  select: (id: string) => bgmCall("select", id),
  export: (id: string) => bgmCall("export", id),
}));
const itemMethods: (keyof FourTigerItemsApi)[] = ['list','create','read','patchItem','reviewItems','updatePolicies','adoptPolicies','acknowledgeDescription','repairReferenceIds','updateIconStyle','generateIcons','cancelPending','reconcile','abandonUnknown','selectIcon','readIcon','validate','exportPackage','probe','restorePrevious'];
contextBridge.exposeInMainWorld('fourTigerItems',Object.freeze(Object.fromEntries(itemMethods.map(method=>[method,async(input:unknown)=>{const result=await ipcRenderer.invoke(`four-tiger-items:${method}`,input);if(!result.ok)throw Object.assign(new Error(result.error),{code:result.code});return result.value;}]))));
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
