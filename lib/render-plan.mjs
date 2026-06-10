import {
  compactionLabel,
  completedSubagentSummary,
  formatDuration,
  formatSubagentSummary,
  formatAic,
  goalLabel,
  skillSummary,
  stripStatusBadge,
  toolActivitySummary,
  visibleIdleLabel,
} from "./status-formatters.mjs";
import { createSurfacePolicy } from "./surface-policy.mjs";

const COLORS = {
  ready: "#196F3D",
  working: "#B26A00",
  done: "#196F3D",
  stopped: "#6E6E6E",
  error: "#B00020",
  warning: "#B26A00",
};

export function renderPlan(state, config, label, options = {}) {
  const policy = createSurfacePolicy(config);
  const visual = stateVisualFor(state, config);
  const workspaceColor = policy.workspaceColor === "write" ? options.fallbackColor || visual.color : undefined;
  const workspaceTitle = policy.workspaceTitle === "write" && options.baseTitle ? `${visual.badge} ${options.baseTitle}` : undefined;
  let progressPlan = config.progressBar ? options.progress : undefined;
  let contextProgressActive = false;

  if (!progressPlan && config.progressBar && policy.detailTarget("context") === "progress" && state.contextUsage) {
    contextProgressActive = true;
    progressPlan = {
      value: state.contextUsage.ratio,
      label: state.state === "working" ? `🤖 ${state.contextUsage.label}` : `✅ ${state.contextUsage.label}`,
    };
  }

  if (!progressPlan && config.progressBar && options.fallbackProgress) {
    progressPlan = options.fallbackProgress;
  }

  const status = policy.status === "write" ? {
    key: config.statusKey,
    value: statusValueFor(label),
    icon: visual.icon,
    color: visual.statusColor,
  } : undefined;
  const cardDescription = cardDescriptionFor(state, config, policy, label, {
    progressLabel: progressPlan?.label,
    statusLabel: status?.value,
    titleLabel: workspaceTitle,
    now: options.now,
  });

  return {
    contextProgressActive,
    progress: progressPlan,
    status,
    workspaceColor,
    workspaceDescription: policy.workspaceCard === "write" ? cardDescription : undefined,
    notificationBody: notificationBodyFor(state, config, policy, cardDescription, label),
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

function statusValueFor(label) {
  const text = stripStatusBadge(label).replace(/\s+/g, " ").trim();
  return text ? `Copilot: ${text}` : "Copilot";
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

function cardDescriptionFor(state, config, policy, label, labels = {}) {
  const lines = [];
  if (config.showPermissions && policy.detailTarget("permission") === "workspace-card" && state.permissionActive && state.permissionMessage && state.permissionMessage !== label) {
    lines.push(state.permissionMessage);
  }
  if (config.showSubagents && policy.detailTarget("subagents") === "workspace-card" && state.activeSubagents.size > 0) {
    lines.push(formatSubagentSummary(state.activeSubagents));
  }
  const completedSubagents = config.showSubagents && policy.detailTarget("subagents") === "workspace-card"
    ? completedSubagentSummary(state.turnStats)
    : "";
  if (completedSubagents) lines.push(completedSubagents);
  const tools = config.showToolActivity && policy.detailTarget("tools") === "workspace-card"
    ? toolActivitySummary(state.turnStats)
    : "";
  if (tools) lines.push(tools);
  const goal = config.showGoal && policy.detailTarget("goal") === "workspace-card" ? goalLabel(state.goal) : "";
  if (goal) lines.push(goal);
  const skills = config.showSkills && policy.detailTarget("skills") === "workspace-card" ? skillSummary(state.turnStats) : "";
  if (skills) lines.push(skills);
  if (config.showContext && policy.detailTarget("context") === "workspace-card" && state.contextUsage) {
    lines.push(`${contextSeverityFor(state.contextUsage, config).badge} ${state.contextUsage.label}`);
  }
  const compaction = config.showCompactions && policy.detailTarget("compaction") === "workspace-card"
    ? compactionLabel(state.compactionActive, state.compactionCount)
    : "";
  if (compaction) lines.push(compaction);
  if (config.showAic && policy.detailTarget("aic") === "workspace-card" && state.aiCreditsUsed > 0) {
    lines.push(`💳 AIC used: ${formatAic(state.aiCreditsUsed)}`);
  }
  const elapsed = elapsedLabelFor(state, config, labels.now);
  if (config.showElapsed && policy.detailTarget("elapsed") === "workspace-card" && state.state === "working" && elapsed) {
    lines.push(elapsed);
  }
  return dedupeWorkspaceLines(lines, [label, labels.statusLabel, labels.progressLabel, labels.titleLabel]);
}

function notificationBodyFor(state, config, policy, cardDescription, label) {
  if (cardDescription) return cardDescription;
  const lines = [];
  const goal = config.showGoal && policy.detailTarget("goal") === "notification" ? goalLabel(state.goal) : "";
  if (goal) lines.push(goal);
  const compaction = config.showCompactions && policy.detailTarget("compaction") === "notification"
    ? compactionLabel(state.compactionActive, state.compactionCount)
    : "";
  if (compaction) lines.push(compaction);
  return dedupeWorkspaceLines(lines, [label]) || label;
}

function elapsedLabelFor(state, config, now = Date.now()) {
  if (config.elapsedIntervalMs <= 0) return "";
  if (!state.turnStartedAt) return "";
  return `Elapsed ${formatDuration(now - state.turnStartedAt)}`;
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
