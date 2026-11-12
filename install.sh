#!/bin/sh
# Installs OpenCorp. Piped from the web, it clones OpenCorp with its yian submodule into
# ~/.local/share/opencorp (or updates a clean earlier clone there); run from a checkout, it installs
# that checkout. Then it finds Bun (installing the version OpenCorp pins when there is none), installs
# the dependencies, builds HQ's web app, writes an `opencorp` wrapper into ~/.local/bin, puts that
# folder on PATH in the login shell's rc files, and, on a terminal, offers to create the company.
# Running it again updates the install; `uninstall.sh` takes it back out.
#
#   curl -fsSL https://raw.githubusercontent.com/ngocbh/opencorp/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/ngocbh/opencorp/main/install.sh | bash -s -- --skip-setup
#   ./install.sh

set -eu

usage() {
  cat <<'EOF'
Usage: install.sh [--dir DIR] [--branch REF] [--repo URL] [--skip-setup] [--no-modify-path] [--switch]

  --dir DIR         where the clone goes (OPENCORP_INSTALL_DIR, default ~/.local/share/opencorp)
  --branch REF      the branch or tag a new clone checks out (default main)
  --repo URL        the repo to clone (OPENCORP_REPO_URL, default https://github.com/ngocbh/opencorp.git)
  --skip-setup      don't offer to create the company; print the next step instead
  --switch          move a set-up office to this install: stop it first, then point opencorp here
  --no-modify-path  leave the shell's rc files alone

Environment: OPENCORP_BIN_DIR, the folder for the `opencorp` wrapper (default ~/.local/bin);
OPENCORP_BUN, the Bun to use; OPENCORP_HOME, the office's home (default ~/.opencorp).
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

# Single-quotes $1 for a shell script.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Runs "$@" with its output kept in a log, whose end is shown only if it fails.
quietly() {
  q_log=$(mktemp) || return 1
  q_status=0
  "$@" >"$q_log" 2>&1 || q_status=$?
  if [ "$q_status" -ne 0 ]; then
    tail -n 30 "$q_log" >&2
    printf '  (all of its output is in %s)\n' "$q_log" >&2
    return "$q_status"
  fi
  rm -f "$q_log"
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

# The first bun on PATH, leaving out folders inside the current one (a project's own bin, as direnv's PATH_add
# makes) unless the current folder is the home or holds it. PATH's relative entries are gone already.
find_bun() {
  fb_here=$(pwd -P)
  fb_here=${fb_here%/}
  fb_rest=$PATH:
  while [ -n "$fb_rest" ]; do
    fb_dir=${fb_rest%%:*}
    fb_rest=${fb_rest#*:}
    case $HOME/ in
      "$fb_here"/* | "$PWD"/*) ;;
      *) case $fb_dir/ in "$fb_here"/* | "$PWD"/*) continue ;; esac ;;
    esac
    if [ -f "$fb_dir/bun" ] && [ -x "$fb_dir/bun" ]; then
      printf '%s\n' "$fb_dir/bun"
      return 0
    fi
  done
  return 1
}

# Whether a terminal is there to ask on: stdin is the script under `curl | bash`.
has_tty() { (: </dev/tty) 2>/dev/null; }

# Asks $1 on the terminal; the answer goes in ANSWER, or $2 for an empty line. False at the end of input (Ctrl-D).
ask() {
  printf '%s ' "$1" >/dev/tty
  ANSWER=
  if ! IFS= read -r ANSWER </dev/tty; then
    printf '\n' >/dev/tty
    return 1
  fi
  [ -n "$ANSWER" ] || ANSWER=$2
}

# Why $1 (a full path, without trailing slashes) can't be the company's project folder; false when it can be one.
# opencorp init refuses more, and says why.
not_a_project() {
  case $1 in
    '') echo "Pick a project folder, not /." ;;
    *"$NL"*) echo "Pick a folder without a newline in its path." ;;
    /*)
      case $HOME/ in "$1"/*) echo "Pick a project folder, not your home folder or a folder that holds it." && return 0 ;; esac
      case $1/ in "$ROOT"/*) echo "Pick a project folder outside the OpenCorp checkout." && return 0 ;; esac
      case $1/ in "$OFFICE"/*) echo "Pick a project folder outside the office's home, $OFFICE." && return 0 ;; esac
      if [ -e "$1" ] && [ ! -d "$1" ]; then echo "$1 isn't a folder." && return 0; fi
      return 1
      ;;
    *) echo "Give the full path, starting with / or ~/." ;;
  esac
}

# Offers to create the company: asks for a project folder until it gets one it can make, then runs opencorp init
# there on the terminal.
offer_setup() {
  if ! ask "→ Create your company now? [Y/n]" y || case $ANSWER in [Nn]*) true ;; *) false ;; esac; then
    step "Next: in a project folder, run opencorp init."
    return 0
  fi
  while :; do
    if ! ask "→ Project folder for it [$HOME/projects/opencorp]:" "$HOME/projects/opencorp"; then
      step "Next: in a project folder, run opencorp init."
      return 0
    fi
    case $ANSWER in "~") ANSWER=$HOME ;; "~/"*) ANSWER=$HOME/${ANSWER#"~/"} ;; esac
    while :; do case $ANSWER in */) ANSWER=${ANSWER%/} ;; *) break ;; esac; done
    if why=$(not_a_project "$ANSWER"); then
      warn "$why"
    elif ! mkdir -p "$ANSWER" 2>/dev/null; then
      warn "Can't make $ANSWER. Pick another folder."
    else
      break
    fi
  done
  step "Running opencorp init in $ANSWER"
  if ! (cd "$ANSWER" && PATH="$BIN_DIR:$PATH" "$TARGET" init </dev/tty >/dev/tty 2>&1); then
    warn "opencorp init didn't finish. Run it again: cd $(quote "$ANSWER") && opencorp init"
  fi
}

# Whether $1 is an OpenCorp checkout.
is_checkout() {
  [ -f "$1/packages/cli/bin/opencorp" ] && grep -q '"name": *"opencorp-workspace"' "$1/package.json" 2>/dev/null
}

# Whether $1 is the wrapper install.sh writes: its second line is WRAPPER_MARK, exactly.
is_wrapper() {
  [ -f "$1" ] && [ "$(LC_ALL=C sed -n '2{p;q;}' "$1" 2>/dev/null)" = "$WRAPPER_MARK" ]
}

# The OpenCorp checkout the launcher $1 runs: the one install.sh's wrapper names on its third line, or the one a
# link to a checkout's packages/cli/bin/opencorp (the README's manual step) points into.
launcher_checkout() {
  if is_wrapper "$1"; then
    lc_to=$(LC_ALL=C sed -n '3{p;q;}' "$1")
    case $lc_to in "# Runs "*) lc_to=${lc_to#"# Runs "} ;; *) return 1 ;; esac
  elif [ -L "$1" ]; then
    lc_to=$(readlink "$1")
    case $lc_to in /*) ;; *) lc_to=$(dirname "$1")/$lc_to ;; esac
  else
    return 1
  fi
  case $lc_to in */packages/cli/bin/opencorp) lc_to=${lc_to%/packages/cli/bin/opencorp} ;; *) return 1 ;; esac
  is_checkout "$lc_to" && printf '%s\n' "$lc_to"
}

