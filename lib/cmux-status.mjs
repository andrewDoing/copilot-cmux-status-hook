import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  formatAic,
  formatTokenCount,
  normalizeAiCreditCost,
  normalizeContextUsage,
  usageCallId,
} from "./status-formatters.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULTS = {
  aicStatusKey: "copilot-aic",
  aicStatusPriority: 100,
  clearOnStartup: true,
  clearContextStatusOnDispose: true,
  contextCriticalRatio: 0.5,
  contextProgress: true,
  contextStatusPriority: 90,
  contextWarningTokens: 100_000,
  labelTerminal: true,
  storeDir: join(tmpdir(), "copilot-cmux-status-hook"),
};

const TERMINAL_EMOJIS = ["🦊", "🐙", "🦉", "🐝", "🐢", "🦀", "🐬", "🦄", "🚀"];
const WORKING_MARKER = "Working";

export function createCmuxStatusController(options = {}) {
  const env = options.env || process.env;
  const config = {
    ...DEFAULTS,
    aicStatusKey: env.CMUX_COPILOT_AIC_STATUS_KEY || DEFAULTS.aicStatusKey,
    aicStatusPriority: numberFromEnv(env.CMUX_COPILOT_AIC_STATUS_PRIORITY, DEFAULTS.aicStatusPriority),
    contextStatusKey: env.CMUX_COPILOT_CONTEXT_STATUS_KEY || defaultContextStatusKey(env),
    contextStatusPriority: numberFromEnv(
      env.CMUX_COPILOT_CONTEXT_STATUS_PRIORITY,
      DEFAULTS.contextStatusPriority,
    ),
    contextProgress: booleanFromEnv(env.CMUX_COPILOT_CONTEXT_PROGRESS, DEFAULTS.contextProgress),
    contextWarningTokens: numberFromEnv(
      env.CMUX_COPILOT_CONTEXT_WARNING_TOKENS,
      DEFAULTS.contextWarningTokens,
    ),
    contextCriticalRatio: numberFromEnv(
      env.CMUX_COPILOT_CONTEXT_CRITICAL_RATIO,
      DEFAULTS.contextCriticalRatio,
    ),
    clearOnStartup: booleanFromEnv(env.CMUX_COPILOT_CLEAR_ON_START, DEFAULTS.clearOnStartup),
    clearContextStatusOnDispose: booleanFromEnv(
      env.CMUX_COPILOT_CLEAR_CONTEXT_STATUS_ON_DISPOSE,
      DEFAULTS.clearContextStatusOnDispose,
    ),
    labelTerminal: booleanFromEnv(env.CMUX_COPILOT_LABEL_TERMINAL, DEFAULTS.labelTerminal),
    storeDir: env.CMUX_COPILOT_AIC_STORE_DIR || DEFAULTS.storeDir,
    ...options,
  };
  const run = options.run || ((command, args) => execFileAsync(command, args));
  const enabled = Boolean(env.CMUX_WORKSPACE_ID);
  const workspaceStorePrefix = workspaceHash(env.CMUX_WORKSPACE_ID || "outside-cmux");
  const workspaceUsagePath = join(config.storeDir, `${workspaceStorePrefix}.jsonl`);
  const terminalRegistryPath = join(config.storeDir, `${workspaceStorePrefix}-terminals.jsonl`);
  const terminalKey = String(env.CMUX_SURFACE_ID || process.pid);
  const seenUsageCallIds = new Set();
  let disposed = false;
  let reportedCmuxFailure = false;
  let anonymousUsageSequence = 0;
  let contextStatusApplied = false;
  let currentActivity = "";
  let latestContextUsage;
  let terminalLabel;
  let terminalPreviewLabel;
  let terminalRenamed = false;

  async function cmux(args) {
    if (!enabled || disposed) return false;
    try {
      await run("cmux", args);
      return true;
    } catch (error) {
      reportCmuxFailure(error);
      return false;
    }
  }

  async function cmuxOutput(args) {
    if (!enabled || disposed) return "";
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

  async function setStatus(key, value, icon, priority) {
    const args = ["set-status", key, value];
    if (icon) args.push("--icon", icon);
    args.push("--priority", String(priority));
    return cmux(args);
  }

  async function setProgress(usage) {
    if (!config.contextProgress) return false;
    return cmux(["set-progress", progressValue(usage.ratio)]);
  }

  async function setActivityProgress(value, detail) {
    if (!config.contextProgress) return false;
    return cmux(["set-progress", progressValue(value), "--label", `${await getTerminalPreviewLabel()} ${WORKING_MARKER}: ${detail}`]);
  }

  async function setActivity(value, detail) {
    currentActivity = detail;
    await setActivityProgress(value, detail);
    await renderContextStatus();
  }

  async function renderAicTotal(total) {
    await setStatus(
      config.aicStatusKey,
      `💳 AIC used: ${formatAic(total)}`,
      "",
      config.aicStatusPriority,
    );
  }

  async function getTerminalLabel() {
    if (terminalLabel) return terminalLabel;
    const ordinal = await assignTerminalOrdinal(terminalRegistryPath, terminalKey);
    terminalLabel = terminalLabelForOrdinal(ordinal);
    terminalPreviewLabel = terminalPreviewLabelForOrdinal(ordinal);
    await renameTerminal(terminalLabel);
    return terminalLabel;
  }

  async function getTerminalPreviewLabel() {
    if (!terminalPreviewLabel) await getTerminalLabel();
    return terminalPreviewLabel;
  }

  async function renameTerminal(label) {
    if (!config.labelTerminal || terminalRenamed || !env.CMUX_SURFACE_ID) return;
    terminalRenamed = await cmux(["rename-tab", "--surface", env.CMUX_SURFACE_ID, label]);
  }

  async function renderContextStatus() {
    if (!latestContextUsage) return;
    contextStatusApplied = await setStatus(
      config.contextStatusKey,
      contextStatusValue(latestContextUsage, await getTerminalPreviewLabel(), currentActivity),
      contextIcon(latestContextUsage, config),
      config.contextStatusPriority,
    );
  }

  async function clearStaleStartupSurfaces() {
    if (!config.clearOnStartup) return;

    const statusOutput = await cmuxOutput(["list-status"]);
    const keys = new Set([config.aicStatusKey]);
    for (const line of statusOutput.split("\n")) {
      const key = line.split("=", 1)[0]?.trim();
      if (key?.startsWith("copilot-context-")) keys.add(key);
    }

    for (const key of keys) {
      if (key) await cmux(["clear-status", key]);
    }
    if (config.contextProgress) await cmux(["clear-progress"]);
    contextStatusApplied = false;
    currentActivity = "";
    latestContextUsage = undefined;
  }

  return {
    isEnabled() {
      return enabled;
    },

    async startupReady() {
      await clearStaleStartupSurfaces();
      await getTerminalLabel();
      await this.refreshAicTotal();
    },

    async ready() {
      await getTerminalLabel();
      await this.refreshAicTotal();
    },

    async userPrompt() {
      await setActivity(0.05, "reading prompt");
    },

    async assistantTurnStart() {
      await setActivity(0.15, "thinking");
    },

    async assistantIntent(intent) {
      if (!intent) return;
      await setActivity(0.25, String(intent));
    },

    async toolStart(toolName, args) {
      await setActivity(0.45, describeToolActivity(toolName, args));
    },

    async toolComplete(toolName, success) {
      await setActivity(success === false ? 0.9 : 0.7, `${formatToolName(toolName)} ${success === false ? "failed" : "finished"}`);
    },

    async idle() {
      currentActivity = "";
      await renderContextStatus();
      if (latestContextUsage) await setProgress(latestContextUsage);
    },

    async contextUsage(data) {
      const usage = normalizeContextUsage(data);
      if (!usage) return;
      latestContextUsage = usage;
      await renderContextStatus();
      await setProgress(usage);
    },

    async assistantUsage(data = {}) {
      const cost = normalizeAiCreditCost(data?.cost);
      if (cost === undefined) return;

      const callId = usageCallId(data) || `anonymous-${process.pid}-${Date.now()}-${++anonymousUsageSequence}`;
      if (seenUsageCallIds.has(callId)) return;
      seenUsageCallIds.add(callId);

      await appendWorkspaceUsage(workspaceUsagePath, { callId, cost });
      await this.refreshAicTotal();
    },

    async refreshAicTotal() {
      if (!enabled) return;
      await renderAicTotal(await readWorkspaceAicTotal(workspaceUsagePath));
    },

    async clearStatus() {
      if (!config.clearContextStatusOnDispose) return;
      if (!contextStatusApplied) return;
      if (await cmux(["clear-status", config.contextStatusKey])) {
        contextStatusApplied = false;
      }
    },

    dispose() {
      if (config.clearContextStatusOnDispose && contextStatusApplied && enabled) {
        void run("cmux", ["clear-status", config.contextStatusKey]).catch((error) => reportCmuxFailure(error));
      }
      disposed = true;
    },
  };
}

export async function appendWorkspaceUsage(filePath, record) {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export async function assignTerminalOrdinal(filePath, terminalKey) {
  const existing = await readTerminalOrdinals(filePath);
  if (existing.has(terminalKey)) return existing.get(terminalKey);

  await appendWorkspaceUsage(filePath, { terminalKey });
  return (await readTerminalOrdinals(filePath)).get(terminalKey);
}

export async function readTerminalOrdinals(filePath) {
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }

  const ordinals = new Map();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const terminalKey = String(record?.terminalKey || "");
    if (!terminalKey || ordinals.has(terminalKey)) continue;
    ordinals.set(terminalKey, ordinals.size + 1);
  }
  return ordinals;
}

