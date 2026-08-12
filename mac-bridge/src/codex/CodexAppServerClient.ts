import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { Logger } from "../log.js";

type JsonRpcId = string | number;
type JsonObject = Record<string, unknown>;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export type CodexNotification = { method: string; params?: JsonObject };
export type CodexServerRequest = { id: JsonRpcId; method: string; params?: JsonObject };

export class CodexAppServerClient extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private stopping = false;

  constructor(
    private readonly codexBin: string,
    private readonly logger: Logger,
    private readonly appServerArgs: readonly string[] = ["app-server", "--stdio"]
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.process) return;
    this.stopping = false;
    const child = spawn(this.codexBin, [...this.appServerArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizedChildEnvironment(process.env)
    });
    this.process = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.logger.debug("codex stderr", chunk.trim()));
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      this.process = undefined;
      const error = new Error(`Codex App Server exited (code=${String(code)}, signal=${String(signal)})`);
      if (!this.stopping) this.logger.error(error.message);
      this.failAll(error);
      this.emit("exit", error);
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "codex_commander_inmo", title: "CodeX Commander By INMO", version: "0.1.0" },
      capabilities: null
    });
    this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.stopping = true;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 1_000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async request<T = unknown>(method: string, params?: JsonObject, timeoutMs = 30_000): Promise<T> {
    if (!this.process?.stdin.writable) throw new Error("Codex App Server is not running");
    const id = this.nextId++;
    const request = params === undefined ? { method, id } : { method, id, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: JsonObject): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(message: unknown): void {
    if (!this.process?.stdin.writable) throw new Error("Codex App Server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.logger.warn("Ignoring non-JSON Codex output", line);
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const id = message.id as JsonRpcId;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        const rpcError = message.error as { code?: number; message?: string };
        pending.reject(new Error(`Codex JSON-RPC ${String(rpcError.code)}: ${rpcError.message || "unknown error"}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string" && message.id !== undefined) {
      this.emit("request", message as CodexServerRequest);
      return;
    }
    if (typeof message.method === "string") {
      this.emit("notification", message as CodexNotification);
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function sanitizedChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const name of [
    "OPENAI_API_KEY",
    "COMMANDER_PAIRING_FILE",
    "COMMANDER_ORIGIN_ALLOWLIST",
    "COMMANDER_TAILSCALE_BIN"
  ]) delete result[name];
  for (const name of Object.keys(result)) {
    if (name.startsWith("COMMANDER_") && name !== "COMMANDER_CWD") delete result[name];
  }
  return result;
}
