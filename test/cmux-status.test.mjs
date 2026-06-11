import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendWorkspaceUsage,
  assignTerminalOrdinal,
  contextIcon,
  contextStatusValue,
  createCmuxStatusController,
  readTerminalOrdinals,
  readWorkspaceAicTotal,
  terminalLabelForOrdinal,
  terminalPreviewLabelForOrdinal,
} from "../lib/cmux-status.mjs";
import { createSessionHooks, registerCmuxStatusEvents } from "../lib/copilot-events.mjs";
import { normalizeContextUsage } from "../lib/status-formatters.mjs";

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

async function createHarness(env = {}, options = {}) {
  const calls = [];
  const storeDir = options.storeDir || await mkdtemp(join(tmpdir(), "cmux-status-test-"));
  const controller = createCmuxStatusController({
    env: {
      CMUX_WORKSPACE_ID: "workspace-1",
      CMUX_SURFACE_ID: "surface-1",
      ...env,
    },
    storeDir,
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "cmux" && args[0] === "list-status") {
        return { stdout: options.listStatus || "" };
      }
      return {};
    },
  });
  const session = new FakeSession();
  const hooks = createSessionHooks(controller);
  registerCmuxStatusEvents(session, controller);
  return { calls, controller, hooks, session, storeDir };
}

function callLine(call) {
  return call.join(" ");
}

test("assistant usage writes a shared workspace AIC total status", async (t) => {
  const { calls, session, storeDir } = await createHarness();
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await session.emit("assistant.usage", { apiCallId: "usage-1", cost: 1.25 });
  await session.emit("assistant.usage", { apiCallId: "usage-2", cost: 2 });

  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-aic 💳 AIC used: 1.25 --priority 100"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-aic 💳 AIC used: 3.25 --priority 100"));
  assert(!calls.some((call) => call[1] === "workspace-action" || call[1] === "notify" || call[1] === "log"));
});

test("duplicate usage call ids do not double count AIC", async (t) => {
  const { calls, session, storeDir } = await createHarness();
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await session.emit("assistant.usage", { apiCallId: "usage-1", cost: 1.25 });
  await session.emit("assistant.usage", { apiCallId: "usage-1", cost: 1.25 });

  const aicCalls = calls.filter((call) => call[1] === "set-status" && call[2] === "copilot-aic");
  assert.equal(aicCalls.length, 1);
  assert.equal(aicCalls[0][3], "💳 AIC used: 1.25");
});

test("workspace AIC totals aggregate records written by separate controllers", async (t) => {
  const storeDir = await mkdtemp(join(tmpdir(), "cmux-status-test-"));
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  const sharedFile = join(storeDir, "usage.jsonl");
  await appendWorkspaceUsage(sharedFile, { callId: "a", cost: 1 });
  await appendWorkspaceUsage(sharedFile, { callId: "b", cost: 2.5 });
  await appendWorkspaceUsage(sharedFile, { callId: "a", cost: 1 });

  assert.equal(await readWorkspaceAicTotal(sharedFile), 3.5);
  const content = await readFile(sharedFile, "utf8");
  assert.equal(content.trim().split("\n").length, 3);
});

