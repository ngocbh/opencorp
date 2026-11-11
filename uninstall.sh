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
# An error that doesn't stop the rest; the script ends with status 1.
fail() {
  printf '%s✗%s %s\n' "$C_ERR" "$C_OFF" "$1" >&2
  FAILED=1
}

# Single-quotes $1 for a shell script.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# The marked lines install.sh writes to put BIN_DIR on PATH: SH_LINE for sh-like shells, FISH_LINE for fish.
path_lines() {
  SUFFIX="  # added by opencorp install.sh"
  # shellcheck disable=SC2016
  SH_LINE="case \":\$PATH:\" in *:$(quote "$BIN_DIR"):*) ;; *) export PATH=$(quote "$BIN_DIR"):\"\$PATH\" ;; esac$SUFFIX"
  FISH_LINE="fish_add_path --path $(quote "$BIN_DIR")$SUFFIX"
}

# The size in bytes of file $1, or of standard input.
bytes() {
  if [ $# -gt 0 ]; then LC_ALL=C wc -c <"$1"; else LC_ALL=C wc -c; fi | tr -d ' '
}

# Takes the marked PATH lines out of the rc file $1, keeping every other byte. On any failure the file is left as it
# was, and says so.
remove_path_lines() {
  [ -f "$1" ] || return 0
  rl_sh=$(LC_ALL=C grep -a -c -F -x -e "$SH_LINE" "$1") || true
  rl_fish=$(LC_ALL=C grep -a -c -F -x -e "$FISH_LINE" "$1") || true
  case $rl_sh.$rl_fish in
    0.0) return 0 ;;
    *[!0-9.]* | .* | *.) fail "Couldn't read $1. Take out the line that ends in '$SUFFIX' yourself."; return 0 ;;
  esac
  if [ ! -w "$1" ]; then
    fail "$1 isn't writable, so its PATH line stays. Take out this line yourself: $SH_LINE"
    return 0
  fi
  rl_tmp=$(mktemp) || { fail "Couldn't make a temp file, so $1 is as it was."; return 0; }
  rl_status=0
  LC_ALL=C grep -a -v -F -x -e "$SH_LINE" -e "$FISH_LINE" "$1" >"$rl_tmp" || rl_status=$?
  # The old file less the marked lines, each with its newline; grep ends a last line that had none.
  rl_want=$(($(bytes "$1") - rl_sh * $(printf '%s\n' "$SH_LINE" | bytes) - rl_fish * $(printf '%s\n' "$FISH_LINE" | bytes)))
  if [ -n "$(tail -c 1 "$1")" ]; then rl_want=$((rl_want + 1)); fi
  # Status 1 is grep's for no lines left.
  if [ "$rl_status" -gt 1 ] || [ "$(bytes "$rl_tmp")" != "$rl_want" ]; then
    rm -f "$rl_tmp"
    fail "Couldn't rewrite $1, so it's as it was. Take out the line that ends in '$SUFFIX' yourself."
    return 0
  fi
  # Write back through the original file, so its permissions and any symlink stay.
  if ! cat "$rl_tmp" >"$1" || ! cmp -s "$rl_tmp" "$1"; then
    fail "Writing $1 stopped part-way. Its whole new text is in $rl_tmp: copy that over it."
    return 0
  fi
  rm -f "$rl_tmp"
  # The file stays, even when nothing is left in it: it may have been there, empty, before install.sh.
  ok "Removed the PATH line from $1"
}

# Whether $1 is the wrapper install.sh writes: its second line is WRAPPER_MARK, exactly.
is_wrapper() {
  [ -f "$1" ] && [ "$(LC_ALL=C sed -n '2{p;q;}' "$1" 2>/dev/null)" = "$WRAPPER_MARK" ]
}

# The checkout install.sh's wrapper $1 runs, from its third line.
wrapper_checkout() {
  wc_to=$(LC_ALL=C sed -n '3{p;q;}' "$1")
  case $wc_to in "# Runs "*/packages/cli/bin/opencorp) ;; *) return 1 ;; esac
  wc_to=${wc_to#"# Runs "}
  printf '%s\n' "${wc_to%/packages/cli/bin/opencorp}"
}

