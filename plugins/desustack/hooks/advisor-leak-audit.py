#!/usr/bin/env python3
"""SubagentStop audit: warn when a subagent called the server-side advisor tool."""
import json
import re
import sys
import time
from pathlib import Path

data = json.load(sys.stdin)
path = data.get("agent_transcript_path")
if not path:
    sys.exit(0)

try:
    text = Path(path).expanduser().read_text()
except OSError:
    sys.exit(0)

# A real call leaves an advisor_tool_result block; the tool definition alone does not.
calls = len(re.findall(r'"type":\s*"advisor_tool_result"', text))
if not calls:
    sys.exit(0)

agent = data.get("agent_type") or "subagent"
msg = f"Advisor leak: {agent} called the advisor {calls}x (each call re-reads its transcript at advisor rates)."
with open(Path.home() / ".claude" / "advisor-leaks.log", "a") as log:
    log.write(f"{time.strftime('%F %T')} {agent} {data.get('agent_id')} calls={calls}\n")
print(json.dumps({"systemMessage": msg}))
