import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { importedModelSourceProblem, type AssetVersion } from '../shared/graphics';
import { validateNativeTopologyMap, type NativeTopologyResult } from '../shared/native-topology';

type Options = {
  projectRoot: (id: string) => string;
  version: (id: string, versionId: string) => AssetVersion | undefined;
  blenderPath: () => string;
  resources: () => string;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hashFile = (file: string) => hash(fs.readFileSync(file));
function contained(root: string, file: string) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('검사 경로가 프로젝트 밖입니다.');
  return relative.split(path.sep).join('/');
}
function checkedFile(root: string, relative: string, digest: string) {
  const file = path.resolve(root, relative); contained(root, file);
  contained(fs.realpathSync(root), fs.realpathSync(file));
  if (!fs.statSync(file).isFile() || hashFile(file) !== digest) throw Error('등록한 원본 또는 미리보기 해시가 달라 원본 면 검사를 중단했습니다.');
  return file;
}
function run(executable: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve();
    };
    const timer = setTimeout(() => finish(Error('원본 면 검사의 로컬 처리 시간이 초과됐습니다. 게임용 삼각형 보기를 사용할 수 있습니다.')), 180_000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + String(chunk)).slice(-3500); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? undefined : Error(`원본 면 검사를 완료하지 못했습니다: ${output}`)));
  });
}

