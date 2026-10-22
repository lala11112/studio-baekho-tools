// Read-only authentication diagnostic. Never prints or copies the stored key.
import { app } from "electron";
import path from "node:path";
import { Vault } from "../electron/vault";
import { Tripo } from "../engine/tripo";
app.setPath("userData", path.join(app.getPath("appData"), "partsmith"));
app.whenReady().then(async () => {
  try {
    const vault = new Vault(path.join(app.getPath("appData"), "partsmith"));
    if (!vault.info().configured) {
      console.log(
        JSON.stringify({ configured: false, storage: vault.info().storage }),
      );
      return;
    }
    const balance = await new Tripo(() => vault.get()).balance();
    console.log(
      JSON.stringify({
        configured: true,
        region: "international",
        authenticated: true,
        balance: balance.balance ?? null,
        frozen: balance.frozen ?? null,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        authenticated: false,
        error:
          error instanceof Error
            ? error.message
            : "Authentication check failed",
      }),
    );
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
