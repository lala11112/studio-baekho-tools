import { app, BrowserWindow, type DownloadItem } from "electron";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  STUDIO_URL,
  STUDIO_TOOLS,
  StudioLedger,
  chargedActionPattern,
  creditFromLabel,
  guardedPath,
  isLoginUrl,
  isStudioUrl,
  userActionPattern,
  writeJson,
  type StudioRunContext,
} from "./studio-policy";
import type { WorkerConnectionContext } from "../engine/codex-worker";

type Control = {
  index: number;
  tag: string;
  role: string;
  type: string;
  label: string;
  disabled: boolean;
  navigation: boolean;
  fileIndex?: number;
  accept?: string;
  options?: { value: string; label: string }[];
};
type Snapshot = {
  snapshotId: string;
  url: string;
  text: string;
  controls: Control[];
  requiresInput: boolean;
  reason?: string;
  screenshot?: string;
};
type Download = {
  id: string;
  runId: string;
  stageId: string;
  attempt: number;
  file: string;
  sourcePage: string;
  sourceOrigin: string;
  state: string;
  bytes?: number;
  sha256?: string;
  error?: string;
};
type Bound = { id: string; nodes: Element[]; labels: string[] };

// These functions run only in a fixed isolated world. Callers cannot provide JS,
// selectors, arbitrary URLs, cookie access or network requests.
function collect(id: string) {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth &&
      s.visibility !== "hidden" &&
      s.display !== "none"
    );
  };
  const label = (el: Element) =>
    (
      el.getAttribute("aria-label") ||
      (el as HTMLElement).innerText ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.tagName
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600);
  const fileInputs = Array.from(
    document.querySelectorAll('input[type="file"]'),
  );
  const nodes = Array.from(
    document.querySelectorAll(
      'button,a,input,textarea,select,[role="button"],[role="tab"],[role="option"],[role="combobox"],[role="checkbox"],[role="radio"],summary,[contenteditable="true"],[role="menuitem"]',
    ),
  ).filter((el) => visible(el) || fileInputs.includes(el));
  for (const el of document.querySelectorAll("div,section,aside,main")) {
    if (
      visible(el) &&
      el.scrollHeight > el.clientHeight + 50 &&
      /auto|scroll/.test(getComputedStyle(el).overflowY) &&
      !nodes.includes(el)
    )
      nodes.push(el);
  }
  const labels = nodes.map(label);
  (window as unknown as { __partsmithStudio: Bound }).__partsmithStudio = {
    id,
    nodes,
    labels,
  };
  const text = (document.body?.innerText ?? "").slice(0, 24000);
  const captcha =
    Array.from(
      document.querySelectorAll(
        'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"]',
      ),
    ).some(
      (el) =>
        visible(el) &&
        el.getBoundingClientRect().height > 70 &&
        el.getBoundingClientRect().width > 120,
    ) ||
    /verify you are human|complete the captcha|사람인지 확인|보안 문자/i.test(
      text,
    );
  const auth = nodes.some(
    (el) =>
      visible(el) &&
      (el.getAttribute("type") === "password" ||
        /(^|[\s/])(log\s*in|sign\s*in|sign\s*up|로그인|회원가입)([\s/]|$)/i.test(
          label(el),
        )),
  );
  return {
    snapshotId: id,
    url: location.origin + location.pathname,
    text,
    requiresInput: captcha || auth || !text.trim(),
    reason: captcha
      ? "Studio 인증 화면을 직접 완료하세요."
      : auth
        ? "Studio 창에서 직접 로그인하세요. 앱/API 키 로그인과 별개입니다."
        : !text.trim()
          ? "Studio 화면을 불러오는 중입니다."
          : undefined,
    controls: nodes.map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      type: el.getAttribute("type") || "",
      label: labels[index],
      disabled:
        (el as HTMLButtonElement).disabled === true ||
        el.getAttribute("aria-disabled") === "true",
      navigation:
        !!el.closest('nav,[role="tablist"]') ||
        ["tab", "option", "radio", "checkbox"].includes(
          el.getAttribute("role") || "",
        ) ||
        el.tagName === "A",
      ...(fileInputs.includes(el)
        ? {
            fileIndex: fileInputs.indexOf(el),
            accept: el.getAttribute("accept") ?? "",
          }
        : {}),
      ...(el instanceof HTMLSelectElement
        ? {
            options: Array.from(el.options).map((o) => ({
              value: o.value,
              label: o.text,
            })),
          }
        : {}),
    })),
  };
}
function interact(input: {
  id: string;
  index?: number;
  action: "inspect" | "fill" | "select" | "scroll";
  value?: string;
}) {
  const state = (window as unknown as { __partsmithStudio?: Bound })
    .__partsmithStudio;
  if (!state || state.id !== input.id)
    throw Error("Stale observation; take a new snapshot");
  if (input.action === "scroll" && input.index === undefined) {
    window.scrollBy(0, (input.value === "up" ? -1 : 1) * innerHeight * 0.7);
    return {};
  }
  const el = state.nodes[input.index ?? -1] as HTMLElement;
  if (!el || !el.isConnected) throw Error("Observed element no longer exists");
  const label = (
    el.getAttribute("aria-label") ||
    el.innerText ||
    el.getAttribute("title") ||
    el.getAttribute("placeholder") ||
    el.getAttribute("name") ||
    el.tagName
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  if (label !== state.labels[input.index!])
    throw Error("Element changed; reobserve before acting");
  if (
    (el as HTMLButtonElement).disabled ||
    el.getAttribute("aria-disabled") === "true"
  )
    throw Error("Control is disabled");
  const r = el.getBoundingClientRect(),
    x = Math.round(r.left + r.width / 2),
    y = Math.round(r.top + r.height / 2);
  if (!(el instanceof HTMLInputElement && el.type === "file")) {
    const hit = document.elementFromPoint(x, y);
    if (
      !r.width ||
      !r.height ||
      x < 0 ||
      y < 0 ||
      x >= innerWidth ||
      y >= innerHeight ||
      !hit ||
      !(el === hit || el.contains(hit))
    )
      throw Error("Control is hidden or covered; reobserve/scroll");
  }
  if (input.action === "fill") {
    if (el instanceof HTMLInputElement) {
      if (!["text", "number", "search", "url", ""].includes(el.type))
        throw Error("Only prompt/number fields may be filled");
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(el, input.value);
    } else if (el instanceof HTMLTextAreaElement)
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(el, input.value);
    else if (el.isContentEditable) el.textContent = input.value ?? "";
    else throw Error("Observed control is not editable");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (input.action === "select") {
    if (
      !(el instanceof HTMLSelectElement) ||
      !Array.from(el.options).some((o) => o.value === input.value)
    )
      throw Error("Select an observed option value");
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(el, input.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (input.action === "scroll")
    el.scrollBy(
      0,
      (input.value === "up" ? -1 : 1) * Math.max(200, el.clientHeight * 0.7),
    );
  return { x, y };
}

export class StudioBrowser {
  private window?: BrowserWindow;
  private run?: StudioRunContext;
  private ledger?: StudioLedger;
  private snapshot?: Snapshot;
  private downloads: Download[] = [];
  private server?: http.Server;
  private token?: string;
  private running = false;
  private fixtureUrl?: string;
  constructor(options: { fixtureUrl?: string; bridgePath?: string } = {}) {
    if (options.fixtureUrl) {
      if (
        app.isPackaged ||
        process.env.PARTSMITH_STUDIO_TEST !== "1" ||
        !/^http:\/\/127\.0\.0\.1:\d+\//.test(options.fixtureUrl)
      )
        throw Error("Local Studio fixture is test-only");
      this.fixtureUrl = options.fixtureUrl;
    }
    this.bridgePath =
      options.bridgePath ??
      path.join(app.getAppPath(), "dist-electron", "production-mcp.cjs");
  }
  private bridgePath: string;
  private allowed(value: string) {
    return (
      isStudioUrl(value) ||
      (!!this.fixtureUrl &&
        new URL(value).origin === new URL(this.fixtureUrl).origin)
    );
  }
  async open(show = true) {
    if (!this.window || this.window.isDestroyed()) {
      const win = new BrowserWindow({
        title: "Partsmith · Tripo Studio",
        width: 1360,
        height: 900,
        show,
        webPreferences: {
          partition: this.fixtureUrl
            ? "partsmith-studio-test"
            : "persist:partsmith-tripo-studio",
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          devTools: false,
        },
      });
      this.window = win;
      const session = win.webContents.session;
      session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      session.setPermissionCheckHandler(() => false);
      const guard = (event: Electron.Event, url: string) => {
        if (!this.allowed(url) && !isLoginUrl(url)) event.preventDefault();
      };
      win.webContents.on("will-navigate", guard);
      win.webContents.on("will-redirect", guard);
      win.webContents.on("did-start-navigation", () => {
        this.snapshot = undefined;
      });
      win.webContents.setWindowOpenHandler(({ url }) =>
        this.allowed(url) || isLoginUrl(url)
          ? {
              action: "allow",
              overrideBrowserWindowOptions: {
                show: true,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  sandbox: true,
                  webSecurity: true,
                  devTools: false,
                },
              },
            }
          : { action: "deny" },
      );
      win.webContents.on("did-create-window", (popup) => {
        popup.webContents.on("will-navigate", guard);
        popup.webContents.on("will-redirect", guard);
        popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      });
      const download = (
        event: Electron.Event,
        item: DownloadItem,
        contents: Electron.WebContents,
      ) => {
        if (contents?.id !== win.webContents.id) return;
        if (!this.run || !this.allowed(win.webContents.getURL())) {
          event.preventDefault();
          return;
        }
        this.receiveDownload(item);
      };
      session.on("will-download", download);
      win.on("closed", () => {
        session.removeListener("will-download", download);
        this.window = undefined;
        this.snapshot = undefined;
      });
      await win.loadURL(this.fixtureUrl ?? STUDIO_URL);
    }
    if (show) {
      this.window.show();
      this.window.focus();
    }
    return this.status();
  }
  async status() {
    let reason = "Studio 브라우저를 열고 로그인하세요.",
      ready = false;
    if (this.window && !this.window.isDestroyed()) {
      if (!this.allowed(this.window.webContents.getURL()))
        reason = "Studio 인증 창에서 직접 로그인을 완료하세요.";
      else
        try {
          const observed =
            this.server && this.snapshot
              ? this.snapshot
              : await this.observe(false);
          ready = !observed.requiresInput;
          reason =
            observed.reason ??
            "Studio 화면 연결됨 — 실제 제출 전 화면과 비용을 검증합니다.";
        } catch {
          reason = "Studio 화면 로딩 또는 연결 확인이 필요합니다.";
        }
    }
    return {
      available: true,
      opened: !!this.window && !this.window.isDestroyed(),
      ready,
      requiresInput: !ready,
      reason,
      url: this.snapshot?.url,
      runId: this.run?.runId,
      budget: this.ledger?.summary(),
      downloads: this.downloads,
    };
  }
  async probeConnections() {
    const status = await this.status();
    return { studio: status.ready, video: false, motion: true };
  }
  private downloadJournal(runId: string) {
    return path.join(
      app.getPath("userData"),
      "studio-downloads",
      createHash("sha256").update(runId).digest("hex") + ".json",
    );
  }
  /** Host-owned evidence; the workspace copy is only a worker-readable mirror. */
  stageReceipt(runId: string, stageId: string, attempt: number) {
    const charges = StudioLedger.readCharges(
      path.join(app.getPath("userData"), "studio-ledgers"),
      runId,
    ).filter((item) => item.stageId === stageId && item.attempt === attempt);
    const journal = this.downloadJournal(runId);
    const records: Download[] = fs.existsSync(journal)
      ? JSON.parse(fs.readFileSync(journal, "utf8"))
      : [];
    return {
      charges,
      downloads: records.filter(
        (item) =>
          item.runId === runId &&
          item.stageId === stageId &&
          item.attempt === attempt,
      ),
    };
  }
  attachRun(context: StudioRunContext) {
    if (this.server)
      throw Error(
        "Close the previous worker bridge before attaching another stage",
      );
    if (this.downloads.some((item) => item.state === "downloading"))
      throw Error(
        "Wait for the current Studio download before changing stages",
      );
    if (!fs.existsSync(context.rootDir))
      throw Error("Production workspace missing");
    this.run = { ...context, rootDir: fs.realpathSync(context.rootDir) };
    this.ledger = new StudioLedger(
      path.join(app.getPath("userData"), "studio-ledgers"),
      this.run,
    );
    const file = this.downloadJournal(context.runId);
    this.downloads = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : [];
    this.snapshot = undefined;
  }
  private wc() {
    if (!this.window || this.window.isDestroyed())
      throw Error("Open the Studio browser first");
    if (!this.allowed(this.window.webContents.getURL()))
      throw Error(
        "Complete Studio login manually; automation does not access authentication pages",
      );
    return this.window.webContents;
  }
  private async isolated<T>(fn: Function, value: unknown): Promise<T> {
    return this.wc().executeJavaScriptInIsolatedWorld(987, [
      { code: `(${fn.toString()})(${JSON.stringify(value)})` },
    ]) as Promise<T>;
  }
  private async observe(saveImage: boolean): Promise<Snapshot> {
    const result = await this.isolated<Snapshot>(collect, randomUUID());
    this.snapshot = result;
    if (saveImage && this.run) {
      const relative = `studio-evidence/${result.snapshotId}.png`,
        dest = guardedPath(this.run.rootDir, relative, false);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let png: Buffer | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          png = (await this.wc().capturePage()).toPNG();
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      if (!png?.length) throw Error("Studio screenshot has no rendered frame");
      fs.writeFileSync(dest, png);
      result.screenshot = relative;
      writeJson(
        guardedPath(
          this.run.rootDir,
          `studio-evidence/${result.snapshotId}.json`,
          false,
        ),
        result,
      );
    }
    return result;
  }
  private requireObserved(args: Record<string, unknown>, needElement = true) {
    if (!this.run) throw Error("No approved production run is attached");
    if (!this.snapshot || args.snapshotId !== this.snapshot.snapshotId)
      throw Error("Stale observation; call studio_snapshot");
    if (this.snapshot.requiresInput)
      throw Error(this.snapshot.reason ?? "User authentication required");
    const node = this.snapshot.controls.find((c) => c.index === args.element);
    if (needElement && (!node || node.disabled))
      throw Error("Observed enabled control required");
    return node;
  }
  private async imageResult(snapshot: Snapshot) {
    const content: unknown[] = [
      {
        type: "text",
        text: JSON.stringify({ ...snapshot, budget: this.ledger?.summary() }),
      },
    ];
    if (snapshot.screenshot && this.run)
      content.push({
        type: "image",
        data: fs
          .readFileSync(guardedPath(this.run.rootDir, snapshot.screenshot))
          .toString("base64"),
        mimeType: "image/png",
      });
    return { content };
  }
  private async click(args: Record<string, unknown>, paid: boolean) {
    const node = this.requireObserved(args)!;
    if (
      userActionPattern.test(node.label) ||
      node.type === "password" ||
      node.type === "email"
    )
      throw Error(
        "Authentication, payment and sensitive actions require direct user input",
      );
    const cost = creditFromLabel(node.label);
    if (paid) {
      if (!["button", "input"].includes(node.tag) && node.role !== "button")
        throw Error("Paid action must be an observed button");
      if (
        node.navigation ||
        cost === undefined ||
        cost !== args.expectedCredits
      )
        throw Error(
          "A single credit price must be visible on the actual action button and match expectedCredits",
        );
    } else if (
      cost !== undefined ||
      (!node.navigation && chargedActionPattern.test(node.label)) ||
      node.type === "submit"
    )
      throw Error(
        "Possible charged action: use studio_submit after observing its actual credit cost",
      );
    const point = await this.isolated<{ x: number; y: number }>(interact, {
      id: args.snapshotId,
      index: args.element,
      action: "inspect",
    });
    if (paid)
      this.ledger!.reserve(
        String(args.operationId),
        cost!,
        node.label,
        String(args.snapshotId),
      );
    // The reservation is durable before either input event. A thrown/uncertain
    // click remains reserved and cannot be retried automatically.
    this.wc().sendInputEvent({
      type: "mouseDown",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    this.wc().sendInputEvent({
      type: "mouseUp",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    if (paid) this.ledger!.clicked(String(args.operationId));
    return this.imageResult(await this.observe(true));
  }
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (name === "studio_status")
      return {
        content: [{ type: "text", text: JSON.stringify(await this.status()) }],
      };
    if (name === "studio_downloads")
      return {
        content: [{ type: "text", text: JSON.stringify(this.downloads) }],
      };
    if (name === "studio_snapshot")
      return this.imageResult(await this.observe(true));
    if (name === "studio_wait") {
      const ms = args.milliseconds ?? 1500;
      if (!Number.isInteger(ms) || Number(ms) < 0 || Number(ms) > 5000)
        throw Error("Wait range is 0–5000 ms");
      await new Promise((resolve) => setTimeout(resolve, Number(ms)));
      return this.imageResult(await this.observe(true));
    }
    if (name === "studio_click" || name === "studio_submit")
      return this.click(args, name === "studio_submit");
    if (name === "studio_observe_submission") {
      this.requireObserved(args, false);
      const evidence = String(args.evidenceText ?? "").trim();
      if (
        evidence.length < 12 ||
        evidence.length > 1000 ||
        !this.snapshot!.text.includes(evidence) ||
        !/complet|success|fail|error|queued|processing|running|progress|download|완료|성공|실패|오류|처리 중|생성 중|대기|다운로드/i.test(
          evidence,
        )
      )
        throw Error(
          "Visible task status/result evidence is required to reconcile the submission",
        );
      this.ledger!.observe(
        String(args.operationId),
        `${this.snapshot!.snapshotId}: ${evidence}`,
      );
      return {
        content: [
          { type: "text", text: JSON.stringify(this.ledger!.summary()) },
        ],
      };
    }
    if (name === "studio_scroll") {
      this.requireObserved(args, args.element !== undefined);
      if (!["up", "down"].includes(String(args.direction)))
        throw Error("Invalid scroll direction");
      await this.isolated(interact, {
        id: args.snapshotId,
        index: args.element,
        action: "scroll",
        value: args.direction,
      });
      return this.imageResult(await this.observe(true));
    }
    const node = this.requireObserved(args)!;
    if (
      userActionPattern.test(node.label) ||
      ["password", "email"].includes(node.type)
    )
      throw Error("Credential/authentication controls are user-only");
    if (name === "studio_fill" || name === "studio_select") {
      const value = name === "studio_fill" ? args.text : args.value;
      if (typeof value !== "string" || value.length > 12000)
        throw Error("Invalid field text");
      await this.isolated(interact, {
        id: args.snapshotId,
        index: args.element,
        action: name === "studio_fill" ? "fill" : "select",
        value,
      });
    } else if (name === "studio_upload") {
      if (node.fileIndex === undefined)
        throw Error("Observed file input required");
      const file = guardedPath(this.run!.rootDir, String(args.file));
      const ext = path.extname(file).toLowerCase(),
        image = [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
      if (!image && ![".glb", ".fbx", ".obj", ".stl"].includes(ext))
        throw Error(
          "Studio upload supports images and GLB/FBX/OBJ/STL models only",
        );
      if (fs.statSync(file).size > (image ? 20 : 150) * 1024 * 1024)
        throw Error("Studio upload exceeds the observed file-size limit");
      await this.isolated(interact, {
        id: args.snapshotId,
        index: args.element,
        action: "inspect",
      });
      const debuggerApi = this.wc().debugger;
      if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
      const doc = await debuggerApi.sendCommand("DOM.getDocument");
      const found = await debuggerApi.sendCommand("DOM.querySelectorAll", {
        nodeId: doc.root.nodeId,
        selector: 'input[type="file"]',
      });
      if (!found.nodeIds[node.fileIndex])
        throw Error("File input changed; reobserve");
      await debuggerApi.sendCommand("DOM.setFileInputFiles", {
        nodeId: found.nodeIds[node.fileIndex],
        files: [file],
      });
    } else throw Error("Unknown Studio tool");
    return this.imageResult(await this.observe(true));
  }
  private receiveDownload(item: DownloadItem) {
    const run = this.run!,
      id = randomUUID(),
      ext = path.extname(item.getFilename()).toLowerCase();
    if (
      ![
        ".glb",
        ".gltf",
        ".fbx",
        ".obj",
        ".stl",
        ".zip",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".blend",
        ".usdz",
        ".3mf",
      ].includes(ext)
    ) {
      item.cancel();
      return;
    }
    const relative = `downloads/${id}${ext}`,
      file = guardedPath(run.rootDir, relative, false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const url = item.getURL(),
      protocol = new URL(url).protocol;
    if (!["https:", "blob:"].includes(protocol) && !this.fixtureUrl) {
      item.cancel();
      return;
    }
    const record: Download = {
      id,
      runId: run.runId,
      stageId: run.stageId,
      attempt: run.attempt ?? 1,
      file: relative,
      sourcePage: this.snapshot?.url ?? STUDIO_URL,
      sourceOrigin: new URL(url).origin,
      state: "downloading",
    };
    this.downloads.push(record);
    item.setSavePath(file);
    this.saveDownloads(run);
    item.on("updated", () => {
      if (item.getReceivedBytes() > 1024 ** 3) item.cancel();
    });
    item.once("done", (_event, state) => {
      record.state = state;
      if (state === "completed") {
        try {
          const checked = guardedPath(run.rootDir, relative),
            stat = fs.statSync(checked);
          if (!stat.size || stat.size > 1024 ** 3)
            throw Error("Empty or oversized download");
          const fd = fs.openSync(checked, "r"),
            head = Buffer.alloc(16);
          fs.readSync(fd, head, 0, 16, 0);
          fs.closeSync(fd);
          if (
            /^\s*</.test(head.toString()) ||
            (ext === ".glb" && head.subarray(0, 4).toString() !== "glTF")
          )
            throw Error("Downloaded content does not match its model format");
          record.bytes = stat.size;
          record.sha256 = createHash("sha256")
            .update(fs.readFileSync(checked))
            .digest("hex");
        } catch (e) {
          record.state = "failed";
          record.error = String(e);
        }
      }
      this.saveDownloads(run);
    });
  }
  private saveDownloads(run: StudioRunContext) {
    writeJson(this.downloadJournal(run.runId), this.downloads);
    writeJson(
      guardedPath(run.rootDir, "studio-downloads.json", false),
      this.downloads,
    );
  }
  async startBridge() {
    if (!this.run) throw Error("Attach an approved run first");
    if (this.server) throw Error("Worker bridge already attached");
    const token = randomBytes(32).toString("hex");
    this.token = token;
    const server = http.createServer(async (request, response) => {
      const supplied =
        request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (
        request.method !== "POST" ||
        request.url !== "/tools" ||
        request.headers.origin ||
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      ) {
        response.writeHead(403).end();
        return;
      }
      let body = "",
        acquired = false;
      try {
        for await (const chunk of request) {
          body += chunk.toString();
          if (body.length > 64000) throw Error("Request too large");
        }
        if (this.running)
          throw Error("Studio tool already running; await its observation");
        this.running = true;
        acquired = true;
        const payload = JSON.parse(body);
        const result =
          payload.method === "tools/list"
            ? { tools: STUDIO_TOOLS }
            : payload.method === "tools/call"
              ? await this.callTool(payload.name, payload.arguments ?? {})
              : (() => {
                  throw Error("Unknown bridge method");
                })();
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result));
      } catch (error) {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            isError: true,
            content: [{ type: "text", text: String(error) }],
          }),
        );
      } finally {
        if (acquired) this.running = false;
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Loopback bridge unavailable");
    return { port: address.port, token, close: () => this.closeBridge(server) };
  }
  private async closeBridge(server = this.server) {
    if (!server) return;
    if (server === this.server) {
      this.server = undefined;
      this.token = undefined;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  async workerConnection(context: WorkerConnectionContext) {
    this.attachRun({
      runId: context.runId,
      stageId: context.stageId,
      rootDir: context.workspace,
      creditLimit: context.studioCreditLimit,
      maxAttempts: context.maxIterations,
      attempt: context.attempt,
    });
    const bridge = await this.startBridge();
    return {
      args: [
        "-c",
        `mcp_servers.partsmith_studio.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.partsmith_studio.args=${JSON.stringify([this.bridgePath])}`,
        "-c",
        'mcp_servers.partsmith_studio.env_vars=["PARTSMITH_STUDIO_PORT","PARTSMITH_STUDIO_TOKEN"]',
        "-c",
        'mcp_servers.partsmith_studio.env.ELECTRON_RUN_AS_NODE="1"',
      ],
      env: {
        PARTSMITH_STUDIO_PORT: String(bridge.port),
        PARTSMITH_STUDIO_TOKEN: bridge.token,
      },
      capabilities: await this.probeConnections(),
      close: bridge.close,
    };
  }
  async close() {
    await this.closeBridge();
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.run = undefined;
    this.snapshot = undefined;
  }
}
