# Copilot CMUX Status Hook

Show two Copilot CLI signals in CMUX:

- **Workspace AIC total:** every Copilot terminal in the same `CMUX_WORKSPACE_ID` appends `assistant.usage` costs to a shared local total and refreshes the high-priority `cmux set-status copilot-aic` row.
- **Per-terminal context progress:** each Copilot terminal writes its own lower-priority native CMUX status pill to `cmux set-status copilot-context-${CMUX_SURFACE_ID}`.

The extension is inert outside CMUX. If `CMUX_WORKSPACE_ID` is not set, it does nothing. It does not write CMUX workspace descriptions, workspace titles, workspace colors, logs, notifications, or shared progress bars.

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

Look for the `cmux-status` extension. After Copilot reports usage, CMUX should show:

- `copilot-aic` with a value like `AIC used: 3.25`.
- `copilot-context-surface:3` with a value like `Context 25% (68k/272k, 88 msgs)`.

## Configuration

Set environment variables before starting Copilot CLI:

| Variable | Default | Description |
| --- | --- | --- |
| `CMUX_COPILOT_AIC_STATUS_KEY` | `copilot-aic` | Override the shared workspace AIC status key. |
| `CMUX_COPILOT_AIC_STATUS_PRIORITY` | `100` | Sort priority for the AIC status row. Higher appears first in CMUX. |
| `CMUX_COPILOT_CONTEXT_STATUS_KEY` | `copilot-context-${CMUX_SURFACE_ID}` | Override this terminal's context status key. Defaults to `copilot-context-${process.pid}` if `CMUX_SURFACE_ID` is unavailable. |
| `CMUX_COPILOT_CONTEXT_STATUS_PRIORITY` | `90` | Sort priority for each context status row. Keep below the AIC priority for stable row order. |
| `CMUX_COPILOT_AIC_STORE_DIR` | OS temp dir plus `copilot-cmux-status-hook` | Directory for the local JSONL usage totals keyed by `CMUX_WORKSPACE_ID`. |
| `CMUX_COPILOT_CLEAR_CONTEXT_STATUS_ON_DISPOSE` | `1` | Set to `0` to leave this terminal's context status row visible after the extension disposes. |

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

The extension entrypoint must be named `extension.mjs` for Copilot CLI discovery.
