import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { parseJsonText } from "./json";
import type {
  ProductionProbe,
  ProductionRun,
  ProductionStage,
} from "../shared/production";

export type WorkerCapabilities = ProductionProbe["capabilities"];
export type WorkerConnectionContext = {
  runId: string;
  stageId: string;
  workspace: string;
  studioCreditLimit: number;
  videoCreditLimit: number;
  maxIterations: number;
  attempt: number;
  charged: boolean;
  capability?: "studio" | "video" | "motion";
  videoUrl?: string;
  recoveryOnly?: boolean;
  /** Explicit image execution path; absent means the existing native worker. */
  imageBackend?: "codex" | "chatgpt-web";
  /** Host-frozen original references and user-facing ChatGPT request. */
  referencePaths?: string[];
  webPrompt?: string;
  /** Host-frozen existing-model edit; cannot submit a fresh model generation. */
  modelEdit?: { scope: "all" | "part"; target?: string };
};
export type WorkerConnection = {
  imageBackend?: "chatgpt-web";
  args?: string[];
  env?: Record<string, string>;
  capabilities?: WorkerCapabilities;
  close?: () => Promise<void> | void;
};
export type WorkerTask = {
  /** App-owned Chrome runner uses its own scoped connection, not embedded web. */
  connectedChrome?: boolean;
  run: ProductionRun;
  stage: ProductionStage;
  prompt: string;
  imagePaths: string[];
  /** Host-selected model for a specific user-requested authoring action. */
  requestedModel?: "gpt-6-astra";
  /** Recovery may inspect/download existing work, never create another paid submission. */
  recoveryOnly?: boolean;
  imageBackend?: "codex" | "chatgpt-web";
  referencePaths?: string[];
  webPrompt?: string;
  modelEdit?: { scope: "all" | "part"; target?: string };
  /** Host-selected existing project folders, never supplied by worker output. */
  allowedWritePaths?: string[];
  schemaPath: string;
  resultPath: string;
  signal: AbortSignal;
  onEvent: (event: {
    type: string;
    threadId?: string;
    message?: string;
    usage?: unknown;
  }) => void;
};
export type StageReceipt = {
  imageBackend?: "chatgpt-web";
  submission?: { state: string; conversationUrl?: string };
  charges: { state: string; cost: number }[];
  downloads: {
    state: string;
    file: string;
    sha256?: string;
    bytes?: number;
    id?: string;
    sourcePage?: string;
    imageLabel?: string;
    runId?: string;
    stageId?: string;
    attempt?: number;
  }[];
};
export interface ProductionWorker {
  probe(): Promise<ProductionProbe>;
  run(task: WorkerTask): Promise<{ result: unknown; threadId?: string }>;
  shutdown?(): void;
  stageReceipt?(
    runId: string,
    stageId: string,
    attempt: number,
  ): StageReceipt | undefined;
}
export type CodexWorkerOptions = {
  cliPath?: string;
  timeoutMs?: number;
  connectionFactory?: (
    context: WorkerConnectionContext,
  ) => Promise<WorkerConnection>;
  probeConnections?: () => Promise<WorkerCapabilities>;
  stageReceipt?: (
    runId: string,
    stageId: string,
    attempt: number,
  ) => StageReceipt;
};
export function codexArguments(task: WorkerTask, extraArgs: string[] = []) {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--config",
    'approval_policy="never"',
    // Child jobs use built-in image tools and local Blender scripts. Keep the
    // user's disabled integrations disabled without rewriting their config.
    "--config",
    "mcp_servers.blender.enabled=false",
    "--config",
    "mcp_servers.fal_ai.enabled=false",
    "--config",
    "mcp_servers.notion.enabled=false",
    "--skip-git-repo-check",
    "--cd",
    task.run.workspace,
    "--output-schema",
    task.schemaPath,
    "--output-last-message",
    task.resultPath,
  ];
  if (task.requestedModel || task.stage.kind === "motion-transfer")
    args.push("--model", task.requestedModel ?? "gpt-6-astra");
  // A local repair can inspect existing images but must not consume another
  // image-generation request. This override applies only to this child process.
  if (task.recoveryOnly || task.imageBackend === "chatgpt-web" || task.connectedChrome)
    args.push("--config", "features.image_generation=false");
  for (const directory of task.allowedWritePaths ?? [])
    args.push("--add-dir", directory);
  for (const file of task.imagePaths) args.push("--image", file);
  args.push(...extraArgs, "-");
  return args;
}
/** Deterministic transport failure, not a request to reason over more files. */
export function isBrowserToolApprovalDenied(event: unknown): boolean {
  const value = event as {
    type?: string;
    item?: {
      type?: string;
      tool?: string;
      tool_name?: string;
      server?: string;
      status?: string;
      error?: unknown;
      result?: unknown;
    };
  };
  const item = value?.item;
  return (
    value?.type === "item.completed" &&
    item?.type === "mcp_tool_call" &&
    /^(?:studio_|chatgpt_)/.test(item.tool ?? item.tool_name ?? "") &&
    (item.status === "failed" || Boolean(item.error)) &&
    /approval[_ ]policy.{0,40}never|(?:denied|blocked).{0,60}approval|approval.{0,60}(?:denied|blocked)/i.test(
      JSON.stringify(item.error ?? item.result ?? ""),
    )
  );
}
const unavailable: WorkerCapabilities = {
  studio: false,
  video: false,
  motion: false,
};

