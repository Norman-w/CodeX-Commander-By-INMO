import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PathGuard } from "./PathGuard.js";

describe("PathGuard", () => {
  it("accepts files below an allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "commander-root-"));
    const file = join(root, "image.png");
    await writeFile(file, "x");
    await expect(new PathGuard([root]).resolveAllowed(file)).resolves.toBe(await realpath(file));
  });

  it("rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "commander-root-"));
    const outside = await mkdtemp(join(tmpdir(), "commander-outside-"));
    const secret = join(outside, "secret.png");
    await mkdir(join(root, "nested"));
    await writeFile(secret, "x");
    const link = join(root, "nested", "escape.png");
    await symlink(secret, link);
    await expect(new PathGuard([root]).resolveAllowed(link)).rejects.toThrow("outside");
  });
});
