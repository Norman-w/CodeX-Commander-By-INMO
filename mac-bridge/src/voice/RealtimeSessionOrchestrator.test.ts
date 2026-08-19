import { describe, expect, it, vi } from "vitest";

import { Logger } from "../log.js";
import { RealtimeSessionOrchestrator } from "./RealtimeSessionOrchestrator.js";

describe("RealtimeSessionOrchestrator", () => {
  it("retries start once then falls back to appendSpeech", async () => {
    const appendSpeech = vi.fn(async () => undefined);
    const restartSession = vi.fn(async () => {
      throw new Error("conflict");
    });
    const orchestrator = new RealtimeSessionOrchestrator({
      logger: new Logger("error"),
      appendSpeech,
      restartSession,
      wakeSpeech: "继续"
    });

    orchestrator.markStarting();
    orchestrator.markActive();
    const recovered = await orchestrator.handleError(new Error("closed"));
    expect(recovered).toBe(true);
    expect(restartSession).toHaveBeenCalledTimes(1);
    expect(appendSpeech).toHaveBeenCalledWith("继续");
    expect(orchestrator.getState()).toBe("degraded");
  });
});
