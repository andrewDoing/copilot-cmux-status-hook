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

function createHarness() {
  const calls = [];
  const controller = createCmuxStatusController({
    env: { CMUX_WORKSPACE_ID: "workspace-1" },
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
  await session.emit("assistant.turn_start", { turnId: "7" });
  await session.emit("session.compaction_start", { conversationTokens: 150_000 });
  await session.emit("session.compaction_complete", { success: true, tokensRemoved: 55_000 });
  await session.emit("tool.execution_start", { toolCallId: "tool-1", toolName: "bash" });
  await session.emit("tool.execution_complete", { toolCallId: "tool-1", success: true });
  await session.emit("session.idle", { aborted: false });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli 🤖 prompt received --icon gear --color #B26A00"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description "));
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.25 --label 🤖 Context 25% (68k/272k, 88 msgs)"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level success --source copilot-cmux-status -- compaction complete: 1 compaction, 55k tokens removed"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level success --source copilot-cmux-status -- bash finished"));
  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli ✅ Done: 1 tool, 1 compaction --icon checkmark --color #196F3D"));
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.25 --label ✅ Context 25% (68k/272k, 88 msgs)"));
});

test("e2e error flow marks the sidebar as needing attention", async () => {
  const { calls, hooks } = createHarness();

  await hooks.onUserPromptSubmitted();
  await hooks.onErrorOccurred({ error: "model failed" });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli 🔴 Needs attention --icon xmark --color #B00020"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description "));
  assert(calls.some((call) => call.join(" ") === "cmux notify --title Copilot needs attention --body model failed"));
});
