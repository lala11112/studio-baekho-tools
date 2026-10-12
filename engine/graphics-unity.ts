import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { runProcess } from "./local";
import type { AssetVersion, GraphicsFile, GraphicsObject, UnityDelivery, UnityTargetProfile } from "../shared/graphics";

export const GRAPHICS_UNITY_CONVERTER = "graphics-unity-1";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sha = (file: string) => digest(fs.readFileSync(file));
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const slash = (p: string) => p.replaceAll("\\", "/");
const read = (file: string) => fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  fs.renameSync(file + ".tmp", file);
};
function contained(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}
/** Reject junctions/symlinks in existing ancestors, including destinations not created yet. */
function safePath(root: string, relative: string) {
  if (path.isAbsolute(relative) || relative.includes("\0")) throw Error("외부 경로는 Unity 관리 파일로 사용할 수 없습니다.");
  const file = path.resolve(root, relative);
  if (!contained(root, file)) throw Error("Unity 관리 경로가 프로젝트 밖을 가리킵니다.");
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = fs.realpathSync(ancestor);
  if (actual !== root && !contained(root, actual)) throw Error("Unity 관리 폴더의 링크가 프로젝트 밖을 가리킵니다.");
  return file;
}
function files(root: string, max = 60000): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const walk = (folder: string) => {
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(folder, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { result.push(p); if (result.length > max) throw Error("Unity 파일 검사 범위를 초과했습니다."); }
    }
  };
  walk(root); return result;
}
function pipelineRef(text: string, key: string) {
  const value = text.match(new RegExp("(?:^|\\n)\\s*" + key + ":\\s*\\{([^}]+)\\}"))?.[1];
  if (!value) return undefined;
  if (/fileID:\s*0(?:\s|,|$)/.test(value)) return null;
  return value.match(/guid:\s*([a-f\d]{32})/i)?.[1].toLowerCase();
}

/** Reads the PC target without changing project settings or relying on installed package names alone. */
export function readUnityTarget(projectPath: string): UnityTargetProfile {
  const root = fs.realpathSync(projectPath), warnings: string[] = [];
  const versionFile = safePath(root, "ProjectSettings/ProjectVersion.txt");
  const version = read(versionFile).match(/^m_EditorVersion:\s*(\S+)/m)?.[1];
  if (!version || !fs.statSync(safePath(root, "Assets")).isDirectory()) throw Error("올바른 Unity 프로젝트를 선택하세요.");
  const graphicFile = safePath(root, "ProjectSettings/GraphicsSettings.asset");
  const qualityFile = safePath(root, "ProjectSettings/QualitySettings.asset");
  const packageFile = safePath(root, "Packages/manifest.json");
  const graphics = fs.existsSync(graphicFile) ? read(graphicFile) : "";
  const quality = fs.existsSync(qualityFile) ? read(qualityFile) : "";
  const packageData = fs.existsSync(packageFile) ? json(packageFile) : {};
  const packages: Record<string, string> = Object.fromEntries(Object.entries(packageData.dependencies ?? {}).filter((e): e is [string,string] => typeof e[1] === "string").sort(([a],[b]) => a.localeCompare(b)));
  const groups = quality.split(/\n  - serializedVersion:/).slice(1);
  const pcIndex = quality.match(/m_PerPlatformDefaultQuality:[\s\S]*?\n    Standalone:\s*(\d+)/)?.[1];
  const currentIndex = quality.match(/m_CurrentQuality:\s*(\d+)/)?.[1];
  const index = Number(pcIndex ?? currentIndex ?? 0);
  if (pcIndex === undefined && quality) warnings.push("PC 기본 품질 설정이 없어 현재 편집기 품질 설정을 읽었습니다.");
  const qualityGuid = groups[index] ? pipelineRef(groups[index], "customRenderPipeline") : null;
  const graphicsGuid = pipelineRef(graphics, "m_CustomRenderPipeline");
  const guid = qualityGuid || graphicsGuid;
  let pipeline: UnityTargetProfile["pipeline"] = "unknown";
  const evidence: { path: string; sha256: string }[] = [];
  if (graphicsGuid === null && !qualityGuid) pipeline = "builtin";
  else if (guid) {
    const candidates = [...files(safePath(root, "Assets")), ...files(safePath(root, "Packages"))];
    const matches = candidates.filter(f => f.endsWith(".meta") && new RegExp("^guid:\\s*" + guid + "\\s*$", "m").test(read(f)));
    if (matches.length === 1) {
      const asset = matches[0].slice(0, -5);
      safePath(root, path.relative(root, asset));
      if (fs.existsSync(asset)) {
        const content = read(asset);
        evidence.push({ path: slash(path.relative(root, asset)), sha256: sha(asset) });
        if (/m_RendererDataList:/.test(content) || /UniversalRenderPipelineAsset/.test(content)) pipeline = "urp";
        else if (/HDRenderPipelineAsset/.test(content) || /m_RenderPipelineResources:/.test(content) && /m_RenderPipelineRayTracingResources:/.test(content)) pipeline = "hdrp";
      }
    }
    if (pipeline === "unknown") warnings.push("지정된 렌더 파이프라인 GUID의 에셋 종류를 확인하지 못했습니다.");
  } else if (pipeline === "unknown") warnings.push("렌더 파이프라인 설정을 읽지 못했습니다. Built-in으로 추정하지 않습니다.");
  const lockFile = safePath(root, "Packages/packages-lock.json");
  const fingerprint = digest(JSON.stringify({ root: root.toLowerCase(), version, graphics, quality, packages, packageLock: fs.existsSync(lockFile) ? sha(lockFile) : null, evidence, platform: "pc" }));
  return { id: "unity-" + digest(root.toLowerCase()).slice(0,24), projectPath: root, unityVersion: version, pipeline, platform: "pc", packages, inspectedAt: new Date().toISOString(), fingerprint, warnings };
}

