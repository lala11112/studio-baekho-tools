/** Child-process-only grants for the app-owned, budget-guarded browser bridges.
 * These names are not configurable by a worker or by page content. The host
 * still enforces the approved phase, authentication, paths and submission ledger.
 * Keep the global approval policy and filesystem sandbox unchanged.
 */
export function browserToolPolicy(
  server: "partsmith_studio" | "partsmith_chatgpt",
  tools: readonly { name: string }[],
): string[] {
  const prefix = server === "partsmith_studio" ? "studio_" : "chatgpt_";
  const names = tools.map((tool) => tool.name);
  if (
    !names.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !name.startsWith(prefix) || !/^[a-z_]+$/.test(name))
  )
    throw Error("Invalid app-owned browser tool allowlist");
  return [
    "-c",
    `mcp_servers.${server}.enabled=true`,
    "-c",
    `mcp_servers.${server}.enabled_tools=${JSON.stringify(names)}`,
    ...names.flatMap((name) => [
      "-c",
      `mcp_servers.${server}.tools.${name}.approval_mode="approve"`,
    ]),
  ];
}
