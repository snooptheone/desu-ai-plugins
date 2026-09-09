# desu-ai-plugins

A marketplace repo for Claude Code plugins. Currently ships one plugin:
`shunt-agy`.

## Repository structure

- `plugins/shunt-agy/` — the plugin itself: hooks, scripts, skills, and
  evals. See `plugins/shunt-agy/README.md` for what it does.
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

There is no automated CI yet — wiring `bash plugins/shunt-agy/evals/run.sh` into a GitHub
Action on every PR (no `agy` auth needed) is still open; see the plugin README's
"Known limitations" section.
