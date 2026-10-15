/** Opt-in: sends two real image-generation and two vision requests using the signed-in Codex account. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexService } from '../electron/services/codex';
import { CodexTransport } from '../electron/services/codex-transport';
import { DEFAULT_SETTINGS, parseProjectFile, validateMap } from '../src/shared/map';
import { generationConditionIssues } from '../src/shared/features';
import { applyRoomPreset, resolveGenerationSettings } from '../src/shared/room-presets';
import { analyzeLevelDesign } from '../src/shared/level-design';
import type { AssetBinding, RoomPresetId } from '../src/shared/types';

const output = path.resolve('.local/level-design-ai-smoke', `run-${Date.now()}`);
await mkdir(output, { recursive: true });
const catalog: AssetBinding[] = ['crate', 'barrel'].map((id, index) => ({ id, label: `검증 ${id}`, role: 'prop', prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/Validation/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  prop: { category: id, tags: ['industrial'], blocksMovement: true, size: { x: 1, y: 1, z: 1 }, placement: 'floor', roomTypes: ['battle', 'boss'], weight: 1 } }));
let caseDirectory = output;
const rawWrites: Promise<unknown>[] = [];
const service = new CodexService({ dataDirectory: path.join(output, 'runtime'), timeoutMs: 10 * 60 * 1000,
  connect: async (runtime, directory) => {
    const transport = new CodexTransport(runtime.executable, directory); await transport.initialize();
    transport.onNotification((method, params) => {
      const item = params.item as Record<string, unknown> | undefined;
      if (method === 'item/completed' && item?.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string') {
        try { const value = JSON.parse(item.text); if (value && Array.isArray(value.rows)) rawWrites.push(writeFile(path.join(caseDirectory, 'raw-layout.json'), JSON.stringify(value, null, 2))); } catch { /* Non-JSON image phase prose is not recorded. */ }
      }
    });
    return transport;
  },
});
const results: unknown[] = [];
try {
  const status = await service.getStatus();
  console.log(JSON.stringify({ stage: 'status', state: status.state, version: status.version, output }));
  if (status.state !== 'ready') throw new Error(status.message);
  for (const id of ['small', 'shop'] as RoomPresetId[]) {
    caseDirectory = path.join(output, id); await mkdir(caseDirectory, { recursive: true });
    const request = applyRoomPreset(DEFAULT_SETTINGS, id);
    request.seed = id === 'small' ? 0 : 12;
    request.prompt = id === 'small'
      ? 'A compact industrial melee combat room. Keep a broad unobstructed flat fighting area, a small raised side platform with correctly aligned stair access, two exterior connection doors, and a few separate small crate or barrel obstacles away from entrance approaches and the fighting area. One standalone room; no corridors or stacked floors.'
      : 'A safe standalone industrial shop room with one external connection door and enough clear floor to approach a merchant. Flat continuous floor, no blocking props, no hazards, no enemies, no pits, no stairs. The merchant will be placed locally after extraction.';
    request.designer!.ceilings = true;
    const settings = resolveGenerationSettings(request), snapshot = structuredClone(catalog), started = Date.now();
    await writeFile(path.join(caseDirectory, 'request.json'), JSON.stringify({ settings, catalog: snapshot, catalogNote: 'Synthetic measured test metadata; no Unity source prefab payload is sent.' }, null, 2));
    let stage = 'image';
    try {
      console.log(JSON.stringify({ preset: id, stage, width: settings.width, height: settings.height, seed: settings.seed, pattern: settings.levelDesign!.pattern }));
      const image = await service.generateImage(settings, undefined, snapshot);
      await writeFile(path.join(caseDirectory, 'blueprint.png'), Buffer.from(image.split(',')[1], 'base64'));
      stage = 'extract'; console.log(JSON.stringify({ preset: id, stage, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
      const map = await service.extractLayout(settings, image, undefined, snapshot);
      const report = analyzeLevelDesign(map, settings), issues = [...validateMap(map), ...generationConditionIssues(map, settings), ...report.issues];
      const project = parseProjectFile({ formatVersion: 1, map, settings, bindings: snapshot, blueprintDataUrl: image });
      await writeFile(path.join(caseDirectory, 'map.baekho.json'), JSON.stringify(project, null, 2));
      const result = { preset: id, result: issues.some(i => i.severity === 'error') ? 'FAIL' : 'PASS', width: map.width, height: map.height, seed: settings.seed, pattern: report.recipe.pattern, walkableArea: report.walkableArea, entryCells: report.reservedEntryCells.length, combatCells: report.combatCells.length, routeCount: report.routes.length, markers: map.markers, fixtures: map.fixtures, props: map.propInstances, uniqueHeights: [...new Set(map.elevations.flat())], ceilingYs: [...new Set(map.ceilings?.map(c => c.undersideY))], issues, elapsedSeconds: Math.round((Date.now() - started) / 1000) };
      results.push(result); await writeFile(path.join(caseDirectory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    } catch (error) {
      const result = { preset: id, result: 'FAIL', stage, message: error instanceof Error ? error.message : String(error), elapsedSeconds: Math.round((Date.now() - started) / 1000) };
      results.push(result); await writeFile(path.join(caseDirectory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    }
  }
} finally { await Promise.all(rawWrites); await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); service.close(); }
if (results.some(result => (result as { result: string }).result !== 'PASS')) process.exitCode = 1;
