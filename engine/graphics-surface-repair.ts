import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

type FrozenFile = { path: string; sha256: string; bytes: number };
type ResultFile = FrozenFile & { kind: string };
type RunBlender = (binary: string, command: string[], signal: AbortSignal) => Promise<void>;
export type GraphicsSurfaceRepairArgs = {
  projectRoot: string; source: FrozenFile; sourceVersionId: string;
  repairSource: FrozenFile; repairVersionId: string; originalSource: FrozenFile; originalVersionId: string;
  mode: 'reuse-planar-material'; donorFaceIndex?: number;
  blenderPath: string; resources: string; signal: AbortSignal; onProgress?: (message: string) => void;
};
export type GraphicsSurfaceRepairResult = { files: ResultFile[]; report: any; cached: boolean };
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const fileHash = (file: string) => hash(fs.readFileSync(file));
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');
const inside = (root: string, file: string) => { const r = path.relative(root, file); return !!r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const active = new Set<string>();
const checks = ['staticOnly', 'appendOnlyAncestry', 'uniformCorrespondence', 'geometryPreserved', 'originalUVPreserved', 'onlyAddedDegenerateUVChanged', 'materialsAndImagesPreserved', 'allFacesHaveUV', 'fbxRoundTrip'];
const names = ['asset.blend', 'asset.fbx', 'asset.glb', 'report.json'];
const kinds = ['blend', 'model', 'model', 'report'];

function guarded(root: string, supplied: string, missing = false) {
  if (typeof supplied !== 'string' || !supplied || supplied.includes('\0')) throw Error('재질 복구 경로가 잘못됐습니다.');
  const actual = path.resolve(root, supplied);
  if (!inside(root, actual)) throw Error('재질 복구 경로가 프로젝트 밖입니다.');
  let current = root;
  for (const component of path.relative(root, actual).split(path.sep)) {
    if (component.includes(':')) throw Error('재질 복구 경로가 잘못됐습니다.');
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || path.relative(current, fs.realpathSync(current)) || current !== actual && !stat.isDirectory()) throw Error('재질 복구 경로의 링크는 지원하지 않습니다.');
    } catch (error) { if (!(missing && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error; }
  }
  return actual;
}
function directory(root: string, supplied: string) {
  const actual = guarded(root, supplied, true); fs.mkdirSync(actual, { recursive: true }); guarded(root, actual); return actual;
}
function verify(root: string, file: FrozenFile) {
  if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw Error('재질 복구 파일의 크기·해시가 잘못됐습니다.');
  const actual = guarded(root, file.path), stat = fs.lstatSync(actual);
  if (!stat.isFile() || stat.size !== file.bytes || fileHash(actual) !== file.sha256) throw Error('재질 복구 파일의 크기·해시가 변경됐습니다.');
  return actual;
}
function read(root: string, file: string): any {
  const actual = guarded(root, file), stat = fs.lstatSync(actual);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) throw Error('재질 복구 기록이 잘못됐습니다.');
  return JSON.parse(fs.readFileSync(actual, 'utf8'));
}
function validate(report: any, expected: Record<string, string>) {
  if (!report || report.schemaVersion !== 1 || report.passed !== true || Object.entries(expected).some(([k, v]) => report[k] !== v) ||
    checks.some(k => report.checks?.[k] !== true) || report.localOnly !== true || report.modelTurns !== 0 || report.paidSubmissions !== 0 ||
    !Array.isArray(report.repairedFaces) || !report.repairedFaces.length || !Array.isArray(report.mappings) || report.mappings.length !== report.repairedFaces.length ||
    report.uniqueUvLayout !== false || report.visualQualityVerified !== false || !Array.isArray(report.warnings) || report.warnings.length < 1)
    throw Error('재질 복구의 원본 보존·UV·이미지 검사 기록이 일치하지 않습니다.');
}
const runBlender: RunBlender = async (binary, command, signal) => {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, command, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', failure: Error | undefined, finished = false;
    const stop = (message: string) => { failure ??= Error(message); child.kill(); };
    const abort = () => stop('재질 복구를 중지했습니다.');
    const timer = setTimeout(() => stop('재질 복구 시간이 초과됐습니다.'), 10 * 60_000);
    const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', value => { tail = (tail + value).slice(-4000); }); child.stderr.on('data', value => { tail = (tail + value).slice(-4000); });
    child.on('error', error => finish(failure ?? error)); child.on('close', code => finish(failure ?? (code === 0 ? undefined : Error(`Blender 재질 복구 실패: ${tail}`))));
    if (signal.aborted) abort();
  });
};

