#!/bin/bash
# Local-only integration test: loads the plugin into the real `claude` CLI and checks
# that the hooks' output is accepted (no "Hook JSON output validation failed") and that
# a large Read is actually denied. Needs an authenticated `claude`, so it is not in CI.
# Run it when Claude Code is upgraded or hooks/ changes.
#
# Exit codes: 0 pass, 1 a check failed, 2 inconclusive (the model never called Read),
# 3 unexpected stream shape (no tool_result / no PreToolUse:Read hook event to inspect).
# Streams are kept in $LOGS on any non-zero exit.
set -u

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d)
LOGS=$(mktemp -d)
ATTEMPTS=3
trap 'rm -rf "$WORK"' EXIT

seq 1 400 > "$WORK/big.txt"
seq 1 10 > "$WORK/small.txt"

# NDJSON lines only (stderr noise is dropped by fromjson?).
events() { jq -Rc 'fromjson?' "$1"; }

called_read() { events "$1" | jq -e 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and .name == "Read")' >/dev/null; }

# run_read <name> <file>: run claude until it calls Read (max $ATTEMPTS); stream -> $LOGS/<name>.jsonl
run_read() {
  local name="$1" file="$2" i
  for ((i = 1; i <= ATTEMPTS; i++)); do
    (cd "$WORK" && claude -p "Use the Read tool on $file in full (no offset/limit), then stop." \
      --plugin-dir "$PLUGIN_DIR" --allowedTools Read --max-turns 2 \
      --output-format stream-json --verbose --include-hook-events) > "$LOGS/$name.jsonl" 2>&1
    called_read "$LOGS/$name.jsonl" && return 0
  done
  echo "INCONCLUSIVE: model never called Read for $name after $ATTEMPTS attempts (stream: $LOGS/$name.jsonl)"
  exit 2
}

# First tool result the model received (later turns may retry with offset/limit).
first_tool_result() {
  events "$1" | jq -rs '[.[] | select(.type == "user") | .message.content[]? | select(.type == "tool_result") | .content | tostring] | first // empty'
}

# permissionDecision of every non-empty PreToolUse:Read hook output (what the CLI itself recorded).
hook_decisions() {
  events "$1" | jq -r 'select(.type == "system" and .subtype == "hook_response" and .hook_name == "PreToolUse:Read" and (.output // "") != "")
    | .output | fromjson? | .hookSpecificOutput.permissionDecision // "invalid"'
}

# Negative checks ("content not returned", "hook silent") pass on empty input, so first
# prove the stream still has the events they inspect; otherwise the test says nothing.
require_shape() { # name
  local f="$LOGS/$1.jsonl"
  if [ -z "$(first_tool_result "$f")" ] ||
     [ -z "$(events "$f" | jq -r 'select(.type == "system" and .subtype == "hook_response" and .hook_name == "PreToolUse:Read") | .hook_name' | head -1)" ]; then
    echo "UNEXPECTED STREAM SHAPE for $1: no tool_result or no PreToolUse:Read hook_response (stream: $f)"
    echo "Claude Code's stream-json format may have changed; update first_tool_result/hook_decisions."
    exit 3
  fi
}

fail=0
check() { # name, condition exit code
  if [ "$2" -eq 0 ]; then printf "  PASS  %s\n" "$1"; else printf "  FAIL  %s\n" "$1"; fail=1; fi
}

run_read big "$WORK/big.txt"
run_read small "$WORK/small.txt"

require_shape big
require_shape small

big_res=$(first_tool_result "$LOGS/big.jsonl")
small_res=$(first_tool_result "$LOGS/small.jsonl")

echo "Integration (real claude CLI)"
cat "$LOGS"/*.jsonl | grep -q "validation failed"; check "no hook schema validation errors" $((! $?))
[ "$(hook_decisions "$LOGS/big.jsonl")" = "deny" ]; check "large Read: hook event records permissionDecision=deny" $?
[ -z "$(hook_decisions "$LOGS/small.jsonl")" ]; check "small Read: hook event is silent (allow)" $?
echo "$big_res" | grep -q "File is 400 lines"; check "large Read: model receives the deny reason" $?
echo "$big_res" | grep -q "399.399"; check "large Read: file content is not returned" $((! $?))
echo "$small_res" | grep -q "10.10"; check "small Read: real file content is returned" $?

if [ "$fail" -ne 0 ]; then echo "Streams kept in $LOGS"; exit 1; fi
rm -rf "$LOGS"
