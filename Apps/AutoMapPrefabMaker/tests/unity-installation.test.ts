import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { inspectUnityFiles, prepareUnityFiles, unityMapFolder, writeUnityManifest } from '../electron/services/unity-installation';
import type { ExportManifest } from '../src/shared/types';

const legacyCatalog = 'namespace StudioBaekho { public static class BaekhoPropCatalog { public static int ExportToPath(string output, string[] guids) { return 0; } } }';
const sha256 = (source: string) => createHash('sha256').update(source).digest('hex');
async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else files[path.relative(root, file)] = await readFile(file, 'utf8');
    }
  }
  return files;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baekho-unity-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'Project'), resources = path.join(root, 'Resources');
  await mkdir(path.join(project, 'Assets'), { recursive: true });
  const files = ['Editor/BaekhoMapImporter.cs', 'Editor/BaekhoPropCatalog.cs', 'Runtime/BaekhoMapConnection.cs',
    'Runtime/BaekhoGameplayMarker.cs', 'Runtime/BaekhoMapFixture.cs', 'Runtime/BaekhoWallModule.cs', 'Mcp/BaekhoBuildMapTool.cs',
    'Runtime/BaekhoMapAsset.cs', 'Editor/BaekhoMapAssetEditor.cs', 'Editor/BaekhoAssetCatalog.cs', 'Mcp/BaekhoGetAssetCatalogTool.cs'];
  for (const file of files) {
    await mkdir(path.dirname(path.join(resources, file)), { recursive: true });
    await writeFile(path.join(resources, file), `// bundled ${file}`);
  }
  return { root, project, resources };
}

test('Unity setup installs once, updates only managed content and preserves .meta', async t => {
  const { project, resources } = await fixture(t);
  assert.equal((await prepareUnityFiles(project, resources)).changed, true);
  assert.equal((await prepareUnityFiles(project, resources)).changed, false);
  const importer = path.join(project, 'Assets/Baekho/Editor/BaekhoMapImporter.cs');
  await writeFile(`${importer}.meta`, 'guid: original');
  await writeFile(path.join(resources, 'Editor/BaekhoMapImporter.cs'), '// version 2');
  assert.equal((await prepareUnityFiles(project, resources)).changed, true);
  assert.equal(await readFile(importer, 'utf8'), '// version 2');
  assert.equal(await readFile(`${importer}.meta`, 'utf8'), 'guid: original');
  await writeFile(importer, '// custom dungeon hook');
  await writeFile(path.join(resources, 'Editor/BaekhoMapImporter.cs'), '// version 3');
  const result = await prepareUnityFiles(project, resources);
  assert.equal(result.changed, false);
  assert.equal(result.warnings.length, 1);
  assert.equal(await readFile(importer, 'utf8'), '// custom dungeon hook');
});

test('Existing customized importer in a different folder is preserved without duplicate installation', async t => {
  const { project, resources } = await fixture(t);
  const folder = path.join(project, 'Assets/Custom/Editor');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'BaekhoMapImporter.cs'), '// user importer');
  const result = await prepareUnityFiles(project, resources);
  assert.equal(result.warnings.length, 1);
  await assert.rejects(readFile(path.join(project, 'Assets/Baekho/Editor/BaekhoMapImporter.cs')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(folder, 'BaekhoMapImporter.cs'), 'utf8'), '// user importer');
});

test('A manually copied legacy exporter rejects every installation write and preserves source metadata', async t => {
  const { project, resources } = await fixture(t);
  const relative = 'Assets/Custom/Editor/BaekhoPropCatalog.cs';
  const catalog = path.join(project, relative);
  await mkdir(path.dirname(catalog), { recursive: true });
  await writeFile(catalog, legacyCatalog);
  await writeFile(`${catalog}.meta`, 'guid: legacy-exporter-guid');
  const before = await snapshotFiles(project);
  for (const operation of [inspectUnityFiles, prepareUnityFiles]) {
    await assert.rejects(operation(project, resources), error => {
      assert.match(String(error), /Assets\/Custom\/Editor\/BaekhoPropCatalog\.cs/);
      assert.match(String(error), /백업.*병합.*업데이트/);
      return true;
    });
    assert.deepEqual(await snapshotFiles(project), before);
  }
});

