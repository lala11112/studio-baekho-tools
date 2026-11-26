/** Opt-in real AI A/B benchmark. No retries, fallback maps, or model/effort changes. */
import { appendFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { CodexService } from '../electron/services/codex';
import { CodexTransport } from '../electron/services/codex-transport';
import { conceptForRequest } from '../src/shared/concepts';
import { generationConditionIssues } from '../src/shared/features';
import { analyzeLevelDesign } from '../src/shared/level-design';
import { DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { applyRoomPreset, resolveGenerationSettings } from '../src/shared/room-presets';
import type { AssetBinding, GenerationProgress, GenerationSettings, GridMap, MapConcept, ValidationIssue } from '../src/shared/types';

export const BENCHMARK_CASES = [
  { id: 'flat', preset: 'medium', pattern: 'openArena', seed: 10, width: 16, height: 16, elevation: false },
  { id: 'elevated', preset: 'medium', pattern: 'raisedArena', seed: 32, width: 18, height: 18, elevation: true },
  { id: 'large', preset: 'large', pattern: 'openArena', seed: 43, width: 40, height: 40, elevation: false },
] as const;
export type BenchmarkMethod = 'image' | 'direct';
export interface BenchmarkOptions {
  repetitions: number; cases: string[]; methods: BenchmarkMethod[]; output: string; timeoutMs: number; model: string;
}
export interface BenchmarkResult {
  case: string; repetition: number; seed: number; method: BenchmarkMethod; status: 'passed' | 'failed';
  attempted: boolean; conceptMs: number; elapsedMs: number; totalMs: number; validationMs: number;
  stages: Record<string, number>; telemetry: GenerationProgress[]; issues: ValidationIssue[]; failureStage?: string; error?: string;
}
const round = (value: number) => Math.round(value * 1000) / 1000;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
class BenchmarkShutdownError extends Error {}
export function isBenchmarkBlocker(error: unknown): boolean {
  return error instanceof BenchmarkShutdownError || /usage.?limit|rate.?limit|quota|authentication|unauthorized|not.?authenticated|login.?required|로그인이 필요|한도에 도달|모델.*사용할 수 없|이미지 생성을 지원하지|이미지 입력을 지원하지/i.test(errorText(error));
}

export function parseBenchmarkOptions(argv: string[], cwd = process.cwd()): BenchmarkOptions {
  const values = new Map<string, string>();
  const allowed = new Set(['repetitions', 'cases', 'methods', 'output', 'timeout-ms', 'model']);
  for (let index = 0; index < argv.length; index++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[index]);
    if (!match || !allowed.has(match[1])) throw new Error(`Unknown option: ${argv[index]}`);
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--') || values.has(match[1])) throw new Error(`Missing or repeated --${match[1]}`);
    values.set(match[1], value);
  }
  const repetitions = Number(values.get('repetitions') ?? 3), timeoutMs = Number(values.get('timeout-ms') ?? 1_200_000);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 30) throw new Error('repetitions must be 1–30');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 7_200_000) throw new Error('timeout-ms must be 1000–7200000');
  const selectedCases = (values.get('cases') ?? 'flat,elevated,large').split(',');
  const methods = (values.get('methods') ?? 'image,direct').split(',');
  if (!selectedCases.length || new Set(selectedCases).size !== selectedCases.length || selectedCases.some(id => !BENCHMARK_CASES.some(item => item.id === id)))
    throw new Error('cases must contain distinct flat,elevated,large values');
  if (!methods.length || new Set(methods).size !== methods.length || methods.some(method => !['image', 'direct'].includes(method)))
    throw new Error('methods must contain distinct image,direct values');
  const model = values.get('model') ?? '';
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model)) throw new Error('Invalid model identifier');
  const output = path.resolve(cwd, values.get('output') ?? `.local/generation-benchmark/run-${Date.now()}`);
  const relative = path.relative(path.resolve(cwd, '.local'), output);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('output must be a new directory below this workspace .local');
  return { repetitions, cases: selectedCases, methods: methods as BenchmarkMethod[], output, timeoutMs, model };
}

