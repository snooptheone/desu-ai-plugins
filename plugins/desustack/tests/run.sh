#!/usr/bin/env bash
# Hook evals for the desustack plugin. Needs bash, python3 and jq. No network, no Claude Code.
# Each hook gets a JSON event on stdin; we check what it prints. HOME points at a temp dir.
set -u

H="$(cd "$(dirname "${BASH_SOURCE[0]}")/../hooks" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"
mkdir -p "$HOME/.claude"

pass=0
fail=0

check() { # name, ok(0/1), output
  if [ "$2" -eq 0 ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL %s\n     output: %s\n' "$1" "$(printf '%s' "$3" | cut -c1-200)"
  fi
}

run() { python3 "$H/$1" 2>&1; } # event on stdin

bash_event() { # command [cwd] [transcript_path]
  # the command goes in on stdin: a 300 KB --arg would hit the kernel's per-argument limit
  printf '%s' "$1" | jq -Rsc --arg d "${2:-/tmp}" --arg t "${3:-}" \
    '{tool_name:"Bash",cwd:$d,transcript_path:$t,session_id:"s1",tool_input:{command:.}}'
}

deny() { # name, hook, event
  local out
  out="$(printf '%s' "$3" | run "$2")"
  case "$out" in *'"permissionDecision": "deny"'*) check "$1" 0 "$out" ;; *) check "$1" 1 "$out" ;; esac
}

allow() { # name, hook, event
  local out
  out="$(printf '%s' "$3" | run "$2")"
  [ -z "$out" ] && check "$1" 0 "$out" || check "$1" 1 "$out"
}

no_deny() { # name, hook, event: the hook may warn, but must neither deny nor crash
  local out
  out="$(printf '%s' "$3" | run "$2")"
  case "$out" in *'"permissionDecision"'*|*Traceback*) check "$1" 1 "$out" ;; *) check "$1" 0 "$out" ;; esac
}

contains() { # name, hook, event, text
  local out
  out="$(printf '%s' "$3" | run "$2")"
  case "$out" in *"$4"*) check "$1" 0 "$out" ;; *) check "$1" 1 "$out" ;; esac
}

# --- hooks-write-guard
G=hooks-write-guard.py
deny  "write-guard: rm in hooks dir"          $G "$(bash_event 'rm ~/.claude/hooks/x.py')"
deny  "write-guard: redirect into hooks dir"  $G "$(bash_event 'echo x > ~/.claude/hooks/x.py')"
allow "write-guard: read of hooks dir"        $G "$(bash_event 'cat ~/.claude/hooks/x.py')"
allow "write-guard: plugin hooks.json copy"   $G "$(bash_event 'cp a.json plugins/x/.claude-plugin/hooks.json')"
allow "write-guard: rm elsewhere"             $G "$(bash_event 'rm /tmp/x')"
allow "write-guard: ignores non-Bash"         $G '{"tool_name":"Read","tool_input":{"file_path":"/x"}}'
no_deny "write-guard: fails open on empty stdin" $G ''
no_deny "write-guard: fails open on null"        $G 'null'
out="$(printf '%s' "$(bash_event 'rm /x/cfg/hooks/a.py')" | CLAUDE_CONFIG_DIR=/x/cfg run $G)"
case "$out" in *'"permissionDecision": "deny"'*) check "write-guard: custom CLAUDE_CONFIG_DIR is guarded" 0 "" ;; *) check "write-guard: custom CLAUDE_CONFIG_DIR is guarded" 1 "$out" ;; esac
out="$(printf '%s' "$(bash_event 'rm /x/other/hooks/a.py')" | CLAUDE_CONFIG_DIR=/x/cfg run $G)"
[ -z "$out" ] && check "write-guard: other dirs stay free with a custom config dir" 0 "" || check "write-guard: other dirs stay free with a custom config dir" 1 "$out"

# --- bash-guard
G=bash-guard.py
deny  "bash-guard: cd down"                   $G "$(bash_event 'cd /usr && ls')"
allow "bash-guard: cd to an ancestor"         $G "$(bash_event 'cd /tmp' /tmp/a/b)"
allow "bash-guard: cd in a subshell"          $G "$(bash_event '( cd /usr && ls )')"
deny  "bash-guard: find /"                    $G "$(bash_event 'find / -name x')"
allow "bash-guard: find / with maxdepth"      $G "$(bash_event 'find / -maxdepth 1')"
deny  "bash-guard: pkill -f without bracket"  $G "$(bash_event 'pkill -f node')"
allow "bash-guard: pkill -f with bracket"     $G "$(bash_event "pkill -f '[n]ode'")"
deny  "bash-guard: --root /"                  $G "$(bash_event 'npx vitest run --root /')"
allow "bash-guard: quoted text is ignored"    $G "$(bash_event 'git commit -m "no cd /usr here"')"
allow "bash-guard: plain command"             $G "$(bash_event 'ls -la')"
allow "bash-guard: && inside quotes is text"  $G "$(bash_event 'echo "x && cd /usr && y"')"
deny  "bash-guard: real && after quoted text" $G "$(bash_event 'echo "a && b" && cd /usr')"
allow "bash-guard: subshell cd with quotes"   $G "$(bash_event '( cd /usr && echo "a; b" )')"
big="$(head -c 300000 /dev/zero | tr '\0' a)"
allow "bash-guard: skips a 300 KB command"    $G "$(bash_event "cd /usr && echo $big")"
no_deny "bash-guard: empty stdin"             $G ''
hd_script=$'cat > install.sh <<\'EOF\'\ncd /opt/app\nfind / -name x\nEOF'
allow "bash-guard: heredoc body is text"           $G "$(bash_event "$hd_script")"
allow "bash-guard: heredoc, then a plain command"  $G "$(bash_event "$hd_script"$'\nls')"
deny  "bash-guard: real cd after a heredoc"        $G "$(bash_event "$hd_script"$'\ncd /usr')"

