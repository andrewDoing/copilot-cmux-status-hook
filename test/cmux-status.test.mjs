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
    elapsedIntervalMs: 0,
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    workspaceTitle: false,
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

test("marks the agent as working with status, progress, and log", async () => {
  const { controller, calls } = createRecorder();

  await controller.startWorking("thinking");

  assert.deepEqual(calls, [
    [
      "cmux",
      "set-status",
      "copilot-cli",
      "🤖 thinking",
      "--icon",
      "gear",
      "--color",
      "#B26A00",
    ],
    ["cmux", "set-progress", "0.12", "--label", "🤖 thinking"],
    ["cmux", "workspace-action", "--action", "set-description", "--description", ""],
    ["cmux", "workspace-action", "--action", "set-color", "--color", "Amber"],
    ["cmux", "log", "--level", "info", "--source", "copilot-cmux-status", "--", "🤖 thinking"],
  ]);
});

test("marks the agent as done and clears progress", async () => {
  const { controller, calls } = createRecorder();

  await controller.startWorking("thinking");
  calls.length = 0;
  await controller.done();

  assert.deepEqual(calls, [
    ["cmux", "set-progress", "1.00", "--label", "✅ Done"],
    [
      "cmux",
      "set-status",
      "copilot-cli",
      "✅ Done",
      "--icon",
      "checkmark",
      "--color",
      "#196F3D",
    ],
    ["cmux", "workspace-action", "--action", "set-description", "--description", ""],
    ["cmux", "workspace-action", "--action", "set-color", "--color", "Green"],
    ["cmux", "log", "--level", "success", "--source", "copilot-cmux-status", "--", "✅ Done"],
    ["cmux", "notify", "--title", "Copilot is done", "--body", "✅ Done"],
    ["cmux", "clear-progress"],
  ]);
});

test("uses the progress bar for context usage after usage info is available", async () => {
  const { controller, calls } = createRecorder();

  await controller.contextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 });
  await controller.startWorking("thinking");
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.21 --label 🤖 Context 21% (42k/200k, 25 msgs)"));
  calls.length = 0;
  await controller.done();

  assert.deepEqual(calls, [
    ["cmux", "set-progress", "0.21", "--label", "✅ Context 21% (42k/200k, 25 msgs)"],
    [
      "cmux",
      "set-status",
      "copilot-cli",
      "✅ Done",
      "--icon",
      "checkmark",
      "--color",
      "#196F3D",
    ],
    [
      "cmux",
      "workspace-action",
      "--action",
      "set-description",
      "--description",
      "",
    ],
    ["cmux", "workspace-action", "--action", "set-color", "--color", "Green"],
    ["cmux", "log", "--level", "success", "--source", "copilot-cmux-status", "--", "✅ Done"],
    ["cmux", "notify", "--title", "Copilot is done", "--body", "✅ Done"],
  ]);
});

test("labels context progress as working while the agent is active", async () => {
  const { controller, calls } = createRecorder();

  await controller.startWorking("prompt received");
  calls.length = 0;
  await controller.contextUsage({ currentTokens: 93_600, tokenLimit: 272_000, messagesLength: 121 });

  assert.deepEqual(calls, [
    ["cmux", "set-progress", "0.34", "--label", "🤖 Context 34% (93.6k/272k, 121 msgs)"],
    [
      "cmux",
      "workspace-action",
      "--action",
      "set-description",
      "--description",
      "",
    ],
    ["cmux", "workspace-action", "--action", "set-color", "--color", "Amber"],
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
      "🔴 apply patch failed",
      "--icon",
      "xmark",
      "--color",
      "#B00020",
    ],
    [
      "cmux",
      "workspace-action",
      "--action",
      "set-description",
      "--description",
      "🛠 Tools invoked: 1",
    ],
    ["cmux", "workspace-action", "--action", "set-color", "--color", "Red"],
  ]);
});

