export function createSessionHooks(controller) {
  return {
    onSessionStart: async () => {
      await controller.ready();
    },
    onUserPromptSubmitted: async () => {},
    onErrorOccurred: async () => {},
    onSessionEnd: async () => {
      await controller.clearStatus();
      controller.dispose();
    },
  };
}

export function registerCmuxStatusEvents(session, controller) {
  const on = (eventType, handler) => {
    session.on(eventType, (event) => {
      return handler(event);
    });
  };

  on("session.usage_info", (event) => {
    return controller.contextUsage(event.data);
  });

  on("assistant.usage", (event) => {
    return controller.assistantUsage(event.data);
  });

  on("session.shutdown", () => {
    return controller.clearStatus().finally(() => controller.dispose());
  });
}
