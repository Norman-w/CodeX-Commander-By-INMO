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
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; background: #070d12; color: #eef9fb; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 8% 0%, #205466, transparent 40%), radial-gradient(circle at 100% 100%, #243a52, transparent 42%), #070d12; }
    main { width: min(900px, calc(100vw - 32px)); margin: 0 auto; padding: 34px 0 48px; }
    h1 { margin: 0 0 8px; font-size: clamp(28px, 5vw, 44px); letter-spacing: -.04em; }
    p { color: #a9c2ca; line-height: 1.6; }
    .eyebrow { color: #68e0d0; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    .panel { margin-top: 24px; padding: 22px; border: 1px solid #294d59; border-radius: 22px; background: rgba(10, 27, 35, .88); box-shadow: 0 24px 80px rgba(0,0,0,.26); }
    .routes, .meters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .field, .meter { padding: 18px; border-radius: 16px; background: #102832; }
    .field label, .meter-title { display: block; margin-bottom: 9px; color: #a9c7ce; font-size: 13px; font-weight: 700; }
    select, button { width: 100%; border: 1px solid #3c6974; border-radius: 11px; padding: 12px 13px; color: #f4ffff; background: #0b1b22; font: inherit; }
    button { cursor: pointer; border-color: #54d9c9; color: #052020; background: #63e4d1; font-weight: 800; }
    button[data-active="true"] { border-color: #ffb86c; color: #291706; background: #ffbf73; }
    .meter-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .meter-status { color: #6fe3bd; font-size: 12px; }
    .bar { height: 14px; margin: 16px 0 10px; overflow: hidden; border-radius: 999px; background: #071317; }
    .fill { width: 0%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #36c7ff, #67e5c6, #ffd166); transition: width .12s linear; }
    .values { display: flex; justify-content: space-between; color: #96b4bc; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .transcript-panel { display: grid; gap: 12px; }
    .voice-events { display: grid; gap: 8px; max-height: 300px; overflow: auto; }
    .voice-event { padding: 10px 12px; border-left: 3px solid #5f8490; border-radius: 8px; background: #0b1b22; color: #e7f7f7; white-space: pre-wrap; word-break: break-word; }
    .voice-event.user { border-left-color: #65c7ff; }
    .voice-event.assistant { border-left-color: #63e4d1; }
    .voice-event.error { border-left-color: #ff8176; color: #ffd1cb; }
    .voice-event-label { display: block; margin-bottom: 4px; color: #9bbac2; font-size: 12px; font-weight: 800; }
    .action { display: grid; grid-template-columns: minmax(0, 1fr) 220px; align-items: end; gap: 18px; }
    .voice-control { display: flex; align-items: center; justify-content: space-between; gap: 24px; border-color: rgba(255, 204, 128, .36); background: linear-gradient(120deg, rgba(255, 204, 128, .13), rgba(255, 255, 255, .04)); }
    .voice-state { margin-top: 10px; color: #ffd28a; font-size: 17px; font-weight: 700; }
    button.primary { min-width: 168px; border-color: rgba(255, 204, 128, .65); background: #ffcc80; color: #24190b; }
    .actions { display: grid; gap: 10px; }
    #status { min-height: 22px; color: #70e6b0; }
    .hint { color: #8caab2; font-size: 13px; }
    code { color: #79def5; }
    @media (max-width: 680px) { main { width: min(100% - 24px, 520px); padding-top: 24px; } .routes, .meters, .action { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">CodeX Commander / Bridge</div>
    <h1>原生 Voice Chat 音频诊断</h1>
    <p>先选择输入和输出，再启动一次测试。这里走当前 ChatGPT 登录态与 Chromium WebRTC 原生音频，不使用 TTS。</p>
    <section class="panel routes">
      <div class="field"><label for="audioInput">输入来源</label><select id="audioInput"><option value="visor">眼镜麦克风</option><option value="mac">电脑麦克风</option></select><div class="hint">开始/停止音频测试使用电脑麦克风；眼镜麦克风由眼镜 PTT 触发。</div></div>
      <div class="field"><label for="localAudio">服务器回复输出</label><select id="localAudio"><option value="visor_only">仅眼镜</option><option value="mac_only">仅电脑</option><option value="mac_and_visor">电脑 + 眼镜</option></select><div class="hint">电脑输出由 Chromium WebRTC 远端音频直接播放。</div></div>
    </section>
    <section class="panel meters">
      <div class="meter"><div class="meter-head"><div class="meter-title">输入电平</div><div id="inputStatus" class="meter-status">未采集</div></div><div class="bar"><div id="inputFill" class="fill"></div></div><div class="values"><span id="inputRms">RMS 0.000</span><span id="inputPeak">Peak 0.000</span></div></div>
      <div class="meter"><div class="meter-head"><div class="meter-title">服务器返回电平</div><div id="outputStatus" class="meter-status">未收到</div></div><div class="bar"><div id="outputFill" class="fill"></div></div><div class="values"><span id="outputRms">RMS 0.000</span><span id="outputPeak">Peak 0.000</span></div></div>
    </section>
    <section class="panel transcript-panel"><div class="meter-head"><div><div class="meter-title">服务器解析 / 原生返回</div><div class="hint">和眼镜使用同一份 Voice Chat 事件；这里能区分“识别到了”与“收到音频”。</div></div><div id="voiceEventStatus" class="meter-status">等待服务器返回</div></div><div id="voiceEvents" class="voice-events"></div></section>
    <section class="panel voice-control"><div><div class="eyebrow">VOICE CHAT 总控</div><h2>会话生命周期</h2><div class="voice-state" id="voiceChatStatus">正在读取 Voice Chat 状态...</div><div class="hint">先启动会话，再测试输入和服务器返回；挂断后所有测试按钮都会锁定。</div></div><button id="voiceChatButton" class="primary" type="button">启动 Voice Chat</button></section>
    <section class="panel action"><div><div id="status">正在读取 Bridge 状态...</div><div class="hint">先用已生成的 hi there 音频验证服务器返回；电脑麦克风录音随后接入。</div></div><div class="actions"><button id="sampleButton" type="button">发送测试 hi there</button><button id="testButton" type="button">开始音频测试</button></div></section>
    <p class="hint">管理页只允许从本机访问。当前设置只作用于运行中的 Bridge，重启后回到环境变量默认值。</p>
  </main>
  <script>
    const inputControl = document.querySelector('#audioInput');
    const outputControl = document.querySelector('#localAudio');
    const voiceChatButton = document.querySelector('#voiceChatButton');
    const voiceChatStatus = document.querySelector('#voiceChatStatus');
    const sampleButton = document.querySelector('#sampleButton');
    const testButton = document.querySelector('#testButton');
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
    let testActive = false;
    let voiceChatActive = false;
    let actionMessage = '';
    let managementSocket = null;
    let macCapture = null;
    const outputLabels = { visor_only: '仅眼镜', mac_only: '仅电脑', mac_and_visor: '电脑 + 眼镜' };
    const inputLabels = { visor: '眼镜麦克风', mac: '电脑麦克风' };
    const transportLabels = { none: '未开始采集', visor: '眼镜通道', management_page: '8787 网页通道', chromium_native: 'Chromium 原生通道' };
    const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));
    const meterWidth = (level) => Math.min(100, Math.max(0, Math.round(clamp(level.peak) * 100)));
    const showAction = (message) => { actionMessage = message; status.textContent = message; };
    const renderVoiceEvents = (events) => {
      const items = Array.isArray(events) ? events.slice(-40) : [];
      voiceEvents.replaceChildren();
      if (!items.length) {
        voiceEventStatus.textContent = '等待服务器返回';
        const empty = document.createElement('div');
        empty.className = 'hint';
        empty.textContent = '发送 hi there 或开始音频测试后，服务器识别文本和原生音频状态会显示在这里。';
        voiceEvents.append(empty);
        return;
      }
      for (const event of items) {
        const row = document.createElement('div');
        const role = event.role === 'user' ? 'user' : event.role === 'assistant' ? 'assistant' : event.type;
        row.className = 'voice-event ' + role;
        const label = document.createElement('span');
        label.className = 'voice-event-label';
        label.textContent = event.type === 'caption'
          ? (event.role === 'user' ? '我说 / 服务器识别' : '服务器回复文本')
          : event.type === 'audio_start'
            ? '服务器已返回原生音频'
            : event.type === 'audio_end'
              ? '原生音频结束'
              : 'Voice Chat 错误';
        const body = document.createElement('span');
        body.textContent = event.text || (event.type === 'audio_start' ? '正在通过 Chromium WebRTC 播放' : event.type === 'audio_end' ? '播放完成' : '未提供附加信息');
        row.append(label, body);
        voiceEvents.append(row);
      }
      voiceEventStatus.textContent = items.length + ' 条实时事件';
      voiceEvents.scrollTop = voiceEvents.scrollHeight;
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
      const phaseLabels = { starting: '正在启动 Voice Chat...', connected: 'Voice Chat 已连接，可以开始测试', stopping: '正在挂断 Voice Chat...', stopped: 'Voice Chat 已挂断', error: 'Voice Chat 失败' + (value.voiceChatError ? '：' + value.voiceChatError : '') };
      voiceChatStatus.textContent = phaseLabels[phase] || phase;
      voiceChatButton.textContent = voiceChatActive ? '挂断 Voice Chat' : '启动 Voice Chat';
      voiceChatButton.disabled = phase === 'starting' || phase === 'stopping';
      inputFill.style.width = meterWidth(input) + '%';
      outputFill.style.width = meterWidth(output) + '%';
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
      outputStatus.textContent = output.active ? '已收到返回' : '未收到返回';
      renderVoiceEvents(value.voiceEvents);
      testActive = value.testActive === true;
      sampleButton.disabled = !voiceChatActive || testActive || value.voiceTurnActive === true;
      testButton.disabled = !testActive && (!voiceChatActive || value.voiceTurnActive === true);
      testButton.dataset.active = String(testActive);
      testButton.textContent = testActive ? '停止音频测试' : '开始音频测试';
      if (!actionMessage && value.audioInputDevice) {
        showAction('输入：' + (inputLabels[inputControl.value] || inputControl.value) + '（设备：' + value.audioInputDevice + '，通道：' + (transportLabels[value.audioInputTransport] || value.audioInputTransport || '未知') + '）；输出：' + (outputLabels[outputControl.value] || outputControl.value));
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
      voiceChatStatus.textContent = starting ? '正在启动 Voice Chat...' : '正在挂断 Voice Chat...';
      try {
        const response = await fetch(starting ? '/api/voice-chat/start' : '/api/voice-chat/stop', { method: 'POST' });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'Voice Chat 控制失败');
        updateMeters(value);
      } catch (error) {
        voiceChatStatus.textContent = error.message || String(error);
        await poll();
      }
    });
    sampleButton.addEventListener('click', async () => {
      sampleButton.disabled = true;
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
        sampleButton.disabled = false;
      }
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
