using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using StudioBaekho.CombatLab;
using UnityEditor;
using UnityEngine;

/// <summary>Exercises the real filesystem transport in Edit Mode without starting a run or creating assets.</summary>
public static class CombatLabBridgeRegression
{
    [Serializable] private sealed class Envelope
    {
        public string id;
        public int protocolVersion = 1;
        public string command = "describe";
        public string payloadJson = "{}";
        public long expiresUtcMs;
    }
    [Serializable] private sealed class Receipt
    {
        public string id;
        public bool ok;
        public string payloadJson;
        public string error;
    }

    public static string Run()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling || CombatLabRunner.IsRunning)
            throw new InvalidOperationException("Run bridge checks while Unity is idle in Edit Mode.");
        string mailbox = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Library", "CombatLabBridge"));
        var owned = new List<string>();
        var passed = new List<string>();
        foreach (string folder in new[] { "requests", "processing", "responses" }) Directory.CreateDirectory(Path.Combine(mailbox, folder));
        // Refuse to interfere with another client's queued work; normal editor polling will drain it.
        if (Directory.GetFiles(Path.Combine(mailbox, "requests"), "*.json").Length != 0 ||
            Directory.GetFiles(Path.Combine(mailbox, "processing"), "*.json").Length != 0)
            throw new InvalidOperationException("Let the desktop client's queued requests finish before bridge checks.");

        void Invoke(string method)
        {
            try { typeof(CombatLabBridge).GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null); }
            catch (TargetInvocationException error) { throw error.InnerException ?? error; }
        }
        string PathFor(string folder, string id)
        {
            string path = Path.Combine(mailbox, folder, id + ".json");
            if (!owned.Contains(path)) owned.Add(path);
            return path;
        }
        Receipt Submit(string id, string json)
        {
            File.WriteAllText(PathFor("requests", id), json);
            PathFor("processing", id);
            string response = PathFor("responses", id);
            Invoke("ProcessRequests");
            if (!File.Exists(response)) throw new InvalidOperationException("No response for " + id);
            return JsonUtility.FromJson<Receipt>(File.ReadAllText(response));
        }
        void Reject(string label, Action<Envelope> alter, string rawJson = null)
        {
            string id = Guid.NewGuid().ToString("N");
            var envelope = new Envelope { id = id };
            alter?.Invoke(envelope);
            var response = Submit(id, rawJson ?? JsonUtility.ToJson(envelope));
            if (response.id != id || response.ok || string.IsNullOrWhiteSpace(response.error))
                throw new InvalidOperationException("Bridge accepted invalid input: " + label);
            passed.Add(label);
        }
        try
        {
            Reject("unsupported protocol", request => request.protocolVersion = 2);
            Reject("ID does not match filename", request => request.id = Guid.NewGuid().ToString("N"));
            Reject("unknown command", request => request.command = "execute-script");
            Reject("expired request", request => request.expiresUtcMs = 1);
            Reject("missing start payload", request => { request.command = "start"; request.payloadJson = ""; });
            Reject("missing export fields", request => request.command = "export");
            Reject("malformed JSON", null, "{broken");
            Reject("oversize request", null, new string(' ', 1024 * 1024 + 1));

            string described = Guid.NewGuid().ToString("N");
            var description = Submit(described, JsonUtility.ToJson(new Envelope { id = described }));
            if (!description.ok || string.IsNullOrWhiteSpace(description.payloadJson) || !description.payloadJson.Contains("adapters"))
                throw new InvalidOperationException("Describe did not return the registered project adapters.");
            passed.Add("real adapter description");
            string original = File.ReadAllText(PathFor("responses", described));
            Submit(described, JsonUtility.ToJson(new Envelope { id = described, command = "start", payloadJson = "{}" }));
            if (original != File.ReadAllText(PathFor("responses", described)))
                throw new InvalidOperationException("A duplicate request replaced the original receipt.");
            passed.Add("duplicate side-effect request preserves receipt");

            string interrupted = Guid.NewGuid().ToString("N");
            File.WriteAllText(PathFor("processing", interrupted), JsonUtility.ToJson(new Envelope {
                id = interrupted, command = "start", payloadJson = "{}"
            }));
            string recoveredPath = PathFor("responses", interrupted);
            Invoke("RecoverProcessing");
            var recovered = JsonUtility.FromJson<Receipt>(File.ReadAllText(recoveredPath));
            if (recovered.ok || recovered.id != interrupted || string.IsNullOrEmpty(recovered.error) || CombatLabRunner.IsRunning)
                throw new InvalidOperationException("Interrupted request was replayed or lost its failure receipt.");
            passed.Add("reload recovery never replays a claimed action");
            return passed.Count + " bridge regression checks passed: " + string.Join(", ", passed);
        }
        finally
        {
            foreach (string path in owned) if (File.Exists(path)) File.Delete(path);
        }
    }
}
