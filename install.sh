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
Usage: install.sh [--dir DIR] [--branch REF] [--repo URL] [--skip-setup] [--no-modify-path]

  --dir DIR         where the clone goes (OPENCORP_INSTALL_DIR, default ~/.local/share/opencorp)
  --branch REF      the branch or tag a new clone checks out (default main)
  --repo URL        the repo to clone (OPENCORP_REPO_URL, default https://github.com/ngocbh/opencorp.git)
  --skip-setup      don't offer to create the company; print the next step instead
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

# Whether a terminal is there to ask on: stdin is the script under `curl | bash`.
has_tty() { (: </dev/tty) 2>/dev/null; }

# Asks $1 on the terminal; the answer goes in ANSWER, or $2 for an empty line.
ask() {
  printf '%s ' "$1" >/dev/tty
  ANSWER=
  IFS= read -r ANSWER </dev/tty || ANSWER=
  [ -n "$ANSWER" ] || ANSWER=$2
}

# Whether $1 is an OpenCorp checkout.
is_checkout() {
  [ -f "$1/packages/cli/bin/opencorp" ] && grep -q '"name": *"opencorp-workspace"' "$1/package.json" 2>/dev/null
}

# Whether $1 is a link to an OpenCorp checkout's packages/cli/bin/opencorp (the README's manual step).
links_to_checkout() {
  [ -L "$1" ] || return 1
  l_to=$(readlink "$1")
  case $l_to in /*) ;; *) l_to=$(dirname "$1")/$l_to ;; esac
  case $l_to in */packages/cli/bin/opencorp) is_checkout "${l_to%/packages/cli/bin/opencorp}" ;; *) return 1 ;; esac
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

# Adds the marked line $2 to the rc file $1, unless the file already puts BIN_DIR on PATH.
add_path_line() {
  if [ -f "$1" ] && { grep -qF "$MARK" "$1" || grep -Eq "$OWN_PATH_RE" "$1"; }; then return 0; fi
  mkdir -p "$(dirname "$1")"
  # A last line without its newline would run into ours.
  if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then printf '\n' >>"$1"; fi
  printf '%s  # added by %s\n' "$2" "$MARK" >>"$1"
  ok "Added $BIN_DIR to PATH in $1"
}

