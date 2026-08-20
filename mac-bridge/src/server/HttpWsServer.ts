import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { ClientControlMessageSchema } from "@codex-commander/protocol";

import type { CommanderBridge } from "../bridge/CommanderBridge.js";
import type { BridgeConfig } from "../config.js";
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

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
