import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { CodexController } from "./CodexController.js";

describe("CodexController", () => {
  it("starts a turn, gates approval, collects final summary and image", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "commander-controller-"));
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/fake-codex-controller.mjs");
    const config = loadConfig({
      COMMANDER_CWD: cwd,
      COMMANDER_CODEX_BIN: process.execPath,
      COMMANDER_PAIRING_FILE: join(cwd, "pairing.json"),
      COMMANDER_LOG_LEVEL: "error",
    });
    const controller = new CodexController(config, new Logger("error"), [fixture]);
    const approvals: string[] = [];
    const taskEvents: string[] = [];
    const images: string[] = [];
    controller.on("approvalRequested", (value) => approvals.push(value.requestId));
    controller.on("taskEvent", (value) => taskEvents.push(value.phase));
    controller.on("imageFound", (path) => images.push(path));

    await controller.start();
    expect(await controller.listThreads()).toHaveLength(1);
    const started = await controller.sendCommand("运行测试");
    expect(started.threadId).toMatch(/^0198/);
    expect((await controller.sendCommand("并输出简短总结")).turnId).toBe(started.turnId);
    await vi.waitFor(() => expect(approvals).toEqual(["approval-1"]));
    controller.resolveApproval("approval-1", "accept");
    await vi.waitFor(() => expect(controller.getLatestFinal()).toBe("测试完成"));
    await vi.waitFor(() => expect(taskEvents).toContain("completed"));
    expect(images[0]).toBe(`${await realpath(cwd)}/preview.png`);
    await controller.stop();
  });
});