test("reports cmux command failures once without throwing", async () => {
  const calls = [];
  const errors = [];
  const controller = createCmuxStatusController({
    env: { CMUX_WORKSPACE_ID: "workspace-1" },
    elapsedIntervalMs: 0,
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    workspaceTitle: false,
    run: async (command, args) => {
      calls.push([command, ...args]);
      throw new Error("cmux unavailable");
    },
    onError: (message) => errors.push(message),
  });

  await controller.ready();
  await controller.done();

  assert.equal(calls.length, 11);
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

test("marks context yellow at 100k tokens and red at 50 percent", async () => {
  const { controller, calls } = createRecorder();

  await controller.contextUsage({ currentTokens: 100_000, tokenLimit: 272_000, messagesLength: 10 });
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description "));

  calls.length = 0;
  await controller.contextUsage({ currentTokens: 136_000, tokenLimit: 272_000, messagesLength: 11 });
  await controller.startWorking("thinking");

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli 🤖 thinking --icon gear --color #B00020"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description "));
});

test("makes permission requests obvious", async () => {
  const { controller, calls } = createRecorder();

  await controller.permissionRequested({
    requestId: "perm-1",
    permissionRequest: { kind: "shell", fullCommandText: "npm test -- --watch" },
  });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli 🚨 APPROVAL NEEDED: shell command npm test -- --watch --icon exclamationmark.triangle --color #B00020"));
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 1.00 --label 🚨 APPROVAL NEEDED: shell command npm test -- --watch"));
  assert(calls.some((call) => call.join(" ") === "cmux notify --title Copilot needs approval --body 🚨 APPROVAL NEEDED: shell command npm test -- --watch"));
});

test("shows elapsed time for permission requests that start a turn", async () => {
  const calls = [];
  const now = 1_000_000;
  let intervalCallback;
  const controller = createCmuxStatusController({
    env: { CMUX_WORKSPACE_ID: "workspace-1" },
    elapsedIntervalMs: 1000,
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    workspaceTitle: false,
    timers: {
      setInterval(callback) {
        intervalCallback = callback;
        return 1;
      },
      clearInterval() {},
      setTimeout() {
        return 1;
      },
      clearTimeout() {},
    },
    run: async (command, args) => {
      calls.push([command, ...args]);
    },
  });
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    await controller.permissionRequested({
      requestId: "perm-1",
      permissionRequest: { kind: "write" },
    });
    calls.length = 0;
    Date.now = () => now + 5000;
    await intervalCallback();
  } finally {
    Date.now = originalNow;
    controller.dispose();
  }

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description Elapsed 5s"));
});

test("tracks subagents and summarizes completion", async () => {
  const { controller, calls } = createRecorder();

  await controller.userPrompt("prompt received");
  await controller.subagentStarted({
    toolCallId: "agent-1",
    agentDisplayName: "Reviewer",
    agentName: "reviewer",
  });
  await controller.subagentCompleted({
    toolCallId: "agent-1",
    agentDisplayName: "Reviewer",
    agentName: "reviewer",
  });
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli ✅ Done --icon checkmark --color #196F3D"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🤖 Subagents completed: 1"));
});

test("does not duplicate completed tool summary in workspace description", async () => {
  const { controller, calls } = createRecorder();

  await controller.toolStart("bash", { command: "npm test" });
  await controller.toolComplete("bash", true);
  await controller.toolStart("view");
  await controller.toolComplete("view", true);
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli ✅ Done --icon checkmark --color #196F3D"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🛠 Tools invoked: 2"));
});

test("tracks invoked skill names without changing done status", async () => {
  const { controller, calls } = createRecorder();

  await controller.userPrompt("prompt received");
  calls.length = 0;
  await controller.skillInvoked({ name: "cmux", trigger: "agent-invoked" });
  await controller.skillInvoked({ name: "worktree-arena", trigger: "user-invoked" });

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧰 Skills: cmux"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧰 Skills: cmux, worktree-arena"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level info --source copilot-cmux-status -- skill invoked: cmux (agent-invoked)"));

  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli ✅ Done --icon checkmark --color #196F3D"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧰 Skills: cmux, worktree-arena"));
});

test("tracks injected skill context when skill invoked events are absent", async () => {
  const { controller, calls } = createRecorder();

  await controller.userPrompt("prompt received");
  calls.length = 0;
  await controller.skillContextMessage('<skill-context name="cmux">loaded</skill-context>');

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧰 Skills: cmux"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level info --source copilot-cmux-status -- skill invoked: cmux (context-load)"));
});

test("tracks running AIC usage total without changing done status", async () => {
  const { controller, calls } = createRecorder();

  await controller.assistantUsage({ apiCallId: "call-1", cost: 1, model: "gpt-5.5" });
  await controller.assistantUsage({ apiCallId: "call-2", cost: 0.5, model: "gpt-5-mini" });
  await controller.assistantUsage({ apiCallId: "call-2", cost: 0.5, model: "gpt-5-mini" });

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 💳 AIC used: 1"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 💳 AIC used: 1.5"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level info --source copilot-cmux-status -- AIC used: 1.5 (+0.5 gpt-5-mini)"));

  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli ✅ Done --icon checkmark --color #196F3D"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 💳 AIC used: 1.5"));
});

test("tracks compaction count without changing done status", async () => {
  const { controller, calls } = createRecorder();

  await controller.compactionStarted({ conversationTokens: 180_000 });
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description "));
  assert(calls.some((call) => call.join(" ") === "cmux log --level info --source copilot-cmux-status -- compaction started at 180k conversation tokens"));

  calls.length = 0;
  await controller.compactionCompleted({ success: true, tokensRemoved: 75_000 });
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux log --level success --source copilot-cmux-status -- compaction complete: 1 compaction, 75k tokens removed"));
  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli ✅ Done --icon checkmark --color #196F3D"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧹 Compactions: 1"));
  assert(calls.some((call) => call.join(" ") === "cmux notify --title Copilot is done --body 🧹 Compactions: 1"));
});

test("marks failed compactions as needing attention", async () => {
  const { controller, calls } = createRecorder();

  await controller.compactionStarted();
  calls.length = 0;
  await controller.compactionCompleted({ success: false, error: "summary failed" });
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli 🔴 compaction failed --icon xmark --color #B00020"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level error --source copilot-cmux-status -- compaction failed: summary failed"));
  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli 🔴 Needs attention: compaction failed --icon xmark --color #B00020"));
});

test("logs raw events when debug mode is enabled", async () => {
  const { controller, calls } = createRecorder({ CMUX_WORKSPACE_ID: "workspace-1", CMUX_COPILOT_DEBUG: "1" });

  await controller.debugEvent("permission.requested");

  assert.deepEqual(calls, [
    ["cmux", "log", "--level", "info", "--source", "copilot-cmux-status", "--", "event: permission.requested"],
  ]);
});

test("prefixes workspace title with working and done emoji", async () => {
  const calls = [];
  const controller = createCmuxStatusController({
    env: { CMUX_WORKSPACE_ID: "workspace-1" },
    elapsedIntervalMs: 0,
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "tree") {
        return {
          stdout: JSON.stringify({
            active: { workspace_ref: "workspace:1" },
            windows: [{ workspaces: [{ ref: "workspace:1", selected: true, title: "Project" }] }],
          }),
        };
      }
      return {};
    },
  });

  await controller.startWorking("thinking");
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action rename --title 🤖 Project"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action rename --title ✅ Project"));
});
