import type {
  ClientControlMessage,
  ImageCard,
  ServerControlMessage
} from "@codex-commander/protocol";
import { CLIENT_AUDIO_FRAME, decodeBinaryFrame, encodeBinaryFrame, SERVER_AUDIO_FRAME } from "@codex-commander/protocol";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { AudioInputSource, BridgeConfig, LocalAudioOutput } from "../config.js";
import { CodexController } from "../codex/CodexController.js";
import type { Logger } from "../log.js";
import { ImageService } from "../media/ImageService.js";
import { PairingStore, type PairingSnapshot } from "../security/PairingStore.js";
import { createVoiceClient } from "../voice/createVoiceClient.js";
import { measurePcm16, type AudioLevel } from "../voice/AudioDiagnostics.js";
import { VoiceClientError, type CommanderVoice } from "../voice/types.js";
import { EventJournal, RequestDeduplicator } from "./EventJournal.js";

export type BridgeTransport = {
  id: string;
  sendControl(message: ServerControlMessage): void;
  sendBinary(frame: Uint8Array): void;
  close(code: number, reason: string): void;
};

type ClientSession = {
  transport: BridgeTransport;
  authenticated: boolean;
  deviceId?: string;
  pttActive: boolean;
};

export class CommanderBridge {
  private readonly pairing: PairingStore;
  private readonly codex: CodexController;
  private readonly images: ImageService;
  private readonly voice: CommanderVoice;
  private readonly journal = new EventJournal();
  private readonly dedupe = new RequestDeduplicator();
  private readonly imageCards: ImageCard[] = [];
  private readonly sessions = new Map<string, ClientSession>();
  private audioResponseActive = false;
  private ready = false;
  private localAudioOutput: LocalAudioOutput;
  private audioInputSource: AudioInputSource;
  private inputLevel: AudioLevel = { rms: 0, peak: 0, active: false };
  private outputLevel: AudioLevel = { rms: 0, peak: 0, active: false };
  private inputLevelAt = 0;
  private outputLevelAt = 0;
  private diagnosticInputActive = false;
  private voiceChatActive = false;
  private voiceChatPhase: "starting" | "connected" | "stopping" | "stopped" | "error" = "stopped";
  private voiceChatError?: string;
  private audioInputDeviceLabel?: string;

  constructor(
    private readonly config: BridgeConfig,
    mediaOutputRoot: string,
    private readonly logger: Logger
  ) {
    this.localAudioOutput = config.audio.localOutput;
    this.audioInputSource = config.audio.inputSource;
    this.pairing = new PairingStore(config.pairingFile);
    this.codex = new CodexController(config, logger);
    this.images = new ImageService(config.mediaRoots, mediaOutputRoot);
    this.voice = createVoiceClient(
      config,
      this.codex,
      this.images,
      (image) => this.publishImage(image),
      logger
    );

    this.codex.on("taskEvent", (event) => {
      this.logger.info("Codex task event", {
        phase: event.phase,
        final: event.final,
        message: event.message,
      });
      this.broadcast(this.journal.create({ type: "task_event", ...event }));
    });
    this.codex.on("approvalRequested", (approval) => this.broadcast(this.journal.create({ type: "approval_request", approval })));
    this.codex.on("approvalResolved", (approvalRequestId, resolution) => {
      this.broadcast(this.journal.create({ type: "approval_resolved", approvalRequestId, resolution }));
    });
    this.codex.on("imageFound", (path, title) => {
      void this.images.prepare(path, title).then((image) => this.publishImage(image)).catch((error) => {
        this.logger.warn("Could not prepare Codex image", error instanceof Error ? error.message : String(error));
      });
    });

    this.voice.on("audio", (audio: Buffer) => {
      if ([...this.sessions.values()].some((session) => session.pttActive)) return;
      if (this.localAudioOutput === "mac_only") return;
      if (!this.audioResponseActive) {
        this.audioResponseActive = true;
        this.broadcast(this.journal.create({
          type: "assistant_audio_start",
          sampleRate: 24_000,
          channels: 1,
          encoding: "pcm16le"
        }, false));
      }
      this.broadcastBinary(encodeBinaryFrame(SERVER_AUDIO_FRAME, audio));
    });
    this.voice.on("inputLevel", (level: AudioLevel) => {
      this.inputLevel = level;
      this.inputLevelAt = Date.now();
    });
    this.voice.on("outputLevel", (level: AudioLevel) => {
      this.outputLevel = level;
      this.outputLevelAt = Date.now();
    });
    this.voice.on("inputDevice", (label: string) => {
      this.audioInputDeviceLabel = label;
      this.logger.info("Audio input device selected", { label });
    });
    this.voice.on("audioEnd", (transcript: string) => {
      if (!this.audioResponseActive) return;
      this.audioResponseActive = false;
      this.broadcast(this.journal.create({ type: "assistant_audio_end", ...(transcript ? { transcript } : {}) }, false));
    });
    this.voice.on("caption", (role: "user" | "assistant", text: string) => {
      this.broadcast(this.journal.create({ type: "caption", role, text }, false));
    });
    this.voice.on("error", (error: Error) => {
      this.broadcast(this.journal.create({ type: "assistant_audio_end" }, false));
      this.audioResponseActive = false;
      if (!(error instanceof VoiceClientError) || error.code === "realtime_unavailable" || error.code === "realtime_error") {
        this.voiceChatActive = false;
        this.voiceChatPhase = "error";
        this.voiceChatError = error.message;
      }
      this.broadcastError(error instanceof VoiceClientError ? error.code : "realtime_error", error.message, true);
    });
  }

