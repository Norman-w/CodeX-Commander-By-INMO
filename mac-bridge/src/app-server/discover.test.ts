import { describe, expect, it } from "vitest";

import { defaultControlSocket, resolveCodexBin } from "./discover.js";

describe("app-server discover", () => {
  it("resolves bundled codex path on macOS layout when present", () => {
    expect(resolveCodexBin("codex")).toMatch(/codex$/);
  });

  it("uses default control socket under ~/.codex", () => {
    expect(defaultControlSocket()).toContain(".codex/app-server-control/app-server-control.sock");
  });

  it("honors configured socket override", () => {
    expect(defaultControlSocket("/tmp/custom.sock")).toBe("/tmp/custom.sock");
  });
});
