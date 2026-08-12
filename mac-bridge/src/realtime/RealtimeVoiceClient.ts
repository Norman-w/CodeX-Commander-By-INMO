import { EventEmitter } from "node:events";

import WebSocket from "ws";
import { z } from "zod";

import { AUDIO_SAMPLE_RATE } from "@codex-commander/protocol";

import type { Logger } from "../log.js";
import { sanitizeForVisor } from "../privacy/VisorText.js";

export type VoiceToolName = "list_tasks" | "select_task" | "send_command" | "interrupt_task" | "get_status" | "read_summary" | "show_image";
export type VoiceToolHandler = (name: VoiceToolName, argumentsValue: unknown) => Promise<unknown>;

export type RealtimeConfig = {
  apiKey?: string;
  model: string;
  voice: string;
  idleMs: number;
  endpoint?: string;
};

const RealtimeEventSchema = z.object({ type: z.string() }).passthrough();
const VoiceToolNameSchema = z.enum(["list_tasks", "select_task", "send_command", "interrupt_task", "get_status", "read_summary", "show_image"]);

export class RealtimeVoiceClient extends EventEmitter {
  private socket?: WebSocket;
  private connectPromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private inputStarted = false;
  private inputEverHadAudio = false;
  private inputAudioBytes = 0;
  private inputReady = false;
  private readonly pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private responseActive = false;
  private outputAudioStarted = false;
  private transcript = "";

  constructor(
    private readonly config: RealtimeConfig,
    private readonly tools: VoiceToolHandler,
    private readonly logger: Logger
  ) {
    super();
  }

  isConfigured(): boolean { return Boolean(this.config.apiKey); }

  async beginInput(): Promise<void> {
    if (!this.config.apiKey) throw new VoiceClientError("realtime_not_configured", "Mac 尚未配置 OpenAI API Key");
    this.inputStarted = true;
    this.inputEverHadAudio = false;
    this.inputAudioBytes = 0;
    this.inputReady = false;
    this.pendingAudio.length = 0;
    this.pendingAudioBytes = 0;
    this.transcript = "";
    await this.ensureConnected();
    if (!this.inputStarted) return;
    if (this.responseActive) {
      this.send({ type: "response.cancel" });
      if (this.outputAudioStarted) {
        this.outputAudioStarted = false;
        this.emit("audioEnd", "");
      }
    }
    this.send({ type: "input_audio_buffer.clear" });
    this.inputReady = true;
    for (const audio of this.pendingAudio) this.sendAudio(audio);
    this.pendingAudio.length = 0;
    this.pendingAudioBytes = 0;
    this.touch();
  }

  appendInput(pcm16le: Uint8Array): void {
    if (!this.inputStarted) return;
    const audio = Buffer.from(pcm16le);
    if (audio.byteLength > 0) {
      this.inputEverHadAudio = true;
      this.inputAudioBytes += audio.byteLength;
    }
    if (!this.inputReady || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (this.pendingAudioBytes + audio.byteLength <= MAX_PENDING_AUDIO_BYTES) {
        this.pendingAudio.push(audio);
        this.pendingAudioBytes += audio.byteLength;
      }
      return;
    }
    this.touch();
    this.sendAudio(audio);
  }

  async endInput(): Promise<void> {
    if (!this.inputStarted) throw new VoiceClientError("ptt_not_active", "当前没有正在录音的语音");
    this.inputStarted = false;
    this.inputReady = false;
    if (!this.inputEverHadAudio || this.inputAudioBytes < MIN_INPUT_AUDIO_BYTES) {
      this.send({ type: "input_audio_buffer.clear" });
      throw new VoiceClientError("ptt_too_short", "说话时间太短，请按住后再说");
    }
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
    this.touch();
  }

  abortInput(): void {
    if (!this.inputStarted) return;
    this.inputStarted = false;
    this.inputEverHadAudio = false;
    this.inputAudioBytes = 0;
    this.inputReady = false;
    this.pendingAudio.length = 0;
    this.pendingAudioBytes = 0;
    this.send({ type: "input_audio_buffer.clear" });
    this.touch();
  }

