//#region 导入/依赖
import { AUDIO_SAMPLE_RATE } from "@codex-commander/protocol";
//#endregion

//#region 模型/类型
export type CommanderVoice = {
  isConfigured(): boolean;
  probeRealtime(): Promise<void>;
  beginInput(): Promise<void>;
  appendInput(pcm16le: Uint8Array): void;
  endInput(): Promise<void>;
  abortInput(): void;
  speakSummary(summary: string): Promise<void>;
  close(): void;
  on(event: "audio", listener: (audio: Buffer) => void): unknown;
  on(event: "audioEnd", listener: (transcript: string) => void): unknown;
  on(event: "caption", listener: (role: "user" | "assistant", text: string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};
//#endregion

//#region 公开 API
export class VoiceClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export const MIN_INPUT_AUDIO_BYTES = AUDIO_SAMPLE_RATE * 2 / 10;
export const MAX_PENDING_AUDIO_BYTES = AUDIO_SAMPLE_RATE * 2 * 5;
//#endregion
