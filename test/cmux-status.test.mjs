import test from "node:test";
import assert from "node:assert/strict";
import {
  createCmuxStatusController,
  DEFAULTS,
  formatTokenCount,
  humanizeToolName,
  normalizeContextUsage,
  renderPlan,
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

function callLine(call) {
  return call.join(" ");
}

function workspaceDescriptions(calls) {
  return calls
    .filter((call) => call[1] === "workspace-action" && call[3] === "set-description")
    .map((call) => call[5]);
}

function aicLineCount(text) {
  return String(text || "").split("\n").filter((line) => line.includes("AIC used")).length;
}

function testConfig(overrides = {}) {
  return { ...DEFAULTS, elapsedIntervalMs: 0, statusKey: "copilot-cli", workspaceTitle: false, ...overrides };
}

test("does not call cmux outside CMUX", async () => {
  const { controller, calls } = createRecorder({});

  await controller.startWorking("thinking");
  await controller.done();

  assert.equal(controller.isEnabled(), false);
  assert.deepEqual(calls, []);
});

test("render plan assigns context to progress and AIC to workspace card", () => {
  const state = {
    activeSubagents: new Map(),
    aiCreditsUsed: 7.5,
    attentionActive: false,
    attentionMessage: "",
    compactionActive: false,
    compactionCount: 0,
    contextUsage: normalizeContextUsage({ currentTokens: 90_300, tokenLimit: 272_000, messagesLength: 78 }),
    currentActivity: "thinking",
    permissionActive: false,
    permissionMessage: "",
    progress: 0.12,
    state: "idle",
    turnStartedAt: undefined,
    turnStats: {
      toolCount: 0,
      failedTools: 0,
      completedSubagents: 0,
      failedSubagents: 0,
      skills: new Map(),
      tools: new Map(),
    },
  };

  const plan = renderPlan(state, testConfig(), "✅ Done");

  assert.equal(plan.status.value, "✅ Done");
  assert.equal(plan.progress.label, "✅ Context 33% (90.3k/272k, 78 msgs)");
  assert.equal(plan.workspaceDescription, "💳 AIC used: 7.5");
  assert.equal(aicLineCount(plan.workspaceDescription), 1);
});

test("render plan moves context to workspace card when context progress is disabled", () => {
  const state = {
    activeSubagents: new Map(),
    aiCreditsUsed: 0,
    attentionActive: false,
    attentionMessage: "",
    compactionActive: false,
    compactionCount: 0,
    contextUsage: normalizeContextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 }),
    currentActivity: "thinking",
    permissionActive: false,
    permissionMessage: "",
    progress: 0.12,
    state: "idle",
    turnStartedAt: undefined,
    turnStats: {
      toolCount: 0,
      failedTools: 0,
      completedSubagents: 0,
      failedSubagents: 0,
      skills: new Map(),
      tools: new Map(),
    },
  };

  const plan = renderPlan(state, testConfig({ contextProgress: false }), "✅ Done");

  assert.equal(plan.progress, undefined);
  assert.equal(plan.workspaceDescription, "🟢 Context 21% (42k/200k, 25 msgs)");
});

test("render plan assigns goal mode to the workspace card only", () => {
  const state = {
    activeSubagents: new Map(),
    aiCreditsUsed: 2,
    attentionActive: false,
    attentionMessage: "",
    compactionActive: false,
    compactionCount: 0,
    contextUsage: normalizeContextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 }),
    currentActivity: "thinking",
    goal: { active: true, title: "implement goal mode support" },
    permissionActive: false,
    permissionMessage: "",
    progress: 0.12,
    state: "working",
    turnStartedAt: undefined,
    turnStats: {
      toolCount: 0,
      failedTools: 0,
      completedSubagents: 0,
      failedSubagents: 0,
      skills: new Map([["cmux", 1]]),
      tools: new Map(),
    },
  };

  const plan = renderPlan(state, testConfig(), "🤖 thinking");

  assert.equal(plan.status.value, "🤖 thinking");
  assert.equal(plan.progress.label, "🤖 Context 21% (42k/200k, 25 msgs)");
  assert.equal(plan.workspaceDescription, "🎯 Goal: implement goal mode support\n🧰 Skills: cmux\n💳 AIC used: 2");
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
    ["cmux", "set-progress", "0.12"],
    ["cmux", "workspace-action", "--action", "clear-description"],
    ["cmux", "workspace-action", "--action", "set-color", "--color", "Amber"],
    ["cmux", "log", "--level", "info", "--source", "copilot-cmux-status", "--", "🤖 thinking"],
  ]);
});

