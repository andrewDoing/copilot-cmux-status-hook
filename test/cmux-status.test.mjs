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

const DEFAULT_ENV = {
  CMUX_WORKSPACE_ID: "workspace-1",
  CMUX_SURFACE_ID: "surface-1",
  CMUX_COPILOT_WORKSPACE_CARD: "0",
};

function createRecorder(env = DEFAULT_ENV) {
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

function createCardRecorder(env = { CMUX_WORKSPACE_ID: "workspace-1", CMUX_SURFACE_ID: "surface-1" }) {
  return createRecorder({ ...env, CMUX_COPILOT_WORKSPACE_CARD: "1" });
}

function callLine(call) {
  return call.join(" ");
}

function workspaceDescriptions(calls) {
  return calls
    .filter((call) => call[1] === "workspace-action" && call[3] === "set-description")
    .map((call) => call[5]);
}

function assertNoLifecycleStatusWrites(calls) {
  assert(!calls.some((call) => call[1] === "set-status"));
}

function statusValues(calls) {
  return calls.filter((call) => call[1] === "set-status").map((call) => call[3]);
}

function surfaceCommands(calls) {
  return new Set(
    calls.flatMap((call) => {
      if (call[1] === "set-status") return ["status"];
      if (call[1] === "set-progress") return ["progress"];
      if (call[1] === "clear-progress") return ["clear-progress"];
      if (call[1] === "workspace-action" && ["set-description", "clear-description"].includes(call[3])) {
        return ["workspace-card"];
      }
      if (call[1] === "workspace-action" && call[3] === "rename") return ["workspace-title"];
      if (call[1] === "workspace-action" && call[3] === "set-color") return ["workspace-color"];
      return [];
    }),
  );
}

function assertSurfaceCommands(calls, expected) {
  const actual = surfaceCommands(calls);
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

function assertNoSharedProgressOrCardWrites(calls) {
  assert(!calls.some((call) => call[1] === "set-progress"));
  assert(!calls.some((call) => call[1] === "clear-progress"));
  assert(!calls.some((call) => call[1] === "workspace-action" && ["set-description", "clear-description"].includes(call[3])));
}

function assertNoWorkspaceDescriptionWrites(calls) {
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "set-description"));
}

function assertClearsWorkspaceDescription(calls) {
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action clear-description"));
}

function aicLineCount(text) {
  return String(text || "").split("\n").filter((line) => line.includes("AIC used")).length;
}

function testConfig(overrides = {}) {
  return {
    ...DEFAULTS,
    contextProgress: true,
    elapsedIntervalMs: 0,
    lifecycleStatus: false,
    progressBar: true,
    statusKey: "copilot-surface-1",
    workspaceCard: true,
    workspaceTitle: false,
    ...overrides,
  };
}

function renderState(overrides = {}) {
  return {
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
    state: "working",
    turnStartedAt: undefined,
    turnStats: {
      toolCount: 0,
      failedTools: 0,
      completedSubagents: 0,
      failedSubagents: 0,
      skills: new Map(),
      tools: new Map(),
    },
    ...overrides,
  };
}

test("does not call cmux outside CMUX", async () => {
  const { controller, calls } = createRecorder({});

  await controller.startWorking("thinking");
  await controller.done();

  assert.equal(controller.isEnabled(), false);
  assert.deepEqual(calls, []);
});

test("render plan shows AIC on the workspace card", () => {
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

  assert.equal(plan.status, undefined);
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

  assert.equal(plan.status, undefined);
  assert.equal(plan.progress.label, "🤖 Context 21% (42k/200k, 25 msgs)");
  assert.equal(plan.workspaceDescription, "🎯 Goal: implement goal mode support\n🧰 Skills: cmux\n💳 AIC used: 2");
});