# All of it runs from the last line, so a download cut off part-way runs nothing.
main() {
  init_output
  MARK="opencorp install.sh"
  DIR=${OPENCORP_INSTALL_DIR:-}
  DIR_SET=0
  BRANCH=main
  BRANCH_SET=0
  REPO=${OPENCORP_REPO_URL:-https://github.com/ngocbh/opencorp.git}
  SKIP_SETUP=0
  MODIFY_PATH=1
  while [ $# -gt 0 ]; do
    case $1 in
      --dir | --branch | --repo)
        [ $# -ge 2 ] || die "$1 needs a value (see --help)."
        case $1 in
          --dir) DIR=$2 DIR_SET=1 ;;
          --branch) BRANCH=$2 BRANCH_SET=1 ;;
          --repo) REPO=$2 ;;
        esac
        shift 2
        ;;
      --skip-setup) SKIP_SETUP=1 && shift ;;
      --no-modify-path) MODIFY_PATH=0 && shift ;;
      -h | --help) usage && return 0 ;;
      *) die "unknown option $1 (see --help)." ;;
    esac
  done
  BIN_DIR=${OPENCORP_BIN_DIR:-$HOME/.local/bin}
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

  # Refuse early, before installing anything, if the target is someone else's file.
  if [ -e "$TARGET" ] && ! grep -q "$MARK" "$TARGET" 2>/dev/null && ! links_to_checkout "$TARGET"; then
    die "$TARGET exists and was not written by install.sh. Move it away, or set OPENCORP_BIN_DIR."
  fi

  # The checkout: the one this script is in, unless --dir says otherwise; else a clone.
  ROOT=
  case $0 in
    *install.sh) if [ "$DIR_SET" = 0 ] && [ -f "$0" ] && is_checkout "$(dirname "$0")"; then ROOT=$(CDPATH='' cd "$(dirname "$0")" && pwd -P); fi ;;
  esac
  if [ -n "$ROOT" ]; then
    ok "Installing the checkout at $ROOT"
  else
    DIR=${DIR:-$HOME/.local/share/opencorp}
    case $DIR in /*) ;; *) DIR=$PWD/$DIR ;; esac
    if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR")" ]; then
      if ! is_checkout "$DIR" || [ ! -e "$DIR/.git" ]; then
        die "$DIR holds something other than an OpenCorp clone. Move it away, or pick another folder with --dir."
      fi
      [ -z "$(git -C "$DIR" status --porcelain)" ] ||
        die "$DIR has uncommitted changes. Commit or stash them, then run this again."
      CURRENT=$(git -C "$DIR" symbolic-ref -q --short HEAD) ||
        die "$DIR isn't on a branch (its HEAD is detached). Check out a branch, then run this again."
      if [ "$BRANCH_SET" = 1 ] && [ "$CURRENT" != "$BRANCH" ]; then
        warn "$DIR is on $CURRENT; --branch only picks the branch of a new clone."
      fi
      step "Updating $DIR ($CURRENT)"
      git -C "$DIR" pull --ff-only --quiet ||
        die "git pull --ff-only failed in $DIR. If its branch has commits the remote doesn't, sort them out, then run this again."
      git -C "$DIR" submodule --quiet update --init --recursive || die "git submodule update failed in $DIR."
      ok "Updated $DIR to $(git -C "$DIR" rev-parse --short HEAD)"
    else
      step "Cloning $REPO ($BRANCH) into $DIR"
      if ! git clone --quiet --recurse-submodules --branch "$BRANCH" -- "$REPO" "$DIR"; then
        # A clone whose submodule failed is install.sh's all the same: a re-run finishes it.
        if [ -d "$DIR/.git" ]; then printf 'Cloned by %s.\n' "$MARK" >"$DIR/.git/opencorp-installer"; fi
        die "git clone failed. Check --repo and --branch and your network, then run this again."
      fi
      # Marks the clone as install.sh's, so uninstall.sh may remove it.
      printf 'Cloned by %s.\n' "$MARK" >"$DIR/.git/opencorp-installer"
      ok "Cloned OpenCorp into $DIR"
    fi
    ROOT=$(CDPATH='' cd "$DIR" && pwd -P)
  fi

  BUN_FLOOR=$(sed -n 's/.*"packageManager": *"bun@\([0-9.]*\)".*/\1/p' "$ROOT/package.json")
  [ -n "$BUN_FLOOR" ] || die "$ROOT/package.json names no Bun version in packageManager."

  # Find Bun: OPENCORP_BUN, then bun on PATH, then Bun's own install folder.
  BUN_HOME=${BUN_INSTALL:-$HOME/.bun}
  if [ -n "${OPENCORP_BUN:-}" ]; then
    BUN=$OPENCORP_BUN
    [ -x "$BUN" ] || die "OPENCORP_BUN=$BUN is not an executable file."
  elif command -v bun >/dev/null 2>&1; then
    BUN=$(command -v bun)
  elif [ -x "$BUN_HOME/bin/bun" ]; then
    BUN=$BUN_HOME/bin/bun
  else
    step "Installing Bun $BUN_FLOOR into $BUN_HOME with https://bun.sh/install"
    quietly install_bun "$BUN_FLOOR" ||
      die "Bun's installer failed. Install Bun $BUN_FLOOR from https://bun.sh, then run this again."
    BUN=$BUN_HOME/bin/bun
  fi
  BUN_VERSION=$("$BUN" --version) || die "$BUN --version failed."
  older "$BUN_VERSION" "$BUN_FLOOR" && too_old=0 || too_old=$?
  case $too_old in
    0) die "OpenCorp needs Bun $BUN_FLOOR or later; $BUN is $BUN_VERSION. Run 'bun upgrade', then run this again." ;;
    2) die "could not read a version from $BUN --version: $BUN_VERSION" ;;
  esac
  BUN=$(CDPATH='' cd "$(dirname "$BUN")" && pwd -P)/$(basename "$BUN")
  ok "Bun $BUN_VERSION at $BUN"

  step "Installing dependencies (bun install)"
  (cd "$ROOT" && quietly "$BUN" install --frozen-lockfile) || die "bun install failed in $ROOT. Run it there to see why."
  step "Building HQ's web app (bun run build)"
  (cd "$ROOT" && quietly "$BUN" run build) || die "bun run build failed in $ROOT. Run it there to see why."
  ok "Installed dependencies and built HQ's web app"

  WAS_LINK=
  if [ -L "$TARGET" ]; then WAS_LINK=$(readlink "$TARGET"); fi
  mkdir -p "$BIN_DIR"
  TMP=$TARGET.tmp.$$
  cat >"$TMP" <<EOF
