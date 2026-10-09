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

Use the `unifi_*` tools of the plugin's MCP server. They only send GET requests, so nothing here can
change the network. If the user asks for a change (block a device, edit a rule, restart an AP), say this
plugin is read-only for now and describe what they would do in the UniFi UI.

| Tool | Shows |
|---|---|
| `unifi_info`, `unifi_sites` | Network app version; sites (the only site is picked automatically) |
| `unifi_devices`, `unifi_device_stats`, `unifi_pending_devices` | Managed devices; latest stats of one device (needs `deviceId`); devices waiting for adoption |
| `unifi_clients` | Connected clients |
| `unifi_networks`, `unifi_wifi` | Networks/VLANs; WiFi broadcasts (SSIDs) |
| `unifi_firewall_policies`, `unifi_firewall_zones`, `unifi_acl_rules` | Firewall |
| `unifi_dns_policies`, `unifi_wans`, `unifi_traffic_lists` | DNS policies, WAN links, traffic matching lists |
| `unifi_vpn_servers`, `unifi_vpn_tunnels` | VPN |
| `unifi_get` | Any other GET path under `/v1`, for example `/dpi/categories` |

- List tools return every item. Pass `fields` (for example `["name","ipAddress"]`) to keep only what the
  question needs; this saves a lot of tokens on clients and firewall policies.
- Client and device output includes MAC and IP addresses. Show only what the question needs.
- Several consoles: set `UNIFI_CONSOLE_ID` in the environment that starts Claude Code. Several sites: pass `site`.
- Cloud mode goes through the Site Manager Connector (100 requests per minute per console, firmware
  5.0.3 or later); local mode, when the user set a console address, talks to the console directly.
