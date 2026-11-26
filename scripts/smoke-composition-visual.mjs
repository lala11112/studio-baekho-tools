// Deterministic before/after scene evidence using the actual application renderer.
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = resolve('.local/composition-visual'); await mkdir(output, { recursive: true });
const baseline = resolve(process.argv.find(a => a.startsWith('--baseline='))?.slice(11) ?? '.local/composition-baseline');
await access(resolve(baseline, 'src/shared/grouped-props.ts')).catch(() => { throw new Error('Provide --baseline=<source snapshot> containing the before-change src folder. The comparison never substitutes current code as its baseline.'); });
const imports = await Promise.all(['map', 'features', 'grouped-props', 'wall-mounts', 'room-composition'].map(name => tsImport(`../src/shared/${name}.ts`, import.meta.url)));
const [{ DEFAULT_SETTINGS, validateMap }, { DEFAULT_DESIGNER }, { placeGroupedProps }, { placeWallMounts, NEW_WALL_SETTINGS, wallMountIssues }, { planRoomComposition }] = imports;
const oldProps = await tsImport(pathToFileURL(resolve(baseline, 'src/shared/grouped-props.ts')).href, import.meta.url);
const oldWalls = await tsImport(pathToFileURL(resolve(baseline, 'src/shared/wall-mounts.ts')).href, import.meta.url);
const width = 24, height = 20;
const source = { version: 5, name: 'Composition comparison', width, height, cellSize: 2, maxStepHeight: .4, headroom: 2,
  rows: ['###########DD###########', ...Array(height - 2).fill('#......................#'), '########################'],
  elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], assetOverrides: [],
  connections: [{ id: 'north', label: '입구', x: 11, row: 0, direction: 0, width: 4, height: 3, kind: 'door' }],
  structureSettings: { ceilingClearance: 6, fillDoorTops: true, fillHeightGaps: true, gapRole: 'wall', pitBottomKind: 'deadzone', pitDepth: 4, deadzoneThickness: 1, defaultWallHeight: 6 } };
const settings = { ...DEFAULT_SETTINGS, width, height, seed: 237, connectionCount: 1, conceptMode: 'manual', prompt: 'Composition regression',
  levelDesign: { pattern: 'openArena', characterRadius: .4, dodgeDistance: 3 },
  designer: { ...DEFAULT_DESIGNER, elevation: false, props: true, propLayout: 'grouped', propCoverage: 8, decorations: false } };
const bindings = ['Console', 'Generator', 'Crate'].map((id, i) => ({ id, label: id, role: 'prop', prefabGuid: String(i + 1).repeat(32), prefabPath: `Assets/${id}.prefab`,
  scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
  prop: { category: id, tags: [], blocksMovement: true, size: { x: i === 1 ? 2.4 : 1.2, y: i === 1 ? 2 : 1.2, z: 1.2 }, placement: 'floor', roomTypes: ['battle'], weight: 1,
    composition: { usage: 'equipment', family: 'machines', member: 'either', arrangement: 'either' } } }));
const beforeProps = oldProps.placeGroupedProps(source, settings, bindings).map;
const afterProps = placeGroupedProps(source, settings, bindings);
const before = oldWalls.placeWallMounts(beforeProps, { ...settings, designer: { ...settings.designer,
  wallMounts: { ...oldWalls.DEFAULT_WALL_SETTINGS, enabled: true, singles: false, runOrientation: 'both', runDensity: 45, runHeight: { mode: 'random', reference: 'floor', min: 1, max: 4.5 } } } }, bindings).map;
