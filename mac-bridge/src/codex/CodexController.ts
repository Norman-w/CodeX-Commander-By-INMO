import type { ApprovalCard, ApprovalDecision, ThreadSummary } from "@codex-commander/protocol";

import type { Thread } from "../generated/codex/v2/Thread.js";
import type { ThreadForkParams } from "../generated/codex/v2/ThreadForkParams.js";
import type { ThreadForkResponse } from "../generated/codex/v2/ThreadForkResponse.js";
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
import { resolveAppServerLaunch, type AppServerLaunchConfig } from "../app-server/discover.js";
import { redactSecrets, sanitizeForVisor } from "../privacy/VisorText.js";
import {
  CodexAppServerClient,
  type CodexNotification,
  type CodexServerRequest
} from "./CodexAppServerClient.js";

type ApprovalPending = {
  rpcId: string | number;
  card: ApprovalCard;
  responseFor: (decision: ApprovalDecision) => unknown;
  timeout: NodeJS.Timeout;
};

export type CodexControllerEvents = {
  taskEvent: (event: { threadId: string; turnId: string | null; phase: "working" | "progress" | "waiting_approval" | "completed" | "interrupted" | "failed"; message: string; final: boolean }) => void;
  approvalRequested: (card: ApprovalCard) => void;
  approvalResolved: (requestId: string, resolution: ApprovalDecision | "expired" | "resolved_elsewhere") => void;
  imageFound: (path: string, title: string) => void;
};

