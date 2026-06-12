# Copilot CMUX Status Hook

Show Copilot CLI session state in CMUX:

- **Context progress:** each Copilot terminal gets a stable workspace-local emoji label, renames its CMUX tab to a label like `🦊 Copilot`, writes an emoji-prefixed context pill to `cmux set-status copilot-context-${CMUX_SURFACE_ID}` with a `🟢`/`🟡`/`🔴` threshold marker in the text, updates CMUX's workspace progress bar with activity/context updates, and sets the workspace color bar to Amber while working, Red while waiting on the user, and Green on session end. The native CMUX Copilot `Done` pill is left alone.

The CMUX extension is inert outside CMUX. If `CMUX_WORKSPACE_ID` is not set, it does nothing. It does not write CMUX workspace descriptions, workspace titles, logs, or notifications.

On extension startup, such as after Copilot CLI `/restart`, the hook clears stale hook-owned rows (`copilot-context-*` plus the legacy `copilot-aic` row) plus the CMUX progress bar. It does not clear CMUX native Copilot rows such as `✅ Done`.

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

Look for the `cmux-status` extension. After Copilot reports context usage, CMUX should show:

- A Copilot terminal tab renamed to a stable label like `🦊 Copilot`.
- `copilot-context-surface:3` with values like `🟢 🦊 Working: running tests · Context 25% (68k/272k, 88 msgs)` while active and `🟢 🦊 Context 25% (...)` when idle.
- The CMUX progress bar showing `Working:` activity labels while active, then an unlabeled context percentage bar when idle.
- The CMUX workspace color bar showing Amber while active, Red while waiting on the user, and Green when the session ends.

## Configuration

Set environment variables before starting Copilot CLI:

| Variable | Default | Description |
| --- | --- | --- |
| `CMUX_COPILOT_CLEAR_ON_START` | `1` | Set to `0` to skip startup cleanup of hook-owned context rows, legacy AIC row, and progress. |
| `CMUX_COPILOT_CONTEXT_STATUS_KEY` | `copilot-context-${CMUX_SURFACE_ID}` | Override this terminal's context status key. Defaults to `copilot-context-${process.pid}` if `CMUX_SURFACE_ID` is unavailable. |
| `CMUX_COPILOT_CONTEXT_STATUS_PRIORITY` | `90` | Sort priority for each context status row. |
| `CMUX_COPILOT_CONTEXT_PROGRESS` | `1` | Set to `0` to stop updating CMUX's workspace progress bar. The per-terminal context status row still updates. |
| `CMUX_COPILOT_CONTEXT_WARNING_TOKENS` | `100000` | Token count that changes the context icon from `🟢` to `🟡`. |
| `CMUX_COPILOT_CONTEXT_CRITICAL_RATIO` | `0.5` | Context window ratio that changes the context icon to `🔴`. |
| `CMUX_COPILOT_STORE_DIR` | OS temp dir plus `copilot-cmux-status-hook` | Directory for the local terminal-label registry keyed by `CMUX_WORKSPACE_ID`. |
| `CMUX_COPILOT_LABEL_TERMINAL` | `1` | Set to `0` to keep the original CMUX tab title instead of renaming it to the emoji label. |
| `CMUX_COPILOT_CLEAR_CONTEXT_STATUS_ON_DISPOSE` | `1` | Set to `0` to leave this terminal's context status row visible after the extension disposes. |
| `CMUX_COPILOT_WORKSPACE_COLOR` | `1` | Set to `0` to stop changing the CMUX workspace color bar. |
| `CMUX_COPILOT_WORKSPACE_WORKING_COLOR` | `Amber` | Workspace color while Copilot is processing a prompt or running a tool. |
| `CMUX_COPILOT_WORKSPACE_WAITING_COLOR` | `Red` | Workspace color while Copilot is idle or waiting on user input. |
| `CMUX_COPILOT_WORKSPACE_DONE_COLOR` | `Green` | Workspace color when the Copilot session ends. |

## Optional iMessage completion hook

This repo also includes an optional Copilot CLI hook script that sends an iMessage
when a Copilot turn or session finishes. It is separate from the CMUX extension
and only runs if you add it to your active Copilot hook config.

Requirements:

- macOS with Messages signed in.
- The `imsg` CLI installed and configured.
- Node.js available on `PATH`.
- A recipient provided through `COPILOT_IMESSAGE_RECIPIENT`.

Add an `agentStop` command to `~/.copilot/hooks/hooks.json`. If you already
have `agentStop` hooks, append this object to the existing array:

```json
{
  "type": "command",
  "bash": "/absolute/path/to/copilot-cmux-status-hook/hooks/imessage-agent-stop.sh",
  "timeoutSec": 15,
  "env": {
    "COPILOT_IMESSAGE_RECIPIENT": "REPLACE_WITH_PHONE_OR_APPLE_ID"
  }
}
```

See `examples/copilot-hooks.imessage.json` for a complete example. Replace the
script path and recipient before using it.

Dry-run the hook without sending a message:

```bash
printf '{"reason":"end_turn"}' | \
  COPILOT_IMESSAGE_RECIPIENT="REPLACE_WITH_PHONE_OR_APPLE_ID" \
  COPILOT_IMESSAGE_DRY_RUN=1 \
  hooks/imessage-agent-stop.sh
```

By default, the hook sends for `complete` and `end_turn` stop reasons. Override
that list with `COPILOT_IMESSAGE_SEND_REASONS`, for example
`COPILOT_IMESSAGE_SEND_REASONS=complete`.

Optional iMessage hook environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `COPILOT_IMESSAGE_RECIPIENT` | required | Phone number or Apple ID email passed to `imsg send --to`. |
| `COPILOT_IMESSAGE_SEND_REASONS` | `complete,end_turn` | Comma-separated stop reasons that should send a message. |
| `COPILOT_IMESSAGE_DRY_RUN` | `0` | Set to `1` to print what would be sent without notifications or iMessages. |
| `COPILOT_IMESSAGE_MESSAGE` | reason-based | Override the default completion message. |
| `COPILOT_IMESSAGE_LOG_DIR` | `$TMPDIR/copilot-imessage-hook` | Directory for hook reason logs. |
| `COPILOT_IMESSAGE_NOTIFY` | `1` | Set to `0` to skip the macOS local notification. |
| `COPILOT_IMESSAGE_BELL` | `1` | Set to `0` to skip the terminal bell. |

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

`npm run check` runs syntax checks plus the Node test suite.

For opt-in live CMUX coverage, run this from inside a CMUX terminal:

```bash
npm run test:e2e:cmux
```

The live test uses disposable status keys, disables terminal renaming, and clears
its own status rows and progress when it finishes. It skips automatically when
`CMUX_WORKSPACE_ID` is not set.

The extension entrypoint must be named `extension.mjs` for Copilot CLI discovery.
