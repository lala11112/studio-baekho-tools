import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Compare decoded local paths: Chromium and Node encode Windows short-path '~' differently. */
export function createPageTrustChecker(
  productionPage: string,
  developmentUrl: string | null,
  platform: NodeJS.Platform = process.platform,
): (url: string) => boolean {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const normalize = (value: string) => windows ? paths.normalize(value).toLowerCase() : paths.normalize(value);
  if (!paths.isAbsolute(productionPage)) throw new Error('The application page must have an absolute path.');
  const expectedPath = normalize(productionPage);
  const developmentOrigin = developmentUrl ? new URL(developmentUrl).origin : null;
  return (url: string): boolean => {
    try {
      const candidate = new URL(url);
      if (candidate.username || candidate.password) return false;
      if (developmentOrigin) {
        return candidate.origin === developmentOrigin && ['/', '/index.html'].includes(candidate.pathname);
      }
      if (candidate.protocol !== 'file:' || candidate.hostname) return false;
      return normalize(fileURLToPath(candidate, { windows })) === expectedPath;
    } catch { return false; }
  };
}
