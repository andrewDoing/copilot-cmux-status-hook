export function createSessionHooks(controller) {
  return {
    onSessionStart: async () => {
      await controller.ready("Copilot ready");
    },
    onUserPromptSubmitted: async () => {
      await controller.userPrompt("reading prompt");
    },
    onErrorOccurred: async (input) => {
      await controller.error(String(input.error || "Copilot error"));
    },
    onSessionEnd: async () => {
      controller.dispose();
    },
  };
}

export function registerCmuxStatusEvents(session, controller) {
  const toolNames = new Map();
  const on = (eventType, handler) => {
    session.on(eventType, (event) => {
      void controller.debugEvent(eventType);
      handler(event);
    });
  };

  on("assistant.turn_start", (event) => {
    void controller.startWorking(`thinking turn ${event.data.turnId}`);
  });

  on("assistant.intent", (event) => {
    void controller.assistantIntent(event.data.intent);
  });

  on("user.message", () => {
    void controller.userPrompt("prompt received");
  });

  on("tool.execution_start", (event) => {
    toolNames.set(event.data.toolCallId, event.data.toolName);
    void controller.toolStart(event.data.toolName, event.data.arguments);
  });

  on("tool.execution_complete", (event) => {
    const toolName = toolNames.get(event.data.toolCallId) || "tool";
    toolNames.delete(event.data.toolCallId);
    void controller.toolComplete(toolName, event.data.success);
  });

  on("subagent.started", (event) => {
    void controller.subagentStarted(event.data);
  });

  on("subagent.completed", (event) => {
    void controller.subagentCompleted(event.data);
  });

  on("subagent.failed", (event) => {
    void controller.subagentFailed(event.data);
  });

  on("permission.requested", (event) => {
    void controller.permissionRequested(event.data);
  });

  on("permission.completed", (event) => {
    void controller.permissionCompleted(event.data);
  });

  on("session.background_tasks_changed", () => {
    void controller.backgroundTasksChanged();
  });

  on("session.idle", (event) => {
    toolNames.clear();
    void controller.done({ aborted: event.data.aborted === true });
  });

  on("session.error", (event) => {
    void controller.error(event.data.message);
  });

  on("session.usage_info", (event) => {
    void controller.contextUsage(event.data);
  });

  on("session.compaction_start", (event) => {
    void controller.compactionStarted(event.data);
  });

  on("session.compaction_complete", (event) => {
    void controller.compactionCompleted(event.data);
  });

  on("session.shutdown", (event) => {
    if (event.data.shutdownType === "error") {
      void controller.shutdown(event.data).finally(() => controller.dispose());
      return;
    }
    controller.dispose();
  });
}
