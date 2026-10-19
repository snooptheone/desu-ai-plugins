---
name: unifi
description: >
  The user's UniFi network through the official UniFi Network API. Reads: connected clients,
  devices and their stats, networks/VLANs, WiFi SSIDs, firewall policies and zones, DNS policies,
  WANs and VPN. Use when the user asks who is on the network, what devices are online, how the
  network is configured, or about firewall, WiFi, VLAN or VPN settings, even if they do not say
  "UniFi". Also plans and applies changes (create, edit or delete networks, WiFi, firewall, DNS,
  ACL, traffic lists, vouchers; restart or remove a device; power-cycle a port) when the user turned
  on the enable_writes option, always after asking; use it for any such change request.
---

# UniFi

Use the `unifi_*` tools of the plugin's MCP server. The read tools below only send GET requests and
cannot change anything. Changes are covered at the end, and only exist when the user turned on the
`enable_writes` plugin option.

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
| `unifi_system_log`, `unifi_legacy_get`, `unifi_stats_query` | Only with a console address set (local mode). The controller's private API: the **system log** (what happened, who changed what, alerts), statistics, alarms, rogue APs, health, per-client detail, every known client (`list/user`, offline ones too), channels, the newest firmware, and with `unifi_stats_query` client sessions and DPI traffic. Undocumented and may change with the controller version; secrets (`x_` keys, passphrases) are masked |

- List tools return every item. Pass `fields` (for example `["name","ipAddress"]`) to keep only what the
  question needs; this saves a lot of tokens on clients and firewall policies.
- Firewall policies reference traffic matching lists by id. To see what a rule really matches (ports or
  IPs), look the id up in `unifi_traffic_lists` and read its `items`; do not guess from the name, and do
  not ask the user to open the UI for it. Do not pass `fields` that drop `items`.
- The official API has no logs, events or history. For "what happened", "who connected", "what changed" or
  alerts, use `unifi_system_log` (class `all`, `critical`, `admin-activity`, `client-alert`, `device-alert`,
  `threat-alert`; `hours` goes back up to 90 days, paged). It needs local mode; without it, say so. It also records
  changes made through the API, so it answers "what did Claude change". `stat/event`, `list/alarm` and `cnt/alarm`
  of `unifi_legacy_get` are gone on current controllers (404/400 on 10.6.106); use the system log instead.
- The API does not expose: PoE state or power, AP transmit power, IDS/IPS settings, WAN failover
  settings. Say so instead of guessing.
- Wi-Fi passphrases: `unifi_wifi` (the list) leaves them out, but the detail of one WiFi
  (`unifi_get` on `/sites/<site>/wifi/broadcasts/<id>`) returns the passphrase in clear text. Do not fetch or show it
  unless the person asked for the password, and say that it will appear in this conversation.
- Client and device output includes MAC and IP addresses. Show only what the question needs.
- Several consoles: set `UNIFI_CONSOLE_ID` in the environment that starts Claude Code. Several sites: pass `site`.
- Cloud mode goes through the Site Manager Connector (100 requests per minute per console, firmware
  5.0.3 or later); local mode, when the user set a console address, talks to the console directly.

## Changes (only when the write tools are listed)

If no `unifi_plan_*` tools exist, writes are off: say so, tell the user they can enable "Allow changes"
in the plugin options, and describe what they would do in the UniFi UI. The official API cannot block a
client (only guest access can be authorized) or change IDS/IPS, WAN failover or PoE settings; do not
promise what the tools below do not do.

| Plan tool | Changes |
|---|---|
| `unifi_plan_restart_device` | Restarts an AP, switch or the gateway |
| `unifi_plan_set_firewall_policy` | Enables/disables a user-defined firewall policy, or turns its logging on/off |
| `unifi_plan_update_traffic_list` | Replaces all items of a port or IP list (send the full new list) |
| `unifi_plan_change` | Anything else the API allows: `method` + `path` (like `sites/<site>/networks/<id>`) + `body`. Prefer the three tools above when one fits |

For `unifi_plan_change`: read the current object first (`PUT` replaces the whole object, so send it back
with only the wanted fields changed, without `id` and `metadata`); for a create (`POST`), copy an existing
item of the same kind as a template, or read the schema at
`https://developer.ui.com/network/v<applicationVersion>/openapi.json` (`unifi_info` gives the version).
Client actions are only `AUTHORIZE_GUEST_ACCESS` / `UNAUTHORIZE_GUEST_ACCESS`, device `RESTART`, port
`POWER_CYCLE`. Deletes cannot be undone: say so, and for a network read the `references` in the plan.

Every change takes these steps, and you may not skip or merge them:
1. Call the plan tool. It changes nothing and returns a `summary`, an `approvalCode` (valid 5 minutes,
   one use) and a `confirmation` phrase.
2. Show the user the summary, including who uses a traffic list and every value added or removed (not
   just the counts), and ask. Wait for a clear yes in the
   chat for exactly that change. Silence, "ok maybe" or an earlier approval of something else is not a yes.
3. Only then call `unifi_apply_change` with the `approvalCode` and the `confirmation` verbatim.

Never call `unifi_apply_change` on your own initiative, never reuse a code for a different change, and
never apply several plans at once without the user approving each one. If the plan expired or the
resource changed, make a new plan and ask again. Applied changes are logged to `changes.jsonl` in the
plugin's data directory, with the state before the change, so one can be undone by hand.
