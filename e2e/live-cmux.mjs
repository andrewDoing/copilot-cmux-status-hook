import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createCmuxStatusController } from "../lib/cmux-status.mjs";
import { createSessionHooks, registerCmuxStatusEvents } from "../lib/copilot-events.mjs";

const execFileAsync = promisify(execFile);
const liveCmuxOptions = process.env.CMUX_WORKSPACE_ID
  ? {}
  : { skip: "requires a live CMUX session with CMUX_WORKSPACE_ID set" };

class FakeSession {
  #handlers = new Map();

  on(eventType, handler) {
    const handlers = this.#handlers.get(eventType) || [];
    handlers.push(handler);
    this.#handlers.set(eventType, handlers);
  }

  async emit(type, data = {}) {
    const event = { type, data };
    for (const handler of this.#handlers.get(type) || []) {
      await handler(event);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function cmux(args) {
  const result = await execFileAsync("cmux", args, { timeout: 5_000 });
  return typeof result.stdout === "string" ? result.stdout : "";
}

async function safeCmux(args) {
  try {
    await cmux(args);
  } catch {
    // Best-effort cleanup after a live CMUX integration test.
  }
}

async function listStatus() {
  return cmux(["list-status"]);
}

async function sidebarState() {
  return cmux(["sidebar-state"]);
}

function sidebarColor(sidebarOutput) {
  const line = sidebarOutput.split(/\r?\n/).find((entry) => entry.startsWith("color="));
  return line?.slice("color=".length).trim() || "none";
}

function isGreenSidebarColor(color) {
  return color === "Green" || color.toLowerCase() === "#196f3d";
}

async function restoreWorkspaceColor(color) {
  if (color && color !== "none") {
    await safeCmux(["workspace-action", "--action", "set-color", "--color", color]);
    return;
  }
  await safeCmux(["workspace-action", "--action", "clear-color"]);
}

function statusLine(statusOutput, key) {
  return statusOutput.split(/\r?\n/).find((line) => line.startsWith(`${key}=`));
}

async function waitForStatusLine(key, predicate) {
  const deadline = Date.now() + 2_000;
  let output = "";
  let line;

  while (Date.now() < deadline) {
    output = await listStatus();
    line = statusLine(output, key);
    if (predicate(line, output)) return line;
    await sleep(50);
  }

  assert.fail(`timed out waiting for ${key}; last status output:\n${output}`);
}

function callLine(call) {
  return call.join(" ");
}

test("live CMUX event flow writes disposable status rows and clears context on shutdown", liveCmuxOptions, async (t) => {
  const suffix = `e2e-${process.pid}-${Date.now()}`;
  const contextKey = `copilot-context-${suffix}`;
  const storeDir = await mkdtemp(join(tmpdir(), "cmux-status-live-"));
  const calls = [];
  const errors = [];
  const originalWorkspaceColor = sidebarColor(await sidebarState());

  t.after(async () => {
    await safeCmux(["clear-status", contextKey]);
    await safeCmux(["clear-progress"]);
    await restoreWorkspaceColor(originalWorkspaceColor);
    await rm(storeDir, { recursive: true, force: true });
  });

  const controller = createCmuxStatusController({
    env: {
      ...process.env,
      CMUX_COPILOT_CONTEXT_STATUS_KEY: contextKey,
      CMUX_COPILOT_CLEAR_ON_START: "0",
      CMUX_COPILOT_LABEL_TERMINAL: "0",
      CMUX_COPILOT_STORE_DIR: storeDir,
    },
    onError: (message) => errors.push(message),
    run: async (command, args) => {
      calls.push([command, ...args]);
      return execFileAsync(command, args, { timeout: 5_000 });
    },
  });
  const session = new FakeSession();
  const hooks = createSessionHooks(controller);
  registerCmuxStatusEvents(session, controller);

  await hooks.onSessionStart();
  await session.emit("user.message", { content: "live cmux e2e" });
  await session.emit("assistant.turn_start", { turnId: "live-1" });
  await session.emit("tool.execution_start", {
    toolCallId: "tool-1",
    toolName: "bash",
    arguments: { command: "npm run check" },
  });
  await session.emit("session.usage_info", {
    currentTokens: 68_000,
    tokenLimit: 272_000,
    messagesLength: 88,
  });
  await session.emit("tool.execution_complete", { toolCallId: "tool-1", success: true });
  await session.emit("session.idle", { aborted: false });

  assert.deepEqual(errors, []);
  assert.equal(
    await waitForStatusLine(
      contextKey,
      (line) => line === `${contextKey}=🟢 🦊 Context 25% (68k/272k, 88 msgs) priority=90`,
    ),
    `${contextKey}=🟢 🦊 Context 25% (68k/272k, 88 msgs) priority=90`,
  );

  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.05 --label 🦊 Working: reading prompt"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.15 --label 🦊 Working: thinking"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.45 --label 🦊 Working: running tests"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.25"));
  assert(calls.some((call) => callLine(call) === "cmux workspace-action --action set-color --color Red"));
  assert(calls.some((call) => callLine(call) === "cmux workspace-action --action set-color --color Amber"));
  assert(!calls.some((call) => call[1] === "notify"));
  assert(!calls.some((call) => call[1] === "log"));
  assert(!calls.some((call) => call[1] === "rename-tab"));
  assert(!calls.some((call) => call[1] === "set-status" && call[2] === contextKey && call.includes("--icon")));
  assert(
    !calls.some(
      (call) =>
        call[1] === "set-status" &&
        String(call[2]).startsWith("copilot-") &&
        call[2] !== contextKey,
    ),
  );

  calls.length = 0;
  await session.emit("session.shutdown", { shutdownType: "normal" });
  assert.deepEqual(calls, [
    ["cmux", "workspace-action", "--action", "set-color", "--color", "Green"],
    ["cmux", "clear-status", contextKey],
  ]);

  const statusAfterShutdown = await listStatus();
  assert.equal(statusLine(statusAfterShutdown, contextKey), undefined);
  assert(isGreenSidebarColor(sidebarColor(await sidebarState())));
});
