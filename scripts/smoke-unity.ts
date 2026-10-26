import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {UnityService} from '../electron/services/unity';
import type {Catalog} from '../src/shared/types';
const unity=new UnityService();await mkdir('artifacts',{recursive:true});
try{
 const connection=await unity.connect();const catalog=await unity.call('catalog') as Catalog;
 assert.ok(catalog.assets.length>0);assert.ok(catalog.attacks.length>=5);assert.equal(catalog.template.stats.criticalChance,1);
 const validation=await unity.call('validate',{blueprint:catalog.template});assert.equal(validation.valid,true,JSON.stringify(validation.issues));
 const structural=await unity.call('regression');assert.match(String(structural),/^PASS:/);
 const builds=await unity.call('regression',{build:true});assert.equal(builds.passed,true);assert.equal(builds.alternateModelBuilt,true);
 const report={connection,assetCount:catalog.assets.length,attackCount:catalog.attacks.length,structural,builds};await writeFile('artifacts/unity-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,assets:catalog.assets.length,attacks:catalog.attacks.length,structural,checks:builds.checks,alternateModelBuilt:builds.alternateModelBuilt},null,2));
}finally{await unity.dispose();}
