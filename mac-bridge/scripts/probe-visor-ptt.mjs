//#region 导入/依赖
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import WebSocket from "ws";

import {
  AUDIO_CHANNELS,
  AUDIO_ENCODING,
  AUDIO_SAMPLE_RATE,
  CLIENT_AUDIO_FRAME,
  PROTOCOL_VERSION,
  encodeBinaryFrame
} from "@codex-commander/protocol";
//#endregion

//#region 常量/配置
const FRAME_MS = 40;
const MIN_PTT_MS = 600;
const WAIT_AFTER_PTT_MS = 45_000;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..");
const DAEMON_STDERR = resolve(homedir(), ".codex/app-server-daemon/app-server.stderr.log");
const BRIDGE_STDERR = resolve(packageRoot, "data/bridge.stderr.log");
loadDotenv({ path: resolve(repoRoot, ".env"), quiet: true });
//#endregion

//#region 模型/类型
/** @typedef {{ audioPath: string, pairingCode: string }} ProbeOptions */
/** @typedef {{ type?: string, code?: string, message?: string, role?: string, text?: string, transcript?: string, phase?: string, bytes?: number }} VisorEvent */
//#endregion

//#region 私有成员
const bytesPerMs = (AUDIO_SAMPLE_RATE * 2) / 1_000;
const frameBytes = Math.floor((AUDIO_SAMPLE_RATE * FRAME_MS) / 1_000) * 2;
//#endregion

