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

# git in the repo at W_DIR, run the same whatever the user's git config says.
wgit() {
  LC_ALL=C git --no-optional-locks -c core.quotePath=true -c status.showUntrackedFiles=all \
    -c core.fsmonitor=false -c core.untrackedCache=false -C "$W_DIR" "$@"
}

# Why the repo at $1 (the clone or one of its submodules) holds work found nowhere else; nothing when it holds
# none. Anything git can't answer counts as work.
repo_work() {
  W_DIR=$1
  # What `git status --ignored=matching` shows for what install.sh makes: node_modules folders (the root's, each
  # package's and yian's) and HQ's build. Every other ignored file is someone's work.
  w_built='!! (([^"]*/)?node_modules/|packages/app/dist/)'
  w_out=$(wgit status --porcelain --untracked-files=all --ignored=matching --ignore-submodules=none) ||
    { echo "it can't be read by git"; return; }
  if [ -n "$w_out" ]; then
    w_status=0
    printf '%s\n' "$w_out" | LC_ALL=C grep -a -v -x -E "$w_built" >/dev/null || w_status=$?
    # 1: every line was install.sh's own.
    [ "$w_status" = 1 ] || { echo "it has changes or files that aren't committed"; return; }
  fi
  w_out=$(wgit stash list) || { echo "it can't be read by git"; return; }
  [ -z "$w_out" ] || { echo "it has stashed changes"; return; }
  # Every ref and HEAD, so a detached HEAD, a tag or any branch counts.
  w_out=$(wgit rev-list --all --not --remotes) || { echo "it can't be read by git"; return; }
  [ -z "$w_out" ] || { echo "it has commits that aren't pushed"; return; }
  w_out=$(wgit worktree list --porcelain) || { echo "it can't be read by git"; return; }
  [ "$(printf '%s\n' "$w_out" | LC_ALL=C grep -a -c '^worktree ')" -le 1 ] || echo "it has other worktrees"
}

# Why the clone at $1 holds work found nowhere else, in it or any of its submodules; nothing when it holds none.
local_work() {
  lw_why=$(repo_work "$1")
  [ -z "$lw_why" ] || { echo "$lw_why"; return; }
  W_DIR=$1
  # shellcheck disable=SC2016
  lw_subs=$(wgit submodule --quiet foreach --recursive 'printf "%s\n" "$displaypath"') ||
    { echo "its submodules can't be read by git"; return; }
  while IFS= read -r lw_sub; do
    [ -n "$lw_sub" ] || continue
    lw_why=$(repo_work "$1/$lw_sub")
    [ -z "$lw_why" ] || { echo "its submodule $lw_sub ${lw_why#it }"; return; }
  done <<EOF
$lw_subs
EOF
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
      why=$(local_work "$DIR")
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
