import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type RpcObject = Record<string, unknown>;
export type CodexErrorCategory='context'|'schema'|'model'|'auth'|'timeout'|'rate_limit'|'capability'|'server'|'request'|'unknown';
/** Retain only a numeric protocol code and allowlisted diagnostic category. */
export class CodexRpcError extends Error {
  readonly code:number|undefined;
  readonly category:CodexErrorCategory;
  constructor(raw:unknown){
    const error=raw&&typeof raw==='object'?raw as RpcObject:{};
    const code=typeof error.code==='number'&&Number.isSafeInteger(error.code)?error.code:undefined;
    const message=typeof error.message==='string'?error.message.slice(0,16000):'';
    const category:CodexErrorCategory=
      /context.{0,30}(?:length|window|limit)|too many tokens|(?:input|prompt).{0,30}(?:too long|too large)|token limit|maximum.{0,20}tokens/i.test(message)?'context':
      /schema|structured.?output|response_format|output.?format|additionalProperties|required property|json.{0,20}(?:invalid|unsupported)/i.test(message)?'schema':
      /rate.?limit|quota|usage.?limit|insufficient.{0,20}(?:credit|balance)|\b429\b/i.test(message)?'rate_limit':
      /unauthori[sz]ed|auth(?:entication|orization)|log.?in|credential|api.?key|token.{0,20}(?:expired|invalid)|\b40[13]\b/i.test(message)?'auth':
      /timed? out|timeout|\b(?:408|504)\b/i.test(message)?'timeout':
      /model.{0,40}(?:not found|not supported|unavailable|does not support|unsupported|invalid)|unsupported.{0,20}model|reasoning.{0,30}(?:unsupported|not supported)|unknown model|model_not_found/i.test(message)?'model':
      /capabilit|tool.{0,30}(?:not supported|unsupported)|multi.?agent|delegation/i.test(message)||code===-32601?'capability':
      /internal.{0,20}(?:server|error)|overloaded|service.{0,20}unavailable|\b50[023]\b/i.test(message)?'server':
      code===-32600||code===-32602?'request':'unknown';
    const advice:Record<CodexErrorCategory,string>={context:'입력 길이 제한을 확인해 주세요.',schema:'구조화된 JSON 응답 형식을 확인해 주세요.',model:'기본 모델과 추론 설정의 지원 여부를 확인해 주세요.',auth:'Codex의 ChatGPT 로그인 상태를 확인해 주세요.',timeout:'서버 응답 시간이 초과되었습니다.',rate_limit:'계정 사용량 제한과 재설정 시간을 확인해 주세요.',capability:'CLI와 요청 기능의 호환성을 확인해 주세요.',server:'서버가 요청을 처리하지 못했습니다.',request:'CLI 요청 규격을 확인해 주세요.',unknown:'CLI 업데이트와 로그인·모델 설정을 확인해 주세요.'};
    super(`Codex 요청 실패 [${category}${code!==undefined?`, RPC ${code}`:''}]. ${advice[category]}`);
    this.name='CodexRpcError';this.code=code;this.category=category;
  }
}
export interface CodexRpc {
  request(method: string, params: RpcObject): Promise<RpcObject>;
  onNotification(listener: (method: string, params: RpcObject) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

/** Launch one private app-server; never connect to or interrupt the user's desktop daemon. */
export class CodexTransport implements CodexRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: RpcObject) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly notifications = new Set<(method: string, params: RpcObject) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private sequence = 0;
  private closed = false;