test("startup clears stale hook-owned status rows and progress before re-emitting AIC", async (t) => {
  const { calls, controller, storeDir } = await createHarness({}, {
    listStatus: [
      "copilot-aic=💳 AIC used: 99 priority=100",
      "copilot-context-old=🦊 Working: stale · Context 50% icon=🔴 priority=90",
      "other-tool=leave me alone",
    ].join("\n"),
  });
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await controller.startupReady();

  assert(calls.some((call) => callLine(call) === "cmux list-status"));
  assert(calls.some((call) => callLine(call) === "cmux clear-status copilot-aic"));
  assert(calls.some((call) => callLine(call) === "cmux clear-status copilot-context-old"));
  assert(!calls.some((call) => callLine(call) === "cmux clear-status other-tool"));
  assert(calls.some((call) => callLine(call) === "cmux clear-progress"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-aic 💳 AIC used: 0 --priority 100"));
});

test("startup clear can be disabled", async (t) => {
  const { calls, controller, storeDir } = await createHarness({ CMUX_COPILOT_CLEAR_ON_START: "0" }, {
    listStatus: "copilot-context-old=stale",
  });
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await controller.startupReady();

  assert(!calls.some((call) => call[1] === "list-status" || call[1] === "clear-status" || call[1] === "clear-progress"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-aic 💳 AIC used: 0 --priority 100"));
});

test("context usage writes one prioritized status per Copilot terminal surface and the CMUX progress bar", async (t) => {
  const storeDir = await mkdtemp(join(tmpdir(), "cmux-status-test-"));
  const first = await createHarness({ CMUX_SURFACE_ID: "surface-a" }, { storeDir });
  const second = await createHarness({ CMUX_SURFACE_ID: "surface-b" }, { storeDir });
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await first.session.emit("session.usage_info", {
    currentTokens: 68_000,
    tokenLimit: 272_000,
    messagesLength: 88,
  });
  await second.session.emit("session.usage_info", {
    currentTokens: 204_000,
    tokenLimit: 272_000,
    messagesLength: 120,
  });

  assert(first.calls.some((call) => callLine(call) === "cmux rename-tab --surface surface-a 🦊 Copilot"));
  assert(first.calls.some((call) => callLine(call) === "cmux set-status copilot-context-surface-a 🦊 Context 25% (68k/272k, 88 msgs) --icon 🟢 --priority 90"));
  assert(first.calls.some((call) => callLine(call) === "cmux set-progress 0.25"));
  assert(second.calls.some((call) => callLine(call) === "cmux rename-tab --surface surface-b 🐙 Copilot"));
  assert(second.calls.some((call) => callLine(call) === "cmux set-status copilot-context-surface-b 🐙 Context 75% (204k/272k, 120 msgs) --icon 🔴 --priority 90"));
  assert(second.calls.some((call) => callLine(call) === "cmux set-progress 0.75"));
  assert(!first.calls.some((call) => call[2] === "copilot-context-surface-b"));
  assert(!second.calls.some((call) => call[2] === "copilot-context-surface-a"));
});

test("terminal ordinals are stable within the workspace registry", async (t) => {
  const storeDir = await mkdtemp(join(tmpdir(), "cmux-status-test-"));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const registryPath = join(storeDir, "workspace-terminals.jsonl");

  assert.equal(await assignTerminalOrdinal(registryPath, "surface-a"), 1);
  assert.equal(await assignTerminalOrdinal(registryPath, "surface-b"), 2);
  assert.equal(await assignTerminalOrdinal(registryPath, "surface-a"), 1);
  assert.deepEqual([...(await readTerminalOrdinals(registryPath)).entries()], [
    ["surface-a", 1],
    ["surface-b", 2],
  ]);
});

test("terminal labels use distinct emojis for the first nine Copilot terminals", () => {
  assert.deepEqual(
    Array.from({ length: 10 }, (_, index) => terminalLabelForOrdinal(index + 1)),
    [
      "🦊 Copilot",
      "🐙 Copilot",
      "🦉 Copilot",
      "🐝 Copilot",
      "🐢 Copilot",
      "🦀 Copilot",
      "🐬 Copilot",
      "🦄 Copilot",
      "🚀 Copilot",
      "Copilot 10",
    ],
  );
  assert.deepEqual(
    Array.from({ length: 10 }, (_, index) => terminalPreviewLabelForOrdinal(index + 1)),
    ["🦊", "🐙", "🦉", "🐝", "🐢", "🦀", "🐬", "🦄", "🚀", "Copilot 10"],
  );
});

test("activity events update CMUX progress with emoji-only labels", async (t) => {
  const { calls, session, storeDir } = await createHarness();
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await session.emit("session.usage_info", { currentTokens: 50, tokenLimit: 100 });
  await session.emit("user.message", {});
  await session.emit("assistant.turn_start", {});
  await session.emit("assistant.intent", { intent: "editing files" });
  await session.emit("tool.execution_start", { toolCallId: "tool-1", toolName: "bash", arguments: { command: "npm run check" } });
  await session.emit("tool.execution_complete", { toolCallId: "tool-1", success: true });
  await session.emit("session.idle", {});

  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.05 --label 🦊 Working: reading prompt"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.15 --label 🦊 Working: thinking"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.25 --label 🦊 Working: editing files"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.45 --label 🦊 Working: running tests"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.7 --label 🦊 Working: bash finished"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-context-surface-1 🦊 Working: running tests · Context 50% (50/100) --icon 🔴 --priority 90"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-context-surface-1 🦊 Context 50% (50/100) --icon 🔴 --priority 90"));
});

test("context status icon is green below 100k, yellow at 100k, and red at 50 percent", () => {
  assert.equal(contextIcon(normalizeContextUsage({ currentTokens: 99_999, tokenLimit: 300_000 })), "🟢");
  assert.equal(contextIcon(normalizeContextUsage({ currentTokens: 100_000, tokenLimit: 300_000 })), "🟡");
  assert.equal(contextIcon(normalizeContextUsage({ currentTokens: 150_000, tokenLimit: 300_000 })), "🔴");
});

test("session end clears only the terminal context status", async (t) => {
  const { calls, hooks, session, storeDir } = await createHarness();
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await session.emit("session.usage_info", { currentTokens: 10, tokenLimit: 100 });
  calls.length = 0;
  await hooks.onSessionEnd();

  assert.deepEqual(calls, [["cmux", "clear-status", "copilot-context-surface-1"]]);
});

test("outside CMUX is inert", async (t) => {
  const { calls, hooks, session, storeDir } = await createHarness({
    CMUX_WORKSPACE_ID: "",
  });
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await hooks.onSessionStart();
  await session.emit("session.usage_info", { currentTokens: 10, tokenLimit: 100 });
  await session.emit("assistant.usage", { apiCallId: "usage-1", cost: 1 });
  await hooks.onSessionEnd();

  assert.deepEqual(calls, []);
});

test("contextStatusValue renders a compact native status label", () => {
  const usage = normalizeContextUsage({ currentTokens: 50, tokenLimit: 100 });

  assert.equal(contextStatusValue(usage, "🦀"), "🦀 Context 50% (50/100)");
  assert.equal(contextStatusValue(usage, "🦀", "thinking"), "🦀 Working: thinking · Context 50% (50/100)");
});
