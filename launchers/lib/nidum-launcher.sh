# Nidum Local launcher core. Sourced (never run directly) by:
#   launchers/macos/Nidum Local.command   NIDUM_PLATFORM=macos (verified)
#   launchers/linux/nidum-local.sh        NIDUM_PLATFORM=linux (experimental)
# The entry script sets NIDUM_LAUNCHER_DIR to its own real directory, then calls nidum_main.
#
# Must stay compatible with bash 3.2 (/bin/bash on macOS): no associative arrays, no ${v,,},
# no mapfile/readarray, no |&, no &>>, no [[ -v ]], no coproc. Checked with /bin/bash -n.
#
# Environment (all optional; tests set them to temp paths):
#   NIDUM_HOME           state and logs folder              default ~/.nidum-local
#   NIDUM_APP_ROOT       folder containing src/server.js    default two levels above the launcher
#   NIDUM_SERVICE_PLIST  Portless launchd service (macOS)   default /Library/LaunchDaemons/sh.portless.proxy.plist
#   NIDUM_SERVICE_UNIT   Portless systemd unit (Linux)      default /etc/systemd/system/portless.service
#   NIDUM_EXTRA_PATH     extra folders searched after PATH  default Homebrew folders
#   NIDUM_DRY_RUN=1      print every action instead of doing it
#   NIDUM_START_TIMEOUT  seconds to wait for the dashboard  default 10 (1-300)
#   NIDUM_SERVICE_WAIT   seconds to wait for a startup service to answer  default 5 (1-60)
#   NIDUM_RESUME_WAIT    seconds to wait for a resumed (paused) service to answer  default 10 (1-60)
#   NIDUM_COLOR=1        force colour when not on a terminal (NO_COLOR always wins)
#   NIDUM_NO_MENUBAR=1   don't start the macOS menu bar app
#   PORTLESS_STATE_DIR   Portless state folder, read only   default from the service, else ~/.portless

NIDUM_MIN_NODE=18
NIDUM_MIN_NODE_FOR_NPM=24
NIDUM_MIN_PORTLESS=0.15.6
NIDUM_DEFAULT_PORT=47800

# ---------------------------------------------------------------- basics

nidum_dry() {
  case "${NIDUM_DRY_RUN:-}" in ''|0|false|no) return 1 ;; *) return 0 ;; esac
}

nidum_log() {
  [ -n "$NIDUM_LOG_FILE" ] || return 0
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$NIDUM_LOG_FILE" 2>/dev/null
}

nidum_has() { command -v "$1" >/dev/null 2>&1; }

# Milliseconds since the epoch for deadlines. perl (on every Mac) gives sub-second precision;
# without it, whole seconds from date.
nidum_now_ms() {
  local t=''
  nidum_has perl && t=$(perl -MTime::HiRes=time -e 'printf "%d", time() * 1000' 2>/dev/null)
  case "$t" in ''|*[!0-9]*) t="$(date +%s)000" ;; esac
  printf '%s' "$t"
}

# 0 when $1 is a TCP port: digits only, no leading zero, 1-65535.
nidum_valid_port() {
  case "$1" in ''|*[!0-9]*|0*) return 1 ;; esac
  [ ${#1} -le 5 ] && [ "$1" -le 65535 ]
}

# Whole seconds from an environment value, clamped to min..max, else the default.
nidum_seconds() { # value default min max
  local v=$1
  case "$v" in
    ''|*[!0-9]*) v=$2 ;;
    *) v=${v#"${v%%[!0]*}"}; v=${v:-0} ;;
  esac
  [ ${#v} -le 4 ] || v=$4
  [ "$v" -ge "$3" ] || v=$3
  [ "$v" -le "$4" ] || v=$4
  printf '%s' "$v"
}

# Display form of a path: $HOME is shown as ~.
nidum_pretty_path() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

nidum_init_colors() {
  NIDUM_C_GREEN='' NIDUM_C_CYAN='' NIDUM_C_YELLOW='' NIDUM_C_RED='' NIDUM_C_BOLD='' NIDUM_C_RESET=''
  if [ -n "${NO_COLOR:-}" ]; then return 0; fi
  if [ -t 1 ] || [ "${NIDUM_COLOR:-}" = 1 ]; then
    NIDUM_C_GREEN=$'\033[32m'
    NIDUM_C_CYAN=$'\033[36m'
    NIDUM_C_YELLOW=$'\033[33m'
    NIDUM_C_RED=$'\033[31m'
    NIDUM_C_BOLD=$'\033[1m'
    NIDUM_C_RESET=$'\033[0m'
  fi
}

# One step line: two spaces, a glyph, a plain sentence (design spec §3).
nidum_line() { # colour glyph text
  printf '  %s%s%s %s\n' "$1" "$2" "$NIDUM_C_RESET" "$3"
  nidum_log "$2 $3"
}
ui_ok()    { nidum_line "$NIDUM_C_GREEN" '✓' "$*"; }
ui_wait()  { nidum_line "$NIDUM_C_CYAN" '…' "$*"; }
ui_warn()  { nidum_line "$NIDUM_C_YELLOW" '!' "$*"; }
ui_arrow() { nidum_line '' '→' "$*"; }
ui_note()  { printf '    %s\n' "$*"; nidum_log "  $*"; }

# Consent prompt. Enter (or y/yes) accepts the default, which is Yes. Returns 0 for yes.
# No input at all (closed stdin) counts as No: nothing is installed without an answer.
ui_ask() { # question  action-with-[Y/n]
  printf '  %s?%s %s\n' "$NIDUM_C_YELLOW" "$NIDUM_C_RESET" "$1"
  printf '    %s ' "$2"
  nidum_log "? $1 $2"
  if nidum_dry; then
    printf '(dry run: answering Y)\n'
    nidum_log 'answer: Y (dry run)'
    return 0
  fi
  local answer
  if ! IFS= read -r answer; then
    printf '\n'
    nidum_log 'answer: none (input closed), treated as No'
    return 1
  fi
  case "$answer" in
    ''|y|Y|yes|Yes|YES) nidum_log 'answer: yes'; return 0 ;;
    *) nidum_log "answer: no ($answer)"; return 1 ;;
  esac
}

# Failure screen (design spec §3): the window stays open until a key is pressed.
nidum_fail() { # title  what-happened  what-to-try
  local details
  if [ -n "$NIDUM_LOG_FILE" ]; then
    details=$(nidum_pretty_path "$NIDUM_LOG_FILE")
  elif nidum_dry; then
    details='(a dry run writes no log)'
  else
    details="(no log: $(nidum_pretty_path "$NIDUM_HOME") could not be written)"
  fi
  printf '\n  %s✗%s %s\n\n' "$NIDUM_C_RED" "$NIDUM_C_RESET" "$1"
  printf '    What happened: %s\n' "$2"
  printf '    What to try:   %s\n' "$3"
  printf '    Details:       %s\n\n' "$details"
  nidum_log "✗ $1 | What happened: $2 | What to try: $3"
  printf '  Press any key to close.'
  if nidum_dry; then
    printf ' (dry run: not waiting)\n'
  else
    local key
    IFS= read -r -s -n 1 key || true
    printf '\n'
  fi
  nidum_log 'exit 1'
  exit 1
}

