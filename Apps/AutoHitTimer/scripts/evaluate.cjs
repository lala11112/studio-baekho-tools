'use strict';
// Compare independently reviewed human windows with unedited AI output.
// Count mismatches have no boundary score: pairing unrelated strikes would hide errors.
const fs = require('node:fs');
function key(clip) { return clip.guid + ':' + String(clip.localId); }
function windows(value) {
  if (!Array.isArray(value) || value.some(w => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end <= w.start))
    throw new Error('Each window needs finite start/end seconds with 0 <= start < end.');
  return [...value].sort((a, b) => a.start - b.start);
}
function evaluate(reference, predictions) {
  if (!reference?.clips?.length || !Array.isArray(predictions?.clips)) throw new Error('Both inputs need a clips array; reference must not be empty.');
  const predicted = new Map();
  for (const clip of predictions.clips) {
    if (predicted.has(key(clip))) throw new Error('Duplicate predicted clip ID.');
    predicted.set(key(clip), clip);
  }
  const seen = new Set(), errors = [], rows = [];
  for (const clip of reference.clips) {
    const id = key(clip);
    if (!/^[a-f0-9]{32}$/i.test(clip.guid || '') || !/^-?\d+$/.test(String(clip.localId)) || seen.has(id) || !String(clip.reviewer || '').trim())
      throw new Error('Human references need a unique GUID/localId and reviewer.');
    seen.add(id);
    const expected = windows(clip.windows), actual = predicted.get(id);
    if (!actual) { rows.push({ id, status: 'missing', expectedHits: expected.length }); continue; }
    if (actual.source !== 'real-ai-unedited') throw new Error('Predictions must be marked source: real-ai-unedited. Mock or human-edited results are not AI accuracy evidence.');
    const found = windows(actual.windows), countMatch = expected.length === found.length;
    const boundaryErrorsMs = countMatch ? expected.map((w, i) => ({ start: Math.abs(w.start - found[i].start) * 1000, end: Math.abs(w.end - found[i].end) * 1000 })) : [];
    errors.push(...boundaryErrorsMs.flatMap(w => [w.start, w.end]));
    rows.push({ id, status: 'compared', expectedHits: expected.length, predictedHits: found.length, countMatch, boundaryErrorsMs });
  }
  const compared = rows.filter(row => row.status === 'compared');
  return { humanReferences: rows.length, compared: compared.length, missing: rows.length - compared.length,
    hitCountMatchRate: compared.length ? compared.filter(row => row.countMatch).length / compared.length : null,
    boundaryMeanAbsoluteErrorMs: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
    boundaryMaxAbsoluteErrorMs: errors.length ? Math.max(...errors) : null,
    boundaryScoreScope: 'Only clips with matching hit count, paired chronologically. Missing clips are excluded from match rate and reported separately.', rows };
}
if (require.main === module) {
  try {
    const [reference, predictions, output] = process.argv.slice(2);
    if (!reference || !predictions || !output) throw new Error('Usage: node scripts/evaluate.cjs human.json real-ai.json report.json');
    const result = evaluate(JSON.parse(fs.readFileSync(reference, 'utf8')), JSON.parse(fs.readFileSync(predictions, 'utf8')));
    fs.writeFileSync(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { evaluate };
