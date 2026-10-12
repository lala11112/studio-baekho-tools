import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { GraphicsFile, GraphicsObject } from '../shared/graphics';
import type { GraphicsNativeArgs, GraphicsNativeResult } from './graphics-native';

type RunBlender = (binary: string, args: string[], signal: AbortSignal) => Promise<void>;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const sha = (file: string) => hash(fs.readFileSync(file));
const inside = (root: string, file: string) => { const p = path.relative(root, file); return p !== '' && p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
const relative = (root: string, file: string) => path.relative(root, file).replaceAll('\\', '/');

/** Local presets are deliberately finite. Image likeness, arbitrary text and ornamental minerals need authoring. */
export function proceduralProblem(settings: GraphicsObject['settings'], taskId = 'M04'): string | undefined {
  if (!['M04', 'T02', 'T05'].includes(taskId)) return '지원하는 로컬 작업은 M04/T02/T05입니다.';
  if (String(settings.freeInstruction ?? '').trim()) return '로컬 제작은 수치·프리셋만 지원합니다. 자유 지시는 비우거나 Astra 제작을 선택하세요.';
  if (Number(settings.count ?? 1) !== 1) return '로컬 실행 단위는 후보 1개입니다. 후보별 독립 작업으로 요청하세요.';
  if (taskId === 'T02') {
    if (!['local', 'keep'].includes(String(settings.uvMode ?? 'local'))) return '로컬 UV는 local 또는 keep만 지원합니다.';
    if (settings.uvMode !== 'keep' && settings['lock.materials'] === true) return '새 UV 배치는 텍스처 위치가 달라질 수 있어 원본 재질 유지 잠금과 함께 실행할 수 없습니다.';
  } else if (taskId === 'T05') {
    if (settings.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(settings.color))) return '재질 색은 #RRGGBB 값이어야 합니다.';
    for (const key of ['roughness', 'metallic', 'opacity', 'emission']) if (settings[key] !== undefined && (typeof settings[key] !== 'number' || !Number.isFinite(settings[key]) || Number(settings[key]) < 0 || Number(settings[key]) > (key === 'emission' ? 100 : 1))) return `${key} 재질 수치를 확인하세요.`;
    if (!['color', 'roughness', 'metallic', 'emission', 'opacity'].some(key => settings[key] !== undefined)) return '변경할 재질 수치를 하나 이상 선택하세요.';
    if (settings['lock.materials'] === true || settings.color !== undefined && settings['lock.color'] === true) return '변경할 재질·색과 유지 잠금이 충돌합니다.';
  } else {
    const subject = String(settings.subject ?? '');
    if (!['rock', 'box'].includes(subject)) return '로컬 형상 프리셋은 바위(rock)와 상자(box)입니다.';
    const supported: Record<string, string[]> = {
      style: ['stylized', 'lowpoly', 'anime', 'realistic'], shape: ['rounded', 'angular', 'flat', 'long'],
      composition: ['whole'], mood: ['neutral'], material: ['reference', subject === 'rock' ? 'stone' : settings['attr.container'] === 'metal' ? 'metal' : 'wood'], wear: ['new'], detail: ['normal'],
      ...(subject === 'rock' ? { surface: ['smooth', 'rough', 'rugged'], cracks: ['none', 'few', 'many'], moss: ['none', 'some', 'many'], mineral: ['none'] } :
        { lid: ['none', 'closed', 'open'], container: ['crate', 'chest', 'metal'], interior: ['solid', 'hollow'], hinge: ['none'] }),
    };
    for (const [key, value] of Object.entries(settings)) {
      if (key.startsWith('lock.') && value === true) return '새 로컬 프리셋은 원본 외형 유지 잠금을 검증할 수 없습니다.';
      if (!key.startsWith('attr.') || value === '') continue;
      const name = key.slice(5);
      if (['width', 'height', 'depth'].includes(name)) { if (typeof value !== 'number' || value < .05 || value > 100 || !Number.isFinite(value)) return `${name} 크기는 0.05–100입니다.`; }
      else if (!supported[name]?.includes(String(value))) return `로컬 ${subject} 프리셋은 ${name}=${value} 옵션을 지원하지 않습니다.`;
    }
    if (settings.partId) return '로컬 프리셋의 지정 파츠 제작은 지원하지 않습니다.';
    if (settings.quad !== undefined && typeof settings.quad !== 'boolean') return '사각형 메시 옵션은 참/거짓이어야 합니다.';
    if (settings.symmetry !== undefined && typeof settings.symmetry !== 'boolean') return '대칭 옵션은 참/거짓이어야 합니다.';
    if (subject === 'box' && settings.symmetry === false) return '상자 로컬 프리셋은 X축 대칭만 지원합니다. 비대칭 형상은 Astra 제작을 선택하세요.';
    const faces = Number(settings.faceLimit ?? 10000), seed = Number(settings.variationSeed ?? 1);
    if (!Number.isInteger(faces) || faces < 100 || faces > 1000000) return '면 수 상한은 100–1000000입니다.';
    if (!Number.isInteger(seed) || seed < 1 || seed > 1000000) return '프리셋 후보 시드가 잘못됐습니다.';
    if (settings.scale !== undefined && Number(settings.scale) !== 1) return '로컬 크기는 width/height/depth로 설정하세요. 별도 scale은 1만 지원합니다.';
  }
  return undefined;
}
function verify(root: string, file: GraphicsFile) {
  const actual = path.resolve(root, file.path);
  if (!inside(root, actual) || !fs.existsSync(actual) || !inside(root, fs.realpathSync(actual)) || !fs.statSync(actual).isFile() || fs.statSync(actual).size !== file.bytes || sha(actual) !== file.sha256) throw Error('로컬 원본·결과의 경로·크기·해시가 다릅니다.');
  return actual;
}
function prepare(args: GraphicsNativeArgs) {
  const problem = proceduralProblem(args.task.settings, args.task.taskId); if (problem) throw Error(problem);
  if (args.task.objectId !== args.object.id || !/^[\w-]{1,160}$/.test(args.task.id)) throw Error('로컬 작업 대상·식별자가 다릅니다.');
  const root = fs.realpathSync(args.projectRoot), ids = args.task.inputVersionIds;
  if (new Set(ids).size !== ids.length || args.inputs.length !== ids.length || new Set(args.inputs.map(v => v.id)).size !== ids.length || args.inputs.some(v => !ids.includes(v.id) || v.objectId !== args.object.id)) throw Error('로컬 작업의 고정 입력 목록이 다릅니다.');
  for (const v of args.inputs) for (const f of v.files) verify(root, f);
  if (args.task.taskId === 'M04') return { root, source: undefined, version: undefined };
  const accepted = args.task.objectSnapshot?.accepted ?? {};
  const version = ['model', 'material'].flatMap(role => args.inputs.filter(v => v.role === role && accepted[`${v.role}:${v.slot}`] === v.id)).find(v => v.files.some(f => /\.(blend|glb|fbx)$/i.test(f.path)));
  const source = ['blend', 'glb', 'fbx'].map(ext => version?.files.find(f => f.path.toLowerCase().endsWith('.' + ext))).find(Boolean);
  if (!version || !source) throw Error('채택한 모델·재질의 BLEND/GLB/FBX 원본이 필요합니다.');
  return { root, source, version };
}
const runBlender: RunBlender = async (binary, command, signal) => {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, command, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', done = false;
    const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const abort = () => { child.kill(); finish(Error('로컬 제작을 중지했습니다.')); };
    const timer = setTimeout(() => { child.kill(); finish(Error('로컬 제작 시간이 초과됐습니다.')); }, 10 * 60_000);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', value => { tail = (tail + value).slice(-5000); }); child.stderr.on('data', value => { tail = (tail + value).slice(-5000); });
    child.on('error', finish); child.on('close', code => finish(code === 0 ? undefined : Error(`Blender 로컬 제작 실패: ${tail}`))); if (signal.aborted) abort();
  });
};
function walk(folder: string): string[] { return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => { const file = path.join(folder, entry.name); if (entry.isSymbolicLink()) throw Error('로컬 출력에 링크가 있습니다.'); return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : []; }); }
function durable(file: string, value: unknown) { const fd = fs.openSync(file, 'wx'); try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

export function createGraphicsProceduralExecutor(deps: { runBlender?: RunBlender } = {}) {
  const active = new Set<string>();
  return async (args: GraphicsNativeArgs): Promise<GraphicsNativeResult> => {
    args.signal.throwIfAborted();
    const { root, source, version } = prepare(args), output = path.join(root, 'graphics/jobs', args.task.id, 'procedural'), final = path.join(output, 'result');
    const script = path.join(args.resources, 'blender/graphics_procedural.py'), helper = path.join(args.resources, 'blender/graphics_glb.py');
    if (!fs.existsSync(script) || !fs.existsSync(helper)) throw Error('로컬 제작 리소스가 없습니다.');
    const identity = hash(JSON.stringify({ request: args.task.requestHash, operation: args.task.taskId, settings: args.task.settings, inputs: args.inputs, script: sha(script), helper: sha(helper) }));
    let ancestor = output; while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (fs.realpathSync(ancestor) !== root && !inside(root, fs.realpathSync(ancestor))) throw Error('로컬 출력 경로가 프로젝트 밖입니다.');
    const key = output.toLowerCase(); if (active.has(key)) throw Error('이 로컬 제작이 이미 실행 중입니다.'); active.add(key);
    let staging: string | undefined;
    try {
      fs.mkdirSync(output, { recursive: true });
      if (fs.existsSync(final) && !inside(root, fs.realpathSync(final))) throw Error('저장된 로컬 결과 경로가 프로젝트 밖입니다.');
      const checkpoint = path.join(final, 'checkpoint.json');
      if (fs.existsSync(checkpoint)) {
        const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
        if (saved.identity !== identity || !Array.isArray(saved.files) || !saved.files.length || JSON.stringify(saved.result?.files) !== JSON.stringify(saved.files.map(({ path, kind }: GraphicsFile) => ({ path, kind })))) throw Error('저장된 로컬 제작 요청이 다릅니다.');
        for (const file of saved.files) verify(root, file);
        return saved.result;
      }
      if (args.recoveryOnly || fs.readdirSync(output).length) throw Error('완료 기록 없는 로컬 제작은 자동 재실행하지 않습니다. 기존 출력을 보존하고 새 작업으로 실행하세요.');
      if (!fs.existsSync(args.blenderPath)) throw Error('설정된 Blender 실행 파일이 없습니다.');
      staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-proc-')); const input = path.join(staging, 'input'), out = path.join(staging, 'output'); fs.mkdirSync(input);
      const files = (version?.files ?? []).map((file, index) => { const local = path.join(input, `${index}-${path.basename(file.path)}`); fs.copyFileSync(verify(root, file), local, fs.constants.COPYFILE_EXCL); return { ...file, local, original: path.resolve(root, file.path) }; });
      const spec = path.join(staging, 'request.json');
      fs.writeFileSync(spec, JSON.stringify({ schemaVersion: 1, identity, taskId: args.task.taskId, settings: args.task.settings, source: files.find(f => f.path === source?.path)?.local,
        sourceSha256: source?.sha256, inputRoot: input, output: out, files }));
      durable(path.join(output, 'dispatch.json'), { identity, startedAt: new Date().toISOString(), localOnly: true, modelTurns: 0, paidSubmissions: 0 });
      args.onProgress('로컬 Blender에서 새 버전을 제작합니다. GPT 호출·유료 서비스 사용은 없습니다.');
      await (deps.runBlender ?? runBlender)(args.blenderPath, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script, '--', spec], args.signal);
      args.signal.throwIfAborted(); prepare(args);
      const report = JSON.parse(fs.readFileSync(path.join(out, 'inspection.json'), 'utf8'));
      if (report.identity !== identity || report.operation !== args.task.taskId || report.sourceSha256 !== source?.sha256 || report.originalPreserved !== true || !Number.isInteger(report.faces) || report.faces < 1 || !Number.isInteger(report.triangles) || report.triangles < report.faces || !(report.vertices > 0) || report.selfContainedGlb !== true || !Array.isArray(report.warnings)) throw Error('로컬 결과 원본·메시·GLB 검증이 실패했습니다.');
      for (const name of ['Asset.blend', 'Asset.fbx', 'Asset.glb']) if (!fs.statSync(path.join(out, name)).size) throw Error('편집 가능한 로컬 결과가 빠졌습니다.');
      if (args.task.taskId === 'M04' && (report.faceLimit !== Number(args.task.settings.faceLimit ?? 10000) || report.faceLimitSatisfied !== true || report.faces > report.faceLimit || args.task.settings.quad !== false && report.quads !== report.faces)) throw Error('로컬 면 수 상한·사각형 메시 검증이 실패했습니다.');
      if (args.task.taskId === 'M04' && args.task.settings.symmetry !== false && (report.symmetry?.axis !== 'X' || report.symmetry.verified !== true || !Number.isFinite(report.symmetry.maxMirrorError) || !Number.isFinite(report.symmetry.tolerance) || report.symmetry.tolerance <= 0 || report.symmetry.maxMirrorError > report.symmetry.tolerance)) throw Error('로컬 X축 대칭 메시 검증이 실패했습니다.');
      if (args.task.taskId === 'T05' && (!report.uvPreserved || !report.geometryPreserved || !report.originalTexturesPreserved)) throw Error('재질 수정 중 원본 UV·메시·텍스처 보존 검증이 실패했습니다.');
      const pending = path.join(output, 'pending'); fs.mkdirSync(pending);
      const filesOut: GraphicsFile[] = walk(out).map(file => { const name = path.relative(out, file), target = path.join(pending, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
        const ext = path.extname(name).toLowerCase(), kind = ext === '.blend' ? 'blend' : ext === '.fbx' || ext === '.glb' ? 'model' : ['.png', '.jpg', '.jpeg'].includes(ext) ? 'texture' : 'report';
        return { path: relative(root, path.join(final, name)), kind, sha256: sha(target), bytes: fs.statSync(target).size }; });
      const result: GraphicsNativeResult = { files: filesOut.map(({ path, kind }) => ({ path, kind })), role: 'model', slot: 'main',
        label: args.task.taskId === 'M04' ? `로컬 ${args.task.settings.subject === 'rock' ? '바위' : '상자'} 프리셋` : args.task.taskId === 'T02' ? '로컬 UV 버전' : '로컬 재질 버전', warnings: report.warnings,
        usage: { localOnly: true, modelTurns: 0, paidSubmissions: 0 } };
      durable(path.join(pending, 'checkpoint.json'), { schemaVersion: 1, identity, files: filesOut, result }); fs.renameSync(pending, final);
      return result;
    } finally { active.delete(key); if (staging && path.dirname(staging) === path.resolve(os.tmpdir()) && path.basename(staging).startsWith('ps-proc-')) fs.rmSync(staging, { recursive: true, force: true }); }
  };
}
export const executeGraphicsProcedural = createGraphicsProceduralExecutor();