# Whether $1 and $2 are the same folder, both there.
same_dir() {
  sd_a=$(cd -P "$1" 2>/dev/null && pwd -P) && sd_b=$(cd -P "$2" 2>/dev/null && pwd -P) &&
    [ "$sd_a" = "$sd_b" ]
}

# Whether version $1 (x.y.z, perhaps with a -pre or +build suffix) is older than $2 (x.y.z); 2 when
# $1 can't be read.
older() {
  o_a=${1%%[-+]*}.
  o_b=$2.
  while [ -n "$o_b" ]; do
    o_x=${o_a%%.*}
    o_y=${o_b%%.*}
    case $o_x in '' | *[!0-9]*) return 2 ;; esac
    if [ "$o_x" -ne "$o_y" ]; then
      [ "$o_x" -lt "$o_y" ]
      return
    fi
    o_a=${o_a#*.}
    o_b=${o_b#*.}
  done
  return 1
}

# Whether an office is set up at OFFICE: any of the state `opencorp offboard` removes is there.
office_set_up() {
  for f in office identity.json tui .company-clone; do
    if [ -e "$OFFICE/$f" ] || [ -L "$OFFICE/$f" ]; then return 0; fi
  done
  return 1
}

# Bun's own installer, pinned to version $1.
install_bun() {
  curl -fsSL https://bun.sh/install | bash -s "bun-v$1"
  [ -x "$BUN_HOME/bin/bun" ]
}

# The marked lines that put BIN_DIR on PATH: SH_LINE for sh-like shells, FISH_LINE for fish. uninstall.sh
# takes out exactly these lines.
path_lines() {
  SUFFIX="  # added by opencorp install.sh"
  # shellcheck disable=SC2016
  SH_LINE="case \":\$PATH:\" in *:$(quote "$BIN_DIR"):*) ;; *) export PATH=$(quote "$BIN_DIR"):\"\$PATH\" ;; esac$SUFFIX"
  FISH_LINE="fish_add_path --path $(quote "$BIN_DIR")$SUFFIX"
}

# Adds the marked line $2 to the rc file $1, unless the file already puts BIN_DIR on PATH; a file it can't write
# gets a warning with the line to add.
add_path_line() {
  if [ -f "$1" ] && { LC_ALL=C grep -a -q -F -x -e "$2" "$1" || LC_ALL=C grep -a -q -E "$OWN_PATH_RE" "$1"; }; then
    RELOAD=${RELOAD:-"$SOURCE $1"}
    return 0
  fi
  ap_dir=$(dirname "$1")
  if ! mkdir -p "$ap_dir" 2>/dev/null || { [ -e "$1" ] && [ ! -w "$1" ]; } || { [ ! -e "$1" ] && [ ! -w "$ap_dir" ]; }; then
    warn "Can't write $1, so add this line to it yourself: $2"
    return 0
  fi
  # A last line without its newline would run into ours.
  if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then
    printf '\n' >>"$1" || { warn "Couldn't write $1, so add this line to it yourself: $2"; return 0; }
  fi
  printf '%s\n' "$2" >>"$1" || { warn "Couldn't write $1, so add this line to it yourself: $2"; return 0; }
  ok "Added $BIN_DIR to PATH in $1"
  RELOAD=${RELOAD:-"$SOURCE $1"}
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
  MARK="opencorp install.sh"
  # The wrapper's second line, which marks it as install.sh's.
  WRAPPER_MARK="# Written by $MARK; uninstall.sh removes it."
  DIR=${OPENCORP_INSTALL_DIR:-}
  DIR_SET=0
  BRANCH=main
  BRANCH_SET=0
  REPO=${OPENCORP_REPO_URL:-https://github.com/ngocbh/opencorp.git}
  REPO_SET=0
  [ -z "${OPENCORP_REPO_URL:-}" ] || REPO_SET=1
  SKIP_SETUP=0
  SWITCH=0
  MODIFY_PATH=1
  while [ $# -gt 0 ]; do
    case $1 in
      --dir | --branch | --repo)
        [ $# -ge 2 ] || die "$1 needs a value (see --help)."
        case $1 in
          --dir) DIR=$2 DIR_SET=1 ;;
          --branch) BRANCH=$2 BRANCH_SET=1 ;;
          --repo) REPO=$2 REPO_SET=1 ;;
        esac
        shift 2
        ;;
      --skip-setup) SKIP_SETUP=1 && shift ;;
      --switch) SWITCH=1 && shift ;;
      --no-modify-path) MODIFY_PATH=0 && shift ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option $1 (see --help)." ;;
    esac
  done
  [ -z "$DIR" ] || need_path "The install folder (--dir or OPENCORP_INSTALL_DIR)" "$DIR"
  BIN_DIR=${OPENCORP_BIN_DIR:-$HOME/.local/bin}
  need_path OPENCORP_BIN_DIR "$BIN_DIR"
  TARGET=$BIN_DIR/opencorp
  OFFICE=${OPENCORP_HOME:-$HOME/.opencorp}

  case $(uname -s) in
    Darwin | Linux) ;;
    *) die "OpenCorp runs on macOS and Linux, not $(uname -s)." ;;
  esac
  git --version >/dev/null 2>&1 || die "git is missing. Install it (on macOS: xcode-select --install), then run this again."
  command -v curl >/dev/null 2>&1 || die "curl is missing. Install it, then run this again."
  if [ "$(uname -s)" = Linux ] && ! command -v bwrap >/dev/null 2>&1; then
    warn "bubblewrap (bwrap) is missing, and the office needs it to sandbox commands. Install it with your package manager (apt install bubblewrap, dnf install bubblewrap, or pacman -S bubblewrap), then run opencorp doctor."
  fi

  # Refuse early, before installing anything, if the target is someone else's file. install.sh replaces only its
  # own wrapper, a link to a checkout's wrapper, and a link to nothing.
  OLD=
  if [ -e "$TARGET" ]; then
    OLD=$(launcher_checkout "$TARGET") || OLD=
    if [ -z "$OLD" ] && ! is_wrapper "$TARGET"; then
      die "$TARGET exists and was not written by install.sh. Move it away, or set OPENCORP_BIN_DIR."
    fi
  fi

  # The checkout: the one this script is in, unless --dir says otherwise; else a clone.
  ROOT=
  # Piped, $0 is the shell's name, so a file of that name in the current folder proves nothing.
  case $0 in
    */install.sh) HERE=$(dirname "$0") ;;
    install.sh) HERE=. ;;
    *) HERE= ;;
  esac
  if [ -n "$HERE" ] && [ "$DIR_SET" = 0 ] && [ -f "$HERE/install.sh" ] && is_checkout "$HERE"; then
    ROOT=$(cd "$HERE" && pwd -P)
  fi
  if [ -n "$ROOT" ]; then
    need_path "The checkout's path" "$ROOT"
  else
    DIR=${DIR:-$HOME/.local/share/opencorp}
  fi

  # The office's service runs the checkout the office was set up from, most likely the one opencorp runs now, and
  # `opencorp restart` reuses that service: pointing opencorp at another checkout would leave the office on the old
  # code. The way over is opencorp doctor's for a moved checkout: stop the office, then onboard from the new install.
  SWITCHING=0
  if [ -n "$OLD" ] && office_set_up && ! same_dir "$OLD" "${ROOT:-$DIR}"; then
    if [ "$SWITCH" = 0 ]; then
      die "An office is set up at $OFFICE, and $TARGET runs the checkout at $OLD, whose code the office's service likely runs. To update that checkout, run its own install.sh. To move the office to ${ROOT:-$DIR}, run this again with --switch: it stops the office (opencorp stop) before it points opencorp at the new checkout, and you then run opencorp onboard from the install you use, which sets the office's service up again. opencorp offboard is the destructive last resort: it deletes the office's store, connections, sign-ins and this device."
    fi
    SWITCHING=1
  fi

  if [ -n "$ROOT" ]; then
    ok "Installing the checkout at $ROOT"
  else
    if [ -e "$DIR" ] && [ ! -d "$DIR" ]; then
      die "$DIR is a file, not a folder. Move it away, or pick another folder with --dir."
    elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR")" ]; then
      if ! is_checkout "$DIR" || [ ! -e "$DIR/.git" ]; then
        die "$DIR holds something other than an OpenCorp clone. Move it away, or pick another folder with --dir."
      fi
      [ -z "$(git -C "$DIR" status --porcelain)" ] ||
        die "$DIR has uncommitted changes. Commit or stash them, then run this again."
      CURRENT=$(git -C "$DIR" symbolic-ref -q --short HEAD) ||
        die "$DIR isn't on a branch (its HEAD is detached). Check out a branch, then run this again."
      git -C "$DIR" rev-parse -q --verify '@{upstream}' >/dev/null 2>&1 ||
        die "$DIR is on $CURRENT, which has no upstream branch to pull from. Set one (git -C $(quote "$DIR") branch --set-upstream-to origin/main), or check out one that has, then run this again."
      if [ "$BRANCH_SET" = 1 ] && [ "$CURRENT" != "$BRANCH" ]; then
        warn "$DIR is on $CURRENT; --branch only picks the branch of a new clone."
      fi
      if [ "$REPO_SET" = 1 ]; then
        warn "$DIR pulls from its own remote; --repo only picks where a new clone comes from."
      fi
      if office_set_up; then
        warn "The office at $OFFICE keeps running the code it started with until you restart it."
      fi
      step "Updating $DIR ($CURRENT)"
      git -C "$DIR" pull --ff-only --quiet ||
        die "git pull --ff-only failed in $DIR: $CURRENT and its upstream have each moved on. Sort that out, then run this again."
      git -C "$DIR" submodule --quiet update --init --recursive || die "git submodule update failed in $DIR."
      ok "Updated $DIR to $(git -C "$DIR" rev-parse --short HEAD)"
    else
      # The mark says the clone is install.sh's, so uninstall.sh may remove it: the folder too when install.sh
      # made it, or only what's in it when the folder was there before.
      if [ -d "$DIR" ]; then MADE=existing; else MADE=new; fi
      step "Cloning $REPO ($BRANCH) into $DIR"
      if ! git clone --quiet --recurse-submodules --branch "$BRANCH" -- "$REPO" "$DIR"; then
        # A clone whose submodule failed is install.sh's all the same: a re-run finishes it.
        if [ -d "$DIR/.git" ]; then printf '# Cloned by %s.\nfolder=%s\n' "$MARK" "$MADE" >"$DIR/.git/opencorp-installer"; fi
        die "git clone failed. Check --repo and --branch and your network, then run this again."
      fi
      printf '# Cloned by %s.\nfolder=%s\n' "$MARK" "$MADE" >"$DIR/.git/opencorp-installer"
      ok "Cloned OpenCorp into $DIR"
    fi
    ROOT=$(cd "$DIR" && pwd -P)
    need_path "The clone's path" "$ROOT"
  fi

  BUN_FLOOR=$(sed -n 's/.*"packageManager": *"bun@\([0-9.]*\)".*/\1/p' "$ROOT/package.json")
  [ -n "$BUN_FLOOR" ] || die "$ROOT/package.json names no Bun version in packageManager."

  # Find Bun: OPENCORP_BUN, then bun on PATH, then Bun's own install folder.
  BUN_HOME=${BUN_INSTALL:-$HOME/.bun}
  if [ -n "${OPENCORP_BUN:-}" ]; then
    BUN=$OPENCORP_BUN
    [ -x "$BUN" ] || die "OPENCORP_BUN=$BUN is not an executable file."
  elif BUN=$(find_bun); then
    :
  elif [ -x "$BUN_HOME/bin/bun" ]; then
    BUN=$BUN_HOME/bin/bun
  else
    step "Installing Bun $BUN_FLOOR into $BUN_HOME with https://bun.sh/install"
    quietly install_bun "$BUN_FLOOR" ||
      die "Bun's installer failed. Install Bun $BUN_FLOOR from https://bun.sh, then run this again."
    BUN=$BUN_HOME/bin/bun
    if [ "$MODIFY_PATH" = 0 ]; then
      warn "--no-modify-path doesn't reach Bun's installer, which adds $BUN_HOME/bin to PATH in your shell's rc files itself. uninstall.sh leaves those lines, with Bun."
    else
      ok "Installed Bun $BUN_FLOOR. Bun's installer adds $BUN_HOME/bin to PATH in your shell's rc files itself; uninstall.sh leaves those lines, with Bun."
    fi
  fi
  BUN_VERSION=$("$BUN" --version) || die "$BUN --version failed."
  older "$BUN_VERSION" "$BUN_FLOOR" && too_old=0 || too_old=$?
  case $too_old in
    0) die "OpenCorp needs Bun $BUN_FLOOR or later; $BUN is $BUN_VERSION. Run 'bun upgrade', then run this again." ;;
    2) die "could not read a version from $BUN --version: $BUN_VERSION" ;;
  esac
  BUN=$(cd "$(dirname "$BUN")" && pwd -P)/$(basename "$BUN")
  need_path "Bun's path" "$BUN"
  ok "Bun $BUN_VERSION at $BUN"
  # The PATH install.sh was given, which the checks below of whether the user's shell has BIN_DIR on PATH look at.
  USER_PATH=$PATH
  # What runs from here (the build's scripts, opencorp init) calls `bun` by name, and Bun's installer puts its folder
  # on PATH only for new shells. So the chosen Bun's folder goes first, and a `bun` by name is that Bun, never one in
  # a project folder further on.
  PATH=$(dirname "$BUN"):$PATH
  export PATH

  step "Installing dependencies (bun install)"
  (cd "$ROOT" && quietly "$BUN" install --frozen-lockfile) || die "bun install failed in $ROOT. Run it there to see why."
  step "Building HQ's web app (bun run build)"
  (cd "$ROOT" && quietly "$BUN" run build) || die "bun run build failed in $ROOT. Run it there to see why."
  ok "Installed dependencies and built HQ's web app"

  if [ "$SWITCHING" = 1 ]; then
    step "Stopping the office with the opencorp that runs $OLD"
    "$TARGET" stop </dev/null ||
      die "opencorp stop failed, so $TARGET still runs $OLD. Stop the office yourself (opencorp stop), then run this again with --switch."
  fi
  WAS_LINK=
  if [ -L "$TARGET" ]; then WAS_LINK=$(readlink "$TARGET"); fi
  mkdir -p "$BIN_DIR"
  TMP=$TARGET.tmp.$$
  cat >"$TMP" <<EOF
