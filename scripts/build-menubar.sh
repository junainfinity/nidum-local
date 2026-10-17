#!/bin/bash
# Builds the Nidum Local menu bar app (node N7) into an .app bundle.
#
#   scripts/build-menubar.sh <output .app path>
#   NIDUM_MENUBAR_ARCHS="arm64 x86_64"   architectures (default both, joined with lipo;
#                                        "native" = this Mac's only)
#
# swiftc (AppKit only, -warnings-as-errors, macOS 13+), Info.plist with LSUIElement (no
# Dock icon), ad-hoc signature (codesign -s -). Every tool call has a deadline (macOS has
# no `timeout`: perl alarm). bash 3.2 compatible.
#
# Concurrent builds of one output are safe (N7 validation 1 finding 6, validation 2 finding 6):
#   - Builds of the same output are serialized by an flock on a lock folder named after
#     it, `.<name>.app.lock`, beside the bundle (never inside it). The lock is taken on
#     fd 9, which this script and every tool it runs share, so it is released only when
#     all of them are gone, even after a kill. Builds of other outputs in the same folder
#     don't wait. The lock folder is removed (while still held) when the build ends; a
#     waiter that then finds it gone or replaced takes the lock again on the new one.
#     A build that arrives just as it is removed (gone, or replaced, before it holds the
#     lock) starts over after a short pause, at most 15 times (N7 validation 3 finding 1).
#     A SIGKILL can leave it behind: the next build reuses it and removes it.
#   - A build that had to wait exits 0 without building only when, while it waited, the
#     other build put a new bundle in place (the output's inode changed) and that bundle is
#     valid for this version. Otherwise it builds. The wait is capped at 840 s.
#   - Work folders of a killed earlier build of this output are removed first, under the
#     lock (so none of them can still be in use).
#   - The bundle is assembled in `.<name>.app.build.XXXXXX` beside the output and moved
#     into place with rename(2) (the old bundle is first renamed aside and is put back
#     if anything fails), so the output is always the old bundle, the new one, or — only
#     if killed between the two renames — absent. Never a mix.
#   - scripts/package.sh zips the folder it builds into. The lock folder and the work
#     folder are removed on every exit this script sees; a SIGKILL makes the build fail,
#     and package.sh then stops before zipping. So no lock artefact reaches a zip.
# Worst case for one architecture (no lock wait): swiftc 600 + plutil 30 + codesign 120 +
# verify 60 + lipo 30 = 840 s (launchers/lib/nidum-launcher.sh NIDUM_MENU_BUILD_LIMIT).
set -eu

fail() { echo "build-menubar.sh: $*" >&2; exit 1; }
deadline() { local secs=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec $ARGV[0]: $!\n"' "$secs" "$@"; }

[ $# -eq 1 ] && [ -n "$1" ] || { echo "usage: scripts/build-menubar.sh <output .app path>" >&2; exit 2; }
out=$1
case "$out" in *.app|*.app/) out=${out%/} ;; *) fail "the output path must end in .app: $out" ;; esac
[ "$(uname -s)" = Darwin ] || fail "the menu bar app is macOS only"

root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
src="$root/macos/menubar"
command -v swiftc >/dev/null 2>&1 || fail "swiftc isn't installed (install the Xcode Command Line Tools: xcode-select --install)"
[ -f "$src/main.swift" ] && [ -f "$src/Info.plist" ] || fail "missing sources in $src"

version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$root/package.json" | head -n 1)
[ -n "$version" ] || fail "couldn't read the version from package.json"

archs=${NIDUM_MENUBAR_ARCHS:-arm64 x86_64}
if [ "$archs" = native ]; then archs=$(uname -m); fi

parent=$(dirname "$out")
base=$(basename "$out")
case "$base" in .*) fail "the output name must not start with a dot: $base" ;; esac
mkdir -p "$parent" 2>/dev/null && [ -d "$parent" ] || fail "can't create the folder $parent"
lockdir="$parent/.$base.lock"
lock_wait=840

# The output's identity (device, inode, ctime) before any wait: a waiter skips its build
# only when this changed while it waited.
out_id() { perl -e 'my @s = lstat($ARGV[0]); print @s ? "$s[0]:$s[1]:$s[10]" : "none"' "$out"; }
before=$(out_id)
waited=0
held=0
locker=
release_lock() {
  # A signal during the wait: stop the waiting helper too.
  if [ -n "$locker" ]; then kill "$locker" 2>/dev/null || true; fi
  # Remove the lock folder while it is still held, then let go (the fd closes on exit).
  if [ "$held" = 1 ]; then rmdir "$lockdir" 2>/dev/null || true; fi
}
trap release_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

