import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const COLORS = {
  ready: "#196F3D",
  working: "#B26A00",
  done: "#196F3D",
  stopped: "#6E6E6E",
  error: "#B00020",
  warning: "#B26A00",
};

export const DEFAULTS = {
  statusKey: "copilot-cli",
  source: "copilot-cmux-status",
  notifyOnDone: true,
  notifyOnError: true,
  contextProgress: true,
  workspaceCard: true,
  workspaceTitle: true,
  showAic: true,
  showCompactions: true,
  showContext: true,
  showElapsed: true,
  showGoal: true,
  showPermissions: true,
  showSkills: true,
  showSubagents: true,
  showToolActivity: true,
  debug: false,
  elapsedIntervalMs: 15000,
  pulseIntervalMs: 1200,
  progressClearDelayMs: 4000,
  progressMin: 0.12,
  progressMax: 0.92,
  progressStep: 0.08,
  contextWarningTokens: 100_000,
  contextCriticalRatio: 0.5,
};

export function createCmuxStatusController(options = {}) {
  const env = options.env || process.env;
  const config = {
    ...DEFAULTS,
    statusKey: env.CMUX_COPILOT_STATUS_KEY || DEFAULTS.statusKey,
    source: env.CMUX_COPILOT_LOG_SOURCE || DEFAULTS.source,
    notifyOnDone: booleanFromEnv(env.CMUX_COPILOT_NOTIFY_DONE, DEFAULTS.notifyOnDone),
    notifyOnError: booleanFromEnv(env.CMUX_COPILOT_NOTIFY_ERROR, DEFAULTS.notifyOnError),
    contextProgress: booleanFromEnv(env.CMUX_COPILOT_CONTEXT_PROGRESS, DEFAULTS.contextProgress),
    workspaceCard: booleanFromEnv(env.CMUX_COPILOT_WORKSPACE_CARD, DEFAULTS.workspaceCard),
    workspaceTitle: booleanFromEnv(env.CMUX_COPILOT_WORKSPACE_TITLE, DEFAULTS.workspaceTitle),
    showAic: booleanFromEnv(env.CMUX_COPILOT_SHOW_AIC, DEFAULTS.showAic),
    showCompactions: booleanFromEnv(env.CMUX_COPILOT_SHOW_COMPACTIONS, DEFAULTS.showCompactions),
    showContext: booleanFromEnv(env.CMUX_COPILOT_SHOW_CONTEXT, DEFAULTS.showContext),
    showElapsed: booleanFromEnv(env.CMUX_COPILOT_SHOW_ELAPSED, DEFAULTS.showElapsed),
    showGoal: booleanFromEnv(env.CMUX_COPILOT_SHOW_GOAL, DEFAULTS.showGoal),
    showPermissions: booleanFromEnv(env.CMUX_COPILOT_SHOW_PERMISSIONS, DEFAULTS.showPermissions),
    showSkills: booleanFromEnv(env.CMUX_COPILOT_SHOW_SKILLS, DEFAULTS.showSkills),
    showSubagents: booleanFromEnv(env.CMUX_COPILOT_SHOW_SUBAGENTS, DEFAULTS.showSubagents),
    showToolActivity: booleanFromEnv(env.CMUX_COPILOT_SHOW_TOOL_ACTIVITY, DEFAULTS.showToolActivity),
    debug: env.CMUX_COPILOT_DEBUG === "1",
    elapsedIntervalMs: numberFromEnv(env.CMUX_COPILOT_ELAPSED_MS, DEFAULTS.elapsedIntervalMs),
    contextWarningTokens: numberFromEnv(
      env.CMUX_COPILOT_CONTEXT_WARNING_TOKENS,
      DEFAULTS.contextWarningTokens,
    ),
    contextCriticalRatio: numberFromEnv(
      env.CMUX_COPILOT_CONTEXT_CRITICAL_RATIO,
      DEFAULTS.contextCriticalRatio,
    ),
    pulseIntervalMs: numberFromEnv(env.CMUX_COPILOT_PULSE_MS, DEFAULTS.pulseIntervalMs),
    progressClearDelayMs: numberFromEnv(
      env.CMUX_COPILOT_CLEAR_PROGRESS_MS,
      DEFAULTS.progressClearDelayMs,
    ),
    ...options,
  };
  const run = options.run || ((command, args) => execFileAsync(command, args));
  const timers = options.timers || globalThis;
  const enabled = Boolean(env.CMUX_WORKSPACE_ID);
  let state = "idle";
  let progress = config.progressMin;
  let pulseTimer;
  let clearProgressTimer;
  let elapsedTimer;
  let contextUsage;
  let originalWorkspaceTitle;
  let turnStartedAt;
  let currentActivity = "waiting";
  let attentionActive = false;
  let attentionMessage = "";
  let permissionActive = false;
  let permissionMessage = "";
  let pendingPermissions = new Set();
  let activeSubagents = new Map();
  let compactionActive = false;
  let compactionCount = 0;
  let goal;
  let aiCreditsUsed = 0;
  let usageCallIds = new Set();
  let turnStats = createTurnStats();
  let reportedCmuxFailure = false;
  const applied = {
    progress: undefined,
    status: undefined,
    workspaceColor: undefined,
    workspaceDescription: undefined,
    workspaceTitle: undefined,
  };

  async function cmux(args) {
    if (!enabled) return false;
    try {
      await run("cmux", args);
      return true;
    } catch (error) {
      reportCmuxFailure(error);
      return false;
    }
  }

  async function cmuxOutput(args) {
    if (!enabled) return "";
    try {
      const result = await run("cmux", args);
      return typeof result?.stdout === "string" ? result.stdout : "";
    } catch (error) {
      reportCmuxFailure(error);
      return "";
    }
  }

  function reportCmuxFailure(error) {
    if (reportedCmuxFailure) return;
    reportedCmuxFailure = true;
    config.onError?.(`cmux command failed: ${error.message}`);
  }

  async function applyClearProgress() {
    applied.progress = undefined;
    await cmux(["clear-progress"]);
  }

  function clearProgressLater() {
    if (clearProgressTimer) timers.clearTimeout(clearProgressTimer);
    if (config.progressClearDelayMs <= 0) {
      void applyClearProgress();
      return;
    }
    clearProgressTimer = timers.setTimeout(() => {
      clearProgressTimer = undefined;
      void applyClearProgress();
    }, config.progressClearDelayMs);
  }

  function stopPulse() {
    if (pulseTimer) {
      timers.clearInterval(pulseTimer);
      pulseTimer = undefined;
    }
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      timers.clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
  }

  function startPulse(label) {
    stopPulse();
    if (config.pulseIntervalMs <= 0) return;
    pulseTimer = timers.setInterval(() => {
      if (state !== "working") return;
      progress += config.progressStep;
      if (progress > config.progressMax) progress = config.progressMin;
      void applyProgress({ value: progress, label });
    }, config.pulseIntervalMs);
  }

  async function applyStatus(status) {
    if (!status) return;
    if (
      applied.status?.key === status.key &&
      applied.status?.value === status.value &&
      applied.status?.icon === status.icon &&
      applied.status?.color === status.color
    ) {
      return;
    }
    applied.status = { ...status };
    await cmux(["set-status", status.key, status.value, "--icon", status.icon, "--color", status.color]);
  }

  async function applyProgress(progressPlan) {
    if (!progressPlan) return;
    const value = progressPlan.value.toFixed(2);
    if (applied.progress?.value === value && applied.progress?.label === progressPlan.label) return;
    applied.progress = { value, label: progressPlan.label };
    await cmux(["set-progress", value, "--label", progressPlan.label]);
  }

  async function applyWorkspaceDescription(description) {
    if (!config.workspaceCard) return;
    if (applied.workspaceDescription === description) return;
    applied.workspaceDescription = description;
    await cmux(["workspace-action", "--action", "set-description", "--description", description]);
  }

  async function applyWorkspaceColor(color) {
    if (!color || (!config.workspaceCard && !config.workspaceTitle)) return;
    if (applied.workspaceColor === color) return;
    applied.workspaceColor = color;
    await cmux(["workspace-action", "--action", "set-color", "--color", color]);
  }

  async function applyWorkspaceTitle(title) {
    if (!title || !config.workspaceTitle) return;
    if (applied.workspaceTitle === title) return;
    applied.workspaceTitle = title;
    await cmux(["workspace-action", "--action", "rename", "--title", title]);
  }

  async function applyRenderPlan(plan) {
    await applyStatus(plan.status);
    await applyProgress(plan.progress);
    await applyWorkspaceDescription(plan.workspaceDescription);
    await applyWorkspaceTitle(plan.workspaceTitle);
    await applyWorkspaceColor(plan.workspaceColor);
  }

  async function getOriginalWorkspaceTitle() {
    if (!config.workspaceTitle) return undefined;
    if (originalWorkspaceTitle !== undefined) return originalWorkspaceTitle;

    const treeJson = await cmuxOutput(["tree", "--json"]);
    if (!treeJson) return undefined;
    try {
      const tree = JSON.parse(treeJson);
      const activeWorkspace = tree?.active?.workspace_ref;
      for (const window of tree?.windows || []) {
        for (const workspace of window?.workspaces || []) {
          if (workspace?.ref === activeWorkspace || workspace?.selected === true) {
            originalWorkspaceTitle = stripStatusBadge(String(workspace?.title || "Copilot"));
            return originalWorkspaceTitle;
          }
        }
      }
    } catch (error) {
      config.onError?.(`cmux tree parse failed: ${error.message}`);
    }
    return undefined;
  }

  function snapshot() {
    return {
      activeSubagents,
      aiCreditsUsed,
      attentionActive,
      attentionMessage,
      compactionActive,
      compactionCount,
      contextUsage,
      currentActivity,
      goal,
      permissionActive,
      permissionMessage,
      progress,
      state,
      turnStartedAt,
      turnStats,
    };
  }

  async function renderVisibleState(label, options = {}) {
    const baseTitle = config.workspaceTitle ? await getOriginalWorkspaceTitle() : undefined;
    const plan = renderPlan(snapshot(), config, label, { ...options, baseTitle });
    if (plan.contextProgressActive) {
      stopPulse();
      if (clearProgressTimer) {
        timers.clearTimeout(clearProgressTimer);
        clearProgressTimer = undefined;
      }
    }
    await applyRenderPlan(plan);
    return plan;
  }

  async function log(level, message) {
    await cmux(["log", "--level", level, "--source", config.source, "--", message]);
  }

  async function notify(title, body) {
    await cmux(["notify", "--title", title, "--body", body]);
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    turnStartedAt = Date.now();
    if (config.elapsedIntervalMs <= 0) return;
    elapsedTimer = timers.setInterval(() => {
      if (state !== "working") return;
      const label = permissionActive ? permissionMessage : workingLabel(currentActivity);
      void renderVisibleState(label);
    }, config.elapsedIntervalMs);
  }

  function resetAttention() {
    attentionActive = false;
    attentionMessage = "";
    permissionActive = false;
    permissionMessage = "";
    pendingPermissions = new Set();
  }

  async function applyWorking(detail, { reset = false } = {}) {
    if (reset) {
      resetAttention();
      turnStats = createTurnStats();
      startElapsedTimer();
    } else if (!turnStartedAt) {
      startElapsedTimer();
    }

    state = "working";
    currentActivity = detail;
    progress = config.progressMin;
    if (clearProgressTimer) {
      timers.clearTimeout(clearProgressTimer);
      clearProgressTimer = undefined;
    }
    const label = workingLabel(detail);
    const plan = await renderVisibleState(label, { fallbackProgress: { value: progress, label } });
    await log("info", label);
    if (!plan.contextProgressActive) startPulse(label);
  }

  function attention(message) {
    attentionActive = true;
    attentionMessage = message;
  }

  return {
    isEnabled() {
      return enabled;
    },

    async ready(label = "✅ Ready") {
      state = "idle";
      stopPulse();
      stopElapsedTimer();
      await renderVisibleState(label);
      await log("success", label);
    },

    async userPrompt(detail = "prompt received") {
      await applyWorking(detail, { reset: true });
    },

    async startWorking(detail = "working") {
      await applyWorking(detail);
    },

    async toolStart(toolName, args) {
      turnStats.toolCount += 1;
      const name = humanizeToolName(toolName);
      turnStats.tools.set(name, (turnStats.tools.get(name) || 0) + 1);
      await this.startWorking(describeToolActivity(toolName, args));
    },

    async toolComplete(toolName, success) {
      if (state !== "working") return;
      const name = humanizeToolName(toolName);
      const level = success ? "success" : "error";
      const marker = success ? "finished" : "failed";
      await log(level, `${name} ${marker}`);
      if (!success) {
        turnStats.failedTools += 1;
        attention(`${name} failed`);
        const label = `🔴 ${name} failed`;
        await renderVisibleState(label);
      }
    },

    async done({ aborted = false } = {}) {
      state = aborted ? "stopped" : "idle";
      stopPulse();
      stopElapsedTimer();
      const label = doneLabel({ aborted, attentionActive, attentionMessage, compactionCount, turnStats });
      const plan = await renderVisibleState(label, { fallbackProgress: { value: 1, label } });
      await log(aborted ? "warning" : "success", label);
      if (!aborted && !attentionActive && config.notifyOnDone) {
        await notify("Copilot is done", plan.workspaceDescription || label);
      }
      if (!plan.contextProgressActive) clearProgressLater();
    },

    async error(message) {
      state = "error";
      attention(message);
      stopPulse();
      stopElapsedTimer();
      const label = "🔴 Needs attention";
      const plan = await renderVisibleState(label, { fallbackProgress: { value: 1, label } });
      await log("error", `Copilot error: ${message}`);
      if (config.notifyOnError) await notify("Copilot needs attention", message);
      if (!plan.contextProgressActive) clearProgressLater();
    },

    async contextUsage(data) {
      const usage = normalizeContextUsage(data);
      if (!usage) return;
      contextUsage = usage;
      const label = state === "working" ? workingLabel(currentActivity) : visibleIdleLabel();
      await renderVisibleState(label);
    },

    async assistantUsage(data = {}) {
      const cost = normalizeAiCreditCost(data?.cost);
      if (cost === undefined) return;
      const callId = usageCallId(data);
      if (callId) {
        if (usageCallIds.has(callId)) return;
        usageCallIds.add(callId);
      }
      aiCreditsUsed += cost;
      await renderVisibleState(currentStatusLabel({
        attentionActive,
        attentionMessage,
        compactionCount,
        currentActivity,
        permissionActive,
        permissionMessage,
        state,
        turnStats,
      }));
      if (config.debug) {
        await log("info", `aic.total=${formatAic(aiCreditsUsed)} aic.delta=${formatAic(cost)} model=${data?.model || "model"}`);
      }
    },

    async skillInvoked(data = {}) {
      const name = normalizeSkillName(data?.name);
      if (!name) return;
      turnStats.skills.set(name, (turnStats.skills.get(name) || 0) + 1);
      await renderVisibleState(currentStatusLabel({
        attentionActive,
        attentionMessage,
        compactionCount,
        currentActivity,
        permissionActive,
        permissionMessage,
        state,
        turnStats,
      }));
      await log("info", skillInvokedLog(name, data));
    },

    async skillContextMessage(content) {
      const names = skillNamesFromContext(content);
      for (const name of names) {
        await this.skillInvoked({ name, trigger: "context-load" });
      }
    },

    async goalModeMessage(content) {
      const parsedGoal = goalFromMessage(content);
      if (!parsedGoal) return;
      goal = parsedGoal;
      await renderVisibleState(currentStatusLabel({
        attentionActive,
        attentionMessage,
        compactionCount,
        currentActivity,
        permissionActive,
        permissionMessage,
        state,
        turnStats,
      }));
    },

    async compactionStarted(data = {}) {
      if (!turnStartedAt) startElapsedTimer();
      compactionActive = true;
      state = "working";
      currentActivity = "compacting context";
      const label = workingLabel(currentActivity);
      const plan = await renderVisibleState(label, { fallbackProgress: { value: progress, label } });
      await log("info", compactionStartLog(data));
      if (!plan.contextProgressActive) startPulse(label);
    },

    async compactionCompleted(data = {}) {
      compactionActive = false;
      if (data?.success === false) {
        attention("compaction failed");
        const label = `🔴 compaction failed`;
        await renderVisibleState(label);
        await log("error", `compaction failed: ${data?.error || "unknown error"}`);
        return;
      }

      compactionCount += 1;
      currentActivity = state === "working" ? "continuing after compaction" : currentActivity;
      const label = state === "working" ? workingLabel(currentActivity) : visibleIdleLabel();
      await renderVisibleState(label);
      await log("success", compactionCompleteLog(data, compactionCount));
    },

    async assistantIntent(intent) {
      if (!intent) return;
      await this.startWorking(intent);
    },

    async permissionRequested(data) {
      if (!turnStartedAt) startElapsedTimer();
      const requestId = String(data?.requestId || `permission-${pendingPermissions.size + 1}`);
      pendingPermissions.add(requestId);
      permissionActive = true;
      permissionMessage = `🚨 APPROVAL NEEDED: ${describePermission(data?.permissionRequest)}`;
      state = "working";
      const label = permissionMessage;
      await renderVisibleState(label, { progress: { value: 1, label } });
      await log("warning", label);
      if (config.notifyOnError) await notify("Copilot needs approval", permissionMessage);
    },

    async permissionCompleted(data) {
      const requestId = String(data?.requestId || "");
      if (requestId) pendingPermissions.delete(requestId);
      if (pendingPermissions.size === 0) {
        permissionActive = false;
        permissionMessage = "";
      }
      if (state === "working") await renderVisibleState(workingLabel(currentActivity));
    },

    async subagentStarted(data) {
      const key = String(data?.toolCallId || data?.agentName || `subagent-${activeSubagents.size + 1}`);
      const name = String(data?.agentDisplayName || data?.agentName || "subagent");
      activeSubagents.set(key, name);
      await this.startWorking(formatSubagentSummary(activeSubagents));
    },

    async subagentCompleted(data) {
      const key = String(data?.toolCallId || data?.agentName || "");
      const name = String(data?.agentDisplayName || data?.agentName || "subagent");
      if (key) activeSubagents.delete(key);
      turnStats.completedSubagents += 1;
      await log("success", `${name} subagent done`);
      if (activeSubagents.size > 0) await this.startWorking(formatSubagentSummary(activeSubagents));
    },

    async subagentFailed(data) {
      const key = String(data?.toolCallId || data?.agentName || "");
      const name = String(data?.agentDisplayName || data?.agentName || "subagent");
      if (key) activeSubagents.delete(key);
      turnStats.failedSubagents += 1;
      attention(`${name} subagent failed`);
      const label = `🔴 ${name} subagent failed`;
      await renderVisibleState(label);
      await log("error", `${name} subagent failed: ${data?.error || "unknown error"}`);
    },

    async backgroundTasksChanged() {
      await log("info", "Background tasks changed");
    },

    async debugEvent(eventType) {
      if (!config.debug) return;
      await log("info", `event: ${eventType}`);
    },

    async shutdown(data = {}) {
      stopPulse();
      stopElapsedTimer();
      if (data.shutdownType === "error") {
        await this.error(data.errorReason || "The Copilot session ended with an error.");
        return;
      }
      await this.done();
    },

    dispose() {
      stopPulse();
      stopElapsedTimer();
      if (clearProgressTimer) {
        timers.clearTimeout(clearProgressTimer);
        clearProgressTimer = undefined;
      }
    },
  };
}

