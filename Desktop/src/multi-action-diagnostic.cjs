'use strict';

// Explicit developer diagnostic only. Uses real UI buttons, authenticated AI,
// IPC and Unity. The supplied new-asset destination replaces the native chooser;
// all production validation still runs. Never injects synthetic candidates.
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function ({ window, app, dialog, diagnosticPath, diagnosticConsoleErrors, argv = process.argv }) {
  const argument = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const evaluate = expression => window.webContents.executeJavaScript(expression, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const outputBase = diagnosticPath.replace(/\.json$/, '');
  const result = { ok: false, consoleErrors: diagnosticConsoleErrors };
  const originalChooser = dialog.showSaveDialog;
  const originalOpenChooser = dialog.showOpenDialog;
  const phase = value => fs.writeFileSync(diagnosticPath + '.progress.json', JSON.stringify({ phase: value, updatedUtc: new Date().toISOString() }));
  async function screenshot(suffix) {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(outputBase + suffix + '.png', (await window.webContents.capturePage()).toPNG());
  }
  async function waitFor(expression, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      const error = await evaluate("!$('message').hidden && $('message').classList.contains('error') ? $('messageText').textContent : ''");
      if (error) throw new Error(label + ': ' + error);
      if (diagnosticConsoleErrors.length) throw new Error(diagnosticConsoleErrors.join('; '));
      await delay(300);
    }
    throw new Error('Timeout: ' + label);
  }
  const card = id => `document.querySelector('#multiActionDesign section[data-action-id="${id}"]')`;
  try {
    const exportRelative = argument('--diagnostic-export-asset');
    if (!exportRelative?.startsWith('Assets/') || exportRelative.includes('..') || !exportRelative.endsWith('.asset'))
      throw new Error('--diagnostic-export-asset must name a new Assets/*.asset destination.');
    fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
    // Replay only candidates from a prior successful real-AI diagnostic through
    // the normal JSON import UI. This verifies report round-trips without another
    // paid model call or synthetic candidates.
    const replayPath = argument('--diagnostic-multi-replay');
    const replay = replayPath ? JSON.parse(fs.readFileSync(replayPath, 'utf8')) : null;
    if (replay && (!replay.ok || !replay.request?.selections?.length || !replay.runs?.length))
      throw new Error('Replay needs a successful multi-action diagnostic with real runs.');
    phase('startup');
    await waitFor("state.snapshot?.connection?.connected && !locked() && state.source", 'Unity ready');
    await evaluate(`(() => {
      const select = $('source');
      const source = [...select.options].find(item => item.textContent.includes('WaterFromAction'));
      if (!source) throw new Error('Water source missing');
      select.value = source.value; select.dispatchEvent(new Event('change'));
      for (const input of [...document.querySelectorAll('#actionSelection input')]) if (input.checked) input.click();
      for (const id of ['normal-1','skill']) {
        const input = document.querySelector('#actionSelection input[data-action-id="'+id+'"]');
        if (!input || input.disabled) throw new Error('Action unavailable: ' + id);
        input.click();
      }
    })()`);
    await waitFor("document.querySelectorAll('#multiActionDesign section[data-action-id]').length === 2", 'one card per selected action');
    if (!await evaluate("locate(state.selection).adapter.supportsCombinedExport === true")) throw new Error('Installed adapter does not support combined export');
    const goals = {
      'normal-1': '일반 첫 타격의 명중감을 선명하게. 히트스톱은 짧게, 넉백은 과하지 않게 두 후보를 비교합니다.',
      skill: '스킬에 묵직하고 확실한 적중감을 주세요. 카메라 흔들림은 절제하고 두 후보의 타격 정지를 구분해주세요.'
    };
    let firstRequest;
    for (const id of ['normal-1', 'skill']) {
      if (replay) {
        phase('import-' + id);
        const request = replay.request.selections.find(item => item.request.actionId === id)?.request;
        if (!['codex', 'claude'].includes(request?.generation?.provider)) throw new Error('Replay requires recorded AI (Codex or Claude Code) candidates');
        const inputPath = outputBase + '-import-' + id + '.json';
        fs.writeFileSync(inputPath, JSON.stringify(request, null, 2));
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [inputPath] });
        await evaluate("$('importRequest').click()");
        await waitFor(`!state.busy && state.actionDrafts[${JSON.stringify(id)}]?.requestOrigin === 'import'`, 'import real AI candidates ' + id);
        dialog.showOpenDialog = originalOpenChooser;
      } else {
        phase('generate-' + id);
        await evaluate(`(() => {
        const panel = ${card(id)}, goal = panel.querySelector('[data-control="goal"]'), count = panel.querySelector('[data-control="count"]');
        goal.value = ${JSON.stringify(goals[id])}; goal.dispatchEvent(new Event('input'));
        count.value = '2'; count.dispatchEvent(new Event('input'));
        const generate = panel.querySelector('[data-control="generate"]');
        if (generate.disabled) throw new Error('Generate button disabled: ${id}');
        generate.click();
        })()`);
        await waitFor(`!generating() && !locked() && state.actionDrafts[${JSON.stringify(id)}]?.request?.candidates?.length === 2`, 'AI candidates ' + id, 240000);
      }
      const current = await evaluate(`JSON.parse(JSON.stringify(state.actionDrafts[${JSON.stringify(id)}].request))`);
      if (current.actionId !== id || current.generation?.count !== 2) throw new Error('Wrong action or generation count');
      if (id === 'normal-1') firstRequest = JSON.stringify(current);
      else if (await evaluate("JSON.stringify(state.actionDrafts['normal-1'].request)") !== firstRequest)
        throw new Error('Generating skill overwrote normal attack candidates');
      await evaluate(`(() => {
        const select = ${card(id)}.querySelector('[data-control="winner"]');
        select.value = state.actionDrafts[${JSON.stringify(id)}].request.candidates[${id === 'normal-1' ? 1 : 0}].id;
        select.dispatchEvent(new Event('change'));
      })()`);
    }
    result.beforePlayback = await evaluate('JSON.parse(JSON.stringify(combinedRequest()))');
    await screenshot('-candidates');
    if (argv.includes('--diagnostic-multi-run')) {
      result.runs = [];
      await evaluate("$('duration').value='3';$('duration').dispatchEvent(new Event('input'));$('recordVideo').checked=false;$('recordVideo').dispatchEvent(new Event('change'))");
      for (const id of ['normal-1', 'skill']) {
        phase('run-' + id);
        await evaluate(`$('setupTab').click();${card(id)}.querySelector('[data-control="run"]').click()`);
        await waitFor('!!state.activeRunId && !state.starting', 'run started ' + id);
        const runId = await evaluate('state.activeRunId');
        await waitFor("state.snapshot?.connection?.connected && !state.snapshot.connection.running && !state.snapshot.connection.isPlaying && !state.snapshot.connection.isCompiling && !running()", 'run completed ' + id, 180000);
        const report = await evaluate(`window.baekho.loadReport(${JSON.stringify(runId)})`);
        if (report.report.actionId !== id || report.report.results.length !== 2 || report.report.results.some(row => row.status !== 'completed' || row.metrics.hits < 1))
          throw new Error('Requested action candidates did not both complete with damage: ' + id);
        result.runs.push({ actionId: id, runId, hits: report.report.results.map(row => row.metrics.hits) });
        await evaluate("$('setupTab').click()");
        await waitFor('!locked()', 'ready after comparison');
      }
    }
    // Select final candidates from actual Unity results, including its float32
    // JSON serialization, instead of merely inspecting the setup dropdowns.
    const completedRuns = result.runs || replay?.runs || [];
    if (completedRuns.length) {
      result.reportSelections = [];
      for (const { actionId: id, runId } of completedRuns) {
        phase('report-winner-' + id);
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('.history-item')].find(item => item.title === ${JSON.stringify(runId)});
          if (!button) throw new Error('Missing actual run history: ${id}');
          button.click();
        })()`);
        await waitFor(`!state.busy && state.selectedRunId === ${JSON.stringify(runId)} && !!state.reportBundle`, 'actual report opened ' + id);
        await evaluate(`(() => {
          const candidateId = state.actionDrafts[${JSON.stringify(id)}].request.candidates[${id === 'normal-1' ? 1 : 0}].id;
          state.actionDrafts[${JSON.stringify(id)}].candidateId = '';
          $('winner').value = candidateId; $('winner').dispatchEvent(new Event('change'));
          if ($('useReportCandidate').disabled) throw new Error('Matching Unity report cannot select final candidate: ${id}');
          $('useReportCandidate').click();
          if (state.actionDrafts[${JSON.stringify(id)}].candidateId !== candidateId) throw new Error('Report winner did not transfer');
        })()`);
        result.reportSelections.push({ actionId: id, runId, candidateId: await evaluate(`state.actionDrafts[${JSON.stringify(id)}].candidateId`) });
      }
      result.runs = completedRuns;
    }
    await evaluate("$('setupTab').click()");
    for (const id of ['normal-1', 'skill']) {
      await evaluate(`${card(id)}.scrollIntoView({block:'start'})`);
      await screenshot('-card-' + id);
    }
    phase('export');
    result.request = await evaluate('JSON.parse(JSON.stringify(combinedRequest()))');
    const project = await evaluate('state.snapshot.projectPath');
    const destination = path.join(project, exportRelative);
    if (fs.existsSync(destination) || fs.existsSync(destination + '.meta')) throw new Error('Diagnostic export already exists');
    let choices = 0;
    dialog.showSaveDialog = async () => { choices++; return { canceled: false, filePath: destination }; };
    await evaluate("$('setupTab').click();if($('exportCombinedPreset').disabled)throw new Error('Combined export disabled');$('exportCombinedPreset').click()");
    await waitFor(`!state.busy && $('messageText').textContent.includes(${JSON.stringify(exportRelative)})`, 'combined export saved');
    if (choices !== 1 || !fs.existsSync(destination)) throw new Error('Expected exactly one save chooser and output form file');
    result.assetPath = exportRelative;
    result.filePath = destination;
    result.chooserCount = choices;
    result.horizontalOverflow = await evaluate('document.documentElement.scrollWidth > window.innerWidth');
    if (result.horizontalOverflow) throw new Error('Multi-action layout overflows');
    await evaluate("$('combinedPreset').scrollIntoView({block:'end'})");
    await screenshot('-complete');
    window.setSize(1024, 800); await delay(300);
    await evaluate("$('combinedPreset').scrollIntoView({block:'end'})");
    result.narrowOverflow = await evaluate('document.documentElement.scrollWidth > window.innerWidth');
    if (result.narrowOverflow) throw new Error('Multi-action narrow layout overflows');
    await screenshot('-narrow');
    result.ok = true;
    fs.writeFileSync(diagnosticPath, JSON.stringify(result, null, 2));
    phase('complete');
    app.quit();
  } catch (error) {
    phase('failed');
    result.error = error.stack || error.message;
    fs.writeFileSync(diagnosticPath, JSON.stringify(result, null, 2));
    try { await screenshot('-failed'); } catch {}
    app.exit(1);
  } finally { dialog.showSaveDialog = originalChooser; dialog.showOpenDialog = originalOpenChooser; }
};
