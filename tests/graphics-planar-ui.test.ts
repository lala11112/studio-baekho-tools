import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { _electron as electron } from "playwright";
import binary from "electron";

test(
  "planar review requires explicit partition, preserves default, and stays local at responsive widths",
  { timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-planar-ui-"));
    const source = {
      id: "source-exact",
      objectId: "object",
      label: "원본 상자",
      role: "model",
      slot: "main",
      createdAt: "2026-10-15",
      files: [{ kind: "glb", path: "original.glb" }],
    };
    const report = {
      schemaVersion: 1,
      inspectionId: "inspection-frozen",
      sourceVersionId: source.id,
      sourceSha256: "a".repeat(64),
      reportFile: { path: "inspection.json", sha256: "current-report-hash" },
      meshes: [
        {
          meshId: "mesh-1",
          name: "상자 메시",
          boundaries: [
            {
              id: "hole",
              number: 1,
              vertexIndices: [0, 1, 2, 3],
              worldVertices: [
                [0, 1, 2],
                [1, 1, 2],
                [1, 2, 2],
                [0, 2, 2],
              ],
              status: "eligible",
              reasons: [],
              materialOptions: ["preserve", "reuse-existing-pattern"],
            },
            {
              id: "opening",
              number: 2,
              vertexIndices: [4, 5, 6],
              worldVertices: [
                [0, 0, 0],
                [1, 0, 0],
                [0, 1, 0],
              ],
              status: "blocked",
              reasons: ["원래 열린 부분인지 검토하세요"],
              materialOptions: [],
            },
          ],
        },
      ],
    };
    await build({
      stdin: {
        contents: `import${JSON.stringify(path.resolve("src/style.css"))};import React from 'react';import{createRoot}from'react-dom/client';import{GraphicsPlanarReview}from${JSON.stringify(path.resolve("src/GraphicsPlanarReview.tsx"))};import${JSON.stringify(path.resolve("src/graphics-studio.css"))};import${JSON.stringify(path.resolve("src/graphics-guide.css"))};window.calls=[];window.desktop={assetUrl:()=>''};const root=createRoot(document.getElementById('root'));let tasks=[],extraVersions=[],objects=[];window.injectObjects=value=>{objects=value;render()};window.injectVersions=value=>{extraVersions=value;render()};window.injectTasks=value=>{tasks=value;render()};function render(){root.render(<section className="graphics-studio gs-planar-open" style={{height:"100vh"}}><header className="gs-header" style={{height:160}}>Fixture project</header><aside className="gs-objects">Objects</aside><div className="gs-workspace"><div className="gs-command-area" style={{height:110}}><nav className="gs-creation-stages">{["이미지 사용 중","모델 결과 확인","재질","조립·수정","Unity 전달 사용 중"].map((label,index)=><button key={label}><span>{index+1}</span>{label}</button>)}</nav></div><main className="gs-main"><div className="gs-work-layout"><section className="gs-result"><GraphicsPlanarReview project={{id:'p',assets:[],parts:[]}} workspace={{objects,tasks,versions:[${JSON.stringify(source)},...extraVersions],planarInspections:{'source-exact':${JSON.stringify(report)}}}} source={${JSON.stringify(source)}} disabled={false} onAction={async action=>{window.calls.push(action)}} onClose={()=>window.closedReview=true} onAccept={()=>window.accepted=true}/></section><aside className="gs-guide">Competing guide</aside></div></main></div></section>);}render();`,
        loader: "tsx",
        resolveDir: process.cwd(),
      },
      plugins: [
        {
          name: "viewport-stub",
          setup(b) {
            b.onResolve({ filter: /\/(Viewport|PlanarComparison)$/ }, () => ({
              path: "stub",
              namespace: "fixture",
            }));
            b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents:
                'export function Viewport({boundaryOverlays,focusedBoundaryId}) { return <div data-testid="overlays" data-values={JSON.stringify(boundaryOverlays)} data-focus={focusedBoundaryId}/> } export function PlanarComparison(){return <div className="gs-head-comparison"><div className="head-comparison-canvas" style={{height:300}}/></div>}',
              loader: "tsx",
              resolveDir: process.cwd(),
            }));
          },
        },
      ],
      bundle: true,
      format: "iife",
      outfile: path.join(root, "ui.js"),
      jsx: "automatic",
      logLevel: "silent",
    });
    fs.writeFileSync(
      path.join(root, "index.html"),
      '<html lang="ko"><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(root, "main.cjs"),
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, "profile"))});app.whenReady().then(()=>{new BrowserWindow({show:false,width:960,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadFile(${JSON.stringify(path.join(root, "index.html"))});});`,
    );
    const app = await electron.launch({
      executablePath: binary as unknown as string,
      args: [path.join(root, "main.cjs")],
    });
    try {
      const page = await app.firstWindow();
      await page
        .getByRole("heading", { name: "빠진 면 검사", exact: true })
        .waitFor();
      assert.deepEqual(await page.evaluate(() => (window as any).calls), []);
      const repair = page.getByRole("button", {
        name: "선택한 부분 복구",
        exact: true,
      });
      assert.equal(await repair.isDisabled(), true);
      assert.equal(await page.locator("input:checked").count(), 0);
      assert.equal(
        await page.getByLabel("새 면의 재질").inputValue(),
        "preserve",
      );
      const hole = page.locator("fieldset").first();
      await hole.getByLabel("막을 부분", { exact: true }).check();
      assert.equal(await repair.isDisabled(), true);
      await page
        .locator("fieldset")
        .nth(1)
        .getByLabel("원래 열린 부분·유지", { exact: true })
        .check();
      assert.equal(await repair.isDisabled(), false);
      await page.reload();
      await page
        .getByRole("heading", { name: "빠진 면 검사", exact: true })
        .waitFor();
      assert.equal(await page.locator("input:checked").count(), 2);
      assert.deepEqual(await page.evaluate(() => (window as any).calls), []);
      await page.getByRole("button", { name: "영역 1 확대" }).click();
      assert.equal(
        await page.getByTestId("overlays").getAttribute("data-focus"),
        "hole",
      );
      const overlays = JSON.parse(
        (await page.getByTestId("overlays").getAttribute("data-values"))!,
      );
      assert.deepEqual(overlays[0].points[0], [0, 2, -1]);
      await repair.click();
      assert.deepEqual(await page.evaluate(() => (window as any).calls), [
        {
          kind: "repair-planar",
          versionId: "source-exact",
          inspectionId: "inspection-frozen",
          meshId: "mesh-1",
          selectedBoundaryIds: ["hole"],
          keptBoundaryIds: ["opening"],
          materialPolicy: "preserve",
        },
      ]);
      const failedTask = {
        id: "failed-repair",
        taskId: "LOCAL_PLANAR_REPAIR",
        status: "running",
        inputVersionIds: ["source-exact"],
        createdAt: new Date().toISOString(),
        message: "Traceback hidden detail: patch intersects existing surface",
        planarSelection: {
          versionId: "source-exact",
          inspectionId: "inspection-frozen",
          meshId: "mesh-1",
          selectedBoundaryIds: ["hole"],
          keptBoundaryIds: ["opening"],
          materialPolicy: "preserve",
        },
      };
      await page.evaluate(
        (task) => (window as any).injectTasks([task]),
        failedTask,
      );
      await page
        .getByText("선택한 부분 로컬 복구 중", { exact: false })
        .waitFor();
      await page.evaluate(
        (task) => (window as any).injectTasks([{ ...task, status: "failed" }]),
        failedTask,
      );
      await page
        .getByText(
          "새로 막을 면이 기존 표면이나 다른 복구 면과 겹쳐 복구를 멈췄습니다.",
          { exact: false },
        )
        .waitFor();
      assert.equal(
        await page
          .getByText("선택한 부분 로컬 복구 중", { exact: false })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByText("Traceback hidden detail:", { exact: false })
          .isVisible(),
        false,
      );
      assert.equal(await repair.isDisabled(), true);
      await page
        .getByLabel("새 면의 재질")
        .selectOption("reuse-existing-pattern");
      assert.equal(await repair.isDisabled(), false);
      await repair.click();
      assert.equal(
        (await page.evaluate(() => (window as any).calls)).at(-1)
          .materialPolicy,
        "reuse-existing-pattern",
      );
      await page
        .getByRole("button", { name: "이 원본 다시 검사", exact: true })
        .click();
      assert.deepEqual(
        (await page.evaluate(() => (window as any).calls)).at(-1),
        { kind: "inspect-planar", versionId: "source-exact" },
      );
      assert.equal(await page.locator("input:checked").count(), 2);
      const oldCandidate = {
        ...source,
        id: "old-candidate",
        planarRepair: {
          versionId: "source-exact",
          inspectionId: "inspection-frozen",
          meshId: "mesh-1",
          selectedBoundaryIds: ["hole"],
          keptBoundaryIds: ["opening"],
          materialPolicy: "reuse-existing-pattern",
          reportPath: "old-report.json",
        },
      };
      await page.evaluate(
        (version) => (window as any).injectVersions([version]),
        oldCandidate,
      );
      await page.evaluate(() =>
        (window as any).injectTasks([
          {
            id: "old-task",
            taskId: "LOCAL_PLANAR_REPAIR",
            status: "review",
            createdAt: new Date().toISOString(),
            inputVersionIds: ["source-exact"],
            outputVersionIds: ["old-candidate"],
            planarInspection: { reportFile: { sha256: "old-report-hash" } },
          },
        ]),
      );
      assert.equal(
        await page
          .getByRole("region", { name: "복구 결과 확인", exact: true })
          .count(),
        0,
      );
      assert.equal(await page.getByLabel("새 면의 재질").isVisible(), true);
      await page.evaluate(() => {
        window.fetch = async () =>
          new Response(
            JSON.stringify({
              warnings: [
                "Local candidate; inspect appearance before adoption.",
              ],
              checks: {
                staticOnly: true,
                appendOnly: true,
                oldVerticesPreserved: true,
                oldUVLayersPreserved: true,
                otherMeshesPreserved: true,
                materialsAndImagesPreserved: true,
                oldCustomAttributesPreserved: true,
                oldCustomNormalsPreserved: true,
                intersectionValidation: true,
                fbxRoundTrip: true,
                glbRoundTrip: true,
              },
            }),
          );
        (window as any).injectTasks([
          {
            id: "current-result-task",
            taskId: "LOCAL_PLANAR_REPAIR",
            status: "review",
            createdAt: new Date().toISOString(),
            inputVersionIds: ["source-exact"],
            outputVersionIds: ["old-candidate"],
            planarInspection: { reportFile: { sha256: "current-report-hash" } },
          },
        ]);
      });
      await page
        .getByRole("button", { name: "이 복구본 사용", exact: true })
        .waitFor();
      for (const width of [800, 960, 1280, 1920])
        for (const zoom of [1, 1.25, 1.5]) {
          await page.setViewportSize({ width, height: 900 });
          await app.evaluate(
            ({ BrowserWindow }, factor) =>
              BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(
                factor,
              ),
            zoom,
          );
          await page.waitForFunction(
            ({ width, zoom }) =>
              Math.abs(innerWidth - width / zoom) < 3 &&
              Math.abs(innerHeight - 900 / zoom) < 3,
            { width, zoom },
            { timeout: 10000 },
          );
          const viewportHeight = await page.evaluate(() => innerHeight);
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
          const adoption = await page
            .getByRole("button", { name: "이 복구본 사용", exact: true })
            .boundingBox();
          assert.ok(adoption);
          assert.ok(
            adoption.y >= 0 && adoption.y + adoption.height <= viewportHeight,
            JSON.stringify({ width, zoom, viewportHeight, adoption }),
          );
          const resultWidth = await page
            .locator(".gs-result")
            .evaluate((e) => e.getBoundingClientRect().width);
          const mainWidth = await page
            .locator(".gs-main")
            .evaluate((e) => e.getBoundingClientRect().width);
          assert.ok(resultWidth > mainWidth * 0.9);
          const stages = await page
            .locator(".gs-creation-stages button")
            .evaluateAll((buttons) =>
              buttons.map((button) => {
                const r = button.getBoundingClientRect();
                return { left: r.left, right: r.right };
              }),
            );
          assert.ok(
            stages.every(
              (stage, index) => !index || stage.left >= stages[index - 1].right,
            ),
            JSON.stringify({ width, zoom, stages }),
          );
          await page
            .locator(".head-comparison-canvas")
            .scrollIntoViewIfNeeded();
          const visiblePreview = await page
            .locator(".head-comparison-canvas")
            .boundingBox();
          assert.ok(visiblePreview);
          assert.ok(
            visiblePreview.y < viewportHeight - 90 &&
              visiblePreview.y + visiblePreview.height > 0,
          );
          const viewportAfterScroll = await page.evaluate(() => innerHeight);
          const footerAfterScroll = await page
            .getByRole("button", { name: "이 복구본 사용", exact: true })
            .boundingBox();
          assert.ok(
            footerAfterScroll &&
              footerAfterScroll.y >= 0 &&
              footerAfterScroll.y + footerAfterScroll.height <=
                viewportAfterScroll + 1,
            JSON.stringify({ width, zoom, viewportHeight, footerAfterScroll }),
          );
        }
      assert.equal(
        await page
          .getByText("Local candidate; inspect appearance before adoption.", {
            exact: true,
          })
          .isVisible(),
        false,
      );
      await page.evaluate(() =>
        (window as any).injectObjects([
          { id: "object", accepted: { "model:main": "old-candidate" } },
        ]),
      );
      assert.equal(
        await page
          .getByRole("button", { name: "사용 중인 복구본", exact: true })
          .isDisabled(),
        true,
      );
    } finally {
      await app.close();
    }
  },
);
