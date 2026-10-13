import fs from 'node:fs/promises';
import path from 'node:path';
import type { GraphicsStorageReport } from '../shared/graphics-storage';

const cacheNames = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache']);
const definitions = [
  ['originals', '등록된 제작 원본·버전', '현재 등록 파일과 채택 결과입니다. 보존이 필요합니다.'],
  ['project-other', '프로젝트 작업·검사·기록', '미등록 작업 원본도 포함할 수 있습니다. 불필요한 자료로 단정하지 않습니다.'],
  ['cache', '브라우저 렌더링 캐시', '재생성 가능한 후보입니다. 로그인 데이터는 포함하지 않습니다. 실행 중 정리하지 않습니다.'],
  ['profile', '앱 설정·기타 데이터', '프로젝트 목록, 인증·설정과 복구 기록을 보존합니다.'],
  ['archive', '과거 제작 원본 보관본', '유일하게 남은 과거 제작 원본이 포함됩니다. 삭제하지 마세요.'],
  ['release', '앱 배포 파일', '현재 실행본과 이전 버전이 포함될 수 있습니다. 정리 전 의존성 확인이 필요합니다.'],
  ['dependencies', '개발 라이브러리', '개발·빌드용 파일입니다. 설치 앱의 제작 원본과 별개입니다.'],
  ['validation', '검사 입력·보고서', '고정 입력과 백업이 포함될 수 있습니다. 폴더 전체 삭제는 적절하지 않습니다.'],
  ['source', '소스·기타 개발 자료', '개발 소스와 Git 기록 등을 포함합니다.'],
] as const;

/** Enumerate metadata only, never follow symlinks/junctions or read source contents. */
export async function inspectGraphicsStorage(args: {
  profileRoot: string; appRoot?: string; registeredFiles: string[];
}): Promise<GraphicsStorageReport> {
  const key = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const sources = new Set(args.registeredFiles.map(key));
  const categories = definitions.map(([id, label, note]) => ({ id, label, note, bytes: 0, files: 0 }));
  const byId = new Map(categories.map(row => [row.id as string, row]));
  const report: GraphicsStorageReport = { measuredAt: new Date().toISOString(), roots: [], categories, totalBytes: 0, skippedLinks: 0, unreadable: 0, autoDelete: false };
  const roots = [{ label: '앱 데이터', path: path.resolve(args.profileRoot), profile: true },
    ...(args.appRoot ? [{ label: '앱·개발 파일', path: path.resolve(args.appRoot), profile: false }] : [])];
  const visited = new Set<string>();
  for (const root of roots) {
    const row = { label: root.label, path: root.path, bytes: 0, files: 0, incomplete: false };
    report.roots.push(row);
    const stack = [root.path];
    while (stack.length) {
      const current = stack.pop()!;
      if (visited.has(key(current))) continue;
      visited.add(key(current));
      let stat;
      try { stat = await fs.lstat(current); } catch { row.incomplete = true; report.unreadable++; continue; }
      if (stat.isSymbolicLink()) { report.skippedLinks++; continue; }
      if (stat.isDirectory()) {
        try { for (const name of await fs.readdir(current)) stack.push(path.join(current, name)); }
        catch { row.incomplete = true; report.unreadable++; }
        continue;
      }
      if (!stat.isFile()) continue;
      const relative = path.relative(root.path, current).split(path.sep);
      const first = relative[0];
      const id = root.profile
        ? sources.has(key(current)) ? 'originals' : first === 'projects' ? 'project-other'
          : relative.some(part => cacheNames.has(part)) ? 'cache' : 'profile'
        : first === 'node_modules' ? 'dependencies'
          : first === 'release' ? 'release'
          : relative[0] === 'artifacts' && relative[1] === 'preserved-validation-files' ? 'archive'
          : first === 'artifacts' ? 'validation'
          : ['resources', 'locales'].includes(first) || /\.(exe|dll|pak|bin|dat)$/i.test(current) ? 'release' : 'source';
      const category = byId.get(id)!;
      category.bytes += stat.size; category.files++;
      row.bytes += stat.size; row.files++; report.totalBytes += stat.size;
    }
  }
  return report;
}
