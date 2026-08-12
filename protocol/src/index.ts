import { z } from "zod";

export const PROTOCOL_VERSION = "visor.v1" as const;
export const AUDIO_SAMPLE_RATE = 24_000 as const;
export const AUDIO_CHANNELS = 1 as const;
export const AUDIO_ENCODING = "pcm16le" as const;

export const IdSchema = z.string().min(1).max(160);
export const RequestIdSchema = z.string().uuid();

export const ThreadSummarySchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(240),
  preview: z.string().max(1_000).default(""),
  cwd: z.string().max(2_048).optional(),
  status: z.enum(["idle", "working", "waiting_approval", "failed", "unknown"]),
  updatedAt: z.number().int().nonnegative().optional()
});

export const ApprovalDecisionSchema = z.enum(["accept", "decline", "cancel"]);

export const ApprovalCardSchema = z.object({
  requestId: IdSchema,
  kind: z.enum(["command", "file_change"]),
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(4_000),
  threadId: IdSchema,
  turnId: IdSchema,
  expiresAt: z.number().int().nonnegative()
});

export const ImageCardSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(160),
  url: z.string().startsWith("/media/"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: z.literal("image/webp")
});

const HelloMessageBaseSchema = z.object({
  type: z.literal("hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  requestId: RequestIdSchema,
  deviceId: z.string().min(8).max(160),
  deviceName: z.string().min(1).max(120),
  appVersion: z.string().min(1).max(40),
  token: z.string().min(16).max(512).optional(),
  pairingCode: z.string().regex(/^\d{6}$/).optional(),
  lastEventId: z.number().int().nonnegative().default(0)
});

export const HelloMessageSchema = HelloMessageBaseSchema.refine((value) => Boolean(value.token) !== Boolean(value.pairingCode), {
  message: "Exactly one of token or pairingCode is required"
});

export const ClientControlMessageSchema = z.discriminatedUnion("type", [
  HelloMessageBaseSchema,
  z.object({
    type: z.literal("state_sync"),
    requestId: RequestIdSchema,
    lastEventId: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal("ptt_start"),
    requestId: RequestIdSchema,
    sampleRate: z.literal(AUDIO_SAMPLE_RATE),
    channels: z.literal(AUDIO_CHANNELS),
    encoding: z.literal(AUDIO_ENCODING)
  }),
  z.object({
    type: z.literal("ptt_end"),
    requestId: RequestIdSchema
  }),
  z.object({
    type: z.literal("task_select"),
    requestId: RequestIdSchema,
    threadId: IdSchema
  }),
  z.object({
    type: z.literal("task_command"),
    requestId: RequestIdSchema,
    text: z.string().min(1).max(20_000),
    threadId: IdSchema.optional()
  }),
  z.object({
    type: z.literal("task_interrupt"),
    requestId: RequestIdSchema,
    threadId: IdSchema.optional()
  }),
  z.object({
    type: z.literal("approval_decision"),
    requestId: RequestIdSchema,
    approvalRequestId: IdSchema,
    decision: ApprovalDecisionSchema,
    physicalConfirmation: z.literal(true)
  }),
  z.object({
    type: z.literal("report_request"),
    requestId: RequestIdSchema,
    threadId: IdSchema.optional()
  }),
  z.object({
    type: z.literal("image_request"),
    requestId: RequestIdSchema,
    path: z.string().min(1).max(4_096),
    title: z.string().min(1).max(160).optional()
  }),
  z.object({
    type: z.literal("ping"),
    requestId: RequestIdSchema,
    sentAt: z.number().int().nonnegative()
  })
]).superRefine((value, context) => {
  if (value.type === "hello" && Boolean(value.token) === Boolean(value.pairingCode)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Exactly one of token or pairingCode is required" });
  }
});

const ServerEventBaseSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  eventId: z.number().int().nonnegative(),
  sentAt: z.number().int().nonnegative()
});

export const ServerControlMessageSchema = z.discriminatedUnion("type", [
  ServerEventBaseSchema.extend({
    type: z.literal("hello_ack"),
    requestId: RequestIdSchema,
    deviceToken: z.string().min(16).max(512).optional(),
    bridgeVersion: z.string().min(1).max(40),
    audioSampleRate: z.literal(AUDIO_SAMPLE_RATE)
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("state_sync"),
    selectedThreadId: IdSchema.nullable(),
    activeTurnId: IdSchema.nullable(),
    threads: z.array(ThreadSummarySchema).max(100),
    pendingApproval: ApprovalCardSchema.nullable(),
    latestSummary: z.string().max(16_000).nullable(),
    images: z.array(ImageCardSchema).max(20)
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("task_event"),
    threadId: IdSchema,
    turnId: IdSchema.nullable(),
    phase: z.enum(["queued", "working", "progress", "waiting_approval", "completed", "interrupted", "failed"]),
    message: z.string().max(4_000),
    final: z.boolean().default(false)
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("assistant_audio_start"),
    sampleRate: z.literal(AUDIO_SAMPLE_RATE),
    channels: z.literal(AUDIO_CHANNELS),
    encoding: z.literal(AUDIO_ENCODING)
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("assistant_audio_end"),
    transcript: z.string().max(16_000).optional()
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("approval_request"),
    approval: ApprovalCardSchema
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("approval_resolved"),
    approvalRequestId: IdSchema,
    resolution: z.enum(["accept", "decline", "cancel", "expired", "resolved_elsewhere"])
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("image_card"),
    image: ImageCardSchema
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("error"),
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(2_000),
    recoverable: z.boolean(),
    requestId: RequestIdSchema.optional()
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("pong"),
    requestId: RequestIdSchema,
    echoedSentAt: z.number().int().nonnegative()
  })
]);

export type ClientControlMessage = z.infer<typeof ClientControlMessageSchema>;
export type ServerControlMessage = z.infer<typeof ServerControlMessageSchema>;
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export type ApprovalCard = z.infer<typeof ApprovalCardSchema>;
export type ImageCard = z.infer<typeof ImageCardSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const CLIENT_AUDIO_FRAME = 0x01;
export const SERVER_AUDIO_FRAME = 0x02;

export function encodeBinaryFrame(kind: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = kind;
  frame.set(payload, 1);
  return frame;
}

export function decodeBinaryFrame(frame: Uint8Array): { kind: number; payload: Uint8Array } {
  if (frame.byteLength < 2) {
    throw new Error("Binary frame must contain a kind byte and payload");
  }
  return { kind: frame[0]!, payload: frame.subarray(1) };
}
