#!/usr/bin/env python3
"""SubagentStop audit: warn when a subagent called the server-side advisor tool."""
import json
import os
import re
import sys
import time
from pathlib import Path

MAX_BYTES = 1_000_000  # keep the log from growing without bound: past 1 MB, keep the last 1000 lines


def main():
    data = json.load(sys.stdin)
    path = data.get("agent_transcript_path")
    if not path:
        return

    try:
        text = Path(path).expanduser().read_text()
    except OSError:
        return

    # A real call leaves an advisor_tool_result block; the tool definition alone does not.
    calls = len(re.findall(r'"type":\s*"advisor_tool_result"', text))
    if not calls:
        return

    agent = data.get("agent_type") or "subagent"
    msg = f"Advisor leak: {agent} called the advisor {calls}x (each call re-reads its transcript at advisor rates)."
    log_path = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "advisor-leaks.log"
    if log_path.exists() and log_path.stat().st_size > MAX_BYTES:
        log_path.write_text("".join(log_path.read_text().splitlines(keepends=True)[-1000:]))
    with open(log_path, "a") as log:
        log.write(f"{time.strftime('%F %T')} {agent} {data.get('agent_id')} calls={calls}\n")
    print(json.dumps({"systemMessage": msg}))


try:
    main()
except Exception:
    pass  # an audit must never get in the way
