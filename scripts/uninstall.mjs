import { rm } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const extensionsDir = process.env.COPILOT_EXTENSIONS_DIR || join(os.homedir(), ".copilot", "extensions");
const target = join(extensionsDir, "cmux-status");

if (!existsSync(target)) {
  console.log(`Not installed: ${target}`);
  process.exit(0);
}

if (!lstatSync(target).isSymbolicLink()) {
  throw new Error(`${target} exists but is not a symlink. Remove it manually if intended.`);
}

await rm(target);
console.log(`Removed Copilot CLI extension: ${target}`);

