#!/bin/bash
# Tests pve-vm and run.sh against a fake `ssh` that pretends to be the Proxmox host. No VM, no network.
# Run: bash plugins/unifi/tests/e2e/selftest.sh
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASSED=0
FAILED=0

mkdir -p "$ROOT/bin"
cat >"$ROOT/bin/ssh" <<'FAKE'
#!/bin/bash
# fake ssh: args are  -o ... -o ... -- <host> qm <subcommand> ...   State lives in $FAKE_DIR.
args=("$@"); i=0
while [ "${args[$i]}" != "--" ]; do i=$((i + 1)); done
cmd=("${args[@]:$((i + 2))}")
echo "${cmd[*]}" >>"$FAKE_DIR/ssh.log"
[ -z "${FAKE_SSH_DOWN:-}" ] || exit 255
if [ "${cmd[0]}" = ip ]; then [ -z "${FAKE_NEIGH:-}" ] || echo "$FAKE_NEIGH"; exit 0; fi
[ "${cmd[0]}" = qm ] || exit 127
case "${cmd[1]}" in
  status) echo "status: $(cat "$FAKE_DIR/state")" ;;
  listsnapshot) for n in ${FAKE_SNAPS:-Inicial}; do printf ' `-> %s    2026-01-01 10:00:00     %s\n' "$n" "${FAKE_DESC:-no-description}"; done; echo '  `-> current                                    You are here!' ;;
  config) echo "name: ${FAKE_NAME:-unifi-test}"; echo "net0: virtio=BC:24:11:AA:BB:CC,bridge=vmbr0" ;;
  guest) [ -n "${FAKE_GUEST:-}" ] && echo "$FAKE_GUEST" || exit 255 ;;
  rollback) [ -z "${FAKE_ROLLBACK_FAIL:-}" ] || { echo "can't rollback, '${cmd[3]}' is not most recent snapshot" >&2; exit 255; }
            echo "rollback ${cmd[3]}" >>"$FAKE_DIR/actions.log"; echo "${FAKE_ROLLBACK_LEAVES:-stopped}" >"$FAKE_DIR/state" ;;
  start) echo start >>"$FAKE_DIR/actions.log"; echo running >"$FAKE_DIR/state" ;;
  shutdown) echo shutdown >>"$FAKE_DIR/actions.log"; [ -n "${FAKE_NO_STOP:-}" ] || echo stopped >"$FAKE_DIR/state" ;;
esac
FAKE
chmod +x "$ROOT/bin/ssh"
cat >"$ROOT/bin/curl" <<'FAKE'
#!/bin/bash
# fake curl: reads the -K - config from stdin; JSON 200 for FAKE_CURL_OK (host:port), an HTML 200 for FAKE_CURL_HTML, 401 for FAKE_CURL_401, else nothing
case " $* " in *" -K "*) cat >>"$FAKE_DIR/curl.stdin" ;; esac   # only the API probe sends its config on stdin
echo "$*" >>"$FAKE_DIR/curl.log"
url="${@: -1}"; hp=${url#https://}; hp=${hp%%/*}
case "$url" in */stat/device) cat "$FAKE_DIR/statdevice.json"; printf '\n%s' "${FAKE_STAT_CODE:-200}"; exit 0 ;; esac
if [ "$hp" = "fw-update.ubnt.com" ]; then
  [ -z "${FAKE_FW_DOWN:-}" ] || exit 22
  out=; prev=; for a in "$@"; do [ "$prev" = "-o" ] && out=$a; prev=$a; done
  cp "$FAKE_DIR/fw.json" "$out"; exit 0
fi
if [ "$hp" = "${FAKE_CURL_OK:-}" ]; then printf '200 application/json'
elif [ "$hp" = "${FAKE_CURL_HTML:-}" ]; then printf '200 text/html'
elif [ "$hp" = "${FAKE_CURL_401:-}" ]; then printf '401 application/json'
else printf '000 '; exit 7; fi
FAKE
chmod +x "$ROOT/bin/curl"
cat >"$ROOT/bin/docker" <<'FAKE'
#!/bin/bash
# fake docker: logs the container lifecycle into the same order log as the fake ssh, and its full argv separately
echo "$*" >>"$FAKE_DIR/docker.log"
case "$1" in
  rm) echo docker-rm >>"$FAKE_DIR/actions.log"
      for n in "${@:3}"; do grep -vx "$n" "$FAKE_DIR/containers" >"$FAKE_DIR/containers.new"; mv "$FAKE_DIR/containers.new" "$FAKE_DIR/containers"; done ;;
  run) echo docker-run >>"$FAKE_DIR/actions.log"; [ -z "${FAKE_DOCKER_FAIL:-}" ] || exit 125
       for ((j = 1; j <= $#; j++)); do [ "${!j}" = --name ] && { k=$((j + 1)); echo "${!k}" >>"$FAKE_DIR/containers"; }; done
       echo "key-in-env=${UNIFI_EMU_AUTHKEY:-none}" >>"$FAKE_DIR/docker.env" ;;
  ps) cat "$FAKE_DIR/containers" ;;
  logs) cat "$FAKE_DIR/docker.logs" ;;
esac
FAKE
chmod +x "$ROOT/bin/docker"

