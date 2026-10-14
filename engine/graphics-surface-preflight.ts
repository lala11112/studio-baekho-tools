import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

type FrozenFile = { path: string; sha256: string; bytes: number };
type ResultFile = FrozenFile & { kind: 'report' };
type RunBlender = (binary: string, command: string[], signal: AbortSignal) => Promise<void>;
export type GraphicsSurfaceArgs = {
  projectRoot: string; source: FrozenFile; sourceVersionId: string; blenderPath: string;
  resources: string; signal: AbortSignal; onProgress?: (message: string) => void;
};
export type GraphicsSurfaceReport = {
  schemaVersion: 1; identity: string; sourceSha256: string; sourceVersionId: string; validatorFingerprint: string;
  passed: boolean; ready: boolean; reason: string; uvMissing: boolean; uvMissingFaces: number; invalidUvFaces: number; faces: number; triangles: number;
  materialIndexIssues: number; ambiguousUvMeshes: number; invalidGeometryFaces: number; reasons: string[];
  meshes: Array<{ name: string; faces: number; invalidUvFaces: number; uvMissing: number;
    materialIndexIssues: number; activeUv: string | null; renderUv: string | null; consumedUv: string | null; ambiguousUv: boolean }>;
  localOnly: true; modelTurns: 0; paidSubmissions: 0;
};
export type GraphicsSurfaceResult = { report: GraphicsSurfaceReport; files: ResultFile[]; cached: boolean };
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const fileHash = (file: string) => hash(fs.readFileSync(file));
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');
const inside = (root: string, file: string) => { const r = path.relative(root, file); return !!r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const active = new Set<string>();

function guarded(root: string, supplied: string, missing = false): string {
  if (!supplied || supplied.includes('\0')) throw Error('UV 검사 경로가 잘못됐습니다.');
  const actual = path.resolve(root, supplied);
  if (!inside(root, actual)) throw Error('UV 검사 경로가 프로젝트 밖입니다.');
  let current = root;
  for (const component of path.relative(root, actual).split(path.sep)) {
    if (component.includes(':')) throw Error('UV 검사 경로가 잘못됐습니다.');
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || path.relative(current, fs.realpathSync(current)) || current !== actual && !stat.isDirectory()) throw Error('UV 검사 경로의 링크는 지원하지 않습니다.');
    } catch (error) { if (!(missing && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error; }
  }
  return actual;
}
function directory(root: string, supplied: string) {
  const actual = guarded(root, supplied, true); fs.mkdirSync(actual, { recursive: true }); guarded(root, actual); return actual;
}
function verify(root: string, file: FrozenFile) {
  if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw Error('UV 검사 입력의 크기·해시가 잘못됐습니다.');
  const actual = guarded(root, file.path), stat = fs.lstatSync(actual);
  if (!stat.isFile() || stat.size !== file.bytes || fileHash(actual) !== file.sha256) throw Error('UV 검사 입력의 크기·해시가 변경됐습니다.');
  return actual;
}
function read(root: string, file: string): any {
  const actual = guarded(root, file), stat = fs.lstatSync(actual);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 8 * 1024 * 1024) throw Error('UV 검사 기록이 잘못됐습니다.');
  return JSON.parse(fs.readFileSync(actual, 'utf8'));
}
function validate(report: GraphicsSurfaceReport, expected: Record<string, string>) {
  const counts = ['uvMissingFaces', 'invalidUvFaces', 'faces', 'triangles', 'materialIndexIssues', 'ambiguousUvMeshes', 'invalidGeometryFaces'] as const;
  if (!report || report.schemaVersion !== 1 || Object.entries(expected).some(([k, v]) => (report as any)[k] !== v) ||
    counts.some(k => !Number.isSafeInteger(report[k]) || report[k] < 0) || typeof report.ready !== 'boolean' || report.passed !== report.ready || report.uvMissing !== (report.uvMissingFaces > 0) ||
    !Array.isArray(report.reasons) || report.reasons.some(v => typeof v !== 'string') || !Array.isArray(report.meshes) ||
    report.localOnly !== true || report.modelTurns !== 0 || report.paidSubmissions !== 0 ||
    report.ready !== (report.faces > 0 && report.triangles > 0 && !report.uvMissing && !report.invalidUvFaces && !report.materialIndexIssues && !report.ambiguousUvMeshes && !report.invalidGeometryFaces) ||
    typeof report.reason !== 'string' || report.reason !== report.reasons.join(' ') || (!report.ready && !report.reasons.length)) throw Error('원본 해시와 UV 검사 증거가 일치하지 않습니다.');
}
const runBlender: RunBlender = async (binary, command, signal) => {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, command, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', failure: Error | undefined, finished = false;
    const stop = (message: string) => { failure ??= Error(message); child.kill(); };
    const abort = () => stop('UV 검사를 중지했습니다.');
    const timer = setTimeout(() => stop('UV 검사 시간이 초과됐습니다.'), 180_000);
    const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', value => { tail = (tail + value).slice(-4000); }); child.stderr.on('data', value => { tail = (tail + value).slice(-4000); });
    child.on('error', error => finish(failure ?? error)); child.on('close', code => finish(failure ?? (code === 0 ? undefined : Error(`Blender UV 검사 실패: ${tail}`))));
    if (signal.aborted) abort();
  });
};

