/** Real app buttons, isolated original chest copy, no network or production changes. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import binary from "electron";
import type { AppState } from "../shared/types";
import type { GraphicsWorkspace } from "../shared/graphics";
const fixture = JSON.parse(
  fs.readFileSync(
    process.env.PARTSMITH_PLANAR_FIXTURE ??
      "artifacts/runtime/graphics-planar-fixture.json",
    "utf8",
  ),
);
// Reuse the isolated fixture while keeping each verification's evidence separate.
const evidencePrefix =
  process.env.PARTSMITH_PLANAR_EVIDENCE ?? "graphics-planar";
assert(/^[a-z0-9-]+$/.test(evidencePrefix));
const evidence = path.resolve(`artifacts/runtime/${evidencePrefix}-app.json`);
const capture = (name: string) =>
  `artifacts/runtime/${evidencePrefix}-${name}.png`;
const packageVersion = JSON.parse(
  fs.readFileSync("package.json", "utf8"),
).version;
const mode = process.argv[2] ?? "inspect";
const packaged = process.argv.includes("--packaged");
assert(
  [
    "inspect",
    "inspect-again",
    "repair",
    "accept",
    "restart",
    "review",
    "delivery",
    "delivery-result",
    "cancel-delivery",
    "layout",
  ].includes(mode),
);
const report: any = fs.existsSync(evidence)
  ? JSON.parse(fs.readFileSync(evidence, "utf8"))
  : { fixture, events: [], paidSubmissions: 0, productionGPT: 0 };
const save = () => fs.writeFileSync(evidence, JSON.stringify(report, null, 2));
const digest = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const originalFiles = fixture.sourceFiles.map((f: any) => ({
  ...f,
  absolute: path.join(fixture.profile, "projects", fixture.projectId, f.path),
}));
for (const f of originalFiles) assert.equal(digest(f.absolute), f.sha256);
const bootstrap = path.join(fixture.root, "app-bootstrap.cjs");
fs.writeFileSync(
  bootstrap,
  `const {app,dialog,session}=require('electron');app.setAppPath(${JSON.stringify(process.cwd())});process.chdir(${JSON.stringify(process.cwd())});global.fetch=async()=>{throw Error('Network forbidden in planar verification')};dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};app.on('browser-window-created',(_,win)=>{win.hide();win.webContents.setBackgroundThrottling(false);win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:/^https?:/.test(d.url)}))});require(${JSON.stringify(path.resolve("dist-electron/main.cjs"))});`,
);
let app: ElectronApplication | undefined, page: Page;
const errors: string[] = [];
const state = () =>
  page.evaluate(() => window.desktop.call<AppState>({ type: "state" }));
const workspace = async () => {
  const w = (await state()).graphicsWorkspaces?.find(
    (w) => w.projectId === fixture.projectId,
  );
  assert(w);
  return w;
};
const waitState = async (
  predicate: (w: GraphicsWorkspace) => boolean,
  ms = 180000,
) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const w = await workspace();
    if (predicate(w)) return w;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error(
    "Local app result timed out " + JSON.stringify((await workspace()).tasks),
  );
};
async function open() {
  const env = {
    ...process.env,
    PARTSMITH_DATA: fixture.profile,
    PARTSMITH_DEV: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: packaged
      ? path.resolve(`release/${packageVersion}/win-unpacked/Partsmith.exe`)
      : (binary as unknown as string),
    args: packaged ? [] : [bootstrap],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  if (packaged) {
    report.packaged = await app.evaluate(({ app, session }) => {
      globalThis.fetch = async () => {
        throw Error("Network forbidden in planar verification");
      };
      session.defaultSession.webRequest.onBeforeRequest((request, callback) =>
        callback({ cancel: /^https?:/.test(request.url) }),
      );
      return { version: app.getVersion(), packaged: app.isPackaged };
    });
    assert.deepEqual(report.packaged, {
      version: packageVersion,
      packaged: true,
    });
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("button", { name: "새 프로젝트", exact: true })
    .waitFor();
  assert.equal(
    path.resolve((await state()).dataDir),
    path.resolve(fixture.profile),
  );
  const fixtureObject = (await workspace()).objects[0];
  if (fixtureObject.creation?.subject === "container") {
    // Correct the original verification seed's invalid subject ID, only in this isolated profile.
    await page.evaluate(
      async ({ projectId, objectId, creation }) => {
        await window.desktop.call({
          type: "graphics.action",
          id: projectId,
          action: {
            kind: "update-object",
            objectId,
            patch: { creation: { ...creation, subject: "box" } },
          },
        });
        localStorage.removeItem(
          `partsmith.guided-workspace.v1:${projectId}:${objectId}`,
        );
      },
      {
        projectId: fixture.projectId,
        objectId: fixture.objectId,
        creation: fixtureObject.creation,
      },
    );
    report.fixtureSubjectCorrected = true;
    save();
  }
  await page
    .locator(`[data-project-id="${fixture.projectId}"]`)
    .getByTestId("project-open")
    .click();
  await page.getByTestId("graphics-studio").waitFor();
  await page.getByTestId("graphics-object-" + fixture.objectId).click();
  if (mode === "cancel-delivery" || mode === "delivery-result") {
    await page
      .getByRole("navigation", { name: "제작 단계", exact: true })
      .getByRole("button", { name: /Unity 전달/ })
      .click();
    return;
  }
  await page
    .getByRole("navigation", { name: "제작 단계", exact: true })
    .getByRole("button", { name: "2 모델", exact: true })
    .click();
  // Select the exact immutable source; inspection must not adopt it again.
  const history = page.locator(".gs-version-history");
  if (
    (await history.count()) &&
    !(await history.evaluate((e) => e.hasAttribute("open")))
  )
    await history.locator("summary").click();
  await page.getByTestId("graphics-version-" + fixture.sourceVersionId).click();
  await page.getByRole("button", { name: "수정하기", exact: true }).click();
  await page.getByRole("button", { name: "빠진 면 검사", exact: true }).click();
  await page.getByTestId("graphics-planar-review").waitFor();
  if(report.candidate && ["accept","review","restart","layout","delivery"].includes(mode)){
    const saved=page.locator('.gs-planar-history');
    if(await saved.count()){
      if(!(await saved.evaluate(el=>el.hasAttribute('open'))))await saved.locator('summary').click();
      await saved.getByRole('button',{name:new RegExp(report.candidate.id.slice(0,8)+' 비교$')}).click();
    }
  }
}
try {
  await open();
  const before = await workspace(),
    panel = page.getByTestId("graphics-planar-review");
  const priorFiles = [
    ...new Map(
      before.versions
        .flatMap((version) => version.files)
        .map((file) => [
          file.path,
          {
            ...file,
            absolute: path.join(
              fixture.profile,
              "projects",
              fixture.projectId,
              file.path,
            ),
          },
        ]),
    ).values(),
  ];
  for (const file of priorFiles)
    assert.equal(digest(file.absolute), file.sha256);
  if (mode === "inspect" || mode === "inspect-again") {
    if (mode === "inspect-again")
      await panel
        .getByRole("button", { name: "이 원본 다시 검사", exact: true })
        .click();
    else if (!before.planarInspections?.[fixture.sourceVersionId]) {
      await panel
        .getByRole("button", { name: "이 원본의 빠진 면 검사", exact: true })
        .click();
    }
    const inspected = await waitState(
      (w) =>
        (!!w.planarInspections?.[fixture.sourceVersionId] &&
          (mode !== "inspect-again" ||
            w.planarInspections[fixture.sourceVersionId].reportFile?.sha256 !==
              before.planarInspections?.[fixture.sourceVersionId]?.reportFile
                ?.sha256)) ||
        w.tasks.some(
          (t) =>
            t.taskId === "LOCAL_PLANAR_INSPECT" &&
            t.status === "failed" &&
            !before.tasks.some((old) => old.id === t.id),
        ),
    );
    assert(
      inspected.planarInspections?.[fixture.sourceVersionId],
      JSON.stringify(inspected.tasks),
    );
    report.inspection = inspected.planarInspections![fixture.sourceVersionId];
    await panel.locator("fieldset").first().waitFor();
    // A saved, explicit draft may remain when the same immutable boundaries are re-inspected.
    await page.waitForTimeout(500);
    assert.deepEqual(inspected.objects[0].accepted, before.objects[0].accepted);
    await panel.screenshot({
      path: capture("inspection"),
    });
  }
  if (mode === "repair") {
    const inspection = before.planarInspections![fixture.sourceVersionId];
    assert(inspection);
    const mesh = inspection.meshes[0];
    assert(mesh);
    // Explicit test choice: one eligible boundary; all others remain open.
    const vertices = process.env.PARTSMITH_PLANAR_VERTICES?.split(",")
      .map(Number)
      .sort((a, b) => a - b);
    const requested = Number(process.argv[3] ?? 2),
      chosen = mesh.boundaries.find((b) =>
        vertices
          ? JSON.stringify([...b.vertexIndices].sort((a, b) => a - b)) ===
            JSON.stringify(vertices)
          : b.number === requested,
      );
    assert(chosen?.status === "eligible");
    for (const b of mesh.boundaries) {
      const field = panel.locator("fieldset").filter({
        has: page
          .locator("legend")
          .filter({ hasText: new RegExp("영역 " + b.number + " ·") }),
      });
      await field
        .getByRole("radio", {
          name: b.id === chosen.id ? "막을 부분" : "원래 열린 부분·유지",
          exact: true,
        })
        .check();
    }
    await panel
      .getByRole("button", {
        name: "영역 " + chosen.number + " 확대",
        exact: true,
      })
      .click();
    await panel.screenshot({
      path: capture("selected"),
    });
    await panel
      .getByRole("button", { name: "선택한 부분 복구", exact: true })
      .click();
    const finished = await waitState((w) =>
      w.tasks.some(
        (t) =>
          t.taskId === "LOCAL_PLANAR_REPAIR" &&
          t.status !== "running" &&
          !before.tasks.some((old) => old.id === t.id),
      ),
    );
    const task = finished.tasks
      .filter((t) => t.taskId === "LOCAL_PLANAR_REPAIR")
      .at(-1)!;
    report.repairTask = task;
    save();
    assert.equal(task.status, "review", task.message);
    const candidate = finished.versions.find(
      (v) => v.id === task.outputVersionIds[0],
    )!;
    assert(candidate?.planarRepair);
    report.candidate = candidate;
    assert.deepEqual(finished.objects[0].accepted, before.objects[0].accepted);
    assert.equal(finished.versions.length, before.versions.length + 1);
    const compare = panel.getByTestId("graphics-head-comparison-canvas");
    await compare.waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="graphics-head-comparison-canvas"]')
          ?.getAttribute("data-ready") === "true",
    );
    await panel
      .getByRole("button", {
        name: `복구 영역 ${chosen.number} 확대`,
        exact: true,
      })
      .click();
    await page.waitForTimeout(250);
    await panel.screenshot({
      path: capture("comparison"),
    });
  }
  if (mode === "accept") {
    assert(report.candidate);
    await panel
      .getByRole("button", { name: "이 복구본 사용", exact: true })
      .click();
    const adopted = await waitState(
      (w) => w.objects[0].accepted["model:main"] === report.candidate.id,
    );
    report.acceptedVersionId = report.candidate.id;
    report.acceptanceInIsolatedFixtureOnly = true;
    assert.equal(
      adopted.tasks.length,
      before.tasks.length,
      "Adoption cannot start a generation",
    );
  }
  if (mode === "review") {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const comparison = panel.getByTestId("graphics-head-comparison");
    await comparison.waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="graphics-head-comparison-canvas"]')
          ?.getAttribute("data-ready") === "true",
    );
    const selected = report.inspection.meshes
      .flatMap((mesh: any) => mesh.boundaries)
      .find((b: any) =>
        report.candidate.planarRepair.selectedBoundaryIds.includes(b.id),
      );
    assert(selected);
    await comparison
      .getByRole("button", {
        name: `복구 영역 ${selected.number} 확대`,
        exact: true,
      })
      .click();
    await page.waitForTimeout(350);
    await comparison.screenshot({ path: capture("review-face") });
    for (const name of ["+Z 방향", "−X 방향", "사선"]) {
      await comparison.getByRole("button", { name, exact: true }).click();
      await page.waitForTimeout(350);
      await comparison.screenshot({
        path: capture(
          "review-" +
            { "+Z 방향": "z", "−X 방향": "minus-x", 사선: "oblique" }[name],
        ),
      });
    }
    await panel
      .getByRole("button", { name: "이 복구본 사용", exact: true })
      .waitFor();
    assert(
      await panel
        .getByRole("button", { name: "이 복구본 사용", exact: true })
        .isEnabled(),
    );
  }
  if (mode === "restart") {
    report.restart = {
      unchangedCandidate: before.versions.some(
        (v) => v.id === report.candidate?.id,
      ),
      accepted: before.objects[0].accepted["model:main"],
      noRunning: before.tasks.every((t) => t.status !== "running"),
    };
    assert(report.restart.noRunning);
  }
  if (mode === "delivery") {
    await panel.getByRole("button", { name: "닫기", exact: true }).click();
    await page
      .getByRole("navigation", { name: "제작 단계", exact: true })
      .getByRole("button", { name: /Unity 전달/ })
      .click();
    if (!(await workspace()).target) {
      const diagnostics = page.locator(".gs-diagnostics-disclosure");
      await diagnostics.locator("summary").first().click();
      await diagnostics
        .getByRole("button", { name: "프로젝트 검사", exact: true })
        .click();
      const connected = await waitState((w) => !!w.target, 10000);
      assert.equal(
        path.resolve(connected.target!.projectPath),
        path.resolve(fixture.unity),
      );
      await diagnostics.locator("summary").first().click();
    }
    await page.waitForTimeout(300);
    const primary = page.getByTestId("graphics-guide-primary");
    report.deliveryPrimary = await primary.innerText();
    report.deliveryDraft = await page.evaluate(
      ({ projectId, objectId }) =>
        localStorage.getItem(
          `partsmith.guided-workspace.v1:${projectId}:${objectId}`,
        ),
      fixture,
    );
    save();
    await page.screenshot({
      path: capture("delivery-before"),
    });
    const retry = page.getByTestId("graphics-prepare");
    if (
      before.tasks.some((t) => t.taskId === "X05") &&
      (await retry.isVisible())
    )
      await retry.click();
    else {
      assert.notEqual(
        await primary.innerText(),
        "Unity에서 확인",
        "A completed delivery must expose explicit redelivery preparation",
      );
      await primary.click();
    }
    await page.waitForTimeout(300);
    await page.screenshot({
      path: capture("delivery-after"),
    });
    const staged = await waitState(
      (w) =>
        w.tasks.some(
          (t) =>
            t.taskId === "X05" &&
            t.status !== "running" &&
            !before.tasks.some((old) => old.id === t.id),
        ),
      30000,
    );
    const task = staged.tasks.filter((t) => t.taskId === "X05").at(-1);
    assert(task);
    assert.equal(task.status, "awaiting_approval", task.message);
    await page.getByTestId("graphics-guide-primary").click();
    const queued = await waitState((w) => {
      const current = w.tasks.find((t) => t.id === task.id);
      return (
        !!current?.deliveryId &&
        w.deliveries.some((d) => d.id === current.deliveryId)
      );
    }, 60000);
    report.deliveryTask = queued.tasks.find((t) => t.id === task.id);
    report.delivery = queued.deliveries.find(
      (d) => d.id === report.deliveryTask.deliveryId,
    );
    save();
    const ready = await waitState((w) =>
      w.tasks.some(
        (t) =>
          t.id === task.id &&
          t.status !== "running" &&
          t.status !== "awaiting_approval",
      ),
    );
    const done = ready.tasks.find((t) => t.id === task.id)!;
    assert.equal(done.status, "review", done.message);
    report.delivery = ready.deliveries.find((d) => d.id === done.deliveryId);
    assert(report.delivery);
    report.deliveryTask = done;
  }
  if (mode === "cancel-delivery") {
    const task = before.tasks
      .filter((t) => t.taskId === "X05" && t.status === "running")
      .at(-1);
    if (task) {
      await page
        .getByTestId(`graphics-current-task-${task.id}`)
        .getByRole("button", { name: "추적 중지", exact: true })
        .click();
      await waitState(
        (w) => w.tasks.find((t) => t.id === task.id)?.status === "cancelled",
        10000,
      );
      report.cancelledVerificationDelivery = task.deliveryId;
    }
  }
  if (mode === "delivery-result") {
    const finished = await waitState(
      (w) =>
        w.deliveries.some(
          (d) => d.id === report.delivery?.id && d.status === "imported",
        ),
      30000,
    );
    report.delivery = finished.deliveries.find(
      (d) => d.id === report.delivery.id,
    );
    report.deliveryTask = finished.tasks.find(
      (t) => t.deliveryId === report.delivery.id,
    );
    assert.equal(report.deliveryTask.status, "review");
  }
  if (mode === "layout") {
    report.layout = [];
    for (const width of [1920, 1280, 960, 800])
      for (const zoom of [1, 1.25, 1.5]) {
        await page.setViewportSize({ width, height: 900 });
        await app!.evaluate(
          ({ BrowserWindow }, factor) =>
            BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor),
          zoom,
        );
        await page.waitForTimeout(250);
        const metrics = await panel.evaluate((el) => ({
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          width: el.clientWidth,
          scrollWidth: el.scrollWidth,
          documentOverflow:
            document.documentElement.scrollWidth > innerWidth + 1,
          buttons: [...el.querySelectorAll("button")]
            .filter((b) =>
              [
                "닫기",
                "이 원본 다시 검사",
                "선택한 부분 복구",
                "이 복구본 사용",
                "사용 중인 복구본",
              ].includes(b.textContent?.trim() ?? ""),
            )
            .map((b) => {
              const r = b.getBoundingClientRect();
              return {
                text: b.textContent,
                x: r.x,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
              };
            }),
        }));
        assert(!metrics.documentOverflow, JSON.stringify(metrics));
        assert(
          metrics.scrollWidth <= metrics.width + 1,
          JSON.stringify(metrics),
        );
        for (const button of metrics.buttons)
          assert(
            button.x >= -1 && button.right <= metrics.viewportWidth + 1,
            JSON.stringify(button),
          );
        const adoption = metrics.buttons.find((b) =>
          b.text?.includes("복구본"),
        );
        if (adoption)
          assert(
            adoption.top >= 0 && adoption.bottom <= metrics.viewportHeight + 1,
            JSON.stringify(adoption),
          );
        report.layout.push({ width, zoom, metrics });
        await page.screenshot({
          path: capture(`layout-${width}-${zoom}`),
        });
      }
  }
  for (const f of originalFiles) assert.equal(digest(f.absolute), f.sha256);
  const final = await workspace();
  for (const version of before.versions)
    assert.deepEqual(
      final.versions.find((v) => v.id === version.id),
      version,
      "Existing candidate changed",
    );
  for (const file of priorFiles)
    assert.equal(
      digest(file.absolute),
      file.sha256,
      "Existing candidate file changed",
    );
  if (!["cancel-delivery", "delivery-result"].includes(mode))
    for (const task of before.tasks)
      assert.deepEqual(
        final.tasks.find((t) => t.id === task.id),
        task,
        "Previous task history changed",
      );
  assert.equal(
    (await state()).projects.find((p) => p.id === fixture.projectId)!.jobs
      .length,
    0,
  );
  assert(
    final.tasks.every((t) => !t.paidApproval && t.backendJobIds.length === 0),
  );
  assert.deepEqual(errors, []);
  report.events.push({
    mode,
    packaged,
    at: new Date().toISOString(),
    taskCount: final.tasks.length,
    versionCount: final.versions.length,
    originalFilesPreserved: true,
    priorVersionFilesPreserved: priorFiles.length,
    errors: [],
  });
  if (report.failure) {
    (report.priorFailures ??= []).push(report.failure);
    delete report.failure;
  }
  save();
  console.log(
    JSON.stringify({
      mode,
      passed: true,
      candidate: report.candidate?.id,
      taskCount: final.tasks.length,
    }),
  );
} catch (e) {
  report.failure = {
    mode,
    message: String(e),
    errors,
    at: new Date().toISOString(),
  };
  save();
  throw e;
} finally {
  await app?.close();
}