test("marks the agent as done and clears progress", async () => {
  const { controller, calls } = createRecorder();

  await controller.startWorking("thinking");
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-cli ✅ Done --icon checkmark --color #196F3D"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 1.00"));
  assert(!calls.some((call) => callLine(call) === "cmux workspace-action --action set-description --description "));
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "clear-description"));
  assert(calls.some((call) => callLine(call) === "cmux workspace-action --action set-color --color Green"));
  assert(calls.some((call) => callLine(call) === "cmux log --level success --source copilot-cmux-status -- ✅ Done"));
  assert(calls.some((call) => callLine(call) === "cmux notify --title Copilot is done --body ✅ Done"));
  assert(calls.some((call) => callLine(call) === "cmux clear-progress"));
});

test("uses the progress bar for context usage after usage info is available", async () => {
  const { controller, calls } = createRecorder();

  await controller.contextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 });
  await controller.startWorking("thinking");
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.21 --label 🤖 Context 21% (42k/200k, 25 msgs)"));
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-cli ✅ Done --icon checkmark --color #196F3D"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.21 --label ✅ Context 21% (42k/200k, 25 msgs)"));
  assert(!calls.some((call) => callLine(call) === "cmux workspace-action --action set-description --description "));
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "clear-description"));
  assert(calls.some((call) => callLine(call) === "cmux workspace-action --action set-color --color Green"));
  assert(calls.some((call) => callLine(call) === "cmux notify --title Copilot is done --body ✅ Done"));
});

test("labels context progress as working while the agent is active", async () => {
  const { controller, calls } = createRecorder();

  await controller.startWorking("prompt received");
  calls.length = 0;
  await controller.contextUsage({ currentTokens: 93_600, tokenLimit: 272_000, messagesLength: 121 });

  assert.deepEqual(calls, [
    ["cmux", "set-progress", "0.34", "--label", "🤖 Context 34% (93.6k/272k, 121 msgs)"],
  ]);
});

test("does not replace progress when context usage is invalid", async () => {
  const { controller, calls } = createRecorder();

  await controller.contextUsage({ currentTokens: 10, tokenLimit: 0, messagesLength: 1 });

  assert.deepEqual(calls, []);
});

test("can reset ready state without adding duplicate ready logs", async () => {
  const { controller, calls } = createRecorder();

  await controller.ready("✅ Ready", { log: false });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli ✅ Ready --icon checkmark --color #196F3D"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action clear-description"));
  assert(!calls.some((call) => call[1] === "log"));
});

test("marks failed tools as attention-grabbing while the agent keeps working", async () => {
  const { controller, calls } = createRecorder();

  await controller.toolStart("apply_patch");
  calls.length = 0;
  await controller.toolComplete("apply_patch", false);

  assert(calls.some((call) => callLine(call) === "cmux log --level error --source copilot-cmux-status -- apply patch failed"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-cli 🔴 apply patch failed --icon xmark --color #B00020"));
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "set-description"));
  assert(calls.some((call) => callLine(call) === "cmux workspace-action --action set-color --color Red"));
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

  assert.equal(calls.length, 9);
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
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.37 --label ✅ Context 37% (100k/272k, 10 msgs)"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action clear-description"));

  calls.length = 0;
  await controller.contextUsage({ currentTokens: 136_000, tokenLimit: 272_000, messagesLength: 11 });
  await controller.startWorking("thinking");

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli 🤖 thinking --icon gear --color #B00020"));
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.50 --label 🤖 Context 50% (136k/272k, 11 msgs)"));
});

test("makes permission requests obvious", async () => {
  const { controller, calls } = createRecorder();

  await controller.permissionRequested({
    requestId: "perm-1",
    permissionRequest: { kind: "shell", fullCommandText: "npm test -- --watch" },
  });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli 🚨 APPROVAL NEEDED: shell command npm test -- --watch --icon exclamationmark.triangle --color #B00020"));
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 1.00"));
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
    await new Promise((resolve) => setImmediate(resolve));
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
  assert(calls.some((call) => callLine(call) === "cmux workspace-action --action set-description --description 🛠 Tools invoked: 2"));
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli ✅ Done --icon checkmark --color #196F3D"));
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "set-description"));
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
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "set-description"));
});

test("tracks injected skill context when skill invoked events are absent", async () => {
  const { controller, calls } = createRecorder();

  await controller.userPrompt("prompt received");
  calls.length = 0;
  await controller.skillContextMessage('<skill-context name="cmux">loaded</skill-context>');

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧰 Skills: cmux"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level info --source copilot-cmux-status -- skill invoked: cmux (context-load)"));
});

