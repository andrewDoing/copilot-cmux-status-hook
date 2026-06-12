export function createSessionHooks(controller) {
  return {
    onSessionStart: async () => {
      await controller.ready();
    },
    onUserPromptSubmitted: async () => {
      await controller.userPrompt();
    },
    onErrorOccurred: async () => {},
    onSessionEnd: async () => {
      await controller.clearStatus();
      controller.dispose();
    },
  };
}

export function registerCmuxStatusEvents(session, controller) {
  const toolNames = new Map();
  const on = (eventType, handler) => {
    session.on(eventType, (event) => {
      return handler(event);
    });
  };

  on("user.message", () => {
    return controller.userPrompt();
  });

  on("assistant.turn_start", () => {
    return controller.assistantTurnStart();
  });

  on("assistant.intent", (event) => {
    return controller.assistantIntent(event.data.intent);
  });

  on("tool.execution_start", (event) => {
    toolNames.set(event.data.toolCallId, event.data.toolName);
    return controller.toolStart(event.data.toolName, event.data.arguments);
  });

  on("tool.execution_complete", (event) => {
    const toolName = toolNames.get(event.data.toolCallId) || "tool";
    toolNames.delete(event.data.toolCallId);
    return controller.toolComplete(toolName, event.data.success);
  });

  on("session.idle", () => {
    toolNames.clear();
    return controller.idle();
  });

  on("session.usage_info", (event) => {
    return controller.contextUsage(event.data);
  });

  on("session.shutdown", () => {
    return controller.clearStatus().finally(() => controller.dispose());
  });
}
