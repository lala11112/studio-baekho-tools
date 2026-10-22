using System;
using System.IO;
using System.Threading.Tasks;
using StudioBaekho.CombatLab;
using UnityEditor;
using UnityEngine;

// Invoke in Play Mode. Creates a quiet temporary tone and restores all changed state.
public static class CombatLabCaptureRegression
{
    public static async Task<string> Run()
    {
        if (!Application.isPlaying) throw new InvalidOperationException("Run in Play Mode.");
        EditorApplication.ExecuteMenuItem("Window/General/Game");
        string path = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "CombatLabResults",
            "capture-check-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss"), "wall-clock-audio"));
        float scale = Time.timeScale;
        var host = new GameObject("Combat Lab temporary audio test");
        var clip = AudioClip.Create("Combat Lab test tone", 48000, 1, 48000, false);
        var samples = new float[48000];
        for (int i = 0; i < samples.Length; i++) samples[i] = 0.08f * Mathf.Sin(i * 440f * 2f * Mathf.PI / 48000f);
        clip.SetData(samples, 0);
        var source = host.AddComponent<AudioSource>();
        source.clip = clip; source.loop = true; source.spatialBlend = 0f; source.volume = 0.08f;
        var capture = new CombatLabRecording();
        try
        {
            capture.Start(path); source.Play();
            double start = Time.realtimeSinceStartupAsDouble;
            Time.timeScale = 0f;
            while (Time.realtimeSinceStartupAsDouble - start < 1.5) await Task.Delay(50);
            Time.timeScale = 0.25f;
            while (Time.realtimeSinceStartupAsDouble - start < 3) await Task.Delay(50);
            capture.Stop();
            if (!string.IsNullOrEmpty(capture.Error)) throw new Exception(capture.Error);
            if (capture.CapturedFrameCount < 15) throw new Exception("Too few captured frames during stopped/slowed game time.");
            if (!File.Exists(capture.OutputPath)) throw new Exception("Missing encoded video.");
            return capture.OutputPath + "\n" + string.Join("\n", capture.Warnings);
        }
        finally
        {
            capture.Dispose(); Time.timeScale = scale;
            UnityEngine.Object.DestroyImmediate(host); UnityEngine.Object.DestroyImmediate(clip);
        }
    }
}
