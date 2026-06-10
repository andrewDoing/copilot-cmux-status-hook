import test from "node:test";
import assert from "node:assert/strict";
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
      handler(event);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createHarness(env = { CMUX_WORKSPACE_ID: "workspace-1", CMUX_SURFACE_ID: "surface-1", CMUX_COPILOT_WORKSPACE_CARD: "0" }) {
  const calls = [];
  const controller = createCmuxStatusController({
    env,
    elapsedIntervalMs: 0,
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    workspaceTitle: false,
    run: async (command, args) => {
      calls.push([command, ...args]);
    },
  });
  const session = new FakeSession();
  const hooks = createSessionHooks(controller);
  registerCmuxStatusEvents(session, controller);
  return { calls, controller, hooks, session };
}

function callLine(call) {
  return call.join(" ");
}

function assertOnlyStatusKeys(calls, expectedKeys) {
  const actualKeys = new Set(
    calls
      .filter((call) => call[1] === "set-status" || call[1] === "clear-status")
      .map((call) => call[2]),
  );
  assert.deepEqual([...actualKeys].sort(), [...expectedKeys].sort());
}

function assertSurfaceContract(calls, { statusKeys, sharedSurfaces = [] }) {
  assertOnlyStatusKeys(calls, statusKeys);
  const allowed = new Set(sharedSurfaces);
  if (!allowed.has("progress")) {
    assert(!calls.some((call) => call[1] === "set-progress" || call[1] === "clear-progress"));
  }
  if (!allowed.has("workspace-card")) {
    assert(!calls.some((call) => call[1] === "workspace-action" && ["set-description", "clear-description"].includes(call[3])));
  }
  if (!allowed.has("workspace-title")) {
    assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "rename"));
  }
  if (!allowed.has("workspace-color")) {
    assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "set-color"));
  }
}

test("product contract: default session stays isolated to its CMUX surface", async () => {
  const { calls, hooks, session } = createHarness();

  await hooks.onSessionStart();
  await hooks.onUserPromptSubmitted();
  await session.emit("user.message", {
    content: [
      "The user set this explicit autopilot objective with /autopilot:",
      "",
      "ship a safe product contract test",
      "",
      "Work autonomously toward this objective in clear checkpoints.",
    ].join("\n"),
  });
  await session.emit("session.usage_info", {
    currentTokens: 90_000,
    tokenLimit: 272_000,
    messagesLength: 100,
  });
  await session.emit("system.message", { content: '<skill-context name="hickey">loaded</skill-context>' });
  await session.emit("assistant.turn_start", { turnId: "product-1" });
  await session.emit("tool.execution_start", {
    toolCallId: "tool-1",
    toolName: "bash",
    arguments: { command: "npm test" },
  });
  await session.emit("permission.requested", {
    requestId: "perm-1",
    permissionRequest: { kind: "shell", fullCommandText: "npm test" },
  });
  await session.emit("permission.completed", { requestId: "perm-1" });
  await session.emit("tool.execution_complete", { toolCallId: "tool-1", success: true });
  await session.emit("session.compaction_start", { conversationTokens: 180_000 });
  await session.emit("session.compaction_complete", { success: true, tokensRemoved: 60_000 });
  await session.emit("assistant.usage", { apiCallId: "usage-product-1", cost: 2, model: "gpt-5.5" });
  await session.emit("session.idle", { aborted: false });

  assertSurfaceContract(calls, { statusKeys: ["copilot-surface-1"] });
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: running tests --icon gear --color #B26A00"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: APPROVAL NEEDED: shell command npm test --icon exclamationmark.triangle --color #B00020"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: Done --icon checkmark --color #196F3D"));
  assert(calls.some((call) => call[1] === "notify" && call[3] === "Copilot is done"));
});

test("product contract: multiple Copilot surfaces do not overwrite or clear each other", async () => {
  const first = createHarness({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_SURFACE_ID: "surface-a",
    CMUX_COPILOT_WORKSPACE_CARD: "0",
  });
  const second = createHarness({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_SURFACE_ID: "surface-b",
    CMUX_COPILOT_WORKSPACE_CARD: "0",
  });

  await first.hooks.onUserPromptSubmitted();
  await second.hooks.onUserPromptSubmitted();
  await first.session.emit("tool.execution_start", {
    toolCallId: "tool-a",
    toolName: "apply_patch",
  });
  await second.session.emit("tool.execution_start", {
    toolCallId: "tool-b",
    toolName: "bash",
    arguments: { command: "npm test" },
  });
  await first.session.emit("session.idle", { aborted: false });
  await second.session.emit("session.idle", { aborted: false });

  assertSurfaceContract(first.calls, { statusKeys: ["copilot-surface-a"] });
  assertSurfaceContract(second.calls, { statusKeys: ["copilot-surface-b"] });
  assert(!first.calls.some((call) => call[1] === "clear-status" && call[2] === "copilot-surface-b"));
  assert(!second.calls.some((call) => call[1] === "clear-status" && call[2] === "copilot-surface-a"));
});

