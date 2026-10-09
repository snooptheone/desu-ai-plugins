# unifi

A [Claude Code](https://claude.ai/claude-code) plugin that gives Claude a read-only view of your UniFi
Network, built only on the official [UniFi Network API](https://developer.ui.com/network) and the Site
Manager Connector. Ask who is on the network, what devices are online, or how a VLAN, SSID or firewall
policy is set up.

It is an MCP server (one Node.js file, no dependencies) that sends GET requests only. Writes are not
implemented yet; when they are, they will need your explicit approval for each change.

This is an independent project, not affiliated with or endorsed by Ubiquiti Inc.

## Requirements

- Node.js 18 or later on your PATH (CI runs on Linux, macOS and Windows)
- A UniFi console with firmware 5.0.3 or later
- A UniFi API key from https://unifi.ui.com/settings/api-keys

## Install

```bash
claude plugin marketplace add snooptheone/desu-ai-plugins
claude plugin install unifi@desu-ai-plugins
```

When the plugin is enabled, Claude Code asks for the API key and keeps it in your system's secure
credential store. The key is passed to the server process and never appears in the conversation. Never
paste it into the chat.

Then ask something like "who is connected to my network?".

## Configuration

| Where | Purpose |
|---|---|
| Plugin option `api_key` | Your API key (asked on enable, stored securely) |
| Env `UNIFI_CONSOLE_ID` | Console to use when the account has more than one |

Requests go through `api.ui.com`, limited to 100 per minute per console.

## Development

```bash
node --test plugins/unifi/tests/server.test.js
```

The tests start the server against a local fake API; they need no network and no key.

## Known limitations

- Read-only for now.
- Uses the cloud Connector, so it needs internet access. Direct access to
  `https://<console>/proxy/network/integration` is not implemented.