  async start(): Promise<PairingSnapshot> {
    const pairing = await this.pairing.initialize();
    if (!this.voice.isConfigured()) {
      throw new Error("语音引擎未配置；Core realtime 需要可用的 Codex app-server");
    }
    await this.codex.start();
    this.voiceChatPhase = "starting";
    try {
      await this.voice.probeRealtime();
      this.voiceChatActive = true;
      this.voiceChatPhase = "connected";
      this.voiceChatError = undefined;
      this.logger.info("Core realtime session ready");
    } catch (error) {
      this.voiceChatActive = false;
      this.voiceChatPhase = "error";
      this.voiceChatError = error instanceof Error ? error.message : String(error);
      await this.codex.stop().catch(() => undefined);
      throw error;
    }
    this.ready = true;
    return pairing;
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.diagnosticInputActive = false;
    this.voiceChatActive = false;
    this.voiceChatPhase = "stopped";
    this.voice.close();
    for (const session of this.sessions.values()) session.transport.close(1001, "bridge stopping");
    this.sessions.clear();
    await this.codex.stop();
  }

  isReady(): boolean { return this.ready; }
  getPairingSnapshot(): PairingSnapshot { return this.pairing.snapshot(); }
  validateMediaToken(deviceId: string, token: string): boolean { return this.pairing.isTokenValid(deviceId, token); }
  getLocalAudioOutput(): LocalAudioOutput { return this.localAudioOutput; }
  getAudioInputSource(): AudioInputSource { return this.audioInputSource; }
  getAudioDiagnostics(): Record<string, unknown> {
    const now = Date.now();
    return {
      audioInputSource: this.audioInputSource,
      audioInputDevice: this.audioInputDeviceLabel || null,
      localAudioOutput: this.localAudioOutput,
      voiceChatActive: this.voiceChatActive,
      voiceChatPhase: this.voiceChatPhase,
      voiceChatError: this.voiceChatError || null,
      testActive: this.diagnosticInputActive,
      visorConnected: [...this.sessions.values()].some((session) => session.authenticated),
      input: now - this.inputLevelAt < 600 ? this.inputLevel : { rms: 0, peak: 0, active: false },
      output: now - this.outputLevelAt < 600 ? this.outputLevel : { rms: 0, peak: 0, active: false },
    };
  }
  setAudioInputSource(source: AudioInputSource): void {
    this.audioInputSource = source;
    this.inputLevelAt = 0;
    this.voice.setAudioInputSource?.(source);
    this.logger.info("Audio input source updated", { source });
  }
  setLocalAudioOutput(output: LocalAudioOutput): void {
    const previous = this.localAudioOutput;
    this.localAudioOutput = output;
    this.voice.setLocalAudioOutput?.(output);
    if (output === "mac_only" && previous !== output && this.audioResponseActive) {
      this.audioResponseActive = false;
      this.broadcast(this.journal.create({ type: "assistant_audio_end" }, false));
    }
    this.logger.info("Audio output mode updated", { output });
  }

