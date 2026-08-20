import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { LocalAudioOutput } from "../config.js";

const AUDIO_SAMPLE_RATE = 24_000;
const START_TIMEOUT_MS = 45_000;
const PAGE_SOURCE = String.raw`<!doctype html>
<meta charset="utf-8">
<title>Codex Commander realtime transport</title>
<body>
<script>
(async () => {
  let control;
  let inputContext;
  let inputNode;
  let peerConnection;
  let remoteContext;
  let inputMonitorGain;
  let remoteMonitorGain;

  const send = (value) => {
    if (control && control.readyState === WebSocket.OPEN) {
      control.send(JSON.stringify(value));
    }
  };

  const fail = (error) => {
    const message = String(error && (error.stack || error.message) || error);
    send({ type: 'error', message });
  };

  try {
    control = new WebSocket('ws://' + location.host + '/control');
    control.binaryType = 'arraybuffer';
    control.onmessage = async (event) => {
      try {
        if (typeof event.data !== 'string') {
          if (inputNode) {
            inputNode.port.postMessage({ type: 'audio', buffer: event.data }, [event.data]);
          }
          return;
        }

        const message = JSON.parse(event.data);
        if (message.type === 'answer' && peerConnection) {
          await peerConnection.setRemoteDescription({ type: 'answer', sdp: message.sdp });
          send({ type: 'answer-set' });
        }
        if (message.type === 'local-output') {
          const mode = typeof message.mode === 'string'
            ? message.mode
            : (message.enabled === true ? 'mac_and_visor' : 'visor_only');
          const gain = mode === 'mac_only' || mode === 'mac_and_visor' ? 1 : 0;
          if (inputMonitorGain) inputMonitorGain.gain.value = 0;
          if (remoteMonitorGain) remoteMonitorGain.gain.value = gain;
        }
        if (message.type === 'close') {
          window.close();
        }
      } catch (error) {
        fail(error);
      }
    };

    await new Promise((resolve, reject) => {
      control.addEventListener('open', resolve, { once: true });
      control.addEventListener('error', () => reject(new Error('local realtime control socket failed')), { once: true });
    });

    const workletSource = [
      "class InputProcessor extends AudioWorkletProcessor {",
      "  constructor() {",
      "    super();",
      "    this.samples = [];",
      "    this.readPosition = 0;",
      "    this.step = 24000 / sampleRate;",
      "    this.port.onmessage = (event) => {",
      "      if (event.data && event.data.type === 'audio' && event.data.buffer) {",
      "        const input = new Int16Array(event.data.buffer);",
      "        for (let index = 0; index < input.length; index += 1) this.samples.push(input[index] / 32768);",
      "      }",
      "    };",
      "  }",
      "  process(inputs, outputs) {",
      "    const output = outputs[0] && outputs[0][0];",
      "    if (!output) return true;",
      "    for (let index = 0; index < output.length; index += 1) {",
      "      const sourceIndex = Math.floor(this.readPosition);",
      "      if (sourceIndex >= this.samples.length) { output[index] = 0; continue; }",
      "      const nextIndex = Math.min(sourceIndex + 1, this.samples.length - 1);",
      "      const fraction = this.readPosition - sourceIndex;",
      "      output[index] = this.samples[sourceIndex] * (1 - fraction) + this.samples[nextIndex] * fraction;",
      "      this.readPosition += this.step;",
      "    }",
      "    const removeCount = Math.floor(this.readPosition) - 8192;",
      "    if (removeCount > 0) { this.samples.splice(0, removeCount); this.readPosition -= removeCount; }",
      "    return true;",
      "  }",
      "}",
      "registerProcessor('codex-commander-input', InputProcessor);",
    ].join("\n");
    const workletUrl = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
    inputContext = new AudioContext({ sampleRate: 48000 });
    await inputContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    await inputContext.resume();

    const destination = inputContext.createMediaStreamDestination();
    inputNode = new AudioWorkletNode(inputContext, 'codex-commander-input', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    inputNode.connect(destination);
    inputMonitorGain = inputContext.createGain();
    inputMonitorGain.gain.value = 0;
    inputNode.connect(inputMonitorGain);
    inputMonitorGain.connect(inputContext.destination);

    peerConnection = new RTCPeerConnection();
    const events = peerConnection.createDataChannel('oai-events');
    events.onopen = () => send({ type: 'data-channel', state: 'open' });
    events.onmessage = (event) => send({ type: 'event', value: event.data });
    peerConnection.onconnectionstatechange = () => send({ type: 'state', state: peerConnection.connectionState });
    peerConnection.oniceconnectionstatechange = () => send({ type: 'ice-state', state: peerConnection.iceConnectionState });
    peerConnection.ontrack = async (event) => {
      try {
        if (!remoteContext) {
          remoteContext = new AudioContext({ sampleRate: 48000 });
          await remoteContext.resume();
        }
        const stream = event.streams[0] || new MediaStream([event.track]);
        const source = remoteContext.createMediaStreamSource(stream);
        const processor = remoteContext.createScriptProcessor(4096, 2, 1);
        processor.onaudioprocess = (audioEvent) => {
          const buffer = audioEvent.inputBuffer;
          const frames = buffer.length;
          const channels = buffer.numberOfChannels;
          const output = new Int16Array(frames);
          for (let frame = 0; frame < frames; frame += 1) {
            let sample = 0;
            for (let channel = 0; channel < channels; channel += 1) sample += buffer.getChannelData(channel)[frame] || 0;
            sample /= Math.max(1, channels);
            output[frame] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
          }
          control.send(output.buffer);
        };
        source.connect(processor);
        remoteMonitorGain = remoteContext.createGain();
        remoteMonitorGain.gain.value = 0;
        processor.connect(remoteMonitorGain);
        remoteMonitorGain.connect(remoteContext.destination);
        send({ type: 'remote-sample-rate', sampleRate: remoteContext.sampleRate });
        send({ type: 'remote-track' });
      } catch (error) {
        fail(error);
      }
    };

    peerConnection.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    if (peerConnection.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const finish = () => {
          if (peerConnection.iceGatheringState === 'complete') {
            peerConnection.removeEventListener('icegatheringstatechange', finish);
            resolve();
          }
        };
        peerConnection.addEventListener('icegatheringstatechange', finish);
        finish();
      });
    }
    send({ type: 'offer', sdp: peerConnection.localDescription && peerConnection.localDescription.sdp });
  } catch (error) {
    fail(error);
  }
})();
</script>`;

