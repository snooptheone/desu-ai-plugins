# Contributing

Issues and PRs are welcome, especially for `shunt-agy` (hook edge cases, agy CLI
compatibility, or portability to other worker models).

## Before opening a PR

```bash
bash plugins/shunt-agy/evals/run.sh
bash plugins/desustack/tests/run.sh
```

The second line is the `desustack` hook evals; it needs `python3` and `jq`. Neither run needs `agy` or
network access (~1s each). CI runs both on every PR — a red build means the PR isn't mergeable as-is.

If you have an authenticated `agy` CLI and want to sanity-check real token savings:

```bash
bash plugins/shunt-agy/evals/benchmark.sh
```

## Bump the version when a plugin changes

Installed copies only update when the version changes. If a PR changes anything that ships
in a plugin (hooks, scripts, skills including `SKILL.md`, MCP server code, manifests), raise
`version` in both `plugins/<name>/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
CI fails the PR otherwise. Changes limited to `evals/`, `tests/` or the plugin `README.md`
don't need a bump.

## If you're touching `hooks/` or `scripts/` under `plugins/shunt-agy`

Those files are adapted from Spotify's Apache-2.0 `shunt` plugin — see [`NOTICE`](NOTICE)
for exactly what was reused. If your change diverges further from the original, a one-line
note in the file's existing attribution header is enough; no need to touch `NOTICE` unless
the scope of what was reused actually changes.

## Style

- Bash, not Python/Node, for hooks and scripts — keeps the plugin dependency-free beyond
  `jq` and `agy`. This rule is for `shunt-agy`. The `desustack` hooks are Python 3 and need only
  `python3` on the PATH; `unifi` is Node. A new plugin may pick its own language, and its README
  must say what it requires.
- No speculative configuration knobs. If you're adding an env var, it should solve a
  problem that exists today, not one that might exist for a model nobody's using yet
  (see the `AGENTS.md` "Known gotchas" section for the reasoning behind the knobs that
  already exist).
