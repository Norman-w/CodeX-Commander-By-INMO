import { createInterface } from "node:readline";

let cwd = process.cwd();
const approvalMode = process.env.FAKE_APPROVAL_MODE || "command";
const includeCommanderFork = process.env.FAKE_INCLUDE_COMMANDER_FORK === "true";
const bindingId = process.env.FAKE_BINDING_ID || "";
const thread = {
  id: "0198a648-61d4-7de0-8fc9-36122720ef34",
  sessionId: "session-1",
  forkedFromId: null,
  parentThreadId: null,
  preview: "眼镜遥控测试",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 2,
  recencyAt: 2,
  status: { type: "idle" },
  path: null,
  cwd,
  cliVersion: "fake",
  source: "appServer",
  threadSource: bindingId ? `codex_commander_inmo:${bindingId}` : "codex_commander_inmo",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "眼镜遥控测试",
  turns: [],
};
const turn = {
  id: "0198a648-61d4-7de0-8fc9-36122720ef35",
  items: [],
  itemsView: "full",
  status: "inProgress",
  error: null,
  startedAt: 1,
  completedAt: null,
  durationMs: null,
};
const existingFork = {
  ...thread,
  id: "0198a648-61d4-7de0-8fc9-36122720ef36",
  forkedFromId: thread.id,
  name: "眼镜遥控 · 眼镜遥控测试",
  threadSource: "codex_commander_inmo",
};

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize": send({ id: message.id, result: {} }); break;
    case "account/read": send({ id: message.id, result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true } }); break;
    case "thread/list": send({ id: message.id, result: { data: includeCommanderFork ? [existingFork, thread] : [thread], nextCursor: null, backwardsCursor: null } }); break;
    case "thread/start":
      cwd = message.params?.cwd || cwd;
      thread.cwd = cwd;
      send({ id: message.id, result: { thread, model: "fake", modelProvider: "openai", serviceTier: null, cwd, instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null } });
      break;
    case "thread/fork": {
      const forked = { ...thread, id: "0198a648-61d4-7de0-8fc9-36122720ef36", forkedFromId: message.params?.threadId || thread.id, threadSource: message.params?.threadSource || null };
      send({ id: message.id, result: { thread: forked, model: "fake", modelProvider: "openai", serviceTier: null, cwd, instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null } });
      break;
    }
    case "thread/name/set":
      thread.name = message.params?.name || thread.name;
      send({ id: message.id, result: {} });
      break;
    case "thread/resume": send({ id: message.id, result: { thread: message.params?.threadId === existingFork.id ? existingFork : thread } }); break;
    case "turn/start":
      send({ id: message.id, result: { turn } });
      send({ method: "turn/started", params: { threadId: thread.id, turn } });
      setTimeout(() => {
        if (approvalMode === "permissions") {
          send({
            id: "approval-1",
            method: "item/permissions/requestApproval",
            params: {
              threadId: thread.id,
              turnId: turn.id,
              itemId: "item-1",
              environmentId: null,
              startedAtMs: Date.now(),
              cwd,
              reason: "需要访问测试目录",
              permissions: { network: { enabled: true }, fileSystem: { read: null, write: [cwd] } },
            },
          });
        } else {
          send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: turn.id, itemId: "item-1", startedAtMs: Date.now(), environmentId: null, command: "pnpm test" } });
        }
      }, 5);
      break;
    case "turn/interrupt": send({ id: message.id, result: {} }); break;
    case "turn/steer": send({ id: message.id, result: { turnId: turn.id } }); break;
  }
  if (message.id === "approval-1" && (message.result?.decision === "accept" || message.result?.permissions?.network?.enabled === true)) {
    const finalItem = { type: "agentMessage", id: "item-final", text: "测试完成", phase: "final_answer", memoryCitation: null };
    send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: finalItem, completedAtMs: Date.now() } });
    send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: { type: "imageView", id: "image-1", path: `${cwd}/preview.png` }, completedAtMs: Date.now() } });
    send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn, status: "completed", completedAt: 2, durationMs: 1000 } } });
  }
});

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
