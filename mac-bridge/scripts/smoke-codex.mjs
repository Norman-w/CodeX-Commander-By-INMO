import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: resolve(packageRoot, "../.env"), quiet: true });

const [{ loadConfig }, { Logger }, { CodexController }] = await Promise.all([
  import("../dist/config.js"),
  import("../dist/log.js"),
  import("../dist/codex/CodexController.js"),
]);

const config = loadConfig();
const controller = new CodexController(config, new Logger("error"));
try {
  await controller.start();
  const tasks = await controller.listThreads();
  process.stdout.write(`${JSON.stringify({ ok: true, taskCount: tasks.length, commanderTaskReady: Boolean(controller.getSelectedThreadId()) })}\n`);
} finally {
  await controller.stop();
}