# Run a command with a time limit (no `timeout` binary on macOS). Output goes to $NIDUM_CAPTURE.
nidum_capture() { # seconds command...
  local secs=$1 out pid watchdog rc
  shift
  out=$(mktemp "${TMPDIR:-/tmp}/nidum-launcher.XXXXXX") || { NIDUM_CAPTURE=''; return 1; }
  "$@" >"$out" 2>&1 </dev/null &
  pid=$!
  # The watchdog kills its own sleep when it is stopped, so no sleep outlives the launcher.
  (
    nap=''
    trap '[ -n "$nap" ] && kill "$nap" 2>/dev/null; exit 0' TERM
    sleep "$secs" &
    nap=$!
    wait "$nap"
    kill -TERM "$pid" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  watchdog=$!
  # 2>/dev/null: when the watchdog kills the command, bash would print its job report
  # ("line N: <pid> Terminated: 15 ...") on the user's window. The exit code stays 143.
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  NIDUM_CAPTURE=$(cat "$out" 2>/dev/null)
  rm -f "$out"
  return $rc
}

# Run an action the user can watch (installs, proxy start). Output is shown and logged.
# In a dry run it is printed instead. The last output line is kept for the failure screen.
nidum_run() { # command...
  local shown
  shown=$(printf '%q ' "$@")
  shown=${shown% }
  nidum_log "run: $shown"
  NIDUM_LAST_LINE=''
  if nidum_dry; then
    ui_note "[dry run] would run: $shown"
    return 0
  fi
  local out rc esc=$'\033'
  out=$(mktemp "${TMPDIR:-/tmp}/nidum-launcher.XXXXXX") || out=/dev/null
  "$@" 2>&1 | tee "$out" | sed -e "s/^/    /"
  rc=${PIPESTATUS[0]}
  if [ "$out" != /dev/null ]; then
    [ -n "$NIDUM_LOG_FILE" ] && cat "$out" >>"$NIDUM_LOG_FILE" 2>/dev/null
    NIDUM_LAST_LINE=$(sed -e "s/${esc}\[[0-9;]*m//g" -e '/^[[:space:]]*$/d' "$out" | tail -n 1)
    rm -f "$out"
  fi
  nidum_log "exit code: $rc"
  return $rc
}

# First x.y.z in the text.
nidum_extract_version() {
  printf '%s\n' "$1" | sed -n 's/[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1
}

# 0 when dotted version $1 >= $2.
nidum_ver_ge() {
  local IFS=. i x y
  local -a a b
  a=($1)
  b=($2)
  for i in 0 1 2; do
    x=${a[$i]:-0}; y=${b[$i]:-0}
    x=${x%%[!0-9]*}; y=${y%%[!0-9]*}
    x=${x:-0}; y=${y:-0}
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
  done
  return 0
}

nidum_resolve_path() { # follows symlinks, prints the real file path
  local p=$1 d
  while [ -h "$p" ]; do
    d=$(cd -P "$(dirname "$p")" 2>/dev/null && pwd)
    p=$(readlink "$p")
    case "$p" in /*) ;; *) p="$d/$p" ;; esac
  done
  d=$(cd -P "$(dirname "$p")" 2>/dev/null && pwd)
  printf '%s/%s' "$d" "$(basename "$p")"
}

# ---------------------------------------------------------------- setup

nidum_init() {
  NIDUM_PLATFORM=${NIDUM_PLATFORM:-macos}
  NIDUM_HOME=${NIDUM_HOME:-$HOME/.nidum-local}
  case "$NIDUM_HOME" in /*) ;; *) NIDUM_HOME="$PWD/$NIDUM_HOME" ;; esac
  export NIDUM_HOME
  if [ -n "${NIDUM_APP_ROOT:-}" ]; then
    NIDUM_ROOT=$NIDUM_APP_ROOT
  else
    NIDUM_ROOT=$(cd -P "$NIDUM_LAUNCHER_DIR/../.." && pwd)
  fi
  # Absolute, because the menu bar app gets it as --app-root and doesn't start in this folder.
  case "$NIDUM_ROOT" in /*) ;; *) NIDUM_ROOT="$PWD/$NIDUM_ROOT" ;; esac
  NIDUM_SESSION_FILE="$NIDUM_HOME/session.json"
  NIDUM_STATE_FILE="$NIDUM_HOME/state.json"
  NIDUM_SERVER_LOG="$NIDUM_HOME/server.log"
  NIDUM_LOG_FILE=''
  NIDUM_LAST_LINE=''
  NIDUM_CAPTURE=''

  if [ "$NIDUM_PLATFORM" = linux ]; then
    NIDUM_SERVICE_FILE=${NIDUM_SERVICE_UNIT-/etc/systemd/system/portless.service}
    NIDUM_RESTART_HINT='sudo systemctl restart portless.service (or, if it isn'"'"'t enabled: sudo systemctl enable --now portless.service)'
    NIDUM_EXTRA_DEFAULT='/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/opt/node/bin:/usr/local/bin'
  else
    NIDUM_SERVICE_FILE=${NIDUM_SERVICE_PLIST-/Library/LaunchDaemons/sh.portless.proxy.plist}
    NIDUM_RESTART_HINT="sudo launchctl kickstart -k system/sh.portless.proxy (or, if it isn't loaded: sudo launchctl bootstrap system $NIDUM_SERVICE_FILE)"
    NIDUM_EXTRA_DEFAULT='/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/opt/node/bin:/usr/local/opt/node/bin'
  fi

  # Finder-launched windows may lack Homebrew on PATH: search its folders after PATH.
  local extra dir oldifs=$IFS
  extra=${NIDUM_EXTRA_PATH-$NIDUM_EXTRA_DEFAULT}
  IFS=:
  for dir in $extra; do
    IFS=$oldifs
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    case ":$PATH:" in *":$dir:"*) ;; *) PATH="$PATH:$dir" ;; esac
  done
  IFS=$oldifs
  export PATH

  # Logging. A dry run never creates the folder; it logs only into one that already exists.
  NIDUM_HOME_OK=1
  if nidum_dry; then
    if [ -d "$NIDUM_HOME" ] && [ -w "$NIDUM_HOME" ]; then NIDUM_LOG_FILE="$NIDUM_HOME/launcher.log"; fi
  else
    NIDUM_HOME_OK=0
    if mkdir -p "$NIDUM_HOME" 2>/dev/null && [ -d "$NIDUM_HOME" ] && [ -w "$NIDUM_HOME" ]; then
      NIDUM_HOME_OK=1
      chmod 700 "$NIDUM_HOME" 2>/dev/null
      NIDUM_LOG_FILE="$NIDUM_HOME/launcher.log"
      if [ -f "$NIDUM_LOG_FILE" ] && [ "$(wc -c <"$NIDUM_LOG_FILE" | tr -d ' ')" -gt 524288 ]; then
        mv -f "$NIDUM_LOG_FILE" "$NIDUM_LOG_FILE.1" 2>/dev/null
      fi
    fi
  fi
  nidum_init_colors
  trap 'printf "\n"; nidum_log "interrupted"; exit 130' INT
  nidum_log "---- launcher start: platform=$NIDUM_PLATFORM root=$NIDUM_ROOT dry_run=${NIDUM_DRY_RUN:-0}"
}

nidum_header() {
  printf '\n  %sNidum Local%s\n' "$NIDUM_C_BOLD" "$NIDUM_C_RESET"
  printf "  Share what's running on this computer with your network.\n\n"
  if nidum_dry; then
    printf '  (dry run: nothing will be installed, started or opened)\n\n'
  fi
}

# ---------------------------------------------------------------- step 0: home folder, basic tools

# Nothing works without NIDUM_HOME (session.json, server.log), so stop early and say why.
nidum_step_home() {
  [ "${NIDUM_HOME_OK:-1}" = 1 ] && return 0
  nidum_fail "Nidum Local can't save its files." \
    "The folder $(nidum_pretty_path "$NIDUM_HOME") can't be created or written." \
    "Check that folder's permissions (or move away a file with the same name), then open Nidum Local again."
}

nidum_step_tools() {
  if ! nidum_has curl; then
    nidum_fail "Couldn't check what's running." \
      "The curl program isn't installed." \
      "Install curl (for example: sudo apt install curl), then open Nidum Local again."
  fi
}

# ---------------------------------------------------------------- step 1: Node.js >= 18

nidum_find_node() {
  NODE_BIN=''; NODE_VERSION=''; NODE_OLD_VERSION=''
  local cand v oldifs=$IFS list
  list=$(type -ap node 2>/dev/null)
  IFS='
'
  for cand in $list; do
    IFS=$oldifs
    if nidum_capture 10 "$cand" --version; then
      v=$(nidum_extract_version "$NIDUM_CAPTURE")
      if [ -n "$v" ] && nidum_ver_ge "$v" "$NIDUM_MIN_NODE"; then
        NODE_BIN=$cand; NODE_VERSION=$v
        return 0
      fi
      if [ -n "$v" ] && [ -z "$NODE_OLD_VERSION" ]; then NODE_OLD_VERSION=$v; fi
    fi
  done
  IFS=$oldifs
  return 1
}

nidum_step_node() {
  if nidum_find_node; then
    ui_ok "Node.js $NODE_VERSION found"
    nidum_log "node: $NODE_BIN"
    return 0
  fi
  local have='You have none installed.'
  if [ -n "$NODE_OLD_VERSION" ]; then have="You have $NODE_OLD_VERSION."; fi

  if nidum_has brew; then
    if ui_ask "Nidum Local needs Node.js $NIDUM_MIN_NODE or newer. $have" "Install it now with Homebrew? [Y/n]"; then
      ui_wait 'Installing Node.js with Homebrew'
      if ! nidum_run brew install node; then
        nidum_fail "Couldn't install Node.js." \
          "Homebrew stopped with an error: ${NIDUM_LAST_LINE:-no details}" \
          "Install Node.js from https://nodejs.org, then open Nidum Local again."
      fi
      hash -r
      if nidum_dry; then
        ui_ok 'Node.js would be installed (dry run)'
        NODE_BIN=node; NODE_VERSION=$NIDUM_MIN_NODE.0.0
        return 0
      fi
      if nidum_find_node; then
        ui_ok "Node.js $NODE_VERSION installed"
        return 0
      fi
      nidum_fail "Couldn't install Node.js." \
        "Homebrew finished, but Node.js $NIDUM_MIN_NODE or newer still isn't available." \
        "Install Node.js from https://nodejs.org, then open Nidum Local again."
    fi
    nidum_fail "Nidum Local can't start without Node.js." \
      "Node.js $NIDUM_MIN_NODE or newer isn't installed. $have" \
      "Install it from https://nodejs.org (or answer Y next time), then open Nidum Local again."
  fi
  nidum_fail "Nidum Local needs Node.js $NIDUM_MIN_NODE or newer." \
    "$have" \
    "Install Node.js from https://nodejs.org, then open Nidum Local again."
}

# ---------------------------------------------------------------- step 2: Portless

nidum_portless_version() {
  PORTLESS_VERSION=''
  PORTLESS_BIN=$(command -v portless 2>/dev/null)
  [ -n "$PORTLESS_BIN" ] || return 2
  if nidum_capture 15 portless --version; then
    PORTLESS_VERSION=$(nidum_extract_version "$NIDUM_CAPTURE")
    [ -n "$PORTLESS_VERSION" ] && return 0
  fi
  nidum_log "portless --version failed: $NIDUM_CAPTURE"
  return 1
}

nidum_portless_via_brew() {
  nidum_has brew || return 1
  case "$(nidum_resolve_path "$PORTLESS_BIN")" in
    */Cellar/*|*/homebrew/*|*/linuxbrew/*) return 0 ;;
  esac
  return 1
}

nidum_install_portless() {
  if nidum_has brew; then
    ui_ask "Nidum Local uses Portless to give your services addresses. It isn't installed." \
      "Install it now with Homebrew? [Y/n]" || nidum_fail "Nidum Local can't start without Portless." \
        "Portless isn't installed." \
        "Answer Y next time, or run: brew install portless"
    ui_wait 'Installing Portless with Homebrew'
    nidum_run brew install portless || nidum_fail "Couldn't install Portless." \
      "Homebrew stopped with an error: ${NIDUM_LAST_LINE:-no details}" \
      "Run: brew install portless, then open Nidum Local again."
  else
    local major=${NODE_VERSION%%.*}
    if [ -z "$major" ] || [ "$major" -lt "$NIDUM_MIN_NODE_FOR_NPM" ]; then
      nidum_fail "Nidum Local needs Portless, which isn't installed." \
        "Installing Portless with npm needs Node.js $NIDUM_MIN_NODE_FOR_NPM or newer. You have $NODE_VERSION." \
        "Install Homebrew (https://brew.sh) or Node.js $NIDUM_MIN_NODE_FOR_NPM (https://nodejs.org), then open Nidum Local again."
    fi
    ui_ask "Nidum Local uses Portless to give your services addresses. It isn't installed." \
      "Install it now with npm? [Y/n]" || nidum_fail "Nidum Local can't start without Portless." \
        "Portless isn't installed." \
        "Answer Y next time, or run: npm install -g portless"
    ui_wait 'Installing Portless with npm'
    nidum_run npm install -g portless || nidum_fail "Couldn't install Portless." \
      "npm stopped with an error: ${NIDUM_LAST_LINE:-no details}" \
      "Run: npm install -g portless, then open Nidum Local again."
  fi
  hash -r
}

nidum_step_portless() {
  nidum_portless_version
  local rc=$?
  if [ $rc -eq 2 ]; then
    nidum_install_portless
    if nidum_dry; then
      ui_ok 'Portless would be installed (dry run)'
      PORTLESS_VERSION=$NIDUM_MIN_PORTLESS
      return 0
    fi
    nidum_portless_version
    rc=$?
    if [ $rc -eq 0 ]; then
      ui_ok "Portless $PORTLESS_VERSION installed"
      return 0
    fi
    if [ $rc -eq 2 ]; then
      nidum_fail "Couldn't install Portless." \
        "The install finished, but the portless command still can't be found." \
        "Open a new Terminal window, then open Nidum Local again."
    fi
  fi
  if [ $rc -ne 0 ]; then
    local fix='npm install -g portless'
    nidum_has brew && fix='brew reinstall portless'
    nidum_fail "Portless is installed but doesn't run." \
      "\"portless --version\" failed: $(printf '%s' "$NIDUM_CAPTURE" | tail -n 1)" \
      "Run: $fix, then open Nidum Local again."
  fi

  if ! nidum_ver_ge "$PORTLESS_VERSION" "$NIDUM_MIN_PORTLESS"; then
    local how='npm' cmd='npm install -g portless@latest'
    if nidum_portless_via_brew; then how='Homebrew'; cmd='brew upgrade portless'; fi
    if ui_ask "Nidum Local works best with Portless $NIDUM_MIN_PORTLESS or newer. You have $PORTLESS_VERSION." \
      "Update it now with $how? [Y/n]"; then
      ui_wait "Updating Portless with $how"
      # shellcheck disable=SC2086
      if nidum_run $cmd; then
        hash -r
        local before=$PORTLESS_VERSION
        if ! nidum_dry; then nidum_portless_version || PORTLESS_VERSION=$before; fi
      else
        ui_warn "Couldn't update Portless. Continuing with $PORTLESS_VERSION."
      fi
    else
      ui_warn "Continuing with Portless $PORTLESS_VERSION. Some features may not work."
    fi
  fi
  ui_ok "Portless $PORTLESS_VERSION found"
}

# ---------------------------------------------------------------- step 3 (Linux): Avahi

nidum_step_avahi() {
  [ "$NIDUM_PLATFORM" = linux ] || return 0
  if nidum_has avahi-publish-address; then
    ui_ok 'Avahi found'
    return 0
  fi
  local cmd=''
  if nidum_has apt-get; then cmd='sudo apt-get install -y avahi-utils'
  elif nidum_has dnf; then cmd='sudo dnf install -y avahi-tools'
  elif nidum_has pacman; then cmd='sudo pacman -S --noconfirm avahi'
  fi
  if [ -z "$cmd" ]; then
    ui_warn "Avahi isn't installed, so other devices may not find your addresses. Install avahi-utils."
    return 0
  fi
  if ui_ask "Other devices find your addresses through Avahi, which isn't installed." \
    "Install avahi-utils now? You may be asked for your password. [Y/n]"; then
    # shellcheck disable=SC2086
    if nidum_run $cmd; then
      ui_ok 'Avahi installed'
    else
      ui_warn "Couldn't install Avahi. Other devices may not find your addresses."
    fi
  else
    ui_warn 'Without Avahi, other devices may not find your addresses.'
  fi
}

# ---------------------------------------------------------------- step 4: network sharing (proxy)

# Read-only: values from the service definition.
nidum_service_value() { # env-key
  if [ "$NIDUM_PLATFORM" = linux ]; then
    sed -n "s/^Environment=\"\{0,1\}$1=\([^\"]*\)\"\{0,1\}\$/\1/p" "$NIDUM_SERVICE_FILE" 2>/dev/null | head -n 1
  else
    sed -n "/<key>$1<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}" "$NIDUM_SERVICE_FILE" 2>/dev/null | head -n 1
  fi
}
nidum_service_arg_after() { # flag
  if [ "$NIDUM_PLATFORM" = linux ]; then
    sed -n "s/^ExecStart=.* $1[ =]\([^ ]*\).*/\1/p" "$NIDUM_SERVICE_FILE" 2>/dev/null | head -n 1
  else
    sed -n "/<string>$1<\/string>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}" "$NIDUM_SERVICE_FILE" 2>/dev/null | head -n 1
  fi
}
nidum_service_has_arg() { # flag
  if [ "$NIDUM_PLATFORM" = linux ]; then
    grep -q "^ExecStart=.* $1\( \|\$\)" "$NIDUM_SERVICE_FILE" 2>/dev/null
  else
    grep -q "<string>$1</string>" "$NIDUM_SERVICE_FILE" 2>/dev/null
  fi
}

nidum_read_proxy_config() {
  PROXY_SERVICE=0
  PROXY_PORT=''
  PROXY_SERVICE_LAN=0
  PROXY_TLS=1
  [ -n "$NIDUM_SERVICE_FILE" ] && [ -f "$NIDUM_SERVICE_FILE" ] && PROXY_SERVICE=1

  if [ -n "${PORTLESS_STATE_DIR:-}" ]; then
    PROXY_STATE_DIR=$PORTLESS_STATE_DIR
  elif [ $PROXY_SERVICE = 1 ] && [ -n "$(nidum_service_value PORTLESS_STATE_DIR)" ]; then
    PROXY_STATE_DIR=$(nidum_service_value PORTLESS_STATE_DIR)
  else
    PROXY_STATE_DIR="$HOME/.portless"
  fi

  local candidate
  if [ $PROXY_SERVICE = 1 ]; then
    for candidate in "$(nidum_service_value PORTLESS_PORT)" "$(nidum_service_arg_after --port)" "$(nidum_service_arg_after -p)"; do
      if nidum_valid_port "$candidate"; then PROXY_PORT=$candidate; break; fi
    done
    if [ "$(nidum_service_value PORTLESS_LAN)" = 1 ] || nidum_service_has_arg --lan; then PROXY_SERVICE_LAN=1; fi
    if [ "$(nidum_service_value PORTLESS_HTTPS)" = 0 ] || nidum_service_has_arg --no-tls; then PROXY_TLS=0; fi
  fi
  if [ -z "$PROXY_PORT" ] && [ -f "$PROXY_STATE_DIR/proxy.port" ]; then
    candidate=$(head -n 1 "$PROXY_STATE_DIR/proxy.port" | tr -d ' \r\n')
    nidum_valid_port "$candidate" && PROXY_PORT=$candidate
  fi
  if [ $PROXY_SERVICE = 0 ]; then
    if [ -f "$PROXY_STATE_DIR/proxy.tls" ]; then PROXY_TLS=1; else PROXY_TLS=0; fi
  fi
  if [ $PROXY_SERVICE = 1 ] && [ -z "$PROXY_PORT" ]; then
    if [ $PROXY_TLS = 1 ]; then PROXY_PORT=443; else PROXY_PORT=80; fi
  fi
  nidum_log "proxy config: service=$PROXY_SERVICE file=$NIDUM_SERVICE_FILE state=$PROXY_STATE_DIR port=${PROXY_PORT:-none} tls=$PROXY_TLS"
}

# LAN IP the proxy shares on (proxy.lan holds the IP), or empty.
nidum_lan_ip() {
  local ip=''
  if [ -f "$PROXY_STATE_DIR/proxy.lan" ]; then ip=$(head -n 1 "$PROXY_STATE_DIR/proxy.lan" | tr -d ' \r\n'); fi
  case "$ip" in ''|*[!0-9a-fA-F.:]*) ip='' ;; esac
  printf '%s' "$ip"
}

