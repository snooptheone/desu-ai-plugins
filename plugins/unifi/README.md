# unifi

A [Claude Code](https://claude.ai/claude-code) plugin that gives Claude a view of your UniFi
Network that is read-only by default, built only on the official [UniFi Network API](https://developer.ui.com/network) and the Site
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
node --test plugins/unifi/tests/*.test.js
```

The tests start the server against a local fake API; they need no network and no key.

### Against a real console (a UniFi OS test VM on Proxmox)

`tests/e2e/` runs tests against a UniFi OS VM that lives on a Proxmox host, and leaves the VM as it found it. The VM it was
developed against is a [UniFi OS Server VM from the Proxmox community scripts](https://community-scripts.org/scripts/unifi-os-server-vm)
(Network 10.6.106, port 11443). Create the VM, finish the first-run setup, create an API key in the Network app, then take the
snapshot (the key must be inside it):

```bash
bash plugins/unifi/tests/e2e/init-secrets.sh     # once: creates the settings file, mode 600, outside the repo
$EDITOR ~/.config/desu-ai-plugins/unifi-vm.env   # fill in the VM id and name, the API key and the root password
bash plugins/unifi/tests/e2e/run.sh              # restore snapshot -> start -> tests -> restore -> stop -> verify stopped
```

`run.sh` rolls the VM back to the snapshot (default `Inicial`), starts it if it is stopped, waits for the API,
runs `tests/e2e/*.e2e.js` one file at a time, then rolls back again and shuts the VM down. The last two steps run even when the
tests fail or the run is killed; if the VM cannot be left restored and stopped, the exit code is 3.
`tests/e2e/pve-vm status|check|restore|start|stop` does one step by hand. The files run in name order, one at a time:
`devices` (adopt, read, restart, PoE), `firewall`, `private-api`, `reads`, `smoke`, `writes`, and `zz-remove-devices` last.

- What the tests check: every write is verified by reading the resource back (what was sent is what is read, the
  neighbouring items did not move, a deleted item is gone), not only that the API answered. `writes.e2e.js` covers
  networks (including `?force=true`), WiFi (the list has no passphrase, the detail of one WiFi does, and the plan never shows it), traffic lists, DNS, ACL rules and
  their order, vouchers (one by one and in bulk by filter), and firewall zones and policies and their order.
  `reads.e2e.js` calls every GET of the OpenAPI spec of the VM's version and checks required fields and types.
- Zone-based firewall needs a UniFi gateway on firmware 4.1 or newer and Network 9.0 or newer
  ([Ubiquiti's requirements](https://help.ui.com/hc/en-us/articles/115003173168-Zone-Based-Firewalls-in-UniFi)). A virtual
  gateway can unlock it (checked on Network 10.6.106), but only if it answers the controller's `wg-genkeypair` command:
  the controller sends that to every adopted gateway until it gets an X25519 key pair back on the gateway's next inform
  (`inform_as_notif`, `notif_reason: "cmd"`, a `notif_payload` with the same `request_id`; the shape comes from the
  behaviour [unifi-stubd](https://github.com/konstruktor1/unifi-stubd) documents). Unanswered, the gateway never completes
  provisioning and the console never offers zones. Answered, the console shows "Upgrade to the New Zone-Based Firewall";
  after clicking it the API lists the 6 default zones and 25 policies. The stock emulator does not answer, so
  `tests/e2e/build-emu-image` builds an image from it plus `emu/gateway.patch` (the answer, and `UNIFI_EMU_AUTHKEY` to start a
  device on a known authkey). No API for the upgrade is known, so it is done once by hand:
  1. `build-emu-image`, put its tag in `UNIFI_EMU_IMAGE`; `virtual-devices up UXGB`; adopt it in the app; click the upgrade.
  2. Take a Proxmox snapshot of the VM (no RAM), for example `ZBF`.
  3. `zbf-authkey unifi-manual-emu-1` stores the site's inform authkey (never printed) and the snapshot name in the settings file.
  Proxmox on ZFS only rolls back to the most recent snapshot, so with these settings `run.sh` restores `ZBF` instead of
  `PVE_SNAPSHOT` on every run, starts the already adopted virtual `UXGB` first (on that authkey), and `firewall.e2e.js`
  fails (not skips) if there are no zones. The report lists the virtual gateway as OFFLINE although it informs on every
  cycle and the zones work; the cause was not found. Without them the firewall tests are skipped, and the write logic is covered by
  the unit tests.
- Virtual devices run the newest release firmware of their model, read from Ubiquiti's public firmware index at each
  run (`UNIFI_EMU_FIRMWARE=latest`, the default; `default` keeps the emulator's own, older, versions). The index files
  the 5.x gateway line under other platform names, so a `UXG*` model gets the newest version of the whole UXG family.
  If the index cannot be read, the run warns and the emulator's own versions are used. One container is started per
  device. To try things by hand in the VM's app, outside the test cycle (it never touches the VM itself):
  `tests/e2e/virtual-devices up UXGB`, `... logs`, `... down`. `tests/e2e/gateway-caps HOST` (read only, asks for the key, prints
  only capability fields) compares what a controller stores for a real gateway and for a virtual one.
- Devices: set `UNIFI_EMU_IMAGE` in the settings file (needs docker; pin a tag or digest you trust, for example
  `ghcr.io/jamesbraid/unifi-emu:0.5.2`) and `run.sh` starts [unifi-emu](https://github.com/jamesbraid/unifi-emu) (MIT),
  a fake access point and switch that speak the real inform protocol. `devices.e2e.js` adopts them, reads them,
  restarts one, power-cycles a PoE port, removes them and sees them come back as pending. The container is removed at
  teardown, before the VM is restored. Not covered: clients (the API cannot create them, and the emulator does not
  simulate stations), so authorizing a guest has no real test yet.
- Only the VM in `PVE_VMID` is touched. With `PVE_VM_NAME` set, a VM with another name is refused, and so is a
  missing snapshot, before anything is rolled back.
- The VM's address and port are found by themselves: the address from Proxmox (the guest agent, or the host's
  neighbour table for the VM's MAC), the port by trying 443 and 11443 (UniFi OS Server) with the API key until
  one answers 200. Set `UNIFI_VM_HOST` (an address or `address:port`) or `UNIFI_VM_PORT` only to override that.
  The tests get the result as `UNIFI_VM_ENDPOINT`.
- The API key must exist **inside** the snapshot, because every run returns to it: create the key first, then
  take the snapshot.
- Secrets live in `~/.config/desu-ai-plugins/unifi-vm.env` (directory 700, file 600), never in the repository.
  The file is parsed, not executed, and refused if anyone else can read it. Environment variables of the same
  name override it, so a CI job can pass secrets without a file. The tools never print them.
- `bash plugins/unifi/tests/e2e/selftest.sh` tests the tooling itself against a fake `ssh`; CI runs it.

## Logs and statistics (private API, local mode)

The official API has no logs, events or history. In local mode (a console address is set) two more read-only tools
talk to the controller's own API, which the UniFi apps use:

| Tool | Reads |
|---|---|
| `unifi_system_log` | The system log: client and device alerts, admin activity, threats. A bounded query (class, hours, page), not free-form |
| `unifi_legacy_get` | A fixed list of reads: `stat/health`, `stat/sysinfo`, `stat/device`, `stat/sta`, `stat/alluser`, `stat/guest`, `stat/rogueap`, `stat/event`, `stat/report/*`, `stat/current-channel`, `stat/ccode`, `stat/dpi`, `stat/fwupdate/latest-version`, `list/user` (every known client, offline ones too), `list/alarm`, `cnt/alarm`, `v2/clients/active`, `v2/clients/history`, `v2/aggregated-dashboard` |
| `unifi_stats_query` | Two reads the private API answers only to a POST with a query body, nothing is changed: client sessions and DPI traffic. Each kind has its own bounded, checked body (hours, type, mac, categories), not free-form |

Checked on a UniFi OS Server VM running Network 10.6.106: the same API key that works for the official API is
accepted here (no local account needed); `stat/health`, `stat/sysinfo`, `stat/device`, `stat/sta`, `stat/report/*`
and the `v2` reads answer; `stat/event` is gone (404) and `list/alarm` and `cnt/alarm` are refused (400), so events and
alarms are in the system log; and the system log records changes made through the official API.

This API is undocumented and can change with the controller version, so treat these tools as best effort. Paths follow what open clients of it use
([go-unifi](https://github.com/ubiquiti-community/go-unifi), [Art-of-WiFi/UniFi-API-client](https://github.com/Art-of-WiFi/UniFi-API-client));
no code was copied. It returns secrets that the official API leaves out (keys starting with `x_`), so the
output is masked, and settings, commands and anything that writes are not on the list. The one non-GET request is the
log query, a POST that changes nothing. Whether your API key is accepted by this API depends on the controller; the
end-to-end test `private-api.e2e.js` finds out on the test VM.

## Changes

Turn on the plugin option `enable_writes` ("Allow changes") to get these tools. Without it they do not
exist.

| Tool | Does |
|---|---|
| `unifi_plan_restart_device` | Restart an AP, switch or gateway |
| `unifi_plan_set_firewall_policy` | Enable/disable a user-defined firewall policy, or its logging |
| `unifi_plan_update_traffic_list` | Replace the items of a port or IP list |
| `unifi_plan_change` | Every other write operation of the API (below) |
| `unifi_apply_change` | Apply a plan |

`unifi_plan_change` takes a method and a path and accepts only the write operations that exist in the Network
API v1 (checked against the 10.6.106 spec): create (`POST`), replace (`PUT`), update (`PATCH`) or delete
(`DELETE`) networks, WiFi broadcasts, firewall policies and zones, ACL rules, DNS policies, traffic matching
lists and hotspot vouchers; reorder firewall policies and ACL rules; adopt, remove or restart a device,
power-cycle a switch port's PoE; authorize or unauthorize a guest client. Any other method or path is
refused before a request is sent. A `PUT` replaces the whole object, so the plan shows which fields differ.
Deleting a network also shows what still references it.

Every change takes two steps. A `plan` tool changes nothing and returns a summary, a one-use approval
code (valid for 5 minutes) and a confirmation phrase. `unifi_apply_change` runs only with that code, the
exact phrase, and a resource that is unchanged since the plan. The tool is flagged
`anthropic/requiresUserInteraction`, so Claude Code (v2.1.214 or later) shows you the call, with the
phrase, in its permission prompt **every time**, even in auto-accept modes and even if an allow rule
matches; with `dontAsk` it is refused. On an older Claude Code, never allow-list
`unifi_apply_change`. The skill also tells Claude to ask you in the chat first.

The approval code is not a secret: Claude sees it. What keeps Claude from approving its own plan is that
permission prompt, so do not disable it.

Each attempt and its result are appended to `changes.jsonl` in the plugin's data directory
(`~/.claude/plugins/data/…`), with the resource as it was before. The change is not applied if the log
cannot be written. Undoing a change is manual: the log has the previous state.

Changes were tested in local mode only. With a Site Manager key (cloud mode) the cloud API may refuse them
after the plan, with an HTTP 403.

The official API limits what can change. It cannot block a client (guest access only), and firewall policies created by the
system cannot be enabled or disabled. Prefer a key with an expiration date.

## Known limitations

- Approval codes live in memory, so restarting Claude Code discards pending plans.
- Local mode does not verify the console's certificate, and that includes changes: someone who can
  intercept traffic on your LAN could read the API key or alter a request. Use it on a network you trust.
