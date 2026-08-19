import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import { AUDIO_SAMPLE_RATE } from "@codex-commander/protocol";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: resolve(packageRoot, "../.env"), quiet: true });

const [{ loadConfig }, { Logger }, { CodexController }, { probeAppServerAttach, resolveCodexBin, defaultControlSocket }] =
  await Promise.all([
    import("../dist/config.js"),
    import("../dist/log.js"),
    import("../dist/codex/CodexController.js"),
    import("../dist/app-server/discover.js")
  ]);

const attach = await probeAppServerAttach({
  codexBin: resolveCodexBin(process.env.COMMANDER_CODEX_BIN || "codex"),
  socketPath: process.env.COMMANDER_APP_SERVER_SOCKET || defaultControlSocket()
});

if (!attach.attachReady) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    mode: "gui_shared",
    attach,
    error: "GUI app-server control socket 不可用；请打开 ChatGPT.app 或运行 codex app-server daemon start"
  })}\n`);
  process.exitCode = 1;
  process.exit();
}

const config = loadConfig({ ...process.env, COMMANDER_APP_SERVER_MODE: "gui_shared" });
const controller = new CodexController(config, new Logger("error"));
const notifications = [];
let threadId = process.env.COMMANDER_THREAD_ID?.trim() || "";
let sawAudio = false;

try {
  await controller.start();
  if (!threadId) {
    const threads = await controller.listThreads();
    threadId = threads[0]?.id || await controller.ensureSelectedThread();
  } else {
    await controller.selectThread(threadId).catch(async () => {
      threadId = await controller.ensureSelectedThread();
    });
  }

  const off = controller.subscribeNotifications((notification) => {
    notifications.push(notification.method);
    if (notification.method === "thread/realtime/outputAudio/delta") sawAudio = true;
  });

  await controller.requestJsonRpc("thread/realtime/start", {
    threadId,
    outputModality: "audio",
    transport: { type: "websocket" },
    version: "v3"
  }, 45_000).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("does not support realtime conversation")) throw error;
    threadId = await controller.startVoiceThread();
    await controller.requestJsonRpc("thread/realtime/start", {
      threadId,
      outputModality: "audio",
      transport: { type: "websocket" },
      version: "v3"
    }, 45_000);
  });

  const pcm = Buffer.alloc(Math.floor(AUDIO_SAMPLE_RATE * 0.2 * 2), 0);
  await controller.requestJsonRpc("thread/realtime/appendAudio", {
    threadId,
    audio: {
      data: pcm.toString("base64"),
      sampleRate: AUDIO_SAMPLE_RATE,
      numChannels: 1,
      samplesPerChannel: pcm.byteLength / 2,
      itemId: crypto.randomUUID()
    }
  }, 8_000);

  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await controller.requestJsonRpc("thread/realtime/stop", { threadId }).catch(() => undefined);
  off();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "gui_shared",
    threadId,
    sawAudio,
    notifications: [...new Set(notifications)].filter((method) => method.startsWith("thread/realtime/"))
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    mode: "gui_shared",
    threadId,
    attach,
    error: error instanceof Error ? error.message : String(error),
    notifications: [...new Set(notifications)]
  })}\n`);
  process.exitCode = 1;
} finally {
  await controller.stop();
}
