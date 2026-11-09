# desustack

Engineering skills, guardrail hooks and one read-only agent for Claude Code.

## Skills

**Pull requests** (from [t3dotgg/tstack](https://github.com/t3dotgg/tstack))

| Skill | Use it to |
|---|---|
| `modernize` | Rebase an old PR and decide whether it should still exist (`MODERNIZE`, `REWORK` or `CLOSE`). |
| `takeover` | Finish someone else's PR, branch or agent thread and keep their credit. |
| `leaving-pr-comments` | Mark comments an agent posts on your behalf with a "responding on behalf of" note. |

None of them pushes, posts or merges on its own. Each outward step needs your request in that turn.

**Engineering** (from [pstack](https://github.com/cursor/plugins/tree/main/pstack))

| Skill | Use it to |
|---|---|
| `unslop` | Cut signs of AI-written text from technical docs. |
| `blast-radius` | Find what a change could break somewhere else before it ships. |
| `correct` | Find the mistakes agents keep repeating in a repo and make each one impossible. |
| `create-verification-skill` | Generate a project-local skill that drives the app the way a user does. |
| `figure-it-out` | Design an auditable playbook when no narrower skill fits. |
| `in-your-own-words` | Restate the user's goals and problem before acting. |
| `show-me-your-work` | Keep a reviewable decision log for long or unattended work. |
| `typescript-best-practices` | Apply TypeScript conventions when reading or editing `.ts` and `.tsx`. |
| `principle-attack-the-premise`, `principle-boundary-discipline`, `principle-build-the-lever`, `principle-encode-lessons-in-structure`, `principle-fix-root-causes`, `principle-foundational-thinking`, `principle-laziness-protocol`, `principle-make-operations-idempotent`, `principle-never-block-on-the-human`, `principle-prove-it-works`, `principle-redesign-from-first-principles`, `principle-sequence-verifiable-units`, `principle-type-system-discipline` | One principle each. |

`principles` is original to this repo: a router that tells Claude which principle skill to read for the situation at hand.

## Hooks

All hooks are Python 3 scripts with no dependencies. Enabling the plugin enables all of them.

| Hook | Event | Effect |
|---|---|---|
| `quiet-output` | PreToolUse (Bash) | Wraps noisy build, test and install commands so only errors, warnings and the summary come back. Rewrites the command. |
| `implement-review-gate` | PreToolUse (Bash) | Denies `git commit` after `/mattpocock-skills:implement` until `mattpocock-skills:code-review` has run. Only the full skill name arms it. Needs the `mattpocock-skills` plugin. |
| `bash-guard` | PreToolUse (Bash) | Denies `cd` into another directory, `pkill -f` without a bracketed pattern, `find /` and `--root /`. |
| `hooks-write-guard` | PreToolUse (Bash) | Denies a Bash command that writes to `~/.claude/hooks`. It matches the path in the raw command text, not a shell parse, so a script that builds the path at run time slips through. |
| `premise-guard` | PostToolUse, PostToolUseFailure (Bash) | After the third failure in a row of the same test or build command, points to `principle-attack-the-premise`. Keeps its counter in `<config dir>/state/desustack`. |
| `advisor-leak-audit` | SubagentStop | Warns, and appends to `<config dir>/advisor-leaks.log` (trimmed to 1000 lines past 1 MB), when a subagent called the advisor tool. |

`<config dir>` is `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`.

Run the hook evals with `bash plugins/desustack/tests/run.sh` (needs `python3` and `jq`).

## Agent

`Explore`: read-only search agent pinned to `claude-haiku-5-5`. Edit the `model` line in `agents/Explore.md` if that model is not available to you.

Plugin agents are namespaced, so this one is called `desustack:Explore` and does not replace the built-in `Explore`. To make the plain name `Explore` use these settings, copy `agents/Explore.md` to `~/.claude/agents/Explore.md`.

## Requirements

- `python3` on the PATH. The hooks are Python 3 scripts run directly through their shebang.
- Linux and macOS. Windows is untested: a `.py` file is not run through a shebang there.

## Install

```bash
claude plugin marketplace add snooptheone/desu-ai-plugins
claude plugin install desustack@desu-ai-plugins
```

If you already run any of these hooks from your own `settings.json`, remove those entries after enabling the plugin. Otherwise each hook runs twice: `premise-guard` warns twice and `advisor-leak-audit` logs each leak twice.

## Credit

The pull-request skills are adapted from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT, Theo Browne). The engineering skills are adapted from pstack by Lauren Tan, in [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack) (MIT). See [`NOTICE`](../../NOTICE), [`LICENSE-tstack`](LICENSE-tstack) and [`LICENSE-pstack`](LICENSE-pstack).
