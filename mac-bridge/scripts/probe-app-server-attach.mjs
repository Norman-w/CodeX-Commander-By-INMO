import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: resolve(packageRoot, "../.env"), quiet: true });

const [{ probeAppServerAttach, resolveCodexBin, defaultControlSocket }] = await Promise.all([
  import("../dist/app-server/discover.js")
]);

const codexBin = resolveCodexBin(process.env.COMMANDER_CODEX_BIN || "codex");
const report = await probeAppServerAttach({
  codexBin,
  socketPath: process.env.COMMANDER_APP_SERVER_SOCKET || defaultControlSocket()
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.attachReady || report.chatgptRunning ? 0 : 1;
