import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { buildElectron } from './build-electron.mjs';
await buildElectron();
const server = await createServer(); await server.listen();
const environment={...process.env,FORGE_DEV_URL:'http://127.0.0.1:5174'};delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { env:environment, stdio:'inherit',windowsHide:true });
child.on('exit', async code => { await server.close(); process.exit(code ?? 0); });
