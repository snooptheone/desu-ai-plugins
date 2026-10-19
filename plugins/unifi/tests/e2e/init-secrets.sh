#!/bin/bash
# Creates the settings/secrets file for the test VM, outside the repository, readable only by you.
# It writes empty placeholders; open the file in your editor to fill them in, so nothing secret
# passes through the shell history, a chat, or a command line.
set -eu
conf="${UNIFI_VM_CONFIG:-$HOME/.config/desu-ai-plugins/unifi-vm.env}"
[ ! -e "$conf" ] || { echo "$conf already exists; not touching it" >&2; exit 1; }
umask 077
mkdir -p "$(dirname "$conf")"
chmod 700 "$(dirname "$conf")"
cat >"$conf" <<'EOF'
# Test VM for the unifi plugin. KEY=VALUE only; this file is parsed, not executed.
# Environment variables of the same name override what is written here.

# Proxmox: ssh alias or user@host of the PVE server (key-based login, no password prompt)
PVE_HOST=pve
# Numeric id of the UniFi OS test VM. Only this VM is ever touched.
PVE_VMID=
# Optional but recommended: the VM must have exactly this name, or nothing is rolled back
PVE_VM_NAME=
# Snapshot every run starts from and returns to
PVE_SNAPSHOT=Inicial

# Optional. Leave both empty: the address is found from Proxmox and the port by trying 443 and 11443.
# Set UNIFI_VM_HOST (an address, or address:port) or UNIFI_VM_PORT only to override that.
UNIFI_VM_HOST=
UNIFI_VM_PORT=
# Optional: virtual devices (a fake access point and switch that really get adopted) for the device tests.
# Needs docker; the image is pulled the first time. Pin a tag or digest you trust, for example
# ghcr.io/jamesbraid/unifi-emu:0.5.2 (project: github.com/jamesbraid/unifi-emu, MIT). Leave empty to skip the device tests.
UNIFI_EMU_IMAGE=
# Optional: which virtual devices to run. The virtual devices use the newest firmware (UNIFI_EMU_FIRMWARE=latest, the
# default; default keeps the emulator's own older versions). A virtual gateway only unlocks zone-based firewall with the
# patched emulator image (tests/e2e/build-emu-image); see "Zone-based firewall" in the plugin README, and the two optional
# settings below, which `zbf-authkey` fills in for you.
UNIFI_EMU_MODELS=U7PRO,USM8P
# Optional, written by zbf-authkey: a snapshot taken AFTER the zone-based firewall upgrade, with the virtual gateway
# adopted, and the site's inform authkey. With them every run restores that snapshot instead of PVE_SNAPSHOT (Proxmox on
# ZFS rolls back only to the newest snapshot) and the firewall tests run for real. Leave both unset to skip them.
# UNIFI_ZBF_SNAPSHOT=
# UNIFI_EMU_ZBF_AUTHKEY=
# API key created in the VM's Network app (Integrations). It must already exist INSIDE the snapshot,
# because every run rolls back to it: create the key first, then take the snapshot.
UNIFI_TEST_API_KEY=
# root password of the VM (only for tests that need to log in to it; not used by the tools themselves)
UNIFI_VM_ROOT_PASSWORD=
EOF
echo "created $conf (mode 600). Edit it and fill in the values." >&2
