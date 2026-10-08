'use strict';

// Explicit developer integration check. Uses baseline values to verify the selected
// gameplay route; production candidate generation continues to require Codex.
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { ProjectClient } = require('../src/project-client.cjs');

async function main() {
  const [project, output, ...cases] = process.argv.slice(2);
  if (!project || !output || !cases.length) throw new Error('Usage: node scripts/action-smoke.cjs <Unity project> <output.json> <Form:action> ...');
  const client = new ProjectClient(project);
  const initial = client.getStatus();
  if (!initial.connected || initial.running || initial.isPlaying || initial.isCompiling) throw new Error('Unity must be connected and idle in Edit Mode.');
  const catalog = await client.describe();
  const results = [];
  const write = () => fs.writeFileSync(output, JSON.stringify({ catalog, results }, null, 2));
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  write();
  for (const testCase of cases) {
    const [form, actionId] = testCase.split(':');
    const adapter = catalog.adapters.find(item => item.id === 'four-tiger-sword.water');
    const source = adapter?.sources.find(item => item.label.toLowerCase().includes(form.toLowerCase()));
    const action = source?.actions?.find(item => item.id === actionId);
    if (!action || action.available === false || !action.defaultRequest) throw new Error(`Unavailable ${testCase}: ${action?.unavailableReason || 'missing catalog entry'}`);
    const request = { ...action.defaultRequest, durationSeconds: 7, recordVideo: false, generation: null,
      candidates: [{ id: 'route-check', label: `연결 검증 · ${testCase}`, rationale: '',
        values: action.parameters.map(spec => ({ id: spec.id, value: spec.baseline })) }] };
    const started = await client.command('start', request, { timeoutMs: 20000 });
    const runId = path.basename(started.directory);
    process.stdout.write(`Started ${testCase}: ${runId}\n`);
    const deadline = Date.now() + 150000;
    let report;
    while (Date.now() < deadline) {
      await delay(1000);
      const status = client.getStatus();
      if (!status.connected || status.running || status.isPlaying || status.isCompiling) continue;
      try { report = client.loadReport(runId).report; } catch { continue; }
      if (report.results?.length === 1 && ['completed', 'no-hits', 'failed', 'cancelled'].includes(report.results[0].status)) break;
      report = null;
    }
    if (!report) throw new Error(`Timed out ${testCase}: ${runId}. Inspect Unity before retrying; no automatic re-run.`);
    const row = report.results[0];
    const summary = { testCase, runId, actionId: report.actionId, status: row.status, error: row.error,
      hits: row.metrics?.hits, damage: row.metrics?.damageDealt,
      events: row.metrics?.events, notes: row.metrics?.notes, appliedValues: row.metrics?.appliedValues };
    results.push(summary); write();
    process.stdout.write(`Finished ${testCase}: ${row.status}, ${summary.hits} damage events\n`);
    if (row.status === 'failed' || row.status === 'cancelled') throw new Error(`${testCase}: ${row.error || row.status}`);
    if (!row.metrics?.events?.some(event => event.kind === 'action-executed')) throw new Error(`${testCase}: selected action execution was not observed.`);
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
