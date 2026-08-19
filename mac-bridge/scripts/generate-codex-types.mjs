import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: resolve(packageRoot, "../.env"), quiet: true });
const output = resolve(packageRoot, "src/generated/codex");
const versionFile = resolve(output, ".codex-version");
const temporary = `${output}.tmp-${process.pid}`;
const fixtureGenerated = resolve(packageRoot, "test/fixtures/codex-generated/codex");
const codex = process.env.COMMANDER_CODEX_BIN || "codex";

let version;
try {
  version = execFileSync(codex, ["--version"], { encoding: "utf8" }).trim();
} catch (error) {
  if (readVersion()) process.exit(0);
  if (existsSync(fixtureGenerated)) {
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    cpSync(fixtureGenerated, output, { recursive: true });
    writeFileSync(versionFile, "fixture-stub\n", "utf8");
    process.exit(0);
  }
  throw new Error(`Unable to run ${codex}. Install Codex or set COMMANDER_CODEX_BIN. ${String(error)}`);
}

if (readVersion() === version) process.exit(0);

rmSync(temporary, { recursive: true, force: true });
mkdirSync(temporary, { recursive: true });
try {
  execFileSync(codex, ["app-server", "generate-ts", "--out", temporary], { stdio: "inherit" });
  writeFileSync(resolve(temporary, ".codex-version"), `${version}\n`, "utf8");
  rmSync(output, { recursive: true, force: true });
  renameSync(temporary, output);
} catch (error) {
  rmSync(temporary, { recursive: true, force: true });
  throw error;
}

function readVersion() {
  try {
    return readFileSync(versionFile, "utf8").trim();
  } catch {
    return undefined;
  }
}
