import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type PersistedPairingState = {
  version: 1;
  pairingCodeHash: string;
  pairingCodeExpiresAt: number;
  deviceId?: string;
  deviceTokenHash?: string;
};

export type PairingSnapshot = {
  code: string;
  expiresAt: number;
  pairedDeviceId?: string;
};

const PAIRING_TTL_MS = 10 * 60 * 1_000;
const MAX_PAIRING_ATTEMPTS = 10;

export class PairingStore {
  private state!: PersistedPairingState;
  private pairingCode = "";
  private failedPairingAttempts = 0;

  constructor(private readonly path: string) {}

  async initialize(): Promise<PairingSnapshot> {
    try {
      this.state = JSON.parse(await readFile(this.path, "utf8")) as PersistedPairingState;
    } catch {
      this.state = { version: 1, pairingCodeHash: "", pairingCodeExpiresAt: 0 };
    }

    // The plaintext one-time code is intentionally never persisted. If the bridge
    // restarts before first pairing, issue a new code so the console can display it.
    if (!this.state?.deviceId || !this.state.deviceTokenHash) {
      await this.rotatePairingCode(true);
    }

    return this.snapshot();
  }

  snapshot(): PairingSnapshot {
    return {
      code: this.pairingCode || "already paired",
      expiresAt: this.state.pairingCodeExpiresAt,
      ...(this.state.deviceId ? { pairedDeviceId: this.state.deviceId } : {})
    };
  }

  isTokenValid(deviceId: string, token: string): boolean {
    return this.state.deviceId === deviceId && Boolean(this.state.deviceTokenHash) && safeEqual(this.state.deviceTokenHash!, hash(token));
  }

  async pair(deviceId: string, code: string): Promise<string | undefined> {
    if (this.state.deviceId && this.state.deviceTokenHash) return undefined;
    if (this.state.pairingCodeExpiresAt <= Date.now()) return undefined;
    if (!safeEqual(this.state.pairingCodeHash, hash(code))) {
      this.failedPairingAttempts++;
      if (this.failedPairingAttempts >= MAX_PAIRING_ATTEMPTS) await this.rotatePairingCode(true);
      return undefined;
    }

    const token = randomBytes(32).toString("base64url");
    this.failedPairingAttempts = 0;
    this.state = {
      ...this.state,
      deviceId,
      deviceTokenHash: hash(token),
      pairingCodeExpiresAt: 0,
      pairingCodeHash: hash(randomBytes(16).toString("hex"))
    };
    this.pairingCode = "";
    await this.persist();
    return token;
  }

  async reset(): Promise<PairingSnapshot> {
    await this.rotatePairingCode(true);
    return this.snapshot();
  }

  private async rotatePairingCode(clearDevice = false): Promise<void> {
    this.failedPairingAttempts = 0;
    this.pairingCode = randomInt(0, 1_000_000).toString().padStart(6, "0");
    this.state = {
      version: 1,
      pairingCodeHash: hash(this.pairingCode),
      pairingCodeExpiresAt: Date.now() + PAIRING_TTL_MS,
      ...(clearDevice ? {} : this.state?.deviceId ? { deviceId: this.state.deviceId, deviceTokenHash: this.state.deviceTokenHash } : {})
    };
    await this.persist();
  }

  private async persist() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