export interface ChromiumRealtimeHost {
  requestJsonRpc<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export class ChromiumRealtimeSession extends EventEmitter {
  private httpServer?: Server;
  private socketServer?: WebSocketServer;
  private socket?: WebSocket;
  private chrome?: ChildProcess;
  private profileDir?: string;
  private threadId?: string;
  private remoteSampleRate = 48_000;
  private offerRequested = false;
  private connected = false;
  private pendingSdp?: string;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;

  public constructor(
    private readonly host: ChromiumRealtimeHost,
    private readonly logger: any,
    localAudioOutput: LocalAudioOutput = "visor_only"
  ) {
    super();
    this.localAudioOutput = localAudioOutput;
  }

  private localAudioOutput: LocalAudioOutput = "visor_only";

  public async start(threadId: string): Promise<void> {
    await this.close();
    this.threadId = threadId;
    this.remoteSampleRate = 48_000;
    this.offerRequested = false;
    this.connected = false;

    const started = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    void started.catch(() => undefined);
    const timeout = setTimeout(() => this.failStart(new Error('Chromium realtime page did not connect in time')), START_TIMEOUT_MS);

    try {
      await this.openLocalPage();
      await started;
    } catch (error) {
      this.failStart(asError(error));
      await this.close();
      throw asError(error);
    } finally {
      clearTimeout(timeout);
      this.resolveStart = undefined;
      this.rejectStart = undefined;
    }
  }

  public appendInput(audio: Buffer): void {
    if (audio.length === 0) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.logger?.warn?.('native realtime input dropped because Chromium is not connected');
      return;
    }
    this.socket.send(audio);
  }

  public setLocalAudioOutput(output: LocalAudioOutput): void {
    this.localAudioOutput = output;
    this.sendJson({ type: 'local-output', mode: output });
  }

  public handleNotification(notification: unknown): void {
    const record = asRecord(notification);
    if (record?.method !== 'thread/realtime/sdp') return;
    const params = asRecord(record.params);
    if (typeof params?.threadId === 'string' && params.threadId !== this.threadId) return;
    const sdp = findSdp(params);
    if (sdp) {
      this.pendingSdp = sdp;
      this.sendJson({ type: 'answer', sdp });
    }
  }

  public async close(): Promise<void> {
    this.connected = false;
    this.offerRequested = false;
    this.pendingSdp = undefined;

    const reject = this.rejectStart;
    this.resolveStart = undefined;
    this.rejectStart = undefined;
    if (reject) reject(new Error('native realtime session closed'));

    const socket = this.socket;
    this.socket = undefined;
    socket?.close();

    const socketServer = this.socketServer;
    this.socketServer = undefined;
    if (socketServer) {
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    }

    const httpServer = this.httpServer;
    this.httpServer = undefined;
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }

    const chrome = this.chrome;
    this.chrome = undefined;
    if (chrome && !chrome.killed) chrome.kill('SIGTERM');

    const profileDir = this.profileDir;
    this.profileDir = undefined;
    if (profileDir) await rm(profileDir, { recursive: true, force: true });