//#region 公开 API
const args = parseArgs(process.argv.slice(2));
let report;
try {
  report = await runProbe(args);
} catch (error) {
  report = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
//#endregion

//#region 业务逻辑
async function runProbe(options) {
  const port = Number(options.serverPort || process.env.COMMANDER_PORT || 8787);
  const ready = await fetch(`http://127.0.0.1:${port}/readyz`).then((response) => response.ok).catch(() => false);
  if (!ready) {
    return { ok: false, error: "Bridge /readyz 不可用；请先启动 Mac Bridge" };
  }

  if (!options.audioPath) {
    return { ok: false, error: "必须通过 --audio 提供 WAV 输入；native probe 不使用 TTS" };
  }
  const pcm = padPcm(pcmFromWav(readFileSync(resolve(options.audioPath))));
  const pairingReset = !options.pairingCode;
  const pairingCode = options.pairingCode || resetPairingCode();
  const deviceId = randomUUID();
  /** @type {VisorEvent[]} */
  const events = [];
  const captions = [];
  const errors = [];
  let audioBytes = 0;
  const assistantAudio = [];
  let helloAck = false;
  let closed = false;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/visor`);
  await new Promise((resolveConnect, reject) => {
    const timer = setTimeout(() => reject(new Error("visor websocket 连接超时")), 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolveConnect();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  ws.on("close", (code, reason) => {
    closed = true;
    events.push({ type: "socket_close", code: String(code), message: String(reason || "") });
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const payload = frame.subarray(1);
      audioBytes += Math.max(0, payload.byteLength);
      if (payload.byteLength && frame[0] === 0x02) {
        assistantAudio.push(payload);
      }
      events.push({ type: "binary_audio", bytes: frame.byteLength });
      return;
    }
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      events.push({ type: "invalid_json" });
      return;
    }
    events.push({
      type: message.type,
      code: message.code,
      message: message.message,
      role: message.role,
      text: message.text,
      transcript: message.transcript,
      phase: message.phase
    });
    if (message.type === "hello_ack") helloAck = true;
    if (message.type === "caption" && message.text) captions.push({ role: message.role, text: message.text });
    if (message.type === "error") errors.push({ code: message.code, message: message.message });
  });

  sendJson(ws, {
    type: "hello",
    protocol: PROTOCOL_VERSION,
    requestId: randomUUID(),
    deviceId,
    deviceName: "visor-ptt-probe",
    appVersion: "0.1.0",
    pairingCode,
    lastEventId: 1_000_000_000
  });

  await waitFor(() => helloAck || errors.length > 0, 5_000);
  if (!helloAck) {
    ws.close();
    return summarize({ ok: false, error: "hello 未确认", events, captions, errors, audioBytes, pcmBytes: pcm.byteLength });
  }

  sendJson(ws, {
    type: "ptt_start",
    requestId: randomUUID(),
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: AUDIO_CHANNELS,
    encoding: AUDIO_ENCODING
  });
  await waitFor(() => errors.length > 0 || closed, 3_000);
  if (errors.length > 0) {
    ws.close();
    return summarize({
      ok: false,
      error: "ptt_start 被拒绝",
      pairingReset,
      diagnostics: summarizeDiagnostics(errors),
      events,
      captions,
      errors,
      audioBytes,
      pcmBytes: pcm.byteLength,
      outputAudio: options.outputAudio ? resolve(repoRoot, options.outputAudio) : undefined,
      daemon: recentLogHits(DAEMON_STDERR),
      bridgeLog: recentLogHits(BRIDGE_STDERR)
    });
  }

  for (let offset = 0; offset < pcm.byteLength; offset += frameBytes) {
    const chunk = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.byteLength));
    if (chunk.byteLength < 2) break;
    ws.send(encodeBinaryFrame(CLIENT_AUDIO_FRAME, chunk));
    await sleep(FRAME_MS);
  }

  sendJson(ws, { type: "ptt_end", requestId: randomUUID() });
  await waitFor(() => {
    return errors.length > 0
      || events.some((event) => event.type === "assistant_audio_end")
      || events.some((event) => event.type === "caption" && event.role === "assistant");
  }, WAIT_AFTER_PTT_MS);

  if (assistantAudio.length > 0 && options.outputAudio) {
    writeWav(resolve(repoRoot, options.outputAudio), Buffer.concat(assistantAudio));
  }

  ws.close();
  const daemon = recentLogHits(DAEMON_STDERR);
  const bridgeLog = recentLogHits(BRIDGE_STDERR);
  const accessDenied = errors.some((item) => /access denied|Voice Chat/i.test(`${item.code} ${item.message}`))
    || daemon.accessDenied
    || bridgeLog.accessDenied;
  const heardReply = audioBytes > 0 || events.some((event) => event.type === "assistant_audio_end" || (event.type === "caption" && event.role === "assistant"));
  return summarize({
    ok: heardReply && errors.length === 0 && !accessDenied,
    helloAck,
    pairingReset,
    note: pairingReset ? "已重置 visor 配对；眼镜需要重新写入配对码" : undefined,
    pcmBytes: pcm.byteLength,
    pcmMs: Math.round(pcm.byteLength / bytesPerMs),
    phrase: options.audioPath || options.phrase,
    audioBytes,
    captions,
    errors,
    accessDenied,
    eventTypes: events.map((event) => event.type),
    outputAudio: options.outputAudio ? resolve(repoRoot, options.outputAudio) : undefined,
    events: events.filter((event) => event.type !== "binary_audio"),
    diagnostics: summarizeDiagnostics(errors),
    daemon,
    bridgeLog
  });
}

function summarize(value) {
  return value;
}
//#endregion

//#region 方法/工具
function parseArgs(argv) {
  const options = {
    audioPath: "",
    pairingCode: "",
    outputAudio: "",
    serverPort: process.env.COMMANDER_PORT || ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    const next = argv[index + 1] || "";
    if (flag === "--audio") {
      options.audioPath = next;
      index += 1;
    } else if (flag === "--pairing-code") {
      options.pairingCode = next;
      index += 1;
    } else if (flag === "--output-audio") {
      options.outputAudio = next;
      index += 1;
    } else if (flag === "--port") {
      options.serverPort = next;
      index += 1;
    }
  }
  return options;
}

function summarizeDiagnostics(errors) {
  if (!errors.length) return undefined;
  const combined = errors.map((item) => `${item.code || ""} ${item.message || ""}`.toLowerCase());
  if (combined.some((value) => value.includes("access denied") || value.includes("voice chat"))) {
    return "语音会话被拒绝：请关闭 ChatGPT GUI 的 Voice Chat 后重试；若脚本仍失败，可尝试先重启 app-server。";
  }
  if (combined.some((value) => value.includes("api key"))) {
    return "当前 Codex app-server 的 native realtime 只接受 API key；脚本不会改用 TTS 或其他音频替代路径。";
  }
  return "当前返回 realtime_unavailable，请对照日志继续排查 / re-run bridge log.";
}

function writeWav(filePath, pcm) {
  const numChannels = 1;
  const sampleRate = AUDIO_SAMPLE_RATE;
  const bitsPerSample = 16;
  const blockAlign = numChannels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  let offset = 0;
  header.write("RIFF", offset); offset += 4;
  header.writeUInt32LE(36 + pcm.byteLength, offset); offset += 4;
  header.write("WAVE", offset); offset += 4;
  header.write("fmt ", offset); offset += 4;
  header.writeUInt32LE(16, offset); offset += 4;
  header.writeUInt16LE(1, offset); offset += 2;
  header.writeUInt16LE(numChannels, offset); offset += 2;
  header.writeUInt32LE(sampleRate, offset); offset += 4;
  header.writeUInt32LE(byteRate, offset); offset += 4;
  header.writeUInt16LE(blockAlign, offset); offset += 2;
  header.writeUInt16LE(bitsPerSample, offset); offset += 2;
  header.write("data", offset); offset += 4;
  header.writeUInt32LE(pcm.byteLength, offset); offset += 4;
  writeFileSync(filePath, Buffer.concat([header, pcm]));
}

function sendJson(ws, value) {
  ws.send(JSON.stringify(value));
}

function resetPairingCode() {
  const script = resolve(repoRoot, "scripts/reset-pairing.sh");
  const result = spawnSync(script, ["--code-only"], { encoding: "utf8" });
  const code = result.stdout.trim();
  if (result.status !== 0 || !/^\d{6}$/.test(code)) {
    throw new Error(result.stderr.trim() || "无法签发 visor 配对码；确认 Mac Bridge 登录服务在跑");
  }
  return code;
}

function padPcm(pcm) {
  const lead = Buffer.alloc(Math.floor(200 * bytesPerMs));
  const trail = Buffer.alloc(Math.floor(200 * bytesPerMs));
  let body = Buffer.from(pcm);
  const minBytes = Math.floor(MIN_PTT_MS * bytesPerMs);
  if (body.byteLength < minBytes) {
    body = Buffer.concat([body, Buffer.alloc(minBytes - body.byteLength)]);
  }
  return Buffer.concat([lead, body, trail]);
}

function recentLogHits(path) {
  try {
    const cutoff = Date.now() - 120_000;
    const lines = readFileSync(path, "utf8").trim().split("\n").slice(-200);
    const recent = lines.filter((line) => logTimeMs(line) >= cutoff);
    const hits = recent.filter((line) => /realtime|denied|append|Voice session|PTT|authenticated/i.test(line)).slice(-12);
    return {
      accessDenied: hits.some((line) => /access denied/i.test(line)),
      tail: hits.map((line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line))
    };
  } catch {
    return { accessDenied: false, tail: [] };
  }
}

function logTimeMs(line) {
  const iso = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  return iso ? Date.parse(iso[0]) : 0;
}

function pcmFromWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return buffer;
  let offset = 12;
  let data;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bits = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      data = buffer.subarray(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!data) throw new Error("WAV 没有 data 块");
  if (sampleRate !== AUDIO_SAMPLE_RATE || channels !== 1 || bits !== 16) {
    throw new Error(`音频必须是 ${AUDIO_SAMPLE_RATE} Hz mono PCM16，实际 ${sampleRate} Hz ${channels}ch ${bits}bit`);
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}
//#endregion
