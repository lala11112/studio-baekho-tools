// Read-only production preservation evidence for the guided UI upgrade.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import initSqlJs from 'sql.js';

const profile = path.join(process.env.APPDATA, 'partsmith');
const evidence = path.resolve('artifacts/runtime/graphics-guided-production.json');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
const db = new SQL.Database(fs.readFileSync(path.join(profile, 'workbench.db')));
const query = db.prepare("SELECT kind,id,json FROM records WHERE kind IN ('graphics','project','workbench','production') ORDER BY kind,id");
const records = [];
while (query.step()) { const row = query.getAsObject(); records.push({ kind: row.kind, id: row.id, data: JSON.parse(row.json) }); }
query.free(); db.close();
for (const record of records) {
  if (record.kind === 'graphics') assert(!record.data.tasks.some(task => task.status === 'running'), 'Graphics production is active');
  if (record.kind === 'project') assert(!record.data.jobs.some(task => ['queued','running','submitting','processing','downloading'].includes(task.status)), 'Backend production is active');
  if (record.kind === 'workbench') assert(!record.data.activeJobId && !record.data.jobs.some(task => task.status === 'running'), 'Workbench production is active');
  if (record.kind === 'production') assert(record.data.status !== 'running', 'Production is active');
}
const spaces = records.filter(record => record.kind === 'graphics').map(record => record.data);
const files = [...new Map(spaces.flatMap(space => space.versions.flatMap(version => version.files.map(file => {
  const absolute = path.join(profile, 'projects', space.projectId, file.path);
  assert.equal(sha(absolute), file.sha256, `Registered file changed: ${absolute}`);
  return [absolute, { path: absolute, sha256: file.sha256 }];
})))).values()];
const projectFiles = records.filter(record => record.kind === 'project').map(record => {
  const absolute = path.join(profile, 'projects', record.id, 'project.json');
  return { path: absolute, sha256: sha(absolute) };
});
if (process.argv[2] === 'snapshot') {
  assert(!fs.existsSync(evidence), 'Never replace the production baseline');
  fs.writeFileSync(evidence, JSON.stringify({ before: { records, files, projectFiles }, startedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ idle: true, workspaces: spaces.length, protectedFiles: files.length, projectFiles: projectFiles.length }));
} else {
  const report = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  assert.deepEqual(records, report.before.records, 'Production records changed');
  for (const file of [...report.before.files, ...report.before.projectFiles]) assert.equal(sha(file.path), file.sha256);
  report.verification = { at: new Date().toISOString(), workspaces: spaces.length, protectedFiles: files.length, projectFiles: projectFiles.length, recordsUnchanged: true, noNewTasksOrSubmissions: true };
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.verification));
}