started=$SECONDS
# Another build of this output removes the lock folder as it finishes. If that happens
# between our checks, before we hold the lock (the folder is gone, or a new one has
# taken its place), it is a handover, not a problem: start over after a short pause.
# Bounded: at most `race_max` times (about 2.5 s of pauses in all). A folder that is
# there but is a symlink, isn't a folder or isn't ours is still refused at once.
races=0
race_max=15
lock_race() { # what was seen
  races=$((races + 1))
  [ "$races" -le "$race_max" ] || fail "$lockdir kept disappearing or changing while this build tried to lock it ($1, $race_max times); try again"
  exec 9<&-
  case $races in 1) sleep 0.01 ;; 2) sleep 0.02 ;; 3) sleep 0.05 ;; 4) sleep 0.1 ;; *) sleep 0.2 ;; esac
}
gone() { [ ! -e "$lockdir" ] && [ ! -L "$lockdir" ]; }
while :; do
  # Made here unless it already exists; any other failure (no permission, …) is final.
  perl -e 'mkdir($ARGV[0], 0700) or $!{EEXIST} or die "build-menubar.sh: can'"'"'t create $ARGV[0]: $!\n"' "$lockdir" || exit 1
  [ ! -L "$lockdir" ] || fail "$lockdir is a symlink, not a folder; remove it and try again"
  # Each failed check looks again: only a path that is still there is refused.
  if [ ! -d "$lockdir" ]; then
    if gone; then lock_race "it was gone after mkdir"; continue; fi
    fail "$lockdir isn't a folder; remove it and try again"
  fi
  if ! { exec 9<"$lockdir"; } 2>/dev/null; then
    if gone; then lock_race "it was gone before it could be opened"; continue; fi
    fail "can't open $lockdir"
  fi
  left=$((lock_wait - (SECONDS - started)))
  [ "$left" -gt 0 ] || fail "another build of $out was still running after $lock_wait s"
  # 10 = locked, 11 = locked after waiting; 12/13 = the folder was removed or replaced
  # after it was locked (13: after waiting), so lock the new one; 14 = it was removed or
  # replaced before it was locked (a handover race, see above); anything else is an
  # error. It runs in the background so that a signal to this script ends the wait at
  # once.
  rc=0
  perl -MFcntl=:flock,:mode -e '
    my ($path, $left, $name) = @ARGV; $| = 1;
    sub bail { print STDERR "build-menubar.sh: @_\n"; exit 2 }
    open(my $fh, "<&=", 9) or bail("can'"'"'t use the lock: $!");
    my @f = stat($fh);
    bail("can'"'"'t check $path: $!") unless @f;
    # What was opened must be a folder of ours (ownership is never retried).
    bail("$path isn'"'"'t a folder of yours; remove it and try again") unless S_ISDIR($f[2]) && $f[4] == $>;
    # The path must still name what was opened; otherwise it went away or was replaced
    # since: a race, so start over.
    my @l = lstat($path);
    exit 14 unless @l && $l[0] == $f[0] && $l[1] == $f[1];
    my $waited = 0;
    unless (flock($fh, LOCK_EX | LOCK_NB)) {
      print "build-menubar.sh: another build of $name is running; waiting for it\n";
      $waited = 1;
      local $SIG{ALRM} = sub { bail("another build of $name was still running after the wait limit") };
      alarm $left;
      flock($fh, LOCK_EX) or bail("couldn'"'"'t lock $path: $!");
      alarm 0;
    }
    my @n = lstat($path);
    exit(12 + $waited) unless @n && $n[0] == $f[0] && $n[1] == $f[1];
    exit(10 + $waited);
  ' "$lockdir" "$left" "$base" &
  locker=$!
  wait "$locker" || rc=$?
  locker=
  case $rc in
    10|11) held=1; [ "$rc" = 11 ] && waited=1; break ;;
    12|13) [ "$rc" = 13 ] && waited=1; exec 9<&- ;;
    14) lock_race "it was removed or replaced before it was locked" ;;
    *) exit 1 ;;
  esac
done

