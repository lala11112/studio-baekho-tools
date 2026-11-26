import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MAP_JSON_SCHEMA, parseBindings } from '../../src/shared/map';
import { parseImageGenerationContext } from '../../src/shared/spatial-intent';
import { propCatalogPrompt } from '../../src/shared/props';
import { assertResolvedConceptSettings, parseConceptGenerationContext, parseConceptText } from '../../src/shared/concepts';
import type { ClaudeStatus, GenerationProgress, GenerationRegion, GenerationSettings, GenerationStage, GridMap, AssetBinding } from '../../src/shared/types';
import { atomicWrite } from './projects';
import { conceptPrompt, directLayoutPrompt, layoutPrompt } from './prompts';
import { decodePngDataUrl, validateGenerationRegion, validateSettings } from './validation';
import { finalizeLayoutText } from './layout-result';

const execute = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const LABEL = 'Claude Code';
const SYSTEM_PROMPT = [
  'You are the map design engine of Baekho Map Forge, a focused map design assistant.',
  'Write Korean map concepts, interpret a supplied blueprint image as the required JSON map, or design the required JSON map directly from the supplied settings and brief.',
  'You have no coding, browsing, terminal, filesystem, app, or delegation task. Do not use tools other than returning the structured output.',
  'Explicit generation settings override creative concept details. Follow the exact output contract and never replace failures with sample data.',
].join(' ');

export interface ClaudeRuntime { executable: string; version: string }
export interface ClaudeCodeOptions {
  dataDirectory: string;
  discover?: (selected?: string) => Promise<ClaudeRuntime | null>;
  onProgress?: (progress: GenerationProgress) => void;
  /** Resolves the Claude model to request; empty or undefined uses Claude Code's default. */
  model?: () => string | undefined;
}
interface ActiveJob { id: string; method: 'image' | 'direct'; controller: AbortController; model?: string; tokenUsage?: GenerationProgress['tokenUsage'] }
type Json = Record<string, unknown>;
function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }

/** Only native executables are run; npm .cmd/.ps1 wrappers would need a shell. */
export async function inspectClaudeRuntime(candidate: string): Promise<ClaudeRuntime | null> {
  try {
    if (process.platform === 'win32' && path.extname(candidate).toLowerCase() !== '.exe') return null;
    const absolute = await realpath(candidate);
    if (!(await lstat(absolute)).isFile()) return null;
    const { stdout } = await execute(absolute, ['--version'], { timeout: 15000, maxBuffer: 65536, windowsHide: true });
    const version = stdout.match(/(\d+\.\d+\.\d+[\w.+-]*)\s*\(Claude Code\)/)?.[1];
    return version ? { executable: absolute, version } : null;
  } catch { return null; }
}