test('A user-edited managed legacy exporter blocks pending upgrades without changing its installation record', async t => {
  const { project, resources } = await fixture(t);
  const catalogPath = 'Assets/Baekho/Editor/BaekhoPropCatalog.cs', importerPath = 'Assets/Baekho/Editor/BaekhoMapImporter.cs';
  const record = path.join(project, 'Library/BaekhoMapForge/integration.json');
  await mkdir(path.dirname(path.join(project, catalogPath)), { recursive: true });
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(path.join(project, catalogPath), `${legacyCatalog}\n// User's custom exporter behaviour`);
  await writeFile(path.join(project, `${catalogPath}.meta`), 'guid: customized-exporter-guid');
  await writeFile(path.join(project, importerPath), '// original managed importer');
  await writeFile(record, JSON.stringify({ version: 1, files: {
    [catalogPath]: sha256(legacyCatalog), [importerPath]: sha256('// original managed importer'),
  } }));
  await writeFile(path.join(resources, 'Editor/BaekhoMapImporter.cs'), '// pending importer update');
  const before = await snapshotFiles(project);
  await assert.rejects(prepareUnityFiles(project, resources), /공개 측정 API/);
  assert.deepEqual(await snapshotFiles(project), before);
});

test('An unchanged managed legacy exporter upgrades automatically to the new inspection API', async t => {
  const { project, resources } = await fixture(t);
  const catalogPath = 'Assets/Baekho/Editor/BaekhoPropCatalog.cs';
  const record = path.join(project, 'Library/BaekhoMapForge/integration.json');
  await mkdir(path.dirname(path.join(project, catalogPath)), { recursive: true });
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(path.join(project, catalogPath), legacyCatalog);
  await writeFile(path.join(project, `${catalogPath}.meta`), 'guid: managed-legacy-guid');
  await writeFile(record, JSON.stringify({ version: 1, files: { [catalogPath]: sha256(legacyCatalog) } }));
  const latest = await readFile(path.resolve('unity-importer/Editor/BaekhoPropCatalog.cs'), 'utf8');
  await writeFile(path.join(resources, 'Editor/BaekhoPropCatalog.cs'), latest);
  assert.equal((await prepareUnityFiles(project, resources)).changed, true);
  assert.equal(await readFile(path.join(project, catalogPath), 'utf8'), latest);
  assert.equal(await readFile(path.join(project, `${catalogPath}.meta`), 'utf8'), 'guid: managed-legacy-guid');
});

test('Compatible customized exporter remains protected while dependent scripts install', async t => {
  const { project, resources } = await fixture(t);
  const catalog = path.join(project, 'Assets/Custom/Editor/BaekhoPropCatalog.cs');
  const customized = `${await readFile(path.resolve('unity-importer/Editor/BaekhoPropCatalog.cs'), 'utf8')}\n// User-specific exporter customization`;
  await mkdir(path.dirname(catalog), { recursive: true });
  await writeFile(catalog, customized);
  await writeFile(`${catalog}.meta`, 'guid: compatible-exporter-guid');
  const result = await prepareUnityFiles(project, resources);
  assert.equal(result.changed, true);
  assert.ok(result.warnings.some(warning => warning.includes('Assets/Custom/Editor/BaekhoPropCatalog.cs')));
  assert.equal(await readFile(catalog, 'utf8'), customized);
  assert.equal(await readFile(`${catalog}.meta`, 'utf8'), 'guid: compatible-exporter-guid');
  assert.ok(await readFile(path.join(project, 'Assets/Baekho/Editor/BaekhoAssetCatalog.cs'), 'utf8'));
  assert.equal((await prepareUnityFiles(project, resources)).changed, false);
});

