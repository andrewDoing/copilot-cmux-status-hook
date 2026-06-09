# Copilot CMUX Status Hook

Make GitHub Copilot CLI status obvious in CMUX.

This Copilot CLI extension listens to session hooks and events, then mirrors the agent state into CMUX:

- **Working:** orange sidebar status, visible workspace card description/color, log entry, and a pulsing progress bar until context usage is known.
- **Context usage:** persistent progress bar from Copilot's `session.usage_info` event, labeled with percentage, token counts, and message count. While the agent is active, the label is prefixed with `Working -`.
- **Done:** green sidebar status, log entry, and desktop notification.
- **Needs attention:** red sidebar status, error log entry, and desktop notification.

The extension is inert outside CMUX. If `CMUX_WORKSPACE_ID` is not set, it does nothing.

## Install

```bash
git clone https://github.com/andrewDoing/copilot-cmux-status-hook.git
cd copilot-cmux-status-hook
npm run install:extension
```

Restart Copilot CLI, or run `/clear`, so the extension loader discovers `~/.copilot/extensions/cmux-status/extension.mjs`.

## Verify

In Copilot CLI:

```text
/env
```

Look for the `cmux-status` extension. When you submit a prompt inside CMUX, the sidebar should switch to **Copilot working** immediately after the user message is accepted. When the turn becomes idle, it should switch to **Copilot done**. After Copilot emits usage data, the progress bar should show context usage, for example `Working - Context 21% (42k/200k, 25 msgs)` while active and `Context 21% (42k/200k, 25 msgs)` while idle.

## Configuration

Set environment variables before starting Copilot CLI:

| Variable | Default | Description |
| --- | --- | --- |
| `CMUX_COPILOT_STATUS_KEY` | `copilot-cli` | CMUX sidebar status key to write. |
| `CMUX_COPILOT_NOTIFY_DONE` | `1` | Set to `0` to disable done notifications. |
| `CMUX_COPILOT_NOTIFY_ERROR` | `1` | Set to `0` to disable error notifications. |
| `CMUX_COPILOT_CONTEXT_PROGRESS` | `1` | Set to `0` to keep the progress bar for working/done state instead of context usage. |
| `CMUX_COPILOT_WORKSPACE_CARD` | `1` | Set to `0` to avoid updating the visible CMUX workspace card description/color. |
| `CMUX_COPILOT_PULSE_MS` | `1200` | Progress pulse interval while the agent works. |
| `CMUX_COPILOT_CLEAR_PROGRESS_MS` | `4000` | Delay before clearing the completed progress bar when context progress is unavailable or disabled. |
| `CMUX_COPILOT_LOG_SOURCE` | `copilot-cmux-status` | Source label for CMUX log entries. |

## Update

```bash
cd copilot-cmux-status-hook
git pull
```

The install script creates a symlink, so pulled changes apply after Copilot CLI reloads extensions.

## Uninstall

```bash
npm run uninstall:extension
```

## Development

```bash
npm run check
```

`npm run check` runs syntax checks plus unit tests and E2E-style event-flow tests that drive the same Copilot lifecycle events the extension listens to in a real session.

The extension entrypoint must be named `extension.mjs` for Copilot CLI discovery.
