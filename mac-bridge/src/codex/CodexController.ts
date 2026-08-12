import type { ApprovalCard, ApprovalDecision, ThreadSummary } from "@codex-commander/protocol";

import type { Thread } from "../generated/codex/v2/Thread.js";
import type { ThreadListParams } from "../generated/codex/v2/ThreadListParams.js";
import type { ThreadListResponse } from "../generated/codex/v2/ThreadListResponse.js";
import type { ThreadResumeParams } from "../generated/codex/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "../generated/codex/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "../generated/codex/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../generated/codex/v2/ThreadStartResponse.js";
import type { TurnStartParams } from "../generated/codex/v2/TurnStartParams.js";
import type { TurnStartResponse } from "../generated/codex/v2/TurnStartResponse.js";
import type { TurnSteerParams } from "../generated/codex/v2/TurnSteerParams.js";
import type { TurnSteerResponse } from "../generated/codex/v2/TurnSteerResponse.js";

import type { BridgeConfig } from "../config.js";
import type { Logger } from "../log.js";
import {
  CodexAppServerClient,
  type CodexNotification,
  type CodexServerRequest
} from "./CodexAppServerClient.js";

type ApprovalPending = {
  rpcId: string | number;
  card: ApprovalCard;
  timeout: NodeJS.Timeout;
};

export type CodexControllerEvents = {
  taskEvent: (event: { threadId: string; turnId: string | null; phase: "working" | "progress" | "waiting_approval" | "completed" | "interrupted" | "failed"; message: string; final: boolean }) => void;
  approvalRequested: (card: ApprovalCard) => void;
  approvalResolved: (requestId: string, resolution: ApprovalDecision | "expired" | "resolved_elsewhere") => void;
  imageFound: (path: string, title: string) => void;
};

