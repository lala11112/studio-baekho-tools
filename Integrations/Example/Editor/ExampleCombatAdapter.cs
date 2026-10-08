using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace StudioBaekho.CombatLab.Example
{
    public sealed class ExampleCombatAdapter : ICombatLabActionAdapter
    {
        public const string AdapterId = "studio-baekho.example";
        public string Id => AdapterId;
        public string DisplayName => "Example / 기본 연결 예제";

        public List<CombatSource> DiscoverSources() => AssetDatabase.FindAssets("t:ExampleActionData")
            .Select(guid => new CombatSource { guid = guid, label = AssetDatabase.GUIDToAssetPath(guid) })
            .OrderBy(source => source.label, StringComparer.Ordinal).ToList();

        public List<CombatAction> DiscoverActions(string sourceGuid)
        {
            Resolve(sourceGuid);
            return new List<CombatAction> { new CombatAction { id = "strike", label = "훈련 표적 공격" } };
        }

        public List<ParameterSpec> Describe(string sourceGuid) => Describe(sourceGuid, null);
        public List<ParameterSpec> Describe(string sourceGuid, string actionId)
        {
            RequireAction(actionId);
            var source = Resolve(sourceGuid);
            return new List<ParameterSpec> {
                Spec("damage", "피해량", "HP", 1f, 100f, source.damage, "훈련 표적이 실제로 받은 피해량입니다."),
                Spec("attackInterval", "공격 간격", "초", 0.15f, 3f, source.attackInterval, "다음 공격 요청을 허용하기까지의 게임 시간입니다."),
                Spec("knockbackDistance", "밀리는 거리", "m", 0f, 2f, source.knockbackDistance, "실제 명중 시 표적을 오른쪽으로 밀어내는 거리입니다. 사거리 밖에서는 빗나갑니다.")
            };
        }

        private static ParameterSpec Spec(string id, string label, string unit, float minimum, float maximum, float baseline, string description)
            => new ParameterSpec { id = id, label = label, unit = unit, minimum = minimum, maximum = maximum, baseline = baseline, description = description };

        internal static ExampleActionData Resolve(string guid)
        {
            var data = AssetDatabase.LoadAssetAtPath<ExampleActionData>(AssetDatabase.GUIDToAssetPath(guid ?? ""));
            if (data == null) throw new ArgumentException("ExampleActionData 에셋을 선택하세요. 예제 씬 생성 메뉴로 만들 수 있습니다.");
            return data;
        }

        private static void RequireAction(string actionId)
        {
            if (!string.IsNullOrEmpty(actionId) && actionId != "strike") throw new ArgumentException("예제는 strike 동작만 지원합니다.");
        }

        public void Validate(ExperimentRequest request)
        {
            if (request == null || request.adapterId != Id) throw new ArgumentException("예제 어댑터 요청이 아닙니다.");
            CombatLab.ValidateData(request);
            var actor = FindActor();
            if (actor.actionData == null || actor.target == null || !actor.target.enabled || !actor.target.gameObject.activeInHierarchy)
                throw new InvalidOperationException("활성 ExampleCombatActor에 Action Data와 활성 Target을 연결하세요.");
        }

        internal static ExampleCombatActor FindActor()
        {
            // Authoring validation also runs immediately after scene creation, before OnEnable/Awake.
            var actors = Object.FindObjectsByType<ExampleCombatActor>(FindObjectsSortMode.None)
                .Where(actor => actor.enabled && actor.gameObject.activeInHierarchy).ToArray();
            if (actors.Length != 1) throw new InvalidOperationException("현재 씬에는 활성 ExampleCombatActor가 정확히 하나 필요합니다.");
            return actors[0];
        }

        internal static ExampleActionData CloneAndApply(ExampleActionData source, CombatCandidate candidate)
        {
            // These are value fields only. Deep-clone any referenced SO before mutating it in a real adapter.
            var copy = Object.Instantiate(source);
            copy.name = source.name + " (Combat Lab)";
            foreach (var value in candidate.values)
            {
                if (value.id == "damage") copy.damage = value.value;
                else if (value.id == "attackInterval") copy.attackInterval = value.value;
                else if (value.id == "knockbackDistance") copy.knockbackDistance = value.value;
            }
            return copy;
        }

        private void ValidateCandidate(ExperimentRequest request, CombatCandidate candidate)
        {
            if (request == null || request.adapterId != Id) throw new ArgumentException("예제 어댑터 요청이 아닙니다.");
            CombatLab.ValidateData(new ExperimentRequest {
                adapterId = Id, sourceGuid = request.sourceGuid, actionId = request.actionId,
                durationSeconds = request.durationSeconds, candidates = new List<CombatCandidate> { candidate }
            });
        }

        public ICombatLabSession Begin(ExperimentRequest request, CombatCandidate candidate)
        {
            Validate(request);
            ValidateCandidate(request, candidate);
            if (!Application.isPlaying || Time.timeScale <= 0f) throw new InvalidOperationException("일시 정지되지 않은 Play Mode가 필요합니다.");
            return new ExampleCombatSession(request, candidate, FindActor());
        }

        public Object Export(ExperimentRequest request, CombatCandidate candidate, string assetPath)
        {
            ValidateCandidate(request, candidate);
            string path = (assetPath ?? "").Replace('\\', '/');
            if (!path.StartsWith("Assets/", StringComparison.Ordinal) || path.Contains("..") || !path.EndsWith(".asset", StringComparison.OrdinalIgnoreCase)
                || File.Exists(path) || AssetDatabase.LoadMainAssetAtPath(path) != null || !AssetDatabase.IsValidFolder(Path.GetDirectoryName(path).Replace('\\', '/')))
                throw new ArgumentException("Assets 안의 기존 폴더에 새로운 .asset 경로를 지정하세요.");
            var copy = CloneAndApply(Resolve(request.sourceGuid), candidate);
            try
            {
                // Export the runtime SO directly. It can be assigned to the actor and included in builds.
                copy.name = Path.GetFileNameWithoutExtension(path);
                AssetDatabase.CreateAsset(copy, path);
                EditorUtility.SetDirty(copy);
                AssetDatabase.SaveAssetIfDirty(copy);
                return copy;
            }
            catch
            {
                if (!AssetDatabase.Contains(copy)) Object.DestroyImmediate(copy);
                throw;
            }
        }
    }
}
