#!/bin/bash
# Shared by pve-vm and run.sh. Source it; do not run it.
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit "${DIE_CODE:-1}"; }
log() { echo "[e2e] $*" >&2; }

# Settings and secrets come from the environment, or from a KEY=VALUE file outside the repository.
# The file is parsed, never executed, and is refused unless only its owner can read it.
# Environment variables win over the file, so a CI job can pass secrets without a file.
load_config() {
  local conf="${UNIFI_VM_CONFIG:-$HOME/.config/desu-ai-plugins/unifi-vm.env}" line key val
  if [ -e "$conf" ]; then
    [ -f "$conf" ] || die "$conf is not a regular file"
    [ "$(stat -c %u "$conf")" = "$(id -u)" ] || die "$conf must belong to you"
    case "$(stat -c %a "$conf")" in 600 | 400) ;; *) die "$conf must be readable only by you: chmod 600 $conf" ;; esac
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in '' | '#'*) continue ;; esac
      key=${line%%=*}
      val=${line#*=}
      val=${val%"${val##*[![:space:]]}"}   # trailing blanks of an unquoted value are never meant
      [[ $key =~ ^(PVE|UNIFI_VM|UNIFI_TEST|UNIFI_EMU|UNIFI_ZBF)_[A-Z0-9_]+$ ]] || die "$conf: only PVE_*, UNIFI_VM_*, UNIFI_TEST_*, UNIFI_EMU_* and UNIFI_ZBF_* KEY=VALUE lines are allowed"
      val=${val#[\"\']}
      val=${val%[\"\']}
      [ -n "${!key+x}" ] || export "$key=$val"
    done <"$conf"
  fi
  export PVE_HOST="${PVE_HOST:-pve}" PVE_SNAPSHOT="${UNIFI_ZBF_SNAPSHOT:-${PVE_SNAPSHOT:-Inicial}}"
  export PVE_SHUTDOWN_TIMEOUT="${PVE_SHUTDOWN_TIMEOUT:-60}" PVE_POLL_SECONDS="${PVE_POLL_SECONDS:-2}" PVE_STOP_GRACE="${PVE_STOP_GRACE:-30}"
  [[ ${PVE_VMID:-} =~ ^[0-9]+$ ]] || die "PVE_VMID must be the numeric id of the test VM (set it in $conf)"
  [[ $PVE_SNAPSHOT =~ ^[A-Za-z][A-Za-z0-9_-]*$ ]] || die "PVE_SNAPSHOT has characters Proxmox does not allow"
  [[ $PVE_HOST =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || die "PVE_HOST must be an ssh host name or alias"
  [[ $PVE_STOP_GRACE =~ ^[0-9]+$ ]] || die "PVE_STOP_GRACE must be a number of seconds"
  [[ $PVE_SHUTDOWN_TIMEOUT =~ ^[0-9]+$ ]] || die "PVE_SHUTDOWN_TIMEOUT must be a number of seconds"
}

# Runs a command on the Proxmox host. Callers pass only validated values.
pve() { ssh -o BatchMode=yes -o ConnectTimeout=10 -- "$PVE_HOST" "$@"; }

# Prints running or stopped; fails (instead of printing nothing) when the status cannot be read, so callers
# use  st=$(vm_status) || die ...  and never mistake an ssh failure for a state.
vm_status() {
  local out st
  out=$(pve qm status "$PVE_VMID") || { echo "cannot read the status of VM $PVE_VMID on $PVE_HOST" >&2; return 1; }
  st=$(sed -n 's/^status: //p' <<<"$out")
  [ -n "$st" ] || { echo "unexpected qm status output for VM $PVE_VMID" >&2; return 1; }
  echo "$st"
}

wait_status() { # wanted-status timeout-seconds
  local polls=0 st
  while :; do
    st=$(vm_status) || return 2
    [ "$st" = "$1" ] && return 0
    awk -v n="$polls" -v p="$PVE_POLL_SECONDS" -v t="$2" 'BEGIN { exit !(n * p >= t) }' && return 1
    sleep "$PVE_POLL_SECONDS"
    polls=$((polls + 1))
  done
}

# Refuses to touch a VM that is not the one configured: the snapshot must exist (by name, not as a word in a
# description) and, when PVE_VM_NAME is set, the VM must have that name. A wrong VMID would otherwise roll back another VM.
vm_check() {
  local snaps name
  snaps=$(pve qm listsnapshot "$PVE_VMID") || die "cannot list the snapshots of VM $PVE_VMID on $PVE_HOST"
  sed -n 's/^[[:space:]`>|-]*\([A-Za-z][A-Za-z0-9_-]*\)[[:space:]].*/\1/p' <<<"$snaps" | grep -qx "$PVE_SNAPSHOT" || die "VM $PVE_VMID has no snapshot '$PVE_SNAPSHOT'; refusing to roll back"
  if [ -n "${PVE_VM_NAME:-}" ]; then
    name=$(pve qm config "$PVE_VMID" | sed -n 's/^name: //p')
    [ "$name" = "$PVE_VM_NAME" ] || die "VM $PVE_VMID is named '$name', not '$PVE_VM_NAME'; refusing to touch it"
  fi
}

# IPv4 address of the VM, found from the Proxmox side so nobody has to configure it: the guest agent when the VM
# runs one, otherwise the neighbour table of the host for the MAC of net0. Prints nothing until the VM is on the network.
discover_ip() {
  local cfg mac ip
  cfg=$(pve qm config "$PVE_VMID") || return 1
  mac=$(sed -n 's/^net0: [^=]*=\([0-9A-Fa-f:]\{17\}\).*/\1/p' <<<"$cfg" | tr 'A-F' 'a-f')
  ip=$(pve qm guest cmd "$PVE_VMID" network-get-interfaces 2>/dev/null | grep -o '"ip-address" *: *"[0-9.]*"' | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+\.[0-9]\+' | grep -v '^127\.' | head -1)
  if [ -z "$ip" ] && [ -n "$mac" ]; then
    ip=$(pve ip -4 neigh show | awk -v m="$mac" 'tolower($5) == m { print $1; exit }')
  fi
  [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && echo "$ip"
}

# Prints 200 only when the Network integration API at host:port answers 200 with JSON, using the test key;
# 000 when nothing answers. A 200 with a web page is not the API: UniFi OS serves its own UI for every path
# while the Network application is still starting, so that is reported as "200 (not JSON: ...)".
# The key goes to curl on stdin, so it never shows up in the process list.
probe_code() {
  local out
  out=$(printf 'header = "X-API-KEY: %s"\n' "${UNIFI_TEST_API_KEY:-}" |
    curl -sk -K - -o /dev/null -m 5 -w '%{http_code} %{content_type}' "https://$1/proxy/network/integration/v1/info") || true
  case "$out" in
    '200 application/json'*) echo 200 ;;
    '200 '*) echo "200 (not JSON: ${out#200 })" ;;
    *) echo "${out%% *}" ;;
  esac
}

# Waits until the API answers 200 and sets ENDPOINT=host:port. UNIFI_VM_HOST may be empty (found from Proxmox),
# an address, or address:port; without a port, 443 and 11443 (UniFi OS Server) are tried, whichever answers.
wait_endpoint() {
  local deadline=$((SECONDS + ${UNIFI_VM_READY_TIMEOUT:-600})) host p t code last="no address yet"
  local -a targets
  while [ "$SECONDS" -lt "$deadline" ]; do
    host=${UNIFI_VM_HOST:-}
    [ -n "$host" ] || host=$(discover_ip 2>/dev/null) || host=
    if [ -n "$host" ]; then
      targets=()
      if [[ $host =~ :[0-9]+$ ]]; then
        targets=("$host")
      else
        for p in ${UNIFI_VM_PORT:-443 11443}; do targets+=("$host:$p"); done
      fi
      for t in "${targets[@]}"; do
        code=$(probe_code "$t")
        last="$t answered HTTP $code"
        [ "$code" = 200 ] && { ENDPOINT="$t"; return 0; }
      done
    fi
    sleep "$PVE_POLL_SECONDS"
  done
  die "the UniFi API did not answer 200 in time (last probe: $last)"
}

# ── virtual devices (unifi-emu): one container per device, each on the newest firmware ──
EMU_FW_URL="https://fw-update.ubnt.com/api/firmware-latest?filter=eq~~product~~unifi-firmware&filter=eq~~channel~~release"
EMU_NAMES=()
EMU_FW_FILE=

# Newest release firmware for a model, in the form devices report it (5.1.26.33914), from Ubiquiti's public index.
# The index files the 5.x gateway line under other platform names (UXGPRO still lists 1.13.8), so a UXG* model gets
# the newest version of the whole UXG family. Prints nothing for a model the index does not know.
emu_latest_firmware() { # index-file model
  jq -r --arg m "$2" '
    def num: split(".") | map(tonumber? // 0);
    [._embedded.firmware[] | select(.product == "unifi-firmware" and .channel == "release")] as $all
    | (if ($m | test("^UXG")) then [$all[] | select(.platform | test("^UXG"))] else [$all[] | select(.platform == $m)] end)
    | map(.version | ltrimstr("v") | sub("\\+"; "."))
    | sort_by(num) | last // empty' "$1"
}

emu_fetch_firmware_index() {
  EMU_FW_FILE=$(mktemp) || return 1
  curl -sf -m 30 -o "$EMU_FW_FILE" "$EMU_FW_URL" && jq -e '._embedded.firmware | length > 0' "$EMU_FW_FILE" >/dev/null 2>&1
}

# emu_start_fleet <vm-host> <name-prefix> <models> [authkey]   models like U7PRO,USM8P:2 ; image from UNIFI_EMU_IMAGE
# With an authkey the FIRST device informs with it from the start: it is the gateway a restored snapshot already has adopted.
# UNIFI_EMU_FIRMWARE=latest (default) | default (the emulator's own, older, versions)
emu_start_fleet() {
  local host=$1 prefix=$2 models=$3 key=${4:-} devkey url spec model count n i=0 ver mac ip fw=
  local -a list=()
  url="http://$host:${UNIFI_EMU_INFORM_PORT:-8080}/inform"
  for spec in ${models//,/ }; do
    model=${spec%%:*}
    count=1
    [[ $spec == *:* ]] && count=${spec#*:}
    [[ $count =~ ^[0-9]+$ ]] && [ "$count" -ge 1 ] && [ "$count" -le 20 ] || die "bad device count in '$spec'"
    for ((n = 0; n < count; n++)); do list+=("$model"); done
  done
  [ "${#list[@]}" -le 200 ] || die "too many virtual devices"
  for ((i = 0; i < ${#list[@]}; i++)); do EMU_NAMES+=("$prefix-$((i + 1))"); done
  docker rm -f "${EMU_NAMES[@]}" >/dev/null 2>&1 || true

  if [ "${UNIFI_EMU_FIRMWARE:-latest}" = latest ]; then
    if emu_fetch_firmware_index; then
      fw=$EMU_FW_FILE
    else
      log "WARNING: could not read Ubiquiti's firmware index; the virtual devices use the emulator's own, older, firmware"
    fi
  fi
  for ((i = 0; i < ${#list[@]}; i++)); do
    model=${list[$i]}
    ver=
    [ -z "$fw" ] || ver=$(emu_latest_firmware "$fw" "$model")
    [ -z "$fw" ] || [ -n "$ver" ] || log "WARNING: no firmware found for $model in Ubiquiti's index; using the emulator's own"
    printf -v mac '00:27:22:e0:00:%02x' $((i + 1))
    ip="192.168.1.$((100 + i))"
    log "virtual $model ($mac) firmware ${ver:-emulator default}"
    # the key travels in the environment, never on a command line
    devkey=; [ "$i" -ne 0 ] || devkey=$key
    UNIFI_EMU_AUTHKEY=$devkey docker run -d ${devkey:+-e UNIFI_EMU_AUTHKEY} --name "${EMU_NAMES[$i]}" "$UNIFI_EMU_IMAGE" -model "$model" ${ver:+-version "$ver"} -mac "$mac" -ip "$ip" \
      -name "emu-${model,,}-$((i + 1))" -inform "$url" >/dev/null || die "cannot start the emulator container ${EMU_NAMES[$i]}"
  done
}

emu_stop_fleet() {
  [ "${#EMU_NAMES[@]}" -eq 0 ] || docker rm -f "${EMU_NAMES[@]}" >/dev/null 2>&1 || log "could not remove the emulator containers"
  [ -z "$EMU_FW_FILE" ] || rm -f "$EMU_FW_FILE"
  return 0
}
