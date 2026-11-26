/** Compare saved, accepted terrain only. No AI calls; props and ornaments never count as variety. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareGeometry } from '../src/shared/geometry-similarity';
import { analyzeLevelDesign } from '../src/shared/level-design';
import { parseProjectFile, validateMap } from '../src/shared/map';
import type { Cell, GridMap, ProjectFile } from '../src/shared/types';

const key = (c: Cell) => `${c.x},${c.row}`;
const adjacent = (c: Cell): Cell[] => [{ x: c.x - 1, row: c.row }, { x: c.x + 1, row: c.row }, { x: c.x, row: c.row - 1 }, { x: c.x, row: c.row + 1 }];
const round = (n: number) => Number(n.toFixed(3));

export interface SpaceProportions { usableFraction: number; clearanceQuantiles: number[]; pocketShares: number[] }

/** Orientation-invariant measures of broad/narrow floor and relative usable pockets. */
export function spaceProportions(map: GridMap): SpaceProportions {
  let minX = map.width, minRow = map.height, maxX = -1, maxRow = -1;
  const floor: Cell[] = [];
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
    const t = map.rows[row][x];
    if (t !== '_') { minX = Math.min(minX, x); minRow = Math.min(minRow, row); maxX = Math.max(maxX, x); maxRow = Math.max(maxRow, row); }
    if ('.PDRB'.includes(t)) floor.push({ x, row });
  }
  const width = Math.max(1, maxX - minX + 1), height = Math.max(1, maxRow - minRow + 1), span = Math.min(width, height);
  const allowed = new Set(floor.map(key)), distances = new Map<string, number>();
  const queue = floor.filter(c => adjacent(c).some(n => !allowed.has(key(n))));
  queue.forEach(c => distances.set(key(c), 1));
  for (let i = 0; i < queue.length; i++) for (const next of adjacent(queue[i])) if (allowed.has(key(next)) && !distances.has(key(next))) {
    distances.set(key(next), distances.get(key(queue[i]))! + 1); queue.push(next);
  }
  const sorted = [...distances.values()].sort((a, b) => a - b);
  const clearanceQuantiles = [.25, .5, .75, .9].map(q => round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0) / span));
  // Erode only relative to this room's width. Distinct broad pockets survive narrow transitions.
  const core = new Map(floor.filter(c => (distances.get(key(c)) ?? 0) >= Math.max(2, Math.round(span * .12))).map(c => [key(c), c]));
  const coreCount = core.size, pockets: number[] = [];
  while (core.size) {
    const first = core.values().next().value!, group = [first]; core.delete(key(first));
    for (let i = 0; i < group.length; i++) for (const next of adjacent(group[i])) if (core.delete(key(next))) group.push(next);
    pockets.push(group.length);
  }
  return { usableFraction: round(floor.length / (width * height)), clearanceQuantiles, pocketShares: pockets.sort((a, b) => b - a).map(n => round(n / Math.max(1, coreCount))) };
}

export interface QualityCandidate { index: number; project: ProjectFile }
export interface StructuralPair {
  first: number; second: number; footprintSimilarity: number; differingAttributes: string[];
  proportionDifferences: { usableFraction: number; clearance: number; pocketShares: number };
}

export function structuralPairs(candidates: QualityCandidate[]): StructuralPair[] {
  const proportions = candidates.map(c => spaceProportions(c.project.map)), result: StructuralPair[] = [];
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const comparison = compareGeometry(candidates[i].project.map, candidates[j].project.map), a = proportions[i], b = proportions[j];
    const usableFraction = Math.abs(a.usableFraction - b.usableFraction);
    const clearance = Math.max(...a.clearanceQuantiles.map((n, k) => Math.abs(n - b.clearanceQuantiles[k])));
    const pocketShares = Array.from({ length: Math.max(a.pocketShares.length, b.pocketShares.length) }, (_, k) => Math.abs((a.pocketShares[k] ?? 0) - (b.pocketShares[k] ?? 0))).reduce((sum, n) => sum + n, 0);
    const differingAttributes = [
      ...(comparison.silhouetteSimilarity < .9 ? ['윤곽'] : []),
      ...(usableFraction > .08 || clearance > .04 || pocketShares > .3 ? ['공간 비율'] : []),
      ...(!comparison.matchingRelationships.includes('높이') || !comparison.matchingRelationships.includes('계단 접근') ? ['높이·계단 접근'] : []),
      ...(!comparison.matchingRelationships.includes('문 배치') || !comparison.matchingRelationships.includes('동선 관계') ? ['문·동선 관계'] : []),
    ];
    result.push({ first: candidates[i].index, second: candidates[j].index, footprintSimilarity: round(comparison.silhouetteSimilarity), differingAttributes,
      proportionDifferences: { usableFraction: round(usableFraction), clearance: round(clearance), pocketShares: round(pocketShares) } });
  }
  return result;
}

