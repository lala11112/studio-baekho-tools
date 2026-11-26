import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { benchmarkSettings, inspectBenchmarkMap, isBenchmarkBlocker, parseBenchmarkOptions, summarizeBenchmark, withBenchmarkTimeout, type BenchmarkResult } from '../scripts/benchmark-generation';
import { createDemoMap } from '../src/shared/map';

const result = (changes: Partial<BenchmarkResult> = {}): BenchmarkResult => ({ case: 'flat', repetition: 1, seed: 10, method: 'image',
  status: 'passed', attempted: true, conceptMs: 100, elapsedMs: 1000, totalMs: 1100, validationMs: 5, stages: {}, telemetry: [], issues: [], ...changes });

test('benchmark defaults compare eighteen maps with inherited model and a twenty-minute request deadline', () => {
  const options = parseBenchmarkOptions([], process.cwd());
  assert.equal(options.repetitions, 3); assert.deepEqual(options.cases, ['flat', 'elevated', 'large']);
  assert.deepEqual(options.methods, ['image', 'direct']); assert.equal(options.model, ''); assert.equal(options.timeoutMs, 1_200_000);
  assert.equal(options.repetitions * options.cases.length * options.methods.length, 18);
  assert.ok(options.output.startsWith(path.resolve('.local') + path.sep));
  const custom = parseBenchmarkOptions(['--cases=large', '--methods', 'direct', '--repetitions=1', '--timeout-ms', '5000', '--model=chosen-model']);
  assert.equal(custom.model, 'chosen-model'); assert.deepEqual(custom.methods, ['direct']); assert.equal(custom.timeoutMs, 5000);
});

test('benchmark rejects unknown, duplicate, unsafe output and invalid numeric options before any AI call', () => {
  for (const args of [['--cases=unknown'], ['--cases=flat,flat'], ['--methods=sample'], ['--methods=image,image'], ['--repetitions=0'],
    ['--repetitions=1.5'], ['--timeout-ms=NaN'], ['--timeout-ms=999'], ['--model=bad model'], ['--output=.local'],
    ['--output=../outside'], ['--output=.local/../tracked'], ['--effort=low'], ['--cases'], ['--cases=flat', '--cases=large']])
    assert.throws(() => parseBenchmarkOptions(args), args.join(' '));
});

test('paired settings stay identical and reproducible while repetitions use distinct seeds', () => {
  for (const id of ['flat', 'elevated', 'large']) {
    const first = benchmarkSettings(id, 0), second = benchmarkSettings(id, 1);
    assert.deepEqual(first, benchmarkSettings(id, 0)); assert.notEqual(first.seed, second.seed);
    assert.equal(first.codexModel, ''); assert.equal(first.designer?.propLayout, 'balanced');
    assert.equal(first.designer?.propCoverage, 12); assert.equal(first.designer?.ceilings, true);
    assert.equal(first.sizeResolved, true); assert.equal(first.sizeMode, 'custom');
    assert.equal(first.designer?.elevation, id === 'elevated');
    assert.equal(benchmarkSettings(id, 0, 'selected').codexModel, 'selected');
  }
  assert.equal(benchmarkSettings('large', 0).width, 40); assert.equal(benchmarkSettings('large', 0).height, 40);
});

test('benchmark reports successful timing medians/maxima without hiding fast failures or concept failures', () => {
  const summary = summarizeBenchmark([
    result({ elapsedMs: 1000, totalMs: 1100 }), result({ elapsedMs: 3000, totalMs: 3100 }),
    result({ status: 'failed', elapsedMs: 5, totalMs: 105, failureStage: 'extract' }),
    result({ status: 'failed', attempted: false, elapsedMs: 0, totalMs: 100, failureStage: 'concept' }),
    result({ method: 'direct', elapsedMs: 500, totalMs: 600 }),
  ]);
  assert.deepEqual(summary.methods.image.successfulElapsedMs, { median: 2000, max: 3000 });
  assert.deepEqual(summary.methods.image.successfulTotalMs, { median: 2100, max: 3100 });
  assert.equal(summary.methods.image.successRate, .5); assert.equal(summary.methods.image.attempted, 3);
  assert.equal(summary.methods.image.failed, 2); assert.equal(summary.methods.direct.successRate, 1);
  assert.equal(summary.cases.flat.image.planned, 4); assert.equal(summary.overall.planned, 5);
  const failed = summarizeBenchmark([result({ status: 'failed' })]);
  assert.deepEqual(failed.methods.image.successfulElapsedMs, { median: null, max: null });
  assert.equal(failed.methods.direct.successRate, 0); assert.equal(failed.methods.direct.planned, 0);
});

