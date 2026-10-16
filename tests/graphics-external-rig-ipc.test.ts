import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {externalRigPreparedFile} from '../electron/external-rig';
import type {GraphicsWorkspace} from '../shared/graphics';
test('prepared file IPC helper reveals only exact registered in-project FBX',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rig-ipc-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'prepared.fbx'),'prepared');
 const file={path:'prepared.fbx',bytes:8,sha256:createHash('sha256').update('prepared').digest('hex'),kind:'preparation-fbx'};
 const h:any={id:'h',state:'awaiting-external',preparation:{files:[file]}};const w={externalRigHandoffs:[h]} as GraphicsWorkspace;
 assert.equal(externalRigPreparedFile(root,w,'h'),path.join(root,'prepared.fbx'));
 assert.throws(()=>externalRigPreparedFile(root,w,'other'));
 h.state='cancelled';assert.throws(()=>externalRigPreparedFile(root,w,'h'));h.state='awaiting-external';
 file.path='../outside.fbx';assert.throws(()=>externalRigPreparedFile(root,w,'h'));file.path='prepared.fbx';
 fs.writeFileSync(path.join(root,'prepared.fbx'),'tampered');assert.throws(()=>externalRigPreparedFile(root,w,'h'),/변경/);
});