export class CodexController {
  private client!: CodexAppServerClient;
  private readonly testLaunch?: AppServerLaunchConfig;
  private selectedThreadId: string | null = null;
  private selectedThreadSummary: ThreadSummary | null = null;
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
    testFixture?: readonly string[]
  ) {
    if (testFixture) {
      this.testLaunch = { mode: "raw", codexBin: config.codex.bin, args: [...testFixture] };
    }
  }

  private async createClient(): Promise<CodexAppServerClient> {
    const launch = this.testLaunch ?? await resolveAppServerLaunch({
      codexBin: this.config.codex.bin,
      mode: this.config.appServer.mode,
      socketPath: this.config.appServer.socketPath
    });
    this.logger.info("Connecting to Codex app-server", { mode: launch.mode });
    const client = new CodexAppServerClient(launch, this.logger);
    client.on("notification", (notification: CodexNotification) => this.handleNotification(notification));
    client.on("request", (request: CodexServerRequest) => this.handleServerRequest(request));
    return client;
  }

  on<K extends keyof CodexControllerEvents>(event: K, listener: CodexControllerEvents[K]): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  async start(): Promise<void> {
    this.client = await this.createClient();
    await this.client.start();
    try {
      const account = await this.client.request<{ account: unknown | null; requiresOpenaiAuth: boolean }>("account/read", {});
      if (account.requiresOpenaiAuth && !account.account) {
        throw new Error("Codex 尚未登录，请先在 Mac 上打开 Codex 完成登录");
      }
      if (this.config.codex.threadId) {
        const expectedSource = commanderThreadSource(this.config);
        const existing = (await this.listThreadRecords()).find(
          (thread) => thread.threadSource === expectedSource && thread.forkedFromId === this.config.codex.threadId
        );
        if (existing) await this.resumeThread(existing.id);
        else await this.forkThreadForCommander(this.config.codex.threadId);
      } else if (this.config.codex.autoSelectLatest) {
        const latest = (await this.listThreads()).find((thread) => thread.status !== "working" && thread.status !== "waiting_approval");
        if (latest) await this.selectThread(latest.id);
      }
    } catch (error) {
      await this.client.stop().catch(() => undefined);
      throw error;
    }
  }
  async stop(): Promise<void> {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.progressBuffer = "";
    if (this.pendingApproval) {
      clearTimeout(this.pendingApproval.timeout);
      try { this.client.respond(this.pendingApproval.rpcId, this.pendingApproval.responseFor("cancel")); } catch { /* process may already be gone */ }
      this.pendingApproval = undefined;
    }
    await this.client.stop();
  }

  getSelectedThreadId(): string | null { return this.selectedThreadId; }
  getActiveTurnId(): string | null { return this.activeTurnId; }
  getLatestFinal(): string { return this.latestFinal; }
  getPendingApproval(): ApprovalCard | null { return this.pendingApproval?.card ?? null; }

  async ensureSelectedThread(): Promise<string> {
    if (this.selectedThreadId) return this.selectedThreadId;
    const params: ThreadStartParams = {
      cwd: this.config.cwd,
      approvalPolicy: this.config.codex.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: this.config.codex.sandbox,
      serviceName: "codex_commander_inmo",
      threadSource: COMMANDER_THREAD_SOURCE,
      config: realtimeSessionConfig(),
      ...(this.config.codex.model ? { model: this.config.codex.model } : {})
    };
    const started = await this.client.request<ThreadStartResponse>("thread/start", params);
    this.selectedThreadId = started.thread.id;
    this.selectedThreadSummary = {
      ...toThreadSummary(started.thread, this.config.cwd),
      title: "眼镜遥控 · 新任务"
    };
    await this.client.request("thread/name/set", {
      threadId: started.thread.id,
      name: "眼镜遥控 · 新任务"
    });
    this.latestFinal = "";
    return started.thread.id;
  }

  async startVoiceThread(): Promise<string> {
    this.selectedThreadId = null;
    this.selectedThreadSummary = null;
    this.activeTurnId = null;
    return this.ensureSelectedThread();
  }

  requestJsonRpc<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.client.request<T>(method, params, timeoutMs);
  }

  subscribeNotifications(listener: (notification: CodexNotification) => void): () => void {
    const wrapped = (notification: CodexNotification) => listener(notification);
    this.client.on("notification", wrapped);
    return () => this.client.off("notification", wrapped);
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const records = await this.listThreadRecords();
    const tasks = records
      .filter((thread) => isCommanderThreadSource(thread.threadSource))
      .map((thread) => toThreadSummary(thread, this.config.cwd));
    if (this.selectedThreadSummary && !tasks.some((thread) => thread.id === this.selectedThreadSummary?.id)) {
      tasks.unshift(this.selectedThreadSummary);
    }
    return tasks;
  }

  private async listThreadRecords(): Promise<Thread[]> {
    const params: ThreadListParams = {
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      cwd: this.config.cwd,
      sourceKinds: ["cli", "vscode", "appServer", "unknown"]
    };
    const result = await this.client.request<ThreadListResponse>("thread/list", params);
    return result.data;
  }

  async selectThread(threadId: string): Promise<void> {
    if (this.activeTurnId) {
      throw new Error("Codex 正在执行，完成或中断后才能切换任务");
    }
    const available = await this.listThreads();
    if (!available.some((thread) => thread.id === threadId)) {
      throw new Error("该任务不属于当前配置的 Codex 工作目录");
    }
    await this.resumeThread(threadId);
  }

  private async resumeThread(threadId: string): Promise<void> {
    const params: ThreadResumeParams = {
      threadId,
      cwd: this.config.cwd,
      approvalPolicy: this.config.codex.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: this.config.codex.sandbox
    };
    const resumed = await this.client.request<ThreadResumeResponse>("thread/resume", params);
    this.selectedThreadId = threadId;
    this.selectedThreadSummary = toThreadSummary(resumed.thread, this.config.cwd);
    const summary = sanitizeForVisor(latestSummaryFromThread(resumed.thread), 16_000, [this.config.cwd]);
    if (summary) this.summaries.set(threadId, summary);
    this.latestFinal = summary;
    const activeTurn = [...resumed.thread.turns].reverse().find((turn) => turn.status === "inProgress");
    this.activeTurnId = activeTurn?.id ?? null;
  }

  private async forkThreadForCommander(sourceThreadId: string): Promise<void> {
    const params: ThreadForkParams = {
      threadId: sourceThreadId,
      cwd: this.config.cwd,
      approvalPolicy: this.config.codex.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: this.config.codex.sandbox,
      ephemeral: false,
      threadSource: commanderThreadSource(this.config)
    };
    const forked = await this.client.request<ThreadForkResponse>("thread/fork", params);
    this.selectedThreadId = forked.thread.id;
    const sourceTitle = sanitizeForVisor(forked.thread.name || forked.thread.preview || "当前任务", 180, [this.config.cwd]);
    await this.client.request("thread/name/set", {
      threadId: forked.thread.id,
      name: `眼镜遥控 · ${sourceTitle}`.slice(0, 240)
    });
    this.selectedThreadSummary = {
      ...toThreadSummary(forked.thread, this.config.cwd),
      title: `眼镜遥控 · ${sourceTitle}`.slice(0, 240)
    };
    const summary = sanitizeForVisor(latestSummaryFromThread(forked.thread), 16_000, [this.config.cwd]);
    if (summary) this.summaries.set(forked.thread.id, summary);
    this.latestFinal = summary;
    this.activeTurnId = null;
  }

  async sendCommand(text: string, requestedThreadId?: string): Promise<{ threadId: string; turnId: string }> {
    if (requestedThreadId && requestedThreadId !== this.selectedThreadId) await this.selectThread(requestedThreadId);
    const threadId = await this.ensureSelectedThread();
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
        message: "已把补充指令交给正在执行的 Codex",
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
    this.emit("taskEvent", { threadId, turnId: this.activeTurnId, phase: "working", message: "已交给 Codex，正在执行", final: false });
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
    this.client.respond(pending.rpcId, pending.responseFor(decision));
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
        const summary = sanitizeForVisor(item.text, 16_000, [this.config.cwd]);
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
      const fallback = status === "interrupted" ? "任务已中断" : status === "failed" ? `任务失败：${turn?.error?.message || "请在 Mac 上查看详情"}` : "任务已完成";
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
    if (
      request.method !== "item/commandExecution/requestApproval" &&
      request.method !== "item/fileChange/requestApproval" &&
      request.method !== "item/permissions/requestApproval"
    ) {
      this.client.respondError(request.id, -32601, "CodeX Commander does not support this interactive request");
      this.logger.warn("Declined unsupported Codex server request", { method: request.method });
      return;
    }

    if (this.pendingApproval) {
      this.client.respond(request.id, denyResponse(request.method));
      this.logger.warn("Declined concurrent approval request");
      return;
    }

    const params = request.params ?? {};
    const requestId = String(request.id);
    const kind = request.method.includes("commandExecution")
      ? "command"
      : request.method.includes("permissions")
        ? "permissions"
        : "file_change";
    const command = typeof params.command === "string" ? params.command : undefined;
    const grantRoot = typeof params.grantRoot === "string" ? `\n写入范围：${params.grantRoot}` : "";
    const permissionDetail = kind === "permissions" ? describePermissions(params.permissions) : "";
    const detail = redactSecrets(`${command || stringOf(params.reason, kind === "command" ? "Codex 请求执行命令" : kind === "permissions" ? "Codex 请求额外权限" : "Codex 请求修改文件")}${grantRoot}${permissionDetail}`);
    const card: ApprovalCard = {
      requestId,
      kind,
      title: kind === "command" ? "确认执行命令" : kind === "permissions" ? "确认额外权限" : "确认修改文件",
      detail: detail.slice(0, 4_000),
      threadId: stringOf(params.threadId, this.selectedThreadId || "unknown"),
      turnId: stringOf(params.turnId, this.activeTurnId || "unknown"),
      expiresAt: Date.now() + 60_000
    };
    const timeout = setTimeout(() => {
      if (this.pendingApproval?.card.requestId !== requestId) return;
      this.pendingApproval = undefined;
      try { this.client.respond(request.id, denyResponse(request.method)); } catch { /* app-server exited */ }
      this.emit("approvalResolved", requestId, "expired");
    }, 60_000);
    timeout.unref();
    this.pendingApproval = {
      rpcId: request.id,
      card,
      responseFor: (decision) => responseForApproval(request.method, params.permissions, decision),
      timeout
    };
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
      message: conciseProgress(this.progressBuffer),
      final: false
    });
    this.progressBuffer = "";
  }
}