#!/bin/sh
# Written by $MARK: runs the OpenCorp checkout at $ROOT with Bun.
# A Bun set in OPENCORP_BUN wins over the one install.sh found.
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
  case ":$PATH:" in
    *":$BIN_DIR:"* | *":$BIN_DIR/:"*) ;;
    *)
      if [ "$MODIFY_PATH" = 1 ]; then
        case $BIN_DIR in "$HOME"/*) own=${BIN_DIR#"$HOME"/} ;; *) own=$BIN_DIR ;; esac
        OWN_PATH_RE="^[[:space:]]*([^#[:space:]].*)?(PATH|fish_add_path).*$(printf '%s' "$own" | sed 's/[.[\*^$+?(){}|]/\\&/g')"
        # shellcheck disable=SC2016
        line="case \":\$PATH:\" in *:$(quote "$BIN_DIR"):*) ;; *) export PATH=$(quote "$BIN_DIR"):\"\$PATH\" ;; esac"
        case $(basename "${SHELL:-sh}") in
          zsh)
            RELOAD=". ${ZDOTDIR:-$HOME}/.zshrc"
            add_path_line "${ZDOTDIR:-$HOME}/.zshrc" "$line"
            add_path_line "${ZDOTDIR:-$HOME}/.zprofile" "$line"
            ;;
          bash)
            RELOAD=". $HOME/.bashrc"
            add_path_line "$HOME/.bashrc" "$line"
            add_path_line "$HOME/.profile" "$line"
            # A login bash reads only the first of .bash_profile, .bash_login and .profile.
            for rc in "$HOME/.bash_profile" "$HOME/.bash_login"; do
              if [ -f "$rc" ]; then add_path_line "$rc" "$line"; fi
            done
            ;;
          fish)
            RELOAD="source ${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
            add_path_line "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" "fish_add_path -g $(quote "$BIN_DIR")"
            ;;
          *)
            RELOAD=". $HOME/.profile"
            add_path_line "$HOME/.profile" "$line"
            ;;
        esac
      fi
      ;;
  esac

  VERSION=$("$TARGET" --version) || die "$TARGET was written but doesn't run."
  ok "Installed OpenCorp $VERSION from $ROOT"

  if office_set_up; then
    ok "An office is set up at $OFFICE: run opencorp restart to use this version."
  elif [ "$SKIP_SETUP" = 0 ] && has_tty; then
    ask "→ Create your company now? [Y/n]" y
    case $ANSWER in
      [Nn]*) step "Next: in a project folder, run opencorp init." ;;
      *)
        ask "→ Project folder for it [$HOME/projects/opencorp]:" "$HOME/projects/opencorp"
        case $ANSWER in "~") ANSWER=$HOME ;; "~/"*) ANSWER=$HOME/${ANSWER#"~/"} ;; esac
        mkdir -p "$ANSWER" || die "can't make $ANSWER. Make a project folder yourself, then run opencorp init in it."
        step "Running opencorp init in $ANSWER"
        if ! (cd "$ANSWER" && PATH="$BIN_DIR:$PATH" "$TARGET" init </dev/tty >/dev/tty 2>&1); then
          warn "opencorp init didn't finish. Run it again: cd $(quote "$ANSWER") && opencorp init"
        fi
        ;;
    esac
  else
    step "Next: in a project folder, run opencorp init."
  fi

  case ":$PATH:" in
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

main "$@"
