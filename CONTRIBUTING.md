# Contributing

Issues and PRs are welcome, especially for `shunt-agy` (hook edge cases, agy CLI
compatibility, or portability to other worker models).

## Before opening a PR

```bash
bash plugins/shunt-agy/evals/run.sh
```

45 cases, no `agy` or network access needed, ~1s. CI runs this on every PR — a red build
means the PR isn't mergeable as-is.

If you have an authenticated `agy` CLI and want to sanity-check real token savings:

```bash
cd plugins/shunt-agy/evals && ./benchmark.sh
```

## If you're touching `hooks/` or `scripts/` under `plugins/shunt-agy`

Those files are adapted from Spotify's Apache-2.0 `shunt` plugin — see [`NOTICE`](NOTICE)
for exactly what was reused. If your change diverges further from the original, a one-line
note in the file's existing attribution header is enough; no need to touch `NOTICE` unless
the scope of what was reused actually changes.

## Style

- Bash, not Python/Node, for hooks and scripts — keeps the plugin dependency-free beyond
  `jq` and `agy`.
- No speculative configuration knobs. If you're adding an env var, it should solve a
  problem that exists today, not one that might exist for a model nobody's using yet
  (see the `AGENTS.md` "Known gotchas" section for the reasoning behind the knobs that
  already exist).