test("tracks autopilot goal objective from injected message text", async () => {
  const { controller, calls } = createRecorder();

  await controller.userPrompt("prompt received");
  calls.length = 0;
  await controller.goalModeMessage([
    "The user set this explicit autopilot objective with /autopilot:",
    "",
    "implement goal mode support",
    "",
    "Work autonomously toward this objective in clear checkpoints.",
  ].join("\n"));

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🎯 Goal: implement goal mode support"));
  assert(!calls.some((call) => call[1] === "set-status"));
  assert(!calls.some((call) => call[1] === "set-progress"));
});

test("allows goal mode card line to be disabled", async () => {
  const { controller, calls } = createRecorder({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_COPILOT_SHOW_GOAL: "0",
  });

  await controller.goalModeMessage([
    "The user set this explicit autopilot objective with /autopilot:",
    "",
    "hide this goal",
  ].join("\n"));

  assert(!workspaceDescriptions(calls).some((description) => description.includes("Goal:")));
});

test("tracks running AIC usage total without changing done status", async () => {
  const { controller, calls } = createRecorder();

  await controller.assistantUsage({ apiCallId: "call-1", cost: 1, model: "gpt-5.5" });
  await controller.assistantUsage({ apiCallId: "call-2", cost: 0.5, model: "gpt-5-mini" });
  await controller.assistantUsage({ apiCallId: "call-2", cost: 0.5, model: "gpt-5-mini" });

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 💳 AIC used: 1"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 💳 AIC used: 1.5"));
  assert(!calls.some((call) => call[1] === "log" && String(call[7]).includes("AIC used")));
  assert(workspaceDescriptions(calls).every((description) => aicLineCount(description) <= 1));

  calls.length = 0;
  await controller.done();

  assert(!calls.some((call) => call[1] === "set-status"));
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "set-description"));
});

test("keeps context out of the workspace card when progress owns context", async () => {
  const calls = [];
  const controller = createCmuxStatusController({
    env: { CMUX_WORKSPACE_ID: "workspace-1" },
    elapsedIntervalMs: 0,
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    workspaceTitle: false,
    run: async (command, args) => {
      calls.push([command, ...args]);
      return {};
    },
  });

  await controller.contextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 });
  await controller.skillInvoked({ name: "cmux" });
  await controller.toolStart("bash", { command: "npm test" });
  await controller.toolComplete("bash", true);
  await controller.toolStart("view");
  await controller.toolComplete("view", true);
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🛠 Tools invoked: 2\n🧰 Skills: cmux"));
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.21 --label ✅ Context 21% (42k/200k, 25 msgs)"));
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "set-description"));
  assert(!calls.some((call) => call[1] === "sidebar-state"));
});

test("shows context on the workspace card when context progress is disabled", async () => {
  const { controller, calls } = createRecorder({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_COPILOT_CONTEXT_PROGRESS: "0",
  });

  await controller.contextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 });

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🟢 Context 21% (42k/200k, 25 msgs)"));
});

test("allows workspace detail lines to be disabled independently", async () => {
  const { controller, calls } = createRecorder({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_COPILOT_SHOW_AIC: "0",
    CMUX_COPILOT_SHOW_COMPACTIONS: "0",
    CMUX_COPILOT_SHOW_CONTEXT: "0",
    CMUX_COPILOT_SHOW_SKILLS: "0",
    CMUX_COPILOT_SHOW_TOOL_ACTIVITY: "0",
  });

  await controller.contextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 });
  await controller.assistantUsage({ apiCallId: "call-1", cost: 1, model: "gpt-5.5" });
  await controller.skillInvoked({ name: "cmux" });
  await controller.toolStart("bash", { command: "npm test" });
  await controller.toolComplete("bash", true);
  await controller.compactionCompleted({ success: true, tokensRemoved: 10_000 });
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action clear-description"));
  calls.length = 0;
  await controller.done();

  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "set-description"));
});

test("does not generate ellipses for long skill or subagent lists", async () => {
  const { controller, calls } = createRecorder();

  await controller.skillInvoked({ name: "cmux" });
  await controller.skillInvoked({ name: "worktree-arena" });
  await controller.skillInvoked({ name: "autoreview" });
  await controller.skillInvoked({ name: "crabbox" });
  await controller.subagentStarted({ toolCallId: "a", agentDisplayName: "Alpha" });
  await controller.subagentStarted({ toolCallId: "b", agentDisplayName: "Beta" });
  await controller.subagentStarted({ toolCallId: "c", agentDisplayName: "Gamma" });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-cli 🤖 3 subagents running: Alpha, Beta, Gamma --icon gear --color #B26A00"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧰 Skills: cmux, worktree-arena, autoreview, crabbox"));
  assert(!calls.some((call) => call.some((part) => String(part).includes("...") || String(part).includes("…"))));
});

test("tracks compaction count without changing done status", async () => {
  const { controller, calls } = createRecorder();

  await controller.compactionStarted({ conversationTokens: 180_000 });
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action clear-description"));
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
