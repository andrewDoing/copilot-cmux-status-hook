export function createCmuxSurfaceApplicator({ config, cmux }) {
  const applied = {
    progress: undefined,
    status: undefined,
    workspaceColor: undefined,
    workspaceDescription: undefined,
    workspaceTitle: undefined,
  };

  async function applyClearProgress() {
    applied.progress = undefined;
    await cmux(["clear-progress"]);
  }

  async function applyStatus(status) {
    if (!status) {
      if (!config.lifecycleStatus) return;
      const key = applied.status?.key || config.statusKey;
      if (applied.status === null) return;
      await cmux(["clear-status", key]);
      applied.status = null;
      return;
    }
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
    const args = ["set-progress", value];
    if (progressPlan.label) args.push("--label", progressPlan.label);
    await cmux(args);
  }

  async function applyWorkspaceDescription(description) {
    if (description === undefined) return;
    if (applied.workspaceDescription === description) return;
    applied.workspaceDescription = description;
    if (!description) {
      await cmux(["workspace-action", "--action", "clear-description"]);
      return;
    }
    await cmux(["workspace-action", "--action", "set-description", "--description", description]);
  }

  async function applyWorkspaceColor(color) {
    if (!color) return;
    if (applied.workspaceColor === color) return;
    applied.workspaceColor = color;
    await cmux(["workspace-action", "--action", "set-color", "--color", color]);
  }

  async function applyWorkspaceTitle(title) {
    if (!title) return;
    if (applied.workspaceTitle === title) return;
    applied.workspaceTitle = title;
    await cmux(["workspace-action", "--action", "rename", "--title", title]);
  }

  return {
    async applyRenderPlan(plan) {
      await applyStatus(plan.status);
      await applyProgress(plan.progress);
      await applyWorkspaceDescription(plan.workspaceDescription);
      await applyWorkspaceTitle(plan.workspaceTitle);
      await applyWorkspaceColor(plan.workspaceColor);
    },

    applyClearProgress,

    async clearStartupSurfaces() {
      applied.progress = undefined;
      await cmux(["clear-progress"]);
      for (const key of startupStatusKeys(config.statusKey)) {
        await cmux(["clear-status", key]);
      }
      applied.status = null;
      applied.workspaceDescription = "";
      await cmux(["workspace-action", "--action", "clear-description"]);
      if (config.clearLogOnStartup) await cmux(["clear-log"]);
    },
  };
}

function startupStatusKeys(statusKey) {
  return [...new Set([statusKey, "copilot-cli", "copilot"].filter(Boolean))];
}
