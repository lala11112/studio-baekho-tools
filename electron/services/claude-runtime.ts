import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CodexRuntime, RuntimeDiscoveryOptions } from './codex-runtime';

const execute = promisify(execFile);
export type ClaudeRuntime = CodexRuntime;

/** Inspect native Claude Code executables only. npm/PowerShell wrappers are never executed. */
export async function inspectClaudeRuntime(candidate: string): Promise<ClaudeRuntime | null> {
  try {
    if (process.platform === 'win32' && path.extname(candidate).toLowerCase() !== '.exe') return null;
    const absolute = await realpath(candidate);
    if (!(await lstat(absolute)).isFile()) return null;
    const { stdout } = await execute(absolute, ['--version'], { timeout: 15000, maxBuffer: 65536, windowsHide: true, env: claudeEnvironment() });
    const version = stdout.match(/(\d+\.\d+\.\d+[\w.+-]*)\s*\(Claude Code\)/)?.[1];
    return version ? { executable: absolute, version } : null;
  } catch { return null; }
}

/** The app launches its own non-interactive Claude Code; never inherit a parent Claude session marker. */
export function claudeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[key];
  return env;
}

async function isFile(candidate: string): Promise<boolean> {
  return (await lstat(candidate).catch(() => null))?.isFile() ?? false;
}

export async function discoverClaude(selected?: string, options: RuntimeDiscoveryOptions = {}): Promise<ClaudeRuntime | null> {
  const inspect = options.inspect ?? inspectClaudeRuntime;
  if (selected && await isFile(selected)) return inspect(selected);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const binary = platform === 'win32' ? 'claude.exe' : 'claude';
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const pathEntries = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')
    .map(directory => directory.trim().replace(/^"|"$/g, '')).filter(directory => path.isAbsolute(directory)).slice(0, 256);
  // The native installer is the official distribution; PATH covers other native installs.
  const candidates = [
    ...(home ? [path.join(home, '.local', 'bin', binary), path.join(home, '.claude', 'local', binary)] : []),
    ...pathEntries.map(directory => path.join(directory, binary)),
  ];
  for (const candidate of new Set(candidates)) {
    if (!await isFile(candidate)) continue;
    const runtime = await inspect(candidate);
    if (runtime) return runtime;
  }
  return null;
}
