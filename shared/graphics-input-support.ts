import { importedModelSourceProblem, isGraphicsProductionFile, type AssetVersion, type GraphicsKind } from './graphics';

/** Format readiness only. File hashes, UV quality and combined-rig contracts remain engine-owned. */
export function graphicsInputSupportProblem(taskId: string, versions: AssetVersion[], kind?: GraphicsKind): string | undefined {
  const ambiguous=versions.map(importedModelSourceProblem).find(Boolean);if(ambiguous)return ambiguous;
  if (!['T02', 'T05', 'A05', 'X04', 'X05'].includes(taskId)) return undefined;
  if (taskId === 'X05' && (kind === 'sprite' || kind === 'ui')) return undefined;
  const relevant = versions.filter(version => ['model', 'material', 'rig', 'animation'].includes(version.role));
  const supported = taskId === 'X05' ? /\.(blend|fbx|glb|obj)$/i : /\.(blend|fbx|glb)$/i;
  const required = taskId === 'X05' ? 'BLEND·FBX·GLB·OBJ' : 'BLEND·FBX·GLB';
  if (!relevant.length) return `이 작업에 사용할 모델 원본이 없습니다. BLEND/FBX 원본으로 가져와 채택하면 진행할 수 있습니다.`;
  for (const version of relevant) {
    const files = version.files.filter(isGraphicsProductionFile);
    if (files.some(file => supported.test(file.path))) continue;
    const native = files.filter(file => /\.(blend|fbx|glb|obj|stl)$/i.test(file.path));
    if (native.length) {
      const formats = [...new Set(native.map(file => file.path.split('.').at(-1)!.toUpperCase()))].join('·');
      return `${formats} 원본은 이 작업에서 지원하지 않습니다. ${required} 원본이 필요합니다. BLEND/FBX 원본으로 가져와 채택하면 진행할 수 있습니다. 화면 미리보기는 제작 원본을 대신하지 않습니다.`;
    }
    return `선택한 버전에 모델 원본 파일이 없습니다. ${required} 원본이 필요합니다. BLEND/FBX 원본으로 가져와 채택하면 진행할 수 있습니다. 화면 미리보기는 제작 원본을 대신하지 않습니다.`;
  }
  return undefined;
}
