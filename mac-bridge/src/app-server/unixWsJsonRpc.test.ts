import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decodeServerFrame, encodeServerFrame, UnixWsJsonRpc } from "./unixWsJsonRpc.js";

describe("unixWsJsonRpc", () => {
  it("decodes an unmasked text frame", () => {
    const payload = Buffer.from("{\"ok\":true}", "utf8");
    const frame = encodeServerFrame(payload);
    const decoded = decodeServerFrame(frame);
    expect(decoded?.payload.toString("utf8")).toBe("{\"ok\":true}");
    expect(decoded?.rest.byteLength).toBe(0);
  });

  it("upgrades a unix websocket and exchanges JSON-RPC", async () => {
    const directory = mkdtempSync(join(tmpdir(), "commander-ws-"));
    const socketPath = join(directory, "control.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      server.on("connection", (socket) => {
        let buffer = Buffer.alloc(0);
        let upgraded = false;
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (!upgraded) {
            const headerEnd = buffer.indexOf("\r\n\r\n");
            if (headerEnd < 0) return;
            buffer = buffer.subarray(headerEnd + 4);
            socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
            upgraded = true;
          }
          const frame = decodeServerFrame(buffer);
          if (!frame) return;
          buffer = Buffer.from(frame.rest);
          if (frame.opcode !== 0x1 || frame.payload.byteLength === 0) return;
          const request = JSON.parse(frame.payload.toString("utf8")) as { id?: number; method?: string };
          if (request.method === "initialize") {
            socket.write(encodeServerFrame(Buffer.from(JSON.stringify({ id: request.id, result: { ok: true } }), "utf8")));
          }
        });
      });

      const client = new UnixWsJsonRpc(socketPath);
      const replies: unknown[] = [];
      client.on("message", (message) => replies.push(message));
      await client.connect();
      client.send({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "0" } } });
      await viWait(() => replies.length === 1);
      expect(replies[0]).toEqual({ id: 1, result: { ok: true } });
      client.close();
    } finally {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function viWait(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3_000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
