import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ExportManifest } from '../../src/shared/types';
import { atomicWrite } from './projects';

const SOURCES = [
  ['Editor/BaekhoMapImporter.cs', 'Editor/BaekhoMapImporter.cs'],
  ['Editor/BaekhoPropCatalog.cs', 'Editor/BaekhoPropCatalog.cs'],
  ['Editor/BaekhoAssetCatalog.cs', 'Editor/BaekhoAssetCatalog.cs'],
  ['Editor/BaekhoMapAssetEditor.cs', 'Editor/BaekhoMapAssetEditor.cs'],
  ['Runtime/BaekhoMapAsset.cs', 'Runtime/BaekhoMapAsset.cs'],
  ['Runtime/BaekhoMapConnection.cs', 'Runtime/BaekhoMapConnection.cs'],
  ['Runtime/BaekhoGameplayMarker.cs', 'Runtime/BaekhoGameplayMarker.cs'],
  ['Runtime/BaekhoMapFixture.cs', 'Runtime/BaekhoMapFixture.cs'],
  ['Runtime/BaekhoWallModule.cs', 'Runtime/BaekhoWallModule.cs'],
  ['Mcp/BaekhoBuildMapTool.cs', 'Editor/BaekhoBuildMapTool.cs'],
  ['Mcp/BaekhoGetAssetCatalogTool.cs', 'Editor/BaekhoGetAssetCatalogTool.cs'],
] as const;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Check the shared inspection contract before installing dependants beside a protected older exporter. */
function compatiblePropCatalog(contents: string): boolean {
  // Mask comments and C# string/character literals so documentation and example signatures cannot pass.
  const code = contents.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|(?:\$@|@\$|@)"(?:""|[^"])*"|\$?"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    literal => literal.replace(/[^\r\n]/g, ' '));
  const declaration = /\bpublic\s+(?:(?:static|partial)\s+)*class\s+BaekhoPropCatalog\s*\{/.exec(code);
  if (!declaration) return false;
  // Keep only direct members: a similarly named type/method inside another nested class is not callable.
  let depth = 0, members = '';
  for (let index = declaration.index + declaration[0].length; index < code.length; index++) {
    const token = code[index];
    if (token === '{') { if (depth++ === 0) members += '{}'; }
    else if (token === '}') { if (depth === 0) break; if (--depth === 0) members += ' '; }
    else if (depth === 0) members += token;
  }
  return /\bpublic\s+(?:(?:sealed|partial)\s+)*class\s+Measurement\s*\{/.test(members)
    && /\bpublic\s+(?:(?:sealed|partial)\s+)*class\s+LocalBounds\s*\{/.test(members)
    && /\bpublic\s+static\s+(?:BaekhoPropCatalog\.)?Measurement\s+MeasurePrefab\s*\(\s*(?:UnityEngine\.)?GameObject\s+\w+\s*,\s*string\s+\w+\s*,\s*(?:UnityEngine\.SceneManagement\.)?Scene\s+\w+\s*\)/.test(members)
    && /\bpublic\s+static\s+string\s*\[\s*\]\s+ResolveSelectedPrefabGuids\s*\(\s*(?:UnityEngine\.)?Object\s*\[\s*\]\s+\w+\s*\)/.test(members);
}

/** Refuse links at every existing ancestor, including Windows directory junctions. */
export async function unityProjectPath(projectRoot: string, relative: string, createParent = false): Promise<string> {
  const root = await realpath(projectRoot);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error('Unity 프로젝트 범위를 벗어난 경로입니다.');
  const parts = rel.split(path.sep);
  let cursor = root;
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info && createParent && i < parts.length - 1) {
      await mkdir(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      info = await lstat(cursor);
    }
    if (info?.isSymbolicLink()) throw new Error(`Unity 연동 경로에 링크를 사용할 수 없습니다: ${relative}`);
    if (info && i < parts.length - 1 && !info.isDirectory()) throw new Error(`폴더가 아닌 경로입니다: ${cursor}`);
    if (info && i === parts.length - 1 && !info.isFile()) throw new Error(`파일이 아닌 경로입니다: ${cursor}`);
    if (info) {
      const resolved = path.relative(root, await realpath(cursor));
      if (resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved))
        throw new Error('Unity 연동 경로가 프로젝트 밖으로 연결되어 있습니다.');
    }
  }
  return target;
}

async function optionalText(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
      throw new Error(`연동 파일이 올바르지 않거나 너무 큽니다: ${file}`);
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function findInstalledSources(root: string): Promise<Map<string, string[]>> {
  const names = new Set(SOURCES.map(([, destination]) => path.basename(destination)));
  const found = new Map<string, string[]>();
  const pending = [path.join(root, 'Assets')];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const info = await lstat(directory);
    if (info.isSymbolicLink()) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 200000) throw new Error('Unity 연동 파일 검색 범위가 너무 큽니다.');
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(full); continue; }
      if (entry.isFile() && names.has(entry.name)) {
        const locations = found.get(entry.name) ?? [];
        locations.push(path.relative(root, full).split(path.sep).join('/'));
        found.set(entry.name, locations);
      }
    }
  }
  return found;
}

