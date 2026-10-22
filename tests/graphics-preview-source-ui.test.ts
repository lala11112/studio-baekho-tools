import { revealGraphicsControl } from './graphics-ui-disclosures';
import test from 'node:test';
import assert from 'node:assert/strict';

/** Small, self-contained binary glTF fixtures exercise the real GLTFLoader. */
function meshGlb(name: string, square = false): Buffer {
  const positions = new Float32Array(square ? [-1, 0, 0, 1, 0, 0, 1, 2, 0, -1, 2, 0] : [-1, 0, 0, 1, 0, 0, 0, 2, 0]);
  const indices = new Uint16Array(square ? [0, 1, 2, 0, 2, 3] : [0, 1, 2]);
  const source = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const binary = Buffer.concat([source, Buffer.alloc((4 - source.length % 4) % 4)]);
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }], meshes: [{ name, primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: source.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }] }));
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + paddedJson.length + binary.length, 8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(binary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, paddedJson, binHeader, binary]);
}

test('version preview loads its GLB despite an FBX production asset with the same ID, across UV result switching', { timeout: 60000 }, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url'), { createHash } = await import('node:crypto');
  const { build } = await import('esbuild'), { _electron: electron } = await import('playwright'), { default: electronBinary } = await import('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphics-preview-source-ui-'));
  const fixtures = { 'head.glb': meshGlb('Head preview'), 'head-uv.glb': meshGlb('UV preview', true),
    'head.fbx': Buffer.from('Kaydara FBX Binary  \\0'), 'head-uv.fbx': Buffer.from('Kaydara FBX Binary  \\0 UV') };
  for (const [name, bytes] of Object.entries(fixtures)) fs.writeFileSync(path.join(root, name), bytes);
  const file = (name: keyof typeof fixtures) => ({ path: name, bytes: fixtures[name].length, sha256: createHash('sha256').update(fixtures[name]).digest('hex'), kind: 'model' });
  const version = (id: 'head' | 'head-uv', role: 'model' | 'material') => ({ id, objectId: 'human', role, slot: 'part-head', label: id,
    files: [file(`${id}.fbx`), file(`${id}.glb`)], createdAt: '', sourceVersionIds: id === 'head' ? [] : ['head'], provenance: { type: 'local' }, warnings: [] });
  const workspace = { schemaVersion: 1, id: 'ws', projectId: 'p', revision: 3,
    objects: [{ id: 'human', name: 'Preview fixture', kind: 'character', createdAt: '', selectedTasks: [], settings: {}, instruction: '', references: [], accepted: { 'model:part-head': 'head' } }],
    versions: [version('head', 'model'), version('head-uv', 'material')], tasks: [], deliveries: [] };
  const project = { schemaVersion: 1, id: 'p', name: 'Preview source collision', style: '', height: 1, unityPath: '', unityFolder: '', createdAt: '', updatedAt: '', revision: 0,
    assets: ['head', 'head-uv'].map(id => ({ id: `graphics-${id}`, file: `${id}.fbx`, kind: 'model', label: `${id} native UV input`, origin: 'import', createdAt: '' })),
    parts: [], jobs: [], assemblies: [], builds: [], demo: false };
  const urls = Object.fromEntries(Object.keys(fixtures).map(name => [name, pathToFileURL(path.join(root, name)).href]));
  const entry = `import React from'react';import{createRoot}from'react-dom/client';import{GraphicsStudio}from${JSON.stringify(path.resolve('src/GraphicsStudio.tsx'))};import${JSON.stringify(path.resolve('src/style.css'))};
    const project=${JSON.stringify(project)},workspace=${JSON.stringify(workspace)},urls=${JSON.stringify(urls)};
    window.fixtureProject=project;window.fixtureWorkspace=workspace;window.assetRequests=[];window.actions=[];window.desktopCalls=[];
    window.desktop={assetUrl:(id,file)=>{window.assetRequests.push({id,file});if(!urls[file])throw Error('Unregistered fixture asset '+file);return urls[file]},call:request=>{window.desktopCalls.push(request);throw Error('Desktop work forbidden in preview inspection')}};
    const action=async request=>{window.actions.push(request);throw Error('Mutation forbidden in preview inspection')};
    createRoot(document.getElementById('root')).render(<GraphicsStudio project={project} workspace={workspace} busy={false} onAction={action}/>);`;
  await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'iife', outfile: path.join(root, 'ui.js'), jsx: 'automatic', logLevel: 'silent' });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; connect-src \'self\' file: blob:"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`);
  const app = await electron.launch({ executablePath: electronBinary as unknown as string, args: [path.join(root, 'main.cjs')] });
  try {
    const page = await app.firstWindow(), errors: string[] = [], serviceRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().route(/^https?:/, async route => { serviceRequests.push(route.request().url()); await route.abort(); });
    page.setDefaultTimeout(12000);
    await page.setViewportSize({ width: 1024, height: 768 });
    for (const [id, vertices, triangles] of [['head', 3, 1], ['head-uv', 4, 2], ['head', 3, 1]] as const) {
      await revealGraphicsControl(page.getByTestId(`graphics-version-${id}`));
      await page.getByTestId(`graphics-version-${id}`).click();
      await page.waitForFunction(({ vertices, triangles }) => {
        const viewport = document.querySelector('[data-testid="graphics-preview"] .viewport');
        const text = viewport?.querySelector('[data-testid="viewport-total-stats"]')?.textContent ?? '';
        return viewport?.getAttribute('data-mesh-count') === '1' && text.includes('정점 ' + vertices) && text.includes('삼각형 ' + triangles);
      }, { vertices, triangles });
      const preview = page.getByTestId('graphics-preview');
      assert.equal(await preview.locator('canvas').count(), 1);
      assert.equal(await preview.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width > 0 && (canvas as HTMLCanvasElement).height > 0), true);
      assert.equal(await preview.locator('.viewport-error').count(), 0);
      assert.equal(await page.getByTestId(`graphics-version-${id}`).getAttribute('aria-pressed'), 'true');
    }
    const requests = await page.evaluate(() => (window as any).assetRequests as { id: string; file: string }[]);
    assert.deepEqual([...new Set(requests.map(request => request.file))].sort(), ['head-uv.glb', 'head.glb']);
    assert.ok(requests.filter(request => request.file === 'head.glb').length >= 2, 'returning to the head reloads its GLB');
    assert.equal(requests.some(request => /\.fbx$/i.test(request.file)), false, 'native input assets must never reach GLTFLoader');
    assert.deepEqual(await page.evaluate(() => (window as any).actions), []);
    assert.deepEqual(await page.evaluate(() => (window as any).desktopCalls), []);
    assert.deepEqual(await page.evaluate(() => (window as any).fixtureWorkspace), workspace);
    assert.deepEqual(await page.evaluate(() => (window as any).fixtureProject), project);
    assert.deepEqual(errors, []); assert.deepEqual(serviceRequests, []);
  } finally {
    await app.close();
    for (const [name, bytes] of Object.entries(fixtures)) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes);
  }
});