# Under the lock from here on.
exe=NidumLocalMenu
# A finished bundle: only Contents at its root, the executable, this version, and a
# valid strict signature.
bundle_ok() { # app
  [ -d "$1/Contents" ] && [ ! -L "$1" ] && [ "$(ls -A "$1")" = Contents ] && [ -x "$1/Contents/MacOS/$exe" ] || return 1
  [ "$(tr -d '\n\r' <"$1/Contents/Info.plist" 2>/dev/null |
    sed -n 's/.*<key>CFBundleShortVersionString<\/key>[[:space:]]*<string>\([^<]*\)<\/string>.*/\1/p')" = "$version" ] || return 1
  [ "${2:-}" = nosig ] || verify_signature "$1"
}
verify_signature() { deadline 60 codesign --verify --strict "$1"; }

# Leftovers of a killed earlier build of this output (none can be running: we hold the
# lock, which every tool of that build held too). Exactly mktemp's six characters, so
# another output's folders never match.
for stale in "$parent/.$base.build."??????; do
  if [ -d "$stale" ] && [ ! -L "$stale" ]; then rm -rf "$stale"; fi
done

if [ "$waited" = 1 ] && [ "$(out_id)" != "$before" ] && bundle_ok "$out" 2>/dev/null; then
  echo "build-menubar.sh: another build put a valid bundle of version $version at $out while this one waited; nothing to do"
  exit 0
fi

# Refuse to replace anything that isn't an app bundle.
if [ -e "$out" ]; then
  [ -d "$out" ] && { [ -d "$out/Contents" ] || [ -z "$(ls -A "$out")" ]; } || fail "$out exists and isn't an app bundle"
fi

work=$(mktemp -d "$parent/.$base.build.XXXXXX")
old="$work/old.app"
cleanup() {
  # Killed between the two renames: put the old bundle back.
  if [ -e "$old" ] && [ ! -e "$out" ] && [ ! -L "$out" ]; then
    perl -e 'rename($ARGV[0], $ARGV[1])' "$old" "$out" 2>/dev/null || true
  fi
  rm -rf "$work"
  release_lock
}
trap cleanup EXIT

sources=()
for f in "$src"/*.swift; do sources+=("$f"); done

bins=()
for arch in $archs; do
  echo "build-menubar.sh: compiling $arch"
  deadline 600 swiftc -O -swift-version 5 -warnings-as-errors \
    -target "$arch-apple-macos13" -module-name NidumLocalMenu -framework AppKit \
    -o "$work/NidumLocalMenu-$arch" "${sources[@]}"
  bins+=("$work/NidumLocalMenu-$arch")
done

if [ ${#bins[@]} -gt 1 ]; then
  deadline 60 lipo -create -output "$work/NidumLocalMenu" "${bins[@]}"
else
  cp "${bins[0]}" "$work/NidumLocalMenu"
fi

app="$work/app.app"
mkdir -p "$app/Contents/MacOS"
sed "s/__VERSION__/$version/g" "$src/Info.plist" >"$app/Contents/Info.plist"
deadline 30 plutil -lint -s "$app/Contents/Info.plist" || fail "Info.plist is invalid"
printf 'APPL????' >"$app/Contents/PkgInfo"
cp "$work/NidumLocalMenu" "$app/Contents/MacOS/NidumLocalMenu"
chmod 755 "$app/Contents/MacOS/NidumLocalMenu"
deadline 120 codesign --force --sign - --timestamp=none "$app"
verify_signature "$app"

# Swap it in: rename the old bundle aside, rename the new one into place (both rename(2):
# never "move into" a directory). If the second rename fails, the old one goes back.
perl -e '
  my ($new, $out, $old) = @ARGV;
  my $had = (-e $out || -l $out);
  if ($had) { rename($out, $old) or die "build-menubar.sh: couldn'"'"'t move the old bundle aside: $!\n" }
  unless (rename($new, $out)) {
    my $e = $!;
    rename($old, $out) if $had;
    die "build-menubar.sh: couldn'"'"'t move the new bundle into place: $e\n";
  }
' "$app" "$out" "$old"
# The same files that were just verified; check the structure once more (no stray
# entries, right version), and never leave a broken bundle behind.
if ! bundle_ok "$out" nosig; then
  perl -e 'rename($ARGV[0], $ARGV[1])' "$out" "$work/broken.app" 2>/dev/null || rm -rf "$out"
  fail "the bundle at $out didn't check out after moving it into place; removed it"
fi
echo "build-menubar.sh: built $out ($(deadline 30 lipo -archs "$out/Contents/MacOS/NidumLocalMenu"), version $version, ad-hoc signed)"
