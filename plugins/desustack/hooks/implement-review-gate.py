#!/usr/bin/env python3
"""PreToolUse (Bash): after /implement, block `git commit` until the code-review skill ran.

The implement skill lists "call code-review" as a plain line before "commit"; agents jumped
from the test run to the commit. This turns that line into a gate.
Needs the `mattpocock-skills` plugin (its `implement` and `code-review` skills).
"""
import json, re, sys

IMPLEMENT = {"implement", "mattpocock-skills:implement"}
# Only mattpocock's review counts: the bare `code-review` resolves to the built-in skill (inline, no subagents).
REVIEW = {"mattpocock-skills:code-review"}
CMD_NAME = re.compile(r"<command-name>/?([^<]+)</command-name>")
# A brief for a child session (not started with /implement) arms the gate with this line on its own.
BRIEF_MARKER = re.compile(r"^REVIEW-GATE: mattpocock-skills:code-review\s*$", re.M)


def briefed(entry):
    """True if a user message carries the gate marker line."""
    msg = entry.get("message") or {}
    content = msg.get("content")
    if entry.get("type") != "user":
        return False
    if isinstance(content, str):
        return bool(BRIEF_MARKER.search(content))
    return any(
        isinstance(b, dict) and b.get("type") == "text" and BRIEF_MARKER.search(b.get("text", ""))
        for b in content or []
    )


def invoked(entry):
    """Skill names invoked by this transcript entry: /slash command or Skill tool call."""
    msg = entry.get("message") or {}
    content = msg.get("content")
    if entry.get("type") == "user" and isinstance(content, str):
        return [m.strip() for m in CMD_NAME.findall(content)]
    if entry.get("type") == "assistant" and isinstance(content, list):
        return [
            (b.get("input") or {}).get("skill", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "Skill"
        ]
    return []


try:
    d = json.load(sys.stdin)
    cmd = (d.get("tool_input") or {}).get("command", "")
    if d.get("tool_name") != "Bash" or not re.search(r"\bgit\b[^;&|\n]*\bcommit\b", cmd):
        sys.exit(0)
    implemented = reviewed = False
    for line in open(d["transcript_path"], errors="ignore"):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        names = invoked(entry)
        if briefed(entry):
            implemented = True  # keeps `reviewed`: a review run earlier still counts
        if any(n in IMPLEMENT for n in names):
            implemented, reviewed = True, False  # a new /implement restarts the requirement
        if implemented and any(n in REVIEW for n in names):
            reviewed = True
    if implemented and not reviewed:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "The implement skill requires a code review before the commit. Call the Skill "
                "`mattpocock-skills:code-review` (reviewing the work since the starting point), "
                "report the findings, and only then run git commit. If the review is impossible, "
                "stop and tell the user why. Do not skip it silently."
            ),
        }}))
except SystemExit:
    pass
except Exception as e:
    # fail closed: a crashed gate must not let a commit through unreviewed
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": f"implement-review-gate.py failed ({e!r}); fix the hook before committing.",
    }}))
