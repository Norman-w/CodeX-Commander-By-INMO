import { z } from "zod";

import type { CodexController } from "../codex/CodexController.js";
import type { ImageService } from "../media/ImageService.js";
import type { VoiceToolHandler } from "./RealtimeVoiceClient.js";

const ThreadIdArgs = z.object({ threadId: z.string().min(1) });
const OptionalThreadIdArgs = z.object({ threadId: z.string().min(1).optional() });
const SendCommandArgs = z.object({ text: z.string().min(1).max(20_000), threadId: z.string().min(1).optional() });
const ShowImageArgs = z.object({ path: z.string().min(1), title: z.string().min(1).max(160).optional() });

export function createVoiceToolRouter(codex: CodexController, images: ImageService, onImage: (image: Awaited<ReturnType<ImageService["prepare"]>>) => void): VoiceToolHandler {
  return async (name, value) => {
    switch (name) {
      case "list_tasks": return { tasks: await codex.listThreads() };
      case "select_task": {
        const args = ThreadIdArgs.parse(value);
        await codex.selectThread(args.threadId);
        return { selectedThreadId: args.threadId };
      }
      case "send_command": {
        const args = SendCommandArgs.parse(value);
        return codex.sendCommand(args.text, args.threadId);
      }
      case "interrupt_task": {
        const args = OptionalThreadIdArgs.parse(value);
        await codex.interrupt(args.threadId);
        return { interrupted: true };
      }
      case "get_status": return {
        selectedThreadId: codex.getSelectedThreadId(),
        activeTurnId: codex.getActiveTurnId(),
        waitingApproval: Boolean(codex.getPendingApproval())
      };
      case "read_summary": return { summary: codex.getLatestFinal() || "目前没有新的完成汇报。" };
      case "show_image": {
        const args = ShowImageArgs.parse(value);
        const image = await images.prepare(args.path, args.title);
        onImage(image);
        return { shown: true, image };
      }
    }
  };
}