# --- quiet-output
G=quiet-output.py
contains "quiet-output: wraps npm test"       $G "$(bash_event 'npm test')" '"updatedInput"'
allow    "quiet-output: leaves a pipe alone"  $G "$(bash_event 'npm test | tail -5')"
allow    "quiet-output: leaves ls alone"      $G "$(bash_event 'ls')"
allow    "quiet-output: ignores a null event" $G 'null'
allow    "quiet-output: ignores null tool_input" $G '{"tool_name":"Bash","tool_input":null}'
if command -v make > /dev/null; then # run the rewritten command: exit code and error text must survive
  wrapped="$(printf '%s' "$(bash_event 'make -f /nonexistent')" | python3 "$H/$G" | jq -r '.hookSpecificOutput.updatedInput.command')"
  out="$(bash -c "$wrapped" 2>&1)"
  rc=$?
  [ "$rc" -eq 2 ] && check "quiet-output: wrapped command keeps its exit code" 0 "" || check "quiet-output: wrapped command keeps its exit code" 1 "rc=$rc"
  case "$out" in *'No such file'*) check "quiet-output: wrapped command shows the error" 0 "" ;; *) check "quiet-output: wrapped command shows the error" 1 "$out" ;; esac
fi

# --- premise-guard
G=premise-guard.py
fail_event() { jq -nc --arg c "$1" '{tool_name:"Bash",session_id:"s1",hook_event_name:"PostToolUseFailure",tool_input:{command:$c}}'; }
ok_event()   { jq -nc --arg c "$1" '{tool_name:"Bash",session_id:"s1",hook_event_name:"PostToolUse",tool_input:{command:$c}}'; }
allow    "premise-guard: 1st failure"         $G "$(fail_event 'pytest -x')"
allow    "premise-guard: 2nd failure"         $G "$(fail_event 'pytest -x')"
contains "premise-guard: 3rd failure warns"   $G "$(fail_event 'pytest -x')" 'principle-attack-the-premise'
allow    "premise-guard: success resets"      $G "$(ok_event 'pytest -x')"
allow    "premise-guard: 1st failure again"   $G "$(fail_event 'pytest -x')"
if [ -n "$(find "$HOME/.claude/state/desustack" -name '*.json' 2>/dev/null | head -1)" ]; then
  check "premise-guard: state file exists while a gate is failing" 0 ""
else
  check "premise-guard: state file exists while a gate is failing" 1 "no state file"
fi
allow    "premise-guard: success clears the state" $G "$(ok_event 'pytest -x')"
if [ -z "$(find "$HOME/.claude/state/desustack" -name '*.json' 2>/dev/null | head -1)" ]; then
  check "premise-guard: state file removed when clean" 0 ""
else
  check "premise-guard: state file removed when clean" 1 "state file left behind"
fi
printf '%s' "$(fail_event 'pytest -x')" | CLAUDE_CONFIG_DIR="$T/cfg" run $G > /dev/null
if [ -n "$(find "$T/cfg/state/desustack" -name '*.json' 2>/dev/null | head -1)" ]; then
  check "premise-guard: state follows CLAUDE_CONFIG_DIR" 0 ""
else
  check "premise-guard: state follows CLAUDE_CONFIG_DIR" 1 "no state under the custom dir"
fi
for _ in 1 2 3; do # a gate word inside a commit message must not count as a gate
  out="$(printf '%s' "$(fail_event 'git commit -m "fix tsc errors"')" | run $G)"
  [ -z "$out" ] || break
done
[ -z "$out" ] && check "premise-guard: a gate word inside quotes is not a gate" 0 "" || check "premise-guard: a gate word inside quotes is not a gate" 1 "$out"