# Quick liveness probe for polling loops: plain HTTP only (a TLS Portless proxy answers plain
# HTTP with X-Portless too), at most about 1 s (or the given limit, e.g. 0.4) even when the
# port accepts but never answers.
nidum_proxy_alive_quick() { # port [max-seconds]
  nidum_valid_port "$1" || return 1
  local m=${2:-1}
  curl -sI -m "$m" --connect-timeout "$m" --noproxy '*' "http://127.0.0.1:$1/" 2>/dev/null | tr -d '\r' | grep -qi '^x-portless:[[:space:]]*1'
}

# Portless liveness check: HEAD / answers with "X-Portless: 1".
nidum_proxy_alive() { # port
  nidum_valid_port "$1" || return 1
  if curl -sI -m 3 --noproxy '*' "http://127.0.0.1:$1/" 2>/dev/null | tr -d '\r' | grep -qi '^x-portless:[[:space:]]*1'; then
    return 0
  fi
  curl -skI -m 3 --noproxy '*' "https://127.0.0.1:$1/" 2>/dev/null | tr -d '\r' | grep -qi '^x-portless:[[:space:]]*1'
}

nidum_sharing_line() { # suffix
  local ip
  ip=$(nidum_lan_ip)
  if [ -n "$ip" ]; then ui_ok "Network sharing is on$1 — this computer is $ip"; else ui_ok "Network sharing is on$1"; fi
}

