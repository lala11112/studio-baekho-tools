import { app, dialog, ipcMain, WebContentsView, type BrowserWindow, type WebContents, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { createRequire } from "node:module";
import { buildStudioSummary, type CombatSummary, type HitTimerSummary, type SummaryInput } from "../engine/studio-summary";
import { fitStudioBounds } from "./studio-bounds";
import type { StudioBounds, StudioTarget, StudioNativeTool } from "../shared/studio";

interface NativeService<T> {
  initialize(): void;
  activate?(): Promise<void>;
  getSummary(): T;
  chooseProject(): Promise<void>;
  navigate(target: StudioTarget): void | Promise<void>;
  setVisible(visible: boolean): void;
  hasActiveWork(): boolean;
  shutdown(): void | Promise<void>;
}
type WindowAccess = { getWindow: () => BrowserWindow; getWebContents: () => WebContents | undefined };
type CombatFactory = (o: WindowAccess & { settingsPath: string; legacySettingsPath?: string }) => NativeService<CombatSummary>;
type HitTimerFactory = (o: WindowAccess & { dataRoot: string; legacyDataRoot?: string; kitRoot: string }) => NativeService<HitTimerSummary>;
type Entry = { service: NativeService<unknown>; label: string; preload: string; url: string; tabs: string[]; view?: WebContentsView; loading?: Promise<void>; bounds?: StudioBounds; crash: string };

/** One visible native workspace; each hidden workspace retains its own state. */
export function installStudioHost(options: { window: BrowserWindow; root: string; modeling: () => Pick<SummaryInput, "projects" | "workbenches" | "productionRuns">; modelingBusy: () => boolean; itemProjects:()=>Promise<NonNullable<SummaryInput['itemProjects']>>; itemsBusy:()=>boolean }) {
  const win = options.window;
  const require = createRequire(__filename);
  const { createCombatService } = require(path.join(app.getAppPath(), "Desktop/src/main.cjs")) as { createCombatService: CombatFactory };
  const { createAutoHitTimerService } = require(path.join(app.getAppPath(), "Apps/AutoHitTimer/src/main.cjs")) as { createAutoHitTimerService: HitTimerFactory };
  const entries = {} as Record<StudioNativeTool, Entry>;
  let intent = 0, disposed = false;
  let visibleTool: StudioNativeTool | null = null;
  let shutdownPromise: Promise<void> | undefined;
  const settingsPath = path.join(options.root, "combat-lab", "settings.json");
  const hitTimerRoot = path.join(options.root, "auto-hit-timer");
  const isolated = !!(process.env.PARTSMITH_DATA || process.env.BAEKHO_DATA);
  const combat = createCombatService({
    getWindow: () => win, getWebContents: () => entries.combat?.view?.webContents, settingsPath,
    legacySettingsPath: isolated ? undefined : path.join(app.getPath("appData"), "Baekho Studio", "settings.json"),
  });
  const hitTimer = createAutoHitTimerService({
    getWindow: () => win, getWebContents: () => entries["hit-timing"]?.view?.webContents, dataRoot: hitTimerRoot,
    legacyDataRoot: isolated ? undefined : path.join(app.getPath("appData"), "StudioBaekho", "AutoHitTimer"),
    kitRoot: app.isPackaged ? path.join(process.resourcesPath, "auto-hit-timer-kit") : app.getAppPath(),
  });
  entries.combat = { service: combat, label: "타격감", preload: "Desktop/src/preload.cjs", url: "baekho://app/index.html?embedded=1", tabs: ["setup", "compare"], crash: "" };
  entries["hit-timing"] = { service: hitTimer, label: "타격 타이밍", preload: "Apps/AutoHitTimer/src/preload.cjs", url: "aht://app/index.html?embedded=1", tabs: ["hits", "save"], crash: "" };
  combat.initialize(); hitTimer.initialize();

  function entryFor(tool: unknown): Entry {
    if (tool !== "combat" && tool !== "hit-timing") throw new Error("지원하지 않는 작업 도구입니다.");
    return entries[tool];
  }
  function layout() {
    if (win.isDestroyed() || win.isMinimized()) return;
    const [width, height] = win.getContentSize();
    if (width <= 0 || height <= 0) return;
    for (const entry of Object.values(entries))
      if (entry.view && entry.bounds) entry.view.setBounds(fitStudioBounds(entry.bounds, width, height));
  }
  function hideAll() {
    visibleTool = null; ++intent;
    for (const entry of Object.values(entries)) { entry.view?.setVisible(false); entry.service.setVisible(false); }
  }
  async function show(tool: StudioNativeTool, rawBounds: unknown, target?: StudioTarget) {
    const entry = entryFor(tool), bounds = fitStudioBounds(rawBounds, 100000, 100000);
    if (target && (target.tool !== tool || [target.runId, target.jobId].some(id => id !== undefined && (typeof id !== "string" || id.length > 200)) || (target.projectPath !== undefined && (typeof target.projectPath !== "string" || target.projectPath.length > 32767)) || (target.tab !== undefined && !entry.tabs.includes(target.tab)))) throw new Error("작업 위치가 올바르지 않습니다. 목록을 새로고침하세요.");
    hideAll(); entry.bounds = bounds; visibleTool = tool;
    const thisIntent = ++intent;
    if (!entry.view) {
      const created = new WebContentsView({ webPreferences: { preload: path.join(app.getAppPath(), entry.preload), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
      entry.view = created; win.contentView.addChildView(created); created.setVisible(false);
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      created.webContents.on("will-navigate", e => e.preventDefault());
      created.webContents.on("will-attach-webview", e => e.preventDefault());
      const discard = () => {
        if (entry.view === created) { entry.view = undefined; entry.loading = undefined; }
        if (!created.webContents.isDestroyed()) created.webContents.close();
        if (!win.isDestroyed()) win.contentView.removeChildView(created);
      };
      created.webContents.on("render-process-gone", () => { entry.crash = entry.label + " 화면이 종료되었습니다. 다시 열어주세요. 저장된 결과는 남아 있습니다."; discard(); });
      entry.loading = created.webContents.loadURL(entry.url).catch(error => { discard(); throw error; });
    }
    await Promise.all([entry.loading, entry.service.activate?.()]);
    if (disposed || visibleTool !== tool || thisIntent !== intent || !entry.view) return;
    if (target) await entry.service.navigate(target);
    if (disposed || visibleTool !== tool || thisIntent !== intent || !entry.view) return;
    entry.crash = ""; layout(); entry.view.setVisible(true); entry.service.setVisible(true);
  }
  function trusted(event: IpcMainInvokeEvent) {
    if (disposed || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("허용되지 않은 백호툴 요청입니다.");
  }
  const channels: string[] = [];
  function handle(name: string, callback: (...args: any[]) => unknown) {
    const channel = "studio:" + name; channels.push(channel);
    ipcMain.handle(channel, (event, ...args) => { trusted(event); return callback(...args); });
  }
  function resize(tool: StudioNativeTool, rectangle: unknown) { entryFor(tool).bounds = fitStudioBounds(rectangle, 100000, 100000); layout(); }
  handle("summary", async () => {
    const warnings = Object.values(entries).map(e => e.crash).filter(Boolean);
    let combatSnapshot: CombatSummary, hitSnapshot: HitTimerSummary;
    try { combatSnapshot = combat.getSummary(); }
    catch (error) {
      const message = error instanceof Error ? error.message : "기록을 읽지 못했습니다.";
      warnings.push("타격감 기록 확인 필요: " + message);
      combatSnapshot = { projectName: "", projectPath: "", connection: { error: message }, generating: false, runs: [] };
    }
    try { hitSnapshot = hitTimer.getSummary(); }
    catch (error) {
      const message = error instanceof Error ? error.message : "기록을 읽지 못했습니다.";
      warnings.push("타격 타이밍 기록 확인 필요: " + message);
      hitSnapshot = { projectName: "", projectPath: "", connected: false, busy: false, error: message, jobs: [] };
    }
    let itemProjects:NonNullable<SummaryInput['itemProjects']>=[];
    try{itemProjects=await options.itemProjects();}catch{warnings.push('사인검 아이템 기록 확인 필요');}
    return buildStudioSummary({ ...options.modeling(), itemProjects, version: app.getVersion(), combat: combatSnapshot, hitTimer: hitSnapshot, storage: { modeling: options.root, combat: path.dirname(settingsPath), hitTimer: hitTimerRoot, fourTigerItems:path.join(options.root,'four-tiger-items') }, warnings });
  });
  handle("show-tool", show); handle("hide-tools", hideAll); handle("resize-tool", resize);
  // Compatibility for existing 0.7 diagnostics.
  handle("show-combat", (bounds, target) => show("combat", bounds, target));
  handle("hide-combat", () => { if (visibleTool === "combat") hideAll(); });
  handle("resize-combat", bounds => resize("combat", bounds));
  handle("choose-combat-project", () => combat.chooseProject());
  handle("choose-hit-timer-project", () => hitTimer.chooseProject());
  win.on("resize", layout); win.on("restore", layout); win.on("show", layout);
  let allowClose = false, closePrompt = false;
  win.on("close", event => {
    if (allowClose || disposed || (!combat.hasActiveWork() && !hitTimer.hasActiveWork() && !options.modelingBusy() && !options.itemsBusy())) return;
    event.preventDefault(); if (closePrompt) return; closePrompt = true;
    void dialog.showMessageBox(win, { type: "warning", title: "진행 중인 작업이 있습니다", message: "백호툴을 종료할까요?", detail: "로컬 분석을 중단하고 저장된 초안을 유지합니다. 이미 제출한 원격 작업이나 Unity 저장은 계속될 수 있으며 결과는 다음 연결에서 확인합니다.", buttons: ["계속 작업", "앱 종료"], defaultId: 0, cancelId: 0 })
      .then(({ response }) => { closePrompt = false; if (response === 1) { allowClose = true; win.close(); } }).catch(() => { closePrompt = false; });
  });
  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    disposed = true; hideAll();
    for (const entry of Object.values(entries)) { if (entry.view && !entry.view.webContents.isDestroyed()) entry.view.webContents.close(); entry.view = undefined; }
    for (const channel of channels) ipcMain.removeHandler(channel);
    shutdownPromise = Promise.allSettled(Object.values(entries).map(entry => Promise.resolve().then(() => entry.service.shutdown()))).then(results => {
      if (results.some(result => result.status === "rejected")) throw new Error("작업 정리 중 일부 오류가 발생했습니다. 다음 실행에서 저장 상태를 확인하세요.");
    });
    return shutdownPromise;
  }
  return { shutdown };
}
