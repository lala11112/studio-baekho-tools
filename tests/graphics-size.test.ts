import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPhysicalSize,normalizePhysicalSize,physicalSizeTransform } from '../shared/graphics-size';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const bounds={min:{x:1,y:2,z:3},max:{x:3,y:6,z:9}};
test('physical meter fit shares a canonical frozen JSON contract and is idempotent',()=>{
 const setting={...defaultPhysicalSize(),mode:'uniform' as const,axis:'y' as const,lengthMeters:2,pivot:'bottom-center' as const};
 assert.deepEqual(normalizePhysicalSize(JSON.stringify(setting)),setting);
 const fit=physicalSizeTransform(bounds,setting);
 assert.deepEqual(fit.factors,{x:.5,y:.5,z:.5});assert.deepEqual(fit.dimensions,{x:1,y:2,z:3});assert.deepEqual(fit.anchor,{x:2,y:2,z:6});
 const repeated=physicalSizeTransform({min:{x:-.5,y:0,z:-1.5},max:{x:.5,y:2,z:1.5}},setting);
 assert.deepEqual(repeated.factors,{x:1,y:1,z:1});assert.deepEqual(repeated.anchor,{x:0,y:0,z:0});
});
test('real Blender sized rig keeps the strict animation dependency and bone contracts', {timeout:60000}, t=>{
 const blender=process.env.PARTSMITH_TEST_BLENDER;if(!blender||!fs.existsSync(blender)){t.skip('Set PARTSMITH_TEST_BLENDER');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-size-contract-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const file=path.join(root,'check.py'),validator=path.resolve('integrations/blender/graphics_astra_validate.py');
 fs.writeFileSync(file,`import bpy,pathlib,sys\nsys.path.insert(0,${JSON.stringify(path.dirname(validator))})\nfrom graphics_size import apply_physical_size,MARKER\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add(size=2)\nmesh=bpy.context.object;mesh['partsmith_id']='mesh'\nbpy.ops.object.armature_add()\nrig=bpy.context.object;rig.name='Rig'\nm=mesh.modifiers.new('Skin','ARMATURE');m.object=rig\ng=mesh.vertex_groups.new(name=rig.data.bones[0].name);g.add(list(range(8)),1,'REPLACE')\napply_physical_size({'mode':'uniform','axis':'y','lengthMeters':3},'a'*64)\nns={'__file__':${JSON.stringify(validator)}}\nexec(pathlib.Path(${JSON.stringify(validator)}).read_text(encoding='utf8').rsplit('\\nq = json.loads(',1)[0],ns)\nfirst=ns['animation_contract']()\nrig.parent.location.x+=1;bpy.context.view_layer.update()\nassert first['skeleton']!=ns['animation_contract']()['skeleton'],'wrapper motion was hidden from preservation contract'\ndel rig.parent[MARKER]\ntry:ns['animation_contract']();raise AssertionError('arbitrary parent accepted')\nexcept RuntimeError:pass\n`);
 const result=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',file],{windowsHide:true,encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stdout+result.stderr);
});
test('static XYZ fitting is separate from uniform rig fitting and invalid dimensions stop',()=>{
 const setting={...defaultPhysicalSize(),mode:'axes' as const,dimensionsMeters:{x:.2,y:10,z:30}};
 assert.deepEqual(physicalSizeTransform(bounds,setting).dimensions,setting.dimensionsMeters);
 assert.throws(()=>physicalSizeTransform(bounds,setting,true),/리그/);
 for(const invalid of [0,-1,Infinity,NaN,'2'])assert.throws(()=>normalizePhysicalSize({...setting,lengthMeters:invalid}));
 assert.throws(()=>physicalSizeTransform({min:{x:0,y:0,z:0},max:{x:0,y:4,z:6}},setting),/평면/);
 assert.deepEqual(physicalSizeTransform(bounds,undefined).factors,{x:1,y:1,z:1});
});