/** Strong interpretation: every pair in the selected subset differs in at least two attributes. */
export function largestDistinctSubset(candidates: QualityCandidate[], pairs = structuralPairs(candidates)): number[] {
  if (candidates.length > 8) throw new Error('품질 비교는 최대 8개 후보를 지원합니다.');
  const edges = new Set(pairs.filter(p => p.differingAttributes.length >= 2).map(p => `${Math.min(p.first, p.second)}:${Math.max(p.first, p.second)}`));
  let best: number[] = [];
  for (let mask = 1; mask < 1 << candidates.length; mask++) {
    const selected = candidates.filter((_, i) => mask & 1 << i).map(c => c.index);
    if (selected.length <= best.length) continue;
    if (selected.every((a, i) => selected.slice(i + 1).every(b => edges.has(`${Math.min(a, b)}:${Math.max(a, b)}`)))) best = selected;
  }
  return best;
}

async function main(): Promise<void> {
  const argument = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const directory = path.resolve(argument('input') ?? '.local/spatial-ai/implemented');
  const reportPath = path.resolve(argument('report') ?? path.join(directory, 'structural-quality.json'));
  const expected = Number(argument('expected') ?? 6), required = Number(argument('required') ?? 4);
  if (!Number.isInteger(expected) || expected < 2 || expected > 8 || !Number.isInteger(required) || required < 2 || required > expected) throw new Error('expected는 2~8, required는 2~expected여야 합니다.');
  const names = (await readdir(directory)).filter(n => /^candidate-\d+\.baekho\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const candidates = await Promise.all(names.map(async name => ({ index: Number(name.match(/\d+/)![0]), project: parseProjectFile(JSON.parse(await readFile(path.join(directory, name), 'utf8'))) })));
  let results: { index: number; status: string; error?: string }[] = [];
  try { results = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8')); } catch { /* An in-progress run has no final results yet. */ }
  const completed = results.length === expected && results.every(r => ['ready', 'error', 'cancelled'].includes(r.status)) || candidates.length === expected;
  const pairs = structuralPairs(candidates), distinctSubset = largestDistinctSubset(candidates, pairs);
  const safety = candidates.map(c => ({ index: c.index, errors: [...validateMap(c.project.map, c.project.bindings), ...(c.project.settings.levelDesign ? analyzeLevelDesign(c.project.map, c.project.settings).issues : [])].filter(issue => issue.severity === 'error').map(i => i.message) }));
  const report = { completed, acceptedCandidates: candidates.length, expectedCandidates: expected, requiredDistinct: required, distinctSubset, pairwiseMinimumDifferentAttributes: 2,
    meetsCriterion: completed && distinctSubset.length >= required && safety.every(s => !s.errors.length),
    methodology: 'Compare cropped silhouettes under rotation/reflection, relative usable-floor/clearance/pocket proportions, height and stair approaches, and door/height-correct route relationships. P props, fixtures, names, lights and markers are excluded. Every pair in distinctSubset must differ in at least two of these four structural attributes. This is structural variety evidence, not a fun score.',
    thresholds: { footprintSimilarity: .9, usableFractionDifference: .08, normalizedClearanceDifference: .04, pocketShareL1Difference: .3 },
    candidates: candidates.map((c, i) => ({ index: c.index, spaceProportions: spaceProportions(c.project.map), safetyErrors: safety[i].errors })), pairs, generationFailures: results.filter(r => r.status !== 'ready') };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.meetsCriterion) process.exitCode = completed ? 1 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