  async startVoiceChat(): Promise<void> {
    if (this.voiceChatActive) return;
    if (!this.voice.startSession) {
      throw new BridgeError("voice_control_unavailable", "当前 Voice Chat 客户端不支持启动控制", true);
    }
    this.voiceChatPhase = "starting";
    this.voiceChatError = undefined;
    try {
      await this.voice.startSession();
      this.voiceChatActive = true;
      this.voiceChatPhase = "connected";
      this.logger.info("Voice Chat master switch started");
    } catch (error) {
      this.voiceChatActive = false;
      this.voiceChatPhase = "error";
      this.voiceChatError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stopVoiceChat(): Promise<void> {
    if (!this.voiceChatActive && this.voiceChatPhase === "stopped") return;
    if (!this.voice.stopSession) {
      throw new BridgeError("voice_control_unavailable", "当前 Voice Chat 客户端不支持挂断控制", true);
    }
    this.voiceChatPhase = "stopping";
    this.voiceChatError = undefined;
    try {
      await this.voice.stopSession();
      this.voiceChatActive = false;
      this.voiceChatPhase = "stopped";
      this.diagnosticInputActive = false;
      this.logger.info("Voice Chat master switch stopped");
    } catch (error) {
      this.voiceChatPhase = "error";
      this.voiceChatError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async startAudioTest(): Promise<void> {
    if (!this.voiceChatActive) {
      throw new BridgeError("voice_chat_inactive", "请先启动 Voice Chat，再开始音频测试", true);
    }
    if (this.diagnosticInputActive) return;
    if ([...this.sessions.values()].some((session) => session.pttActive)) {
      throw new BridgeError("ptt_active", "眼镜正在录音，请先结束眼镜 PTT", true);
    }
    if (!this.voice.setAudioInputSource || !this.voice.setInputActive) {
      throw new BridgeError("audio_test_unavailable", "当前语音客户端不支持可切换音频输入", true);
    }
    this.voice.setAudioInputSource(this.audioInputSource);
    await this.voice.beginInput();
    this.diagnosticInputActive = true;
    this.logger.info("Audio diagnostic test started", { input: this.audioInputSource, output: this.localAudioOutput });
  }

  async stopAudioTest(): Promise<void> {
    if (!this.diagnosticInputActive) return;
    try {
      await this.voice.endInput();
    } finally {
      this.diagnosticInputActive = false;
    }
    this.logger.info("Audio diagnostic test stopped");
  }

  async sendAudioTestSample(): Promise<void> {
    if (!this.voiceChatActive) {
      throw new BridgeError("voice_chat_inactive", "请先启动 Voice Chat，再发送测试音频", true);
    }
    if (this.diagnosticInputActive) throw new BridgeError("audio_test_active", "音频测试已经在进行", true);
    if ([...this.sessions.values()].some((session) => session.pttActive)) {
      throw new BridgeError("ptt_active", "眼镜正在录音，请先结束眼镜 PTT", true);
    }
    if (!this.voice.setAudioInputSource || !this.voice.setInputActive) {
      throw new BridgeError("audio_test_unavailable", "当前语音客户端不支持可切换音频输入", true);
    }

    const audio = padProbeAudio(parseProbeWav(await readFile(PROBE_AUDIO_PATH)));
    this.voice.setAudioInputSource(this.audioInputSource);
    await this.voice.beginInput();
    this.diagnosticInputActive = true;
    this.logger.info("Audio probe sample started", { input: this.audioInputSource, bytes: audio.byteLength });
    try {
      for (let offset = 0; offset < audio.byteLength; offset += PROBE_FRAME_BYTES) {
        const frame = audio.subarray(offset, Math.min(offset + PROBE_FRAME_BYTES, audio.byteLength));
        this.inputLevel = measurePcm16(frame);
        this.inputLevelAt = Date.now();
        this.voice.appendInput(frame);
        await delay(Math.max(1, Math.round(frame.byteLength / 48)));
      }
      await this.voice.endInput();
    } finally {
      this.diagnosticInputActive = false;
    }
    this.logger.info("Audio probe sample stopped");
  }

  async resetPairing(): Promise<PairingSnapshot> {
    if ([...this.sessions.values()].some((session) => session.pttActive)) this.voice.abortInput();
    const snapshot = await this.pairing.reset();
    for (const session of this.sessions.values()) {
      if (session.authenticated) session.transport.close(4002, "pairing reset");
    }
    this.sessions.clear();
    return snapshot;
  }

  attach(transport: BridgeTransport): void {
    this.sessions.set(transport.id, { transport, authenticated: false, pttActive: false });
  }

  detach(transportId: string): void {
    const session = this.sessions.get(transportId);
    if (session?.pttActive) this.voice.abortInput();
    this.sessions.delete(transportId);
  }

  async handleControl(transportId: string, message: ClientControlMessage): Promise<void> {
    const session = this.sessions.get(transportId);
    if (!session) return;

    if (message.type === "hello") {
      await this.authenticate(session, message);
      return;
    }
    if (!session.authenticated) throw new BridgeError("not_authenticated", "必须先发送 hello 完成认证", false);
    if (this.dedupe.isDuplicate(message.requestId)) return;

    switch (message.type) {
      case "state_sync":
        for (const event of this.journal.after(message.lastEventId)) session.transport.sendControl(event);
        await this.sendStateSync(session);
        break;
      case "ptt_start":
        if (this.diagnosticInputActive) throw new BridgeError("audio_test_active", "电脑音频测试正在进行", true);
        if (session.pttActive) throw new BridgeError("ptt_already_active", "PTT 已经处于录音状态", true);
        if (this.audioResponseActive) {
          this.audioResponseActive = false;
          this.broadcast(this.journal.create({ type: "assistant_audio_end" }, false));
        }
        session.pttActive = true;
        try {
          await this.voice.beginInput();
        } catch (error) {
          session.pttActive = false;
          this.voice.abortInput();
          if (error instanceof VoiceClientError) throw new BridgeError(error.code, error.message, true);
          throw error;
        }
        break;
      case "ptt_end":
        if (!session.pttActive) break;
        session.pttActive = false;
        try {
          await this.voice.endInput();
        } catch (error) {
          if (error instanceof VoiceClientError) throw new BridgeError(error.code, error.message, true);
          throw error;
        }
        break;
      case "task_select":
        await this.codex.selectThread(message.threadId);
        await this.sendStateSync(session);
        break;
      case "task_command":
        await this.codex.sendCommand(message.text, message.threadId);
        break;
      case "task_interrupt":
        await this.codex.interrupt(message.threadId);
        break;
      case "approval_decision":
        this.codex.resolveApproval(message.approvalRequestId, message.decision);
        break;
      case "report_request": {
        const summary = this.codex.getLatestFinal();
        if (!summary) throw new BridgeError("no_summary", "当前没有可播报的完成汇报", true);
        await this.voice.speakSummary(summary);
        break;
      }
      case "image_request":
        this.publishImage(await this.images.prepare(message.path, message.title));
        break;
      case "ping":
        session.transport.sendControl(this.journal.create({ type: "pong", requestId: message.requestId, echoedSentAt: message.sentAt }, false));
        break;
    }
  }

  handleBinary(transportId: string, frame: Uint8Array): void {
    const session = this.sessions.get(transportId);
    if (!session?.authenticated || !session.pttActive) return;
    const decoded = decodeBinaryFrame(frame);
    if (decoded.kind !== CLIENT_AUDIO_FRAME) throw new BridgeError("bad_audio_frame", "未知的音频帧类型", true);
    if (decoded.payload.byteLength > MAX_AUDIO_FRAME_BYTES) {
      throw new BridgeError("bad_audio_frame", "音频帧超过允许大小", true);
    }
    if (this.audioInputSource !== "visor") return;
    this.inputLevel = measurePcm16(decoded.payload);
    this.inputLevelAt = Date.now();
    this.voice.appendInput(decoded.payload);
  }

  sendError(transportId: string, error: unknown, requestId?: string): void {
    const session = this.sessions.get(transportId);
    if (!session) return;
    const bridgeError = error instanceof BridgeError
      ? error
      : error instanceof VoiceClientError
        ? new BridgeError(error.code, error.message, true)
        : new BridgeError("internal_error", error instanceof Error ? error.message : String(error), true);
    session.transport.sendControl(this.journal.create({
      type: "error",
      code: bridgeError.code,
      message: bridgeError.message,
      recoverable: bridgeError.recoverable,
      ...(requestId ? { requestId } : {})
    }, false));
    if (!bridgeError.recoverable) session.transport.close(1008, bridgeError.code);
  }

  private async authenticate(session: ClientSession, hello: Extract<ClientControlMessage, { type: "hello" }>): Promise<void> {
    if (session.authenticated) throw new BridgeError("already_authenticated", "连接已经认证", false);
    let deviceToken: string | undefined;
    const authenticated = hello.token
      ? this.pairing.isTokenValid(hello.deviceId, hello.token)
      : Boolean((deviceToken = await this.pairing.pair(hello.deviceId, hello.pairingCode!)));
    if (!authenticated) {
      const snapshot = this.pairing.snapshot();
      if (!snapshot.pairedDeviceId && snapshot.code !== "already paired") {
        this.logger.warn("Pairing attempt failed; current pairing code", {
          pairingCode: snapshot.code,
          pairingExpiresAt: snapshot.expiresAt
        });
      }
      throw new BridgeError("authentication_failed", "配对码或设备令牌无效", false);
    }

    for (const [id, existing] of this.sessions) {
      if (id !== session.transport.id && existing.authenticated && existing.deviceId === hello.deviceId) {
        if (existing.pttActive) this.voice.abortInput();
        existing.transport.close(4001, "newer device connection");
        this.sessions.delete(id);
      }
    }
    session.authenticated = true;
    session.deviceId = hello.deviceId;
    this.logger.info("AIR3 authenticated", { pairing: deviceToken ? "new" : "saved_token" });
    session.transport.sendControl(this.journal.create({
      type: "hello_ack",
      requestId: hello.requestId,
      ...(deviceToken ? { deviceToken } : {}),
      bridgeVersion: "0.1.0",
      audioSampleRate: 24_000
    }, false));
    for (const event of this.journal.after(hello.lastEventId)) session.transport.sendControl(event);
    await this.sendStateSync(session);
  }

  private async sendStateSync(session: ClientSession): Promise<void> {
    session.transport.sendControl(this.journal.create({
      type: "state_sync",
      selectedThreadId: this.codex.getSelectedThreadId(),
      activeTurnId: this.codex.getActiveTurnId(),
      threads: await this.codex.listThreads(),
      pendingApproval: this.codex.getPendingApproval(),
      latestSummary: this.codex.getLatestFinal() || null,
      images: this.imageCards
    }, false));
  }

  private publishImage(image: ImageCard): void {
    const existing = this.imageCards.findIndex((candidate) => candidate.id === image.id);
    if (existing >= 0) this.imageCards.splice(existing, 1);
    this.imageCards.unshift(image);
    if (this.imageCards.length > 20) this.imageCards.length = 20;
    this.broadcast(this.journal.create({ type: "image_card", image }));
  }

  private broadcast(message: ServerControlMessage): void {
    for (const session of this.sessions.values()) if (session.authenticated) session.transport.sendControl(message);
  }

  private broadcastBinary(frame: Uint8Array): void {
    for (const session of this.sessions.values()) if (session.authenticated) session.transport.sendBinary(frame);
  }

  private broadcastError(code: string, message: string, recoverable: boolean): void {
    this.broadcast(this.journal.create({ type: "error", code, message, recoverable }, false));
  }
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable: boolean
  ) {
    super(message);
  }
}

const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
const PROBE_AUDIO_PATH = fileURLToPath(new URL("../../data/probe-hi-there-24k-mono.wav", import.meta.url));
const PROBE_FRAME_BYTES = 24_000 * 2 * 40 / 1_000;

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function parseProbeWav(buffer: Buffer): Uint8Array {
  if (buffer.byteLength < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("probe hi there 音频不是有效 WAV");
  }
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let audio: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.byteLength) throw new Error("probe hi there WAV 数据不完整");
    if (chunkId === "fmt " && chunkSize >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    } else if (chunkId === "data") {
      audio = buffer.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkSize % 2);
  }
  if (!format || format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 24_000 || format.bitsPerSample !== 16) {
    throw new Error("probe hi there WAV 必须是 24 kHz 单声道 PCM16");
  }
  if (!audio?.byteLength) throw new Error("probe hi there WAV 没有音频数据");
  return audio;
}

function padProbeAudio(audio: Uint8Array): Buffer {
  const bytesPerMs = 24_000 * 2 / 1_000;
  const minimumBytes = Math.floor(600 * bytesPerMs);
  const body = audio.byteLength < minimumBytes
    ? Buffer.concat([Buffer.from(audio), Buffer.alloc(minimumBytes - audio.byteLength)])
    : Buffer.from(audio);
  return Buffer.concat([
    Buffer.alloc(Math.floor(200 * bytesPerMs)),
    body,
    Buffer.alloc(Math.floor(200 * bytesPerMs))
  ]);
}
