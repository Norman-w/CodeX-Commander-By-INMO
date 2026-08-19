//#region 导入/依赖
import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
//#endregion

//#region 常量/配置
const UPGRADE_TIMEOUT_MS = 8_000;
const WS_TEXT = 0x1;
const WS_CLOSE = 0x8;
const WS_PING = 0x9;
const WS_PONG = 0xa;
//#endregion

//#region 模型/类型
type JsonObject = Record<string, unknown>;
//#endregion

//#region 公开 API
export class UnixWsJsonRpc extends EventEmitter {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private headerDone = false;
  private open = false;

  constructor(private readonly socketPath: string) {
    super();
  }

  isOpen(): boolean {
    return this.open && Boolean(this.socket && !this.socket.destroyed);
  }

  async connect(timeoutMs = UPGRADE_TIMEOUT_MS): Promise<void> {
    if (this.socket) return;
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`control socket 连接超时：${this.socketPath}`));
      }, timeoutMs);
      timer.unref();
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("connect", () => {
        const key = randomBytes(16).toString("base64");
        socket.write(
          "GET / HTTP/1.1\r\n"
          + "Host: localhost\r\n"
          + "Upgrade: websocket\r\n"
          + "Connection: Upgrade\r\n"
          + `Sec-WebSocket-Key: ${key}\r\n`
          + "Sec-WebSocket-Version: 13\r\n"
          + "\r\n"
        );
        const onData = (chunk: Buffer) => {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd < 0) return;
          const header = this.buffer.subarray(0, headerEnd).toString("latin1");
          this.buffer = this.buffer.subarray(headerEnd + 4);
          socket.off("data", onData);
          clearTimeout(timer);
          if (!header.startsWith("HTTP/1.1 101")) {
            socket.destroy();
            reject(new Error(`control socket WebSocket 升级失败：${header.split("\r\n")[0] || "unknown"}`));
            return;
          }
          this.headerDone = true;
          this.open = true;
          socket.on("data", (next) => this.onBytes(next));
          socket.on("close", () => this.handleClose());
          socket.on("error", (error) => this.emit("error", error));
          this.drainFrames();
          resolve();
        };
        socket.on("data", onData);
      });
    });
  }

  send(message: unknown): void {
    if (!this.isOpen() || !this.socket) throw new Error("Codex App Server is not running");
    this.socket.write(encodeClientFrame(Buffer.from(JSON.stringify(message), "utf8"), WS_TEXT));
  }

  close(): void {
    const socket = this.socket;
    this.open = false;
    if (!socket || socket.destroyed) {
      this.socket = undefined;
      return;
    }
    try {
      socket.write(encodeClientFrame(Buffer.alloc(0), WS_CLOSE));
    } catch {
      /* closing */
    }
    socket.end();
    this.socket = undefined;
  }
  //#endregion

  //#region 业务逻辑
  private onBytes(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drainFrames();
  }

  private drainFrames(): void {
    if (!this.headerDone) return;
    while (this.buffer.byteLength >= 2) {
      const parsed = decodeServerFrame(this.buffer);
      if (!parsed) return;
      this.buffer = Buffer.from(parsed.rest);
      this.handleFrame(parsed.opcode, parsed.payload);
    }
  }

  private handleFrame(opcode: number, payload: Buffer): void {
    if (opcode === WS_PING) {
      this.socket?.write(encodeClientFrame(payload, WS_PONG));
      return;
    }
    if (opcode === WS_CLOSE) {
      this.handleClose();
      return;
    }
    if (opcode !== WS_TEXT) return;
    const text = payload.toString("utf8").trim();
    if (!text) return;
    try {
      this.emit("message", JSON.parse(text) as JsonObject);
    } catch {
      this.emit("nonjson", text);
    }
  }

  private handleClose(): void {
    const wasOpen = this.open;
    this.open = false;
    this.socket = undefined;
    if (wasOpen) this.emit("close");
  }
}
//#endregion

//#region 方法/工具
export function encodeClientFrame(payload: Buffer, opcode: number): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([encodeHeader(opcode, payload.byteLength, true), mask, masked]);
}

export function decodeServerFrame(buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buffer.byteLength < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = Boolean(buffer[1]! & 0x80);
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.byteLength < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.byteLength < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) {
    if (buffer.byteLength < offset + 4 + length) return null;
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = buffer[offset + index]! ^ mask[index % 4]!;
    }
    return { opcode, payload, rest: buffer.subarray(offset + length) };
  }
  if (buffer.byteLength < offset + length) return null;
  return {
    opcode,
    payload: buffer.subarray(offset, offset + length),
    rest: buffer.subarray(offset + length)
  };
}

function encodeHeader(opcode: number, length: number, mask: boolean): Buffer {
  const first = 0x80 | (opcode & 0x0f);
  const maskBit = mask ? 0x80 : 0;
  if (length < 126) return Buffer.from([first, maskBit | length]);
  if (length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = first;
    header[1] = maskBit | 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = first;
  header[1] = maskBit | 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

export function encodeServerFrame(payload: Buffer, opcode = WS_TEXT): Buffer {
  return Buffer.concat([encodeHeader(opcode, payload.byteLength, false), payload]);
}
//#endregion
