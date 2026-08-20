//#region 导入/依赖
import { EventEmitter } from "node:events";

import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE } from "@codex-commander/protocol";

import type { CodexNotification } from "../codex/CodexAppServerClient.js";
import type { AudioInputSource, LocalAudioOutput } from "../config.js";
import type { Logger } from "../log.js";
import { sanitizeForVisor } from "../privacy/VisorText.js";
import { CaptionLog, type CaptionRole } from "./CaptionLog.js";
import { ChromiumRealtimeSession } from "./ChromiumRealtimeSession.js";
import { measurePcm16 } from "./AudioDiagnostics.js";
import { RealtimeSessionOrchestrator } from "./RealtimeSessionOrchestrator.js";
import { MIN_INPUT_AUDIO_BYTES, VoiceClientError } from "./types.js";
//#endregion

//#region 常量/配置
const OUTPUT_IDLE_MS = 420;
const APPEND_TIMEOUT_MS = 8_000;
const START_TIMEOUT_MS = 45_000;
const END_SILENCE_MS = 700;
const REPLY_TIMEOUT_MS = 20_000;
//#endregion

//#region 模型/类型
export type CodexRealtimeHost = {
  ensureSelectedThread(): Promise<string>;
  startVoiceThread(): Promise<string>;
  requestJsonRpc<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  subscribeNotifications(listener: (notification: CodexNotification) => void): () => void;
};

type RealtimeAudioChunk = {
  data?: unknown;
  sampleRate?: unknown;
  numChannels?: unknown;
  samplesPerChannel?: unknown;
};
//#endregion

//#region 公开 API
export class CodexRealtimeVoiceClient extends EventEmitter {
  private unsubscribe?: () => void;
  private threadId: string | null = null;
  private sessionActive = false;
  private inputStarted = false;
  private inputBytes = 0;
  private appendChain: Promise<void> = Promise.resolve();
  private outputIdle?: NodeJS.Timeout;
  private outputStarted = false;
  private inputItemId: string | null = null;
  private waitingForReply = false;
  private sessionFailure: string | null = null;
  private replyTimer?: NodeJS.Timeout;
  private inputHadSignal = false;
  private readonly pending: Buffer[] = [];
  private readonly captions = new CaptionLog();
  private readonly orchestrator: RealtimeSessionOrchestrator;
  private readonly chromiumSession: ChromiumRealtimeSession;
  private sessionReset?: Promise<void>;
  private outputAudioFrames = 0;

  constructor(
    private readonly host: CodexRealtimeHost,
    private readonly logger: Logger,
    localAudioOutput: LocalAudioOutput = "visor_only",
    audioInputSource: AudioInputSource = "visor"
  ) {
    super();
    this.orchestrator = new RealtimeSessionOrchestrator({
      logger,
      appendSpeech: (text) => this.speakSummary(text),
      restartSession: () => this.restartSession()
    });
    this.chromiumSession = new ChromiumRealtimeSession(host, logger, localAudioOutput, audioInputSource);
    this.chromiumSession.on("audio", (pcm: Buffer) => {
      this.onOutputAudio({
        data: pcm.toString("base64"),
        sampleRate: AUDIO_SAMPLE_RATE,
        numChannels: AUDIO_CHANNELS,
        samplesPerChannel: pcm.length / 2
      });
    });
    this.chromiumSession.on("inputLevel", (level) => {
      if (level.active) this.inputHadSignal = true;
      this.emit("inputLevel", level);
    });
    this.chromiumSession.on("outputLevel", (level) => this.emit("outputLevel", level));
    this.chromiumSession.on("inputDevice", (label) => this.emit("inputDevice", label));
    this.unsubscribe = host.subscribeNotifications((notification) => this.handleNotification(notification));
  }

  isConfigured(): boolean {
    return true;
  }

  setLocalAudioOutput(output: LocalAudioOutput): void {
    this.chromiumSession.setLocalAudioOutput(output);
  }

  setAudioInputSource(source: AudioInputSource): void {
    this.chromiumSession.setAudioInputSource(source);
  }

  setInputActive(active: boolean): void {
    this.chromiumSession.setInputActive(active);
  }

