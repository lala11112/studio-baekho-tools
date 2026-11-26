import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { CodexRpc, RpcObject } from './codex-transport';
import { claudeEnvironment } from './claude-runtime';

export interface ClaudeRunResult { stdout: string; code: number | null }
/** Runs one non-interactive Claude Code process; the prompt is written to stdin to avoid command-line limits. */
export type ClaudeRunner = (executable: string, args: string[], input: string, cwd: string, signal: AbortSignal) => Promise<ClaudeRunResult>;

const MAX_OUTPUT = 48 * 1024 * 1024;
export const CLAUDE_MODELS = [
  { model: 'fable', displayName: 'Claude Fable (최신)' },
  { model: 'opus', displayName: 'Claude Opus (최신)' },
  { model: 'sonnet', displayName: 'Claude Sonnet (최신)' },
  { model: 'haiku', displayName: 'Claude Haiku (최신)' },
];

export const runClaude: ClaudeRunner = (executable, args, input, cwd, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('aborted')); return; }
  const child = spawn(executable, args, { cwd, env: claudeEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const decoder = new StringDecoder('utf8');
  let stdout = ''; let failed = false;
  const onAbort = () => { child.kill(); };
  signal.addEventListener('abort', onAbort, { once: true });
  child.stderr.resume(); // Diagnostics can contain account/config details; do not log or persist them.
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += decoder.write(chunk);
    if (stdout.length > MAX_OUTPUT && !failed) { failed = true; child.kill(); reject(new Error('Claude Code 응답이 허용 크기를 초과했습니다.')); }
  });
  child.on('error', () => { if (!failed) { failed = true; reject(new Error('Claude Code 실행에 실패했습니다. 선택한 실행 파일과 설치 상태를 확인해 주세요.')); } });
  child.on('close', code => { signal.removeEventListener('abort', onAbort); if (!failed) resolve({ stdout: stdout + decoder.end(), code }); });
  child.stdin.on('error', () => undefined);
  child.stdin.end(input, 'utf8');
});

function claudeErrorMessage(text: string): string {
  const detail = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  const advice =
    /not logged in|\/login|unauthori[sz]ed|authenticat|credential|api.?key|oauth|\b40[13]\b/i.test(text) ? 'Claude Code 로그인 상태를 확인해 주세요.' :
    /rate.?limit|usage.?limit|quota|credit|\b429\b/i.test(text) ? '계정 사용량 제한과 재설정 시간을 확인해 주세요.' :
    /context|too long|too many tokens|prompt is too long/i.test(text) ? '입력 길이 제한을 확인해 주세요.' :
    /model/i.test(text) ? '선택한 모델의 지원 여부를 확인해 주세요.' :
    /overloaded|\b50[0-9]\b|internal/i.test(text) ? '서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' :
    'Claude Code 업데이트와 로그인·모델 설정을 확인해 주세요.';
  return `Claude Code 요청 실패. ${advice}${detail ? ` (${detail})` : ''}`;
}

function lastJsonObject(stdout: string): RpcObject | null {
  const trimmed = stdout.trim();
  try { const value = JSON.parse(trimmed); if (value && typeof value === 'object') return value as RpcObject; } catch { /* Try line-delimited output. */ }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try { const value = JSON.parse(line); if (value && typeof value === 'object' && (value as RpcObject).type === 'result') return value as RpcObject; } catch { /* Skip non-JSON lines. */ }
  }
  return null;
}

/** Parse `claude -p --output-format json` into the structured answer, or throw a user-facing error. */
export function parseClaudeResult(stdout: string): unknown {
  const result = lastJsonObject(stdout);
  if (!result) throw new Error('Claude Code 응답을 읽을 수 없습니다. CLI를 업데이트해 주세요.');
  const text = typeof result.result === 'string' ? result.result : '';
  if (result.is_error === true || (typeof result.subtype === 'string' && result.subtype.startsWith('error'))) throw new Error(claudeErrorMessage(text || String(result.subtype ?? '')));
  if (result.structured_output !== undefined && result.structured_output !== null) return result.structured_output;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  try { return JSON.parse(fenced.trim()); } catch { throw new Error('AI가 올바른 JSON을 반환하지 않았습니다.'); }
}

interface Thread { cwd: string; sessionId: string; model?: string; systemPrompt: string; turns: number; active?: { turnId: string; controller: AbortController } }

/**
 * Adapts Claude Code's headless print mode to the subset of the Codex app-server protocol used by AiService.
 * Each turn is one `claude -p` process with no tools, no MCP servers, no user/project settings and a
 * JSON-schema constrained answer. Repairs resume the same session so the model keeps the original context.
 */