test('benchmark deadline cancels once and never substitutes a map or automatically retries', async () => {
  let calls = 0, cancellations = 0;
  await assert.rejects(withBenchmarkTimeout(() => { calls++; return new Promise<never>(() => {}); }, 5, () => { cancellations++; }, 10), /cancelled without retry/);
  assert.equal(calls, 1); assert.equal(cancellations, 1);
  assert.equal(await withBenchmarkTimeout(async () => 'real-result', 1000, () => { cancellations++; }), 'real-result');
  assert.equal(cancellations, 1);
  await assert.rejects(withBenchmarkTimeout(async () => { throw new Error('AI unavailable'); }, 1000, () => { cancellations++; }), /AI unavailable/);
  assert.equal(cancellations, 1);
});

test('timeout waits for delayed service cleanup before the next map can start, and stalls block the batch', async () => {
  let active = false, rejectOperation: (error: Error) => void = () => {}, cleaned = false;
  const operation = () => new Promise<never>((_, reject) => { active = true; rejectOperation = reject; });
  await assert.rejects(withBenchmarkTimeout(operation, 5, () => {
    setTimeout(() => { active = false; cleaned = true; rejectOperation(new Error('cancelled after cleanup')); }, 20);
  }, 100), /exceeded/);
  assert.equal(active, false); assert.equal(cleaned, true);
  let stuck: unknown;
  try { await withBenchmarkTimeout(() => new Promise<never>(() => {}), 5, () => {}, 10); } catch (error) { stuck = error; }
  assert.equal(isBenchmarkBlocker(stuck), true, 'incomplete shutdown prevents starting another request');
});

test('stage summaries keep service wall times separate and combine repeated internal validation stages per map', () => {
  const telemetry = [
    { id: 'first', jobId: 'job', method: 'direct' as const, stage: 'validation' as const, state: 'completed' as const, elapsedMs: 3 },
    { id: 'second', jobId: 'job', method: 'direct' as const, stage: 'validation' as const, state: 'completed' as const, elapsedMs: 7 },
  ];
  const summary = summarizeBenchmark([result({ method: 'direct', stages: { layout: 500 }, telemetry })]);
  assert.deepEqual(summary.methods.direct.successfulServiceStageMs.layout, { median: 500, max: 500 });
  assert.deepEqual(summary.methods.direct.successfulInternalStageMs.validation, { median: 10, max: 10 });
});

test('auth, model, capability and usage blockers stop the benchmark without changing models or making more calls', () => {
  for (const message of ['Codex 이미지 생성 사용량 한도에 도달했습니다.', 'rate_limit_exceeded', 'usageLimitExceeded', 'Codex의 ChatGPT 로그인이 필요합니다.',
    '선택한 모델을 현재 Codex 계정에서 사용할 수 없습니다.', '현재 Codex 연결에서 이미지 생성을 지원하지 않습니다.'])
    assert.equal(isBenchmarkBlocker(new Error(message)), true, message);
  assert.equal(isBenchmarkBlocker(new Error('Codex 배치도가 검증을 통과하지 못했습니다.')), false);
});

test('independent benchmark audit rejects a generated map that changes the requested dimensions', () => {
  const map = createDemoMap(), settings = benchmarkSettings('flat', 0);
  settings.width = map.width + 2; settings.height = map.height; settings.cellSize = map.cellSize;
  const issues = inspectBenchmarkMap(map, settings, []);
  assert.ok(issues.some(issue => issue.code === 'benchmark-dimensions' && issue.severity === 'error'));
});