# Reads state.json "settings" read-only with Node and prints one line:
#   "ok <tls 0|1|-> <port|-> <fixedIp|-> <wildcard 0|1>"   or   "error <reason>".
# "-" means the field is absent; the caller picks the fallback (D20).
# A present field with a wrong type or range rejects the whole settings object.
NIDUM_SETTINGS_JS='
const fs = require("fs"), net = require("net");
const say = (s) => { process.stdout.write(s + "\n"); process.exit(0); };
let doc;
try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
catch (e) { say("error " + (e && e.code === "ENOENT" ? "state.json missing" : "state.json is not readable JSON")); }
const st = doc && typeof doc === "object" && !Array.isArray(doc) ? doc.settings : undefined;
if (!st || typeof st !== "object" || Array.isArray(st)) say("error state.json has no settings object");
const bad = (k) => say("error state.json settings." + k + " is invalid");
let tls = "-", port = "-", ip = "-", wildcard = 0;
if (st.tls !== undefined) { if (typeof st.tls !== "boolean") bad("tls"); tls = st.tls ? 1 : 0; }
if (st.port !== undefined) { if (!Number.isInteger(st.port) || st.port < 1 || st.port > 65535) bad("port"); port = st.port; }
if (st.fixedIp !== undefined && st.fixedIp !== null) { if (typeof st.fixedIp !== "string" || !net.isIP(st.fixedIp)) bad("fixedIp"); ip = st.fixedIp; }
if (st.wildcard !== undefined) { if (typeof st.wildcard !== "boolean") bad("wildcard"); wildcard = st.wildcard ? 1 : 0; }
say("ok " + tls + " " + port + " " + ip + " " + wildcard);
'

# The one helper behind every proxy start (Contracts §4, D20): flags from state.json settings.
#   nidum_proxy_flags                      cold start: missing/invalid -> TLS on, port 443 (80 without TLS)
#   nidum_proxy_flags <tls 0|1> <port>     restart:    missing/invalid -> the running proxy's TLS and port
# Field-level: a valid state.json field always wins; only absent ones fall back.
# Sets PROXY_FLAGS (array) and PROXY_START_TLS / PROXY_START_PORT.
nidum_proxy_flags() {
  local fb_tls='' fb_port='' mode=cold
  if [ -n "${1:-}" ] && nidum_valid_port "${2:-}"; then
    mode=restart
    fb_tls=$1
    fb_port=$2
    [ "$fb_tls" = 1 ] || fb_tls=0
  fi
  local tls='-' port='-' ip='' wildcard=0 why='' status a_tls a_port a_ip a_wild
  if [ ! -f "$NIDUM_STATE_FILE" ]; then
    why='no state.json'
  elif [ -z "${NODE_BIN:-}" ] || ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    why='Node.js not available to read state.json'
  elif ! nidum_capture 10 "$NODE_BIN" -e "$NIDUM_SETTINGS_JS" -- "$NIDUM_STATE_FILE"; then
    why="reading state.json failed: $(printf '%s\n' "$NIDUM_CAPTURE" | tail -n 1)"
  else
    read -r status a_tls a_port a_ip a_wild <<EOF
$(printf '%s\n' "$NIDUM_CAPTURE" | tail -n 1)
EOF
    if [ "$status" = ok ] && { [ "$a_tls" = 0 ] || [ "$a_tls" = 1 ] || [ "$a_tls" = - ]; } \
      && { [ "$a_port" = - ] || nidum_valid_port "$a_port"; } \
      && { [ "$a_wild" = 0 ] || [ "$a_wild" = 1 ]; } && case "$a_ip" in ''|*[!0-9a-fA-F.:-]*) false ;; *) true ;; esac; then
      tls=$a_tls
      port=$a_port
      [ "$a_ip" = - ] || ip=$a_ip
      wildcard=$a_wild
    elif [ "$status" = error ]; then
      why=$(printf '%s\n' "$NIDUM_CAPTURE" | tail -n 1 | sed 's/^error //')
    else
      why='unexpected output while reading state.json'
    fi
  fi
  # Fill what state.json didn't give (D20).
  if [ "$tls" = - ]; then
    if [ $mode = restart ]; then tls=$fb_tls; else tls=1; fi
  fi
  if [ "$port" = - ]; then
    if [ $mode = restart ]; then port=$fb_port
    elif [ "$tls" = 1 ]; then port=443
    else port=80
    fi
  fi
  PROXY_START_TLS=$tls
  PROXY_START_PORT=$port
  PROXY_FLAGS=(--lan)
  if [ "$PROXY_START_TLS" = 1 ]; then PROXY_FLAGS=("${PROXY_FLAGS[@]}" --https); else PROXY_FLAGS=("${PROXY_FLAGS[@]}" --no-tls); fi
  PROXY_FLAGS=("${PROXY_FLAGS[@]}" -p "$PROXY_START_PORT")
  [ -n "$ip" ] && PROXY_FLAGS=("${PROXY_FLAGS[@]}" --ip "$ip")
  [ "$wildcard" = 1 ] && PROXY_FLAGS=("${PROXY_FLAGS[@]}" --wildcard)
  if [ -n "$why" ]; then
    if [ $mode = restart ]; then
      nidum_log "proxy flags: ${PROXY_FLAGS[*]} (running proxy's TLS and port: $why)"
    else
      nidum_log "proxy flags: ${PROXY_FLAGS[*]} (default: $why)"
    fi
    case "$why" in
      'no state.json'|'state.json missing') ;;
      *)
        if [ $mode = restart ]; then
          ui_warn "Your saved sharing settings couldn't be read, so Nidum Local keeps the current setup (port $PROXY_START_PORT)."
        else
          ui_warn "Your saved sharing settings couldn't be read, so Nidum Local uses the standard setup (port 443)."
        fi
        ;;
    esac
  else
    nidum_log "proxy flags: ${PROXY_FLAGS[*]} (from state.json, $mode)"
  fi
}