  async probeRealtime(): Promise<void> {
    await this.ensureSession();
    this.orchestrator.markActive();
  }

  async startSession(): Promise<void> {
    await this.ensureSession();
    this.orchestrator.markActive();
  }

  async stopSession(): Promise<void> {
    this.abortInput();
    this.clearWaitingForReply();
    this.finishOutput();

    const threadId = this.threadId;
    this.sessionActive = false;
    this.orchestrator.markIdle();
    if (threadId) {
      await this.host.requestJsonRpc("thread/realtime/stop", { threadId }).catch((error) => {
        this.logger.warn("Codex realtime stop request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    await this.chromiumSession.close();
    this.logger.info("Codex realtime session stopped by Voice Chat master switch");
  }

  async beginInput(): Promise<void> {
    if (this.sessionReset) await this.sessionReset;
    this.inputStarted = true;
    this.inputBytes = 0;
    this.inputHadSignal = false;
    this.outputAudioFrames = 0;
    this.pending.length = 0;
    this.appendChain = Promise.resolve();
    this.inputItemId = crypto.randomUUID();
    this.captions.beginUserTurn();
    await this.ensureSession();
    this.chromiumSession.setInputActive(true);
    for (const chunk of this.pending) this.enqueueAppend(chunk);
    this.pending.length = 0;
  }

  appendInput(pcm16le: Uint8Array): void {
    if (!this.inputStarted || pcm16le.byteLength === 0) return;
    this.inputBytes += pcm16le.byteLength;
    const audio = Buffer.from(pcm16le);
    if (!this.threadId || !this.sessionActive) {
      this.pending.push(audio);
      return;
    }
    this.enqueueAppend(audio);
  }

  async endInput(): Promise<void> {
    if (!this.inputStarted) throw new VoiceClientError("ptt_not_active", "当前没有正在录音的语音");
    this.inputStarted = false;
    try {
      await this.appendChain.catch(() => undefined);
      if (this.inputBytes < MIN_INPUT_AUDIO_BYTES && !this.inputHadSignal) {
        this.inputItemId = null;
        throw new VoiceClientError("ptt_too_short", "说话时间太短，请再说一次");
      }
      if (!this.sessionActive) {
        throw new VoiceClientError("realtime_unavailable", voiceUnavailableMessage(this.sessionFailure));
      }
      this.enqueueAppend(silenceFrame(END_SILENCE_MS));
      await this.appendChain.catch(async (error) => {
        await this.orchestrator.recoverFromAppendFailure().catch(() => undefined);
        throw error;
      });
      await wait(END_SILENCE_MS);
      this.chromiumSession.setInputActive(false);
      if (!this.sessionActive) {
        throw new VoiceClientError("realtime_unavailable", voiceUnavailableMessage(this.sessionFailure));
      }
      this.armReplyTimeout();
      this.logger.info("Codex Voice Chat PTT ended; waiting for reply");
    } catch (error) {
      this.chromiumSession.setInputActive(false);
      throw error;
    }
  }

  abortInput(): void {
    this.inputStarted = false;
    this.chromiumSession.setInputActive(false);
    this.clearWaitingForReply();
    this.inputBytes = 0;
    this.inputHadSignal = false;
    this.inputItemId = null;
    this.pending.length = 0;
  }

  async speakSummary(summary: string): Promise<void> {
    const spoken = sanitizeForVisor(summary, 16_000);
    if (!spoken) return;
    await this.ensureSession();
    this.emitCaption("assistant", this.captions.complete("assistant", spoken));
    await this.host.requestJsonRpc("thread/realtime/appendSpeech", {
      threadId: this.threadId,
      text: spoken
    }, APPEND_TIMEOUT_MS);
  }

  close(): void {
    this.abortInput();
    this.finishOutput();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const threadId = this.threadId;
    this.threadId = null;
    this.sessionActive = false;
    this.orchestrator.markIdle();
    if (threadId) {
      void this.host.requestJsonRpc("thread/realtime/stop", { threadId }).catch(() => undefined);
    }
    void this.chromiumSession.close();
  }

  private async ensureSession(): Promise<void> {
    const threadId = await this.host.ensureSelectedThread();
    if (this.sessionActive && this.threadId === threadId) return;
    if (this.sessionActive && this.threadId && this.threadId !== threadId) {
      await this.host.requestJsonRpc("thread/realtime/stop", { threadId: this.threadId }).catch(() => undefined);
      this.sessionActive = false;
    }
    this.threadId = threadId;
    this.orchestrator.markStarting();
    try {
      await this.startRealtime(threadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("does not support realtime conversation")) {
        this.logger.warn("Codex Voice Chat start failed", { message });
        throw new VoiceClientError("realtime_unavailable", `无法打开 Codex Voice Chat：${message}`);
      }
      this.logger.warn("Current Codex thread cannot take Voice Chat; starting a voice-capable task");
      const voiceThreadId = await this.host.startVoiceThread();
      this.threadId = voiceThreadId;
      try {
        await this.startRealtime(voiceThreadId);
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        this.logger.warn("Codex Voice Chat start failed", { message: retryMessage });
        throw new VoiceClientError("realtime_unavailable", `无法打开 Codex Voice Chat：${retryMessage}`);
      }
    }
    this.sessionActive = true;
    this.orchestrator.markActive();
  }

  private async restartSession(): Promise<void> {
    const threadId = this.threadId ?? await this.host.ensureSelectedThread();
    if (this.threadId && this.sessionActive) {
      await this.host.requestJsonRpc("thread/realtime/stop", { threadId: this.threadId }).catch(() => undefined);
    }
    this.sessionActive = false;
    this.threadId = threadId;
    await this.startRealtime(threadId);
    this.sessionActive = true;
  }

  private startRealtime(threadId: string): Promise<unknown> {
    return this.chromiumSession.start(threadId);
  }

  private enqueueAppend(audio: Buffer): void {
    this.chromiumSession.appendInput(audio);
  }

  private handleNotification(notification: CodexNotification): void {
    this.chromiumSession.handleNotification(notification);
    const params = notification.params ?? {};
    switch (notification.method) {
      case "thread/realtime/outputAudio/delta":
        this.onOutputAudio(params.audio);
        break;
      case "thread/realtime/transcript/delta":
        this.onTranscriptDelta(params.role, firstText(params.delta, params.text));
        break;
      case "thread/realtime/transcript/done":
        this.onTranscriptDone(params.role, firstText(params.text, params.delta));
        break;
      case "thread/realtime/error": {
        const message = typeof params.message === "string" ? params.message : "Codex 语音中断";
        this.logger.warn("Codex realtime error", message);
        this.sessionActive = false;
        this.sessionFailure = message;
        const turnOpen = this.inputStarted || this.waitingForReply;
        if (message.includes("access denied") || turnOpen) {
          this.failOpenTurn(voiceUnavailableMessage(message));
          if (turnOpen) this.resetRealtimeSession();
          void this.orchestrator.handleClosed();
          break;
        }
        void this.orchestrator.handleError(new VoiceClientError("realtime_error", message)).then((recovered) => {
          if (!recovered) this.emit("error", new VoiceClientError("realtime_error", message));
        });
        break;
      }
      case "thread/realtime/closed":
        this.sessionActive = false;
        this.finishOutput();
        if (this.inputStarted || this.waitingForReply) {
          this.failOpenTurn(voiceUnavailableMessage(this.sessionFailure ?? "realtime session closed"));
        }
        void this.orchestrator.handleClosed();
        break;
      default:
        break;
    }
  }

  private onOutputAudio(value: unknown): void {
    const chunk = asAudioChunk(value);
    if (!chunk) return;
    const pcm = Buffer.from(chunk.data, "base64");
    if (pcm.byteLength === 0) return;
    this.emit("outputLevel", measurePcm16(pcm));
    if (!hasAudibleSignal(pcm)) return;
    if (chunk.sampleRate !== AUDIO_SAMPLE_RATE) {
      this.logger.warn("Codex realtime sample rate differs from glasses PCM", { sampleRate: chunk.sampleRate });
    }
    if (this.outputAudioFrames < 3) {
      this.outputAudioFrames += 1;
      this.logger.info("Codex realtime audible audio frame", { bytes: pcm.byteLength, frame: this.outputAudioFrames });
    }
    this.outputStarted = true;
    this.clearWaitingForReply();
    this.emit("audio", pcm);
    if (this.outputIdle) clearTimeout(this.outputIdle);
    this.outputIdle = setTimeout(() => this.finishOutput(), OUTPUT_IDLE_MS);
    this.outputIdle.unref();
  }

  private onTranscriptDelta(roleValue: unknown, deltaValue: unknown): void {
    const delta = typeof deltaValue === "string" ? deltaValue : "";
    if (!delta) return;
    const role = captionRole(roleValue);
    this.emitCaption(role, this.captions.appendDelta(role, delta));
  }

  private onTranscriptDone(roleValue: unknown, textValue: unknown): void {
    const role = captionRole(roleValue);
    const text = typeof textValue === "string" ? textValue : undefined;
    this.emitCaption(role, this.captions.complete(role, text));
  }

  private emitCaption(role: CaptionRole, text: string): void {
    const caption = sanitizeForVisor(text, Number.MAX_SAFE_INTEGER).slice(-16_000).trim();
    if (!caption) return;
    this.emit("caption", role, caption);
  }

  private finishOutput(): void {
    if (this.outputIdle) {
      clearTimeout(this.outputIdle);
      this.outputIdle = undefined;
    }
    if (!this.outputStarted) return;
    this.outputStarted = false;
    this.emit("audioEnd", this.captions.complete("assistant"));
  }

  private failOpenTurn(message: string): void {
    this.inputStarted = false;
    this.chromiumSession.setInputActive(false);
    this.inputHadSignal = false;
    this.clearWaitingForReply();
    this.emit("error", new VoiceClientError("realtime_unavailable", message));
  }

  private armReplyTimeout(): void {
    this.clearReplyTimeout();
    this.waitingForReply = true;
    this.replyTimer = setTimeout(() => {
      if (!this.waitingForReply) return;
      this.failOpenTurn("语音没有返回结果，请再说一次");
      this.resetRealtimeSession();
    }, REPLY_TIMEOUT_MS);
    this.replyTimer.unref();
  }

  private clearWaitingForReply(): void {
    this.waitingForReply = false;
    this.clearReplyTimeout();
  }

  private clearReplyTimeout(): void {
    if (!this.replyTimer) return;
    clearTimeout(this.replyTimer);
    this.replyTimer = undefined;
  }

  private resetRealtimeSession(): void {
    if (this.sessionReset) return;
    const threadId = this.threadId;
    this.sessionActive = false;
    this.sessionReset = (async () => {
      if (threadId) await this.host.requestJsonRpc("thread/realtime/stop", { threadId }).catch(() => undefined);
      await this.chromiumSession.close();
    })().finally(() => {
      this.sessionReset = undefined;
    });
  }
}
//#endregion

//#region 方法/工具
function voiceUnavailableMessage(detail: string | null): string {
  if (detail && detail.toLowerCase().includes("access denied")) {
    return "Codex 语音通道不可用。请关闭 ChatGPT 的 Voice Chat 后再说一次";
  }
  return detail?.trim() ? `无法完成语音：${detail}` : "Codex 语音通道不可用，请稍后再试";
}

function captionRole(value: unknown): CaptionRole {
  return typeof value === "string" && value.toLowerCase() === "user" ? "user" : "assistant";
}

function hasAudibleSignal(pcm: Buffer): boolean {
  for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
    if (Math.abs(pcm.readInt16LE(offset)) > 8) return true;
  }
  return false;
}

function silenceFrame(durationMs: number): Buffer {
  const samples = Math.max(1, Math.floor((AUDIO_SAMPLE_RATE * durationMs) / 1_000));
  return Buffer.alloc(samples * 2);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function asAudioChunk(value: unknown): { data: string; sampleRate: number } | null {
  if (!value || typeof value !== "object") return null;
  const chunk = value as RealtimeAudioChunk;
  if (typeof chunk.data !== "string" || chunk.data.length === 0) return null;
  const sampleRate = typeof chunk.sampleRate === "number" ? chunk.sampleRate : AUDIO_SAMPLE_RATE;
  return { data: chunk.data, sampleRate };
}
//#endregion