function createTurnStats() {
  return {
    toolCount: 0,
    failedTools: 0,
    completedSubagents: 0,
    failedSubagents: 0,
    skills: new Map(),
    tools: new Map(),
  };
}

export function renderPlan(state, config = DEFAULTS, label = currentStatusLabel(state), options = {}) {
  const visual = stateVisualFor(state, config);
  const workspaceColor = options.fallbackColor || visual.color;
  const workspaceTitle = options.baseTitle ? `${visual.badge} ${options.baseTitle}` : undefined;
  let progressPlan = options.progress;
  let contextProgressActive = false;

  if (!progressPlan && contextProgressOwnsContext(config, state.contextUsage)) {
    contextProgressActive = true;
    progressPlan = {
      value: state.contextUsage.ratio,
      label: state.state === "working" ? `🤖 ${state.contextUsage.label}` : `✅ ${state.contextUsage.label}`,
    };
  }

  if (!progressPlan && options.fallbackProgress) {
    progressPlan = options.fallbackProgress;
  }

  const status = {
    key: config.statusKey,
    value: label,
    icon: visual.icon,
    color: visual.statusColor,
  };
  const workspaceDescription = cardDescriptionFor(state, config, label, {
    progressLabel: progressPlan?.label,
    statusLabel: status.value,
    titleLabel: workspaceTitle,
    now: options.now,
  });

  return {
    contextProgressActive,
    progress: progressPlan,
    status,
    workspaceColor,
    workspaceDescription,
    workspaceTitle,
  };
}

