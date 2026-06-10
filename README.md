# Copilot CMUX Status Hook

Make GitHub Copilot CLI status obvious in CMUX.

This Copilot CLI extension listens to session hooks and events, then adds a per-surface status row to CMUX:

- **Working:** writes `cmux set-status copilot-${CMUX_SURFACE_ID}` with labels such as `Copilot: reading prompt`, `Copilot: running tests`, and `Copilot: Done`.
- **Surface isolation:** uses one unique CMUX status key per Copilot CLI surface, so multiple CLIs in one workspace do not overwrite a shared workspace description or progress bar.
- **Context usage:** tracks Copilot's `session.usage_info`; shared progress output is disabled by default and available only by opt-in.
- **Tool activity:** updates the same per-surface status row with activity such as editing, searching, running tests, or waiting for approval.
- **AIC usage:** tracks `assistant.usage` billing cost for optional workspace-card details and notifications.
- **Goal mode:** tracks injected `/autopilot` objectives for optional workspace-card details and notifications.
- **Skills:** tracks `skill.invoked` and injected `<skill-context name="...">` blocks for optional workspace-card details.
- **Compactions:** tracks `session.compaction_start`/`session.compaction_complete` and logs compaction results.
- **Done:** updates the same per-surface status row, then sends a desktop notification with supplemental details when present.
- **Needs attention:** keeps failure or approval details in the status row, log, and notification surfaces.

The extension is inert outside CMUX. If `CMUX_WORKSPACE_ID` is not set, it does nothing.

Each Copilot CLI process owns one CMUX status row keyed by `copilot-${CMUX_SURFACE_ID}` or `copilot-${process.pid}` when the surface id is unavailable. The hook avoids shared workspace description and progress surfaces by default because those are workspace-level fields; workspace-card, workspace-title, and progress output remain available as explicit opt-ins. The hook clears only its own status key on startup by default, builds a render plan for each event, then applies only changed CMUX surfaces so unchanged values are not re-emitted.

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

Look for the `cmux-status` extension. When you submit a prompt inside CMUX, the sidebar should show a status row keyed like `copilot-surface:3` with labels such as `Copilot: reading prompt`, then `Copilot: running tests`, then `Copilot: Done`. Multiple Copilot CLIs in the same workspace should show separate rows instead of overwriting one shared workspace description or progress bar.

## Configuration

Set environment variables before starting Copilot CLI:

| Variable | Default | Description |
| --- | --- | --- |
| `CMUX_COPILOT_STATUS_KEY` | `copilot-${CMUX_SURFACE_ID}` | Override the per-surface CMUX sidebar status key. Defaults to `copilot-${process.pid}` if `CMUX_SURFACE_ID` is unavailable. |
| `CMUX_COPILOT_NOTIFY_DONE` | `1` | Set to `0` to disable done notifications. |
| `CMUX_COPILOT_NOTIFY_ERROR` | `1` | Set to `0` to disable error notifications. |
| `CMUX_COPILOT_CONTEXT_PROGRESS` | `0` | Set to `1` to allow context usage to own the progress label when `CMUX_COPILOT_PROGRESS_BAR=1`. |
| `CMUX_COPILOT_PROGRESS_BAR` | `0` | Set to `1` to write CMUX's shared workspace progress bar. Keep disabled for multiple Copilot CLIs in one workspace. |
| `CMUX_COPILOT_WORKSPACE_CARD` | `0` | Set to `1` to update the shared CMUX workspace card description/color with supplemental details. Keep disabled for multiple Copilot CLIs in one workspace. |
| `CMUX_COPILOT_WORKSPACE_TITLE` | `0` | Set to `1` to prefix the shared workspace title with status emoji and update the workspace sidebar color. |
| `CMUX_COPILOT_LIFECYCLE_STATUS` | `1` | Set to `0` to disable this hook's per-surface lifecycle status row. |
| `CMUX_COPILOT_CLEAR_ON_START` | `1` | Set to `0` to skip startup clearing of this surface's status row. |
| `CMUX_COPILOT_CLEAR_LEGACY_STATUS_KEYS` | `0` | Set to `1` to also clear old shared `copilot-cli` and `copilot` status keys on startup. |
| `CMUX_COPILOT_CLEAR_STATUS_ON_DISPOSE` | `1` | Set to `0` to leave the per-surface status row visible after the extension disposes. |
| `CMUX_COPILOT_CLEAR_LOG_ON_START` | `1` | Set to `0` to preserve CMUX log history when the extension starts. |
| `CMUX_COPILOT_LOG_BACKGROUND_TASKS` | `0` | Set to `1` to log `session.background_tasks_changed`; disabled by default because CMUX native hooks already surface it. |
| `CMUX_COPILOT_LOG_LIFECYCLE` | `0` | Set to `1` to log lifecycle labels such as `🤖 thinking` and `✅ Done`; disabled by default to avoid duplicating status rows. |
| `CMUX_COPILOT_SHOW_AIC` | `1` | Set to `0` to hide the `💳 AIC used` card line. |
| `CMUX_COPILOT_SHOW_COMPACTIONS` | `1` | Set to `0` to hide compaction card lines. |
| `CMUX_COPILOT_SHOW_CONTEXT` | `1` | Set to `0` to hide context card lines; the progress bar can still show context when enabled. |
| `CMUX_COPILOT_SHOW_ELAPSED` | `1` | Set to `0` to hide elapsed-time card lines. |
| `CMUX_COPILOT_SHOW_GOAL` | `1` | Set to `0` to hide injected `/autopilot` goal card lines. |
| `CMUX_COPILOT_SHOW_PERMISSIONS` | `1` | Set to `0` to hide permission detail card lines. |
| `CMUX_COPILOT_SHOW_SKILLS` | `1` | Set to `0` to hide invoked skill card lines when workspace-card details are enabled. |
| `CMUX_COPILOT_SHOW_SUBAGENTS` | `1` | Set to `0` to hide subagent card lines. |
| `CMUX_COPILOT_SHOW_TOOL_ACTIVITY` | `1` | Set to `0` to hide `🛠 Tools invoked` card lines. |
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
