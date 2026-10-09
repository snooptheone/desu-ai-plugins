# unifi

A [Claude Code](https://claude.ai/claude-code) plugin that gives Claude a read-only view of your UniFi
Network, built only on the official [UniFi Network API](https://developer.ui.com/network) and the Site
Manager Connector. Ask who is on the network, what devices are online, or how a VLAN, SSID or firewall
policy is set up.

It is an MCP server (one Node.js file, no dependencies). Reading is the default and cannot change
anything. A few changes are available behind an option that is off by default; see [Changes](#changes).

This is an independent project, not affiliated with or endorsed by Ubiquiti Inc.

## Requirements

- Node.js 18 or later on your PATH. CI tests on Linux only; macOS and Windows are untested
- A UniFi console with firmware 5.0.3 or later
- A UniFi API key: a Site Manager key from https://unifi.ui.com/settings/api-keys (cloud mode), or an
  Integrations key created in your console's Network app (local mode)

## Install

```bash
claude plugin marketplace add snooptheone/desu-ai-plugins
claude plugin install unifi@desu-ai-plugins
```

When the plugin is enabled, Claude Code asks for the API key and keeps it in your system's secure
credential store. The key is passed to the server process and never appears in the conversation. Never
paste it into the chat.

Then ask something like "who is connected to my network?".

## Modes

| | Cloud (default) | Local |
|---|---|---|
| Key | Site Manager key | Integrations key from your console |
| Set | nothing else | `console_host`, for example `192.168.0.1` |
| Path | `api.ui.com` Connector, 100 requests/minute, needs internet | Straight to the console on your LAN |
| TLS | Normal verification | **Verification is skipped**: the console's certificate is self-signed |

In local mode the key travels over a connection whose certificate is not checked, so anyone who can
intercept traffic on your LAN could read it. Use it on a network you trust, and give the key an
expiration date.

## Configuration

| Where | Purpose |
|---|---|
| Plugin option `api_key` | Your API key (asked on enable, stored securely) |
| Plugin option `console_host` | Console IP or hostname for local mode. Empty means cloud mode |
| Env `UNIFI_CONSOLE_ID` | Cloud mode: console to use when the account has more than one |

## Development

```bash
node --test plugins/unifi/tests/server.test.js
```

The tests start the server against a local fake API; they need no network and no key.

## Changes

Turn on the plugin option `enable_writes` ("Allow changes") to get these tools. Without it they do not
exist.

| Tool | Does |
|---|---|
| `unifi_plan_restart_device` | Restart an AP, switch or gateway |
| `unifi_plan_set_firewall_policy` | Enable/disable a user-defined firewall policy, or its logging |
| `unifi_plan_update_traffic_list` | Replace the items of a port or IP list |
| `unifi_apply_change` | Apply a plan |

Every change takes two steps. A `plan` tool changes nothing and returns a summary, a one-use approval
code (valid for 5 minutes) and a confirmation phrase. `unifi_apply_change` runs only with that code, the
exact phrase, and a resource that is unchanged since the plan. It is marked destructive, so Claude Code
shows you the call, with the phrase, in its permission prompt: do not add it to an allow list. The skill
also tells Claude to ask you in the chat first.

Each attempt and its result are appended to `changes.jsonl` in the plugin's data directory
(`~/.claude/plugins/data/…`), with the resource as it was before. The change is not applied if the log
cannot be written. Undoing a change is manual: the log has the previous state.

The official API limits what can change. It cannot block a client, and firewall policies created by the
system cannot be enabled or disabled. Prefer a key with an expiration date.

## Known limitations

- Few write operations; see [Changes](#changes). Approval codes live in memory, so restarting Claude Code discards pending plans.
- Local mode does not verify the console's certificate.
