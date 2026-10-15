import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const environment = { ...process.env };

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with code ${code}.`)));
  });
}

try {
  if (process.platform !== 'win32') throw new Error('Windows portable packaging must run on Windows.');
  const windowsRoot = environment.SystemRoot || environment.WINDIR;
  if (!windowsRoot) throw new Error('SystemRoot is missing; Windows PowerShell cannot be located.');
  const powershellDirectory = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  if (!existsSync(path.join(powershellDirectory, 'powershell.exe'))) throw new Error('Windows PowerShell 5.1 is required by electron-builder but could not be found.');
  // electron-builder's Windows dependency collector spawns powershell.exe by name.
  // Codex shells may have a reduced PATH; adjust this process and its children only.
  const pathKeys = Object.keys(environment).filter(key => key.toLowerCase() === 'path');
  const originalPath = pathKeys.map(key => environment[key]).filter(Boolean).join(path.delimiter);
  for (const key of pathKeys) delete environment[key];
  environment.Path = [powershellDirectory, path.dirname(process.execPath), originalPath].filter(Boolean).join(path.delimiter);
  const npmCli = environment.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('npm CLI was not found. Run this command through npm run package:win.');
  const builderCli = require.resolve('electron-builder/cli.js');

  if (process.argv.includes('--check')) {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major']);
    console.log('Windows packaging prerequisites verified. No build or packaging was started.');
  } else {
    await run(process.execPath, [npmCli, 'run', 'build']);
    await run(process.execPath, [builderCli, '--win', 'portable', '--x64']);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