export function terminalLabelForOrdinal(ordinal) {
  const emoji = TERMINAL_EMOJIS[ordinal - 1];
  return emoji ? `${emoji} Copilot` : `Copilot ${ordinal}`;
}

export function terminalPreviewLabelForOrdinal(ordinal) {
  return TERMINAL_EMOJIS[ordinal - 1] || `Copilot ${ordinal}`;
}

export async function readWorkspaceAicTotal(filePath) {
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  const usageByCallId = new Map();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const cost = normalizeAiCreditCost(record?.cost);
    const callId = String(record?.callId || "");
    if (!callId || cost === undefined || usageByCallId.has(callId)) continue;
    usageByCallId.set(callId, cost);
  }
  return [...usageByCallId.values()].reduce((total, cost) => total + cost, 0);
}

export function contextStatusValue(usage, terminalLabel = "Copilot", activity = "") {
  const percent = Math.round(usage.ratio * 100);
  const messages = usage.messagesLength === undefined ? "" : `, ${usage.messagesLength} msgs`;
  const context = `Context ${percent}% (${formatTokenCount(usage.currentTokens)}/${formatTokenCount(usage.tokenLimit)}${messages})`;
  const prefix = activity ? `${WORKING_MARKER}: ${activity} · ${context}` : context;
  return `${terminalLabel} ${prefix}`;
}

