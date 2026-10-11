import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseJsonText } from "./json";
import type { WorkerTask } from "./codex-worker";
import type {
  WorkbenchRuntimeApproval,
  WorkbenchRuntimeAnswer,
} from "../shared/workbench";

type Ask = (
  request: WorkbenchRuntimeApproval,
) => Promise<WorkbenchRuntimeAnswer>;
type Rpc = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};

// Do not persist authentication query strings or secret form responses.
export function approvalText(value: unknown): string {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s"<>]+/g, (raw) => {
      try {
        const u = new URL(raw);
        return `${u.origin}${u.pathname}`;
      } catch {
        return "[주소]";
      }
    })
    .slice(0, 12000);
}

/** Only the user's explicitly preauthorized, empty browser-origin prompt may skip UI.
 * Never use sanitized text for a permission decision or infer authority from a model reply. */
export function preauthorizedBrowserOrigin(message: Rpc, allowedOrigins: readonly string[]): string | undefined {
  const p=message.params, schema=p?.requestedSchema;
  if(message.method !== "mcpServer/elicitation/request" || p?.serverName !== "cua_repl" ||
      (p.mode !== undefined && p.mode !== "form") || schema?.type !== "object" ||
      !schema.properties || Object.keys(schema.properties).length || (schema.required?.length ?? 0)) return;
  const match=typeof p.message === "string" && /^Allow Browser use to access (https:\/\/[^\s]+\/)$/.exec(p.message);
  if(!match) return;
  try {
    const u=new URL(match[1]);
    if(u.protocol !== "https:" || u.port || u.username || u.password || u.pathname !== "/" || u.search || u.hash ||
       match[1] !== `${u.origin}/` || !allowedOrigins.includes(u.origin)) return;
    return u.origin;
  } catch { return; }
}

/** Other protocol approvals are answered by the app user, never by the model. */
export async function answerAppServerRequest(
  message: Rpc,
  ask: Ask,
  allowedBrowserOrigins: readonly string[] = [],
): Promise<unknown> {
  if(preauthorizedBrowserOrigin(message,allowedBrowserOrigins))
    return {action:"accept",content:{},_meta:null};
  const p = message.params ?? {},
    method = message.method;
  const request: WorkbenchRuntimeApproval = {
    id: randomUUID(),
    title: "Codex 실행 확인",
    detail: approvalText(p.reason ?? p.message),
    fields: [],
  };
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    request.title = method.includes("commandExecution")
      ? "명령 실행 허용"
      : "파일 변경 허용";
    request.detail = approvalText(
      [p.reason, p.command, p.cwd, p.grantRoot].filter(Boolean).join("\n"),
    );
    const answer = await ask(request);
    return { decision: answer.accepted ? "accept" : "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    request.title = "이 작업의 추가 접근 권한";
    request.detail = approvalText(
      `${p.reason ?? ""}\n${JSON.stringify(p.permissions)}`,
    );
    const answer = await ask(request);
    return {
      permissions: answer.accepted
        ? Object.fromEntries(
            Object.entries(p.permissions ?? {}).filter(([, v]) => v !== null),
          )
        : {},
      scope: "turn",
    };
  }
  if (method === "item/tool/requestUserInput") {
    if (!Array.isArray(p.questions) || p.questions.some((q: any) => q.isSecret))
      throw Error(
        "비밀 입력은 앱에 저장하지 않습니다. 해당 서비스에서 직접 인증하세요.",
      );
    request.title = "Codex가 확인을 요청했습니다";
    request.fields = p.questions.map((q: any) => ({
      id: q.id,
      label: approvalText(q.question),
      required: true,
      options:
        q.options?.length && !q.isOther
          ? q.options.map((o: any) => ({
              value: o.label,
              label: approvalText(`${o.label} — ${o.description}`),
            }))
          : undefined,
    }));
    const answer = await ask(request);
    if (!answer.accepted) return { answers: {} };
    for (const f of request.fields)
      if (!answer.values[f.id]) throw Error("필수 답변이 누락되었습니다.");
    return {
      answers: Object.fromEntries(
        request.fields.map((f) => [f.id, { answers: [answer.values[f.id]] }]),
      ),
    };
  }
  if (method === "mcpServer/elicitation/request") {
    if (p.mode === "url")
      throw Error(
        "외부 인증 화면이 필요한 요청입니다. 해당 서비스에서 인증을 완료한 뒤 앱에서 이어서 확인하세요.",
      );
    const schema = p.requestedSchema;
    if (!schema || schema.type !== "object" || !schema.properties)
      throw Error(
        "현재 앱이 지원하지 않는 권한 확인 형식입니다. 자동 허용하지 않았습니다.",
      );
    request.title = `${approvalText(p.serverName)} 접근 확인`;
    const definitions = Object.entries(schema.properties) as [string, any][];
    for (const [id, s] of definitions) {
      if (
        !["string", "boolean", "number", "integer"].includes(s.type) ||
        s.format === "password" ||
        s.writeOnly
      )
        throw Error("지원하지 않는 인증 입력입니다. 자동 허용하지 않았습니다.");
      const choices = s.enum ?? s.oneOf?.map((v: any) => v.const);
      request.fields.push({
        id,
        label: approvalText(
          s.description
            ? `${s.title ?? id} — ${s.description}`
            : (s.title ?? id),
        ),
        required: schema.required?.includes(id) ?? false,
        options:
          s.type === "boolean"
            ? [
                { value: "true", label: "허용" },
                { value: "false", label: "허용하지 않음" },
              ]
            : choices?.map((v: string, i: number) => ({
                value: v,
                label: approvalText(
                  s.enumNames?.[i] ?? s.oneOf?.[i]?.title ?? v,
                ),
              })),
      });
    }
    const answer = await ask(request);
    if (!answer.accepted)
      return { action: "decline", content: null, _meta: null };
    const content: Record<string, unknown> = {};
    for (const [id, s] of definitions) {
      const v = answer.values[id],
        field = request.fields.find((f) => f.id === id)!;
      if (v === undefined || v === "") {
        if (field.required) throw Error("필수 권한 항목을 선택하세요.");
        continue;
      }
      if (field.options && !field.options.some((o) => o.value === v))
        throw Error("허용되지 않은 권한 선택입니다.");
      let value: unknown = v;
      if (s.type === "boolean") {
        if (!["true", "false"].includes(v)) throw Error("잘못된 권한 응답");
        value = v === "true";
      }
      if (s.type === "number" || s.type === "integer") {
        const number = Number(v);
        if (
          !Number.isFinite(number) ||
          (s.type === "integer" && !Number.isInteger(number)) ||
          number < (s.minimum ?? -Infinity) ||
          number > (s.maximum ?? Infinity)
        )
          throw Error("잘못된 숫자 응답");
        value = number;
      }
      if (
        s.type === "string" &&
        (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? 12000))
      )
        throw Error("답변 길이를 확인하세요.");
      content[id] = value;
    }
    return { action: "accept", content, _meta: null };
  }
  // In particular, never manufacture attestation or account tokens.
  throw Error(`지원하지 않는 Codex 확인 요청: ${method}`);
}

