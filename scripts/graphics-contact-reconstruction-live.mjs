// Explicit Partsmith app buttons only. This helper never generates, repairs, adopts,
// retries, or contacts a provider by itself. Invoke one named phase at a time.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const mode = process.argv[2];
const modes = ['snapshot', 'verify', 'prepare-reconstruction', 'execute-reconstruction', 'recover-procedure', 'inspect', 'review-reconstruction', 'restart-snapshot-check'];
assert(modes.includes(mode), `Choose exactly one mode: ${modes.join(', ')}`);
const profile = path.resolve(process.env.PARTSMITH_PROFILE || path.join(process.env.APPDATA, 'partsmith'));
const projectId = '5844e13a-7892-422b-ac3f-410fe4f59231';
const objectId = 'dedbdea6-d960-4120-b3ee-145b298a46c8';
const sourceVersionId = 'a8a984af-a88d-4529-955b-7c9437dfb292';
const sourceTaskId = '83903b1a-0f3f-47de-9e5b-a1b5d18f7f9b';
const evidence = path.resolve('artifacts/runtime/graphics-contact-reconstruction-live.json');
const now = () => new Date().toISOString();
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
let record = fs.existsSync(evidence) ? json(evidence) : { schemaVersion: 1, profile, projectId, objectId, sourceVersionId, sourceTaskId, events: [] };
for (const [key, value] of Object.entries({ schemaVersion: 1, profile, projectId, objectId, sourceVersionId, sourceTaskId })) assert.equal(record[key], value, `Evidence target mismatch: ${key}`);
const save = () => {
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence + '.tmp', JSON.stringify(record, null, 2));
  fs.renameSync(evidence + '.tmp', evidence);
};
const event = (name, details = {}) => { record.events.push({ name, at: now(), ...details }); save(); };
const projectFile = (id, relative) => {
  const root = path.resolve(profile, 'projects', id), file = path.resolve(root, relative), relation = path.relative(root, file);
  assert(relation && relation !== '..' && !relation.startsWith('..' + path.sep) && !path.isAbsolute(relation), 'File is outside the stated project');
  return file;
};
const stamp = file => ({ path: file, sha256: hash(file), bytes: fs.statSync(file).size });
const registeredFiles = spaces => {
  const files = new Map();
  for (const space of spaces) for (const version of space.versions) for (const file of version.files) {
    const absolute = projectFile(space.projectId, file.path);
    if (files.has(absolute)) assert.equal(files.get(absolute).sha256, file.sha256, 'Registered hashes disagree');
    else {
      const actual = stamp(absolute); assert.equal(actual.sha256, file.sha256, `Original hash differs: ${absolute}`);
      assert.equal(actual.bytes, file.bytes, `Original size differs: ${absolute}`); files.set(absolute, actual);
    }
  }
  return [...files.values()];
};
const projectJson = state => [...new Set([...state.projects.map(project => project.id), ...state.graphicsWorkspaces.map(space => space.projectId)])].map(id => {
  const file = projectFile(id, 'project.json'); assert(fs.existsSync(file), `Missing project JSON: ${id}`); return stamp(file);
});
const workspaceJson = spaces => spaces.map(space => stamp(projectFile(space.projectId, 'graphics/workspace.json')));
const verifyHashes = files => { for (const file of files) { assert.equal(fs.statSync(file.path).size, file.bytes, `Protected size changed: ${file.path}`); assert.equal(hash(file.path), file.sha256, `Protected content changed: ${file.path}`); } };
const phaseTasks = (space, phase) => space.tasks.filter(task => task.objectId === objectId && task.taskId === 'M06' && task.settings.contactPhase === phase && task.settings.sourceVersionId === sourceVersionId);
const getTask = (space, phase) => { const matches = phaseTasks(space, phase); assert(matches.length <= 1, `Duplicate ${phase} records; do not execute`); return matches[0]; };
const sourceCheck = space => {
  const source = space.versions.find(version => version.id === sourceVersionId), task = space.tasks.find(task => task.id === sourceTaskId);
  assert(source && task && source.provenance.jobId === task.id && task.taskId === 'M08' && task.status === 'review' && task.outputVersionIds.includes(source.id));
  assert.equal(source.role, 'model'); assert.equal(source.slot, 'main'); assert(!source.contact); assert(source.files.some(file => /\.blend$/i.test(file.path)));
  const parts = task.outputVersionIds.filter(id => id !== sourceVersionId).map(id => space.versions.find(version => version.id === id));
  assert.equal(parts.length, 3); assert.deepEqual(parts.map(part => part.slot).sort(), ['part-body', 'part-hair', 'part-head']);
  return { source, parts };
};
const byProject = spaces => [...spaces].sort((a, b) => a.projectId.localeCompare(b.projectId));