type Input = GraphicsFile & { absolute: string; versionId: string };
type Output = { source: string; destination: string; sha256: string; bytes: number; kind: string };
export type GraphicsUnityOptimization = { lodEnabled:boolean; lodRatio:number; collider:"none"|"box"|"mesh"|"convex"; deliveryTextureSize:number; deliveryCompression:"none"|"normal" };
export function graphicsUnityOptimization(settings:GraphicsObject["settings"]):GraphicsUnityOptimization {
  if(settings.lodEnabled!==undefined&&typeof settings.lodEnabled!=="boolean")throw Error("LOD 사용 여부는 참/거짓이어야 합니다.");
  const lodRatio=Number(settings.lodRatio??.5),collider=String(settings.collider??"none"),deliveryTextureSize=Number(settings.deliveryTextureSize??0),deliveryCompression=String(settings.deliveryCompression??"none");
  if(!Number.isFinite(lodRatio)||lodRatio<.05||lodRatio>.95)throw Error("LOD 비율은 0.05–0.95입니다.");
  if(!["none","box","mesh","convex"].includes(collider))throw Error("지원하는 충돌체는 none/box/mesh/convex입니다.");
  if(![0,256,512,1024,2048,4096,8192,16384].includes(deliveryTextureSize))throw Error("Unity 전달 텍스처 크기는 원본(0) 또는 256–16384의 2제곱 크기입니다.");
  if(!["none","normal"].includes(deliveryCompression))throw Error("지원하는 Unity 전달 압축은 none/normal입니다.");
  return {lodEnabled:settings.lodEnabled===true,lodRatio,collider:collider as GraphicsUnityOptimization["collider"],deliveryTextureSize,deliveryCompression:deliveryCompression as "none"|"normal"};
}
type QueueRequest = {
  schemaVersion: number; requestId: string; objectId: string; objectName: string;
  destination: string; resultPath: string; profileFingerprint: string; unityVersion: string;
  pipeline: string; converterVersion: string; structure: string; rigType: string;
  mode: string; files: Output[]; expectedClips: string[]; sources: { path: string; sha256: string }[];
  profileFiles: { path: string; sha256: string }[]; spritePixelsPerUnit: number; materialManifest?: string; optimization?:GraphicsUnityOptimization;
};
function assertRequestBinding(root:string, delivery:UnityDelivery, q:QueueRequest) {
  if(q.files?.some(file=>file.destination===delivery.destination+"/Generated/materials.json") && q.materialManifest!==delivery.destination+"/Generated/materials.json")throw Error("Unity 재질 역할 manifest 연결이 고정 요청과 다릅니다.");
  const expectedResult=safePath(root,`Library/PartsmithGraphicsResults/${delivery.id}.json`);
  const samePath=(a:string,b:string)=>process.platform==="win32"?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
  if(q.requestId!==delivery.id||q.objectId!==delivery.objectId||q.profileFingerprint!==delivery.profileFingerprint||q.converterVersion!==delivery.converterVersion||q.destination!==delivery.destination||typeof q.resultPath!=="string"||!samePath(q.resultPath,expectedResult))throw Error("Unity 요청과 고정한 전달·대상 프로젝트 정보가 다릅니다.");
  if(!Array.isArray(q.files)||!q.files.length||!Array.isArray(delivery.files)||q.files.length!==delivery.files.length)throw Error("Unity 전달 파일 목록이 고정 요청과 다릅니다.");
  for(const output of q.files){
    const matches=delivery.files.filter(file=>file.path===output.destination);
    if(matches.length!==1||matches[0].sha256!==output.sha256||matches[0].bytes!==output.bytes||matches[0].kind!==output.kind)throw Error("Unity 전달 파일의 경로·해시·크기가 고정 요청과 다릅니다.");
  }
  const optimizationFile=q.files.find(file=>file.destination===delivery.destination+"/Generated/optimization.json");
  if(optimizationFile){
    const file=safePath(root,`Library/PartsmithGraphicsStaging/${delivery.id}/optimization.json`);
    if(sha(file)!==optimizationFile.sha256||JSON.stringify(graphicsUnityOptimization(json(file).settings??{}))!==JSON.stringify(graphicsUnityOptimization(q.optimization??{})))throw Error("Unity 최적화 옵션이 고정된 파생 결과와 다릅니다.");
  }
}
export type PrepareUnityDeliveryArgs = { projectRoot: string; object: GraphicsObject; versions: AssetVersion[]; profile: UnityTargetProfile; blenderPath: string; resources: string; signal?: AbortSignal };
const busy = new Set<string>();
const objectFolder = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : "object-" + digest(id).slice(0,24);
function validateSources(projectRoot: string, object: GraphicsObject, versions: AssetVersion[]): Input[] {
  const root = fs.realpathSync(projectRoot);
  if (!versions.length || new Set(versions.map(v=>v.id)).size !== versions.length) throw Error("Unity에 보낼 정확한 버전이 필요합니다.");
  return versions.flatMap(v => {
    if (v.objectId !== object.id) throw Error("다른 오브젝트의 버전을 Unity 원본으로 사용할 수 없습니다.");
    return v.files.map(f => {
      const absolute = safePath(root, f.path);
      if (!fs.statSync(absolute).isFile() || !/^[a-f\d]{64}$/.test(f.sha256) || fs.statSync(absolute).size !== f.bytes || sha(absolute) !== f.sha256) throw Error("Unity 원본의 해시·크기·경로가 변경됐습니다: " + f.path);
      return { ...f, absolute, versionId: v.id };
    });
  });
}
function profileFiles(root: string) {
  const base = ["ProjectSettings/ProjectVersion.txt", "ProjectSettings/GraphicsSettings.asset", "ProjectSettings/QualitySettings.asset", "Packages/manifest.json", "Packages/packages-lock.json"];
  const graphics = read(safePath(root,"ProjectSettings/GraphicsSettings.asset"));
  const quality = read(safePath(root,"ProjectSettings/QualitySettings.asset"));
  const guids = new Set([...graphics.matchAll(/m_CustomRenderPipeline:\s*\{[^}]*guid:\s*([a-f\d]{32})/gi), ...quality.matchAll(/customRenderPipeline:\s*\{[^}]*guid:\s*([a-f\d]{32})/gi)].map(m=>m[1]));
  for (const file of [...files(safePath(root,"Assets")),...files(safePath(root,"Packages"))]) if (file.endsWith(".meta")) { const guid = read(file).match(/^guid:\s*([a-f\d]{32})/m)?.[1]; if(guid && guids.has(guid)) base.push(slash(path.relative(root,file.slice(0,-5))),slash(path.relative(root,file))); }
  return [...new Set(base)].filter(p=>fs.existsSync(safePath(root,p))).map(p=>({path:p,sha256:sha(safePath(root,p))}));
}