test("render plan routes detail kinds through the surface policy", () => {
  const state = {
    activeSubagents: new Map([["agent-1", "Reviewer"]]),
    aiCreditsUsed: 2,
    attentionActive: false,
    attentionMessage: "",
    compactionActive: false,
    compactionCount: 1,
    contextUsage: normalizeContextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 }),
    currentActivity: "thinking",
    goal: { active: true, title: "implement goal mode support" },
    permissionActive: false,
    permissionMessage: "",
    progress: 0.12,
    state: "working",
    turnStartedAt: undefined,
    turnStats: {
      toolCount: 2,
      failedTools: 0,
      completedSubagents: 1,
      failedSubagents: 0,
      skills: new Map([["cmux", 1]]),
      tools: new Map([["bash", 1], ["view", 1]]),
    },
  };
  const plan = renderPlan(state, testConfig({ contextProgress: false }), "🤖 thinking");

  assert.equal(plan.status, undefined);
  assert.equal(plan.progress, undefined);
  assert.equal(plan.workspaceDescription, [
    "1 subagent running: Reviewer",
    "🤖 Subagents completed: 1",
    "🛠 Tools invoked: 2",
    "🎯 Goal: implement goal mode support",
    "🧰 Skills: cmux",
    "🟢 Context 21% (42k/200k, 25 msgs)",
    "🧹 Compactions: 1",
    "💳 AIC used: 2",
  ].join("\n"));
  assert(plan.workspaceDescription.includes("AIC used"));
  assert(plan.workspaceDescription.includes("Tools invoked"));
});

test("render plan enforces disabled surface contracts", () => {
  const state = renderState();

  const defaultPlan = renderPlan(state, testConfig({
    contextProgress: true,
    lifecycleStatus: true,
    progressBar: false,
    workspaceCard: false,
  }), "🤖 thinking", {
    fallbackProgress: { value: 0.12, label: "fallback" },
    progress: { value: 0.5, label: "explicit" },
  });

  assert.equal(defaultPlan.status?.key, "copilot-surface-1");
  assert.equal(defaultPlan.progress, undefined);
  assert.equal(defaultPlan.workspaceDescription, undefined);

  const noLifecyclePlan = renderPlan(state, testConfig({
    lifecycleStatus: false,
    progressBar: false,
    workspaceCard: false,
  }), "🤖 thinking");

  assert.equal(noLifecyclePlan.status, undefined);
  assert.equal(noLifecyclePlan.progress, undefined);
  assert.equal(noLifecyclePlan.workspaceDescription, undefined);
});

test("surface policy matrix limits shared CMUX surfaces", async () => {
  const cases = [
    {
      name: "default",
      env: {},
      expected: ["status"],
    },
    {
      name: "progress bar only",
      env: { CMUX_COPILOT_PROGRESS_BAR: "1" },
      expected: ["status", "progress"],
    },
    {
      name: "context progress without progress bar",
      env: { CMUX_COPILOT_CONTEXT_PROGRESS: "1" },
      expected: ["status"],
    },
    {
      name: "context progress with progress bar",
      env: { CMUX_COPILOT_CONTEXT_PROGRESS: "1", CMUX_COPILOT_PROGRESS_BAR: "1" },
      expected: ["status", "progress"],
    },
    {
      name: "workspace card",
      env: { CMUX_COPILOT_WORKSPACE_CARD: "1" },
      expected: ["status", "workspace-card", "workspace-color"],
    },
    {
      name: "lifecycle status disabled",
      env: { CMUX_COPILOT_LIFECYCLE_STATUS: "0" },
      expected: [],
    },
  ];

  for (const { name, env, expected } of cases) {
    const { controller, calls } = createRecorder({
      ...DEFAULT_ENV,
      ...env,
    });

    await controller.contextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 });
    await controller.skillInvoked({ name: "cmux" });
    await controller.startWorking(`matrix ${name}`);

    assertSurfaceCommands(calls, expected);
    controller.dispose();
  }
});

test("adds working status without shared progress, workspace card, or logs", async () => {
  const { controller, calls } = createRecorder();

  await controller.startWorking("thinking");

  assert.deepEqual(calls, [
    ["cmux", "set-status", "copilot-surface-1", "Copilot: thinking", "--icon", "gear", "--color", "#B26A00"],
  ]);
  assert(!calls.some((call) => call[1] === "log"));
  assertNoSharedProgressOrCardWrites(calls);
});

test("prompt submission updates only the per-surface status by default", async () => {
  const calls = [];
  const controller = createCmuxStatusController({
    env: { CMUX_WORKSPACE_ID: "workspace-1", CMUX_SURFACE_ID: "surface-1" },
    elapsedIntervalMs: 0,
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "tree") {
        return {
          stdout: JSON.stringify({
            active: { workspace_ref: "workspace:1" },
            windows: [{ workspaces: [{ ref: "workspace:1", selected: true, title: "✅ GitHub Copilot" }] }],
          }),
        };
      }
      return {};
    },
  });

  await controller.userPrompt("reading prompt");

  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: reading prompt --icon gear --color #B26A00"));
  assert(!calls.some((call) => call[1] === "workspace-action"));
  assertNoSharedProgressOrCardWrites(calls);
});

