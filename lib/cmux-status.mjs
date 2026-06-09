import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const COLORS = {
  ready: "#196F3D",
  working: "#B26A00",
  done: "#196F3D",
  stopped: "#6E6E6E",
  error: "#B00020",
};

const DEFAULTS = {
  statusKey: "copilot-cli",
  source: "copilot-cmux-status",
  notifyOnDone: true,
  notifyOnError: true,
  contextProgress: true,
  pulseIntervalMs: 1200,
  progressClearDelayMs: 4000,
  progressMin: 0.12,
  progressMax: 0.92,
  progressStep: 0.08,
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
  let contextUsage;
  let reportedCmuxFailure = false;

  async function cmux(args) {
    if (!enabled) return false;
    try {
      await run("cmux", args);
      return true;
    } catch (error) {
      if (!reportedCmuxFailure) {
        reportedCmuxFailure = true;
        config.onError?.(`cmux command failed: ${error.message}`);
      }
      return false;
    }
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

  async function renderContextProgress() {
    if (!config.contextProgress || !contextUsage) return false;
    stopPulse();
    if (clearProgressTimer) {
      timers.clearTimeout(clearProgressTimer);
      clearProgressTimer = undefined;
    }
    const label = state === "working" ? `Working - ${contextUsage.label}` : contextUsage.label;
    await setProgress(contextUsage.ratio, label);
    return true;
  }

  async function log(level, message) {
    await cmux(["log", "--level", level, "--source", config.source, "--", message]);
  }

  async function notify(title, body) {
    await cmux(["notify", "--title", title, "--body", body]);
  }

  return {
    isEnabled() {
      return enabled;
    },

    async ready(label = "Copilot ready") {
      state = "idle";
      stopPulse();
      await setStatus(label, "checkmark", COLORS.ready);
      await renderContextProgress();
      await log("success", label);
    },

    async startWorking(detail = "working") {
      state = "working";
      progress = config.progressMin;
      if (clearProgressTimer) {
        timers.clearTimeout(clearProgressTimer);
        clearProgressTimer = undefined;
      }
      const label = `Copilot working: ${detail}`;
      await setStatus(label, "gear", COLORS.working);
      if (!(await renderContextProgress())) {
        await setProgress(progress, label);
      }
      await log("info", label);
      if (!contextUsage || !config.contextProgress) startPulse(label);
    },

    async toolStart(toolName) {
      const label = `running ${humanizeToolName(toolName)}`;
      await this.startWorking(label);
    },

    async toolComplete(toolName, success) {
      if (state !== "working") return;
      const name = humanizeToolName(toolName);
      const level = success ? "success" : "error";
      const marker = success ? "finished" : "failed";
      await log(level, `${name} ${marker}`);
      if (!success) {
        await setStatus(`Copilot working: ${name} failed`, "xmark", COLORS.error);
      }
    },

    async done({ aborted = false } = {}) {
      state = "idle";
      stopPulse();
      const label = aborted ? "Copilot stopped - waiting" : "Copilot done - waiting";
      const color = aborted ? COLORS.stopped : COLORS.done;
      const icon = aborted ? "xmark" : "checkmark";
      const showedContext = await renderContextProgress();
      if (!showedContext) await setProgress(1, label);
      await setStatus(label, icon, color);
      await log(aborted ? "warning" : "success", label);
      if (!aborted && config.notifyOnDone) {
        await notify("Copilot is done", "The agent is waiting for your next instruction.");
      }
      if (!showedContext) clearProgressLater();
    },

    async error(message) {
      state = "error";
      stopPulse();
      const label = "Copilot needs attention";
      const showedContext = await renderContextProgress();
      if (!showedContext) await setProgress(1, label);
      await setStatus(label, "xmark", COLORS.error);
      await log("error", `Copilot error: ${message}`);
      if (config.notifyOnError) {
        await notify("Copilot needs attention", message);
      }
      if (!showedContext) clearProgressLater();
    },

    async contextUsage(data) {
      const usage = normalizeContextUsage(data);
      if (!usage) return;
      contextUsage = usage;
      await renderContextProgress();
    },

    async shutdown(data = {}) {
      stopPulse();
      if (data.shutdownType === "error") {
        await this.error(data.errorReason || "The Copilot session ended with an error.");
        return;
      }
      await this.done();
    },

    dispose() {
      stopPulse();
      if (clearProgressTimer) {
        timers.clearTimeout(clearProgressTimer);
        clearProgressTimer = undefined;
      }
    },
  };
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
