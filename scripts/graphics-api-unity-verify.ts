/** Read-only verification of the existing API pilot's Unity import.
 * Does not open Partsmith/Unity, initialize Store, queue a request or enter Play Mode.
 * Writes evidence only under this repository's artifacts/runtime directory.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  inspectUnityDelivery,
  readUnityTarget,
} from "../engine/graphics-unity";
import type { GraphicsWorkspace, UnityDelivery } from "../shared/graphics";
import type { Project } from "../shared/types";
import { graphicsTripoReserved } from "../shared/graphics-catalog";

const repo = process.cwd();
const runtime = path.join(repo, "artifacts/runtime");
const baselineFile = path.join(runtime, "graphics-api-unity-baseline.json");
const firstDeliveryFile = path.join(runtime, "graphics-api-unity-first-delivery-baseline.json");
const postfixFile = path.join(runtime,"graphics-api-unity-postfix-baseline.json");
const reuseMode=process.argv.includes("--verify-reuse");
const materialsMode = process.argv.includes("--verify-materials")||reuseMode;
const resultFile = path.join(runtime, reuseMode ? "graphics-api-unity-reuse-verify.json" : materialsMode ? "graphics-api-unity-materials-verify.json" : "graphics-api-unity-verify.json");
const json = <T = any>(file: string): T =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const sha = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const slash = (file: string) => file.replaceAll("\\", "/");
const samePath = (a: string, b: string) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const write = (file: string, value: unknown) => {
  assert.equal(path.dirname(file), runtime);
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  fs.renameSync(file + ".tmp", file);
};
const contained = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
function fileInside(root: string, relative: string) {
  assert(!path.isAbsolute(relative), "Manifest paths must be relative");
  const file = path.resolve(root, relative);
  assert(contained(root, file), "File escaped declared project root");
  let existing = file;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = fs.realpathSync(existing);
  assert(
    samePath(root, real) || contained(root, real),
    "Linked path escaped declared project root",
  );
  return file;
}
type Entry = { path: string; sha256: string; bytes: number };
function inventory(root: string, folders: string[]): Entry[] {
  const result: Entry[] = [];
  const walk = (folder: string) => {
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      assert(
        !entry.isSymbolicLink(),
        "Do not follow links in preserved Unity inventory",
      );
      const file = fileInside(
        root,
        path.relative(root, path.join(folder, entry.name)),
      );
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile())
        result.push({
          path: slash(path.relative(root, file)),
          bytes: fs.statSync(file).size,
          sha256: sha(file),
        });
    }
  };
  folders.forEach((folder) => walk(fileInside(root, folder)));
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function verifyFiles(root: string, entries: Entry[]) {
  for (const entry of entries) {
    const file = fileInside(root, entry.path);
    assert(fs.existsSync(file), "Preserved file is missing: " + entry.path);
    assert.equal(
      fs.statSync(file).size,
      entry.bytes,
      "Preserved file size changed: " + entry.path,
    );
    assert.equal(
      sha(file),
      entry.sha256,
      "Preserved file bytes changed: " + entry.path,
    );
  }
}
const guid = (file:string) => {
  const value=fs.readFileSync(file,"utf8").match(/^guid:\s*([a-f\d]{32})\s*$/m)?.[1];
  assert(value,"Missing Unity GUID: "+file);return value;
};
function preserveFirstDelivery(unityRoot:string, projectId:string, objectId:string) {
  if(fs.existsSync(firstDeliveryFile)){
    const previous=json(firstDeliveryFile);assert.equal(previous.projectId,projectId);assert.equal(previous.objectId,objectId);
    assert(samePath(previous.unityRoot,unityRoot));verifyFiles(unityRoot,previous.userFiles);return previous;
  }
  const initialFile=path.join(runtime,"graphics-api-unity-verify.json"), report=json(initialFile);
  assert.equal(report.projectId,projectId);assert.equal(report.objectId,objectId);assert.equal(report.imported,true);
  assert(!report.delivery.files.some((f:Entry)=>f.path.endsWith("/materials.json")),"Initial X05 evidence was already replaced by a material-fixed delivery");
  const manifest=json(fileInside(unityRoot,report.delivery.destination+"/Generated/partsmith-manifest.json"));
  assert.equal(manifest.requestId,report.delivery.id,"Capture first prefab evidence before importing the fixed delivery");
  verifyFiles(unityRoot,report.generatedFiles);
  const userFiles=[report.delivery.userPrefabPath,report.delivery.userPrefabPath+".meta"].map((relative:string)=>{
    const file=fileInside(unityRoot,relative);return {path:relative,sha256:sha(file),bytes:fs.statSync(file).size};
  });
  const baseline={schemaVersion:1,createdAt:new Date().toISOString(),projectId,objectId,unityRoot,
    initialEvidenceSha256:sha(initialFile),initialEvidence:report,userFiles,
    generatedPrefabGuid:guid(fileInside(unityRoot,report.delivery.prefabPath+".meta")),
    userPrefabGuid:guid(fileInside(unityRoot,report.delivery.userPrefabPath+".meta"))};
  assert.equal(baseline.generatedPrefabGuid,report.delivery.guid);
  write(firstDeliveryFile,baseline);return baseline;
}
function verifyPreservedFiles(unityRoot:string, entries:Entry[]) {
  const bridge="Assets/PartsmithGraphicsBridge/Editor/PartsmithGraphicsBridge.cs";
  const updates:unknown[]=[];
  for(const entry of entries){
    const actual=fileInside(unityRoot,entry.path);
    if(entry.path===bridge&&fs.existsSync(actual)&&sha(actual)!==entry.sha256){
      // Only this app-owned converter source may change; its .meta and every user file remain strict.
      const owner=json(fileInside(unityRoot,"Library/PartsmithGraphicsBridge.json"));
      const current=sha(path.join(repo,"integrations/unity/Editor/PartsmithGraphicsBridge.cs"));
      assert.equal(sha(actual),current,"Changed bridge is not the current reviewed converter");assert.equal(owner.sha256,current,"Changed bridge has no matching host ownership receipt");
      assert.equal(typeof owner.converterVersion,"string");assert(owner.converterVersion.includes(current.slice(0,12)));
      updates.push({path:bridge,previousSha256:entry.sha256,sha256:current,converterVersion:owner.converterVersion});
    }else verifyFiles(unityRoot,[entry]);
  }
  return updates;
}
function imageSize(file:string) {
  const raw=fs.readFileSync(file);
  if(raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {width:raw.readUInt32BE(16),height:raw.readUInt32BE(20)};
  assert.equal(raw.readUInt16BE(0),0xffd8,"Expected preserved PNG/JPEG: "+file);
  let offset=2;
  while(offset+4<=raw.length){
    assert.equal(raw[offset++],255,"Invalid JPEG marker");while(raw[offset]===255)offset++;
    const marker=raw[offset++];if(marker===0xd9||marker===0xda)break;
    const length=raw.readUInt16BE(offset);assert(length>=2&&offset+length<=raw.length);
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return {width:raw.readUInt16BE(offset+5),height:raw.readUInt16BE(offset+3)};
    offset+=length;
  }
  throw Error("No JPEG dimensions: "+file);
}
const escapeRegex=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
function yamlNumber(text:string,key:string) {
  const value=text.match(new RegExp("^\\s*(?:-\\s*)?"+escapeRegex(key)+":\\s*(-?[\\d.eE+-]+)\\s*$","m"))?.[1];
  assert(value!==undefined,"Missing numeric Unity field: "+key);return Number(value);
}
function verifyMaterialDelivery(unityRoot:string, delivery:UnityDelivery, request:any) {
  let baseline:any;
  if(fs.existsSync(firstDeliveryFile))baseline=json(firstDeliveryFile);
  else{
    // The first report was overwritten before a User-byte snapshot existed. Recover only durable facts.
    const first=workspace.deliveries.filter(d=>d.objectId===delivery.objectId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];assert(first);
    const initialRequestFile=fileInside(unityRoot,`Library/PartsmithGraphicsStaging/${first.id}/request.json`);
    const initialReceiptFile=fileInside(unityRoot,`Library/PartsmithGraphicsResults/${first.id}.json`);
    const initialRequest=json(initialRequestFile),initialReceipt=json(initialReceiptFile);
    assert.equal(initialReceipt.status,"imported");assert.equal(initialRequest.requestId,first.id);assert.equal(initialReceipt.requestId,first.id);assert.equal(initialReceipt.objectId,delivery.objectId);
    assert.equal(initialRequest.objectId,delivery.objectId);assert.equal(initialRequest.converterVersion,initialReceipt.converterVersion);
    const initial={...first,guid:initialReceipt.guid,prefabPath:initialReceipt.prefabPath,userPrefabPath:initialReceipt.userPrefabPath};
    assert(!initial.files.some(f=>f.path.endsWith("/materials.json")));
    baseline={schemaVersion:1,createdAt:new Date().toISOString(),objectId:delivery.objectId,unityRoot,
      source:"durable first delivery request and receipt; no pre-fix User byte snapshot",initialEvidence:{delivery:initial,receipt:initialReceipt},
      initialRequestPath:slash(path.relative(unityRoot,initialRequestFile)),initialRequestSha256:sha(initialRequestFile),
      initialReceiptPath:slash(path.relative(unityRoot,initialReceiptFile)),initialReceiptSha256:sha(initialReceiptFile),
      generatedPrefabGuid:initialReceipt.guid,userFiles:null,userPrefabGuid:null};
    const recoveredFile=path.join(runtime,"graphics-api-unity-first-receipt-evidence.json");
    if(fs.existsSync(recoveredFile)){
      const saved=json(recoveredFile);assert.equal(saved.initialRequestSha256,baseline.initialRequestSha256);assert.equal(saved.initialReceiptSha256,baseline.initialReceiptSha256);assert.equal(saved.generatedPrefabGuid,baseline.generatedPrefabGuid);baseline=saved;
    }else write(recoveredFile,baseline);
  }
  assert.equal(baseline.objectId,delivery.objectId);assert(samePath(baseline.unityRoot,unityRoot));
  const initial=baseline.initialEvidence.delivery;
  assert.notEqual(delivery.id,initial.id,"The original X05 import is not a fixed material delivery");
  assert.equal(delivery.prefabPath,initial.prefabPath);assert.equal(delivery.userPrefabPath,initial.userPrefabPath);
  assert.equal(guid(fileInside(unityRoot,delivery.prefabPath!+".meta")),baseline.generatedPrefabGuid);
  const historicalUserProof=Array.isArray(baseline.userFiles)&&baseline.userFiles.length===2&&typeof baseline.userPrefabGuid==="string";
  const currentUserGuid=guid(fileInside(unityRoot,delivery.userPrefabPath!+".meta"));
  if(historicalUserProof){assert.equal(currentUserGuid,baseline.userPrefabGuid);verifyFiles(unityRoot,baseline.userFiles);}
  const relative=delivery.destination+"/Generated/materials.json";
  assert.equal(request.materialManifest,relative);
  const frozen=delivery.files.find(f=>f.path===relative);assert(frozen,"Material manifest must be a frozen delivery file");
  const manifestFile=fileInside(unityRoot,relative);assert.equal(sha(manifestFile),frozen.sha256);
  const manifest=json(manifestFile);assert.equal(manifest.schemaVersion,1);assert.equal(manifest.materials.length,1);assert.equal(manifest.originalImages.length,3);assert.equal(manifest.derivedImages.length,1);
  const material=manifest.materials[0];assert.equal(material.supported,true,material.warning);
  assert.equal(material.metallicSource.channel,"B");assert.equal(material.roughnessSource.channel,"G");assert.equal(material.metallicSource.path,material.roughnessSource.path);
  const originalHashes=initial.files.filter((f:Entry)=>f.path.includes("/Generated/Textures/")).map((f:Entry)=>f.sha256).sort();
  assert.deepEqual(manifest.originalImages.map((f:Entry)=>f.sha256).sort(),originalHashes,"The original three source maps must retain their exact bytes");
  const textures=[...manifest.originalImages,...manifest.derivedImages].map((e:any)=>{
    const relative=delivery.destination+"/Generated/"+e.path, file=fileInside(unityRoot,relative);
    const declared=delivery.files.find(f=>f.path===relative);assert(declared);assert.equal(declared.sha256,e.sha256);assert.equal(sha(file),e.sha256);
    assert.deepEqual(imageSize(file),{width:4096,height:4096});assert.equal(e.width,4096);assert.equal(e.height,4096);
    const metadata=fs.readFileSync(file+".meta","utf8");
    const role=e.path===material.normalTexture?"normal":e.path===material.baseColorTexture?"color":"linear";
    assert.equal(yamlNumber(metadata,"textureType"),role==="normal"?1:0,relative+" importer type");
    assert.equal(yamlNumber(metadata,"sRGBTexture"),role==="color"?1:0,relative+" color space");
    assert.equal(yamlNumber(metadata,"nPOTScale"),0);
    if(role==="normal"){assert.equal(yamlNumber(metadata,"convertToNormalMap"),0);assert.equal(yamlNumber(metadata,"flipGreenChannel"),0);}
    const blocks=[...metadata.matchAll(/^  - serializedVersion:[\s\S]*?(?=^  - serializedVersion:|^  spriteSheet:|$(?![\s\S]))/gm)].map(m=>m[0]);
    const defaults=blocks.find(b=>/buildTarget:\s*DefaultTexturePlatform\s*$/m.test(b));assert(defaults,"Default texture platform is missing");
    const standalone=blocks.find(b=>/buildTarget:\s*Standalone\s*$/m.test(b));
    const effective=standalone&&yamlNumber(standalone,"overridden")===1?standalone:defaults;
    assert(yamlNumber(effective,"maxTextureSize")>=4096,"Texture importer would downscale the original 4K map");assert.equal(yamlNumber(effective,"textureCompression"),0,"Texture importer would use lossy compression");
    assert.equal(yamlNumber(effective,"crunchedCompression"),0);
    return {path:relative,sourcePath:e.path,sha256:e.sha256,guid:guid(file+".meta"),role,width:4096,height:4096,textureType:yamlNumber(metadata,"textureType"),sRGB:yamlNumber(metadata,"sRGBTexture")===1,maxTextureSize:yamlNumber(effective,"maxTextureSize"),compression:"uncompressed"};
  });
  const token=createHash("sha256").update(material.name).digest("hex").slice(0,16);
  const materialPath=delivery.destination+"/Generated/Materials/Material-"+token+".mat";
  const mat=fs.readFileSync(fileInside(unityRoot,materialPath),"utf8"), materialGuid=guid(fileInside(unityRoot,materialPath+".meta"));
  const shaderPackage=fs.readdirSync(fileInside(unityRoot,"Library/PackageCache")).filter(name=>name.startsWith("com.unity.render-pipelines.universal@"));assert.equal(shaderPackage.length,1);
  const shaderGuid=guid(fileInside(unityRoot,"Library/PackageCache/"+shaderPackage[0]+"/Shaders/Lit.shader.meta"));
  assert.match(mat,new RegExp("m_Shader: \\{fileID: 4800000, guid: "+shaderGuid+","));
  const bindings=Object.fromEntries([["_BaseMap",material.baseColorTexture],["_BumpMap",material.normalTexture],["_MetallicGlossMap",material.metallicGlossTexture]].map(([key,texturePath])=>{
    const expected=textures.find(t=>t.sourcePath===texturePath);assert(expected);
    const block=mat.match(new RegExp("^    - "+escapeRegex(key)+":[\\s\\S]*?(?=^    - |^    m_|$(?![\\s\\S]))","m"))?.[0];assert(block,"Material texture binding is missing: "+key);
    assert.match(block,new RegExp("m_Texture: \\{fileID: 2800000, guid: "+expected.guid+","));
    assert.match(block,/m_Scale: \{x: 1, y: 1\}/);assert.match(block,/m_Offset: \{x: 0, y: 0\}/);return [key,expected.guid];
  }));
  assert.match(mat,/- _BaseColor: \{r: 1, g: 1, b: 1, a: 1\}/);
  for(const [key,value] of Object.entries({_Metallic:1,_Smoothness:1,_BumpScale:1,_SmoothnessTextureChannel:0,_WorkflowMode:1}))assert.equal(yamlNumber(mat,key),value);
  const keywordBlock=mat.match(/^  m_ValidKeywords:[\s\S]*?(?=^  m_InvalidKeywords:)/m)?.[0];assert(keywordBlock);
  for(const keyword of ["_NORMALMAP","_METALLICSPECGLOSSMAP"])assert.match(keywordBlock,new RegExp("^  - "+keyword+"\\s*$","m"));
  assert(!keywordBlock.includes("_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A"));assert(!keywordBlock.includes("_SPECULAR_SETUP"));
  const fbxMeta=fs.readFileSync(fileInside(unityRoot,delivery.destination+"/Generated/Asset.fbx.meta"),"utf8");assert(fbxMeta.includes("guid: "+materialGuid),"FBX must remap to the verified material asset");
  return {manifestPath:relative,manifestSha256:frozen.sha256,sourceMapsUnchanged:true,textures,materialPath,materialGuid,shaderGuid,bindings,
    baseColor:[1,1,1,1],metallic:1,smoothness:1,normalScale:1,keywords:["_NORMALMAP","_METALLICSPECGLOSSMAP"],
    firstDeliveryId:initial.id,generatedPrefabGuid:baseline.generatedPrefabGuid,generatedPrefabGuidPreserved:true,currentUserPrefabGuid:currentUserGuid,
    firstUpdateUserPrefabGuidPreserved:historicalUserProof?true:null,firstUpdateUserPrefabBytesUnchanged:historicalUserProof?true:null,firstUpdateUserPrefabMetaUnchanged:historicalUserProof?true:null,
    firstUpdateUserPreservation:historicalUserProof?"verified":"not_measured: no User prefab or metadata hash was captured before the first material-fixed import",
    fullPixelComparisonRepeated:false};
}
function postfixEvidence(unityRoot:string,delivery:UnityDelivery) {
  const entries=inventory(unityRoot,[delivery.destination+"/Generated",delivery.destination+"/User"]);
  const requestPath=`Library/PartsmithGraphicsStaging/${delivery.id}/request.json`;
  const jobs=project.jobs.map(j=>({id:j.id,remoteId:j.remoteId,status:j.status,credits:j.credits}));
  const stages=fs.readdirSync(fileInside(unityRoot,"Library/PartsmithGraphicsStaging")).sort();
  const receipts=fs.readdirSync(fileInside(unityRoot,"Library/PartsmithGraphicsResults")).filter(name=>name.endsWith(".json")).sort();
  assert.deepEqual(pendingNames(unityRoot,"Library/PartsmithGraphicsInbox"),[],"Import must finish before a reuse baseline is measured");
  if(!reuseMode){
    if(!fs.existsSync(postfixFile))write(postfixFile,{schemaVersion:1,capturedAt:new Date().toISOString(),scope:"Post-fix baseline only; does not prove first-update User byte preservation",projectId:project.id,objectId:delivery.objectId,unityRoot,deliveryId:delivery.id,versionIds:delivery.versionIds,
      files:entries,requestPath,requestSha256:sha(fileInside(unityRoot,requestPath)),generatedPrefabGuid:delivery.guid,userPrefabGuid:guid(fileInside(unityRoot,delivery.userPrefabPath!+".meta")),stages,receipts,jobs,reservedCredits:graphicsTripoReserved(workspace)});
    return {baselineFile:postfixFile,scope:"postfix",reuseVerified:false};
  }
  const before=json(postfixFile);assert.equal(before.projectId,project.id);assert.equal(before.objectId,delivery.objectId);assert(samePath(before.unityRoot,unityRoot));
  assert.equal(delivery.id,before.deliveryId,"Same-input delivery must reuse its existing immutable request");assert.deepEqual(delivery.versionIds,before.versionIds);
  assert.equal(sha(fileInside(unityRoot,before.requestPath)),before.requestSha256);verifyFiles(unityRoot,before.files);assert.deepEqual(entries,before.files,"No managed or User files may be added, removed or changed by same-input reuse");
  assert.equal(delivery.guid,before.generatedPrefabGuid);assert.equal(guid(fileInside(unityRoot,delivery.userPrefabPath!+".meta")),before.userPrefabGuid);
  assert.deepEqual(stages,before.stages,"A new Unity staging request was created");assert.deepEqual(receipts,before.receipts,"A new Unity import receipt was created");
  assert.deepEqual(jobs,before.jobs,"Existing API production jobs changed");assert.equal(graphicsTripoReserved(workspace),before.reservedCredits);
  return {baselineFile:postfixFile,scope:"postfix",reuseVerified:true,deliveryId:delivery.id,managedAndUserFilesUnchanged:entries.length,requestUnchanged:true,newStagingRequests:0,newImportReceipts:0,apiJobsUnchanged:true,reservedCreditsUnchanged:true};
}
function pendingNames(root: string, relative: string) {
  const folder = fileInside(root, relative);
  return fs.existsSync(folder)
    ? fs.readdirSync(folder).filter((name) => name.endsWith(".json"))
    : [];
}
function noLegacyTriggers(root: string) {
  assert.equal(
    fs.existsSync(
      fileInside(root, "Library/PartsmithResults/verify-play.json"),
    ),
    false,
    "A legacy Play Mode trigger exists; do not start Unity for import-only verification",
  );
  assert.deepEqual(
    pendingNames(root, "Library/PartsmithInbox"),
    [],
    "Unrelated legacy Unity import requests are pending",
  );
}

if (process.argv.includes("--help")) {
  console.log(
    "npx tsx scripts/graphics-api-unity-verify.ts --snapshot | --verify | --snapshot-materials | --verify-materials | --verify-reuse\n--snapshot: preserve existing Unity Assets/Packages/ProjectSettings hashes in repository evidence before X05.\n--snapshot-materials: preserve the first X05 report and Generated/User prefab GUIDs plus User prefab bytes before the fixed import.\n--verify-materials: verify fixed source maps, material/importer bindings and available first-delivery evidence; preserve a separate post-fix baseline without inventing missing earlier hashes.\n--verify-reuse: verify the same delivery/request, all post-fix Generated/User bytes and no new Unity staging/receipt or API production jobs after an explicit same-input app action.\n--verify: read the pilot X05 delivery, host import receipt, actual files/GUIDs and preserved assets. Exit 2 means not yet imported. No mode starts apps, queues work or changes Unity/profile files.",
  );
  process.exit(0);
}
assert(
  ["--snapshot","--verify","--snapshot-materials","--verify-materials","--verify-reuse"].filter(flag=>process.argv.includes(flag)).length===1,
  "Choose one documented snapshot or verification mode",
);
const pilot = json(path.join(runtime, "graphics-api-live.json"));
assert.equal(pilot.limit, 300);
assert(
  typeof pilot.projectId === "string" && typeof pilot.objectId === "string",
  "Existing API pilot identity is required",
);
const projectRoot = fs.realpathSync(
  path.join(pilot.profile, "projects", pilot.projectId),
);
const project = json<Project>(path.join(projectRoot, "project.json"));
assert.equal(project.id, pilot.projectId);
const workspace = json<GraphicsWorkspace>(
  path.join(projectRoot, "graphics/workspace.json"),
);
assert.equal(workspace.projectId, project.id);
const unityRoot = fs.realpathSync(project.unityPath);
assert(
  samePath(unityRoot, "C:/Unity/3D Tool Test"),
  "This verifier is scoped to the existing 3D Tool Test project",
);
const target = readUnityTarget(unityRoot);
const sceneSetupFile = fileInside(
  unityRoot,
  "Library/LastSceneManagerSetup.txt",
);
noLegacyTriggers(unityRoot);
for (const version of workspace.versions)
  verifyFiles(projectRoot, version.files);

if(process.argv.includes("--snapshot-materials")){
  const first=preserveFirstDelivery(unityRoot,project.id,pilot.objectId);
  console.log(JSON.stringify({status:"first_delivery_preserved",firstDeliveryFile,deliveryId:first.initialEvidence.delivery.id,generatedPrefabGuid:first.generatedPrefabGuid,userPrefabGuid:first.userPrefabGuid,userFiles:first.userFiles.length,appsStarted:0,profileWrites:0,unityWrites:0}));
  process.exit(0);
}

if (process.argv.includes("--snapshot")) {
  assert(
    !workspace.deliveries.some(
      (delivery) => delivery.objectId === pilot.objectId,
    ),
    "Capture the baseline before preparing the pilot's first Unity delivery",
  );
  assert.deepEqual(
    pendingNames(unityRoot, "Library/PartsmithGraphicsInbox"),
    [],
    "Another graphics delivery is already pending",
  );
  if (fs.existsSync(baselineFile)) {
    const previous = json(baselineFile);
    assert.equal(previous.projectId, project.id);
    assert(samePath(previous.unityRoot, unityRoot));
    verifyFiles(unityRoot, previous.files);
    console.log(
      JSON.stringify({
        status: "baseline_reused",
        baselineFile,
        existingFiles: previous.files.length,
      }),
    );
  } else {
    const files = inventory(unityRoot, [
      "Assets",
      "Packages",
      "ProjectSettings",
    ]);
    const baseline = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      projectId: project.id,
      objectId: pilot.objectId,
      unityRoot,
      target,
      files,
      sceneFiles: files.filter((file) => file.path.endsWith(".unity")),
      sceneSetup: fs.existsSync(sceneSetupFile)
        ? fs.readFileSync(sceneSetupFile, "utf8")
        : null,
      sourceFiles: workspace.versions.flatMap((version) => version.files),
      legacyPendingImports: 0,
      legacyPlayTrigger: false,
    };
    write(baselineFile, baseline);
    console.log(
      JSON.stringify({
        status: "baseline_saved",
        baselineFile,
        existingFiles: files.length,
        existingScenes: baseline.sceneFiles.length,
        unityVersion: target.unityVersion,
        pipeline: target.pipeline,
        appsStarted: 0,
        profileWrites: 0,
        unityWrites: 0,
      }),
    );
  }
} else {
  const baseline = json(baselineFile);
  assert.equal(baseline.projectId, project.id);
  assert.equal(baseline.objectId, pilot.objectId);
  assert(samePath(baseline.unityRoot, unityRoot));
  const ownedConverterUpdates=verifyPreservedFiles(unityRoot, baseline.files);
  verifyFiles(projectRoot, baseline.sourceFiles);
  const tasks = workspace.tasks.filter(
    (task) => task.objectId === pilot.objectId && task.taskId === "X05",
  );
  const task = tasks.at(-1);
  const delivery = task?.deliveryId
    ? workspace.deliveries.find((item) => item.id === task.deliveryId)
    : undefined;
  const checked: UnityDelivery | undefined = delivery
    ? inspectUnityDelivery(unityRoot, delivery)
    : undefined;
  const imported = checked?.status === "imported";
  const requestPath = delivery
    ? fileInside(
        unityRoot,
        `Library/PartsmithGraphicsStaging/${delivery.id}/request.json`,
      )
    : undefined;
  const request =
    requestPath && fs.existsSync(requestPath) ? json(requestPath) : undefined;
  const reportPath = delivery
    ? fileInside(
        unityRoot,
        `Library/PartsmithGraphicsResults/${delivery.id}.json`,
      )
    : undefined;
  const receipt =
    reportPath && fs.existsSync(reportPath) ? json(reportPath) : undefined;
  if (task) {
    assert.equal(task.localOnly, true);
    assert.equal(task.cost?.credits, 0);
    assert(
      task.targetProfile && samePath(task.targetProfile.projectPath, unityRoot),
    );
  }
  if (request) {
    assert.equal(request.objectId, pilot.objectId);
    assert.equal(request.profileFingerprint, target.fingerprint);
    assert.equal(request.mode, "model");
    assert.deepEqual(
      request.expectedClips,
      [],
      "This verification is scoped to the static API greatsword",
    );
    const allowedSources = new Map(
      workspace.versions
        .filter((version) => task!.inputVersionIds.includes(version.id))
        .flatMap((version) =>
          version.files.map(
            (file) =>
              [
                path.resolve(projectRoot, file.path).toLowerCase(),
                file.sha256,
              ] as const,
          ),
        ),
    );
    for (const source of request.sources)
      assert.equal(
        allowedSources.get(path.resolve(source.path).toLowerCase()),
        source.sha256,
      );
  }
  let generated: Entry[] = [];
  let materialVerification:ReturnType<typeof verifyMaterialDelivery>|undefined;
  let postfixVerification:ReturnType<typeof postfixEvidence>|undefined;
  if (imported) {
    assert.equal(receipt.playbackVerified, false);
    assert.deepEqual(receipt.errors, []);
    assert.equal(receipt.unityVersion, target.unityVersion);
    assert.equal(receipt.pipeline, target.pipeline);
    assert.equal(checked!.playbackVerified, false);
    const manifest = json(
      fileInside(
        unityRoot,
        delivery!.destination + "/Generated/partsmith-manifest.json",
      ),
    );
    assert.equal(manifest.requestId, delivery!.id);
    assert.equal(manifest.objectId, pilot.objectId);
    verifyFiles(unityRoot, manifest.files);
    generated = manifest.files;
    assert(checked!.guid && checked!.prefabPath && checked!.userPrefabPath);
    assert(
      fs.existsSync(fileInside(unityRoot, checked!.userPrefabPath + ".meta")),
      "User prefab metadata is missing",
    );
    if(materialsMode){materialVerification=verifyMaterialDelivery(unityRoot,checked!,request);postfixVerification=postfixEvidence(unityRoot,checked!);}
  }
  const sources = workspace.versions.flatMap((version) => version.files);
  const result = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    status: checked?.status ?? "waiting_for_delivery",
    imported,
    projectId: project.id,
    objectId: pilot.objectId,
    unityRoot,
    taskId: task?.id,
    taskStatus: task?.status,
    delivery: checked,
    receipt,
    originalImageSha256: pilot.originalImageSha256,
    sourcesVerified: sources.length,
    existingFilesPreserved: baseline.files.length-ownedConverterUpdates.length,
    baselineFilesChecked:baseline.files.length,
    ownedConverterUpdates,
    existingScenesPreserved: baseline.sceneFiles.length,
    sceneSetupUnchanged:
      baseline.sceneSetup ===
      (fs.existsSync(sceneSetupFile)
        ? fs.readFileSync(sceneSetupFile, "utf8")
        : null),
    sourceFiles: sources,
    generatedFiles: generated,
    ...(materialsMode?{materialsVerified:!!materialVerification,materialVerification,postfixVerification}:{}),
    reservedCredits: graphicsTripoReserved(workspace),
    jobs: project.jobs.map((job) => ({
      id: job.id,
      remoteId: job.remoteId,
      status: job.status,
      credits: job.credits,
    })),
    importOnly: true,
    playbackVerified: false,
    appsStarted: 0,
    submissions: 0,
    profileWrites: 0,
    unityWrites: 0,
  };
  write(resultFile, result);
  console.log(
    JSON.stringify({
      status: result.status,
      imported,
      taskStatus: result.taskStatus,
      resultFile,
      existingFilesPreserved: result.existingFilesPreserved,
      existingScenesPreserved: result.existingScenesPreserved,
      sceneSetupUnchanged: result.sceneSetupUnchanged,
      sourcesVerified: result.sourcesVerified,
      prefabGuid: checked?.guid,
      errors: checked?.errors ?? [],
      ...(materialsMode?{materialsVerified:!!materialVerification,firstUpdateUserPreservation:materialVerification?.firstUpdateUserPreservation,postfixVerification}:{}),
      playbackVerified: false,
    }),
  );
  if (!imported)
    process.exitCode =
      checked?.status === "failed" || checked?.status === "conflict" ? 1 : 2;
}
