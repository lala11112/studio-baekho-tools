'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../Packages/com.studiobaekho.combat-lab/Editor/CombatLabReport.cs'), 'utf8');
const html = /const string Html = @"([\s\S]*)";/.exec(source)[1].replaceAll('""', '"');
test('portable report JavaScript parses and retains control/repeat/precision behavior', () => {
  const script = /<script>\s*([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /report\.controlResult/); assert.match(script, /repeatIndex/); assert.match(script, /relativeTimeSeconds/);
  assert.doesNotMatch(html, /약 1프레임/);
});
test('portable PNG references allow the generated subfolder while rejecting traversal and URI schemes', () => {
  const definition = /const safeImage=([^;]+);/.exec(html)[1];
  const safeImage = vm.runInNewContext(`(${definition})`);
  assert.equal(safeImage('ai-01-repeat-1.frames/000001.png'), true);
  for (const value of ['../outside.png', 'ai.frames/../outside.png', 'https://example.test/a.png', 'C:/outside.png', 'ai.frames\\000001.png', 'data:image/png;base64,a', 'NUL/a.png']) assert.equal(safeImage(value), false, value);
});
