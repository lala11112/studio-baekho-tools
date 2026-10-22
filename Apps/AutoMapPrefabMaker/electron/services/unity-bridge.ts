import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ScanResult, UnityBuildStatus, UnityConnectionStatus } from '../../src/shared/types';
import { parseUnityAssetCatalog, type UnityAssetCatalog } from '../../src/shared/unity-asset-catalog';
import { atomicWrite, prepareExportManifest } from './projects';
import { scanUnityProject } from './unity-project';
import { inspectUnityFiles, prepareUnityFiles, writeUnityManifest } from './unity-installation';
import { connectUnityMcp, DEFAULT_UNITY_ENDPOINT, UNITY_BUILD_TIMEOUT_MS, validatedUnityEndpoint, type UnityMcpClient } from './unity-mcp';

type ObjectValue = Record<string, unknown>;
interface Receipt extends UnityBuildStatus { endpoint: string; inputHash: string; submitted: boolean }
interface BridgeOptions {
  resourceDirectory: string;
  dataDirectory: string;
  connect?: (endpoint: string) => Promise<UnityMcpClient>;
  pollIntervalMs?: number;
  compilationTimeoutMs?: number;
}
class BridgeError extends Error {
  constructor(readonly state: UnityConnectionStatus['state'], message: string) { super(message); }
}
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const unresolved = (job: Receipt): boolean => job.state === 'running' || job.state === 'unknown';
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const publicJob = ({ endpoint: _endpoint, inputHash: _hash, submitted: _submitted, ...status }: Receipt): UnityBuildStatus => ({ ...status });
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function payload(value: unknown): ObjectValue {
  let result = object(value);
  for (let depth = 0; depth < 5; depth++) {
    if (result.success === false && !('state' in result)) throw new Error(String(result.error || result.message || 'Unity 요청이 실패했습니다.'));
    if (result.result && typeof result.result === 'object') result = object(result.result);
    else if (result.data && typeof result.data === 'object' && !Array.isArray(result.data) && !('state' in result)) result = object(result.data);
    else break;
  }
  return result;
}

/** Serializes all routing and calls in a session, while progress reads stay immediate. */
export class UnityBridgeService {
  private readonly options: BridgeOptions;
  private readonly jobs = new Map<string, Receipt>();
  private endpoint = DEFAULT_UNITY_ENDPOINT;
  private client?: UnityMcpClient;
  private clientEndpoint?: string;
  private activeRequest?: string;
  private preparation?: UnityConnectionStatus;
  private queue: Promise<unknown> = Promise.resolve();
  private initialized?: Promise<void>;
  private closed = false;

