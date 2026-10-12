using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

// Test project only. This is not a game ItemDefinition or runtime importer.
public static class FourTigerItemPackageImportCheck
{
    [Serializable] private class Catalog { public int schemaVersion; public Item[] items; }
    [Serializable] private class Item { public string itemId; public string iconPath; }
    [Serializable] private class Report
    {
        public bool jsonImported;
        public int textureCount;
        public int spriteCount;
        public List<string> errors = new List<string>();
    }
    public static void Run()
    {
        var report = new Report();
        try
        {
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            const string packageRoot = "Assets/SainGeomPackage/";
            var json = AssetDatabase.LoadAssetAtPath<TextAsset>(packageRoot + "saingeom-items.v1.json");
            report.jsonImported = json != null;
            if (json == null) throw new Exception("Catalog did not import as TextAsset");
            var catalog = JsonUtility.FromJson<Catalog>(json.text);
            if (catalog.schemaVersion != 1 || catalog.items == null || catalog.items.Length != 20)
                throw new Exception("Expected schemaVersion 1 and 20 items");
            var paths = new HashSet<string>();
            foreach (var item in catalog.items)
            {
                if (String.IsNullOrEmpty(item.iconPath) || !item.iconPath.StartsWith("icons/") ||
                    item.iconPath.Contains("..") || item.iconPath.Contains("\\") || !paths.Add(item.iconPath))
                { report.errors.Add(item.itemId + ": missing, unsafe or duplicate iconPath"); continue; }
                var assetPath = packageRoot + item.iconPath;
                var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
                if (texture == null) { report.errors.Add(item.itemId + ": missing Texture2D"); continue; }
                report.textureCount++;
                if (texture.width != 256 || texture.height != 256)
                    report.errors.Add(item.itemId + ": expected 256x256");
                var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
                if (importer == null) { report.errors.Add(item.itemId + ": missing TextureImporter"); continue; }
                importer.textureType = TextureImporterType.Sprite;
                importer.spriteImportMode = SpriteImportMode.Single;
                importer.alphaIsTransparency = true;
                importer.SaveAndReimport();
                if (AssetDatabase.LoadAssetAtPath<Sprite>(assetPath) != null) report.spriteCount++;
                else report.errors.Add(item.itemId + ": missing Sprite");
            }
            if (report.textureCount != 20 || report.spriteCount != 20)
                report.errors.Add("Expected 20 textures and 20 sprites");
        }
        catch (Exception error) { report.errors.Add(error.Message); }
        var reportPath = Path.Combine(Directory.GetParent(Application.dataPath).FullName, "unity-import-report.json");
        File.WriteAllText(reportPath, JsonUtility.ToJson(report, true));
        EditorApplication.Exit(report.errors.Count == 0 ? 0 : 1);
    }
}
