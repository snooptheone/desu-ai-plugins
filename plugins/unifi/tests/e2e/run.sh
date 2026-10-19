#!/bin/bash
# Runs the end-to-end tests against the UniFi OS test VM, leaving the VM as it found it:
#   roll back to the snapshot -> start the VM -> wait for the API -> run the tests ->
#   roll back again -> shut the VM down -> verify it is stopped.
# The last two steps run on every exit path (test failure, Ctrl-C, error). Exit codes:
#   0 all good; the tests' own code if they failed; 3 if the VM could not be left restored and stopped.
# The test files run one at a time: they share one VM, and the device tests need it undisturbed.
# The address is found by itself (see wait_endpoint in lib.sh); tests get it as UNIFI_VM_ENDPOINT.
# Zone-based firewall needs a gateway the controller has finished provisioning, and the firewall upgrade done in the app
# (no API for it is known). Proxmox (ZFS) only rolls back to the MOST RECENT snapshot, so with UNIFI_ZBF_SNAPSHOT set that
# snapshot (the VM with an adopted virtual gateway and the upgrade done) is the one every run restores, replacing
# PVE_SNAPSHOT. The adopted gateway is started first in the fleet, on the site's authkey (UNIFI_EMU_ZBF_AUTHKEY, see
# zbf-authkey), and firewall.e2e.js fails (not skips) when there are no zones.
# E2E_CMD replaces the test command (the self-test uses it); E2E_SKIP_WAIT=1 skips waiting for the API.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/lib.sh"
load_config

# Optional virtual devices: with UNIFI_EMU_IMAGE set, a unifi-emu container (fake AP and switch that speak the real
# inform protocol) informs to the VM during the tests, so the device tests have devices to adopt. It is removed at teardown.
# Docker pulls the image on first use: pin the tag or digest you trust.
[ -z "${UNIFI_EMU_IMAGE:-}" ] || [[ $UNIFI_EMU_IMAGE =~ ^[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$ ]] || die "UNIFI_EMU_IMAGE is not an image reference"
[ -z "${UNIFI_EMU_FIRMWARE:-}" ] || [[ $UNIFI_EMU_FIRMWARE =~ ^(latest|default)$ ]] || die "UNIFI_EMU_FIRMWARE must be latest or default"
[ -z "${UNIFI_EMU_MODELS:-}" ] || [[ $UNIFI_EMU_MODELS =~ ^[A-Za-z0-9,:]+$ ]] || die "UNIFI_EMU_MODELS must look like U7PRO,USM8P:2"
[ -z "${UNIFI_EMU_INFORM_PORT:-}" ] || [[ $UNIFI_EMU_INFORM_PORT =~ ^[0-9]+$ ]] || die "UNIFI_EMU_INFORM_PORT must be a port number"
[ -z "${UNIFI_EMU_IMAGE:-}" ] || command -v docker >/dev/null || die "UNIFI_EMU_IMAGE is set but docker is not installed"

[ -z "${UNIFI_ZBF_SNAPSHOT:-}" ] || [[ $UNIFI_ZBF_SNAPSHOT =~ ^[A-Za-z][A-Za-z0-9_-]*$ ]] || die "UNIFI_ZBF_SNAPSHOT has characters Proxmox does not allow"
[ -z "${UNIFI_EMU_ZBF_AUTHKEY:-}" ] || [[ $UNIFI_EMU_ZBF_AUTHKEY =~ ^[0-9a-f]{32}$ ]] || die "UNIFI_EMU_ZBF_AUTHKEY must be 32 hex digits (run zbf-authkey)"
ZBF=
if [ -n "${UNIFI_ZBF_SNAPSHOT:-}" ]; then
  [ -n "${UNIFI_EMU_IMAGE:-}" ] && [ -n "${UNIFI_EMU_ZBF_AUTHKEY:-}" ] || die "UNIFI_ZBF_SNAPSHOT needs UNIFI_EMU_IMAGE and UNIFI_EMU_ZBF_AUTHKEY"
  ZBF=1
fi

# Checked before the VM is touched: a bad setting must not cost a rollback.
[ -z "${UNIFI_VM_HOST:-}" ] || [[ $UNIFI_VM_HOST =~ ^[A-Za-z0-9][A-Za-z0-9.:_-]*$ ]] || die "UNIFI_VM_HOST must be an address"
[ -z "${UNIFI_VM_PORT:-}" ] || [[ $UNIFI_VM_PORT =~ ^[0-9]+( [0-9]+)*$ ]] || die "UNIFI_VM_PORT must be one or more port numbers"

exec 9>"${XDG_RUNTIME_DIR:-/tmp}/unifi-vm-e2e-$PVE_VMID.lock"
flock -n 9 || die "another run is already using VM $PVE_VMID"

child=
restoring= # set while the first rollback may have changed the VM; until then there is nothing to put back
teardown() {
  local rc=$? failed=0
  trap - EXIT INT TERM
  [ -n "$child" ] && kill "$child" 2>/dev/null
  emu_stop_fleet
  [ -n "$restoring" ] || exit "$rc"
  log "teardown: restoring '$PVE_SNAPSHOT' and shutting the VM down"
  "$DIR/pve-vm" restore || failed=1
  "$DIR/pve-vm" stop || failed=1
  [ "$(vm_status 2>/dev/null)" = stopped ] || { log "VM $PVE_VMID is NOT confirmed stopped"; failed=1; }
  [ "$failed" -eq 0 ] || { log "TEARDOWN FAILED: check VM $PVE_VMID by hand"; exit 3; }
  exit "$rc"
}
trap teardown EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

restoring=1
"$DIR/pve-vm" restore || { restoring=; exit 1; } # refused or failed before touching the VM: nothing to restore
"$DIR/pve-vm" start || exit 1

ENDPOINT=
if [ -z "${E2E_SKIP_WAIT:-}" ]; then
  wait_endpoint
  log "UniFi API is up at $ENDPOINT"
fi
export UNIFI_VM_ENDPOINT="$ENDPOINT"
[ -z "$ZBF" ] || export UNIFI_ZBF_EXPECTED=1

if [ -n "${UNIFI_EMU_IMAGE:-}" ]; then
  [ -n "$ENDPOINT" ] || die "virtual devices need the VM address, so E2E_SKIP_WAIT cannot be used with UNIFI_EMU_IMAGE"
  emu_start_fleet "${ENDPOINT%:*}" "unifi-e2e-emu-$PVE_VMID" "${ZBF:+UXGB,}${UNIFI_EMU_MODELS:-U7PRO,USM8P}" "${ZBF:+${UNIFI_EMU_ZBF_AUTHKEY:-}}"
  export UNIFI_EMU_RUNNING=1
fi

if [ -n "${E2E_CMD:-}" ]; then
  bash -c "$E2E_CMD" &
else
  : "${UNIFI_TEST_API_KEY:?UNIFI_TEST_API_KEY is required}" "${ENDPOINT:?no endpoint (E2E_SKIP_WAIT needs E2E_CMD)}"
  env UNIFI_API_KEY="$UNIFI_TEST_API_KEY" UNIFI_CONSOLE_HOST="$ENDPOINT" UNIFI_ENABLE_WRITES=true \
    node --test --test-concurrency=1 "$DIR"/*.e2e.js &
fi
child=$!
wait "$child"
rc=$?
child=

exit "$rc"
