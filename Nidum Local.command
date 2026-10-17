#!/bin/bash
# Nidum Local: double-click to start. This file only hands over to
# launchers/macos/Nidum Local.command, found next to this file's real location.
nidum_self="${BASH_SOURCE[0]}"
while [ -h "$nidum_self" ]; do
  nidum_dir=$(cd -P "$(dirname "$nidum_self")" && pwd)
  nidum_self=$(readlink "$nidum_self")
  case "$nidum_self" in /*) ;; *) nidum_self="$nidum_dir/$nidum_self" ;; esac
done
nidum_root=$(cd -P "$(dirname "$nidum_self")" && pwd)
exec /bin/bash "$nidum_root/launchers/macos/Nidum Local.command" "$@"
