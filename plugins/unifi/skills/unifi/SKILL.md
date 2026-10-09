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
| `unifi_devices`, `unifi_pending_devices` | Managed devices (the list shows only the interface kinds); devices waiting for adoption |
| `unifi_device`, `unifi_device_stats` | One device (needs `deviceId`): detail with switch ports or AP radios (channel, width, band); latest CPU, memory, uplink and radio retry rate |
| `unifi_clients` | Connected clients |
| `unifi_networks`, `unifi_wifi` | Networks/VLANs; WiFi broadcasts (SSIDs) |
| `unifi_firewall_policies`, `unifi_firewall_zones`, `unifi_acl_rules` | Firewall |
| `unifi_dns_policies`, `unifi_wans`, `unifi_traffic_lists` | DNS policies, WAN links, traffic matching lists (`items` holds the ports or IPs) |
| `unifi_vpn_servers`, `unifi_vpn_tunnels` | VPN |
| `unifi_get` | Any other GET path under `/v1`, for example `/dpi/categories` |

- List tools return every item. Pass `fields` (for example `["name","ipAddress"]`) to keep only what the
  question needs; this saves a lot of tokens on clients and firewall policies.
- Firewall policies reference traffic matching lists by id. To see what a rule really matches (ports or
  IPs), look the id up in `unifi_traffic_lists` and read its `items`; do not guess from the name, and do
  not ask the user to open the UI for it. Do not pass `fields` that drop `items`.
- The API does not expose: PoE state or power, AP transmit power, IDS/IPS settings, WAN failover
  settings, Wi-Fi passphrases. Say so instead of guessing.
- Client and device output includes MAC and IP addresses. Show only what the question needs.
- Several consoles: set `UNIFI_CONSOLE_ID` in the environment that starts Claude Code. Several sites: pass `site`.
- Cloud mode goes through the Site Manager Connector (100 requests per minute per console, firmware
  5.0.3 or later); local mode, when the user set a console address, talks to the console directly.
