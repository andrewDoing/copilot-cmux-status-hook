# Copilot CMUX Status Hook

Make GitHub Copilot CLI status obvious in CMUX.

This Copilot CLI extension listens to session hooks and events, then adds supplemental details to CMUX's native Copilot integration:

- **Working:** `🤖` workspace title, amber workspace sidebar, visible workspace-card details, and a labeled pulsing progress bar until context usage is known.
- **Context usage:** persistent progress bar from Copilot's `session.usage_info` event, labeled with percentage, token counts, and message count. Context is marked `🟡` at 100k tokens and `🔴` at 50% of the window.
- **Tool activity:** shows `🛠 Tools invoked: N` on the workspace card.
- **AIC usage:** tracks `assistant.usage` billing cost and shows a running `💳 AIC used: N` total on the workspace card.
- **Goal mode:** tracks injected `/autopilot` objectives and shows them on the workspace card.
- **Skills:** tracks `skill.invoked` and injected `<skill-context name="...">` blocks, then shows invoked skill names on the workspace card.
- **Compactions:** tracks `session.compaction_start`/`session.compaction_complete` and logs compaction results.
- **Done:** leaves CMUX's native idle badge alone, then sends a desktop notification with supplemental details when present.
- **Needs attention:** keeps failure or approval details in progress/log/notification surfaces without replacing CMUX's native Copilot lifecycle rows.

The extension is inert outside CMUX. If `CMUX_WORKSPACE_ID` is not set, it does nothing.

Each CMUX surface has one owner: CMUX's native Copilot hooks own lifecycle status rows, while this hook keeps the workspace title/color and supplemental progress/log/notification/card details fresh by default. Workspace-card details can be disabled with `CMUX_COPILOT_WORKSPACE_CARD=0`; when disabled, startup still clears stale card descriptions left by older versions of this hook. If context progress is disabled and workspace-card details are enabled, the workspace card shows context instead. The hook clears stale status entries that older versions created, builds a render plan for each event, then applies only changed CMUX surfaces so unchanged values are not re-emitted.

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

Look for the `cmux-status` extension. When you submit a prompt inside CMUX, the workspace card should switch to a `🤖` title, amber sidebar, and labeled progress immediately after the user message is accepted, while CMUX's native Copilot integration continues to own the Ready/working lifecycle rows. After Copilot emits usage data, this extension adds context usage to the progress bar, for example `🤖 Context 21% (42k/200k, 25 msgs)` while active and `✅ Context 21% (42k/200k, 25 msgs)` while idle.

## Configuration

Set environment variables before starting Copilot CLI:

| Variable | Default | Description |
| --- | --- | --- |
| `CMUX_COPILOT_STATUS_KEY` | `copilot-cli` | Legacy CMUX sidebar status key to clear on startup. Used for writes only when `CMUX_COPILOT_LIFECYCLE_STATUS=1`. |
| `CMUX_COPILOT_NOTIFY_DONE` | `1` | Set to `0` to disable done notifications. |
| `CMUX_COPILOT_NOTIFY_ERROR` | `1` | Set to `0` to disable error notifications. |
| `CMUX_COPILOT_CONTEXT_PROGRESS` | `1` | Set to `0` to keep the progress bar for working/done state instead of context usage. |
| `CMUX_COPILOT_WORKSPACE_CARD` | `1` | Set to `0` to avoid updating the visible CMUX workspace card description/color with supplemental details. |
| `CMUX_COPILOT_WORKSPACE_TITLE` | `1` | Set to `0` to avoid prefixing the workspace title with status emoji and updating the workspace sidebar color. |
| `CMUX_COPILOT_LIFECYCLE_STATUS` | `0` | Set to `1` to write lifecycle status rows. Leave disabled when using CMUX native Copilot hooks. |
| `CMUX_COPILOT_CLEAR_ON_START` | `1` | Set to `0` to skip startup clearing of stale CMUX progress/status/card surfaces. |
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
