import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendWorkspaceUsage,
  contextStatusValue,
  createCmuxStatusController,
  readWorkspaceAicTotal,
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

async function createHarness(env = {}) {
  const calls = [];
  const storeDir = await mkdtemp(join(tmpdir(), "cmux-status-test-"));
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

  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-aic AIC used: 1.25 --icon creditcard --color #4F46E5"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-aic AIC used: 3.25 --icon creditcard --color #4F46E5"));
  assert(!calls.some((call) => call[1] === "workspace-action" || call[1] === "notify" || call[1] === "log"));
});

test("duplicate usage call ids do not double count AIC", async (t) => {
  const { calls, session, storeDir } = await createHarness();
  t.after(() => rm(storeDir, { recursive: true, force: true }));

  await session.emit("assistant.usage", { apiCallId: "usage-1", cost: 1.25 });
  await session.emit("assistant.usage", { apiCallId: "usage-1", cost: 1.25 });

  const aicCalls = calls.filter((call) => call[1] === "set-status" && call[2] === "copilot-aic");
  assert.equal(aicCalls.length, 1);
  assert.equal(aicCalls[0][3], "AIC used: 1.25");
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

test("context usage writes one progress-bar status per Copilot terminal surface", async (t) => {
  const first = await createHarness({ CMUX_SURFACE_ID: "surface-a" });
  const second = await createHarness({ CMUX_SURFACE_ID: "surface-b" });
  t.after(() => rm(first.storeDir, { recursive: true, force: true }));
  t.after(() => rm(second.storeDir, { recursive: true, force: true }));

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

  assert(first.calls.some((call) => callLine(call) === "cmux set-status copilot-context-surface-a Context: [#####---------------] 25% (68k/272k, 88 msgs) --icon chart.bar --color #196F3D"));
  assert(second.calls.some((call) => callLine(call) === "cmux set-status copilot-context-surface-b Context: [###############-----] 75% (204k/272k, 120 msgs) --icon chart.bar --color #B26A00"));
  assert(!first.calls.some((call) => call[2] === "copilot-context-surface-b"));
  assert(!second.calls.some((call) => call[2] === "copilot-context-surface-a"));
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

test("contextStatusValue renders a bounded ASCII progress bar", () => {
  const usage = normalizeContextUsage({ currentTokens: 50, tokenLimit: 100 });

  assert.equal(contextStatusValue(usage, 10), "Context: [#####-----] 50% (50/100)");
});
