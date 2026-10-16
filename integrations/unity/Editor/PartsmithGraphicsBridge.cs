// PARTSMITH GRAPHICS BRIDGE v1. Import only; never opens a scene or enters Play Mode.
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;

namespace Partsmith.Graphics {
 [Serializable] public class FileEntry { public string source,destination,path,sha256,kind; public long bytes; }
 [Serializable] public class DeliveryRequest {
  public int schemaVersion; public string requestId,objectId,objectName,destination,resultPath,profileFingerprint,unityVersion,pipeline,converterVersion,structure,rigType,mode,materialManifest;
  public FileEntry[] files,sources,profileFiles; public string[] expectedClips; public float spritePixelsPerUnit;
  public DeliveryOptimization optimization;
  public ClipSettings[] clipSettings;
  public PhysicalSizeSettings physicalSize;
  public RigContract rigContract;
 }
 [Serializable] public class HumanBinding { public string boneName,humanName; }
 [Serializable] public class RigContract { public int schemaVersion;public string versionId,producerVersionId,producerTaskId,rigType,hairBinding;public bool fingers;public string[] requiredParts;public HumanBinding[] humanBones; }
 [Serializable] public class RigPart { public string meshName,meshId,partId,armatureName;public int vertices,boneCount;public bool normalizedWeights; }
 [Serializable] public class RigManifest { public int schemaVersion,armatureCount;public string armatureName,sourceSha256;public RigContract contract;public RigPart[] parts; }
 [Serializable] public class ImportedRig { public string rigType,versionId,sourceSha256;public bool avatarValid,avatarHuman;public HumanBinding[] humanBones;public RigPart[] parts; }
 [Serializable] public class MeterVector { public float x,y,z; }
 [Serializable] public class PhysicalSizeSettings { public string mode,axis,pivot;public float lengthMeters;public MeterVector dimensionsMeters; }
 [Serializable] public class PhysicalSizeManifest { public int schemaVersion;public string sourceSha256,basis,unitStatus;public PhysicalSizeSettings settings;public MeterVector dimensionsMeters;public bool originalPreserved; }
 [Serializable] public class ClipSettings { public string versionId,name; public bool loop,rootMotion; public float fps; }
 [Serializable] public class SourceClip { public string name,armatureName,rootBoneName; public float sourceFps,firstFrame,lastFrame; }
 [Serializable] public class AnimationManifest { public int schemaVersion; public ClipSettings[] clipSettings; public SourceClip[] clips; }
 [Serializable] public class ImportedClip { public string versionId,name; public bool loop,rootMotion,lockRootRotation,lockRootHeightY,lockRootPositionXZ; public float sourceFps,importedFps,duration; }
 [Serializable] public class DeliveryOptimization { public bool lodEnabled; public float lodRatio=.5f; public string collider="none",deliveryCompression="none"; public int deliveryTextureSize; }
 [Serializable] public class DeliveryLod { public string source,derived; public int sourceTriangles,derivedTriangles; }
 [Serializable] public class OptimizationManifest { public int schemaVersion; public DeliveryOptimization settings; public DeliveryLod[] lods; }
 [Serializable] public class DeliveryReport {
  public string requestId,objectId,profileFingerprint,converterVersion,status,guid,prefabPath,userPrefabPath,unityVersion,pipeline;
  public bool playbackVerified; public string[] clips,warnings,errors;
  public ImportedClip[] clipSettings;
  public PhysicalSizeManifest physicalSize;
  public ImportedRig rig;
 }
 [Serializable] public class ManagedManifest { public string objectId,profileFingerprint,converterVersion,structure,requestId,pipeline,unityVersion; public FileEntry[] files; }
 [Serializable] public class MaterialTexture { public string path,sha256; public int width,height; }
 [Serializable] public class MaterialChannelSource { public string path,channel; public float value; }
 [Serializable] public class MaterialBinding {
  public string name,warning,baseColorTexture,normalTexture,metallicGlossTexture; public bool supported;
  public float[] baseColor; public float normalScale,metallic,smoothness;
  public MaterialChannelSource metallicSource,roughnessSource;
 }
 [Serializable] public class MaterialBindings { public int schemaVersion; public MaterialBinding[] materials; public MaterialTexture[] originalImages,derivedImages; }
 internal class Conflict : Exception { public Conflict(string message):base(message){} }
 [InitializeOnLoad] public static class PartsmithGraphicsBridge {
  static string Root => Path.GetFullPath(Path.GetDirectoryName(Application.dataPath));
  static bool busy; static double next;
  static PartsmithGraphicsBridge(){EditorApplication.update+=Tick;}
  static void Tick(){
   if(busy||EditorApplication.isCompiling||EditorApplication.isUpdating||EditorApplication.isPlayingOrWillChangePlaymode||EditorApplication.timeSinceStartup<next)return;
   next=EditorApplication.timeSinceStartup+2;
   string inbox=Safe("Library/PartsmithGraphicsInbox");if(!Directory.Exists(inbox))return;
   var file=Directory.GetFiles(inbox,"*.json").OrderBy(x=>x,StringComparer.Ordinal).FirstOrDefault();if(file==null)return;
   busy=true;try{Process(file);}finally{busy=false;}
  }
  [MenuItem("Tools/Partsmith/Process graphics imports")] public static void ProcessPending(){next=0;Tick();}
  public static void ProcessAllForBatch(){while(Directory.Exists(Safe("Library/PartsmithGraphicsInbox"))&&Directory.GetFiles(Safe("Library/PartsmithGraphicsInbox"),"*.json").Length>0){next=0;Tick();}}
  static string Hash(string file){using(var hash=SHA256.Create())using(var stream=File.OpenRead(file))return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
  static string Safe(string relative){
   if(string.IsNullOrEmpty(relative)||Path.IsPathRooted(relative))throw new Exception("Absolute managed path rejected");
   string full=Path.GetFullPath(Path.Combine(Root,relative));
   if(!full.StartsWith(Root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Managed path escaped Unity project");
   string cursor=full;while(cursor!=Root){if((File.Exists(cursor)||Directory.Exists(cursor))&&(File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0)throw new Exception("Linked managed path rejected");cursor=Path.GetDirectoryName(cursor);}
   return full;
  }
  static string Relative(string full)=>full.Substring(Root.Length+1).Replace('\\','/');
  static void Atomic(string file,string content){Directory.CreateDirectory(Path.GetDirectoryName(file));File.WriteAllText(file+".tmp",content);if(File.Exists(file))File.Delete(file);File.Move(file+".tmp",file);}
  static void Folder(string relative){Directory.CreateDirectory(Safe(relative));}
  static void ValidateFile(string file,string expected){if(!File.Exists(file)||Hash(file)!=expected)throw new Conflict("Immutable file changed: "+file);}
  static void Profile(DeliveryRequest q){
   if(Application.unityVersion!=q.unityVersion)throw new Conflict("Unity Editor version differs from the frozen target profile");
   foreach(var file in q.profileFiles??Array.Empty<FileEntry>())ValidateFile(Safe(file.path),file.sha256);
   string actual=GraphicsSettings.currentRenderPipeline?GraphicsSettings.currentRenderPipeline.GetType().Name:"Built-in";
   if(q.pipeline=="urp"&&!actual.Contains("Universal")||q.pipeline=="hdrp"&&!actual.Contains("HDRender")||q.pipeline=="builtin"&&GraphicsSettings.currentRenderPipeline)throw new Conflict("Current renderer differs from the inspected PC target: "+actual);
  }
  [Serializable] class JsonPropertyName { public string value; }
  static bool HasRootProperty(string json,string name){
   int depth=0;
   for(int i=0;i<json.Length;i++){
    char c=json[i];
    if(c=='"'){
     int start=i,end=i+1;bool escaped=false;
     for(;end<json.Length;end++){char next=json[end];if(escaped){escaped=false;continue;}if(next=='\\'){escaped=true;continue;}if(next=='"')break;}
     if(end>=json.Length)throw new Exception("Invalid JSON string");
     int after=end+1;while(after<json.Length&&char.IsWhiteSpace(json[after]))after++;
     if(depth==1&&after<json.Length&&json[after]==':'&&JsonUtility.FromJson<JsonPropertyName>("{\"value\":"+json.Substring(start,end-start+1)+"}").value==name)return true;
     i=end;
    }else if(c=='{'||c=='[')depth++;else if(c=='}'||c==']')depth--;
   }
   return false;
  }
  // Unity synthesizes empty nested objects even when optional JSON fields are absent.
  // Detect actual top-level presence so omitted contracts differ from supplied partial objects.
  public static DeliveryRequest ParseDeliveryRequest(string json,DeliveryRequest q=null){
   q=q??new DeliveryRequest();JsonUtility.FromJsonOverwrite(json,q);
   if(!HasRootProperty(json,"rigContract"))q.rigContract=null;
   if(q.rigContract!=null){var c=q.rigContract;
    if((c.schemaVersion!=1&&c.schemaVersion!=2)||string.IsNullOrWhiteSpace(c.versionId)||string.IsNullOrWhiteSpace(c.producerVersionId)||string.IsNullOrWhiteSpace(c.producerTaskId)||
       (c.rigType!="generic"&&c.rigType!="humanoid")||(c.hairBinding!="head"&&c.hairBinding!="controls")||c.requiredParts==null||c.humanBones==null)
     throw new Exception("Supplied rig contract is incomplete");
    if(c.schemaVersion==2)ValidateExternalMapping(c);
   }
   return q;
  }
  static Dictionary<string,string> ExternalParents(RigContract c){
   var map=c.humanBones.ToDictionary(b=>b.humanName,b=>b.boneName);var p=new Dictionary<string,string>{{"Spine","Hips"},{"Chest","Spine"},{"UpperChest","Chest"},{"Neck",map.ContainsKey("UpperChest")?"UpperChest":"Chest"},{"Head","Neck"},{"LeftEye","Head"},{"RightEye","Head"},{"Jaw","Head"}};
   foreach(var side in new[]{"Left","Right"}){
    string torso=map.ContainsKey("UpperChest")?"UpperChest":"Chest";
    p[side+"Shoulder"]=torso;p[side+"UpperArm"]=map.ContainsKey(side+"Shoulder")?side+"Shoulder":torso;p[side+"LowerArm"]=side+"UpperArm";p[side+"Hand"]=side+"LowerArm";p[side+"UpperLeg"]="Hips";p[side+"LowerLeg"]=side+"UpperLeg";p[side+"Foot"]=side+"LowerLeg";p[side+"Toes"]=side+"Foot";
    foreach(var finger in new[]{"Thumb","Index","Middle","Ring","Little"}){string previous=side+"Hand";foreach(var joint in new[]{"Proximal","Intermediate","Distal"}){string human=side+finger+joint;p[human]=previous;previous=human;}}
   }return p;
  }
  static void ValidateExternalMapping(RigContract c){
   if(c.rigType!="humanoid"||c.humanBones.Any(b=>b==null||string.IsNullOrWhiteSpace(b.boneName)||string.IsNullOrWhiteSpace(b.humanName))||c.humanBones.Select(b=>b.boneName).Distinct().Count()!=c.humanBones.Length||c.humanBones.Select(b=>b.humanName).Distinct().Count()!=c.humanBones.Length)throw new Exception("External Humanoid mapping must be explicit and unique");
   var names=new HashSet<string>(c.humanBones.Select(b=>b.humanName));var p=ExternalParents(c);
   var required=new List<string>{"Hips","Spine","Chest","Neck","Head"};
   foreach(var side in new[]{"Left","Right"}){required.AddRange(new[]{"UpperArm","LowerArm","Hand","UpperLeg","LowerLeg","Foot"}.Select(n=>side+n));if(c.fingers)foreach(var finger in new[]{"Thumb","Index","Middle","Ring","Little"})required.AddRange(new[]{"Proximal","Intermediate","Distal"}.Select(n=>side+finger+n));}
   if(required.Any(n=>!names.Contains(n))||names.Any(n=>n!="Hips"&&(!p.ContainsKey(n)||!names.Contains(p[n]))))throw new Exception("External Humanoid mapping is incomplete or unsupported");
  }
  static void Process(string requestFile){
   DeliveryRequest q=null;
   var warnings=new List<string>{"Import verified only. No Play Mode, visual fidelity, skin deformation, UI layout, or gameplay verification was performed."};
   var errors=new List<string>();
   var r=new DeliveryReport{status="failed",unityVersion=Application.unityVersion,playbackVerified=false,clips=Array.Empty<string>()};
   try{
    q=new DeliveryRequest();ParseDeliveryRequest(File.ReadAllText(requestFile),q);
    if(q==null||q.schemaVersion!=1||!System.Text.RegularExpressions.Regex.IsMatch(q.requestId??"","^[a-f0-9]{32}$")||string.IsNullOrWhiteSpace(q.objectId))throw new Exception("Invalid graphics request");
    r.requestId=q.requestId;r.objectId=q.objectId;r.profileFingerprint=q.profileFingerprint;r.converterVersion=q.converterVersion;r.pipeline=q.pipeline;
    if(q.destination==null||!System.Text.RegularExpressions.Regex.IsMatch(q.destination,"^Assets/PartsmithGraphics/[A-Za-z0-9_-]{1,64}$"))throw new Exception("Unsafe graphics destination");
    if(Path.GetFullPath(q.resultPath)!=Safe("Library/PartsmithGraphicsResults/"+q.requestId+".json"))throw new Exception("Unsafe result path");
    if(q.files==null||q.files.Length==0||q.files.Select(f=>f.destination).Distinct().Count()!=q.files.Length)throw new Exception("Missing or duplicate delivery files");
    if(q.mode!="model"&&q.mode!="sprite"||q.rigType!="generic"&&q.rigType!="humanoid")throw new Exception("Unsupported import mode");
    if(q.rigType=="humanoid"&&(q.mode!="model"||q.rigContract?.rigType!="humanoid"))throw new Exception("Humanoid requires a frozen canonical rig contract");
    if(q.rigContract!=null&&q.rigContract.rigType!=q.rigType)throw new Conflict("Rig type differs from frozen producer contract");
    q.optimization=q.optimization??new DeliveryOptimization();
    if(!new[]{0,256,512,1024,2048,4096,8192,16384}.Contains(q.optimization.deliveryTextureSize)||!new[]{"none","normal"}.Contains(q.optimization.deliveryCompression)||!new[]{"none","box","mesh","convex"}.Contains(q.optimization.collider)||float.IsNaN(q.optimization.lodRatio)||q.optimization.lodRatio<.05f||q.optimization.lodRatio>.95f)throw new Exception("Unsupported frozen optimization settings");
    if(q.mode=="sprite"&&(q.optimization.lodEnabled||q.optimization.collider!="none"))throw new Exception("3D optimization cannot be inferred for a sprite");
    Profile(q);
    string generated=q.destination+"/Generated",user=q.destination+"/User";
    string manifestPath=Safe(generated+"/partsmith-manifest.json");
    string stage=Safe("Library/PartsmithGraphicsStaging/"+q.requestId)+Path.DirectorySeparatorChar;
    foreach(var f in q.files){
     if(!Path.GetFullPath(f.source).StartsWith(stage,StringComparison.OrdinalIgnoreCase)||!f.destination.StartsWith(generated+"/",StringComparison.Ordinal)||f.destination.EndsWith(".meta",StringComparison.OrdinalIgnoreCase))throw new Exception("Unsafe staged file");
     Safe(Relative(Path.GetFullPath(f.source)));Safe(f.destination);ValidateFile(f.source,f.sha256);
     if(new FileInfo(f.source).Length!=f.bytes)throw new Conflict("Staged file byte count changed");
    }
    var optimizationFile=q.files.SingleOrDefault(f=>f.destination==generated+"/optimization.json");
    if(optimizationFile!=null){
     var optimizationEvidence=JsonUtility.FromJson<OptimizationManifest>(File.ReadAllText(optimizationFile.source));
     if(optimizationEvidence?.schemaVersion!=1||optimizationEvidence.settings==null||JsonUtility.ToJson(optimizationEvidence.settings)!=JsonUtility.ToJson(q.optimization))throw new Conflict("Optimization settings differ from the immutable derivative manifest");
    }else if(q.optimization.lodEnabled)throw new Conflict("LOD has no immutable derivative manifest");
    var animationFile=q.files.SingleOrDefault(f=>f.destination==generated+"/animation.json");
    if(animationFile!=null)ValidateAnimationManifest(q,JsonUtility.FromJson<AnimationManifest>(File.ReadAllText(animationFile.source)));
    else if(q.clipSettings!=null&&q.clipSettings.Length>0)throw new Conflict("Frozen animation settings have no source manifest");
    if(q.physicalSize!=null){
     var sizeFile=q.files.SingleOrDefault(f=>f.destination==generated+"/physical-size.json");
     if(sizeFile==null)throw new Conflict("Physical dimensions require a hash-bound manifest");
     ValidatePhysicalSize(q,JsonUtility.FromJson<PhysicalSizeManifest>(File.ReadAllText(sizeFile.source)));
    }
    foreach(var f in q.sources??Array.Empty<FileEntry>())ValidateFile(f.path,f.sha256);
    if(File.Exists(Safe("Library/PartsmithGraphicsStaging/"+q.requestId+"/cancelled.json")))throw new Exception("Delivery cancelled before import");
    if(File.Exists(manifestPath)){
     var previous=JsonUtility.FromJson<ManagedManifest>(File.ReadAllText(manifestPath));
     if(previous.objectId!=q.objectId||previous.structure!=q.structure)throw new Conflict("Existing object or mesh/material/skeleton structure conflicts. Previous assets were preserved.");
     if(previous.profileFingerprint!=q.profileFingerprint){
      if(string.IsNullOrEmpty(previous.pipeline)&&System.Text.RegularExpressions.Regex.IsMatch(previous.requestId??"","^[a-f0-9]{32}$")){
       string oldPath=Safe("Library/PartsmithGraphicsStaging/"+previous.requestId+"/request.json");
       if(File.Exists(oldPath)){var old=JsonUtility.FromJson<DeliveryRequest>(File.ReadAllText(oldPath));previous.pipeline=old.pipeline;previous.unityVersion=old.unityVersion;}
      }
      if(previous.pipeline!=q.pipeline||string.IsNullOrEmpty(previous.unityVersion)||previous.unityVersion.Split('.')[0]!=q.unityVersion.Split('.')[0])throw new Conflict("Renderer or Unity major version changed; explicit compatibility review required");
      warnings.Add("Compatible target settings were reapplied to this delivery. Original source and User prefab remain intact.");
     }
     foreach(var f in previous.files??Array.Empty<FileEntry>())ValidateFile(Safe(f.path),f.sha256);
    }else if(Directory.Exists(Safe(generated))&&Directory.GetFiles(Safe(generated),"*",SearchOption.AllDirectories).Length>0)throw new Conflict("Generated directory has no ownership manifest; existing files were preserved");
    // All known conflicts are checked before the first generated asset write.
    Folder(generated);Folder(user);
    foreach(var f in q.files){Directory.CreateDirectory(Path.GetDirectoryName(Safe(f.destination)));File.Copy(f.source,Safe(f.destination),true);}
    AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
    r.prefabPath=generated+"/Asset.prefab";r.userPrefabPath=user+"/Asset.prefab";
    if(q.mode=="sprite")ImportSprite(q,r,warnings);else ImportModel(q,r,warnings);
    AssetDatabase.SaveAssets();AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
    r.guid=AssetDatabase.AssetPathToGUID(r.prefabPath);
    if(string.IsNullOrEmpty(r.guid)||!AssetDatabase.LoadAssetAtPath<GameObject>(r.prefabPath))throw new Exception("Generated prefab was not imported");
    var generatedFiles=Directory.GetFiles(Safe(generated),"*",SearchOption.AllDirectories).Where(f=>f!=manifestPath&&f!=manifestPath+".meta").OrderBy(f=>f,StringComparer.Ordinal).Select(f=>new FileEntry{path=Relative(f),sha256=Hash(f),bytes=new FileInfo(f).Length}).ToArray();
    Atomic(manifestPath,JsonUtility.ToJson(new ManagedManifest{objectId=q.objectId,profileFingerprint=q.profileFingerprint,converterVersion=q.converterVersion,structure=q.structure,requestId=q.requestId,pipeline=q.pipeline,unityVersion=q.unityVersion,files=generatedFiles},true));
    r.status="imported";
   }catch(Conflict e){r.status="conflict";errors.Add(e.Message);}catch(Exception e){errors.Add(e.ToString());}
   finally{
    r.warnings=warnings.ToArray();r.errors=errors.ToArray();
    if(q!=null&&System.Text.RegularExpressions.Regex.IsMatch(q.requestId??"","^[a-f0-9]{32}$"))Atomic(Safe("Library/PartsmithGraphicsResults/"+q.requestId+".json"),JsonUtility.ToJson(r,true));
    if(File.Exists(requestFile)){string archive=requestFile+".processed";if(!File.Exists(archive))File.Move(requestFile,archive);else File.Move(requestFile,requestFile+"."+DateTime.UtcNow.Ticks+".processed");}
   }
  }
  static void Texture(string asset,bool sprite,float ppu,string role="color",DeliveryOptimization optimization=null){
   optimization=optimization??new DeliveryOptimization();
   var importer=AssetImporter.GetAtPath(asset) as TextureImporter;if(!importer)throw new Exception("Texture importer missing: "+asset);
   int limit=optimization.deliveryTextureSize==0?16384:optimization.deliveryTextureSize;
   var compression=optimization.deliveryCompression=="normal"?TextureImporterCompression.Compressed:TextureImporterCompression.Uncompressed;
   importer.maxTextureSize=limit;importer.textureCompression=compression;
   importer.npotScale=TextureImporterNPOTScale.None;importer.mipmapEnabled=!sprite;
   if(!sprite){importer.textureType=role=="normal"?TextureImporterType.NormalMap:TextureImporterType.Default;importer.sRGBTexture=role=="color";importer.convertToNormalmap=false;importer.alphaSource=TextureImporterAlphaSource.FromInput;importer.alphaIsTransparency=false;}
   var defaults=importer.GetDefaultPlatformTextureSettings();defaults.maxTextureSize=limit;defaults.textureCompression=compression;defaults.crunchedCompression=false;importer.SetPlatformTextureSettings(defaults);
   importer.ClearPlatformTextureSettings("Standalone");
   if(sprite){importer.textureType=TextureImporterType.Sprite;importer.spriteImportMode=SpriteImportMode.Single;importer.spritePixelsPerUnit=ppu;importer.alphaIsTransparency=true;}
   importer.SaveAndReimport();
  }
  static MaterialBindings ReadMaterialBindings(DeliveryRequest q){
   if(string.IsNullOrEmpty(q.materialManifest)){
    if(q.files.Any(f=>f.destination==q.destination+"/Generated/materials.json"))throw new Exception("Frozen material manifest binding was removed");
    return null;
   }
   if(q.materialManifest!=q.destination+"/Generated/materials.json"||!q.files.Any(f=>f.destination==q.materialManifest))throw new Exception("Material manifest is not a frozen delivery file");
   var manifest=JsonUtility.FromJson<MaterialBindings>(File.ReadAllText(Safe(q.materialManifest)));
   if(manifest==null||manifest.schemaVersion!=1||manifest.materials==null||manifest.originalImages==null||manifest.derivedImages==null||manifest.materials.Select(m=>m.name).Distinct().Count()!=manifest.materials.Length)throw new Exception("Invalid material role manifest");
   return manifest;
  }
  static Texture2D BoundTexture(DeliveryRequest q,MaterialBindings bindings,string relative,string role){
   if(string.IsNullOrEmpty(relative))return null;
   if(!relative.StartsWith("Textures/",StringComparison.Ordinal)||relative.Contains("..")||relative.Contains("\\"))throw new Exception("Unsafe material texture path");
   var evidence=bindings.originalImages.Concat(bindings.derivedImages).Single(t=>t.path==relative);
   string asset=q.destination+"/Generated/"+relative;
   if(!q.files.Any(f=>f.destination==asset&&f.sha256==evidence.sha256))throw new Exception("Material texture has no immutable file evidence");
   ValidateFile(Safe(asset),evidence.sha256);Texture(asset,false,100,role,q.optimization);
   var texture=AssetDatabase.LoadAssetAtPath<Texture2D>(asset);
   int limit=q.optimization?.deliveryTextureSize??0;float scale=limit==0?1:Math.Min(1,limit/(float)Math.Max(evidence.width,evidence.height));
   int tolerance=scale==1?0:1;
   if(!texture||Math.Abs(texture.width-Math.Max(1,Math.Round(evidence.width*scale)))>tolerance||Math.Abs(texture.height-Math.Max(1,Math.Round(evidence.height*scale)))>tolerance)throw new Exception("Material texture dimensions differ from explicit delivery settings: "+asset);
   return texture;
  }
  static void ApplyMaterialBinding(DeliveryRequest q,MaterialBindings bindings,MaterialBinding binding,Material mat){
   if(binding.baseColor==null||binding.baseColor.Length!=4)throw new Exception("Missing source base color factor");
   var color=new Color(binding.baseColor[0],binding.baseColor[1],binding.baseColor[2],binding.baseColor[3]);
   var baseMap=BoundTexture(q,bindings,binding.baseColorTexture,"color");
   var normal=BoundTexture(q,bindings,binding.normalTexture,"normal");
   var metallic=BoundTexture(q,bindings,binding.metallicGlossTexture,"linear");
   // Retained source channel maps remain linear assets too; only the derived map is shader-bound.
   if(binding.metallicSource!=null&&!string.IsNullOrEmpty(binding.metallicSource.path))BoundTexture(q,bindings,binding.metallicSource.path,"linear");
   if(binding.roughnessSource!=null&&!string.IsNullOrEmpty(binding.roughnessSource.path)&&binding.roughnessSource.path!=binding.metallicSource?.path)BoundTexture(q,bindings,binding.roughnessSource.path,"linear");
   foreach(var key in new[]{"_BaseColor","_Color"})if(mat.HasProperty(key))mat.SetColor(key,color);
   foreach(var key in new[]{"_BaseMap","_MainTex"})if(mat.HasProperty(key))mat.SetTexture(key,baseMap);
   mat.SetTexture("_BumpMap",normal);mat.SetFloat("_BumpScale",binding.normalScale);
   mat.SetTexture("_MetallicGlossMap",metallic);mat.SetFloat("_Metallic",binding.metallic);
   foreach(var key in new[]{"_Smoothness","_Glossiness","_GlossMapScale"})if(mat.HasProperty(key))mat.SetFloat(key,metallic?1:binding.smoothness);
   if(mat.HasProperty("_SmoothnessTextureChannel"))mat.SetFloat("_SmoothnessTextureChannel",0);
   if(mat.HasProperty("_WorkflowMode"))mat.SetFloat("_WorkflowMode",1);
   mat.DisableKeyword("_SPECULAR_SETUP");mat.DisableKeyword("_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A");
   foreach(var keyword in new[]{"_NORMALMAP","_METALLICSPECGLOSSMAP","_METALLICGLOSSMAP"})mat.DisableKeyword(keyword);
   if(normal)mat.EnableKeyword("_NORMALMAP");
   if(metallic)mat.EnableKeyword(q.pipeline=="urp"?"_METALLICSPECGLOSSMAP":"_METALLICGLOSSMAP");
  }
  static void SavePrefab(GameObject instance,DeliveryReport r){
   PrefabUtility.SaveAsPrefabAsset(instance,r.prefabPath);
   if(!File.Exists(Safe(r.userPrefabPath))){
    var scene=instance.scene;var variant=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(r.prefabPath),scene);
    try{PrefabUtility.SaveAsPrefabAsset(variant,r.userPrefabPath);}finally{UnityEngine.Object.DestroyImmediate(variant);}
   }
  }
  static void ImportSprite(DeliveryRequest q,DeliveryReport r,List<string> warnings){
   var image=q.files.Single(f=>f.kind=="image").destination;Texture(image,true,q.spritePixelsPerUnit,"color",q.optimization);
   var sprite=AssetDatabase.LoadAssetAtPath<Sprite>(image);if(!sprite)throw new Exception("Sprite subasset missing");
   var scene=EditorSceneManager.NewPreviewScene();
   try{var obj=new GameObject("Asset");UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(obj,scene);obj.AddComponent<SpriteRenderer>().sprite=sprite;SavePrefab(obj,r);UnityEngine.Object.DestroyImmediate(obj);}finally{EditorSceneManager.ClosePreviewScene(scene);}
   warnings.Add("Single sprite prefab created. Canvas layout, UI Image, nine-slice, and sprite sheet animation are not inferred.");
  }
  static void ImportModel(DeliveryRequest q,DeliveryReport r,List<string> warnings){
   var bindings=ReadMaterialBindings(q);
   var animationFile=q.files.SingleOrDefault(f=>f.destination==q.destination+"/Generated/animation.json");
   var animation=animationFile==null?null:JsonUtility.FromJson<AnimationManifest>(File.ReadAllText(Safe(animationFile.destination)));
   if(animation!=null)ValidateAnimationManifest(q,animation);
   string modelPath=q.destination+"/Generated/Asset.fbx",texturePath=q.destination+"/Generated/Textures";
   var importer=AssetImporter.GetAtPath(modelPath) as ModelImporter;if(!importer)throw new Exception("FBX importer missing");
   importer.globalScale=1;importer.useFileScale=true;importer.bakeAxisConversion=true;importer.importAnimation=true;importer.animationCompression=ModelImporterAnimationCompression.Off;
   importer.materialImportMode=ModelImporterMaterialImportMode.ImportStandard;
   // Re-read source materials on updates; existing remaps otherwise hide changed source values.
   foreach(var entry in importer.GetExternalObjectMap().ToArray())importer.RemoveRemap(entry.Key);
   // Static meshes do not require an Avatar. Skeleton-bearing models use the explicitly chosen mode.
   // Read source rest transforms, not a previous Human import's Avatar-adjusted pose on reimport.
   if(q.rigType=="humanoid"){importer.animationType=ModelImporterAnimationType.Generic;importer.avatarSetup=ModelImporterAvatarSetup.NoAvatar;importer.SaveAndReimport();}
   var initial=AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);bool skinned=initial&&initial.GetComponentsInChildren<SkinnedMeshRenderer>(true).Any(s=>s.bones.Length>0);
   if(q.rigType=="humanoid"&&!skinned)throw new Exception("Requested Humanoid has no skin; Generic fallback is forbidden");
   importer.animationType=skinned?(q.rigType=="humanoid"?ModelImporterAnimationType.Human:ModelImporterAnimationType.Generic):ModelImporterAnimationType.Generic;
   importer.avatarSetup=skinned?ModelImporterAvatarSetup.CreateFromThisModel:ModelImporterAvatarSetup.NoAvatar;
   if(q.rigType=="humanoid"){
    var rig=ReadRigManifest(q);
    var allTransforms=initial.GetComponentsInChildren<Transform>(true);
    if(q.rigContract.humanBones.Any(binding=>allTransforms.Count(t=>t.name==binding.boneName)!=1))throw new Exception("Mapped Humanoid bone names must be unique across all object and bone transforms");
    var skinBones=initial.GetComponentsInChildren<SkinnedMeshRenderer>(true).SelectMany(s=>s.bones).Where(b=>b).Distinct().ToArray();
    var skeleton=new HashSet<Transform>();
    foreach(var bone in skinBones){var ancestor=bone;while(ancestor){skeleton.Add(ancestor);if(ancestor==initial.transform)break;ancestor=ancestor.parent;}}
    var transforms=skeleton.ToArray();
    if(transforms.Select(t=>t.name).Distinct().Count()!=transforms.Length)throw new Exception("Humanoid transform names are ambiguous");
    importer.humanDescription=new HumanDescription{
     human=q.rigContract.humanBones.Select(binding=>{
      if(transforms.Count(t=>t.name==binding.boneName)!=1||!Enum.TryParse<HumanBodyBones>(binding.humanName,out var human)||human==HumanBodyBones.LastBone)throw new Exception("Missing canonical HumanDescription mapping: "+binding.boneName);
      return new HumanBone{boneName=binding.boneName,humanName=HumanTrait.BoneName[(int)human],limit=new HumanLimit{useDefaultValues=true}};
     }).ToArray(),
     skeleton=transforms.Select(t=>new SkeletonBone{name=t.name,position=t.localPosition,rotation=t.localRotation,scale=t.localScale}).ToArray(),
     upperArmTwist=.5f,lowerArmTwist=.5f,upperLegTwist=.5f,lowerLegTwist=.5f,armStretch=.05f,legStretch=.05f,feetSpacing=0,hasTranslationDoF=false
    };
    importer.skinWeights=ModelImporterSkinWeights.Custom;importer.maxBonesPerVertex=32;importer.minBoneWeight=0;
   }
   ApplyClipSettings(importer,initial,q,animation);
   importer.SaveAndReimport();Folder(texturePath);importer.ExtractTextures(texturePath);AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
   foreach(var file in Directory.GetFiles(Safe(texturePath)).Where(f=>new[]{".png",".jpg",".jpeg",".tga"}.Contains(Path.GetExtension(f).ToLowerInvariant())))Texture(Relative(file),false,100,"color",q.optimization);
   var model=AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);if(!model||model.GetComponentsInChildren<Renderer>(true).Length==0)throw new Exception("Imported model has no renderer");
   var shader=Shader.Find(q.pipeline=="urp"?"Universal Render Pipeline/Lit":q.pipeline=="hdrp"?"HDRP/Lit":"Standard");
   if(!shader)throw new Exception("Required target shader missing; no silent renderer fallback");
   string materials=q.destination+"/Generated/Materials";Folder(materials);
   foreach(var original in model.GetComponentsInChildren<Renderer>(true).SelectMany(x=>x.sharedMaterials).Where(x=>x).Distinct()){
    string token;using(var hash=SHA256.Create())token=BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(original.name))).Replace("-","").Substring(0,16).ToLowerInvariant();
    string matPath=materials+"/Material-"+token+".mat";var mat=AssetDatabase.LoadAssetAtPath<Material>(matPath);if(!mat){mat=new Material(shader);AssetDatabase.CreateAsset(mat,matPath);}else mat.shader=shader;
    var color=original.HasProperty("_BaseColor")?original.GetColor("_BaseColor"):original.HasProperty("_Color")?original.GetColor("_Color"):Color.white;
    var texture=original.HasProperty("_BaseMap")?original.GetTexture("_BaseMap"):original.mainTexture;
    foreach(var key in new[]{"_BaseColor","_Color"})if(mat.HasProperty(key))mat.SetColor(key,color);
    foreach(var key in new[]{"_BaseMap","_BaseColorMap","_MainTex"})if(mat.HasProperty(key))mat.SetTexture(key,texture);
    // FBX Standard keys do not establish channel semantics for metallic or normal maps.
    foreach(var key in new[]{"_BumpMap","_MetallicGlossMap","_OcclusionMap","_EmissionMap"})if(mat.HasProperty(key))mat.SetTexture(key,null);
    foreach(var keyword in new[]{"_NORMALMAP","_METALLICSPECGLOSSMAP","_METALLICGLOSSMAP"})mat.DisableKeyword(keyword);
    var binding=bindings?.materials.SingleOrDefault(b=>b.name==original.name);
    if(binding!=null&&binding.supported&&(q.pipeline=="urp"||q.pipeline=="builtin"))ApplyMaterialBinding(q,bindings,binding,mat);
    else warnings.Add("Material "+original.name+" has only an approximate FBX base-color fallback; no normal/metallic channel mapping was inferred. "+(binding?.warning??"No supported source-node evidence or target shader mapping."));
    EditorUtility.SetDirty(mat);importer.AddRemap(new AssetImporter.SourceAssetIdentifier(original),mat);
   }
   importer.SaveAndReimport();model=AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);
   var clips=AssetDatabase.LoadAllAssetsAtPath(modelPath).OfType<AnimationClip>().Where(c=>!c.name.StartsWith("__preview__")).ToArray();r.clips=clips.Select(c=>c.name).ToArray();
   if(q.expectedClips!=null&&q.expectedClips.Any(expected=>!clips.Any(c=>c.name==expected||c.name.EndsWith("|"+expected))))throw new Exception("An exact source action is missing after Unity import");
   r.clipSettings=VerifyClipSettings(importer,clips,animation);
   var avatar=AssetDatabase.LoadAllAssetsAtPath(modelPath).OfType<Avatar>().FirstOrDefault();
   if(skinned&&(!avatar||!avatar.isValid||q.rigType=="humanoid"&&!avatar.isHuman))throw new Exception("Requested rig Avatar failed validation");
   if(q.rigType=="humanoid")r.rig=VerifyHumanoid(q,model,importer,avatar);
   AnimatorController controller=null;
   if(clips.Length>0){
    string controllerPath=q.destination+"/Generated/Asset.controller";controller=AssetDatabase.LoadAssetAtPath<AnimatorController>(controllerPath)??AnimatorController.CreateAnimatorControllerAtPath(controllerPath);
    var machine=controller.layers[0].stateMachine;
    foreach(var state in machine.states.Where(s=>!clips.Any(c=>c.name==s.state.name)).ToArray())machine.RemoveState(state.state);
    foreach(var clip in clips){var state=machine.states.Select(s=>s.state).FirstOrDefault(s=>s.name==clip.name)??machine.AddState(clip.name);state.motion=clip;}
    EditorUtility.SetDirty(controller);
   }
   var scene=EditorSceneManager.NewPreviewScene();
   try{
    var obj=(GameObject)PrefabUtility.InstantiatePrefab(model,scene);obj.name="Asset";
    if(q.physicalSize!=null)r.physicalSize=VerifyPhysicalSize(q,obj);
    ApplyOptimization(q,obj,warnings);
    if(controller||skinned){var animator=obj.GetComponent<Animator>();if(!animator)animator=obj.AddComponent<Animator>();animator.avatar=avatar;animator.runtimeAnimatorController=controller;animator.applyRootMotion=q.clipSettings?.Any(clip=>clip.rootMotion)??false;}
    SavePrefab(obj,r);UnityEngine.Object.DestroyImmediate(obj);
   }finally{EditorSceneManager.ClosePreviewScene(scene);}
   warnings.Add("Supported opaque Principled materials use source-node base color, tangent normal and explicit metallic R / smoothness A packing. Unsupported graphs use a warned base-color fallback. Appearance still requires visual review.");
   if(q.clipSettings?.Length>0)warnings.Add("Frozen clip loop/root-motion import settings and source FPS were checked. No Play Mode, loop-seam or runtime movement quality was verified.");
  }
  static RigManifest ReadRigManifest(DeliveryRequest q){
   var file=q.files.SingleOrDefault(f=>f.destination==q.destination+"/Generated/rig.json");
   if(file==null)throw new Conflict("Humanoid has no hash-bound source rig manifest");
   ValidateFile(Safe(file.destination),file.sha256);
   var rig=JsonUtility.FromJson<RigManifest>(File.ReadAllText(Safe(file.destination)));
   if(rig?.schemaVersion!=1||rig.armatureCount!=1||string.IsNullOrEmpty(rig.armatureName)||string.IsNullOrEmpty(rig.sourceSha256)||rig.parts==null||rig.parts.Length==0||rig.contract==null||JsonUtility.ToJson(rig.contract)!=JsonUtility.ToJson(q.rigContract)||q.rigContract.humanBones==null||q.rigContract.humanBones.Length<17)throw new Conflict("Humanoid source inventory or contract differs");
   if(q.rigContract.humanBones.Select(b=>b.boneName).Distinct().Count()!=q.rigContract.humanBones.Length||q.rigContract.humanBones.Select(b=>b.humanName).Distinct().Count()!=q.rigContract.humanBones.Length)throw new Conflict("Duplicate Humanoid bone mapping");
   return rig;
  }
  static ImportedRig VerifyHumanoid(DeliveryRequest q,GameObject model,ModelImporter importer,Avatar avatar){
   var evidence=ReadRigManifest(q);
   if(importer.animationType!=ModelImporterAnimationType.Human||!avatar||!avatar.isValid||!avatar.isHuman)throw new Exception("Humanoid Avatar validity/human checks failed");
   if(q.rigContract.schemaVersion==2){
    ValidateExternalMapping(q.rigContract);var mapping=q.rigContract.humanBones.ToDictionary(b=>b.humanName,b=>b.boneName);var transforms=model.GetComponentsInChildren<Transform>(true);var parents=ExternalParents(q.rigContract);
    foreach(var pair in parents.Where(p=>mapping.ContainsKey(p.Key)&&mapping.ContainsKey(p.Value))){var bone=transforms.Single(t=>t.name==mapping[pair.Key]);var ancestor=bone.parent;while(ancestor&&ancestor.name!=mapping[pair.Value]){if(mapping.Values.Contains(ancestor.name))throw new Exception("Unexpected mapped anatomical ancestor: "+pair.Key);ancestor=ancestor.parent;}if(!ancestor)throw new Exception("External Humanoid anatomical ancestry differs: "+pair.Key);}
   }
   foreach(var binding in q.rigContract.humanBones){
    var human=(HumanBodyBones)Enum.Parse(typeof(HumanBodyBones),binding.humanName);
    if(!importer.humanDescription.human.Any(b=>b.boneName==binding.boneName&&b.humanName==HumanTrait.BoneName[(int)human]))throw new Exception("Imported HumanDescription differs from canonical mapping");
   }
   var skins=model.GetComponentsInChildren<SkinnedMeshRenderer>(true);
   if(skins.Length!=evidence.parts.Length||model.GetComponentsInChildren<MeshRenderer>(true).Length>0)throw new Exception("Humanoid part renderer inventory differs from source");
   var parts=new List<RigPart>();
   foreach(var part in evidence.parts){
    var matches=skins.Where(s=>s.name==part.meshName).ToArray();
    if(matches.Length!=1||!matches[0].sharedMesh||matches[0].bones.Length<1||matches[0].bones.Any(b=>!b))throw new Exception("Humanoid part skin/bone references missing: "+part.meshName);
    var skin=matches[0];var mesh=skin.sharedMesh;
    if(q.rigContract.schemaVersion==2){
     if(mesh.bindposes.Length!=skin.bones.Length)throw new Exception("External Humanoid bind pose inventory differs");
     for(int i=0;i<skin.bones.Length;i++){var expected=skin.bones[i].worldToLocalMatrix*skin.transform.localToWorldMatrix;var actual=mesh.bindposes[i];for(int row=0;row<4;row++)for(int column=0;column<4;column++)if(float.IsNaN(actual[row,column])||float.IsInfinity(actual[row,column])||Math.Abs(actual[row,column]-expected[row,column])>.002f)throw new Exception("External Humanoid rest/bind matrix differs: "+skin.bones[i].name);}
    }
    if(mesh.vertexCount<part.vertices)throw new Exception("Humanoid source vertices missing: "+part.meshName);
    var counts=mesh.GetBonesPerVertex();var weights=mesh.GetAllBoneWeights();int cursor=0;
    try{
     if(counts.Length!=mesh.vertexCount)throw new Exception("Humanoid skin weights are inaccessible");
     foreach(var count in counts){float total=0;for(int index=0;index<count;index++){var weight=weights[cursor++];if(float.IsNaN(weight.weight)||float.IsInfinity(weight.weight)||weight.weight<0||weight.boneIndex<0||weight.boneIndex>=skin.bones.Length)throw new Exception("Invalid imported Humanoid weight");total+=weight.weight;if(part.partId=="hair"&&q.rigContract.hairBinding=="head"&&weight.weight>.000001f&&skin.bones[weight.boneIndex].name!=(q.rigContract.schemaVersion==2?q.rigContract.humanBones.Single(b=>b.humanName=="Head").boneName:"head"))throw new Exception("Hair no longer follows Head exclusively");}if(Math.Abs(total-1)>.001f)throw new Exception("Imported Humanoid weights are not normalized");}
    }finally{counts.Dispose();weights.Dispose();}
    parts.Add(new RigPart{meshName=part.meshName,meshId=part.meshId,partId=part.partId,armatureName=part.armatureName,vertices=mesh.vertexCount,boneCount=skin.bones.Length,normalizedWeights=true});
   }
   return new ImportedRig{rigType="humanoid",versionId=q.rigContract.versionId,sourceSha256=evidence.sourceSha256,avatarValid=avatar.isValid,avatarHuman=avatar.isHuman,humanBones=q.rigContract.humanBones,parts=parts.ToArray()};
  }
  static void ValidatePhysicalSize(DeliveryRequest q,PhysicalSizeManifest evidence){
   if(evidence?.schemaVersion!=1||!evidence.originalPreserved||evidence.dimensionsMeters==null||evidence.settings==null||string.IsNullOrEmpty(evidence.sourceSha256)||JsonUtility.ToJson(evidence.settings)!=JsonUtility.ToJson(q.physicalSize))throw new Conflict("Physical size settings differ from the immutable source measurement");
  }
  static PhysicalSizeManifest VerifyPhysicalSize(DeliveryRequest q,GameObject obj){
   var evidence=JsonUtility.FromJson<PhysicalSizeManifest>(File.ReadAllText(Safe(q.destination+"/Generated/physical-size.json")));ValidatePhysicalSize(q,evidence);
   var points=new List<Vector3>();
   foreach(var filter in obj.GetComponentsInChildren<MeshFilter>(true).Where(f=>!f.name.EndsWith("__PS_LOD1")&&f.sharedMesh))foreach(var vertex in filter.sharedMesh.vertices)points.Add(filter.transform.TransformPoint(vertex));
   foreach(var skin in obj.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(s=>!s.name.EndsWith("__PS_LOD1")&&s.sharedMesh)){
    // The contract is the undeformed bind mesh, not a sampled pose or Unity's
    // inflated animation bounds. BakeMesh can include the skeleton root scale;
    // applying the renderer transform again would falsely count it twice.
    foreach(var vertex in skin.sharedMesh.vertices)points.Add(skin.transform.TransformPoint(vertex));
   }
   if(points.Count==0||points.Any(p=>!float.IsFinite(p.x)||!float.IsFinite(p.y)||!float.IsFinite(p.z)))throw new Exception("No finite imported baseline vertices for physical size inspection");
   var dimensions=new MeterVector{x=points.Max(p=>p.x)-points.Min(p=>p.x),y=points.Max(p=>p.y)-points.Min(p=>p.y),z=points.Max(p=>p.z)-points.Min(p=>p.z)};
   float[] expected={evidence.dimensionsMeters.x,evidence.dimensionsMeters.y,evidence.dimensionsMeters.z},actual={dimensions.x,dimensions.y,dimensions.z};
   for(int i=0;i<3;i++)if(!float.IsFinite(actual[i])||Math.Abs(actual[i]-expected[i])>Math.Max(.001f,expected[i]*.001f))throw new Exception("Imported meter dimensions differ from the frozen rest-pose derivative on axis "+i+": "+actual[i]+" vs "+expected[i]);
   evidence.dimensionsMeters=dimensions;return evidence;
  }
  static void ValidateAnimationManifest(DeliveryRequest q,AnimationManifest evidence){
   var settings=q.clipSettings??Array.Empty<ClipSettings>();
   if(evidence?.schemaVersion!=1||evidence.clips==null||evidence.clipSettings==null||evidence.clips.Length!=settings.Length||evidence.clipSettings.Length!=settings.Length||settings.Select(c=>c.name).Distinct().Count()!=settings.Length||settings.Select(c=>c.versionId).Distinct().Count()!=settings.Length)throw new Conflict("Animation contract inventory differs from the immutable source");
   for(int i=0;i<settings.Length;i++){
    var c=settings[i];var source=evidence.clips.SingleOrDefault(s=>s.name==c.name);
    if(string.IsNullOrWhiteSpace(c.versionId)||string.IsNullOrWhiteSpace(c.name)||!float.IsFinite(c.fps)||c.fps<1||c.fps>120||JsonUtility.ToJson(c)!=JsonUtility.ToJson(evidence.clipSettings[i])||source==null||Math.Abs(source.sourceFps-c.fps)>.0001f||!float.IsFinite(source.firstFrame)||!float.IsFinite(source.lastFrame)||source.lastFrame<=source.firstFrame)throw new Conflict("Animation name/FPS/settings differ from frozen source evidence");
   }
  }
  static bool MatchesTake(ModelImporterClipAnimation clip,SourceClip source){
   string take=string.IsNullOrEmpty(clip.takeName)?clip.name:clip.takeName;
   return take==source.name||take==source.armatureName+"|"+source.name;
  }
  static void ApplyClipSettings(ModelImporter importer,GameObject model,DeliveryRequest q,AnimationManifest evidence){
   if(evidence==null||evidence.clipSettings.Length==0)return;
   var defaults=importer.defaultClipAnimations;
   var previous=importer.clipAnimations;
   var selected=new HashSet<int>();
   foreach(var setting in evidence.clipSettings){
    var source=evidence.clips.Single(s=>s.name==setting.name);
    var matches=Enumerable.Range(0,defaults.Length).Where(index=>MatchesTake(defaults[index],source)).ToArray();
    if(matches.Length!=1||!selected.Add(matches[0]))throw new Exception("Animation contract does not match one exact source take: "+setting.name);
    var clip=defaults[matches[0]];clip.name=setting.name;clip.loopTime=setting.loop;clip.loopPose=false;clip.cycleOffset=0;
    clip.lockRootRotation=!setting.rootMotion;clip.lockRootHeightY=!setting.rootMotion;clip.lockRootPositionXZ=!setting.rootMotion;
    clip.keepOriginalOrientation=true;clip.keepOriginalPositionY=true;clip.keepOriginalPositionXZ=true;
   }
   // Uncontracted legacy takes retain their existing settings; no name-based loop guesses.
   for(int i=0;i<defaults.Length;i++)if(!selected.Contains(i)){
    var old=previous.SingleOrDefault(c=>c.takeName==defaults[i].takeName);
    if(old!=null)defaults[i]=old;
   }
   importer.clipAnimations=defaults;
   // A Motion-tab override ignores per-clip bake flags. Use the Generic Rig root designation instead.
   importer.motionNodeName="";
   if(importer.animationType==ModelImporterAnimationType.Generic){
    var roots=evidence.clips.Select(c=>c.rootBoneName).Where(name=>!string.IsNullOrEmpty(name)).Distinct().ToArray();
    if(roots.Length==1){
     if(!model||model.GetComponentsInChildren<Transform>(true).Count(t=>t.name==roots[0])!=1)throw new Exception("Source root bone does not identify one imported transform");
     var serialized=new SerializedObject(importer);var root=serialized.FindProperty("m_HumanDescription.m_RootMotionBoneName");
     if(root==null)throw new Exception("This Unity version does not expose the Generic root bone contract");
     root.stringValue=roots[0];serialized.ApplyModifiedPropertiesWithoutUndo();
    }else if(evidence.clipSettings.Any(c=>c.rootMotion))throw new Exception("Root motion requires one unambiguous source root bone");
   }
  }
  static ImportedClip[] VerifyClipSettings(ModelImporter importer,AnimationClip[] clips,AnimationManifest evidence){
   if(evidence==null)return Array.Empty<ImportedClip>();
   return evidence.clipSettings.Select(setting=>{
    var clip=clips.SingleOrDefault(c=>c.name==setting.name);var config=importer.clipAnimations.SingleOrDefault(c=>c.name==setting.name);var source=evidence.clips.Single(c=>c.name==setting.name);
    if(!clip||config==null||clip.isLooping!=setting.loop||config.loopTime!=setting.loop||config.loopPose||config.lockRootRotation==setting.rootMotion||config.lockRootHeightY==setting.rootMotion||config.lockRootPositionXZ==setting.rootMotion||Math.Abs(clip.frameRate-setting.fps)>.0001f||Math.Abs(clip.length-(source.lastFrame-source.firstFrame)/source.sourceFps)>1/setting.fps+.0001f)throw new Exception("Imported clip loop/root-motion/FPS/duration differs from frozen source: "+setting.name);
    return new ImportedClip{versionId=setting.versionId,name=setting.name,loop=config.loopTime,rootMotion=setting.rootMotion,lockRootRotation=config.lockRootRotation,lockRootHeightY=config.lockRootHeightY,lockRootPositionXZ=config.lockRootPositionXZ,sourceFps=source.sourceFps,importedFps=clip.frameRate,duration=clip.length};
   }).ToArray();
  }
  static void ApplyOptimization(DeliveryRequest q,GameObject obj,List<string> warnings){
   var options=q.optimization??new DeliveryOptimization();
   var renderers=obj.GetComponentsInChildren<Renderer>(true);
   var originalRenderers=renderers;
   if(options.lodEnabled){
    string relative=q.destination+"/Generated/optimization.json";
    if(!q.files.Any(f=>f.destination==relative))throw new Exception("LOD requires immutable local decimation evidence");
    var evidence=JsonUtility.FromJson<OptimizationManifest>(File.ReadAllText(Safe(relative)));
    if(evidence?.schemaVersion!=1||evidence.lods==null||evidence.lods.Length==0||evidence.settings==null||!evidence.settings.lodEnabled||Math.Abs(evidence.settings.lodRatio-options.lodRatio)>.000001f)throw new Exception("LOD settings differ from the local derivative");
    var low=new List<Renderer>();var high=new List<Renderer>();
    foreach(var lod in evidence.lods){
     if(lod.derivedTriangles>=lod.sourceTriangles||lod.derivedTriangles<1)throw new Exception("LOD did not reduce source triangles");
     high.Add(renderers.Single(r=>r.name==lod.source));low.Add(renderers.Single(r=>r.name==lod.derived));
    }
    if(high.Count+low.Count!=renderers.Length)throw new Exception("LOD has an unclassified renderer");
    var group=obj.AddComponent<LODGroup>();group.SetLODs(new[]{new LOD(.5f,high.ToArray()),new LOD(.1f,low.ToArray())});group.RecalculateBounds();originalRenderers=high.ToArray();
    warnings.Add("Explicit local LOD1 applied at 50% screen-relative height and culled below 10%; switching and silhouette require visual review.");
   }
   if(options.collider=="box"){
    if(originalRenderers.Length==0)throw new Exception("Box collider has no source renderer bounds");
    var bounds=new Bounds(obj.transform.InverseTransformPoint(originalRenderers[0].bounds.center),Vector3.zero);
    foreach(var renderer in originalRenderers){var b=renderer.bounds;for(int x=-1;x<=1;x+=2)for(int y=-1;y<=1;y+=2)for(int z=-1;z<=1;z+=2)bounds.Encapsulate(obj.transform.InverseTransformPoint(b.center+Vector3.Scale(b.extents,new Vector3(x,y,z))));}
    var collider=obj.AddComponent<BoxCollider>();collider.center=bounds.center;collider.size=bounds.size;
   }else if(options.collider=="mesh"||options.collider=="convex"){
    foreach(var renderer in originalRenderers){
     var filter=renderer.GetComponent<MeshFilter>();if(!filter||!filter.sharedMesh||renderer is SkinnedMeshRenderer)throw new Exception("Mesh collision requires a static MeshFilter source");
     var collider=renderer.gameObject.AddComponent<MeshCollider>();collider.sharedMesh=filter.sharedMesh;collider.convex=options.collider=="convex";
    }
    warnings.Add(options.collider=="convex"?"Convex collision is a Unity-generated hull; concavities are not preserved and cooking/gameplay need review.":"Mesh collision uses the original static render mesh; dynamic Rigidbody use needs explicit convex authoring.");
   }else if(options.collider!=null&&options.collider!="none")throw new Exception("Unsupported collider option");
   if(options.deliveryTextureSize>0||options.deliveryCompression=="normal")warnings.Add("Explicit delivery texture size/compression was applied only to Unity import settings; source image bytes remain unchanged.");
  }
 }
}
