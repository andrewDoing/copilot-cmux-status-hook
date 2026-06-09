import { joinSession } from "@github/copilot-sdk/extension";
import { createCmuxStatusController } from "./lib/cmux-status.mjs";

const controller = createCmuxStatusController({
  onError: (message) => {
    console.error(`[copilot-cmux-status-hook] ${message}`);
  },
});

const toolNames = new Map();

const session = await joinSession({
  hooks: {
    onSessionStart: async () => {
      await controller.ready("Copilot ready");
    },
    onUserPromptSubmitted: async () => {
      await controller.startWorking("reading prompt");
    },
    onErrorOccurred: async (input) => {
      await controller.error(String(input.error || "Copilot error"));
    },
    onSessionEnd: async () => {
      controller.dispose();
    },
  },
  tools: [],
});

session.on("assistant.turn_start", (event) => {
  void controller.startWorking(`thinking turn ${event.data.turnId}`);
});

session.on("tool.execution_start", (event) => {
  toolNames.set(event.data.toolCallId, event.data.toolName);
  void controller.toolStart(event.data.toolName);
});

session.on("tool.execution_complete", (event) => {
  const toolName = toolNames.get(event.data.toolCallId) || "tool";
  toolNames.delete(event.data.toolCallId);
  void controller.toolComplete(toolName, event.data.success);
});

session.on("session.idle", (event) => {
  toolNames.clear();
  void controller.done({ aborted: event.data.aborted === true });
});

session.on("session.error", (event) => {
  void controller.error(event.data.message);
});

session.on("session.shutdown", (event) => {
  if (event.data.shutdownType === "error") {
    void controller.shutdown(event.data).finally(() => controller.dispose());
    return;
  }
  controller.dispose();
});

process.once("SIGTERM", () => {
  controller.dispose();
  process.exit(0);
});
