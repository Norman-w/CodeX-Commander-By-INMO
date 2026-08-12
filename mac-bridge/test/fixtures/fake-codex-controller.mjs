import { createInterface } from "node:readline";

let cwd = process.cwd();
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
  threadSource: null,
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

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize": send({ id: message.id, result: {} }); break;
    case "thread/list": send({ id: message.id, result: { data: [thread], nextCursor: null, backwardsCursor: null } }); break;
    case "thread/start":
      cwd = message.params?.cwd || cwd;
      thread.cwd = cwd;
      send({ id: message.id, result: { thread, model: "fake", modelProvider: "openai", serviceTier: null, cwd, instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null } });
      break;
    case "thread/resume": send({ id: message.id, result: { thread } }); break;
    case "turn/start":
      send({ id: message.id, result: { turn } });
      send({ method: "turn/started", params: { threadId: thread.id, turn } });
      setTimeout(() => send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: turn.id, itemId: "item-1", startedAtMs: Date.now(), environmentId: null, command: "pnpm test" } }), 5);
      break;
    case "turn/interrupt": send({ id: message.id, result: {} }); break;
    case "turn/steer": send({ id: message.id, result: { turnId: turn.id } }); break;
  }
  if (message.id === "approval-1" && message.result?.decision === "accept") {
    const finalItem = { type: "agentMessage", id: "item-final", text: "测试完成", phase: "final_answer", memoryCitation: null };
    send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: finalItem, completedAtMs: Date.now() } });
    send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: { type: "imageView", id: "image-1", path: `${cwd}/preview.png` }, completedAtMs: Date.now() } });
    send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn, status: "completed", completedAt: 2, durationMs: 1000 } } });
  }
});

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