# new_case <name>: a fresh fake host (VM running), a 0600 config file, and the fake ssh first in PATH
new_case() {
  CASE="$ROOT/$1"
  mkdir -p "$CASE"
  export FAKE_DIR="$CASE" UNIFI_VM_CONFIG="$CASE/vm.env" PATH="$ROOT/bin:$PATH"
  echo running >"$CASE/state"
  : >"$CASE/ssh.log"
  : >"$CASE/actions.log"
  : >"$CASE/curl.log"
  : >"$CASE/curl.stdin"
  : >"$CASE/docker.log"
  : >"$CASE/containers"
  cat >"$CASE/statdevice.json" <<'JSON'
{"meta":{"rc":"ok"},"data":[
 {"type":"uxg","model":"UXGB","version":"5.1.26.33914","adopted":false,"state":1,"mac":"00:27:22:e0:00:01","ip":"192.168.1.100","name":"secret-name","serial":"SERIAL123","x_authkey":"AUTHSECRET","udapi_caps":0,"udapi_version":{"version":"2.0.0"},"usg_caps":12,"hw_caps":0,"fw_caps":3,"some_other":1},
 {"type":"uap","model":"U7PRO","mac":"aa:aa","version":"1","x_authkey":"AUTHSECRET2","udapi_caps":9}]}
JSON
  cat >"$CASE/fw.json" <<'JSON'
{"_embedded":{"firmware":[
 {"platform":"U7PRO","product":"unifi-firmware","channel":"release","version":"v8.7.11+19419"},
 {"platform":"USM8P","product":"unifi-firmware","channel":"release","version":"v2.1.8+971"},
 {"platform":"UXGPRO","product":"unifi-firmware","channel":"release","version":"v1.13.8+4578"},
 {"platform":"UXGPROV2","product":"unifi-firmware","channel":"release","version":"v5.1.26+33914"},
 {"platform":"UXG","product":"unifi-firmware","channel":"release","version":"v5.1.26+33914"},
 {"platform":"UXG","product":"unifi-firmware","channel":"beta","version":"v9.9.9+1"},
 {"platform":"U7PRO","product":"unifi-firmware","channel":"release","version":"v8.6.11+18870"},
 {"platform":"U7PRO","product":"other-product","channel":"release","version":"v99.0.0+1"}]}}
JSON
  printf 'PVE_VMID=105\nPVE_HOST=pve\nPVE_VM_NAME=unifi-test\nUNIFI_TEST_API_KEY=secret-key\nUNIFI_VM_ROOT_PASSWORD="pa ss"\n' >"$UNIFI_VM_CONFIG"
  chmod 600 "$UNIFI_VM_CONFIG"
  unset FAKE_DESC FAKE_ROLLBACK_FAIL PVE_STOP_GRACE FAKE_SNAPS FAKE_NAME FAKE_ROLLBACK_LEAVES FAKE_NO_STOP FAKE_SSH_DOWN FAKE_NEIGH FAKE_GUEST FAKE_DOCKER_FAIL UNIFI_EMU_IMAGE UNIFI_EMU_MODELS UNIFI_EMU_INFORM_PORT FAKE_STAT_CODE UNIFI_API_KEY GATEWAY_CAPS_SITE GATEWAY_CAPS_EXTRA UNIFI_EMU_RUNNING UNIFI_EMU_FIRMWARE FAKE_FW_DOWN FAKE_CURL_OK FAKE_CURL_HTML FAKE_CURL_401 UNIFI_VM_HOST UNIFI_VM_PORT UNIFI_VM_READY_TIMEOUT PVE_VMID PVE_HOST PVE_VM_NAME PVE_SNAPSHOT E2E_CMD UNIFI_ZBF_SNAPSHOT UNIFI_EMU_ZBF_AUTHKEY
  export PVE_POLL_SECONDS=0.05 PVE_SHUTDOWN_TIMEOUT=1 PVE_STOP_GRACE=1 E2E_SKIP_WAIT=1
}

