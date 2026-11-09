---
name: principles
description: Use when designing new types, planning a migration, sweep or commit/PR sequence, writing a script that must be safe to retry (install.sh, Ansible, rsync), writing validation or boundary adapters (CLI, config, external API), refactoring or judging diff size, integrating a new requirement into a design, repeating the same instruction, choosing core data structures, or after repeated fixes failed the same test. Points to the right principle skill to read.
---

# Principles

Find the situation, read the named skill with the Skill tool, and apply it. One situation, one principle. Do not load any of them for a small edit.

| Situation | Read |
|---|---|
| Designing new types or reviewing a signature in a typed language. Does not apply to edits inside existing types. | `principle-type-system-discipline` |
| A migration, a sweep over many files, or planning the sequence of commits and PRs. | `principle-sequence-verifiable-units` |
| A script, command or loop that runs through crashes, restarts or retries (install.sh, Ansible, rsync, disk migration). | `principle-make-operations-idempotent` |
| Writing or reorganizing validation, error handling or boundary adapters (CLI, config, external API, network). | `principle-boundary-discipline` |
| Two or more fixes failed the same test or build. The `premise-guard` hook warns on the third failure in a row. | `principle-attack-the-premise` |
| Non-trivial work (edits, migrations, analyses, checks) that you would otherwise do by hand: build the script, codemod or generator that does it or proves it. | `principle-build-the-lever` |
| Refactoring, judging the size of a diff, or tempted to add an abstraction or a layer. | `principle-laziness-protocol` |
| Integrating a new requirement into an existing design. | `principle-redesign-from-first-principles` |
| Writing the same instruction a second time, or noticing a recurring correction. | `principle-encode-lessons-in-structure` |
| Before writing logic: choosing core types and data structures, sequencing scaffold work, or sharing state between concurrent actors. | `principle-foundational-thinking` |

Always on, outside this table: `principle-fix-root-causes` (debugging) and `principle-prove-it-works` (before declaring done).

User-only, run with `/name`: `principle-never-block-on-the-human` and `show-me-your-work`.

## Rules when applying boundary-discipline

1. Never cut validation that protects against data loss, security, money or an irreversible action, even when it looks redundant (issuing or cancelling a legal document, `rsync --delete`, filesystem or disk operations, any command that deletes). In those cases the guard also stays next to the effect, not only at the entry boundary.
2. The principle guides where to put guards. It does not authorize removing existing ones. To delete a check, list each one and the boundary that covers it today. Without proven coverage, the check stays.
3. Before dropping an internal check, run a test that sends invalid data through the boundary and shows the rejection there (`principle-prove-it-works`).