/** Supported stdio client; policies apply to this child, never global settings. */
export class CodexAppServerWorker {
  private child?: ChildProcess;
  constructor(
    private options: {
      args: string[];
      env: Record<string, string>;
      cliPath?: string;
      timeoutMs?: number;
      allowedBrowserOrigins?: readonly string[];
    },
  ) {}
  shutdown() {
    if (this.child) this.terminate(this.child);
  }
  private terminate(child: ChildProcess) {
    if (child.exitCode !== null) return;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn(
        path.join(
          process.env.SystemRoot ?? "C:/Windows",
          "System32/taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, shell: false, stdio: "ignore" },
      );
      killer.on("error", () => child.kill());
    } else child.kill();
  }
  async run(
    task: WorkerTask & { requestApproval: Ask },
  ): Promise<{ result: unknown; threadId: string }> {
    const configured = path.join(
      process.env.LOCALAPPDATA ?? "",
      "Programs/OpenAI/Codex/bin/codex.exe",
    );
    const exe =
      this.options.cliPath ??
      (fs.existsSync(configured)
        ? configured
        : execFileSync(
            process.platform === "win32" ? "where.exe" : "which",
            ["codex"],
            { encoding: "utf8", windowsHide: true },
          )
            .trim()
            .split(/\r?\n/)[0]);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !(key.startsWith("CODEX_") && key !== "CODEX_HOME") &&
          !/^(BROWSER_USE_|CUA_|OPENAI_API_KEY$|CODEX_API_KEY$)/.test(key),
      ),
    );
    const child = spawn(
      exe,
      [
        "app-server",
        "--stdio",
        "-c",
        'approval_policy="on-request"',
        "-c",
        "features.image_generation=false",
        ...this.options.args,
      ],
      {
        cwd: task.run.workspace,
        env: { ...env, ...this.options.env },
        windowsHide: true,
        shell: false,
        stdio: "pipe",
      },
    );
    this.child = child;
    let seq = 0,
      buffer = "",
      threadId = "",
      turnId = "",
      finalText = "",
      done = false;
    const pending = new Map<
      number,
      { resolve: (result: any) => void; reject: (error: Error) => void }
    >();
    let complete!: (result: unknown) => void, fail!: (error: Error) => void;
    const finished = new Promise<unknown>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    // An early startup failure must not become an unhandled rejection.
    void finished.catch(() => {});
    const write = (value: unknown) => {
      if (!child.stdin?.destroyed)
        child.stdin?.write(JSON.stringify(value) + "\n");
    };
    const rpc = (method: string, params: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        if (done) {
          reject(Error("Codex 연결이 종료됐습니다."));
          return;
        }
        const id = ++seq;
        pending.set(id, { resolve, reject });
        write({ id, method, params });
      });
    const log = (event: unknown) =>
      fs.appendFileSync(
        path.join(path.dirname(task.resultPath), "app-server-events.jsonl"),
        JSON.stringify({ at: new Date().toISOString(), ...(event as object) }) +
          "\n",
      );
    const stop = (error: Error) => {
      if (done) return;
      done = true;
      for (const p of pending.values()) p.reject(error);
      pending.clear();
      fail(error);
      this.terminate(child);
    };
    const abort = () => {
      if (threadId && turnId)
        write({
          id: ++seq,
          method: "turn/interrupt",
          params: { threadId, turnId },
        });
      stop(Error("사용자가 작업을 취소했습니다."));
    };
    const timeout = setTimeout(
      () =>
        stop(
          Error(
            "Codex 실행 제한 시간에 도달했습니다. 기존 제출은 다시 보내지 않습니다.",
          ),
        ),
      this.options.timeoutMs ?? 30 * 60 * 1000,
    );
    task.signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => stop(error));
    child.once("exit", (code) => {
      if (!done) stop(Error(`Codex 연결 종료 (${code})`));
    });
    // Drain stderr without persisting auth or protocol payloads.
    child.stderr?.on("data", () => {});
    let approvalQueue = Promise.resolve();
    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let m: Rpc;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== undefined && !m.method) {
          const p = pending.get(Number(m.id));
          if (!p) continue;
          pending.delete(Number(m.id));
          if (m.error) p.reject(Error(approvalText(m.error.message)));
          else p.resolve(m.result);
        } else if (m.id !== undefined && m.method) {
          log({
            event: "approval.request",
            method: m.method,
            mode: m.params?.mode,
            server: m.params?.serverName,
          });
          approvalQueue = approvalQueue.then(async () => {
            if (done) return;
            try {
              const result = await answerAppServerRequest(
                m,
                task.requestApproval,
                this.options.allowedBrowserOrigins,
              );
              if (!done) write({ id: m.id, result });
              log({ event: "approval.response", method: m.method,
                ...(preauthorizedBrowserOrigin(m,this.options.allowedBrowserOrigins ?? []) ?
                  {source:"user-preauthorized-site",origin:preauthorizedBrowserOrigin(m,this.options.allowedBrowserOrigins ?? [])} : {}) });
            } catch (error) {
              write({
                id: m.id,
                error: { code: -32603, message: approvalText(error) },
              });
              stop(error instanceof Error ? error : Error(String(error)));
            }
          });
        } else {
          const p = m.params ?? {};
          if (m.method === "item/completed") {
            const item = p.item;
            if (item?.type === "agentMessage") {
              if (item.phase === "final_answer" || !item.phase)
                finalText = item.text;
              else
                task.onEvent({
                  type: "progress",
                  message: approvalText(item.text),
                });
            }
            if (item?.type === "mcpToolCall")
              log({
                event: "tool.completed",
                tool: item.tool,
                status: item.status,
              });
          }
          if (m.method === "thread/tokenUsage/updated")
            task.onEvent({ type: "usage", usage: p.tokenUsage });
          if (m.method === "turn/started") turnId = p.turn?.id ?? turnId;
          if (m.method === "turn/completed") {
            if (p.turn?.status !== "completed") {
              stop(
                Error(
                  approvalText(
                    p.turn?.error?.message ??
                      "Codex 작업이 완료되지 않았습니다.",
                  ),
                ),
              );
              continue;
            }
            try {
              const result = parseJsonText(finalText);
              fs.writeFileSync(
                task.resultPath,
                JSON.stringify(result, null, 2),
              );
              done = true;
              complete(result);
            } catch {
              stop(
                Error(
                  "Codex 완료 응답을 해석하지 못했습니다. 기존 결과는 보존됩니다.",
                ),
              );
            }
          }
        }
      }
    });
    try {
      if (task.signal.aborted) abort();
      await rpc("initialize", {
        clientInfo: { name: "partsmith", title: "Partsmith", version: "0.6.9" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          extensions: { "openai/form": {} },
        },
      });
      write({ method: "initialized" });
      const thread = await rpc("thread/start", {
        cwd: task.run.workspace,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        ephemeral: true,
      });
      threadId = thread.thread.id;
      log({ event: "thread.started", threadId });
      task.onEvent({ type: "thread.started", threadId });
      const turn = await rpc("turn/start", {
        threadId,
        input: [
          { type: "text", text: task.prompt, text_elements: [] },
          ...task.imagePaths.map((p) => ({ type: "localImage", path: p })),
        ],
        outputSchema: JSON.parse(fs.readFileSync(task.schemaPath, "utf8")),
      });
      turnId = turn.turn.id;
      return { result: await finished, threadId };
    } finally {
      clearTimeout(timeout);
      task.signal.removeEventListener("abort", abort);
      this.terminate(child);
      this.child = undefined;
    }
  }
}
