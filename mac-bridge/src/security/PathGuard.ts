import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

export class PathGuard {
  private resolvedRoots?: Promise<readonly string[]>;

  constructor(private readonly roots: readonly string[]) {}

  async resolveAllowed(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error("Media paths must be absolute");
    const resolved = await realpath(input);
    const roots = await (this.resolvedRoots ??= Promise.all(this.roots.map((root) => realpath(root))));
    const allowed = roots.some((root) => {
      const segment = relative(root, resolved);
      return segment === "" || (!segment.startsWith("..") && !isAbsolute(segment));
    });
    if (!allowed) throw new Error(`Media path is outside COMMANDER_MEDIA_ROOTS: ${resolved}`);
    return resolved;
  }
}
