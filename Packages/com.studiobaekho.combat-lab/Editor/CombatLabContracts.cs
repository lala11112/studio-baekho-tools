using System;
using System.Collections.Generic;
using UnityEngine;

namespace StudioBaekho.CombatLab
{
    [Serializable] public sealed class CombatSource
    {
        public string guid;
        public string label;
    }

    [Serializable] public sealed class CombatAction
    {
        public string id;
        public string label;
        public bool available = true;
        public string unavailableReason = "";
    }

    [Serializable] public sealed class ParameterSpec
    {
        public string id;
        public string label;
        public string unit;
        public string description;
        public float minimum;
        public float maximum;
        public float baseline;
    }

    [Serializable] public sealed class ParameterValue
    {
        public string id;
        public float value;
        public ParameterValue() { }
        public ParameterValue(string id, float value) { this.id = id; this.value = value; }
    }

    [Serializable] public sealed class CombatCandidate
    {
        public string id;
        public string label;
        public string rationale;
        public List<ParameterValue> values = new List<ParameterValue>();
    }

    [Serializable] public sealed class CandidateGeneration
    {
        public string provider;
        public string model;
        public string goal;
        public int count;
        public string createdUtc;
    }

    [Serializable] public sealed class ExperimentRequest
    {
        public int schemaVersion = 1;
        public string adapterId;
        public string sourceGuid;
        // Omitted in older requests: the adapter's original default action.
        public string actionId;
        public int seed = 1701;
        public float durationSeconds = 10f;
        public bool recordVideo = true;
        public CandidateGeneration generation;
        public List<CombatCandidate> candidates = new List<CombatCandidate>();
    }

    [Serializable] public sealed class CombatActionSelection
    {
        public ExperimentRequest request;
        public string candidateId;
    }

    [Serializable] public sealed class CombinedExportRequest
    {
        public int schemaVersion = 1;
        public string adapterId;
        public string sourceGuid;
        public List<CombatActionSelection> selections = new List<CombatActionSelection>();
    }

    [Serializable] public sealed class CombatEvent
    {
        public float realTime;
        public float gameTime;
        public string kind;
        public string detail;
        public float value;
    }

    [Serializable] public sealed class CombatMetrics
    {
        public int attackRequests;
        public int hits;
        public float damageDealt;
        public float damageTaken;
        public float firstHitSeconds = -1f;
        public float elapsedSeconds;
        public List<CombatEvent> events = new List<CombatEvent>();
        public List<ParameterValue> appliedValues = new List<ParameterValue>();
        public List<string> notes = new List<string>();
    }

    public interface ICombatLabAdapter
    {
        string Id { get; }
        string DisplayName { get; }
        List<CombatSource> DiscoverSources();
        List<ParameterSpec> Describe(string sourceGuid);
        void Validate(ExperimentRequest request);
        ICombatLabSession Begin(ExperimentRequest request, CombatCandidate candidate);
        // Write a new asset only. Never overwrite the source.
        UnityEngine.Object Export(ExperimentRequest request, CombatCandidate candidate, string assetPath);
    }

    public interface ICombatLabSession : IDisposable
    {
        void Tick(float unscaledDeltaTime);
        bool Complete { get; }
        CombatMetrics Metrics { get; }
    }

    // Optional capability: existing project adapters remain source-compatible.
    public interface ICombatLabActionAdapter : ICombatLabAdapter
    {
        List<CombatAction> DiscoverActions(string sourceGuid);
        List<ParameterSpec> Describe(string sourceGuid, string actionId);
    }

    // Optional capability: combine one chosen candidate per action into a single new form asset.
    // Each candidate is relative to the same original source; preserve all unselected actions.
    public interface ICombatLabMultiActionAdapter : ICombatLabAdapter
    {
        UnityEngine.Object ExportCombined(CombinedExportRequest request, string assetPath);
    }

}