# Explains the password prompt(s) before the first one (spec §3, D19). Printed at most once.
#   nidum_password_note [stopping-port]   stopping-port: the running proxy's port on a restart;
#   below 1024 that proxy is root-owned, so stopping it already asks for the password.
nidum_password_note() {
  [ "${NIDUM_NOTE_SHOWN:-0}" = 1 ] && return 0
  local port=$PROXY_START_PORT stop=${1:-}
  if [ -n "$stop" ] && [ "$stop" -lt 1024 ]; then
    NIDUM_NOTE_SHOWN=1
    if [ "$PROXY_START_TLS" = 1 ]; then
      ui_note "Your computer will ask for your password so Nidum Local can restart network sharing and trust its local certificate. You may be asked twice."
    else
      ui_note "Your computer will ask for your password so Nidum Local can restart network sharing on the standard web port."
    fi
    return 0
  fi
  [ -n "$stop" ] && return 0
  NIDUM_NOTE_SHOWN=1
  if [ "$PROXY_START_TLS" = 1 ]; then
    if [ "$port" -lt 1024 ]; then
      ui_note "Your computer will ask for your password so Nidum Local can use the standard web port ($port) and trust its local certificate. You may be asked twice."
    else
      ui_note "Your computer may ask for your password so Nidum Local can trust its local certificate."
    fi
  elif [ "$port" -lt 1024 ]; then
    ui_note "Your computer will ask for your password once, so Nidum Local can use the standard web port ($port)."
  fi
}

nidum_start_proxy() { # uses PROXY_FLAGS / PROXY_START_TLS / PROXY_START_PORT from nidum_proxy_flags
  local port=$PROXY_START_PORT
  nidum_password_note
  if [ "$NIDUM_PLATFORM" != linux ]; then
    ui_note "Your computer may ask whether to allow incoming connections. Choose Allow, or other devices won't be able to connect."
  fi
  ui_wait 'Starting network sharing (you may be asked for your password)'
  if ! nidum_run portless proxy start "${PROXY_FLAGS[@]}"; then
    nidum_fail "Couldn't start network sharing." \
      "${NIDUM_LAST_LINE:-Portless stopped with an error.}" \
      "Open Nidum Local again. If it keeps failing, run: portless doctor"
  fi
  if nidum_dry; then
    ui_ok 'Network sharing would be on (dry run)'
    return 0
  fi
  local i=0
  while [ $i -lt 20 ]; do
    if nidum_proxy_alive "$port"; then
      nidum_sharing_line ''
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  nidum_fail "Couldn't start network sharing." \
    "Portless started, but nothing answers on port $port." \
    "Open Nidum Local again. If it keeps failing, run: portless doctor"
}

# 0 when the startup service is installed but not loaded/active (D43: Pause, Stop All or Quit
# booted it out; the service file stays). Read only, time-limited by the caller's budget ($1,
# seconds, may be fractional). Unknown (no launchctl/systemctl, or no answer in time) counts as no.
nidum_service_stopped() { # limit
  local rc
  if [ "$NIDUM_PLATFORM" = linux ]; then
    nidum_has systemctl || return 1
    nidum_capture "$1" systemctl is-active --quiet "$(basename "$NIDUM_SERVICE_FILE")"
  else
    nidum_has launchctl || return 1
    nidum_capture "$1" launchctl print system/sh.portless.proxy
  fi
  rc=$?
  nidum_log "service loaded check: exit $rc"
  [ $rc -ne 0 ] && [ $rc -ne 143 ]
}

# Polls the quick probe until the port answers or budget-ms (counted from now) runs out. The
# first probe comes at once; each later try is a 0.5 s pause plus a probe of at most 1 s, limited
# to what is left, and a try with under 0.2 s left isn't started. So the wait ends by the
# deadline however slowly the probes fail. Sets NIDUM_WAITED_MS.
nidum_wait_alive() { # port budget-ms
  local started left limit first=1
  started=$(nidum_now_ms)
  NIDUM_WAITED_MS=0
  while :; do
    left=$(($2 - ($(nidum_now_ms) - started)))
    if [ $first = 0 ]; then
      left=$((left - 500))
      [ $left -lt 200 ] && break
      sleep 0.5
    fi
    first=0
    [ $left -lt 200 ] && break
    [ $left -gt 1000 ] && left=1000
    limit=$(printf '%d.%03d' $((left / 1000)) $((left % 1000)))
    if nidum_proxy_alive_quick "$1" "$limit"; then
      NIDUM_WAITED_MS=$(($(nidum_now_ms) - started))
      return 0
    fi
  done
  NIDUM_WAITED_MS=$(($(nidum_now_ms) - started))
  return 1
}

# The service was paused on purpose: offer to start it again (one password prompt).
nidum_resume_service() {
  if ! ui_ask "Network sharing is paused." "Start sharing again? [Y/n]"; then
    ui_warn "Network sharing stays paused, so other devices can't reach your addresses. You can start it from the dashboard."
    return 0
  fi
  ui_note "Your computer will ask for your password so Nidum Local can start network sharing again."
  ui_wait 'Starting network sharing'
  local ok=0
  if [ "$NIDUM_PLATFORM" = linux ]; then
    nidum_run sudo systemctl start "$(basename "$NIDUM_SERVICE_FILE")" && ok=1
  else
    nidum_run sudo launchctl bootstrap system "$NIDUM_SERVICE_FILE" && ok=1
  fi
  if [ $ok = 0 ]; then
    local fallback='The startup service could not be started.'
    nidum_fail "Couldn't start network sharing again." "${NIDUM_LAST_LINE:-$fallback}" "$NIDUM_RESTART_HINT"
  fi
  if nidum_dry; then
    ui_ok 'Network sharing would be on (dry run)'
    return 0
  fi
  # Hard deadline (D22), like the service wait: NIDUM_RESUME_WAIT seconds from the bootstrap,
  # on the millisecond clock, each probe limited to what is left.
  local resume_secs
  resume_secs=$(nidum_seconds "${NIDUM_RESUME_WAIT:-}" 10 1 60)
  if nidum_wait_alive "$PROXY_PORT" $((resume_secs * 1000)); then
    nidum_log "resume wait: answered after $NIDUM_WAITED_MS ms"
    nidum_sharing_line ' (kept on by the startup service)'
    return 0
  fi
  nidum_log "resume wait: gave up after $NIDUM_WAITED_MS ms"
  nidum_fail "Couldn't start network sharing again." \
    "The startup service started, but nothing answers on port $PROXY_PORT." \
    "$NIDUM_RESTART_HINT"
}

