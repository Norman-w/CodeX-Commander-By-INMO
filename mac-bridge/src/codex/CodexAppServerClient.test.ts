import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { Logger } from "../log.js";
import { CodexAppServerClient, type CodexNotification, type CodexServerRequest } from "./CodexAppServerClient.js";

describe("CodexAppServerClient", () => {
  it("initializes, correlates responses, and forwards notifications and requests", async () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/fake-codex-app-server.mjs");
    const client = CodexAppServerClient.fromRaw(process.execPath, [fixture], new Logger("error"));
    const notifications: CodexNotification[] = [];
    const requests: CodexServerRequest[] = [];
    client.on("notification", (value) => notifications.push(value));
    client.on("request", (value) => requests.push(value));

    await client.start();
    await expect(client.request("test/echo", { value: "hello" })).resolves.toEqual({ echoed: "hello" });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.method).toBe("item/commandExecution/requestApproval");
    client.respond(requests[0]!.id, { decision: "decline" });
    await client.stop();
  });
});