/** Every comparison pair has identical conditions and one shared concept, including its seed. */
export function benchmarkSettings(caseId: string, repetition: number, model = ''): GenerationSettings {
  const item = BENCHMARK_CASES.find(testCase => testCase.id === caseId);
  if (!item) throw new Error(`Unknown case: ${caseId}`);
  const settings = applyRoomPreset(DEFAULT_SETTINGS, item.preset);
  settings.conceptMode = 'ai'; settings.prompt = ''; settings.codexModel = model;
  settings.seed = item.seed + repetition * 1009;
  settings.sizeMode = 'custom'; settings.width = item.width; settings.height = item.height;
  settings.levelDesign!.pattern = item.pattern; settings.designer!.elevation = item.elevation;
  settings.designer!.propLayout = 'balanced'; settings.designer!.propCoverage = 12; settings.designer!.ceilings = true;
  return resolveGenerationSettings(settings);
}

export function summarizeBenchmark(results: BenchmarkResult[]) {
  const stats = (values: number[]) => {
    if (!values.length) return { median: null, max: null };
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return { median: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2), max: round(sorted[sorted.length - 1]) };
  };
  const aggregate = (rows: BenchmarkResult[]) => {
    const passed = rows.filter(row => row.status === 'passed');
    const serviceStages = [...new Set(passed.flatMap(row => Object.keys(row.stages)))];
    const telemetryStages = [...new Set(passed.flatMap(row => row.telemetry.filter(event => event.state === 'completed').map(event => event.stage)))];
    return { planned: rows.length, attempted: rows.filter(row => row.attempted).length, passed: passed.length,
      failed: rows.length - passed.length, successRate: rows.length ? passed.length / rows.length : 0,
      successfulElapsedMs: stats(passed.map(row => row.elapsedMs)), successfulTotalMs: stats(passed.map(row => row.totalMs)),
      successfulServiceStageMs: Object.fromEntries(serviceStages.map(stage => [stage, stats(passed.filter(row => row.stages[stage] !== undefined).map(row => row.stages[stage]))])),
      successfulInternalStageMs: Object.fromEntries(telemetryStages.map(stage => [stage, stats(passed.filter(row => row.telemetry.some(event => event.stage === stage && event.state === 'completed'))
        .map(row => row.telemetry.filter(event => event.stage === stage && event.state === 'completed').reduce((sum, event) => sum + event.elapsedMs, 0)))])),
      attemptedElapsedMs: stats(rows.filter(row => row.attempted).map(row => row.elapsedMs)) };
  };
  return { overall: aggregate(results), methods: Object.fromEntries((['image', 'direct'] as const).map(method => [method, aggregate(results.filter(row => row.method === method))])),
    cases: Object.fromEntries([...new Set(results.map(row => row.case))].map(id => [id, Object.fromEntries((['image', 'direct'] as const).map(method => [method, aggregate(results.filter(row => row.case === id && row.method === method))]))])) };
}

export function inspectBenchmarkMap(map: GridMap, settings: GenerationSettings, catalog: AssetBinding[]): ValidationIssue[] {
  const issues = [...validateMap(map, catalog), ...generationConditionIssues(map, settings), ...analyzeLevelDesign(map, settings).issues];
  if (map.width !== settings.width || map.height !== settings.height || map.cellSize !== settings.cellSize)
    issues.push({ severity: 'error', code: 'benchmark-dimensions', message: 'Generated dimensions or cell size differ from the shared request.' });
  return issues;
}

export async function withBenchmarkTimeout<T>(operation: () => Promise<T>, timeoutMs: number, cancel: () => void, cleanupTimeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve().then(operation).then(value => ({ kind: 'value' as const, value }), error => ({ kind: 'error' as const, error }));
  try {
    const outcome = await Promise.race([pending, new Promise<{ kind: 'timeout' }>(resolve => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    })]);
    if (outcome.kind === 'timeout') {
      cancel();
      const cleaned = await Promise.race([pending.then(() => true), new Promise<boolean>(resolve => {
        cleanupTimer = setTimeout(() => resolve(false), cleanupTimeoutMs);
      })]);
      if (!cleaned) throw new BenchmarkShutdownError(`Benchmark request exceeded ${timeoutMs} ms; cancelled without retry, but cleanup did not finish. Stopping the benchmark to avoid overlapping requests.`);
      throw new Error(`Benchmark request exceeded ${timeoutMs} ms; cancelled without retry.`);
    }
    if (outcome.kind === 'error') throw outcome.error;
    return outcome.value;
  } finally { if (timer) clearTimeout(timer); if (cleanupTimer) clearTimeout(cleanupTimer); }
}

