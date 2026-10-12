import type { AssetVersion, GraphicsObject, GraphicsRole } from "./graphics";

const nativeFormats = ["blend", "fbx", "glb", "obj"];

/** Equal native bytes prove unchanged input; different bytes do not prove different topology. */
function sameNativeInput(a: AssetVersion, b: AssetVersion) {
  if (a.id === b.id) return true;
  const signature = (version: AssetVersion) => {
    for (const format of nativeFormats) {
      const hashes = version.files
        .filter(file => file.path.toLowerCase().endsWith("." + format))
        .map(file => file.sha256);
      if (hashes.length) {
        if (hashes.some(hash => !/^[a-f\d]{64}$/i.test(hash))) return undefined;
        return format + ":" + hashes.map(hash => hash.toLowerCase()).sort().join(":");
      }
    }
    return undefined;
  };
  const first = signature(a);
  return first !== undefined && first === signature(b);
}

/**
 * Checks selected dependency provenance, not visual/deformation quality.
 * It never changes acceptance, deletes history, or requests regeneration.
 * No issues means no known lineage conflict; it is not a topology/skin validation result.
 */
export function getGraphicsCompatibility(object: GraphicsObject, versions: AssetVersion[]): string[] {
  const byId = new Map(versions.map(version => [version.id, version]));
  const issues: string[] = [];
  const selected = (key: string, label: string) => {
    const id = object.accepted[key];
    if (!id) return undefined;
    const version = byId.get(id);
    if (!version || version.objectId !== object.id) {
      issues.push(`채택한 ${label} 버전을 찾을 수 없어 호환성 확인이 필요합니다.`);
      return undefined;
    }
    return version;
  };
  const model = selected("model:main", "모델");
  const rig = selected("rig:main", "리그");

  // Stop at the nearest role on each branch. A new model derived from an older model
  // must not let a rig built for the newer one silently match either model.
  const bases = (version: AssetVersion, role: "model" | "rig") => {
    const found = new Map<string, AssetVersion>();
    let uncertain = false;
    const allowed: GraphicsRole[] = role === "model" ? ["rig", "model"] : ["animation", "rig"];
    const visit = (id: string, branch: Set<string>) => {
      if (branch.has(id)) { uncertain = true; return; }
      const ancestor = byId.get(id);
      if (!ancestor) { uncertain = true; return; }
      // Appearance/style inputs from another object are not skeleton ancestry.
      if (ancestor.objectId !== object.id || !allowed.includes(ancestor.role)) return;
      if (ancestor.role === role) { found.set(ancestor.id, ancestor); return; }
      const next = new Set(branch); next.add(id);
      for (const source of ancestor.sourceVersionIds) visit(source, next);
    };
    for (const source of version.sourceVersionIds) visit(source, new Set([version.id]));
    return { versions: [...found.values()], uncertain };
  };

  if (model && rig) {
    const basis = bases(rig, "model");
    if (basis.uncertain || !basis.versions.length) {
      issues.push(`리그 ‘${rig.label}’의 기준 모델을 확인할 수 없습니다. 채택 모델 ‘${model.label}’과 메시·뼈 호환성 확인이 필요합니다.`);
    } else if (basis.versions.some(version => !sameNativeInput(version, model))) {
      issues.push(`리그 ‘${rig.label}’은 현재 채택 모델 ‘${model.label}’과 다른 모델 버전을 기준으로 만들었습니다. 메시 구조·웨이트 호환성을 확인하거나 리그의 기존 기준 모델을 다시 채택하세요.`);
    }
  }

  for (const key of Object.keys(object.accepted).filter(key => key.startsWith("animation:"))) {
    const clip = selected(key, key.slice("animation:".length) + " 동작");
    if (!clip) continue;
    if (!rig) {
      issues.push(`동작 ‘${clip.label}’과 연결할 채택 리그가 없어 뼈·바인드 포즈 호환성 확인이 필요합니다.`);
      continue;
    }
    const basis = bases(clip, "rig");
    if (basis.uncertain || !basis.versions.length) {
      issues.push(`동작 ‘${clip.label}’의 기준 리그를 확인할 수 없습니다. 채택 리그 ‘${rig.label}’과 뼈·바인드 포즈 호환성 확인이 필요합니다.`);
    } else if (basis.versions.some(version => !sameNativeInput(version, rig))) {
      issues.push(`동작 ‘${clip.label}’은 현재 채택 리그 ‘${rig.label}’과 다른 리그 버전을 기준으로 만들었습니다. 뼈 구조·바인드 포즈 호환성을 확인하거나 동작의 기존 기준 리그를 다시 채택하세요.`);
    }
  }
  return [...new Set(issues)];
}
