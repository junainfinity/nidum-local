#!/bin/bash
# Nidum Local launcher for macOS. Double-click to open the dashboard.
# Runs under /bin/bash 3.2: keep it free of bash 4+ features (checked with /bin/bash -n).
# Set NIDUM_DRY_RUN=1 to see every action without doing it.

# Find this file's real folder, following symlinks (no readlink -f on older macOS).
nidum_self="${BASH_SOURCE[0]}"
while [ -h "$nidum_self" ]; do
  nidum_dir=$(cd -P "$(dirname "$nidum_self")" && pwd)
  nidum_self=$(readlink "$nidum_self")
  case "$nidum_self" in /*) ;; *) nidum_self="$nidum_dir/$nidum_self" ;; esac
done
NIDUM_LAUNCHER_DIR=$(cd -P "$(dirname "$nidum_self")" && pwd)
NIDUM_PLATFORM=macos

if [ ! -f "$NIDUM_LAUNCHER_DIR/../lib/nidum-launcher.sh" ]; then
  printf '\n  ✗ Nidum Local is incomplete: launchers/lib/nidum-launcher.sh is missing.\n'
  printf '    Download Nidum Local again and unzip it.\n\n  Press any key to close.'
  IFS= read -r -s -n 1 nidum_key
  printf '\n'
  exit 1
fi
. "$NIDUM_LAUNCHER_DIR/../lib/nidum-launcher.sh"
nidum_main "$@"