const catalog: AssetBinding[] = [
  { id: 'small-crate', size: { x: 1, y: 1, z: 1 } }, { id: 'medium-crate', size: { x: 2, y: 1.5, z: 2 } }, { id: 'large-obstacle', size: { x: 4, y: 2, z: 2 } },
].map(({ id, size }, index) => ({ id, label: `검증 ${id}`, role: 'prop', prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/Validation/${id}.prefab`,
  scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  prop: { category: id, tags: [], blocksMovement: true, size, placement: 'floor', roomTypes: ['battle', 'boss'], weight: 1 } }));

async function createOutput(output: string): Promise<void> {
  const local = path.resolve('.local'), relative = path.relative(local, output);
  await mkdir(local, { recursive: true });
  let parent = local;
  if ((await lstat(parent)).isSymbolicLink()) throw new Error('.local cannot be a link');
  for (const part of relative.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, part);
    await mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Output ancestors must be ordinary directories');
  }
  await mkdir(output); // Existing runs are never overwritten or mixed with new samples.
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help')) {
    console.log('npm run benchmark:generations -- [--repetitions=3] [--cases=flat,elevated,large] [--methods=image,direct] [--timeout-ms=1200000] [--model=MODEL] [--output=.local/generation-benchmark/NEW-RUN]'); return;
  }
  const options = parseBenchmarkOptions(argv); await createOutput(options.output);
  const started = performance.now(), results: BenchmarkResult[] = [], writes: Promise<unknown>[] = [];
  const track = (write: Promise<unknown>) => { writes.push(write); void write.catch(() => undefined); };
  let directory = options.output, stage = 'status', events: GenerationProgress[] = [], interrupted = false, blocker: string | undefined;
  const turns = new Map<string, { directory: string; stage: string }>();
  const itemCounts = new Map<string, { types: Record<string, number>; ids: Set<string> }>();
  const flushItemCounts = async () => {
    for (const [destination, counts] of itemCounts) await writeFile(destination, JSON.stringify({ types: counts.types, uniqueItems: counts.ids.size }, null, 2));
  };
  const service = new CodexService({ dataDirectory: path.join(options.output, 'runtime'),
    onProgress: event => {
      events.push(structuredClone(event));
      track(appendFile(path.join(directory, 'progress.jsonl'), `${JSON.stringify(event)}\n`));
      if (event.state !== 'running') console.log(JSON.stringify({ stage: event.stage, state: event.state, elapsedMs: event.elapsedMs, model: event.model, reasoningEffort: event.reasoningEffort }));
    },
    connect: async (runtime, runtimeDirectory) => {
      const transport = new CodexTransport(runtime.executable, runtimeDirectory); await transport.initialize();
      const saveResponse = (item: Record<string, unknown>, destination: { directory: string; stage: string }, completed = true) => {
        if (typeof item.type === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(item.type)) {
          const file = path.join(destination.directory, `${destination.stage}-item-types.json`), counts = itemCounts.get(file) ?? { types: { imageGeneration: 0 }, ids: new Set<string>() };
          const key = `${item.type}:${typeof item.id === 'string' ? item.id : 'missing-id'}`;
          if (!counts.ids.has(key)) { counts.ids.add(key); counts.types[item.type] = (counts.types[item.type] ?? 0) + 1; }
          itemCounts.set(file, counts);
        }
        if (!completed || item.type !== 'agentMessage' || typeof item.text !== 'string' || item.phase && item.phase !== 'final_answer') return;
        track(writeFile(path.join(destination.directory, `${destination.stage}-response.txt`), item.text));
      };
      transport.onNotification((method, params) => {
        const destination = turns.get(String(params.threadId)); if (!destination) return;
        if ((method === 'item/started' || method === 'item/completed') && params.item) saveResponse(params.item as Record<string, unknown>, destination, method === 'item/completed');
        const turn = params.turn as Record<string, unknown> | undefined;
        if (method === 'turn/completed' && Array.isArray(turn?.items)) for (const item of turn.items) saveResponse(item, destination);
      });
      return { request: async (method, params) => {
        const destination = { directory, stage };
        if (method === 'turn/start') await writeFile(path.join(directory, `${stage}-input.json`), JSON.stringify({
          input: (params.input as Record<string, unknown>[]).map(item => item.type === 'image' ? { type: 'image', file: 'blueprint.png', detail: item.detail } : item), outputSchema: params.outputSchema,
        }, null, 2));
        const result = await transport.request(method, params);
        if (method === 'thread/start') {
          const thread = result.thread as Record<string, unknown> | undefined;
          if (typeof thread?.id === 'string') {
            turns.set(thread.id, destination);
            itemCounts.set(path.join(destination.directory, `${destination.stage}-item-types.json`), { types: { imageGeneration: 0 }, ids: new Set<string>() });
          }
          await writeFile(path.join(destination.directory, `${destination.stage}-metadata.json`), JSON.stringify({ runtimeVersion: runtime.version,
            requestedModel: params.model ?? 'runtime default', model: result.model ?? thread?.model, reasoningEffort: result.reasoningEffort ?? thread?.reasoningEffort, threadId: thread?.id }, null, 2));
        }
        return result;
      }, onNotification: listener => transport.onNotification(listener), onClose: listener => transport.onClose(listener), close: () => transport.close() };
    },
  });
  const stop = () => { interrupted = true; service.cancel(); };
  process.once('SIGINT', stop);
  const saveReport = async () => {
    await writeFile(path.join(options.output, 'results.json'), JSON.stringify(results, null, 2));
    const expectedSamples = options.cases.length * options.repetitions * options.methods.length;
    await writeFile(path.join(options.output, 'summary.json'), JSON.stringify({ options, interrupted, blocker, expectedSamples, recordedSamples: results.length,
      complete: results.length === expectedSamples, wallElapsedMs: round(performance.now() - started),
      timingNote: 'elapsedMs excludes the shared concept and independent audit; totalMs adds the full shared concept once per hypothetical standalone map. stages are service-call wall times including preparation, local placement/validation and cleanup; telemetry reports their separate internal stages. Do not add stages and telemetry together. Successful timing summaries exclude failed samples; success rates include concept failures.',
      ...summarizeBenchmark(results) }, null, 2));
  };
  try {
    await writeFile(path.join(options.output, 'run.json'), JSON.stringify({ ...options, startedAt: new Date().toISOString(), catalog, catalogNote: 'Synthetic measured metadata, same for both methods; no Unity source prefab payload.' }, null, 2));
    const status = await service.getStatus();
    await writeFile(path.join(options.output, 'runtime-status.json'), JSON.stringify(status, null, 2));
    if (status.state !== 'ready') throw new Error(status.message);
    if (options.methods.includes('image') && status.imageGeneration === false) throw new Error('Image generation capability is unavailable; benchmark stopped without generating a concept.');
    for (const caseId of options.cases) for (let repetition = 0; repetition < options.repetitions; repetition++) {
      if (interrupted || blocker) break;
      directory = path.join(options.output, caseId, `repeat-${repetition + 1}`); await mkdir(directory, { recursive: true });
      const settings = benchmarkSettings(caseId, repetition, options.model), snapshot = structuredClone(catalog), pairDirectory = directory;
      await writeFile(path.join(directory, 'request.json'), JSON.stringify({ settings, catalog: snapshot }, null, 2));
      stage = 'concept'; events = []; const conceptStarted = performance.now(); let concept: MapConcept | undefined, conceptError: string | undefined;
      try {
        console.log(JSON.stringify({ case: caseId, repetition: repetition + 1, stage }));
        concept = { source: 'ai', text: await withBenchmarkTimeout(() => service.generateConcept(settings, snapshot), options.timeoutMs, () => service.cancel()) };
        await writeFile(path.join(directory, 'concept.json'), JSON.stringify(concept, null, 2));
      } catch (error) { conceptError = errorText(error); if (isBenchmarkBlocker(error)) blocker = conceptError; }
      const conceptMs = round(performance.now() - conceptStarted);
      await writeFile(path.join(directory, 'concept-result.json'), JSON.stringify({ elapsedMs: conceptMs, error: conceptError, telemetry: events }, null, 2));
      await flushItemCounts();
      const methods = repetition % 2 ? [...options.methods].reverse() : options.methods;
      for (const method of methods) {
        if (interrupted && !conceptError) break;
        directory = path.join(pairDirectory, method); await mkdir(directory); events = [];
        const result: BenchmarkResult = { case: caseId, repetition: repetition + 1, seed: settings.seed!, method,
          status: 'failed', attempted: !!concept, conceptMs, elapsedMs: 0, totalMs: conceptMs, validationMs: 0, stages: {}, telemetry: events, issues: [] };
        stage = 'concept'; const mapStarted = performance.now();
        try {
          if (!concept) throw new Error(conceptError ?? 'Shared concept unavailable');
          const request = conceptForRequest(settings, concept); request.generationMethod = method;
          await writeFile(path.join(directory, 'request.json'), JSON.stringify({ settings: request, catalog: snapshot, concept }, null, 2));
          let image: string | undefined;
          const map = await withBenchmarkTimeout(async () => {
            if (method === 'direct') {
              stage = 'layout'; const began = performance.now();
              try { return await service.generateLayout(request, undefined, snapshot); }
              finally { result.stages.layout = round(performance.now() - began); }
            }
            stage = 'image'; let began = performance.now();
            try { image = await service.generateImage(request, undefined, snapshot); }
            finally { result.stages.image = round(performance.now() - began); }
            await writeFile(path.join(directory, 'blueprint.png'), Buffer.from(image.split(',')[1], 'base64'));
            stage = 'extract'; began = performance.now();
            try { return await service.extractLayout(request, image, undefined, snapshot); }
            finally { result.stages.extract = round(performance.now() - began); }
          }, options.timeoutMs, () => service.cancel());
          result.elapsedMs = round(performance.now() - mapStarted);
          stage = 'audit'; const auditStarted = performance.now();
          result.issues = inspectBenchmarkMap(map, request, snapshot);
          const project = parseProjectFile({ formatVersion: 1, map, settings: { ...settings, generationMethod: method }, bindings: snapshot, ...(image ? { blueprintDataUrl: image } : {}), concept });
          result.validationMs = round(performance.now() - auditStarted);
          await writeFile(path.join(directory, 'map.baekho.json'), JSON.stringify(project, null, 2));
          await writeFile(path.join(directory, 'quality.json'), JSON.stringify({ heights: [...new Set(map.elevations.flat())], props: map.propInstances?.length ?? 0,
            markers: map.markers?.length ?? 0, connections: map.connections.length, issues: result.issues }, null, 2));
          if (result.issues.some(issue => issue.severity === 'error')) throw new Error('Map failed independent safety/condition/design audit');
          result.status = 'passed';
        } catch (error) {
          result.error = errorText(error); result.failureStage = stage;
          if (isBenchmarkBlocker(error)) blocker = result.error;
          if (!result.elapsedMs && result.attempted) result.elapsedMs = round(performance.now() - mapStarted);
        }
        result.totalMs = round(conceptMs + result.elapsedMs); result.telemetry = [...events];
        results.push(result);
        await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); await flushItemCounts(); await saveReport();
        console.log(JSON.stringify({ case: caseId, repetition: repetition + 1, method, status: result.status, elapsedMs: result.elapsedMs, totalMs: result.totalMs, error: result.error }));
        if (blocker && concept) break;
      }
    }
  } finally {
    process.removeListener('SIGINT', stop); service.close();
    const persisted = await Promise.allSettled(writes);
    if (persisted.some(result => result.status === 'rejected')) { console.error('Some evidence files could not be saved.'); process.exitCode = 1; }
    await flushItemCounts(); await saveReport(); console.log(JSON.stringify({ output: options.output, ...summarizeBenchmark(results) }));
  }
  if (interrupted || results.some(result => result.status !== 'passed') || results.length !== options.cases.length * options.repetitions * options.methods.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
