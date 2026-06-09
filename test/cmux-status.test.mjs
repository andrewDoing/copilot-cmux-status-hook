import test from "node:test";
import assert from "node:assert/strict";
import {
  createCmuxStatusController,
  formatTokenCount,
  humanizeToolName,
  normalizeContextUsage,
} from "../lib/cmux-status.mjs";

function createRecorder(env = { CMUX_WORKSPACE_ID: "workspace-1" }) {
  const calls = [];
  const errors = [];
  const controller = createCmuxStatusController({
    env,
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    run: async (command, args) => {
      calls.push([command, ...args]);
    },
    onError: (message) => errors.push(message),
  });
  return { controller, calls, errors };
}

test("does not call cmux outside CMUX", async () => {
  const { controller, calls } = createRecorder({});

  await controller.startWorking("thinking");
  await controller.done();

  assert.equal(controller.isEnabled(), false);
  assert.deepEqual(calls, []);
});

test("marks the agent as working with status, progress, log, and flash", async () => {
  const { controller, calls } = createRecorder();

  await controller.startWorking("thinking");

  assert.deepEqual(calls, [
    [
      "cmux",
      "set-status",
      "copilot-cli",
      "Copilot working: thinking",
      "--icon",
      "gear",
      "--color",
      "#B26A00",
    ],
    ["cmux", "set-progress", "0.12", "--label", "Copilot working: thinking"],
    ["cmux", "log", "--level", "info", "--source", "copilot-cmux-status", "--", "Copilot working: thinking"],
    ["cmux", "trigger-flash"],
  ]);
});

test("marks the agent as done and clears progress", async () => {
  const { controller, calls } = createRecorder();

  await controller.startWorking("thinking");
  calls.length = 0;
  await controller.done();

  assert.deepEqual(calls, [
    ["cmux", "set-progress", "1.00", "--label", "Copilot done - waiting"],
    [
      "cmux",
      "set-status",
      "copilot-cli",
      "Copilot done - waiting",
      "--icon",
      "checkmark",
      "--color",
      "#196F3D",
    ],
    ["cmux", "log", "--level", "success", "--source", "copilot-cmux-status", "--", "Copilot done - waiting"],
    ["cmux", "trigger-flash"],
    ["cmux", "notify", "--title", "Copilot is done", "--body", "The agent is waiting for your next instruction."],
    ["cmux", "clear-progress"],
  ]);
});

test("uses the progress bar for context usage after usage info is available", async () => {
  const { controller, calls } = createRecorder();

  await controller.contextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 });
  await controller.startWorking("thinking");
  calls.length = 0;
  await controller.done();

  assert.deepEqual(calls, [
    ["cmux", "set-progress", "0.21", "--label", "Context 21% (42k/200k, 25 msgs)"],
    [
      "cmux",
      "set-status",
      "copilot-cli",
      "Copilot done - waiting",
      "--icon",
      "checkmark",
      "--color",
      "#196F3D",
    ],
    ["cmux", "log", "--level", "success", "--source", "copilot-cmux-status", "--", "Copilot done - waiting"],
    ["cmux", "trigger-flash"],
    ["cmux", "notify", "--title", "Copilot is done", "--body", "The agent is waiting for your next instruction."],
  ]);
});

test("does not replace progress when context usage is invalid", async () => {
  const { controller, calls } = createRecorder();

  await controller.contextUsage({ currentTokens: 10, tokenLimit: 0, messagesLength: 1 });

  assert.deepEqual(calls, []);
});

test("marks failed tools as attention-grabbing while the agent keeps working", async () => {
  const { controller, calls } = createRecorder();

  await controller.toolStart("apply_patch");
  calls.length = 0;
  await controller.toolComplete("apply_patch", false);

  assert.deepEqual(calls, [
    ["cmux", "log", "--level", "error", "--source", "copilot-cmux-status", "--", "apply patch failed"],
    [
      "cmux",
      "set-status",
      "copilot-cli",
      "Copilot working: apply patch failed",
      "--icon",
      "xmark",
      "--color",
      "#B00020",
    ],
    ["cmux", "trigger-flash"],
  ]);
});

test("reports cmux command failures once without throwing", async () => {
  const calls = [];
  const errors = [];
  const controller = createCmuxStatusController({
    env: { CMUX_WORKSPACE_ID: "workspace-1" },
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    run: async (command, args) => {
      calls.push([command, ...args]);
      throw new Error("cmux unavailable");
    },
    onError: (message) => errors.push(message),
  });

  await controller.ready();
  await controller.done();

  assert.equal(calls.length, 8);
  assert.deepEqual(errors, ["cmux command failed: cmux unavailable"]);
});

test("humanizes tool names for display", () => {
  assert.equal(humanizeToolName("tool.execution_start"), "tool execution start");
  assert.equal(humanizeToolName("apply_patch"), "apply patch");
  assert.equal(humanizeToolName(""), "tool");
});

test("normalizes context usage labels and clamps ratio", () => {
  assert.deepEqual(normalizeContextUsage({ currentTokens: 250_000, tokenLimit: 200_000, messagesLength: 12 }), {
    currentTokens: 250_000,
    tokenLimit: 200_000,
    messagesLength: 12,
    ratio: 1,
    label: "Context 100% (250k/200k, 12 msgs)",
  });
  assert.equal(normalizeContextUsage({ currentTokens: 1, tokenLimit: 0 }), undefined);
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_500), "1.5k");
  assert.equal(formatTokenCount(2_000_000), "2M");
});