  constructor(executable: string, directory: string, private readonly requestTimeoutMs = 30000) {
    const env = { ...process.env };
    // Managed ChatGPT login belongs to Codex. This app never receives its tokens.
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']) delete env[key];
    this.child = spawn(executable, [
      'app-server', '--disable', 'plugins', '--disable', 'apps', '--disable', 'shell_tool',
      '--disable', 'unified_exec', '--disable', 'multi_agent', '--disable', 'code_mode',
      '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
      '-c', 'web_search="disabled"',
    ], { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume(); // Diagnostics can contain account/config details; do not log or persist them.
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    this.child.on('error', () => this.fail('Codex 실행에 실패했습니다. 선택한 실행 파일과 설치 상태를 확인해 주세요.'));
    this.child.on('exit', () => this.fail('Codex 연결이 종료되었습니다. 연결 상태를 새로 확인한 뒤 다시 시도해 주세요.'));
    this.child.stdin.on('error', () => this.fail('Codex에 요청을 전달하지 못했습니다. 다시 연결해 주세요.'));
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'baekho_enemy_forge', title: 'Baekho Enemy Forge', version: '1.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }

  private receive(text: string): void {
    if (this.closed) return;
    this.buffer += text;
    if (this.buffer.length > 48 * 1024 * 1024) { this.fail('Codex 응답이 허용 크기를 초과했습니다.'); this.child.kill(); return; }
    let newline: number;
    while (!this.closed && (newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let packet: RpcObject;
      try { packet = JSON.parse(line) as RpcObject; }
      catch { this.fail('Codex 응답을 읽을 수 없습니다. CLI를 업데이트해 주세요.'); this.child.kill(); return; }
      if (!packet || typeof packet !== 'object') continue;
      if (typeof packet.method === 'string') {
        if (packet.id !== undefined) this.denyServerRequest(packet);
        else {
          const params = packet.params && typeof packet.params === 'object' ? packet.params as RpcObject : {};
          for (const listener of this.notifications) {
            if (this.closed) break;
            try { listener(packet.method, params); }
            catch { this.fail('Codex 출력 처리 중 오류가 발생했습니다. 다시 시도해 주세요.'); this.child.kill(); return; }
          }
        }
      } else if (typeof packet.id === 'number') {
        const call = this.pending.get(packet.id);
        if (!call) continue;
        clearTimeout(call.timer);
        this.pending.delete(packet.id);
        if (packet.error) call.reject(new CodexRpcError(packet.error));
        else call.resolve(packet.result && typeof packet.result === 'object' ? packet.result as RpcObject : {});
      }
    }
  }

  private denyServerRequest(packet: RpcObject): void {
    const method = String(packet.method);
    if (method.includes('requestApproval') && (method.includes('commandExecution') || method.includes('fileChange'))) {
      this.send({ id: packet.id, result: { decision: 'decline' } });
    } else if (method === 'item/permissions/requestApproval') {
      this.send({ id: packet.id, result: { permissions: {}, scope: 'turn' } });
    } else if (method === 'item/tool/call') {
      this.send({ id: packet.id, result: { contentItems: [], success: false } });
    } else if (method === 'item/tool/requestUserInput') {
      this.send({ id: packet.id, result: { answers: {} } });
    } else {
      // No token-sharing, arbitrary process execution or other delegated client actions.
      this.send({ id: packet.id, error: { code: -32601, message: 'This client does not support that request.' } });
    }
  }

  private send(packet: RpcObject): void {
    if (this.closed) throw new Error('Codex 연결이 닫혀 있습니다.');
    this.child.stdin.write(`${JSON.stringify(packet)}\n`);
  }

  request(method: string, params: RpcObject): Promise<RpcObject> {
    if (this.closed) return Promise.reject(new Error('Codex 연결이 닫혀 있습니다. 다시 연결해 주세요.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex 연결 응답 시간이 초과되었습니다. CLI 상태를 확인해 주세요.'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  onNotification(listener: (method: string, params: RpcObject) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onClose(listener: () => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = '';
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error(message)); }
    this.pending.clear();
    for (const listener of this.closeListeners) { try { listener(); } catch { /* Close every other subscriber too. */ } }
    this.closeListeners.clear();
    this.notifications.clear();
  }

  close(): void {
    this.fail('Codex 연결이 종료되었습니다.');
    this.child.stdin.end();
    this.child.kill();
  }
}
