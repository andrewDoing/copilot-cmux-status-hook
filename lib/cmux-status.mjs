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

const DEFAULTS = {
  statusKey: "copilot-cli",
  source: "copilot-cmux-status",
  notifyOnDone: true,
  notifyOnError: true,
  contextProgress: true,
  workspaceCard: true,
  workspaceTitle: true,
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
    notifyOnDone: env.CMUX_COPILOT_NOTIFY_DONE !== "0",
    notifyOnError: env.CMUX_COPILOT_NOTIFY_ERROR !== "0",
    contextProgress: env.CMUX_COPILOT_CONTEXT_PROGRESS !== "0",
    workspaceCard: env.CMUX_COPILOT_WORKSPACE_CARD !== "0",
    workspaceTitle: env.CMUX_COPILOT_WORKSPACE_TITLE !== "0",
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

  function clearProgressLater() {
    if (clearProgressTimer) timers.clearTimeout(clearProgressTimer);
    if (config.progressClearDelayMs <= 0) {
      void cmux(["clear-progress"]);
      return;
    }
    clearProgressTimer = timers.setTimeout(() => {
      clearProgressTimer = undefined;
      void cmux(["clear-progress"]);
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
      void cmux(["set-progress", progress.toFixed(2), "--label", label]);
    }, config.pulseIntervalMs);
  }

  async function setStatus(value, icon, color) {
    await cmux(["set-status", config.statusKey, value, "--icon", icon, "--color", color]);
  }

  async function setProgress(value, label) {
    await cmux(["set-progress", value.toFixed(2), "--label", label]);
  }

  async function setWorkspaceCard(description, color) {
    if (!config.workspaceCard) return;
    await cmux(["workspace-action", "--action", "set-description", "--description", description]);
    await cmux(["workspace-action", "--action", "set-color", "--color", color]);
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

  async function setWorkspaceTitle(badge, colorName) {
    if (!config.workspaceTitle) return;
    const title = await getOriginalWorkspaceTitle();
    if (!title) return;
    await cmux(["workspace-action", "--action", "rename", "--title", `${badge} ${title}`]);
    if (colorName) await cmux(["workspace-action", "--action", "set-color", "--color", colorName]);
  }

  function contextSeverity() {
    if (!contextUsage) return { badge: "🟢", color: "Green", statusColor: COLORS.done };
    if (contextUsage.ratio >= config.contextCriticalRatio) {
      return { badge: "🔴", color: "Red", statusColor: COLORS.error };
    }
    if (contextUsage.currentTokens >= config.contextWarningTokens) {
      return { badge: "🟡", color: "Amber", statusColor: COLORS.warning };
    }
    return { badge: "🟢", color: "Green", statusColor: COLORS.done };
  }

  function stateVisual() {
    if (permissionActive) {
      return { badge: "🚨", color: "Red", statusColor: COLORS.error, icon: "exclamationmark.triangle" };
    }
    if (attentionActive) return { badge: "🔴", color: "Red", statusColor: COLORS.error, icon: "xmark" };
    if (state === "working") {
      const severity = contextSeverity();
      return {
        badge: "🤖",
        color: severity.color === "Green" ? "Amber" : severity.color,
        statusColor: severity.statusColor === COLORS.done ? COLORS.working : severity.statusColor,
        icon: "gear",
      };
    }
    if (state === "error") return { badge: "🔴", color: "Red", statusColor: COLORS.error, icon: "xmark" };
    if (state === "stopped") return { badge: "⚫", color: "Charcoal", statusColor: COLORS.stopped, icon: "xmark" };
    return { badge: "✅", color: "Green", statusColor: COLORS.done, icon: "checkmark" };
  }

  function cardDescription(label) {
    const lines = [label];
    if (permissionActive && permissionMessage && permissionMessage !== label) lines.push(permissionMessage);
    if (activeSubagents.size > 0) lines.push(formatSubagentSummary(activeSubagents));
    if (contextUsage) lines.push(`${contextSeverity().badge} ${contextUsage.label}`);
    const compaction = compactionLabel(compactionActive, compactionCount);
    if (compaction) lines.push(compaction);
    const elapsed = elapsedLabel();
    if (state === "working" && elapsed) lines.push(elapsed);
    return lines.join("\n");
  }

  async function renderContextProgress() {
    if (!config.contextProgress || !contextUsage) return false;
    stopPulse();
    if (clearProgressTimer) {
      timers.clearTimeout(clearProgressTimer);
      clearProgressTimer = undefined;
    }
    const label = state === "working" ? `🤖 ${contextUsage.label}` : `✅ ${contextUsage.label}`;
    await setProgress(contextUsage.ratio, label);
    return true;
  }

  async function updateVisibleState(label, fallbackColor) {
    const visual = stateVisual();
    const color = fallbackColor || visual.color;
    await setWorkspaceCard(cardDescription(label), color);
    await setWorkspaceTitle(visual.badge, color);
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
      void updateVisibleState(label);
    }, config.elapsedIntervalMs);
  }

  function elapsedLabel() {
    if (config.elapsedIntervalMs <= 0) return "";
    if (!turnStartedAt) return "";
    return `Elapsed ${formatDuration(Date.now() - turnStartedAt)}`;
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
    const visual = stateVisual();
    await setStatus(label, visual.icon, visual.statusColor);
    if (!(await renderContextProgress())) await setProgress(progress, label);
    await updateVisibleState(label);
    await log("info", label);
    if (!contextUsage || !config.contextProgress) startPulse(label);
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
      await setStatus(label, "checkmark", COLORS.ready);
      await renderContextProgress();
      await updateVisibleState(label);
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
        await setStatus(label, "xmark", COLORS.error);
        await updateVisibleState(label);
      }
    },

    async done({ aborted = false } = {}) {
      state = aborted ? "stopped" : "idle";
      stopPulse();
      stopElapsedTimer();
      const label = doneLabel({ aborted, attentionActive, attentionMessage, compactionCount, turnStats });
      const visual = stateVisual();
      const showedContext = await renderContextProgress();
      if (!showedContext) await setProgress(1, label);
      await setStatus(label, visual.icon, visual.statusColor);
      await updateVisibleState(label);
      await log(aborted ? "warning" : "success", label);
      if (!aborted && !attentionActive && config.notifyOnDone) {
        await notify("Copilot is done", label);
      }
      if (!showedContext) clearProgressLater();
    },

    async error(message) {
      state = "error";
      attention(message);
      stopPulse();
      stopElapsedTimer();
      const label = "🔴 Needs attention";
      const showedContext = await renderContextProgress();
      if (!showedContext) await setProgress(1, label);
      await setStatus(label, "xmark", COLORS.error);
      await updateVisibleState(label);
      await log("error", `Copilot error: ${message}`);
      if (config.notifyOnError) await notify("Copilot needs attention", message);
      if (!showedContext) clearProgressLater();
    },

    async contextUsage(data) {
      const usage = normalizeContextUsage(data);
      if (!usage) return;
      contextUsage = usage;
      await renderContextProgress();
      const label = state === "working" ? workingLabel(currentActivity) : visibleIdleLabel();
      await updateVisibleState(label);
    },

    async compactionStarted(data = {}) {
      if (!turnStartedAt) startElapsedTimer();
      compactionActive = true;
      state = "working";
      currentActivity = "compacting context";
      const label = workingLabel(currentActivity);
      const visual = stateVisual();
      await setStatus(label, visual.icon, visual.statusColor);
      if (!(await renderContextProgress())) await setProgress(progress, label);
      await updateVisibleState(label);
      await log("info", compactionStartLog(data));
      if (!contextUsage || !config.contextProgress) startPulse(label);
    },

    async compactionCompleted(data = {}) {
      compactionActive = false;
      if (data?.success === false) {
        attention("compaction failed");
        const label = `🔴 compaction failed`;
        await setStatus(label, "xmark", COLORS.error);
        await updateVisibleState(label);
        await log("error", `compaction failed: ${data?.error || "unknown error"}`);
        return;
      }

      compactionCount += 1;
      currentActivity = state === "working" ? "continuing after compaction" : currentActivity;
      const label = state === "working" ? workingLabel(currentActivity) : visibleIdleLabel();
      await updateVisibleState(label);
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
      await setStatus(label, "exclamationmark.triangle", COLORS.error);
      await setProgress(1, label);
      await updateVisibleState(label);
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
      if (state === "working") await updateVisibleState(workingLabel(currentActivity));
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
      await setStatus(label, "xmark", COLORS.error);
      await updateVisibleState(label);
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
    tools: new Map(),
  };
}

