#!/bin/bash
# Tests scripts/lib/worker.sh against a stubbed `agy` binary — no real
# Antigravity CLI or network access needed. Covers the request/response
# plumbing directly, including the two bugs this plugin already hit once
# while wiring up the real agy: the stream-json input/output pairing, and
# the --effort/--model conflict on flash model names.
#
# Not modeled on Spotify's transport-evals.sh (their aika.sh talks to a
# completely different transport — the Portal CLI actions registry). This
# is a from-scratch suite for agy's stream-json protocol.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

# Exported once so every subshell test below inherits them without repeating
# the assignment; AGY_BIN and FAKE_AGY_MODE still vary per test.
export STUB_CAPTURE_STDIN="$STUB_DIR/stdin.json"
export STUB_CAPTURE_ARGS="$STUB_DIR/args.txt"

PASSED=0
FAILED=0

# The stub reads the stream-json event from stdin, saves it for inspection,
# echoes back the args it was called with, and emits canned NDJSON driven by
# FAKE_AGY_MODE — so each test controls agy's behavior without touching a
# real binary.
cat > "$STUB_DIR/agy" <<'STUB'
#!/bin/bash
cat > "$STUB_CAPTURE_STDIN"
printf '%s\n' "$*" > "$STUB_CAPTURE_ARGS"

case "${FAKE_AGY_MODE:-success}" in
  success)
    echo '{"event":"init","conversation_id":"stub"}'
    echo '{"event":"result","result":{"status":"SUCCESS","response":"STUB_OK\n"}}'
    ;;
  error-status)
    echo '{"event":"result","result":{"status":"ERROR","error":"stub failure"}}'
    ;;
  no-result-line)
    echo '{"event":"init","conversation_id":"stub"}'
    echo '{"event":"step_update","step_update":{}}'
    ;;
  nonzero-exit)
    echo 'not json' >&2
    exit 1
    ;;
  empty-response-field)
    echo '{"event":"result","result":{"status":"SUCCESS","response":""}}'
    ;;
esac
STUB
chmod +x "$STUB_DIR/agy"

# Each case runs worker.sh in a subshell so AGY_BIN/env overrides and
# sourced function definitions never leak between tests.

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf "  \033[32mPASS\033[0m  %-30s contains %q\n" "$name" "$needle"
    PASSED=$((PASSED + 1))
  else
    printf "  \033[31mFAIL\033[0m  %-30s missing %q\n" "$name" "$needle"
    FAILED=$((FAILED + 1))
  fi
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf "  \033[31mFAIL\033[0m  %-30s unexpectedly contains %q\n" "$name" "$needle"
    FAILED=$((FAILED + 1))
  else
    printf "  \033[32mPASS\033[0m  %-30s omits %q\n" "$name" "$needle"
    PASSED=$((PASSED + 1))
  fi
}

MSG=$(mktemp)
echo 'hello world' > "$MSG"

# 1. Success path returns 0 and prints the worker's response text
out=$(export AGY_BIN="$STUB_DIR/agy" FAKE_AGY_MODE=success; . "$PLUGIN_DIR/scripts/lib/worker.sh"; shunt_invoke "$MSG")
rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "STUB_OK" ]; then
  printf "  \033[32mPASS\033[0m  %-30s rc=0, response=%q\n" "success-returns-response" "$out"
  PASSED=$((PASSED + 1))
else
  printf "  \033[31mFAIL\033[0m  %-30s rc=%s response=%q\n" "success-returns-response" "$rc" "$out"
  FAILED=$((FAILED + 1))
fi

# 2. status: ERROR from agy is surfaced as a failure
(export AGY_BIN="$STUB_DIR/agy" FAKE_AGY_MODE=error-status; . "$PLUGIN_DIR/scripts/lib/worker.sh"; shunt_invoke "$MSG" >/dev/null 2>/dev/null)
rc=$?
if [ "$rc" -ne 0 ]; then
  printf "  \033[32mPASS\033[0m  %-30s rc=%s\n" "error-status-fails" "$rc"
  PASSED=$((PASSED + 1))
else
  printf "  \033[31mFAIL\033[0m  %-30s expected non-zero rc\n" "error-status-fails"
  FAILED=$((FAILED + 1))
fi

# 3. Missing "result" event (agy hung up early) is a failure, not a silent empty success
(export AGY_BIN="$STUB_DIR/agy" FAKE_AGY_MODE=no-result-line; . "$PLUGIN_DIR/scripts/lib/worker.sh"; shunt_invoke "$MSG" >/dev/null 2>/dev/null)
rc=$?
if [ "$rc" -ne 0 ]; then
  printf "  \033[32mPASS\033[0m  %-30s rc=%s\n" "missing-result-line-fails" "$rc"
  PASSED=$((PASSED + 1))
else
  printf "  \033[31mFAIL\033[0m  %-30s expected non-zero rc\n" "missing-result-line-fails"
  FAILED=$((FAILED + 1))
fi