function stateVisualFor(state, config) {
  if (state.permissionActive) {
    return { badge: "🚨", color: "Red", statusColor: COLORS.error, icon: "exclamationmark.triangle" };
  }
  if (state.attentionActive) return { badge: "🔴", color: "Red", statusColor: COLORS.error, icon: "xmark" };
  if (state.state === "working") {
    const severity = contextSeverityFor(state.contextUsage, config);
    return {
      badge: "🤖",
      color: severity.color === "Green" ? "Amber" : severity.color,
      statusColor: severity.statusColor === COLORS.done ? COLORS.working : severity.statusColor,
      icon: "gear",
    };
  }
  if (state.state === "error") return { badge: "🔴", color: "Red", statusColor: COLORS.error, icon: "xmark" };
  if (state.state === "stopped") return { badge: "⚫", color: "Charcoal", statusColor: COLORS.stopped, icon: "xmark" };
  return { badge: "✅", color: "Green", statusColor: COLORS.done, icon: "checkmark" };
}

function contextSeverityFor(contextUsage, config) {
  if (!contextUsage) return { badge: "🟢", color: "Green", statusColor: COLORS.done };
  if (contextUsage.ratio >= config.contextCriticalRatio) {
    return { badge: "🔴", color: "Red", statusColor: COLORS.error };
  }
  if (contextUsage.currentTokens >= config.contextWarningTokens) {
    return { badge: "🟡", color: "Amber", statusColor: COLORS.warning };
  }
  return { badge: "🟢", color: "Green", statusColor: COLORS.done };
}