export function contextIcon(usage, config = DEFAULTS) {
  if (usage.ratio >= config.contextCriticalRatio) return "🔴";
  if (usage.currentTokens >= config.contextWarningTokens) return "🟡";
  return "🟢";
}

function progressValue(ratio) {
  return String(Math.round(Math.min(Math.max(ratio, 0), 1) * 10000) / 10000);
}

function formatToolName(toolName) {
  return String(toolName || "tool")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function describeToolActivity(toolName, args = {}) {
  if (toolName === "bash") return describeShellCommand(String(args?.command || ""));
  if (toolName === "apply_patch" || toolName === "edit" || toolName === "create") return "editing files";
  if (toolName === "rg" || toolName === "glob") return "searching code";
  if (toolName === "view") return "reading files";
  return `running ${formatToolName(toolName)}`;
}

function describeShellCommand(command) {
  if (/\b(check|test|vitest|jest|pytest|go test|cargo test)\b/i.test(command)) return "running tests";
  if (/\b(lint|eslint|ruff|shellcheck)\b/i.test(command)) return "running lint";
  if (/\b(build|tsc|make)\b/i.test(command)) return "running build";
  if (/\b(git)\b/i.test(command)) return "checking git";
  if (/\b(npm|pnpm|yarn|uv|pip|go)\b.*\b(install|add)\b/i.test(command)) return "installing dependencies";
  return "running shell command";
}

function defaultContextStatusKey(env) {
  return `copilot-context-${env.CMUX_SURFACE_ID || process.pid}`;
}

function workspaceHash(workspaceId) {
  return createHash("sha256").update(String(workspaceId)).digest("hex").slice(0, 24);
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
