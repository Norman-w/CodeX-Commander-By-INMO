import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { Logger } from "../log.js";
import { RealtimeVoiceClient, type VoiceToolHandler } from "./RealtimeVoiceClient.js";

describe("RealtimeVoiceClient", () => {
  const servers: WebSocketServer[] = [];
  const clients: RealtimeVoiceClient[] = [];

  afterEach(async () => {
    for (const client of clients) client.close();
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("streams explicit PTT audio and emits synthesized PCM", async () => {
    const { server, endpoint } = await createServer();
    const messages: Record<string, unknown>[] = [];
    const socketPromise = once(server, "connection") as Promise<[WebSocket]>;
    const client = makeClient(endpoint, async () => ({}));
    const audio = vi.fn();
    const audioEnd = vi.fn();
    client.on("audio", audio);
    client.on("audioEnd", audioEnd);

    const begin = client.beginInput();
    const [socket] = await socketPromise;
    socket.on("message", (value) => messages.push(JSON.parse(value.toString()) as Record<string, unknown>));
    await begin;
    client.appendInput(new Uint8Array(4_800).fill(1));
    await client.endInput();
    await vi.waitFor(() => expect(messages.some((value) => value.type === "input_audio_buffer.commit")).toBe(true));

    socket.send(JSON.stringify({ type: "response.created" }));
    socket.send(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.from([9, 8]).toString("base64") }));
    socket.send(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "完成" }));
    socket.send(JSON.stringify({ type: "response.output_audio.done" }));
    socket.send(JSON.stringify({ type: "response.done", response: { output: [] } }));

    await vi.waitFor(() => expect(audio).toHaveBeenCalledOnce());
    expect([...audio.mock.calls[0]![0] as Buffer]).toEqual([9, 8]);
    await vi.waitFor(() => expect(audioEnd).toHaveBeenCalledWith("完成"));
    expect(messages.filter((value) => value.type === "input_audio_buffer.append")).toHaveLength(1);
  });

  it("returns constrained tool results to Realtime", async () => {
    const { server, endpoint } = await createServer();
    const messages: Record<string, unknown>[] = [];
    const tool: VoiceToolHandler = vi.fn(async () => ({ tasks: [] }));
    const socketPromise = once(server, "connection") as Promise<[WebSocket]>;
    const client = makeClient(endpoint, tool);

    const begin = client.beginInput();
    const [socket] = await socketPromise;
    socket.on("message", (value) => messages.push(JSON.parse(value.toString()) as Record<string, unknown>));
    await begin;
    socket.send(JSON.stringify({
      type: "response.done",
      response: { output: [{ type: "function_call", name: "list_tasks", call_id: "call-1", arguments: "{}" }] }
    }));

    await vi.waitFor(() => expect(tool).toHaveBeenCalledWith("list_tasks", {}));
    await vi.waitFor(() => expect(messages.some((value) => value.type === "conversation.item.create")).toBe(true));
    const output = messages.find((value) => value.type === "conversation.item.create")?.item as { output?: string };
    expect(JSON.parse(output.output || "{}")).toEqual({ tasks: [] });
  });

  async function createServer(): Promise<{ server: WebSocketServer; endpoint: string }> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    return { server, endpoint: `ws://127.0.0.1:${address.port}/v1/realtime` };
  }

  function makeClient(endpoint: string, tool: VoiceToolHandler): RealtimeVoiceClient {
    const client = new RealtimeVoiceClient(
      { apiKey: "test-key", model: "test-model", voice: "marin", idleMs: 10_000, endpoint },
      tool,
      new Logger("error")
    );
    clients.push(client);
    return client;
  }
});