// The user may have closed Partsmith. Freeze disk state before launching the new
// build; stale DevToolsActivePort files must not prevent this read-only snapshot.
if (process.argv.includes('--offline')) {
  assert.equal(mode, 'snapshot', '--offline is supported only for snapshot');
  const projectRoot = path.join(profile, 'projects');
  const directories = fs.readdirSync(projectRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
  const projects = [], spaces = [];
  for (const entry of directories) {
    const projectPath = projectFile(entry.name, 'project.json');
    if (fs.existsSync(projectPath)) { const project = json(projectPath); assert.equal(project.id, entry.name); projects.push({ id: project.id }); }
    const workspacePath = projectFile(entry.name, 'graphics/workspace.json');
    if (fs.existsSync(workspacePath)) { const space = json(workspacePath); assert.equal(space.projectId, entry.name); spaces.push(space); }
  }
  const space = spaces.find(item => item.projectId === projectId); assert(space, 'Human workspace missing on disk'); sourceCheck(space);
  assert(!spaces.some(item => item.tasks.some(task => ['running', 'awaiting_approval', 'submission_unknown'].includes(task.status))), 'Offline initial snapshot requires no active or approval-waiting task');
  assert(!getTask(space, 'reconstruct'), 'Offline initial snapshot requires no existing contact tasks');
  const captured = { at: now(), workspaces: byProject(spaces), files: registeredFiles(spaces), projectJson: projectJson({ projects, graphicsWorkspaces: spaces }), workspaceJson: workspaceJson(spaces) };
  if (record.baseline) {
    assert.deepEqual(byProject(spaces), byProject(record.baseline.workspaces), 'Prior baseline changed; never overwrite it');
    verifyHashes(record.baseline.files); verifyHashes(record.baseline.projectJson); verifyHashes(record.baseline.workspaceJson);
  } else record.baseline = captured;
  record.restartSnapshot = captured;
  event('offline-snapshot', { workspaces: spaces.length, originalFiles: record.baseline.files.length });
  console.log(JSON.stringify({ mode, offline: true, workspaces: spaces.length, protectedFiles: captured.files.length, projectJsonFiles: captured.projectJson.length, activeTasks: 0, contactTasks: 0, appConnection: false }));
  process.exit(0);
}

const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
assert(/^\d+$/.test(port), 'No app CDP port; open the intended Partsmith build first');
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('index.html'));
assert(page, 'Partsmith app page was not found'); page.setDefaultTimeout(15000);
const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
const state = () => page.evaluate(() => window.desktop.call({ type: 'state' }));
const workspace = state => { const space = state.graphicsWorkspaces.find(space => space.projectId === projectId); assert(space, 'Human workspace missing'); return space; };
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) { const current = await state(); if (predicate(workspace(current))) return current; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw Error('Saved state did not reach the expected checkpoint. Inspect the same task; do not repeat the click.');
};
async function openObject() {
  if (!await page.getByTestId('graphics-object-' + objectId).isVisible()) {
    let button = page.locator(`[data-project-id="${projectId}"]`).getByTestId('project-open');
    if (!await button.isVisible()) await page.getByRole('button', { name: '모든 프로젝트', exact: true }).click();
    await button.click();
  }
  await page.getByTestId('graphics-object-' + objectId).click();
  await page.getByRole('navigation', { name: '제작 단계' }).getByRole('button', { name: '4 조립·수정', exact: true }).click();
}
function invariant(current, hashes = true) {
  assert(record.baseline, 'Run snapshot before any live action. No baseline is inferred after production.');
  const before = record.baseline.workspaces, spaces = current.graphicsWorkspaces, currentTarget = workspace(current), priorTarget = before.find(space => space.projectId === projectId);
  assert.deepEqual(spaces.map(space => space.projectId).sort(), before.map(space => space.projectId).sort(), 'Project membership changed');
  for (const old of before) {
    const next = spaces.find(space => space.projectId === old.projectId);
    if (old.projectId !== projectId) { assert.deepEqual(next, old, `Unrelated workspace changed: ${old.projectId}`); continue; }
    assert.deepEqual(next.objects, old.objects, 'Objects, creation drafts or accepted versions changed');
    assert.deepEqual(next.deliveries, old.deliveries, 'Unity deliveries changed');
    assert.deepEqual(next.tripoBudget, old.tripoBudget, 'Tripo budget changed');
    assert.deepEqual(next.target, old.target, 'Unity target changed');
    for (const version of old.versions) assert.deepEqual(next.versions.find(item => item.id === version.id), version, `Original version changed: ${version.id}`);
    for (const task of old.tasks) assert.deepEqual(next.tasks.find(item => item.id === task.id), task, `Previous task changed: ${task.id}`);
    const additions = next.tasks.filter(task => !old.tasks.some(prior => prior.id === task.id));
    assert(additions.every(task => task.objectId === objectId && task.taskId === 'M06' && ['reconstruct'].includes(task.settings.contactPhase) && task.settings.sourceVersionId === sourceVersionId), 'Unrelated task was added');
    for (const phase of ['reconstruct']) {
      const task = getTask(next, phase); if (!task) continue;
      assert.equal(task.cost?.provider, 'Codex'); assert.equal(task.cost.credits, null); assert.deepEqual(task.backendJobIds, []); assert(!task.paidApproval, 'External paid approval appeared');
      const saved = record[phase];
      if (saved?.request) assert.deepEqual({ requestHash: task.requestHash, settings: task.settings, instruction: task.instruction, inputVersionIds: task.inputVersionIds }, saved.request, 'Frozen request changed');
    }
    const addedVersions = next.versions.filter(version => !old.versions.some(prior => prior.id === version.id));
    assert(addedVersions.every(version => version.objectId === objectId && additions.some(task => task.outputVersionIds.includes(version.id) && task.id === version.provenance.jobId)), 'Unrelated/unregistered result added');
  }
  sourceCheck(currentTarget);
  assert.deepEqual(currentTarget.objects.find(object => object.id === objectId).accepted, priorTarget.objects.find(object => object.id === objectId).accepted, 'Harness must leave all final results unadopted');
  if (hashes) { verifyHashes(record.baseline.files); verifyHashes(record.baseline.projectJson); }
  return currentTarget;
}
function rememberTask(task, phase) {
  assert(task, `No ${phase} task exists`);
  record[phase] ??= {};
  const request = { requestHash: task.requestHash, settings: task.settings, instruction: task.instruction, inputVersionIds: task.inputVersionIds };
  if (record[phase].taskId) { assert.equal(record[phase].taskId, task.id); assert.deepEqual(record[phase].request, request); }
  else Object.assign(record[phase], { taskId: task.id, request, observedAt: now() });
  Object.assign(record[phase], { status: task.status, message: task.message, outputVersionIds: task.outputVersionIds, checkedAt: now() }); save();
}
function dispatch(task) {
  const file = projectFile(projectId, `graphics/jobs/${task.id}/contact/dispatch.json`);
  if (!fs.existsSync(file)) return undefined;
  const value = json(file); assert.equal(value.phase, task.settings.contactPhase); assert.equal(value.requestedModel, 'gpt-6-astra'); assert.equal(value.automaticRetries, 0);
  return { path: file, sha256: hash(file), phase: value.phase, startedAt: value.startedAt, automaticRetries: value.automaticRetries };
}
function reviewedVersion(space, phase) {
  const task = getTask(space, phase); assert.equal(task?.status, 'review', task?.message || `No finished ${phase} task`);
  const versions = task.outputVersionIds.map(id => space.versions.find(version => version.id === id));
  const matches = versions.filter(version => version?.contact?.phase === phase);
  const repaired = matches.filter(version => version.slot === 'main' && version.contact.status === 'repaired');
  assert(repaired.length === 1 || repaired.length === 0 && matches.length === 1, 'Exactly one current contact review result required');
  const version = repaired[0] ?? matches[0]; assert.equal(version.contact.sourceVersionId, sourceVersionId);
  assert.deepEqual(version.contact.partVersionIds, sourceCheck(space).parts.map(part => part.id));
  for (const result of versions) for (const file of result.files) { const actual = stamp(projectFile(projectId, file.path)); assert.equal(actual.sha256, file.sha256); assert.equal(actual.bytes, file.bytes); }
  return { task, version, versions };
}
async function captureReview(space, phase) {
  const { task, version, versions } = reviewedVersion(space, phase);
  await openObject(); await page.getByTestId('graphics-version-' + version.id).click();
  const panel = page.getByTestId('graphics-contact-review'); await panel.waitFor();
  assert.equal(await page.getByTestId('graphics-accept-version').count(), 0);
  if (version.contact.status !== 'blocked') await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('[data-testid="graphics-contact-review"] img')];
    return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  const screenshot = path.resolve(`artifacts/runtime/graphics-contact-reconstruction-${phase}-${task.id.slice(0, 8)}.png`);
  await page.getByTestId('graphics-contact-heading').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: screenshot });
  const views = [];
  for (const view of version.contact.views) {
    const allPaths = [view.beforePath, view.overlayPath, view.afterPath].filter(Boolean);
    const paths = allPaths.map(relative => { assert(version.files.some(file => file.path === relative), 'Unregistered view'); return projectFile(projectId, relative); });
    views.push({ id: view.id, label: view.label, files: paths.map(stamp) });
  }
  Object.assign(record[phase], { resultVersionId: version.id, results: versions, review: version.contact, views, screenshot, capturedAt: now(), dispatch: dispatch(task), visualQualityApproved: false }); save();
  // Rendering/capturing is not visual acceptance. The caller must inspect actual overlays.
  return version;
}