const after = placeWallMounts(afterProps.map, { ...settings, designer: { ...settings.designer, wallMounts: { ...NEW_WALL_SETTINGS, enabled: true, singles: false, runDensity: 45 } } }, bindings).map;
for (const map of [before, after]) assert.deepEqual([...validateMap(map, bindings), ...wallMountIssues(map, bindings)].filter(i => i.severity === 'error'), []);
const composition = afterProps.composition ?? planRoomComposition(afterProps.map, settings, bindings);
const occupied = new Set((after.propInstances ?? []).flatMap(prop => prop.cells.map(c => `${c.x},${c.row}`)));
const density = kind => { const cells = composition.zones.filter(c => c.kind === kind); return cells.filter(c => occupied.has(`${c.x},${c.row}`)).length / Math.max(1, cells.length); };
const metrics = { focalCellOccupancy: density('focal'), supportCellOccupancy: density('support'), quietCellOccupancy: density('quiet'), quietCells: composition.quietCells.length };
assert.ok(metrics.focalCellOccupancy >= metrics.supportCellOccupancy * 1.5, 'a noticeably denser focal scene');
assert.equal(metrics.quietCellOccupancy, 0, 'additional quiet floor remains empty');
await writeFile(resolve(output, 'comparison.json'), JSON.stringify({ settings, composition, metrics, issues: afterProps.issues }, null, 2));
for (const [label, map] of [['before', before], ['after', after]]) await writeFile(resolve(output, `${label}.baekho.json`), JSON.stringify({ formatVersion: 1, map, settings, bindings }, null, 2));
const server = await createServer({ appType: 'custom', server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
server.middlewares.use('/evidence', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><html><meta charset="utf-8"><style>body{margin:0;background:#ecefe8;font:20px sans-serif}#grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:12px}article{background:white;border-radius:10px;overflow:hidden}h3{margin:12px;font-size:20px}.view{height:470px;position:relative}.preview-connection-key{display:none}</style><div id="grid"></div><script type="module">import {mountPreview} from '/src/preview.ts'; window.renderEvidence=(items)=>{document.querySelector('#grid').innerHTML=''; for(const item of items){const article=document.createElement('article'),title=document.createElement('h3'),view=document.createElement('div');title.textContent=item.label;view.className='view';article.append(title,view);document.querySelector('#grid').append(article);mountPreview(view,item.map,{bindings:item.bindings,showCeilings:false,showConnectionLabels:false,showCharacter:false,state:item.state});}window.ready=true;};</script></html>`); });
await server.listen();
const address = server.httpServer.address(), browser = await chromium.launch({ headless: true, channel: process.env.BAEKHO_BROWSER_CHANNEL ?? 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.on('pageerror', error => console.error(error));
  await page.goto(`http://127.0.0.1:${address.port}/evidence`); await page.waitForFunction(() => typeof window.renderEvidence === 'function');
  const top = { position: { x: 0, y: 85, z: -.01 }, target: { x: 0, y: 0, z: 0 }, zoom: 1.1 };
  const oblique = { position: { x: -50, y: 45, z: 55 }, target: { x: 0, y: 1, z: 0 }, zoom: 1.15 };
  await page.evaluate(items => window.renderEvidence(items), [
    { label: 'Before · top', map: before, bindings, state: top }, { label: 'After · top', map: after, bindings, state: top },
    { label: 'Before · room view', map: before, bindings, state: oblique }, { label: 'After · room view', map: after, bindings, state: oblique },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('canvas').length === 4); await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(output, 'before-after.png'), fullPage: true });
  const candidates = process.argv.find(a => a.startsWith('--candidates='))?.slice(13);
  if (candidates) {
    const files = (await readdir(candidates)).filter(f => /^candidate-\d+\.baekho\.json$/.test(f)).sort();
    const items = await Promise.all(files.map(async file => { const project = JSON.parse(await readFile(resolve(candidates, file), 'utf8')); return { label: file.replace('.baekho.json', ''), map: project.map, bindings: project.bindings, state: top }; }));
    await page.goto(`http://127.0.0.1:${address.port}/evidence`); await page.waitForFunction(() => typeof window.renderEvidence === 'function');
    await page.evaluate(items => window.renderEvidence(items), items); await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(output, 'candidate-contact-sheet.png'), fullPage: true });
  }
  console.log(JSON.stringify({ output, groups: new Set(after.propInstances?.map(p => p.groupId)).size, runs: new Set(after.fixtures?.filter(f => f.wall?.runId).map(f => f.wall.runId)).size, quietCells: composition.quietCells.length }));
} finally { await browser.close(); await server.close(); }