    this.threadId = undefined;
  }

  private async openLocalPage(): Promise<void> {
    const httpServer = createServer((request, response) => {
      if (request.url === '/' || request.url?.startsWith('/?')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(PAGE_SOURCE);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const socketServer = new WebSocketServer({ server: httpServer, path: '/control' });
    socketServer.on('connection', (socket) => this.attachSocket(socket));
    this.httpServer = httpServer;
    this.socketServer = socketServer;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(0, '127.0.0.1');
    });

    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to allocate local Chromium realtime port');
    const profileDir = await mkdtemp(join(tmpdir(), 'codex-commander-chrome-'));
    this.profileDir = profileDir;
    const chromePath = findChrome();
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${profileDir}`,
      `http://127.0.0.1:${address.port}/`,
    ];
    const chrome = spawn(chromePath, args, { stdio: 'ignore' });
    this.chrome = chrome;
    chrome.once('error', (error) => this.failStart(error));
    chrome.once('exit', (code, signal) => {
      if (!this.connected) this.failStart(new Error(`Chromium exited before realtime connection (${code ?? signal ?? 'unknown'})`));
    });
  }

  private attachSocket(socket: WebSocket): void {
    this.socket?.close();
    this.socket = socket;
    socket.binaryType = 'nodebuffer';
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.onRemoteAudio(rawToBuffer(raw));
        return;
      }
      this.onPageMessage(rawToBuffer(raw).toString('utf8'));
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.connected) this.failStart(new Error('Chromium realtime control socket closed'));
    });
    socket.on('error', () => {
      if (!this.connected) this.failStart(new Error('Chromium realtime control socket failed'));
    });
    if (this.pendingSdp) {
      const sdp = this.pendingSdp;
      this.sendJson({ type: 'answer', sdp });
    }
    this.sendJson({ type: 'local-output', mode: this.localAudioOutput });
  }

  private onPageMessage(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.logger?.warn?.('invalid message from native Chromium realtime page');
      return;
    }
    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'offer') {
      const sdp = typeof message.sdp === 'string' ? message.sdp : undefined;
      if (sdp) void this.handleOffer(sdp);
      return;
    }
    if (type === 'remote-sample-rate' && typeof message.sampleRate === 'number' && message.sampleRate > 0) {
      this.remoteSampleRate = message.sampleRate;
      return;
    }
    if (type === 'state' && message.state === 'connected') {
      this.connected = true;
      this.resolveStart?.();
      return;
    }
    if (type === 'error') {
      const messageText = typeof message.message === 'string' ? message.message : 'native Chromium realtime page failed';
      this.failStart(new Error(messageText));
    }
  }

  private async handleOffer(sdp: string): Promise<void> {
    if (this.offerRequested || !this.threadId) return;
    this.offerRequested = true;
    try {
      const result = await this.host.requestJsonRpc('thread/realtime/start', {
        includeStartupContext: false,
        flushTranscriptTailOnSessionEnd: true,
        codexResponseHandoffPrefix: '',
        threadId: this.threadId,
        codexResponsesAsItems: false,
        codexResponseItemPrefix: null,
        initialItems: [],
        outputModality: 'audio',
        realtimeSessionId: randomUUID(),
        version: 'v3',
        transport: { type: 'webrtc', sdp },
        voice: 'juniper',
      });
      this.acceptSdp(result);
    } catch (error) {
      const normalized = asError(error);
      this.sendJson({ type: 'error', message: normalized.message });
      this.failStart(normalized);
    }
  }

  private acceptSdp(value: unknown): void {
    const sdp = findSdp(value);
    if (!sdp) return;
    this.pendingSdp = sdp;
    this.sendJson({ type: 'answer', sdp });
  }

  private sendJson(value: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(value));
  }

  private onRemoteAudio(audio: Buffer): void {
    const sampleCount = Math.floor(audio.length / 2);
    if (sampleCount <= 0) return;
    if (this.remoteSampleRate === AUDIO_SAMPLE_RATE) {
      this.emit('audio', audio.subarray(0, sampleCount * 2));
      return;
    }
    const outputCount = Math.max(1, Math.floor(sampleCount * AUDIO_SAMPLE_RATE / this.remoteSampleRate));
    const output = Buffer.alloc(outputCount * 2);
    for (let index = 0; index < outputCount; index += 1) {
      const sourceIndex = Math.min(sampleCount - 1, Math.floor(index * this.remoteSampleRate / AUDIO_SAMPLE_RATE));
      output.writeInt16LE(audio.readInt16LE(sourceIndex * 2), index * 2);
    }
    this.emit('audio', output);
  }

  private failStart(error: Error): void {
    const reject = this.rejectStart;
    this.resolveStart = undefined;
    this.rejectStart = undefined;
    if (reject) reject(error);
  }
}

function findChrome(): string {
  const candidates = [
    process.env.COMMANDER_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((candidate): candidate is string => Boolean(candidate));
  const chrome = candidates.find((candidate) => existsSync(candidate));
  if (!chrome) throw new Error('Google Chrome or Chromium is required for native realtime audio');
  return chrome;
}

function rawToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
  if (Array.isArray(raw)) return Buffer.concat(raw.map((part) => rawToBuffer(part)));
  return Buffer.from(raw as Uint8Array);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function findSdp(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['sdp', 'answerSdp']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  for (const key of ['answer', 'transport', 'payload', 'result', 'data']) {
    const nested = findSdp(record[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
