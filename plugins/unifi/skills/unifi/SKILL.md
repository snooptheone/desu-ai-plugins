---
name: unifi
description: >
  Read-only view of the user's UniFi network through the official UniFi Network API:
  connected clients, devices and their stats, networks/VLANs, WiFi SSIDs, firewall
  policies and zones, DNS policies, WANs and VPN. Use when the user asks who is on the
  network, what devices are online, how the network is configured, or about firewall,
  WiFi, VLAN or VPN settings, even if they do not say "UniFi".
---

# UniFi (read-only)

Everything goes through one script. It only sends GET requests, so nothing here can change the
network. If the user asks for a change (block a device, edit a rule, restart an AP), say this skill
is read-only and describe what they would do in the UniFi UI.

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/unifi.py <resource> [id] [--site SITE] [--json]
```

| Resource | Shows |
|---|---|
| `info`, `sites` | Network app version; sites (the script auto-picks the only one) |
| `devices`, `device-stats <deviceId>`, `pending-devices` | Managed devices; latest stats of one; devices waiting for adoption |
| `clients` | Connected clients |
| `networks`, `wifi` | Networks/VLANs; WiFi broadcasts (SSIDs) |
| `firewall-policies`, `firewall-zones`, `acl-rules` | Firewall |
| `dns`, `wans`, `traffic-lists` | DNS policies, WAN links, traffic matching lists |
| `vpn-servers`, `vpn-tunnels` | VPN |
| `get <path>` | Any other GET path under `/v1`, for example `get /dpi/categories` |

Lists are fetched in full (200 per page). `--json` prints compact JSON; the default is indented.
Filter large output with `python3 -c`/`jq` instead of reading it all, and summarize the fields the
question needs.

## Setup (once)

1. Create an API key at https://unifi.ui.com/settings/api-keys.
2. Make it available to the script: `export UNIFI_API_KEY=...` in the shell that starts Claude Code, or
   save it to `~/.config/unifi-skill/api-key` with `chmod 600`. Never paste the key into the chat.
3. Test: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/unifi.py info` prints the Network version.

If there are several consoles set `UNIFI_CONSOLE_ID`; for several sites pass `--site`.

## Notes

- The API goes through the cloud Site Manager Connector, which allows 100 requests per minute and
  needs console firmware 5.0.3 or later. The script makes one request per 200 rows.
- Client and device output includes MAC and IP addresses. Show only what the question needs.
- Reference: the OpenAPI document at `https://developer.ui.com/network/<version>/openapi.json`.
