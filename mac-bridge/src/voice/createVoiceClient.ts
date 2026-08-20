//#region 导入/依赖
import type { CodexController } from "../codex/CodexController.js";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../log.js";
import { RealtimeVoiceClient } from "../realtime/RealtimeVoiceClient.js";
import { createVoiceToolRouter } from "../realtime/VoiceToolRouter.js";
import type { ImageService } from "../media/ImageService.js";
import { CodexRealtimeVoiceClient } from "./CodexRealtimeVoiceClient.js";
import type { CommanderVoice } from "./types.js";
//#endregion

//#region 公开 API
export function createVoiceClient(
  config: BridgeConfig,
  codex: CodexController,
  images: ImageService,
  onImage: (image: import("@codex-commander/protocol").ImageCard) => void,
  logger: Logger
): CommanderVoice {
  if (config.voice.mode === "openai") {
    logger.warn("COMMANDER_VOICE=openai 已弃用；请改用 codex-realtime 以保留 Codex thread 上下文");
    return new RealtimeVoiceClient(
      config.realtime,
      createVoiceToolRouter(codex, images, onImage),
      logger
    );
  }
  return new CodexRealtimeVoiceClient(codex, logger, config.audio.localOutput);
}
//#endregion