# 4. Nonzero exit / garbled stdout from agy is a failure
(export AGY_BIN="$STUB_DIR/agy" FAKE_AGY_MODE=nonzero-exit; . "$PLUGIN_DIR/scripts/lib/worker.sh"; shunt_invoke "$MSG" >/dev/null 2>/dev/null)
rc=$?
if [ "$rc" -ne 0 ]; then
  printf "  \033[32mPASS\033[0m  %-30s rc=%s\n" "nonzero-exit-fails" "$rc"
  PASSED=$((PASSED + 1))
else
  printf "  \033[31mFAIL\033[0m  %-30s expected non-zero rc\n" "nonzero-exit-fails"
  FAILED=$((FAILED + 1))
fi

# 5. Empty response text is a failure, not a silently empty success
(export AGY_BIN="$STUB_DIR/agy" FAKE_AGY_MODE=empty-response-field; . "$PLUGIN_DIR/scripts/lib/worker.sh"; shunt_invoke "$MSG" >/dev/null 2>/dev/null)
rc=$?
if [ "$rc" -ne 0 ]; then
  printf "  \033[32mPASS\033[0m  %-30s rc=%s\n" "empty-response-fails" "$rc"
  PASSED=$((PASSED + 1))
else
  printf "  \033[31mFAIL\033[0m  %-30s expected non-zero rc\n" "empty-response-fails"
  FAILED=$((FAILED + 1))
fi

# 6. Oversized payload is rejected locally, without ever invoking agy
: > "$STUB_DIR/args.txt"
(export AGY_BIN="$STUB_DIR/agy" SHUNT_MAX_PAYLOAD_BYTES=5 FAKE_AGY_MODE=success; . "$PLUGIN_DIR/scripts/lib/worker.sh"; shunt_invoke "$MSG" >/dev/null 2>/dev/null)
rc=$?
if [ "$rc" -ne 0 ] && [ ! -s "$STUB_DIR/args.txt" ]; then
  printf "  \033[32mPASS\033[0m  %-30s rc=%s, agy never invoked\n" "oversized-payload-rejected" "$rc"
  PASSED=$((PASSED + 1))
else
  printf "  \033[31mFAIL\033[0m  %-30s rc=%s\n" "oversized-payload-rejected" "$rc"
  FAILED=$((FAILED + 1))
fi

# 7. SHUNT_AGY_EFFORT unset (default) never passes --effort to agy — this is
# the exact bug that broke the flash models the first time this was wired up.
: > "$STUB_DIR/args.txt"
(export AGY_BIN="$STUB_DIR/agy" FAKE_AGY_MODE=success; unset SHUNT_AGY_EFFORT; . "$PLUGIN_DIR/scripts/lib/worker.sh"; shunt_invoke "$MSG" >/dev/null 2>/dev/null)
args=$(cat "$STUB_DIR/args.txt" 2>/dev/null || echo "")
assert_not_contains "no-effort-flag-by-default" "$args" "--effort"

# 8. SHUNT_AGY_EFFORT set is passed through as --effort <value>
: > "$STUB_DIR/args.txt"
(export AGY_BIN="$STUB_DIR/agy" FAKE_AGY_MODE=success SHUNT_AGY_EFFORT=high; . "$PLUGIN_DIR/scripts/lib/worker.sh"; shunt_invoke "$MSG" >/dev/null 2>/dev/null)
args=$(cat "$STUB_DIR/args.txt" 2>/dev/null || echo "")
assert_contains "effort-flag-when-set" "$args" "--effort high"

# 9. stream-json input/output pairing: worker.sh must never call agy with a
# mismatched --output-format (this is the other bug already hit once).
: > "$STUB_DIR/args.txt"
(export AGY_BIN="$STUB_DIR/agy" FAKE_AGY_MODE=success; . "$PLUGIN_DIR/scripts/lib/worker.sh"; shunt_invoke "$MSG" >/dev/null 2>/dev/null)
args=$(cat "$STUB_DIR/args.txt" 2>/dev/null || echo "")
assert_contains "stream-json-input-flag" "$args" "--input-format stream-json"
assert_contains "stream-json-output-flag" "$args" "--output-format stream-json"

# 10. Message content survives the stdin round-trip byte-for-byte, including
# characters that would break a naive shell-variable/argv approach (quotes,
# backslashes, a literal JSON-like line).
TRICKY=$(mktemp)
printf 'line one\nhe said "hi" \\ back\n{"looks":"like json"}\n' > "$TRICKY"
: > "$STUB_DIR/stdin.json"
(export AGY_BIN="$STUB_DIR/agy" FAKE_AGY_MODE=success; . "$PLUGIN_DIR/scripts/lib/worker.sh"; shunt_invoke "$TRICKY" >/dev/null 2>/dev/null)
roundtrip=$(jq -r '.message.content' "$STUB_DIR/stdin.json" 2>/dev/null)
if [ "$roundtrip" = "$(cat "$TRICKY")" ]; then
  printf "  \033[32mPASS\033[0m  %-30s content byte-for-byte intact\n" "stdin-roundtrip-tricky-chars"
  PASSED=$((PASSED + 1))
else
  printf "  \033[31mFAIL\033[0m  %-30s content mismatch\n" "stdin-roundtrip-tricky-chars"
  FAILED=$((FAILED + 1))
fi
rm -f "$TRICKY"

rm -f "$MSG"

echo "## $PASSED $FAILED"
[ "$FAILED" -eq 0 ]
