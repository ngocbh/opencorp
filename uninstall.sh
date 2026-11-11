#!/bin/sh
# Takes out what `install.sh` put in. While an office is set up, it first runs `opencorp offboard`
# on the terminal, which asks before it removes anything and keeps company work that isn't pushed;
# if that doesn't finish, nothing else changes. Then it removes the `opencorp` wrapper, the PATH
# lines in the shell rc files, and the clone, if install.sh made it and it holds no work that isn't
# pushed. It leaves Bun and the office home (~/.opencorp) in place.
#
#   curl -fsSL https://raw.githubusercontent.com/ngocbh/opencorp/main/uninstall.sh | bash
#   ./uninstall.sh [--dir DIR]

set -eu

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--dir DIR]

  --dir DIR  the clone install.sh made (OPENCORP_INSTALL_DIR, default ~/.local/share/opencorp)

Environment: OPENCORP_BIN_DIR, the folder of the `opencorp` wrapper (default ~/.local/bin);
OPENCORP_HOME, the office's home (default ~/.opencorp).
EOF
}

# Output: one line per step, coloured only on a terminal.
init_output() {
  C_STEP='' C_OK='' C_WARN='' C_ERR='' C_OFF=''
  if [ -t 1 ] && [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
    C_STEP=$(printf '\033[36m') C_OK=$(printf '\033[32m') C_WARN=$(printf '\033[33m')
    C_ERR=$(printf '\033[31m') C_OFF=$(printf '\033[0m')
  fi
}
step() { printf '%s→%s %s\n' "$C_STEP" "$C_OFF" "$1"; }
ok() { printf '%s✓%s %s\n' "$C_OK" "$C_OFF" "$1"; }
warn() { printf '%s⚠%s %s\n' "$C_WARN" "$C_OFF" "$1" >&2; }
die() {
  printf '%s✗%s %s\n' "$C_ERR" "$C_OFF" "$1" >&2
  exit 1
}

# Whether a terminal is there to ask on: stdin is the script under `curl | bash`.
has_tty() { (: </dev/tty) 2>/dev/null; }

# Whether an office is set up at OFFICE: any of the state `opencorp offboard` removes is there.
office_set_up() {
  for f in office identity.json tui .company-clone; do
    if [ -e "$OFFICE/$f" ] || [ -L "$OFFICE/$f" ]; then return 0; fi
  done
  return 1
}

# Why the clone at $1 holds work found nowhere else; nothing when it holds none.
unpushed() {
  u_out=$(git -C "$1" status --porcelain) || { echo "git can't read it"; return; }
  [ -z "$u_out" ] || { echo "it has uncommitted changes"; return; }
  u_out=$(git -C "$1" stash list) || { echo "git can't read it"; return; }
  [ -z "$u_out" ] || { echo "it has stashed changes"; return; }
  u_out=$(git -C "$1" log --branches --not --remotes --format=%h) || { echo "git can't read it"; return; }
  [ -z "$u_out" ] || echo "it has commits that aren't pushed"
}

# All of it runs from the last line, so a download cut off part-way runs nothing.
main() {
  init_output
  MARK="opencorp install.sh"
  DIR=${OPENCORP_INSTALL_DIR:-}
  while [ $# -gt 0 ]; do
    case $1 in
      --dir)
        [ $# -ge 2 ] || die "--dir needs a value (see --help)."
        DIR=$2
        shift 2
        ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option $1 (see --help)." ;;
    esac
  done
  DIR=${DIR:-$HOME/.local/share/opencorp}
  case $DIR in /*) ;; *) DIR=$PWD/$DIR ;; esac
  BIN_DIR=${OPENCORP_BIN_DIR:-$HOME/.local/bin}
  TARGET=$BIN_DIR/opencorp
  OFFICE=${OPENCORP_HOME:-$HOME/.opencorp}

  if office_set_up; then
    has_tty || die "An office is set up at $OFFICE. Run opencorp offboard on a terminal first, then run this again."
    if [ -f "$TARGET" ] && grep -q "$MARK" "$TARGET" 2>/dev/null; then
      OPENCORP=$TARGET
    elif command -v opencorp >/dev/null 2>&1; then
      OPENCORP=$(command -v opencorp)
    else
      die "An office is set up at $OFFICE, but there's no opencorp here to offboard it. Run opencorp offboard first, then run this again."
    fi
    step "An office is set up at $OFFICE; running opencorp offboard first"
    "$OPENCORP" offboard </dev/tty || die "opencorp offboard didn't finish, so nothing else was removed."
    if office_set_up; then die "An office is still set up at $OFFICE, so nothing else was removed."; fi
  fi

  if [ -e "$TARGET" ]; then
    if grep -q "$MARK" "$TARGET" 2>/dev/null; then
      rm -f "$TARGET"
      ok "Removed $TARGET"
    else
      ok "Left $TARGET in place: install.sh did not write it."
    fi
  fi

  for rc in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bash_login" \
    "${ZDOTDIR:-$HOME}/.zshrc" "${ZDOTDIR:-$HOME}/.zprofile" "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; do
    [ -f "$rc" ] && grep -qF "$MARK" "$rc" || continue
    tmp=$(mktemp)
    grep -vF "$MARK" "$rc" >"$tmp" || true
    # Write back through the original file, so its permissions and any symlink stay.
    cat "$tmp" >"$rc"
    rm -f "$tmp"
    ok "Removed the PATH line from $rc"
  done

  if [ -d "$DIR" ]; then
    if [ ! -f "$DIR/.git/opencorp-installer" ]; then
      ok "Left $DIR in place: install.sh did not clone it."
    else
      why=$(unpushed "$DIR")
      if [ -n "$why" ]; then
        warn "Left $DIR in place: $why."
      else
        rm -rf "$DIR"
        ok "Removed $DIR"
      fi
    fi
  fi
  ok "Left Bun and the office home ($OFFICE) in place."
}

main "$@"
