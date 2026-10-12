import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exportItemPackage } from '../engine/four-tiger-items/export';
import { createReviewedFixture } from './fixtures/four-tiger-items';
import { sha256 } from '../engine/four-tiger-items/icons';
import { patchItem } from '../engine/four-tiger-items/domain';
async function setup(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'item-export-'));return {...await createReviewedFixture(root),root};}
test('release exports the reviewed 20, ratio values, Unicode, metal strings and verified relative files',async()=>{
  const {store,project:p}=await setup();const exportRoot=path.join(store.directory(p.projectId),'exports');
  const a=await exportItemPackage({store,projectId:p.projectId,expectedRevision:p.revision,kind:'release',exportRoot});
  const catalog=JSON.parse(await fs.readFile(path.join(a.directory,'saingeom-items.v1.json'),'utf8'));
  assert.equal(catalog.schemaVersion,1);assert.equal(catalog.items.length,20);assert.equal(catalog.contentStatus,'adopted');
  assert.equal(catalog.items.find((i:{itemId:string})=>i.itemId==='IT_FIRE_01').effects[0].amount,.08);
  assert.equal(catalog.items.find((i:{itemId:string})=>i.itemId==='IT_METAL_01').element,'metal');assert.equal(catalog.items[0].name,'새싹 부적');
  const manifest=JSON.parse(await fs.readFile(path.join(a.directory,'manifest.json'),'utf8'));
  assert.equal((await fs.readdir(path.join(a.directory,'icons'))).length,20);
  for(const f of manifest.files){assert.ok(!f.path.includes('..')&&!/^[A-Za-z]:/.test(f.path));assert.equal(sha256(await fs.readFile(path.join(a.directory,f.path))),f.sha256);}
  const previous=await fs.readFile(path.join(a.directory,'saingeom-items.v1.json'));
  const latest=await store.read(p.projectId);const b=await exportItemPackage({store,projectId:p.projectId,expectedRevision:latest.revision,kind:'release',exportRoot});
  assert.notEqual(a.directory,b.directory);assert.deepEqual(await fs.readFile(path.join(a.directory,'saingeom-items.v1.json')),previous);
});
test('every release gate blocks incomplete adoption while draft keeps proposal state',async()=>{
  const mutations=[
    (p:any)=>{p.items[0].review.dataRevision=null;},(p:any)=>{p.items[0].review.iconVersion=null;},
    (p:any)=>{p.ruleProfile.adoptions={};},(p:any)=>{p.items[0].grade=2;},
    (p:any)=>{p.items[0].descriptionStale=true;},(p:any)=>{p.synergyReferences[0].items[0].itemId='BROKEN';},
    (p:any)=>{p.items[0].unsupportedEffectNotes='미지원';},
  ];
  for(const mutate of mutations){const {store,project}=await setup();const p=await store.update(project.projectId,project.revision,p=>{mutate(p);return p;});const exportRoot=path.join(store.directory(p.projectId),'exports');await assert.rejects(exportItemPackage({store,projectId:p.projectId,expectedRevision:p.revision,kind:'release',exportRoot}),{code:'REVIEW_REQUIRED'});}
  const {store,project}=await setup();const p=await store.update(project.projectId,project.revision,p=>{p.items[0].icons=[];p.items[0].selectedIconVersion=null;p.items[0].review.state='draft';p.ruleProfile.adoptions={};return p;});
  const receipt=await exportItemPackage({store,projectId:p.projectId,expectedRevision:p.revision,kind:'draft',exportRoot:path.join(store.directory(p.projectId),'review-bundle')});
  const catalog=JSON.parse(await fs.readFile(path.join(receipt.directory,'saingeom-items.v1.json'),'utf8'));assert.equal(catalog.contentStatus,'draft');assert.equal(catalog.items[0].iconPath,null);assert.deepEqual(catalog.ruleProfile.adoptions,{});
});
test('tampered PNG blocks export and leaves originals untouched',async()=>{
  const {store,project:p}=await setup();const icon=p.items[0].icons[0];const file=await store.resolveFile(p.projectId,icon.thumbnailPath);await fs.appendFile(file,'tamper');
  const bytes=await fs.readFile(file);await assert.rejects(exportItemPackage({store,projectId:p.projectId,expectedRevision:p.revision,kind:'release',exportRoot:path.join(store.directory(p.projectId),'exports')}),{code:'ICON_HASH_MISMATCH'});assert.deepEqual(await fs.readFile(file),bytes);
});
test('export uses one snapshot even if content changes during writing and omits raw worker paths',async(t)=>{
  const {store,project}=await setup();let p=await store.update(project.projectId,project.revision,p=>{p.items[0].icons[0].prompt='C:\\Users\\PRIVATE\\do-not-export';return p;});
  const original=fs.writeFile.bind(fs);let edited=false;
  t.mock.method(fs,'writeFile',async(...args:Parameters<typeof fs.writeFile>)=>{if(!edited&&String(args[0]).endsWith('saingeom-items.v1.json')){edited=true;await store.update(p.projectId,p.revision,x=>patchItem(x,x.items[0].candidateKey,{name:'동시 수정'},new Date().toISOString()));}return original(...args);});
  const receipt=await exportItemPackage({store,projectId:p.projectId,expectedRevision:p.revision,kind:'release',exportRoot:path.join(store.directory(p.projectId),'exports')});
  const text=await fs.readFile(path.join(receipt.directory,'saingeom-items.v1.json'),'utf8');const catalog=JSON.parse(text);assert.equal(catalog.contentRevision,p.revision);assert.equal(catalog.items[0].name,'새싹 부적');assert.ok(!text.includes('PRIVATE'));assert.equal((await store.read(p.projectId)).items[0].name,'동시 수정');
});
test('partial export failure leaves no completed folder and changes no source asset',async(t)=>{
  const {store,project:p}=await setup(),exportRoot=path.join(store.directory(p.projectId),'exports');
  const source=await store.resolveFile(p.projectId,p.items[0].icons[0].sourcePath),before=await fs.readFile(source),original=fs.writeFile.bind(fs);
  t.mock.method(fs,'writeFile',async(...args:Parameters<typeof fs.writeFile>)=>{if(String(args[0]).endsWith('saingeom-items.v1.json'))throw new Error('disk full');return original(...args);});
  await assert.rejects(exportItemPackage({store,projectId:p.projectId,expectedRevision:p.revision,kind:'release',exportRoot}),/disk full/);
  assert.ok((await fs.readdir(exportRoot)).every(n=>n.startsWith('.staging-')));assert.deepEqual(await fs.readFile(source),before);
});