test("marks the agent as done on the same per-surface status key", async () => {
  const { controller, calls } = createRecorder();

  await controller.startWorking("thinking");
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: Done --icon checkmark --color #196F3D"));
  assertNoSharedProgressOrCardWrites(calls);
  assert(!calls.some((call) => callLine(call) === "cmux log --level success --source copilot-cmux-status -- ✅ Done"));
  assert(calls.some((call) => callLine(call) === "cmux notify --title Copilot is done --body ✅ Done"));
});

test("can opt in to the progress bar for context usage", async () => {
  const { controller, calls } = createRecorder({
    ...DEFAULT_ENV,
    CMUX_COPILOT_CONTEXT_PROGRESS: "1",
    CMUX_COPILOT_PROGRESS_BAR: "1",
  });

  await controller.contextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 });
  await controller.startWorking("thinking");
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.21 --label 🤖 Context 21% (42k/200k, 25 msgs)"));
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: Done --icon checkmark --color #196F3D"));
  assert(calls.some((call) => callLine(call) === "cmux set-progress 0.21 --label ✅ Context 21% (42k/200k, 25 msgs)"));
  assert(!calls.some((call) => callLine(call) === "cmux workspace-action --action set-description --description "));
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "clear-description"));
  assert(calls.some((call) => callLine(call) === "cmux notify --title Copilot is done --body ✅ Done"));
});

test("keeps context usage off shared progress by default", async () => {
  const { controller, calls } = createRecorder();

  await controller.contextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 });
  await controller.startWorking("thinking");
  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-surface-1 Copilot: thinking --icon gear --color #B26A00"));
  assertNoSharedProgressOrCardWrites(calls);
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: Done --icon checkmark --color #196F3D"));
  assert(!calls.some((call) => callLine(call) === "cmux workspace-action --action set-description --description "));
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "clear-description"));
  assert(calls.some((call) => callLine(call) === "cmux notify --title Copilot is done --body ✅ Done"));
});

test("labels opted-in context progress as working while the agent is active", async () => {
  const { controller, calls } = createRecorder({
    ...DEFAULT_ENV,
    CMUX_COPILOT_CONTEXT_PROGRESS: "1",
    CMUX_COPILOT_PROGRESS_BAR: "1",
  });

  await controller.startWorking("prompt received");
  calls.length = 0;
  await controller.contextUsage({ currentTokens: 93_600, tokenLimit: 272_000, messagesLength: 121 });

  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.34 --label 🤖 Context 34% (93.6k/272k, 121 msgs)"));
});

test("does not replace progress when context usage is invalid", async () => {
  const { controller, calls } = createRecorder();

  await controller.contextUsage({ currentTokens: 10, tokenLimit: 0, messagesLength: 1 });

  assert.deepEqual(calls, []);
});

test("can reset ready state without adding duplicate ready logs", async () => {
  const { controller, calls } = createRecorder();

  await controller.ready("✅ Ready", { log: false });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-surface-1 Copilot: Ready --icon checkmark --color #196F3D"));
  assert(!calls.some((call) => call[1] === "workspace-action"));
  assert(!calls.some((call) => call[1] === "log"));
});

test("startup clears only this surface status before writing ready status", async () => {
  const { controller, calls } = createRecorder();

  await controller.startupReady("✅ Ready");

  assert.deepEqual(calls, [
    ["cmux", "clear-status", "copilot-surface-1"],
    ["cmux", "clear-log"],
    ["cmux", "set-status", "copilot-surface-1", "Copilot: Ready", "--icon", "checkmark", "--color", "#196F3D"],
  ]);
});

test("startup clears stale workspace card when card updates are enabled", async () => {
  const { controller, calls } = createCardRecorder();

  await controller.startupReady("✅ Ready");

  assert(calls.some((call) => call.join(" ") === "cmux clear-status copilot-surface-1"));
  assertClearsWorkspaceDescription(calls);
  assert(calls.some((call) => call.join(" ") === "cmux clear-log"));
});

