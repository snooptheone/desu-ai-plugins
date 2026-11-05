# pr-flow

Three skills for working with pull requests. No hooks, scripts or dependencies.

| Skill | Use it to |
|---|---|
| `modernize` | Rebase an old PR and decide whether it should still exist (`MODERNIZE`, `REWORK` or `CLOSE`). |
| `takeover` | Finish someone else's PR, branch or agent thread and keep their credit. |
| `leaving-pr-comments` | Mark comments an agent posts on your behalf with a "responding on behalf of" note. |

None of them pushes, posts or merges on its own. Each outward step needs your
request in that turn.

## Install

```bash
claude plugin marketplace add snooptheone/desu-ai-plugins
claude plugin install pr-flow@desu-ai-plugins
```

## Credit

Adapted from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT). See
[`NOTICE`](../../NOTICE) and [`LICENSE-tstack`](LICENSE-tstack).
