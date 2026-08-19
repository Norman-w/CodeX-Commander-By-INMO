import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..");

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1).optional(),
  COMMANDER_HOST: z.string().min(1).default("127.0.0.1"),
  COMMANDER_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  COMMANDER_VOICE: z.enum(["auto", "codex", "codex-realtime", "openai", "turn"]).default("codex-realtime"),
  COMMANDER_APP_SERVER_MODE: z.enum(["gui_shared", "stdio"]).default("gui_shared"),
  COMMANDER_APP_SERVER_SOCKET: z.string().default(""),
  COMMANDER_CWD: z.string().min(1).default(repoRoot),
  COMMANDER_ORIGIN_ALLOWLIST: z.string().default(""),
  COMMANDER_PAIRING_FILE: z.string().min(1).default(resolve(packageRoot, "data/pairing.json")),
  COMMANDER_REALTIME_MODEL: z.string().min(1).default("gpt-realtime-2.1-mini"),
  COMMANDER_REALTIME_VOICE: z.string().min(1).default("marin"),
  COMMANDER_REALTIME_IDLE_MS: z.coerce.number().int().min(10_000).max(600_000).default(60_000),
  COMMANDER_CODEX_BIN: z.string().min(1).default("codex"),
  COMMANDER_THREAD_ID: z.string().uuid().or(z.literal("")).default(""),
  COMMANDER_CONTEXT_BINDING_ID: z.string().uuid().or(z.literal("")).default(""),
  COMMANDER_AUTO_SELECT_LATEST: z.enum(["true", "false"]).default("true"),
  COMMANDER_CODEX_MODEL: z.string().default(""),
  COMMANDER_APPROVAL_POLICY: z.enum(["untrusted", "on-request", "never"]).default("on-request"),
  COMMANDER_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  COMMANDER_NETWORK_ACCESS: z.enum(["true", "false"]).default("false"),
  COMMANDER_MEDIA_ROOTS: z.string().default(""),
  COMMANDER_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});

export type BridgeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.parse(env);
  const cwd = resolve(parsed.COMMANDER_CWD);
  if (!existsSync(cwd)) throw new Error(`COMMANDER_CWD does not exist: ${cwd}`);

  const explicitRoots = parsed.COMMANDER_MEDIA_ROOTS.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));

  return {
    host: parsed.COMMANDER_HOST,
    port: parsed.COMMANDER_PORT,
    cwd: realpathSync(cwd),
    originAllowlist: new Set(parsed.COMMANDER_ORIGIN_ALLOWLIST.split(",").map((entry) => entry.trim()).filter(Boolean)),
    pairingFile: resolve(parsed.COMMANDER_PAIRING_FILE),
    voice: {
      mode: parsed.COMMANDER_VOICE === "openai" ? "openai" as const : "codex-realtime" as const
    },
    appServer: {
      mode: parsed.COMMANDER_APP_SERVER_MODE,
      socketPath: parsed.COMMANDER_APP_SERVER_SOCKET || undefined
    },
    realtime: {
      apiKey: usableApiKey(parsed.OPENAI_API_KEY),
      model: parsed.COMMANDER_REALTIME_MODEL,
      voice: parsed.COMMANDER_REALTIME_VOICE,
      idleMs: parsed.COMMANDER_REALTIME_IDLE_MS
    },
    codex: {
      bin: parsed.COMMANDER_CODEX_BIN,
      threadId: parsed.COMMANDER_THREAD_ID || undefined,
      contextBindingId: parsed.COMMANDER_CONTEXT_BINDING_ID || undefined,
      autoSelectLatest: parsed.COMMANDER_AUTO_SELECT_LATEST === "true",
      model: parsed.COMMANDER_CODEX_MODEL || undefined,
      approvalPolicy: parsed.COMMANDER_APPROVAL_POLICY,
      sandbox: parsed.COMMANDER_SANDBOX,
      networkAccess: parsed.COMMANDER_NETWORK_ACCESS === "true"
    },
    mediaRoots: [realpathSync(cwd), ...explicitRoots.filter(existsSync).map((entry) => realpathSync(entry))],
    logLevel: parsed.COMMANDER_LOG_LEVEL
  } as const;
}

function usableApiKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized === "your_openai_api_key" || normalized === "sk-your-key-here") return undefined;
  return normalized;
}
