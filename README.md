# desu-ai-plugins

[![CI](https://github.com/snooptheone/desu-ai-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/snooptheone/desu-ai-plugins/actions/workflows/ci.yml)

A small marketplace of Claude Code plugins.

## Plugins

### [shunt-agy](plugins/shunt-agy)

Shunts I/O-heavy Claude Code work — bulk file reads and boilerplate
generation — to a cheaper worker model via the [`agy` (Antigravity)
CLI](https://antigravity.google/docs/cli), instead of paying frontier-model
tokens to read large files or write predictable code.

Hooks block `Read`/`cat`/`head`/`tail` on files over a line-count threshold
and redirect Claude to two scripts (`bulk-read`, `code-write`) that delegate
the work to `agy`'s headless mode. File contents and generation specs go to
the worker model over stdin and never enter Claude's own context — only the
final answer does.

Measured savings on the bundled benchmark fixtures: **96–99%** on large/
multi-file reads, **64%** on a small source+test pair (see
[`plugins/shunt-agy/README.md`](plugins/shunt-agy/README.md#benchmarks) for
how to reproduce these numbers yourself).

### [unifi](plugins/unifi)

Your UniFi network in Claude — clients, devices and their stats, networks/VLANs, WiFi,
firewall policies, DNS and VPN — through the official UniFi Network API. Reading is the default; a few
changes are available behind an option that is off by default and need your explicit approval each time. See [`plugins/unifi/README.md`](plugins/unifi/README.md).

## Installation

```bash
claude plugin marketplace add snooptheone/desu-ai-plugins
claude plugin install shunt-agy@desu-ai-plugins
claude plugin install unifi@desu-ai-plugins
```

See [`plugins/shunt-agy/README.md`](plugins/shunt-agy/README.md) for
prerequisites (`jq`, an authenticated `agy` CLI) and configuration.

## Credit

`shunt-agy` is an independent adaptation of Spotify's **shunt** plugin. All
credit for the original idea — routing I/O-heavy agent work to a cheaper
worker model, enforced via hooks rather than relying on the main model to
volunteer for it — goes to the Spotify engineering team:

- Blog post: [Portal by Spotify: Cut My Claude Code Token Usage by 90%](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90)
- Original plugin: [spotify/portal-ai-plugins](https://github.com/spotify/portal-ai-plugins) (`plugins/shunt`)

`shunt-agy` exists because that plugin's delegation target — Spotify's
internal Portal CLI / AiKA mode registry — isn't available outside Spotify.
This repo keeps the same three-layer design (hooks → scripts → skills) but
retargets delegation at the publicly available `agy` CLI, so anyone can use
it. See [`NOTICE`](NOTICE) for the detailed list of what was reused,
copied, and changed.

This project is **not affiliated with, endorsed by, or sponsored by
Spotify AB or Google LLC**.

## AI assistance disclosure

Substantial parts of this repository — the `shunt-agy` adaptation itself, the `unifi` plugin, its tests
(`evals/`), CI setup, and documentation — were written with AI assistance (Claude Code).
Design decisions, testing, and review were done by a human; see the commit history and
[`AGENTS.md`](AGENTS.md) for what was verified along the way (real end-to-end runs against
the `agy` CLI, not just generated code taken on faith).

## License

Apache License 2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