  constructor(options: BridgeOptions) { this.options = options; }
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async initialize(): Promise<void> {
    if (!this.initialized) this.initialized = (async () => {
      let config: ObjectValue;
      try { config = object(JSON.parse(await readFile(path.join(this.options.dataDirectory, 'unity-settings.json'), 'utf8'))); }
      catch { config = {}; }
      if (typeof config.endpoint === 'string') try { this.endpoint = validatedUnityEndpoint(config.endpoint); } catch { /* Invalid saved settings use the loopback default. */ }
      try {
        const saved: unknown = JSON.parse(await readFile(path.join(this.options.dataDirectory, 'unity-builds.json'), 'utf8'));
        if (!Array.isArray(saved)) throw new Error('Invalid receipts');
        // Keep every unresolved request, regardless of age. A malformed journal fails closed.
        for (const value of saved) {
          const item = object(value);
          if (typeof item.requestId !== 'string' || !REQUEST_ID.test(item.requestId) || this.jobs.has(item.requestId)
            || typeof item.projectPath !== 'string' || !path.isAbsolute(item.projectPath)
            || typeof item.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.inputHash)
            || typeof item.submitted !== 'boolean' || typeof item.message !== 'string'
            || !['checking', 'preparing', 'compiling', 'building', 'completed', 'failed', 'unknown'].includes(String(item.stage))
            || !['running', 'completed', 'failed', 'unknown'].includes(String(item.state))) throw new Error('Invalid receipt');
          validatedUnityEndpoint(item.endpoint);
          const receipt = item as unknown as Receipt;
          if (unresolved(receipt)) Object.assign(receipt, { state: 'unknown', stage: 'unknown', message: '이전 생성 요청의 결과를 Unity에서 확인해야 합니다. 자동으로 다시 생성하지 않습니다.' });
          this.jobs.set(receipt.requestId, receipt);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BridgeError('error', '저장한 Unity 생성 기록을 읽을 수 없습니다. 중복 생성을 막기 위해 새 생성을 중단했습니다.');
      }
    })();
    await this.initialized;
  }
  private async saveJobs(): Promise<void> {
    await mkdir(this.options.dataDirectory, { recursive: true });
    await atomicWrite(path.join(this.options.dataDirectory, 'unity-builds.json'), JSON.stringify([...this.jobs.values()], null, 2));
  }
  private async selectedEndpoint(value?: unknown): Promise<string> {
    await this.initialize();
    const next = value === undefined ? this.endpoint : validatedUnityEndpoint(value);
    if (next !== this.endpoint) {
      await mkdir(this.options.dataDirectory, { recursive: true });
      await atomicWrite(path.join(this.options.dataDirectory, 'unity-settings.json'), JSON.stringify({ endpoint: next }, null, 2));
      this.endpoint = next;
    }
    return next;
  }
  private async connection(endpoint: string): Promise<UnityMcpClient> {
    if (this.closed) throw new Error('Unity 연결이 종료되었습니다.');
    if (!this.client || this.clientEndpoint !== endpoint) {
      await this.disconnect();
      try { this.client = await (this.options.connect ?? connectUnityMcp)(endpoint); this.clientEndpoint = endpoint; }
      catch (error) { throw new BridgeError('disconnected', `Unity MCP에 연결할 수 없습니다. Unity Editor와 MCP 서버를 실행해 주세요. ${message(error)}`); }
    }
    return this.client;
  }
  private async disconnect(): Promise<void> {
    const previous = this.client;
    this.client = undefined; this.clientEndpoint = undefined;
    await previous?.close();
  }
  private async canonicalRoot(projectPath: string): Promise<string> {
    try { return await realpath(projectPath); }
    catch { throw new BridgeError('error', '연결한 Unity 프로젝트를 찾을 수 없습니다. 프로젝트를 다시 스캔해 주세요.'); }
  }
  private async select(projectPath: string, endpoint: string): Promise<{ client: UnityMcpClient; root: string; instanceId: string }> {
    const root = await this.canonicalRoot(projectPath);
    const client = await this.connection(endpoint);
    let inventory: ObjectValue;
    try { inventory = payload(await client.readResource('mcpforunity://instances')); }
    catch (error) { await this.disconnect(); throw new BridgeError('disconnected', message(error)); }
    const instances = Array.isArray(inventory.instances) ? inventory.instances : [];
    let unavailable = false;
    for (const candidate of instances) {
      const instanceId = object(candidate).id;
      if (typeof instanceId !== 'string') continue;
      try {
        payload(await client.callTool('set_active_instance', { instance: instanceId }));
        const info = payload(await client.readResource('mcpforunity://project/info'));
        if (typeof info.projectRoot !== 'string') { unavailable = true; continue; }
        const actual = await realpath(info.projectRoot).catch(() => null);
        if (actual && samePath(root, actual)) return { client, root, instanceId };
        if (!actual) unavailable = true;
      } catch { unavailable = true; /* Another editor can be reloading; keep looking for the selected project. */ }
    }
    if (unavailable) {
      await this.disconnect();
      throw new BridgeError('disconnected', 'Unity가 다시 연결되거나 스크립트를 불러오는 중입니다. 잠시 후 다시 확인해 주세요.');
    }
    throw new BridgeError(instances.length ? 'mismatch' : 'disconnected', instances.length
      ? '앱에서 연결한 프로젝트와 실행 중인 Unity 프로젝트가 일치하지 않습니다. 연결한 프로젝트를 Unity에서 열어 주세요.'
      : '실행 중인 Unity 인스턴스를 찾지 못했습니다. Unity Editor의 MCP 연결을 확인해 주세요.');
  }
  private async dependencies(root: string): Promise<void> {
    let manifest: ObjectValue;
    try { manifest = object(JSON.parse(await readFile(path.join(root, 'Packages', 'manifest.json'), 'utf8'))); }
    catch { throw new BridgeError('error', 'Unity Packages/manifest.json을 읽을 수 없습니다.'); }
    const dependencies = object(manifest.dependencies);
    if (!dependencies['com.unity.ai.navigation']) {
      let installed = false;
      try { installed = !!object(object(JSON.parse(await readFile(path.join(root, 'Packages', 'packages-lock.json'), 'utf8'))).dependencies)['com.unity.ai.navigation']; } catch { /* Direct dependency check already failed. */ }
      if (!installed) throw new BridgeError('error', 'Unity Package Manager에서 AI Navigation (com.unity.ai.navigation)을 설치한 뒤 다시 시도해 주세요.');
    }
  }
  private async editorReady(client: UnityMcpClient, checkConsole = true): Promise<void> {
    const state = payload(await client.readResource('mcpforunity://editor/state'));
    const compilation = object(state.compilation), editor = object(state.editor), assets = object(state.assets);
    const play = object(editor.play_mode);
    if (play.is_playing || play.is_changing || state.is_playing) throw new BridgeError('busy', 'Unity Play Mode를 종료한 뒤 다시 시도해 주세요.');
    if (compilation.is_compiling || compilation.is_domain_reload_pending || state.is_compiling || state.is_domain_reload_pending
      || assets.is_updating || object(assets.refresh).is_refresh_in_progress)
      throw new BridgeError('busy', 'Unity가 스크립트를 컴파일하거나 에셋을 가져오는 중입니다.');
    if (checkConsole) {
      const console = payload(await client.callTool('read_console', { action: 'get', types: ['error'], count: '50', format: 'json', include_stacktrace: false }));
      const entries = Array.isArray(console.data) ? console.data : Array.isArray(console.entries) ? console.entries : Array.isArray(console.logs) ? console.logs : [];
      const compileError = entries.map(entry => typeof entry === 'string' ? entry : String(object(entry).message ?? '')).find(text => /\berror\s+CS\d+\b|\bCS\d{4}\s*:/i.test(text));
      if (compileError) throw new BridgeError('error', `Unity 컴파일 오류를 먼저 수정해 주세요: ${compileError.slice(0, 500)}`);
    }
  }
  private async hasTool(client: UnityMcpClient, name = 'baekho_build_map'): Promise<boolean> {
    const custom = payload(await client.readResource('mcpforunity://custom-tools'));
    return Array.isArray(custom.tools) && custom.tools.some(tool => object(tool).name === name);
  }
  private pendingFor(root: string): Receipt | undefined { return [...this.jobs.values()].find(job => !!job.projectPath && samePath(job.projectPath, root) && unresolved(job)); }
  private failure(error: unknown, endpoint: string, projectPath?: string): UnityConnectionStatus {
    return { state: error instanceof BridgeError ? error.state : 'error', endpoint, projectPath, message: message(error) };
  }
  async getStatus(scan: ScanResult | null, endpoint?: unknown): Promise<UnityConnectionStatus> {
    let address = this.endpoint;
    try {
      address = await this.selectedEndpoint(endpoint);
      if (!scan) return { state: 'no-project', endpoint: address, message: 'Unity 프로젝트 폴더를 먼저 연결해 주세요.' };
      if (this.preparation) return { ...this.preparation };
      const pending = this.pendingFor(await this.canonicalRoot(scan.projectPath));
      if (pending) return { state: 'busy', endpoint: pending.endpoint, projectPath: pending.projectPath,
        message: pending.message, requestId: pending.requestId } as UnityConnectionStatus;
      if (this.activeRequest) return { state: 'busy', endpoint: address, projectPath: scan.projectPath, message: '다른 Unity 프리팹 생성이 진행 중입니다.' };
      return await this.locked(async () => {
        const { client, root, instanceId } = await this.select(scan.projectPath, address);
        await this.dependencies(root);
        await this.editorReady(client);
        const inspection = await inspectUnityFiles(root, this.options.resourceDirectory);
        const installed = !inspection.needsSetup && await this.hasTool(client);
        return { state: installed ? 'ready' : 'needs-setup', endpoint: address, projectPath: root, instanceId, warnings: inspection.warnings,
          message: installed ? 'Unity에 프리팹을 생성할 준비가 되었습니다.' : '이 프로젝트에 Unity 자동 생성 스크립트를 준비해야 합니다.' };
      });
    } catch (error) { return this.failure(error, address, scan?.projectPath); }
  }
  async prepare(scan: ScanResult | null, endpoint?: unknown): Promise<UnityConnectionStatus> {
    let address = this.endpoint;
    let ownsPreparation = false;
    try {
      address = await this.selectedEndpoint(endpoint);
      if (!scan) throw new BridgeError('no-project', 'Unity 프로젝트 폴더를 먼저 연결해 주세요.');
      if (this.activeRequest || this.preparation) throw new BridgeError('busy', 'Unity 프리팹 생성 또는 준비가 진행 중입니다.');
      const root = await this.canonicalRoot(scan.projectPath);
      if (this.activeRequest || this.preparation) throw new BridgeError('busy', 'Unity 프리팹 생성 또는 준비가 진행 중입니다.');
      if (this.pendingFor(root)) throw new BridgeError('busy', '이전 생성 요청의 결과를 먼저 확인해 주세요.');
      this.preparation = { state: 'busy', endpoint: address, projectPath: root, message: 'Unity 스크립트를 준비하고 있습니다.' };
      ownsPreparation = true;
      return await this.locked(async () => {
        const ready = await this.prepareInternal(root, address, undefined, false);
        return { state: 'ready', endpoint: address, projectPath: root, instanceId: ready.instanceId, warnings: ready.warnings,
          message: 'Unity 연동 스크립트 준비가 완료되었습니다.' };
      });
    } catch (error) { return this.failure(error, address, scan?.projectPath); }
    finally { if (ownsPreparation) this.preparation = undefined; }
  }
  private async prepareInternal(projectPath: string, endpoint: string, progress?: (stage: UnityBuildStatus['stage'], text: string) => Promise<void>, requireNavigation = true,
    toolName = 'baekho_build_map'): Promise<{ instanceId: string; warnings: string[] }> {
    let selected = await this.select(projectPath, endpoint);
    if (requireNavigation) await this.dependencies(selected.root);
    await this.editorReady(selected.client);
    await progress?.('preparing', 'Unity 자동 생성 스크립트를 준비하고 있습니다.');
    const prepared = await prepareUnityFiles(selected.root, this.options.resourceDirectory);
    if (prepared.changed) {
      await progress?.('compiling', 'Unity 에셋 가져오기와 스크립트 컴파일을 기다리고 있습니다.');
      try { payload(await selected.client.callTool('refresh_unity', { mode: 'force', scope: 'all', compile: 'request', wait_for_ready: false })); }
      catch { /* A refresh can drop its own response during a domain reload. Only wait/reconnect below. */ }
      await this.disconnect();
    }
    const deadline = Date.now() + (this.options.compilationTimeoutMs ?? 180_000);
    let lastError: unknown;
    do {
      try {
        selected = await this.select(projectPath, endpoint);
        await this.editorReady(selected.client);
        if (await this.hasTool(selected.client, toolName)) return { instanceId: selected.instanceId, warnings: prepared.warnings };
        lastError = new Error(`Unity MCP가 ${toolName} 도구를 아직 등록하지 않았습니다.`);
      } catch (error) {
        lastError = error;
        if (error instanceof BridgeError && ['mismatch', 'error'].includes(error.state)) throw error;
        await this.disconnect();
      }
      await sleep(this.options.pollIntervalMs ?? 1000);
    } while (!this.closed && Date.now() < deadline);
    throw new BridgeError('error', `Unity 스크립트 준비를 완료하지 못했습니다. MCP 연결과 Console을 확인해 주세요. ${message(lastError)}`);
  }
  async importUnityAssetCatalog(scan: ScanResult | null, endpoint?: unknown): Promise<{ catalog: UnityAssetCatalog; scan: ScanResult; warnings: string[] }> {
    const address = await this.selectedEndpoint(endpoint);
    if (!scan) throw new BridgeError('no-project', 'Unity 프로젝트 폴더를 먼저 연결해 주세요.');
    if (this.activeRequest || this.preparation) throw new BridgeError('busy', 'Unity 프리팹 생성 또는 준비가 진행 중입니다.');
    return this.locked(async () => {
      const root = await this.canonicalRoot(scan.projectPath);
      if (this.activeRequest || this.preparation || this.pendingFor(root))
        throw new BridgeError('busy', 'Unity 프리팹 생성 또는 이전 생성 요청의 결과를 먼저 확인해 주세요.');
      const prepared = await this.prepareInternal(root, address, undefined, false, 'baekho_get_asset_catalog');
      // Re-select after any compilation/domain reload and check identity immediately before querying.
      const selected = await this.select(root, address);
      await this.editorReady(selected.client);
      let result: ObjectValue;
      try {
        result = payload(await selected.client.callTool('execute_custom_tool', {
          tool_name: 'baekho_get_asset_catalog', parameters: { expectedProjectRoot: root, timeout_seconds: 120 },
        }, 120_000));
      } catch (error) {
        await this.disconnect();
        throw new BridgeError('disconnected', `Unity 프리팹 정보를 가져오지 못했습니다. 등록은 변경하지 않았습니다. ${message(error)}`);
      }
      const catalog = parseUnityAssetCatalog(result.catalog ?? result);
      // The filesystem is authoritative, including moves and changed GUIDs since project connection.
      const freshScan = await scanUnityProject(root);
      const byGuid = new Map(freshScan.assets.map(asset => [asset.guid, asset]));
      for (const asset of catalog.assets) {
        const current = byGuid.get(asset.guid);
        if (!current || current.path !== asset.path)
          throw new BridgeError('error', `Unity 프리팹이 최신 프로젝트 스캔과 일치하지 않습니다. 다시 가져와 주세요: ${asset.path}`);
      }
      return { catalog, scan: freshScan, warnings: [...prepared.warnings, ...freshScan.warnings] };
    });
  }
  async startBuild(value: unknown, scan: ScanResult | null, endpoint?: unknown): Promise<UnityBuildStatus> {
    const address = await this.selectedEndpoint(endpoint);
    if (!scan) throw new BridgeError('no-project', 'Unity 프로젝트 폴더를 먼저 연결해 주세요.');
    if (this.activeRequest || this.preparation) throw new BridgeError('busy', '이미 Unity 프리팹 생성 또는 준비가 진행 중입니다.');
    const root = await this.canonicalRoot(scan.projectPath);
    if (this.activeRequest || this.preparation) throw new BridgeError('busy', '이미 Unity 프리팹 생성 또는 준비가 진행 중입니다.');
    const previous = this.pendingFor(root);
    if (previous) return publicJob(previous);
    // Reserve synchronously before validation so simultaneous IPC requests cannot both start.
    const requestId = randomUUID();
    this.activeRequest = requestId;
    try {
      const manifest = await prepareExportManifest(value, scan);
      const receipt: Receipt = { requestId, state: 'running', stage: 'checking', message: 'Unity 연결과 프로젝트를 확인하고 있습니다.',
        projectPath: root, endpoint: address, inputHash: createHash('sha256').update(JSON.stringify(manifest, null, 2), 'utf8').digest('hex'), submitted: false };
      this.jobs.set(requestId, receipt);
      await this.saveJobs();
      void this.locked(async () => {
        const progress = async (stage: UnityBuildStatus['stage'], text: string) => {
          Object.assign(receipt, { stage, message: text }); await this.saveJobs();
        };
        try {
          await this.prepareInternal(root, address, progress);
          const selected = await this.select(root, address);
          await this.editorReady(selected.client);
          // The manifest writer runs only after authoritative instance identity was confirmed.
          const manifestPath = await writeUnityManifest(root, manifest);
          await progress('building', '맵 조립, NavMesh 베이크와 프리팹 저장을 진행하고 있습니다.');
          // Persist before sending: a lost response or application crash can never lead to an automatic replay.
          receipt.submitted = true; await this.saveJobs();
          const result = await selected.client.callTool('execute_custom_tool', { tool_name: 'baekho_build_map', parameters: {
            action: 'build', requestId, manifestPath, expectedProjectRoot: root, inputHash: receipt.inputHash, timeout_seconds: 900,
          } }, UNITY_BUILD_TIMEOUT_MS);
          this.applyResult(receipt, result);
          await this.saveJobs();
        } catch (error) {
          Object.assign(receipt, { state: receipt.submitted ? 'unknown' : 'failed', stage: receipt.submitted ? 'unknown' : 'failed',
            message: receipt.submitted ? 'Unity 응답이 끊겨 생성 결과를 확인하고 있습니다. 같은 요청을 다시 실행하지 않습니다.' : message(error), error: message(error) });
          await this.disconnect().catch(() => undefined);
          await this.saveJobs();
        } finally { if (this.activeRequest === requestId) this.activeRequest = undefined; }
      }).catch(() => { if (this.activeRequest === requestId) this.activeRequest = undefined; });
      return publicJob(receipt);
    } catch (error) { this.activeRequest = undefined; throw error; }
  }
  private applyResult(receipt: Receipt, value: unknown): void {
    const result = payload(value);
    if (result.requestId !== receipt.requestId || !['completed', 'failed', 'running', 'unknown'].includes(String(result.state)))
      throw new Error('Unity 생성 응답의 요청 ID 또는 상태가 올바르지 않습니다.');
    const state = result.state as UnityBuildStatus['state'];
    for (const key of ['prefabPath', 'navMeshPath'] as const) {
      const target = result[key];
      const extension = key === 'prefabPath' ? '.prefab' : '.NavMesh.asset';
      if (target !== undefined && target !== null && (typeof target !== 'string'
        || !target.startsWith('Assets/Baekho/Generated/') || !target.endsWith(extension)
        || target.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0) || target.includes('\\')))
        throw new Error('Unity가 예상한 생성 폴더 밖의 결과를 반환했습니다.');
    }
    Object.assign(receipt, { state, stage: state === 'running' ? 'building' : state,
      message: typeof result.message === 'string' ? result.message : state === 'completed' ? 'Unity 프리팹 생성이 완료되었습니다.' : 'Unity 생성 상태를 확인하고 있습니다.',
      prefabPath: typeof result.prefabPath === 'string' ? result.prefabPath : undefined,
      navMeshPath: typeof result.navMeshPath === 'string' ? result.navMeshPath : undefined, error: typeof result.error === 'string' ? result.error : undefined });
    if (state === 'completed' && (!receipt.prefabPath || !receipt.navMeshPath)) throw new Error('Unity 생성 결과에 프리팹 또는 NavMesh 경로가 없습니다.');
  }
  async getBuild(requestId: unknown): Promise<UnityBuildStatus> {
    await this.initialize();
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new Error('올바른 Unity 생성 요청 ID가 아닙니다.');
    const receipt = this.jobs.get(requestId);
    if (!receipt) throw new Error('Unity 생성 요청을 찾을 수 없습니다.');
    // Publish terminal/uncertain results after their journal commit and exclusive job release.
    if (this.activeRequest === requestId && receipt.state !== 'running') await this.queue;
    if (!unresolved(receipt) || this.activeRequest === requestId || this.activeRequest || this.preparation) return publicJob(receipt);
    return this.locked(async () => {
      if (!unresolved(receipt)) return publicJob(receipt);
      try {
        if (!receipt.submitted) {
          Object.assign(receipt, { state: 'failed', stage: 'failed', message: 'Unity에 전달되기 전에 앱이 종료되었습니다. 새로 생성을 시작해 주세요.' });
        } else {
          const { client, root } = await this.select(receipt.projectPath!, receipt.endpoint);
          const response = await client.callTool('execute_custom_tool', { tool_name: 'baekho_build_map', parameters: {
            action: 'status', requestId, expectedProjectRoot: root, inputHash: receipt.inputHash,
          } });
          this.applyResult(receipt, response);
        }
      } catch (error) {
        Object.assign(receipt, { state: 'unknown', stage: 'unknown', message: 'Unity에서 이전 생성 결과를 확인하지 못했습니다. 연결을 복구한 뒤 상태를 다시 확인해 주세요.', error: message(error) });
        await this.disconnect().catch(() => undefined);
      }
      await this.saveJobs();
      return publicJob(receipt);
    });
  }
  async close(): Promise<void> { this.closed = true; await this.disconnect(); }
}