#!/bin/sh
$WRAPPER_MARK
# Runs $ROOT/packages/cli/bin/opencorp
# with the Bun install.sh found; a Bun set in OPENCORP_BUN wins.
if [ -z "\${OPENCORP_BUN:-}" ]; then OPENCORP_BUN=$(quote "$BUN"); export OPENCORP_BUN; fi
exec $(quote "$ROOT/packages/cli/bin/opencorp") "\$@"
EOF
  chmod 755 "$TMP"
  mv -f "$TMP" "$TARGET"
  if [ -n "$WAS_LINK" ]; then
    ok "Replaced $TARGET, a link to $WAS_LINK, with a wrapper for $ROOT"
  else
    ok "Wrote $TARGET"
  fi

  # Put BIN_DIR on PATH for new login shells, unless it already is.
  RELOAD=
  case ":$USER_PATH:" in
    *":$BIN_DIR:"* | *":$BIN_DIR/:"*) ;;
    *)
      if [ "$MODIFY_PATH" = 1 ]; then
        path_lines
        # A file whose own line puts BIN_DIR on PATH: a PATH= at the start of a line (as Ubuntu's .profile has),
        # fish_add_path, or fish's set, naming the folder (relative to the home, or in full).
        case $BIN_DIR in "$HOME"/*) own=${BIN_DIR#"$HOME"/} ;; *) own=$BIN_DIR ;; esac
        own=$(printf '%s' "$own" | sed 's/[.[\*^$+?(){}|]/\\&/g')
        OWN_PATH_RE="^[[:space:]]*((export[[:space:]]+)?PATH=|fish_add_path[[:space:]]|set[[:space:]]+(-[[:alnum:]]+[[:space:]]+)*(PATH|fish_user_paths)[[:space:]]).*$own/?([:\"'[:space:]]|\$)"
        case $(basename "${SHELL:-sh}") in
          zsh)
            SOURCE=.
            add_path_line "${ZDOTDIR:-$HOME}/.zshrc" "$SH_LINE"
            add_path_line "${ZDOTDIR:-$HOME}/.zprofile" "$SH_LINE"
            ;;
          bash)
            SOURCE=.
            add_path_line "$HOME/.bashrc" "$SH_LINE"
            add_path_line "$HOME/.profile" "$SH_LINE"
            # A login bash reads only the first of .bash_profile, .bash_login and .profile.
            for rc in "$HOME/.bash_profile" "$HOME/.bash_login"; do
              if [ -f "$rc" ]; then add_path_line "$rc" "$SH_LINE"; fi
            done
            ;;
          fish)
            SOURCE=source
            add_path_line "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" "$FISH_LINE"
            ;;
          *)
            SOURCE=.
            add_path_line "$HOME/.profile" "$SH_LINE"
            ;;
        esac
      fi
      ;;
  esac

  "$TARGET" --help >/dev/null 2>&1 || die "$TARGET was written, but opencorp --help fails. Run it to see why."
  VERSION=$("$TARGET" --version) || die "$TARGET was written, but opencorp --version fails. Run it to see why."
  ok "Installed OpenCorp $VERSION from $ROOT"

  if [ "$SWITCHING" = 1 ]; then
    step "Next: run opencorp onboard, which sets the office's service up to run $ROOT."
  elif office_set_up; then
    if [ -n "$OLD" ] && same_dir "$OLD" "$ROOT"; then
      ok "An office is set up at $OFFICE: run opencorp restart to use this version."
    else
      ok "An office is set up at $OFFICE. If its service runs $ROOT, opencorp restart picks up this version; if it runs another checkout, see opencorp doctor."
    fi
  elif [ "$SKIP_SETUP" = 0 ] && has_tty; then
    offer_setup
  else
    step "Next: in a project folder, run opencorp init."
  fi

  case ":$USER_PATH:" in
    *":$BIN_DIR:"* | *":$BIN_DIR/:"*) ;;
    *)
      if [ -n "$RELOAD" ]; then
        step "To use opencorp in this shell, run: $RELOAD (or open a new terminal)"
      else
        warn "$BIN_DIR isn't on your PATH. Add it there, or run $TARGET."
      fi
      ;;
  esac
}

# In braces, so a download cut off inside this line is a syntax error rather than a run without the flags.
{ main "$@"; }
