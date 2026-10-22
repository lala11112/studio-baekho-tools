import { app, BrowserWindow, nativeImage, type DownloadItem } from "electron";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { browserToolPolicy } from "./worker-tool-policy";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  WorkerConnection,
  WorkerConnectionContext,
} from "../engine/codex-worker";
import type { ChatGptStatus } from "../shared/types";
import { guardedPath, writeJson } from "./studio-policy";
import {
  CHATGPT_URL,
  CHATGPT_TOOLS,
  ChatGptLedger,
  downloadChatControl,
  isChatGptAuthUrl,
  isChatGptPopupUrl,
  isChatGptSignInRequest,
  isChatGptUrl,
  chatGptDiagnosticLocation,
  isGoogleEmbeddedBrowserRejection,
  sensitiveChatControl,
  submitChatControl,
  validateOriginalImage,
  type ChatGptContext,
  type ChatGptDownload,
} from "./chatgpt-policy";

type Control = {
  index: number;
  tag: string;
  role: string;
  type: string;
  label: string;
  disabled: boolean;
  kind:
    "composer" | "upload" | "send" | "image" | "download" | "close" | "other";
  fileIndex?: number;
  imageId?: string;
  accept?: string;
  viewerMain?: boolean;
};
type Snapshot = {
  snapshotId: string;
  url: string;
  text: string;
  controls: Control[];
  requiresInput: boolean;
  reason?: string;
  busy: boolean;
  composerText: string;
  userMessages: number;
  assistantImages: number;
  frozenPromptPresent: boolean;
  referencesReady: boolean;
  attachmentCount: number;
};
type Bound = {
  id: string;
  nodes: Element[];
  controls: Control[];
  imageSources: string[];
};