try {
  let current = await state(), space = workspace(current);
  assert.equal(path.resolve(current.dataDir), profile, 'Connected app profile does not match intended profile'); sourceCheck(space);
  if (mode === 'snapshot') {
    assert(!current.graphicsWorkspaces.some(space => space.tasks.some(task => ['running', 'submission_unknown'].includes(task.status))), 'Snapshot only while no producer is running');
    if (!record.baseline) {
      assert(!getTask(space, 'analyze') && !getTask(space, 'repair'), 'Contact work already exists: missing pre-action baseline must be investigated, never reconstructed');
      record.baseline = { at: now(), workspaces: current.graphicsWorkspaces, files: registeredFiles(current.graphicsWorkspaces), projectJson: projectJson(current), workspaceJson: workspaceJson(current.graphicsWorkspaces) };
      save();
    } else invariant(current);
    record.restartSnapshot = { at: now(), workspaces: current.graphicsWorkspaces, projectJson: projectJson(current), workspaceJson: workspaceJson(current.graphicsWorkspaces), files: registeredFiles(current.graphicsWorkspaces) };
    event('snapshot', { originalFiles: record.baseline.files.length, currentFiles: record.restartSnapshot.files.length });
  } else {
    invariant(current, mode !== 'inspect');
    if (mode === 'restart-snapshot-check') {
      assert(record.restartSnapshot, 'Take an idle snapshot before restart');
      assert.deepEqual(byProject(current.graphicsWorkspaces), byProject(record.restartSnapshot.workspaces), 'Workspace changed across restart');
      verifyHashes(record.restartSnapshot.workspaceJson); verifyHashes(record.restartSnapshot.projectJson); verifyHashes(record.restartSnapshot.files);
      event('restart-preserved', { capturedAt: record.restartSnapshot.at });
    }
    if (mode === 'verify') event('preservation-verified', { files: record.baseline.files.length });
    if (mode === 'recover-procedure') {
      const task = getTask(space, 'reconstruct'); rememberTask(task, 'reconstruct');
      assert.equal(task.id, '0d3e1522-7949-406b-87e9-2ed14a25d2ff');
      if (record.procedureRecovery?.intentAt || task.contactProcedureRecoveryRequested) {
        event('procedure-recovery-not-repeated', { taskId: task.id, status: task.status });
      } else {
        const { version } = reviewedVersion(space, 'reconstruct');
        assert.equal(version.id, 'a86ec006-8736-4eb9-b387-9e884e18929b');
        assert.equal(version.contact.status, 'blocked');
        assert(!space.tasks.some(item => ['running', 'awaiting_approval', 'submission_unknown'].includes(item.status)));
        await openObject(); await page.getByTestId('graphics-version-' + version.id).click();
        const recover = page.getByTestId('graphics-contact-recover-procedure'); await recover.waitFor(); assert(await recover.isEnabled());
        const folder = projectFile(projectId, `graphics/jobs/${task.id}/contact`);
        record.procedureRecovery = { intentAt: now(), taskId: task.id, originals: ['dispatch.json', 'usage.json', 'checkpoint.json', 'prepared.json', 'work/author_once.py', 'work/author.log', 'work/result.json'].map(file => stamp(path.join(folder, file))) }; save();
        await recover.click(); current = await waitFor(space => getTask(space, 'reconstruct')?.contactProcedureRecoveryRequested === true); space = invariant(current);
        event('procedure-recovery-clicked-once', { taskId: task.id });
      }
    }
    for (const phase of ['reconstruct']) {
      const suffix = 'reconstruction';
      if (mode === `prepare-${suffix}`) {
        let task = getTask(space, phase);
        if (!task) {
          assert(!space.tasks.some(task => ['running', 'awaiting_approval', 'submission_unknown'].includes(task.status)), 'Existing work is active; inspect it instead');
          await openObject();
          const { version } = reviewedVersion(space, 'analyze'); assert.equal(version.contact.status, 'blocked');
          assert.equal(version.id, '05968857-7764-444c-ad72-6051bde3e285');
          await page.getByTestId('graphics-version-' + version.id).click();
          const prepare = page.getByTestId('graphics-contact-reconstruct'); await prepare.waitFor();
          event('explicit-reconstruction-prepare-intent', { phase, analysisVersionId: version.id });
          await prepare.click();
          current = await waitFor(space => !!getTask(space, phase)); space = invariant(current); task = getTask(space, phase);
        }
        rememberTask(task, phase); assert.equal(task.settings.sourceVersionId, sourceVersionId);
        assert.deepEqual(JSON.parse(task.settings.contactPartVersionIds), sourceCheck(space).parts.map(part => part.id));
        assert.equal(task.settings.contactTopologyReconstructionConfirmed, true); assert.equal(task.settings.contactAnalysisVersionId, '05968857-7764-444c-ad72-6051bde3e285');
        event('prepared-or-existing', { phase, taskId: task.id, status: task.status });
      }
      if (mode === `execute-${suffix}`) {
        const task = getTask(space, phase); rememberTask(task, phase);
        if (record[phase].executeIntentAt || dispatch(task) || task.status !== 'awaiting_approval') {
          event('execution-not-repeated', { phase, taskId: task.id, status: task.status });
        } else {
          assert.deepEqual(task.backendJobIds, []); assert.equal(task.cost.provider, 'Codex'); assert.equal(task.cost.credits, null); assert(!task.paidApproval);
          await openObject(); const approve = page.getByTestId('graphics-approve-' + task.id); await approve.waitFor(); assert(await approve.isEnabled());
          record[phase].executeIntentAt = now(); save(); // Journal BEFORE the click: uncertainty must never trigger another click.
          await approve.click(); current = await waitFor(space => getTask(space, phase)?.status !== 'awaiting_approval'); space = invariant(current);
          rememberTask(getTask(space, phase), phase); event('approval-clicked-once', { phase, taskId: task.id });
        }
      }
      if (mode === `review-${suffix}`) { rememberTask(getTask(space, phase), phase); await captureReview(space, phase); event('review-captured-not-adopted', { phase }); }
    }
  }
  current = await state(); space = invariant(current, mode !== 'inspect');
  if (record.procedureRecovery?.originals) verifyHashes(record.procedureRecovery.originals);
  const tasks = ['reconstruct'].flatMap(phase => {
    const task = getTask(space, phase); if (!task) return [];
    rememberTask(task, phase); return [{ phase, id: task.id, status: task.status, message: task.message, outputs: task.outputVersionIds, dispatch: dispatch(task), runtimeApproval: task.runtimeApproval ? { id: task.runtimeApproval.id, title: task.runtimeApproval.title } : undefined }];
  });
  assert.deepEqual(pageErrors, []); record.lastInspection = { at: now(), mode, originalStatePreserved: true, originalHashesChecked: mode !== 'inspect', tasks }; save();
  console.log(JSON.stringify({ mode, tasks, originalStatePreserved: true, originalHashesChecked: mode !== 'inspect', protectedFiles: record.baseline.files.length, acceptedUnchanged: true, finalAdoption: false }));
} catch (error) {
  record.lastError = { at: now(), mode, message: String(error) }; save(); throw error;
} finally {
  // Disconnect this CDP client only; never close the user's app or its page.
  await browser.close();
}
