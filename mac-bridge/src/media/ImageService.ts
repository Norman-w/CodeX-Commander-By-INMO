import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import sharp from "sharp";

import type { ImageCard } from "@codex-commander/protocol";

import { redactSecrets } from "../privacy/VisorText.js";
import { PathGuard } from "../security/PathGuard.js";

export class ImageService {
  private readonly guard: PathGuard;

  constructor(roots: readonly string[], private readonly outputRoot: string) {
    this.guard = new PathGuard(roots);
  }

  async prepare(input: string, title?: string): Promise<ImageCard> {
    const source = await this.guard.resolveAllowed(input);
    const sourceStat = await stat(source);
    const id = createHash("sha256")
      .update(`${source}\0${sourceStat.size}\0${sourceStat.mtimeMs}`)
      .digest("hex")
      .slice(0, 24);
    const output = resolve(this.outputRoot, `${id}.webp`);
    await mkdir(this.outputRoot, { recursive: true, mode: 0o700 });

    const result = await sharp(source, { failOn: "warning", limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1_280, height: 720, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toFile(output);

    return {
      id,
      title: safeImageTitle(title || basename(source)),
      url: `/media/${id}.webp`,
      width: result.width,
      height: result.height,
      mimeType: "image/webp"
    };
  }
}

function safeImageTitle(value: string): string {
  const basenameOnly = value.includes("/") || value.includes("\\") ? basename(value) : value;
  return redactSecrets(basenameOnly).slice(0, 160);
}
