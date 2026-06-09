# Copilot CMUX Status Hook

Make GitHub Copilot CLI status obvious in CMUX.

This Copilot CLI extension listens to session hooks and events, then mirrors the agent state into CMUX:

- **Working:** `🤖` status/card/title, visible workspace card description/color, log entry, elapsed timer, and a pulsing progress bar until context usage is known.
- **Context usage:** persistent progress bar from Copilot's `session.usage_info` event, labeled with percentage, token counts, and message count. Context is marked `🟡` at 100k tokens and `🔴` at 50% of the window.
- **Compactions:** tracks `session.compaction_start`/`session.compaction_complete`, shows `🧹` compaction count on the workspace card, and includes the count in done summaries.
- **Done:** `✅` green sidebar status/card/title, last-turn summary, log entry, and desktop notification with the actual status summary.
- **Needs attention:** `🔴`/`🚨` red sidebar status/card/title, persistent failure or approval state, error log entry, and desktop notification.

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

Look for the `cmux-status` extension. When you submit a prompt inside CMUX, the sidebar should switch to `🤖` immediately after the user message is accepted. When the turn becomes idle, it should switch to `✅`. After Copilot emits usage data, the progress bar should show context usage, for example `🤖 Context 21% (42k/200k, 25 msgs)` while active and `✅ Context 21% (42k/200k, 25 msgs)` while idle.

## Configuration

Set environment variables before starting Copilot CLI:

| Variable | Default | Description |
| --- | --- | --- |
| `CMUX_COPILOT_STATUS_KEY` | `copilot-cli` | CMUX sidebar status key to write. |
| `CMUX_COPILOT_NOTIFY_DONE` | `1` | Set to `0` to disable done notifications. |
| `CMUX_COPILOT_NOTIFY_ERROR` | `1` | Set to `0` to disable error notifications. |
| `CMUX_COPILOT_CONTEXT_PROGRESS` | `1` | Set to `0` to keep the progress bar for working/done state instead of context usage. |
| `CMUX_COPILOT_WORKSPACE_CARD` | `1` | Set to `0` to avoid updating the visible CMUX workspace card description/color. |
| `CMUX_COPILOT_WORKSPACE_TITLE` | `1` | Set to `0` to avoid prefixing the workspace title with status emoji. |
| `CMUX_COPILOT_CONTEXT_WARNING_TOKENS` | `100000` | Token count that turns context status yellow. |
| `CMUX_COPILOT_CONTEXT_CRITICAL_RATIO` | `0.5` | Context window ratio that turns context status red. |
| `CMUX_COPILOT_ELAPSED_MS` | `15000` | Interval for refreshing elapsed working time on the card. |
| `CMUX_COPILOT_DEBUG` | `0` | Set to `1` to log raw Copilot event names. |
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
