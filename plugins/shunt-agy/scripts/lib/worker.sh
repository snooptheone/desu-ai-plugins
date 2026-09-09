#!/bin/bash
# Shared plumbing for shunt-agy's delegation scripts.
#
# Delegates one chat turn to a cheap worker model through the agy
# (Antigravity CLI) headless mode, so file contents and boilerplate specs
# never enter Claude's own context — only the worker's final answer does.
#
# Input goes over stdin as a single stream-json event rather than argv, so
# there's no ARG_MAX ceiling on file size the way there would be with a
# `-p "<prompt>"` invocation. Closing stdin after the one line ends the
# turn and agy exits — see `agy --help` / the headless docs for "close
# stdin to end the turn".

AGY_BIN="${AGY_BIN:-agy}"
AGY_MODEL="${SHUNT_AGY_MODEL:-gemini-3.8-flash-low}"
# Left empty by default: the flash models above already bake their
# reasoning level into the model name (-high/-medium/-low), and passing
# --effort alongside one of those is a conflict agy rejects outright. Only
# set SHUNT_AGY_EFFORT if you switch to a model that takes effort separately
# (e.g. claude-sonnet-4-6, gpt-oss-120b-medium).
AGY_EFFORT="${SHUNT_AGY_EFFORT:-}"
SHUNT_TIMEOUT_SECONDS="${SHUNT_TIMEOUT_SECONDS:-180}"
SHUNT_MAX_PAYLOAD_BYTES="${SHUNT_MAX_PAYLOAD_BYTES:-2000000}"

# mktemp with cleanup on script exit. Usage: shunt_tmpfile <varname>
SHUNT_TMPFILES=()
shunt_tmpfile() {
  local f
  f=$(mktemp) || return 1
  SHUNT_TMPFILES+=("$f")
  trap 'rm -f "${SHUNT_TMPFILES[@]}"' EXIT
  printf -v "$1" '%s' "$f"
}

shunt_preflight() {
  local missing=""
  command -v jq >/dev/null 2>&1 || missing=" jq"
  command -v "$AGY_BIN" >/dev/null 2>&1 || missing="$missing $AGY_BIN"

  if [ -n "$missing" ]; then
    echo "Error: missing required command(s):$missing" >&2
    echo "  jq  — install via your package manager" >&2
    echo "  agy — the Antigravity CLI; see https://antigravity.google/docs/cli" >&2
    return 1
  fi
  return 0
}

# Runs one headless turn against the worker model and prints the answer.
#   $1 message file (the full prompt: wrapped file contents / spec, etc.)
shunt_invoke() {
  local message_file="$1"
  local bytes event_file response_file rc response status text err

  bytes=$(wc -c < "$message_file" | tr -d ' ')
  if [ "$bytes" -gt "$SHUNT_MAX_PAYLOAD_BYTES" ]; then
    echo "Error: request is $bytes bytes, over the $SHUNT_MAX_PAYLOAD_BYTES byte limit." >&2
    echo "Send fewer or smaller files, or raise SHUNT_MAX_PAYLOAD_BYTES if there is headroom." >&2
    return 1
  fi

  shunt_tmpfile event_file || return 1
  shunt_tmpfile response_file || return 1

  # Build the single stream-json input event without ever materializing the
  # message as a shell variable — --rawfile streams it straight from disk.
  jq -n --rawfile content "$message_file" \
    '{event: "user", message: {content: $content}}' > "$event_file" || return 1

  # stream-json input requires stream-json output: agy emits one NDJSON
  # line per event (init, step_update, ..., result) and exits on its own
  # once stdin closes and the turn completes. Only the "result" line matters.
  local -a effort_args=()
  [ -n "$AGY_EFFORT" ] && effort_args=(--effort "$AGY_EFFORT")

  "$AGY_BIN" \
    --input-format stream-json \
    --output-format stream-json \
    --model "$AGY_MODEL" \
    "${effort_args[@]}" \
    --print-timeout "${SHUNT_TIMEOUT_SECONDS}s" \
    < "$event_file" > "$response_file"
  rc=$?

  response=$(grep '"event":"result"' "$response_file" | tail -n1 | jq -c '.result // empty' 2>/dev/null)

  if [ "$rc" -ne 0 ] || [ -z "$response" ] || ! printf '%s' "$response" | jq -e . >/dev/null 2>&1; then
    echo "Error: agy invocation failed (exit $rc)" >&2
    cat "$response_file" >&2
    return 1
  fi

  status=$(printf '%s' "$response" | jq -r '.status // empty')
  if [ "$status" != "SUCCESS" ]; then
    err=$(printf '%s' "$response" | jq -r '.error // "no error field"')
    echo "Error: agy turn ended with status $status: $err" >&2
    return 1
  fi

  text=$(printf '%s' "$response" | jq -r '.response // empty')
  if [ -z "$text" ]; then
    echo "Error: agy returned no response text" >&2
    printf '%s\n' "$response" >&2
    return 1
  fi

  printf '%s\n' "$text"
}