test("multiple controllers in one workspace use isolated status keys", async () => {
  const first = createRecorder({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_SURFACE_ID: "surface-a",
    CMUX_COPILOT_WORKSPACE_CARD: "0",
  });
  const second = createRecorder({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_SURFACE_ID: "surface-b",
    CMUX_COPILOT_WORKSPACE_CARD: "0",
  });

  await first.controller.startWorking("editing frontend");
  await second.controller.startWorking("running tests");
  await first.controller.done();
  await second.controller.done();

  assert(first.calls.every((call) => call[1] !== "set-status" || call[2] === "copilot-surface-a"));
  assert(second.calls.every((call) => call[1] !== "set-status" || call[2] === "copilot-surface-b"));
  assert(!first.calls.some((call) => call[1] === "clear-status" && call[2] === "copilot-surface-b"));
  assert(!second.calls.some((call) => call[1] === "clear-status" && call[2] === "copilot-surface-a"));
  assertNoSharedProgressOrCardWrites(first.calls);
  assertNoSharedProgressOrCardWrites(second.calls);
});

test("uses a per-surface lifecycle status by default", async () => {
  const { controller, calls } = createRecorder({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_SURFACE_ID: "surface-99",
  });

  await controller.ready("✅ Ready", { log: false });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-surface-99 Copilot: Ready --icon checkmark --color #196F3D"));
});

