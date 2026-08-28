#!/bin/sh
set -eu

ip_binary="@ipBinary@"
stat_binary="@statBinary@"
sleep_binary="@sleepBinary@"
tr_binary="@trBinary@"
caller_uid="${PKEXEC_UID:-}"

cleanup() {
  "$ip_binary" rule del pref 9020 2>/dev/null || true
  "$ip_binary" -6 rule del pref 9020 2>/dev/null || true
  "$ip_binary" route flush table 20220 2>/dev/null || true
  "$ip_binary" -6 route flush table 20220 2>/dev/null || true
  "$ip_binary" link delete nixvpn0 2>/dev/null || true
}

stop_core() {
  config_path="$1"
  case "$config_path" in
    */runtime-config.json) ;;
    *) exit 2 ;;
  esac
  [ -n "$caller_uid" ] || exit 3
  [ -f "$config_path" ] || exit 4
  [ "$($stat_binary -c '%u' "$config_path")" = "$caller_uid" ] || exit 5

  for proc in /proc/[0-9]*; do
    pid=${proc##*/}
    [ "$pid" != "$$" ] || continue
    [ "$($stat_binary -c '%u' "$proc" 2>/dev/null || true)" = "0" ] || continue
    command_line=$($tr_binary '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)
    case "$command_line" in
      *sing-box*"$config_path"*) kill -TERM "$pid" 2>/dev/null || true ;;
    esac
  done

  "$sleep_binary" 1
  for proc in /proc/[0-9]*; do
    pid=${proc##*/}
    [ "$pid" != "$$" ] || continue
    [ "$($stat_binary -c '%u' "$proc" 2>/dev/null || true)" = "0" ] || continue
    command_line=$($tr_binary '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)
    case "$command_line" in
      *sing-box*"$config_path"*) kill -KILL "$pid" 2>/dev/null || true ;;
    esac
  done
}

case "${1:-}" in
  cleanup)
    [ "$#" -eq 1 ] || exit 2
    cleanup
    ;;
  stop-core)
    [ "$#" -eq 2 ] || exit 2
    stop_core "$2"
    ;;
  *)
    exit 2
    ;;
esac
