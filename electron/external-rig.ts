import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { GraphicsWorkspace } from '../shared/graphics';

/** Only reveal the exact prepared, registered copy; never execute a model path. */
export function externalRigPreparedFile(root: string, workspace: GraphicsWorkspace, handoffId: string): string {
  const handoff = workspace.externalRigHandoffs?.find(item => item.id === handoffId);
  const file = handoff?.preparation?.files.find(item => item.kind === 'preparation-fbx');
  if (!handoff || handoff.state === 'cancelled' || !file) throw Error('먼저 리깅용 파일을 준비해 주세요.');
  const full = path.resolve(root, file.path), relative = path.relative(root, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/\.fbx$/i.test(full)) throw Error('준비된 리깅 파일 경로가 잘못됐습니다.');
  const realRoot = fs.realpathSync(root), real = fs.realpathSync(full);
  if (!real.startsWith(realRoot + path.sep) || fs.lstatSync(full).isSymbolicLink()) throw Error('준비된 프로젝트 안의 실제 파일만 열 수 있습니다.');
  const data = fs.readFileSync(full);
  if (data.byteLength !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw Error('준비한 파일이 변경됐습니다. 원본을 다시 확인하세요.');
  return full;
}