export class CodexController {
  private readonly client: CodexAppServerClient;
  private selectedThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private latestFinal = "";
  private readonly summaries = new Map<string, string>();
  private pendingApproval?: ApprovalPending;
  private progressBuffer = "";
  private progressThreadId = "";
  private progressTurnId: string | null = null;
  private progressTimer?: NodeJS.Timeout;
  private readonly listeners: { [K in keyof CodexControllerEvents]: Set<CodexControllerEvents[K]> } = {
    taskEvent: new Set(),
    approvalRequested: new Set(),
    approvalResolved: new Set(),
    imageFound: new Set()
  };

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    appServerArgs?: readonly string[]
  ) {
    this.client = new CodexAppServerClient(config.codex.bin, logger, appServerArgs);
    this.client.on("notification", (notification: CodexNotification) => this.handleNotification(notification));
    this.client.on("request", (request: CodexServerRequest) => this.handleServerRequest(request));
  }

  on<K extends keyof CodexControllerEvents>(event: K, listener: CodexControllerEvents[K]): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  async start(): Promise<void> { await this.client.start(); }
  async stop(): Promise<void> {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.progressBuffer = "";
    if (this.pendingApproval) {
      clearTimeout(this.pendingApproval.timeout);
      try { this.client.respond(this.pendingApproval.rpcId, { decision: "cancel" }); } catch { /* process may already be gone */ }
      this.pendingApproval = undefined;
    }
    await this.client.stop();
  }

  getSelectedThreadId(): string | null { return this.selectedThreadId; }
  getActiveTurnId(): string | null { return this.activeTurnId; }
  getLatestFinal(): string { return this.latestFinal; }
  getPendingApproval(): ApprovalCard | null { return this.pendingApproval?.card ?? null; }

  async listThreads(): Promise<ThreadSummary[]> {
    const params: ThreadListParams = {
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      cwd: this.config.cwd,
      sourceKinds: ["cli", "vscode", "appServer"]
    };
    const result = await this.client.request<ThreadListResponse>("thread/list", params);
    return result.data.map(toThreadSummary);
  }

  async selectThread(threadId: string): Promise<void> {
    const params: ThreadResumeParams = {
      threadId,
      cwd: this.config.cwd,
      approvalPolicy: this.config.codex.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: this.config.codex.sandbox
    };
    const resumed = await this.client.request<ThreadResumeResponse>("thread/resume", params);
    this.selectedThreadId = threadId;
    const summary = latestSummaryFromThread(resumed.thread);
    if (summary) this.summaries.set(threadId, summary);
    this.latestFinal = summary;
    const activeTurn = [...resumed.thread.turns].reverse().find((turn) => turn.status === "inProgress");
    this.activeTurnId = activeTurn?.id ?? null;
  }

  async sendCommand(text: string, requestedThreadId?: string): Promise<{ threadId: string; turnId: string }> {
    if (requestedThreadId && requestedThreadId !== this.selectedThreadId) await this.selectThread(requestedThreadId);
    if (!this.selectedThreadId) {
      const params: ThreadStartParams = {
        cwd: this.config.cwd,
        approvalPolicy: this.config.codex.approvalPolicy,
        approvalsReviewer: "user",
        sandbox: this.config.codex.sandbox,
        serviceName: "codex_commander_inmo",
        ...(this.config.codex.model ? { model: this.config.codex.model } : {})
      };
      const started = await this.client.request<ThreadStartResponse>("thread/start", params);
      this.selectedThreadId = started.thread.id;
      this.latestFinal = "";
    }

    const threadId = this.selectedThreadId;
    if (this.activeTurnId) {
      const params: TurnSteerParams = {
        threadId,
        expectedTurnId: this.activeTurnId,
        input: [{ type: "text", text, text_elements: [] }]
      };
      const steered = await this.client.request<TurnSteerResponse>("turn/steer", params);
      this.emit("taskEvent", {
        threadId,
        turnId: steered.turnId,
        phase: "working",
        message: "已向正在执行的 Codex 任务追加指令",
        final: false
      });
      return { threadId, turnId: steered.turnId };
    }
    const params: TurnStartParams = {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd: this.config.cwd,
      approvalPolicy: this.config.codex.approvalPolicy,
      approvalsReviewer: "user",
      sandboxPolicy: sandboxPolicy(this.config),
      ...(this.config.codex.model ? { model: this.config.codex.model } : {})
    };
    const result = await this.client.request<TurnStartResponse>("turn/start", params);
    this.activeTurnId = result.turn.id;
    this.latestFinal = "";
    this.emit("taskEvent", { threadId, turnId: this.activeTurnId, phase: "working", message: "Codex 已开始执行", final: false });
    return { threadId, turnId: result.turn.id };
  }

  async interrupt(requestedThreadId?: string): Promise<void> {
    const threadId = requestedThreadId || this.selectedThreadId;
    if (!threadId || !this.activeTurnId) throw new Error("No active Codex turn to interrupt");
    await this.client.request("turn/interrupt", { threadId, turnId: this.activeTurnId });
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApproval;
    if (!pending || pending.card.requestId !== requestId) throw new Error("Approval is no longer pending");
    clearTimeout(pending.timeout);
    this.pendingApproval = undefined;
    this.client.respond(pending.rpcId, { decision });
    this.emit("approvalResolved", requestId, decision);
  }

  private handleNotification(notification: CodexNotification): void {
    const params = notification.params ?? {};
    if (notification.method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (delta) this.appendProgress(
        stringOf(params.threadId, this.selectedThreadId || "unknown"),
        nullableString(params.turnId),
        delta
      );
      return;
    }

    if (notification.method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string" && item.phase !== "commentary") {
        const threadId = stringOf(params.threadId, this.selectedThreadId || "unknown");
        const summary = item.text.slice(0, 16_000);
        this.summaries.set(threadId, summary);
        if (threadId === this.selectedThreadId) this.latestFinal = summary;
      }
      if (item?.type === "imageView" && typeof item.path === "string") this.emit("imageFound", item.path, "Codex 图片");
      if (item?.type === "imageGeneration" && typeof item.savedPath === "string") this.emit("imageFound", item.savedPath, "Codex 生成图片");
      return;
    }

    if (notification.method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id) this.activeTurnId = turn.id;
      this.selectedThreadId = stringOf(params.threadId, this.selectedThreadId || "") || this.selectedThreadId;
      return;
    }

    if (notification.method === "turn/completed") {
      this.flushProgress();
      const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
      const threadId = stringOf(params.threadId, this.selectedThreadId || "unknown");
      const status = turn?.status;
      const phase = status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed";
      const fallback = status === "interrupted" ? "Codex 任务已中断" : status === "failed" ? `Codex 任务失败：${turn?.error?.message || "未知错误"}` : "Codex 任务已完成，触摸可听汇报";
      const summary = this.summaries.get(threadId) || fallback;
      if (threadId === this.selectedThreadId) this.latestFinal = this.summaries.get(threadId) || "";
      this.emit("taskEvent", { threadId, turnId: turn?.id ?? this.activeTurnId, phase, message: summary.slice(0, 4_000), final: true });
      this.activeTurnId = null;
      return;
    }

    if (notification.method === "serverRequest/resolved" && this.pendingApproval) {
      const id = rpcIdString(params.requestId);
      if (id && id === this.pendingApproval.card.requestId) {
        clearTimeout(this.pendingApproval.timeout);
        this.pendingApproval = undefined;
        this.emit("approvalResolved", id, "resolved_elsewhere");
      }
    }
  }

  private handleServerRequest(request: CodexServerRequest): void {
    if (request.method !== "item/commandExecution/requestApproval" && request.method !== "item/fileChange/requestApproval") {
      this.client.respondError(request.id, -32601, "CodeX Commander does not support this interactive request");
      this.logger.warn("Declined unsupported Codex server request", { method: request.method });
      return;
    }

    if (this.pendingApproval) {
      this.client.respond(request.id, { decision: "decline" });
      this.logger.warn("Declined concurrent approval request");
      return;
    }

    const params = request.params ?? {};
    const requestId = String(request.id);
    const kind = request.method.includes("commandExecution") ? "command" : "file_change";
    const command = typeof params.command === "string" ? params.command : undefined;
    const grantRoot = typeof params.grantRoot === "string" ? `\n写入范围：${params.grantRoot}` : "";
    const detail = `${command || stringOf(params.reason, kind === "command" ? "Codex 请求执行命令" : "Codex 请求修改文件")}${grantRoot}`;
    const card: ApprovalCard = {
      requestId,
      kind,
      title: kind === "command" ? "确认执行命令" : "确认修改文件",
      detail: detail.slice(0, 4_000),
      threadId: stringOf(params.threadId, this.selectedThreadId || "unknown"),
      turnId: stringOf(params.turnId, this.activeTurnId || "unknown"),
      expiresAt: Date.now() + 60_000
    };
    const timeout = setTimeout(() => {
      if (this.pendingApproval?.card.requestId !== requestId) return;
      this.pendingApproval = undefined;
      try { this.client.respond(request.id, { decision: "cancel" }); } catch { /* app-server exited */ }
      this.emit("approvalResolved", requestId, "expired");
    }, 60_000);
    timeout.unref();
    this.pendingApproval = { rpcId: request.id, card, timeout };
    this.emit("approvalRequested", card);
  }

  private emit<K extends keyof CodexControllerEvents>(event: K, ...args: Parameters<CodexControllerEvents[K]>) {
    for (const listener of this.listeners[event]) (listener as (...values: Parameters<CodexControllerEvents[K]>) => void)(...args);
  }

  private appendProgress(threadId: string, turnId: string | null, delta: string): void {
    if (this.progressBuffer && (threadId !== this.progressThreadId || turnId !== this.progressTurnId)) this.flushProgress();
    this.progressThreadId = threadId;
    this.progressTurnId = turnId;
    this.progressBuffer = `${this.progressBuffer}${delta}`.slice(-4_000);
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => this.flushProgress(), 300);
    this.progressTimer.unref();
  }

  private flushProgress(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    if (!this.progressBuffer) return;
    this.emit("taskEvent", {
      threadId: this.progressThreadId || this.selectedThreadId || "unknown",
      turnId: this.progressTurnId,
      phase: "progress",
      message: this.progressBuffer,
      final: false
    });
    this.progressBuffer = "";
  }
}

