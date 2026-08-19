//#region 导入/依赖
import type { Logger } from "../log.js";
//#endregion

//#region 模型/类型
export type RealtimeSessionState = "idle" | "starting" | "active" | "recovering" | "degraded";

export type RealtimeSessionOrchestratorOptions = {
  maxStartRetries?: number;
  wakeSpeech?: string;
  onStateChange?: (state: RealtimeSessionState) => void;
  appendSpeech: (text: string) => Promise<void>;
  restartSession: () => Promise<void>;
  logger: Logger;
};
//#endregion

//#region 公开 API
export class RealtimeSessionOrchestrator {
  private state: RealtimeSessionState = "idle";
  private startRetries = 0;
  private readonly maxStartRetries: number;
  private readonly wakeSpeech: string;

  constructor(private readonly options: RealtimeSessionOrchestratorOptions) {
    this.maxStartRetries = options.maxStartRetries ?? 1;
    this.wakeSpeech = options.wakeSpeech ?? "继续";
  }

  getState(): RealtimeSessionState {
    return this.state;
  }

  markStarting(): void {
    this.setState("starting");
  }

  markActive(): void {
    this.startRetries = 0;
    this.setState("active");
  }

  markIdle(): void {
    this.setState("idle");
  }

  async handleClosed(): Promise<void> {
    this.options.logger.info("Codex realtime session closed; will restart on next PTT");
    this.setState("idle");
  }

  async handleError(error: Error): Promise<boolean> {
    this.options.logger.warn("Codex realtime session error", error.message);
    if (this.startRetries >= this.maxStartRetries) {
      this.setState("degraded");
      return false;
    }
    this.startRetries += 1;
    this.setState("recovering");
    try {
      await this.options.restartSession();
      this.markActive();
      return true;
    } catch (retryError) {
      this.options.logger.warn(
        "Codex realtime restart failed",
        retryError instanceof Error ? retryError.message : String(retryError)
      );
      try {
        await this.options.appendSpeech(this.wakeSpeech);
        this.setState("degraded");
        return true;
      } catch {
        this.setState("degraded");
        return false;
      }
    }
  }

  async recoverFromAppendFailure(): Promise<void> {
    if (this.state === "degraded") return;
    this.setState("recovering");
    await this.options.restartSession();
    this.markActive();
  }
  //#endregion

  //#region 业务逻辑
  private setState(state: RealtimeSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
  //#endregion
}
