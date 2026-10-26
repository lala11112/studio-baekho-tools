// Real Electron renderer/preload smoke. Unity and AI IPC responses are explicit test fixtures.
// This test never opens a Unity project, installs a bridge, or invokes a model.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const output = path.resolve('artifacts');
const placementOnly = process.argv.includes('--placement-only');
const reportName = placementOnly ? 'desktop-placement-report.json' : 'desktop-report.json';
const screenshotName = placementOnly ? 'desktop-placement.png' : 'desktop.png';
await mkdir(output, { recursive: true });
const userData = await mkdtemp(path.join(tmpdir(), 'baekho-enemy-desktop-'));
const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'FORGE_DEV_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
const application = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, ...(process.argv.includes('--no-gpu') ? ['--disable-gpu'] : [])], env });
const errors = [];
const observations = [];
const dialogAnswers = [];
const confirmations = [];
let page;
try {
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { const accepted=dialogAnswers.shift()??true;confirmations.push({type:dialog.type(),accepted});if(accepted)await dialog.accept();else await dialog.dismiss(); });
  await application.evaluate(({ BrowserWindow, ipcMain, dialog }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ width: 1540, height: 1000 });
    const asset = (name, kind, index, extra = {}) => ({ name, kind, guid: index.toString(16).padStart(32, '0'), localId: String(1000 + index), path: `Assets/_Project/Smoke/${name}.${kind === 'AnimationClip' ? 'anim' : kind === 'AudioClip' ? 'wav' : 'fbx'}`, ...extra });
    const alternate = asset('Alternate_Model', 'Model', 1, { rig: 'generic' });
    const drone = asset('Drone_Model', 'Model', 2, { rig: 'generic' });
    const idle = asset('Drone_Idle', 'AnimationClip', 3, { duration: 2, rig: 'generic' });
    const attackClip = asset('Drone_Attack', 'AnimationClip', 4, { duration: 1.3, rig: 'generic' });
    const controller = asset('Drone_Controller', 'AnimatorController', 5);
    const sound = asset('Attack_Sound', 'AudioClip', 6);
    const number = (name, min = 0) => ({ path: name, label: name, type: 'number', min });
    const vec = name => ({ path: name, label: name, type: 'vector3' });
    const common = [{ path: 'animName', label: 'State', type: 'string' }, number('attackSpeed', .01), number('executeRange'), number('weight'), { path: 'isParryable', label: 'Parry', type: 'boolean' }];
    const definitions = [
      { typeId: 'MonsterDefaultAttackSO', name: '기본 공격', category: 'normal', description: '모의 기본 공격', previewSupported: true,
        fields: [...common, number('damage'), number('hitStartTime'), number('hitDuration'), number('attackDuration'), { path: 'hitBoxShape', label: 'Shape', type: 'enum', options: [{ label: 'Sphere', value: 0 }, { label: 'Box', value: 1 }, { label: 'Capsule', value: 2 }] }, vec('hitBoxOffset'), number('hitBoxRadius'), { path: 'SwingAudio', label: 'Audio', type: 'object', children: [{ path: 'Clip', label: 'Clip', type: 'asset', assetType: 'AudioClip' }, number('Volume')] }],
        defaults: { animName: 'Attack', attackSpeed: 1, executeRange: 2, weight: 100, isParryable: true, damage: .5, hitStartTime: .5, hitDuration: .2, attackDuration: 1.3, hitBoxShape: 0, hitBoxOffset: [0, 0, 1], hitBoxRadius: 1.5, SwingAudio: { Clip: null, Volume: .42 } } },
      { typeId: 'MonsterComboAttackSO', name: '콤보 공격', category: 'normal', description: '다중 타격 모의 공격', previewSupported: true,
        fields: [...common, number('baseDamage'), number('attackDuration'), { path: 'hits', label: 'Hits', type: 'array', children: [number('hitStartTime'), number('hitDuration', .01), vec('hitBoxOffset')] }, { path: 'weights', label: 'Scalar weights', type: 'array', element: { path: 'data', label: 'Weight value', type: 'number', min: 0 } }, { path: 'points', label: 'Vector points', type: 'array', element: { path: 'data', label: 'Point value', type: 'vector3' } }, { path: 'flags', label: 'Boolean flags', type: 'array', element: { path: 'data', label: 'Flag value', type: 'boolean' } }, { path: 'modes', label: 'Enum modes', type: 'array', element: { path: 'data', label: 'Mode value', type: 'enum', options: [{ label: 'First', value: 10 }, { label: 'Second', value: 20 }] } }],
        defaults: { animName: 'Combo', attackSpeed: 1, executeRange: 2, weight: 30, isParryable: true, baseDamage: 1, attackDuration: 2, hits: [{ hitStartTime: .2, hitDuration: .1, hitBoxOffset: [0, 0, 1] }], weights: [.3, .7], points: [[0, 0, 1]], flags: [], modes: [10] } },
      { typeId: 'MonsterSelfDestructSO', name: '자폭', category: 'selfDestruct', description: '모의 자폭 공격', previewSupported: true, fields: [...common, number('explosionDelay'), number('explosionRadius')], defaults: { animName: 'SelfDestruct', attackSpeed: 1, executeRange: 2, weight: 0, isParryable: false, explosionDelay: 2, explosionRadius: 3 } },
    ];
    const blueprint = { version: 1, name: 'Drone', template: asset('Drone', 'GameObject', 7), model: drone, modelTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, stats: { maxHp: 1500, baseAtk: 10, criticalChance: .1 }, components: { NavMeshAgent: { m_Speed: 3.5, m_StoppingDistance: .2 }, FanVisionSensor: { _range: 10 } }, animation: { mode: 'clips', controller, states: { Idle: idle, Move: idle, Groggy: idle, Attack: attackClip } }, attacks: [{ id: 'fixture-basic', typeId: definitions[0].typeId, values: structuredClone(definitions[0].defaults) }], selfDestruct: null, hpBarPosition: [0, 3, 0], vfxPosition: [0, 1, 0] };
    const state = globalThis.enemyDesktopSmoke = { catalog: { projectRoot: 'C:/Smoke/UnityProject', unityVersion: '6000.3.10f1', assets: [alternate, drone, idle, attackClip, controller, sound], attacks: definitions, statsFields: [number('maxHp'), number('baseAtk'), { ...number('criticalChance'), min: 0, max: 1, percent: true }], componentFields: { NavMeshAgent: [number('m_Speed'), number('m_StoppingDistance')], FanVisionSensor: [number('_range')] }, template: blueprint, warnings: [] }, saved: [], validates: [], builds: [], previews: [], closed: [], opened: 0, openRequests:0, chooseRequests:0, aiCalls: [], conceptCalls:[],analyses:[],animationInfos:[],analysisMode:'normal',holdAnalysis:false,heldAnalysis:false, revealed: [], validationMode: 'valid', buildMode: 'complete', aiMode: 'fail',conceptMode:'fail',holdConcept:false,heldConcept:false, previewMode:'normal',holdNextFrame:false,heldFrame:false,confirmAnswers:[],confirmations:[] };
    const analysisWaiters=[];
    globalThis.releaseHeldAnalyses=()=>{state.holdAnalysis=false;state.heldAnalysis=false;for(const resolve of analysisWaiters.splice(0))resolve();};
    // Cover native Electron dialogs as well as Playwright's dialog events across runtime versions.
    dialog.showMessageBoxSync=(_window,options)=>{const accepted=state.confirmAnswers.shift()??true;const settings=options??_window;state.confirmations.push({accepted,message:settings?.message,buttons:settings?.buttons,cancelId:settings?.cancelId});const cancel=Number.isInteger(settings?.cancelId)?settings.cancelId:Math.max(0,settings?.buttons?.findIndex(label=>/cancel|취소/i.test(label))??0);return accepted?(settings?.buttons?.findIndex((_label,index)=>index!==cancel)??1):cancel;};
    const handlers = {
      connect: () => ({ projectRoot: state.catalog.projectRoot, projectName: 'Desktop Smoke Fixture', unityVersion: '6000.3.10f1', instanceId: 'mock-editor' }),
      'choose-project': () => {state.chooseRequests++;return state.catalog.projectRoot;},
      install: () => { throw new Error('Desktop smoke must not install a Unity bridge.'); },
      catalog: () => state.catalog,
      'assets-search': (_event, query, kinds) => {const assets=state.catalog.assets.filter(a=>(!kinds.length||kinds.includes(a.kind))&&(a.name+' '+a.path).toLowerCase().includes(query.toLowerCase()));return {assets,total:assets.length,truncated:false};},
      'animation-info': (_event, reference) => {state.animationInfos.push(structuredClone(reference));return {parameters:[{name:'MotionX',type:'Float'},{name:'MotionY',type:'Float'},{name:'CanAttack',type:'Bool'}],move:null,warnings:[]};},
      'analyze-model': async (_event, b) => {state.analyses.push(structuredClone(b));if(state.holdAnalysis){state.heldAnalysis=true;await new Promise(resolve=>analysisWaiters.push(resolve));}if(state.analysisMode==='fail')throw new Error('모의 모델 분석 연결 실패');if(state.analysisMode==='empty')return {bounds:null,hpBarPosition:b.hpBarPosition,vfxPosition:b.vfxPosition,warnings:['모의 메시 분석 실패: 기존 위치를 유지합니다.']};const [x,y,z]=b.modelTransform.position,height=2*b.modelTransform.scale[1];return {bounds:{min:[x-.5,y,z-.5],max:[x+.5,y+height,z+.5],center:[x,y+height/2,z],size:[1,height,1]},hpBarPosition:[x,y+height+.25,z],vfxPosition:[x,y+height/2,z],warnings:[]};},
      save: (_event, b) => { state.saved.push(structuredClone(b)); return 'C:/Smoke/Enemy.enemyforge.json'; },
      open: () => {state.openRequests++;return state.saved.at(-1) ?? null;},
      validate: (_event, b) => { state.validates.push(structuredClone(b)); return state.validationMode === 'valid' ? { valid: true, issues: [] } : { valid: false, issues: [{ severity: 'error', path: 'animation', message: '모의 Rig 불일치: 클립을 다시 선택하세요.' }] }; },
      build: async (_event, b) => { state.builds.push(structuredClone(b)); await new Promise(resolve => setTimeout(resolve, 150)); return state.buildMode === 'complete' ? { requestId: 'mock-build', state: 'completed', prefabPath: 'Assets/Baekho/Generated/Enemies/Drone_New/Drone_New.prefab', assets: [] } : { requestId: 'mock-build-failed', state: 'failed', error: '모의 생성 실패: 결과 에셋은 저장하지 않았습니다.' }; },
      'preview-open': () => ({ sessionId: `fixture-preview-${++state.opened}` }),
      'preview-frame': (_event, request) => { state.previews.push({ sessionId:request.sessionId,sequence: request.sequence, time: request.time, yaw: request.yaw, pitch: request.pitch, zoom: request.zoom, attackId: request.attackId, showHitboxes: request.showHitboxes,state:request.state,moveParameters:request.moveParameters }); if (state.previews.length > 300) state.previews.shift();if(state.previewMode==='expired')throw new Error('모의 미리보기 세션이 만료되었습니다.');if(state.holdNextFrame){state.holdNextFrame=false;state.heldFrame=true;return new Promise((_resolve,reject)=>{globalThis.rejectHeldPreview=()=>{state.heldFrame=false;reject(new Error('모의 이전 세션 프레임 실패'));};});} return { sequence: request.sequence, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', warning: '모의 데스크톱 응답 · 실제 Unity 모델 렌더링은 별도 검증합니다.' }; },
      'preview-close': (_event, sessionId) => { state.closed.push(sessionId); return {}; },
      'ai-status': () => ({ state: 'ready', message: '모의 Codex 연결 · 실제 AI 호출 없음', models: [{ id: 'fixture-model', name: 'Fixture Model' }] }),
      'ai-login': () => undefined,
      'ai-select': () => ({ state: 'missing', message: '모의 실행 파일 없음', models: [] }),
      'ai-cancel': () => undefined,
      'ai-concept': async (_event, request) => {
        state.conceptCalls.push(structuredClone(request));
        window.webContents.send('forge:progress',{stage:'컨셉 분석',message:'모의 몬스터 컨셉을 구성합니다.'});
        if(state.holdConcept){state.heldConcept=true;await new Promise(resolve=>{globalThis.releaseHeldConcept=()=>{state.heldConcept=false;state.holdConcept=false;resolve();};});}
        else await new Promise(resolve=>setTimeout(resolve,120));
        if(state.conceptMode==='fail')throw new Error('모의 컨셉 구성 실패: 현재 설계는 유지합니다.');
        const configured=structuredClone(request.blueprint);configured.stats.maxHp=3100;configured.components.NavMeshAgent.m_Speed=1.8;configured.components.FanVisionSensor._range=7;
        configured.attacks=[{id:'concept-attack',typeId:definitions[0].typeId,values:{...structuredClone(definitions[0].defaults),animName:'ConceptSlam',damage:2.8}}];configured.selfDestruct=null;
        configured.animation.states.ConceptSlam=structuredClone(configured.animation.states.Attack??idle);
        return {blueprint:configured,summary:'모의 바위 수호자 구성 완료',reasons:['높은 체력과 느린 이동으로 수호자 역할을 구성했습니다.'],warnings:['모의 컨셉 안내'],attacks:[{attackId:'concept-attack',typeId:definitions[0].typeId,summary:'내려찍기 구성',files:[],configuredExisting:true,existingValues:configured.attacks[0].values}]};
      },
      'ai-generate': async (_event, request) => {
        state.aiCalls.push(structuredClone(request));
        window.webContents.send('forge:progress', { stage: '정적 검증', message: '모의 공격 C#을 검증합니다.', attempt: 1 });
        await new Promise(resolve => setTimeout(resolve, 120));
        if (state.aiMode === 'fail') throw new Error('모의 컴파일 오류 CS0246: 공격 초안을 확인하세요.');
        if(state.aiMode==='existing')return {attackId:'mock-existing-config',typeId:definitions[0].typeId,summary:'기존 기본 공격 배율 구성',files:[],configuredExisting:true,existingValues:{...structuredClone(definitions[0].defaults),damage:.75}};
        if(state.aiMode==='existing-bomb')return {attackId:'mock-existing-bomb',typeId:definitions[2].typeId,summary:'기존 자폭 반경 구성',files:[],configuredExisting:true,existingValues:{...structuredClone(definitions[2].defaults),explosionRadius:5}};
        const generated = { typeId: 'StudioBaekho.Generated.SmokeAttackSO', name: 'AI 모의 탄환 공격', category: 'normal', description: '실제 코드를 생성하지 않는 UI 검증용 공격', previewSupported: true, preview:{shapes:[{shape:'sphere',start:1,end:4.3,radius:1}]}, generated: true, fields: [...common, number('damage')], defaults: { animName: 'AIGenerated', attackSpeed: 1, executeRange: 8, weight: 20, isParryable: true, damage: 2 } };
        if (!state.catalog.attacks.some(a => a.typeId === generated.typeId)) state.catalog.attacks.push(generated);
        return { attackId: 'mock-ai-attack', typeId: generated.typeId, summary: '모의 새 공격 등록', files: [] };
      },
      reveal: (_event, relative) => { state.revealed.push(relative); },
    };
    for (const [name, handler] of Object.entries(handlers)) { ipcMain.removeHandler(`forge:${name}`); ipcMain.handle(`forge:${name}`, handler); }
  });
  await page.reload();
  const action = name => page.locator(`[data-action="${name}"]`).first();
  const nav = name => page.locator(`[data-tab="${name}"]`);
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'));
  const snapshot = () => application.evaluate(() => globalThis.enemyDesktopSmoke);
  const waitState = async predicate => { const until=Date.now()+15000;while(Date.now()<until){const state=await snapshot();if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Desktop fixture state did not settle.'); };
  const setMode = (field, value) => application.evaluate((_electron, { field, value }) => { globalThis.enemyDesktopSmoke[field] = value; }, { field, value });
  const fieldInput = text => page.locator('.field > span').filter({ hasText: new RegExp(`^${text}(?:\\s*%)?$`) }).first().locator('..').locator('input').first();
  const editNumber = async (label, value) => { const input = fieldInput(label); await input.fill(String(value)); await input.press('Tab'); };
  const saveSnapshot = async () => { await action('save').click(); await idle(); return (await snapshot()).saved.at(-1); };
  const chooseFirstAsset = async button => { await button.click(); await page.locator('#asset-dialog[open]').waitFor(); await page.locator('[data-asset-index="0"]').click(); await page.waitForFunction(() => !document.querySelector('#asset-dialog')?.open); };
  const mapState = async state => { const row = page.locator('.animation-field').filter({ has: page.locator('b', { hasText: new RegExp(`^${state}$`) }) }); await chooseFirstAsset(row.locator('.asset-input')); };
  const vectorInputs = label => page.locator('.field > span').filter({hasText:new RegExp(`^${label}$`)}).first().locator('..').locator('input');
  const waitVector = (label,index,value) => page.waitForFunction(({label,index,value})=>{const row=[...document.querySelectorAll('.field')].find(el=>el.querySelector(':scope > span')?.textContent===label);return row?.querySelectorAll('input')[index]?.value===String(value);},{label,index,value});
  const mapMoveChildren = async () => {for(let i=0;i<await page.locator('.blend-child').count();i++)await chooseFirstAsset(page.locator('.blend-child').nth(i).locator('.asset-input'));};
  const testPlacementRecovery = async () => {
    await nav('appearance').click();await vectorInputs('체력바').nth(1).fill('9');
    const initialScale=Number(await vectorInputs('크기').nth(1).inputValue());
    await page.locator('[data-anchor-mode="vfx"]').selectOption('auto');await waitVector('피격 효과',1,initialScale);
    await setMode('analysisMode','fail');await vectorInputs('크기').nth(1).fill(String(initialScale+1));
    await page.waitForFunction(()=>document.querySelector('#inspector-body')?.textContent?.includes('모의 모델 분석 연결 실패'));
    const failedCalls=(await snapshot()).analyses.length;await setMode('analysisMode','normal');
    const recovered=await saveSnapshot();assert.ok((await snapshot()).analyses.length>failedCalls);
    assert.equal(recovered.vfxPosition[1],initialScale+1);assert.equal(recovered.hpBarPosition[1],9);
    assert.doesNotMatch(await page.locator('#inspector-body').innerText(),/모의 모델 분석 연결 실패/);
    await setMode('analysisMode','empty');await vectorInputs('크기').nth(1).fill(String(initialScale+2));
    await page.waitForFunction(()=>document.querySelector('#inspector-body')?.textContent?.includes('모의 메시 분석 실패'));
    const preserved=await saveSnapshot();assert.equal(preserved.vfxPosition[1],initialScale+1);assert.equal(preserved.hpBarPosition[1],9);
    assert.match(await page.locator('#inspector-body').innerText(),/모의 메시 분석 실패.*기존 위치/);
    await setMode('analysisMode','normal');const retried=await saveSnapshot();
    assert.equal(retried.vfxPosition[1],initialScale+2);assert.equal(retried.hpBarPosition[1],9);
    observations.push('Automatic placement retries a transient analysis failure on immediate save and applies fresh transformed coordinates');
    observations.push('Unavailable geometry preserves manual and previous automatic positions with a visible warning, then retries successfully');
  };

  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.forge?.previewFrame), 'function');
  assert.equal(await page.locator('.nav-item').count(), 7);
  await action('build').click(); await idle();
  assert.match(await page.locator('#issues').innerText(), /모델을 선택|클립을 지정/);
  assert.equal((await snapshot()).builds.length, 0);
  observations.push('Sandboxed preload and required-setting rejection before project connection');

  await action('connect').click(); await idle();
  await page.waitForFunction(() => document.querySelector('#enemy-title')?.textContent === 'Drone_New');
  await page.waitForFunction(() => !document.querySelector('#preview-image')?.hidden);
  assert.match(await page.locator('.project-status').innerText(), /Desktop Smoke Fixture/);
  for (const tab of ['stats', 'movement', 'attacks', 'animation', 'appearance']) { await nav(tab).click(); assert.equal(await nav(tab).getAttribute('class'), 'nav-item active'); }
  observations.push('Connected catalog and all inspector tabs');

  if(placementOnly)await testPlacementRecovery();
  else {

  await nav('stats').click();
  await editNumber('최대 체력', 2400);
  await editNumber('치명타 확률', 25);
  for(const command of ['reset','open','choose-project']){dialogAnswers.push(false);await application.evaluate(()=>globalThis.enemyDesktopSmoke.confirmAnswers.push(false));await action(command).click();await idle();assert.equal(await fieldInput('최대 체력').inputValue(),'2400',JSON.stringify({command,confirmations,fixture:(await snapshot()).confirmations}));assert.equal(await page.locator('#dirty').innerText(),'수정됨');}
  assert.equal((await snapshot()).openRequests,0);assert.equal((await snapshot()).chooseRequests,0);
  observations.push('Canceling discard confirmation preserves unsaved edits for reset/open/project change');
  let saved = await saveSnapshot();
  assert.equal(saved.stats.maxHp, 2400);
  assert.equal(saved.stats.criticalChance, .25);
  await nav('movement').click();
  await editNumber('이동 속도', 6);
  assert.equal((await saveSnapshot()).components.NavMeshAgent.m_Speed, 6);
  observations.push('Dynamic numeric fields and percentage conversion');

  await nav('animation').click();
  await page.getByRole('button',{name:'방향 2D 블렌드 트리로 전환',exact:true}).click();
  await page.locator('#move-parameters option[value="MotionX"]').waitFor({state:'attached'});
  assert.equal(await page.locator('#move-parameters option[value="CanAttack"]').count(),0);
  await page.locator('[data-move-param="parameterX"]').fill('MotionX');
  await page.locator('[data-move-param="parameterY"]').fill('MotionY');
  const initialChildren=await page.locator('.blend-child').count();assert.equal(initialChildren,5);
  await page.getByRole('button',{name:'+ 방향 클립 추가',exact:true}).click();
  assert.equal(await page.locator('.blend-child').count(),initialChildren+1);
  const addedChild=page.locator('.blend-child').last();
  await chooseFirstAsset(addedChild.locator('.asset-input'));
  await addedChild.getByText('방향 좌표',{exact:true}).locator('..').locator('input').nth(0).fill('2');
  await addedChild.getByText('재생 배속',{exact:true}).locator('..').locator('input').fill('.75');
  saved=await saveSnapshot();
  assert.equal(saved.animation.move.parameterX,'MotionX');assert.equal(saved.animation.move.parameterY,'MotionY');
  assert.deepEqual(saved.animation.move.children.at(-1).position,[2,1]);assert.equal(saved.animation.move.children.at(-1).timeScale,.75);
  await addedChild.getByTitle('방향 삭제').click();assert.equal(await page.locator('.blend-child').count(),initialChildren);
  await mapMoveChildren();
  await page.locator('#preview-clip').selectOption('Move');
  await page.locator('#move-preview-0').fill('0.5');await page.locator('#move-preview-1').fill('-0.75');
  await waitState(state=>state.previews.at(-1)?.state==='Move'&&state.previews.at(-1)?.moveParameters?.[0]===.5&&state.previews.at(-1)?.moveParameters?.[1]===-.75);
  const blended=await saveSnapshot();await action('open').click();await idle();await nav('animation').click();
  assert.equal(await page.locator('[data-move-param="parameterX"]').inputValue(),'MotionX');
  assert.deepEqual((await saveSnapshot()).animation.move,blended.animation.move);
  observations.push('Legacy Move opt-in, Float parameter choices, direction child add/edit/remove, XY preview requests and Blend Tree save/open round trip');

  await nav('appearance').click();
  assert.equal(await page.locator('[data-anchor-mode="hpBar"]').inputValue(),'manual');
  assert.equal(await page.locator('[data-anchor-mode="vfx"]').inputValue(),'manual');
  assert.equal((await snapshot()).analyses.length,0);
  await page.locator('[data-anchor-mode="hpBar"]').selectOption('auto');await waitVector('체력바',1,2.25);
  await page.locator('[data-anchor-mode="vfx"]').selectOption('auto');await waitState(state=>state.analyses.length>=2);
  await vectorInputs('크기').nth(1).fill('2');await waitVector('체력바',1,4.25);await waitVector('피격 효과',1,2);
  await vectorInputs('체력바').nth(1).fill('9');
  assert.equal(await page.locator('[data-anchor-mode="hpBar"]').inputValue(),'manual');
  await vectorInputs('크기').nth(1).fill('3');await waitVector('피격 효과',1,3);
  saved=await saveSnapshot();assert.equal(saved.hpBarPosition[1],9);assert.equal(saved.vfxPosition[1],3);
  assert.deepEqual(saved.anchors,{hpBar:'manual',vfx:'auto'});
  observations.push('Legacy anchors retain manual values; automatic anchors follow transformed geometry and manual edits remain protected');

  let savesBeforePlacement=(await snapshot()).saved.length;
  await setMode('holdAnalysis',true);await vectorInputs('크기').nth(1).fill('4');await action('save').click();
  await waitState(state=>state.heldAnalysis);
  assert.equal(await action('save').isDisabled(),true);assert.equal((await snapshot()).saved.length,savesBeforePlacement);
  await application.evaluate(()=>globalThis.releaseHeldAnalyses());await idle();
  saved=(await snapshot()).saved.at(-1);assert.equal(saved.vfxPosition[1],4);assert.equal(saved.hpBarPosition[1],9);
  savesBeforePlacement=(await snapshot()).saved.length;
  await setMode('holdAnalysis',true);await page.locator('[data-anchor-mode="hpBar"]').selectOption('auto');await action('save').click();
  await waitState(state=>state.heldAnalysis);
  assert.equal(await action('save').isDisabled(),true);assert.equal((await snapshot()).saved.length,savesBeforePlacement);
  await application.evaluate(()=>globalThis.releaseHeldAnalyses());await idle();
  saved=(await snapshot()).saved.at(-1);assert.equal(saved.hpBarPosition[1],8.25);assert.equal(saved.anchors.hpBar,'auto');
  await vectorInputs('체력바').nth(1).fill('9');await saveSnapshot();
  observations.push('Immediate save waits for pending automatic placement after a scale edit and after toggling auto at unchanged geometry');
  await testPlacementRecovery();

  await nav('attacks').click();
  await page.locator('#add-attack-type').selectOption('MonsterComboAttackSO');
  await action('add-attack').click();
  const arrayGroup = label => page.locator('details.subgroup').filter({ has: page.locator(':scope > summary', { hasText: label }) });
  const hits = arrayGroup('연속 타격');
  await hits.locator('.array-item').first().getByText('판정 시작', { exact: true }).locator('..').locator('input').fill('.45');
  await hits.locator('.array-item').first().getByText('판정 위치', { exact: true }).locator('..').locator('input').nth(0).fill('0.35');
  await hits.getByRole('button', { name: '+ 항목 추가', exact: true }).click();
  assert.equal(await hits.locator('.array-item').count(), 2);
  await hits.locator('.array-item').nth(1).getByText('판정 시작', { exact: true }).locator('..').locator('input').fill('1.2');
  saved = await saveSnapshot();
  assert.equal(saved.attacks[1].values.hits[0].hitStartTime, .45);
  assert.deepEqual(saved.attacks[1].values.hits[0].hitBoxOffset, [.35, 0, 1]);
  assert.equal(saved.attacks[1].values.hits[1].hitStartTime, 1.2);
  assert.ok(Array.isArray(saved.attacks[1].values.hits[1].hitBoxOffset));
  await hits.locator('.array-item').nth(1).getByTitle('항목 삭제').click();
  assert.equal(await hits.locator('.array-item').count(), 1);
  const weights = arrayGroup('Scalar weights');
  await weights.locator('input').nth(0).fill('0.4'); await weights.locator('input').nth(1).fill('0.6');
  await weights.getByRole('button', { name: '+ 항목 추가', exact: true }).click();
  assert.equal(await weights.locator('input').nth(2).inputValue(), '0');
  await weights.locator('.array-item').nth(2).getByTitle('항목 삭제').click();
  const points = arrayGroup('Vector points');
  await points.locator('input').nth(0).fill('1.5'); await points.locator('input').nth(1).fill('2');
  const flags = arrayGroup('Boolean flags');
  await flags.getByRole('button', { name: '+ 항목 추가', exact: true }).click();
  await flags.locator('.toggle-field').click();
  assert.equal(await flags.locator('input[type="checkbox"]').isChecked(), true);
  await arrayGroup('Enum modes').locator('select').selectOption('20');
  saved = await saveSnapshot();
  assert.deepEqual(saved.attacks[1].values.weights, [.4, .6]);
  assert.deepEqual(saved.attacks[1].values.points, [[1.5, 2, 1]]);
  assert.deepEqual(saved.attacks[1].values.flags, [true]);
  assert.deepEqual(saved.attacks[1].values.modes, [20]);
  await page.locator('#add-attack-type').selectOption('MonsterSelfDestructSO'); await action('add-attack').click();
  await page.locator('#add-attack-type').selectOption('MonsterSelfDestructSO');
  await action('add-attack').click();
  assert.match(await page.locator('#status-text').innerText(), /하나만/);
  assert.equal((await saveSnapshot()).selfDestruct.typeId, 'MonsterSelfDestructSO');
  observations.push('Object, number, vector, boolean and enum arrays plus single self-destruct enforcement');

  await page.locator('[data-attack="fixture-basic"]').click();
  await page.getByText('판정 모양', { exact: true }).locator('..').locator('select').selectOption('1');
  await page.locator('.subgroup > summary').filter({ hasText: '공격 소리' }).click();
  await chooseFirstAsset(page.locator('.subgroup').filter({ has: page.locator('summary', { hasText: '공격 소리' }) }).locator('.asset-input'));
  saved = await saveSnapshot();
  assert.equal(saved.attacks[0].values.hitBoxShape, 1);
  assert.equal(saved.attacks[0].values.SwingAudio.Clip.name, 'Attack_Sound');
  observations.push('Enum and nested object asset editing, including asset choice index zero');

  await nav('appearance').click();
  await chooseFirstAsset(page.locator('#inspector-body > .field').filter({ has: page.locator('span', { hasText: /^모델$/ }) }).locator('.asset-input'));
  saved = await saveSnapshot();
  assert.equal(saved.model.name, 'Alternate_Model');
  assert.equal(saved.animation.controller, null);
  assert.ok(Object.values(saved.animation.states).every(value => value === null));
  assert.ok(saved.animation.move.children.every(child=>child.clip===null));
  await waitState(state=>state.analyses.at(-1)?.model?.name==='Alternate_Model');
  await action('build').click(); await idle();
  assert.equal((await snapshot()).builds.length, 0);
  assert.match(await page.locator('#issues').innerText(), /클립/);
  observations.push('Model switch clears controller and clip mappings and blocks incomplete generation');

  await nav('animation').click();
  for (const state of ['Idle', 'Groggy', 'Attack', 'Combo', 'SelfDestruct']) await mapState(state);
  await mapMoveChildren();
  assert.equal((await saveSnapshot()).animation.states.Attack.name, 'Drone_Idle');
  await page.locator('#preview-clip').selectOption('Attack');
  await page.locator('#timeline').fill('0.6');
  await page.waitForFunction(() => document.querySelector('#time-label')?.textContent?.startsWith('0.60'));
  const beforeOrbit = (await snapshot()).previews.at(-1);
  const viewport = await page.locator('#viewport').boundingBox();
  assert.ok(viewport);
  await page.mouse.move(viewport.x + viewport.width * .5, viewport.y + viewport.height * .5);
  await page.mouse.down(); await page.mouse.move(viewport.x + viewport.width * .6, viewport.y + viewport.height * .55, { steps: 5 }); await page.mouse.up();
  await page.mouse.wheel(0, -150);
  const afterOrbit = (await waitState(state=>state.previews.at(-1)?.yaw!==beforeOrbit.yaw&&state.previews.at(-1)?.zoom!==beforeOrbit.zoom)).previews.at(-1);
  assert.notEqual(afterOrbit.yaw, beforeOrbit.yaw);
  assert.notEqual(afterOrbit.zoom, beforeOrbit.zoom);
  await page.locator('#hitboxes').uncheck();
  await waitState(state=>state.previews.at(-1)?.showHitboxes===false);
  assert.equal((await snapshot()).previews.at(-1).showHitboxes, false);
  await page.locator('#hitboxes').check();
  await action('play').click(); await waitState(state=>state.previews.at(-1)?.time!==.6); await action('play').click();
  assert.notEqual((await snapshot()).previews.at(-1).time, .6);
  await page.locator('#preview-loop').uncheck();await page.locator('#timeline').fill('1.95');await action('play').click();
  await page.waitForFunction(()=>document.querySelector('#time-label')?.textContent?.startsWith('2.00')&&document.querySelector('[data-action="play"]')?.textContent==='▶');
  await action('play').click();await page.waitForFunction(()=>document.querySelector('[data-action="play"]')?.textContent==='Ⅱ'&&!document.querySelector('#time-label')?.textContent?.startsWith('2.00'));await action('play').click();await page.locator('#preview-loop').check();
  await page.locator('[data-mode="controller"]').click();await page.waitForFunction(()=>document.querySelector('#preview-warning')?.textContent?.includes('컨트롤러 상태·전환·Blend Tree'));
  await page.locator('[data-mode="clips"]').click();
  observations.push('Clip mapping, timeline seek, playback, orbit, zoom and hitbox-toggle requests');
  observations.push('Nonrepeating playback stops at the end and restarts; controller sampling limits are explicit');

  await nav('ai').click();
  await page.getByText('모의 Codex 연결 · 실제 AI 호출 없음', { exact: true }).waitFor();
  await page.locator('#ai-prompt').fill('플레이어를 향해 탄환을 세 발 발사하는 공격');
  await page.locator('#ai-model').selectOption('fixture-model');
  await action('ai-generate').click(); await idle();
  assert.match(await page.locator('#status-text').innerText(), /모의 컴파일 오류 CS0246/);
  assert.equal(await page.locator('#ai-prompt').inputValue(), '플레이어를 향해 탄환을 세 발 발사하는 공격');
  assert.equal(await action('ai-generate').isEnabled(), true);
  assert.match(await page.locator('#ai-log').innerText(), /모의 공격 C#/);
  await setMode('aiMode', 'complete');
  await action('ai-generate').click(); await idle();
  assert.match(await page.locator('#status-text').innerText(), /새 공격 등록 완료/);
  assert.equal(await page.locator('.attack-row').count(), 4);
  assert.match(await page.locator('#inspector-heading').innerText(), /공격/);
  assert.equal((await snapshot()).aiCalls.at(-1).model, 'fixture-model');
  observations.push('AI progress/error recovery and successful generated-type catalog refresh without real AI calls');

  await nav('animation').click(); await mapState('AIGenerated');
  await page.waitForFunction(()=>document.querySelector('#timeline')?.getAttribute('max')==='4.3');
  await page.locator('#timeline').fill('4.2');await page.waitForFunction(()=>document.querySelector('#time-label')?.textContent?.startsWith('4.20'));
  observations.push('Generated attack preview timeline includes its complete declared 4.3-second lifetime');
  await nav('ai').click();await setMode('aiMode','existing');await action('ai-generate').click();await idle();
  assert.match(await page.locator('#status-text').innerText(),/기존 공격 설정 적용 완료/);
  assert.equal(await page.locator('.attack-row').count(),5);
  assert.equal((await snapshot()).catalog.attacks.filter(a=>a.typeId==='MonsterDefaultAttackSO').length,1);
  const configured=await saveSnapshot();assert.equal(configured.attacks.at(-1).values.damage,.75);
  await nav('ai').click();await setMode('aiMode','existing-bomb');await action('ai-generate').click();await idle();
  const configuredBomb=await saveSnapshot();assert.equal(configuredBomb.selfDestruct.id,configured.selfDestruct.id);assert.equal(configuredBomb.selfDestruct.values.explosionRadius,5);assert.equal(await page.locator('.attack-row').count(),5);
  observations.push('AI existing configurations apply returned values without duplicate types and preserve the single self-destruct slot');
  await setMode('validationMode', 'invalid');
  await action('build').click(); await idle();
  assert.equal((await snapshot()).builds.length, 0);
  assert.match(await page.locator('#issues').innerText(), /모의 Rig 불일치/);
  await setMode('validationMode', 'valid');
  await setMode('buildMode', 'fail');
  await action('build').click(); await idle();
  assert.match(await page.locator('#status-text').innerText(), /모의 생성 실패/);
  await setMode('buildMode', 'complete');
  await action('build').click(); await idle();
  assert.match(await page.locator('#status-text').innerText(), /생성 완료.*Drone_New\.prefab/);
  await page.getByRole('button', { name: '생성 폴더 열기 ↗' }).click();
  assert.equal((await snapshot()).revealed.at(-1), 'Assets/Baekho/Generated/Enemies/Drone_New/Drone_New.prefab');
  observations.push('Unity validation rejection, failed build recovery, completed result and reveal IPC');

  saved = await saveSnapshot();
  await nav('stats').click();
  await editNumber('최대 체력', 999);
  await action('open').click(); await idle();
  await nav('stats').click();
  assert.equal(await fieldInput('최대 체력').inputValue(), '2400');
  assert.equal(saved.attacks.length, 4);
  assert.equal(saved.selfDestruct.typeId, 'MonsterSelfDestructSO');
  observations.push('Blueprint save/open round trip and edited-data preservation');
  await setMode('previewMode','expired');await page.locator('#timeline').fill('0.7');
  await page.waitForFunction(()=>!document.querySelector('#preview-empty')?.hidden&&document.querySelector('#preview-warning')?.textContent?.includes('만료'));
  assert.equal(await page.locator('#preview-image').getAttribute('src'),null);
  await setMode('previewMode','normal');await action('play').click();
  await page.waitForFunction(()=>!document.querySelector('#preview-image')?.hidden&&document.querySelector('[data-action="play"]')?.textContent==='Ⅱ'&&Number(document.querySelector('#time-label')?.textContent?.split(' / ')[0])>.05);
  await action('play').click();
  await setMode('holdNextFrame',true);await page.locator('#timeline').fill('0.8');
  const held=await waitState(state=>state.heldFrame);const oldSession=held.previews.at(-1).sessionId;
  await action('connect').click();await idle();await waitState(state=>state.previews.at(-1)?.sessionId!==oldSession);
  await page.waitForFunction(()=>!document.querySelector('#preview-image')?.hidden);
  await application.evaluate(()=>globalThis.rejectHeldPreview?.());await page.waitForTimeout(100);
  assert.equal(await page.locator('#preview-image').isVisible(),true);
  assert.doesNotMatch(await page.locator('#preview-warning').innerText(),/이전 세션 프레임 실패/);
  await page.locator('#timeline').fill('0.9');await waitState(state=>state.previews.at(-1)?.time===.9);
  observations.push('Expired preview clears stale pixels; Play reconnects and an old failed frame cannot kill the replacement session');
  await page.waitForTimeout(200);const beforeHeartbeat=(await snapshot()).previews.at(-1);
  await page.waitForTimeout(15300);
  const afterHeartbeat=(await snapshot()).previews.at(-1);assert.ok(afterHeartbeat.sequence>beforeHeartbeat.sequence);assert.equal(afterHeartbeat.time,beforeHeartbeat.time);
  observations.push('Idle preview sends a 15-second keepalive frame without changing the selected pose');

  const beforeConcept=await saveSnapshot();
  await nav('concept').click();
  await page.locator('#concept-prompt').fill('느리지만 단단한 바위 수호자. 가까운 적을 강하게 내려찍는다.');
  await action('ai-concept').click();await idle();
  assert.match(await page.locator('#status-text').innerText(),/모의 컨셉 구성 실패/);
  assert.equal(await page.locator('#concept-prompt').inputValue(),'느리지만 단단한 바위 수호자. 가까운 적을 강하게 내려찍는다.');
  assert.deepEqual(await saveSnapshot(),beforeConcept);
  await setMode('conceptMode','complete');await setMode('holdConcept',true);
  await action('ai-concept').click();await waitState(state=>state.heldConcept);
  assert.equal(await action('build').isDisabled(),true);assert.equal(await action('save').isDisabled(),true);assert.equal(await page.locator('#concept-prompt').isDisabled(),true);
  assert.equal(await action('ai-cancel').isEnabled(),true);
  await nav('stats').click();assert.equal(await fieldInput('최대 체력').isDisabled(),true);
  await nav('concept').click();assert.equal(await page.locator('#concept-prompt').isDisabled(),true);assert.equal(await action('ai-concept').isDisabled(),true);
  await application.evaluate(()=>globalThis.releaseHeldConcept());await idle();
  assert.match(await page.locator('#inspector-body').innerText(),/모의 바위 수호자 구성 완료/);
  assert.match(await page.locator('#inspector-body').innerText(),/높은 체력과 느린 이동/);
  assert.match(await page.locator('#inspector-body').innerText(),/모의 컨셉 안내/);
  const concept=await saveSnapshot();assert.equal(concept.stats.maxHp,3100);assert.equal(concept.components.NavMeshAgent.m_Speed,1.8);assert.equal(concept.components.FanVisionSensor._range,7);
  assert.equal(concept.attacks.length,1);assert.equal(concept.attacks[0].values.damage,2.8);assert.equal(concept.selfDestruct,null);
  assert.equal(concept.name,beforeConcept.name);assert.deepEqual(concept.model,beforeConcept.model);assert.deepEqual(concept.animation.move,beforeConcept.animation.move);assert.deepEqual(concept.hpBarPosition,beforeConcept.hpBarPosition);
  assert.equal((await snapshot()).conceptCalls.at(-1).model,'fixture-model');
  observations.push('Concept failure preserves the complete draft and prompt; successful concept updates stats, movement, sensing and attacks while preserving identity, animations and manual anchors');
  observations.push('Concept generation locks editing and build/save commands across inspector tab changes until completion');
  }
  await page.screenshot({ path: path.join(output, screenshotName), fullPage: true });
  assert.deepEqual(errors, []);
  const result = await snapshot();
  const report = { passed: true, mode: 'mocked Unity and AI IPC / actual Electron renderer and preload', observations, counts: { previewFrames: result.previews.length, closedSessions: result.closed.length, saves: result.saved.length, validations: result.validates.length, builds: result.builds.length, aiCalls: result.aiCalls.length,conceptCalls:result.conceptCalls.length,modelAnalyses:result.analyses.length,animationInspections:result.animationInfos.length, confirmations:confirmations.length+result.confirmations.length }, screenshot: 'artifacts/'+screenshotName };
  await writeFile(path.join(output, reportName), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'desktop-failed.png'), fullPage: true }).catch(() => undefined);
  await writeFile(path.join(output, reportName), JSON.stringify({ passed: false, error: error.message, errors, observations }, null, 2));
  throw error;
} finally {
  await application.close();
  // mkdtemp creates this exact leaf under the OS temporary directory; verify before recursive cleanup.
  assert.equal(path.dirname(path.resolve(userData)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
  assert.ok(path.basename(userData).startsWith('baekho-enemy-desktop-'));
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
