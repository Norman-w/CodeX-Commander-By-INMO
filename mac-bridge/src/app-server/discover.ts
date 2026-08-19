//#region 导入/依赖
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
//#endregion

//#region 常量/配置
const execFileAsync = promisify(execFile);

export const DEFAULT_APP_SERVER_SOCKET = join(homedir(), ".codex/app-server-control/app-server-control.sock");

export const CHATGPT_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
//#endregion

//#region 模型/类型
export type AppServerAttachReport = {
  codexBin: string;
  bundledCodexExists: boolean;
  chatgptRunning: boolean;
  controlSocketPath: string | null;
  controlSocketExists: boolean;
  daemonVersion: unknown | null;
  daemonError: string | null;
  remoteControlHint: string;
  recommendedMode: "proxy" | "stdio";
  attachReady: boolean;
  notes: string[];
};

export type AppServerLaunchConfig =
  | { mode: "stdio"; codexBin: string; args: readonly string[] }
  | { mode: "proxy"; codexBin: string; socketPath: string; args: readonly string[] }
  | { mode: "raw"; codexBin: string; args: readonly string[] };
//#endregion

//#region 公开 API
export function resolveCodexBin(configured: string): string {
  if (configured !== "codex" && existsSync(configured)) return configured;
  if (existsSync(CHATGPT_CODEX_BIN)) return CHATGPT_CODEX_BIN;
  return configured;
}

export function defaultControlSocket(configured?: string): string {
  const trimmed = configured?.trim();
  return trimmed ? resolve(trimmed) : DEFAULT_APP_SERVER_SOCKET;
}

export async function probeAppServerAttach(options: {
  codexBin: string;
  socketPath?: string;
}): Promise<AppServerAttachReport> {
  const codexBin = resolveCodexBin(options.codexBin);
  const controlSocketPath = defaultControlSocket(options.socketPath);
  const notes: string[] = [];
  const bundledCodexExists = existsSync(CHATGPT_CODEX_BIN);
  const controlSocketExists = existsSync(controlSocketPath);
  let chatgptRunning = false;
  let daemonVersion: unknown | null = null;
  let daemonError: string | null = null;

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-x", "ChatGPT"]);
      chatgptRunning = stdout.trim().length > 0;
    } catch {
      chatgptRunning = false;
    }
  }

  if (chatgptRunning) notes.push("ChatGPT.app 正在运行");
  else notes.push("ChatGPT.app 未运行；gui_shared 模式需要打开 ChatGPT 或启用 app-server daemon");

  if (controlSocketExists) notes.push(`发现 control socket：${controlSocketPath}`);
  else notes.push(`未发现 control socket：${controlSocketPath}`);

  if (existsSync(codexBin)) {
    try {
      const { stdout } = await execFileAsync(codexBin, ["app-server", "daemon", "version"], {
        timeout: 8_000,
        maxBuffer: 1024 * 1024
      });
      daemonVersion = JSON.parse(stdout.trim());
    } catch (error) {
      daemonError = error instanceof Error ? error.message : String(error);
    }
  } else {
    daemonError = `Codex 二进制不存在：${codexBin}`;
  }

  const attachReady = controlSocketExists;
  const recommendedMode = attachReady ? "proxy" : "stdio";

  return {
    codexBin,
    bundledCodexExists,
    chatgptRunning,
    controlSocketPath: controlSocketExists ? controlSocketPath : null,
    controlSocketExists,
    daemonVersion,
    daemonError,
    remoteControlHint: "可尝试：codex app-server daemon start && codex app-server daemon enable-remote-control",
    recommendedMode,
    attachReady,
    notes
  };
}

export async function resolveAppServerLaunch(config: {
  codexBin: string;
  mode: "gui_shared" | "stdio";
  socketPath?: string;
}): Promise<AppServerLaunchConfig> {
  const codexBin = resolveCodexBin(config.codexBin);
  if (config.mode === "stdio") {
    return { mode: "stdio", codexBin, args: ["app-server", "--stdio"] };
  }

  const report = await probeAppServerAttach({ codexBin, socketPath: config.socketPath });
  if (!report.attachReady || !report.controlSocketPath) {
    throw new Error(
      "无法附着到 ChatGPT 的 app-server：请先打开 ChatGPT.app，或运行 "
      + "`codex app-server daemon start` 后再试。"
      + (report.daemonError ? ` (${report.daemonError})` : "")
    );
  }

  return {
    mode: "proxy",
    codexBin,
    socketPath: report.controlSocketPath,
    args: ["app-server", "proxy", "--sock", report.controlSocketPath]
  };
}
//#endregion
