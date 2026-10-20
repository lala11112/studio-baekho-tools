/** Opt-in: six real concept → image → vision runs using the signed-in Codex account. No automatic retries. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexService } from '../electron/services/codex';
import { CodexTransport } from '../electron/services/codex-transport';
import { DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { generationConditionIssues } from '../src/shared/features';
import { applyRoomPreset, resolveGenerationSettings } from '../src/shared/room-presets';
import { analyzeLevelDesign } from '../src/shared/level-design';
import { conceptForRequest } from '../src/shared/concepts';
import type { AssetBinding, MapConcept, RoomPresetId } from '../src/shared/types';
import type { DesignPattern } from '../src/shared/level-design';

const cases: { id: string; preset: RoomPresetId; pattern: DesignPattern; seed: number; width: number; height: number; elevation: boolean }[] = [
  { id: 'open', preset: 'medium', pattern: 'openArena', seed: 10, width: 16, height: 16, elevation: false },
  { id: 'flanking', preset: 'medium', pattern: 'flankingArena', seed: 21, width: 18, height: 16, elevation: false },
  { id: 'raised', preset: 'medium', pattern: 'raisedArena', seed: 32, width: 18, height: 18, elevation: true },
  { id: 'boss', preset: 'boss', pattern: 'openArena', seed: 43, width: 24, height: 22, elevation: false },
  { id: 'shop', preset: 'shop', pattern: 'openArena', seed: 54, width: 12, height: 10, elevation: false },
  { id: 'open-alt', preset: 'medium', pattern: 'openArena', seed: 65, width: 16, height: 16, elevation: false },
];
const selected = process.argv.filter(arg => arg.startsWith('--case=')).map(arg => arg.slice(7));
if (selected.some(id => !cases.some(testCase => testCase.id === id))) throw new Error(`Unknown case. Choose ${cases.map(c => c.id).join(', ')}.`);

const output = path.resolve('.local/level-design-ai-smoke', `run-${Date.now()}`);
await mkdir(output, { recursive: true });
const catalog: AssetBinding[] = [
  { id: 'small-crate', size: { x: 1, y: 1, z: 1 } },
  { id: 'medium-crate', size: { x: 2, y: 1.5, z: 2 } },
  { id: 'large-obstacle', size: { x: 4, y: 2, z: 2 } },
].map(({ id, size }, index) => ({ id, label: `검증 ${id}`, role: 'prop', prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/Validation/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  prop: { category: id, tags: [], blocksMovement: true, size, placement: 'floor', roomTypes: ['battle', 'boss'], weight: 1 } }));
let caseDirectory = output;
let stage = 'status';
const rawWrites: Promise<unknown>[] = [];
const turns = new Map<string, { directory: string; stage: string }>();
const service = new CodexService({ dataDirectory: path.join(output, 'runtime'),
  connect: async (runtime, directory) => {
    const transport = new CodexTransport(runtime.executable, directory); await transport.initialize();
    const recordResponse = (item: Record<string, unknown>, destination: { directory: string; stage: string }) => {
      if (item.type !== 'agentMessage' || typeof item.text !== 'string' || (item.phase && item.phase !== 'final_answer')) return;
      rawWrites.push(writeFile(path.join(destination.directory, `${destination.stage}-response.txt`), item.text));
      try {
        const value = JSON.parse(item.text);
        if (value && Array.isArray(value.rows)) rawWrites.push(writeFile(path.join(destination.directory, 'raw-layout.json'), JSON.stringify(value, null, 2)));
      } catch { /* Malformed output is retained as text for failure diagnosis. */ }
    };
    transport.onNotification((method, params) => {
      const destination = turns.get(String(params.threadId));
      if (!destination) return;
      if (method === 'item/completed' && params.item) recordResponse(params.item as Record<string, unknown>, destination);
      const turn = params.turn as Record<string, unknown> | undefined;
      if (method === 'turn/completed' && Array.isArray(turn?.items)) for (const item of turn.items) recordResponse(item, destination);
    });
    return {
      request: async (method, params) => {
        if (method === 'turn/start') await writeFile(path.join(caseDirectory, `${stage}-input.json`), JSON.stringify({
          input: (params.input as Record<string, unknown>[]).map(item => item.type === 'image' ? { type: 'image', file: 'blueprint.png', detail: item.detail } : item),
          outputSchema: params.outputSchema,
        }, null, 2));
        const result = await transport.request(method, params);
        if (method === 'thread/start') {
          const thread = result.thread as Record<string, unknown> | undefined;
          if (typeof thread?.id === 'string') turns.set(thread.id, { directory: caseDirectory, stage });
          await writeFile(path.join(caseDirectory, `${stage}-metadata.json`), JSON.stringify({
            runtimeVersion: runtime.version, requestedModel: params.model ?? 'runtime default',
            threadId: thread?.id, model: result.model, baseInstructions: params.baseInstructions, developerInstructions: params.developerInstructions,
          }, null, 2));
        }
        return result;
      },
      onNotification: listener => transport.onNotification(listener),
      onClose: listener => transport.onClose(listener), close: () => transport.close(),
    };
  },
});
const results: unknown[] = [];
try {
  const status = await service.getStatus();
  console.log(JSON.stringify({ stage: 'status', state: status.state, version: status.version, output }));
  if (status.state !== 'ready') throw new Error(status.message);
  for (const testCase of cases.filter(item => !selected.length || selected.includes(item.id))) {
    const { id, preset, seed, pattern, width, height, elevation } = testCase;
    caseDirectory = path.join(output, id); await mkdir(caseDirectory, { recursive: true });
    const request = applyRoomPreset(DEFAULT_SETTINGS, preset);
    request.conceptMode = 'ai'; request.prompt = ''; request.seed = seed;
    request.sizeMode = 'custom'; request.width = width; request.height = height;
    request.levelDesign!.pattern = pattern; request.designer!.elevation = elevation;
    request.designer!.propLayout = 'balanced'; request.designer!.propCoverage = 12;
    request.designer!.ceilings = true;
    const resolved = resolveGenerationSettings(request), snapshot = structuredClone(catalog), started = Date.now();
    await writeFile(path.join(caseDirectory, 'request.json'), JSON.stringify({ settings: resolved, catalog: snapshot, catalogNote: 'Synthetic measured test metadata; no Unity source prefab payload is sent.' }, null, 2));
    stage = 'concept';
    try {
      console.log(JSON.stringify({ case: id, stage }));
      const concept: MapConcept = { source: 'ai', text: await service.generateConcept(resolved, snapshot) };
      await writeFile(path.join(caseDirectory, 'concept.json'), JSON.stringify(concept, null, 2));
      const settings = conceptForRequest(resolved, concept);
      await writeFile(path.join(caseDirectory, 'resolved-request.json'), JSON.stringify({ settings, catalog: snapshot, concept }, null, 2));
      stage = 'image';
      console.log(JSON.stringify({ preset: id, stage, width: settings.width, height: settings.height, seed: settings.seed, pattern: settings.levelDesign!.pattern }));
      const image = await service.generateImage(settings, undefined, snapshot);
      await writeFile(path.join(caseDirectory, 'blueprint.png'), Buffer.from(image.split(',')[1], 'base64'));
      stage = 'extract'; console.log(JSON.stringify({ preset: id, stage, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
      const map = await service.extractLayout(settings, image, undefined, snapshot);
      const report = analyzeLevelDesign(map, settings), issues = [...validateMap(map), ...generationConditionIssues(map, settings), ...report.issues];
      const project = parseProjectFile({ formatVersion: 1, map, settings: resolved, bindings: snapshot, blueprintDataUrl: image, concept });
      await writeFile(path.join(caseDirectory, 'map.baekho.json'), JSON.stringify(project, null, 2));
      const result = { case: id, preset, result: issues.some(i => i.severity === 'error') ? 'FAIL' : 'PASS', concept: concept.text, width: map.width, height: map.height, seed: settings.seed, pattern: report.recipe.pattern, walkableArea: report.walkableArea, entryCells: report.reservedEntryCells.length, combatCells: report.combatCells.length, routeCount: report.routes.length, markers: map.markers, fixtures: map.fixtures, props: map.propInstances, uniqueHeights: [...new Set(map.elevations.flat())], ceilingYs: [...new Set(map.ceilings?.map(c => c.undersideY))], issues, elapsedSeconds: Math.round((Date.now() - started) / 1000) };
      results.push(result); await writeFile(path.join(caseDirectory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ case: id, result: result.result, elapsedSeconds: result.elapsedSeconds, issues }));
    } catch (error) {
      const result = { case: id, preset, result: 'FAIL', stage, message: error instanceof Error ? error.message : String(error), elapsedSeconds: Math.round((Date.now() - started) / 1000) };
      results.push(result); await writeFile(path.join(caseDirectory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    }
  }
} finally {
  try {
    const writes = await Promise.allSettled(rawWrites);
    const failedWrites = writes.filter(result => result.status === 'rejected').length;
    await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    if (failedWrites) { console.error(`Failed to persist ${failedWrites} response evidence files.`); process.exitCode = 1; }
  } finally { service.close(); }
}
if (results.some(result => (result as { result: string }).result !== 'PASS')) process.exitCode = 1;
