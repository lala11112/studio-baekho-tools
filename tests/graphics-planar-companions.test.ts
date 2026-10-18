import test from 'node:test';
import assert from 'node:assert/strict';
import { planarCompanions, validatePlanarReport } from '../engine/graphics-planar';

const file=(path:string,kind='image')=>({path,kind,bytes:3,sha256:'a'.repeat(64)});
test('planar companions retain exact registered texture metadata and reject normalized name collisions',()=>{
  const texture=file('originals/metal.PNG','texture');
  assert.deepEqual(planarCompanions([texture,file('derived/a.png','preview'),file('report.png','report'),file('source.fbx','model')]),[texture]);
  assert.throws(()=>planarCompanions([file('a/Metal.png'),file('b/metal.PNG')]),/중복/);
  assert.throws(()=>planarCompanions([file('a/é.png'),file('b/e\u0301.png')]),/중복/);
});
test('sidecar inspection report must bind the exact manifest, including bytes and source path',()=>{
  const companions=[file('originals/metal.png')];
  const report={schemaVersion:1,mode:'inspect',passed:true,identity:'id',algorithmVersion:'planar-v2',sourceVersionId:'source',sourceSha256:'source-hash',localOnly:true,modelTurns:0,paidSubmissions:0,inspectionId:'inspection',meshes:[],sourceCompanions:companions,sourceManifestVersion:1};
  const args:any={source:{sha256:'source-hash'},sourceVersionId:'source',mode:'inspect',sourceCompanions:companions};
  validatePlanarReport(report,args,'id');
  for(const sourceCompanions of [undefined,[{...companions[0],bytes:4}],[{...companions[0],path:'other/metal.png'}]])assert.throws(()=>validatePlanarReport({...report,sourceCompanions},args,'id'),/동반/);
  validatePlanarReport({...report,sourceCompanions:undefined},{...args,sourceCompanions:undefined},'id');
});
