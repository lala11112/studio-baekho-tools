import test from 'node:test';
import assert from 'node:assert/strict';
import { changeCreationSubject, compileCreation, creationForSubject, creationSubjects, creationSubjectGroups, creationOptions, defaultCreation, effectiveCreation, optionAppliesToSubject, validateCreation } from '../shared/graphics-creation';
import type { GraphicsObject } from '../shared/graphics';

const make = (subject: string): GraphicsObject => ({ id: 'o', name: 'Fixture', kind: creationSubjects.find(s => s.id === subject)!.kind, createdAt: '', instruction: '', settings: {}, selectedTasks: [], accepted: {}, references: [{ versionId: 'reference', role: 'style' }], creation: creationForSubject(subject) });

test('all five groups produce independent valid image and model requests with the chosen subject and free description', () => {
  assert.equal(creationSubjectGroups.length, 5);
  const required = ['human','animal','creature','furniture','everyday','box','tool','machine','food','decoration','weapon','armor','accessory','building','wall','floor','roof','door','stairs','column','fence','rock','tree','shrub','grass','terrain'];
  for (const subject of required) {
    const o = make(subject), before = structuredClone(o);
    o.creation!.instruction = '사진의 색을 참고하고 측면에 작은 파란 장식을 추가';
    o.creation!.attributes['custom.extra'] = '우측 윗부분만 매끈하게';
    assert.equal(validateCreation(o.creation!, o.kind).subject, subject);
    for (const taskId of ['I01', 'M01']) {
      const compiled = compileCreation(o, taskId);
      assert.equal(compiled.settings.subject, subject);
      assert.match(compiled.instruction, /사진의 색|파란 장식/);
      assert.match(compiled.settings.freeInstruction as string, /우측 윗부분/);
      if (o.kind !== 'character') {
        assert.equal(compiled.settings.pose, undefined);
        assert.doesNotMatch(compiled.instruction, /A 포즈|T 포즈|얼굴:|귀:/);
      }
    }
    assert.deepEqual(o.references, before.references);
    assert.equal(o.creation!.stageSettings.rig!.values.rigType, 'none');
    assert.deepEqual(o.selectedTasks, []);
  }
});

test('stale hidden biological options cannot leak into object generation or editing while the saved source remains untouched', () => {
  const o = make('machine'), c = o.creation!;
  Object.assign(c.attributes, { face: 'sharp', ears: 'long', hair: 'long', body: 'slim', 'custom.face': '눈을 크게', 'custom.extra': '녹색 도장', shape: 'angular' });
  c.stageSettings.design!.values.pose = 'a'; c.stageSettings.design!.values.framing = 'face'; c.locks = ['face','hair','color'];
  const before = structuredClone(o);
  for (const taskId of ['I01','M01','M05']) {
    const compiled = compileCreation(o, taskId);
    assert.equal(compiled.settings.pose, undefined);
    assert.equal(compiled.settings['attr.face'], undefined);
    assert.equal(compiled.settings['attr.ears'], undefined);
    assert.equal(compiled.settings['attr.custom.face'], undefined);
    assert.equal(compiled.settings['lock.face'], undefined);
    assert.equal(compiled.settings['lock.color'], true);
    assert.match(compiled.instruction, /각진|녹색 도장/);
    assert.doesNotMatch(compiled.instruction, /A 포즈|얼굴|눈을 크게|머리카락|귀:/);
  }
  assert.deepEqual(o, before);
});

test('subject families expose object-specific options and subject change retains references/free text without reusing human pose', () => {
  const option = (id: string) => creationOptions.find(o => o.id === id)!;
  assert(optionAppliesToSubject(option('shape'), 'furniture'));
  assert(optionAppliesToSubject(option('hinge'), 'machine'));
  assert(optionAppliesToSubject(option('buildingType'), 'roof'));
  assert(optionAppliesToSubject(option('foliage'), 'tree'));
  assert(!optionAppliesToSubject(option('face'), 'tool'));
  const human = defaultCreation('character');
  human.attributes.face = 'sharp'; human.instruction = '참조의 색';
  const animal = changeCreationSubject(human, 'animal');
  assert.equal(animal.attributes.face, undefined);
  assert.equal(animal.stageSettings.design!.values.pose, 'natural');
  assert.equal(animal.instruction, '참조의 색');
  assert.equal(human.stageSettings.design!.values.pose, 'a');
});

test('size is an immutable downstream setting, absent from image prompts; legacy objects preserve missing-size distinction', () => {
  const o = make('building');
  Object.assign(o.creation!.physicalSize!, { mode: 'uniform', axis: 'y', lengthMeters: 20 });
  assert.equal(compileCreation(o,'I01').settings.physicalSize, undefined);
  assert.equal(JSON.parse(String(compileCreation(o,'X05').settings.physicalSize)).lengthMeters,20);
  const old = make('prop'); delete old.creation; old.settings.scale = 1.5;
  assert.equal(effectiveCreation(old).physicalSize,undefined);
  assert.equal(compileCreation(old,'X05').settings.physicalSize,undefined);
  assert.equal(compileCreation(old,'X05').settings.scale,1.5);
});

test('local size copies do not require the unrelated Unity delivery choices', () => {
  const o = make('prop'), spec = o.creation!;
  Object.assign(spec.stageSettings.unity!.values, { deliveryMode: '', collider: '', deliveryCompression: '' });
  Object.assign(spec.physicalSize!, { mode: 'uniform', lengthMeters: .25 });
  const request = compileCreation(o, 'A05');
  assert.equal(JSON.parse(String(request.settings.physicalSize)).lengthMeters, .25);
  assert.equal(request.settings.count, 1);
  assert.throws(() => compileCreation(o, 'X05'), /전달 방식 선택/);
});
