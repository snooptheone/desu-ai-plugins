#!/usr/bin/env python3
"""PostToolUse/PostToolUseFailure (Bash): on the 3rd consecutive failure of the same test/build gate, point at principle-attack-the-premise.

State lives in <config dir>/state/desustack (mode 700; the config dir is CLAUDE_CONFIG_DIR or ~/.claude), not in the shared /tmp,
and the file is deleted once no gate is failing.
"""
import json, os, re, sys
from pathlib import Path
GATE = re.compile(r"\b(pytest|vitest|jest|npm (run )?(test|build|lint)|pnpm (run )?(test|build|lint)|yarn (test|build|lint)|tsc|eslint|ruff|mypy|cargo (test|build|check|clippy)|go (test|build|vet)|make|bash -n|shellcheck|ansible-lint|ansible-playbook|docker compose (build|config)|npx (vitest|tsc|prisma))\b")
try:
    d = json.load(sys.stdin)
    cmd = (d.get("tool_input") or {}).get("command", "")
    bare = re.sub(r"\"[^\"]*\"|'[^']*'", "", cmd)  # quoted text (a commit message) is not a gate
    if d.get("tool_name") != "Bash" or not GATE.search(bare): sys.exit(0)
    key = GATE.search(bare).group(1)
    state_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "state" / "desustack"
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    f = state_dir / f"premise-{re.sub(r'[^A-Za-z0-9_-]', '_', d['session_id'])}.json"
    st = json.loads(f.read_text()) if f.exists() else {}
    if d.get("hook_event_name") == "PostToolUseFailure":
        if d.get("is_interrupt"): sys.exit(0)
        st[key] = st.get(key, 0) + 1
        if st[key] % 3 == 0:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUseFailure", "additionalContext": f"The same gate (`{key}`) failed {st[key]} times in a row. Stop patching. Load the `principle-attack-the-premise` skill, write down the premise the fixes share, and test it directly before the next fix."}}))
    else:
        st.pop(key, None)
    if st:
        f.write_text(json.dumps(st))
    else:
        try:
            f.unlink()
        except FileNotFoundError:
            pass
except SystemExit:
    pass
except Exception:
    pass
