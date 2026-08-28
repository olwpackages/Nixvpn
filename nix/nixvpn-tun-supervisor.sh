#!/usr/bin/env bash
set -eu

sing_box="@singBox@"
ip_binary="@ipBinary@"
stat_binary="@statBinary@"
config_path="${1:-}"
caller_uid="${PKEXEC_UID:-}"

if [ "$sing_box" = "@singBox@" ]; then
  sing_box="$(command -v sing-box 2>/dev/null || true)"
  [ -n "$sing_box" ] || sing_box=/run/current-system/sw/bin/sing-box
fi
if [ "$ip_binary" = "@ipBinary@" ]; then
  ip_binary="$(command -v ip 2>/dev/null || true)"
  [ -n "$ip_binary" ] || ip_binary=/run/current-system/sw/bin/ip
fi
if [ "$stat_binary" = "@statBinary@" ]; then
  stat_binary="$(command -v stat 2>/dev/null || true)"
  [ -n "$stat_binary" ] || stat_binary=/run/current-system/sw/bin/stat
fi

case "$config_path" in
  */runtime-config.json) ;;
  *) exit 2 ;;
esac
[ -n "$caller_uid" ] || exit 3
[ -f "$config_path" ] || exit 4
[ "$($stat_binary -c '%u' "$config_path")" = "$caller_uid" ] || exit 5

cleanup() {
  "$ip_binary" rule del pref 9020 2>/dev/null || true
  "$ip_binary" -6 rule del pref 9020 2>/dev/null || true
  "$ip_binary" route flush table 20220 2>/dev/null || true
  "$ip_binary" -6 route flush table 20220 2>/dev/null || true
  "$ip_binary" link delete nixvpn0 2>/dev/null || true
}

core_pid=""
stop_core() {
  if [ -n "$core_pid" ]; then
    kill -INT "$core_pid" 2>/dev/null || true
    wait "$core_pid" 2>/dev/null || true
    core_pid=""
  fi
  cleanup
  exit 0
}

restart_core() {
  if [ -n "$core_pid" ]; then
    kill -INT "$core_pid" 2>/dev/null || true
    wait "$core_pid" 2>/dev/null || true
    core_pid=""
  fi
  cleanup
  "$sing_box" run --config "$config_path" &
  core_pid=$!
  printf '%s\n' 'NIXVPN_CORE_RESTARTED'
}

trap stop_core INT TERM HUP
"$sing_box" run --config "$config_path" &
core_pid=$!

while kill -0 "$core_pid" 2>/dev/null; do
  if read -r -t 1 command; then
    case "$command" in
      stop) stop_core ;;
      restart) restart_core ;;
    esac
  fi
done

wait "$core_pid" 2>/dev/null || true
core_pid=""
cleanup