function toThreadSummary(thread: Thread): ThreadSummary {
  const activeFlags = thread.status.type === "active" ? thread.status.activeFlags : [];
  const status = activeFlags.includes("waitingOnApproval")
    ? "waiting_approval"
    : thread.status.type === "active"
      ? "working"
      : thread.status.type === "systemError"
        ? "failed"
        : thread.status.type === "idle" || thread.status.type === "notLoaded"
          ? "idle"
          : "unknown";
  return {
    id: thread.id,
    title: (thread.name || thread.preview || "未命名 Codex 任务").slice(0, 240),
    preview: (thread.preview || "").slice(0, 1_000),
    cwd: thread.cwd.slice(0, 2_048),
    status,
    updatedAt: thread.updatedAt
  };
}

function sandboxPolicy(config: BridgeConfig): import("../generated/codex/v2/SandboxPolicy.js").SandboxPolicy {
  if (config.codex.sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (config.codex.sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [config.cwd],
    networkAccess: config.codex.networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function stringOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function rpcIdString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function latestSummaryFromThread(thread: Thread): string {
  for (const turn of [...thread.turns].reverse()) {
    for (const item of [...turn.items].reverse()) {
      if (item.type === "agentMessage" && item.phase !== "commentary" && item.text) return item.text.slice(0, 16_000);
    }
  }
  return "";
}
