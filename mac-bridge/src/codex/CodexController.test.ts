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
      COMMANDER_AUTO_SELECT_LATEST: "false",
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

  it("auto-selects the newest task in the configured Codex workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "commander-controller-select-"));
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/fake-codex-controller.mjs");
    const config = loadConfig({
      COMMANDER_CWD: cwd,
      COMMANDER_CODEX_BIN: process.execPath,
      COMMANDER_PAIRING_FILE: join(cwd, "pairing.json"),
      COMMANDER_LOG_LEVEL: "error",
      COMMANDER_AUTO_SELECT_LATEST: "true",
    });
    const controller = new CodexController(config, new Logger("error"), [fixture]);

    await controller.start();
    expect(controller.getSelectedThreadId()).toBe("0198a648-61d4-7de0-8fc9-36122720ef34");
    await controller.stop();
  });

  it("forks a pinned desktop task so Commander owns a separate writer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "commander-controller-fork-"));
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/fake-codex-controller.mjs");
    const config = loadConfig({
      COMMANDER_CWD: cwd,
      COMMANDER_CODEX_BIN: process.execPath,
      COMMANDER_THREAD_ID: "0198a648-61d4-7de0-8fc9-36122720ef34",
      COMMANDER_PAIRING_FILE: join(cwd, "pairing.json"),
      COMMANDER_LOG_LEVEL: "error",
    });
    const controller = new CodexController(config, new Logger("error"), [fixture]);

    await controller.start();
    expect(controller.getSelectedThreadId()).toBe("0198a648-61d4-7de0-8fc9-36122720ef36");
    expect((await controller.listThreads())[0]?.title).toContain("眼镜遥控");
    await controller.stop();
  });

  it("reuses the existing Commander fork on restart", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "commander-controller-reuse-"));
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/fake-codex-controller.mjs");
    const original = process.env.FAKE_INCLUDE_COMMANDER_FORK;
    const originalBinding = process.env.FAKE_BINDING_ID;
    process.env.FAKE_INCLUDE_COMMANDER_FORK = "true";
    process.env.FAKE_BINDING_ID = "0198a648-61d4-7de0-8fc9-36122720ef39";
    const config = loadConfig({
      COMMANDER_CWD: cwd,
      COMMANDER_CODEX_BIN: process.execPath,
      COMMANDER_THREAD_ID: "0198a648-61d4-7de0-8fc9-36122720ef34",
      COMMANDER_CONTEXT_BINDING_ID: "0198a648-61d4-7de0-8fc9-36122720ef39",
      COMMANDER_PAIRING_FILE: join(cwd, "pairing.json"),
      COMMANDER_LOG_LEVEL: "error",
    });
    const controller = new CodexController(config, new Logger("error"), [fixture]);

    try {
      await controller.start();
      expect(controller.getSelectedThreadId()).toBe("0198a648-61d4-7de0-8fc9-36122720ef36");
      await controller.stop();
    } finally {
      if (original === undefined) delete process.env.FAKE_INCLUDE_COMMANDER_FORK;
      else process.env.FAKE_INCLUDE_COMMANDER_FORK = original;
      if (originalBinding === undefined) delete process.env.FAKE_BINDING_ID;
      else process.env.FAKE_BINDING_ID = originalBinding;
    }
  });

  it("returns only the physically approved permission subset for the current turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "commander-controller-permissions-"));
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/fake-codex-controller.mjs");
    const original = process.env.FAKE_APPROVAL_MODE;
    process.env.FAKE_APPROVAL_MODE = "permissions";
    const config = loadConfig({
      COMMANDER_CWD: cwd,
      COMMANDER_CODEX_BIN: process.execPath,
      COMMANDER_PAIRING_FILE: join(cwd, "pairing.json"),
      COMMANDER_LOG_LEVEL: "error",
      COMMANDER_AUTO_SELECT_LATEST: "false",
    });
    const controller = new CodexController(config, new Logger("error"), [fixture]);
    const approvals: Array<{ kind: string; detail: string }> = [];
    controller.on("approvalRequested", (value) => approvals.push(value));

    try {
      await controller.start();
      await controller.sendCommand("运行需要权限的测试");
      await vi.waitFor(() => expect(approvals[0]?.kind).toBe("permissions"));
      expect(approvals[0]?.detail).toContain("网络访问");
      expect(approvals[0]?.detail).toContain(`写入 ${await realpath(cwd)}`);
      controller.resolveApproval("approval-1", "accept");
      await vi.waitFor(() => expect(controller.getLatestFinal()).toBe("测试完成"));
      await controller.stop();
    } finally {
      if (original === undefined) delete process.env.FAKE_APPROVAL_MODE;
      else process.env.FAKE_APPROVAL_MODE = original;
    }
  });
});
