import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import type { AutoRigReadiness } from '../shared/graphics-auto-rig';
import { validateAutoRigPartPolicy, validateAutoRigPartReport, type AutoRigPartPolicy } from '../shared/graphics-auto-rig';
const sha = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export type AutoRigRepair = { mesh: string; islandId: string; kind: 'normalize' | 'remove-influence' | 'rigid-bind'; bones?: string[]; targetBone?: string };
export type GraphicsAutoRigArgs = { blenderPath: string; workerPath: string; sourceBlend: string; sourceSha256: string; outputDir: string; operation: 'rig' | 'inspect' | 'repair'; sourceToRigMatrix?: number[][]; fingers?: boolean; repairs?: AutoRigRepair[]; recoveryOnly?: boolean; partPolicy?: AutoRigPartPolicy; workerResources?: Record<string,string> };
type Hooks = { signal?: AbortSignal; onProgress?: (message: string) => void };
const progressLabels: Record<string,string> = {
  'prepare-smart-copy':'자동 리깅용 작업 사본을 준비합니다.',
  'ai-body-markers':'몸의 관절 위치를 분석합니다.',
  'ai-finger-markers':'손가락 관절 위치를 분석합니다.',
  'detect-reference-rig':'분석한 관절로 기준 골격을 만듭니다.',
  'match-control-rig':'움직임 제어용 리그를 연결합니다.',
  'bind-weights':'모델과 뼈를 연결하고 웨이트를 계산합니다.',
  'inspect-repair':'연결 부위와 본 영향을 검사하고 선택한 보정을 적용합니다.',
  'export-fbx':'게임용 FBX를 별도 파일로 저장합니다.',
  'verify-exported-skeleton':'저장한 FBX의 실제 본 이름을 검증합니다.',
  'export-preview':'팔·팔꿈치·양쪽 무릎의 검사 동작을 저장합니다.',
  'running':'로컬 리깅 작업을 진행합니다.',
  'exported-review-pending':'저장을 마쳤습니다. 결과의 외형과 움직임을 확인하세요.',
  'failed':'로컬 리깅 작업이 완료되지 않았습니다.',
};
export const autoRigProgressLabel = (step: string) => progressLabels[step] ?? '로컬 리깅 결과를 확인합니다.';
function nativeFailure(error: unknown) {
  const value=typeof error==='string'?error.slice(0,2000):'';
  const known:Record<string,string>={
    'Rig rest geometry changed':'중립 자세의 형상 변화가 허용 범위를 넘었습니다.',
    'Packed image bytes changed':'원본 이미지의 보존 검사에 실패했습니다.',
    'Packed source image bytes changed':'원본 이미지의 보존 검사에 실패했습니다.',
    'Repair has no valid remaining mass':'선택한 보정 후 남는 유효한 웨이트가 없습니다. 다른 부위나 본을 선택하세요.',
    'Input not a fresh static mesh':'새 리깅에는 기존 리그·웨이트·변형·애니메이션이 없는 정적 모델이 필요합니다.',
    'AI installation missing':'Auto-Rig Pro AI 파일이 설치되어 있지 않습니다.',
    'Protected topology, UV, attributes or materials changed':'토폴로지·UV·속성·재질의 보존 검사에 실패했습니다.',
    'Humanoid mapping does not match exported FBX names':'Humanoid 본 연결이 저장된 FBX의 실제 본 이름과 다릅니다.',
  };
  return '로컬 리깅 실패: '+((known[value]??value)||'완전한 결과가 저장되지 않았습니다. 실행 기록을 확인하세요.');
}
function durable(file: string, value: unknown) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function confined(root: string, file: string) {
  const full = path.resolve(file), rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('작업 폴더 밖의 결과는 사용할 수 없습니다.');
  let at = root;
  for (const part of rel.split(path.sep)) { at = path.join(at, part); if (fs.lstatSync(at).isSymbolicLink()) throw Error('링크로 연결된 결과 파일은 사용할 수 없습니다.'); }
  return full;
}
export function inspectSavedGraphicsAutoRig(outputDir: string) {
  const root = path.resolve(outputDir);
  const journal = JSON.parse(fs.readFileSync(path.join(root, 'dispatch.json'), 'utf8'));
  if (fs.existsSync(path.join(root, 'cancelled.json'))) throw Error('취소한 실행은 복구하지 않습니다.');
  const outcomePath=path.join(root,'process-outcome.json');
  if (fs.existsSync(outcomePath)) { const outcome=JSON.parse(fs.readFileSync(outcomePath,'utf8')); if(outcome.requestSha256!==journal.requestSha256||outcome.succeeded!==true)throw Error('로컬 작업 프로세스가 정상적으로 완료되지 않았습니다.'); }
  const requestPath = path.join(root, 'request.json');
  if (sha(requestPath) !== journal.requestSha256 || sha(path.join(root, 'worker.py')) !== journal.toolSha256) throw Error('고정한 작업 도구 또는 요청이 변경됐습니다.');
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  if(request.workerResources!==undefined){
    if(!request.workerResources||Array.isArray(request.workerResources)||Object.keys(request.workerResources).some(n=>n!=='graphics_auto_rig_parts.py'))throw Error('고정 작업 도구의 리소스 명세가 잘못됐습니다.');
    for(const [name,expected] of Object.entries(request.workerResources))if(typeof expected!=='string'||sha(confined(root,path.join(root,name)))!==expected)throw Error('고정 작업 도구의 리소스가 변경됐습니다.');
  }
  if (sha(request.sourceBlend) !== request.sourceSha256) throw Error('작업 사본의 원본 파일이 변경됐습니다.');
  const reportPath = path.join(root, 'output', 'run-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (report.requestSha256 !== journal.requestSha256 || report.sourceSha256 !== request.sourceSha256 || report.operation !== request.operation || report.osInputUsed !== false || report.paidSubmissions !== 0) throw Error('결과 기록이 고정한 원본·요청과 일치하지 않습니다.');
  if (report.status === 'failed') throw Error(nativeFailure(report.error));
  if (report.status !== 'exported-review-pending' || !Array.isArray(report.files) || report.files.length !== 3) throw Error('완전한 결과가 저장되지 않았습니다. 저장된 실행 기록을 확인하세요.');
  validateAutoRigPartReport(request.partPolicy,report);
  const expected = ['rigged.blend', 'character.fbx', 'character.glb'];
  for (const name of expected) {
    const file = report.files.find((v: { path: string }) => path.basename(v.path) === name);
    if (!file || file.path !== path.join(root, 'output', name)) throw Error('예상한 결과 파일과 저장된 파일이 다릅니다.');
    const full = confined(root, file.path);
    if (fs.statSync(full).size !== file.bytes || file.bytes < 100 || sha(full) !== file.sha256) throw Error('저장된 결과 파일의 내용이 변경됐습니다.');
  }
  return { blendPath: path.join(root, 'output', expected[0]), fbxPath: path.join(root, 'output', expected[1]), glbPath: path.join(root, 'output', expected[2]), reportPath, requestPath, requestSha256: journal.requestSha256 as string, toolSha256: journal.toolSha256 as string, report };
}
export async function runGraphicsAutoRig(args: GraphicsAutoRigArgs, hooks: Hooks = {}) {
  if(args.partPolicy!==undefined)validateAutoRigPartPolicy(args.partPolicy);
  if (!['rig', 'inspect', 'repair'].includes(args.operation) || !/\.(blend|fbx)$/i.test(args.sourceBlend) || args.operation !== 'rig' && !/\.blend$/i.test(args.sourceBlend)) throw Error('자동 리깅 작업 또는 원본 파일 형식이 잘못됐습니다.');
  if (hooks.signal?.aborted) throw Error('작업을 중단했습니다.');
  if (sha(args.sourceBlend) !== args.sourceSha256) throw Error('원본 파일이 변경됐습니다.');
  if (args.operation === 'rig' && (!args.sourceToRigMatrix || args.sourceToRigMatrix.length !== 4 || args.sourceToRigMatrix.some(row => row.length !== 4 || row.some(v => !Number.isFinite(v))))) throw Error('모델의 앞 방향 설정이 올바르지 않습니다.');
  if (args.operation === 'repair' && !args.repairs?.length) throw Error('보정할 부위와 방식을 먼저 선택하세요.');
  const root = path.resolve(args.outputDir);
  if (fs.existsSync(path.join(root, 'dispatch.json'))) {
    const request = JSON.parse(fs.readFileSync(path.join(root, 'request.json'), 'utf8'));
    if (request.sourceSha256 !== args.sourceSha256 || request.operation !== args.operation || JSON.stringify(request.repairs) !== JSON.stringify(args.repairs) || JSON.stringify(request.sourceToRigMatrix) !== JSON.stringify(args.sourceToRigMatrix) || request.fingers !== args.fingers || JSON.stringify(request.partPolicy)!==JSON.stringify(args.partPolicy)||args.workerResources!==undefined&&JSON.stringify(request.workerResources)!==JSON.stringify(args.workerResources)) throw Error('저장된 요청과 현재 선택이 다릅니다.');
    return inspectSavedGraphicsAutoRig(root);
  }
  if (args.recoveryOnly) throw Error('복구할 저장 실행 기록이 없습니다.');
  if(args.workerResources===undefined){const helper=path.join(path.dirname(args.workerPath),'graphics_auto_rig_parts.py');if(fs.existsSync(helper))args={...args,workerResources:{'graphics_auto_rig_parts.py':sha(helper)}};}
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) throw Error('새 실행의 작업 폴더가 비어 있지 않습니다.');
  fs.mkdirSync(path.join(root, 'output'));
  const staged = path.join(root, 'source' + path.extname(args.sourceBlend).toLowerCase()), worker = path.join(root, 'worker.py');
  fs.copyFileSync(args.sourceBlend, staged, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(args.workerPath, worker, fs.constants.COPYFILE_EXCL);
  if(args.workerResources!==undefined){
    if(!args.workerResources||Array.isArray(args.workerResources)||Object.keys(args.workerResources).some(n=>n!=='graphics_auto_rig_parts.py'))throw Error('작업 도구의 리소스 명세가 잘못됐습니다.');
    for(const [name,expected] of Object.entries(args.workerResources)){
      const original=path.join(path.dirname(args.workerPath),name);
      if(sha(original)!==expected)throw Error('고정한 작업 도구의 리소스가 변경됐습니다.');
      fs.copyFileSync(original,path.join(root,name),fs.constants.COPYFILE_EXCL);
    }
  }
  const requestPath = path.join(root, 'request.json');
  durable(requestPath, { schemaVersion: 1, operation: args.operation, sourceBlend: staged, sourceSha256: args.sourceSha256, sourceToRigMatrix: args.sourceToRigMatrix, fingers: args.fingers, repairs: args.repairs, ...(args.partPolicy?{partPolicy:args.partPolicy}:{}),...(args.workerResources?{workerResources:args.workerResources}:{}) });
  durable(path.join(root, 'dispatch.json'), { requestSha256: sha(requestPath), toolSha256: sha(worker), blenderSha256: sha(args.blenderPath), startedAt: new Date().toISOString(), automaticRetries: 0, osInputUsed: false, paidSubmissions: 0 });
  hooks.onProgress?.('설치된 Auto-Rig Pro로 로컬 작업을 시작합니다.');
  await new Promise<void>((resolve, reject) => {
    const argv = ['--factory-startup', ...(args.operation === 'rig' ? [] : ['--background']), '--python', worker, '--', requestPath];
    // Windows process startup flags hide the OpenGL-capable Blender process;
    // no window APIs, screen capture, mouse or keyboard automation are used.
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const ps = `$p = Start-Process -FilePath ${quote(args.blenderPath)} -ArgumentList @(${argv.map(v=>quote('"'+v.replaceAll('"','\\"')+'"')).join(',')}) -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput ${quote(path.join(root,'blender.stdout.log'))} -RedirectStandardError ${quote(path.join(root,'blender.stderr.log'))}; exit $p.ExitCode`;
    const hiddenWindows = process.platform === 'win32' && args.operation === 'rig';
    const child = spawn(hiddenWindows ? 'powershell.exe' : args.blenderPath, hiddenWindows ? ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')] : argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(root, 'process.log'), { flags: 'wx' });
    child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
    const abort = () => {
      if (!fs.existsSync(path.join(root, 'cancelled.json'))) durable(path.join(root, 'cancelled.json'), { cancelledAt: new Date().toISOString() });
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    };
    const timer = setInterval(() => {
      try { const report = JSON.parse(fs.readFileSync(path.join(root, 'output', 'run-report.json'), 'utf8')); hooks.onProgress?.(autoRigProgressLabel(String(report.currentStep ?? report.status))); } catch { /* no partial JSON exposure */ }
    }, 1500);
    hooks.signal?.addEventListener('abort', abort, { once: true });
    if (hooks.signal?.aborted) abort();
    const finish = () => { clearInterval(timer); hooks.signal?.removeEventListener('abort', abort); log.end(); };
    const outcome=(succeeded:boolean,detail:string)=>{const file=path.join(root,'process-outcome.json');if(!fs.existsSync(file))durable(file,{requestSha256:sha(requestPath),succeeded,detail,finishedAt:new Date().toISOString()});};
    child.once('error', e => { outcome(false,e.message); finish(); reject(e); });
    child.once('exit', code => { outcome(code===0&&!hooks.signal?.aborted,String(code)); finish(); hooks.signal?.aborted ? reject(Error('작업을 중단했습니다.')) : code === 0 ? resolve() : reject(Error(`로컬 리깅 프로세스가 종료 코드 ${code}로 중단됐습니다. 실행 기록을 확인하세요.`)); });
  });
  if (sha(args.sourceBlend) !== args.sourceSha256) throw Error('실행 중 원본 파일이 변경됐습니다.');
  return inspectSavedGraphicsAutoRig(root);
}

export function probeGraphicsAutoRig(blenderPath: string, workerPath: string): Promise<AutoRigReadiness> {
  return new Promise(resolve => {
    execFile(blenderPath, ['--background','--factory-startup','--python',workerPath,'--','--probe'], {windowsHide:true,timeout:30000,maxBuffer:2*1024*1024}, (error, stdout) => {
      try {
        const line=stdout.split(/\r?\n/).find(v=>v.startsWith('PARTSMITH_PROBE '));
        if (!line) throw Error(error?.message ?? '설치 확인 결과를 받지 못했습니다.');
        resolve({...JSON.parse(line.slice('PARTSMITH_PROBE '.length)),checkedAt:new Date().toISOString()});
      } catch(e) { resolve({available:false,checkedAt:new Date().toISOString(),message:String(e)}); }
    });
  });
}

