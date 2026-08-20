import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import { CommanderBridge } from "./bridge/CommanderBridge.js";
import { loadConfig } from "./config.js";
import { Logger } from "./log.js";
import { HttpWsServer } from "./server/HttpWsServer.js";

const moduleRoot = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(moduleRoot, "../../.env"), quiet: true });

const packageRoot = resolve(moduleRoot, "..");
const mediaRoot = resolve(packageRoot, "media");
const config = loadConfig();
const logger = new Logger(config.logLevel);
const bridge = new CommanderBridge(config, mediaRoot, logger);
const server = new HttpWsServer(config, mediaRoot, bridge, logger);

let pairing: ReturnType<CommanderBridge["getPairingSnapshot"]>;
let startupError: unknown;
try {
  pairing = await bridge.start();
} catch (error) {
  startupError = error;
  logger.error("Bridge startup failed; management page will remain available", error instanceof Error ? error.stack : String(error));
  pairing = bridge.getPairingSnapshot();
}

try {
  await server.listen();
  logger.info("CodeX Commander bridge ready", {
    listen: `http://${config.host}:${config.port}`,
    websocket: `ws://${config.host}:${config.port}/v1/visor`,
    cwd: config.cwd,
    voiceMode: config.voice.mode,
    appServerMode: config.appServer.mode,
    pairingCode: pairing.pairedDeviceId ? "already paired" : pairing.code,
    pairingExpiresAt: pairing.expiresAt || undefined,
    voiceStartupError: startupError instanceof Error ? startupError.message : undefined,
  });
} catch (error) {
  logger.error("Bridge HTTP startup failed", error instanceof Error ? error.stack : String(error));
  await server.close().catch(() => undefined);
  await bridge.stop().catch(() => undefined);
  process.exitCode = 1;
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Stopping bridge", { signal });
  await server.close().catch((error) => logger.warn("HTTP shutdown failed", String(error)));
  await bridge.stop().catch((error) => logger.warn("Bridge shutdown failed", String(error)));
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGHUP", () => {
  void bridge.resetPairing()
    .then((pairing) => logger.info("Pairing reset", { pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt }))
    .catch((error) => logger.error("Pairing reset failed", error instanceof Error ? error.message : String(error)));
});