test("default pulse path does not write shared progress", async () => {
  const calls = [];
  let intervalCallback;
  const controller = createCmuxStatusController({
    env: {
      CMUX_WORKSPACE_ID: "workspace-1",
      CMUX_SURFACE_ID: "surface-1",
      CMUX_COPILOT_WORKSPACE_CARD: "0",
    },
    elapsedIntervalMs: 0,
    pulseIntervalMs: 100,
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

  await controller.startWorking("thinking");

  assert.equal(intervalCallback, undefined);
  assert(!calls.some((call) => call[1] === "set-progress"));
  controller.dispose();
});

test("default compaction pulse path does not write shared progress", async () => {
  const calls = [];
  let intervalCallback;
  const controller = createCmuxStatusController({
    env: {
      CMUX_WORKSPACE_ID: "workspace-1",
      CMUX_SURFACE_ID: "surface-1",
      CMUX_COPILOT_WORKSPACE_CARD: "0",
    },
    elapsedIntervalMs: 0,
    pulseIntervalMs: 100,
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

  await controller.compactionStarted({ conversationTokens: 100_000 });

  assert.equal(intervalCallback, undefined);
  assert(!calls.some((call) => call[1] === "set-progress"));
  controller.dispose();
});

test("default done and error flows do not clear shared progress", async () => {
  const { controller, calls } = createRecorder();

  await controller.startWorking("thinking");
  calls.length = 0;
  await controller.done();
  await controller.error("model failed");

  assert(!calls.some((call) => call[1] === "clear-progress"));
  assert(!calls.some((call) => call[1] === "set-progress"));
});

test("dispose can preserve status when cleanup is disabled", async () => {
  const { controller, calls } = createRecorder({
    ...DEFAULT_ENV,
    CMUX_COPILOT_CLEAR_STATUS_ON_DISPOSE: "0",
  });

  await controller.startWorking("thinking");
  calls.length = 0;
  controller.dispose();
  await new Promise((resolve) => setImmediate(resolve));

  assert(!calls.some((call) => call[1] === "clear-status"));
});

test("pulse updates do not clear lifecycle status when progress is enabled", async () => {
  const calls = [];
  let intervalCallback;
  const controller = createCmuxStatusController({
    env: {
      CMUX_WORKSPACE_ID: "workspace-1",
      CMUX_SURFACE_ID: "surface-1",
      CMUX_COPILOT_LIFECYCLE_STATUS: "1",
      CMUX_COPILOT_PROGRESS_BAR: "1",
      CMUX_COPILOT_WORKSPACE_CARD: "0",
    },
    elapsedIntervalMs: 0,
    pulseIntervalMs: 100,
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

  await controller.startWorking("thinking");
  calls.length = 0;
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));

  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.20"));
  assert(!calls.some((call) => call[1] === "clear-status"));
  controller.dispose();
});

test("workspace card details can be enabled", async () => {
  const calls = [];
  const controller = createCmuxStatusController({
    env: { CMUX_WORKSPACE_ID: "workspace-1", CMUX_SURFACE_ID: "surface-1", CMUX_COPILOT_WORKSPACE_CARD: "1" },
    elapsedIntervalMs: 0,
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    workspaceTitle: false,
    run: async (command, args) => {
      calls.push([command, ...args]);
    },
  });

  await controller.skillInvoked({ name: "cmux" });
  await controller.toolStart("bash", { command: "npm test" });

  assert(workspaceDescriptions(calls).some((description) => description.includes("Skills: cmux")));
  assert(workspaceDescriptions(calls).some((description) => description.includes("Tools invoked: 1")));
});

test("can preserve startup logs when clearing logs is disabled", async () => {
  const { controller, calls } = createRecorder({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_COPILOT_CLEAR_LOG_ON_START: "0",
  });

  await controller.startupReady("✅ Ready");

  assert(!calls.some((call) => call[1] === "clear-log"));
});

test("can opt in to lifecycle logs", async () => {
  const { controller, calls } = createRecorder({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_COPILOT_LOG_LIFECYCLE: "1",
  });

  await controller.startWorking("thinking");
  await controller.done();

  assert(calls.some((call) => callLine(call) === "cmux log --level info --source copilot-cmux-status -- 🤖 thinking"));
  assert(calls.some((call) => callLine(call) === "cmux log --level success --source copilot-cmux-status -- ✅ Done"));
});

test("marks failed tools as attention-grabbing while the agent keeps working", async () => {
  const { controller, calls } = createRecorder();

  await controller.toolStart("apply_patch");
  calls.length = 0;
  await controller.toolComplete("apply_patch", false);

  assert(calls.some((call) => callLine(call) === "cmux log --level error --source copilot-cmux-status -- apply patch failed"));
  assert(calls.some((call) => callLine(call) === "cmux set-status copilot-surface-1 Copilot: apply patch failed --icon xmark --color #B00020"));
  assertNoWorkspaceDescriptionWrites(calls);
  assertNoSharedProgressOrCardWrites(calls);
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
    workspaceCard: false,
    run: async (command, args) => {
      calls.push([command, ...args]);
      throw new Error("cmux unavailable");
    },
    onError: (message) => errors.push(message),
  });

  await controller.ready();
  await controller.done();

  assert.equal(calls.length, 3);
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

test("marks opted-in context progress yellow at 100k tokens and red at 50 percent", async () => {
  const { controller, calls } = createRecorder({
    ...DEFAULT_ENV,
    CMUX_COPILOT_CONTEXT_PROGRESS: "1",
    CMUX_COPILOT_PROGRESS_BAR: "1",
  });

  await controller.contextUsage({ currentTokens: 100_000, tokenLimit: 272_000, messagesLength: 10 });
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.37 --label ✅ Context 37% (100k/272k, 10 msgs)"));
  assert(!calls.some((call) => call[1] === "workspace-action"));

  calls.length = 0;
  await controller.contextUsage({ currentTokens: 136_000, tokenLimit: 272_000, messagesLength: 11 });
  await controller.startWorking("thinking");

  assert(calls.some((call) => call[1] === "set-status" && call[2] === "copilot-surface-1"));
  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.50 --label 🤖 Context 50% (136k/272k, 11 msgs)"));
});

test("makes permission requests obvious", async () => {
  const { controller, calls } = createRecorder();

  await controller.permissionRequested({
    requestId: "perm-1",
    permissionRequest: { kind: "shell", fullCommandText: "npm test -- --watch" },
  });

  assert(calls.some((call) => call.join(" ") === "cmux set-status copilot-surface-1 Copilot: APPROVAL NEEDED: shell command npm test -- --watch --icon exclamationmark.triangle --color #B00020"));
  assertNoSharedProgressOrCardWrites(calls);
  assert(calls.some((call) => call.join(" ") === "cmux notify --title Copilot needs approval --body 🚨 APPROVAL NEEDED: shell command npm test -- --watch"));
});

test("shows elapsed time for permission requests on the workspace card when enabled", async () => {
  const calls = [];
  const now = 1_000_000;
  let intervalCallback;
  const controller = createCmuxStatusController({
    env: { CMUX_WORKSPACE_ID: "workspace-1", CMUX_COPILOT_WORKSPACE_CARD: "1" },
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
  const { controller, calls } = createCardRecorder();

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

  assert(calls.some((call) => call[1] === "set-status" && call[2] === "copilot-surface-1"));
  assertNoWorkspaceDescriptionWrites(calls);
  assert(!calls.some((call) => String(call[5] || "").includes("Subagents completed")));
});

test("shows tool summary on the workspace card", async () => {
  const { controller, calls } = createCardRecorder();

  await controller.toolStart("bash", { command: "npm test" });
  await controller.toolComplete("bash", true);
  await controller.toolStart("view");
  await controller.toolComplete("view", true);
  assert(workspaceDescriptions(calls).some((description) => description.includes("Tools invoked: 2")));
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => call[1] === "set-status" && call[2] === "copilot-surface-1"));
  assertNoWorkspaceDescriptionWrites(calls);
  assertClearsWorkspaceDescription(calls);
});

test("tracks invoked skill names on the workspace card when enabled", async () => {
  const { controller, calls } = createCardRecorder();

  await controller.userPrompt("prompt received");
  calls.length = 0;
  await controller.skillInvoked({ name: "cmux", trigger: "agent-invoked" });
  await controller.skillInvoked({ name: "worktree-arena", trigger: "user-invoked" });

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧰 Skills: cmux"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧰 Skills: cmux, worktree-arena"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level info --source copilot-cmux-status -- skill invoked: cmux (agent-invoked)"));

  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => call[1] === "set-status" && call[2] === "copilot-surface-1"));
  assertNoWorkspaceDescriptionWrites(calls);
  assertClearsWorkspaceDescription(calls);
});

test("tracks injected skill context on the workspace card when enabled", async () => {
  const { controller, calls } = createCardRecorder();

  await controller.userPrompt("prompt received");
  calls.length = 0;
  await controller.skillContextMessage('<skill-context name="cmux">loaded</skill-context>');

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧰 Skills: cmux"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level info --source copilot-cmux-status -- skill invoked: cmux (context-load)"));
});

