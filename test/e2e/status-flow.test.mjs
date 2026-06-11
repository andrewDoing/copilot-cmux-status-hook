import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCmuxStatusController } from "../../lib/cmux-status.mjs";
import { createSessionHooks, registerCmuxStatusEvents } from "../../lib/copilot-events.mjs";

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

async function createHarness(env = {}) {
  const calls = [];
  const storeDir = await mkdtemp(join(tmpdir(), "cmux-status-e2e-"));
  const controller = createCmuxStatusController({
    env: {
      CMUX_WORKSPACE_ID: "workspace-1",
      CMUX_SURFACE_ID: "surface-1",
      ...env,
    },
    storeDir,
    run: async (command, args) => {
      calls.push([command, ...args]);
    },
  });
  const session = new FakeSession();
  const hooks = createSessionHooks(controller);
  registerCmuxStatusEvents(session, controller);
  return { calls, hooks, session, storeDir };
}

function callLine(call) {
  return call.join(" ");
}

test("e2e event flow shows only AIC total and terminal context progress", async (t) => {
  const { calls, hooks, session, storeDir } = await createHarness();
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await hooks.onSessionStart();
  await session.emit("user.message", { content: "ignored by simplified hook" });
  await session.emit("assistant.turn_start", { turnId: "7" });
  await session.emit("tool.execution_start", { toolCallId: "tool-1", toolName: "bash", arguments: { command: "npm run check" } });
  await session.emit("session.usage_info", {
    currentTokens: 68_000,
    tokenLimit: 272_000,
    messagesLength: 88,
  });
  await session.emit("assistant.usage", { apiCallId: "usage-1", cost: 1 });
  await session.emit("tool.execution_complete", { toolCallId: "tool-1", success: true });
  await session.emit("session.idle", { aborted: false });

  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-aic 💳 AIC used: 0 --priority 100"));
  assert(calls.some((call) => callLine(call) === "cmux rename-tab --surface surface-1 🦊 Copilot"));
  assert(calls.some((call) => callLine(call) === "cmux workspace-action --action set-color --color Red"));
  assert(calls.some((call) => callLine(call) === "cmux workspace-action --action set-color --color Amber"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.05 --label 🦊 Working: reading prompt"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.15 --label 🦊 Working: thinking"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.45 --label 🦊 Working: running tests"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-context-surface-1 🟢 🦊 Context 25% (68k/272k, 88 msgs) --priority 90"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.25"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-context-surface-1 🟢 🦊 Working: bash finished · Context 25% (68k/272k, 88 msgs) --priority 90"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-aic 💳 AIC used: 1 --priority 100"));
  assert(!calls.some((call) => call[1] === "notify"));
  assert(!calls.some((call) => call[1] === "log"));
  assert(!calls.some((call) => call[1] === "set-status" && String(call[2]).startsWith("copilot-") && !["copilot-aic", "copilot-context-surface-1"].includes(call[2])));
});

test("e2e shutdown clears context status and leaves workspace AIC total", async (t) => {
  const { calls, session, storeDir } = await createHarness();
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await session.emit("session.usage_info", {
    currentTokens: 50,
    tokenLimit: 100,
  });
  await session.emit("assistant.usage", { apiCallId: "usage-1", cost: 2 });
  calls.length = 0;
  await session.emit("session.shutdown", { shutdownType: "normal" });

  assert.deepEqual(calls, [
    ["cmux", "workspace-action", "--action", "set-color", "--color", "Green"],
    ["cmux", "clear-status", "copilot-context-surface-1"],
  ]);
});