/** Pending imports need only their small frozen profile inventory, not an Assets tree walk. */
function pendingProfileMatches(root:string, delivery:UnityDelivery):boolean {
  const requestPath=safePath(root,`Library/PartsmithGraphicsStaging/${delivery.id}/request.json`);
  if(!fs.existsSync(requestPath))return readUnityTarget(root).fingerprint===delivery.profileFingerprint;
  const q=json(requestPath) as QueueRequest;
  assertRequestBinding(root,delivery,q);
  const inventory=q.profileFiles;
  const required=["ProjectSettings/ProjectVersion.txt","ProjectSettings/GraphicsSettings.asset","ProjectSettings/QualitySettings.asset","Packages/manifest.json"];
  // Older requests lack GUID metadata. Keep their complete profile check until explicitly prepared anew.
  if(!Array.isArray(inventory)||required.some(p=>!inventory.some(f=>f.path===p))||(q.pipeline!=="builtin"&&!inventory.some(f=>f.path.endsWith(".meta"))))return readUnityTarget(root).fingerprint===delivery.profileFingerprint;
  for(const file of inventory){
    const absolute=safePath(root,file.path);
    if(!fs.existsSync(absolute)||sha(absolute)!==file.sha256)return false;
  }
  return true;
}

/** Freezes and stages exact source bytes, then queues import only. Never enters Play Mode. */
export async function prepareUnityDelivery(a: PrepareUnityDeliveryArgs): Promise<UnityDelivery> {
  a.signal?.throwIfAborted();
  const target = readUnityTarget(a.profile.projectPath), root = target.projectPath;
  if (target.fingerprint !== a.profile.fingerprint || a.profile.platform !== "pc") throw Error("Unity 대상 설정이 바뀌었습니다. 프로젝트를 다시 확인하세요.");
  if (target.pipeline === "unknown") throw Error("렌더 파이프라인을 확인한 뒤 Unity로 보낼 수 있습니다.");
  const inputs = validateSources(a.projectRoot, a.object, a.versions);
  const sprite = a.object.kind === "sprite" || a.object.kind === "ui";
  const optimization=graphicsUnityOptimization(a.object.settings);
  if(sprite&&(optimization.lodEnabled||optimization.collider!=="none"))throw Error("스프라이트 전달은 3D LOD·충돌체를 지원하지 않습니다.");
  const models = inputs.filter(i=>/\.(fbx|blend|glb|obj)$/i.test(i.path));
  // A version may contain preview GLB beside its editable/native source.
  const preferred = a.versions.map(v=>{
    const ranked=models.filter(m=>m.versionId===v.id).sort((x,y)=>[".blend",".fbx",".glb",".obj"].indexOf(path.extname(x.path).toLowerCase())-[".blend",".fbx",".glb",".obj"].indexOf(path.extname(y.path).toLowerCase()));
    if(ranked.length>1 && path.extname(ranked[0].path).toLowerCase()===path.extname(ranked[1].path).toLowerCase())throw Error("같은 형식의 원본 모델이 여러 개입니다. Unity에 보낼 원본 하나를 지정하세요.");
    return ranked[0];
  }).filter(Boolean);
  const images = inputs.filter(i=>/\.(png|jpe?g|tga)$/i.test(i.path));
  const combine = !sprite && a.versions.length > 1;
  const rigs = a.versions.filter(v=>v.role==="rig" && v.slot==="main");
  const clips = a.versions.filter(v=>v.role==="animation");
  if(combine && (rigs.length!==1 || !clips.length || rigs.length+clips.length!==a.versions.length || preferred.length!==a.versions.length))
    throw Error("여러 버전의 Unity 전달은 채택한 리그 한 개와 이름을 지정한 동작 클립을 지원합니다. 별도 재질은 리그 원본에 포함해야 합니다.");
  if(combine && (a.versions.some(v=>a.object.accepted[`${v.role}:${v.slot}`]!==v.id) || new Set(clips.map(v=>v.slot)).size!==clips.length))
    throw Error("Unity로 보낼 리그와 각 동작 클립의 정확한 버전을 먼저 채택하세요.");
  if(combine && (preferred.some(input=>path.extname(input.path).toLowerCase()!==".blend") || clips.some(v=>!v.slot.trim() || v.slot==="main")))
    throw Error("리그·클립 합성은 원본 BLEND와 정확한 Action 이름의 클립 슬롯이 필요합니다.");
  const source = sprite ? images[0] : combine ? preferred.find(input=>input.versionId===rigs[0].id) : preferred[0];
  if (!source || (sprite ? images.length !== 1 || a.versions.length!==1 : !combine && preferred.length !== 1)) throw Error(sprite ? "현재 Unity 스프라이트 출력은 PNG/JPEG/TGA 이미지 한 개를 지원합니다." : "Unity에 보낼 원본 모델 버전 한 개를 지정하세요.");
  const rigType = a.object.settings.unityRigType === "humanoid" ? "humanoid" : "generic";
  const spritePixelsPerUnit = Number(a.object.settings.spritePixelsPerUnit ?? 100);
  if (!Number.isFinite(spritePixelsPerUnit) || spritePixelsPerUnit < 1 || spritePixelsPerUnit > 10000) throw Error("스프라이트 단위를 확인하세요.");
  const bridgeSource = path.join(a.resources,"unity/Editor/PartsmithGraphicsBridge.cs");
  const converterSource = path.join(a.resources,"blender/graphics_prepare.py");
  const combineSource = path.join(a.resources,"blender/graphics_combine.py");
  const converterVersion = GRAPHICS_UNITY_CONVERTER + "-" + digest(fs.readFileSync(bridgeSource)).slice(0,12) + "-" + digest(fs.readFileSync(converterSource)).slice(0,12) + (combine ? "-" + digest(fs.readFileSync(combineSource)).slice(0,12) : "");
  const identity = digest(JSON.stringify({ objectId:a.object.id, versionIds:a.versions.map(v=>v.id), inputs:inputs.map(i=>({path:i.path,sha256:i.sha256})), ...(combine?{clips:clips.map(v=>({versionId:v.id,action:v.slot})),rigVersion:rigs[0].id}:{}), profile:target.fingerprint, converterVersion, rigType, sprite, spritePixelsPerUnit,optimization }));
  const id = identity.slice(0,32), dest = `Assets/PartsmithGraphics/${objectFolder(a.object.id)}`;
  const staging = safePath(root,`Library/PartsmithGraphicsStaging/${id}`);
  const deliveryFile = safePath(root,`Library/PartsmithGraphicsStaging/${id}/delivery.json`);
  const queue = safePath(root,`Library/PartsmithGraphicsInbox/${id}.json`);
  const resultPath = safePath(root,`Library/PartsmithGraphicsResults/${id}.json`);
  if (fs.existsSync(deliveryFile)) {
    const cached=json(deliveryFile) as UnityDelivery;
    if(cached.id!==id||cached.objectId!==a.object.id||cached.profileFingerprint!==target.fingerprint||cached.converterVersion!==converterVersion||cached.destination!==dest||JSON.stringify(cached.versionIds)!==JSON.stringify(a.versions.map(v=>v.id)))throw Error("저장된 Unity 전달 기록이 현재 고정 입력·대상과 다릅니다.");
    return inspectUnityDelivery(root,cached);
  }
  if (busy.has(root)) throw Error("이 Unity 프로젝트의 다른 전달 작업을 처리 중입니다.");
  busy.add(root);
  const delivery: UnityDelivery = { id,objectId:a.object.id,versionIds:a.versions.map(v=>v.id),profileFingerprint:target.fingerprint,converterVersion,createdAt:new Date().toISOString(),destination:dest,status:"queued",files:[],warnings:["가져오기만 요청했습니다. Play Mode·외형·변형 품질은 검증하지 않았습니다."],errors:[],playbackVerified:false };
  let lock: number | undefined;
  const lockPath = safePath(root,"Library/PartsmithGraphicsPreparation.lock");
  try {
    fs.mkdirSync(path.dirname(lockPath),{recursive:true});
    try { lock=fs.openSync(lockPath,"wx"); fs.writeFileSync(lock,JSON.stringify({pid:process.pid,id})); } catch { throw Error("Unity 전달 잠금이 있습니다. 다른 작업이 끝났는지 확인하세요."); }
    const inboxDir=path.dirname(queue);
    if(fs.existsSync(inboxDir) && files(inboxDir).some(f=>f.endsWith(".json") && f!==queue)) throw Error("이미 대기 중인 Unity 전달이 있습니다. 먼저 기존 결과를 확인하세요.");
    const bridgeDest = safePath(root,"Assets/PartsmithGraphicsBridge/Editor/PartsmithGraphicsBridge.cs");
    const bridgeRecord = safePath(root,"Library/PartsmithGraphicsBridge.json");
    const bridgeHash=sha(bridgeSource);
    if(fs.existsSync(bridgeDest) && sha(bridgeDest)!==bridgeHash && (!fs.existsSync(bridgeRecord)||json(bridgeRecord).sha256!==sha(bridgeDest))) { delivery.status="conflict"; delivery.errors.push("기존 Unity 그래픽 브리지 파일이 다릅니다. 사용자 코드와 참조를 보존했습니다."); return delivery; }
    const generated=safePath(root,dest+"/Generated"), previous=safePath(root,dest+"/Generated/partsmith-manifest.json");
    if(fs.existsSync(generated) && files(generated).length && !fs.existsSync(previous)) { delivery.status="conflict";delivery.errors.push("출처 기록 없는 Generated 폴더를 덮어쓰지 않았습니다.");return delivery; }
    if(fs.existsSync(previous)) {
      const prior=json(previous);
      if(prior.objectId!==a.object.id) { delivery.status="conflict";delivery.errors.push("기존 출력의 오브젝트가 다릅니다.");return delivery; }
      if(prior.profileFingerprint!==target.fingerprint){
        const priorRequest=typeof prior.requestId==="string"&&/^[a-f\d]{32}$/.test(prior.requestId)?safePath(root,`Library/PartsmithGraphicsStaging/${prior.requestId}/request.json`):undefined;
        const priorProfile=prior.pipeline?prior:priorRequest&&fs.existsSync(priorRequest)?json(priorRequest):{};
        if(priorProfile.pipeline!==target.pipeline || String(priorProfile.unityVersion).split(".")[0]!==target.unityVersion.split(".")[0]){delivery.status="conflict";delivery.errors.push("기존 출력의 렌더 파이프라인 또는 Unity 주 버전이 달라 호환성을 확인해야 합니다.");return delivery;}
        delivery.warnings.push("호환되는 Unity 대상 설정 변경을 새 전달에 반영합니다. 원본과 사용자 프리팹은 보존합니다.");
      }
      for(const f of prior.files??[]) if(!fs.existsSync(safePath(root,f.path)) || sha(safePath(root,f.path))!==f.sha256) { delivery.status="conflict";delivery.errors.push("Generated 파일이 외부에서 변경되어 보존했습니다: "+f.path);return delivery; }
    }
    fs.mkdirSync(staging,{recursive:true});
    const outputs: Output[]=[];
    let structure="sprite", expectedClips:string[]=[];
    if(sprite) {
      const out=path.join(staging,"Asset"+path.extname(source.path).toLowerCase());fs.copyFileSync(source.absolute,out);
      outputs.push({source:out,destination:dest+"/Generated/"+path.basename(out),sha256:sha(out),bytes:fs.statSync(out).size,kind:"image"});
    } else {
      if(!a.blenderPath || !fs.existsSync(a.blenderPath)) throw Error("모델과 텍스처를 검사할 Blender 실행 파일이 필요합니다.");
      const temp=fs.mkdtempSync(path.join(os.tmpdir(),"ps-gfx-"));
      try {
        const declared=combine ? inputs : inputs.filter(i=>i.versionId===source.versionId);
        let common=path.dirname(source.absolute);
        for(const input of declared)while(input.absolute!==common&&!contained(common,input.absolute))common=path.dirname(common);
        const inputRoot=path.join(temp,"input");fs.mkdirSync(inputRoot);
        const copied = declared.map(i=> {
          const local=safePath(inputRoot,path.relative(common,i.absolute));fs.mkdirSync(path.dirname(local),{recursive:true});fs.copyFileSync(i.absolute,local);return {original:i.absolute,local,sha256:i.sha256};
        });
        const spec=path.join(temp,"request.json");
        let nativeSource=copied.find(c=>c.original===source.absolute)!.local;
        let merge:unknown;
        if(combine){
          const combineSpec=path.join(temp,"combine.json"), combined=path.join(inputRoot,"combined-derivative.blend"), report=path.join(temp,"combine-report.json");
          if(fs.existsSync(combined))throw Error("Unity 합성 결과 경로가 입력 원본과 충돌합니다.");
          write(combineSpec,{source:nativeSource,inputRoot,files:copied,output:combined,report,clips:clips.map(v=>({name:v.slot,path:copied.find(c=>c.original===preferred.find(p=>p.versionId===v.id)!.absolute)!.local}))});
          a.signal?.throwIfAborted();
          await runProcess(a.blenderPath,["--background","--factory-startup","--disable-autoexec","--python-exit-code","1","--python",combineSource,"--",combineSpec]);
          a.signal?.throwIfAborted();
          const combinedReport=json(report);
          if(combinedReport.sourceChanged!==false || combinedReport.animationAuthored!==false || combinedReport.outputSha256!==sha(combined) || JSON.stringify(combinedReport.selectedClips)!==JSON.stringify(clips.map(v=>v.slot)))throw Error("리그·동작 합성의 원본·클립 검증 기록이 없습니다.");
          merge=combinedReport; nativeSource=combined;
          copied.push({original:combined,local:combined,sha256:sha(combined)});
        }
        write(spec,{source:nativeSource,inputRoot,files:copied,output:path.join(temp,"export"),optimization});
        a.signal?.throwIfAborted();
        await runProcess(a.blenderPath,["--background","--factory-startup","--disable-autoexec","--python-exit-code","1","--python",converterSource,"--",spec]);
        a.signal?.throwIfAborted();
        const converted=json(path.join(temp,"export/inspection.json"));
        if(!converted.structure || !Array.isArray(converted.clips)) throw Error("Blender 구조 검사 결과가 없습니다.");
        const optimizationManifest=json(path.join(temp,"export/optimization.json"));
        if(optimizationManifest.schemaVersion!==1||JSON.stringify(graphicsUnityOptimization(optimizationManifest.settings??{}))!==JSON.stringify(optimization)||!Array.isArray(optimizationManifest.lods))throw Error("Blender 최적화 옵션 검사 결과가 고정 요청과 다릅니다.");
        if(optimization.lodEnabled&&(optimizationManifest.lods.length!==converted.structure.meshes.length||optimizationManifest.lods.some((lod:{source:string;derived:string;sourceTriangles:number;derivedTriangles:number})=>!converted.structure.meshes.some((mesh:{name:string})=>mesh.name===lod.source)||lod.derived!==lod.source+"__PS_LOD1"||!Number.isInteger(lod.derivedTriangles)||lod.derivedTriangles<1||lod.derivedTriangles>=lod.sourceTriangles)))throw Error("Blender LOD 감소·메시 연결 검증 결과가 없습니다.");
        const materialManifest=json(path.join(temp,"export/materials.json"));
        if(materialManifest.schemaVersion!==1 || !Array.isArray(materialManifest.materials) || !Array.isArray(materialManifest.originalImages) || !Array.isArray(materialManifest.derivedImages))throw Error("Blender 재질 역할 검사 결과가 없습니다.");
        if(new Set(materialManifest.materials.map((m:{name:string})=>m.name)).size!==materialManifest.materials.length)throw Error("Blender 재질 이름이 중복됩니다.");
        for(const image of [...materialManifest.originalImages,...materialManifest.derivedImages]){
          const file=safePath(path.join(temp,"export"),image.path);
          if(!image.path.startsWith("Textures/") || sha(file)!==image.sha256 || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width<1 || image.height<1)throw Error("Blender 재질 텍스처 근거가 고정 파일과 다릅니다.");
        }
        if(combine && clips.some(v=>!converted.clips.includes(v.slot)))throw Error("Unity 변환에서 채택한 동작 클립이 누락됐습니다.");
        if(merge)write(path.join(temp,"export/inspection.json"),{...converted,merge});
        structure=digest(JSON.stringify(converted.structure)); expectedClips=converted.clips;
        delivery.warnings.push(...(converted.warnings??[]));
        if(fs.existsSync(previous) && json(previous).structure!==structure) { delivery.status="conflict";delivery.errors.push("모델의 메시·재질 슬롯·뼈 구조가 달라 기존 프리팹과 참조를 보존했습니다.");return delivery; }
        for(const f of files(path.join(temp,"export"))) {
          const relative=slash(path.relative(path.join(temp,"export"),f));
          const local=safePath(staging,relative);fs.mkdirSync(path.dirname(local),{recursive:true});fs.copyFileSync(f,local);
          if(relative==="inspection.json")continue;
          outputs.push({source:local,destination:dest+"/Generated/"+relative,sha256:sha(local),bytes:fs.statSync(local).size,kind:path.extname(local).slice(1)});
        }
      } finally {
        const tempRoot=fs.realpathSync(os.tmpdir());
        if(path.dirname(fs.realpathSync(temp))!==tempRoot)throw Error("Blender 임시 폴더 경로가 바뀌었습니다.");
        fs.rmSync(temp,{recursive:true,force:true,maxRetries:3});
      }
    }
    validateSources(a.projectRoot,a.object,a.versions);
    if(readUnityTarget(root).fingerprint!==target.fingerprint)throw Error("처리 중 Unity 대상 설정이 변경됐습니다.");
    a.signal?.throwIfAborted();
    const request: QueueRequest={schemaVersion:1,requestId:id,objectId:a.object.id,objectName:a.object.name,destination:dest,resultPath,profileFingerprint:target.fingerprint,unityVersion:target.unityVersion,pipeline:target.pipeline,converterVersion,structure,rigType,mode:sprite?"sprite":"model",files:outputs,expectedClips,sources:inputs.map(i=>({path:i.absolute,sha256:i.sha256})),profileFiles:profileFiles(root),spritePixelsPerUnit,optimization,...(!sprite?{materialManifest:dest+"/Generated/materials.json"}:{})};
    // User code is not overwritten. Existing .meta files are deliberately never replaced.
    if(!fs.existsSync(bridgeDest)||sha(bridgeDest)!==bridgeHash){fs.mkdirSync(path.dirname(bridgeDest),{recursive:true});fs.copyFileSync(bridgeSource,bridgeDest);}
    write(bridgeRecord,{sha256:bridgeHash,converterVersion});
    delivery.files=outputs.map(o=>({path:o.destination,sha256:o.sha256,bytes:o.bytes,kind:o.kind}));
    write(path.join(staging,"request.json"),request); write(deliveryFile,delivery);
    a.signal?.throwIfAborted();
    write(queue,request);
    return delivery;
  } catch(e) {
    delivery.status="failed";delivery.errors.push(e instanceof Error?e.message:String(e));return delivery;
  } finally {
    if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync(lockPath);}
    busy.delete(root);
  }
}

