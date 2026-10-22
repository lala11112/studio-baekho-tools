import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { autoRigUnityExport } from './graphics-unity';
import type { GraphicsNativeArgs } from './graphics-native';
import type { GraphicsFile } from '../shared/graphics';
import { validateUnityRigContract } from '../shared/graphics-rig';

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function prepareAutoRigExport(args: GraphicsNativeArgs) {
  if (args.task.taskId !== 'X04' || !args.inputs.some(v => v.autoRig) && args.task.unityRigContract?.exportPolicy !== 'auto-rig-fbx') return undefined;
  if (args.inputs.length !== 1) throw Error('자동 리그 내보내기는 정확한 원본 한 개만 지원합니다.');
  const source = args.inputs[0], meta = source.autoRig;
  if (!meta || meta.schemaVersion !== 1 || !meta.runId || !meta.reportFile || meta.contract.versionId !== source.id || meta.contract.producerVersionId !== source.id) throw Error('검증된 자동 리그의 원본 계약이 필요합니다.');
  const contract = validateUnityRigContract(args.inputs,args.task.unityRigContract ?? meta.contract);
  // X04 copies files only; Unity-only LOD/collider/compression drafts do not apply.
  const fbx = autoRigUnityExport(source, args.inputs, {physicalSize:args.task.settings.physicalSize}, contract);
  if (!fbx || Number(args.task.settings.scale ?? 1) !== 1 || String(args.task.settings.pivot ?? 'keep') !== 'keep') throw Error('자동 리그는 크기·피벗 변경 없이 검증된 파일 그대로 내보냅니다.');
  const format = String(args.task.settings.exportFormat ?? 'both');
  if (!['fbx','both','glb'].includes(format)) throw Error('내보내기 형식을 확인하세요.');
  if (format === 'glb') throw Error('자동 리그 GLB는 진단용입니다. 검증된 리그를 유지하려면 FBX 또는 FBX+GLB를 선택하세요.');
  const blends = source.files.filter(f => f.kind === 'blend' && /\.blend$/i.test(f.path));
  const glbs = source.files.filter(f => /\.glb$/i.test(f.path) && (f.kind !== 'preview' || !!meta.derivedFromVersionId && /\/diagnostic\.glb$/i.test(f.path.replaceAll('\\','/'))));
  if (blends.length !== 1 || format === 'both' && glbs.length !== 1) throw Error('검증된 편집 원본 또는 진단 GLB가 없거나 중복됩니다.');
  const root = fs.realpathSync(args.projectRoot);
  function verify(file: GraphicsFile) {
    const absolute = path.resolve(root,file.path), relative = path.relative(root,absolute);
    if (!relative || relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw Error('자동 리그 원본 경로가 프로젝트 밖입니다.');
    const actual = fs.realpathSync(absolute), resolved = path.relative(root,actual);
    if (resolved === '..' || resolved.startsWith('..'+path.sep) || path.isAbsolute(resolved) || !fs.statSync(actual).isFile() || fs.statSync(actual).size !== file.bytes || sha(actual) !== file.sha256) throw Error('자동 리그 원본·검사·출력 SHA가 다릅니다.');
    return actual;
  }
  verify(meta.reportFile);
  const files = [{ file: blends[0], name:'asset.blend' },{ file:fbx,name:'asset.fbx' },...(format === 'both' ? [{file:glbs[0],name:'diagnostic.glb'}] : [])].map(item=>({...item,absolute:verify(item.file)}));
  return { policy:'verified-auto-rig-copy-v2', source, files, metadata:structuredClone(meta), format };
}
