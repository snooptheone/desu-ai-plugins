#!/usr/bin/env python3
"""PostToolUse/PostToolUseFailure (Bash): on the 3rd consecutive failure of the same test/build gate, point at principle-attack-the-premise."""
import json, os, re, sys
GATE = re.compile(r"\b(pytest|vitest|jest|npm (run )?(test|build|lint)|pnpm (run )?(test|build|lint)|yarn (test|build|lint)|tsc|eslint|ruff|mypy|cargo (test|build|check|clippy)|go (test|build|vet)|make|bash -n|shellcheck|ansible-lint|ansible-playbook|docker compose (build|config)|npx (vitest|tsc|prisma))\b")
try:
    d = json.load(sys.stdin)
    cmd = (d.get("tool_input") or {}).get("command", "")
    if d.get("tool_name") != "Bash" or not GATE.search(cmd): sys.exit(0)
    key = GATE.search(cmd).group(1)
    f = f"/tmp/claude-premise-{d['session_id']}.json"
    st = json.load(open(f)) if os.path.exists(f) else {}
    if d.get("hook_event_name") == "PostToolUseFailure":
        if d.get("is_interrupt"): sys.exit(0)
        st[key] = st.get(key, 0) + 1
        if st[key] % 3 == 0:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUseFailure", "additionalContext": f"The same gate (`{key}`) failed {st[key]} times in a row. Stop patching. Load the `principle-attack-the-premise` skill, write down the premise the fixes share, and test it directly before the next fix."}}))
    else:
        st.pop(key, None)
    json.dump(st, open(f, "w"))
except SystemExit:
    pass
except Exception:
    pass
