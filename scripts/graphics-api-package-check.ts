/** Inspect existing real API/Astra results in the packaged app twice. Never generates, adopts or submits. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { _electron as electron, type ElectronApplication } from "playwright";
import type { AppState } from "../shared/types";
import type { GraphicsWorkspace } from "../shared/graphics";
import { graphicsTripoReserved } from "../shared/graphics-catalog";

const repo = process.cwd(), version = JSON.parse(fs.readFileSync(path.join(repo,"package.json"),"utf8")).version;
const pilot = JSON.parse(fs.readFileSync(path.join(repo,"artifacts/runtime/graphics-api-live.json"),"utf8"));
const executablePath = path.join(repo,`release/${version}/win-unpacked/Partsmith.exe`);
const projectRoot = path.join(pilot.profile,"projects",pilot.projectId);
const baseline: GraphicsWorkspace = JSON.parse(fs.readFileSync(path.join(projectRoot,"graphics/workspace.json"),"utf8"));
assert(!baseline.tasks.some(t=>t.status==="running"));
assert.equal(graphicsTripoReserved(baseline),140);
assert.equal(baseline.tripoBudget?.limit,300);
const sha = (p:string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
for(const v of baseline.versions) for(const f of v.files) assert.equal(sha(path.join(projectRoot,f.path)),f.sha256);
const errors: string[] = [];
let app: ElectronApplication | undefined;
let backendBefore: unknown;
try {
  for(let run=0;run<2;run++) {
    const env = {...process.env, PARTSMITH_DATA:pilot.profile, PARTSMITH_DEV:""}; delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({executablePath,env,timeout:30000});
    assert.equal(await app.evaluate(({app})=>app.getVersion()),version);
    const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on("pageerror",e=>errors.push(e.message));
    await page.locator(`[data-project-id="${pilot.projectId}"]`).getByTestId("project-open").click();
    await page.getByTestId("graphics-studio").waitFor();
    await page.getByTestId(`graphics-object-${pilot.objectId}`).click();
    for(const operation of ["T03",pilot.stages["X04-fixed"]?"X04-fixed":"M05"]){
      const id=pilot.stages[operation].versionIds[0];
      await page.getByTestId(`graphics-version-${id}`).click();
      const preview=page.getByTestId("graphics-preview");await preview.scrollIntoViewIfNeeded();
      await preview.locator("canvas").waitFor({state:"visible"});await page.waitForTimeout(3000);
      await preview.getByTitle("시점 초기화",{exact:true}).click();
      await page.waitForTimeout(300);
      if(run===0)await page.screenshot({path:path.join(repo,`artifacts/runtime/graphics-api-package-${operation}.png`)});
    }
    const state=await page.evaluate(()=>window.desktop.call<AppState>({type:"state"}));
    assert.deepEqual(state.graphicsWorkspaces?.find(w=>w.projectId===pilot.projectId),baseline);
    const backend=state.projects.find(p=>p.id===pilot.projectId)!.jobs;
    if(run===0) backendBefore=structuredClone(backend);else assert.deepEqual(backend,backendBefore);
    assert.equal(backend.length,3);
    assert(backend.every(j=>j.status==="success"&&j.remoteId));
    assert.equal(backend.reduce((n,j)=>n+(j.credits??0),0),140);
    await app.close();app=undefined;
  }
  for(const v of baseline.versions)for(const f of v.files)assert.equal(sha(path.join(projectRoot,f.path)),f.sha256);
  assert.deepEqual(errors,[]);
  const result={passed:true,version,executablePath,projectId:pilot.projectId,actualPackagedApp:true,restarts:2,versions:baseline.versions.length,sourceAndResultHashesPreserved:true,acceptedVersionsPreserved:true,paidJobs:3,paidCredits:140,budget:300,extraPaidSubmissions:0,extraGptCalls:0,errors,checkedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(repo,"artifacts/runtime/graphics-api-package-check.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await app?.close();}
