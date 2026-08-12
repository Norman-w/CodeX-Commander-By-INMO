import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex" } });
    return;
  }
  if (message.method === "test/echo") {
    send({ id: message.id, result: { echoed: message.params?.value } });
    send({ method: "test/notification", params: { ready: true } });
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "echo safe" } });
    return;
  }
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "unknown" } });
});

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