# Whether $1 and $2 are the same folder, both there.
same_dir() {
  sd_a=$(cd -P "$1" 2>/dev/null && pwd -P) && sd_b=$(cd -P "$2" 2>/dev/null && pwd -P) &&
    [ "$sd_a" = "$sd_b" ]
}

# Drops PATH's relative and empty entries: they name whatever folder the script runs in, so a `bun` or `git` found
# there could be any project's.
absolute_path() {
  ap_out=
  ap_rest=$PATH:
  while [ -n "$ap_rest" ]; do
    ap_dir=${ap_rest%%:*}
    ap_rest=${ap_rest#*:}
    case $ap_dir in /*) ap_out=${ap_out:+$ap_out:}$ap_dir ;; esac
  done
  PATH=$ap_out
}

# Stops unless $2, the path named $1, is absolute and has no newline in it.
need_path() {
  case $2 in
    *"$NL"*) die "$1 holds a newline. Pick a path without one." ;;
    /*) ;;
    *) die "$1 must be an absolute path, not ${2:-empty}." ;;
  esac
}

# Stops when run through sudo, as root in someone's home: their next run, as themselves, couldn't change what it made.
not_sudo() {
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
    die "Run this as yourself, not through sudo: it works in the home of whoever runs it ($HOME)."
  fi
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
# none. $2 is what `git status --ignored=matching` shows for what install.sh makes there, which uninstall.sh removes
# with the clone; every other file that isn't committed is someone's work, and the first five are named. Finder's
# .DS_Store files don't count. Anything git can't answer counts as work.
repo_work() {
  W_DIR=$1
  w_out=$(wgit status --porcelain --untracked-files=all --ignored=matching --ignore-submodules=none) ||
    { echo "it can't be read by git"; return; }
  # shellcheck disable=SC2016
  w_out=$(printf '%s\n' "$w_out" | BUILT="^!! ($2)\$" LC_ALL=C awk '
    $0 == "" || $0 ~ ENVIRON["BUILT"] { next }
    { path = substr($0, 4) }
    path ~ /(^|\/)\.DS_Store"?$/ { next }
    { n++; if (n <= 5) names = names (n > 1 ? ", " : "") path }
    END { if (n > 5) names = names ", and " (n - 5) " more"; if (n) print names }
  ') || { echo "it can't be read by git"; return; }
  [ -z "$w_out" ] || { echo "it has files that aren't committed: $w_out"; return; }
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
  # The node_modules folders of the root and of each workspace package, and HQ's build.
  lw_why=$(repo_work "$1" 'node_modules/|packages/[^/"]+/node_modules/|packages/app/dist/')
  [ -z "$lw_why" ] || { echo "$lw_why"; return; }
  W_DIR=$1
  # shellcheck disable=SC2016
  lw_subs=$(wgit submodule --quiet foreach --recursive 'printf "%s\n" "$displaypath"') ||
    { echo "its submodules can't be read by git"; return; }
  while IFS= read -r lw_sub; do
    [ -n "$lw_sub" ] || continue
    # A submodule that is a workspace package gets its own node_modules folder.
    lw_why=$(repo_work "$1/$lw_sub" 'node_modules/')
    [ -z "$lw_why" ] || { echo "its submodule $lw_sub ${lw_why#it }"; return; }
  done <<EOF
$lw_subs
EOF
}

# Removes the clone at $1 (the folder a link there points at) if install.sh made it and it holds no work found
# nowhere else; otherwise says why it stays. A folder that was there before install.sh cloned into it is kept, empty.
remove_clone() {
  [ -d "$1" ] || return 0
  rm_dir=$(cd -P "$1" && pwd -P) || { fail "Couldn't look in $1."; return 0; }
  if [ ! -f "$rm_dir/.git/opencorp-installer" ]; then
    ok "Left $rm_dir in place: install.sh did not clone it."
    return 0
  fi
  case $HOME/ in "$rm_dir"/* | "$rm_dir"//*)
    fail "Won't remove $rm_dir, which holds your home folder."
    return 0
    ;;
  esac
  rm_why=$(local_work "$rm_dir")
  if [ -n "$rm_why" ]; then
    warn "Left $rm_dir in place: $rm_why."
    return 0
  fi
  if LC_ALL=C grep -q -x 'folder=new' "$rm_dir/.git/opencorp-installer"; then
    rm -rf "$rm_dir" || { fail "Couldn't remove all of $rm_dir."; return 0; }
  else
    for rm_f in "$rm_dir"/* "$rm_dir"/.[!.]* "$rm_dir"/..?*; do
      if [ -e "$rm_f" ] || [ -L "$rm_f" ]; then rm -rf "$rm_f" || { fail "Couldn't remove all of $rm_dir."; return 0; }; fi
    done
  fi
  ok "Removed $rm_dir"
}

# All of it runs from the last line, so a download cut off part-way runs nothing.
main() {
  init_output
  unset CDPATH
  NL='
'
  absolute_path
  need_path HOME "${HOME:-}"
  not_sudo
  FAILED=0
  # The second line of the wrapper install.sh writes, which marks it as install.sh's.
  WRAPPER_MARK="# Written by opencorp install.sh; uninstall.sh removes it."
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
  [ -z "$DIR" ] || need_path "The install folder (--dir or OPENCORP_INSTALL_DIR)" "$DIR"
  BIN_DIR=${OPENCORP_BIN_DIR:-$HOME/.local/bin}
  need_path OPENCORP_BIN_DIR "$BIN_DIR"
  TARGET=$BIN_DIR/opencorp
  OFFICE=${OPENCORP_HOME:-$HOME/.opencorp}

  if office_set_up; then
    has_tty || die "An office is set up at $OFFICE. Run opencorp offboard on a terminal first, then run this again."
    if is_wrapper "$TARGET"; then
      OPENCORP=$TARGET
    elif command -v opencorp >/dev/null 2>&1; then
      OPENCORP=$(command -v opencorp)
    else
      die "An office is set up at $OFFICE, but there's no opencorp here to offboard it. Run opencorp offboard first, then run this again."
    fi
    step "An office is set up at $OFFICE; running opencorp offboard first (whatever it says about the opencorp command and the checkout, uninstall.sh sees to those next)"
    "$OPENCORP" offboard </dev/tty || die "opencorp offboard didn't finish, so nothing else was removed."
    if office_set_up; then die "An office is still set up at $OFFICE, so nothing else was removed."; fi
  fi

  # The clones to look at: the one --dir names, or else the one the wrapper runs and the default one.
  CLONE=${DIR:-}
  OTHER=
  if [ -z "$CLONE" ]; then
    if is_wrapper "$TARGET"; then CLONE=$(wrapper_checkout "$TARGET") || CLONE=; fi
    OTHER=$HOME/.local/share/opencorp
    if [ -z "$CLONE" ]; then CLONE=$OTHER OTHER=; elif same_dir "$CLONE" "$OTHER"; then OTHER=; fi
  fi

  if is_wrapper "$TARGET"; then
    if rm -f "$TARGET"; then ok "Removed $TARGET"; else fail "Couldn't remove $TARGET."; fi
  elif [ -e "$TARGET" ]; then
    ok "Left $TARGET in place: install.sh did not write it."
  fi

  path_lines
  for rc in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bash_login" \
    "${ZDOTDIR:-$HOME}/.zshrc" "${ZDOTDIR:-$HOME}/.zprofile" "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; do
    remove_path_lines "$rc"
  done

  remove_clone "$CLONE"
  if [ -n "$OTHER" ]; then remove_clone "$OTHER"; fi
  ok "Left Bun and the office home ($OFFICE) in place."
  [ "$FAILED" = 0 ] || exit 1
}

# In braces, so a download cut off inside this line is a syntax error rather than a run without the flags.
{ main "$@"; }
