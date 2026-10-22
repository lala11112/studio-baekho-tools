import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { _electron as electron } from "playwright";
import binary from "electron";

test(
  "planar comparison locks original, preserves scale, starts with material and focuses both views",
  { timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-planar-compare-"));
    const positions = new Float32Array([
        -1, -1, 1, 1, -1, 1, 0, 1, 0, 0, -1, -1,
      ]),
      indices = new Uint16Array([0, 1, 2, 1, 3, 2, 3, 0, 2, 0, 3, 1]);
    const bytes = Buffer.concat([
      Buffer.from(positions.buffer),
      Buffer.from(indices.buffer),
    ]);
    const gltf = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      buffers: [
        {
          uri:
            "data:application/octet-stream;base64," + bytes.toString("base64"),
          byteLength: bytes.length,
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        {
          buffer: 0,
          byteOffset: positions.byteLength,
          byteLength: indices.byteLength,
        },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 4,
          type: "VEC3",
          min: [-1, -1, -1],
          max: [1, 1, 1],
        },
        { bufferView: 1, componentType: 5123, count: 12, type: "SCALAR" },
      ],
    };
    const url =
      "data:model/gltf+json;base64," +
      Buffer.from(JSON.stringify(gltf)).toString("base64");
    const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{PlanarComparison}from${JSON.stringify(path.resolve("src/PlanarComparison.tsx"))};window.desktop={assetUrl:()=>${JSON.stringify(url)}};const source={id:'source',label:'고정 원본',files:[{path:'source.glb'}]},candidate={id:'candidate',label:'복구 후보',files:[{path:'candidate.glb'}]};createRoot(document.getElementById('root')).render(<PlanarComparison projectId="fixture" baseline={source} candidate={candidate} choices={[source]} onBaseline={()=>{throw Error('Source changed')}} onClose={()=>{}} focusBoundaries={[{id:'patch',number:3,points:[[-.1,.2,.6],[.1,.2,.6],[.1,.4,.6],[-.1,.4,.6]]}]}/>);`;
    await build({
      stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() },
      bundle: true,
      format: "iife",
      outfile: path.join(root, "ui.js"),
      jsx: "automatic",
      logLevel: "silent",
    });
    fs.writeFileSync(
      path.join(root, "index.html"),
      '<html><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"><body><div id="root"></div><script src="ui.js"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(root, "main.cjs"),
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, "profile"))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadFile(${JSON.stringify(path.join(root, "index.html"))}));`,
    );
    const app = await electron.launch({
      executablePath: binary as unknown as string,
      args: [path.join(root, "main.cjs")],
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      await page
        .locator(
          '[data-testid="graphics-head-comparison-canvas"][data-ready="true"]',
        )
        .waitFor();
      assert.equal(
        await page.getByLabel("모델 비교 기준 버전").isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "원본 재질", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      const canvas = page.locator("canvas");
      const before = await canvas.screenshot();
      await page
        .getByRole("button", { name: "복구 영역 3 확대", exact: true })
        .click();
      const after = await canvas.screenshot();
      assert.notDeepEqual(after, before);
      await page
        .getByRole("button", { name: "전체 보기", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "전체 보기", exact: true })
          .isEnabled(),
        true,
      );
      assert.match(
        await page.getByTestId("head-comparison-status-source").innerText(),
        /×1.*원래 크기 유지/,
      );
      assert.match(
        await page.getByTestId("head-comparison-status-candidate").innerText(),
        /×1.*원래 크기 유지/,
      );
      assert.equal(await canvas.count(), 1);
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
    }
  },
);
