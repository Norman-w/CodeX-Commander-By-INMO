import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { ClientControlMessageSchema } from "@codex-commander/protocol";

import type { CommanderBridge } from "../bridge/CommanderBridge.js";
import type { AudioInputSource, BridgeConfig, LocalAudioOutput } from "../config.js";
import type { Logger } from "../log.js";

export class HttpWsServer {
  private readonly server: Server;
  private readonly websocket: WebSocketServer;
  private readonly managementWebsocket: WebSocketServer;

  constructor(
    private readonly config: BridgeConfig,
    private readonly mediaRoot: string,
    private readonly bridge: CommanderBridge,
    private readonly logger: Logger
  ) {
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("HTTP request failed", message);
        if (!response.headersSent) json(response, request.url?.startsWith("/api/") ? 400 : 500, { error: message });
        else response.destroy();
      });
    });
    this.websocket = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
    this.managementWebsocket = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
    this.server.on("upgrade", (request, socket, head) => {
      if (request.url === "/v1/management-audio" && this.originAllowed(request)) {
        this.managementWebsocket.handleUpgrade(request, socket, head, (ws) => this.managementWebsocket.emit("connection", ws, request));
        return;
      }
      if (request.url !== "/v1/visor" || !this.originAllowed(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.websocket.handleUpgrade(request, socket, head, (ws) => this.websocket.emit("connection", ws, request));
    });
    this.websocket.on("connection", (ws) => this.handleSocket(ws));
    this.managementWebsocket.on("connection", (ws) => this.handleManagementAudioSocket(ws));
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
    for (const client of this.managementWebsocket.clients) client.close(1001, "server stopping");
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

  private handleManagementAudioSocket(ws: WebSocket): void {
    ws.on("message", (data: RawData, isBinary) => {
      if (!isBinary) {
        try {
          const value = JSON.parse(toBuffer(data).toString("utf8")) as { type?: string; label?: string };
          if (value.type === "device" && typeof value.label === "string") {
            this.bridge.setManagementAudioDevice(value.label);
          }
        } catch {
          // Ignore malformed management control messages.
        }
        return;
      }
      this.bridge.handleManagementAudio(new Uint8Array(toBuffer(data)));
    });
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/api/settings" || url.pathname === "/api/audio-levels" || url.pathname === "/api/voice-chat/start" || url.pathname === "/api/voice-chat/stop" || url.pathname === "/api/audio-test/start" || url.pathname === "/api/audio-test/stop" || url.pathname === "/api/audio-test/sample") {
      if (!isLocalRequest(request)) return json(response, 403, { error: "management page is local-only" });
      if (request.method === "GET" && url.pathname === "/") return html(response, MANAGEMENT_PAGE);
      if (request.method === "GET" && url.pathname === "/api/settings") {
        return json(response, 200, {
          audioInputSource: this.bridge.getAudioInputSource(),
          localAudioOutput: this.bridge.getLocalAudioOutput(),
          inputOptions: ["visor", "mac"],
          outputOptions: ["visor_only", "mac_only", "mac_and_visor"]
        });
      }
      if (request.method === "GET" && url.pathname === "/api/audio-levels") {
        return json(response, 200, this.bridge.getAudioDiagnostics());
      }
      if (request.method === "POST" && url.pathname === "/api/voice-chat/start") {
        await this.bridge.startVoiceChat();
        return json(response, 200, { ok: true, ...this.bridge.getAudioDiagnostics() });
      }
      if (request.method === "POST" && url.pathname === "/api/voice-chat/stop") {
        await this.bridge.stopVoiceChat();
        return json(response, 200, { ok: true, ...this.bridge.getAudioDiagnostics() });
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        const payload = await readJson(request);
        const record = isRecord(payload) ? payload : {};
        const requestedOutput = record.localAudioOutput;
        const output = typeof requestedOutput === "boolean"
          ? (requestedOutput ? "mac_and_visor" : "visor_only")
          : requestedOutput;
        const requestedInput = record.audioInputSource;
        if (output !== undefined && !isLocalAudioOutput(output)) {
          return json(response, 400, { error: "localAudioOutput must be visor_only, mac_only, or mac_and_visor" });
        }
        if (requestedInput !== undefined && !isAudioInputSource(requestedInput)) {
          return json(response, 400, { error: "audioInputSource must be visor or mac" });
        }
        if (isLocalAudioOutput(output)) this.bridge.setLocalAudioOutput(output);
        if (isAudioInputSource(requestedInput)) this.bridge.setAudioInputSource(requestedInput);
        return json(response, 200, {
          ok: true,
          audioInputSource: this.bridge.getAudioInputSource(),
          localAudioOutput: this.bridge.getLocalAudioOutput()
        });
      }
      if (request.method === "POST" && url.pathname === "/api/audio-test/start") {
        await this.bridge.startAudioTest();
        return json(response, 200, { ok: true, ...this.bridge.getAudioDiagnostics() });
      }
      if (request.method === "POST" && url.pathname === "/api/audio-test/stop") {
        await this.bridge.stopAudioTest();
        return json(response, 200, { ok: true, ...this.bridge.getAudioDiagnostics() });
      }
      if (request.method === "POST" && url.pathname === "/api/audio-test/sample") {
        await this.bridge.sendAudioTestSample();
        return json(response, 200, { ok: true, ...this.bridge.getAudioDiagnostics() });
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
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"
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
  <title>CodeX Commander Bridge 音频诊断</title>
  <style>
    :root {
      color-scheme: dark;
      --ink: #f4eee6;
      --muted: #9f9b92;
      --dim: #65635e;
      --bg: #11110f;
      --panel: rgba(29, 28, 25, .76);
      --line: rgba(244, 238, 230, .14);
      --input: #72b9ff;
      --output: #ff9a6a;
      --signal: #f3d27a;
      --danger: #ff736b;
      font-family: "Avenir Next", "Helvetica Neue", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; overflow-x: hidden; background: var(--bg); }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .32; background-image: linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size: 42px 42px; mask-image: linear-gradient(to bottom, black, transparent 82%); }
    body::after { content: ""; position: fixed; inset: -20%; pointer-events: none; background: radial-gradient(circle at 50% 32%, rgba(243,210,122,.07), transparent 28%), radial-gradient(circle at 0% 50%, rgba(114,185,255,.09), transparent 30%), radial-gradient(circle at 100% 50%, rgba(255,154,106,.08), transparent 30%); }
    main { position: relative; z-index: 1; width: min(1480px, 100%); margin: 0 auto; padding: 26px clamp(18px, 4vw, 64px) 56px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
    .brand { display: flex; align-items: center; gap: 11px; color: var(--ink); font-size: 13px; font-weight: 700; letter-spacing: .1em; }
    .brand-mark { width: 10px; height: 10px; border: 2px solid var(--signal); border-radius: 50%; box-shadow: 0 0 0 5px rgba(243,210,122,.1); }
    .system-readout { display: flex; align-items: center; gap: 12px; color: var(--muted); font: 11px "SF Mono", Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; }
    .readout-label { color: var(--dim); }
    .workspace { display: grid; grid-template-columns: minmax(132px, .65fr) minmax(460px, 1.8fr) minmax(132px, .65fr); gap: clamp(24px, 5vw, 80px); min-height: 650px; padding: 34px 0 30px; }
    .signal-rail { position: relative; display: flex; min-height: 590px; flex-direction: column; justify-content: space-between; padding: 18px 0; }
    .signal-rail::before { content: ""; position: absolute; top: 0; bottom: 0; width: 1px; background: linear-gradient(transparent, var(--line) 14%, var(--line) 86%, transparent); }
    .signal-left::before { right: -16px; }
    .signal-right::before { left: -16px; }
    .rail-heading { display: grid; gap: 7px; }
    .rail-kicker { color: var(--dim); font: 10px "SF Mono", Menlo, monospace; letter-spacing: .15em; }
    .rail-name { color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .rail-status { color: var(--input); font-size: 12px; }
    .signal-right .rail-status { color: var(--output); }
    .rail-track { position: relative; flex: 1; width: 48px; min-height: 360px; margin: 28px auto; overflow: hidden; border: 1px solid var(--line); background: rgba(255,255,255,.025); }
    .rail-track::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: repeating-linear-gradient(to bottom, transparent 0, transparent 15px, rgba(255,255,255,.12) 16px); }
    .rail-fill { position: absolute; right: 0; bottom: 0; left: 0; z-index: 1; height: 0; background: linear-gradient(to top, rgba(114,185,255,.18), var(--input)); box-shadow: 0 0 26px rgba(114,185,255,.48); transition: height .12s linear; }
    .signal-right .rail-fill { background: linear-gradient(to top, rgba(255,154,106,.16), var(--output)); box-shadow: 0 0 26px rgba(255,154,106,.42); }
    .rail-fill::after { content: ""; position: absolute; top: 0; right: 0; left: 0; height: 2px; background: #fff; box-shadow: 0 0 13px currentColor; }
    .rail-values { display: grid; gap: 6px; color: var(--muted); font: 11px "SF Mono", Menlo, monospace; }
    .rail-values span:last-child { color: var(--dim); }
    .call-stage { position: relative; display: flex; min-height: 590px; flex-direction: column; align-items: center; justify-content: center; padding: 20px 0 0; text-align: center; }
    .stage-kicker { color: var(--signal); font: 11px "SF Mono", Menlo, monospace; letter-spacing: .2em; text-transform: uppercase; }
    h1 { max-width: 700px; margin: 18px 0 12px; font-size: clamp(44px, 7vw, 92px); font-weight: 500; letter-spacing: -.075em; line-height: .94; }
    .lede { max-width: 530px; margin: 0; color: var(--muted); font-size: 15px; line-height: 1.65; }
    .call-orb { position: relative; display: grid; width: 176px; height: 176px; place-items: center; margin: 36px 0 22px; border: 1px solid rgba(243,210,122,.34); border-radius: 50%; background: radial-gradient(circle, rgba(243,210,122,.14), transparent 58%); box-shadow: 0 0 0 14px rgba(243,210,122,.035), 0 0 90px rgba(243,210,122,.1); }
    .call-orb::before, .call-orb::after { content: ""; position: absolute; border: 1px solid rgba(243,210,122,.28); border-radius: 50%; }
    .call-orb::before { inset: 18px; }
    .call-orb::after { inset: -12px; border-color: rgba(243,210,122,.12); }
    .orb-core { width: 34px; height: 34px; border-radius: 50%; background: var(--signal); box-shadow: 0 0 30px rgba(243,210,122,.75); }
    .call-orb[data-phase="starting"] { animation: dialPulse 1.8s ease-in-out infinite; }
    .call-orb[data-phase="connected"] { border-color: rgba(114,185,255,.5); background: radial-gradient(circle, rgba(114,185,255,.18), transparent 58%); box-shadow: 0 0 0 14px rgba(114,185,255,.035), 0 0 90px rgba(114,185,255,.16); }
    .call-orb[data-phase="connected"] .orb-core { background: var(--input); box-shadow: 0 0 30px rgba(114,185,255,.85); }
    .call-orb[data-phase="error"] { border-color: rgba(255,115,107,.5); }
    .call-orb[data-phase="error"] .orb-core { background: var(--danger); box-shadow: 0 0 30px rgba(255,115,107,.7); }
    @keyframes dialPulse { 0%, 100% { transform: scale(1); opacity: .72; } 50% { transform: scale(1.05); opacity: 1; } }
    .voice-state { min-height: 24px; color: var(--signal); font-size: 16px; font-weight: 700; }
    .status-lights { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px 20px; margin-top: 14px; }
    .status-light { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font: 10px "SF Mono", Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
    .status-light i { display: block; width: 7px; height: 7px; border-radius: 50%; background: var(--dim); box-shadow: 0 0 0 transparent; }
    .status-light[data-state="busy"] i { background: var(--signal); box-shadow: 0 0 12px rgba(243,210,122,.78); animation: lightPulse 1.2s ease-in-out infinite; }
    .status-light[data-state="on"] i { background: #83e6b7; box-shadow: 0 0 12px rgba(131,230,183,.78); }
    .status-light[data-state="error"] i { background: var(--danger); box-shadow: 0 0 12px rgba(255,115,107,.78); }
    @keyframes lightPulse { 50% { opacity: .42; } }
    .call-console { display: grid; justify-items: center; margin-top: 18px; }
    .call-button { position: relative; display: grid; width: 116px; height: 116px; min-height: 116px; place-items: center; margin: 0; border: 8px solid rgba(243,210,122,.22); border-radius: 50%; color: #17140e; background: radial-gradient(circle at 35% 28%, #ffe8a9, var(--signal) 58%, #bb963d); box-shadow: inset 0 3px 2px rgba(255,255,255,.48), inset 0 -8px 13px rgba(90,60,10,.25), 0 0 0 8px rgba(243,210,122,.06), 0 15px 30px rgba(0,0,0,.28); }
    .call-button::before { content: ""; position: absolute; inset: -15px; border: 1px solid rgba(243,210,122,.2); border-radius: 50%; }
    .call-button svg { width: 43px; height: 43px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.5; transition: transform .24s ease; }
    .call-button:active:not(:disabled) { transform: translateY(4px) scale(.97); box-shadow: inset 0 7px 14px rgba(90,60,10,.28), 0 7px 15px rgba(0,0,0,.24); }
    .call-button[data-active="true"] { border-color: rgba(255,115,107,.28); color: #fff4ef; background: radial-gradient(circle at 35% 28%, #ff9a8e, var(--danger) 60%, #a33c43); box-shadow: inset 0 3px 2px rgba(255,255,255,.25), inset 0 -8px 13px rgba(75,12,20,.3), 0 0 0 8px rgba(255,115,107,.07), 0 15px 30px rgba(0,0,0,.28); }
    .call-button[data-active="true"]::before { border-color: rgba(255,115,107,.2); }
    .call-button[data-active="true"] svg { transform: rotate(135deg); }
    .call-action-name { margin-top: 18px; color: var(--ink); font-size: 14px; font-weight: 800; letter-spacing: .08em; }
    .call-action-note { margin-top: 5px; color: var(--dim); font: 10px "SF Mono", Menlo, monospace; }
    .control-dock { width: min(620px, 100%); margin-top: 38px; padding: 16px; border: 1px solid var(--line); background: var(--panel); box-shadow: 0 24px 80px rgba(0,0,0,.2); backdrop-filter: blur(18px); }
    .control-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .field { display: grid; gap: 8px; text-align: left; }
    .field-label { color: var(--dim); font: 10px "SF Mono", Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
    .field-note { color: var(--dim); font-size: 11px; }
    select, button { width: 100%; min-height: 48px; border: 1px solid var(--line); border-radius: 0; padding: 12px 13px; color: var(--ink); background: rgba(0,0,0,.22); font: inherit; transition: border-color .2s ease, background .2s ease, opacity .2s ease, transform .2s ease; }
    select:focus-visible, button:focus-visible { outline: 2px solid var(--signal); outline-offset: 3px; }
    select:disabled { color: var(--dim); opacity: .5; }
    button { cursor: pointer; font-weight: 700; }
    button:hover:not(:disabled) { transform: translateY(-2px); }
    button:disabled { cursor: not-allowed; opacity: .3; }
    button.primary { border-color: var(--signal); color: #181510; background: var(--signal); font-size: 15px; letter-spacing: .04em; }
    button.primary:hover:not(:disabled) { background: #ffe19b; box-shadow: 0 12px 35px rgba(243,210,122,.18); }
    button[data-active="true"] { border-color: var(--output); color: #20130d; background: var(--output); }
    .action-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
    .audio-key { position: relative; display: flex; align-items: center; justify-content: flex-start; gap: 12px; min-height: 66px; padding: 10px 14px; border-color: rgba(244,238,230,.18); background: linear-gradient(145deg, rgba(255,255,255,.1), rgba(0,0,0,.16)); box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 8px 18px rgba(0,0,0,.15); text-align: left; }
    .audio-key:hover:not(:disabled) { border-color: rgba(243,210,122,.65); background: linear-gradient(145deg, rgba(243,210,122,.18), rgba(0,0,0,.16)); }
    .audio-key:active:not(:disabled) { transform: translateY(3px); box-shadow: inset 0 5px 12px rgba(0,0,0,.25); }
    .key-icon { display: grid; width: 38px; height: 38px; flex: 0 0 38px; place-items: center; border: 1px solid rgba(244,238,230,.2); border-radius: 50%; color: var(--signal); background: rgba(0,0,0,.18); }
    .key-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
    .sample-key .key-icon svg { fill: currentColor; stroke: none; }
    .talk-key[data-active="true"] { border-color: rgba(114,185,255,.7); background: linear-gradient(145deg, rgba(114,185,255,.2), rgba(0,0,0,.16)); }
    .talk-key[data-active="true"] .key-icon { color: var(--input); box-shadow: 0 0 18px rgba(114,185,255,.35); }
    .status-line { min-height: 22px; margin-top: 14px; color: var(--signal); font-size: 12px; text-align: left; }
    .control-hint { margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.5; text-align: left; }
    .log-panel { margin-top: 2px; padding-top: 22px; border-top: 1px solid var(--line); }
    .log-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
    .log-title { margin-top: 7px; font-size: 24px; letter-spacing: -.04em; }
    .meter-status { color: var(--signal); font: 11px "SF Mono", Menlo, monospace; }
    .voice-events { display: grid; gap: 1px; min-height: 76px; max-height: 360px; margin-top: 18px; overflow-y: auto; overscroll-behavior: auto; border-top: 1px solid var(--line); scrollbar-color: rgba(244,238,230,.28) transparent; }
    .voice-event { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 18px; padding: 16px 4px; border-bottom: 1px solid var(--line); color: var(--ink); white-space: pre-wrap; word-break: break-word; }
    .voice-event.user { color: var(--input); }
    .voice-event.assistant { color: var(--output); }
    .voice-event.error { color: var(--danger); }
    .voice-event-label { color: var(--muted); font: 10px "SF Mono", Menlo, monospace; letter-spacing: .08em; }
    .voice-event.error .voice-event-label { color: var(--danger); }
    .hint { color: var(--muted); font-size: 12px; line-height: 1.55; }
    footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 22px; color: var(--dim); font: 10px "SF Mono", Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
    @media (max-width: 900px) { .workspace { grid-template-columns: 86px minmax(0, 1fr) 86px; gap: 24px; } h1 { font-size: clamp(42px, 8vw, 72px); } }
    @media (max-width: 680px) { main { padding-top: 20px; } .topbar { align-items: flex-start; flex-direction: column; } .system-readout { align-self: stretch; justify-content: space-between; } .workspace { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; min-height: 0; padding-top: 24px; } .call-stage { grid-column: 1 / -1; grid-row: 1; min-height: 650px; padding-top: 0; } .signal-left { grid-column: 1; grid-row: 2; min-height: 250px; } .signal-right { grid-column: 2; grid-row: 2; min-height: 250px; } .rail-track { min-height: 130px; margin: 14px auto; } .control-grid, .action-row { grid-template-columns: 1fr; } .voice-event { grid-template-columns: 1fr; gap: 7px; } footer { flex-direction: column; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }
  </style>
</head>
<body>
  <main>
    <header class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>Code X</span></div>
      <div class="system-readout"><span class="readout-label">通话</span><span id="linkReadout">未接通</span></div>
    </header>
    <div class="workspace">
      <aside class="signal-rail signal-left" aria-label="输入音频电平">
        <div class="rail-heading"><span class="rail-kicker">输入 01</span><span class="rail-name">麦克风</span><span id="inputStatus" class="rail-status">未采集</span></div>
        <div class="rail-track"><div id="inputFill" class="rail-fill"></div></div>
        <div class="rail-values"><span id="inputRms">RMS 0.000</span><span id="inputPeak">PEAK 0.000</span></div>
      </aside>
      <section class="call-stage">
        <div class="stage-kicker">当前通话</div>
        <h1>Code X</h1>
        <p class="lede">先拨通，再开始说话或播放测试音频。</p>
        <div id="callOrb" class="call-orb" data-phase="stopped" aria-hidden="true"><span class="orb-core"></span></div>
        <div id="voiceChatStatus" class="voice-state">未接通</div>
        <div class="status-lights" aria-live="polite">
          <span id="callLight" class="status-light" data-state="off"><i></i><span id="callLightText">未接通</span></span>
          <span id="inputLight" class="status-light" data-state="off"><i></i><span id="inputLightText">输入待机</span></span>
          <span id="outputLight" class="status-light" data-state="off"><i></i><span id="outputLightText">播放待机</span></span>
        </div>
        <div class="call-console">
          <button id="voiceChatButton" class="primary call-button" type="button" aria-label="拨打电话">
            <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M15.2 8.5c1.2-.9 2.9-.7 3.8.5l4.2 5.8c.8 1.1.6 2.7-.4 3.6l-2.9 2.4c2 4 5.2 7.2 9.2 9.2l2.4-2.9c.9-1.1 2.5-1.3 3.6-.4l5.8 4.2c1.2.9 1.4 2.6.5 3.8l-2.5 3.2c-1.5 1.9-4.1 2.6-6.4 1.7-6.7-2.6-12.2-6.5-16.5-10.8C11.7 24.5 7.8 19 5.2 12.3c-.9-2.3-.2-4.9 1.7-6.4l3.2-2.5c1.2-.9 2.9-.7 3.8.5l1.3 1.8Z" /></svg>
          </button>
          <span id="voiceChatButtonLabel" class="call-action-name">拨打电话</span>
          <span class="call-action-note">接通后按此键挂断</span>
        </div>
        <div class="control-dock">
          <div class="control-grid">
            <label class="field"><span class="field-label">输入来源</span><select id="audioInput" disabled><option value="visor">眼镜麦克风</option><option value="mac">电脑麦克风</option></select><span class="field-note">电脑麦克风，或眼镜按住 PTT。</span></label>
            <label class="field"><span class="field-label">回复播放到</span><select id="localAudio" disabled><option value="visor_only">仅眼镜</option><option value="mac_only">仅电脑</option><option value="mac_and_visor">电脑 + 眼镜</option></select><span class="field-note">选择 Code X 的声音播放位置。</span></label>
          </div>
          <div class="action-row">
            <button id="sampleButton" class="audio-key sample-key" type="button" disabled><span class="key-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6V6Z" /></svg></span><span id="sampleButtonLabel">播放探针</span></button>
            <button id="testButton" class="audio-key talk-key" type="button" disabled><span class="key-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg></span><span id="testButtonLabel">开始说话</span></button>
          </div>
          <div id="status" class="status-line">先拨打电话，接通后才能使用音频。</div>
          <div id="controlHint" class="control-hint">电话状态会像真实通话一样控制音频设备与操作权限。</div>
        </div>
      </section>
      <aside class="signal-rail signal-right" aria-label="服务器返回音频电平">
        <div class="rail-heading"><span class="rail-kicker">输出 02</span><span class="rail-name">服务器回复</span><span id="outputStatus" class="rail-status">未收到</span></div>
        <div class="rail-track"><div id="outputFill" class="rail-fill"></div></div>
        <div class="rail-values"><span id="outputRms">RMS 0.000</span><span id="outputPeak">PEAK 0.000</span></div>
      </aside>
    </div>
    <section class="log-panel" aria-live="polite">
      <div class="log-heading"><div><div class="rail-kicker">对话记录</div><div class="log-title">通话内容</div></div><div id="voiceEventStatus" class="meter-status">暂无对话内容</div></div>
      <div id="voiceEvents" class="voice-events"></div>
    </section>
  </main>
  <script>
    const inputControl = document.querySelector('#audioInput');
    const outputControl = document.querySelector('#localAudio');
    const voiceChatButton = document.querySelector('#voiceChatButton');
    const voiceChatButtonLabel = document.querySelector('#voiceChatButtonLabel');
    const voiceChatStatus = document.querySelector('#voiceChatStatus');
    const sampleButton = document.querySelector('#sampleButton');
    const sampleButtonLabel = document.querySelector('#sampleButtonLabel');
    const testButton = document.querySelector('#testButton');
    const testButtonLabel = document.querySelector('#testButtonLabel');
    const status = document.querySelector('#status');
    const inputFill = document.querySelector('#inputFill');
    const outputFill = document.querySelector('#outputFill');
    const inputRms = document.querySelector('#inputRms');
    const inputPeak = document.querySelector('#inputPeak');
    const outputRms = document.querySelector('#outputRms');
    const outputPeak = document.querySelector('#outputPeak');
    const inputStatus = document.querySelector('#inputStatus');
    const outputStatus = document.querySelector('#outputStatus');
    const voiceEventStatus = document.querySelector('#voiceEventStatus');
    const voiceEvents = document.querySelector('#voiceEvents');
    const linkReadout = document.querySelector('#linkReadout');
    const callOrb = document.querySelector('#callOrb');
    const controlHint = document.querySelector('#controlHint');
    const callLight = document.querySelector('#callLight');
    const callLightText = document.querySelector('#callLightText');
    const inputLight = document.querySelector('#inputLight');
    const inputLightText = document.querySelector('#inputLightText');
    const outputLight = document.querySelector('#outputLight');
    const outputLightText = document.querySelector('#outputLightText');
    let testActive = false;
    let voiceChatActive = false;
    let voiceTurnActive = false;
    let pendingSample = false;
    let actionMessage = '';
    let managementSocket = null;
    let macCapture = null;
    let toneContext = null;
    let dialToneTimer = null;
    let callToneSession = false;
    let callToneConnected = false;
    let renderedTranscriptSignature = null;
    let lastAudioEndId = null;
    const outputLabels = { visor_only: '仅眼镜', mac_only: '仅电脑', mac_and_visor: '电脑 + 眼镜' };
    const inputLabels = { visor: '眼镜麦克风', mac: '电脑麦克风' };
    const transportLabels = { none: '未开始采集', visor: '眼镜通道', management_page: '8787 网页通道', chromium_native: 'Chromium 原生通道' };
    const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));
    const meterWidth = (level) => Math.min(100, Math.max(0, Math.round(clamp(level.peak) * 100)));
    const showAction = (message) => { actionMessage = message; status.textContent = message; };
    const getToneContext = () => {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return null;
      if (!toneContext) toneContext = new Context();
      if (toneContext.state === 'suspended') void toneContext.resume();
      return toneContext;
    };
    const beep = (frequency, duration, volume = .045, delay = 0) => {
      const context = getToneContext();
      if (!context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + delay;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + .018);
      gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + .03);
    };
    const playRogerSound = () => {
      if (!toneContext) return;
      const context = toneContext;
      const length = Math.floor(context.sampleRate * .18);
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < channel.length; index += 1) {
        const envelope = Math.max(0, 1 - index / channel.length);
        channel[index] = (Math.random() * 2 - 1) * envelope;
      }
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      const start = context.currentTime;
      source.buffer = buffer;
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(2300, start);
      filter.Q.setValueAtTime(.8, start);
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(.06, start + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, start + .17);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      source.start(start);
      source.stop(start + .19);
      beep(1480, .075, .026);
    };
    const syncRogerSound = (events) => {
      const latestAudioEnd = (Array.isArray(events) ? events : []).slice().reverse().find((event) => event && event.type === 'audio_end');
      if (!latestAudioEnd || latestAudioEnd.id === lastAudioEndId) return;
      lastAudioEndId = latestAudioEnd.id;
      playRogerSound();
    };
    const stopDialTone = () => {
      if (dialToneTimer !== null) {
        window.clearInterval(dialToneTimer);
        dialToneTimer = null;
      }
    };
    const beginDialTone = () => {
      stopDialTone();
      callToneSession = true;
      callToneConnected = false;
      const ring = () => beep(425, 1.12, .04);
      ring();
      dialToneTimer = window.setInterval(ring, 3000);
    };
    const playDisconnectTone = () => {
      beep(520, .16, .05);
      beep(350, .22, .05, .18);
      beep(240, .32, .045, .42);
    };
    const finishCallTone = (disconnect) => {
      stopDialTone();
      if (disconnect) playDisconnectTone();
      callToneSession = false;
      callToneConnected = false;
    };
    const syncCallTone = (phase) => {
      if (phase === 'connected') {
        callToneConnected = true;
        stopDialTone();
      } else if ((phase === 'error' || phase === 'stopped') && callToneSession && callToneConnected) {
        finishCallTone(true);
      }
    };
    const setStatusLight = (element, textElement, text, state) => {
      element.dataset.state = state;
      textElement.textContent = text;
    };
    const renderVoiceEvents = (events) => {
      const items = (Array.isArray(events) ? events : [])
        .filter((event) => event && event.type === 'caption' && (event.role === 'user' || event.role === 'assistant'))
        .slice(-40);
      const signature = items.map((event) => String(event.id) + ':' + event.role + ':' + (event.text || '')).join('|');
      if (signature === renderedTranscriptSignature) return;
      const shouldFollow = voiceEvents.scrollHeight - voiceEvents.scrollTop - voiceEvents.clientHeight < 40;
      const previousScrollTop = voiceEvents.scrollTop;
      renderedTranscriptSignature = signature;
      voiceEvents.replaceChildren();
      if (!items.length) {
        voiceEventStatus.textContent = '暂无对话内容';
        const empty = document.createElement('div');
        empty.className = 'hint';
        empty.textContent = '接通后开始说话，对话内容会按轮次出现在这里。';
        voiceEvents.append(empty);
        return;
      }
      for (const event of items) {
        const row = document.createElement('div');
        const role = event.role === 'user' ? 'user' : 'assistant';
        row.className = 'voice-event ' + role;
        const label = document.createElement('span');
        label.className = 'voice-event-label';
        label.textContent = event.role === 'user' ? '我' : 'Code X';
        const body = document.createElement('span');
        body.textContent = event.text || '';
        row.append(label, body);
        voiceEvents.append(row);
      }
      voiceEventStatus.textContent = items.length + ' 条对话内容';
      if (shouldFollow) voiceEvents.scrollTop = voiceEvents.scrollHeight;
      else voiceEvents.scrollTop = previousScrollTop;
    };
    const floatToPcm16 = (samples, sampleRate) => {
      const outputLength = Math.max(1, Math.floor(samples.length * 24000 / sampleRate));
      const output = new Int16Array(outputLength);
      for (let index = 0; index < output.length; index += 1) {
        const sourceIndex = Math.min(samples.length - 1, Math.floor(index * sampleRate / 24000));
        const sample = Math.max(-1, Math.min(1, samples[sourceIndex] || 0));
        output[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      }
      return output.buffer;
    };
    const openManagementSocket = () => new Promise((resolve, reject) => {
      if (managementSocket && managementSocket.readyState === WebSocket.OPEN) return resolve(managementSocket);
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(scheme + '://' + location.host + '/v1/management-audio');
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => { managementSocket = socket; resolve(socket); };
      socket.onerror = () => reject(new Error('无法连接 Bridge 管理音频通道'));
    });
    const stopMacCapture = async () => {
      const capture = macCapture;
      macCapture = null;
      if (!capture) return;
      capture.processor.disconnect();
      capture.source.disconnect();
      capture.silentGain.disconnect();
      capture.stream.getTracks().forEach((track) => track.stop());
      if (capture.context.state !== 'closed') await capture.context.close();
      if (capture.socket.readyState === WebSocket.OPEN) capture.socket.close(1000, 'audio test stopped');
      if (managementSocket === capture.socket) managementSocket = null;
    };
    const startMacCapture = async () => {
      if (macCapture) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('当前网页环境不支持麦克风采集');
      let requestSettled = false;
      const mediaRequest = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false }).then((value) => {
        if (requestSettled) value.getTracks().forEach((track) => track.stop());
        return value;
      });
      let stream;
      try {
        stream = await Promise.race([mediaRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('电脑麦克风权限未返回，请允许 127.0.0.1 使用麦克风后重试')), 8000))]);
        requestSettled = true;
      } catch (error) {
        requestSettled = true;
        throw error;
      }
      const socket = await openManagementSocket();
      const context = new AudioContext({ latencyHint: 'interactive' });
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(2048, 1, 1);
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      const track = stream.getAudioTracks()[0];
      const deviceLabel = track?.label || '网页麦克风';
      macCapture = { stream, socket, context, source, processor, silentGain, deviceLabel };
      socket.send(JSON.stringify({ type: 'device', label: deviceLabel }));
      processor.onaudioprocess = (event) => {
        if (!macCapture || macCapture.socket.readyState !== WebSocket.OPEN || !testActive) return;
        macCapture.socket.send(floatToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
    };
    const updateMeters = (value) => {
      const input = value.input || {};
      const output = value.output || {};
      voiceChatActive = value.voiceChatActive === true;
      const phase = value.voiceChatPhase || (voiceChatActive ? 'connected' : 'stopped');
      const phaseLabels = { starting: '拨号中', connected: '已接通', stopping: '挂断中', stopped: '未接通', error: '通话错误' };
      voiceChatStatus.textContent = phaseLabels[phase] || phase;
      voiceChatButton.disabled = phase === 'starting' || phase === 'stopping';
      inputFill.style.height = meterWidth(input) + '%';
      outputFill.style.height = meterWidth(output) + '%';
      inputRms.textContent = 'RMS ' + clamp(input.rms).toFixed(3);
      inputPeak.textContent = 'Peak ' + clamp(input.peak).toFixed(3);
      outputRms.textContent = 'RMS ' + clamp(output.rms).toFixed(3);
      outputPeak.textContent = 'Peak ' + clamp(output.peak).toFixed(3);
      const inputFrames = Number(value.inputFrames) || 0;
      inputStatus.textContent = input.active
        ? '有声音'
        : value.testActive
          ? (inputFrames > 0 ? '已收到输入帧，等待有效声音' : (inputControl.value === 'visor' ? '未收到眼镜音频，请使用眼镜 PTT' : '未收到电脑麦克风'))
          : (inputFrames > 0 ? '测试已停止，已收到 ' + inputFrames + ' 帧' : '未采集');
      renderVoiceEvents(value.voiceEvents);
      testActive = value.testActive === true;
      voiceTurnActive = value.voiceTurnActive === true;
      const connected = voiceChatActive && phase === 'connected';
      const callState = phase === 'connected' ? 'on' : phase === 'starting' || phase === 'stopping' ? 'busy' : phase === 'error' ? 'error' : 'off';
      setStatusLight(callLight, callLightText, phase === 'connected' ? '已接通' : phase === 'starting' ? '拨号中' : phase === 'stopping' ? '挂断中' : phase === 'error' ? '通话错误' : '未接通', callState);
      setStatusLight(inputLight, inputLightText, input.active ? '有声音' : testActive ? '采集中' : '输入待机', input.active ? 'on' : testActive ? 'busy' : 'off');
      setStatusLight(outputLight, outputLightText, output.active ? '播放中' : voiceTurnActive ? '等待回复' : '播放待机', output.active ? 'on' : voiceTurnActive ? 'busy' : 'off');
      inputStatus.textContent = input.active ? '有声音' : testActive ? '采集中' : '输入待机';
      outputStatus.textContent = output.active ? '播放中' : voiceTurnActive ? '等待回复' : '播放待机';
      syncRogerSound(value.voiceEvents);
      callOrb.dataset.phase = phase;
      linkReadout.textContent = phase === 'connected' ? '已接通' : phase === 'starting' ? '拨号中' : phase === 'stopping' ? '挂断中' : '未接通';
      syncCallTone(phase);
      voiceChatButton.dataset.active = String(connected);
      voiceChatButton.setAttribute('aria-label', connected ? '挂断电话' : '拨打电话');
      voiceChatButtonLabel.textContent = connected ? '挂断电话' : phase === 'starting' ? '拨号中...' : '拨打电话';
      inputControl.disabled = !connected;
      outputControl.disabled = !connected;
      sampleButton.disabled = !connected || testActive;
      sampleButtonLabel.textContent = voiceTurnActive
        ? (pendingSample ? 'hi there 已排队' : '等待上一轮完成后发送 hi there')
        : '播放探针';
      testButton.disabled = !connected || (!testActive && voiceTurnActive);
      testButton.dataset.active = String(testActive);
      testButtonLabel.textContent = testActive ? '结束并发送' : '开始说话';
      controlHint.textContent = connected
        ? '通话已接通。可以播放 hi there 探针，或使用 Chrome 麦克风开始一轮对话。'
        : phase === 'starting'
          ? '正在拨号，音频控制将在实时链路接通后解锁。'
          : phase === 'stopping'
            ? '正在挂断，正在释放音频链路。'
            : '未接通前不能播放、录音或切换音频设备。';
      if (!actionMessage && value.audioInputDevice) {
        showAction('输入：' + (inputLabels[inputControl.value] || inputControl.value) + '（设备：' + value.audioInputDevice + '，通道：' + (transportLabels[value.audioInputTransport] || value.audioInputTransport || '未知') + '）；输出：' + (outputLabels[outputControl.value] || outputControl.value));
      }
      if (pendingSample && !voiceTurnActive && voiceChatActive && !testActive) {
        showAction('上一轮已结束，正在发送排队的 hi there 音频...');
        void sendSample();
      }
    };
    const updateStatus = (value) => {
      inputControl.value = value.audioInputSource || 'visor';
      outputControl.value = value.localAudioOutput || 'visor_only';
      const device = value.audioInputDevice ? '（设备：' + value.audioInputDevice + '）' : '';
      status.textContent = '输入：' + (inputLabels[inputControl.value] || inputControl.value) + device + '；输出：' + (outputLabels[outputControl.value] || outputControl.value);
    };
    async function load() {
      const response = await fetch('/api/settings', { cache: 'no-store' });
      updateStatus(await response.json());
    }
    async function saveSettings() {
      inputControl.disabled = true;
      outputControl.disabled = true;
      const response = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audioInputSource: inputControl.value, localAudioOutput: outputControl.value }) });
      const value = await response.json();
      inputControl.disabled = false;
      outputControl.disabled = false;
      if (!response.ok) throw new Error(value.error || '设置失败');
      updateStatus(value);
    }
    inputControl.addEventListener('change', () => { actionMessage = ''; saveSettings().catch((error) => showAction(error.message)); });
    outputControl.addEventListener('change', () => { actionMessage = ''; saveSettings().catch((error) => showAction(error.message)); });
    voiceChatButton.addEventListener('click', async () => {
      const starting = !voiceChatActive;
      voiceChatButton.disabled = true;
      if (starting) beginDialTone();
      voiceChatStatus.textContent = starting ? '正在启动 Voice Chat...' : '正在挂断 Voice Chat...';
      try {
        const response = await fetch(starting ? '/api/voice-chat/start' : '/api/voice-chat/stop', { method: 'POST' });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'Voice Chat 控制失败');
        updateMeters(value);
        if (starting && value.voiceChatActive === true && value.voiceChatPhase === 'connected') stopDialTone();
        if (starting && value.voiceChatActive !== true && value.voiceChatPhase === 'error') finishCallTone(true);
        if (!starting && value.voiceChatActive !== true) finishCallTone(true);
      } catch (error) {
        if (starting) finishCallTone(true);
        voiceChatStatus.textContent = error.message || String(error);
        await poll();
      }
    });
    const sendSample = async () => {
      sampleButton.disabled = true;
      pendingSample = false;
      showAction('正在发送已生成的 hi there 音频...');
      try {
        const response = await fetch('/api/audio-test/sample', { method: 'POST' });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || '测试音频发送失败');
        updateMeters(value);
        showAction('hi there 音频已送入当前 Voice Chat，等待服务器原生返回...');
      } catch (error) {
        showAction(error.message || String(error));
      } finally {
        sampleButton.disabled = !voiceChatActive || testActive;
      }
    };
    sampleButton.addEventListener('click', async () => {
      if (testActive) {
        showAction('请先停止音频测试，再发送 hi there 音频');
        return;
      }
      if (voiceTurnActive) {
        pendingSample = true;
        sampleButtonLabel.textContent = 'hi there 已排队';
        showAction('上一轮音频仍在等待服务器返回；hi there 已排队，将在这一轮结束后自动发送');
        return;
      }
      await sendSample();
    });
    testButton.addEventListener('click', async () => {
      testButton.disabled = true;
      const starting = !testActive;
      let captureStarted = false;
      try {
        showAction(starting && inputControl.value === 'mac' ? '正在请求电脑麦克风权限并连接管理音频通道...' : (starting ? '正在启动音频测试...' : '正在停止音频测试...'));
        if (starting && inputControl.value === 'mac') {
          try {
            await startMacCapture();
            captureStarted = true;
          } catch (error) {
            showAction('网页麦克风不可用（' + (error.message || String(error)) + '），改用 Chromium 原生麦克风...');
          }
        }
        const path = starting ? '/api/audio-test/start' : '/api/audio-test/stop';
        const response = await fetch(path, { method: 'POST' });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || '音频测试失败');
        updateMeters(value);
        if (starting && inputControl.value === 'mac' && macCapture) {
          macCapture.socket.send(JSON.stringify({ type: 'device', label: macCapture.deviceLabel || '网页麦克风' }));
        }
        showAction(starting
          ? (inputControl.value === 'visor' ? '音频测试已开始；本页不会启动眼镜麦克风，请改选电脑麦克风，或使用眼镜 PTT' : '音频测试已开始，请对电脑麦克风说话')
          : '音频测试已停止');
      } catch (error) {
        if (captureStarted) await stopMacCapture().catch(() => undefined);
        showAction(error.message || String(error));
      } finally {
        if (!starting) await stopMacCapture().catch(() => undefined);
        testButton.disabled = !voiceChatActive && !testActive;
      }
    });
    window.addEventListener('beforeunload', () => { void stopMacCapture(); });
    async function poll() {
      try { updateMeters(await (await fetch('/api/audio-levels', { cache: 'no-store' })).json()); } catch { /* bridge may be restarting */ }
    }
    load().catch(() => { status.textContent = '无法读取 Bridge 状态'; });
    poll();
    setInterval(poll, 160);
  </script>
</body>
</html>`;

function isLocalAudioOutput(value: unknown): value is LocalAudioOutput {
  return value === "visor_only" || value === "mac_only" || value === "mac_and_visor";
}

function isAudioInputSource(value: unknown): value is AudioInputSource {
  return value === "visor" || value === "mac";
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
