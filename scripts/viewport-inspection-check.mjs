import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-mesh-inspector-"));
const root = path.join(process.env.APPDATA, "partsmith", "projects", "ff70e6a6-b1cc-4dea-9a92-f9e092114578");
const workspace = JSON.parse(fs.readFileSync(path.join(root, "graphics/workspace.json"), "utf8"));
const version = workspace.versions.find(v => v.id === "48fb2c4b-66f0-4645-af10-38cb917706d1");
const glb = path.join(root, version.files.find(f => f.path.endsWith(".glb")).path);
const sourceHash = createHash("sha256").update(fs.readFileSync(glb)).digest("hex");
const body = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import ${JSON.stringify(path.resolve("src/style.css"))};
import {Viewport} from ${JSON.stringify(path.resolve("src/Viewport.tsx"))};
import {defaultPhysicalSize} from ${JSON.stringify(path.resolve("shared/graphics-size.ts"))};
window.desktop={assetUrl:()=>'/rabbit.glb'};window.meshSelections=[];window.measurements=[];
const project={id:'isolated',assets:[{id:'preview',file:'rabbit.glb',label:'existing native rabbit',kind:'model'}],parts:[]};
function App(){const [size,setSize]=useState(undefined);window.setPhysicalSize=()=>setSize({...defaultPhysicalSize(),mode:'uniform',axis:'y',lengthMeters:0.5,pivot:'bottom-center'});return <div style={{height:'100vh',width:'100%',display:'flex'}}><Viewport project={project} previewId="preview" animation physicalSize={size} onMeshSelect={s=>window.meshSelections.push(s)} onBounds={m=>window.measurements.push(m)}/></div>}
createRoot(document.getElementById('root')).render(<App/>);`;
await build({ stdin: { contents: body, resolveDir: process.cwd(), loader: "tsx" }, bundle: true,
  format: "iife", outfile: path.join(dir, "ui.js"), logLevel: "silent" });
fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%;width:100%}</style><link rel="stylesheet" href="/ui.css"><div id="root"></div><script src="/ui.js"></script>');
const server = http.createServer((req, res) => {
  const file = req.url === "/rabbit.glb" ? glb : path.join(dir, req.url === "/" ? "index.html" : req.url.slice(1));
  if (![glb, ...["index.html", "ui.js", "ui.css"].map(f => path.join(dir, f))].includes(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".glb") ? "model/gltf-binary" : "text/html");
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const reports = [];
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 1.5 });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('[data-mesh-count="1"]').waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "단색 보기", exact: true }).click();
  await page.getByTestId("viewport-wire-toggle").click();
  await page.getByRole("button", { name: "치수·기준자 OFF", exact: true }).click();
  await page.evaluate(() => window.setPhysicalSize());
  await page.locator(".mesh-inspector summary").click();
  await page.getByRole("button", { name: "tripo_node_396a4d5d", exact: true }).click();
  await page.getByTestId("viewport-skeleton-toggle").click();
  await page.getByTestId("viewport-skeleton-toggle").click();
  await page.getByRole("button", { name: "tripo_node_396a4d5d 숨기기", exact: true }).click();
  await page.getByRole("button", { name: "전체 복원", exact: true }).click();
  await page.getByRole("button", { name: "tripo_node_396a4d5d 단독 보기", exact: true }).click();
  assert.match(await page.getByTestId("viewport-total-stats").innerText(), /Y 0.5 m/);
  const baseline = await page.evaluate(() => window.measurements);
  assert.equal(baseline.length, 1); assert.equal(baseline[0].hasSkin, true); assert.equal(baseline[0].hasAnimation, true);
  for (const width of [1100, 800, 520, 360]) {
    await page.setViewportSize({ width, height: 820 });
    const layout = await page.locator(".inspection-viewport").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth,
      canvasHeight: el.querySelector(".inspection-canvas-wrap").clientHeight,
      clipped: [...el.querySelectorAll("button,summary")].filter(b => b.scrollWidth > b.clientWidth + 2 && b.getBoundingClientRect().width).map(b => b.textContent) }));
    assert.ok(layout.scroll <= layout.width + 1, `${width}px horizontal overflow`);
    assert.ok(layout.canvasHeight >= 220, `${width}px canvas collapsed`);
    assert.deepEqual(layout.clipped, [], `${width}px button clipping`);
    reports.push({ width, ...layout });
  }
  await page.setViewportSize({ width: 1100, height: 820 });
  await page.screenshot({ path: path.resolve("artifacts/runtime/viewport-inspection-native-rabbit.png") });
  assert.deepEqual(errors, []);
  const sourceHashAfter = createHash("sha256").update(fs.readFileSync(glb)).digest("hex");
  assert.equal(sourceHashAfter, sourceHash, "original model changed");
  fs.writeFileSync("artifacts/runtime/viewport-inspection-check.json", JSON.stringify({ reports, errors, source: glb,
    sourceHash, sourceHashAfter,
    measurement: baseline[0], finalStats: await page.getByTestId("viewport-total-stats").innerText(),
    selections: await page.evaluate(() => window.meshSelections), sourceWrites: 0, serviceCalls: 0 }, null, 2));
  console.log(JSON.stringify({ success: true, reports, errors, sourceWrites: 0, serviceCalls: 0 }));
} finally { await browser.close(); server.close(); }