ok() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASSED=$((PASSED + 1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s  %s\n' "$1" "${2:-}"; FAILED=$((FAILED + 1)); }
expect() { # name actual expected
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi
}
actions() { tr '\n' ' ' <"$CASE/actions.log" | sed 's/ $//'; }
state() { cat "$CASE/state"; }

echo "config file"
new_case perms; chmod 644 "$UNIFI_VM_CONFIG"
"$DIR/pve-vm" status >/dev/null 2>"$CASE/err"; expect "world-readable file refused" "$?" 1
grep -q "chmod 600" "$CASE/err" && ok "says how to fix it" || bad "says how to fix it"
expect "no ssh call was made" "$(wc -l <"$CASE/ssh.log")" 0

new_case badkey; echo 'PATH=/evil' >>"$UNIFI_VM_CONFIG"
"$DIR/pve-vm" status >/dev/null 2>&1; expect "unexpected key refused (file is data, not code)" "$?" 1

new_case injection
for bad in 'PVE_VMID=105;reboot' 'PVE_VMID=abc' 'PVE_SNAPSHOT=a b' 'PVE_HOST=-oProxyCommand=x'; do
  new_case injection; env "$bad" "$DIR/pve-vm" status >/dev/null 2>&1
  expect "refused: $bad" "$?" 1
  expect "  without any ssh call" "$(wc -l <"$CASE/ssh.log")" 0
done

new_case envwins; echo 'PVE_VMID=105' >/dev/null
PVE_VMID=999 "$DIR/pve-vm" status >/dev/null 2>&1; grep -q "qm status 999" "$CASE/ssh.log" && ok "environment overrides the file" || bad "environment overrides the file"

echo "pve-vm"
new_case guards; FAKE_SNAPS=Outro "$DIR/pve-vm" restore >/dev/null 2>&1
expect "missing snapshot: restore refused" "$?" 1; expect "  nothing rolled back" "$(actions)" ""
new_case name; FAKE_NAME=producao "$DIR/pve-vm" restore >/dev/null 2>&1
expect "wrong VM name: restore refused" "$?" 1; expect "  nothing rolled back" "$(actions)" ""
new_case down; FAKE_SSH_DOWN=1 "$DIR/pve-vm" start >/dev/null 2>&1; expect "unreachable host is an error, not a state" "$?" 1
expect "  no start attempted" "$(actions)" ""
new_case stopvm; "$DIR/pve-vm" stop >/dev/null 2>&1; expect "stop shuts a running VM down" "$(state)" stopped
new_case startvm; echo stopped >"$CASE/state"; "$DIR/pve-vm" start >/dev/null 2>&1; expect "start starts a stopped VM" "$(state)" running
"$DIR/pve-vm" start >/dev/null 2>&1; expect "  and does nothing if it already runs" "$(actions)" "start"
new_case stubborn; FAKE_NO_STOP=1 "$DIR/pve-vm" stop >/dev/null 2>&1; expect "stop fails loudly if the VM stays up" "$?" 1

echo "run.sh"
new_case happy; E2E_CMD="echo tests >>$CASE/actions.log" "$DIR/run.sh" >/dev/null 2>&1
expect "happy path ends with success" "$?" 0
expect "  order: restore, start, tests, restore (VM already stopped by it)" "$(actions)" "rollback Inicial start tests rollback Inicial"
expect "  VM left stopped" "$(state)" stopped

new_case failing; E2E_CMD="echo tests >>$CASE/actions.log; exit 7" "$DIR/run.sh" >/dev/null 2>&1
expect "failing tests keep their exit code" "$?" 7
expect "  VM still restored and stopped afterwards" "$(actions)" "rollback Inicial start tests rollback Inicial"
expect "  VM left stopped" "$(state)" stopped

new_case vmstate; FAKE_ROLLBACK_LEAVES=running E2E_CMD="true" "$DIR/run.sh" >/dev/null 2>&1
expect "snapshot that restores a running VM: no extra start" "$(actions)" "rollback Inicial rollback Inicial shutdown"

new_case interrupt # SIGTERM: a background job started by a script ignores SIGINT; a terminal Ctrl-C reaches run.sh directly
E2E_CMD="sleep 30" "$DIR/run.sh" >/dev/null 2>&1 &
pid=$!
for _ in $(seq 100); do grep -q start "$CASE/actions.log" && break; sleep 0.1; done
sleep 0.3; kill -TERM "$pid"; wait "$pid"; rc=$?
expect "being killed exits 143" "$rc" 143
expect "  and still restores and stops" "$(actions)" "rollback Inicial start rollback Inicial"
expect "  VM left stopped" "$(state)" stopped

new_case noteardown; FAKE_ROLLBACK_LEAVES=running FAKE_NO_STOP=1 E2E_CMD="true" "$DIR/run.sh" >/dev/null 2>&1
expect "a VM that will not stop is exit 3 even if the tests passed" "$?" 3

new_case rollfail; FAKE_ROLLBACK_FAIL=1 E2E_CMD="echo tests >>$CASE/actions.log" "$DIR/run.sh" >/dev/null 2>"$CASE/err"
expect "a rollback Proxmox refuses ends the run with exit 1" "$?" 1
expect "  the VM was never touched, so nothing is put back and it is not shut down" "$(actions)" ""
grep -q "TEARDOWN FAILED" "$CASE/err" && bad "  no false 'TEARDOWN FAILED'" || ok "  no false 'TEARDOWN FAILED'"
grep -q "NEWEST snapshot" "$CASE/err" && ok "  the error names the ZFS rule" || bad "  the error names the ZFS rule"
new_case desc; FAKE_SNAPS=Outro FAKE_DESC="made before Inicial" E2E_CMD="echo tests >>$CASE/actions.log" "$DIR/run.sh" >/dev/null 2>&1
expect "a snapshot name inside a description is not a snapshot" "$?" 1
expect "  nothing was done" "$(actions)" ""
new_case stopwait; SECONDS=0; env FAKE_NO_STOP=1 PVE_SHUTDOWN_TIMEOUT=1 PVE_STOP_GRACE=2 PVE_POLL_SECONDS=0.5 "$DIR/pve-vm" stop >/dev/null 2>&1; w=$SECONDS
[ "$w" -ge 3 ] && [ "$w" -le 4 ] && ok "the stop wait lasts its timeout in seconds, not in polls (took ${w}s for 1+2)" || bad "the stop wait lasts its timeout in seconds" "took ${w}s, wanted 3 or 4"
new_case nosnap; FAKE_SNAPS=Outro E2E_CMD="echo tests >>$CASE/actions.log" "$DIR/run.sh" >/dev/null 2>&1
rc=$?; [ "$rc" -ne 0 ] && ok "no snapshot: run refuses" || bad "no snapshot: run refuses"
grep -q tests "$CASE/actions.log" && bad "  tests must not run" || ok "  tests did not run"
grep -q rollback "$CASE/actions.log" && bad "  nothing may be rolled back" || ok "  nothing was rolled back"

new_case secrets; E2E_CMD='[ "$UNIFI_TEST_API_KEY" = secret-key ] && [ "$UNIFI_VM_ROOT_PASSWORD" = "pa ss" ]' "$DIR/run.sh" >/dev/null 2>&1
expect "tests receive the secrets from the file" "$?" 0
new_case nolog; E2E_CMD="true" "$DIR/run.sh" >"$CASE/out" 2>&1; ! grep -rqE "secret-key|pa ss" "$CASE/out" "$CASE/ssh.log" && ok "secrets never reach output or ssh" || bad "secrets leaked"

new_case lock; exec 8>"${XDG_RUNTIME_DIR:-/tmp}/unifi-vm-e2e-105.lock"; flock -n 8
E2E_CMD="true" "$DIR/run.sh" >/dev/null 2>&1; expect "a second run on the same VM is refused" "$?" 1; exec 8>&-
expect "  without touching the VM" "$(actions)" ""

echo "finding the API by itself"
NEIGH='192.0.2.10 dev vmbr0 lladdr bc:24:11:aa:bb:cc REACHABLE'
new_case discover; FAKE_NEIGH="$NEIGH" FAKE_CURL_OK=192.0.2.10:11443 E2E_SKIP_WAIT= E2E_CMD="echo \$UNIFI_VM_ENDPOINT >$CASE/endpoint" "$DIR/run.sh" >/dev/null 2>&1
expect "no host configured: address from the Proxmox neighbour table, port 11443 found" "$(cat "$CASE/endpoint" 2>/dev/null)" 192.0.2.10:11443
grep -q ':443/' "$CASE/curl.log" && ok "  443 was tried first" || bad "  443 was tried first"
grep -q secret-key "$CASE/curl.log" && bad "  the key must not be on curl's command line" || ok "  the key is not on curl's command line"
grep -q 'X-API-KEY: secret-key' "$CASE/curl.stdin" && ok "  the key is sent to curl on stdin" || bad "  the key is sent to curl on stdin"
expect "  VM left restored and stopped" "$(actions)" "rollback Inicial start rollback Inicial"

new_case agent; FAKE_GUEST='"ip-address" : "127.0.0.1", "ip-address" : "fe80::1", "ip-address" : "10.0.0.7"' FAKE_NEIGH="$NEIGH" FAKE_CURL_OK=10.0.0.7:443 E2E_SKIP_WAIT= E2E_CMD="echo \$UNIFI_VM_ENDPOINT >$CASE/endpoint" "$DIR/run.sh" >/dev/null 2>&1
expect "guest agent address wins over the neighbour table (loopback and IPv6 skipped)" "$(cat "$CASE/endpoint" 2>/dev/null)" 10.0.0.7:443

new_case hostgiven; UNIFI_VM_HOST=192.0.2.10 FAKE_CURL_OK=192.0.2.10:11443 E2E_SKIP_WAIT= E2E_CMD="echo \$UNIFI_VM_ENDPOINT >$CASE/endpoint" "$DIR/run.sh" >/dev/null 2>&1
expect "host given: only the port is found" "$(cat "$CASE/endpoint" 2>/dev/null)" 192.0.2.10:11443
grep -q 'neigh' "$CASE/ssh.log" && bad "  no discovery needed" || ok "  Proxmox was not asked for the address"

new_case exact; UNIFI_VM_HOST=1.2.3.4:8443 FAKE_CURL_OK=1.2.3.4:8443 E2E_SKIP_WAIT= E2E_CMD="echo \$UNIFI_VM_ENDPOINT >$CASE/endpoint" "$DIR/run.sh" >/dev/null 2>&1
expect "host:port given is used as is" "$(cat "$CASE/endpoint" 2>/dev/null)" 1.2.3.4:8443
grep -q '11443\|:443/' "$CASE/curl.log" && bad "  no other port probed" || ok "  no other port was probed"

new_case portlist; UNIFI_VM_HOST=1.2.3.4 UNIFI_VM_PORT=8443 FAKE_CURL_OK=1.2.3.4:8443 E2E_SKIP_WAIT= E2E_CMD="echo \$UNIFI_VM_ENDPOINT >$CASE/endpoint" "$DIR/run.sh" >/dev/null 2>&1
expect "UNIFI_VM_PORT overrides the port list" "$(cat "$CASE/endpoint" 2>/dev/null)" 1.2.3.4:8443

new_case silent; UNIFI_VM_HOST=1.2.3.4 UNIFI_VM_READY_TIMEOUT=1 FAKE_CURL_401=1.2.3.4:443 E2E_SKIP_WAIT= E2E_CMD="echo tests >>$CASE/actions.log" "$DIR/run.sh" >/dev/null 2>"$CASE/err"
expect "API never answers 200: run fails" "$?" 1
grep -q 'last probe: 1.2.3.4:11443 answered HTTP 000' "$CASE/err" && ok "  the message says what was last seen" || bad "  the message says what was last seen" "$(tail -3 "$CASE/err")"
expect "  tests did not run, VM still restored and stopped" "$(actions)" "rollback Inicial start rollback Inicial"

new_case spa; UNIFI_VM_HOST=1.2.3.4 UNIFI_VM_READY_TIMEOUT=1 FAKE_CURL_HTML=1.2.3.4:11443 E2E_SKIP_WAIT= E2E_CMD="echo tests >>$CASE/actions.log" "$DIR/run.sh" >/dev/null 2>"$CASE/err"
expect "a web page answering 200 is not the API: run fails" "$?" 1
grep -q '1.2.3.4:11443 answered HTTP 200 (not JSON: text/html)' "$CASE/err" && ok "  the message says it was a web page" || bad "  the message says it was a web page" "$(tail -3 "$CASE/err")"
expect "  tests did not run" "$(actions)" "rollback Inicial start rollback Inicial"

new_case badport; UNIFI_VM_PORT='443;x' E2E_SKIP_WAIT= E2E_CMD="true" "$DIR/run.sh" >/dev/null 2>&1
expect "bad port setting is refused" "$?" 1
expect "  before the VM is touched" "$(actions)" ""
new_case badhost; UNIFI_VM_HOST='-oProxyCommand=x' E2E_SKIP_WAIT= E2E_CMD="true" "$DIR/run.sh" >/dev/null 2>&1
expect "bad host setting is refused" "$?" 1
expect "  before the VM is touched" "$(actions)" ""

echo "virtual devices (opt-in)"
EMU=ghcr.io/jamesbraid/unifi-emu:0.5.2
emu_env() { env UNIFI_VM_HOST=1.2.3.4 FAKE_CURL_OK=1.2.3.4:443 E2E_SKIP_WAIT= UNIFI_EMU_IMAGE=$EMU "$@"; }
runs() { grep '^run ' "$CASE/docker.log"; }

new_case emu; emu_env E2E_CMD="echo \$UNIFI_EMU_RUNNING >$CASE/flag; echo tests >>$CASE/actions.log" "$DIR/run.sh" >/dev/null 2>"$CASE/err"
expect "emulator run succeeds" "$?" 0
expect "  one container per device, started after the API is up, all removed before the VM is restored" "$(actions)" "rollback Inicial start docker-rm docker-run docker-run tests docker-rm rollback Inicial"
expect "  tests are told the devices are running" "$(cat "$CASE/flag" 2>/dev/null)" 1
expect "  access point: newest release of its own model, not an older one, not another product" "$(runs | sed -n 1p)" "run -d --name unifi-e2e-emu-105-1 $EMU -model U7PRO -version 8.7.11.19419 -mac 00:27:22:e0:00:01 -ip 192.168.1.100 -name emu-u7pro-1 -inform http://1.2.3.4:8080/inform"
expect "  switch: its own MAC, address and name" "$(runs | sed -n 2p)" "run -d --name unifi-e2e-emu-105-2 $EMU -model USM8P -version 2.1.8.971 -mac 00:27:22:e0:00:02 -ip 192.168.1.101 -name emu-usm8p-2 -inform http://1.2.3.4:8080/inform"
grep -q 'fw-update.ubnt.com' "$CASE/curl.log" && ok "  the firmware index was read once from Ubiquiti" || bad "  the firmware index was read once from Ubiquiti"

new_case gw; emu_env UNIFI_EMU_MODELS=U7PRO,UXGPRO E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
expect "gateway gets the newest of the whole UXG family (the index files 5.x under other names)" "$(runs | sed -n 2p | grep -o '\-version [0-9.]*')" "-version 5.1.26.33914"

new_case oldfw; emu_env UNIFI_EMU_FIRMWARE=default E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
runs | grep -q -- '-version' && bad "UNIFI_EMU_FIRMWARE=default keeps the emulator's own versions" || ok "UNIFI_EMU_FIRMWARE=default keeps the emulator's own versions"
grep -q 'fw-update' "$CASE/curl.log" && bad "  and does not even ask Ubiquiti" || ok "  and does not even ask Ubiquiti"

new_case fwdown; emu_env FAKE_FW_DOWN=1 E2E_CMD=true "$DIR/run.sh" >/dev/null 2>"$CASE/err"
expect "firmware index unreachable: the run still goes on" "$?" 0
grep -q 'WARNING: could not read Ubiquiti' "$CASE/err" && ok "  with a warning" || bad "  with a warning" "$(tail -3 "$CASE/err")"
runs | grep -q -- '-version' && bad "  and without inventing a version" || ok "  and without inventing a version"

new_case fwunknown; emu_env UNIFI_EMU_MODELS=NOPE9 E2E_CMD=true "$DIR/run.sh" >/dev/null 2>"$CASE/err"
grep -q 'WARNING: no firmware found for NOPE9' "$CASE/err" && ok "a model the index does not know is warned about" || bad "a model the index does not know is warned about" "$(tail -3 "$CASE/err")"
expect "  and still started" "$(runs | wc -l | tr -d ' ')" 1

new_case emufail; emu_env E2E_CMD="exit 5" "$DIR/run.sh" >/dev/null 2>&1
expect "failing tests: exit code kept" "$?" 5
expect "  containers still removed, VM restored" "$(actions)" "rollback Inicial start docker-rm docker-run docker-run docker-rm rollback Inicial"

new_case emucustom; emu_env UNIFI_EMU_MODELS=USM8P:2 UNIFI_EMU_INFORM_PORT=9090 E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
expect "a count gives that many devices, each with its own MAC and address" "$(runs | grep -o '\-mac [0-9a-f:]* -ip [0-9.]*' | tr '\n' ' ')" "-mac 00:27:22:e0:00:01 -ip 192.168.1.100 -mac 00:27:22:e0:00:02 -ip 192.168.1.101 "
runs | grep -qv 'http://1.2.3.4:9090/inform' && bad "  inform port can be set" || ok "  inform port can be set"

new_case emudown; emu_env FAKE_DOCKER_FAIL=1 E2E_CMD="echo tests >>$CASE/actions.log" "$DIR/run.sh" >/dev/null 2>&1
expect "container that cannot start: run fails" "$?" 1
expect "  tests did not run, VM restored" "$(actions)" "rollback Inicial start docker-rm docker-run docker-rm rollback Inicial"

new_case emuoff; UNIFI_VM_HOST=1.2.3.4 FAKE_CURL_OK=1.2.3.4:443 E2E_SKIP_WAIT= E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
expect "without UNIFI_EMU_IMAGE docker is never called" "$(wc -l <"$CASE/docker.log")" 0

for bad in 'img; reboot' 'Img/Upper' '-oops'; do
  new_case emubad; UNIFI_EMU_IMAGE=$bad E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
  expect "bad image reference refused: $bad" "$?" 1
  expect "  before the VM is touched" "$(actions)" ""
done
new_case emumodels; UNIFI_EMU_IMAGE=$EMU UNIFI_EMU_MODELS='U7PRO;x' E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
expect "bad model list refused" "$?" 1; expect "  before the VM is touched" "$(actions)" ""
new_case emufwbad; UNIFI_EMU_IMAGE=$EMU UNIFI_EMU_FIRMWARE=newest E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
expect "UNIFI_EMU_FIRMWARE other than latest/default refused" "$?" 1; expect "  before the VM is touched" "$(actions)" ""
new_case emuskip; UNIFI_EMU_IMAGE=$EMU E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
expect "emulator without waiting for the API is refused (no address to inform to)" "$?" 1
expect "  and the VM is still restored" "$(actions)" "rollback Inicial start rollback Inicial"

echo "virtual-devices (by hand, VM already running)"
echo "zbf-authkey (writes the settings file)"
ZA=0123456789abcdef0123456789abcdef
ZB=fedcba9876543210fedcba9876543210
new_case zk; printf 'mgmt_cfg: "capability=notif\\nauthkey=%s\\nled=1"\nother line\n' $ZA >"$CASE/docker.logs"
cp "$UNIFI_VM_CONFIG" "$CASE/env.before"
"$DIR/zbf-authkey" some-container >"$CASE/out" 2>&1
expect "the key is stored" "$?" 0
grep -qx "UNIFI_EMU_ZBF_AUTHKEY=$ZA" "$UNIFI_VM_CONFIG" && ok "  as UNIFI_EMU_ZBF_AUTHKEY" || bad "  as UNIFI_EMU_ZBF_AUTHKEY"
grep -qx "UNIFI_ZBF_SNAPSHOT=ZBF" "$UNIFI_VM_CONFIG" && ok "  with the default snapshot name" || bad "  with the default snapshot name"
expect "  every other line is untouched" "$(grep -vE '^UNIFI_(EMU_ZBF_AUTHKEY|ZBF_SNAPSHOT)=' "$UNIFI_VM_CONFIG")" "$(cat "$CASE/env.before")"
expect "  mode stays 600" "$(stat -c %a "$UNIFI_VM_CONFIG")" 600
grep -q "$ZA" "$CASE/out" && bad "  the key is never printed" || ok "  the key is never printed"
printf 'UNIFI_EMU_ZBF_AUTHKEY=old\nUNIFI_ZBF_SNAPSHOT=Old' >>"$UNIFI_VM_CONFIG"   # old lines, the last one without a newline
printf 'authkey=%s\n' $ZB >"$CASE/docker.logs"
"$DIR/zbf-authkey" some-container Snap2 >/dev/null 2>&1
expect "a second run replaces the old lines, once each" "$(grep -c '^UNIFI_EMU_ZBF_AUTHKEY=' "$UNIFI_VM_CONFIG") $(grep -c '^UNIFI_ZBF_SNAPSHOT=' "$UNIFI_VM_CONFIG")" "1 1"
grep -qx "UNIFI_EMU_ZBF_AUTHKEY=$ZB" "$UNIFI_VM_CONFIG" && grep -qx "UNIFI_ZBF_SNAPSHOT=Snap2" "$UNIFI_VM_CONFIG" && ok "  new key and snapshot name" || bad "  new key and snapshot name"
cp "$UNIFI_VM_CONFIG" "$CASE/env.before"
printf 'authkey=%s authkey=%s\n' $ZA $ZB >"$CASE/docker.logs"
"$DIR/zbf-authkey" some-container >/dev/null 2>&1
expect "two different keys in the log: refused" "$?" 1
printf 'no key here\n' >"$CASE/docker.logs"
"$DIR/zbf-authkey" some-container >/dev/null 2>&1
expect "no key in the log: refused" "$?" 1
expect "  the file is left as it was" "$(cat "$UNIFI_VM_CONFIG")" "$(cat "$CASE/env.before")"
"$DIR/zbf-authkey" 'bad name;x' >/dev/null 2>&1
expect "a bad container name is refused" "$?" 2
[ -z "$(find "$CASE" -maxdepth 1 -name "vm.env.??????" -print -quit)" ] && ok "  no temp file is left behind" || bad "  no temp file is left behind"

echo "settings file values"
new_case cfg; printf 'PVE_VMID=105\nPVE_HOST=pve\nUNIFI_EMU_IMAGE=img:1 \nUNIFI_VM_ROOT_PASSWORD="pa ss "\nUNIFI_TEST_API_KEY=k   \n' >"$UNIFI_VM_CONFIG"; chmod 600 "$UNIFI_VM_CONFIG"
expect "blanks after an unquoted value are dropped, inside quotes kept" "$(bash -c ". '$DIR/lib.sh'; load_config; printf '[%s][%s][%s]' \"\$UNIFI_EMU_IMAGE\" \"\$UNIFI_VM_ROOT_PASSWORD\" \"\$UNIFI_TEST_API_KEY\"")" "[img:1][pa ss ][k]"

echo "zone-based firewall: the snapshot with the upgrade is the one restored (opt-in)"
ZK=0123456789abcdef0123456789abcdef
zbf_env() { emu_env FAKE_SNAPS="Inicial ZBF" UNIFI_EMU_MODELS=U7PRO UNIFI_ZBF_SNAPSHOT=ZBF UNIFI_EMU_ZBF_AUTHKEY=$ZK "$@"; }
new_case zbf; zbf_env E2E_CMD="echo \$UNIFI_ZBF_EXPECTED >$CASE/expected; echo tests >>$CASE/actions.log" "$DIR/run.sh" >/dev/null 2>&1
expect "zbf run succeeds" "$?" 0
expect "  every restore is of the ZBF snapshot, never Inicial" "$(actions)" "rollback ZBF start docker-rm docker-run docker-run tests docker-rm rollback ZBF"
expect "  the gateway (first device) gets the key in its environment, the access point none" "$(cat "$CASE/docker.env")" "$(printf 'key-in-env=%s\nkey-in-env=none' $ZK)"
expect "  the first container is a UXGB started with -e and no key on the command line" "$(runs | sed -n 1p | sed 's/ -version.*//')" "run -d -e UNIFI_EMU_AUTHKEY --name unifi-e2e-emu-105-1 $EMU -model UXGB"
expect "  the access point is second, with no -e" "$(runs | sed -n 2p | sed 's/ -version.*//')" "run -d --name unifi-e2e-emu-105-2 $EMU -model U7PRO"
grep -q "$ZK" "$CASE/docker.log" "$CASE/ssh.log" && bad "  the authkey never reaches a command line" || ok "  the authkey never reaches a command line"
expect "  the firewall tests are told the zones are expected" "$(cat "$CASE/expected")" 1
new_case zbfoff; emu_env E2E_CMD='echo ${UNIFI_ZBF_EXPECTED:-no} >'"$CASE/expected" "$DIR/run.sh" >/dev/null 2>&1
expect "without a ZBF snapshot nothing changes: Inicial, and zones are not expected" "$(actions | cut -c1-16) $(cat "$CASE/expected")" "rollback Inicial no"
new_case zbfstale; emu_env UNIFI_EMU_MODELS=U7PRO UNIFI_EMU_ZBF_AUTHKEY=$ZK E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
expect "a leftover key without a ZBF snapshot is not given to any device" "$(cat "$CASE/docker.env")" "key-in-env=none"
new_case zbfkey; emu_env UNIFI_ZBF_SNAPSHOT=ZBF E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
expect "a ZBF snapshot without image+key is refused before the VM is touched" "$?" 1
expect "  nothing done" "$(actions)" ""
new_case zbfbad; zbf_env UNIFI_EMU_ZBF_AUTHKEY=nothex E2E_CMD=true "$DIR/run.sh" >/dev/null 2>&1
expect "a bad key is refused" "$?" 1

new_case manual; env UNIFI_EMU_IMAGE=$EMU "$DIR/virtual-devices" up UXGPRO 1.2.3.4 >/dev/null 2>&1
expect "up starts the gateway on the newest firmware" "$(runs | grep -o '\-model [A-Z0-9]* -version [0-9.]*')" "-model UXGPRO -version 5.1.26.33914"
expect "  and never touches the VM" "$(actions | tr -d ' ' | grep -c 'rollback\|start\|shutdown' | tr -d ' ')" 0
env UNIFI_EMU_IMAGE=$EMU "$DIR/virtual-devices" down >/dev/null 2>&1
expect "down removes what up started" "$(cat "$CASE/containers" | wc -l | tr -d ' ')" 0
new_case manualbad; env UNIFI_EMU_IMAGE=$EMU "$DIR/virtual-devices" up 'UXGPRO;x' 1.2.3.4 >/dev/null 2>&1; expect "bad models refused" "$?" 1
env "$DIR/virtual-devices" up UXGPRO 1.2.3.4 >/dev/null 2>&1; expect "no image set: refused" "$?" 1
expect "  nothing was started" "$(runs | wc -l | tr -d ' ')" 0

echo "gateway-caps (read only, prints capability fields only)"
new_case caps; out=$(env UNIFI_API_KEY=typed-key "$DIR/gateway-caps" 192.168.0.1 2>"$CASE/err"); rc=$?
expect "prints the gateway's capability fields" "$rc" 0
grep -q '"udapi_caps": 0' <<<"$out" && grep -q '"usg_caps": 12' <<<"$out" && ok "  udapi_caps and usg_caps are there" || bad "  udapi_caps and usg_caps are there" "$out"
grep -q '"model": "UXGB"' <<<"$out" && ! grep -q U7PRO <<<"$out" && ok "  only gateways, not the access point" || bad "  only gateways, not the access point"
grep -qE 'AUTHSECRET|00:27:22|192\.168\.1\.100|secret-name|SERIAL123' <<<"$out" && bad "  no secret, address, name or serial value is printed" || ok "  no secret, address, name or serial value is printed"
grep -q '"some_other"' <<<"$out" && ok "  the names of the other fields are listed" || bad "  the names of the other fields are listed"
grep -q typed-key "$CASE/curl.log" && bad "  the key is not on curl's command line" || ok "  the key is not on curl's command line"
grep -q 'X-API-KEY: typed-key' "$CASE/curl.stdin" && ok "  the key goes to curl on stdin" || bad "  the key goes to curl on stdin"
grep -q '/api/s/default/stat/device' "$CASE/curl.log" && ok "  one GET of stat/device on the default site" || bad "  one GET of stat/device on the default site"

new_case capsvm; out=$("$DIR/gateway-caps" --vm 192.0.2.10:11443 2>/dev/null); rc=$?
expect "--vm takes the key from the settings file" "$rc" 0
grep -q 'X-API-KEY: secret-key' "$CASE/curl.stdin" && ok "  and still sends it on stdin only" || bad "  and still sends it on stdin only"
grep -q secret-key "$CASE/curl.log" && bad "  not on a command line" || ok "  not on a command line"

new_case capsnokey; "$DIR/gateway-caps" 192.168.0.1 </dev/null >/dev/null 2>"$CASE/err"; expect "no key and no terminal: refused" "$?" 1
grep -q 'run it in a terminal' "$CASE/err" && ok "  with the reason" || bad "  with the reason"
new_case caps401; env UNIFI_API_KEY=k FAKE_STAT_CODE=401 "$DIR/gateway-caps" 192.168.0.1 >/dev/null 2>"$CASE/err"; expect "a refused key is an error" "$?" 1
grep -q 'not accepted by the private API' "$CASE/err" && ok "  that says what it means" || bad "  that says what it means"
new_case capsbad; env UNIFI_API_KEY=k "$DIR/gateway-caps" 'x;reboot' >/dev/null 2>&1; expect "a bad host is refused" "$?" 2
expect "  without any request" "$(wc -l <"$CASE/curl.log" | tr -d ' ')" 0

new_case capsextra; out=$(env UNIFI_API_KEY=k GATEWAY_CAPS_EXTRA=usg_caps,adopted "$DIR/gateway-caps" 192.168.0.1 2>/dev/null)
expect "GATEWAY_CAPS_EXTRA prints the chosen values" "$(jq -c '.[0].extra_values' <<<"$out")" '{"usg_caps":12,"adopted":false}'
for bad in x_authkey mac serial name ip 'a;b'; do
  new_case capsextrabad; env UNIFI_API_KEY=k GATEWAY_CAPS_EXTRA=$bad "$DIR/gateway-caps" 192.168.0.1 >/dev/null 2>&1
  expect "  refuses to print: $bad" "$?" 1
done

echo "e2e test files"
for f in "$DIR"/*.e2e.js; do
  out=$(UNIFI_EMU_RUNNING=1 timeout 60 node --test --require "$DIR/dry-preload.js" "$f" 2>&1)
  if grep -q "ReferenceError" <<<"$out"; then bad "$(basename "$f") uses a name that is not declared" "$(grep -m1 ReferenceError <<<"$out")"; else ok "$(basename "$f") loads and runs with no undeclared name"; fi
done
printf 'const { test } = require("node:test");\ntest("x", async () => { await notDeclared.call(); });\n' >"$ROOT/control.e2e.js"
grep -q ReferenceError < <(node --test --require "$DIR/dry-preload.js" "$ROOT/control.e2e.js" 2>&1) && ok "the check does catch an undeclared name (control)" || bad "the check does catch an undeclared name (control)"

echo
printf 'Total: %d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
