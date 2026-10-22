import { test } from "node:test";
import assert from "node:assert/strict";
import { browserToolPolicy } from "../electron/worker-tool-policy";
import { STUDIO_TOOLS } from "../electron/studio-policy";
import { CHATGPT_TOOLS } from "../electron/chatgpt-policy";
import { codexArguments, type WorkerTask } from "../engine/codex-worker";

test("noninteractive child approves only app-owned browser tools while keeping sandbox and user integrations", () => {
  for (const [server, tools] of [
    ["partsmith_studio", STUDIO_TOOLS],
    ["partsmith_chatgpt", CHATGPT_TOOLS],
  ] as const) {
    const grants = browserToolPolicy(server, tools);
    for (const tool of tools)
      assert(
        grants.includes(
          `mcp_servers.${server}.tools.${tool.name}.approval_mode="approve"`,
        ),
      );
    assert(
      grants.includes(
        `mcp_servers.${server}.enabled_tools=${JSON.stringify(tools.map((t) => t.name))}`,
      ),
    );
    const args = codexArguments(
      {
        run: { workspace: "C:/isolated-job" },
        stage: { kind: "model" },
        imagePaths: [],
        schemaPath: "schema.json",
        resultPath: "result.json",
      } as unknown as WorkerTask,
      grants,
    );
    assert(args.includes('approval_policy="never"'));
    assert(args.includes("workspace-write"));
    for (const name of ["blender", "fal_ai", "notion"])
      assert(!args.some(arg => arg.startsWith(`mcp_servers.${name}.enabled=`)));
    assert(
      !grants.some((value) =>
        /sandbox|approval_policy|default_tools|apps\./.test(value),
      ),
    );
  }
});

test("browser bridge grants reject foreign names, duplicate tools and TOML injection", () => {
  for (const tools of [
    [],
    [{ name: "shell_exec" }],
    [{ name: "studio_status" }, { name: "studio_status" }],
    [{ name: "studio_status.x=1" }],
  ])
    assert.throws(
      () => browserToolPolicy("partsmith_studio", tools),
      /allowlist/,
    );
});
