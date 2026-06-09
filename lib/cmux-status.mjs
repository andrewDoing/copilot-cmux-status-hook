import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCmuxSurfaceApplicator } from "./cmux-surfaces.mjs";
import { renderPlan } from "./render-plan.mjs";
import {
  compactionCompleteLog,
  compactionStartLog,
  createTurnStats,
  currentStatusLabel,
  describePermission,
  describeToolActivity,
  doneLabel,
  formatAic,
  formatSubagentSummary,
  formatTokenCount,
  goalFromMessage,
  humanizeToolName,
  normalizeAiCreditCost,
  normalizeContextUsage,
  normalizeSkillName,
  skillInvokedLog,
  skillNamesFromContext,
  stripStatusBadge,
  usageCallId,
  visibleIdleLabel,
  workingLabel,
} from "./status-formatters.mjs";

export { renderPlan } from "./render-plan.mjs";
export {
  formatTokenCount,
  humanizeToolName,
  normalizeContextUsage,
} from "./status-formatters.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULTS = {
  statusKey: "copilot-cli",
  source: "copilot-cmux-status",
  notifyOnDone: true,
  notifyOnError: true,
  contextProgress: true,
  workspaceCard: false,
  workspaceTitle: true,
  lifecycleStatus: false,
  showAic: true,
  showCompactions: true,
  showContext: true,
  showElapsed: true,
  showGoal: true,
  showPermissions: true,
  showSkills: true,
  showSubagents: true,
  showToolActivity: true,
  clearLogOnStartup: true,
  clearOnStartup: true,
  logBackgroundTasks: false,
  logLifecycle: false,
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
    lifecycleStatus: booleanFromEnv(env.CMUX_COPILOT_LIFECYCLE_STATUS, DEFAULTS.lifecycleStatus),
    showAic: booleanFromEnv(env.CMUX_COPILOT_SHOW_AIC, DEFAULTS.showAic),
    showCompactions: booleanFromEnv(env.CMUX_COPILOT_SHOW_COMPACTIONS, DEFAULTS.showCompactions),
    showContext: booleanFromEnv(env.CMUX_COPILOT_SHOW_CONTEXT, DEFAULTS.showContext),
    showElapsed: booleanFromEnv(env.CMUX_COPILOT_SHOW_ELAPSED, DEFAULTS.showElapsed),
    showGoal: booleanFromEnv(env.CMUX_COPILOT_SHOW_GOAL, DEFAULTS.showGoal),
    showPermissions: booleanFromEnv(env.CMUX_COPILOT_SHOW_PERMISSIONS, DEFAULTS.showPermissions),
    showSkills: booleanFromEnv(env.CMUX_COPILOT_SHOW_SKILLS, DEFAULTS.showSkills),
    showSubagents: booleanFromEnv(env.CMUX_COPILOT_SHOW_SUBAGENTS, DEFAULTS.showSubagents),
    showToolActivity: booleanFromEnv(env.CMUX_COPILOT_SHOW_TOOL_ACTIVITY, DEFAULTS.showToolActivity),
    clearLogOnStartup: booleanFromEnv(env.CMUX_COPILOT_CLEAR_LOG_ON_START, DEFAULTS.clearLogOnStartup),
    clearOnStartup: booleanFromEnv(env.CMUX_COPILOT_CLEAR_ON_START, DEFAULTS.clearOnStartup),
    logBackgroundTasks: booleanFromEnv(env.CMUX_COPILOT_LOG_BACKGROUND_TASKS, DEFAULTS.logBackgroundTasks),
    logLifecycle: booleanFromEnv(env.CMUX_COPILOT_LOG_LIFECYCLE, DEFAULTS.logLifecycle),
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

  const surfaces = createCmuxSurfaceApplicator({ config, cmux });

  function clearProgressLater() {
    if (clearProgressTimer) timers.clearTimeout(clearProgressTimer);
    if (config.progressClearDelayMs <= 0) {
      void surfaces.applyClearProgress();
      return;
    }
    clearProgressTimer = timers.setTimeout(() => {
      clearProgressTimer = undefined;
      void surfaces.applyClearProgress();
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
      void surfaces.applyRenderPlan({ progress: { value: progress } });
    }, config.pulseIntervalMs);
  }

  async function clearStartupSurfaces() {
    if (!config.clearOnStartup) return;
    if (clearProgressTimer) {
      timers.clearTimeout(clearProgressTimer);
      clearProgressTimer = undefined;
    }
    await surfaces.clearStartupSurfaces();
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
    await surfaces.applyRenderPlan(plan);
    return plan;
  }

  async function log(level, message) {
    await cmux(["log", "--level", level, "--source", config.source, "--", message]);
  }

  async function logLifecycle(level, message, options = {}) {
    if (!config.logLifecycle || options.log === false) return;
    await log(level, message);
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

  async function applyWorking(detail, { reset = false, progressLabel } = {}) {
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
    const plan = await renderVisibleState(label, { fallbackProgress: { value: progress, label: progressLabel } });
    await logLifecycle("info", label);
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

    async startupReady(label = "✅ Ready") {
      await clearStartupSurfaces();
      await this.ready(label, { log: false });
    },

    async ready(label = "✅ Ready", options = {}) {
      state = "idle";
      stopPulse();
      stopElapsedTimer();
      await renderVisibleState(label);
      await logLifecycle("success", label, options);
    },

    async userPrompt(detail = "prompt received") {
      await applyWorking(detail, { reset: true, progressLabel: workingLabel(detail) });
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
      const plan = await renderVisibleState(label, { fallbackProgress: { value: 1 } });
      await logLifecycle(aborted ? "warning" : "success", label);
      if (!aborted && !attentionActive && config.notifyOnDone) {
        await notify("Copilot is done", plan.notificationBody);
      }
      if (!plan.contextProgressActive) clearProgressLater();
    },

    async error(message) {
      state = "error";
      attention(message);
      stopPulse();
      stopElapsedTimer();
      const label = "🔴 Needs attention";
      const plan = await renderVisibleState(label, { fallbackProgress: { value: 1 } });
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
      const plan = await renderVisibleState(label, { fallbackProgress: { value: progress } });
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
      await renderVisibleState(label, { progress: { value: 1 } });
      await logLifecycle("warning", label);
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
      if (!config.logBackgroundTasks) return;
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

function numberFromEnv(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function booleanFromEnv(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return value !== "0";
}
