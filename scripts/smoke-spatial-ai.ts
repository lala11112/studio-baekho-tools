/** Real signed-in Codex generation: identical briefs, varied spatial intentions, no retries. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexService } from '../electron/services/codex';
import { DEFAULT_SETTINGS, createDemoMap, parseProjectFile, validateMap } from '../src/shared/map';
import { applyRoomPreset } from '../src/shared/room-presets';
import { analyzeLevelDesign } from '../src/shared/level-design';
import { generateVariants } from '../src/shared/variants';
import type { AssetBinding } from '../src/shared/types';

const output = path.resolve(process.argv.find(a => a.startsWith('--output='))?.slice(9) ?? `.local/spatial-ai/run-${Date.now()}`);
const count = Number(process.argv.find(a => a.startsWith('--count='))?.slice(8) ?? 5);
if (!Number.isInteger(count) || count < 2 || count > 8) throw new Error('count must be an integer from 2 to 8');
await mkdir(output, { recursive: true });
const settings = applyRoomPreset(DEFAULT_SETTINGS, 'medium');
Object.assign(settings, { conceptMode: 'manual', prompt: '근접 공격과 회피를 사용하는 전투방. 진입 후 주변을 살피고 접근 방향과 이탈 경로를 선택할 수 있다. 공간마다 전투 거리를 조절하며 이동할 수 있다.',
  sizeMode: 'custom', width: 20, height: 18, seed: 651337, connectionCount: 3 });
Object.assign(settings.designer!, { elevation: true, props: true, propLayout: 'grouped', propCoverage: 8, ceilings: false, enemies: false, rewards: false, lights: false, decorations: false });
settings.levelDesign!.pattern = 'openArena';
const bindings: AssetBinding[] = [
  ['generator', '발전기', 2.4, 2.4, 1.8], ['console', '제어 콘솔', 2.4, 1.3, 1.2], ['storage', '적재 상자', 1.2, 1.2, 1.2],
].map(([id, label, x, y, z], index) => ({ id: String(id), label: String(label), role: 'prop', prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/Validation/${id}.prefab`,
  scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
  prop: { category: String(label), tags: [], blocksMovement: true, size: { x: Number(x), y: Number(y), z: Number(z) }, placement: 'floor', roomTypes: ['battle'], weight: 1,
    composition: { usage: 'equipment', family: 'validation', member: 'either', arrangement: 'either' } } }));
const source = parseProjectFile({ formatVersion: 1, settings, bindings, map: createDemoMap() });
const service = new CodexService({ dataDirectory: path.join(output, 'runtime') });
let index = 0, previous = '', writes: Promise<unknown>[] = [];
const saved = new Set<string>();
try {
  const status = await service.getStatus();
  console.log(JSON.stringify({ output, state: status.state, version: status.version }));
  if (status.state !== 'ready') throw new Error(status.message);
  const results = await generateVariants(source, count, {
    generateImage: async (request, catalog, context) => {
      index = context?.candidateIndex ?? index;
      await writeFile(path.join(output, `request-${index + 1}.json`), JSON.stringify({ settings: request, context, catalogNote: 'Measured synthetic validation metadata.' }, null, 2));
      const image = await service.generateImage(request, undefined, catalog, context);
      await writeFile(path.join(output, `blueprint-${index + 1}.png`), Buffer.from(image.split(',')[1], 'base64'));
      return image;
    },
    extractLayout: (request, image, catalog) => service.extractLayout(request, image, undefined, catalog),
    isCancelled: () => false,
    onUpdate: variants => {
      const state = variants.map(v => `${v.index + 1}:${v.status}`).join(' ');
      if (state !== previous) { console.log(state); previous = state; }
      writes.push(writeFile(path.join(output, 'progress.json'), JSON.stringify(variants.map(({ project, ...v }) => ({ ...v, mapName: project?.map.name })), null, 2)));
      for (const candidate of variants) if (candidate.project && !saved.has(candidate.id)) {
        saved.add(candidate.id);
        writes.push(writeFile(path.join(output, `candidate-${candidate.index + 1}.baekho.json`), JSON.stringify(candidate.project, null, 2)));
      }
    },
  });
  for (const candidate of results) if (candidate.project) {
    await writeFile(path.join(output, `candidate-${candidate.index + 1}.baekho.json`), JSON.stringify(candidate.project, null, 2));
  }
  const report = results.map(v => ({ index: v.index + 1, status: v.status, label: v.label, error: v.error, warnings: v.warnings,
    ...(v.project ? { safety: [...validateMap(v.project.map, bindings), ...analyzeLevelDesign(v.project.map, v.project.settings).issues].filter(i => i.severity === 'error') } : {}) }));
  await Promise.all(writes);
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.filter(v => v.status === 'ready').length < Math.min(4, count) || report.some(v => v.safety?.length)) process.exitCode = 1;
} finally { service.close(); }