nidum_step_proxy() {
  nidum_read_proxy_config
  if [ $PROXY_SERVICE = 1 ]; then
    # F1: a startup service owns the proxy. Never start or stop one here.
    # It may be (re)starting right after boot or a KeepAlive restart, so give it a few seconds.
    # Hard deadline (D22): NIDUM_SERVICE_WAIT + 1 s from the first probe, however slowly probes
    # or the paused check fail. The clock starts before the first probe, that probe is the
    # loop's first try, and elapsed time is measured in milliseconds.
    local wait_secs tries waited=0 shown=0 alive=0 started budget hard left limit
    wait_secs=$(nidum_seconds "${NIDUM_SERVICE_WAIT:-}" 5 1 60)
    tries=$((wait_secs * 2))
    started=$(nidum_now_ms)
    budget=$((wait_secs * 1000))
    hard=$((budget + 1000))
    nidum_proxy_alive_quick "$PROXY_PORT" && alive=1
    if [ $alive = 0 ]; then
      # Paused (D43)? A read-only check, at most 2 s and never past the budget.
      left=$((budget - ($(nidum_now_ms) - started)))
      if [ $left -gt 0 ]; then
        [ $left -gt 2000 ] && left=2000
        limit=$(printf '%d.%03d' $((left / 1000)) $((left % 1000)))
        if nidum_service_stopped "$limit"; then
          nidum_resume_service
          return 0
        fi
      fi
    fi
    while :; do
      if [ $alive = 1 ]; then
        nidum_sharing_line ' (kept on by the startup service)'
        if [ $PROXY_SERVICE_LAN = 0 ] && [ -z "$(nidum_lan_ip)" ]; then
          ui_warn "The startup service shares with this computer only. Change it under Network sharing in the dashboard."
        fi
        return 0
      fi
      [ $waited -ge $tries ] && break
      # Another try costs 0.5 s plus a probe of up to 1 s. The probe gets only what is left
      # before the hard deadline, and a try with under 0.2 s left isn't started.
      left=$((hard - ($(nidum_now_ms) - started) - 500))
      [ $left -lt 200 ] && break
      [ $left -gt 1000 ] && left=1000
      limit=$(printf '%d.%03d' $((left / 1000)) $((left % 1000)))
      if [ $shown = 0 ]; then ui_wait 'Waiting for network sharing to answer'; shown=1; fi
      sleep 0.5
      waited=$((waited + 1))
      alive=0
      nidum_proxy_alive_quick "$PROXY_PORT" "$limit" && alive=1
    done
    nidum_log "service wait: gave up after $(($(nidum_now_ms) - started)) ms"
    nidum_fail "The startup service isn't responding." \
      "Network sharing is set to start with your computer, but nothing answers on port $PROXY_PORT." \
      "$NIDUM_RESTART_HINT"
  fi

  if [ -n "$PROXY_PORT" ] && nidum_proxy_alive "$PROXY_PORT"; then
    if [ -n "$(nidum_lan_ip)" ]; then
      nidum_sharing_line ''
      return 0
    fi
    if ui_ask "Network sharing is already on, but only for this computer." \
      "Restart it so other devices can connect? Open addresses will drop for a second. [Y/n]"; then
      # D20: fields state.json lacks keep the running proxy's own TLS and port.
      nidum_proxy_flags "$PROXY_TLS" "$PROXY_PORT"
      nidum_password_note "$PROXY_PORT"
      ui_wait 'Stopping network sharing'
      if ! nidum_run portless proxy stop -p "$PROXY_PORT"; then
        # (bash 3.2 can't parse an apostrophe inside "${var:-...}", so the fallback is a variable)
        local stop_err='Portless could not stop the running network sharing.'
        nidum_fail "Couldn't restart network sharing." \
          "${NIDUM_LAST_LINE:-$stop_err}" \
          "Open Nidum Local again. If it keeps failing, run: portless doctor"
      fi
      nidum_start_proxy
      return 0
    fi
    ui_warn "Network sharing stays on for this computer only. Other devices can't connect yet."
    return 0
  fi

  # Not running, no service: start with the full explicit configuration (F1, Contracts §4).
  nidum_proxy_flags
  nidum_start_proxy
}

# ---------------------------------------------------------------- step 5: dashboard