/** Deliberate existing-pattern reuse, never a paid generation, adoption, or source rewrite. */
export function createGraphicsSurfaceRepairer(deps: { runBlender?: RunBlender } = {}) {
  return async (args: GraphicsSurfaceRepairArgs): Promise<GraphicsSurfaceRepairResult> => {
    args.signal.throwIfAborted();
    const inputs = [args.source, args.repairSource, args.originalSource];
    if (args.mode !== 'reuse-planar-material' || [args.sourceVersionId, args.repairVersionId, args.originalVersionId].some(v => typeof v !== 'string' || !v.trim()) ||
      new Set([args.sourceVersionId, args.repairVersionId, args.originalVersionId]).size !== 3 ||
      inputs.some(file => !file || path.extname(file.path).toLowerCase() !== '.fbx') ||
      args.donorFaceIndex !== undefined && (!Number.isSafeInteger(args.donorFaceIndex) || args.donorFaceIndex < 0))
      throw Error('재질 복구에는 정확한 텍스처·보완·이전 원본 FBX 버전과 명시적인 기존 재질 재사용 설정이 필요합니다.');
    const root = fs.realpathSync(args.projectRoot), resources = fs.realpathSync(args.resources), sources = inputs.map(file => verify(root, file));
    const tools = ['graphics_surface_repair.py', 'tripo_part_preservation.py', 'graphics_glb.py'].map(name => {
      const file = guarded(resources, path.join('blender', name)); return { name, path: file, sha256: fileHash(file), bytes: fs.statSync(file).size };
    });
    const validatorFingerprint = hash(JSON.stringify({ contract: 'surface-patch-reuse-v1', files: tools.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) }));
    const binding = { mode: args.mode, sourceVersionId: args.sourceVersionId, repairVersionId: args.repairVersionId, originalVersionId: args.originalVersionId,
      sourceSha256: args.source.sha256, repairSourceSha256: args.repairSource.sha256, originalSourceSha256: args.originalSource.sha256, validatorFingerprint };
    const identity = hash(JSON.stringify({ ...binding, inputBytes: inputs.map(file => file.bytes), donorFaceIndex: args.donorFaceIndex ?? null }));
    const expected = { identity, ...binding };
    const folder = path.join(root, 'graphics', 'surface-repair', identity.slice(0, 24)), manifestPath = path.join(folder, 'manifest.json');
    const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
    if (active.has(key)) throw Error('같은 재질 복구가 이미 실행 중입니다.'); active.add(key);
    let staging: string | undefined, completed = false;
    const recheck = () => { args.signal.throwIfAborted(); inputs.forEach(file => verify(root, file)); for (const file of tools) verify(resources, file); };
    try {
      guarded(root, manifestPath, true);
      if (fs.existsSync(manifestPath)) {
        const saved = read(root, manifestPath);
        if (saved.schemaVersion !== 1 || saved.identity !== identity || !/^attempt-[a-f0-9-]{36}$/.test(saved.attempt ?? '') || saved.files?.length !== names.length)
          throw Error('저장된 재질 복구 목록이 일치하지 않습니다.');
        saved.files.forEach((file: ResultFile, i: number) => {
          if (file.kind !== kinds[i] || file.path !== relative(root, path.join(folder, saved.attempt, names[i]))) throw Error('저장된 재질 복구 파일 경로가 일치하지 않습니다.');
          verify(root, file);
        });
        const report = read(root, verify(root, saved.files[3])); validate(report, expected); recheck();
        return { report, files: saved.files, cached: true };
      }
      if (!args.blenderPath || !fs.statSync(args.blenderPath).isFile()) throw Error('재질 복구에 사용할 Blender 경로를 확인하세요.');
      const tempRoot = fs.realpathSync(os.tmpdir()); staging = fs.mkdtempSync(path.join(tempRoot, 'ps-surface-repair-'));
      const input = directory(staging, 'input'), scripts = directory(staging, 'tools'), output = directory(staging, 'output');
      const labels = ['source', 'repairSource', 'originalSource'];
      const localSources = sources.map((source, i) => {
        const target = path.join(input, labels[i] + '.fbx'); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); verify(staging!, { ...inputs[i], path: target }); return target;
      });
      for (const file of tools) { const target = path.join(scripts, file.name); fs.copyFileSync(file.path, target, fs.constants.COPYFILE_EXCL); verify(staging, { ...file, path: target }); }
      const request = path.join(staging, 'request.json');
      fs.writeFileSync(request, JSON.stringify({ schemaVersion: 1, ...expected, donorFaceIndex: args.donorFaceIndex ?? null,
        ...Object.fromEntries(labels.map((label, i) => [label, localSources[i]])), output, report: path.join(output, 'report.json') }), { flag: 'wx' });
      args.onProgress?.('기존 재질 무늬를 빈 면에 연결하고, 원본 형상·나머지 UV·텍스처 파일 보존을 검사합니다.');
      await (deps.runBlender ?? runBlender)(args.blenderPath, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.join(scripts, 'graphics_surface_repair.py'), '--', request], args.signal);
      recheck(); inputs.forEach((file, i) => verify(staging!, { ...file, path: localSources[i] }));
      for (const file of tools) verify(staging, { ...file, path: path.join(scripts, file.name) });
      const report = read(staging, path.join(output, 'report.json')); validate(report, expected);
      const staged = names.map((name, i) => {
        const file = guarded(staging!, path.join(output, name)), stat = fs.lstatSync(file);
        if (!stat.isFile() || !stat.size) throw Error('재질 복구 결과 파일이 없습니다.');
        return { path: file, kind: kinds[i], sha256: fileHash(file), bytes: stat.size };
      });
      const attempt = 'attempt-' + randomUUID(), destination = directory(root, path.join(folder, attempt));
      const files = staged.map((file, i) => {
        args.signal.throwIfAborted(); const target = guarded(root, path.join(destination, names[i]), true);
        fs.copyFileSync(verify(staging!, file), target, fs.constants.COPYFILE_EXCL);
        const result = { ...file, path: relative(root, target) }; verify(root, result); return result;
      });
      validate(read(root, verify(root, files[3])), expected); recheck();
      const temporary = guarded(root, path.join(folder, 'manifest-' + randomUUID() + '.tmp'), true), fd = fs.openSync(temporary, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, identity, attempt, files }, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (fs.existsSync(guarded(root, manifestPath, true))) throw Error('다른 재질 복구 기록을 덮어쓰지 않습니다.');
      fs.renameSync(temporary, manifestPath); completed = true;
      return { report, files, cached: false };
    } finally {
      active.delete(key);
      if (completed && staging) {
        const tempRoot = fs.realpathSync(os.tmpdir()); guarded(tempRoot, staging);
        if (path.dirname(staging) === tempRoot && /^ps-surface-repair-[A-Za-z0-9]+$/.test(path.basename(staging))) fs.rmSync(staging, { recursive: true, force: true });
      }
    }
  };
}
export const repairGraphicsSurface = createGraphicsSurfaceRepairer();