// Fixed DOM-only functions run in an isolated world. The worker cannot supply
// script, selectors, URLs, cookies, headers, or network calls.
function collect(input: {
  id: string;
  prompt: string;
  referenceNames: string[];
}) {
  const id = input.id;
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const label = (el: Element) =>
    (
      el.getAttribute("aria-label") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      (el as HTMLElement).innerText ||
      el.tagName
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
  const main = document.querySelector("main") ?? document.body;
  const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
    visible,
  );
  const scope = dialog ?? main;
  const composer = Array.from(
    main.querySelectorAll(
      '[contenteditable="true"][role="textbox"],[contenteditable="true"][aria-label],textarea',
    ),
  ).find(visible);
  const form = composer?.closest("form") ?? composer?.parentElement;
  const fileInputs = Array.from(
    document.querySelectorAll('input[type="file"]'),
  );
  const nodes: Element[] = [];
  const controls: Control[] = [];
  const add = (
    el: Element,
    kind: Control["kind"],
    extras: Partial<Control> = {},
  ) => {
    if (nodes.includes(el)) return;
    const index = nodes.length;
    nodes.push(el);
    controls.push({
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      type: el.getAttribute("type") || "",
      label: label(el),
      kind,
      disabled:
        (el as HTMLButtonElement).disabled === true ||
        el.getAttribute("aria-disabled") === "true",
      ...extras,
    });
  };
  if (composer && !dialog) add(composer, "composer");
  if (!dialog)
    fileInputs.forEach((el, fileIndex) =>
      add(el, "upload", { fileIndex, accept: el.getAttribute("accept") ?? "" }),
    );
  const assistantRoots = Array.from(
    main.querySelectorAll(
      '[data-message-author-role="assistant"],[data-testid="generated-image-gallery"]',
    ),
  );
  const generatedImages = assistantRoots
    .flatMap((root) => Array.from(root.querySelectorAll("img")))
    .filter(
      (el) =>
        (el as HTMLImageElement).naturalWidth >= 128 &&
        (el as HTMLImageElement).naturalHeight >= 128,
    );
  const imageIdentity = (img: HTMLImageElement) =>
    "image-" +
    Array.from(img.currentSrc || img.src)
      .reduce(
        (hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0,
        2166136261,
      )
      .toString(16);
  const images = dialog
    ? Array.from(dialog.querySelectorAll("img")).filter(
        (el) => el.naturalWidth >= 128 && el.naturalHeight >= 128,
      )
    : [...new Set(generatedImages)];
  const viewerMain = dialog
    ? images
        .filter(visible)
        .sort(
          (a, b) =>
            b.getBoundingClientRect().width * b.getBoundingClientRect().height -
            a.getBoundingClientRect().width * a.getBoundingClientRect().height,
        )[0]
    : undefined;
  images.filter(visible).forEach((el) => {
    // This is an opaque identity for DOM revalidation, never a remotely fetched URL.
    const img = el as HTMLImageElement;
    add(el, "image", {
      imageId: imageIdentity(img),
      viewerMain: el === viewerMain,
    });
  });
  for (const el of scope.querySelectorAll(
    'button,[role="button"],a[download]',
  )) {
    if (!visible(el)) continue;
    const text = label(el);
    const isSend =
      /^(send(?: (?:message|prompt))?|submit(?: (?:message|prompt))?|프롬프트 보내기|메시지 보내기|보내기|전송)$/i.test(
        text,
      );
    const isDownload =
      /^(download(?: image)?|save(?: image)?|이미지\s*(다운로드|저장)|다운로드|저장)$/i.test(
        text,
      );
    if (dialog && /^(뷰어 닫기|close(?: viewer)?|닫기)$/i.test(text))
      add(el, "close");
    else if (isSend && !dialog && (form?.contains(el) || el.closest("form")))
      add(el, "send");
    else if (
      isDownload &&
      (dialog || assistantRoots.some((root) => root.contains(el)))
    ) {
      const candidates = images.filter(
        (image) =>
          visible(image) &&
          (dialog ||
            el
              .closest(
                '[data-testid="generated-image-gallery"],[data-message-author-role="assistant"]',
              )
              ?.contains(image)),
      );
      const ordered = candidates.sort(
        (a, b) =>
          b.getBoundingClientRect().width * b.getBoundingClientRect().height -
          a.getBoundingClientRect().width * a.getBoundingClientRect().height,
      );
      if (ordered.length && (dialog || ordered.length === 1))
        add(el, "download", {
          imageId: imageIdentity(ordered[0] as HTMLImageElement),
        });
    }
  }
  const text = (scope as HTMLElement).innerText?.slice(-16000) ?? "";
  const challenge =
    /verify you are human|complete the captcha|사람인지 확인|보안 문자|잠시만 기다리십시오/i.test(
      document.title + " " + text,
    ) ||
    Array.from(
      document.querySelectorAll(
        'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"]',
      ),
    ).some(visible);
  const auth =
    Array.from(
      document.querySelectorAll('input[type="password"],input[type="email"]'),
    ).some(visible) ||
    Array.from(document.querySelectorAll("button,a")).some(
      (el) =>
        visible(el) &&
        /^(log\s*in|sign\s*in|sign\s*up|로그인|회원가입)$/i.test(label(el)),
    );
  const busy =
    !!scope.querySelector('[aria-busy="true"],[role="progressbar"]') ||
    Array.from(main.querySelectorAll("button")).some(
      (el) =>
        visible(el) &&
        /stop (generating|streaming)|생성 중지|응답 중지/i.test(label(el)),
    );
  const attachmentImages = Array.from(
    form?.querySelectorAll("img") ?? [],
  ).filter(visible).length;
  const removeControls = Array.from(
    form?.querySelectorAll("button") ?? [],
  ).filter((el) =>
    /remove (?:file|attachment|image)|(?:파일|첨부|이미지).*삭제|첨부.*제거/i.test(
      label(el),
    ),
  ).length;
  const attachmentCount = Math.max(attachmentImages, removeControls);
  const formEvidence = [
    (form as HTMLElement)?.innerText ?? "",
    ...Array.from(form?.querySelectorAll("[title],[aria-label]") ?? []).map(
      (el) =>
        (el.getAttribute("title") ?? "") +
        " " +
        (el.getAttribute("aria-label") ?? ""),
    ),
  ].join(" ");
  const referencesReady =
    !input.referenceNames.length ||
    (!busy &&
      !/upload failed|uploading|업로드 중|업로드 실패/i.test(formEvidence) &&
      (input.referenceNames.every((name) => formEvidence.includes(name)) ||
        (attachmentImages === input.referenceNames.length &&
          removeControls === input.referenceNames.length)));
  const authoredUserTexts = Array.from(
    main.querySelectorAll('[data-message-author-role="user"]'),
  ).map((el) => el.textContent ?? "");
  if (!authoredUserTexts.length) {
    const headings = Array.from(main.querySelectorAll("h4,h5,h6"));
    for (const heading of headings.filter((el) =>
      /^(내가 한 말:|You said:)$/.test((el.textContent ?? "").trim()),
    )) {
      const turn = heading.closest(
        "[data-turn-key],[data-content-search-turn-key]",
      );
      if (!turn) continue;
      const assistant = Array.from(turn.querySelectorAll("h4,h5,h6")).find(
        (el) =>
          /^(ChatGPT 답변:|ChatGPT said:)$/.test(
            (el.textContent ?? "").trim(),
          ) &&
          !!(
            heading.compareDocumentPosition(el) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ),
      );
      if (!assistant) continue;
      const range = document.createRange();
      range.setStartAfter(heading);
      range.setEndBefore(assistant);
      authoredUserTexts.push(range.toString());
    }
  }
  (window as unknown as { __partsmithChatGpt: Bound }).__partsmithChatGpt = {
    id,
    nodes,
    controls,
    imageSources: nodes.map((node) =>
      node instanceof HTMLImageElement ? node.currentSrc || node.src : "",
    ),
  };
  return {
    snapshotId: id,
    url: location.origin + location.pathname,
    text,
    controls,
    composerText: composer
      ? ((composer as HTMLTextAreaElement).value ??
        (composer as HTMLElement).innerText)
      : "",
    userMessages: Math.max(
      main.querySelectorAll('[data-message-author-role="user"]').length,
      Array.from(main.querySelectorAll("h4,h5,h6")).filter((el) =>
        /^(내가 한 말:|You said:)$/.test((el.textContent ?? "").trim()),
      ).length,
    ),
    frozenPromptPresent:
      !!input.prompt &&
      authoredUserTexts.filter((text) =>
        text.replace(/\s+/g, " ").includes(input.prompt.replace(/\s+/g, " ")),
      ).length === 1,
    referencesReady,
    attachmentCount,
    assistantImages: generatedImages.length,
    busy,
    requiresInput:
      challenge || auth || (!composer && !dialog && !assistantRoots.length),
    reason: challenge
      ? "ChatGPT 인증 확인을 사용자가 직접 완료해야 합니다."
      : auth
        ? "Partsmith의 ChatGPT 창에서 직접 로그인하세요."
        : !composer && !dialog && !assistantRoots.length
          ? "ChatGPT 화면을 불러오는 중이거나 입력창을 확인할 수 없습니다."
          : undefined,
  };
}

function interact(input: {
  id: string;
  index?: number;
  action: "inspect" | "fill" | "scroll" | "click";
  text?: string;
  direction?: string;
}) {
  const bound = (window as unknown as { __partsmithChatGpt?: Bound })
    .__partsmithChatGpt;
  if (!bound || bound.id !== input.id)
    throw Error("Stale ChatGPT snapshot; observe again");
  if (input.action === "scroll") {
    const main = document.querySelector("main");
    const candidates = Array.from(
      (main ?? document.body).querySelectorAll("div"),
    );
    const scroller = candidates.find(
      (el) =>
        el.scrollHeight > el.clientHeight + 100 &&
        /auto|scroll/.test(getComputedStyle(el).overflowY),
    );
    (scroller ?? document.scrollingElement)?.scrollBy(
      0,
      (input.direction === "up" ? -1 : 1) * innerHeight * 0.7,
    );
    return {};
  }
  const el = bound.nodes[input.index ?? -1] as HTMLElement;
  const control = bound.controls[input.index ?? -1];
  if (!el?.isConnected || !control) throw Error("Observed control disappeared");
  const currentLabel = (
    el.getAttribute("aria-label") ||
    el.getAttribute("alt") ||
    el.getAttribute("title") ||
    el.getAttribute("placeholder") ||
    el.innerText ||
    el.tagName
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  if (
    currentLabel !== control.label ||
    (el as HTMLButtonElement).disabled ||
    el.getAttribute("aria-disabled") === "true"
  )
    throw Error("Observed control changed; observe again");
  if (
    control.kind === "image" &&
    ((el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src) !==
      bound.imageSources[input.index ?? -1]
  )
    throw Error("Observed image changed; observe again");
  if (control.kind === "download") {
    const imageIndex = bound.controls.findIndex(
      (candidate) =>
        candidate.kind === "image" && candidate.imageId === control.imageId,
    );
    const image = bound.nodes[imageIndex] as HTMLImageElement;
    if (
      !image?.isConnected ||
      (image.currentSrc || image.src) !== bound.imageSources[imageIndex]
    )
      throw Error("Selected image changed before download");
  }
  if (input.action === "fill") {
    if (control.kind !== "composer" || !input.text)
      throw Error("Only the observed composer can be filled");
    const prior = (el as HTMLTextAreaElement).value ?? el.innerText;
    if (prior.trim() && prior.trim() !== input.text.trim())
      throw Error("Existing user draft must not be overwritten");
    el.focus();
    if (el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(el, input.text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const selection = window.getSelection(),
        range = document.createRange();
      range.selectNodeContents(el);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("insertText", false, input.text);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: input.text,
        }),
      );
    }
    return {};
  }
  if (control.kind === "upload") return {};
  const rect = el.getBoundingClientRect();
  const x = Math.round(rect.x + rect.width / 2),
    y = Math.round(rect.y + rect.height / 2);
  if (
    !rect.width ||
    !rect.height ||
    x < 0 ||
    y < 0 ||
    x >= innerWidth ||
    y >= innerHeight
  )
    throw Error("Observed control is outside the viewport");
  const hit = document.elementFromPoint(x, y);
  if (
    !hit ||
    !(
      el === hit ||
      el.contains(hit) ||
      (control.kind === "image" && hit.contains(el))
    )
  )
    throw Error("Observed control is covered; observe again");
  if (input.action === "click") el.click();
  return { x, y };
}

// This status-only probe does not read input values or replace the worker's
// observed control bindings. UI polling must not invalidate an in-flight click.
function inspectConnection() {
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  if (
    Array.from(
      document.querySelectorAll(
        'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"]',
      ),
    ).some(visible) ||
    /verify you are human|complete the captcha|사람인지 확인|보안 문자|잠시만 기다리십시오/i.test(
      document.title,
    )
  )
    return "challenge";
  if (
    Array.from(
      document.querySelectorAll('input[type="password"],input[type="email"]'),
    ).some(visible) ||
    Array.from(document.querySelectorAll("button,a")).some(
      (el) =>
        visible(el) &&
        /^(log\s*in|sign\s*in|sign\s*up|로그인|회원가입)$/i.test(
          (
            el.getAttribute("aria-label") ||
            (el as HTMLElement).innerText ||
            ""
          ).trim(),
        ),
    )
  )
    return "login";
  const main = document.querySelector("main") ?? document.body;
  if (
    Array.from(
      main.querySelectorAll(
        '[contenteditable="true"][role="textbox"],[contenteditable="true"][aria-label],textarea,[data-message-author-role="assistant"]',
      ),
    ).some(visible)
  )
    return "ready";
  return "unavailable";
}

type LoginWindowState = {
  loading: boolean;
  initialBlank: boolean;
  timer?: ReturnType<typeof setTimeout>;
  sequence: number;
};

async function boundedConnectionProbe<T>(
  operation: Promise<T>,
  milliseconds = 5000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(Error("Connection probe timed out")),
          milliseconds,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export class ChatGptBrowser {
  private window?: BrowserWindow;
  private ledger?: ChatGptLedger;
  private snapshot?: Snapshot;
  private server?: http.Server;
  private running = false;
  private prepared = false;
  private uploaded = false;
  private uploadCompleted = false;
  private selected?: { imageId: string; label: string };
  private pendingDownload?: {
    imageId: string;
    label: string;
    createdAt: number;
  };
  private fixtureUrl?: string;
  private bridgePath: string;
  private ledgerDirectory: string;
  private loginWindows = new Map<BrowserWindow, LoginWindowState>();
  private connectionFailure?: {
    owner: number;
    reason: string;
    diagnostic: NonNullable<ChatGptStatus["diagnostic"]>;
  };
  private loadTimeoutMs = 30000;
  private connectionProbe?: Promise<ChatGptStatus>;
  private connectionEpoch = 0;
  private connectionChanged() {
    this.connectionEpoch++;
    this.connectionProbe = undefined;
  }
  private currentConnectionFailure() {
    return this.connectionFailure;
  }
  constructor(
    options: {
      fixtureUrl?: string;
      bridgePath?: string;
      ledgerDirectory?: string;
      loadTimeoutMs?: number;
    } = {},
  ) {
    if (options.fixtureUrl) {
      if (
        app.isPackaged ||
        process.env.PARTSMITH_CHATGPT_TEST !== "1" ||
        !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(options.fixtureUrl)
      )
        throw Error("Local ChatGPT fixture is test-only");
      this.fixtureUrl = options.fixtureUrl;
    }
    if (options.loadTimeoutMs !== undefined) {
      if (
        !this.fixtureUrl ||
        !Number.isFinite(options.loadTimeoutMs) ||
        options.loadTimeoutMs < 100
      )
        throw Error("Custom login timeout is local-fixture-only");
      this.loadTimeoutMs = options.loadTimeoutMs;
    }
    this.bridgePath =
      options.bridgePath ??
      path.join(app.getAppPath(), "dist-electron", "production-mcp.cjs");
    this.ledgerDirectory =
      options.ledgerDirectory ??
      path.join(app.getPath("userData"), "chatgpt-ledgers");
  }
  private allowed(url: string) {
    try {
      return (
        isChatGptUrl(url) ||
        (!!this.fixtureUrl &&
          new URL(url).origin === new URL(this.fixtureUrl).origin)
      );
    } catch {
      return false;
    }
  }
  private reconnectAvailable() {
    return (
      !this.server &&
      !this.running &&
      !this.pendingDownload &&
      !this.ledger
        ?.summary()
        .downloads.some((item) => item.state === "downloading")
    );
  }
  private fail(win: BrowserWindow, code: string, url: string, reason: string) {
    if (win.isDestroyed() || !this.loginWindows.has(win)) return;
    const state = this.loginWindows.get(win)!;
    state.loading = false;
    clearTimeout(state.timer);
    this.connectionFailure = {
      owner: win.webContents.id,
      reason,
      diagnostic: { code, ...chatGptDiagnosticLocation(url) },
    };
    this.connectionChanged();
  }
  private armLoadTimeout(win: BrowserWindow, url: string) {
    const state = this.loginWindows.get(win)!;
    clearTimeout(state.timer);
    state.loading = true;
    const sequence = ++state.sequence;
    state.timer = setTimeout(() => {
      if (win.isDestroyed() || state.sequence !== sequence) return;
      const blank =
        !win.webContents.getURL() || win.webContents.getURL() === "about:blank";
      this.fail(
        win,
        blank && state.initialBlank ? "BLANK_TIMEOUT" : "LOAD_TIMEOUT",
        url,
        blank && state.initialBlank
          ? "인증 팝업이 빈 화면에서 진행되지 않았습니다. 다시 연결해 주세요."
          : "ChatGPT 인증 페이지 로딩 시간이 초과되었습니다. 다시 연결해 주세요.",
      );
      win.webContents.stop();
    }, this.loadTimeoutMs);
    state.timer.unref();
  }
  private async inspectAuthRejection(win: BrowserWindow) {
    if (win.isDestroyed()) return false;
    const url = win.webContents.getURL();
    if (
      !isChatGptAuthUrl(url) ||
      new URL(url).hostname !== "accounts.google.com"
    )
      return false;
    let rejected = isGoogleEmbeddedBrowserRejection(url);
    if (!rejected) {
      try {
        // Only this boolean leaves the authentication page. No account/input
        // values, authentication text, URLs or tokens are returned or logged.
        rejected = await boundedConnectionProbe(
          win.webContents.executeJavaScriptInIsolatedWorld(989, [
            {
              code: 'Boolean(/\\bdisallowed_useragent\\b/.test(document.body?.innerText || ""))',
            },
          ]),
          2000,
        );
      } catch {
        return false;
      }
    }
    if (rejected && !win.isDestroyed() && win.webContents.getURL() === url) {
      this.fail(
        win,
        "DISALLOWED_USERAGENT",
        url,
        "Google이 내장 브라우저 로그인을 거부했습니다(disallowed_useragent). 현재 내장 창 방식으로는 지원되지 않습니다. 외부 브라우저 연결은 별도 구현이 필요합니다.",
      );
      return true;
    }
    return false;
  }
  private configureLoginWindow(
    win: BrowserWindow,
    initialUrl: string,
    popup: boolean,
  ) {
    const wc = win.webContents;
    const state: LoginWindowState = {
      loading: true,
      initialBlank: popup && initialUrl === "about:blank",
      sequence: 0,
    };
    this.loginWindows.set(win, state);
    this.connectionChanged();
    const navigationAllowed = (url: string) =>
      this.allowed(url) ||
      isChatGptAuthUrl(url) ||
      (state.initialBlank && url === "about:blank");
    const guard = (event: Electron.Event, url: string) => {
      if (!navigationAllowed(url)) {
        event.preventDefault();
        this.fail(
          win,
          "BLOCKED_NAVIGATION",
          url,
          "허용되지 않은 인증 주소로의 이동을 차단했습니다. 주소 진단을 확인해 주세요.",
        );
      }
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", (event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) guard(event, url);
    });
    wc.on("did-start-navigation", (details) => {
      if (!details.isMainFrame) return;
      this.connectionChanged();
      if (win === this.window) this.snapshot = undefined;
      if (details.url !== "about:blank") state.initialBlank = false;
      if (!details.isSameDocument) this.armLoadTimeout(win, details.url);
    });
    wc.on(
      "did-fail-load",
      (_event, errorCode, _description, url, isMainFrame) => {
        // Chromium cancels an old load during a legitimate redirect/navigation.
        if (isMainFrame && errorCode !== -3)
          this.fail(
            win,
            `LOAD_FAILED_${errorCode}`,
            url,
            "ChatGPT 인증 페이지를 불러오지 못했습니다. 다시 연결해 주세요.",
          );
      },
    );
    wc.on("render-process-gone", () =>
      this.fail(
        win,
        "RENDERER_EXITED",
        wc.getURL(),
        "ChatGPT 창이 중단되었습니다. 다시 연결해 주세요.",
      ),
    );
    wc.on("did-finish-load", () => {
      if (wc.getURL() === "about:blank") return; // Keep the bounded blank-window timer.
      clearTimeout(state.timer);
      state.loading = false;
      void this.inspectAuthRejection(win).then(() => {
        if (popup && !win.isDestroyed()) void this.status();
      });
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (!isChatGptPopupUrl(url) && !this.allowed(url)) {
        this.fail(
          win,
          "BLOCKED_POPUP",
          url,
          "허용되지 않은 인증 팝업 주소를 차단했습니다. 주소 진단을 확인해 주세요.",
        );
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          show: true,
          webPreferences: {
            session: wc.session,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            devTools: false,
          },
        },
      };
    });
    wc.on("did-create-window", (child, details) => {
      if (child.webContents.session !== wc.session) {
        this.fail(
          win,
          "SESSION_MISMATCH",
          details.url,
          "인증 팝업의 세션을 연결하지 못했습니다. 다시 연결해 주세요.",
        );
        child.close();
        return;
      }
      this.configureLoginWindow(child, details.url, true);
    });
    win.on("closed", () => {
      clearTimeout(state.timer);
      this.loginWindows.delete(win);
      this.connectionChanged();
      if (popup && this.window && !this.window.isDestroyed())
        void this.status();
    });
    this.armLoadTimeout(win, initialUrl);
  }
  private loadMain(url: string) {
    const win = this.window!;
    this.connectionFailure = undefined;
    this.connectionChanged();
    this.snapshot = undefined;
    this.prepared = false;
    this.uploaded = false;
    this.uploadCompleted = false;
    this.selected = undefined;
    this.armLoadTimeout(win, url);
    const sequence = this.loginWindows.get(win)!.sequence;
    void win.loadURL(url).catch((error: unknown) => {
      if (
        win.isDestroyed() ||
        this.loginWindows.get(win)?.sequence !== sequence ||
        this.connectionFailure
      )
        return;
      const errno = (error as { errno?: unknown })?.errno;
      if (errno === -3) return;
      this.fail(
        win,
        typeof errno === "number" ? `LOAD_FAILED_${errno}` : "LOAD_FAILED",
        url,
        "ChatGPT 인증 페이지를 불러오지 못했습니다. 다시 연결해 주세요.",
      );
    });
  }
  async open(show = true): Promise<ChatGptStatus> {
    if (!this.window || this.window.isDestroyed()) {
      const win = new BrowserWindow({
        title: "Partsmith · ChatGPT",
        width: 1360,
        height: 900,
        show,
        webPreferences: {
          partition: this.fixtureUrl
            ? "partsmith-chatgpt-test"
            : "persist:partsmith-chatgpt",
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
      session.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false),
      );
      session.setPermissionCheckHandler(() => false);
      this.configureLoginWindow(win, this.fixtureUrl ?? CHATGPT_URL, false);
      // Observe only native sign-in request outcomes in this dedicated session.
      // Never inspect headers/bodies or retain query strings and credentials.
      const requestWindow = (webContentsId: number | undefined, url: string) => {
        if (!isChatGptSignInRequest(url)) return;
        return [...this.loginWindows.keys()].find(
          (candidate) =>
            !candidate.isDestroyed() &&
            candidate.webContents.id === webContentsId,
        );
      };
      const signInFilter = { urls: ["https://chatgpt.com/api/auth/signin*"] };
      session.webRequest.onCompleted(signInFilter, (details) => {
        const owner = requestWindow(details.webContentsId, details.url);
        if (
          owner &&
          Number.isInteger(details.statusCode) &&
          details.statusCode >= 400 &&
          details.statusCode <= 599
        )
          this.fail(
            owner,
            `AUTH_HTTP_${details.statusCode}`,
            details.url,
            details.statusCode === 403
              ? "ChatGPT 웹 로그인 요청이 HTTP 403으로 거부되었습니다. 인증 창을 확인한 뒤 다시 연결해 주세요."
              : `ChatGPT 웹 로그인 요청이 실패했습니다(HTTP ${details.statusCode}). 인증 창을 확인한 뒤 다시 연결해 주세요.`,
          );
      });
      session.webRequest.onErrorOccurred(signInFilter, (details) => {
        if (details.error === "net::ERR_ABORTED") return;
        const owner = requestWindow(details.webContentsId, details.url);
        if (owner)
          this.fail(
            owner,
            "AUTH_REQUEST_FAILED",
            details.url,
            "ChatGPT 로그인 요청을 완료하지 못했습니다. 인증 창을 확인한 뒤 다시 연결해 주세요.",
          );
      });
      const onDownload = (
        event: Electron.Event,
        item: DownloadItem,
        contents: Electron.WebContents,
      ) => {
        if (contents?.id !== win.webContents.id) return;
        if (
          !this.ledger ||
          !this.pendingDownload ||
          !this.allowed(win.webContents.getURL())
        ) {
          event.preventDefault();
          return;
        }
        this.receiveDownload(item);
      };
      session.on("will-download", onDownload);
      win.on("closed", () => {
        session.webRequest.onCompleted(null);
        session.webRequest.onErrorOccurred(null);
        session.removeListener("will-download", onDownload);
        for (const popup of this.loginWindows.keys())
          if (popup !== win && !popup.isDestroyed()) popup.close();
        this.window = undefined;
        this.snapshot = undefined;
        this.connectionFailure = undefined;
      });
      this.loadMain(this.fixtureUrl ?? CHATGPT_URL);
    }
    if (show) {
      this.window.show();
      this.window.focus();
    }
    return this.status();
  }
  async reconnect(show = true): Promise<ChatGptStatus> {
    if (!this.reconnectAvailable())
      return {
        ...(await this.status()),
        canReconnect: false,
        reason:
          "진행 중인 ChatGPT 작업 또는 원본 다운로드가 끝난 뒤 다시 연결할 수 있습니다.",
      };
    if (!this.window || this.window.isDestroyed()) return this.open(show);
    for (const popup of this.loginWindows.keys())
      if (popup !== this.window && !popup.isDestroyed()) popup.close();
    const conversation = this.ledger?.summary().submission?.conversationUrl;
    this.loadMain(
      conversation && this.allowed(conversation)
        ? conversation
        : (this.fixtureUrl ?? CHATGPT_URL),
    );
    if (show) {
      this.window.show();
      this.window.focus();
    }
    return this.status();
  }
  async status(): Promise<ChatGptStatus> {
    // Coalesce UI polling and popup completion probes, without observing worker controls.
    if (this.connectionProbe) return this.connectionProbe;
    const pending = this.readConnectionStatus();
    this.connectionProbe = pending;
    try {
      return await pending;
    } finally {
      if (this.connectionProbe === pending) this.connectionProbe = undefined;
    }
  }
  private async readConnectionStatus(): Promise<ChatGptStatus> {
    const win = this.window;
    const epoch = this.connectionEpoch;
    const base = {
      available: true,
      opened: !!win && !win.isDestroyed(),
      ready: false,
      requiresInput: true,
      canReconnect: this.reconnectAvailable(),
    };
    if (!win || win.isDestroyed())
      return {
        ...base,
        state: "closed",
        reason: "ChatGPT 창을 열고 본인 계정으로 로그인하세요.",
      };
    for (const popup of this.loginWindows.keys()) {
      if (!popup.isDestroyed() && !this.loginWindows.get(popup)?.loading)
        await this.inspectAuthRejection(popup);
    }
    if (this.connectionFailure)
      return {
        ...base,
        state: "failed",
        reason: this.connectionFailure.reason,
        diagnostic: this.connectionFailure.diagnostic,
      };
    if ([...this.loginWindows.values()].some((state) => state.loading))
      return {
        ...base,
        state: "loading",
        reason: "ChatGPT 페이지를 불러오는 중입니다.",
      };
    if (
      win.isDestroyed() ||
      !this.allowed(win.webContents.getURL()) ||
      [...this.loginWindows.keys()].some(
        (popup) =>
          popup !== win &&
          !popup.isDestroyed() &&
          !this.allowed(popup.webContents.getURL()),
      )
    )
      return {
        ...base,
        state: "login_required",
        reason: "ChatGPT 인증 창에서 직접 로그인을 완료하세요.",
      };
    try {
      const url = win.webContents.getURL();
      const result = await boundedConnectionProbe(
        win.webContents.executeJavaScriptInIsolatedWorld(989, [
          { code: `(${inspectConnection.toString()})()` },
        ]),
      );
      const latestFailure = this.currentConnectionFailure();
      if (latestFailure)
        return {
          ...base,
          state: "failed",
          reason: latestFailure.reason,
          diagnostic: latestFailure.diagnostic,
        };
      if (win !== this.window || win.isDestroyed())
        return {
          ...base,
          opened: false,
          state: "closed",
          reason: "ChatGPT 창을 열고 본인 계정으로 로그인하세요.",
        };
      if (
        epoch !== this.connectionEpoch ||
        this.loginWindows.get(win)?.loading ||
        win.webContents.getURL() !== url
      )
        return {
          ...base,
          state: "loading",
          reason: "ChatGPT 인증 후 연결 상태를 확인하는 중입니다.",
        };
      if (result === "ready") {
        const parsed = new URL(url);
        return {
          ...base,
          state: "ready",
          ready: true,
          requiresInput: false,
          reason:
            "ChatGPT 웹 연결됨 — 생성 요청은 단계 실행 시 한 번만 전송합니다.",
          url: parsed.origin + parsed.pathname,
        };
      }
      return {
        ...base,
        state: "login_required",
        reason:
          result === "challenge"
            ? "ChatGPT 인증 확인을 사용자가 직접 완료해야 합니다."
            : result === "login"
              ? "Partsmith의 ChatGPT 창에서 직접 로그인하세요."
              : "ChatGPT 입력창을 확인할 수 없습니다. 인증 창을 확인하거나 다시 연결해 주세요.",
      };
    } catch {
      if (epoch !== this.connectionEpoch)
        return {
          ...base,
          state: "loading",
          reason: "ChatGPT 인증 후 연결 상태를 확인하는 중입니다.",
        };
      return {
        ...base,
        state: "failed",
        reason: "ChatGPT 화면 연결을 확인할 수 없습니다. 다시 연결해 주세요.",
        diagnostic: { code: "STATUS_UNAVAILABLE" },
      };
    }
  }
  attachRun(context: ChatGptContext) {
    if (
      this.server ||
      this.pendingDownload ||
      this.ledger
        ?.summary()
        .downloads.some((item) => item.state === "downloading")
    )
      throw Error("Close the previous ChatGPT stage before attaching another");
    this.ledger = new ChatGptLedger(this.ledgerDirectory, context);
    this.prepared = false;
    this.uploaded = false;
    this.uploadCompleted = false;
    this.selected = undefined;
    this.snapshot = undefined;
  }
  stageReceipt(runId: string, stageId: string, _attempt?: number) {
    const journal = ChatGptLedger.read(this.ledgerDirectory, runId, stageId);
    return {
      imageBackend: "chatgpt-web" as const,
      charges: [],
      downloads: journal?.downloads ?? [],
      submission: journal?.submission,
    };
  }
  private wc() {
    if (!this.window || this.window.isDestroyed())
      throw Error("Open the Partsmith ChatGPT browser first");
    if (!this.allowed(this.window.webContents.getURL()))
      throw Error(
        "Authentication is user-only; complete it in the ChatGPT window",
      );
    return this.window.webContents;
  }
  private async isolated<T>(fn: Function, input: unknown): Promise<T> {
    const result = (await this.wc().executeJavaScriptInIsolatedWorld(988, [
      {
        code: `(()=>{try{return {ok:true,value:(${fn.toString()})(${JSON.stringify(input)})};}catch(e){return {ok:false,error:e instanceof Error?e.message:String(e)};}})()`,
      },
    ])) as { ok: boolean; value?: T; error?: string };
    if (!result.ok) throw Error(result.error ?? "ChatGPT observation failed");
    return result.value as T;
  }
  private async observe() {
    const result = await this.isolated<Snapshot>(collect, {
      id: randomUUID(),
      prompt: this.ledger?.context.webPrompt ?? "",
      referenceNames:
        this.ledger?.context.referencePaths.map((file) =>
          path.basename(file),
        ) ?? [],
    });
    const submission = this.ledger?.summary().submission;
    if (submission && result.userMessages === 1 && result.frozenPromptPresent) {
      const canonical = this.fixtureUrl
        ? result.url.replace(
            new URL(this.fixtureUrl).origin,
            "https://chatgpt.com",
          )
        : result.url;
      this.ledger!.observeConversation(canonical);
    }
    this.snapshot = result;
    return result;
  }
  private result(value: unknown) {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  }
  private assertStagePage() {
    if (!this.ledger) throw Error("No approved ChatGPT stage is attached");
    const submission = this.ledger.summary().submission;
    const url = this.wc().getURL();
    const canonical = this.fixtureUrl
      ? url.replace(new URL(this.fixtureUrl).origin, "https://chatgpt.com")
      : url;
    if (
      submission?.conversationUrl &&
      canonical.split(/[?#]/)[0] !== submission.conversationUrl
    )
      throw Error("Return to this stage's recorded conversation");
    if (!submission && new URL(url).pathname !== "/")
      throw Error("Start this stage in a new empty chat");
  }
  private observed(args: Record<string, unknown>, kind?: Control["kind"]) {
    this.assertStagePage();
    if (!this.snapshot || this.snapshot.snapshotId !== args.snapshotId)
      throw Error("Stale ChatGPT observation");
    if (this.snapshot.requiresInput)
      throw Error(this.snapshot.reason ?? "User authentication required");
    const node = this.snapshot.controls.find(
      (item) => item.index === args.element,
    );
    if (kind && (!node || node.disabled || node.kind !== kind))
      throw Error(`Observed ${kind} control required`);
    return node;
  }
  private async click(node: Control) {
    await this.isolated(interact, {
      id: this.snapshot!.snapshotId,
      index: node.index,
      action: "click",
    });
  }
  async callTool(name: string, args: Record<string, unknown> = {}) {
    if (!this.ledger) throw Error("No approved ChatGPT stage attached");
    if (name === "chatgpt_downloads") return this.result(this.ledger.summary());
    if (name === "chatgpt_snapshot") {
      this.assertStagePage();
      return this.result(await this.observe());
    }
    if (name === "chatgpt_wait") {
      const ms = args.milliseconds ?? 10000;
      if (!Number.isInteger(ms) || Number(ms) < 0 || Number(ms) > 30000)
        throw Error("Wait range is 0–30000 ms");
      const prior = this.snapshot;
      await new Promise((resolve) => setTimeout(resolve, Number(ms)));
      this.assertStagePage();
      const fresh = await this.observe();
      return this.result(
        prior &&
          prior.text === fresh.text &&
          prior.busy === fresh.busy &&
          prior.requiresInput === fresh.requiresInput &&
          JSON.stringify(prior.controls) === JSON.stringify(fresh.controls)
          ? {
              unchanged: true,
              snapshotId: fresh.snapshotId,
              busy: fresh.busy,
              requiresInput: fresh.requiresInput,
              reason: fresh.reason,
              assistantImages: fresh.assistantImages,
              instruction:
                "No new output. Wait again for an existing generation; use chatgpt_snapshot before an action.",
            }
          : fresh,
      );
    }
    if (name === "chatgpt_navigate") {
      let target: string;
      if (args.target === "new") {
        this.ledger.assertCanPrepare();
        target = this.fixtureUrl ?? CHATGPT_URL;
        this.prepared = true;
        this.uploaded = false;
        this.uploadCompleted = false;
        this.selected = undefined;
      } else if (args.target === "current") {
        const conversation = this.ledger.summary().submission?.conversationUrl;
        if (!conversation)
          throw Error(
            "Submission has no confirmed conversation URL; user inspection is required, never send again",
          );
        target = this.fixtureUrl
          ? conversation.replace(
              "https://chatgpt.com",
              new URL(this.fixtureUrl).origin,
            )
          : conversation;
      } else throw Error("Only new or current stage navigation is allowed");
      await this.wc().loadURL(target);
      return this.result(await this.observe());
    }
    if (name === "chatgpt_scroll") {
      this.observed(args);
      if (!["up", "down"].includes(String(args.direction)))
        throw Error("Invalid scroll direction");
      await this.isolated(interact, {
        id: args.snapshotId,
        action: "scroll",
        direction: args.direction,
      });
      return this.result(await this.observe());
    }
    if (name === "chatgpt_fill_prompt") {
      const node = this.observed(args, "composer")!;
      this.ledger.assertCanPrepare();
      if (!this.prepared || this.snapshot!.userMessages)
        throw Error("Open a new empty chat for this frozen stage");
      await this.isolated(interact, {
        id: args.snapshotId,
        index: node.index,
        action: "fill",
        text: this.ledger.context.webPrompt,
      });
    } else if (name === "chatgpt_upload_references") {
      const node = this.observed(args, "upload")!;
      this.ledger.assertCanPrepare();
      if (!this.prepared || this.uploaded)
        throw Error("References can be attached once to this empty chat");
      if (this.snapshot!.attachmentCount)
        throw Error("Existing user attachments must not be changed");
      if (!this.ledger.context.referencePaths.length)
        throw Error("This stage has no frozen reference images");
      if (
        node.accept &&
        !/image\/\*|\.png|\.jpeg|\.jpg|\.webp/i.test(node.accept)
      )
        throw Error("Observed input does not accept images");
      await this.isolated(interact, {
        id: args.snapshotId,
        index: node.index,
        action: "inspect",
      });
      const debuggerApi = this.wc().debugger;
      if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
      const doc = await debuggerApi.sendCommand("DOM.getDocument");
      const found = await debuggerApi.sendCommand("DOM.querySelectorAll", {
        nodeId: doc.root.nodeId,
        selector: 'input[type="file"]',
      });
      if (!found.nodeIds[node.fileIndex!])
        throw Error("Observed file input changed");
      // Latch before mutation: a timeout cannot result in a duplicate upload.
      this.uploaded = true;
      await debuggerApi.sendCommand("DOM.setFileInputFiles", {
        nodeId: found.nodeIds[node.fileIndex!],
        files: this.ledger.context.referencePaths,
      });
      this.uploadCompleted = true;
    } else if (name === "chatgpt_submit") {
      const previous = this.observed(args, "send")!;
      this.ledger.assertCanPrepare();
      // Refresh immediately before reservation: a user edit or incomplete upload
      // cannot inherit approval from an older worker snapshot.
      await this.observe();
      const matching = this.snapshot!.controls.filter(
        (node) =>
          node.kind === "send" &&
          node.label === previous.label &&
          !node.disabled,
      );
      if (matching.length !== 1)
        throw Error("Send control changed before submission");
      const node = matching[0];
      if (
        !submitChatControl.test(node.label) ||
        !this.prepared ||
        this.snapshot!.busy ||
        this.snapshot!.userMessages ||
        this.snapshot!.composerText.trim() !==
          this.ledger.context.webPrompt.trim() ||
        !this.snapshot!.referencesReady ||
        (this.ledger.context.referencePaths.length &&
          (!this.uploaded || !this.uploadCompleted))
      )
        throw Error(
          "Exact frozen prompt and reference upload must be ready in the new chat",
        );
      await this.isolated(interact, {
        id: this.snapshot!.snapshotId,
        index: node.index,
        action: "inspect",
      });
      this.ledger.reserve();
      await this.click(node);
    } else if (name === "chatgpt_click_image") {
      const node = this.observed(args, "image")!;
      if (!this.ledger.summary().submission?.conversationUrl)
        throw Error(
          "Only generated images from this submitted stage may be opened",
        );
      this.selected = { imageId: node.imageId!, label: node.label };
      // A viewer can use another resolution/URL than its preview. Explicitly
      // selecting the already displayed main image binds its current identity.
      if (!node.viewerMain) await this.click(node);
    } else if (name === "chatgpt_close_viewer") {
      const node = this.observed(args, "close")!;
      await this.click(node);
      this.selected = undefined;
    } else if (name === "chatgpt_download_image") {
      const node = this.observed(args, "download")!;
      if (
        !this.ledger.summary().submission?.conversationUrl ||
        !this.selected ||
        node.imageId !== this.selected.imageId ||
        !this.snapshot!.controls.some(
          (item) =>
            item.kind === "image" && item.imageId === this.selected!.imageId,
        ) ||
        !downloadChatControl.test(node.label) ||
        sensitiveChatControl.test(node.label)
      )
        throw Error(
          "Select a generated image and observe its original download control",
        );
      if (
        this.pendingDownload ||
        this.ledger
          .summary()
          .downloads.some((item) => item.state === "downloading")
      )
        throw Error("Wait for the current original download");
      if (
        this.ledger
          .summary()
          .downloads.some(
            (item) =>
              item.imageId === this.selected!.imageId &&
              item.state === "completed",
          )
      )
        throw Error("This original was already downloaded; reuse its receipt");
      this.pendingDownload = { ...this.selected, createdAt: Date.now() };
      try {
        await this.click(node);
      } catch (error) {
        this.pendingDownload = undefined;
        throw error;
      }
    } else throw Error("Unknown ChatGPT tool");
    return this.result(await this.observe());
  }
  private receiveDownload(item: DownloadItem) {
    const pending = this.pendingDownload,
      ledger = this.ledger!;
    this.pendingDownload = undefined;
    if (
      !pending ||
      Date.now() - pending.createdAt > 30000 ||
      !ledger.summary().submission?.conversationUrl
    ) {
      item.cancel();
      return;
    }
    const ext = path.extname(item.getFilename()).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
      item.cancel();
      return;
    }
    const protocol = new URL(item.getURL()).protocol;
    if (!["https:", "blob:"].includes(protocol) && !this.fixtureUrl) {
      item.cancel();
      return;
    }
    const id = randomUUID(),
      relative = `chatgpt-downloads/${id}${ext}`,
      file = guardedPath(ledger.context.workspace, relative, false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record: ChatGptDownload = {
      id,
      runId: ledger.context.runId,
      stageId: ledger.context.stageId,
      attempt: ledger.context.attempt,
      file,
      state: "downloading",
      sourcePage: ledger.summary().submission?.conversationUrl ?? CHATGPT_URL,
      imageLabel: pending.label,
      imageId: pending.imageId,
    };
    ledger.addDownload(record);
    item.setSavePath(file);
    this.mirror(ledger);
    item.on("updated", () => {
      if (item.getReceivedBytes() > 100 * 1024 * 1024) item.cancel();
    });
    item.once("done", (_event, state) => {
      let patch: Partial<ChatGptDownload> = { state };
      if (state === "completed")
        try {
          const checked = guardedPath(ledger.context.workspace, relative),
            integrity = validateOriginalImage(checked);
          const decoded = nativeImage.createFromPath(checked);
          if (decoded.isEmpty())
            throw Error("Downloaded image could not be decoded");
          patch = { ...patch, ...integrity };
        } catch (error) {
          patch = { state: "failed", error: String(error) };
        }
      ledger.updateDownload(id, patch);
      this.mirror(ledger);
    });
  }
  private mirror(ledger: ChatGptLedger) {
    writeJson(
      guardedPath(
        ledger.context.workspace,
        `chatgpt-downloads/receipts-${path.basename(ledger.file)}`,
        false,
      ),
      ledger.summary(),
    );
  }
  async startBridge() {
    if (!this.ledger || this.server)
      throw Error("Attach one approved stage before starting its bridge");
    const token = randomBytes(32).toString("hex");
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
      let acquired = false;
      try {
        let body = "";
        for await (const chunk of request) {
          body += chunk.toString();
          if (body.length > 64000) throw Error("Request too large");
        }
        if (this.running)
          throw Error("Wait for the current ChatGPT observation");
        this.running = true;
        acquired = true;
        const payload = JSON.parse(body);
        const result =
          payload.method === "tools/list"
            ? { tools: CHATGPT_TOOLS }
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
      throw Error("ChatGPT bridge unavailable");
    return { port: address.port, token, close: () => this.closeBridge(server) };
  }
  private async closeBridge(server = this.server) {
    if (!server) return;
    if (this.server === server) this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  async workerConnection(
    context: WorkerConnectionContext,
  ): Promise<WorkerConnection> {
    if (context.imageBackend !== "chatgpt-web") return {};
    this.attachRun({
      runId: context.runId,
      stageId: context.stageId,
      workspace: context.workspace,
      attempt: context.attempt,
      recoveryOnly: context.recoveryOnly,
      webPrompt: context.webPrompt ?? "",
      referencePaths: context.referencePaths ?? [],
    });
    const status = await this.status();
    if (!status.ready) throw Error(status.reason);
    const bridge = await this.startBridge();
    return {
      imageBackend: "chatgpt-web",
      args: [
        "-c",
        `mcp_servers.partsmith_chatgpt.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.partsmith_chatgpt.args=${JSON.stringify([this.bridgePath])}`,
        "-c",
        'mcp_servers.partsmith_chatgpt.env_vars=["PARTSMITH_STUDIO_PORT","PARTSMITH_STUDIO_TOKEN"]',
        "-c",
        'mcp_servers.partsmith_chatgpt.env.ELECTRON_RUN_AS_NODE="1"',
        ...browserToolPolicy("partsmith_chatgpt", CHATGPT_TOOLS),
      ],
      env: {
        PARTSMITH_STUDIO_PORT: String(bridge.port),
        PARTSMITH_STUDIO_TOKEN: bridge.token,
      },
      close: bridge.close,
    };
  }
  async close() {
    await this.closeBridge();
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.ledger = undefined;
    this.snapshot = undefined;
  }
}
