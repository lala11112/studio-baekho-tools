import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { browserToolPolicy } from "../electron/worker-tool-policy";
import { codexArguments, type WorkerTask } from "../engine/codex-worker";

// One authenticated CLI inference against a local, read-only MCP fixture.
// No live website, generation, paid request, user project or credential access.
const workspace = fs.mkdtempSync(
  path.join(os.tmpdir(), "partsmith-permissions-"),
);
const token = randomBytes(32).toString("hex");
const proof = randomBytes(10).toString("hex");
const names = ["studio_status", "studio_downloads"];
const calls: string[] = [];
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  res.setHeader("Content-Type", "application/json");
  if (body.method === "tools/list") {
    res.end(
      JSON.stringify({
        tools: names.map((name) => ({
          name,
          description:
            "Read the isolated local fixture's status. No website or remote action.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        })),
      }),
    );
  } else if (body.method === "tools/call" && names.includes(body.name)) {
    calls.push(body.name);
    res.end(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              proof,
              status: "local-fixture-ready",
              submissions: 0,
            }),
          },
        ],
      }),
    );
  } else
    res.end(
      JSON.stringify({
        isError: true,
        content: [{ type: "text", text: "Unsupported fixture tool" }],
      }),
    );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const schemaPath = path.join(workspace, "schema.json");
const resultPath = path.join(workspace, "result.json");
fs.writeFileSync(
  schemaPath,
  JSON.stringify({
    type: "object",
    properties: { proof: { type: "string" } },
    required: ["proof"],
    additionalProperties: false,
  }),
);
const config = [
  "-c",
  `mcp_servers.partsmith_studio.command=${JSON.stringify(process.execPath)}`,
  "-c",
  `mcp_servers.partsmith_studio.args=${JSON.stringify([path.resolve("dist-electron/production-mcp.cjs")])}`,
  "-c",
  'mcp_servers.partsmith_studio.env_vars=["PARTSMITH_STUDIO_PORT","PARTSMITH_STUDIO_TOKEN"]',
  ...browserToolPolicy(
    "partsmith_studio",
    names.map((name) => ({ name })),
  ),
];
const args = codexArguments(
  {
    run: { workspace },
    stage: { kind: "model" },
    imagePaths: [],
    recoveryOnly: true,
    schemaPath,
    resultPath,
  } as unknown as WorkerTask,
  config,
);
const cli = path.join(
  process.env.LOCALAPPDATA!,
  "Programs/OpenAI/Codex/bin/codex.exe",
);
try {
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(cli, args, {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        PARTSMITH_STUDIO_PORT: String(address.port),
        PARTSMITH_STUDIO_TOKEN: token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("CLI permission smoke timed out"));
    }, 180000);
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.stdin.end(
      "Call the injected partsmith_studio studio_status and studio_downloads tools exactly once each. This is a read-only local fixture. Do not run shell, browse, generate anything, or change files. Return only JSON with the proof string returned by the tools. If blocked, return proof='blocked'.",
    );
  });
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf8")).proof, proof);
  assert.deepEqual(calls.toSorted(), names.toSorted());
  fs.writeFileSync(
    "artifacts/worker-permissions-smoke.json",
    JSON.stringify(
      {
        passed: true,
        authenticatedCli: true,
        localFixtureMcpCalls: calls,
        globalApprovalPolicy: "never",
        sandbox: "workspace-write",
        perToolGrant: "approve",
        remoteGenerationRequests: 0,
        paidRequests: 0,
        realStudioGenerationVerified: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Authenticated CLI: both local browser MCP tools executed under never/workspace-write. No generation or paid requests.",
  );
} finally {
  server.closeAllConnections();
  server.close();
}
