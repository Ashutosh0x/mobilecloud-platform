#!/usr/bin/env bash
# MobileCloud device bootstrap: disable the Android Phantom Process Killer
# (research report section 5.1A).
#
# Android 12–16 caps app child processes at 32 and kills violators with
# SIGKILL — fatal for a daemon that forks builders and PTY shells. The
# overrides below lift the cap and pin it across syncs.
#
# Usage:
#   ./config/adb-bootstrap.sh                 # apply to the connected device
#   ./config/adb-bootstrap.sh --check         # read back the current values
set -euo pipefail

ADB="${ADB:-adb}"

run() { "$ADB" shell "$1"; }

check_only=0
[[ "${1:-}" == "--check" ]] && check_only=1

echo "==> MobileCloud ADB bootstrap (Phantom Process Killer disable)"

echo "==> [1/4] Lift the child-process cap (2147483647 = INT_MAX)"
if (( check_only )); then
  run "/system/bin/device_config get activity_manager max_phantom_processes"
else
  run "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
fi

echo "==> [2/4] Persist across device_config syncs"
if (( ! check_only )); then
  run "/system/bin/device_config set_sync_disabled_for_tests persistent"
fi

echo "==> [3/4] Disable phantom process monitoring"
if (( check_only )); then
  run "settings get global settings_enable_monitor_phantom_procs"
else
  run "settings put global settings_enable_monitor_phantom_procs false"
fi

echo "==> [4/4] Doze exemption (WebSockets survive screen-off)"
if (( ! check_only )); then
  run "dumpsys deviceidle whitelist +com.mobilecloud.node"
fi

echo "==> Current limits:"
run "/system/bin/device_config get activity_manager max_phantom_processes" || true
run "cat /proc/sys/fs/file-max" || true

echo "==> Done. Verify battery bypass with:"
echo "    $ADB shell cat /sys/class/power_supply/battery/status   # expect: Not charging / Full"
