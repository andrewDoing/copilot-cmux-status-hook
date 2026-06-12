#!/usr/bin/env bash
set -euo pipefail

default_log_dir="${TMPDIR:-/tmp}/copilot-imessage-hook"
log_dir="${COPILOT_IMESSAGE_LOG_DIR:-$default_log_dir}"
mkdir -p "$log_dir"

input="$(cat)"
reason="$(
  HOOK_INPUT="$input" node <<'NODE'
const input = process.env.HOOK_INPUT ?? "";
  let payload = {};
  if (input.trim() !== "") {
    try {
      payload = JSON.parse(input);
    } catch (error) {
      console.error(`Invalid Copilot hook JSON: ${error.message}`);
      process.exit(2);
    }
  }

  const reason =
    payload.reason ??
    payload.stopReason ??
    payload.status ??
    payload.event?.reason ??
    "complete";
  process.stdout.write(String(reason));
NODE
)"

printf '%s\treason=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$reason" >> "$log_dir/imessage-agent-stop.log"

configured_send_reasons="${COPILOT_IMESSAGE_SEND_REASONS:-complete,end_turn}"
send_reasons=",${configured_send_reasons//[[:space:]]/},"
if [[ "$send_reasons" != *",$reason,"* ]]; then
  echo "Skipping iMessage notification for Copilot stop reason: $reason" >&2
  exit 0
fi

recipient="${COPILOT_IMESSAGE_RECIPIENT:?COPILOT_IMESSAGE_RECIPIENT is required}"
message="${COPILOT_IMESSAGE_MESSAGE:-}"
if [[ -z "$message" ]]; then
  message="Copilot CLI session complete."
  if [[ "$reason" == "end_turn" ]]; then
    message="Copilot CLI turn complete."
  fi
fi

if [[ "${COPILOT_IMESSAGE_DRY_RUN:-0}" == "1" || "${COPILOT_IMESSAGE_SKIP_SEND:-0}" == "1" ]]; then
  echo "Dry run: would send iMessage to ${recipient}: ${message}" >&2
  exit 0
fi

if [[ "${COPILOT_IMESSAGE_BELL:-1}" == "1" ]]; then
  printf '\a'
fi

if [[ "${COPILOT_IMESSAGE_NOTIFY:-1}" == "1" ]]; then
  if ! osascript - "$message" <<'APPLESCRIPT'
on run argv
  display notification (item 1 of argv) with title "Copilot CLI"
end run
APPLESCRIPT
  then
    echo "macOS notification failed; continuing with iMessage send." >&2
  fi
fi

if ! command -v imsg >/dev/null 2>&1; then
  echo "imsg command not found. Install and configure imsg, or set COPILOT_IMESSAGE_DRY_RUN=1 to test." >&2
  exit 127
fi

imsg send --to "$recipient" --text "$message" --service imessage