function workingLabel(detail) {
  return `🤖 ${detail}`;
}

function visibleIdleLabel() {
  return "✅ Done";
}

function doneLabel({ aborted, attentionActive, attentionMessage, compactionCount, turnStats }) {
  if (aborted) return "⚫ Stopped - waiting";
  if (attentionActive) return `🔴 Needs attention: ${attentionMessage || "check the last error"}`;
  const parts = [];
  if (turnStats.toolCount > 0) parts.push(`${turnStats.toolCount} ${plural(turnStats.toolCount, "tool")}`);
  if (turnStats.completedSubagents > 0) {
    parts.push(`${turnStats.completedSubagents} ${plural(turnStats.completedSubagents, "subagent")}`);
  }
  if (compactionCount > 0) parts.push(`${compactionCount} ${plural(compactionCount, "compaction")}`);
  if (parts.length === 0) return visibleIdleLabel();
  return `✅ Done: ${parts.join(", ")}`;
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
  return `${text.slice(0, maxLength - 1)}...`;
}

function formatSubagentSummary(activeSubagents) {
  const names = [...activeSubagents.values()];
  if (names.length === 0) return "";
  if (names.length === 1) return `1 subagent running: ${names[0]}`;
  return `${names.length} subagents running: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ", ..." : ""}`;
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
