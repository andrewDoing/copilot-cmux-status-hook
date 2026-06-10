import { joinSession } from "@github/copilot-sdk/extension";
import { createCmuxStatusController } from "./lib/cmux-status.mjs";
import { createSessionHooks, registerCmuxStatusEvents } from "./lib/copilot-events.mjs";

const controller = createCmuxStatusController({
  onError: (message) => {
    console.error(`[copilot-cmux-status-hook] ${message}`);
  },
});

await controller.startupReady("✅ Ready");

const session = await joinSession({
  hooks: createSessionHooks(controller),
  tools: [],
});

registerCmuxStatusEvents(session, controller);

let cleanupStarted = false;

async function cleanupAndExit(signal) {
  if (cleanupStarted) return;
  cleanupStarted = true;
  await controller.clearStatus();
  controller.dispose();
  process.exit(signal === "SIGINT" ? 130 : 0);
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanupAndExit(signal);
  });
}
