#!/usr/bin/env python3
"""PreToolUse (Bash): deny a command that writes to ~/.claude/hooks.

The hooks are the guardrails that `ask` rules cannot replace; an agent that can `sed -i` them can switch
them off. A command is denied when it names the `.claude/hooks` path and carries a write verb or redirect.
Reading (`cat`, `ls`, running a hook with test input) stays allowed. The user's own `!` commands skip
PreToolUse, so editing by hand still works.
Fails open: if the guard crashes (a changed event format, say) it prints a warning and lets the call through,
so a bug here can never block every Bash call.
shortcut: string match on the raw command, not a shell parse; `cd` elsewhere plus a script that writes
the dir slips through. Not a sandbox. Upgrade to a bubblewrap/read-only mount if that ever matters.
shortcut: Edit and Write tools are not covered here; add an `ask` rule for them if wanted.
"""
import json, os, re, sys

# `.claude-plugin/hooks.json` must not match. A custom CLAUDE_CONFIG_DIR counts as well.
_dirs = [r"\.claude/hooks"]
if os.environ.get("CLAUDE_CONFIG_DIR"):
    _dirs.append(re.escape(os.environ["CLAUDE_CONFIG_DIR"].rstrip("/")) + "/hooks")
HOOKS_DIR = re.compile("(?:" + "|".join(_dirs) + r")(?:/|\s|$|['\"])")
NOISE = re.compile(r"\d*>>?\s*&?\s*(?:/dev/null|\d)\b|\d*>&\d")  # 2>&1, >/dev/null: not a file write
WRITE = re.compile(
    r">"
    r"|\b(?:sed|perl)\b[^;&|\n]*\s-\w*i"
    r"|\b(?:tee|mv|cp|rm|rmdir|ln|chmod|chown|truncate|dd|install|patch|touch|ed|ex|vi|vim|nano|emacs)\b"
    r"|\bopen\([^)]*['\"][wax]|write_text|write_bytes|\bshutil\b|\bos\.(?:remove|rename|unlink|replace)\b"
)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


try:
    d = json.load(sys.stdin)
    if d.get("tool_name") != "Bash":
        sys.exit(0)
    cmd = (d.get("tool_input") or {}).get("command", "")
    if HOOKS_DIR.search(cmd) and WRITE.search(NOISE.sub(" ", cmd)):
        deny("The command writes to ~/.claude/hooks, where the guardrails live. Edit by hand (`!` prefix in the prompt) "
             "or ask the user to authorize the change; do not work around the block by another path.")
except SystemExit:
    pass
except Exception as e:
    print(json.dumps({"systemMessage": f"hooks-write-guard.py failed ({e!r}); the guard is off for this call."}))
