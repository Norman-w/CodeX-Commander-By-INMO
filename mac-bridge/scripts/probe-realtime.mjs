import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: resolve(packageRoot, "../.env"), quiet: true });

const [{ loadConfig }, { Logger }, { CodexController }] = await Promise.all([
  import("../dist/config.js"),
  import("../dist/log.js"),
  import("../dist/codex/CodexController.js")
]);

const config = loadConfig({ ...process.env, COMMANDER_APP_SERVER_MODE: "stdio" });
const controller = new CodexController(config, new Logger("error"));
try {
  await controller.start();
  const threadId = await controller.ensureSelectedThread();
  await controller.requestJsonRpc("thread/realtime/start", {
    threadId,
    outputModality: "audio",
    transport: { type: "websocket" },
    version: "v3"
  }, 45_000);
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "stdio", threadId })}\n`);
  await controller.requestJsonRpc("thread/realtime/stop", { threadId }).catch(() => undefined);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, mode: "stdio", error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
} finally {
  await controller.stop();
}
