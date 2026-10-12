// Read-only account/capability checks; no production profile Store.open, model turn, upload or paid submission.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import electronBinary from "electron";
const repo = process.cwd(), folder = fs.mkdtempSync(path.join(os.tmpdir(), "ps-graphics-connections-"));
const output = path.join(repo, "artifacts/runtime/graphics-connections.json");
const source = `
import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { Store } from ${JSON.stringify(path.join(repo, "engine/store.ts"))};
import { Vault } from ${JSON.stringify(path.join(repo, "electron/vault.ts"))};
import { Tripo } from ${JSON.stringify(path.join(repo, "engine/tripo.ts"))};
import { probeGraphicsConnections } from ${JSON.stringify(path.join(repo, "engine/graphics-connections.ts"))};
process.on('uncaughtException', () => app.exit(1));
process.on('unhandledRejection', () => app.exit(1));
dialog.showErrorBox = () => app.exit(1);
// safeStorage must use the owning Partsmith profile; another profile cannot decrypt its vault.
// No BrowserWindow/session or Store.open is created, and the live database is read into memory only.
app.setPath('userData', path.join(process.env.APPDATA!, 'partsmith'));
app.whenReady().then(async () => {
  const root = path.join(process.env.APPDATA!, 'partsmith');
  const SQL = await initSqlJs({locateFile:()=>${JSON.stringify(path.join(repo, "node_modules/sql.js/dist/sql-wasm.wasm"))}});
  const store = new Store(root);
  store.db = new SQL.Database(fs.readFileSync(path.join(root, 'workbench.db')));
  const settings = store.settings;
  const vault = new Vault(root);
  const connections = await probeGraphicsConnections(settings, new Tripo(()=>vault.get(),fetch,()=>settings.tripoRegion), vault.info().configured);
  store.db.close();
  const report={checkedAt:new Date().toISOString(),readOnly:true,credentialStorage:vault.info().storage,gptTurns:0,uploads:0,paidSubmissions:0,connections};
  fs.mkdirSync(path.dirname(${JSON.stringify(output)}),{recursive:true});fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));app.exit(0);
}).catch(()=>app.exit(1));
`;
await build({stdin:{contents:source,loader:"ts",resolveDir:repo},bundle:true,platform:"node",format:"cjs",external:["electron"],outfile:path.join(folder,"probe.cjs"),logLevel:"silent"});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electronBinary as unknown as string,[path.join(folder,"probe.cjs")],{cwd:repo,env,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});
child.stdout.on("data",data=>{for(const line of data.toString().split(/\r?\n/))if(line.startsWith('{"checkedAt"'))process.stdout.write(line+"\n");});
child.stderr.resume();
const exitCode=await new Promise<number>(resolve=>{child.on("error",()=>resolve(1));child.on("close",code=>resolve(code??1));});
if(exitCode)throw Error("Read-only connection check failed without starting production. No automatic retry.");
const actual=fs.realpathSync(folder),temp=fs.realpathSync(os.tmpdir());
if(path.dirname(actual)===temp&&path.basename(actual).startsWith("ps-graphics-connections-"))fs.rmSync(actual,{recursive:true,force:true,maxRetries:3});
