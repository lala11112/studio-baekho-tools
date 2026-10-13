import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectGraphicsStorage } from '../engine/graphics-storage';
import { modelProductionLabel } from '../shared/graphics-provenance';
import { resolveEditMeshNames } from '../engine/graphics-astra';
import type { AssetVersion, GraphicsTask } from '../shared/graphics';

test('storage classification reads metadata, protects archives and separates registered originals from cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'partsmith-storage-'));
  // Fixture-only cleanup with concrete containment, not a production storage operation.
  try {
    const profile = path.join(root, 'profile'), app = path.join(root, 'app');
    const files: Record<string,string> = {
      'profile/projects/a/native.blend': 'original', 'profile/projects/a/jobs/receipt.json': 'receipt',
      'profile/Cache/data': 'cache', 'profile/Network/Cookies': 'authentication',
      'app/artifacts/preserved-validation-files/only.blend': 'sole-original',
      'app/artifacts/runtime/report.json': 'report', 'app/node_modules/package/index.js': 'code',
      'app/release/old/Partsmith.exe': 'binary', 'app/package.json': '{}',
    };
    for (const [name, value] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root,name)), { recursive:true }); fs.writeFileSync(path.join(root,name),value); }
    const link = path.join(app, 'linked-profile');
    fs.symlinkSync(profile, link, 'junction');
    const report = await inspectGraphicsStorage({ profileRoot:profile, appRoot:app, registeredFiles:[path.join(profile,'projects/a/native.blend')] });
    assert.equal(report.totalBytes, Object.values(files).reduce((n,s)=>n+Buffer.byteLength(s),0));
    const bytes=(id:string)=>report.categories.find(row=>row.id===id)!.bytes;
    assert.equal(bytes('originals'),8);assert.equal(bytes('cache'),5);assert.equal(bytes('profile'),14);
    assert.equal(bytes('archive'),13);assert.equal(report.autoDelete,false);assert.equal(report.skippedLinks,1);assert.equal(report.unreadable,0);
    for(const [name,value]of Object.entries(files))assert.equal(fs.readFileSync(path.join(root,name),'utf8'),value);
    const twice=await inspectGraphicsStorage({profileRoot:profile,appRoot:root,registeredFiles:[]});
    assert.equal(twice.totalBytes,report.totalBytes);
  } finally { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)); fs.rmSync(root,{recursive:true,force:true}); }
});
test('result provider label follows historical producer ancestry and never current controls', () => {
  const model = {id:'model',objectId:'one',sourceVersionIds:[],provenance:{type:'tripo'}} as unknown as AssetVersion;
  const rig = {id:'rig',objectId:'one',sourceVersionIds:['model'],provenance:{type:'codex'}} as unknown as AssetVersion;
  const tasks=[{objectId:'one',taskId:'M01',outputVersionIds:['model'],settings:{model:'P2-20260801'}}] as unknown as GraphicsTask[];
  assert.match(modelProductionLabel(rig,[model,rig],tasks),/P2-20260801/);
  assert.match(modelProductionLabel(rig,[model,rig],[]),/미확인/);
  assert.doesNotMatch(modelProductionLabel({...rig,objectId:'other'},[model,rig],tasks),/P2-20260801/);
});
test('mesh name selection resolves exact unique source IDs and rejects guessed or ambiguous names', () => {
  const meshes=[{id:'native-1',name:'Body'},{id:'native-2',name:'Handle'}];
  assert.deepEqual(resolveEditMeshNames(meshes,['Handle']),['native-2']);
  assert.throws(()=>resolveEditMeshNames(meshes,['handle']),/유일하게/);
  assert.throws(()=>resolveEditMeshNames([...meshes,{id:'native-3',name:'Handle'}],['Handle']),/유일하게/);
});