function toThreadSummary(thread: Thread, sensitiveRoot?: string): ThreadSummary {
  const activeFlags = thread.status.type === "active" ? (thread.status.activeFlags ?? []) : [];
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
    title: sanitizeForVisor(thread.name || thread.preview || "未命名 Codex 任务", 240, sensitiveRoot ? [sensitiveRoot] : []),
    preview: sanitizeForVisor(thread.preview || "", 1_000, sensitiveRoot ? [sensitiveRoot] : []),
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

function responseForApproval(method: string, requested: unknown, decision: ApprovalDecision): unknown {
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: decision === "accept" ? grantedPermissions(requested) : {},
      scope: "turn"
    };
  }
  return { decision };
}

function denyResponse(method: string): unknown {
  return method === "item/permissions/requestApproval"
    ? { permissions: {}, scope: "turn" }
    : { decision: "decline" };
}

function describePermissions(value: unknown): string {
  if (!isRecord(value)) return "\n请求范围：未提供";
  const parts: string[] = [];
  const network = isRecord(value.network) ? value.network : undefined;
  if (network?.enabled === true) parts.push("网络访问");

  const fileSystem = isRecord(value.fileSystem) ? value.fileSystem : undefined;
  const reads = stringArray(fileSystem?.read);
  const writes = stringArray(fileSystem?.write);
  const entries = Array.isArray(fileSystem?.entries)
    ? fileSystem.entries.flatMap((entry) => {
        if (!isRecord(entry) || !isRecord(entry.path)) return [];
        const path = typeof entry.path.path === "string"
          ? entry.path.path
          : typeof entry.path.pattern === "string"
            ? entry.path.pattern
            : typeof entry.path.value === "string"
              ? `系统范围：${entry.path.value}`
              : "未命名路径";
        return [`${entry.access === "write" ? "写入" : entry.access === "deny" ? "禁止" : "读取"} ${path}`];
      })
    : [];
  parts.push(...reads.map((path) => `读取 ${path}`), ...writes.map((path) => `写入 ${path}`), ...entries);
  return `\n请求范围：${parts.length ? parts.join("；") : "未提供"}`;
}

function conciseProgress(value: string): string {
  const normalized = sanitizeForVisor(value, 4_000)
    .replace(/```[\s\S]*?```/g, " [代码内容] ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= 900) return normalized;
  return `…${normalized.slice(-899)}`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function grantedPermissions(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return {
    ...(isRecord(value.network) ? { network: value.network } : {}),
    ...(isRecord(value.fileSystem) ? { fileSystem: value.fileSystem } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COMMANDER_THREAD_SOURCE = "codex_commander_inmo";

function realtimeSessionConfig(): NonNullable<ThreadStartParams["config"]> {
  return {
    features: { realtime_conversation: true },
    realtime: { version: "v3", type: "conversational" }
  };
}

function commanderThreadSource(config: BridgeConfig): string {
  return config.codex.contextBindingId
    ? `${COMMANDER_THREAD_SOURCE}:${config.codex.contextBindingId}`
    : COMMANDER_THREAD_SOURCE;
}

function isCommanderThreadSource(value: string | null): boolean {
  return value === COMMANDER_THREAD_SOURCE || value?.startsWith(`${COMMANDER_THREAD_SOURCE}:`) === true;
}
