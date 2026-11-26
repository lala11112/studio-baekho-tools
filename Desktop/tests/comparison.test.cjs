'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the production comparison controller with a minimal media/DOM harness.
// Real decoding and desktop interactions are covered by the Electron diagnostic.
function comparison(candidateCount) {
  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.events = {}; this.value = ''; this.attributes = {};
      this.hidden = false; this.checked = false; this.duration = NaN; this.currentTime = 0; this.paused = true;
      this.classList = { toggle() {} };
    }
    append(...elements) {
      this.children.push(...elements);
      if (this.tagName === 'select' && this.value === '' && this.options.length) this.value = String(this.options[0].value);
    }
    replaceChildren(...elements) { this.children = []; this.value = ''; this.append(...elements); }
    get options() { return this.children.filter(item => item.tagName === 'option'); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return name === 'src' ? this.src : this.attributes[name]; }
    removeAttribute(name) { if (name === 'src') this.src = undefined; delete this.attributes[name]; }
    addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
    emit(name) { for (const handler of this.events[name] || []) handler(); }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    load() { this.currentTime = 0; }
  }
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, new Element(['compareCount', 'sound', 'rate'].includes(id) ? 'select' : 'div'));
    return elements.get(id);
  };
  $('rate').value = '1'; $('sound').value = 'none';
  const context = vm.createContext({
    $, requestAnimationFrame() {}, finite: value => typeof value === 'number' && Number.isFinite(value),
    node: (tag, text, className) => Object.assign(new Element(tag), { textContent: text, className }),
    option: (select, text, value) => select.append(Object.assign(new Element('option'), { textContent: text, value: String(value) })),
    candidateName: (candidate, index) => candidate?.label || `후보 ${index + 1}`,
    fixtureResults: Array.from({ length: candidateCount }, (_, index) => ({ candidate: { id: `candidate_${index}`, label: `후보 ${index + 1}` }, videoUrl: `baekho-media://video/${index}`, metrics: { firstHitSeconds: index + 0.5 }, videoTimeOffsetSeconds: 0.2 })),
  });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const controller = source.slice(source.indexOf('// Report videos share'), source.indexOf("$('dismissMessage').addEventListener"));
  assert.ok(controller.includes('function drawVideoGrid'), 'production comparison controller is present');
  vm.runInContext(controller + '\nresults = fixtureResults; drawComparisonCount();', context);
  return {
    $, run: code => vm.runInContext(code, context),
    json: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
  };
}

test('comparison defaults to all requested candidates and releases removed media when reducing count', () => {
  const ui = comparison(7);
  assert.equal(ui.run('videos.length'), 7);
  assert.deepEqual(ui.json('selectors.map(select => Number(select.value))'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ui.$('compareCount').options.map(item => item.value), ['2', '3', '4', '5', '6', '7']);
  assert.equal(ui.$('sound').options.length, 8);
  ui.run('globalThis.oldVideos = [...videos]; drawVideoGrid(3, selectedCandidateIds());');
  assert.equal(ui.run('videos.length'), 3);
  assert.equal(ui.run('oldVideos.every(video => video.paused && !video.src)'), true);
  ui.run("oldVideos[0].duration = 20; oldVideos[0].emit('loadedmetadata');");
  assert.equal(ui.run('activeVideos().length'), 0, 'events from released cards cannot mark replacement media ready');
});

test('candidate selectors swap occupied slots instead of producing duplicate comparisons', () => {
  const ui = comparison(5);
  ui.run("selectors[3].value = '0'; selectors[3].emit('change');");
  assert.deepEqual(ui.json('selectors.map(select => Number(select.value))'), [3, 1, 2, 0, 4]);
  assert.equal(ui.run('new Set(selectedCandidateIds()).size'), 5);
  assert.equal(ui.$('sound').options[1].textContent, '1 · 후보 4');
});

test('three videos share the overlapping first-hit timeline and seek to distinct media offsets', async () => {
  const ui = comparison(3);
  ui.run(`
    results[0].metrics.firstHitSeconds = 1; results[0].videoTimeOffsetSeconds = 0.25;
    results[1].metrics.firstHitSeconds = 0.5; results[1].videoTimeOffsetSeconds = 0.1;
    results[2].metrics.firstHitSeconds = 2; results[2].videoTimeOffsetSeconds = 0.2;
    videos.forEach((video, index) => { video.duration = [10, 8, 12][index]; video.emit('loadedmetadata'); });
    $('align').checked = true; seekTo(3);
  `);
  assert.deepEqual(ui.json('bounds()'), { min: -0.6, max: 7.4 });
  assert.deepEqual(ui.json('videos.map(video => video.currentTime)'), [4.25, 3.6, 5.2]);
  await ui.run('play()');
  assert.equal(ui.run('videos.every(video => !video.paused)'), true);
  ui.run('stop(); seekTo(99);');
  assert.equal(ui.run('videos.every(video => video.paused)'), true);
  assert.equal(ui.run('logicalTime()'), 7.4);
  ui.run("$('sound').value = '2'; updateAudioOptions();");
  assert.deepEqual(ui.json('videos.map(video => video.muted)'), [true, true, false]);
});

test('older single-candidate reports and missing recordings remain inspectable', () => {
  const single = comparison(1);
  assert.equal(single.run('videos.length'), 1);
  assert.equal(single.$('compareCount').disabled, true);
  const ui = comparison(3);
  ui.run("results[1].videoUrl = null; loadVideo(1); videos[0].duration = 4; videos[0].emit('loadedmetadata'); videos[2].duration = 6; videos[2].emit('loadedmetadata');");
  assert.equal(ui.run('videos.length'), 3);
  assert.equal(ui.run('activeVideos().length'), 2);
  assert.deepEqual(ui.json('bounds()'), { min: 0, max: 4 });
  assert.equal(ui.run('videoSlots[1].empty.textContent'), '이 후보의 녹화 영상이 없습니다');
});

test('twelve requested candidates remain distinct when comparison count is reduced then restored', () => {
  const ui = comparison(12);
  assert.equal(ui.run('videos.length'), 12);
  ui.run("selectors[0].value = '11'; selectors[0].emit('change'); drawVideoGrid(2, selectedCandidateIds()); drawVideoGrid(12, selectedCandidateIds());");
  assert.equal(ui.run('videos.length'), 12);
  assert.equal(ui.run('new Set(selectedCandidateIds()).size'), 12);
  assert.deepEqual(ui.json('selectors.slice(0, 2).map(select => Number(select.value))'), [11, 1]);
});

test('comparison preserves a selected repeat across count changes without substituting repeat one', () => {
  const ui = comparison(3);
  ui.run(`results[0].repeatIndex=1;results[1].repeatIndex=2;results[1].candidate.id=results[0].candidate.id;drawComparisonCount();selectors[0].value='1';selectors[0].emit('change');drawVideoGrid(2,selectedCandidateIds());drawVideoGrid(3,selectedCandidateIds());`);
  assert.deepEqual(ui.json('selectors.map(select => Number(select.value))'), [1, 0, 2]);
  assert.equal(ui.run("selectedCandidateIds()[0]"), 'candidate_0:repeat:2');
});

test('precision aligns to nearest actual relative time with an earlier-sample tie break', () => {
  const ui = comparison(1);
  assert.equal(ui.run('nearestCaptureIndex([{relativeTimeSeconds:0},{relativeTimeSeconds:.05},{relativeTimeSeconds:.1}],.075)'), 1);
  assert.equal(ui.run('nearestCaptureIndex([{relativeTimeSeconds:-.05},{relativeTimeSeconds:.04},{relativeTimeSeconds:.1}],.075)'), 2);
});
