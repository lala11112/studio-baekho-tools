import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { GraphicsFile } from '../shared/graphics';
import type { ExternalRigOperation, ExternalRigReport, RigHandoff } from '../shared/graphics-external-rig';

const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const active = new Set<string>();
function safe(root: string, target: string, missing = false) {
  root = path.resolve(root);
  const full = path.resolve(root, target), rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(':')) throw Error('Unsafe local rig path');
  let at = root;
  for (const part of ['', ...rel.split(path.sep)]) {
    at = path.join(at, part);
    try { if (fs.lstatSync(at).isSymbolicLink() || path.relative(at, fs.realpathSync(at))) throw Error('Linked rig paths are forbidden'); }
    catch (e) { if (!missing || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return full;
}
function verify(root: string, file: GraphicsFile) {
  const full = safe(root, file.path), stat = fs.statSync(full);
  if (!stat.isFile() || stat.size !== file.bytes || !/^[a-f0-9]{64}$/.test(file.sha256) || digest(fs.readFileSync(full)) !== file.sha256) throw Error('Rig input/output bytes changed');
  return full;
}
function read(file: string) {
  if (fs.statSync(file).size > 16 * 1024 * 1024) throw Error('Rig record too large');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function durable(file: string, value: unknown, exclusive = false) {
  const temp = exclusive ? file : file + '.' + randomUUID();
  const fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!exclusive) fs.renameSync(temp, file);
}
export type ExternalRigArgs = {
  projectRoot: string; handoffId: string; sourceVersionId: string; source: GraphicsFile;
  operation: ExternalRigOperation; blenderPath: string; workerPath: string; signal: AbortSignal;
  sourceToReturnedMatrix?: number[][];
  humanBones?: import('../shared/graphics-rig').HumanBoneBinding[]; fingers?: boolean;
  preparationReport?: GraphicsFile; returnedFbx?: GraphicsFile; recoveryOnly?: boolean;
  onProgress?: (message: string) => void;
};
type Run = (exe: string, argv: string[], signal: AbortSignal) => Promise<void>;
const run: Run = (exe, argv, signal) => new Promise((resolve, reject) => {
  const child = spawn(exe, argv, { signal, windowsHide: true, stdio: 'ignore' });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`Local rig worker exited ${code}`)));
});
export function createGraphicsExternalRigRunner(deps: { runBlender?: Run } = {}) {
  return async (args: ExternalRigArgs) => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(args.handoffId)) throw Error('Invalid handoff ID');
    if (!['prepare', 'inspect-return', 'import-return'].includes(args.operation)) throw Error('Invalid rig operation');
    const root = path.resolve(args.projectRoot);
    const source = verify(root, args.source);
    if (args.operation !== 'prepare' && (!args.preparationReport || !args.returnedFbx)) throw Error('Explicit prepared report and returned FBX required');
    if (args.returnedFbx && !/\.fbx$/i.test(args.returnedFbx.path)) throw Error('Returned file must be FBX');
    const prep = args.preparationReport && verify(root, args.preparationReport);
    const returned = args.returnedFbx && verify(root, args.returnedFbx);
    const folder = safe(root, path.join('graphics', 'external-rig', args.handoffId, args.operation), true);
    if (active.has(folder)) throw Error('Rig handoff is already active');
    fs.mkdirSync(folder, { recursive: true });
    const stateFile = path.join(folder, 'handoff.json'), dispatch = path.join(folder, 'dispatch.json');
    const outcomeFile = path.join(folder, 'process-outcome.json');
    const output = path.join(folder, 'output'), reportFile = path.join(output, 'report.json');
    const frozenJournal = fs.existsSync(dispatch) ? read(safe(root, dispatch)) : undefined;
    const workerSha = frozenJournal?.workerSha256 ?? digest(fs.readFileSync(args.workerPath));
    const blenderSha = frozenJournal?.blenderSha256 ?? digest(fs.readFileSync(args.blenderPath));
    if (![workerSha,blenderSha].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))) throw Error('Invalid frozen rig tools');
    const identity = digest(JSON.stringify({ sourceToReturnedMatrix: args.sourceToReturnedMatrix, humanBones: args.humanBones, fingers: args.fingers, source: args.source, sourceVersionId: args.sourceVersionId, prep: args.preparationReport, returned: args.returnedFbx, workerSha, blenderSha, operation: args.operation, handoffId: args.handoffId }));
    active.add(folder);
    let state: RigHandoff = { schemaVersion: 1, handoffId: args.handoffId, sourceVersionId: args.sourceVersionId, sourceSha256: args.source.sha256, operation: args.operation, state: args.operation === 'prepare' ? 'preparing' : 'inspecting', updatedAt: new Date().toISOString(), files: [] };
    const save = () => { state.updatedAt = new Date().toISOString(); durable(stateFile, state); };
    const check = () => { if (args.signal.aborted) throw Error('Rig operation cancelled'); verify(root, args.source); if (args.preparationReport) verify(root, args.preparationReport); if (args.returnedFbx) verify(root, args.returnedFbx); };
    try {
      check();
      if (fs.existsSync(stateFile)) {
        const previous = read(safe(root, stateFile)) as RigHandoff;
        if (previous.state === 'cancelled') { state = previous; throw Error('Cancelled rig handoff cannot resume'); }
      }
      let requestSha: string;
      if (fs.existsSync(dispatch)) {
        const journal = read(safe(root, dispatch));
        if (journal.identity !== identity) throw Error('Stale rig dispatch');
        requestSha = journal.requestSha256;
        if (digest(fs.readFileSync(safe(root, path.join(folder, 'request.json')))) !== requestSha) throw Error('Rig request changed');
        if (!fs.existsSync(reportFile)) throw Error('Already dispatched: only saved complete results may recover');
      } else {
        if (args.recoveryOnly) throw Error('No saved rig dispatch');
        fs.mkdirSync(output);
        const stagedSource = path.join(folder, 'source' + path.extname(source));
        fs.copyFileSync(source, stagedSource, fs.constants.COPYFILE_EXCL);
        const stagedWorker = path.join(folder, 'graphics_external_rig.py');
        fs.copyFileSync(args.workerPath, stagedWorker, fs.constants.COPYFILE_EXCL);
        const stage = (file: string | undefined, name: string) => { if (!file) return undefined; const dest = path.join(folder, name); fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL); return dest; };
        const request = { sourceToReturnedMatrix: args.sourceToReturnedMatrix, humanBones: args.humanBones, fingers: args.fingers, schemaVersion: 1, operation: args.operation, sourcePath: stagedSource, sourceSha256: args.source.sha256, outputDir: output, preparationReportPath: stage(prep, 'preparation-report.json'), preparationReportSha256: args.preparationReport?.sha256, returnedFbxPath: stage(returned, 'returned.fbx'), returnedFbxSha256: args.returnedFbx?.sha256 };
        const requestFile = path.join(folder, 'request.json');
        durable(requestFile, request, true); requestSha = digest(fs.readFileSync(requestFile));
        state.requestSha256 = requestSha; save();
        durable(dispatch, { identity, requestSha256: requestSha, workerSha256: workerSha, blenderSha256: blenderSha, localOnly: true, paidSubmissions: 0, modelTurns: 0 }, true);
        args.onProgress?.('로컬 복사본을 검사합니다. 외부 리깅 프로그램은 직접 실행해 주세요.');
        try {
          await (deps.runBlender ?? run)(args.blenderPath, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', stagedWorker, '--', '--request', requestFile, '--report', reportFile], args.signal);
          durable(outcomeFile, { requestSha256: requestSha, succeeded: true }, true);
        } catch(error) {
          durable(outcomeFile, { requestSha256: requestSha, succeeded: false }, true);
          if(args.signal.aborted || !fs.existsSync(reportFile)) throw error;
          // Only an exact request-bound blocked report may explain a nonzero exit.
          // Normal report validation below still checks every frozen input.
        }
        if (digest(fs.readFileSync(stagedSource)) !== args.source.sha256 || digest(fs.readFileSync(stagedWorker)) !== workerSha) throw Error('Staged rig inputs changed');
      }
      check();
      for (const [name, sha] of [['source' + path.extname(source), args.source.sha256], ['graphics_external_rig.py', workerSha], ...(args.preparationReport ? [['preparation-report.json', args.preparationReport.sha256]] : []), ...(args.returnedFbx ? [['returned.fbx', args.returnedFbx.sha256]] : [])]) {
        const staged = path.join(folder, name);
        if (fs.existsSync(dispatch) && digest(fs.readFileSync(safe(root, staged))) !== sha) throw Error('Staged rig input changed');
      }
      const report = read(safe(root, reportFile)) as ExternalRigReport;
      if (report.schemaVersion !== 1 || report.operation !== args.operation || report.sourceSha256 !== args.source.sha256 || report.requestSha256 !== requestSha || !['complete', 'blocked'].includes(report.status) || !Array.isArray(report.checks) || !Array.isArray(report.files)) throw Error('Invalid rig report binding');
      const outcome = fs.existsSync(outcomeFile) ? read(safe(root, outcomeFile)) : undefined;
      if (outcome && (outcome.requestSha256 !== requestSha || typeof outcome.succeeded !== 'boolean')) throw Error('Invalid rig process outcome');
      if (outcome?.succeeded === false && report.status !== 'blocked') throw Error('Nonzero rig exit cannot produce a completed result');
      if (report.status === 'blocked' && (typeof report.error !== 'string' || !report.error.trim() || report.error.length > 12000 || report.files.length || report.checks.length)) throw Error('Invalid blocked rig report');
      if (report.status === 'complete' && (!report.checks.length || report.checks.some(c => c.passed !== true || typeof c.id !== 'string'))) throw Error('Rig validation failed');
      const requiredChecks = args.operation === 'prepare'
        ? ['staticSource', 'sourceHashBound', 'sourceScenePacked', 'noInputWrites']
        : ['preparationHashBound', 'uniqueCoordinateCorrespondence', 'triangleMultisetExact', 'splitWeightsConsistent', 'normalizedSkin', ...(args.operation === 'import-return' ? ['originalMeshMaterialsUvRestored'] : [])];
      if (report.status === 'complete' && (new Set(report.checks.map(c => c.id)).size !== report.checks.length || requiredChecks.some(id => !report.checks.some(c => c.id === id && c.passed === true)))) throw Error('Required rig checks missing');
      const roles = args.operation === 'prepare' ? ['source-scene', 'preparation-fbx'] : args.operation === 'import-return' ? ['external-skeleton', 'blend', 'fbx', 'glb'] : [];
      if (report.status === 'complete' && roles.some(role => report.files.filter(f => f.role === role).length !== 1)) throw Error('Required rig output missing or duplicated');
      const seen = new Set<string>();
      const files: GraphicsFile[] = report.files.map(file => {
        const full = safe(output, file.path);
        if (seen.has(full.toLowerCase())) throw Error('Duplicate rig output'); seen.add(full.toLowerCase());
        const item = { path: path.relative(root, full), sha256: file.sha256, bytes: fs.statSync(full).size, kind: file.role };
        verify(root, item); return item;
      });
      const reportItem = { path: path.relative(root, reportFile), bytes: fs.statSync(reportFile).size, sha256: digest(fs.readFileSync(reportFile)), kind: 'report' };
      state = { ...state, requestSha256: requestSha, reportPath: reportItem.path, reportSha256: reportItem.sha256, files: [...files, reportItem], error: report.status === 'blocked' ? report.error : undefined, state: report.status === 'blocked' ? 'blocked' : args.operation === 'prepare' ? 'awaiting-external' : 'review' };
      const manifest = path.join(folder, 'manifest.json');
      const binding = { identity, requestSha256: requestSha, files: state.files };
      if (fs.existsSync(manifest)) { if (JSON.stringify(read(safe(root, manifest))) !== JSON.stringify(binding)) throw Error('Saved rig output manifest changed'); }
      else durable(manifest, binding, true);
      save();
      return { handoff: state, files: state.files, report, externalRig: { schemaVersion: 1 as const, handoffId: args.handoffId, sourceVersionId: args.sourceVersionId, sourceSha256: args.source.sha256, reportPath: reportItem.path, reportSha256: reportItem.sha256, returnedFbxSha256: args.returnedFbx?.sha256, contract: report.contract } };
    } catch (e) {
      state.state = args.signal.aborted || state.state === 'cancelled' ? 'cancelled' : 'failed'; state.error = e instanceof Error ? e.message : String(e); save(); throw e;
    } finally { active.delete(folder); }
  };
}
export const runGraphicsExternalRig = createGraphicsExternalRigRunner();
