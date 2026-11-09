#!/usr/bin/env python3
"""PreToolUse(Bash): wrap noisy commands so only errors, warnings and the summary come back.

Short output (<= SHORT lines) is passed through whole. Full log path is always printed.
shortcut: regex match on the command text, not a shell parse; extend NOISY when a tool slips through.
"""
import json
import re
import sys

SHORT = 40

NOISY = re.compile(
    r"(?:^|[;&|(]\s*|&&\s*)(?:sudo\s+)?(?:"
    r"(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|update|upgrade|build|test|t|run\s+(?:build|test|lint|compile)\S*)"
    r"|npx\s+(?:vitest|jest|playwright|webpack|vite\s+build)"
    r"|(?:vitest|jest|pytest|tox|nox|make|ninja|cmake|mvn|gradle|gradlew)"
    r"|(?:pip3?|uv\s+pip|pipx|poetry|uv)\s+(?:install|sync|add|update)"
    r"|python3?\s+-m\s+(?:pytest|pip\s+install)"
    r"|cargo\s+(?:build|test|check|install|clippy|update)"
    r"|go\s+(?:build|test|install|mod\s+download)"
    r"|docker\s+(?:build|compose\s+build|pull)"
    r"|(?:pacman|yay|paru|apt|apt-get|dnf|brew|flatpak)\s+(?:-S\S*|install|upgrade|update|-Syu\S*)"
    r")\b"
)

# leave pipes, redirects, backgrounding and heredocs alone: the user already shaped that output
SHAPED = re.compile(r"\|(?!\|)|(?<![&>\d])>|<<|&\s*$")

KEEP = (
    r"error|err!|fail|fatal|panic|warn|denied|not found|cannot|traceback|exception|"
    r"✗|✖|×|passed|skipped|tests?\b|test files|summary|added|removed|changed|packages|audited|"
    r"vulnerabilit|built in|finished|success|installed|upgraded|done|exit"
)


def wrap(cmd: str) -> str:
    return (
        '__q=$(mktemp "${TMPDIR:-/tmp}/quiet-output.XXXXXX"); '
        f"( {cmd}\n) >\"$__q\" 2>&1; __rc=$?; "
        "tr '\\r' '\\n' <\"$__q\" >\"$__q.n\" && mv \"$__q.n\" \"$__q\"; "
        '__n=$(wc -l <"$__q"); '
        f'if [ "$__n" -le {SHORT} ]; then cat "$__q"; else '
        'echo "[quiet-output: $__n lines; showing matches + last 4; full log: $__q]"; '
        f"grep -a -n -i -E '{KEEP}' \"$__q\" | head -n 60; "
        'echo "--- tail ---"; tail -n 4 "$__q"; fi; exit $__rc'
    )


def main() -> None:
    try:
        ev = json.load(sys.stdin)
        if ev.get("tool_name") != "Bash":
            return
        cmd = ev["tool_input"]["command"]
        if "quiet-output" in cmd or not NOISY.search(cmd) or SHAPED.search(cmd):
            return
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": {**ev["tool_input"], "command": wrap(cmd)},
            }
        }))
    except Exception:
        return  # fail open: a malformed event just means the command runs as is


if __name__ == "__main__":
    main()