# --- implement-review-gate
G=implement-review-gate.py
armed="$T/armed.jsonl"
printf '%s\n' '{"type":"user","message":{"content":"<command-name>/mattpocock-skills:implement</command-name>"}}' > "$armed"
reviewed="$T/reviewed.jsonl"
cp "$armed" "$reviewed"
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"mattpocock-skills:code-review"}}]}}' >> "$reviewed"
bare="$T/bare.jsonl"
printf '%s\n' '{"type":"user","message":{"content":"<command-name>/implement</command-name>"}}' > "$bare"
briefed="$T/briefed.jsonl"
printf '%s\n' '{"type":"user","message":{"content":"do the work\nREVIEW-GATE: mattpocock-skills:code-review\n"}}' > "$briefed"
none="$T/none.jsonl"
printf '%s\n' '{"type":"user","message":{"content":"hello"}}' > "$none"
listform="$T/listform.jsonl"
printf '%s\n' '{"type":"user","message":{"content":[{"type":"text","text":"<command-name>/mattpocock-skills:implement</command-name>"}]}}' > "$listform"
deny  "gate: commit after /implement, no review" $G "$(bash_event 'git commit -m x' /tmp "$armed")"
allow "gate: commit after the review ran"        $G "$(bash_event 'git commit -m x' /tmp "$reviewed")"
allow "gate: a bare /implement does not arm it"  $G "$(bash_event 'git commit -m x' /tmp "$bare")"
deny  "gate: brief marker arms it"               $G "$(bash_event 'git commit -m x' /tmp "$briefed")"
allow "gate: commit without /implement"          $G "$(bash_event 'git commit -m x' /tmp "$none")"
deny  "gate: /implement sent as a list of blocks"  $G "$(bash_event 'git commit -m x' /tmp "$listform")"
allow "gate: non-commit command"                 $G "$(bash_event 'ls' /tmp "$armed")"
no_deny "gate: fails open without transcript_path" $G '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}'

# --- advisor-leak-audit
G=advisor-leak-audit.py
sub="$T/sub.jsonl"
printf '%s\n' '{"content":[{"type":"advisor_tool_result"}]}' > "$sub"
event="$(jq -nc --arg p "$sub" '{agent_transcript_path:$p,agent_type:"Explore",agent_id:"a1"}')"
contains "advisor-audit: warns on a call"     $G "$event" 'Advisor leak'
grep -q 'calls=1' "$HOME/.claude/advisor-leaks.log" && check "advisor-audit: writes the log" 0 "" || check "advisor-audit: writes the log" 1 ""
allow    "advisor-audit: no call, no output"  $G "$(jq -nc --arg p "$none" '{agent_transcript_path:$p}')"
allow    "advisor-audit: ignores empty stdin" $G ''
allow    "advisor-audit: ignores a null event" $G 'null'
yes 'x calls=1' | head -n 120000 > "$HOME/.claude/advisor-leaks.log" # about 1.2 MB
printf '%s' "$event" | python3 "$H/$G" > /dev/null
lines="$(wc -l < "$HOME/.claude/advisor-leaks.log")"
[ "$lines" -le 1001 ] && check "advisor-audit: trims a big log" 0 "" || check "advisor-audit: trims a big log" 1 "$lines lines"

# --- skills lint: the checks that would have caught the router and rename bugs
SK="$(cd "$H/../skills" && pwd)"

bad=""
for d in "$SK"/*/; do
  n="$(basename "$d")"
  name="$(sed -n 's/^name:[[:space:]]*"\{0,1\}\([^"]*[^"[:space:]]\)"\{0,1\}[[:space:]]*$/\1/p' "$d/SKILL.md" | head -n 1)"
  [ "$name" = "$n" ] || bad="$bad $n(name=$name)"
done
[ -z "$bad" ] && check "skills: frontmatter name matches the folder" 0 "" || check "skills: frontmatter name matches the folder" 1 "$bad"

bad=""
while IFS= read -r hit; do
  f="${hit%%:*}"; target="${hit#*](}"; target="${target%)}"
  [ -f "$(dirname "$f")/$target" ] || bad="$bad ${f#"$SK"/}->$target"
done < <(grep -rHEo '\]\(\.\./[a-z0-9-]+/SKILL\.md\)' "$SK" --include='*.md')
[ -z "$bad" ] && check "skills: no broken ../x/SKILL.md links" 0 "" || check "skills: no broken ../x/SKILL.md links" 1 "$bad"

stale="$(grep -rlE 'pr-flow|prosa-ptbr' "$SK" 2>/dev/null | tr '\n' ' ')"
[ -z "$stale" ] && check "skills: no stale pr-flow or prosa-ptbr names" 0 "" || check "skills: no stale pr-flow or prosa-ptbr names" 1 "$stale"

bad=""
for p in $(grep -E '^(\||Always on)' "$SK/principles/SKILL.md" | grep -oE '`principle-[a-z0-9-]+`' | tr -d '`' | sort -u); do
  [ -f "$SK/$p/SKILL.md" ] || { bad="$bad $p(missing)"; continue; }
  awk 'NR > 1 && /^---$/ { exit } /^disable-model-invocation:[[:space:]]*true/ { f = 1 } END { exit !f }' "$SK/$p/SKILL.md" && bad="$bad $p(user-only)"
done
[ -z "$bad" ] && check "skills: the router points only at skills the model can load" 0 "" || check "skills: the router points only at skills the model can load" 1 "$bad"

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