test('Comments, string examples, private APIs and nested helper APIs do not satisfy exporter compatibility', async t => {
  const compatible = await readFile(path.resolve('unity-importer/Editor/BaekhoPropCatalog.cs'), 'utf8');
  const cases = [
    `${legacyCatalog}\n/* ${compatible} */`,
    `${legacyCatalog}\n// public sealed class Measurement {} public sealed class LocalBounds {}`,
    `namespace StudioBaekho { public static class BaekhoPropCatalog { public const string Example = @"${compatible.replaceAll('"', '""')}"; } }`,
    compatible.replace('public sealed class Measurement', 'private sealed class Measurement'),
    compatible.replace('public sealed class LocalBounds', 'private sealed class LocalBounds'),
    compatible.replace('public static Measurement MeasurePrefab', 'private static Measurement MeasurePrefab'),
    compatible.replace('public static string[] ResolveSelectedPrefabGuids', 'private static string[] ResolveSelectedPrefabGuids'),
    `namespace StudioBaekho { public static class BaekhoPropCatalog { private class Helper { ${compatible} } } }`,
  ];
  for (const [index, source] of cases.entries()) await t.test(`unsupported source ${index + 1}`, async child => {
    const { project, resources } = await fixture(child);
    const catalog = path.join(project, 'Assets/BaekhoPropCatalog.cs');
    await writeFile(catalog, source);
    const before = await snapshotFiles(project);
    await assert.rejects(prepareUnityFiles(project, resources), /호환되지 않습니다/);
    assert.deepEqual(await snapshotFiles(project), before);
  });
});

test('Duplicate importer is rejected before installation', async t => {
  const { project, resources } = await fixture(t);
  for (const folder of ['A', 'B']) {
    await mkdir(path.join(project, 'Assets', folder));
    await writeFile(path.join(project, 'Assets', folder, 'BaekhoMapImporter.cs'), '// duplicate');
  }
  await assert.rejects(prepareUnityFiles(project, resources), /중복/);
  await assert.rejects(readFile(path.join(project, 'Assets/Baekho/Runtime/BaekhoMapConnection.cs')), { code: 'ENOENT' });
});

test('Connection inspection is read-only and a missing resource leaves installation untouched', async t => {
  const { project, resources } = await fixture(t);
  assert.equal((await inspectUnityFiles(project, resources)).needsSetup, true);
  await assert.rejects(readFile(path.join(project, 'Library/BaekhoMapForge/integration.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(project, 'Assets/Baekho/Editor/BaekhoBuildMapTool.cs')), { code: 'ENOENT' });
  await rm(path.join(resources, 'Mcp/BaekhoBuildMapTool.cs'));
  await assert.rejects(prepareUnityFiles(project, resources), /스크립트가 없습니다/);
  await assert.rejects(readFile(path.join(project, 'Assets/Baekho/Editor/BaekhoMapImporter.cs')), { code: 'ENOENT' });
});

test('Manifest path normalizes map names, preserves metadata, and rejects junction escape', async t => {
  const { project, root } = await fixture(t);
  assert.equal(unityMapFolder('../../CON'), 'Map-CON');
  assert.equal(unityMapFolder('한글 맵'), '한글 맵');
  const manifest: ExportManifest = { schemaVersion: 5, name: '한글 맵', width: 2, height: 2, cellSize: 1, placements: [], markers: [], connections: [] };
  const relative = await writeUnityManifest(project, manifest);
  await writeFile(path.join(project, `${relative}.meta`), 'guid: stable');
  await writeUnityManifest(project, manifest);
  assert.equal(await readFile(path.join(project, `${relative}.meta`), 'utf8'), 'guid: stable');
  const outside = path.join(root, 'Outside');
  await mkdir(outside);
  await symlink(outside, path.join(project, 'Assets/Baekho/Generated/Escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeUnityManifest(project, { ...manifest, name: 'Escape' }), /링크/);
  await assert.rejects(readFile(path.join(outside, 'Map.baekhomap.json')), { code: 'ENOENT' });
});
