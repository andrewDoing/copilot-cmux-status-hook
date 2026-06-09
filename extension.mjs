import { joinSession } from "@github/copilot-sdk/extension";
import { createCmuxStatusController } from "./lib/cmux-status.mjs";
import { createSessionHooks, registerCmuxStatusEvents } from "./lib/copilot-events.mjs";

const controller = createCmuxStatusController({
  onError: (message) => {
    console.error(`[copilot-cmux-status-hook] ${message}`);
  },
});

await controller.ready();

const session = await joinSession({
  hooks: createSessionHooks(controller),
  tools: [],
});

registerCmuxStatusEvents(session, controller);

process.once("SIGTERM", () => {
  controller.dispose();
  process.exit(0);
});
