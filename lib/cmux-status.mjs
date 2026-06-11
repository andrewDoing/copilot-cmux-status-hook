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
  clearContextStatusOnDispose: true,
  contextSegments: 20,
  storeDir: join(tmpdir(), "copilot-cmux-status-hook"),
};

export function createCmuxStatusController(options = {}) {
  const env = options.env || process.env;
  const config = {
    ...DEFAULTS,
    aicStatusKey: env.CMUX_COPILOT_AIC_STATUS_KEY || DEFAULTS.aicStatusKey,
    contextStatusKey: env.CMUX_COPILOT_CONTEXT_STATUS_KEY || defaultContextStatusKey(env),
    clearContextStatusOnDispose: booleanFromEnv(
      env.CMUX_COPILOT_CLEAR_CONTEXT_STATUS_ON_DISPOSE,
      DEFAULTS.clearContextStatusOnDispose,
    ),
    contextSegments: numberFromEnv(env.CMUX_COPILOT_CONTEXT_SEGMENTS, DEFAULTS.contextSegments),
    storeDir: env.CMUX_COPILOT_AIC_STORE_DIR || DEFAULTS.storeDir,
    ...options,
  };
  const run = options.run || ((command, args) => execFileAsync(command, args));
  const enabled = Boolean(env.CMUX_WORKSPACE_ID);
  const workspaceUsagePath = join(config.storeDir, `${workspaceHash(env.CMUX_WORKSPACE_ID || "outside-cmux")}.jsonl`);
  const seenUsageCallIds = new Set();
  let disposed = false;
  let reportedCmuxFailure = false;
  let anonymousUsageSequence = 0;
  let contextStatusApplied = false;

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

  function reportCmuxFailure(error) {
    if (reportedCmuxFailure) return;
    reportedCmuxFailure = true;
    config.onError?.(`cmux command failed: ${error.message}`);
  }

  async function setStatus(key, value, icon, color) {
    return cmux(["set-status", key, value, "--icon", icon, "--color", color]);
  }

  async function renderAicTotal(total) {
    await setStatus(config.aicStatusKey, `AIC used: ${formatAic(total)}`, "creditcard", "#4F46E5");
  }

  return {
    isEnabled() {
      return enabled;
    },

    async startupReady() {
      await this.refreshAicTotal();
    },

    async ready() {
      await this.refreshAicTotal();
    },

    async userPrompt() {},

    async contextUsage(data) {
      const usage = normalizeContextUsage(data);
      if (!usage) return;
      contextStatusApplied = await setStatus(
        config.contextStatusKey,
        contextStatusValue(usage, config.contextSegments),
        "chart.bar",
        contextColor(usage.ratio),
      );
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

export function contextStatusValue(usage, segments = DEFAULTS.contextSegments) {
  const segmentCount = Math.max(1, Math.round(Number(segments)) || DEFAULTS.contextSegments);
  const filled = Math.min(segmentCount, Math.round(usage.ratio * segmentCount));
  const empty = segmentCount - filled;
  const percent = Math.round(usage.ratio * 100);
  const messages = usage.messagesLength === undefined ? "" : `, ${usage.messagesLength} msgs`;
  return `Context: [${"#".repeat(filled)}${"-".repeat(empty)}] ${percent}% (${formatTokenCount(usage.currentTokens)}/${formatTokenCount(usage.tokenLimit)}${messages})`;
}

function contextColor(ratio) {
  if (ratio >= 0.8) return "#B00020";
  if (ratio >= 0.5) return "#B26A00";
  return "#196F3D";
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanFromEnv(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return value !== "0";
}
