#!/bin/bash
# Builds nidum-local-<version>.zip: the app without test/, docs/ and design/, inside one
# top-level folder nidum-local-<version>/ that holds "Nidum Local.command" and README.txt.
# When scripts/build-menubar.sh exists (N7), the macOS menu bar app is built into
# nidum-local-<version>/macos/Nidum Local Menu.app; a failed build fails the package.
#
#   scripts/package.sh [output-dir]      default output dir: <repo>/dist
#   NIDUM_MENUBAR_BUILD=<script>         build script to use (default scripts/build-menubar.sh;
#                                        tests point it at a stub; a missing file means "skip")
#
# bash 3.2 compatible. Needs zip (preinstalled on macOS).
set -eu

root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out_dir=${1:-${NIDUM_PACKAGE_OUT:-$root/dist}}

version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$root/package.json" | head -n 1)
if [ -z "$version" ]; then
  echo "package.sh: couldn't read the version from package.json" >&2
  exit 1
fi
command -v zip >/dev/null 2>&1 || { echo "package.sh: zip is not installed" >&2; exit 1; }

# What ships. Everything else (test/, docs/, design/, scripts/, .git, .obsidian,
# the design spec and logo drafts) stays out.
items="Nidum Local.command
README.txt
package.json
LICENSE
launchers
src
public"

stage_root=$(mktemp -d "${TMPDIR:-/tmp}/nidum-package.XXXXXX")
trap 'rm -rf "$stage_root"' EXIT
top="nidum-local-$version"
stage="$stage_root/$top"
mkdir "$stage"

oldifs=$IFS
IFS='
'
for item in $items; do
  IFS=$oldifs
  if [ -e "$root/$item" ]; then
    cp -R "$root/$item" "$stage/"
  elif [ "$item" = "Nidum Local.command" ] || [ "$item" = README.txt ] || [ "$item" = launchers ]; then
    echo "package.sh: required file missing: $item" >&2
    exit 1
  fi
done
IFS=$oldifs

# No macOS clutter or local state in the archive.
find "$stage" \( -name .DS_Store -o -name '._*' -o -name '*.log' -o -name node_modules \) -prune -exec rm -rf {} +

chmod 755 "$stage/Nidum Local.command" "$stage/launchers/macos/Nidum Local.command" "$stage/launchers/linux/nidum-local.sh" "$stage/launchers/linux/nidum-local.desktop"
chmod 644 "$stage/README.txt"

menubar_build=${NIDUM_MENUBAR_BUILD:-$root/scripts/build-menubar.sh}
if [ -f "$menubar_build" ]; then
  mkdir -p "$stage/macos"
  if ! /bin/bash "$menubar_build" "$stage/macos/Nidum Local Menu.app" >&2 || [ ! -d "$stage/macos/Nidum Local Menu.app" ]; then
    echo "package.sh: building the menu bar app failed ($menubar_build)" >&2
    exit 1
  fi
else
  echo "package.sh: no $menubar_build, so the zip has no menu bar app" >&2
fi

mkdir -p "$out_dir"
out_dir=$(cd -P "$out_dir" && pwd)
zip_path="$out_dir/nidum-local-$version.zip"
rm -f "$zip_path"
( cd "$stage_root" && zip -q -r -X -y "$zip_path" "$top" )
echo "$zip_path"