function capture(
  exe: string,
  args: string[],
  timeout = 10000,
): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    let output = "",
      settled = false;
    const child = spawn(exe, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, text: output.trim() });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, timeout);
    child.stdout?.on("data", (data) => {
      output = (output + data.toString()).slice(-4000);
    });
    child.stderr?.on("data", (data) => {
      output = (output + data.toString()).slice(-4000);
    });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** Local CLI execution only: authentication stays in Codex's existing credential store. */
export class CodexWorker implements ProductionWorker {
  private active = new Set<ChildProcess>();
  private cli?: string;
  constructor(private options: CodexWorkerOptions = {}) {}
  stageReceipt(runId: string, stageId: string, attempt: number) {
    return this.options.stageReceipt?.(runId, stageId, attempt);
  }
  private async executable() {
    if (this.cli && fs.existsSync(this.cli)) return this.cli;
    const candidates = [
      this.options.cliPath,
      process.env.LOCALAPPDATA
        ? path.join(
            process.env.LOCALAPPDATA,
            "Programs/OpenAI/Codex/bin/codex.exe",
          )
        : undefined,
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates)
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
        return (this.cli = path.resolve(candidate));
    const found = await capture(
      process.platform === "win32" ? "where.exe" : "which",
      [process.platform === "win32" ? "codex.exe" : "codex"],
    );
    const candidate = found.text
      .split(/\r?\n/)
      .find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!candidate)
      throw new Error(
        "Codex CLI를 찾지 못했습니다. Codex 설치와 로그인 상태를 확인하세요.",
      );
    return (this.cli = candidate);
  }
  async probe(): Promise<ProductionProbe> {
    let capabilities = unavailable;
    try {
      capabilities = (await this.options.probeConnections?.()) ?? unavailable;
    } catch {
      /* Report disconnected without exposing adapter details. */
    }
    try {
      const exe = await this.executable();
      const version = await capture(exe, ["--version"]);
      const login = await capture(exe, ["login", "status"]);
      const authenticated =
        login.code === 0 && /Logged in using ChatGPT/i.test(login.text);
      return {
        codex: {
          available: version.code === 0,
          path: exe,
          version: version.text,
          authenticated,
          message: authenticated
            ? "기존 ChatGPT 계정 로그인 확인 · 작업 실행 권한은 실행 응답으로 확인"
            : "Codex CLI에서 ChatGPT 계정 로그인이 필요합니다. 앱은 키를 읽지 않습니다.",
        },
        capabilities,
        message: capabilities.studio
          ? "Codex 작업자와 Studio 연결 상태를 확인했습니다. 로그인·유료 실행은 단계별 결과로 검증합니다."
          : "Codex 로컬 단계는 실행할 수 있습니다. Studio 브라우저 연결이 준비되어야 원격 단계를 진행합니다.",
      };
    } catch (error) {
      return {
        codex: {
          available: false,
          authenticated: false,
          message: error instanceof Error ? error.message : "Codex 확인 실패",
        },
        capabilities,
        message: "Codex 작업자 연결 필요",
      };
    }
  }
  private terminate(child: ChildProcess) {
    if (child.exitCode !== null || !this.active.has(child)) return;
    // The PID is owned by this instance; never enumerate or terminate unrelated processes.
    if (process.platform === "win32" && child.pid) {
      const killer = spawn(
        path.join(
          process.env.SystemRoot ?? "C:/Windows",
          "System32/taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      killer.on("error", () => child.kill());
    } else child.kill("SIGTERM");
  }
  shutdown() {
    for (const child of this.active) this.terminate(child);
  }
  async run(task: WorkerTask): Promise<{ result: unknown; threadId?: string }> {
    const exe = await this.executable();
    if (task.signal.aborted) throw new Error("Codex 작업 중지");
    const connection = await this.options.connectionFactory?.({
      runId: task.run.id,
      stageId: task.stage.id,
      workspace: task.run.workspace,
      studioCreditLimit: task.run.config.studioCreditLimit,
      videoCreditLimit: task.run.config.videoCreditLimit,
      maxIterations: task.run.config.maxIterations,
      attempt: task.stage.attempt,
      charged: task.stage.charged,
      capability: task.stage.capability,
      videoUrl: task.run.config.videoUrl,
      recoveryOnly: task.recoveryOnly,
      imageBackend: task.imageBackend,
      referencePaths: task.referencePaths,
      webPrompt: task.webPrompt,
      modelEdit: task.modelEdit,
    });
    if (
      task.imageBackend === "chatgpt-web" &&
      connection?.imageBackend !== "chatgpt-web"
    ) {
      await connection?.close?.();
      throw new Error(
        "ChatGPT 웹 이미지 연결이 준비되지 않았습니다. 다른 생성 경로로 전환하지 않습니다.",
      );
    }
    if (
      task.stage.capability &&
      !connection?.capabilities?.[task.stage.capability]
    ) {
      await connection?.close?.();
      throw new Error(
        `${task.stage.capability} 연결이 준비되지 않았습니다. 로그인 또는 실제 동작 전환 도구 연결이 필요합니다.`,
      );
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (task.connectedChrome) {
      // A normally launched Partsmith must not depend on this desktop chat's identity.
      for (const name of Object.keys(env))
        if ((name.startsWith("CODEX_") && name !== "CODEX_HOME") || /^(BROWSER_USE_|CUA_)/.test(name))
          delete env[name];
    }
    // Never silently switch the existing ChatGPT login to a parent process's API credentials.
    for (const name of [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "OPENAI_ACCESS_TOKEN",
      "ELECTRON_RUN_AS_NODE",
    ])
      delete env[name];
    Object.assign(env, connection?.env);
    const secrets = Object.entries(env)
      .filter(
        ([name, value]) =>
          /TOKEN|SECRET|KEY|AUTH|COOKIE/i.test(name) &&
          value &&
          value.length >= 8,
      )
      .map(([, value]) => value!);
    const clean = (value: string) =>
      secrets
        .reduce((text, secret) => text.split(secret).join("[REDACTED]"), value)
        .slice(0, 100000);
    const args = codexArguments(task, connection?.args);
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(exe, args, {
          cwd: task.run.workspace,
          env,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.active.add(child);
        let pending = "",
          threadId: string | undefined,
          completed = false,
          failed = false,
          failure = "",
          settled = false;
        const startedAt = Date.now();
        let lastActivity = "작업자가 도구 연결을 확인하고 있습니다.";
        const heartbeat = setInterval(() => {
          if (!settled)
            task.onEvent({
              type: "worker.heartbeat",
              message: `${lastActivity} · ${Math.floor((Date.now() - startedAt) / 1000)}초 경과`,
            });
        }, 15000);
        const log = fs.createWriteStream(
          path.join(path.dirname(task.resultPath), "codex-events.jsonl"),
          { flags: "a" },
        );
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(heartbeat);
          task.signal.removeEventListener("abort", abort);
          this.active.delete(child);
          log.end();
          if (error) {
            reject(error);
            return;
          }
          try {
            if (!completed || failed || !fs.existsSync(task.resultPath))
              throw new Error(
                failure ||
                  "Codex 완료 이벤트와 결과 파일이 모두 확인되지 않았습니다.",
              );
            resolve({
              result: parseJsonText(fs.readFileSync(task.resultPath, "utf8")),
              threadId,
            });
          } catch (error) {
            reject(error);
          }
        };
        const abort = () => {
          this.terminate(child);
          finish(
            new Error("Codex 작업 중지 · 원격 작업 취소는 보장되지 않습니다."),
          );
        };
        const timer = setTimeout(
          () => {
            this.terminate(child);
            finish(
              new Error(
                "Codex 단계 실행 시간 초과 · 자동 재제출하지 않습니다.",
              ),
            );
          },
          this.options.timeoutMs ?? 30 * 60 * 1000,
        );
        task.signal.addEventListener("abort", abort, { once: true });
        child.on("error", (error) => finish(new Error(clean(error.message))));
        log.on("error", () => {
          this.terminate(child);
          finish(new Error("Codex 실행 기록을 저장할 수 없습니다."));
        });
        child.stdout.on("data", (data) => {
          pending += data.toString();
          if (pending.length > 2_000_000) {
            this.terminate(child);
            finish(new Error("Codex 출력 한도 초과"));
            return;
          }
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!line.trim()) continue;
            log.write(clean(line) + "\n");
            try {
              const event = JSON.parse(line);
              if (isBrowserToolApprovalDenied(event)) {
                this.terminate(child);
                finish(
                  new Error(
                    "앱 내부 브라우저 도구 호출이 승인 정책으로 차단됐습니다. 작업을 중단했으며 추가 생성·복구 요청을 보내지 않습니다. 최신 앱으로 실행하고 기존 제출 기록을 확인하세요.",
                  ),
                );
                return;
              }
              if (event.type === "item.started") {
                const item = event.item;
                if (item?.type === "mcp_tool_call")
                  lastActivity = `도구 실행 중: ${String(item.tool ?? item.tool_name ?? "연결 도구").slice(0, 100)}`;
                else if (item?.type === "command_execution")
                  lastActivity = "파일을 확인·처리하고 있습니다.";
                else if (item?.type === "image_generation")
                  lastActivity = "이미지를 생성하고 있습니다.";
                else lastActivity = "작업자가 현재 단계를 처리하고 있습니다.";
                task.onEvent({
                  type: "worker.progress",
                  message: lastActivity,
                });
              }
              if (
                event.type === "thread.started" &&
                typeof event.thread_id === "string"
              ) {
                threadId = event.thread_id;
                task.onEvent({ type: event.type, threadId });
              }
              if (event.type === "turn.completed") {
                completed = true;
                task.onEvent({ type: event.type, usage: event.usage });
              }
              if (event.type === "turn.failed" || event.type === "error") {
                failed = true;
                failure = clean(
                  event.error?.message ?? event.message ?? "Codex 실행 실패",
                );
                task.onEvent({ type: event.type, message: failure });
              }
              if (
                event.type === "item.completed" &&
                event.item?.type === "agent_message"
              ) {
                lastActivity = clean(event.item.text ?? "작업 중").slice(
                  0,
                  300,
                );
                task.onEvent({
                  type: event.type,
                  message: clean(event.item.text ?? ""),
                });
              }
            } catch {
              /* Non-JSON diagnostics are never interpreted as control instructions. */
            }
          }
        });
        child.stderr.on("data", (data) => {
          log.write(
            JSON.stringify({
              type: "diagnostic",
              message: clean(data.toString()),
            }) + "\n",
          );
        });
        child.on("close", (code) =>
          finish(
            code === 0
              ? undefined
              : new Error(
                  failure || `Codex 프로세스 종료 (${code ?? "signal"})`,
                ),
          ),
        );
        child.stdin.on("error", () => {});
        child.stdin.end(task.prompt);
        if (task.signal.aborted) abort();
      });
    } finally {
      await connection?.close?.();
    }
  }
}
