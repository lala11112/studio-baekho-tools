import { app } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { StudioBrowser } from "../electron/studio-browser";
import { STUDIO_TOOLS } from "../electron/studio-policy";

// Build/run with:
// npm run build
// npx esbuild scripts/studio-browser-smoke.ts --bundle --platform=node --format=cjs --external:electron --outfile=artifacts/runtime/studio-browser-smoke.cjs
// npx electron artifacts/runtime/studio-browser-smoke.cjs
// Set PARTSMITH_EXE to test the packaged executable/asar as the real stdio MCP child.
// The host browser remains this offline development fixture, not live Studio.
// Uses only a local HTTP fixture. No Studio account, key, generation or charge.
async function main() {
  const root = process.cwd(),
    workspace = path.join(
      root,
      "artifacts/runtime/studio-browser-smoke",
      randomUUID(),
    );
  const packagedMcp = Boolean(process.env.PARTSMITH_EXE);
  const mcpExecutable = packagedMcp
    ? path.resolve(process.env.PARTSMITH_EXE!)
    : process.execPath;
  const mcpEntry = packagedMcp
    ? path.join(
        path.dirname(mcpExecutable),
        "resources/app.asar/dist-electron/production-mcp.cjs",
      )
    : path.join(root, "dist-electron/production-mcp.cjs");
  const report = path.join(
    root,
    packagedMcp
      ? "artifacts/studio-browser-smoke-packaged.json"
      : "artifacts/studio-browser-smoke.json",
  );
  fs.mkdirSync(workspace, { recursive: true });
  app.setPath("userData", path.join(workspace, "user-data"));
  process.env.PARTSMITH_STUDIO_TEST = "1";
  const html = `<!doctype html><html><body><nav><a href="#smart">Smart Mesh</a></nav><h1>Local Studio adapter fixture</h1><label>Prompt<textarea aria-label="Model prompt"></textarea></label><select aria-label="Topology"><option value="tri">Triangle</option><option value="quad">Quad</option></select><input type="file" style="display:none" onchange="document.querySelector('#upload').textContent='Uploaded '+this.files[0].name"><p id="upload">No upload</p><button onclick="document.querySelector('#result').textContent='Task fixture-body-001 completed successfully';this.disabled=true">Generate100</button><button>Generate 250</button><button>Subscribe</button><a href="/model.glb" download="fixture.glb">Download model</a><a href="/edit">Mesh editor</a><a href="/login">Account</a><p id="result">Ready for local test</p></body></html>`;
  const editHtml = `<!doctype html><html><body><h1>Edit Mesh</h1><p id="quota">3 free edits remaining</p><div style="position:relative;width:320px;height:220px"><canvas aria-label="Mesh selection canvas" width="320" height="220" style="background:#abd;display:block" onmousedown="this.dataset.down='yes'" onmousemove="if(this.dataset.down==='yes')document.querySelector('#drag').textContent='Canvas selection drag observed'" onmouseup="this.dataset.down='no'"></canvas><div id="cover" style="display:none;position:absolute;inset:0;background:#888">Covered</div></div><p id="drag">No canvas drag yet</p><button onclick="document.querySelector('#result').textContent='Mesh edit fixture completed successfully';document.querySelector('#quota').textContent='2 free edits remaining'">Retry Selection</button><button>Regenerate ⚡ 50</button><button>Generate 100</button><button onclick="document.querySelector('#quota').textContent='0 free edits remaining'">Show exhausted quota</button><button onclick="document.querySelector('#quota').textContent='No quota available'">Hide quota</button><button onclick="document.querySelector('#quota').textContent='3 free edits remaining'">Restore quota</button><button onclick="document.querySelector('#cover').style.display='block'">Cover canvas</button><button onclick="document.querySelector('#cover').style.display='none'">Uncover canvas</button><button onclick="setTimeout(()=>document.querySelector('canvas').remove(),1500)">Detach canvas soon</button><p id="result">Ready</p><a href="/login">Account</a></body></html>`;
  const model = Buffer.alloc(20);
  model.write("glTF");
  model.writeUInt32LE(2, 4);
  model.writeUInt32LE(20, 8);
  model.writeUInt32LE(0, 12);
  model.write("JSON", 16);
  const server = http.createServer((req, res) => {
    if (req.url === "/model.glb") {
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="fixture.glb"',
      );
      res.end(model);
    } else if (req.url === "/edit") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(editHtml);
    } else if (req.url === "/login")
      res.end(
        '<html><body><h1>Account</h1><button>Sign up/Log in</button><input type="password"></body></html>',
      );
    else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Fixture server unavailable");
  await app.whenReady();
  const browser = new StudioBrowser({
    fixtureUrl: `http://127.0.0.1:${address.port}/`,
  });
  const context = {
    runId: randomUUID(),
    stageId: "body.generate",
    rootDir: workspace,
    creditLimit: 200,
    maxAttempts: 2,
    attempt: 1,
  };
  type View = {
    snapshotId: string;
    text: string;
    screenshot?: string;
    requiresInput: boolean;
    controls: { index: number; label: string; type: string; tag: string }[];
  };
  const text = (response: any) => JSON.parse(response.content[0].text);
  const snapshot = async (): Promise<View> =>
    text(await browser.callTool("studio_snapshot"));
  const observed = (view: View, label: string) => {
    const el = view.controls.find((c) => c.label === label);
    assert(el, `Missing ${label}`);
    return { snapshotId: view.snapshotId, element: el.index };
  };
  const checks: string[] = [];
  let bridge: Awaited<ReturnType<StudioBrowser["startBridge"]>> | undefined;
  try {
    browser.attachRun(context);
    assert.equal((await browser.open(true)).ready, true);
    let view = await snapshot();
    assert(
      view.screenshot && fs.existsSync(path.join(workspace, view.screenshot)),
    );
    const old = observed(view, "Model prompt");
    view = text(
      await browser.callTool("studio_fill", {
        ...old,
        text: "Stylized character",
      }),
    );
    await assert.rejects(
      browser.callTool("studio_fill", { ...old, text: "stale" }),
      /Stale/,
    );
    view = text(
      await browser.callTool("studio_select", {
        ...observed(view, "Topology"),
        value: "quad",
      }),
    );
    fs.writeFileSync(
      path.join(workspace, "front.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1cAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    let fileInput = view.controls.find((c) => c.type === "file")!;
    await assert.rejects(
      browser.callTool("studio_upload", {
        snapshotId: view.snapshotId,
        element: fileInput.index,
        file: "../outside.png",
      }),
      /escapes/,
    );
    view = text(
      await browser.callTool("studio_upload", {
        snapshotId: view.snapshotId,
        element: fileInput.index,
        file: "front.png",
      }),
    );
    assert(view.text.includes("Uploaded front.png"));
    checks.push(
      "Observed controls, editable prompts, native select, stale IDs and workspace-only file upload",
    );
    await assert.rejects(
      browser.callTool("studio_click", observed(view, "Subscribe")),
      /user input/,
    );
    await assert.rejects(
      browser.callTool("studio_click", observed(view, "Generate100")),
      /charged/,
    );
    await assert.rejects(
      browser.callTool("studio_submit", {
        ...observed(view, "Generate100"),
        operationId: "body:1",
        expectedCredits: 50,
      }),
      /credit price/,
    );
    view = text(
      await browser.callTool("studio_submit", {
        ...observed(view, "Generate100"),
        operationId: "body:1",
        expectedCredits: 100,
      }),
    );
    if (!view.text.includes("Task fixture-body-001 completed successfully"))
      view = text(await browser.callTool("studio_wait", { milliseconds: 300 }));
    assert(view.text.includes("Task fixture-body-001 completed successfully"));
    await browser.callTool("studio_observe_submission", {
      snapshotId: view.snapshotId,
      operationId: "body:1",
      evidenceText: "Task fixture-body-001 completed successfully",
    });
    await assert.rejects(
      browser.callTool("studio_submit", {
        ...observed(view, "Generate 250"),
        operationId: "duplicate:1",
        expectedCredits: 250,
      }),
      /already submitted/,
    );
    checks.push(
      "Normal click cannot charge; displayed-cost match and durable single-attempt reservation enforced",
    );
    view = text(
      await browser.callTool("studio_click", observed(view, "Download model")),
    );
    let downloads: any[] = [];
    for (let i = 0; i < 20; i++) {
      downloads = text(await browser.callTool("studio_downloads"));
      if (downloads[0]?.state === "completed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(downloads[0]?.state, "completed");
    assert.equal(downloads[0].bytes, model.length);
    assert(downloads[0].sha256);
    assert(fs.existsSync(path.join(workspace, downloads[0].file)));
    const receipt = browser.stageReceipt(context.runId, context.stageId, 1);
    assert.equal(receipt.charges[0].cost, 100);
    assert.equal(receipt.downloads[0].sha256, downloads[0].sha256);
    fs.writeFileSync(path.join(workspace, "studio-downloads.json"), "[]");
    assert.equal(
      browser.stageReceipt(context.runId, context.stageId, 1).downloads.length,
      1,
    );
    checks.push(
      "Native Electron download persisted with run/stage lineage and SHA256",
    );
    browser.attachRun({ ...context, stageId: "head.generate" });
    view = await snapshot();
    await assert.rejects(
      browser.callTool("studio_submit", {
        ...observed(view, "Generate 250"),
        operationId: "head:1",
        expectedCredits: 250,
      }),
      /credit limit/,
    );
    bridge = await browser.startBridge();
    const rejected = await fetch(`http://127.0.0.1:${bridge.port}/tools`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(rejected.status, 403);
    const accepted = await fetch(`http://127.0.0.1:${bridge.port}/tools`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ method: "tools/list" }),
    });
    assert.equal((await accepted.json()).tools.length, STUDIO_TOOLS.length);
    const child = spawn(mcpExecutable, [mcpEntry], {
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PARTSMITH_STUDIO_PORT: String(bridge.port),
        PARTSMITH_STUDIO_TOKEN: bridge.token,
      },
      stdio: "pipe",
    });
    const messages: any[] = [];
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      let split;
      while ((split = pending.indexOf("\n")) >= 0) {
        messages.push(JSON.parse(pending.slice(0, split)));
        pending = pending.slice(split + 1);
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
    );
    for (let i = 0; i < 60 && messages.length < 2; i++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      messages.find((m) => m.id === 1)?.result.serverInfo.name,
      "partsmith-studio",
    );
    assert.equal(
      messages.find((m) => m.id === 2)?.result.tools.length,
      STUDIO_TOOLS.length,
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "studio_status", arguments: {} },
      }) + "\n",
    );
    for (let i = 0; i < 60 && !messages.some((m) => m.id === 3); i++)
      await new Promise((r) => setTimeout(r, 50));
    child.kill();
    const childStatus = text(messages.find((m) => m.id === 3)?.result);
    assert.equal(childStatus.ready, true);
    assert.equal(childStatus.budget.reserved, 100);
    checks.push(
      "Authenticated loopback and real child stdio MCP initialize/tools-list/tools-call round trip",
    );
    await bridge.close();
    bridge = undefined;
    view = await snapshot();
    view = text(
      await browser.callTool("studio_click", observed(view, "Mesh editor")),
    );
    if (!view.text.includes("Edit Mesh"))
      view = text(await browser.callTool("studio_wait", { milliseconds: 300 }));
    const canvas = (v: View) => {
      const node = v.controls.find((c) => c.tag === "canvas");
      assert(node, "Observed canvas required");
      return { snapshotId: v.snapshotId, element: node.index };
    };
    const points = [
      { x: 0.2, y: 0.2 },
      { x: 0.45, y: 0.5 },
      { x: 0.7, y: 0.7 },
    ];
    await assert.rejects(
      browser.callTool("studio_canvas_drag", { ...canvas(view), points }),
      /context required/,
    );
    const editContext = {
      ...context,
      runId: randomUUID(),
      stageId: "model",
      creditLimit: 0,
      modelEdit: { scope: "part" as const, target: "back hair volume" },
    };
    browser.attachRun(editContext);
    view = await snapshot();
    await assert.rejects(
      browser.callTool("studio_canvas_drag", {
        ...observed(view, "Retry Selection"),
        points,
      }),
      /Observed canvas/,
    );
    await assert.rejects(
      browser.callTool("studio_canvas_drag", {
        ...canvas(view),
        points: [
          { x: -1, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
      /0–1/,
    );
    const oldCanvas = canvas(view);
    view = text(
      await browser.callTool("studio_canvas_drag", { ...oldCanvas, points }),
    );
    assert(view.text.includes("Canvas selection drag observed"));
    await assert.rejects(
      browser.callTool("studio_canvas_drag", { ...oldCanvas, points }),
      /Stale/,
    );
    view = text(
      await browser.callTool("studio_click", observed(view, "Cover canvas")),
    );
    await assert.rejects(
      browser.callTool("studio_canvas_drag", { ...canvas(view), points }),
      /covered/,
    );
    view = text(
      await browser.callTool("studio_click", observed(view, "Uncover canvas")),
    );
    checks.push(
      "Mesh-edit canvas drags use real bounded Electron mouse events; missing context, non-canvas, stale, covered and invalid normalized targets are blocked",
    );
    await assert.rejects(
      browser.callTool("studio_submit", {
        ...observed(view, "Generate 100"),
        operationId: "forbidden-generate",
        expectedCredits: 100,
      }),
      /new Generate/,
    );
    await assert.rejects(
      browser.callTool("studio_mesh_edit_submit", {
        ...observed(view, "Generate 100"),
        operationId: "forbidden-generate",
        expectedCredits: 0,
        evidenceText: "3 free edits remaining",
      }),
      /new Generate/,
    );
    await assert.rejects(
      browser.callTool("studio_click", observed(view, "Retry Selection")),
      /charged/,
    );
    view = text(
      await browser.callTool(
        "studio_click",
        observed(view, "Show exhausted quota"),
      ),
    );
    await assert.rejects(
      browser.callTool("studio_mesh_edit_submit", {
        ...observed(view, "Retry Selection"),
        operationId: "free-edit",
        expectedCredits: 0,
        evidenceText: "0 free edits remaining",
      }),
      /exhausted/,
    );
    await assert.rejects(
      browser.callTool("studio_mesh_edit_submit", {
        ...observed(view, "Regenerate ⚡ 50"),
        operationId: "paid-edit",
        expectedCredits: 50,
        evidenceText: "Regenerate ⚡ 50",
      }),
      /credit limit/,
    );
    view = text(
      await browser.callTool("studio_click", observed(view, "Hide quota")),
    );
    await assert.rejects(
      browser.callTool("studio_mesh_edit_submit", {
        ...observed(view, "Retry Selection"),
        operationId: "free-edit",
        expectedCredits: 0,
        evidenceText: "No quota available",
      }),
      /not visible/,
    );
    view = text(
      await browser.callTool("studio_click", observed(view, "Restore quota")),
    );
    browser.attachRun({ ...editContext, recoveryOnly: true });
    view = await snapshot();
    await assert.rejects(
      browser.callTool("studio_mesh_edit_submit", {
        ...observed(view, "Retry Selection"),
        operationId: "free-edit",
        expectedCredits: 0,
        evidenceText: "3 free edits remaining",
      }),
      /자동 복구/,
    );
    browser.attachRun(editContext);
    view = await snapshot();
    view = text(
      await browser.callTool("studio_mesh_edit_submit", {
        ...observed(view, "Retry Selection"),
        operationId: "free-edit",
        expectedCredits: 0,
        evidenceText: "3 free edits remaining",
      }),
    );
    if (!view.text.includes("Mesh edit fixture completed successfully"))
      view = text(await browser.callTool("studio_wait", { milliseconds: 100 }));
    assert(view.text.includes("Mesh edit fixture completed successfully"));
    const editReceipt = browser.stageReceipt(
      editContext.runId,
      editContext.stageId,
      1,
    );
    assert.equal(editReceipt.charges.length, 1);
    assert.equal(editReceipt.charges[0].cost, 0);
    await assert.rejects(
      browser.callTool("studio_mesh_edit_submit", {
        ...observed(view, "Retry Selection"),
        operationId: "free-edit-again",
        expectedCredits: 0,
        evidenceText: "2 free edits remaining",
      }),
      /already submitted/,
    );
    checks.push(
      "Mesh Edit enforces observed quota/price, blocks exhausted/missing quota and new Generate, journals free uses once, and refuses duplicate or recovery submissions",
    );
    view = text(
      await browser.callTool(
        "studio_click",
        observed(view, "Detach canvas soon"),
      ),
    );
    const detached = canvas(view);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await assert.rejects(
      browser.callTool("studio_canvas_drag", { ...detached, points }),
      /attached canvas/,
    );
    checks.push("Detached observed canvas is rejected before input events");
    view = await snapshot();
    view = text(
      await browser.callTool("studio_click", observed(view, "Account")),
    );
    if (!view.requiresInput)
      view = text(await browser.callTool("studio_wait", { milliseconds: 250 }));
    assert(view.requiresInput);
    await assert.rejects(
      browser.callTool("studio_click", {
        snapshotId: view.snapshotId,
        element: 0,
      }),
      /직접 로그인/,
    );
    checks.push(
      "Combined Sign up/Log in and password page halts worker for user input",
    );
    fs.writeFileSync(
      report,
      JSON.stringify(
        {
          passed: true,
          checks,
          workspace,
          actualStudio: false,
          packagedMcp,
          mcpExecutable,
          mcpEntry,
          browserHost: "offline development fixture",
          realPaidCalls: 0,
          fixtureCreditsReserved: 100,
        },
        null,
        2,
      ),
    );
    console.log(
      `Studio browser adapter smoke passed (${checks.length} checks; local fixture only).`,
    );
  } catch (error) {
    fs.writeFileSync(
      report,
      JSON.stringify(
        {
          passed: false,
          checks,
          workspace,
          error: String(error),
          actualStudio: false,
          packagedMcp,
          mcpExecutable,
          browserHost: "offline development fixture",
          realPaidCalls: 0,
        },
        null,
        2,
      ),
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (bridge) await bridge.close();
    await browser.close();
    server.close();
    app.exit(Number(process.exitCode ?? 0));
  }
}
main().catch((error) => {
  console.error(error);
  app.exit(1);
});
