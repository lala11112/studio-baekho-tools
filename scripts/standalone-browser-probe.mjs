import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// One real, read-only Codex turn. No inherited desktop chat identity, service
// submission, credential copying, global config change or model override.
const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), "partsmith-browser-probe-"),
);
const schemaPath = path.join(workspace, "schema.json");
const resultPath = path.join(workspace, "result.json");
await fs.writeFile(
  schemaPath,
  JSON.stringify({
    type: "object",
    properties: {
      chromeAvailable: { type: "boolean" },
      reason: { type: "string" },
      browsers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            family: { type: "string" },
          },
          required: ["id", "name", "family"],
          additionalProperties: false,
        },
      },
    },
    required: ["chromeAvailable", "reason", "browsers"],
    additionalProperties: false,
  }),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(key.startsWith("CODEX_") && key !== "CODEX_HOME") &&
      !/^(BROWSER_USE_|CUA_|OPENAI_API_KEY$|CODEX_API_KEY$)/.test(key),
  ),
);
const exe = path.join(
  process.env.LOCALAPPDATA,
  "Programs/OpenAI/Codex/bin/codex.exe",
);
const child = spawn(
  exe,
  [
    "exec",
    "--ephemeral",
    "--json",
    "--sandbox",
    "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    "mcp_servers.blender.enabled=false",
    "-c",
    "mcp_servers.fal_ai.enabled=false",
    "-c",
    "mcp_servers.notion.enabled=false",
    "--skip-git-repo-check",
    "--cd",
    workspace,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    resultPath,
    "-",
  ],
  { env, windowsHide: true, shell: false, stdio: "pipe" },
);
let buffer = "",
  usage,
  tools = [];
child.stdout.on("data", (data) => {
  buffer += data;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines)
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed") usage = event.usage;
      if (
        event.type === "item.completed" &&
        event.item?.type === "mcp_tool_call"
      ) {
        tools.push({
          server: event.item.server,
          tool: event.item.tool,
          status: event.item.status,
        });
        console.log(JSON.stringify(tools.at(-1)));
      }
      if (event.type === "error")
        console.log(JSON.stringify({ error: event.message?.slice(0, 300) }));
    } catch {}
});
child.stderr.on("data", () => {});
const timer = setTimeout(() => child.kill(), 180000);
child.stdin.end(
  "This is a Partsmith product integration smoke test, not an asset task. Make exactly one read-only browser inventory call through the installed cua_repl tool: await cua.getState(); . Follow its first-invocation documentation. Do not open or select tabs, navigate, read pages, click, log in, generate, run shell commands, or change files/settings. Do not inspect code or seek alternative browser transports. If the tool is unavailable or denied, stop immediately and report the reason. Return only the requested JSON with browser ids/names/families and whether a Chrome browser was actually listed. Do not include any tabs, URLs, personal information or guessed availability.",
);
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
clearTimeout(timer);
let result;
try {
  result = JSON.parse(await fs.readFile(resultPath, "utf8"));
} catch {
  result = {
    chromeAvailable: false,
    reason: "Probe did not finish with a valid result",
    browsers: [],
  };
}
const report = {
  at: new Date().toISOString(),
  exitCode: code,
  inheritedDesktopIdentity: false,
  paidRequests: 0,
  tools,
  usage,
  result,
};
await fs.mkdir("artifacts/runtime", { recursive: true });
await fs.writeFile(
  "artifacts/runtime/standalone-browser-probe.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
