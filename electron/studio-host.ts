import { app, dialog, ipcMain, WebContentsView, type BrowserWindow, type WebContents, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { createRequire } from "node:module";
import { buildStudioSummary, type CombatSummary, type SummaryInput } from "../engine/studio-summary";
import { fitStudioBounds } from "./studio-bounds";
import type { StudioBounds, StudioTarget } from "../shared/studio";

interface CombatService {
  initialize(): void;
  getSummary(): CombatSummary;
  chooseProject(): Promise<void>;
  navigate(target: { runId?: string; tab?: string; projectPath?: string }): void;
  setVisible(visible: boolean): void;
  hasActiveWork(): boolean;
  shutdown(): void;
}
type CombatFactory = (options: { getWindow: () => BrowserWindow; getWebContents: () => WebContents | undefined; settingsPath: string; legacySettingsPath?: string }) => CombatService;

/** The host owns navigation; the two tools keep their own APIs, state and files. */
export function installStudioHost(options: {
  window: BrowserWindow;
  root: string;
  modeling: () => Pick<SummaryInput, "projects" | "workbenches" | "productionRuns">;
  modelingBusy: () => boolean;
}) {
  const { window: win } = options;
  const require = createRequire(__filename);
  const { createCombatService } = require(path.join(app.getAppPath(), "Desktop/src/main.cjs")) as { createCombatService: CombatFactory };
  let view: WebContentsView | undefined;
  let loading: Promise<void> | undefined;
  let intent = 0;
  let visible = false;
  let disposed = false;
  let crash = "";
  let bounds: StudioBounds | undefined;
  const settingsPath = path.join(options.root, "combat-lab", "settings.json");
  const combat = createCombatService({
    getWindow: () => win,
    getWebContents: () => view?.webContents,
    settingsPath,
    legacySettingsPath: process.env.PARTSMITH_DATA || process.env.BAEKHO_DATA ? undefined : path.join(app.getPath("appData"), "Baekho Studio", "settings.json"),
  });
  combat.initialize();

  function layout() {
    if (!view || !bounds || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    // A minimized Windows window can report a zero-sized client area.
    // Keep the renderer geometry and apply it again when the window restores.
    if (width <= 0 || height <= 0 || win.isMinimized()) return;
    view.setBounds(fitStudioBounds(bounds, width, height));
  }
  function hide() {
    visible = false;
    ++intent;
    view?.setVisible(false);
    combat.setVisible(false);
  }
  async function show(rawBounds: unknown, target?: StudioTarget) {
    bounds = fitStudioBounds(rawBounds, 100000, 100000);
    if (target && (target.tool !== "combat" || (target.runId !== undefined && (typeof target.runId !== "string" || target.runId.length > 200)) || (target.projectPath !== undefined && (typeof target.projectPath !== "string" || target.projectPath.length > 32767)) || (target.tab !== undefined && !["setup", "compare"].includes(target.tab)))) throw new Error("타격감 작업 위치가 올바르지 않습니다.");
    visible = true;
    const thisIntent = ++intent;
    if (!view) {
      const created = new WebContentsView({ webPreferences: { preload: path.join(app.getAppPath(), "Desktop/src/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
      view = created;
      win.contentView.addChildView(created);
      created.setVisible(false);
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      created.webContents.on("will-navigate", event => event.preventDefault());
      created.webContents.on("will-attach-webview", event => event.preventDefault());
      created.webContents.on("render-process-gone", () => {
        crash = "타격감 화면이 종료되었습니다. 도구를 다시 열어주세요. 저장된 결과는 그대로 남아 있습니다.";
        if (view === created) { view = undefined; loading = undefined; }
        if (!created.webContents.isDestroyed()) created.webContents.close();
        if (!win.isDestroyed()) win.contentView.removeChildView(created);
      });
      loading = created.webContents.loadURL("baekho://app/index.html?embedded=1").catch(error => {
        if (view === created) { view = undefined; loading = undefined; }
        if (!created.webContents.isDestroyed()) created.webContents.close();
        if (!win.isDestroyed()) win.contentView.removeChildView(created);
        throw error;
      });
    }
    await loading;
    if (disposed || !visible || thisIntent !== intent || !view) return;
    crash = "";
    if (target) combat.navigate(target);
    layout();
    view.setVisible(true);
    combat.setVisible(true);
  }
  function trusted(event: IpcMainInvokeEvent) {
    if (disposed || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("허용되지 않은 백호툴 요청입니다.");
  }
  const channels = ["summary", "show-combat", "hide-combat", "resize-combat", "choose-combat-project"];
  ipcMain.handle("studio:summary", event => {
    trusted(event);
    const warnings = crash ? [crash] : [];
    let snapshot: CombatSummary;
    try { snapshot = combat.getSummary(); }
    catch (error) {
      const message = error instanceof Error ? error.message : "기록을 읽지 못했습니다.";
      warnings.push(`타격감 기록 확인 필요: ${message}`);
      snapshot = { projectName: "", projectPath: "", connection: { error: message }, generating: false, runs: [] };
    }
    return buildStudioSummary({ ...options.modeling(), version: app.getVersion(), combat: snapshot, storage: { modeling: options.root, combat: path.dirname(settingsPath) }, warnings });
  });
  ipcMain.handle("studio:show-combat", (event, rectangle, target) => { trusted(event); return show(rectangle, target); });
  ipcMain.handle("studio:hide-combat", event => { trusted(event); hide(); });
  ipcMain.handle("studio:resize-combat", (event, rectangle) => {
    trusted(event);
    bounds = fitStudioBounds(rectangle, 100000, 100000);
    layout();
  });
  ipcMain.handle("studio:choose-combat-project", event => { trusted(event); return combat.chooseProject(); });
  win.on("resize", layout);
  win.on("restore", layout);
  win.on("show", layout);
  let allowClose = false;
  let closePrompt = false;
  win.on("close", event => {
    if (allowClose || disposed || (!combat.hasActiveWork() && !options.modelingBusy())) return;
    event.preventDefault();
    if (closePrompt) return;
    closePrompt = true;
    void dialog.showMessageBox(win, { type: "warning", title: "진행 중인 작업이 있습니다", message: "백호툴을 종료할까요?", detail: "앱을 종료하면 로컬 작업은 중단됩니다. 이미 제출한 원격 작업이나 Unity 실행은 계속될 수 있습니다. 저장된 결과는 유지됩니다.", buttons: ["계속 작업", "앱 종료"], defaultId: 0, cancelId: 0 }).then(({ response }) => { closePrompt = false; if (response === 1) { allowClose = true; win.close(); } });
  });
  function shutdown() {
    if (disposed) return;
    disposed = true;
    hide();
    combat.shutdown();
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    view = undefined;
    for (const channel of channels) ipcMain.removeHandler(`studio:${channel}`);
  }
  win.on("closed", shutdown);
  return { shutdown };
}
