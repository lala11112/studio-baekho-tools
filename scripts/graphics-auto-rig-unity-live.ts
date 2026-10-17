/** Run only after root authorizes isolated Unity. Uses actual app-generated queue. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';
import {inspectUnityDelivery} from '../engine/graphics-unity';
const read=(f:string)=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),sha=(f:string)=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const runtime=path.resolve('artifacts/runtime'),buttons=process.env.PARTSMITH_AUTO_RIG_BUTTONS==='1';
const app=read(path.join(runtime,buttons?'graphics-auto-rig-buttons-live.json':'graphics-auto-rig-app-live.json'));
const fixture=buttons?app.fixture:read(path.join(runtime,'graphics-auto-rig-app-fixture.json'));
const logPrefix=buttons?'graphics-auto-rig-buttons-unity':'graphics-auto-rig-unity';
const mode=process.argv[2]??'first';assert(['first','reimport'].includes(mode));
const root=fs.realpathSync(fixture.root),unity=fs.realpathSync(fixture.unity);assert(root.startsWith(fs.realpathSync(os.tmpdir())+path.sep)&&path.basename(root).startsWith(buttons?'ps-auto-rig-start-':'ps-auto-rig-app-'));assert(unity.startsWith(root+path.sep));
assert.equal(app.acceptedVersionId,app.candidate.id);const candidate=app.candidate,delivery=app.delivery;assert(candidate.autoRig?.exportFbx&&delivery);assert.deepEqual(delivery.versionIds,[candidate.id]);
for(const f of candidate.files)assert.equal(sha(path.join(fixture.projectRoot,f.path)),f.sha256);
const staging=path.join(unity,'Library/PartsmithGraphicsStaging',delivery.id),queue=read(path.join(staging,'request.json'));
assert.equal(queue.rigType,'humanoid');assert.equal(queue.rigContract.exportPolicy,'auto-rig-fbx');assert.equal(queue.rigContract.versionId,candidate.id);
const exported=queue.files.filter((f:any)=>/\.fbx$/i.test(f.destination));assert.equal(exported.length,1);assert.equal(exported[0].sha256,candidate.autoRig.exportFbx.sha256,'Unity must receive exact ARP game FBX bytes');
const physical=read(path.join(staging,'physical-size.json'));
const evidencePath=path.join(runtime,buttons?'graphics-auto-rig-buttons-unity.json':'graphics-auto-rig-app-unity.json'),evidence=fs.existsSync(evidencePath)?read(evidencePath):{fixture,candidateVersionId:candidate.id,deliveryId:delivery.id,playMode:false,paidSubmissions:0,productionGPT:0};
const save=()=>fs.writeFileSync(evidencePath,JSON.stringify(evidence,null,2));
if(buttons){evidence.firstDeliveryInitiation='Visible app prepare and approve buttons';evidence.reimportInitiation='Separate local Unity regression: re-register the exact frozen inbox request; not an app redelivery button test';}
const cli=path.join(process.env.LOCALAPPDATA!,'Unity/bin/unity.exe');assert(fs.existsSync(cli));
async function command(args:string[],name:string){const log=fs.createWriteStream(path.join(runtime,logPrefix+'-'+name+'.log'));let tail='';const code=await new Promise<number|null>((resolve,reject)=>{const child=spawn(cli,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{log.write(b);tail=(tail+b).slice(-10000);});child.once('error',reject);child.once('exit',resolve);});log.end();if(code!==0&&!(args[0]==='status'&&code===6&&tail.includes('STATUS_NO_INSTANCES')))throw Error('Unity CLI '+code+' '+tail);return tail;}
const status=await command(['status','--format','json'],'status');assert(!status.replaceAll('\\\\','\\').toLowerCase().includes(unity.toLowerCase()),'Do not batch-edit live isolated Editor');
for(const name of ['AutoRigUnityCheck.cs','AutoRigUserMarker.cs']){const dest=path.join(unity,name==='AutoRigUserMarker.cs'?'Assets':'Assets/Editor',name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join('scripts/fixtures',name),dest);}
const protectedFiles=[path.join(unity,delivery.destination,'User/Asset.prefab'),path.join(unity,delivery.destination,'User/Asset.prefab.meta'),path.join(unity,'Assets/AutoRigReference.unity'),path.join(unity,'Assets/AutoRigReference.unity.meta')];
let preserved:Record<string,string>|undefined;
if(mode==='reimport'){
 assert(evidence.first?.result?.passed);preserved=Object.fromEntries(protectedFiles.map(f=>[f,sha(f)]));
 const inbox=path.join(unity,'Library/PartsmithGraphicsInbox',delivery.id+'.json');assert(!fs.existsSync(inbox));for(const f of queue.files)assert.equal(sha(f.source),f.sha256);
 fs.writeFileSync(inbox,JSON.stringify(queue),{flag:'wx'});
}
fs.writeFileSync(path.join(unity,'Library/AutoRigCheckRequest.json'),JSON.stringify({destination:delivery.destination,mapping:queue.rigContract.humanBones,expectedDimensions:physical.dimensionsMeters,secondPass:mode==='reimport'}));
await command(['run',unity,'--format','json','--timeout','300','--','-executeMethod','AutoRigUnityCheck.Run','-logFile',path.join(runtime,logPrefix+'-'+mode+'-editor.log')],mode);
const result=read(path.join(unity,'AutoRigEvidence',mode==='first'?'import.json':'reimport.json'));assert.equal(result.passed,true);assert.equal(result.playMode,false);assert.equal(result.avatarValid,true);assert.equal(result.avatarHuman,true);assert.equal(result.exactMapping,true);
const receipt=inspectUnityDelivery(unity,delivery);assert.equal(receipt.status,'imported',JSON.stringify(receipt.errors));
evidence[mode]={result,receipt};
if(mode==='reimport'){
 assert.equal(result.generatedGuid,evidence.first.result.generatedGuid);assert.equal(result.userGuid,evidence.first.result.userGuid);
 assert.deepEqual(Object.fromEntries(protectedFiles.map(f=>[f,sha(f)])),preserved);evidence.preservedUserFiles=preserved;
}
for(const f of fixture.sourceFiles)assert.equal(sha(path.join(fixture.projectRoot,f.path)),f.sha256);assert.equal(sha(fixture.original),fixture.originalSha256);
save();console.log(JSON.stringify({mode,avatar:result.avatarValid,human:result.avatarHuman,exactMapping:result.exactMapping,vertices:result.vertices,weightedVertices:result.weightedVertices,invalidWeights:result.invalidWeights,dimensions:result.dimensions,receipt:receipt.status}));
