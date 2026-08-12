import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PairingStore } from "./PairingStore.js";

describe("PairingStore", () => {
  it("persists only hashes and accepts the issued device token", async () => {
    const root = await mkdtemp(join(tmpdir(), "commander-pairing-"));
    const path = join(root, "pairing.json");
    const store = new PairingStore(path);
    const initial = await store.initialize();
    expect(initial.code).toMatch(/^\d{6}$/);
    const token = await store.pair("air3-device", initial.code);
    expect(token).toBeTruthy();
    expect(store.isTokenValid("air3-device", token!)).toBe(true);
    expect(store.isTokenValid("another-device", token!)).toBe(false);

    const restarted = new PairingStore(path);
    const snapshot = await restarted.initialize();
    expect(snapshot.pairedDeviceId).toBe("air3-device");
    expect(restarted.isTokenValid("air3-device", token!)).toBe(true);
  });

  it("issues a displayable new code after an unpaired restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "commander-pairing-"));
    const path = join(root, "pairing.json");
    await new PairingStore(path).initialize();
    const restarted = new PairingStore(path);
    expect((await restarted.initialize()).code).toMatch(/^\d{6}$/);
  });
});