test("product contract: shared CMUX surfaces change only when explicitly opted in", async () => {
  const { calls, hooks, session } = createHarness({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_SURFACE_ID: "surface-1",
    CMUX_COPILOT_CONTEXT_PROGRESS: "1",
    CMUX_COPILOT_PROGRESS_BAR: "1",
    CMUX_COPILOT_WORKSPACE_CARD: "1",
    CMUX_COPILOT_WORKSPACE_TITLE: "0",
  });

  await hooks.onUserPromptSubmitted();
  await session.emit("session.usage_info", {
    currentTokens: 68_000,
    tokenLimit: 272_000,
    messagesLength: 88,
  });
  await session.emit("system.message", { content: '<skill-context name="hickey">loaded</skill-context>' });
  await session.emit("assistant.usage", { apiCallId: "usage-product-2", cost: 1, model: "gpt-5.5" });
  await session.emit("tool.execution_start", {
    toolCallId: "tool-1",
    toolName: "view",
  });
  await session.emit("tool.execution_complete", { toolCallId: "tool-1", success: true });
  await session.emit("session.idle", { aborted: false });

  assertSurfaceContract(calls, {
    statusKeys: ["copilot-surface-1"],
    sharedSurfaces: ["progress", "workspace-card", "workspace-color"],
  });
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.25 --label 🤖 Context 25% (68k/272k, 88 msgs)"));
  assert(calls.some((call) => call[1] === "workspace-action" && call[3] === "set-description" && String(call[5]).includes("Skills: hickey")));
  assert(calls.some((call) => call[1] === "workspace-action" && call[3] === "set-description" && String(call[5]).includes("AIC used: 1")));
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "rename"));
});

test("product contract: attention states remain visible by default", async () => {
  const { calls, hooks, session } = createHarness();

  await hooks.onUserPromptSubmitted();
  await session.emit("tool.execution_start", {
    toolCallId: "tool-1",
    toolName: "apply_patch",
  });
  await session.emit("tool.execution_complete", { toolCallId: "tool-1", success: false });
  await session.emit("session.idle", { aborted: false });

  assertSurfaceContract(calls, { statusKeys: ["copilot-surface-1"] });
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: apply patch failed --icon xmark --color #B00020"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: Needs attention: apply patch failed --icon xmark --color #B00020"));
  assert(!calls.some((call) => call[1] === "notify" && call[3] === "Copilot is done"));
});

test("product contract: outside CMUX is inert across a full session story", async () => {
  const { calls, hooks, session } = createHarness({});

  await hooks.onSessionStart();
  await hooks.onUserPromptSubmitted();
  await session.emit("assistant.turn_start", { turnId: "outside-cmux" });
  await session.emit("tool.execution_start", {
    toolCallId: "tool-1",
    toolName: "bash",
    arguments: { command: "npm test" },
  });
  await session.emit("tool.execution_complete", { toolCallId: "tool-1", success: true });
  await session.emit("session.idle", { aborted: false });
  await hooks.onSessionEnd();

  assert.deepEqual(calls, []);
});

