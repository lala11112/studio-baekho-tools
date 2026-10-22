import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('../Apps/AutoMapPrefabMaker/', import.meta.url));
for (const args of [
  [require.resolve('typescript/bin/tsc'), '--noEmit'],
  [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), 'build'],
  ['scripts/build-electron.mjs'],
]) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Map build failed (${result.status ?? result.signal})`);
}