async function planUnityFiles(projectRoot: string, resourceDirectory: string) {
  const root = await realpath(projectRoot);
  // Validate both roots before creating any directory.
  await unityProjectPath(root, 'Assets/Baekho/.installation-check');
  await unityProjectPath(root, 'Library/BaekhoMapForge/integration.json');
  const installed = await findInstalledSources(root);
  const recordPath = await unityProjectPath(root, 'Library/BaekhoMapForge/integration.json');
  const recordText = await optionalText(recordPath);
  let previous: Record<string, string> = {};
  if (recordText) {
    try {
      const record = JSON.parse(recordText);
      if (record.version !== 1 || !record.files || typeof record.files !== 'object' || Array.isArray(record.files))
        throw new Error('invalid');
      previous = record.files;
    } catch { throw new Error('Unity 연동 설치 기록을 읽을 수 없습니다. 기존 스크립트는 변경하지 않았습니다.'); }
  }
  const next: Record<string, string> = {};
  const writes: { relative: string; contents: string }[] = [];
  const warnings: string[] = [];
  for (const [source, destination] of SOURCES) {
    const contents = await optionalText(path.join(resourceDirectory, source));
    if (!contents?.trim()) throw new Error(`Unity 연동 스크립트가 없습니다: ${source}`);
    const matches = installed.get(path.basename(destination)) ?? [];
    if (matches.length > 1) throw new Error(`Unity 연동 스크립트가 중복 설치되어 있습니다: ${matches.join(', ')}`);
    const relative = matches[0] ?? `Assets/Baekho/${destination}`;
    const target = await unityProjectPath(root, relative);
    const existing = await optionalText(target);
    const desiredHash = hash(contents);
    if (existing === contents) { next[relative] = desiredHash; continue; }
    if (existing !== null && previous[relative] !== hash(existing)) {
      if (destination === 'Editor/BaekhoPropCatalog.cs' && !compatiblePropCatalog(existing))
        throw new Error(`보존할 기존 소품 내보내기 스크립트가 새 프리팹 등록 기능과 호환되지 않습니다: ${relative}. 사용자 수정 내용을 백업하고 최신 BaekhoPropCatalog.cs의 공개 측정 API(Measurement, LocalBounds, MeasurePrefab, ResolveSelectedPrefabGuids)를 이 파일에 병합하거나 최신 파일로 업데이트한 뒤 다시 시도해 주세요. 연동 파일과 설치 기록은 변경하지 않았습니다.`);
      warnings.push(`사용자 수정 또는 기존 설치를 보존했습니다: ${relative}`);
      // Never adopt an unknown/user-edited file into future automatic updates.
      continue;
    }
    writes.push({ relative, contents });
    next[relative] = desiredHash;
  }
  return { root, writes, warnings, next, recordText };
}

export async function inspectUnityFiles(projectRoot: string, resourceDirectory: string): Promise<{ needsSetup: boolean; warnings: string[] }> {
  const plan = await planUnityFiles(projectRoot, resourceDirectory);
  return { needsSetup: plan.writes.length > 0, warnings: plan.warnings };
}

export async function prepareUnityFiles(projectRoot: string, resourceDirectory: string): Promise<{ changed: boolean; warnings: string[] }> {
  const { root, writes, warnings, next, recordText } = await planUnityFiles(projectRoot, resourceDirectory);
  // Source/target validation for the whole set completes before the first write.
  for (const write of writes) {
    const target = await unityProjectPath(root, write.relative, true);
    await atomicWrite(target, write.contents);
  }
  const newRecord = JSON.stringify({ version: 1, files: next }, null, 2);
  if (newRecord !== recordText)
    await atomicWrite(await unityProjectPath(root, 'Library/BaekhoMapForge/integration.json', true), newRecord);
  return { changed: writes.length > 0, warnings };
}

export function unityMapFolder(name: string): string {
  let safe = Array.from(name.normalize('NFC').replace(/[^\p{L}\p{N} _-]/gu, '-')).slice(0, 64).join('')
    .replace(/^[ _-]+|[ _-]+$/g, '') || 'Map';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe)) safe = `Map-${safe}`;
  return safe;
}

export async function writeUnityManifest(projectRoot: string, manifest: ExportManifest): Promise<string> {
  const relative = `Assets/Baekho/Generated/${unityMapFolder(manifest.name)}/Map.baekhomap.json`;
  const contents = JSON.stringify(manifest, null, 2);
  if (Buffer.byteLength(contents, 'utf8') > 8 * 1024 * 1024) throw new Error('Unity 맵 JSON은 8 MiB 이하여야 합니다.');
  await atomicWrite(await unityProjectPath(projectRoot, relative, true), contents);
  return relative;
}
