import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { ClientControlMessageSchema } from "@codex-commander/protocol";

import type { CommanderBridge } from "../bridge/CommanderBridge.js";
import type { BridgeConfig, LocalAudioOutput } from "../config.js";
import type { Logger } from "../log.js";

export class HttpWsServer {
  private readonly server: Server;
  private readonly websocket: WebSocketServer;

  constructor(
    private readonly config: BridgeConfig,
    private readonly mediaRoot: string,
    private readonly bridge: CommanderBridge,
    private readonly logger: Logger
  ) {
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch((error) => {
        this.logger.error("HTTP request failed", error instanceof Error ? error.message : String(error));
        if (!response.headersSent) json(response, 500, { error: "internal error" });
        else response.destroy();
      });
    });
    this.websocket = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
    this.server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/v1/visor" || !this.originAllowed(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.websocket.handleUpgrade(request, socket, head, (ws) => this.websocket.emit("connection", ws, request));
    });
    this.websocket.on("connection", (ws) => this.handleSocket(ws));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    for (const client of this.websocket.clients) client.close(1001, "server stopping");
    if (!this.server.listening) return;
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  private handleSocket(ws: WebSocket): void {
    const id = randomUUID();
    const helloTimer = setTimeout(() => ws.close(1008, "hello timeout"), 5_000);
    helloTimer.unref();
    let receivedHello = false;
    let controlQueue = Promise.resolve();
    this.bridge.attach({
      id,
      sendControl: (message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); },
      sendBinary: (frame) => { if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true }); },
      close: (code, reason) => ws.close(code, reason)
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        try { this.bridge.handleBinary(id, new Uint8Array(toBuffer(data))); }
        catch (error) { this.bridge.sendError(id, error); }
        return;
      }
      let raw: unknown;
      try { raw = JSON.parse(data.toString()); }
      catch { this.bridge.sendError(id, new Error("Control frame is not valid JSON")); return; }
      const parsed = ClientControlMessageSchema.safeParse(raw);
      if (!parsed.success) {
        this.bridge.sendError(id, new Error(parsed.error.issues.map((issue) => issue.message).join("; ")));
        return;
      }
      if (!receivedHello && parsed.data.type !== "hello") {
        this.bridge.sendError(id, new Error("First message must be hello"));
        return;
      }
      if (parsed.data.type === "hello") {
        receivedHello = true;
        clearTimeout(helloTimer);
      }
      controlQueue = controlQueue
        .then(() => this.bridge.handleControl(id, parsed.data))
        .catch((error) => this.bridge.sendError(id, error, parsed.data.requestId));
    });
    ws.once("close", () => {
      clearTimeout(helloTimer);
      this.bridge.detach(id);
    });
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/api/settings") {
      if (!isLocalRequest(request)) return json(response, 403, { error: "management page is local-only" });
      if (request.method === "GET" && url.pathname === "/") return html(response, MANAGEMENT_PAGE);
      if (request.method === "GET" && url.pathname === "/api/settings") {
        return json(response, 200, {
          localAudioOutput: this.bridge.getLocalAudioOutput(),
          default: "visor_only",
          options: ["visor_only", "mac_only", "mac_and_visor"]
        });
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        const payload = await readJson(request);
        const requested = isRecord(payload) ? payload.localAudioOutput : undefined;
        const output = typeof requested === "boolean"
          ? (requested ? "mac_and_visor" : "visor_only")
          : requested;
        if (!isLocalAudioOutput(output)) {
          return json(response, 400, { error: "localAudioOutput must be visor_only, mac_only, or mac_and_visor" });
        }
        this.bridge.setLocalAudioOutput(output);
        return json(response, 200, { ok: true, localAudioOutput: this.bridge.getLocalAudioOutput() });
      }
      return json(response, 405, { error: "method not allowed" });
    }
    if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/readyz") return json(response, this.bridge.isReady() ? 200 : 503, { ready: this.bridge.isReady() });
    if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      return void this.handleMedia(request, response, url.pathname);
    }
    json(response, 404, { error: "not found" });
  }

  private async handleMedia(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const authorization = request.headers.authorization;
    const deviceId = request.headers["x-device-id"];
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (typeof deviceId !== "string" || !token || !this.bridge.validateMediaToken(deviceId, token)) {
      return json(response, 401, { error: "unauthorized" });
    }
    const filename = basename(pathname);
    if (pathname !== `/media/${filename}`) return json(response, 404, { error: "not found" });
    if (!/^[a-f0-9]{24}\.webp$/.test(filename)) return json(response, 404, { error: "not found" });
    const file = resolve(this.mediaRoot, filename);
    if (!file.startsWith(`${resolve(this.mediaRoot)}/`) || !existsSync(file)) return json(response, 404, { error: "not found" });
    const metadata = await stat(file);
    response.writeHead(200, {
      "Content-Type": "image/webp",
      "Content-Length": metadata.size,
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff"
    });
    createReadStream(file).pipe(response);
  }

  private originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin || this.config.originAllowlist.size === 0) return true;
    return this.config.originAllowlist.has(origin);
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function html(response: ServerResponse, body: string): void {
  const payload = Buffer.from(body);
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": payload.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 32_768) throw new Error("request body too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const MANAGEMENT_PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CodeX Commander Bridge</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; background: #091116; color: #edf7fa; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 20% 10%, #173b48, #091116 55%); }
    main { width: min(620px, calc(100vw - 40px)); padding: 34px; border: 1px solid #28505b; border-radius: 24px; background: rgba(11, 28, 35, .92); box-shadow: 0 24px 80px rgba(0,0,0,.35); }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -.03em; }
    p { color: #a8c3ca; line-height: 1.6; }
    .card { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-top: 28px; padding: 22px; border-radius: 18px; background: #102832; }
    .label { font-size: 18px; font-weight: 700; }
    .hint { margin-top: 6px; color: #8caab2; font-size: 14px; }
    input { width: 48px; height: 28px; accent-color: #38d7ff; }
    #status { margin-top: 20px; color: #70e6b0; min-height: 24px; }
    code { color: #79def5; }
  </style>
</head>
<body>
  <main>
    <h1>CodeX Commander Bridge</h1>
    <p>macOS 本机管理页。选择服务器返回的原生音频播放到眼镜、Mac，或两者同时播放。</p>
    <section class="card">
      <div><div class="label">回复音频输出</div><div class="hint">仅电脑模式不会向眼镜发送下行音频</div></div>
      <select id="localAudio" aria-label="回复音频输出">
        <option value="visor_only">仅眼镜</option>
        <option value="mac_only">仅电脑</option>
        <option value="mac_and_visor">电脑 + 眼镜</option>
      </select>
    </section>
    <div id="status">正在读取 Bridge 状态…</div>
    <p class="hint">默认值：<code>visor_only</code>。管理页只允许从本机访问。</p>
  </main>
  <script>
    const control = document.querySelector('#localAudio');
    const status = document.querySelector('#status');
    const labels = { visor_only: '仅眼镜播放已开启', mac_only: '仅电脑播放已开启', mac_and_visor: '电脑 + 眼镜同时播放已开启' };
    const normalize = (value) => typeof value === 'boolean' ? (value ? 'mac_and_visor' : 'visor_only') : value;
    const updateStatus = (value) => { control.value = normalize(value); status.textContent = labels[control.value] || '音频输出模式未知'; };
    async function load() {
      const response = await fetch('/api/settings');
      const value = await response.json();
      updateStatus(value.localAudioOutput);
    }
    control.addEventListener('change', async () => {
      control.disabled = true;
      const response = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localAudioOutput: control.value }) });
      const value = await response.json();
      control.disabled = false;
      updateStatus(value.localAudioOutput);
    });
    load().catch(() => { status.textContent = '无法读取 Bridge 状态'; });
  </script>
</body>
</html>`;

function isLocalAudioOutput(value: unknown): value is LocalAudioOutput {
  return value === "visor_only" || value === "mac_only" || value === "mac_and_visor";
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
