import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../hooks/imessage-agent-stop.sh", import.meta.url);

async function withLogDir(fn) {
  const logDir = await mkdtemp(join(tmpdir(), "copilot-imessage-test-"));
  try {
    return await fn(logDir);
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
}

async function runHook(payload, logDir, env = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(script.pathname, [], {
      env: {
        ...process.env,
        COPILOT_IMESSAGE_DRY_RUN: "1",
        COPILOT_IMESSAGE_LOG_DIR: logDir,
        COPILOT_IMESSAGE_RECIPIENT: "test-recipient",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(`iMessage hook exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

test("iMessage hook dry-runs completion and turn-completion stop reasons", async () => {
  await withLogDir(async (logDir) => {
    const complete = await runHook({ reason: "complete" }, logDir);
    const endTurn = await runHook({ reason: "end_turn" }, logDir);

    assert.match(complete.stderr, /Dry run: would send iMessage to test-recipient: Copilot CLI session complete\./);
    assert.match(endTurn.stderr, /Dry run: would send iMessage to test-recipient: Copilot CLI turn complete\./);

    const log = await readFile(join(logDir, "imessage-agent-stop.log"), "utf8");
    assert.match(log, /reason=complete/);
    assert.match(log, /reason=end_turn/);
  });
});

test("iMessage hook skips non-completion stop reasons without requiring a recipient", async () => {
  await withLogDir(async (logDir) => {
    const result = await runHook({ reason: "user_exit" }, logDir, {
      COPILOT_IMESSAGE_RECIPIENT: "",
    });

    assert.match(result.stderr, /Skipping iMessage notification for Copilot stop reason: user_exit/);
    const log = await readFile(join(logDir, "imessage-agent-stop.log"), "utf8");
    assert.match(log, /reason=user_exit/);
  });
});

test("iMessage hook accepts active agentStop payload aliases", async () => {
  await withLogDir(async (logDir) => {
    const result = await runHook({ stopReason: "end_turn" }, logDir);

    assert.match(result.stderr, /Copilot CLI turn complete\./);
  });
});
