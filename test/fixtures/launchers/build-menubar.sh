#!/bin/bash
# Fake scripts/build-menubar.sh (contract: build-menubar.sh <output .app path>). Never compiles:
# it writes a minimal bundle so the launcher and package.sh have something to place. Like the
# real script, the executable is NidumLocalMenu, the bundle id io.nidum.local.menu, and
# CFBundleShortVersionString comes from the package.json one folder up (STUB_BUILD_VERSION
# overrides; 0.0.0 when there is none).
echo "build-menubar $*" >>"${STUB_LOG:-/dev/null}"
echo "build-menubar archs=${NIDUM_MENUBAR_ARCHS:-}" >>"${STUB_LOG:-/dev/null}"
if [ "${STUB_BUILD_FAIL:-}" = 1 ]; then echo "error: build failed" >&2; exit 1; fi
version=${STUB_BUILD_VERSION:-}
pkg="$(dirname "$0")/../package.json"
if [ -z "$version" ] && [ -f "$pkg" ]; then
  version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -n 1)
fi
version=${version:-0.0.0}
app=$1
mkdir -p "$app/Contents/MacOS"
printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleExecutable</key>\n\t<string>NidumLocalMenu</string>\n\t<key>CFBundleIdentifier</key>\n\t<string>io.nidum.local.menu</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>%s</string>\n\t<key>LSUIElement</key>\n\t<true/>\n</dict>\n</plist>\n' "$version" >"$app/Contents/Info.plist"
printf '#!/bin/bash\nexit 0\n' >"$app/Contents/MacOS/NidumLocalMenu"
chmod 755 "$app/Contents/MacOS/NidumLocalMenu"
echo "built $app"