# Contract §4: bash 3.2, no jq. A session counts only when its pid matches /api/health's pid.
nidum_read_session() {
  DASH_PORT=''; DASH_TOKEN=''; DASH_PID=''
  local copy
  # Read the file ONCE and parse that copy, so port, token and pid always come from the same
  # version even if the server renames a new session.json into place meanwhile (Contracts §4).
  copy=$(cat "$NIDUM_SESSION_FILE" 2>/dev/null) || return 1
  [ -n "$copy" ] || return 1
  DASH_PORT=$(printf '%s\n' "$copy" | sed -n 's/.*"port":\([0-9]*\).*/\1/p' | head -n 1)
  DASH_TOKEN=$(printf '%s\n' "$copy" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p' | head -n 1)
  DASH_PID=$(printf '%s\n' "$copy" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p' | head -n 1)
  nidum_valid_port "$DASH_PORT" && [ ${#DASH_TOKEN} -eq 64 ] && [ -n "$DASH_PID" ]
}

nidum_dashboard_healthy() { # port session-pid
  local body health_pid
  nidum_valid_port "$1" || return 1
  body=$(curl -s -m 2 --noproxy '*' "http://127.0.0.1:$1/api/health" 2>/dev/null) || return 1
  printf '%s' "$body" | grep -q '"app"[[:space:]]*:[[:space:]]*"nidum-local"' || return 1
  health_pid=$(printf '%s\n' "$body" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -n 1)
  if [ -z "$health_pid" ] || [ "$health_pid" != "$2" ]; then
    nidum_log "health on port $1 answers for pid ${health_pid:-?}, session.json says ${2:-?}: not this session"
    return 1
  fi
  return 0
}

nidum_session_ok() { nidum_read_session && nidum_dashboard_healthy "$DASH_PORT" "$DASH_PID"; }

# Starts the server in its own session (setsid via Node's detached spawn), so closing the
# terminal can't SIGHUP it. Node resets an ignored SIGHUP, which is why nohup is not enough.
# Prints "pid <n>" or "error <message>".
NIDUM_SPAWN_JS='
const fail = (e) => { process.stdout.write("error " + (e && e.message ? e.message : String(e)) + "\n"); process.exit(1); };
try {
  const { spawn } = require("child_process"), fs = require("fs");
  const [node, log, root] = process.argv.slice(1);
  const fd = fs.openSync(log, "a", 0o600);
  const child = spawn(node, ["src/server.js"], { cwd: root, detached: true, stdio: ["ignore", fd, fd] });
  child.on("error", fail);
  if (child.pid) { child.unref(); process.stdout.write("pid " + child.pid + "\n"); process.exit(0); }
} catch (e) { fail(e); }
'

nidum_step_dashboard() {
  if nidum_session_ok; then
    ui_ok 'Dashboard is already running'
    return 0
  fi
  if [ ! -f "$NIDUM_ROOT/src/server.js" ]; then
    nidum_fail "Nidum Local's files are incomplete." \
      "src/server.js is missing from $(nidum_pretty_path "$NIDUM_ROOT")." \
      "Download Nidum Local again, unzip it, and open it from the new folder."
  fi
  ui_wait 'Starting the dashboard'
  if nidum_dry; then
    ui_note "[dry run] would run: cd $(printf '%q' "$NIDUM_ROOT") && $(printf '%q' "$NODE_BIN") src/server.js (in its own session, output to $(printf '%q' "$NIDUM_SERVER_LOG"))"
    ui_ok 'Dashboard would be started (dry run)'
    nidum_valid_port "$DASH_PORT" || DASH_PORT=$NIDUM_DEFAULT_PORT
    DASH_TOKEN='<token>'
    return 0
  fi
  if ! ( : >>"$NIDUM_SERVER_LOG" ) 2>/dev/null; then
    nidum_fail "Couldn't start the dashboard." \
      "Its log file $(nidum_pretty_path "$NIDUM_SERVER_LOG") can't be written." \
      "Check the permissions of $(nidum_pretty_path "$NIDUM_HOME") (or remove that file), then open Nidum Local again."
  fi
  nidum_log "start: $NODE_BIN src/server.js (cwd $NIDUM_ROOT, own session)"
  local pid='' line limit tries waited=0 last
  if nidum_capture 15 "$NODE_BIN" -e "$NIDUM_SPAWN_JS" -- "$NODE_BIN" "$NIDUM_SERVER_LOG" "$NIDUM_ROOT"; then
    line=$(printf '%s\n' "$NIDUM_CAPTURE" | sed -n 's/^pid \([0-9][0-9]*\)$/\1/p' | tail -n 1)
    pid=$line
  fi
  if [ -z "$pid" ]; then
    last=$(printf '%s\n' "$NIDUM_CAPTURE" | sed -e '/^[[:space:]]*$/d' -e 's/^error //' | tail -n 1)
    nidum_fail "Couldn't start the dashboard." \
      "${last:-Node.js could not start it.}" \
      "Open Nidum Local again. If it keeps failing, see $(nidum_pretty_path "$NIDUM_SERVER_LOG")"
  fi
  nidum_log "dashboard process: pid $pid"
  limit=$(nidum_seconds "${NIDUM_START_TIMEOUT:-}" 10 1 300)
  tries=$((limit * 2))
  while [ $waited -lt $tries ]; do
    sleep 0.5
    waited=$((waited + 1))
    if nidum_session_ok; then
      nidum_log "dashboard healthy on port $DASH_PORT after $waited polls"
      ui_ok 'Dashboard started'
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      # It exited. One last look, in case it handed over to another process.
      if nidum_session_ok; then
        ui_ok 'Dashboard started'
        return 0
      fi
      last=$(sed -e '/^[[:space:]]*$/d' "$NIDUM_SERVER_LOG" 2>/dev/null | tail -n 1)
      nidum_fail "Couldn't start the dashboard." \
        "${last:-The dashboard stopped right after starting.}" \
        "Open Nidum Local again. If it keeps failing, see $(nidum_pretty_path "$NIDUM_SERVER_LOG")"
    fi
  done
  nidum_fail "Couldn't start the dashboard." \
    "It didn't answer within $limit seconds." \
    "Open Nidum Local again. If it keeps failing, see $(nidum_pretty_path "$NIDUM_SERVER_LOG")"
}

# ---------------------------------------------------------------- step 6: open the browser

nidum_step_open() {
  local base="http://127.0.0.1:$DASH_PORT" url opener=open msg
  url="$base/?t=$DASH_TOKEN"
  [ "$NIDUM_PLATFORM" = linux ] && opener=xdg-open
  ui_arrow "Opening $base in your browser"
  if nidum_dry; then
    ui_note "[dry run] would run: $opener $base/?t=<token>"
    nidum_log "run: $opener $base/?t=<token> (dry run)"
    return 0
  fi
  nidum_log "run: $opener $base/?t=<redacted>"
  if ! nidum_has "$opener" || ! "$opener" "$url" >/dev/null 2>&1; then
    # The full address (with its token) goes to the screen only, never to the log.
    msg="Couldn't open your browser. Open this address:"
    printf '  %s!%s %s %s\n' "$NIDUM_C_YELLOW" "$NIDUM_C_RESET" "$msg" "$url"
    nidum_log "! $msg $base/?t=<redacted>"
  fi
}

# ---------------------------------------------------------------- step 7 (macOS): menu bar app

NIDUM_MENU_NAME='Nidum Local Menu.app'
# The app's executable (CFBundleExecutable in macos/menubar/Info.plist, -module-name in
# scripts/build-menubar.sh). pgrep matches it exactly, for this user only. NIDUM_MENU_EXEC
# exists for tests only (a unique name, so a menu app running elsewhere can't interfere). Only
# letters and digits are honoured: anything else (an option like -v, a regex like .*) falls back
# to the real name.
NIDUM_MENU_EXEC=${NIDUM_MENU_EXEC:-NidumLocalMenu}
case "$NIDUM_MENU_EXEC" in *[!a-zA-Z0-9]*) NIDUM_MENU_EXEC=NidumLocalMenu ;; esac
# One-time build limit. It must outlast scripts/build-menubar.sh's own worst case for one
# architecture (swiftc 600 + plutil 30 + codesign 120 + 60 + lipo 30 = 840 s), so the launcher
# never kills the script while its swiftc keeps running. Two launchers building at once are
# serialized by the build script's own flock on the output folder (N7, D52): no lock here.
NIDUM_MENU_BUILD_LIMIT=900
# D52: how long an older running menu app gets to quit after SIGTERM.
NIDUM_MENU_QUIT_MS=3000
# D58: CFBundleIdentifier in macos/menubar/Info.plist. A running app counts as a menu app (and can
# ever get SIGTERM) only when its bundle has this id. Fixed: NIDUM_MENU_EXEC never changes it.
NIDUM_MENU_ID=io.nidum.local.menu

# "version" from package.json (the same sed as build-menubar.sh); empty when unreadable.
nidum_app_version() {
  [ -f "$NIDUM_ROOT/package.json" ] || return 0
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$NIDUM_ROOT/package.json" 2>/dev/null | head -n 1
}

# A <string> value from an .app bundle's (XML) Info.plist; empty when missing.
nidum_bundle_value() { # app key
  [ -f "$1/Contents/Info.plist" ] || return 0
  tr -d '\n\r' <"$1/Contents/Info.plist" 2>/dev/null |
    sed -n "s/.*<key>$2<\/key>[[:space:]]*<string>\([^<]*\)<\/string>.*/\1/p"
}

# CFBundleShortVersionString of an .app bundle; empty when missing.
nidum_bundle_version() { nidum_bundle_value "$1" CFBundleShortVersionString; }

# The bundle a running menu app was started from, or nothing when that can't be told. As safe
# as pgrep allows: ps shows the path the process was started with (open -a gives the absolute
# path inside the bundle). It counts only when that path is absolute, ends in
# .app/Contents/MacOS/<executable>, and that bundle's Info.plist names the same executable and
# has the menu app's bundle id (D58), so no other app is ever taken for it.
nidum_menu_bundle_of() { # pid
  local exe bundle
  nidum_has ps || return 0
  exe=$(ps -o comm= -p "$1" 2>/dev/null | head -n 1)
  exe=${exe%"${exe##*[! ]}"}
  case "$exe" in /*"/Contents/MacOS/$NIDUM_MENU_EXEC") ;; *) return 0 ;; esac
  bundle=${exe%"/Contents/MacOS/$NIDUM_MENU_EXEC"}
  case "$bundle" in *.app) ;; *) return 0 ;; esac
  [ "$(nidum_bundle_value "$bundle" CFBundleExecutable)" = "$NIDUM_MENU_EXEC" ] || return 0
  [ "$(nidum_bundle_value "$bundle" CFBundleIdentifier)" = "$NIDUM_MENU_ID" ] || return 0
  printf '%s' "$bundle"
}

# Finds this user's running menu apps (exact executable name; uid from id -u, never from an
# inherited $UID) and the version of the bundle each runs from, read before any rebuild can
# replace that bundle. Sets NIDUM_MENU_RUNNING (0/1) and the arrays NIDUM_MENU_PIDS,
# NIDUM_MENU_BUNDLES, NIDUM_MENU_VERS (an empty version: can't tell).
nidum_menu_scan() {
  NIDUM_MENU_RUNNING=0
  NIDUM_MENU_PIDS=()
  NIDUM_MENU_BUNDLES=()
  NIDUM_MENU_VERS=()
  local uid found pid bundle ver
  nidum_has pgrep || return 0
  uid=$(id -u 2>/dev/null)
  case "$uid" in ''|*[!0-9]*) nidum_log 'menu bar app: no user id, so no running check'; return 0 ;; esac
  found=$(pgrep -U "$uid" -x -- "$NIDUM_MENU_EXEC" 2>/dev/null) || return 0
  NIDUM_MENU_RUNNING=1
  for pid in $found; do
    case "$pid" in *[!0-9]*) continue ;; esac
    bundle=$(nidum_menu_bundle_of "$pid")
    ver=''
    [ -n "$bundle" ] && ver=$(nidum_bundle_version "$bundle")
    nidum_log "menu bar app running: pid $pid, bundle ${bundle:-unknown}, version ${ver:-unknown}"
    NIDUM_MENU_PIDS=("${NIDUM_MENU_PIDS[@]}" "$pid")
    NIDUM_MENU_BUNDLES=("${NIDUM_MENU_BUNDLES[@]}" "$bundle")
    NIDUM_MENU_VERS=("${NIDUM_MENU_VERS[@]}" "$ver")
  done
}

# 0 when a running menu app is known to be version $1.
nidum_menu_is_current() { # version
  local i=0
  [ -n "$1" ] || return 1
  while [ $i -lt ${#NIDUM_MENU_VERS[@]} ]; do
    [ "${NIDUM_MENU_VERS[$i]}" = "$1" ] && return 0
    i=$((i + 1))
  done
  return 1
}

# D52: a running menu app known to be another version than $1 (the bundle about to start) gets
# SIGTERM, then up to 3 s to quit. One whose version can't be told is left alone: the new one
# is started anyway, and open -a plus the app's own lock keep a single instance. Sets
# NIDUM_MENU_STOPPED to the bundles it signalled (D58: one of them is reopened if the current one
# can't be started).
nidum_menu_stop_stale() { # version
  local i=0 pid stale='' started left
  NIDUM_MENU_STOPPED=()
  [ -n "$1" ] || return 0
  while [ $i -lt ${#NIDUM_MENU_PIDS[@]} ]; do
    pid=${NIDUM_MENU_PIDS[$i]}
    if [ -n "${NIDUM_MENU_VERS[$i]}" ] && [ "${NIDUM_MENU_VERS[$i]}" != "$1" ]; then
      if nidum_dry; then
        stale="$stale $pid"
      elif [ "$(nidum_menu_bundle_of "$pid")" = "${NIDUM_MENU_BUNDLES[$i]}" ]; then
        # Still the same process (same bundle path); a reused pid would no longer match.
        stale="$stale $pid"
        NIDUM_MENU_STOPPED=("${NIDUM_MENU_STOPPED[@]}" "${NIDUM_MENU_BUNDLES[$i]}")
      fi
    fi
    i=$((i + 1))
  done
  [ -n "$stale" ] || return 0
  ui_wait "Restarting the menu bar app for version $1"
  for pid in $stale; do
    if nidum_dry; then
      ui_note "[dry run] would run: kill -TERM $pid"
    else
      nidum_log "menu bar app: SIGTERM to pid $pid (another version than $1)"
      kill -TERM "$pid" 2>/dev/null
    fi
  done
  nidum_dry && return 0
  started=$(nidum_now_ms)
  while :; do
    left=''
    for pid in $stale; do kill -0 "$pid" 2>/dev/null && left="$left $pid"; done
    if [ -z "$left" ]; then
      nidum_log "menu bar app: older one quit after $(($(nidum_now_ms) - started)) ms"
      return 0
    fi
    [ $(($(nidum_now_ms) - started)) -ge $NIDUM_MENU_QUIT_MS ] && break
    sleep 0.1
  done
  nidum_log "menu bar app: pid$left still running after $(($(nidum_now_ms) - started)) ms; starting this version anyway"
}

# Starts the menu bar app once (N7, D40, D52). Never fails the launcher: problems are one ! line.
nidum_step_menubar() {
  [ "$NIDUM_PLATFORM" = macos ] || return 0
  case "${NIDUM_NO_MENUBAR:-}" in ''|0|false|no) ;; *) nidum_log 'menu bar app: disabled (NIDUM_NO_MENUBAR)'; return 0 ;; esac
  local app="$NIDUM_ROOT/macos/$NIDUM_MENU_NAME" built="$NIDUM_HOME/app/$NIDUM_MENU_NAME"
  local script="$NIDUM_ROOT/scripts/build-menubar.sh"
  local want have='' expect target would_build=0
  want=$(nidum_app_version)
  # Before any build: a rebuild replaces the bundle a running app came from.
  nidum_menu_scan
  # The version that would start: the prebuilt app's, else this Nidum Local's (what a build makes).
  if [ -d "$app" ]; then
    expect=$(nidum_bundle_version "$app")
  else
    expect=$want
    [ -z "$expect" ] && [ -d "$built" ] && expect=$(nidum_bundle_version "$built")
  fi
  if [ $NIDUM_MENU_RUNNING = 1 ] && nidum_menu_is_current "$expect"; then
    ui_ok 'Menu bar app is already running'
    return 0
  fi
  if [ ! -d "$app" ]; then
    app=$built
    # Build once on the first run, and once more whenever Nidum Local's version changes, so an
    # old build never runs against a newer server.
    local title='Building the menu bar app (first run only)'
    if [ -d "$built" ]; then
      have=$(nidum_bundle_version "$built")
      title='Updating the menu bar app'
    fi
    if [ ! -d "$built" ] || { [ -n "$want" ] && [ "$have" != "$want" ]; }; then
      if [ -d "$built" ]; then
        nidum_log "menu bar app in $NIDUM_HOME/app is version ${have:-unknown}, Nidum Local is $want: rebuilding"
        if ! nidum_has swiftc || [ ! -f "$script" ]; then
          ui_warn "The menu bar app is from an earlier version and can't be rebuilt here. The dashboard works without it."
          return 0
        fi
      fi
      if ! nidum_has swiftc; then
        ui_warn "The menu bar app isn't included and can't be built here (no Swift compiler). The dashboard works without it."
        return 0
      fi
      if [ ! -f "$script" ]; then
        ui_warn "The menu bar app isn't included in this copy of Nidum Local. The dashboard works without it."
        return 0
      fi
      ui_wait "$title"
      if nidum_dry; then
        ui_note "[dry run] would run: NIDUM_MENUBAR_ARCHS=native /bin/bash $(printf '%q' "$script") $(printf '%q' "$built")"
        would_build=1
      else
        mkdir -p "$NIDUM_HOME/app" 2>/dev/null
        # This Mac's architecture only: about half the time of a universal build.
        if ! NIDUM_MENUBAR_ARCHS=native nidum_capture $NIDUM_MENU_BUILD_LIMIT /bin/bash "$script" "$built" ||
          [ ! -d "$built" ] || { [ -n "$want" ] && [ "$(nidum_bundle_version "$built")" != "$want" ]; }; then
          nidum_log "menu bar build failed: $NIDUM_CAPTURE"
          ui_warn "Couldn't build the menu bar app. The dashboard works without it. Details are in the log."
          return 0
        fi
        nidum_log "menu bar build: $NIDUM_CAPTURE"
      fi
    fi
  fi
  # A dry run builds nothing, so the bundle on disk may be missing or older: report what a real
  # run would start, the version a build makes.
  if [ $would_build = 1 ]; then
    target=$expect
  else
    target=$(nidum_bundle_version "$app")
    if [ -z "$target" ] && nidum_dry; then target=$expect; fi
  fi
  NIDUM_MENU_STOPPED=()
  if [ $NIDUM_MENU_RUNNING = 1 ]; then
    if nidum_menu_is_current "$target"; then
      ui_ok 'Menu bar app is already running'
      return 0
    fi
    # Without open nothing could start afterwards, so nothing is stopped either.
    if nidum_has open || nidum_dry; then nidum_menu_stop_stale "$target"; fi
  fi
  # The app refuses a Node.js older than 18 and starts the server only from an explicit
  # --app-root, so both always come from here: the Node.js this launcher chose (absolute).
  local node=$NODE_BIN
  case "$node" in ''|/*) ;; */*) node="$PWD/$node" ;; esac
  local -a args
  args=(--app-root "$NIDUM_ROOT")
  [ -n "$node" ] && args=("${args[@]}" --node "$node")
  local shown
  shown="open -g -a $(printf '%q' "$app") --env NIDUM_HOME=$(printf '%q' "$NIDUM_HOME") --args$(printf ' %q' "${args[@]}")"
  if nidum_dry; then
    ui_note "[dry run] would run: $shown"
    return 0
  fi
  nidum_log "run: $shown"
  if nidum_has open && open -g -a "$app" --env "NIDUM_HOME=$NIDUM_HOME" --args "${args[@]}" >/dev/null 2>&1; then
    ui_ok 'Menu bar app started'
    return 0
  fi
  # D58: an older app was stopped for this one, which didn't start (for example Gatekeeper refused
  # a newly downloaded copy). An old menu app beats none: reopen the bundle it ran from, with the
  # same arguments, unless that bundle is the one that just failed (a rebuild in place).
  local old
  for old in "${NIDUM_MENU_STOPPED[@]}"; do
    [ "$old" != "$app" ] && [ -d "$old" ] || continue
    nidum_log "menu bar app: $app didn't start; reopening the earlier one: $old"
    if open -g -a "$old" --env "NIDUM_HOME=$NIDUM_HOME" --args "${args[@]}" >/dev/null 2>&1; then
      ui_warn "Couldn't start the new menu bar app, so the earlier version was started again. Details are in the log."
      return 0
    fi
    nidum_log "menu bar app: reopening $old failed too"
    break
  done
  ui_warn "Couldn't start the menu bar app. The dashboard works without it."
}

# ---------------------------------------------------------------- main

nidum_main() {
  nidum_init
  nidum_header
  nidum_step_home
  nidum_step_tools
  nidum_step_node
  nidum_step_portless
  nidum_step_avahi
  nidum_step_proxy
  nidum_step_dashboard
  nidum_step_open
  nidum_step_menubar
  printf '\n  You can close this window. Nidum Local keeps running.\n\n'
  nidum_log 'done, exit 0'
  exit 0
}
