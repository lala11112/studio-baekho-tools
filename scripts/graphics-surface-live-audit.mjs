// Read-only production audit. Actual recovery is initiated with the visible app button.
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import { createHash } from 'node:crypto'; import initSqlJs from 'sql.js';
const profile = path.join(process.env.APPDATA, 'partsmith');
const targetProject = 'caae83af-1e58-4340-b419-3d155c01030b';
const targetVersion = '89d3d3db-e2db-463b-89f1-eb6afcb2bbef';
const evidence = path.resolve('artifacts/runtime/graphics-surface-live.json');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
const db = new SQL.Database(fs.readFileSync(path.join(profile, 'workbench.db')));
const query = db.prepare("SELECT kind,id,json FROM records WHERE kind IN ('graphics','project','workbench','production') ORDER BY kind,id");
const records = []; while (query.step()) { const row = query.getAsObject(); records.push({ kind: row.kind, id: row.id, data: JSON.parse(row.json) }); }
query.free(); db.close();
const spaces = records.filter(record => record.kind === 'graphics').map(record => record.data);
for (const record of records) {
  if (record.kind === 'graphics') assert(!record.data.tasks.some(task => task.status === 'running'), 'Graphics active');
  if (record.kind === 'project') assert(!record.data.jobs.some(task => ['queued','running','submitting','processing','downloading'].includes(task.status)), 'Backend active');
  if (record.kind === 'workbench') assert(!record.data.activeJobId && !record.data.jobs.some(task => task.status === 'running'), 'Workbench active');
  if (record.kind === 'production') assert(record.data.status !== 'running', 'Production active');
}
const files = [...new Map(spaces.flatMap(space => space.versions.flatMap(version => version.files.map(file => {
  const absolute = path.join(profile, 'projects', space.projectId, file.path); assert.equal(sha(absolute), file.sha256);
  return [absolute, { path: absolute, sha256: file.sha256 }];
})))).values()];
const projectFiles = records.filter(record => record.kind === 'project').map(record => { const file = path.join(profile, 'projects', record.id, 'project.json'); return { path: file, sha256: sha(file) }; });
const mode = process.argv[2] ?? 'verify';
if (mode === 'snapshot') {
  assert(!fs.existsSync(evidence), 'Do not overwrite audit baseline');
  fs.writeFileSync(evidence, JSON.stringify({ before: { records, files, projectFiles }, startedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ idle: true, workspaces: spaces.length, protectedFiles: files.length }));
} else {
  const report = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  for (const file of [...report.before.files, ...report.before.projectFiles]) assert.equal(sha(file.path), file.sha256);
  if (mode === 'unchanged') {
    assert.deepEqual(records, report.before.records);
    console.log(JSON.stringify({ unchanged: true, protectedFiles: report.before.files.length }));
  } else if (mode === 'restart') {
    assert.deepEqual(records, report.after.records); report.restart = { verifiedAt: new Date().toISOString(), noAutorun: true, exactRecords: true };
    fs.writeFileSync(evidence, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.restart));
  } else {
    for (const old of report.before.records) {
      const current = records.find(record => record.kind === old.kind && record.id === old.id); assert(current);
      if (old.kind !== 'graphics' || old.id !== targetProject) { assert.deepEqual(current, old); continue; }
      const before = old.data, after = current.data;
      assert.deepEqual(after.objects, before.objects); assert.deepEqual(after.deliveries, before.deliveries);
      assert.deepEqual(after.tripoBudget, before.tripoBudget); assert.equal(after.tasks.length, before.tasks.length);
      for (const version of before.versions) assert.deepEqual(after.versions.find(item => item.id === version.id), version);
      const added = after.versions.filter(version => !before.versions.some(item => item.id === version.id));
      assert.equal(added.length, 1); const derivative = added[0]; assert.equal(derivative.surfaceRepair?.providerVersionId, targetVersion);
      assert.equal(derivative.provenance.type, 'local'); assert(!after.objects.some(object => Object.values(object.accepted).includes(derivative.id)));
      const originalTask = before.tasks.find(task => task.taskId === 'T03' && task.outputVersionIds.includes(targetVersion)); assert(originalTask);
      for (const task of before.tasks) {
        const actual = after.tasks.find(item => item.id === task.id);
        if (task.id !== originalTask.id) { assert.deepEqual(actual, task); continue; }
        const { outputVersionIds, message, updatedAt, ...frozen } = actual;
        const { outputVersionIds: oldOutputs, message: oldMessage, updatedAt: oldTime, ...oldFrozen } = task;
        assert.deepEqual(frozen, oldFrozen); assert.deepEqual(outputVersionIds, [...oldOutputs, derivative.id]);
      }
      const nativeReport = JSON.parse(fs.readFileSync(path.join(profile, 'projects', targetProject, derivative.surfaceRepair.reportPath), 'utf8'));
      assert.equal(nativeReport.passed, true); assert.equal(nativeReport.paidSubmissions, 0); assert.equal(nativeReport.modelTurns, 0);
      assert(Object.values(nativeReport.checks).every(value => value === true));
      report.result = { versionId: derivative.id, files: derivative.files, nativeReport, accepted: false, taskId: originalTask.id };
    }
    report.after = { records, files, projectFiles }; report.verifiedAt = new Date().toISOString();
    fs.writeFileSync(evidence, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ preservedFiles: report.before.files.length, newVersion: report.result.versionId, newTasks: 0, paidSubmissions: 0, productionGPT: 0, unadopted: true }));
  }
}
