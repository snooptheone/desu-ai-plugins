# unifi

A [Claude Code](https://claude.ai/claude-code) plugin that gives Claude a read-only view of your UniFi
Network, built only on the official [UniFi Network API](https://developer.ui.com/network) and the Site
Manager Connector. Ask who is on the network, what devices are online, or how a VLAN, SSID or firewall
policy is set up.

It is an MCP server (one Node.js file, no dependencies) that sends GET requests only. Writes are not
implemented yet; when they are, they will need your explicit approval for each change.

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

## Known limitations

- Read-only for now.
- Local mode does not verify the console's certificate.
