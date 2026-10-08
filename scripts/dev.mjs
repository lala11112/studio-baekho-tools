import { spawn } from "node:child_process";
import electron from "electron";
await import("./build.mjs");
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  stdio: "inherit",
});
for (let i = 0; i < 40; i++) {
  try {
    await fetch("http://127.0.0.1:5173");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}
const app = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, PARTSMITH_DEV: "1" },
});
app.on("exit", () => {
  vite.kill();
  process.exit();
});
