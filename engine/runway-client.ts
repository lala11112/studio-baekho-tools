import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { answerAppServerRequest, approvalText } from "./codex-app-server-worker";
import type { WorkbenchRuntimeApproval, WorkbenchRuntimeAnswer } from "../shared/workbench";

export type RunwayTool = "whoami" | "init_upload" | "complete_upload" | "generate_video" | "get_task";
export interface RunwayConnection {
  open(cwd: string, signal: AbortSignal, ask: (value: WorkbenchRuntimeApproval) => Promise<WorkbenchRuntimeAnswer>): Promise<void>;
  call(tool: RunwayTool, args: Record<string, unknown>): Promise<any>;
  close(): void;
}
/** Official connector calls. File parameters require Codex's normal tool-turn
 * upload adapter; other operations use direct RPC with no inference turn. */
export class CodexRunwayConnection implements RunwayConnection {
  constructor(private uploadOnly = false) {}
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private threadId = "";
  private tools = new Map<string, { server: string; name: string }>();
  private detach?: () => void;
  private context?: { cwd: string; signal: AbortSignal; ask: (value: WorkbenchRuntimeApproval) => Promise<WorkbenchRuntimeAnswer> };
  private notification?: (message: any) => void;
  private onClose?: () => void;
  private uploadChild?: CodexRunwayConnection;
  async open(cwd: string, signal: AbortSignal, ask: (value: WorkbenchRuntimeApproval) => Promise<WorkbenchRuntimeAnswer>) {
    this.context = { cwd, signal, ask };
    if (signal.aborted) throw Error("취소되었습니다.");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !(key.startsWith("CODEX_") && key !== "CODEX_HOME") && !/^(BROWSER_USE_|CUA_|OPENAI_API_KEY$|CODEX_API_KEY$)/.test(key)));
    const child = spawn(path.join(process.env.LOCALAPPDATA!, "Programs/OpenAI/Codex/bin/codex.exe"),
      ["app-server", "--stdio",
        ...(this.uploadOnly ? ["-c", "features.image_generation=false"] : [])],
      { cwd, env, windowsHide: true, shell: false, stdio: "pipe" });
    this.child = child;
    let buffer = "";
    const abort = () => this.close(); signal.addEventListener("abort", abort, { once: true });
    this.detach = () => signal.removeEventListener("abort", abort);
    child.stderr.on("data", () => {}); // Never log server credentials or authentication URLs.
    child.on("error", () => this.close()); child.on("exit", () => this.close());
    child.stdout.on("data", chunk => {
      buffer += chunk;
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) {
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.method && m.id !== undefined) {
          void answerAppServerRequest(m, ask).then(result => this.write({ id: m.id, result }))
            .catch(() => this.write({ id: m.id, error: { code: -32603, message: "사용자 확인이 완료되지 않았습니다." } }));
        } else if (this.pending.has(m.id)) {
          const pending = this.pending.get(m.id)!; this.pending.delete(m.id); clearTimeout(pending.timer);
          m.error ? pending.reject(Error(approvalText(m.error.message))) : pending.resolve(m.result);
        } else this.notification?.(m);
      }
    });
    await this.rpc("initialize", { clientInfo: { name: "partsmith", version: "0.6.18" }, capabilities: { experimentalApi: true, extensions: { "openai/form": {} } } });
    this.write({ method: "initialized" });
    const started = await this.rpc("thread/start", { cwd, ephemeral: true, approvalPolicy: "on-request", sandbox: "workspace-write",
      ...(this.uploadOnly ? { developerInstructions: "This is a single-file Runway upload task, not a coding task. Do not scan directories, repository files, memories, credentials or settings. Do not generate any media. Use only Runway whoami and init_upload for the exact user-provided local PNG. No shell commands, other apps, browser or delegation. Never retry a failed upload. Stop immediately after its first result. Do not repeat asset URLs in your final answer." } : {}) });
    this.threadId = started.thread.id;
    let cursor: string | null = null;
    do {
      const result = await this.rpc("mcpServerStatus/list", { threadId: this.threadId, limit: 100, detail: "toolsAndAuthOnly", cursor });
      for (const server of result.data ?? []) for (const t of Object.values(server.tools ?? {}) as any[]) {
        const match = /^runway\.(whoami|init_upload|complete_upload|generate_video|get_task)$/.exec(t.name);
        if (server.name === "codex_apps" && match) this.tools.set(match[1], { server: server.name, name: t.name });
      }
      cursor = result.nextCursor;
    } while (cursor);
    if (!this.tools.has("whoami")) throw Error("Runway 플러그인을 연결한 뒤 다시 확인하세요.");

  }
  private write(value: unknown) { if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(value) + "\n"); }
  private rpc(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(Error("Runway 연결이 종료되었습니다.")); return; }
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error("Runway 응답을 확인하지 못했습니다. 제출된 작업을 다시 생성하지 않습니다.")); }, 120000);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  async call(tool: RunwayTool, args: Record<string, unknown>) {
    if (tool === "init_upload" && typeof args.file === "string" && !this.uploadOnly) {
      const context = this.context!;
      const child = new CodexRunwayConnection(true); this.uploadChild = child;
      try { await child.open(context.cwd, context.signal, context.ask); return await child.uploadTurn(args.file); }
      finally { child.close(); this.uploadChild = undefined; }
    }
    const target = this.tools.get(tool); if (!target) throw Error(`Runway ${tool} 도구를 사용할 수 없습니다.`);
    const response = await this.rpc("mcpServer/tool/call", { threadId: this.threadId, server: target.server, tool: target.name, arguments: args });
    const value = response.structuredContent;
    if (response.isError || value?.error) {
      if (value?.error_code === "USER_NOT_LOGGED_IN") throw Error("Runway 계정 미연결: Runway 플러그인에서 로그인한 뒤 기존 작업 이어서 확인을 누르세요.");
      throw Error(approvalText(value?.error ?? response.content?.find((c: any) => c.type === "text")?.text ?? "Runway 도구 호출 실패"));
    }
    if (!value || typeof value !== "object") throw Error("Runway의 구조화된 응답을 확인하지 못했습니다.");
    return value;
  }
  private async uploadTurn(file: string): Promise<any> {
    let result: any, usage: any, finalText = "";
    const observed: string[] = [];
    return await new Promise((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => { reject(Error("원본 업로드 확인 시간이 초과되었습니다. 자동 재시도하지 않습니다.")); this.close(); }, 180000);
      const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); this.notification = undefined; this.onClose = undefined;
        if (error) reject(error); else if (result?.kind === "upload_complete" && result.assetUrl) resolve({ ...result, uploadModelTurns: 1, uploadUsage: usage });
        else reject(Error(`Codex 업로드 도구의 실제 완료 영수증을 받지 못했습니다. ${observed.join("; ")} ${approvalText(finalText).slice(0, 700)}`)); };
      this.onClose = () => finish(Error("원본 업로드 연결이 종료되었습니다."));
      this.notification = m => {
        if (m.method === "thread/tokenUsage/updated") usage = m.params?.tokenUsage;
        const item = m.params?.item;
        if (m.method === "item/completed" && item?.type === "agentMessage") finalText = item.text ?? "";
        if (m.method === "item/completed" && item?.type === "mcpToolCall") observed.push(`${item.server}/${item.tool}:${item.status}`);
        if (m.method === "item/completed" && item?.type === "mcpToolCall" && item.server === "codex_apps" && /^(?:mcp__codex_apps__)?runway[._]init_upload$/.test(item.tool)) {
          result = item.result?.structuredContent;
          if (!result) for (const content of item.result?.content ?? []) if (content.type === "text") { try { result = JSON.parse(content.text); } catch {} }
          if (item.error || result?.error) finish(Error(`Runway 원본 업로드 도구 실패: ${approvalText(item.error?.message ?? result.error)}`));
        }
        if (m.method === "turn/completed") finish(m.params?.turn?.status === "completed" ? undefined : Error("Codex 업로드 작업이 중단되었습니다."));
      };
      void this.rpc("turn/start", { threadId: this.threadId, input: [{ type: "text", text: `Upload only this already accepted local PNG to the connected Runway account: ${JSON.stringify(file)}. Use runway.whoami, then call runway.init_upload ONCE with the file argument set to this exact local path. Use the normal MCP tool so Codex handles openai/fileParams. Do not use raw mcpServer/tool/call. No shell, file scans, image inspection, browser, generation, retries or other files. The user authorized uploading this source; paid generation is NOT authorized. Stop after the tool returns; If successful, final text should say upload done without URLs. If unsuccessful, explain the exact tool availability or error reason without secret URLs.`, text_elements: [] }] }).catch(finish);
    });
  }
  close() {
    this.onClose?.(); this.onClose = undefined;
    this.uploadChild?.close(); this.uploadChild = undefined;
    const child = this.child; this.child = undefined;
    this.detach?.(); this.detach = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error("Runway 연결이 종료되었습니다.")); }
    this.pending.clear(); child?.stdin.end(); child?.kill();
  }
}