  async speakSummary(summary: string): Promise<void> {
    await this.ensureConnected();
    this.send({
      type: "response.create",
      response: {
        input: [],
        tools: [],
        tool_choice: "none",
        instructions: `请用简洁自然的中文口头汇报下面内容，不要新增事实，不要读 Markdown、密钥或本机绝对路径。\n\n${sanitizeSpokenSummary(summary)}`
      }
    });
    this.touch();
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.inputStarted = false;
    this.inputEverHadAudio = false;
    this.inputAudioBytes = 0;
    this.inputReady = false;
    this.pendingAudio.length = 0;
    this.pendingAudioBytes = 0;
    this.responseActive = false;
    this.outputAudioStarted = false;
    this.socket?.close(1000, "idle");
    this.socket = undefined;
    this.connectPromise = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.config.apiKey) throw new VoiceClientError("realtime_not_configured", "Mac 尚未配置 OpenAI API Key");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const endpoint = new URL(this.config.endpoint || "wss://api.openai.com/v1/realtime");
      endpoint.searchParams.set("model", this.config.model);
      const socket = new WebSocket(endpoint, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        maxPayload: 4_194_304
      });
      this.socket = socket;
      const fail = (error: Error) => {
        this.connectPromise = undefined;
        reject(error);
      };
      socket.once("error", fail);
      socket.once("open", () => {
        socket.off("error", fail);
        socket.on("error", (error) => this.emit("error", error));
        socket.on("message", (data) => void this.handleMessage(data.toString()));
        socket.on("close", () => {
          if (this.socket === socket) this.socket = undefined;
          this.connectPromise = undefined;
          this.inputStarted = false;
          this.inputEverHadAudio = false;
          this.inputAudioBytes = 0;
          this.inputReady = false;
          this.pendingAudio.length = 0;
          this.pendingAudioBytes = 0;
          this.responseActive = false;
          if (this.outputAudioStarted) this.emit("audioEnd", "");
          this.outputAudioStarted = false;
        });
        this.send({
          type: "session.update",
          session: {
            type: "realtime",
            model: this.config.model,
            output_modalities: ["audio"],
            audio: {
              input: { format: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE }, turn_detection: null },
              output: { format: { type: "audio/pcm" }, voice: this.config.voice }
            },
            instructions: [
              "你是眼镜里的 Codex 遥控助手。用自然、直接的中文回答，通常不超过两句，不使用客服腔或营销话术。",
              "用户给出明确的开发指令时，立即调用 send_command；工具成功后只需确认已交给 Codex，并简述当前状态。",
              "不要把尚未调用工具的事说成已经执行，也不要在任务真正完成前声称完成。",
              "你可以查询、选择、中断任务、读取汇报和请求显示图片。目标不清楚且会影响执行时，只问一个简短问题。",
              "你永远不能批准 Codex 的命令、文件修改或额外权限；审批只能由用户在眼镜上物理确认。",
              "如工具返回错误，用一句话说明用户下一步能做什么；不要朗读错误代码、路径或 Markdown 标记。"
            ].join("\n"),
            tools: voiceTools,
            tool_choice: "auto"
          }
        });
        this.connectPromise = undefined;
        this.touch();
        resolve();
      });
    });
    return this.connectPromise;
  }

  private async handleMessage(raw: string): Promise<void> {
    let event: z.infer<typeof RealtimeEventSchema>;
    try {
      event = RealtimeEventSchema.parse(JSON.parse(raw));
    } catch (error) {
      this.logger.warn("Ignoring invalid Realtime event", String(error));
      return;
    }

    if (event.type === "response.created") {
      this.responseActive = true;
      return;
    }
    if (event.type === "response.output_audio.delta" && typeof event.delta === "string") {
      this.outputAudioStarted = true;
      this.emit("audio", Buffer.from(event.delta, "base64"));
      return;
    }
    if (event.type === "response.output_audio_transcript.delta" && typeof event.delta === "string") {
      this.transcript += event.delta;
      return;
    }
    if (event.type === "response.output_audio.done") {
      this.emit("audioEnd", this.transcript);
      this.transcript = "";
      this.outputAudioStarted = false;
      return;
    }
    if (event.type === "response.done") {
      this.responseActive = false;
      if (this.outputAudioStarted) {
        this.outputAudioStarted = false;
        this.emit("audioEnd", this.transcript);
        this.transcript = "";
      }
      await this.handleFunctionCalls(event.response);
      return;
    }
    if (event.type === "error") {
      const errorValue = event.error as { message?: string; code?: string } | undefined;
      this.emit("error", new Error(errorValue?.message || `Realtime error: ${errorValue?.code || "unknown"}`));
    }
  }

  private async handleFunctionCalls(response: unknown): Promise<void> {
    const output = (response as { output?: unknown[] } | undefined)?.output;
    if (!Array.isArray(output)) return;
    let called = false;
    for (const value of output) {
      const item = value as { type?: string; name?: string; call_id?: string; arguments?: string };
      if (item.type !== "function_call" || !item.name || !item.call_id) continue;
      called = true;
      let result: unknown;
      try {
        const name = VoiceToolNameSchema.parse(item.name);
        result = await this.tools(name, item.arguments ? JSON.parse(item.arguments) : {});
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result) }
      });
    }
    if (called) this.send({ type: "response.create" });
  }

  private send(value: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
  }

  private sendAudio(audio: Buffer): void {
    this.send({ type: "input_audio_buffer.append", audio: audio.toString("base64") });
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.config.idleMs);
    this.idleTimer.unref();
  }
}

export class VoiceClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// Five seconds is enough for a cold Realtime handshake while keeping memory bounded.
const MAX_PENDING_AUDIO_BYTES = AUDIO_SAMPLE_RATE * 2 * 5;
const MIN_INPUT_AUDIO_BYTES = AUDIO_SAMPLE_RATE * 2 / 10;

const voiceTools = [
  tool("list_tasks", "列出最近的 Codex 任务", {}),
  tool("select_task", "选择一个 Codex 任务", { threadId: { type: "string" } }, ["threadId"]),
  tool("send_command", "向当前或指定 Codex 任务发送开发指令", { text: { type: "string" }, threadId: { type: "string" } }, ["text"]),
  tool("interrupt_task", "中断当前正在执行的 Codex 任务", { threadId: { type: "string" } }),
  tool("get_status", "读取当前任务状态", {}),
  tool("read_summary", "读取最近一次 Codex 完成汇报", {}),
  tool("show_image", "把 Mac 上允许目录内的一张图片显示到眼镜", { path: { type: "string" }, title: { type: "string" } }, ["path"])
] as const;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: "function", name, description, parameters: { type: "object", properties, required, additionalProperties: false } };
}

function sanitizeSpokenSummary(value: string): string {
  return sanitizeForVisor(value, 16_000);
}
