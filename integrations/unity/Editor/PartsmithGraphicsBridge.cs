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
  public int schemaVersion; public string requestId,objectId,objectName,destination,resultPath,profileFingerprint,unityVersion,pipeline,converterVersion,structure,rigType,mode;
  public FileEntry[] files,sources,profileFiles; public string[] expectedClips; public float spritePixelsPerUnit;
 }
 [Serializable] public class DeliveryReport {
  public string requestId,objectId,profileFingerprint,converterVersion,status,guid,prefabPath,userPrefabPath,unityVersion,pipeline;
  public bool playbackVerified; public string[] clips,warnings,errors;
 }
 [Serializable] public class ManagedManifest { public string objectId,profileFingerprint,converterVersion,structure,requestId,pipeline,unityVersion; public FileEntry[] files; }
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
  static void Process(string requestFile){
   DeliveryRequest q=null;
   var warnings=new List<string>{"Import verified only. No Play Mode, visual fidelity, skin deformation, UI layout, or gameplay verification was performed."};
   var errors=new List<string>();
   var r=new DeliveryReport{status="failed",unityVersion=Application.unityVersion,playbackVerified=false,clips=Array.Empty<string>()};
   try{
    q=JsonUtility.FromJson<DeliveryRequest>(File.ReadAllText(requestFile));
    if(q==null||q.schemaVersion!=1||!System.Text.RegularExpressions.Regex.IsMatch(q.requestId??"","^[a-f0-9]{32}$")||string.IsNullOrWhiteSpace(q.objectId))throw new Exception("Invalid graphics request");
    r.requestId=q.requestId;r.objectId=q.objectId;r.profileFingerprint=q.profileFingerprint;r.converterVersion=q.converterVersion;r.pipeline=q.pipeline;
    if(q.destination==null||!System.Text.RegularExpressions.Regex.IsMatch(q.destination,"^Assets/PartsmithGraphics/[A-Za-z0-9_-]{1,64}$"))throw new Exception("Unsafe graphics destination");
    if(Path.GetFullPath(q.resultPath)!=Safe("Library/PartsmithGraphicsResults/"+q.requestId+".json"))throw new Exception("Unsafe result path");
    if(q.files==null||q.files.Length==0||q.files.Select(f=>f.destination).Distinct().Count()!=q.files.Length)throw new Exception("Missing or duplicate delivery files");
    if(q.mode!="model"&&q.mode!="sprite"||q.rigType!="generic"&&q.rigType!="humanoid")throw new Exception("Unsupported import mode");
    Profile(q);
    string generated=q.destination+"/Generated",user=q.destination+"/User";
    string manifestPath=Safe(generated+"/partsmith-manifest.json");
    string stage=Safe("Library/PartsmithGraphicsStaging/"+q.requestId)+Path.DirectorySeparatorChar;
    foreach(var f in q.files){
     if(!Path.GetFullPath(f.source).StartsWith(stage,StringComparison.OrdinalIgnoreCase)||!f.destination.StartsWith(generated+"/",StringComparison.Ordinal)||f.destination.EndsWith(".meta",StringComparison.OrdinalIgnoreCase))throw new Exception("Unsafe staged file");
     Safe(Relative(Path.GetFullPath(f.source)));Safe(f.destination);ValidateFile(f.source,f.sha256);
     if(new FileInfo(f.source).Length!=f.bytes)throw new Conflict("Staged file byte count changed");
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
  static void Texture(string asset,bool sprite,float ppu){
   var importer=AssetImporter.GetAtPath(asset) as TextureImporter;if(!importer)throw new Exception("Texture importer missing: "+asset);
   importer.maxTextureSize=16384;importer.textureCompression=TextureImporterCompression.Uncompressed;
   importer.npotScale=TextureImporterNPOTScale.None;importer.mipmapEnabled=!sprite;
   importer.ClearPlatformTextureSettings("Standalone");
   if(sprite){importer.textureType=TextureImporterType.Sprite;importer.spriteImportMode=SpriteImportMode.Single;importer.spritePixelsPerUnit=ppu;importer.alphaIsTransparency=true;}
   importer.SaveAndReimport();
  }
  static void SavePrefab(GameObject instance,DeliveryReport r){
   PrefabUtility.SaveAsPrefabAsset(instance,r.prefabPath);
   if(!File.Exists(Safe(r.userPrefabPath))){
    var scene=instance.scene;var variant=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(r.prefabPath),scene);
    try{PrefabUtility.SaveAsPrefabAsset(variant,r.userPrefabPath);}finally{UnityEngine.Object.DestroyImmediate(variant);}
   }
  }
  static void ImportSprite(DeliveryRequest q,DeliveryReport r,List<string> warnings){
   var image=q.files.Single(f=>f.kind=="image").destination;Texture(image,true,q.spritePixelsPerUnit);
   var sprite=AssetDatabase.LoadAssetAtPath<Sprite>(image);if(!sprite)throw new Exception("Sprite subasset missing");
   var scene=EditorSceneManager.NewPreviewScene();
   try{var obj=new GameObject("Asset");UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(obj,scene);obj.AddComponent<SpriteRenderer>().sprite=sprite;SavePrefab(obj,r);UnityEngine.Object.DestroyImmediate(obj);}finally{EditorSceneManager.ClosePreviewScene(scene);}
   warnings.Add("Single sprite prefab created. Canvas layout, UI Image, nine-slice, and sprite sheet animation are not inferred.");
  }
  static void ImportModel(DeliveryRequest q,DeliveryReport r,List<string> warnings){
   string modelPath=q.destination+"/Generated/Asset.fbx",texturePath=q.destination+"/Generated/Textures";
   var importer=AssetImporter.GetAtPath(modelPath) as ModelImporter;if(!importer)throw new Exception("FBX importer missing");
   importer.globalScale=1;importer.useFileScale=true;importer.bakeAxisConversion=true;importer.importAnimation=true;importer.animationCompression=ModelImporterAnimationCompression.Off;
   importer.materialImportMode=ModelImporterMaterialImportMode.ImportStandard;
   // Re-read source materials on updates; existing remaps otherwise hide changed source values.
   foreach(var entry in importer.GetExternalObjectMap().ToArray())importer.RemoveRemap(entry.Key);
   // Static meshes do not require an Avatar. Skeleton-bearing models use the explicitly chosen mode.
   var initial=AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);bool skinned=initial&&initial.GetComponentsInChildren<SkinnedMeshRenderer>(true).Any(s=>s.bones.Length>0);
   importer.animationType=skinned?(q.rigType=="humanoid"?ModelImporterAnimationType.Human:ModelImporterAnimationType.Generic):ModelImporterAnimationType.Generic;
   importer.avatarSetup=skinned?ModelImporterAvatarSetup.CreateFromThisModel:ModelImporterAvatarSetup.NoAvatar;
   importer.SaveAndReimport();Folder(texturePath);importer.ExtractTextures(texturePath);AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
   foreach(var file in Directory.GetFiles(Safe(texturePath)).Where(f=>new[]{".png",".jpg",".jpeg",".tga"}.Contains(Path.GetExtension(f).ToLowerInvariant())))Texture(Relative(file),false,100);
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
    foreach(var key in new[]{"_BumpMap","_MetallicGlossMap","_OcclusionMap","_EmissionMap"})if(mat.HasProperty(key)&&original.HasProperty(key))mat.SetTexture(key,original.GetTexture(key));
    if(mat.HasProperty("_BumpMap")&&mat.GetTexture("_BumpMap"))mat.EnableKeyword("_NORMALMAP");
    EditorUtility.SetDirty(mat);importer.AddRemap(new AssetImporter.SourceAssetIdentifier(original),mat);
   }
   importer.SaveAndReimport();model=AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);
   var clips=AssetDatabase.LoadAllAssetsAtPath(modelPath).OfType<AnimationClip>().Where(c=>!c.name.StartsWith("__preview__")).ToArray();r.clips=clips.Select(c=>c.name).ToArray();
   if(q.expectedClips!=null&&q.expectedClips.Any(expected=>!clips.Any(c=>c.name==expected||c.name.EndsWith("|"+expected))))throw new Exception("An exact source action is missing after Unity import");
   var avatar=AssetDatabase.LoadAllAssetsAtPath(modelPath).OfType<Avatar>().FirstOrDefault();
   if(skinned&&(!avatar||!avatar.isValid||q.rigType=="humanoid"&&!avatar.isHuman))throw new Exception("Requested rig Avatar failed validation");
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
    if(controller||skinned){var animator=obj.GetComponent<Animator>();if(!animator)animator=obj.AddComponent<Animator>();animator.avatar=avatar;animator.runtimeAnimatorController=controller;animator.applyRootMotion=false;}
    SavePrefab(obj,r);UnityEngine.Object.DestroyImmediate(obj);
   }finally{EditorSceneManager.ClosePreviewScene(scene);}
   warnings.Add("Base color and supported texture bindings were adapted to the selected renderer. Transparency, custom shaders, channel packing, and appearance require visual review.");
  }
 }
}