/** Stops only this queued request. An import already completed or in progress is never undone. */
export function cancelUnityDelivery(projectPath: string, delivery: UnityDelivery): UnityDelivery {
  const root=fs.realpathSync(projectPath);
  if(!/^[a-f\d]{32}$/.test(delivery.id))throw Error("Unity 전달 ID가 잘못됐습니다.");
  const report=safePath(root,`Library/PartsmithGraphicsResults/${delivery.id}.json`);
  if(fs.existsSync(report))return inspectUnityDelivery(root,delivery);
  const queue=safePath(root,`Library/PartsmithGraphicsInbox/${delivery.id}.json`);
  const staged=safePath(root,`Library/PartsmithGraphicsStaging/${delivery.id}/delivery.json`);
  if(!fs.existsSync(staged))return {...delivery,status:"failed",errors:[...delivery.errors,"대기 중인 Unity 전달 기록이 없습니다."],playbackVerified:false};
  const saved=json(staged);
  if(saved.id!==delivery.id||saved.objectId!==delivery.objectId||saved.profileFingerprint!==delivery.profileFingerprint||saved.converterVersion!==delivery.converterVersion)throw Error("취소 대상 Unity 전달 기록이 일치하지 않습니다.");
  const savedRequest=safePath(root,`Library/PartsmithGraphicsStaging/${delivery.id}/request.json`);
  if(!fs.existsSync(savedRequest))throw Error("취소 대상의 고정 Unity 요청이 없습니다.");
  assertRequestBinding(root,delivery,json(savedRequest));
  if(fs.existsSync(queue)){
    const request=json(queue);
    assertRequestBinding(root,delivery,request);
  }
  write(safePath(root,`Library/PartsmithGraphicsStaging/${delivery.id}/cancelled.json`),{requestId:delivery.id,cancelledAt:new Date().toISOString()});
  if(fs.existsSync(queue))fs.unlinkSync(queue);
  if(fs.existsSync(report))return inspectUnityDelivery(root,delivery);
  const cancelled:UnityDelivery={...delivery,status:"failed",errors:[...delivery.errors,"사용자가 Unity 대기 요청을 취소했습니다. 이미 시작한 가져오기는 되돌리지 않으며 생성된 에셋은 보존합니다."],playbackVerified:false};
  write(staged,cancelled);return cancelled;
}