/** Read-only copied-input inspection. A failed coverage report is cached too; no model or paid call is made. */
export function createGraphicsSurfaceInspector(deps: { runBlender?: RunBlender } = {}) {
  return async (args: GraphicsSurfaceArgs): Promise<GraphicsSurfaceResult> => {
    args.signal.throwIfAborted();
    if (!args.sourceVersionId?.trim() || !/\.(fbx|glb|blend|obj|stl)$/i.test(args.source.path)) throw Error('UV 검사에는 정확한 원본 버전과 모델 파일이 필요합니다.');
    const root = fs.realpathSync(args.projectRoot), resources = fs.realpathSync(args.resources), source = verify(root, args.source);
    const tools = ['graphics_surface_preflight.py', 'graphics_glb.py'].map(name => {
      const file = guarded(resources, path.join('blender', name)); return { name, path: file, sha256: fileHash(file), bytes: fs.statSync(file).size };
    });
    const validatorFingerprint = hash(JSON.stringify({ contract: 'surface-coverage-v1', files: tools.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) }));
    const identity = hash(JSON.stringify({ sourceVersionId: args.sourceVersionId, source: args.source, validatorFingerprint }));
    const expected = { identity, sourceSha256: args.source.sha256, sourceVersionId: args.sourceVersionId, validatorFingerprint };
    const folder = path.join(root, 'graphics', 'surface-inspection', identity.slice(0, 24)), manifestPath = path.join(folder, 'manifest.json');
    const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
    if (active.has(key)) throw Error('같은 원본의 UV 검사가 이미 실행 중입니다.'); active.add(key);
    let staging: string | undefined, completed = false;
    const recheck = () => { args.signal.throwIfAborted(); verify(root, args.source); for (const file of tools) verify(resources, file); };
    try {
      guarded(root, manifestPath, true);
      if (fs.existsSync(manifestPath)) {
        const saved = read(root, manifestPath);
        if (saved.schemaVersion !== 1 || saved.identity !== identity || !/^attempt-[a-f0-9-]{36}$/.test(saved.attempt ?? '') ||
          saved.files?.length !== 1 || saved.files[0].kind !== 'report' || saved.files[0].path !== relative(root, path.join(folder, saved.attempt, 'report.json'))) throw Error('저장된 UV 검사 목록이 일치하지 않습니다.');
        const report = read(root, verify(root, saved.files[0])); validate(report, expected); recheck();
        return { report, files: saved.files, cached: true };
      }
      if (!args.blenderPath || !fs.statSync(args.blenderPath).isFile()) throw Error('UV 검사에 사용할 Blender 경로를 확인하세요.');
      const tempRoot = fs.realpathSync(os.tmpdir()); staging = fs.mkdtempSync(path.join(tempRoot, 'ps-surface-'));
      const input = directory(staging, 'input'), scripts = directory(staging, 'tools');
      const localSource = path.join(input, 'source' + path.extname(source).toLowerCase()); fs.copyFileSync(source, localSource, fs.constants.COPYFILE_EXCL);
      verify(staging, { ...args.source, path: localSource });
      for (const file of tools) { const target = path.join(scripts, file.name); fs.copyFileSync(file.path, target, fs.constants.COPYFILE_EXCL); verify(staging, { ...file, path: target }); }
      const request = path.join(staging, 'request.json'), localReport = path.join(staging, 'report.json');
      fs.writeFileSync(request, JSON.stringify({ schemaVersion: 1, ...expected, source: localSource, report: localReport }), { flag: 'wx' });
      args.onProgress?.('텍스처 생성 전 모든 면의 UV와 재질 연결을 로컬에서 검사합니다.');
      await (deps.runBlender ?? runBlender)(args.blenderPath, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.join(scripts, 'graphics_surface_preflight.py'), '--', request], args.signal);
      recheck(); verify(staging, { ...args.source, path: localSource });
      for (const file of tools) verify(staging, { ...file, path: path.join(scripts, file.name) });
      const report = read(staging, localReport); validate(report, expected);
      const attempt = 'attempt-' + randomUUID(), destination = directory(root, path.join(folder, attempt));
      const target = guarded(root, path.join(destination, 'report.json'), true); fs.copyFileSync(localReport, target, fs.constants.COPYFILE_EXCL);
      const files: ResultFile[] = [{ path: relative(root, target), kind: 'report', bytes: fs.statSync(target).size, sha256: fileHash(target) }];
      validate(read(root, verify(root, files[0])), expected); recheck();
      const temporary = guarded(root, path.join(folder, 'manifest-' + randomUUID() + '.tmp'), true), fd = fs.openSync(temporary, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, identity, attempt, files }, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (fs.existsSync(guarded(root, manifestPath, true))) throw Error('다른 UV 검사 기록을 덮어쓰지 않습니다.');
      fs.renameSync(temporary, manifestPath); completed = true;
      return { report, files, cached: false };
    } finally {
      active.delete(key);
      if (completed && staging) {
        const tempRoot = fs.realpathSync(os.tmpdir()); guarded(tempRoot, staging);
        if (path.dirname(staging) === tempRoot && /^ps-surface-[A-Za-z0-9]+$/.test(path.basename(staging))) fs.rmSync(staging, { recursive: true, force: true });
      }
    }
  };
}
export const inspectGraphicsSurface = createGraphicsSurfaceInspector();
