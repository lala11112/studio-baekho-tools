import { appendFile, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MAP_JSON_SCHEMA, parseBindings } from '../../src/shared/map';
import { parseImageGenerationContext } from '../../src/shared/spatial-intent';
import { propCatalogPrompt } from '../../src/shared/props';
import { finalizeLayoutText } from './layout-result';
import { assertResolvedConceptSettings, parseConceptGenerationContext, parseConceptText } from '../../src/shared/concepts';
import type { AssetBinding, CodexModelInfo, CodexStatus, GenerationProgress, GenerationRegion, GenerationSettings, GenerationStage, GridMap } from '../../src/shared/types';
import { CodexTransport } from './codex-transport';
import type { CodexRpc, RpcObject } from './codex-transport';
import { atomicWrite } from './projects';
import { conceptPrompt, directLayoutPrompt, imagePrompt, layoutPrompt } from './prompts';
import { decodePngDataUrl, MAX_IMAGE_BYTES, validateGenerationRegion, validateSettings } from './validation';
import { discoverCodex, inspectRuntime } from './codex-runtime';
import type { CodexRuntime } from './codex-runtime';
export { discoverCodex } from './codex-runtime';
export type { CodexRuntime } from './codex-runtime';

export interface CodexOptions {
  dataDirectory: string;
  executable?: string;
  discover?: () => Promise<CodexRuntime | null>;
  /** Test/diagnostic override that returns an already initialized transport. */
  connect?: (runtime: CodexRuntime, directory: string) => Promise<CodexRpc>;
  onProgress?: (progress: GenerationProgress) => void;
}
interface ActiveJob {
  controller: AbortController; id: string; method: 'image' | 'direct'; threadId?: string; turnId?: string;
  model?: string; reasoningEffort?: string; tokenUsage?: GenerationProgress['tokenUsage'];
}
function object(value: unknown): RpcObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as RpcObject : {}; }
function childOf(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Codex owns authentication and model access; this service owns only an isolated child and job files. */
export class CodexService {
  private rpc: CodexRpc | null = null;
  private connectingRpc: CodexRpc | null = null;
  private runtime: CodexRuntime | null = null;
  private connection: Promise<CodexRpc | null> | null = null;
  private connectionVersion = 0;
  private disposed = false;
  private active: ActiveJob | null = null;
  private disabledMcpServers: RpcObject = {};
  private configuredModel?: string;
  private configuredEffort?: string;
  private metricWrites: Promise<unknown> = Promise.resolve();
  private selectedExecutable?: string;
  private readonly directory: string;
  private readonly jobsDirectory: string;
  constructor(private readonly options: CodexOptions) {
    this.directory = path.resolve(options.dataDirectory);
    this.jobsDirectory = path.join(this.directory, 'jobs');
    this.selectedExecutable = options.executable;
  }

  private async ensureConnection(): Promise<CodexRpc | null> {
    if (this.disposed) throw new Error('Codex 연결이 종료되었습니다.');
    if (this.rpc) return this.rpc;
    if (this.connection) return this.connection;
    const connection = this.connect(this.connectionVersion);
    this.connection = connection;
    try { return await connection; }
    finally { if (this.connection === connection) this.connection = null; }
  }

  private checkConnection(version: number): void {
    if (this.disposed || version !== this.connectionVersion) throw new Error('Codex 연결이 종료되거나 변경되었습니다.');
  }

  private resetConnection(): void {
    this.connectionVersion++;
    this.connection = null;
    const clients = new Set([this.rpc, this.connectingRpc]);
    this.rpc = null;
    this.connectingRpc = null;
    for (const client of clients) client?.close();
  }

  private async connect(version: number): Promise<CodexRpc | null> {
    await mkdir(this.jobsDirectory, { recursive: true });
    this.checkConnection(version);
    if (!this.selectedExecutable && !this.options.discover) {
      try {
        const saved = JSON.parse(await readFile(path.join(this.directory, 'codex-executable.json'), 'utf8'));
        if (typeof saved.path === 'string' && path.isAbsolute(saved.path)) this.selectedExecutable = saved.path;
      } catch { /* No custom executable preference yet. */ }
    }
    const runtime = this.options.discover ? await this.options.discover() : await discoverCodex(this.selectedExecutable);
    this.checkConnection(version);
    this.runtime = runtime;
    if (!runtime) return null;
    const client = this.options.connect ? await this.options.connect(runtime, this.directory) : new CodexTransport(runtime.executable, this.directory);
    try {
      this.checkConnection(version);
      this.connectingRpc = client;
      if (!this.options.connect && client instanceof CodexTransport) await client.initialize();
      this.checkConnection(version);
      // Disable every inherited MCP server individually: an empty table would deep-merge.
      const configuration = await client.request('config/read', { includeLayers: false, cwd: this.directory });
      this.checkConnection(version);
      const config = object(configuration.config);
      this.configuredModel = metricIdentifier(config.model);
      this.configuredEffort = metricIdentifier(config.model_reasoning_effort);
      this.disabledMcpServers = Object.fromEntries(Object.keys(object(config.mcp_servers)).map(name => [name, { enabled: false }]));
      client.onClose(() => { if (this.rpc === client) this.rpc = null; });
      this.rpc = client;
      if (this.connectingRpc === client) this.connectingRpc = null;
      return client;
    } catch (error) {
      if (this.connectingRpc === client) this.connectingRpc = null;
      client.close();
      throw error;
    }
  }

  async getStatus(): Promise<CodexStatus> {
    let client: CodexRpc | null = null;
    try {
      client = await this.ensureConnection();
      if (!client) return { state: 'missing', message: 'Codex 실행 파일을 찾지 못했습니다. Codex를 설치하거나 실행 파일을 선택해 주세요.', models: [] };
      const account = await client.request('account/read', { refreshToken: false });
      if (object(account.account).type !== 'chatgpt') return {
        state: 'login-required', message: 'Codex의 ChatGPT 로그인이 필요합니다. ChatGPT로 로그인한 뒤 연결을 다시 확인해 주세요.', version: this.runtime!.version, models: [],
      };
      const capabilities = await client.request('modelProvider/capabilities/read', {});
      const response = await client.request('model/list', { includeHidden: false, limit: 100 });
      const models: CodexModelInfo[] = (Array.isArray(response.data) ? response.data : []).map(object)
        .filter(model => typeof model.model === 'string')
        .map(model => ({ id: String(model.model), name: typeof model.displayName === 'string' ? model.displayName : String(model.model), isDefault: model.isDefault === true,
          ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image') } : {}) }));
      if (!models.length) return { state: 'error', message: '사용 가능한 모델을 찾지 못했습니다. Codex 계정과 모델 접근 권한을 확인해 주세요.', version: this.runtime!.version, models: [] };
      return { state: 'ready', message: 'Codex의 ChatGPT 로그인으로 연결되었습니다. 컨셉 작성·맵 생성은 Codex 사용량에 반영됩니다.', version: this.runtime!.version, models, imageGeneration: capabilities.imageGeneration === true };
    } catch (error) {
      if (client && this.rpc === client) this.resetConnection();
      return { state: 'error', message: error instanceof Error ? error.message : 'Codex 연결을 확인하지 못했습니다.', ...(this.runtime ? { version: this.runtime.version } : {}), models: [] };
    }
  }

  async startLogin(): Promise<string> {
    if (this.active) throw new Error('생성 작업이 끝난 뒤 로그인해 주세요.');
    const client = await this.ensureConnection();
    if (!client) throw new Error('Codex 실행 파일을 먼저 설치하거나 선택해 주세요.');
    const response = await client.request('account/login/start', { type: 'chatgpt' });
    if (response.type !== 'chatgpt' || typeof response.authUrl !== 'string') throw new Error('Codex 로그인 주소를 받지 못했습니다. Codex 앱에서 ChatGPT로 로그인해 주세요.');
    return validatedLoginUrl(response.authUrl);
  }

  async selectExecutable(executable: string): Promise<CodexStatus> {
    if (this.active) throw new Error('진행 중인 생성 작업을 완료하거나 취소한 뒤 Codex를 변경해 주세요.');
    const runtime = await inspectRuntime(executable);
    if (!runtime) throw new Error('선택한 파일을 Codex CLI로 실행할 수 없습니다. codex.exe를 선택해 주세요.');
    this.resetConnection();
    this.selectedExecutable = runtime.executable;
    await mkdir(this.directory, { recursive: true });
    await atomicWrite(path.join(this.directory, 'codex-executable.json'), JSON.stringify({ path: runtime.executable }, null, 2));
    return this.getStatus();
  }

  cancel(): void {
    const active = this.active;
    if (!active) return;
    if (active.threadId && active.turnId && this.rpc) void this.rpc.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }).catch(() => undefined);
    active.controller.abort();
    this.resetConnection();
  }

  close(): void { this.disposed = true; this.cancel(); this.resetConnection(); }

  private aborted(): Error {
    return new Error('Codex 생성이 취소되었습니다.');
  }

  private async duringJob<T>(promise: Promise<T>, job: ActiveJob): Promise<T> {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(this.aborted());
      job.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (job.controller.signal.aborted) onAbort();
      promise.then(resolve, reject).finally(() => job.controller.signal.removeEventListener('abort', onAbort));
    });
  }

  private progress(job: ActiveJob, id: string, stage: GenerationStage, state: GenerationProgress['state'], elapsedMs: number): void {
    // Build a fresh allow-listed record; never spread server notifications or user content into metrics.
    const event: GenerationProgress = { id, jobId: job.id, method: job.method, stage, state, elapsedMs: Math.max(0, Math.round(elapsedMs)),
      ...(job.model ? { model: job.model } : {}), ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
      ...(job.tokenUsage ? { tokenUsage: { ...job.tokenUsage } } : {}) };
    this.emitProgress(event);
  }

  private emitProgress(event: GenerationProgress): void {
    try { this.options.onProgress?.(structuredClone(event)); } catch { /* Observers cannot break generation. */ }
    if (event.state !== 'running') {
      this.metricWrites = this.metricWrites.then(async () => {
        await mkdir(this.directory, { recursive: true });
        await appendFile(path.join(this.directory, 'generation-metrics.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
      }).catch(() => undefined); // Diagnostics must never mask success, failure or cancellation.
    }
  }

  async recordGenerationStage(input: unknown): Promise<void> {
    const value = object(input), fields = ['id', 'jobId', 'method', 'stage', 'state', 'elapsedMs'];
    const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
    if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) || !uuid(value.id) || !uuid(value.jobId)
      || typeof value.method !== 'string' || !['image', 'direct'].includes(value.method) || typeof value.stage !== 'string' || !['placement', 'validation'].includes(value.stage)
      || typeof value.state !== 'string' || !['completed', 'failed', 'cancelled'].includes(value.state) || typeof value.elapsedMs !== 'number' || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) {
      throw new Error('생성 단계 측정값이 올바르지 않습니다.');
    }
    const event: GenerationProgress = { id: value.id, jobId: value.jobId, method: value.method as 'image' | 'direct',
      stage: value.stage as 'placement' | 'validation', state: value.state as GenerationProgress['state'], elapsedMs: value.elapsedMs };
    this.emitProgress(event);
    await this.metricWrites;
  }

  private async stage<T>(job: ActiveJob, stage: GenerationStage, operation: () => T | Promise<T>): Promise<T> {
    const id = randomUUID(), started = performance.now();
    this.progress(job, id, stage, 'running', 0);
    try {
      if (job.controller.signal.aborted) throw this.aborted();
      const result = await operation();
      if (job.controller.signal.aborted) throw this.aborted();
      this.progress(job, id, stage, 'completed', performance.now() - started);
      return result;
    } catch (error) {
      this.progress(job, id, stage, job.controller.signal.aborted ? 'cancelled' : 'failed', performance.now() - started);
      throw error;
    }
  }

  private async runJob<T>(settings: GenerationSettings, stage: 'concept' | 'image' | 'extract' | 'layout', operation: (client: CodexRpc, job: ActiveJob, directory: string) => Promise<T>): Promise<T> {
    if (this.active) throw new Error('이미 Codex 생성이 진행 중입니다. 완료하거나 취소한 뒤 다시 시도해 주세요.');
    const job: ActiveJob = { controller: new AbortController(), id: randomUUID(), method: stage === 'layout' ? 'direct' : stage === 'concept' ? settings.generationMethod ?? 'image' : 'image',
      model: metricIdentifier(settings.codexModel) ?? this.configuredModel, reasoningEffort: this.configuredEffort };
    this.active = job;
    let directory: string | undefined;
    try {
      await this.stage(job, 'preparing', async () => {
        const status = await this.duringJob(this.getStatus(), job);
        job.model = metricIdentifier(settings.codexModel) ?? this.configuredModel;
        job.reasoningEffort = this.configuredEffort;
        if (job.controller.signal.aborted) throw this.aborted();
        if (status.state !== 'ready') throw new Error(status.message);
        if (settings.codexModel && !status.models.some(model => model.id === settings.codexModel)) throw new Error('선택한 모델을 현재 Codex 계정에서 사용할 수 없습니다. 연결 상태를 새로 확인하고 모델을 선택해 주세요.');
        if (stage === 'image' && status.imageGeneration === false) throw new Error('현재 Codex 연결에서 이미지 생성을 지원하지 않습니다. 직접 생성 모드를 사용하거나 Codex의 이미지 생성 지원을 확인해 주세요.');
        const selected = status.models.find(model => model.id === job.model) ?? (!job.model ? status.models.find(model => model.isDefault) : undefined);
        if (stage === 'extract' && selected?.inputModalities && !selected.inputModalities.includes('image')) throw new Error('선택한 Codex 모델은 이미지 입력을 지원하지 않습니다. 이미지 입력 모델을 선택하거나 직접 생성 모드를 사용해 주세요.');
        const client = this.rpc!;
        directory = await mkdtemp(path.join(this.jobsDirectory, 'map-'));
        const started = await this.duringJob(client.request('thread/start', {
          ephemeral: true, cwd: directory, environments: [], sandbox: 'read-only', approvalPolicy: 'never',
          selectedCapabilityRoots: [],
          ...(settings.codexModel ? { model: settings.codexModel } : {}),
          config: { mcp_servers: this.disabledMcpServers },
          baseInstructions: 'You are a focused map design assistant embedded in Baekho Map Forge. Write a Korean map concept as requested JSON, generate requested PNG images with the native image_generation tool, interpret a supplied image as the required JSON map, or design the required JSON map directly from the supplied settings and brief. You have no coding, browsing, terminal, filesystem, app, or delegation task. Work only from the provided settings, map description, catalog and optional image.',
          developerInstructions: 'You are the map design engine of Baekho Map Forge. Write concepts and directly requested JSON maps without tools, use only the native image generation tool for requested images, and use your own visual reasoning for grid extraction. Explicit generation settings override creative concept details. Do not run commands, read unrelated files, use external apps, browse, spawn agents, or modify any project. Follow the exact output contract. Do not replace failures with sample data.',
        }), job);
        const thread = object(started.thread);
        if (typeof thread.id !== 'string') throw new Error('Codex 작업을 시작하지 못했습니다. CLI를 업데이트해 주세요.');
        job.threadId = thread.id;
        job.model = metricIdentifier(started.model) ?? metricIdentifier(thread.model) ?? job.model;
        job.reasoningEffort = metricIdentifier(started.reasoningEffort) ?? metricIdentifier(started.effort) ?? metricIdentifier(thread.reasoningEffort) ?? job.reasoningEffort;
        if (stage === 'extract') {
          const resolved = status.models.find(model => model.id === job.model);
          if (resolved?.inputModalities && !resolved.inputModalities.includes('image')) throw new Error('선택한 Codex 모델은 이미지 입력을 지원하지 않습니다. 이미지 입력 모델을 선택하거나 직접 생성 모드를 사용해 주세요.');
        }
        if (job.controller.signal.aborted) throw this.aborted();
      });
      return await operation(this.rpc!, job, directory!);
    } catch (error) {
      if (job.controller.signal.aborted) throw this.aborted();
      throw error;
    } finally {
      if (job.threadId && this.rpc && !job.controller.signal.aborted) {
        await this.rpc.request('thread/unload', { threadId: job.threadId }).catch(() => this.resetConnection());
      }
      if (directory && path.dirname(directory) === this.jobsDirectory && path.basename(directory).startsWith('map-')) {
        await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined);
      }
      if (this.active === job) this.active = null;
      await this.metricWrites;
    }
  }

  private async turn(client: CodexRpc, job: ActiveJob, params: RpcObject): Promise<RpcObject[]> {
    return new Promise((resolve, reject) => {
      const items = new Map<string, RpcObject>();
      let settled = false;
      const keep = (raw: unknown) => {
        const item = object(raw);
        if (typeof item.id !== 'string' || !['imageGeneration', 'agentMessage'].includes(String(item.type))) return;
        if (items.size > 100 || (typeof item.text === 'string' && item.text.length > 2 * 1024 * 1024)) throw new Error('Codex 응답이 허용 크기를 초과했습니다.');
        items.set(item.id, item);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        stopNotifications(); stopClose(); job.controller.signal.removeEventListener('abort', onAbort);
        if (error && !job.controller.signal.aborted) this.resetConnection();
        error ? reject(error) : resolve([...items.values()]);
      };
      const onAbort = () => finish(this.aborted());
      const stopClose = client.onClose(() => finish(new Error('Codex 연결이 작업 중 종료되었습니다. 다시 연결한 뒤 시도해 주세요.')));
      const stopNotifications = client.onNotification((method, notification) => {
        if (notification.threadId !== job.threadId) return;
        if (job.turnId && typeof notification.turnId === 'string' && notification.turnId !== job.turnId) return;
        try {
          if (method === 'thread/tokenUsage/updated') job.tokenUsage = metricTokenUsage(notification.tokenUsage) ?? job.tokenUsage;
          if (method === 'item/completed') keep(notification.item);
          if (method === 'turn/completed') {
            const turn = object(notification.turn);
            if (job.turnId && turn.id !== job.turnId) return;
            job.tokenUsage = metricTokenUsage(turn.tokenUsage) ?? job.tokenUsage;
            if (Array.isArray(turn.items)) turn.items.forEach(keep);
            if (turn.status === 'completed') finish();
            else if (turn.status === 'interrupted') finish(new Error('Codex 생성이 취소되었습니다.'));
            else finish(codexTurnError(object(turn.error)));
          }
        } catch (error) { finish(error instanceof Error ? error : new Error('Codex 출력 처리에 실패했습니다.')); }
      });
      job.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (job.controller.signal.aborted) { onAbort(); return; }
      void client.request('turn/start', { threadId: job.threadId, ...params }).then(response => {
        const turn = object(response.turn);
        if (typeof turn.id !== 'string') { finish(new Error('Codex 생성 응답에 작업 ID가 없습니다.')); return; }
        job.turnId = turn.id;
      }).catch(error => finish(error instanceof Error ? error : new Error('Codex 생성 요청에 실패했습니다.')));
    });
  }

  async generateConcept(input: unknown, catalogInput?: unknown, contextInput?: unknown): Promise<string> {
    const settings = validateSettings(input);
    const catalog = catalogInput === undefined ? undefined : parseBindings(catalogInput);
    const context = parseConceptGenerationContext(contextInput);
    if (context?.currentMap && (context.currentMap.width !== settings.width || context.currentMap.height !== settings.height
      || context.currentMap.cellSize !== settings.cellSize || context.currentMap.maxStepHeight !== settings.maxStepHeight)) {
      throw new Error('컨셉 작성에 참고할 현재 맵이 생성 설정과 다릅니다.');
    }
    return this.runJob(settings, 'concept', (client, job) => this.stage(job, 'concept', async () => {
      const items = await this.turn(client, job, {
        input: [{ type: 'text', text: conceptPrompt(settings, catalog, context) }],
        outputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['text'], additionalProperties: false },
      });
      const messages = items.filter(item => item.type === 'agentMessage' && typeof item.text === 'string');
      const final = [...messages].reverse().find(item => item.phase === 'final_answer')
        ?? [...messages].reverse().find(item => item.phase === null || item.phase === undefined);
      let response: unknown;
      try { response = JSON.parse(String(final?.text ?? '')); }
      catch { throw new Error('Codex가 올바른 컨셉 JSON을 반환하지 않았습니다. 컨셉 작성을 다시 시도해 주세요.'); }
      const fields = object(response);
      if (Object.keys(fields).length !== 1 || !Object.hasOwn(fields, 'text')) throw new Error('Codex 컨셉 응답은 text만 포함해야 합니다. 다시 시도해 주세요.');
      return parseConceptText(fields.text, 'ai');
    }));
  }

  async generateImage(input: unknown, regionInput?: unknown, catalogInput?: unknown, contextInput?: unknown): Promise<string> {
    const settings = validateSettings(input);
    assertResolvedConceptSettings(settings);
    const region=validateGenerationRegion(regionInput,settings);
    const catalog=catalogInput===undefined?undefined:parseBindings(catalogInput);
    const imageContext = parseImageGenerationContext(contextInput);
    return this.runJob(settings, 'image', (client, job, directory) => this.stage(job, 'image', async () => {
      const startedAt = Date.now();
      const items = await this.turn(client, job, { input: [{ type: 'text', text: `Use the native image_generation tool now to generate exactly ONE opaque PNG image. Do not draw with code or return SVG/text as an image. Do not create additional variants.\n\n${imagePrompt(settings,region,imageContext)}\n${catalog?propCatalogPrompt(catalog):''}` }] });
      const generated = items.filter(item => item.type === 'imageGeneration');
      const image = generated.find(item => item.status === 'completed' && !item.failure);
      if (!image) {
        if (generated.some(item => object(item.failure).type === 'usageLimitExceeded')) throw new Error('Codex 이미지 생성 사용량 한도에 도달했습니다. Codex에서 한도와 초기화 시간을 확인해 주세요.');
        throw new Error('Codex가 이미지를 생성하지 못했습니다. Codex의 이미지 생성 지원과 사용량을 확인한 뒤 다시 시도해 주세요.');
      }
      if (typeof image.result === 'string' && image.result.length > 0) {
        const dataUrl = image.result.startsWith('data:image/png;base64,') ? image.result : `data:image/png;base64,${image.result}`;
        try { decodePngDataUrl(dataUrl); return dataUrl; } catch { /* Some runtimes deliver only a savedPath. */ }
      }
      if (typeof image.savedPath === 'string') {
        const resolved = path.resolve(image.savedPath);
        // Only a native image-generation event can supply this path, never assistant prose.
        const info = await lstat(resolved).catch(() => null);
        if (path.isAbsolute(image.savedPath) && path.extname(resolved).toLowerCase() === '.png' && info?.isFile() && !info.isSymbolicLink()
          && info.size <= MAX_IMAGE_BYTES && (childOf(directory, resolved) || info.mtimeMs >= startedAt - 5000)) {
          const dataUrl = `data:image/png;base64,${(await readFile(resolved)).toString('base64')}`;
          decodePngDataUrl(dataUrl);
          return dataUrl;
        }
      }
      throw new Error('Codex의 PNG 이미지 결과를 읽을 수 없습니다. CLI를 업데이트한 뒤 다시 시도해 주세요.');
    }));
  }

  async extractLayout(input: unknown, imageDataUrl: unknown, regionInput?: unknown, catalogInput?: unknown): Promise<GridMap> {
    const settings = validateSettings(input);
    assertResolvedConceptSettings(settings);
    const region=validateGenerationRegion(regionInput,settings);
    const catalog=catalogInput===undefined?undefined:parseBindings(catalogInput);
    decodePngDataUrl(imageDataUrl);
    return this.runJob(settings, 'extract', async (client, job) => {
      const items = await this.stage(job, 'extract', () => this.turn(client, job, {
        input: [{ type: 'text', text: `${layoutPrompt(settings,region)}\n${catalog?propCatalogPrompt(catalog):''}\nDo not use any tools. Inspect the attached image directly and return only the schema-conforming map JSON.` }, { type: 'image', url: imageDataUrl, detail: 'high' }],
        outputSchema: MAP_JSON_SCHEMA,
      }));
      return this.finalizeLayout(items, settings, region, catalog, job);
    });
  }

  async generateLayout(input: unknown, regionInput?: unknown, catalogInput?: unknown, contextInput?: unknown): Promise<GridMap> {
    const settings = validateSettings(input);
    assertResolvedConceptSettings(settings);
    const region = validateGenerationRegion(regionInput, settings);
    const catalog = catalogInput === undefined ? undefined : parseBindings(catalogInput);
    const context = parseImageGenerationContext(contextInput);
    return this.runJob(settings, 'layout', async (client, job) => {
      const items = await this.stage(job, 'layout', () => this.turn(client, job, {
        input: [{ type: 'text', text: `${directLayoutPrompt(settings, region, context)}\n${catalog ? propCatalogPrompt(catalog) : ''}\nDo not use any tools. Return only the schema-conforming map JSON.` }],
        outputSchema: MAP_JSON_SCHEMA,
      }));
      return this.finalizeLayout(items, settings, region, catalog, job);
    });
  }

  private async finalizeLayout(items: RpcObject[], settings: GenerationSettings, region: GenerationRegion | undefined, catalog: AssetBinding[] | undefined, job: ActiveJob): Promise<GridMap> {
    const messages = items.filter(item => item.type === 'agentMessage' && typeof item.text === 'string');
    const final = [...messages].reverse().find(item => item.phase === 'final_answer')
      ?? [...messages].reverse().find(item => item.phase === null || item.phase === undefined);
    return finalizeLayoutText(typeof final?.text === 'string' ? final.text : undefined, settings, region, catalog, job.method,
      (stage, operation) => this.stage(job, stage, operation), 'Codex');
  }
}

function metricIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value) ? value : undefined;
}

function metricTokenUsage(raw: unknown): GenerationProgress['tokenUsage'] | undefined {
  const usage = object(raw), values = object(usage.total ?? usage.last ?? raw);
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!count(values.inputTokens) || !count(values.outputTokens)) return undefined;
  return { inputTokens: values.inputTokens, outputTokens: values.outputTokens,
    ...(count(values.reasoningOutputTokens) ? { reasoningOutputTokens: values.reasoningOutputTokens } : {}),
    ...(count(values.cachedInputTokens) ? { cachedInputTokens: values.cachedInputTokens } : {}) };
}

export function validatedLoginUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Codex 로그인 주소가 올바르지 않습니다.'); }
  if (url.protocol !== 'https:' || !['auth.openai.com', 'auth.chatgpt.com', 'chatgpt.com'].includes(url.hostname)
    || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Codex에서 허용되지 않은 로그인 주소를 반환했습니다.');
  return url.href;
}

function codexTurnError(error: RpcObject): Error {
  const message = typeof error.message === 'string' ? error.message : '';
  if (/usage|rate.?limit|quota|credit|limit exceeded/i.test(message)) return new Error('Codex 사용량 한도에 도달했습니다. Codex에서 사용량과 초기화 시간을 확인해 주세요.');
  if (/auth|login|unauthori|forbidden|401|403/i.test(message)) return new Error('Codex 로그인이 만료되었거나 접근 권한이 없습니다. ChatGPT 로그인을 다시 확인해 주세요.');
  return new Error('Codex가 생성 작업을 완료하지 못했습니다. 연결·모델·사용량을 확인한 뒤 다시 시도해 주세요.');
}
