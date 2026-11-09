#!/usr/bin/env python3
"""PreToolUse (Bash): deny four commands that waste a session.

- `cd DIR` that goes down or sideways: the shell's cwd persists across Bash calls, so the rest of the
  session runs from DIR (it once ended inside node_modules). Going up or staying put is allowed.
- `pkill -f PATTERN` without a bracketed char (`[s]low`): the pattern also matches the Bash shell
  running the command, so it kills itself and the call returns exit 144 with nothing stopped.
- `find /`: walks the whole filesystem (/proc, /sys, every mount) and times out after 120 s.
- `--root /` (vitest and friends): same walk through the test runner.
Only a command in command position is checked, so a commit message quoting these is left alone,
and so is the body of a heredoc (a script being written is text, not commands).
"""
import json, os, re, shlex, sys

SEGMENT = re.compile(r"\|\||&&|[;|\n]")
SEPARATORS = set(";&|\n")
MAX_CHARS = 200_000
# The body of a heredoc is text (often a script being written), not commands to run.
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?\n[ \t]*\2[ \t]*(?:\n|$)", re.S)


def drop_heredoc_bodies(command):
    """Keep the line that opens each heredoc and drop its body."""
    return HEREDOC.sub(lambda m: m.group(0).split("\n", 1)[0] + "\n", command)


def segments(command):
    """Command segments split at ; & | && || and newlines, but not inside quotes.
    Raises ValueError on unbalanced quotes; the caller then falls back to a plain regex split."""
    lex = shlex.shlex(command, posix=True, punctuation_chars=";&|\n")
    lex.whitespace = " \t\r"  # newline is a separator, not whitespace
    lex.whitespace_split = True
    seg = []
    for tok in lex:
        if set(tok) <= SEPARATORS:
            if seg:
                yield seg
            seg = []
        else:
            seg.append(tok)
    if seg:
        yield seg


def reason(tokens, cwd=""):
    name = tokens[0]
    rest = tokens[1:]
    if name == "cd" and cwd:
        # The cwd persists between Bash calls: `cd sub && cmd` leaves the session inside sub.
        # Going up to the current folder or an ancestor (fixing drift) passes; going down or elsewhere needs a subshell.
        args = [t for t in rest if not t.startswith("-")]
        target = os.path.expanduser(os.path.expandvars(args[0])) if args else os.path.expanduser("~")
        if "$" not in target:
            target = os.path.realpath(os.path.join(cwd, target))
            here = os.path.realpath(cwd)
            if not (here == target or here.startswith(target.rstrip("/") + "/")):
                return (
                    f"`cd {args[0] if args else ''}` changes the directory of ALL later Bash calls. "
                    "Use `( cd dir && command )`, `git -C dir`, `npm --prefix dir` or an absolute path."
                )
    if name == "pkill":
        flags = [t for t in rest if t.startswith("-") and not t.startswith("--")]
        patterns = [t for t in rest if not t.startswith("-")]
        if any("f" in f[1:] for f in flags) and patterns and not any("[" in p for p in patterns):
            return (
                "`pkill -f` without a bracket matches the command line of the shell itself and kills it (exit 144). "
                "Use `pkill -f '[s]low-stub'` (bracket in the pattern) or, better, `fuser -k PORT/tcp`, "
                "and run the teardown in a call of its own."
            )
    if name == "find":
        paths = []
        for t in rest:
            if t.startswith("-") or t in ("(", "!"):
                break
            paths.append(t)
        if "/" in paths and "-maxdepth" not in rest:  # with -maxdepth it ends at once
            return "`find /` walks the whole disk and times out. Start from the repository or a specific directory."
    for i, t in enumerate(tokens):
        if t == "--root=/" or (t == "--root" and i + 1 < len(tokens) and tokens[i + 1] == "/"):
            return "`--root /` makes the runner walk the whole disk. Run from inside the package (e.g. `( cd backend && npx vitest run <file> )`)."
    return None


try:
    d = json.load(sys.stdin)
    if d.get("tool_name") != "Bash":
        sys.exit(0)
    command = (d.get("tool_input") or {}).get("command", "")
    if len(command) > MAX_CHARS:
        sys.exit(0)  # shortcut: shlex is quadratic on one huge word; skip the check past 200 KB
    command = drop_heredoc_bodies(command)
    try:
        token_lists = list(segments(command))
    except ValueError:
        token_lists = []
        for segment in SEGMENT.split(command):
            try:
                token_lists.append(shlex.split(segment))
            except ValueError:
                continue
    for tokens in token_lists:
        while tokens and re.fullmatch(r"\w+=\S*", tokens[0]):
            tokens.pop(0)  # VAR=val prefix
        found = reason(tokens, d.get("cwd") or "") if tokens else None
        if found:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": found,
            }}))
            break
except SystemExit:
    pass
except Exception:
    pass  # fail open: a broken guard must never block unrelated work
