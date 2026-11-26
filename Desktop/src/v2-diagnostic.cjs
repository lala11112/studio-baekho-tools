'use strict';
// Opt-in renderer fixture diagnostic. This mode never sends a Unity command or launches AI generation.
const fs = require('node:fs');
const path = require('node:path');
const { validateGenerationInput, createPrompt } = require('./ai-candidates.cjs');
module.exports = async ({ window, app, diagnosticPath, diagnosticConsoleErrors, loadKnowledge }) => {
  fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
  const phase = name => fs.writeFileSync(diagnosticPath + '.progress.json', JSON.stringify({ phase: name, updatedUtc: new Date().toISOString() }));
  phase('knowledge');
  const evaluate = async code => {
    const result = await window.webContents.executeJavaScript(`Promise.resolve().then(()=>(${code})).then(value=>({ok:true,value}),error=>({ok:false,error:String(error?.stack||error)}))`);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const wait = async expression => {
    const deadline = Date.now() + 30000;
    while (!await evaluate(expression)) { if (Date.now() > deadline) throw new Error(`V2 fixture timeout: ${expression}`); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const knowledge = loadKnowledge('heavy');
  const parameters = [
    { id: 'step.0.camera.shake.mode', label: 'Mode', kind: 'enum', options: ['원본 유지', '끄기', '직접 설정'], minimum: 0, maximum: 2, baseline: 0, targetId: 'step.0', group: '화면 흔들림' },
    { id: 'step.0.camera.shake.amplitude', label: 'Amplitude', kind: 'number', minimum: 0, maximum: 3.4028235e38, baseline: 0.25, targetId: 'step.0', group: '화면 흔들림', useSuggestedRange: true, suggestedMinimum: 0, suggestedMaximum: 1 }
  ];
  const curves = [{ id: 'step.0.camera.shake.envelope', label: 'Envelope', minimum: 0, maximum: 1, maximumTime: 1, targetId: 'step.0', group: '화면 흔들림', keys: [{ time: 0, value: 1 }, { time: 1, value: 0 }] }];
  const request = { schemaVersion: 2, adapterId: 'diagnostic', sourceGuid: 'fixture-source', actionId: 'normal-1', durationSeconds: 3, seed: 1701, recordVideo: true, includeSourceControl: true, scenarioMode: 'fixed', precisionCapture: true, precisionTargetId: '', repeatCount: 1, sourceHash: 'fixture-source-hash', candidates: [] };
  const spec = validateGenerationInput({ schemaVersion: 2, goal: '묵직한 단발', count: 2, parameters, curves, knowledge, recipeId: 'heavy' });
  const prompt = createPrompt(spec);
  if (!prompt.includes(knowledge.guide) && !prompt.includes(JSON.stringify(knowledge.guide))) throw new Error('Packaged AI prompt is missing local guide content.');
  if (!knowledge.selectedRecipe || !prompt.includes('깊고 묵직하게') || knowledge.hash.length !== 64) throw new Error('Packaged recipe or guide hash is missing.');
  await wait('state.snapshot && !state.busy');
  phase('setup');
  await evaluate(`(() => {
    state.refreshing=true;
    const request=${JSON.stringify(request)}, parameters=${JSON.stringify(parameters)}, curves=${JSON.stringify(curves)};
    applySnapshot({projectPath:'V2 diagnostic fixture',projectName:'V2 진단',connection:{connected:true},ai:{available:true,authenticated:true,label:'진단'},knowledge:${JSON.stringify(knowledge)},runs:[],catalog:{adapters:[{id:'diagnostic',displayName:'진단 어댑터',sources:[{guid:'fixture-source',label:'진단 원본',actions:[{id:'normal-1',label:'고정 단발',available:true,parameters,curves,supportedRequestVersions:[1,2],defaultRequest:request,context:'단일 고정 대상 · 원본과 후보 비교'}]}]}]}});
    document.getElementById('addManualCandidate').click(); document.getElementById('addManualCandidate').click();
    const input=document.querySelector('#candidates input[type=number]');input.closest('details').open=true;input.value='0.75';input.dispatchEvent(new Event('input'));
    if(state.request.candidates[0].values.find(v=>v.id==='step.0.camera.shake.mode')?.value!==2)throw new Error('Direct edit did not enable owning mode.');
    validate(state.request);
  })()`);
  const output = { ok: true, mode: 'v2-fixture', guideVersion: knowledge.version, guideHash: knowledge.hash, packagedKnowledge: true, consoleErrors: diagnosticConsoleErrors };
  output.setup = await evaluate(`({cards:document.querySelectorAll('#candidates .candidate-card').length,editable:document.querySelectorAll('#candidates input').length,overflow:document.documentElement.scrollWidth>innerWidth})`);
  if (output.setup.overflow || output.setup.cards !== 2) throw new Error('V2 setup layout overflow or missing editable candidates.');
  phase('setup-screenshot');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
  fs.writeFileSync(diagnosticPath.replace(/\.json$/, '-setup.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  await evaluate("document.getElementById('candidates').scrollIntoView({block:'start'})");
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(diagnosticPath.replace(/\.json$/, '-editor.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  phase('comparison');
  await evaluate(`(() => {
    const makeImage=(label,color)=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');ctx.fillStyle='#15212d';ctx.fillRect(0,0,640,360);ctx.fillStyle=color;ctx.fillRect(270,140,100,100);ctx.fillStyle='#eef4fa';ctx.font='24px sans-serif';ctx.fillText(label,24,44);return canvas.toDataURL('image/png');};
    const capture=label=>({schemaVersion:1,precisionStatus:'complete',frames:(label==='원본'?[-0.05,0,0.075]:[-0.04,0.012,0.095]).map((relativeTimeSeconds,i)=>({captureIndex:i,unityFrameCount:i+10,unityRealtimeUs:1000000+relativeTimeSeconds*1000000,captureElapsedUs:i*40000,mediaPtsUs:i*40000,kind:'captured',relativeTimeSeconds,imageUrl:makeImage(label+' / '+i,i===2?'#e4a67a':'#91cbb7')}))});
    const request=JSON.parse(JSON.stringify(state.request));
    const metrics={hits:1,attackRequests:1,firstHitSeconds:0.5,elapsedSeconds:3,appliedValues:[],notes:[],events:[{kind:'value-limited',detail:'FOV requested=182 applied=179 reason=engine',value:179,realTime:0.5,gameTime:0.5}]};
    const control={candidate:{id:'source-control',label:'원본 그대로',values:[],isSourceControl:true},status:'completed',metrics,capture:capture('원본')};
    const report={schemaVersion:1,runId:'fixture-run',startedUtc:'2026-10-23T00:00:00Z',sourceGuid:'fixture-source',adapterId:'diagnostic',actionId:'normal-1',sourceDependencyHash:'fixture-source-hash',seed:1701,controlResult:control,results:request.candidates.flatMap(candidate=>[1,2,3].map(repeatIndex=>({candidate,status:'completed',repeatIndex,metrics,capture:capture(candidate.label)})))};
    state.reportBundle={request,report,runId:'fixture-run'};state.selectedRunId='fixture-run';drawReport(state.reportBundle);showView('compare');
  })()`);
  await wait("[...document.querySelectorAll('#precisionGrid img')].every(image=>image.complete&&image.naturalWidth===640)");
  output.comparison = await evaluate(`(() => {const winner=document.getElementById('winner');const card=document.querySelector('#precisionGrid .precision-card');const before=card.querySelector('img').src;[...card.querySelectorAll('button')].find(b=>b.textContent==='다음 캡처').click();const nextTime=precisionTime,pairedTimes=[...document.querySelectorAll('#precisionGrid .precision-card p')].map(p=>p.textContent);const select=document.getElementById('precisionCandidate');select.value='3';select.dispatchEvent(new Event('change'));return {precisionImages:document.querySelectorAll('#precisionGrid img').length,winnerOptions:winner.options.length,controlSelectable:[...winner.options].some(o=>o.value==='source-control'),stepChanged:before!==card.querySelector('img').src,time:card.querySelector('p').textContent,sharedTime:nextTime,pairedTimes,candidateChangeKeepsTime:precisionTime===nextTime,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
  if (output.comparison.controlSelectable || output.comparison.winnerOptions !== 3 || !output.comparison.stepChanged || output.comparison.overflow ||
      output.comparison.sharedTime !== 0.075 || !output.comparison.pairedTimes[1].includes('95.0ms') || !output.comparison.pairedTimes[1].includes('+20.0ms') || !output.comparison.candidateChangeKeepsTime) throw new Error('V2 comparison fixture validation failed.');
  await wait("[...document.querySelectorAll('#precisionGrid img')].every(image=>image.complete&&image.naturalWidth===640)");
  await evaluate("document.getElementById('precisionPanel').scrollIntoView({block:'start'})");
  phase('comparison-screenshot');
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(diagnosticPath.replace(/\.json$/, '-comparison.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  if (diagnosticConsoleErrors.length) throw new Error(`V2 renderer errors: ${diagnosticConsoleErrors.join('; ')}`);
  fs.writeFileSync(diagnosticPath, JSON.stringify(output, null, 2)); app.exit(0);
};