export class ClaudeCodeTransport implements CodexRpc {
  private readonly threads = new Map<string, Thread>();
  private readonly notifications = new Set<(method: string, params: RpcObject) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly executable: string, private readonly directory: string, private readonly runner: ClaudeRunner = runClaude) {}

  async request(method: string, params: RpcObject): Promise<RpcObject> {
    if (this.closed) throw new Error('Claude Code 연결이 닫혀 있습니다. 다시 연결해 주세요.');
    switch (method) {
      case 'config/read': return { config: {} };
      case 'model/list': return { data: CLAUDE_MODELS };
      case 'account/read': return this.account();
      case 'account/login/start': return this.login();
      case 'thread/start': return this.startThread(params);
      case 'turn/start': return this.startTurn(params);
      case 'turn/interrupt': { const active = this.threads.get(String(params.threadId))?.active; if (active && active.turnId === params.turnId) active.controller.abort(); return {}; }
      case 'thread/unload': { const thread = this.threads.get(String(params.threadId)); thread?.active?.controller.abort(); this.threads.delete(String(params.threadId)); return {}; }
      default: throw new Error(`Claude Code 연결은 ${method} 요청을 지원하지 않습니다.`);
    }
  }

  private async account(): Promise<RpcObject> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const { stdout } = await this.runner(this.executable, ['auth', 'status', '--json'], '', this.directory, controller.signal);
      const status = lastJsonObject(stdout);
      if (!status) throw new Error('Claude Code 로그인 상태를 읽을 수 없습니다. CLI를 업데이트해 주세요.');
      return { account: status.loggedIn === true ? { type: 'claude', authMethod: typeof status.authMethod === 'string' ? status.authMethod : '' } : null };
    } catch (error) {
      throw controller.signal.aborted ? new Error('Claude Code 로그인 상태 확인 시간이 초과되었습니다.') : error;
    } finally { clearTimeout(timer); }
  }

  private login(): RpcObject {
    // Claude Code owns its OAuth flow and credentials. Give it a visible console so the user can finish sign-in.
    const child = spawn(this.executable, ['auth', 'login'], { cwd: this.directory, env: claudeEnvironment(), detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => undefined);
    child.unref();
    return { type: 'claude' };
  }

  private startThread(params: RpcObject): RpcObject {
    const cwd = typeof params.cwd === 'string' ? params.cwd : this.directory;
    const model = typeof params.model === 'string' && params.model ? params.model : undefined;
    const systemPrompt = [params.baseInstructions, params.developerInstructions].filter(text => typeof text === 'string' && text).join('\n\n');
    const id = randomUUID();
    this.threads.set(id, { cwd, sessionId: randomUUID(), model, systemPrompt, turns: 0 });
    return { thread: { id } };
  }

  private startTurn(params: RpcObject): RpcObject {
    const threadId = String(params.threadId);
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error('Claude Code 작업을 찾을 수 없습니다.');
    if (thread.active) throw new Error('Claude Code 작업이 이미 진행 중입니다.');
    const input = Array.isArray(params.input) ? params.input : [];
    const prompt = input.map(item => (item && typeof item === 'object' && typeof (item as RpcObject).text === 'string') ? (item as RpcObject).text as string : '').join('\n\n');
    const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands'];
    if (params.outputSchema) args.push('--json-schema', JSON.stringify(params.outputSchema));
    if (thread.systemPrompt) args.push('--system-prompt', thread.systemPrompt);
    if (thread.model) args.push('--model', thread.model);
    args.push(...(thread.turns === 0 ? ['--session-id', thread.sessionId] : ['--resume', thread.sessionId]));
    thread.turns++;
    const turnId = randomUUID();
    const controller = new AbortController();
    thread.active = { turnId, controller };
    const complete = (turn: RpcObject) => {
      if (thread.active?.turnId === turnId) thread.active = undefined;
      if (this.closed) return;
      for (const listener of [...this.notifications]) { try { listener('turn/completed', { threadId, turnId, turn: { id: turnId, ...turn } }); } catch { /* Observers cannot affect other observers. */ } }
    };
    // Defer so the caller receives the turn id before the completion notification.
    setImmediate(() => {
      void this.runner(this.executable, args, prompt, thread.cwd, controller.signal).then(({ stdout }) => {
        if (controller.signal.aborted) { complete({ status: 'interrupted' }); return; }
        const answer = parseClaudeResult(stdout);
        complete({ status: 'completed', items: [{ id: `${turnId}-answer`, type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(answer) }] });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) complete({ status: 'interrupted' });
        else complete({ status: 'failed', error: { message: error instanceof Error ? error.message : 'Claude Code 요청 실패' } });
      });
    });
    return { turn: { id: turnId } };
  }

  onNotification(listener: (method: string, params: RpcObject) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onClose(listener: () => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const thread of this.threads.values()) thread.active?.controller.abort();
    this.threads.clear();
    for (const listener of this.closeListeners) { try { listener(); } catch { /* Close every other subscriber too. */ } }
    this.closeListeners.clear();
    this.notifications.clear();
  }
}
