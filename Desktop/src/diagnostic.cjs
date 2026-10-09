'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Explicit opt-in developer diagnostics. All user actions use the real renderer
// controls and IPC; no candidates or recordings are injected into the app.
module.exports = async function runDiagnostic({ window, app, diagnosticPath, diagnosticConsoleErrors, argv = process.argv }) {
  const result = { ok: true, consoleErrors: diagnosticConsoleErrors };
  const outputBase = diagnosticPath.replace(/\.json$/, '');
  const evaluate = (expression, userGesture = false) => window.webContents.executeJavaScript(expression, userGesture);
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
  function phase(name, detail = '') {
    fs.writeFileSync(diagnosticPath + '.progress.json', JSON.stringify({ phase: name, detail: String(detail).slice(0, 2000), updatedUtc: new Date().toISOString() }, null, 2));
  }
  async function screenshot(suffix) {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(outputBase + suffix + '.png', (await window.webContents.capturePage()).toPNG());
  }
  async function waitForUi(expression, label, timeoutMs = 15000, failOnMessage = false) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      if (failOnMessage) {
        const error = await evaluate("document.getElementById('message').classList.contains('error') && !document.getElementById('message').hidden ? document.getElementById('messageText').textContent : ''");
        if (error) throw new Error(`${label}: ${error}`);
      }
      if (diagnosticConsoleErrors.length) throw new Error(`Renderer console error: ${diagnosticConsoleErrors.join('; ').slice(0, 4000)}`);
      await delay(250);
    }
    throw new Error(`Renderer did not become ready: ${label}`);
  }
  const mediaElements = "[...document.querySelectorAll('#videoGrid video')].filter(video => video.getAttribute('src'))";
  const videoState = `${mediaElements}.map(video => ({id:video.id,time:video.currentTime,duration:video.duration,paused:video.paused,seeking:video.seeking,width:video.videoWidth,height:video.videoHeight,muted:video.muted,rate:video.playbackRate}))`;
  const selectionState = "[...document.querySelectorAll('#videoGrid select')].map(select => Number(select.value))";
  const decoded = `${mediaElements}.every(video => video.readyState >= 2 && video.videoWidth > 0 && Number.isFinite(video.duration) && !video.error)`;
  function assertUnique(indices, expected) {
    if (indices.length !== expected || new Set(indices).size !== expected) throw new Error(`Expected ${expected} distinct comparison candidates: ${JSON.stringify(indices)}`);
  }
  try {
    const generateWithAi = argv.includes('--diagnostic-ai'), runExperiment = argv.includes('--diagnostic-run');
    if (runExperiment && !generateWithAi) throw new Error('--diagnostic-run requires --diagnostic-ai; fixed diagnostic candidates are no longer supported.');
    const argument = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; };
    const requestedSource = argument('--diagnostic-source'), requestedAction = argument('--diagnostic-action'), requestedRun = argument('--diagnostic-run-id');
    const requestedCount = Number(argument('--diagnostic-count') || 4), requestedDuration = Number(argument('--diagnostic-duration') || 4);
    if (!Number.isInteger(requestedCount) || requestedCount < 2 || requestedCount > 12 || !Number.isFinite(requestedDuration) || requestedDuration < 3 || requestedDuration > 60)
      throw new Error('Diagnostic count must be 2–12 and duration 3–60 seconds.');
    phase('startup');
    await waitForUi("state.snapshot?.connection?.connected && state.source && document.getElementById('adapter').value && document.getElementById('source').value && !state.busy", 'Unity source', 30000, true);
    if (requestedSource) await evaluate(`(() => {
      const select = document.getElementById('source'), search = ${JSON.stringify(requestedSource)}.toLowerCase();
      const matches = [...select.options].filter(option => option.value.toLowerCase() === search || option.textContent.toLowerCase().includes(search));
      if (matches.length !== 1) throw new Error('Diagnostic source must match exactly one available source.');
      select.value = matches[0].value; select.dispatchEvent(new Event('change'));
    })()`);
    if (requestedAction) await evaluate(`(() => {
      const select = document.getElementById('action'), id = ${JSON.stringify(requestedAction)};
      if (![...select.options].some(option => option.value === id)) throw new Error('Diagnostic action is missing from the selected source.');
      select.value = id; select.dispatchEvent(new Event('change'));
      if (!actionAvailable()) throw new Error(document.getElementById('sourceHelp').textContent);
    })()`);
    result.state = await evaluate('window.baekho.bootstrap()');
    result.initialSetup = await evaluate(`({adapter:document.getElementById('adapter').value,source:document.getElementById('source').value,
      action:document.getElementById('action').value,actionOptions:[...document.getElementById('action').options].map(option=>({id:option.value,label:option.textContent})),
      sourceOptions:[...document.getElementById('source').options].map(option=>({id:option.value,label:option.textContent})),
      candidateCount:document.querySelectorAll('#candidates .candidate-card').length,
      editableCandidateValues:document.querySelectorAll('#candidates input').length,
      horizontalOverflow:document.documentElement.scrollWidth > window.innerWidth})`);
    if (result.initialSetup.candidateCount !== 0 || result.initialSetup.editableCandidateValues !== 0)
      throw new Error('Startup must wait for AI-generated candidates, with no editable candidate values.');
    if (result.initialSetup.horizontalOverflow) throw new Error('Setup view has horizontal overflow.');
    await screenshot('-setup-empty');

    if (generateWithAi) {
      phase('ai-generation', `Generating ${requestedCount} candidates through the actual UI.`);
      if (!result.state.ai?.available || !result.state.ai?.authenticated) throw new Error(`Codex is unavailable: ${result.state.ai?.error || result.state.ai?.label || 'unknown connection state'}`);
      await evaluate(`(() => {
        const goal = document.getElementById('goal'), count = document.getElementById('candidateTotal');
        goal.value = '선택한 공격·스킬의 반응을 유지하면서 묵직한 명중감을 비교하고 싶습니다. 화면 흔들림은 절제하고, 각 후보가 서로 구분되게 제안하세요.';
        count.value = ${JSON.stringify(String(requestedCount))}; goal.dispatchEvent(new Event('input')); count.dispatchEvent(new Event('input'));
      })()`);
      await waitForUi("!document.getElementById('generateCandidates').disabled", 'AI generate button', 15000, true);
      await evaluate("document.getElementById('generateCandidates').click()", true);
      await waitForUi(`!state.generating && state.request?.candidates?.length === ${requestedCount} && requestReady() && document.querySelectorAll('#candidates .candidate-card').length === ${requestedCount}`, 'AI candidates', 210000, true);
      result.generatedRequest = await evaluate('JSON.parse(JSON.stringify(state.request))');
      result.generationUi = await evaluate(`({origin:state.requestOrigin,cards:document.querySelectorAll('#candidates .candidate-card').length,
        editableValues:document.querySelectorAll('#candidates input').length,
        reasons:[...document.querySelectorAll('#candidates .candidate-rationale')].map(item=>item.textContent),
        horizontalOverflow:document.documentElement.scrollWidth > window.innerWidth})`);
      if (result.generationUi.origin !== 'ai' || result.generationUi.editableValues !== 0 || result.generationUi.reasons.length !== requestedCount ||
          result.generatedRequest.candidates.some(candidate => !candidate.rationale?.trim()) || result.generatedRequest.generation?.count !== requestedCount ||
          result.generatedRequest.actionId !== result.initialSetup.action || result.generatedRequest.sourceGuid !== result.initialSetup.source)
        throw new Error('AI proposals must preserve the selected target, requested count, read-only values, reasons, and generation metadata.');
      if (result.generationUi.horizontalOverflow) throw new Error('Generated setup view has horizontal overflow.');
    }
    await screenshot('-setup');

    if (runExperiment) {
      phase('experiment-start');
      await evaluate(`document.getElementById('duration').value=${JSON.stringify(String(requestedDuration))};document.getElementById('duration').dispatchEvent(new Event('input'))`);
      await waitForUi("!document.getElementById('runExperiment').disabled", 'experiment launch button', 15000, true);
      result.submittedRequest = await evaluate('JSON.parse(JSON.stringify(state.request))');
      await evaluate("document.getElementById('runExperiment').click()", true);
      await waitForUi('!!state.activeRunId && !state.starting', 'experiment id', 25000, true);
      const runId = await evaluate('state.activeRunId'); result.runId = runId;
      phase('experiment-running', runId);
      const deadline = Date.now() + Math.max(150000, (requestedDuration + 20) * requestedCount * 1000);
      let completed = false;
      while (Date.now() < deadline) {
        const snapshot = await evaluate('window.baekho.refresh()');
        const run = snapshot.runs.find(item => item.id === runId);
        if (snapshot.connection.connected && !snapshot.connection.running && !snapshot.connection.isCompiling && run) {
          result.run = await evaluate(`window.baekho.loadReport(${JSON.stringify(runId)})`);
          if (result.run.report.results.length === requestedCount && result.run.report.results.every(row => row.status === 'completed')) { completed = true; break; }
          if (result.run.report.results.some(row => ['failed', 'cancelled', 'error'].includes(row.status)))
            throw new Error(`Unity experiment failed: ${JSON.stringify(result.run.report.results.map(row => ({ status: row.status, error: row.error })))}`);
        }
        await delay(1200);
      }
      if (!completed) throw new Error('AI experiment did not complete all requested candidates within its time limit.');
      if (JSON.stringify(result.run.request.generation) !== JSON.stringify(result.submittedRequest.generation) ||
          result.run.request.actionId !== result.submittedRequest.actionId || result.run.request.sourceGuid !== result.submittedRequest.sourceGuid ||
          result.run.request.candidates.some((candidate, index) => candidate.rationale !== result.submittedRequest.candidates[index].rationale) ||
          result.run.report.results.some((row, index) => row.candidate.rationale !== result.submittedRequest.candidates[index].rationale))
        throw new Error('AI generation metadata and candidate rationale must survive the Unity run.');
      phase('experiment-completed', runId);
    }

    const snapshot = await evaluate('window.baekho.refresh()');
    const latest = result.runId || requestedRun || snapshot.runs.find(run => run.completedCount > 0)?.id;
    if (latest) {
      phase('comparison-load', latest);
      const history = `[...document.querySelectorAll('#history .history-item')].find(button=>button.title===${JSON.stringify(latest)})`;
      await waitForUi(`Boolean(${history})`, 'history entry');
      await evaluate(`${history}.click()`);
      await waitForUi(`!document.getElementById('comparePanel').hidden && !document.getElementById('reportContent').hidden &&
        document.getElementById('reportMeta').textContent.includes(${JSON.stringify(latest)}) && document.querySelectorAll('#videoGrid select').length > 0`, 'comparison report', 20000, true);
      const loaded = await evaluate(`window.baekho.loadReport(${JSON.stringify(latest)})`);
      const count = loaded.report.results.length;
      result.comparedRunId = latest;
      result.defaultSelection = await evaluate(selectionState); assertUnique(result.defaultSelection, count);
      if (await evaluate("Number(document.getElementById('compareCount').value)") !== count) throw new Error('Comparison must initially show every candidate.');
      const expectedMedia = loaded.report.results.filter(row => row.videoUrl).length;
      if (runExperiment && expectedMedia !== count) throw new Error('The new AI experiment must produce a playable recording for every candidate.');
      if (await evaluate(`${mediaElements}.length`) !== expectedMedia) throw new Error('Comparison did not load each available recording.');
      await waitForUi(decoded, 'all comparison videos decoded', 30000, true);
      result.media = await evaluate(videoState);
      if (count > 2) {
        phase('comparison-count', `${count} → 2 → ${count}`);
        await evaluate("document.getElementById('compareCount').value='2';document.getElementById('compareCount').dispatchEvent(new Event('change'))");
        assertUnique(await evaluate(selectionState), 2);
        await waitForUi(decoded, 'two-video comparison decoded');
        await evaluate(`document.getElementById('compareCount').value=${JSON.stringify(String(count))};document.getElementById('compareCount').dispatchEvent(new Event('change'))`);
        assertUnique(await evaluate(selectionState), count);
        await waitForUi(decoded, 'restored comparison decoded', 30000);
        result.comparisonResize = { original: count, reduced: 2, restored: count };
      }
      if (count >= 2) {
        await evaluate(`(() => { const selectors=[...document.querySelectorAll('#videoGrid select')];selectors[${count - 1}].value=selectors[0].value;selectors[${count - 1}].dispatchEvent(new Event('change')); })()`);
        result.swappedSelection = await evaluate(selectionState); assertUnique(result.swappedSelection, count);
        await evaluate(`document.getElementById('selectCandidate${count}').value=${JSON.stringify(String(count - 1))};document.getElementById('selectCandidate${count}').dispatchEvent(new Event('change'))`);
        await waitForUi(decoded, 'swapped comparison videos decoded', 30000);
      }
      if (expectedMedia > 0) {
        phase('comparison-playback', `${expectedMedia} videos`);
        await evaluate("document.getElementById('restart').click()");
        await waitForUi(`${mediaElements}.every(video => !video.seeking)`, 'initial seek');
        const before = await evaluate(videoState);
        await evaluate("document.getElementById('play').click()", true);
        await waitForUi(`${mediaElements}.every(video => !video.paused)`, 'all videos playing');
        await delay(700);
        await evaluate("document.getElementById('play').click()", true);
        await waitForUi(`${mediaElements}.every(video => video.paused)`, 'all videos paused');
        const paused = await evaluate(videoState);
        if (paused.some((video, index) => video.time <= before[index].time + 0.05)) throw new Error('Every recorded candidate must advance during synchronized playback.');
        await evaluate("if(!document.getElementById('align').checked)document.getElementById('align').click()");
        await waitForUi(`${mediaElements}.every(video => !video.seeking)`, 'first-hit aligned seek');
        await evaluate("document.getElementById('next').click()");
        await waitForUi(`${mediaElements}.every(video => !video.seeking)`, 'aligned frame step');
        const stepped = await evaluate(videoState);
        const timeline = await evaluate(`(() => {const seek=document.getElementById('seek');return {aligned:document.getElementById('align').checked,time:Number(seek.value),min:Number(seek.min),max:Number(seek.max)};})()`);
        const epsilon = 0.000001;
        if (!timeline.aligned || !Number.isFinite(timeline.time) || timeline.time < timeline.min - epsilon || timeline.time > timeline.max + epsilon ||
            stepped.some(video => !Number.isFinite(video.time) || video.time < -epsilon || video.time > video.duration + epsilon))
          throw new Error('Aligned frame stepping must remain within every video timeline.');
        result.playback = { before, paused, stepped, timeline };
        if (timeline.max - timeline.min > 0.4) {
          const target = timeline.min + (timeline.max - timeline.min) * 0.55;
          await evaluate(`document.getElementById('seek').value=${JSON.stringify(String(target))};document.getElementById('seek').dispatchEvent(new Event('input'))`);
          await waitForUi(`${mediaElements}.every(video => !video.seeking && video.seekable.length > 0 && video.seekable.end(video.seekable.length - 1) >= video.currentTime)`, 'random access in every video');
          result.randomAccess = await evaluate(videoState);
        }
        await evaluate(`document.getElementById('sound').value=${JSON.stringify(String(count - 1))};document.getElementById('sound').dispatchEvent(new Event('change'));document.getElementById('rate').value='0.5';document.getElementById('rate').dispatchEvent(new Event('change'))`);
        result.audioAndRate = await evaluate("[...document.querySelectorAll('#videoGrid video')].map(video=>({muted:video.muted,rate:video.playbackRate}))");
        if (result.audioAndRate.some((video, index) => video.muted !== (index !== count - 1) || video.rate !== 0.5)) throw new Error('Only the chosen video may play audio, and playback rate must apply to every video.');
        await evaluate("document.getElementById('sound').value='none';document.getElementById('sound').dispatchEvent(new Event('change'));document.getElementById('rate').value='1';document.getElementById('rate').dispatchEvent(new Event('change'))");
      }
    }
    phase('visual-check');
    await delay(500);
    result.ui = await evaluate(`({title:document.title,text:document.body.innerText.slice(0,5000),comparisonVisible:!document.getElementById('comparePanel').hidden,
      reportVisible:!document.getElementById('reportContent').hidden,cards:document.querySelectorAll('#videoGrid .video-card').length,
      metricColumns:document.querySelectorAll('#metrics thead th').length,metricRows:document.querySelectorAll('#metrics tbody tr').length,
      horizontalOverflow:document.documentElement.scrollWidth > window.innerWidth})`);
    if (result.ui.horizontalOverflow) throw new Error('Comparison view has horizontal overflow.');
    if (latest && result.ui.metricColumns !== result.ui.cards + 1) throw new Error('Metrics must retain a column for every candidate.');
    await screenshot('-comparison'); await screenshot('');
    window.setSize(1024, 800); await delay(500);
    result.narrow = await evaluate('({width:window.innerWidth,height:window.innerHeight,horizontalOverflow:document.documentElement.scrollWidth > window.innerWidth})');
    if (result.narrow.horizontalOverflow) throw new Error('Comparison view has horizontal overflow at 1024×800.');
    await screenshot('-narrow');
    if (diagnosticConsoleErrors.length) throw new Error(`Renderer console errors: ${diagnosticConsoleErrors.join('; ').slice(0, 4000)}`);
    fs.writeFileSync(diagnosticPath, JSON.stringify(result, null, 2));
    phase('complete'); app.quit();
  } catch (error) {
    phase('failed', error.stack || error.message);
    try { await screenshot('-failed'); } catch {}
    throw error;
  }
};
