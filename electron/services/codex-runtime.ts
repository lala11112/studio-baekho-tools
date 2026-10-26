import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export interface CodexRuntime { executable: string; version: string }
export interface RuntimeDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  inspect?: (candidate: string) => Promise<CodexRuntime | null>;
}

/** Inspect native executables only. npm/PowerShell wrappers are never executed. */
export async function inspectRuntime(candidate: string): Promise<CodexRuntime | null> {
  try {
    if (process.platform === 'win32' && path.extname(candidate).toLowerCase() !== '.exe') return null;
    const absolute = await realpath(candidate);
    if (!(await lstat(absolute)).isFile()) return null;
    const { stdout } = await execute(absolute, ['--version'], { timeout: 8000, maxBuffer: 65536, windowsHide: true });
    const version = stdout.match(/codex-cli\s+([\w.+-]+)/)?.[1];
    return version ? { executable: absolute, version } : null;
  } catch { return null; }
}

async function isFile(candidate: string): Promise<boolean> {
  return (await lstat(candidate).catch(() => null))?.isFile() ?? false;
}

export async function discoverCodex(selected?: string, options: RuntimeDiscoveryOptions = {}): Promise<CodexRuntime | null> {
  const inspect = options.inspect ?? inspectRuntime;
  // A real manual selection stays authoritative; removed installations recover automatically.
  if (selected && await isFile(selected)) return inspect(selected);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pathEntries = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')
    .map(directory => directory.trim().replace(/^"|"$/g, '')).filter(directory => path.isAbsolute(directory)).slice(0, 256);
  const candidates = pathEntries.map(directory => path.join(directory, platform === 'win32' ? 'codex.exe' : 'codex'));
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) {
      const desktopBin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
      const directories = await readdir(desktopBin, { withFileTypes: true }).catch(() => []);
      const versions = await Promise.all(directories.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).slice(0, 128).map(async entry => {
        const candidate = path.join(desktopBin, entry.name, 'codex.exe');
        return { candidate, modified: (await lstat(candidate).catch(() => null))?.mtimeMs ?? 0 };
      }));
      candidates.unshift(...versions.sort((a, b) => b.modified - a.modified).map(item => item.candidate));
    }
    const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const platformPackage = arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
    const npmDirectories = new Set([...pathEntries, ...(env.APPDATA ? [path.join(env.APPDATA, 'npm')] : [])]);
    for (const directory of npmDirectories) {
      if (!await isFile(path.join(directory, 'codex.cmd')) && !await isFile(path.join(directory, 'codex.ps1'))) continue;
      const packageRoot = path.join(directory, 'node_modules', '@openai', 'codex');
      // Official npm installs have either bundled vendor files or an optional platform package.
      const vendorRoots = [path.join(packageRoot, 'vendor'), path.join(directory, 'node_modules', '@openai', platformPackage, 'vendor'),
        path.join(packageRoot, 'node_modules', '@openai', platformPackage, 'vendor')];
      for (const vendor of vendorRoots) for (const binaryDirectory of ['bin', 'codex']) {
        candidates.push(path.join(vendor, triple, binaryDirectory, 'codex.exe'));
      }
    }
  }
  for (const candidate of new Set(candidates)) {
    if (!await isFile(candidate)) continue;
    const runtime = await inspect(candidate);
    if (runtime) return runtime;
  }
  return null;
}