test("e2e event flow shows immediate working state, context usage, tool activity, and idle", async () => {
  const { calls, hooks, session } = createHarness();

  await hooks.onSessionStart();
  await hooks.onUserPromptSubmitted();
  await session.emit("user.message", { content: "dogfood the hook" });
  await session.emit("session.usage_info", {
    currentTokens: 68_000,
    tokenLimit: 272_000,
    messagesLength: 88,
  });
  await session.emit("assistant.usage", { apiCallId: "usage-1", cost: 1, model: "gpt-5.5" });
  await session.emit("system.message", { content: '<skill-context name="cmux">loaded</skill-context>' });
  await session.emit("assistant.turn_start", { turnId: "7" });
  await session.emit("session.compaction_start", { conversationTokens: 150_000 });
  await session.emit("session.compaction_complete", { success: true, tokensRemoved: 55_000 });
  await session.emit("tool.execution_start", { toolCallId: "tool-1", toolName: "bash" });
  await session.emit("tool.execution_complete", { toolCallId: "tool-1", success: true });
  await session.emit("session.idle", { aborted: false });

  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: reading prompt --icon gear --color #B26A00"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: running shell command --icon gear --color #B26A00"));
  assert(!calls.some((call) => call[1] === "set-progress"));
  assert(!calls.some((call) => call[1] === "workspace-action"));
  assert(calls.some((call) => callLine(call) === "cmux log --level success --source copilot-cmux-status -- compaction complete: 1 compaction, 55k tokens removed"));
  assert(calls.some((call) => callLine(call) === "cmux log --level success --source copilot-cmux-status -- bash finished"));
  assert(!calls.some((call) => callLine(call) === "cmux log --level info --source copilot-cmux-status -- Background tasks changed"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: Done --icon checkmark --color #196F3D"));
});

test("e2e error flow marks the sidebar as needing attention", async () => {
  const { calls, hooks } = createHarness();

  await hooks.onUserPromptSubmitted();
  await hooks.onErrorOccurred({ error: "model failed" });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-surface-1 Copilot: Needs attention --icon xmark --color #B00020"));
  assert(!calls.some((call) => call[1] === "workspace-action"));
  assert(calls.some((call) => call.join(" ") === "cmux notify --title Copilot needs attention --body model failed"));
});

test("e2e turn start does not duplicate thinking text in progress", async () => {
  const { calls, session } = createHarness();

  await session.emit("assistant.turn_start", { turnId: "6" });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-surface-1 Copilot: thinking turn 6 --icon gear --color #B26A00"));
  assert(!calls.some((call) => call[1] === "set-progress"));
  assert(!calls.some((call) => call[1] === "set-progress" && String(call[4] || "").includes("thinking turn 6")));
});

test("e2e session end clears the per-surface status once", async () => {
  const { calls, hooks } = createHarness();

  await hooks.onUserPromptSubmitted();
  calls.length = 0;
  await hooks.onSessionEnd();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.filter((call) => call[1] === "clear-status"), [
    ["cmux", "clear-status", "copilot-surface-1"],
  ]);
});

test("e2e non-error shutdown clears the per-surface status", async () => {
  const { calls, session } = createHarness();

  await session.emit("assistant.turn_start", { turnId: "8" });
  calls.length = 0;
  await session.emit("session.shutdown", { shutdownType: "normal" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.filter((call) => call[1] === "clear-status"), [
    ["cmux", "clear-status", "copilot-surface-1"],
  ]);
});

test("e2e goal mode flow avoids workspace card duplication when workspace card is disabled", async () => {
  const { calls, hooks, session } = createHarness();

  await hooks.onUserPromptSubmitted();
  await session.emit("user.message", {
    content: [
      "The user set this explicit autopilot objective with /autopilot:",
      "",
      "implement goal mode support",
      "",
      "Work autonomously toward this objective in clear checkpoints.",
    ].join("\n"),
  });

  assert(!calls.some((call) => call[1] === "workspace-action"));
  assert(!calls.some((call) => call[1] === "set-status" && String(call[3]).includes("Goal:")));
  assert(!calls.some((call) => call[1] === "set-progress" && String(call[4]).includes("Goal:")));
});

test("e2e goal mode can opt in to workspace card details", async () => {
  const { calls, hooks, session } = createHarness({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_SURFACE_ID: "surface-1",
    CMUX_COPILOT_WORKSPACE_CARD: "1",
  });

  await hooks.onUserPromptSubmitted();
  await session.emit("user.message", {
    content: [
      "The user set this explicit autopilot objective with /autopilot:",
      "",
      "implement goal mode support",
      "",
      "Work autonomously toward this objective in clear checkpoints.",
    ].join("\n"),
  });

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🎯 Goal: implement goal mode support"));
  assert(!calls.some((call) => call[1] === "set-status" && String(call[3]).includes("Goal:")));
  assert(!calls.some((call) => call[1] === "set-progress" && String(call[4]).includes("Goal:")));
});

test("e2e skill context can opt in to workspace card details", async () => {
  const { calls, session } = createHarness({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_SURFACE_ID: "surface-1",
    CMUX_COPILOT_WORKSPACE_CARD: "1",
  });

  await session.emit("system.message", { content: '<skill-context name="cmux">loaded</skill-context>' });

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧰 Skills: cmux"));
  assert(!calls.some((call) => call[1] === "set-status" && String(call[3]).includes("Skills:")));
  assert(!calls.some((call) => call[1] === "set-progress" && String(call[4]).includes("Skills:")));
});
