import { describe, expect, it } from "vitest";

import {
  CLIENT_AUDIO_FRAME,
  ClientControlMessageSchema,
  decodeBinaryFrame,
  encodeBinaryFrame
} from "./index.js";

describe("visor.v1 protocol", () => {
  it("accepts a token-authenticated hello", () => {
    const message = ClientControlMessageSchema.parse({
      type: "hello",
      protocol: "visor.v1",
      requestId: "0198a648-61d4-7de0-8fc9-36122720ef34",
      deviceId: "air3-test-device",
      deviceName: "INMO AIR3",
      appVersion: "0.1.0",
      token: "a-token-that-is-long-enough",
      lastEventId: 0
    });

    expect(message.type).toBe("hello");
  });

  it("requires exactly one authentication method", () => {
    const result = ClientControlMessageSchema.safeParse({
      type: "hello",
      protocol: "visor.v1",
      requestId: "0198a648-61d4-7de0-8fc9-36122720ef34",
      deviceId: "air3-test-device",
      deviceName: "INMO AIR3",
      appVersion: "0.1.0",
      token: "a-token-that-is-long-enough",
      pairingCode: "123456",
      lastEventId: 0
    });

    expect(result.success).toBe(false);
  });

  it("round trips a binary audio frame", () => {
    const payload = Uint8Array.from([0, 1, 2, 255]);
    const decoded = decodeBinaryFrame(encodeBinaryFrame(CLIENT_AUDIO_FRAME, payload));

    expect(decoded.kind).toBe(CLIENT_AUDIO_FRAME);
    expect([...decoded.payload]).toEqual([...payload]);
  });

  it("requires an explicit physical confirmation for approvals", () => {
    const result = ClientControlMessageSchema.safeParse({
      type: "approval_decision",
      requestId: "0198a648-61d4-7de0-8fc9-36122720ef34",
      approvalRequestId: "approval-1",
      decision: "accept",
      physicalConfirmation: false
    });
    expect(result.success).toBe(false);
  });
});
