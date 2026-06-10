export function createSurfacePolicy(config) {
  return {
    status: config.lifecycleStatus ? "write" : "clear-legacy-only",
    workspaceCard: config.workspaceCard ? "write" : "clear-legacy-only",
    workspaceTitle: config.workspaceTitle ? "write" : "off",
    workspaceColor: config.workspaceCard || config.workspaceTitle ? "write" : "off",
    detailTarget(kind) {
      if (kind === "lifecycle") return "native";
      if (kind === "context" && config.contextProgress) return "progress";
      if (config.workspaceCard) return "workspace-card";
      if (kind === "goal" || kind === "compaction" || kind === "permission") return "notification";
      return "hidden";
    },
  };
}