/** Lazy, local-only derivatives. No workspace writes, task execution, or acceptance changes. */
export class NativeTopologyManager {
  private pending = new Map<string, Promise<NativeTopologyResult>>();
  private allowed = new Map<string, { versionId: string; sourcePath: string; sourceHash: string; oldPreviewPath: string; oldPreviewHash: string; previewHash: string; mapPath: string; mapHash: string; dependencies: { path: string; sha256: string }[] }>();
  constructor(private readonly options: Options) {}
  inspect(id: string, versionId: string): Promise<NativeTopologyResult> {
    const key = `${id}:${versionId}`, previous = this.pending.get(key);
    if (previous) return previous;
    const job = this.prepare(id, versionId).catch(error => ({ status: 'unavailable' as const, reason: error instanceof Error ? error.message : String(error) })).finally(() => this.pending.delete(key));
    this.pending.set(key, job); return job;
  }
  /** Exact receipt-bound file only. Every serve rechecks registered source and derivative hashes. */
  isAllowed(id: string, absolutePath: string): boolean {
    try {
      const root = fs.realpathSync(this.options.projectRoot(id)), file = path.resolve(absolutePath);
      contained(root, file);
      const permission = this.allowed.get(`${id}:${file}`);
      if (!permission) return false;
      const version = this.options.version(id, permission.versionId);
      if (version && importedModelSourceProblem(version)) return false;
      if (!version?.files.some(value => value.path === permission.sourcePath && value.sha256 === permission.sourceHash) ||
        !version.files.some(value => value.path === permission.oldPreviewPath && value.sha256 === permission.oldPreviewHash)) return false;
      checkedFile(root, permission.sourcePath, permission.sourceHash);
      checkedFile(root, permission.oldPreviewPath, permission.oldPreviewHash);
      for (const dependency of permission.dependencies) {
        if (!version.files.some(file => file.path === dependency.path && file.sha256 === dependency.sha256)) return false;
        checkedFile(root, dependency.path, dependency.sha256);
      }
      checkedFile(root, contained(root, file), permission.previewHash);
      checkedFile(root, contained(root, permission.mapPath), permission.mapHash);
      return true;
    } catch { return false; }
  }
  private async prepare(id: string, versionId: string): Promise<NativeTopologyResult> {
    const root = fs.realpathSync(this.options.projectRoot(id)), version = this.options.version(id, versionId);
    if (!version) throw Error('검사할 원본 버전을 찾지 못했습니다.');
    const sourceProblem = importedModelSourceProblem(version);
    if (sourceProblem) throw Error(sourceProblem);
    const source = version.files.find(file => /\.blend$/i.test(file.path)) ?? version.files.find(file => /\.fbx$/i.test(file.path));
    const originalPreview = version.files.find(file => file.path === version.preview && /\.glb$/i.test(file.path)) ?? version.files.find(file => /\.glb$/i.test(file.path));
    if (!source || !originalPreview) throw Error('원본 면 정보가 있는 Blender·FBX 원본과 연결된 GLB가 필요합니다. 현재 자료는 게임용 삼각형 보기만 가능합니다.');
    const sourcePath = checkedFile(root, source.path, source.sha256);
    checkedFile(root, originalPreview.path, originalPreview.sha256);
    const dependencies = version.files.filter(file => /\.(png|jpe?g|webp|tga|tiff?|bmp|exr|hdr)$/i.test(file.path)).map(file => ({ path: file.path, sha256: file.sha256 }));
    const dependencyPaths = dependencies.map(file => checkedFile(root, file.path, file.sha256));
    const resources = this.options.resources(), script = path.join(resources, 'blender/native_topology.py');
    const executable = this.options.blenderPath();
    if (!fs.existsSync(executable)) throw Error('원본 면 검사에 필요한 로컬 Blender 경로를 설정하세요.');
    const executableInfo = fs.statSync(executable);
    const exporterFingerprint = hash(JSON.stringify({ schema: 1, script: hashFile(script), images: hashFile(path.join(resources, 'blender/graphics_glb.py')),
      executable, bytes: executableInfo.size, modified: executableInfo.mtimeMs }));
    const identity = { sourceVersionId: versionId, source: { path: source.path, sha256: source.sha256 },
      originalPreview: { path: originalPreview.path, sha256: originalPreview.sha256 }, dependencies, exporterFingerprint };
    const key = hash(JSON.stringify(identity));
    const cacheRoot = path.join(root, 'graphics/inspection/native-topology');
    fs.mkdirSync(cacheRoot, { recursive: true }); contained(root, fs.realpathSync(cacheRoot));
    const receipt = path.join(cacheRoot, key + '.json');
    let previewPath: string, mapPath: string;
    if (fs.existsSync(receipt)) {
      const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (saved.identity !== key) throw Error('원본 면 캐시 식별자가 달라 재사용하지 않았습니다.');
      previewPath = checkedFile(root, saved.preview.path, saved.preview.sha256);
      mapPath = checkedFile(root, saved.map.path, saved.map.sha256);
    } else {
      const runRoot = path.join(cacheRoot, `${key}-${randomUUID()}`);
      fs.mkdirSync(runRoot); contained(root, fs.realpathSync(runRoot));
      previewPath = path.join(runRoot, 'preview.glb'); mapPath = path.join(runRoot, 'topology.json');
      // Blender/Python's temporary-directory and image APIs still hit MAX_PATH
      // even when Node can read the project. Keep every Blender output short.
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-topo-'));
      contained(fs.realpathSync(os.tmpdir()), fs.realpathSync(temporary));
      try {
        const stagedPreview = path.join(temporary, 'preview.glb'), stagedMap = path.join(temporary, 'topology.json');
        const allowedResources: string[] = [], resourceMappings: Record<string, string> = {};
        let inspectionSource = '';
        // Importers can unpack embedded media beside the FBX. Stage registered
        // bytes first so even that side effect cannot touch a production folder.
        const files = [sourcePath, ...dependencyPaths];
        let common = path.dirname(sourcePath);
        while (files.some(file => { const relative = path.relative(common, file); return relative.startsWith('..') || path.isAbsolute(relative); })) common = path.dirname(common);
        for (const file of files) {
          const staged = path.join(temporary, 'input', path.relative(common, file));
          contained(temporary, staged); fs.mkdirSync(path.dirname(staged), { recursive: true });
          fs.copyFileSync(file, staged, fs.constants.COPYFILE_EXCL);
          if (hashFile(file) !== hashFile(staged)) throw Error('검사 사본의 원본 해시가 다릅니다.');
          if (file === sourcePath) inspectionSource = staged;
          else { allowedResources.push(staged); resourceMappings[file] = staged; }
        }
        const spec = JSON.stringify({ sourcePath: inspectionSource, previewPath: stagedPreview, mapPath: stagedMap, identity, allowedResources, resourceMappings, stagingRoot: path.join(temporary, 'input') });
        fs.writeFileSync(path.join(runRoot, 'request.json'), spec);
        const request = path.join(temporary, 'request.json'); fs.writeFileSync(request, spec);
        const stagedScript = path.join(temporary, 'native_topology.py');
        fs.copyFileSync(script, stagedScript, fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(path.join(resources, 'blender/graphics_glb.py'), path.join(temporary, 'graphics_glb.py'), fs.constants.COPYFILE_EXCL);
        await run(executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', stagedScript, '--', request]);
        checkedFile(root, source.path, source.sha256); checkedFile(root, originalPreview.path, originalPreview.sha256);
        dependencies.forEach(file => checkedFile(root, file.path, file.sha256));
        const map = JSON.parse(fs.readFileSync(stagedMap, 'utf8')); validateNativeTopologyMap(map);
        if (map.previewSha256 !== hashFile(stagedPreview)) throw Error('검사 미리보기 해시가 명세와 다릅니다.');
        fs.copyFileSync(stagedPreview, previewPath, fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(stagedMap, mapPath, fs.constants.COPYFILE_EXCL);
      } finally {
        // This is our exact mkdtemp directory, checked again before recursion.
        contained(fs.realpathSync(os.tmpdir()), fs.realpathSync(temporary));
        fs.rmSync(temporary, { recursive: true, force: true });
      }
      // Publish only validated complete artifacts; interrupted scratch files cannot be reused.
      fs.writeFileSync(receipt, JSON.stringify({ identity: key,
        preview: { path: contained(root, previewPath), sha256: hashFile(previewPath) },
        map: { path: contained(root, mapPath), sha256: hashFile(mapPath) } }), { flag: 'wx' });
    }
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8')); validateNativeTopologyMap(map);
    if (map.sourceVersionId !== versionId || map.source.path !== source.path || map.source.sha256 !== source.sha256 ||
      map.originalPreview.path !== originalPreview.path || map.originalPreview.sha256 !== originalPreview.sha256 ||
      JSON.stringify(map.dependencies) !== JSON.stringify(dependencies) ||
      map.exporterFingerprint !== exporterFingerprint || map.previewSha256 !== hashFile(previewPath)) throw Error('원본과 검사 결과의 연결이 달라 재사용하지 않았습니다.');
    const preview = { path: contained(root, previewPath), sha256: map.previewSha256, bytes: fs.statSync(previewPath).size };
    this.allowed.set(`${id}:${previewPath}`, { versionId, sourcePath: source.path, sourceHash: source.sha256,
      oldPreviewPath: originalPreview.path, oldPreviewHash: originalPreview.sha256, previewHash: preview.sha256, mapPath, mapHash: hashFile(mapPath), dependencies });
    return { status: 'ready', preview, map };
  }
}