test("tracks autopilot goal objective from injected message text", async () => {
  const { controller, calls } = createCardRecorder();

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
  assertNoLifecycleStatusWrites(calls);
  assert(!calls.some((call) => call[1] === "set-progress"));
});

test("allows goal mode card line to be disabled", async () => {
  const { controller, calls } = createCardRecorder({
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

test("tracks running AIC usage total on the workspace card", async () => {
  const { controller, calls } = createCardRecorder();

  await controller.assistantUsage({ apiCallId: "call-1", cost: 1, model: "gpt-5.5" });
  await controller.assistantUsage({ apiCallId: "call-2", cost: 0.5, model: "gpt-5-mini" });
  await controller.assistantUsage({ apiCallId: "call-2", cost: 0.5, model: "gpt-5-mini" });

  assert(workspaceDescriptions(calls).some((description) => description.includes("AIC used: 1")));
  assert(workspaceDescriptions(calls).some((description) => description.includes("AIC used: 1.5")));
  assert(!calls.some((call) => call[1] === "log" && String(call[7]).includes("AIC used")));
  assert(calls.some((call) => call[1] === "set-status" && call[2] === "copilot-surface-1"));

  calls.length = 0;
  await controller.done();

  assertNoWorkspaceDescriptionWrites(calls);
  assertClearsWorkspaceDescription(calls);
});

test("clearStatus removes lifecycle status and owned shared surfaces", async () => {
  const { controller, calls } = createRecorder({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_SURFACE_ID: "surface-1",
    CMUX_COPILOT_PROGRESS_BAR: "1",
    CMUX_COPILOT_WORKSPACE_CARD: "1",
  });

  await controller.userPrompt("prompt received");
  await controller.skillInvoked({ name: "cmux" });
  calls.length = 0;
  await controller.clearStatus();

  assert(calls.some((call) => call.join(" ") === "cmux clear-status copilot-surface-1"));
  assert(calls.some((call) => call.join(" ") === "cmux clear-progress"));
  assertClearsWorkspaceDescription(calls);
});

test("keeps context out of the workspace card when progress owns context", async () => {
  const calls = [];
  const controller = createCmuxStatusController({
    env: {
      CMUX_WORKSPACE_ID: "workspace-1",
      CMUX_SURFACE_ID: "surface-1",
      CMUX_COPILOT_CONTEXT_PROGRESS: "1",
      CMUX_COPILOT_PROGRESS_BAR: "1",
      CMUX_COPILOT_WORKSPACE_CARD: "1",
    },
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
  assert(workspaceDescriptions(calls).some((description) => description.includes("Tools invoked: 2")));
  assert(workspaceDescriptions(calls).some((description) => description.includes("Skills: cmux")));
  calls.length = 0;
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux set-progress 0.21 --label ✅ Context 21% (42k/200k, 25 msgs)"));
  assert(!calls.some((call) => call[1] === "workspace-action" && call[3] === "set-description"));
  assert(!calls.some((call) => call[1] === "sidebar-state"));
});

test("shows context on the workspace card when context progress is disabled", async () => {
  const { controller, calls } = createCardRecorder({
    CMUX_WORKSPACE_ID: "workspace-1",
    CMUX_COPILOT_CONTEXT_PROGRESS: "0",
  });

  await controller.contextUsage({ currentTokens: 42_000, tokenLimit: 200_000, messagesLength: 25 });

  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🟢 Context 21% (42k/200k, 25 msgs)"));
});

test("allows workspace detail lines to be disabled independently", async () => {
  const { controller, calls } = createCardRecorder({
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
  const { controller, calls } = createCardRecorder();

  await controller.skillInvoked({ name: "cmux" });
  await controller.skillInvoked({ name: "worktree-arena" });
  await controller.skillInvoked({ name: "autoreview" });
  await controller.skillInvoked({ name: "crabbox" });
  await controller.subagentStarted({ toolCallId: "a", agentDisplayName: "Alpha" });
  await controller.subagentStarted({ toolCallId: "b", agentDisplayName: "Beta" });
  await controller.subagentStarted({ toolCallId: "c", agentDisplayName: "Gamma" });

  assert(calls.some((call) => call[1] === "set-status" && call[2] === "copilot-surface-1"));
  assert(workspaceDescriptions(calls).some((description) => description.includes("Skills: cmux, worktree-arena, autoreview, crabbox")));
  assert(!calls.some((call) => call.some((part) => String(part).includes("...") || String(part).includes("…"))));
});

test("tracks compaction count without changing done status", async () => {
  const { controller, calls } = createCardRecorder();

  await controller.compactionStarted({ conversationTokens: 180_000 });
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action clear-description"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level info --source copilot-cmux-status -- compaction started at 180k conversation tokens"));

  calls.length = 0;
  await controller.compactionCompleted({ success: true, tokensRemoved: 75_000 });
  await controller.done();

  assert(calls.some((call) => call.join(" ") === "cmux log --level success --source copilot-cmux-status -- compaction complete: 1 compaction, 75k tokens removed"));
  assert(calls.some((call) => call[1] === "set-status" && call[2] === "copilot-surface-1"));
  assert(calls.some((call) => call.join(" ") === "cmux workspace-action --action set-description --description 🧹 Compactions: 1"));
  assert(calls.some((call) => call.join(" ") === "cmux notify --title Copilot is done --body 🧹 Compactions: 1"));
});

test("marks failed compactions as needing attention", async () => {
  const { controller, calls } = createRecorder();

  await controller.compactionStarted();
  calls.length = 0;
  await controller.compactionCompleted({ success: false, error: "summary failed" });
  await controller.done();

  assert(calls.some((call) => call[1] === "set-status" && call[2] === "copilot-surface-1"));
  assert(calls.some((call) => call.join(" ") === "cmux log --level error --source copilot-cmux-status -- compaction failed: summary failed"));
  assert(calls.some((call) => call[1] === "set-status" && call[2] === "copilot-surface-1"));
});

test("logs raw events when debug mode is enabled", async () => {
  const { controller, calls } = createRecorder({ CMUX_WORKSPACE_ID: "workspace-1", CMUX_COPILOT_DEBUG: "1" });

  await controller.debugEvent("permission.requested");

  assert.deepEqual(calls, [
    ["cmux", "log", "--level", "info", "--source", "copilot-cmux-status", "--", "event: permission.requested"],
  ]);
});

test("can opt in to workspace title prefixes", async () => {
  const calls = [];
  const controller = createCmuxStatusController({
    env: { CMUX_WORKSPACE_ID: "workspace-1" },
    elapsedIntervalMs: 0,
    pulseIntervalMs: 0,
    progressClearDelayMs: 0,
    workspaceTitle: true,
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
