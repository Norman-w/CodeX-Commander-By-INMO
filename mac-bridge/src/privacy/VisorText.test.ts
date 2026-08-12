import { describe, expect, it } from "vitest";

import { redactSecrets, sanitizeForVisor } from "./VisorText.js";

describe("visor text privacy", () => {
  it("removes local identity, configured roots and common credentials", () => {
    const userHome = ["", "Users", "private-name", "Project With Space", "out.png"].join("/");
    const openaiKey = ["sk", "proj", "abcdefghijklmnop"].join("-");
    const value = `完成 ${userHome}，目录 /opt/team/secret；${openaiKey}`;
    const sanitized = sanitizeForVisor(value, 1_000, ["/opt/team/secret"]);

    expect(sanitized).toBe("完成 [本机目录]/Project With Space/out.png，目录 [工作目录]；[已隐藏密钥]");
    expect(sanitized).not.toContain("private-name");
    expect(sanitized).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("keeps approval scope readable while hiding credentials", () => {
    const githubToken = ["ghp", "abcdefghijklmnop"].join("_");
    const value = redactSecrets(`写入 /tmp/report，令牌 ${githubToken}`);

    expect(value).toBe("写入 /tmp/report，令牌 [已隐藏令牌]");
  });
});