/** Polls only the existing delivery. Missing reports never queue or rerun anything. */
export function inspectUnityDelivery(projectPath: string, delivery: UnityDelivery): UnityDelivery {
  const result: UnityDelivery={...delivery,warnings:[...delivery.warnings],errors:[...delivery.errors],playbackVerified:false};
  try {
    const root=fs.realpathSync(projectPath);
    if(!/^[a-f\d]{32}$/.test(delivery.id))throw Error("Unity 전달 ID가 잘못됐습니다.");
    const reportFile=safePath(root,`Library/PartsmithGraphicsResults/${delivery.id}.json`);
    if(!fs.existsSync(reportFile)){
      if(result.status==="queued"&&!fs.existsSync(safePath(root,`Library/PartsmithGraphicsInbox/${delivery.id}.json`)))throw Error("기존 Unity 요청 또는 처리 보고서가 사라졌습니다. 자동 재전송하지 않습니다.");
      if(!pendingProfileMatches(root,delivery)){result.status="conflict";result.errors.push("Unity 대상 프로필이 바뀌어 이전 검증을 재사용하지 않습니다.");}
      return result;
    }
    const requestPath=safePath(root,`Library/PartsmithGraphicsStaging/${delivery.id}/request.json`);
    if(!fs.existsSync(requestPath))throw Error("Unity 결과에 대응하는 고정 요청이 없습니다.");
    assertRequestBinding(root,delivery,json(requestPath));
    // Completion still resolves GUIDs and computes the full target fingerprint before accepting evidence.
    if(readUnityTarget(root).fingerprint!==delivery.profileFingerprint){result.status="conflict";result.errors.push("Unity 대상 프로필이 바뀌어 이전 검증을 재사용하지 않습니다.");return result;}
    const r=json(reportFile);
    if(r.requestId!==delivery.id || r.objectId!==delivery.objectId || r.profileFingerprint!==delivery.profileFingerprint || r.converterVersion!==delivery.converterVersion || !["imported","failed","conflict"].includes(r.status))throw Error("Unity 결과와 고정한 전달 요청이 다릅니다.");
    result.status=r.status;result.warnings=[...new Set([...result.warnings,...(r.warnings??[])])];result.errors=[...new Set([...result.errors,...(r.errors??[])])];
    if(r.status==="imported") {
      if(result.errors.length || !/^[a-f\d]{32}$/.test(r.guid??"") || r.prefabPath!==delivery.destination+"/Generated/Asset.prefab" || r.userPrefabPath!==delivery.destination+"/User/Asset.prefab")throw Error("Unity 프리팹 검증 정보가 없습니다.");
      for(const f of delivery.files)if(sha(safePath(root,f.path))!==f.sha256)throw Error("Unity에 전달한 원본 파일이 변경됐습니다: "+f.path);
      const prefab=safePath(root,r.prefabPath), userPrefab=safePath(root,r.userPrefabPath);
      if(!fs.existsSync(prefab)||!fs.existsSync(userPrefab)||!new RegExp("^guid:\\s*"+r.guid+"\\s*$","m").test(read(prefab+".meta")))throw Error("Unity 프리팹 파일 또는 GUID가 일치하지 않습니다.");
      result.guid=r.guid;result.prefabPath=r.prefabPath;result.userPrefabPath=r.userPrefabPath;
    }
  }catch(e){result.status="failed";result.errors.push(e instanceof Error?e.message:String(e));}
  return result;
}
