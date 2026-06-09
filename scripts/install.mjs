import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionsDir = process.env.COPILOT_EXTENSIONS_DIR || join(os.homedir(), ".copilot", "extensions");
const target = join(extensionsDir, "cmux-status");
const force = process.argv.includes("--force");

await mkdir(extensionsDir, { recursive: true });

if (existsSync(target)) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    const current = await realpath(target);
    const desired = await realpath(repoRoot);
    if (current === desired) {
      console.log(`Already installed at ${target}`);
      process.exit(0);
    }
  }

  if (!force) {
    throw new Error(`${target} already exists. Re-run with -- --force to replace it.`);
  }
  await rm(target, { recursive: true, force: true });
}

await symlink(repoRoot, target, "dir");
console.log(`Installed Copilot CLI extension: ${target} -> ${repoRoot}`);
console.log("Restart Copilot CLI or run /clear to reload extensions.");

