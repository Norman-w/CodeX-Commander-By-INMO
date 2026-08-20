import { describe, expect, it, vi } from "vitest";

import { Logger } from "../log.js";
import { CodexRealtimeVoiceClient, type CodexRealtimeHost } from "./CodexRealtimeVoiceClient.js";

describe("CodexRealtimeVoiceClient", () => {
  it("streams glasses PCM into Codex Voice Chat and plays audio back", async () => {
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const listeners: Array<(notification: { method: string; params?: Record<string, unknown> }) => void> = [];
    const host: CodexRealtimeHost = {
      ensureSelectedThread: vi.fn(async () => "thread-1"),
      startVoiceThread: vi.fn(async () => "thread-voice"),
      requestJsonRpc: vi.fn(async (method, params) => {
        requests.push({ method, params });
        return {} as never;
      }),
      subscribeNotifications: (listener) => {
        listeners.push(listener);
        return () => undefined;
      }
    };
    const client = new CodexRealtimeVoiceClient(host, new Logger("error"));
    const audio = vi.fn();
    const captions: Array<[string, string]> = [];
    client.on("audio", audio);
    client.on("caption", (role: "user" | "assistant", text: string) => captions.push([role, text]));

    await client.beginInput();
    client.appendInput(new Uint8Array(4_800).fill(1));
    await client.endInput();
    await vi.waitFor(() => expect(requests.some((item) => item.method === "thread/realtime/appendAudio")).toBe(true));

    expect(requests[0]).toMatchObject({
      method: "thread/realtime/start",
      params: { threadId: "thread-1", outputModality: "audio", version: "v3" }
    });

    listeners[0]?.({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "user", text: "给首页加暗色模式" }
    });
    listeners[0]?.({
      method: "thread/realtime/outputAudio/delta",
      params: {
        threadId: "thread-1",
        audio: { data: Buffer.from([1, 0, 2, 0]).toString("base64"), sampleRate: 24_000, numChannels: 1 }
      }
    });
    listeners[0]?.({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "assistant", text: "已经开始改。" }
    });

    expect(audio).toHaveBeenCalled();
    expect(captions).toEqual([
      ["user", "给首页加暗色模式"],
      ["assistant", "已经开始改。"]
    ]);
    const audioEnd = vi.fn();
    client.on("audioEnd", audioEnd);
    await vi.waitFor(() => expect(audioEnd).toHaveBeenCalledWith("已经开始改。"));
    client.close();
  });

  it("fails the open turn when Voice session access is denied", async () => {
    const listeners: Array<(notification: { method: string; params?: Record<string, unknown> }) => void> = [];
    const host: CodexRealtimeHost = {
      ensureSelectedThread: async () => "thread-1",
      startVoiceThread: async () => "thread-voice",
      requestJsonRpc: async () => ({} as never),
      subscribeNotifications: (listener) => {
        listeners.push(listener);
        return () => undefined;
      }
    };
    const client = new CodexRealtimeVoiceClient(host, new Logger("error"));
    const failed = new Promise<Error>((resolve) => client.on("error", resolve));
    await client.beginInput();
    client.appendInput(new Uint8Array(4_800).fill(1));
    listeners[0]?.({
      method: "thread/realtime/error",
      params: { message: "stream disconnected before completion: Voice session access denied." }
    });
    const error = await failed;
    expect(error.message).toContain("Voice Chat");
    await expect(client.endInput()).rejects.toMatchObject({ code: "ptt_not_active" });
    client.close();
  });

  it("probes realtime/start on the selected thread", async () => {
    const requests: Array<{ method: string }> = [];
    const host: CodexRealtimeHost = {
      ensureSelectedThread: async () => "thread-1",
      startVoiceThread: async () => "thread-voice",
      requestJsonRpc: async (method) => {
        requests.push({ method });
        return {} as never;
      },
      subscribeNotifications: () => () => undefined
    };
    const client = new CodexRealtimeVoiceClient(host, new Logger("error"));
    await client.probeRealtime();
    expect(requests.map((item) => item.method)).toEqual(["thread/realtime/start"]);
    client.close();
  });
});
