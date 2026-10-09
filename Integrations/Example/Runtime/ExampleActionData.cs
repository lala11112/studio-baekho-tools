using UnityEngine;

namespace StudioBaekho.CombatLab.Example
{
    // This assembly has no Editor or Combat Lab dependency: exported data works in builds.
    [CreateAssetMenu(menuName = "Baekho/Combat Lab Example/Action Data")]
    public sealed class ExampleActionData : ScriptableObject
    {
        [Min(1f)] public float damage = 10f;
        [Min(0.15f)] public float attackInterval = 0.8f;
        [Min(0f)] public float knockbackDistance = 0.4f;
    }
}
