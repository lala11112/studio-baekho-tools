/** Run once only after the parent confirms that this M08 job is complete.
 * Read-only against the project: no Blender, worker, service, recovery or polling.
 * The only write is a separate audit JSON inside this repository's artifacts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults = {
  project: path.join(os.homedir(), 'AppData', 'Roaming', 'partsmith', 'projects', '5844e13a-7892-422b-ac3f-410fe4f59231'),
  task: '83903b1a-0f3f-47de-9e5b-a1b5d18f7f9b',
  output: path.join(repository, 'artifacts/runtime/graphics-human-head-assembly-audit.json'),
};
const supplied = process.argv.slice(2);
if (supplied.includes('--help')) {
  console.log('After confirmed completion: node --import tsx scripts/graphics-head-assembly-audit.mts [--project ABSOLUTE_PROJECT] [--task TASK_ID] [--output REPOSITORY_ARTIFACT_JSON]');
  process.exit(0);
}
const options = { ...defaults };
for (let i = 0; i < supplied.length; i += 2) {
  const key = supplied[i]?.replace(/^--/, '') as keyof typeof defaults;
  if (!(key in defaults) || !supplied[i + 1]) throw Error('Expected --project, --task or --output followed by a value.');
  options[key] = supplied[i + 1];
}
if (!/^[a-zA-Z0-9_-]+$/.test(options.task)) throw Error('Invalid task identity.');
const project = fs.realpathSync(options.project);
function contained(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function projectFile(file: string) {
  const absolute = path.resolve(project, file);
  if (!contained(project, absolute) || !contained(project, fs.realpathSync(absolute))) throw Error('Audit input leaves the exact project folder: ' + file);
  if (!fs.statSync(absolute).isFile()) throw Error('Audit input is not a regular file: ' + file);
  return absolute;
}
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = (file: string) => JSON.parse(fs.readFileSync(projectFile(file), 'utf8').replace(/^\uFEFF/, ''));
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const job = path.join(project, 'graphics/jobs', options.task, 'astra');
const checkpointFile = path.join(job, 'checkpoint.json');
if (!fs.existsSync(checkpointFile)) throw Error('Completed checkpoint is absent. Audit stopped without polling or recovery.');
const prepared = read(path.join(job, 'prepared.json'));
const baseline = read(prepared.baseline);
const checkpoint = read(checkpointFile);
const main = checkpoint.result?.candidates?.find((candidate: any) => candidate.role === 'model' && candidate.slot === 'main');
const reports = main?.files?.filter((file: any) => file.kind === 'report') ?? [];
if (reports.length !== 1) throw Error('Expected the exact combined-main validation report, not a standalone part report.');
const reportFile = projectFile(reports[0].path);
const report = read(reportFile);
const request = read(path.join(job, 'validate-request.json'));
if (report.operation !== 'M08' || request.operation !== 'M08' || !baseline.assemblyContract || !baseline.assemblyParts || !report.assemblyLayout)
  throw Error('Completed assembly evidence is missing; audit did not execute any production or recovery.');

const checks: Record<string, boolean> = {};
const evidence: Record<string, unknown> = {};
checks.completedNativeValidation = report.passed === true;
checks.frozenIdentity = prepared.identity === baseline.identity && prepared.identity === checkpoint.identity && prepared.identity === report.identity && prepared.identity === request.identity;
checks.reportRequestBinding = report.nonce === request.nonce && report.validatorFingerprint === request.validatorFingerprint && report.validatorFingerprint === checkpoint.validatorFingerprint;
checks.baselineHash = sha(projectFile(prepared.baseline)) === prepared.baselineSha256;
checks.preparedBlendHash = sha(projectFile(prepared.preparedBlend)) === prepared.preparedSha256;
checks.authoredBlendHash = sha(projectFile(request.outputBlend)) === report.outputSha256;
checks.authoritativeParts = equal([...baseline.assemblyParts.map((part: any) => part.id)].sort(), ['body', 'hair', 'head'])
  && equal([...report.assemblyLayout.parts.map((part: any) => part.id)].sort(), ['body', 'hair', 'head']);
checks.nativeContract = ['meshLineage', 'topology', 'materials', 'skeleton', 'actionsPreserved', 'assemblyPartIdentity', 'assemblyShapePreserved']
  .every(key => report.checks?.[key] === true);

const hashEvidence: any[] = [];
function verify(file: string, expected: string, bytes: number | undefined, category: string) {
  const absolute = projectFile(file), stat = fs.statSync(absolute), actual = sha(absolute);
  const passed = actual === expected && (bytes === undefined || stat.size === bytes);
  hashEvidence.push({ category, path: path.relative(project, absolute).split(path.sep).join('/'), expectedSha256: expected, actualSha256: actual, bytes: stat.size, passed });
  return passed;
}
checks.originalAndFrozenCopyHashes = true;
for (const copy of prepared.copies ?? []) {
  checks.originalAndFrozenCopyHashes = verify(copy.sourcePath, copy.sha256, copy.bytes, 'original') && checks.originalAndFrozenCopyHashes;
  checks.originalAndFrozenCopyHashes = verify(copy.localPath, copy.sha256, copy.bytes, 'frozen-input-copy') && checks.originalAndFrozenCopyHashes;
}
checks.assemblySourceHashes = true;
for (const source of prepared.assemblySources ?? []) {
  checks.assemblySourceHashes = verify(source.sourcePath, source.sourceSha256, undefined, 'original-part') && checks.assemblySourceHashes;
  checks.assemblySourceHashes = verify(source.path, source.sha256, source.bytes, 'prepared-part-blend') && checks.assemblySourceHashes;
  checks.assemblySourceHashes = verify(source.report, source.reportSha256, source.reportBytes, 'prepared-part-report') && checks.assemblySourceHashes;
}
checks.registeredDerivativeHashes = true;
for (const file of checkpoint.files ?? []) checks.registeredDerivativeHashes = verify(file.path, file.sha256, file.bytes, 'registered-derivative') && checks.registeredDerivativeHashes;
evidence.hashes = hashEvidence;

const expectedIds = baseline.meshes.map((mesh: any) => mesh.id).sort();
checks.originalMeshIds = equal(expectedIds, report.meshes.map((mesh: any) => mesh.id).sort());
checks.originalMaterialsAndTextures = equal(baseline.materials, report.materials) && equal(baseline.textures, report.textures);
checks.originalActionsAndSkeleton = equal(baseline.actions, report.actions) && equal(baseline.rigs, report.rigs);
const geometry = baseline.meshes.map((source: any) => {
  const result = report.meshes.find((mesh: any) => mesh.id === source.id);
  const fields = ['partId', 'vertices', 'faces', 'topology', 'positions', 'uv', 'materials', 'faceMaterials', 'weights', 'modifiers', 'shapeKeys'];
  return { id: source.id, partId: source.partId, checks: Object.fromEntries(fields.map(field => [field, result !== undefined && equal(source[field], result[field])])) };
});
checks.originalGeometryUVAndAssignments = geometry.every((mesh: any) => Object.values(mesh.checks).every(Boolean));
evidence.geometry = geometry;

function matrixDifference(left: number[][], right: number[][]) {
  return Math.max(...left.flatMap((row, i) => row.map((value, j) => Math.abs(value - right[i][j]))));
}
function validMatrix(matrix: unknown): matrix is number[][] {
  return Array.isArray(matrix) && matrix.length === 4 && matrix.every(row => Array.isArray(row) && row.length === 4 && row.every(value => typeof value === 'number' && Number.isFinite(value)));
}
const placements: any[] = [];
for (const part of baseline.assemblyParts) {
  const sourceInfo = prepared.assemblySources.find((source: any) => source.versionId === part.sourceVersionId && source.slot === part.slot);
  if (!sourceInfo) throw Error('A frozen original part source is missing: ' + part.id);
  const originalReport = read(sourceInfo.report);
  const outputPart = report.assemblyLayout.parts.find((item: any) => item.id === part.id);
  for (const id of part.meshIds) {
    const original = originalReport.meshes.find((mesh: any) => mesh.id === id);
    const frozen = baseline.assemblyContract.meshes[id];
    const result = outputPart?.meshes.find((mesh: any) => mesh.id === id);
    if (!original || !frozen || !result || !validMatrix(frozen.transform) || !validMatrix(result.sourceTransform) || !validMatrix(result.outputTransform))
      throw Error('Exact part matrix evidence is missing: ' + id);
    const maxPreparationDeviation = matrixDifference(original.transform, frozen.transform);
    placements.push({ partId: part.id, meshId: id, sourceVersionId: part.sourceVersionId,
      originalPreparedMatrixRounded7: original.transform, baselineMatrixExact: frozen.transform, outputMatrixExact: result.outputTransform,
      inputPreparationWithinStoredPrecision: maxPreparationDeviation <= 5.1e-8, maxPreparationDeviation,
      baselineMatchesOutputReceipt: equal(frozen.transform, result.sourceTransform),
      maxOutputMatrixDeviation: matrixDifference(frozen.transform, result.outputTransform),
      matrixExactlyUnchanged: equal(frozen.transform, result.outputTransform),
      exactLocalShapeHashUnchanged: frozen.shapeSha256 === result.shapeSha256,
      originalWorldBounds: frozen.worldBounds, outputWorldBounds: result.worldBounds });
  }
}
checks.originalPreparationPlacement = placements.every(item => item.inputPreparationWithinStoredPrecision && item.baselineMatchesOutputReceipt);
checks.allExactLocalShapes = placements.every(item => item.exactLocalShapeHashUnchanged);
checks.bodyPlacementFixed = placements.some(item => item.partId === 'body') && placements.filter(item => item.partId === 'body').every(item => item.matrixExactlyUnchanged && equal(item.originalWorldBounds, item.outputWorldBounds));
checks.hairPlacementFixed = placements.some(item => item.partId === 'hair') && placements.filter(item => item.partId === 'hair').every(item => item.matrixExactlyUnchanged && equal(item.originalWorldBounds, item.outputWorldBounds));
evidence.placements = placements;
evidence.headObjectMatrixChanged = placements.some(item => item.partId === 'head' && !item.matrixExactlyUnchanged);
evidence.nativePartExports = report.assemblyLayout.partExports;

const output = path.resolve(options.output), artifacts = path.join(repository, 'artifacts');
if (!contained(artifacts, output) || path.extname(output) !== '.json') throw Error('Audit output must be a separate JSON inside repository artifacts.');
fs.mkdirSync(path.dirname(output), { recursive: true });
if (!contained(fs.realpathSync(artifacts), fs.realpathSync(path.dirname(output)))) throw Error('Audit output folder leaves repository artifacts.');
const result = { schemaVersion: 1, auditedAt: new Date().toISOString(), taskId: options.task, project,
  passed: Object.values(checks).every(Boolean), checks, evidence,
  reportPath: path.relative(project, reportFile).split(path.sep).join('/'), reportSha256: sha(reportFile),
  scope: 'Independent comparison of frozen source and completed host-native validation evidence, with current original and derivative file hashes.',
  limitations: ['Native geometry is not parsed again by this script; exact shape and placement measurements come from the hash-bound Blender validation report.',
    'The source preparation report stores matrices rounded to seven decimal places; body/hair baseline-to-result checks use exact stored native matrices.',
    'An unchanged local shape with a changed head object matrix is reported; TRS decomposition, constraints, visual fit, neck joins, intersections and anatomy are not independently inspected.'],
  projectFilesWritten: 0, serviceCalls: 0, workerCalls: 0, recoveryAttempts: 0, polling: false };
fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ passed: result.passed, output, checks }, null, 2));
if (!result.passed) process.exitCode = 1;
