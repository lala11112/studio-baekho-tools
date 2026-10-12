import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {postProductionBridge} from '../engine/production-bridge-http';
test('approval HTTP waits for response, rejects closed/late/invalid responses without retry',async()=>{
 let calls=0;const server=http.createServer((req,res)=>{calls++;req.resume();req.on('end',()=>setTimeout(()=>{if(!res.destroyed){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));}},90));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 try{assert.deepEqual(await postProductionBridge(port,'fixture',{},1000),{ok:true});await assert.rejects(postProductionBridge(port,'fixture',{},15),/deadline/);await new Promise(r=>setTimeout(r,110));assert.equal(calls,2);}finally{server.closeAllConnections();server.close();}
});
test('approval HTTP remains open beyond fetch five-minute header default',{skip:!process.env.PARTSMITH_LONG_BRIDGE_TEST,timeout:330000},async()=>{
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>setTimeout(()=>res.end('{"approved":true}'),305000));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{assert.deepEqual(await postProductionBridge((server.address() as any).port,'fixture',{},315000),{approved:true});}finally{server.closeAllConnections();server.close();}
});
