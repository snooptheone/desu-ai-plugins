# desu-ai-plugins

A marketplace repo for Claude Code plugins. Currently ships two plugins:
`shunt-agy` and `unifi`.

## Repository structure

- `plugins/shunt-agy/` — the plugin itself: hooks, scripts, skills, and
  evals. See `plugins/shunt-agy/README.md` for what it does.
- `plugins/unifi/` — UniFi Network MCP server (`mcp/server.js`, one Node.js file, no
  dependencies) plus a skill. Read-only today. Any write capability must require the
  user's explicit, unambiguous approval for each change. Tests:
  `node --test plugins/unifi/tests/server.test.js`; CI runs them on Linux (Node 18 and 22) and
  must pass before a PR is merged. macOS and Windows are not tested yet.
- `.claude-plugin/marketplace.json` — exposes this repo as a Claude Code
  marketplace (`claude plugin marketplace add snooptheone/desu-ai-plugins`).
- `NOTICE` — third-party attribution. Read this before touching anything
  under `plugins/shunt-agy/hooks/` or `plugins/shunt-agy/scripts/` — those
  files are adapted from Spotify's Apache-2.0 `shunt` plugin.
- `LICENSE` — Apache License 2.0, applies to the whole repo.

## Design rules

- Additional plugins live under `plugins/<name>/` and get registered in
  `.claude-plugin/marketplace.json`.
- `shunt-agy` must keep working with only `jq` and an authenticated `agy`
  CLI as prerequisites — no dependency on any Spotify-internal tooling.
  That's the entire reason this fork exists instead of just using `shunt`.
- Preserve attribution: if you copy or closely mirror another Apache-2.0
  project's file (as `hooks/check-file-size`, `hooks/check-bash-read`, and
  the `bulk-read`/`code-write` scripts do from Spotify's `shunt`), keep the
  header comment noting where it came from and update `NOTICE` if the scope
  of what was reused changes.
- Don't imply Spotify or Google endorsement anywhere in docs or plugin
  metadata (descriptions, `author`, `homepage`). This is an independent,
  unaffiliated adaptation.

## Known gotchas (learned the hard way, don't re-break these)

- `agy --input-format stream-json` **requires** `--output-format
  stream-json` — mixing it with `--output-format json` fails. The worker
  script parses the NDJSON stream for the line where `.event == "result"`.
- `agy`'s Gemini Flash model names bake reasoning effort into the name
  itself (`gemini-3.8-flash-high|medium|low`). Passing `--effort` alongside
  one of those conflicts and agy rejects the call. `SHUNT_AGY_EFFORT` is
  left unset by default for exactly this reason — only set it for models
  that take effort as a separate parameter (e.g. `claude-sonnet-4-6`,
  `gpt-oss-120b-medium`).
- Hooks must print **nothing** to allow, and to block print
  `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
  "permissionDecisionReason": "..."}}`. The old `{"decision": "allow"|"block"}` shape is
  rejected by current Claude Code ("Hook JSON output validation failed").
- The worker's input travels over stdin as a single stream-json event
  (`{"event":"user","message":{"content": ...}}`), not argv — this avoids
  `ARG_MAX`/`MAX_ARG_STRLEN` limits that the original Portal-CLI-based
  `aika.sh` had to work around explicitly. Keep it this way; don't
  "simplify" back to passing content via `-p "<content>"`.

## Validation

```bash
# Hook + transport evals (45 cases, no agy access needed, ~1s):
bash plugins/shunt-agy/evals/run.sh

# End-to-end delegation + token-savings benchmark (needs authenticated agy):
cd plugins/shunt-agy/evals && ./benchmark.sh
```

`evals/run.sh` covers `check-file-size` and `check-bash-read` (17 cases each, ported from
Spotify's `shunt` evals) plus `scripts/lib/worker.sh`'s transport plumbing (11 cases against
a stubbed `agy` binary in `evals/transport-evals.sh`) — including regression cases for both
bugs already hit once in this repo (the `--effort`/model-name conflict, and stream-json
input requiring stream-json output). Run it before touching anything under `hooks/` or
`scripts/`.

CI (`.github/workflows/ci.yml`) runs `evals/run.sh` on every PR; it needs no `agy` auth.

`run.sh` also validates every hook's stdout against the PreToolUse schema Claude Code
accepts, so a format drift fails the suite even if allow/block still matches. That check
only proves the output matches *our copy* of the schema. An integration test against the
real `claude` CLI (load the plugin, read a >350-line file, confirm no "Hook JSON output
validation failed" in the log) is the only thing that catches the CLI changing its format.
It needs an authenticated `claude`, so it must be run **locally**, not in CI — do it
whenever Claude Code is upgraded or `hooks/` changes: `bash plugins/shunt-agy/evals/integration-test.sh`.
Exit 2 means inconclusive (the model never called Read after 3 tries), not a bug; exit 1 keeps
the raw streams in a temp dir whose path it prints. Exit 3 means the stream-json shape changed
(no tool_result or hook_response to inspect): update `first_tool_result`/`hook_decisions`.
