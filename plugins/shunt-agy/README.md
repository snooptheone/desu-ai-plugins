# shunt-agy

A Claude Code plugin that shunts I/O-heavy work to a cheaper model, saving tokens on large
file reads and boilerplate generation.

Adapted from Spotify's [`shunt`](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt)
(Apache-2.0) — see their [engineering blog post](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90)
for the original idea and design rationale — swapping their internal Portal/AiKA delegation
for the [agy (Antigravity) CLI](https://antigravity.google/docs/cli) headless mode, so anyone
with `agy` installed can use it, no internal platform required. See [`/NOTICE`](../../NOTICE)
for exactly what was reused vs. rewritten. **Not affiliated with or endorsed by Spotify or
Google.**

## How it works

Three layers, from hard gate to soft suggestion:

1. **Hooks** block Claude from reading large files and redirect to the bulk-reader skill.
2. **Scripts** invoke `agy` headlessly and clean up its output.
3. **Skills** tell Claude when and how to call the scripts.

Claude never assembles bash pipelines from prose. It calls a script with named arguments.
The scripts handle everything internally. File contents / specs go to `agy`'s worker model
over stdin and never enter Claude's own context — only the final answer does.

## Prerequisites

- [`jq`](https://jqlang.org)
- [`agy`](https://antigravity.google/docs/cli) (Antigravity CLI), authenticated and on `PATH`
  (or point `AGY_BIN` at its binary)

## Plugin structure

```
shunt-agy/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   ├── hooks.json           # PreToolUse matchers for Read and Bash
│   ├── check-file-size      # Blocks Read on files > SHUNT_MIN_LINES
│   └── check-bash-read      # Blocks cat/head/tail on large files
├── scripts/
│   ├── lib/
│   │   └── worker.sh        # Shared agy invocation plumbing
│   ├── bulk-read            # Delegates reads to agy
│   └── code-write           # Delegates codegen to agy
└── skills/
    ├── bulk-reader/SKILL.md
    └── code-writer/SKILL.md
```

## Scripts

### bulk-read

```bash
bulk-read --question "What does this service do?" --paths src/Service.java src/Handler.java
```

Wraps each file in `<file path="...">` XML tags, sends them plus the question to `agy` in
one headless turn, and prints the answer.

### code-write

```bash
code-write --spec "Write tests for UserService" --reference tests/OrderTest.java --target tests/UserTest.java
```

`--reference` is required — without a file to match patterns against, the worker generates
context-free code that fits nothing in the project. Strips markdown fences from the output.

### One shot per call

Every invocation is a fresh, independent turn — no server-side conversation state to manage,
and no follow-up mechanism to worry about. Re-sending files on a follow-up question is free
where it matters: the corpus goes to the worker model, never into Claude's context.

## Hooks

### check-file-size (Read hook)

Fires on every `Read` call. Blocks full-file reads on files exceeding `SHUNT_MIN_LINES`
(default 350). Allows targeted reads (offset/limit set), files under the threshold, and
nonexistent files through.

### check-bash-read (Bash hook)

Fires on every `Bash` call. Catches `cat`/`head`/`tail`/`less`/`more` on large files. Allows
piped commands, redirections, and non-read commands through.

## Configuration

Environment variables — add them to the `env` block in `.claude/settings.json`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SHUNT_MIN_LINES` | `350` | Line count above which the Read/Bash hooks block and redirect |
| `AGY_BIN` | `agy` | Override how the Antigravity CLI is launched |
| `SHUNT_AGY_MODEL` | `gemini-3.8-flash-low` | Worker model passed to `agy --model` |
| `SHUNT_AGY_EFFORT` | (unset) | Reasoning effort passed to `agy --effort` — only set this for models that take effort separately from the model name (the flash models bake it into the name and reject `--effort` alongside them) |
| `SHUNT_MAX_PAYLOAD_BYTES` | `2000000` | Soft ceiling on message size before refusing to send |
| `SHUNT_TIMEOUT_SECONDS` | `180` | Passed to `agy --print-timeout` |

## What doesn't get delegated

- **Debugging** — requires Claude's reasoning, not a summary.
- **Editing** — Claude needs exact content in context; use targeted reads (offset/limit).
- **Small files** — delegation overhead exceeds savings under `SHUNT_MIN_LINES`.
- **Architectural decisions** — judgment calls stay on Claude.

## Testing

```bash
bash evals/run.sh
```

45 cases, no `agy` or network access needed (~1s to run): 17 `check-file-size` hook cases
and 17 `check-bash-read` hook cases (ported from Spotify's `shunt` evals — the hook logic
is unchanged, so the same edge cases apply: boundary lines, offset/limit bypass, env
overrides, quoted paths, pipes/redirects, nonexistent files), plus 11 `scripts/lib/worker.sh`
transport cases against a stubbed `agy` binary (success/error/malformed responses, the
oversized-payload guard, and regression cases for the two bugs this plugin hit while wiring
up the real agy: the `--effort`/model-name conflict, and the stream-json input/output
pairing).

## Benchmarks

```bash
cd evals && ./benchmark.sh
```

Runs the scenarios in `benchmarks.json` (fixtures ported from Spotify's `shunt` evals)
against the real `agy` CLI and reports chars/4 token estimates with vs without delegation.
Needs an authenticated `agy` on `PATH`; each scenario takes ~10-30s.

Measured with `gemini-3.8-flash-low` against the included fixtures (35-602 lines — small by
design, so treat these as a floor):

| Scenario | No shunt | With shunt | Savings |
|----------|----------|------------|---------|
| Single large file (602L) | 12,006 tok | 149 tok | 99% |
| Multi-file cross-read (3 files) | 12,686 tok | 479 tok | 96% |
| Source + test pair | 680 tok | 244 tok | 64% |
| Code generation | 680 tok (context only) | ~0, written to disk | n/a |

Savings scale with file size and question specificity — a real 4,000+ line file you'd
actually hit the 350-line hook threshold on should land closer to the single-large-file row
than the source+test-pair row.

## Known limitations

- **No enforcement for code-writer** — only bulk-reader has hook enforcement; code-writer
  relies on Claude recognizing when to use it via the skill description.
- **Model access** — `agy` must already be authenticated against whatever backend serves
  `SHUNT_AGY_MODEL`; this plugin doesn't manage credentials.
- The benchmark's "no-shunt" column only counts input tokens (reading the files). It excludes
  the *output* tokens Claude would otherwise pay to generate code inline, so the code-write
  row understates real savings for that scenario.