function cardDescriptionFor(state, config, label, labels = {}) {
  const lines = [];
  if (config.showPermissions && state.permissionActive && state.permissionMessage && state.permissionMessage !== label) {
    lines.push(state.permissionMessage);
  }
  if (config.showSubagents && state.activeSubagents.size > 0) {
    lines.push(formatSubagentSummary(state.activeSubagents));
  }
  const goal = config.showGoal ? goalLabel(state.goal) : "";
  if (goal) lines.push(goal);
  const turnActivity = turnActivitySummary(state.turnStats, config);
  if (turnActivity) lines.push(turnActivity);
  const skills = config.showSkills ? skillSummary(state.turnStats.skills) : "";
  if (skills) lines.push(skills);
  if (config.showContext && state.contextUsage && !contextProgressOwnsContext(config, state.contextUsage)) {
    lines.push(`${contextSeverityFor(state.contextUsage, config).badge} ${state.contextUsage.label}`);
  }
  if (config.showAic && state.aiCreditsUsed > 0) lines.push(`💳 AIC used: ${formatAic(state.aiCreditsUsed)}`);
  const compaction = config.showCompactions ? compactionLabel(state.compactionActive, state.compactionCount) : "";
  if (compaction) lines.push(compaction);
  const elapsed = elapsedLabelFor(state, config, labels.now);
  if (config.showElapsed && state.state === "working" && elapsed) lines.push(elapsed);
  return dedupeWorkspaceLines(lines, [label, labels.statusLabel, labels.progressLabel, labels.titleLabel]);
}

