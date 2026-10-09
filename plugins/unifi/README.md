# unifi

A read-only Claude Code plugin for UniFi Network, built only on the official
[UniFi Network API](https://developer.ui.com/network) and the Site Manager Connector. Ask Claude who
is on the network, what devices are online, or how a VLAN, SSID or firewall policy is set up.

It sends GET requests only. There is no code that creates, changes or deletes anything.

This is an independent project, not affiliated with or endorsed by Ubiquiti Inc.

## Install

```bash
claude plugin marketplace add snooptheone/desu-ai-plugins
claude plugin install unifi@desu-ai-plugins
```

Create an API key at https://unifi.ui.com/settings/api-keys, then either export it in the shell that
starts Claude Code:

```bash
export UNIFI_API_KEY=...
```

or save it in a file only you can read:

```bash
mkdir -p ~/.config/unifi-skill && install -m 600 /dev/null ~/.config/unifi-skill/api-key
read -rs K && printf '%s\n' "$K" > ~/.config/unifi-skill/api-key && unset K
```

Never paste the key into the chat. Then ask Claude something like "who is connected to my network?".

## Configuration

| Variable | Purpose |
|---|---|
| `UNIFI_API_KEY` | API key. Wins over the key file |
| `UNIFI_API_KEY_FILE` | Key file (default `~/.config/unifi-skill/api-key`, must be mode 600) |
| `UNIFI_CONSOLE_ID` | Console to use when the account has more than one |

Requests go through `api.ui.com`, limited to 100 per minute per console. Requires Python 3.9+ and
console firmware 5.0.3 or later.

## Running the script directly

```bash
python plugins/unifi/scripts/unifi.py clients
python plugins/unifi/scripts/unifi.py networks --json
python plugins/unifi/scripts/unifi.py get /dpi/categories
python plugins/unifi/scripts/unifi.py --help        # all resources
```

## Known limitations

- Read-only by design. Writes (block a client, edit a rule) are not implemented.
- Uses the cloud Connector, so it needs internet access. Direct access to `https://<console>/proxy/network/integration`
  is not implemented.
