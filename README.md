# Copilot CMUX Status Hook

Make GitHub Copilot CLI status obvious in CMUX.

This Copilot CLI extension listens to session hooks and events, then mirrors the agent state into CMUX:

- **Working:** orange sidebar status, pulsing progress bar, log entry, and surface flash.
- **Done:** green sidebar status, full progress bar, log entry, surface flash, and desktop notification.
- **Needs attention:** red sidebar status, error log entry, surface flash, and desktop notification.

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

Look for the `cmux-status` extension. When you submit a prompt inside CMUX, the sidebar should switch to **Copilot working**. When the turn becomes idle, it should switch to **Copilot done**.

## Configuration

Set environment variables before starting Copilot CLI:

| Variable | Default | Description |
| --- | --- | --- |
| `CMUX_COPILOT_STATUS_KEY` | `copilot-cli` | CMUX sidebar status key to write. |
| `CMUX_COPILOT_NOTIFY_DONE` | `1` | Set to `0` to disable done notifications. |
| `CMUX_COPILOT_NOTIFY_ERROR` | `1` | Set to `0` to disable error notifications. |
| `CMUX_COPILOT_PULSE_MS` | `1200` | Progress pulse interval while the agent works. |
| `CMUX_COPILOT_CLEAR_PROGRESS_MS` | `4000` | Delay before clearing the completed progress bar. |
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

The extension entrypoint must be named `extension.mjs` for Copilot CLI discovery.