function elapsedLabelFor(state, config, now = Date.now()) {
  if (config.elapsedIntervalMs <= 0) return "";
  if (!state.turnStartedAt) return "";
  return `Elapsed ${formatDuration(now - state.turnStartedAt)}`;
}

function workingLabel(detail) {
  return `🤖 ${detail}`;
}

function visibleIdleLabel() {
  return "✅ Done";
}

function doneLabel({ aborted, attentionActive, attentionMessage }) {
  if (aborted) return "⚫ Stopped - waiting";
  if (attentionActive) return `🔴 Needs attention: ${attentionMessage || "check the last error"}`;
  return visibleIdleLabel();
}

function currentStatusLabel({
  attentionActive,
  attentionMessage,
  compactionCount,
  currentActivity,
  permissionActive,
  permissionMessage,
  state,
  turnStats,
}) {
  if (permissionActive) return permissionMessage;
  if (state === "working") return workingLabel(currentActivity);
  if (state === "stopped") return doneLabel({ aborted: true, attentionActive, attentionMessage, compactionCount, turnStats });
  return doneLabel({ aborted: false, attentionActive, attentionMessage, compactionCount, turnStats });
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

function describeToolActivity(toolName, args = {}) {
  const name = humanizeToolName(toolName);
  if (toolName === "bash") return describeShellCommand(String(args?.command || ""));
  if (toolName === "apply_patch" || toolName === "edit" || toolName === "create") return "editing files";
  if (toolName === "rg" || toolName === "glob") return "searching code";
  if (toolName === "view") return "reading files";
  if (toolName === "ask_user") return "waiting for user input";
  if (toolName === "task") return "running subagent";
  return `running ${name}`;
}

function describeShellCommand(command) {
  if (/\b(test|vitest|jest|pytest|go test|cargo test)\b/i.test(command)) return "running tests";
  if (/\b(lint|eslint|ruff|shellcheck)\b/i.test(command)) return "running lint";
  if (/\b(build|tsc|make)\b/i.test(command)) return "running build";
  if (/\b(git)\b/i.test(command)) return "checking git";
  if (/\b(npm|pnpm|yarn|uv|pip|go)\b.*\b(install|add)\b/i.test(command)) return "installing dependencies";
  return "running shell command";
}

function describePermission(permissionRequest = {}) {
  const kind = permissionRequest?.kind || "permission";
  if (kind === "shell") return `shell command ${shorten(permissionRequest.fullCommandText || "")}`;
  if (kind === "write") return "file write";
  if (kind === "read") return "file read";
  if (kind === "url") return "URL access";
  if (kind === "mcp") return "MCP tool";
  return kind;
}

function shorten(value, maxLength = 64) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function formatSubagentSummary(activeSubagents) {
  const names = [...activeSubagents.values()];
  if (names.length === 0) return "";
  if (names.length === 1) return `1 subagent running: ${names[0]}`;
  return `${names.length} subagents running: ${names.join(", ")}`;
}

function turnActivitySummary(turnStats, config = DEFAULTS) {
  const parts = [];
  if (config.showToolActivity && turnStats.toolCount > 0) {
    parts.push(`🛠 Tools invoked: ${turnStats.toolCount}`);
  }
  if (config.showSubagents && turnStats.completedSubagents > 0) {
    parts.push(`🤖 Subagents completed: ${turnStats.completedSubagents}`);
  }
  return parts.join("\n");
}

function skillSummary(skills) {
  const names = [...skills.keys()];
  if (names.length === 0) return "";
  return `🧰 Skills: ${names.join(", ")}`;
}

function normalizeSkillName(name) {
  return String(name || "").replace(/\s+/g, " ").trim();
}

function skillInvokedLog(name, data = {}) {
  const trigger = data?.trigger ? ` (${data.trigger})` : "";
  return `skill invoked: ${name}${trigger}`;
}

function skillNamesFromContext(content) {
  const text = String(content || "");
  const names = [];
  for (const match of text.matchAll(/<skill-context\s+[^>]*name=["']([^"']+)["'][^>]*>/g)) {
    const name = normalizeSkillName(match[1]);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function goalFromMessage(content) {
  const text = String(content || "");
  const marker = "The user set this explicit autopilot objective with /autopilot:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const afterMarker = text.slice(markerIndex + marker.length);
  const match = afterMarker.match(/\n\s*\n([\s\S]*?)(?:\n\s*\n(?:Work autonomously|<system_reminder>|$)|$)/);
  const title = shortenGoal(match?.[1] || "");
  if (!title) return undefined;
  return { active: true, title };
}

function goalLabel(goal) {
  if (!goal?.active || !goal.title) return "";
  return `🎯 Goal: ${goal.title}`;
}

function shortenGoal(value, maxLength = 96) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function dedupeWorkspaceLines(lines, statusLabels) {
  const seen = new Set(statusLabels.flatMap((label) => normalizedStatusKeys(label)));
  const output = [];
  for (const group of lines) {
    for (const line of String(group || "").split("\n")) {
      const keys = normalizedStatusKeys(line);
      if (keys.length === 0) continue;
      if (keys.some((key) => seen.has(key))) continue;
      keys.forEach((key) => seen.add(key));
      output.push(line);
    }
  }
  return output.join("\n");
}

function contextProgressOwnsContext(config, contextUsage) {
  return Boolean(config.contextProgress && contextUsage);
}

function normalizedStatusKeys(value) {
  const normalized = normalizeStatusText(value);
  if (!normalized) return [];
  const keys = [normalized];
  const withoutPrefix = normalized.replace(/^(working|done|needs attention|approval needed|stopped|ready)\s*[:.-]?\s*/, "");
  if (withoutPrefix && withoutPrefix !== normalized) keys.push(withoutPrefix);
  return keys;
}

function normalizeStatusText(value) {
  return String(value || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeAiCreditCost(cost) {
  const parsed = Number(cost);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function usageCallId(data = {}) {
  return data?.apiCallId || data?.providerCallId || data?.serviceRequestId || "";
}

function formatAic(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded.toFixed(2)).replace(/0$/, "");
}

function compactionLabel(active, count) {
  if (active) return count > 0 ? `🧹 Compacting context (${count} done)` : "🧹 Compacting context";
  if (count > 0) return `🧹 Compactions: ${count}`;
  return "";
}

function compactionStartLog(data = {}) {
  const tokens = Number(data?.conversationTokens);
  if (Number.isFinite(tokens) && tokens > 0) return `compaction started at ${formatTokenCount(tokens)} conversation tokens`;
  return "compaction started";
}

function compactionCompleteLog(data = {}, count) {
  const removed = Number(data?.tokensRemoved);
  const suffix = Number.isFinite(removed) && removed > 0 ? `, ${formatTokenCount(removed)} tokens removed` : "";
  return `compaction complete: ${count} ${plural(count, "compaction")}${suffix}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function stripStatusBadge(title) {
  return title.replace(/^(🤖|✅|🚨|🔴|🟡|🟢|⚫)\s+/, "");
}

export function humanizeToolName(toolName) {
  return String(toolName || "tool")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeContextUsage(data) {
  const currentTokens = Math.max(0, Number(data?.currentTokens));
  const tokenLimit = Number(data?.tokenLimit);
  if (!Number.isFinite(currentTokens) || !Number.isFinite(tokenLimit) || tokenLimit <= 0) {
    return undefined;
  }

  const messagesLength = Number(data?.messagesLength);
  const ratio = Math.min(Math.max(currentTokens / tokenLimit, 0), 1);
  const percent = Math.round(ratio * 100);
  const messageSuffix = Number.isFinite(messagesLength) ? `, ${messagesLength} msgs` : "";
  const label = `Context ${percent}% (${formatTokenCount(currentTokens)}/${formatTokenCount(tokenLimit)}${messageSuffix})`;

  return {
    currentTokens,
    tokenLimit,
    messagesLength: Number.isFinite(messagesLength) ? messagesLength : undefined,
    ratio,
    label,
  };
}

export function formatTokenCount(value) {
  const number = Math.max(0, Math.round(Number(value)));
  if (number >= 1_000_000) return `${trimDecimal(number / 1_000_000)}M`;
  if (number >= 1_000) return `${trimDecimal(number / 1_000)}k`;
  return String(number);
}

function trimDecimal(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

function numberFromEnv(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function booleanFromEnv(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return value !== "0";
}