export async function discoverClaude(selected?: string, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeRuntime | null> {
  const isFile = async (candidate: string) => (await lstat(candidate).catch(() => null))?.isFile() ?? false;
  if (selected && await isFile(selected)) return inspectClaudeRuntime(selected);
  const windows = process.platform === 'win32';
  const name = windows ? 'claude.exe' : 'claude';
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const candidates = [path.join(home, '.local', 'bin', name), path.join(home, '.claude', 'local', name)];
  const pathEntries = (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':')
    .map(directory => directory.trim().replace(/^"|"$/g, '')).filter(directory => path.isAbsolute(directory)).slice(0, 256);
  candidates.push(...pathEntries.map(directory => path.join(directory, name)));
  for (const candidate of new Set(candidates)) {
    if (!await isFile(candidate)) continue;
    const runtime = await inspectClaudeRuntime(candidate);
    if (runtime) return runtime;
  }
  return null;
}

/** Runs concept writing and layout design/analysis through the local Claude Code CLI in headless mode. */
export class ClaudeCodeService {
  private runtime: ClaudeRuntime | null = null;
  private selectedExecutable?: string;
  private preferenceLoaded = false;
  private active: ActiveJob | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private metricWrites: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly directory: string;
  private readonly jobsDirectory: string;
  constructor(private readonly options: ClaudeCodeOptions) {
    this.directory = path.resolve(options.dataDirectory);
    this.jobsDirectory = path.join(this.directory, 'jobs');
  }

  private async resolveRuntime(): Promise<ClaudeRuntime | null> {
    if (!this.preferenceLoaded) {
      this.preferenceLoaded = true;
      try {
        const saved = JSON.parse(await readFile(path.join(this.directory, 'claude-executable.json'), 'utf8'));
        if (typeof saved.path === 'string' && path.isAbsolute(saved.path)) this.selectedExecutable = saved.path;
      } catch { /* No custom executable preference yet. */ }
    }
    this.runtime = await (this.options.discover ?? discoverClaude)(this.selectedExecutable);
    return this.runtime;
  }

  async getStatus(): Promise<ClaudeStatus> {
    try {
      const runtime = await this.resolveRuntime();
      if (!runtime) return { state: 'missing', message: 'Claude Code 실행 파일(claude.exe)을 찾지 못했습니다. Claude Code를 설치하거나 실행 파일을 선택해 주세요.' };
      let output = '';
      try { output = (await execute(runtime.executable, ['auth', 'status'], { timeout: 15000, maxBuffer: 65536, windowsHide: true })).stdout; }
      catch (error) { output = String(object(error).stdout ?? ''); } // Exits non-zero when logged out but still prints JSON.
      let status: Json = {};
      try { status = object(JSON.parse(output)); } catch { /* Older CLIs may not print JSON; let generation report auth errors. */ }
      if (status.loggedIn === false) return { state: 'login-required', message: 'Claude Code 로그인이 필요합니다. 터미널에서 claude를 실행해 /login으로 로그인한 뒤 새로고침해 주세요.', version: runtime.version };
      return { state: 'ready', message: 'Claude Code로 연결되었습니다. 컨셉 작성·배치 분석·구조 설계는 Claude 사용량에 반영됩니다.', version: runtime.version };
    } catch (error) {
      return { state: 'error', message: error instanceof Error ? error.message : 'Claude Code 연결을 확인하지 못했습니다.', ...(this.runtime ? { version: this.runtime.version } : {}) };
    }
  }

  async selectExecutable(executable: string): Promise<ClaudeStatus> {
    if (this.active) throw new Error('진행 중인 생성 작업을 완료하거나 취소한 뒤 Claude Code를 변경해 주세요.');
    const runtime = await inspectClaudeRuntime(executable);
    if (!runtime) throw new Error('선택한 파일을 Claude Code CLI로 실행할 수 없습니다. claude.exe를 선택해 주세요.');
    this.selectedExecutable = runtime.executable;
    this.preferenceLoaded = true;
    await mkdir(this.directory, { recursive: true });
    await atomicWrite(path.join(this.directory, 'claude-executable.json'), JSON.stringify({ path: runtime.executable }, null, 2));
    return this.getStatus();
  }

  cancel(): void {
    this.active?.controller.abort();
    this.killChild();
  }

  close(): void { this.disposed = true; this.cancel(); }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
  }

  private aborted(): Error { return new Error('Claude Code 생성이 취소되었습니다.'); }

  private progress(job: ActiveJob, id: string, stage: GenerationStage, state: GenerationProgress['state'], elapsedMs: number): void {
    const event: GenerationProgress = { id, jobId: job.id, method: job.method, stage, state, elapsedMs: Math.max(0, Math.round(elapsedMs)),
      ...(job.model ? { model: job.model } : {}), ...(job.tokenUsage ? { tokenUsage: { ...job.tokenUsage } } : {}) };
    try { this.options.onProgress?.(structuredClone(event)); } catch { /* Observers cannot break generation. */ }
    if (state !== 'running') {
      this.metricWrites = this.metricWrites.then(async () => {
        await mkdir(this.directory, { recursive: true });
        await appendFile(path.join(this.directory, 'generation-metrics.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
      }).catch(() => undefined);
    }
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
      throw job.controller.signal.aborted ? this.aborted() : error;
    }
  }

  private async runJob<T>(method: 'image' | 'direct', operation: (job: ActiveJob, directory: string, runtime: ClaudeRuntime) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('Claude Code 연결이 종료되었습니다.');
    if (this.active) throw new Error('이미 Claude Code 생성이 진행 중입니다. 완료하거나 취소한 뒤 다시 시도해 주세요.');
    const model = modelIdentifier(this.options.model?.());
    const job: ActiveJob = { id: randomUUID(), method, controller: new AbortController(), ...(model ? { model } : {}) };
    this.active = job;
    let directory: string | undefined;
    try {
      const runtime = await this.stage(job, 'preparing', async () => {
        const status = await this.getStatus();
        if (status.state !== 'ready') throw new Error(status.message);
        await mkdir(this.jobsDirectory, { recursive: true });
        directory = await mkdtemp(path.join(this.jobsDirectory, 'map-'));
        return this.runtime!;
      });
      return await operation(job, directory!, runtime);
    } finally {
      this.killChild();
      if (directory && path.dirname(directory) === this.jobsDirectory && path.basename(directory).startsWith('map-')) {
        await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined);
      }
      if (this.active === job) this.active = null;
      await this.metricWrites;
    }
  }

  /** One headless, tool-less Claude Code turn that must return JSON matching the schema. */
  private query(job: ActiveJob, runtime: ClaudeRuntime, directory: string, prompt: string, schema: object, imageDataUrl?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--json-schema', JSON.stringify(schema), '--tools', '', '--strict-mcp-config', '--no-session-persistence',
        '--system-prompt', SYSTEM_PROMPT, ...(job.model ? ['--model', job.model] : [])];
      const child = spawn(runtime.executable, args, { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let settled = false, buffer = '', received = 0, stderr = '';
      let result: Json | undefined;
      const timer = setTimeout(() => finish(new Error('Claude Code 응답 시간이 초과되었습니다. 다시 시도해 주세요.')), JOB_TIMEOUT_MS);
      const onAbort = () => finish(this.aborted());
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.controller.signal.removeEventListener('abort', onAbort);
        if (this.child === child) this.killChild();
        error ? reject(error) : resolve(value);
      };
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let message: Json;
        try { message = object(JSON.parse(line)); } catch { return; }
        if (message.type === 'system' && message.subtype === 'init') job.model = modelIdentifier(message.model) ?? job.model;
        if (message.type === 'result') result = message;
      };
      job.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (job.controller.signal.aborted) { onAbort(); return; }
      child.on('error', error => finish(new Error(`Claude Code를 실행하지 못했습니다: ${error.message}`)));
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
      child.stdout.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_OUTPUT_BYTES) { finish(new Error('Claude Code 응답이 허용 크기를 초과했습니다.')); return; }
        buffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) { handleLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      });
      child.on('close', () => {
        handleLine(buffer);
        if (job.controller.signal.aborted) { finish(this.aborted()); return; }
        if (!result) { finish(claudeError(stderr)); return; }
        job.tokenUsage = tokenUsage(result.usage) ?? job.tokenUsage;
        if (result.is_error === true) { finish(claudeError(typeof result.result === 'string' ? result.result : stderr)); return; }
        if (result.structured_output !== undefined && result.structured_output !== null) { finish(undefined, result.structured_output); return; }
        try { finish(undefined, JSON.parse(stripFence(String(result.result ?? '')))); }
        catch { finish(new Error(`${LABEL}가 올바른 JSON을 반환하지 않았습니다. 다시 시도해 주세요.`)); }
      });
      const content: Json[] = [{ type: 'text', text: prompt }];
      if (imageDataUrl) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageDataUrl.replace(/^data:image\/png;base64,/, '') } });
      child.stdin.on('error', () => undefined);
      child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
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
    return this.runJob(settings.generationMethod ?? 'image', (job, directory, runtime) => this.stage(job, 'concept', async () => {
      const schema = { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['text'], additionalProperties: false };
      const fields = object(await this.query(job, runtime, directory, conceptPrompt(settings, catalog, context), schema));
      if (Object.keys(fields).length !== 1 || !Object.hasOwn(fields, 'text')) throw new Error(`${LABEL} 컨셉 응답은 text만 포함해야 합니다. 다시 시도해 주세요.`);
      return parseConceptText(fields.text, 'ai');
    }));
  }

  async extractLayout(input: unknown, imageDataUrl: unknown, regionInput?: unknown, catalogInput?: unknown): Promise<GridMap> {
    const settings = validateSettings(input);
    assertResolvedConceptSettings(settings);
    const region = validateGenerationRegion(regionInput, settings);
    const catalog = catalogInput === undefined ? undefined : parseBindings(catalogInput);
    decodePngDataUrl(imageDataUrl);
    const prompt = `${layoutPrompt(settings, region)}\n${catalog ? propCatalogPrompt(catalog) : ''}\nInspect the attached image directly and return only the schema-conforming map JSON.`;
    return this.runJob('image', async (job, directory, runtime) => {
      const map = await this.stage(job, 'extract', () => this.query(job, runtime, directory, prompt, MAP_JSON_SCHEMA, imageDataUrl as string));
      return this.finalize(map, settings, region, catalog, job);
    });
  }

  async generateLayout(input: unknown, regionInput?: unknown, catalogInput?: unknown, contextInput?: unknown): Promise<GridMap> {
    const settings = validateSettings(input);
    assertResolvedConceptSettings(settings);
    const region = validateGenerationRegion(regionInput, settings);
    const catalog = catalogInput === undefined ? undefined : parseBindings(catalogInput);
    const context = parseImageGenerationContext(contextInput);
    const prompt = `${directLayoutPrompt(settings, region, context)}\n${catalog ? propCatalogPrompt(catalog) : ''}\nReturn only the schema-conforming map JSON.`;
    return this.runJob('direct', async (job, directory, runtime) => {
      const map = await this.stage(job, 'layout', () => this.query(job, runtime, directory, prompt, MAP_JSON_SCHEMA));
      return this.finalize(map, settings, region, catalog, job);
    });
  }

  private finalize(map: unknown, settings: GenerationSettings, region: GenerationRegion | undefined, catalog: AssetBinding[] | undefined, job: ActiveJob): Promise<GridMap> {
    return finalizeLayoutText(JSON.stringify(map), settings, region, catalog, job.method, (stage, operation) => this.stage(job, stage, operation), LABEL);
  }
}

function stripFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : text.trim();
}

function modelIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/.test(value) ? value : undefined;
}

function tokenUsage(raw: unknown): GenerationProgress['tokenUsage'] | undefined {
  const usage = object(raw);
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!count(usage.input_tokens) || !count(usage.output_tokens)) return undefined;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    ...(count(usage.cache_read_input_tokens) ? { cachedInputTokens: usage.cache_read_input_tokens } : {}) };
}

function claudeError(message: string): Error {
  if (/not logged in|\/login|auth|unauthori|forbidden|401|403|invalid api key/i.test(message)) return new Error('Claude Code 로그인이 만료되었거나 접근 권한이 없습니다. 터미널에서 claude를 실행해 /login으로 다시 로그인해 주세요.');
  if (/usage|rate.?limit|quota|credit|limit (reached|exceeded)|overloaded|529|429/i.test(message)) return new Error('Claude 사용량 한도에 도달했거나 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.');
  if (/invalid model|model.{0,40}(not found|not available|unavailable|does not exist)/i.test(message)) return new Error('선택한 Claude 모델을 사용할 수 없습니다. 모델 이름을 확인하거나 비워 두고 기본 모델을 사용해 주세요.');
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, 200);
  return new Error(`Claude Code가 생성 작업을 완료하지 못했습니다. 연결·로그인·사용량을 확인한 뒤 다시 시도해 주세요.${detail ? ` (${detail})` : ''}`);
}
