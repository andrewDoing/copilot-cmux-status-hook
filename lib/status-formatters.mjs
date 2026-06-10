export function createTurnStats() {
  return {
    toolCount: 0,
    failedTools: 0,
    completedSubagents: 0,
    failedSubagents: 0,
    skills: new Map(),
    tools: new Map(),
  };
}

export function currentStatusLabel({
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

export function workingLabel(detail) {
  return `🤖 ${detail}`;
}

export function visibleIdleLabel() {
  return "✅ Done";
}

export function doneLabel({ aborted, attentionActive, attentionMessage }) {
  if (aborted) return "⚫ Stopped - waiting";
  if (attentionActive) return `🔴 Needs attention: ${attentionMessage || "check the last error"}`;
  return visibleIdleLabel();
}

export function describeToolActivity(toolName, args = {}) {
  const name = humanizeToolName(toolName);
  if (toolName === "bash") return describeShellCommand(String(args?.command || ""));
  if (toolName === "apply_patch" || toolName === "edit" || toolName === "create") return "editing files";
  if (toolName === "rg" || toolName === "glob") return "searching code";
  if (toolName === "view") return "reading files";
  if (toolName === "ask_user") return "waiting for user input";
  if (toolName === "task") return "running subagent";
  return `running ${name}`;
}

export function describePermission(permissionRequest = {}) {
  const kind = permissionRequest?.kind || "permission";
  if (kind === "shell") return `shell command ${shorten(permissionRequest.fullCommandText || "")}`;
  if (kind === "write") return "file write";
  if (kind === "read") return "file read";
  if (kind === "url") return "URL access";
  if (kind === "mcp") return "MCP tool";
  return kind;
}

export function formatSubagentSummary(activeSubagents) {
  const names = [...activeSubagents.values()];
  if (names.length === 0) return "";
  if (names.length === 1) return `1 subagent running: ${names[0]}`;
  return `${names.length} subagents running: ${names.join(", ")}`;
}

export function normalizeSkillName(name) {
  return String(name || "").replace(/\s+/g, " ").trim();
}

export function skillInvokedLog(name, data = {}) {
  const trigger = data?.trigger ? ` (${data.trigger})` : "";
  return `skill invoked: ${name}${trigger}`;
}

export function skillNamesFromContext(content) {
  const text = String(content || "");
  const names = [];
  for (const match of text.matchAll(/<skill-context\s+[^>]*name=["']([^"']+)["'][^>]*>/g)) {
    const name = normalizeSkillName(match[1]);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function goalFromMessage(content) {
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

export function normalizeAiCreditCost(cost) {
  const parsed = Number(cost);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function usageCallId(data = {}) {
  return data?.apiCallId || data?.providerCallId || data?.serviceRequestId || "";
}

export function formatAic(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded.toFixed(2)).replace(/0$/, "");
}

export function compactionStartLog(data = {}) {
  const tokens = Number(data?.conversationTokens);
  if (Number.isFinite(tokens) && tokens > 0) return `compaction started at ${formatTokenCount(tokens)} conversation tokens`;
  return "compaction started";
}

export function compactionCompleteLog(data = {}, count) {
  const removed = Number(data?.tokensRemoved);
  const suffix = Number.isFinite(removed) && removed > 0 ? `, ${formatTokenCount(removed)} tokens removed` : "";
  return `compaction complete: ${count} ${plural(count, "compaction")}${suffix}`;
}

export function stripStatusBadge(title) {
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

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function goalLabel(goal) {
  if (!goal?.active || !goal.title) return "";
  return `🎯 Goal: ${goal.title}`;
}

export function completedSubagentSummary(turnStats) {
  if (turnStats.completedSubagents <= 0) return "";
  return `🤖 Subagents completed: ${turnStats.completedSubagents}`;
}

export function toolActivitySummary(turnStats) {
  if (turnStats.toolCount <= 0) return "";
  return `🛠 Tools invoked: ${turnStats.toolCount}`;
}

export function skillSummary(turnStats) {
  const names = [...turnStats.skills.keys()];
  if (names.length === 0) return "";
  return `🧰 Skills: ${names.join(", ")}`;
}

export function compactionLabel(active, count) {
  if (active) return count > 0 ? `🧹 Compacting context (${count} done)` : "🧹 Compacting context";
  if (count > 0) return `🧹 Compactions: ${count}`;
  return "";
}

function describeShellCommand(command) {
  if (/\b(test|vitest|jest|pytest|go test|cargo test)\b/i.test(command)) return "running tests";
  if (/\b(lint|eslint|ruff|shellcheck)\b/i.test(command)) return "running lint";
  if (/\b(build|tsc|make)\b/i.test(command)) return "running build";
  if (/\b(git)\b/i.test(command)) return "checking git";
  if (/\b(npm|pnpm|yarn|uv|pip|go)\b.*\b(install|add)\b/i.test(command)) return "installing dependencies";
  return "running shell command";
}

function shorten(value, maxLength = 64) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function shortenGoal(value, maxLength = 96) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

function trimDecimal(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}
