/**
 * Reading a sh command line for a permission check: its simple commands, what makes it unreadable, what is
 * read-only, what is a file operation inside the workspace, what runs code, what is risky, what a `git push` does
 * and which credential paths it names. It needs nothing from the office.
 *
 * The reader can promise that a command line runs without Auto's check or a card only when every part of it is
 * covered: by an allow rule; by a form it knows to be read-only (`auto`, `default`, `dontAsk`); by a plain push of a
 * feature branch (`auto`, `dontAsk`); or, inside the workspace sandbox, by a file operation on paths inside the
 * workspace (`auto`, `dontAsk`). A deny rule refuses what it matches wherever the reader sees it: inside
 * substitutions, `sh -c` strings, `sudo`, `find -exec` and ssh's remote command too.
 * The reader asks, in every mode, before a command that names a credential path anywhere in the line (an operand,
 * an option's value, an assignment, a `for` list, a here-string or a redirect), one the host marks
 * (`Where.credentials`), or a folder that holds them. On the SSH-only profile and over ssh, where credentials are
 * reachable, it also asks before a program that reads file contents is given a path through an expansion, whose
 * value it can't see; in the workspace sandbox, which keeps the home out, such a read follows the usual rules and
 * the sandbox is the guard. Auto's check never judges a push, `sudo`, a local command for ssh (the wrapper's
 * `OPENCORP_SSH_CONFIG` among them), an ssh the shell's PATH doesn't find (by path, `command -p`, or a PATH the part
 * sets or clears), which skips a wrapper there, or a command that controls a shared ssh connection (`-O` but `check`,
 * `-S`, `ControlPath`, `ControlMaster`, and port forwards): the owner's own connections can be reached from the
 * SSH-only profile, `-O exit` would end one, and a forward added to one outlives the call. ssh behind `command`,
 * `builtin`, `exec`, `env` and the other wrappers is ssh to every check. On the SSH-only profile, where an ssh wrapper
 * comes first on PATH, neither does Auto's check judge a line that changes PATH or runs `hash -p` (`pathChange`).
 *
 * It can't know what a program does with its files, its config or its input: `git` runs hooks and programs its
 * config names (`core.fsmonitor`, `core.pager`, `diff.external`); a script does what it contains; a remote host has
 * its own rc files and `PATH`; `~/.ssh/config` can name a `ProxyCommand` for a host. In a persistent shell, earlier
 * lines can define functions, aliases or a `PATH` that change what a read-only line runs. No rule sees into a
 * variable's value or a script file, readable line or not, and the credential check doesn't see a path reached
 * through `cd` or a link, given through a variable to a program that isn't a content reader, or, in the workspace
 * sandbox, given through a variable at all.
 *
 * It can't stop a read-only program from reading what the sandbox lets it read. The model then sees it.
 *
 * The shell is bash: brace expansion is on, and `$'…'` is decoded as bash decodes it.
 */

/** One simple command: its words with quotes removed and leading `NAME=value` assignments kept apart, whether the
 *  shell may change each word, the files its `>` and `>>` redirects write, the files its `<` redirects read, and
 *  whether its standard input is fed by a pipe, a redirect, a here-document or a here-string. */
export interface SimpleCommand {
  readonly assignments: readonly string[]
  readonly words: readonly string[]
  /** For each word, whether the shell may turn it into something else: a glob or brace character, or `$`,
   *  outside single quotes. */
  readonly expands: readonly boolean[]
  /** For each word, whether a parameter, command or arithmetic expansion outside single quotes gives part of it,
   *  so the reader can't know its value. */
  readonly substituted: readonly boolean[]
  readonly writes: readonly string[]
  readonly reads: readonly string[]
  /** The words its here-strings and here-documents feed it: data, not commands, and whether the shell expands
   *  each (a here-document whose delimiter is quoted expands nothing). */
  readonly data: readonly { readonly text: string; readonly substituted: boolean }[]
  readonly fed: boolean
}
/** A command line read: its simple commands in order, those inside substitutions, groups, compound commands,
 *  `sh -c` strings and `eval` included (before the command that holds them), and why the line can't be read
 *  safely, or null. */
export interface ReadCommand {
  readonly parts: readonly SimpleCommand[]
  readonly unreadable: string | null
}
/** What a part is, for a permission check. `readOnly`: a form the reader knows reads only. `runsCode`: an
 *  interpreter, a build tool or a script. `risk`: why `default` asks, keeping its rules exact. */
export interface Kind {
  readonly readOnly: boolean
  readonly runsCode: boolean
  readonly risk: string | null
}
/** Where a command runs, as the host binds it: the shell's sandbox profile, its folder, and the folders the
 *  workspace profile may write (none on the SSH-only profile). The model sets none of it. `cwd` is null when the host
 *  can't know the folder, as when a persistent shell's last command didn't report it. */
export interface Where {
  readonly profile: "workspace" | "ssh"
  readonly cwd: string | null
  readonly writable: readonly string[]
  /** Paths the host marks as credentials beside `CREDENTIALS`, absolute or from `~`, globs allowed: the identity
   *  files a profile binds outside `~/.ssh`. A read of one asks as a read under `~/.ssh` does. */
  readonly credentials?: readonly string[]
}

/** Paths whose contents are credentials, as globs over a path's folders: `**` is any folders, none included, and
 *  `*` stays inside one name; `except` names files a literal path may name without counting, and `at` is where the
 *  file or folder usually lives, for a read of a folder above it. `$NAME` is a variable that names one. A command
 *  that names one, even a read-only one, asks the owner in every mode and dontAsk refuses it: nothing scrubs what
 *  the model sees, and the SSH-only profile lets ssh read `~/.ssh`.
 *  - A literal name ending `.pub` never counts.
 *  - In a path, `$…` reads as `*`, and the exemptions hold only when nothing in the path is expanded.
 *  - A glob or expansion counts when a literal part names a credential folder or file (`~/.ssh/*`,
 *    `~/.s${X}sh/id_rsa`), or when it starts at `/` or a home and could reach an `at` (`cat ~/*`); a bare `*`
 *    elsewhere doesn't (`cat src/*`).
 *  - A recursive read (`grep -r`, `diff -r`, `git diff --no-index`, `tar`, `zip`, `rsync`, `cp -r`, `find -exec`)
 *    counts when a path it reads is an `at`, holds one (`~`, `/`, `/home`), or is under one.
 *  - The folders count too, except to `ls`, `stat`, `du` and the like, which read only names. */
export const CREDENTIALS: readonly {
  readonly path: string
  readonly except?: readonly string[]
  readonly at?: string
}[] = [
  { path: "**/.ssh/**", except: ["known_hosts*", "config", "authorized_keys"], at: "~/.ssh" },
  { path: "/etc/ssh/*_key", at: "/etc/ssh" },
  { path: "**/id_rsa" },
  { path: "**/id_dsa" },
  { path: "**/id_ecdsa*" },
  { path: "**/id_ed25519*" },
  { path: "**/*.pem" },
  { path: "**/*.key" },
  { path: "**/*.p12" },
  { path: "**/.netrc", at: "~/.netrc" },
  { path: "**/.pgpass", at: "~/.pgpass" },
  { path: "**/.npmrc", at: "~/.npmrc" },
  { path: "**/.git-credentials", at: "~/.git-credentials" },
  { path: "**/.aws/**", at: "~/.aws" },
  { path: "**/.config/gcloud/**", at: "~/.config/gcloud" },
  { path: "**/.config/gh/**", at: "~/.config/gh" },
  { path: "**/.docker/**", at: "~/.docker" },
  { path: "**/.kube/**", at: "~/.kube" },
  { path: "**/krb5cc*", at: "/tmp/krb5cc*" },
  { path: "$KRB5CCNAME" },
  { path: "**/.opencorp", at: "~/.opencorp" },
  { path: "**/.opencorp/**/auth.json" },
  { path: "**/.opencorp/**/provider.json" },
  { path: "**/.opencorp/**/connections/**" },
  { path: "$OPENCORP_HOME" },
]
/** The folders that hold every home: a read of one reads them all. */
const HOMES = ["/home/*", "/Users/*", "/root"]

const set = (names: string) => new Set(names.split(" "))

// ---- Reasons and tables ----

const COMMAND_SUB = "it has a command substitution"
const PROCESS_SUB = "it has a process substitution"
const ARITHMETIC = "it has an arithmetic expansion"
const PARAMETER = "it has a parameter expansion it can't read"
const SUBSHELL = "it has a subshell or group"
const HERE_DOC = "it has a here-document"
const HERE_STRING = "it has a here-string"
const UNCLOSED = "it has an unclosed quote"
const UNDECODED = "it has a $'…' string it can't decode"
const CONTROL = "it has a control character"
const EXPANDED = "the program's name is expanded"
const DEEP = "it is nested too deeply"
const RUNS_TEXT = "it runs text as a command"
const CHANGES = "it changes how later commands run"
const KEYWORD = "it uses a shell keyword"

const DELETES = "it deletes or moves files"
const WRITES = "it writes or overwrites files"
const KILLS = "it kills or cancels processes or jobs"
const SUBMITS = "it submits jobs"
const OTHER_USER = "it runs as another user"
const EDITS = "it edits files"
const PERMISSIONS = "it changes who may use files"
const PUSHES = "it pushes to another repository"
const COPIES = "it copies files to or from another machine"
const LOCAL_SSH = "it runs a local command for ssh"
const SSH_OFF_PATH = "it runs ssh without the shell's PATH lookup, so around any ssh wrapper on it"
const SETS_PATH = "it changes the shell's PATH, which OpenCorp's ssh wrapper comes first on"
const NAMES_REAL_SSH = "it names the real ssh that OpenCorp's ssh wrapper stands in for"
const CONTROLS_SSH = "it controls a shared ssh connection"
const NETWORK = "it connects to another machine"
const FEEDS_SHELL = "it feeds a remote shell from its input"

const DEFAULT_BRANCH = "it pushes to the default branch"
const FORCE = "it force-pushes"
const DELETE_BRANCH = "it deletes a remote branch"
const UNNAMED = "it doesn't name the branch it pushes to"
const PUSH_HEAD = "it pushes HEAD, not a named branch"

/** Words that start a compound command or negate one; `for`, `select` and `case` are followed by words that aren't
 *  a command, and `function` by a name. */
const RESERVED = set("if then else elif fi case esac for select while until do done function ! [[ ]] coproc")
const RUNS_TEXT_PROGRAMS = set("eval exec source . xargs watch")
const SHELLS = set("sh bash dash zsh ksh fish")
const CHANGES_LATER = set(
  "alias unalias function set shopt enable hash export declare typeset readonly local unset trap builtin",
)
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
const ANSI: Readonly<Record<string, string>> = {
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'",
  '"': '"', "?": "?",
}
const MAX_DEPTH = 1000

/** Read-only with any arguments: none has an option that writes a file or runs a program. A glob in a path
 *  argument stays read-only. */
const READ_ANY = set(
  "cat head tail wc grep egrep fgrep ls pwd echo whoami id uname which stat du df cut tr cmp basename dirname " +
    "realpath readlink true false sleep nproc free uptime ps column nl fold od md5sum sha1sum sha256sum seq " +
    "printenv squeue sinfo sacct sshare sprio sstat qstat bjobs bqueues",
)
const FIND_UNSAFE = set("-delete -exec -execdir -ok -okdir -fprint -fprint0 -fprintf -fls")
const GIT_READS = set("status log show rev-parse ls-files blame describe shortlog diff")
const GIT_LISTING = set("-a -r -v --list")
const MODULE_READS = set("list avail spider show whatis")
/** Read-only only with their arguments checked; any argument the shell may change (a glob, a brace or `$`) makes
 *  them not read-only, since it could become an option the check refuses. Each entry's checks must follow that
 *  program's own option parsing, not getopt's: tree, for one, takes each option's value from the next word. */
const CHECKED: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  env: (a) => a.length === 0,
  find: (a) => !a.some((w) => FIND_UNSAFE.has(w)),
  sort: (a) => !a.some((w) => short(w, "o", "kotST") || long(w, "--output", "--compress-program")),
  uniq: (a) => operands(a, "fsw", ["--skip-fields", "--skip-chars", "--check-chars"]).length <= 1,
  diff: (a) => !a.some((w) => long(w, "--output", "--ext-diff")),
  git: gitReadOnly,
  scontrol: (a) => a[0] === "show",
  module: (a) => MODULE_READS.has(a[0] ?? ""),
  printf: (a) => !(a[0] ?? "").startsWith("-v"),
  tree: (a) => !a.some((w) => (/^-[^-]/.test(w) && /[oR]/.test(w)) || long(w, "--output")),
  file: (a) => !a.some((w) => short(w, "C", "eFfmP") || long(w, "--compile")),
  date: (a) => !a.some((w) => short(w, "s", "dfIrs") || long(w, "--set")),
  hostname: (a) => a.every((w) => w.startsWith("-") && !short(w, "Fb", "F") && !long(w, "--file", "--boot")),
  test: (a) => !a.includes("-v"),
  "[": (a) => !a.includes("-v"),
}
const RUNS_CODE = set(
  "sh bash dash zsh ksh fish python python2 python3 perl ruby node bun deno php lua tclsh R Rscript julia " +
    "awk gawk mawk nawk sed make cmake ninja npm npx yarn pnpm cargo go java mvn gradle",
)
/** Wrappers that make a command not read-only even when what they run is: `nohup` writes `nohup.out` on a
 *  terminal, and `env` runs a program it finds itself. */
const NOT_READ_ONLY_WRAPPERS = set("nohup env")
const FIXED_RISKS: ReadonlyMap<string, string> = new Map([
  ...[...set("rm rmdir mv unlink shred")].map((p) => [p, DELETES] as const),
  ...[...set("cp ln install tee truncate dd wget")].map((p) => [p, WRITES] as const),
  ...[...set("kill pkill killall scancel qdel bkill")].map((p) => [p, KILLS] as const),
  ...[...set("sbatch srun salloc qsub bsub")].map((p) => [p, SUBMITS] as const),
  ...[...set("sudo su doas pkexec")].map((p) => [p, OTHER_USER] as const),
  ...[...set("vi vim nvim nano emacs ed patch")].map((p) => [p, EDITS] as const),
  ...[...set("chmod chown chgrp setfacl")].map((p) => [p, PERMISSIONS] as const),
  ["sftp", COPIES] as const,
])
const SSH_VALUE_LETTERS = "BbcDEeFIiJLlmOoPpQRSWw"
/** mosh's options that take a value as the next word when not joined with `=`. */
const MOSH_VALUES = set("-p --port --ssh --client --server --predict --family --bind-server --experimental-remote-ip")
const SSH_SAFE_FLAGS = "46CqtTvx"
const SSH_SAFE_VALUES = "lpiJ"
const SSH_SAFE_KEYS = set(
  "batchmode connecttimeout serveraliveinterval serveralivecountmax user port identitiesonly identityfile " +
    "controlpersist",
)
/** ssh's options that pick or make the master a call shares, or add a forward to it, which outlives the call. */
const SSH_CONTROL_KEYS = set("controlmaster controlpath localforward remoteforward dynamicforward")
/** ssh's flags that do the same: a control socket, a control command, and the three forwards. */
const SSH_CONTROL_LETTERS = "SOLRD"
/** A word that names a variable for a local command or config of ssh (git's, and the config the ssh wrapper passes
 *  with `-F`) anywhere in it: as a name, an assignment, an append, an index, a nameref's target or an option's value,
 *  however a builtin sets it (`export`, `declare -n`, `printf -v`, `read`, `getopts`, ...). Only a plain read of its
 *  value, `$NAME` or `${NAME}`, is left out; `${NAME:=x}` assigns, so it counts. */
const SSH_VARIABLE =
  /(?:^|[^A-Za-z0-9_${]|\$\{(?=[A-Za-z_]+:?=))(?:-[A-Za-z]+)?(?:GIT_SSH_COMMAND|GIT_SSH|OPENCORP_SSH_CONFIG)(?![A-Za-z0-9_])/
/** The builtins that set, export or unset a variable a word of theirs names. */
const SETS_VARIABLE = set("export declare typeset readonly local unset read mapfile readarray printf getopts")
/** A word that names PATH, as `SSH_VARIABLE` names ssh's variables: a plain read of its value is left out. */
const PATH_VARIABLE = /(?:^|[^A-Za-z0-9_${]|\$\{(?=PATH:?=))(?:-[A-Za-z]+)?PATH(?![A-Za-z0-9_])/
/** A word naming the folder where the SSH-only sandbox keeps the real ssh for its wrapper (`REAL_SSH`'s), or what is in
 *  it, anywhere in the word: a path, an option's value, a script's text. */
const REAL_SSH_FOLDER = /\/run\/opencorp(?![^/])/
const SSH_LOCAL_KEYS = set("proxycommand localcommand permitlocalcommand knownhostscommand")
const SSH_IDENTITY_KEYS = set("identityfile certificatefile")
/** Programs that read only names and metadata, so a credential path given to them reads no secret. */
const NAMES_ONLY = set("ls stat du test [ realpath readlink basename dirname")
/** Programs that print, copy or send what files hold; given a path through an expansion, they may read a
 *  credential the reader can't see. */
const CONTENT_READERS = set(
  "cat tac head tail less more grep egrep fgrep rg ag ack cut sort uniq diff cmp comm paste join od xxd hexdump " +
    "strings base64 base32 nl fold column rev expand unexpand fmt pr shuf split csplit iconv look jq yq sed awk " +
    "gawk mawk nawk cp scp rsync tar zip unzip gzip gunzip zcat bzip2 bunzip2 bzcat xz unxz xzcat dd tee openssl " +
    "gpg vi vim nvim view nano emacs ed sqlite3",
)
const GREP_VALUES = [
  "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--directories", "--devices",
  "--include", "--exclude", "--exclude-dir", "--exclude-from", "--label", "--binary-files", "--glob", "--type",
]
const DIFF_VALUES = "CUIxXSLFDW"
/** How a content reader takes options, for the expansion rule, which counts its operands and the values of options
 *  that name a file it reads, never counts, patterns, keys or scripts. `value`: short letters that take a value;
 *  `longs`: long options that take the next word; `paths` and `pathLongs`: those whose value is a file it reads;
 *  `given`, `givenLongs`: the options that give its pattern or script, which is otherwise its first operand;
 *  `onlyPaths`: its operands don't count (wc and du print no contents), only its path options. A reader missing
 *  here takes no option values, so every operand counts. */
interface ReaderOptions {
  readonly value: string
  readonly longs: readonly string[]
  readonly paths: string
  readonly pathLongs: readonly string[]
  readonly given?: string
  readonly givenLongs?: readonly string[]
  readonly onlyPaths?: boolean
}
const GREP_LIKE: ReaderOptions = {
  value: "efmABCdD", longs: GREP_VALUES, paths: "f", pathLongs: ["--file", "--exclude-from"], given: "ef",
  givenLongs: ["--regexp", "--file"],
}
const SEARCH_LIKE: ReaderOptions = {
  value: "efgtTmABC", longs: GREP_VALUES, paths: "f", pathLongs: ["--file", "--ignore-file"], given: "ef",
  givenLongs: ["--regexp", "--file"],
}
const AWK_LIKE: ReaderOptions = {
  value: "fvF", longs: ["--file", "--assign", "--field-separator"], paths: "f", pathLongs: ["--file"], given: "f",
  givenLongs: ["--file"],
}
const READER_OPTIONS: Readonly<Record<string, ReaderOptions>> = {
  grep: GREP_LIKE, egrep: GREP_LIKE, fgrep: GREP_LIKE, rg: SEARCH_LIKE, ag: SEARCH_LIKE, ack: SEARCH_LIKE,
  awk: AWK_LIKE, gawk: AWK_LIKE, mawk: AWK_LIKE, nawk: AWK_LIKE,
  sed: {
    value: "efl", longs: ["--expression", "--file", "--line-length"], paths: "f", pathLongs: ["--file"], given: "ef",
    givenLongs: ["--expression", "--file"],
  },
  head: { value: "nc", longs: ["--lines", "--bytes"], paths: "", pathLongs: [] },
  tail: { value: "ncs", longs: ["--lines", "--bytes", "--sleep-interval", "--pid"], paths: "", pathLongs: [] },
  cut: { value: "bcdf", longs: ["--bytes", "--characters", "--delimiter", "--fields"], paths: "", pathLongs: [] },
  sort: {
    value: "kotST", longs: ["--key", "--field-separator", "--output", "--temporary-directory", "--buffer-size"],
    paths: "", pathLongs: ["--files0-from", "--random-source"],
  },
  uniq: { value: "fsw", longs: ["--skip-fields", "--skip-chars", "--check-chars"], paths: "", pathLongs: [] },
  diff: { value: DIFF_VALUES, longs: [], paths: "X", pathLongs: ["--from-file", "--to-file", "--exclude-from"] },
  tar: { value: "fCTbHX", longs: ["--file", "--directory", "--files-from"], paths: "fTX", pathLongs: ["--file", "--files-from"] },
  wc: { value: "", longs: [], paths: "", pathLongs: ["--files0-from"], onlyPaths: true },
  du: {
    value: "BdtX", longs: ["--block-size", "--max-depth", "--threshold", "--exclude"], paths: "X",
    pathLongs: ["--files0-from", "--exclude-from"], onlyPaths: true,
  },
}
const FILE_OPS: Readonly<Record<string, { short: string; long: Set<string>; min: number; strict: boolean }>> = {
  mkdir: { short: "pv", long: set("--parents --verbose"), min: 1, strict: false },
  touch: { short: "acm", long: set("--no-create"), min: 1, strict: false },
  cp: { short: "rRapfnvT", long: set("--recursive --archive --force --no-clobber --verbose"), min: 2, strict: false },
  mv: { short: "fnvT", long: set("--force --no-clobber --verbose"), min: 2, strict: true },
  rm: { short: "rRfdv", long: set("--recursive --force --dir --verbose"), min: 1, strict: true },
}
/** Programs that run what follows them as another user; Auto's check never judges them. */
const OTHER_USERS = set("sudo su doas pkexec")
const SUDO_VALUES = "aCcDgpRrtTUu"
const SUDO_LONG_VALUES = [
  "--user", "--group", "--prompt", "--chdir", "--chroot", "--close-from", "--role", "--type", "--command-timeout",
  "--other-user", "--login-class", "--auth-type",
]
const FIND_RUNS = set("-exec -execdir -ok -okdir")
const NO_OPTIONS: ReaderOptions = { value: "", longs: [], paths: "", pathLongs: [] }
const PUSH_SAFE = set("--set-upstream --verbose --quiet --dry-run --progress --no-progress --porcelain")
const PUSH_MANY = set("--mirror --all --branches --tags --prune")
const XARGS_VALUES = ["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"]
const GIT_VALUES = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]

/** Each ssh part's remote command, as the reader read it (to `MAX_DEPTH`), so checks don't read it again. */
const REMOTES = new WeakMap<SimpleCommand, ReadCommand>()

/** The part an empty line reads as, so rules and modes can still decide it. */
export const EMPTY: SimpleCommand = {
  assignments: [], words: [], expands: [], substituted: [], writes: [], reads: [], data: [], fed: false,
}

// ---- What the reader exports ----

export function readCommand(text: string): ReadCommand {
  return read(text, 0)
}

/** The program a simple command runs and its arguments, past wrappers with their options and values. */
export function programOf(part: SimpleCommand): readonly string[] {
  return part.words.slice(unwrap(part).start)
}

/** The variables a simple command sets for its program: its leading assignments and `env`'s. */
export function assignmentsOf(part: SimpleCommand): readonly string[] {
  return unwrap(part).sets
}

export function classify(part: SimpleCommand): Kind {
  const { start, sets, wrappers, offPath } = unwrap(part)
  const [prog = "", ...args] = part.words.slice(start)
  const name = base(prog)
  const remote = name === "ssh" ? remoteKind(part) : null
  // An ssh by path, or with a PATH of its own, isn't the one the shell's PATH finds first: a wrapper there is skipped.
  // So may be one behind an env whose options the reader can't read.
  const behindEnv = name === "env" && args.some((w) => base(w) === "ssh")
  const skips = (name === "ssh" && (offPath || prog.includes("/"))) || behindEnv ? SSH_OFF_PATH : null
  const risk = riskOf(part, prog, args, sets) ?? skips ?? remote?.risk ?? null
  // printf takes options only before its format, so only its first argument could become `-v`.
  const changes = part.expands.slice(start + 1, prog === "printf" ? start + 2 : undefined).some(Boolean)
  const check = CHECKED[prog]
  const form =
    prog === "" ||
    READ_ANY.has(prog) ||
    (check !== undefined && !changes && check(args)) ||
    (prog === "ssh" && !changes && sshReadOnly(args) && (remote === null ? !part.fed : remote.readOnly))
  return {
    readOnly:
      risk === null && sets.length === 0 && !prog.includes("/") &&
      !wrappers.some((w) => NOT_READ_ONLY_WRAPPERS.has(w)) && form,
    runsCode:
      prog.includes("/") || RUNS_CODE.has(name) || remote?.runsCode === true ||
      (name === "find" && innerParts(part).length > 0),
    risk,
  }
}

/** Whether `part` is `mkdir`, `touch`, `cp`, `mv` or `rm` of literal paths inside `where`'s writable paths, on
 *  the workspace profile. Lexical: the sandbox, not this test, keeps a path behind a link from being written. */
export function fileOp(part: SimpleCommand, where: Where): boolean {
  if (where.profile !== "workspace" || where.cwd === null) return false
  const cwd = where.cwd
  const { start, sets } = unwrap(part)
  if (sets.length > 0 || part.writes.some((w) => w !== "/dev/null") || connects(part)) return false
  const [prog = "", ...args] = part.words.slice(start)
  const op = FILE_OPS[prog]
  if (!op) return false
  const paths: string[] = []
  let options = true
  for (const [k, arg] of args.entries()) {
    if (options && arg === "--") {
      options = false
      continue
    }
    if (options && arg.startsWith("-") && arg !== "-") {
      const known = arg.startsWith("--") ? op.long.has(arg) : [...arg.slice(1)].every((c) => op.short.includes(c))
      if (!known) return false
      continue
    }
    if (part.expands[start + 1 + k] || /[$*?[{]/.test(arg) || arg.startsWith("~")) return false
    paths.push(resolve(cwd, arg))
  }
  if (paths.length < op.min) return false
  const roots = where.writable.map((root) => resolve("/", root))
  return paths.every((p) => roots.some((root) => inside(p, root, op.strict)))
}

/** The destinations of a line's `ssh` and `mosh` parts, in order (mosh logs in through ssh). */
export function sshHosts(read: ReadCommand): readonly string[] {
  return read.parts.flatMap((part) => {
    const host = sshOf(part)?.host ?? moshHost(part)
    return host ? [host] : []
  })
}

/** Whether a line logs in to another machine: it has an `ssh` or `mosh` part, whether or not its destination
 *  reads. A line typed into it runs there. */
export function logsIn(read: ReadCommand): boolean {
  return read.parts.some((part) => sshOf(part) !== null || moshHost(part) !== null)
}

/** An `ssh` part's destination ("" when it names none) and the words of the command it runs there, which ssh
 *  joins with spaces (null for a login); null when the part isn't `ssh`. */
export function sshOf(
  part: SimpleCommand,
): { readonly host: string; readonly command: readonly string[] | null } | null {
  const [prog = "", ...args] = programOf(part)
  if (base(prog) !== "ssh") return null
  const { host, command } = sshParse(args)
  return { host, command }
}

/** An `ssh` part's destination and its remote command, read; null for a login or any other part. The reader keeps
 *  what it read for each part, so a check doesn't read it again. */
export function remoteOf(part: SimpleCommand): { readonly host: string; readonly read: ReadCommand } | null {
  const ssh = sshOf(part)
  if (!ssh?.command) return null
  let remote = REMOTES.get(part)
  if (!remote) {
    remote = readCommand(ssh.command.join(" "))
    REMOTES.set(part, remote)
  }
  return { host: ssh.host, read: remote }
}

/** How the reader judges a `git push`: null when the part isn't one; `asks: null` for a plain push of named
 *  branches that aren't the default (`main`, `master`) to a named remote, which `auto` runs; else why it asks in
 *  every mode. Read from the words, so a comment or quoting can't change it. A push run over ssh always asks. */
export function pushOf(part: SimpleCommand): { readonly asks: string | null } | null {
  const { start, sets } = unwrap(part)
  const [prog = "", ...args] = part.words.slice(start)
  if (base(prog) === "ssh") {
    const remote = remoteOf(part)
    for (const inner of remote?.read.parts ?? []) {
      const push = pushOf(inner)
      if (push) return { asks: `on ${remote!.host}: ${push.asks ?? PUSHES}` }
    }
    return null
  }
  if (base(prog) !== "git") return null
  const git = gitArgs(args)
  if (git.sub !== "push") return null
  const asks = (): string | null => {
    if (prog.includes("/")) return `it pushes with ${prog}`
    if (sets.length > 0) return `it pushes with ${sets[0]}`
    const global = git.globals.find((g) => g !== "-C" && g !== "--no-pager")
    if (global) return `it pushes with ${global}`
    if (connects(part)) return NETWORK
    if (part.writes.some((w) => w !== "/dev/null")) return WRITES
    let remote: string | null = null
    const refspecs: string[] = []
    let options = true
    for (const [k, w] of git.rest.entries()) {
      if (options && w === "--") {
        options = false
        continue
      }
      if (options && w.startsWith("-") && w !== "-") {
        const key = w.split("=")[0]!
        if (key === "--force" || key === "--force-with-lease" || key === "--force-if-includes") return FORCE
        if (key === "--delete") return DELETE_BRANCH
        if (PUSH_MANY.has(key)) return `it pushes with ${key}`
        if (PUSH_SAFE.has(key)) continue
        if (w.startsWith("--")) return `it pushes with ${key}`
        for (const c of w.slice(1)) {
          if (c === "f") return FORCE
          if (c === "d") return DELETE_BRANCH
          if (!"uvqn".includes(c)) return `it pushes with -${c}`
        }
        continue
      }
      if (remote === null) {
        // A remote by name only: a URL, a path, `ext::` or `host:path` could push anywhere.
        const named =
          /^[A-Za-z0-9._-]+$/.test(w) && w !== "." && w !== ".." && !part.expands[start + 1 + git.restAt + k]
        if (!named) return `it pushes to ${w}, not a named remote`
        remote = w
      } else refspecs.push(w)
    }
    if (remote === null || refspecs.length === 0) return UNNAMED
    for (const spec of refspecs) {
      if (spec.startsWith("+")) return FORCE
      if (spec.startsWith(":")) return DELETE_BRANCH
      const [src = "", dst = src, ...more] = spec.split(":")
      if (more.length > 0) return UNNAMED
      if (defaultBranch(dst)) return DEFAULT_BRANCH
      if (src.toUpperCase() === "HEAD" || src === "@") return PUSH_HEAD
      if (!plainBranch(src) || !plainBranch(dst)) return UNNAMED
    }
    return null
  }
  return { asks: asks() }
}

/** The most folders a line's parts are judged from; past it, the folder is unknown. Each cd to a new name from each
 *  folder so far doubles them. */
const FOLDERS_MAX = 8

/** Why a line's `parts` name a credential path, as `credentialOf` says of each, or null. A `cd`, `pushd` or `popd`
 *  moves the folder the later parts' relative paths start from (`folderAfter`); since a cd can fail and the line go
 *  on, each later part is judged from every folder it may run in, `cwd` among them. Past `FOLDERS_MAX` folders the
 *  folder is unknown (null), as after a cd the reader can't follow. */
export function lineCredential(
  parts: readonly SimpleCommand[],
  cwd?: string | null,
  marked: readonly string[] = [],
  strict = true,
): string | null {
  let folders: (string | null | undefined)[] = [cwd]
  for (const part of parts) {
    for (const folder of folders) {
      const found = credentialOf(part, folder, marked, strict)
      if (found !== null) return found
    }
    const moved = folders.map((folder) => folderAfter(part, folder)).filter((folder) => folder !== false)
    if (moved.length > 0) folders = [...new Set([...folders, ...moved])]
    if (folders.length > FOLDERS_MAX) folders = [null]
  }
  return null
}

/** The folder `part` moves the shell to from `cwd`: a `cd` (`chdir`) or `pushd` to a literal path, `~` for a bare
 *  `cd`; null when the reader can't know it (an expansion, `cd -`, `popd`, a `pushd` that rotates the stack, or a
 *  relative path from an unknown folder); false when `part` doesn't move. `CDPATH` isn't followed. */
function folderAfter(part: SimpleCommand, cwd: string | null | undefined): string | null | undefined | false {
  const { start } = unwrap(part)
  const name = part.words[start]
  if (name === "popd") return null
  if (name !== "cd" && name !== "chdir" && name !== "pushd") return false
  let k = start + 1
  while (k < part.words.length && /^-[LPe@]+$/.test(part.words[k]!)) k += 1
  if (part.words[k] === "--") k += 1
  const target = part.words[k]
  if (target === undefined) return name === "pushd" ? null : "~"
  if (target === "-" || /^[-+]/.test(target) || part.expands[k] || part.substituted[k]) return null
  if (/^[/~]/.test(target)) return target
  return cwd === null ? null : cwd === undefined ? target : `${cwd}/${target}`
}

/** Why `part` names a credential path (`CREDENTIALS`, or one of `marked`, the host's), or null: a literal anywhere
 *  in it (a word of its program's other than ssh's identity file, an assignment, a redirect, a here-string or
 *  here-document), a folder it reads recursively, or, over ssh, any of these in the remote command, named with its
 *  host. When `strict` (where credentials are reachable: see `decide`), a content read whose path comes
 *  through an expansion counts too, and, when `cwd` is null (the folder can't be known), a content or recursive read
 *  of a relative path; an ssh remote command is always strict. `cwd` is the folder relative paths start from: when
 *  undefined, a relative path is judged as written. An ssh remote command starts at the remote home. */
export function credentialOf(
  part: SimpleCommand,
  cwd?: string | null,
  marked: readonly string[] = [],
  strict = true,
): string | null {
  const words = programOf(part)
  const [prog = "", ...args] = words
  const name = base(prog)
  const ssh = name === "ssh" ? sshOf(part) : null
  const own = NAMES_ONLY.has(prog) && !args.some((w) => long(w, "--files0-from"))
    ? []
    : ["ssh", "scp", "sftp"].includes(name)
      ? withoutIdentity(words.slice(0, words.length - (ssh?.command?.length ?? 0)))
      : words
  const values = assignmentsOf(part).map((a) => a.slice(a.indexOf("=") + 1))
  const literals = [...own, ...values, ...part.reads, ...part.writes, ...part.data.map((d) => d.text)]
  const from = cwd ?? undefined
  const named = literals.find((word) => isCredential(word, from, marked))
  if (named !== undefined) return `it names a credential path: ${named}`
  const hidden = strict ? throughExpansion(part) : null
  if (hidden !== null) return `it reads a path named by an expansion: ${hidden}`
  const climbs = recursivePaths(part).find(({ path, expanded }) =>
    holdsCredentials(path, from, marked, strict && expanded))
  if (climbs !== undefined) return `it reads a folder that holds credentials: ${climbs.path}`
  const lost = strict && cwd === null ? relativeRead(part) : null
  if (lost !== null) return `it reads a relative path where the folder isn't known: ${lost}`
  const remote = ssh ? remoteOf(part) : null
  const found = remote ? lineCredential(remote.read.parts, "~", marked, true) : null
  return found === null ? null : `on ${remote!.host}: ${found}`
}

/** The commands a part runs that the reader doesn't list as parts of their own, for deny and ask rules: what
 *  `sudo` and `doas` run, `find`'s `-exec` commands, and an ssh remote command's parts. */
export function innerParts(part: SimpleCommand): readonly SimpleCommand[] {
  const { start } = unwrap(part)
  const [prog = "", ...args] = part.words.slice(start)
  const name = base(prog)
  const runs = (from: number, to = args.length): SimpleCommand => ({
    assignments: [], words: args.slice(from, to), expands: part.expands.slice(start + 1 + from, start + 1 + to),
    substituted: part.substituted.slice(start + 1 + from, start + 1 + to),
    writes: [], reads: [], data: [], fed: false,
  })
  if (name === "sudo" || name === "doas") {
    const at = optionsEnd(args, name === "sudo" ? SUDO_VALUES : "aCu", SUDO_LONG_VALUES)
    return at < args.length ? [runs(at)] : []
  }
  if (name === "find") {
    const found: SimpleCommand[] = []
    for (let k = 0; k < args.length; k++) {
      if (!FIND_RUNS.has(args[k]!)) continue
      const end = args.findIndex((w, i) => i > k && (w === ";" || w === "+"))
      const to = end < 0 ? args.length : end
      if (to > k + 1) found.push(runs(k + 1, to))
      k = to
    }
    return found
  }
  return remoteOf(part)?.read.parts ?? []
}

/** Why Auto's check must never judge `part`, so every mode asks the owner and dontAsk refuses it: a push the
 *  reader can't call plain (any push, in a line it can't read), a program that runs as another user, a local
 *  command for ssh (`ProxyCommand`, `-F`, `scp -S`, `rsync -e`, `GIT_SSH_COMMAND`, `core.sshCommand`,
 *  `OPENCORP_SSH_CONFIG`), which on the SSH-only profile could send a key off the machine, an ssh the shell's PATH
 *  doesn't find, which skips the wrapper there and logs in with the owner's config as it is, or an ssh that controls a
 *  shared connection (`-O` but `check`, `-S`, `ControlPath`, `ControlMaster`, `-L`, `-R`, `-D` and their options),
 *  which could end one of the owner's or leave a forward on it; here, under `find -exec` or over ssh. Null
 *  otherwise. */
export function ownerOnly(part: SimpleCommand, readable: boolean): string | null {
  const push = pushOf(part)
  if (push) return push.asks ?? (readable ? null : PUSHES)
  if (OTHER_USERS.has(base(programOf(part)[0] ?? ""))) return OTHER_USER
  const risk = classify(part).risk
  if (risk === LOCAL_SSH || risk === CONTROLS_SSH || risk === SSH_OFF_PATH || risk === NAMES_REAL_SSH) return risk
  const host = sshOf(part)?.host
  for (const inner of innerParts(part)) {
    const found = ownerOnly(inner, readable)
    if (found) return host ? `on ${host}: ${found}` : found
  }
  return null
}

/** Why `part` may change which ssh the shell's later commands, or the program it runs, find on PATH: it sets,
 *  exports or unsets PATH (a bare assignment, one for its program or `env`'s, `env -i`, `env -u PATH`, a builtin that
 *  writes the variable, `${PATH:=…}`), looks its program up on another PATH (`command -p`), or runs `hash -p`; here,
 *  under `sudo` or `find -exec`, but not in an ssh remote command, whose PATH is another machine's. Null otherwise. A
 *  wrapper for ssh first on PATH holds only while PATH stays as the host set it. */
export function pathChange(part: SimpleCommand): string | null {
  const { start, offPath } = unwrap(part)
  const [prog = "", ...args] = part.words.slice(start)
  const name = base(prog)
  const named = SETS_VARIABLE.has(name) && args.some((w) => PATH_VARIABLE.test(w))
  const expanded = part.words.some((w) => /\$\{PATH:?=/.test(w))
  const hashed = name === "hash" && args.slice(0, optionsEnd(args, "", [])).some((w) => /^-[A-Za-z]*p/.test(w))
  if (offPath || named || expanded || hashed) return SETS_PATH
  if (sshOf(part) !== null) return null
  for (const inner of innerParts(part)) {
    const found = pathChange(inner)
    if (found !== null) return found
  }
  return null
}

// ---- Reading a line ----

function read(text: string, depth: number): ReadCommand {
  const reader = new Reader(text, depth)
  if (CONTROL_CHARS.test(text)) reader.mark(CONTROL)
  try {
    reader.list(false)
  } catch (error) {
    if (!(error instanceof TooDeep)) throw error
    reader.mark(DEEP)
  }
  return { parts: reader.parts, unreadable: reader.unreadable }
}

class TooDeep extends Error {}

/** A word being read: its text with quotes removed, whether the shell may change it, whether any of it was
 *  quoted, and where its first quoted character is (to tell `A=b` from `'A'=b`). */
interface Word {
  text: string
  expands: boolean
  substituted: boolean
  quoted: boolean
  firstQuoted: number
}
type Redirect = "write" | "read" | "readwrite" | "dup-in" | "dup-out" | "heredoc" | "heredoc-tabs" | "herestring"
/** A simple command being read; `skip` drops the rest of its words (after `for`, `select`, `case`), and
 *  `skipName` the next one (after `function`). */
interface Building {
  assignments: string[]
  words: string[]
  expands: boolean[]
  substituted: boolean[]
  writes: string[]
  reads: string[]
  data: { text: string; substituted: boolean }[]
  /** After `for`, `select` or `case`: the keyword and the words that follow it, which are no command. */
  listed: string[]
  fed: boolean
  redirect: Redirect | null
  skip: boolean
  skipName: boolean
}
const building = (fed = false): Building => ({
  assignments: [], words: [], expands: [], substituted: [], writes: [], reads: [], data: [], listed: [], fed,
  redirect: null, skip: false, skipName: false,
})
const INPUTS: ReadonlySet<Redirect> = new Set(["read", "readwrite", "dup-in", "heredoc", "heredoc-tabs", "herestring"])
const newWord = (): Word => ({ text: "", expands: false, substituted: false, quoted: false, firstQuoted: Infinity })
function add(word: Word, text: string, quoted: boolean): void {
  if (quoted) {
    if (word.firstQuoted === Infinity) word.firstQuoted = word.text.length
    word.quoted = true
  }
  word.text += text
}
const REDIRECTS: readonly (readonly [string, Redirect])[] = [
  ["<<<", "herestring"], ["<<-", "heredoc-tabs"], ["<<", "heredoc"], ["<&", "dup-in"], ["<>", "readwrite"],
  ["<", "read"], [">>", "write"], [">|", "write"], [">&", "dup-out"], [">", "write"],
]

/** One pass over a command line. Nested lists (`$(…)`, `<(…)`, `(…)`) are read in place; backquotes, `sh -c`
 *  strings, `eval`'s words and the like by a reader of their own, one level deeper. */
class Reader {
  readonly parts: SimpleCommand[] = []
  unreadable: string | null = null
  private pos = 0
  private heredocs: { delim: string; tabs: boolean; quoted: boolean; data: Building["data"] }[] = []

  constructor(
    private readonly text: string,
    private depth: number,
  ) {}

  mark(reason: string): void {
    this.unreadable ??= reason
  }

  /** Reads simple commands to the end of the text, or, when `nested`, to the `)` that closes the list. */
  list(nested: boolean): void {
    if (this.depth > MAX_DEPTH) throw new TooDeep()
    const t = this.text
    let cmd = building()
    let w: Word | null = null
    const word = () => (w ??= newWord())
    const endWord = () => {
      if (w === null) return
      const done = w
      w = null
      if (this.addWord(cmd, done)) {
        this.finish(cmd)
        cmd = building()
      }
    }
    const endCommand = () => {
      endWord()
      this.finish(cmd)
      cmd = building()
    }
    while (this.pos < t.length) {
      const c = t[this.pos]!
      const n = t[this.pos + 1]
      if (c === "\\") {
        if (n !== "\n") add(word(), n ?? "\\", true)
        this.pos += n === undefined ? 1 : 2
      } else if (c === "'") this.single(word())
      else if (c === '"') this.double(word())
      else if (c === "$") this.dollar(word(), false)
      else if (c === "`") this.backtick(word())
      else if (c === " " || c === "\t") {
        endWord()
        this.pos++
      } else if (c === "#" && w === null) {
        while (this.pos < t.length && t[this.pos] !== "\n") this.pos++
      } else if (c === "\n") {
        endCommand()
        this.pos++
        this.bodies()
      } else if (c === "&" && n === ">") {
        endWord()
        cmd.redirect = "write"
        this.pos += t[this.pos + 2] === ">" ? 3 : 2
      } else if (c === ";" || c === "&" || c === "|") {
        endCommand()
        if (c === "|" && n !== "|") cmd.fed = true
        this.pos += (c === "&" && n === "&") || (c === "|" && (n === "|" || n === "&")) ? 2 : 1
      } else if ((c === "<" || c === ">") && n === "(") {
        endWord()
        this.mark(PROCESS_SUB)
        const start = this.pos
        this.pos += 2
        this.nested()
        const sub = word()
        add(sub, t.slice(start, this.pos), false)
        sub.expands = true
      } else if (c === "<" || c === ">") {
        // A word of digits right before the operator names the descriptor it redirects.
        const pending = w as Word | null
        const fd = pending !== null && !pending.quoted && /^\d+$/.test(pending.text) ? Number(pending.text) : null
        if (fd !== null) w = null
        else endWord()
        const [op, kind] = REDIRECTS.find(([op]) => t.startsWith(op, this.pos))!
        this.pos += op.length
        cmd.redirect = kind
        if (INPUTS.has(kind) && (fd === null || fd === 0)) cmd.fed = true
        if (kind === "herestring") this.mark(HERE_STRING)
        if (kind === "heredoc" || kind === "heredoc-tabs") this.mark(HERE_DOC)
      } else if (c === "(" && n === "(" && w === null && cmd.words.length === 0 && this.arithmetic(2)) {
        this.mark(ARITHMETIC)
      } else if (c === "(" && cmd.skip) {
        this.pos++ // a case pattern's optional `(`
      } else if (c === "(") {
        endWord()
        this.mark(SUBSHELL)
        this.pos++
        this.nested()
      } else if (c === ")" && cmd.skip) {
        endCommand() // a case pattern ends; its commands follow
        this.pos++
      } else if (c === ")") {
        endCommand()
        this.pos++
        if (nested) return
        this.mark(SUBSHELL)
      } else {
        const sub = word()
        if ("*?[{}".includes(c)) sub.expands = true
        add(sub, c, false)
        this.pos++
      }
    }
    endCommand()
  }

  /** Adds a finished word to `cmd`: a redirect's target, a reserved word, an assignment or a word. True when the
   *  word is a group's `{` or `}`, which ends the command. */
  private addWord(cmd: Building, w: Word): boolean {
    const text = w.text
    const redirect = cmd.redirect
    if (redirect !== null) {
      cmd.redirect = null
      if (redirect === "write" || redirect === "readwrite") cmd.writes.push(text)
      if (redirect === "read" || redirect === "readwrite") cmd.reads.push(text)
      // `>&N` writes to descriptor N: 0 to 2 are the terminal's, a higher one may be any file or socket.
      if (redirect === "dup-out" && /^\d+$/.test(text) && Number(text) >= 3) cmd.writes.push(`&${text}`)
      if (redirect === "dup-out" && !/^(\d+|-)$/.test(text)) cmd.writes.push(text)
      if (redirect === "heredoc" || redirect === "heredoc-tabs")
        this.heredocs.push({ delim: text, tabs: redirect === "heredoc-tabs", quoted: w.quoted, data: cmd.data })
      if (redirect === "herestring") cmd.data.push({ text, substituted: w.substituted })
      return false
    }
    if (!w.quoted && (text === "{" || text === "}")) {
      this.mark(SUBSHELL)
      return true
    }
    if (cmd.skipName) {
      cmd.skipName = false
      return false
    }
    if (cmd.skip) {
      cmd.listed.push(text)
      return false
    }
    if (cmd.words.length === 0 && cmd.assignments.length === 0 && !w.quoted && RESERVED.has(text)) {
      if (text === "function") {
        this.mark(`${CHANGES}: function`)
        cmd.skipName = true
      } else {
        this.mark(`${KEYWORD}: ${text}`)
        cmd.skip = text === "for" || text === "select" || text === "case"
        if (cmd.skip) cmd.listed.push(text)
      }
      return false
    }
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*\+?=/.exec(text)
    if (cmd.words.length === 0 && assignment && assignment[0].length - 1 < w.firstQuoted) cmd.assignments.push(text)
    else {
      cmd.words.push(text)
      cmd.expands.push(w.expands)
      cmd.substituted.push(w.substituted)
    }
    return false
  }

  /** Ends a simple command: marks what makes it unreadable, reads the commands its words run (inner ones first),
   *  then adds it. */
  private finish(cmd: Building): void {
    // A `for` list or a `case` word reads as a part of its own, so its literals are checked as any command's.
    if (cmd.listed.length > 1) {
      const flags = cmd.listed.map(() => false)
      this.complete({ ...EMPTY, words: cmd.listed, expands: flags, substituted: flags })
    }
    if (cmd.words.length + cmd.assignments.length + cmd.writes.length + cmd.reads.length + cmd.data.length === 0) return
    const { assignments, words, expands, substituted, writes, reads, data, fed } = cmd
    this.complete({ assignments, words, expands, substituted, writes, reads, data, fed })
  }

  private complete(part: SimpleCommand): void {
    const { start, wrappers } = unwrap(part)
    const [prog, ...args] = part.words.slice(start)
    // `builtin` runs what it names, which the reader reads; it still marks the line, as it does alone.
    if (wrappers.includes("builtin")) this.mark(`${CHANGES}: builtin`)
    if (prog !== undefined) {
      const name = base(prog)
      if (prog !== "[" && (part.expands[start] || /[$*?[{}]/.test(prog) || prog.startsWith("~"))) this.mark(EXPANDED)
      if (RUNS_TEXT_PROGRAMS.has(name)) this.mark(`${RUNS_TEXT}: ${name}`)
      if (name === "env" && splitString(args) !== null) this.mark(`${RUNS_TEXT}: env -S`)
      if (SHELLS.has(name) && shellString(args).runsText) this.mark(`${RUNS_TEXT}: ${name} -c`)
      if (CHANGES_LATER.has(name)) this.mark(`${CHANGES}: ${name}`)
      if (name === "ssh") {
        const { host, command } = sshParse(args)
        const remote = command ? read(command.join(" "), this.depth + 1) : null
        if (remote) REMOTES.set(part, remote)
        if (remote?.unreadable) this.mark(`on ${host}: ${remote.unreadable}`)
        if (!command && host && part.fed) this.mark(`on ${host}: ${FEEDS_SHELL}`)
      }
      this.inner(part, start, name, args)
    }
    this.parts.push(part)
  }

  /** Reads what a program runs as a command, so deny and ask rules see it: `eval`'s words, an `sh -c` string,
   *  `env -S`'s string, `watch`'s and `trap`'s commands, and what `exec` and `xargs` run. */
  private inner(part: SimpleCommand, start: number, name: string, args: readonly string[]): void {
    const runs = (from: number) =>
      from < args.length &&
      this.complete({
        assignments: [], words: args.slice(from), expands: part.expands.slice(start + 1 + from),
        substituted: part.substituted.slice(start + 1 + from), writes: [], reads: [], data: [], fed: false,
      })
    if (name === "eval") this.sub(args.join(" "))
    else if (SHELLS.has(name)) {
      const { runsText, at } = shellString(args)
      if (runsText && at < args.length) this.sub(args[at]!)
    } else if (name === "env") {
      const at = splitString(args)
      if (at !== null) this.sub(args.slice(at).join(" ").replace(/^(-S|--split-string=?)/, ""))
    } else if (name === "watch") this.sub(args.slice(optionsEnd(args, "n", ["--interval"])).join(" "))
    else if (name === "trap") {
      const at = args[0] === "--" ? 1 : 0
      const action = args[at]
      if (action !== undefined && (at === 1 || !action.startsWith("-"))) this.sub(action)
    }
    else if (name === "exec") runs(optionsEnd(args, "a", []))
    else if (name === "xargs") runs(optionsEnd(args, "adEILnPs", XARGS_VALUES))
  }

  /** Reads `text` as a command line of its own, one level deeper, and keeps its commands. */
  private sub(text: string): void {
    if (this.depth >= MAX_DEPTH) throw new TooDeep()
    const reader = new Reader(text, this.depth + 1)
    reader.list(false)
    this.parts.push(...reader.parts)
  }

  private nested(): void {
    this.depth++
    try {
      this.list(true)
    } finally {
      this.depth--
    }
  }

  /** Skips the bodies of the here-documents opened on the line that just ended: they are data, not commands,
   *  except the substitutions in a body whose delimiter isn't quoted, which the shell runs. */
  private bodies(): void {
    const t = this.text
    for (const { delim, tabs, quoted, data } of this.heredocs) {
      let body = ""
      while (this.pos < t.length) {
        const end = t.indexOf("\n", this.pos)
        const line = t.slice(this.pos, end < 0 ? t.length : end)
        this.pos = end < 0 ? t.length : end + 1
        if ((tabs ? line.replace(/^\t+/, "") : line) === delim) break
        body += `${line}\n`
      }
      if (!quoted) this.expand(body)
      for (const text of body.split(/\s+/)) if (text) data.push({ text, substituted: !quoted && text.includes("$") })
    }
    this.heredocs = []
  }

  /** Reads the substitutions in an unquoted here-document's body, as the shell expands it. */
  private expand(body: string): void {
    if (this.depth >= MAX_DEPTH) throw new TooDeep()
    const reader = new Reader(body, this.depth + 1)
    const scratch = newWord()
    while (reader.pos < body.length) {
      const c = body[reader.pos]!
      if (c === "\\") reader.pos += 2
      else if (c === "$") reader.dollar(scratch, true)
      else if (c === "`") reader.backtick(scratch)
      else reader.pos++
    }
    this.parts.push(...reader.parts)
  }

  private single(w: Word): void {
    const end = this.text.indexOf("'", this.pos + 1)
    if (end < 0) {
      this.mark(UNCLOSED)
      add(w, this.text.slice(this.pos + 1), true)
      this.pos = this.text.length
      return
    }
    add(w, this.text.slice(this.pos + 1, end), true)
    this.pos = end + 1
  }

  private double(w: Word): void {
    const t = this.text
    this.pos++
    add(w, "", true)
    while (this.pos < t.length) {
      const c = t[this.pos]!
      const n = t[this.pos + 1]
      if (c === '"') {
        this.pos++
        return
      }
      if (c === "\\" && n === "\n") this.pos += 2
      else if (c === "\\" && n !== undefined && '"\\$`'.includes(n)) (add(w, n, true), (this.pos += 2))
      else if (c === "$") this.dollar(w, true)
      else if (c === "`") this.backtick(w)
      else (add(w, c, true), this.pos++)
    }
    this.mark(UNCLOSED)
  }

  /** A `$`: ANSI-C and locale quotes (outside double quotes), a command or arithmetic substitution, a parameter
   *  expansion, or a plain variable. Each but a decoded `$'…'` may change the word. */
  private dollar(w: Word, quoted: boolean): void {
    const t = this.text
    const n = t[this.pos + 1]
    const start = this.pos
    if (!quoted && n === "'") return this.ansi(w)
    if (!quoted && n === '"') {
      this.pos++
      w.expands = true
      return this.double(w)
    }
    w.expands = true
    // `$` alone, or before a character that starts no expansion, is a plain `$`.
    if (n !== undefined && /[A-Za-z0-9_@*#?$!({[-]/.test(n)) w.substituted = true
    if (n === "(" && t[this.pos + 2] === "(" && this.arithmetic(3)) this.mark(ARITHMETIC)
    else if (n === "(") {
      this.mark(COMMAND_SUB)
      this.pos += 2
      this.nested()
    } else if (n === "{" || n === "[") {
      this.pos += 2
      const body = this.balanced(n === "{" ? "}" : "]")
      if (n === "[") this.mark(ARITHMETIC)
      else if (!readableParameter(body)) this.mark(PARAMETER)
    } else this.pos++
    add(w, t.slice(start, this.pos), quoted)
  }

  /** Decodes `$'…'` as bash does; a NUL, a byte past ASCII, `\c` or `\u` can't be decoded for sure. */
  private ansi(w: Word): void {
    const t = this.text
    this.pos += 2
    let out = ""
    while (this.pos < t.length) {
      const c = t[this.pos]!
      if (c === "'") {
        this.pos++
        add(w, out, true)
        return
      }
      if (c !== "\\" || this.pos + 1 >= t.length) {
        out += c
        this.pos++
        continue
      }
      const e = t[this.pos + 1]!
      this.pos += 2
      if (ANSI[e] !== undefined) {
        out += ANSI[e]
        continue
      }
      const octal = /[0-7]/.test(e)
      const width = e === "x" ? 2 : e === "u" ? 4 : e === "U" ? 8 : 0
      const digits = octal
        ? /^[0-7]{1,3}/.exec(t.slice(this.pos - 1, this.pos + 2))
        : width > 0
          ? new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(t.slice(this.pos, this.pos + width))
          : null
      if (digits) {
        const point = parseInt(digits[0], octal ? 8 : 16)
        this.pos += digits[0].length - (octal ? 1 : 0)
        if (point === 0 || point > 0x7f) this.mark(UNDECODED)
        else out += String.fromCharCode(point)
      } else if (e === "c" || e === "u" || e === "U") this.mark(UNDECODED)
      else out += `\\${e}`
    }
    this.mark(UNCLOSED)
    add(w, out, true)
  }

  private backtick(w: Word): void {
    const t = this.text
    const start = this.pos
    this.mark(COMMAND_SUB)
    let i = this.pos + 1
    let inner = ""
    while (i < t.length && t[i] !== "`") {
      if (t[i] === "\\" && i + 1 < t.length && "$`\\".includes(t[i + 1]!)) {
        inner += t[i + 1]
        i += 2
      } else inner += t[i++]
    }
    this.pos = Math.min(i + 1, t.length)
    this.sub(inner)
    add(w, t.slice(start, this.pos), false)
    w.expands = true
    w.substituted = true
  }

  /** Reads an arithmetic expression from `skip` characters on (past `((` or `$((`) to its `))`, reading the
   *  substitutions inside; arithmetic has no redirects, so `<<` there is a shift. When no `))` closes it at its
   *  own depth, it is no arithmetic: `pos` is left where it was and false returned. */
  private arithmetic(skip: number): boolean {
    const t = this.text
    const start = this.pos
    const scratch = newWord()
    let depth = 0
    this.pos += skip
    while (this.pos < t.length) {
      const c = t[this.pos]!
      if (c === ")" && depth === 0) {
        if (t[this.pos + 1] !== ")") break
        this.pos += 2
        return true
      }
      if (c === "(") depth++
      if (c === ")") depth--
      if (c === "\\") this.pos += 2
      else if (c === "'") this.single(scratch)
      else if (c === '"') this.double(scratch)
      else if (c === "$") this.dollar(scratch, false)
      else if (c === "`") this.backtick(scratch)
      else this.pos++
    }
    this.pos = start
    return false
  }

  /** Reads to the `close` that ends a `${…}` or `$[…]`, reading the substitutions inside; returns the body. */
  private balanced(close: "}" | "]"): string {
    const t = this.text
    const open = close === "}" ? "{" : "["
    const start = this.pos
    const scratch = newWord()
    let depth = 0
    while (this.pos < t.length) {
      const c = t[this.pos]!
      if (c === close && depth === 0) {
        this.pos++
        return t.slice(start, this.pos - 1)
      }
      if (c === open) depth++
      if (c === close) depth--
      if (c === "\\") this.pos += 2
      else if (c === "'") this.single(scratch)
      else if (c === '"') this.double(scratch)
      else if (c === "$") this.dollar(scratch, false)
      else if (c === "`") this.backtick(scratch)
      else this.pos++
    }
    this.mark(UNCLOSED)
    return t.slice(start)
  }
}

/** A `${…}` that runs nothing: a name, `#name`, or a name and a default, alternative, pattern removal,
 *  substitution or case change. A subscript, an offset, `!`, `@` and `=` evaluate or assign. */
function readableParameter(body: string): boolean {
  const m = /^(#?)([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])([^]*)$/.exec(body)
  if (!m) return false
  const [, count, , rest] = m
  if (rest === "") return true
  return count === "" && /^(:?[-+]|%%?|##?|\/\/?|\^\^?|,,?)/.test(rest!)
}

// ---- Wrappers and options ----

/** Where the program starts past wrappers, the variables they and the part set, the wrappers, and whether the program
 *  is looked up other than on the shell's PATH: through `command -p`'s default PATH, or a PATH set, cleared or unset. */
function unwrap(part: SimpleCommand): { start: number; sets: string[]; wrappers: string[]; offPath: boolean } {
  const words = part.words
  const sets = [...part.assignments]
  const wrappers: string[] = []
  let offPath = false
  let i = 0
  for (;;) {
    const name = words[i]
    if (name === undefined) break
    const skipped = skipWrapper(name, words, i + 1)
    if (skipped === null || skipped.next >= words.length) break
    wrappers.push(name)
    sets.push(...skipped.sets)
    offPath ||= skipped.offPath
    i = skipped.next
  }
  offPath ||= sets.some((set) => /^PATH\+?=/.test(set))
  return { start: i, sets, wrappers, offPath }
}

/** If `name` is a wrapper whose options from `i` on are all known, where its program starts, what it sets, and whether
 *  its options look the program up other than on the shell's PATH (`command -p`, `env -i`, `env -u PATH`). */
function skipWrapper(
  name: string,
  words: readonly string[],
  i: number,
): { next: number; sets: string[]; offPath: boolean } | null {
  const first = i
  const sets: string[] = []
  const options = (
    value: string,
    valueLongs: readonly string[],
    flags: readonly string[],
    extra?: (w: string) => boolean,
  ) => {
    while (i < words.length) {
      const w = words[i]!
      if (w === "--") return i + 1
      if (!w.startsWith("-")) {
        if (extra?.(w)) {
          i++
          continue
        }
        return i
      }
      const key = w.split("=")[0]!
      if (flags.includes(w) || (extra?.(w) ?? false)) i++
      else if (w.startsWith("--") && valueLongs.includes(key)) i += w.includes("=") ? 1 : 2
      else if (!w.startsWith("--") && w.length >= 2 && value.includes(w[1]!)) i += w.length > 2 ? 1 : 2
      else return null
    }
    return i
  }
  let next: number | null
  if (name === "nice") next = options("n", ["--adjustment"], [], (w) => /^-\d+$/.test(w))
  else if (name === "nohup") next = options("", [], [])
  else if (name === "time") next = options("", [], ["-p"])
  else if (name === "command") next = options("", [], ["-p"])
  else if (name === "builtin") next = options("", [], [])
  else if (name === "stdbuf") next = options("ioe", ["--input", "--output", "--error"], [])
  else if (name === "timeout") {
    next = options("ks", ["--kill-after", "--signal"], ["--preserve-status", "--foreground", "-v", "--verbose"])
    if (next !== null) next++
  } else if (name === "env") return envOptions(words, i)
  else return null
  if (next === null) return null
  return { next, sets, offPath: name === "command" && words.slice(first, next).includes("-p") }
}

/** `env`'s options and assignments from `i`: where its program starts, the variables it sets, and whether it clears
 *  the environment or unsets PATH. Short flags combine (`-iu PATH`, `-0i`); `-u` and `-C` take the rest of their word
 *  or the next one; assignments may follow `--`. Null for an option it doesn't know, `-S` among them (its string is
 *  read as a command of its own). */
function envOptions(words: readonly string[], i: number): { next: number; sets: string[]; offPath: boolean } | null {
  const sets: string[] = []
  let offPath = false
  let options = true
  for (; i < words.length; i++) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) sets.push(w)
    else if (!options || !w.startsWith("-")) break
    else if (w === "--") options = false
    else if (w === "-") offPath = true
    else if (w.startsWith("--")) {
      const [key, joined] = w.includes("=") ? [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)] : [w, null]
      if (key === "--ignore-environment") offPath = true
      else if (key === "--unset" || key === "--chdir") {
        const value = joined ?? words[++i]
        if (value === undefined) return null
        if (key === "--unset" && value === "PATH") offPath = true
      } else if (key !== "--null" && key !== "--debug") return null
    } else {
      for (let k = 1; k < w.length; k++) {
        const c = w[k]!
        if (c === "i") offPath = true
        else if (c === "u" || c === "C") {
          const value = k + 1 < w.length ? w.slice(k + 1) : words[++i]
          if (value === undefined) return null
          if (c === "u" && value === "PATH") offPath = true
          break
        } else if (c !== "0" && c !== "v") return null
      }
    }
  }
  return { next: i, sets, offPath }
}

/** Where `env`'s `-S` (`--split-string`) string starts, or null when it has none. */
function splitString(args: readonly string[]): number | null {
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!
    if (!w.startsWith("-") || w === "--") return null
    if (w.startsWith("--split-string")) return w.includes("=") ? k : k + 1
    if (w === "-u" || w === "--unset" || w === "-C" || w === "--chdir") k++
    else if (!w.startsWith("--") && w.includes("S")) return w.endsWith("S") ? k + 1 : k
  }
  return null
}

/** A shell's options: whether one holds `c` (it runs a string), and where its first operand is. */
function shellString(args: readonly string[]): { runsText: boolean; at: number } {
  let runsText = false
  let k = 0
  while (k < args.length) {
    const w = args[k]!
    if (w === "--") return { runsText, at: k + 1 }
    if (!/^[-+]./.test(w)) break
    if (w.includes("c")) runsText = true
    k += !w.startsWith("--") && /[oO]$/.test(w) ? 2 : 1
  }
  return { runsText, at: k }
}

/** Where a program's operands start: past options, `value` letters and `valueLongs` taking the next word. */
function optionsEnd(args: readonly string[], value: string, valueLongs: readonly string[]): number {
  let k = 0
  while (k < args.length) {
    const w = args[k]!
    if (w === "--") return k + 1
    if (!w.startsWith("-") || w === "-") return k
    if (w.startsWith("--")) k += valueLongs.includes(w) ? 2 : 1
    else {
      const at = [...w.slice(1)].findIndex((c) => value.includes(c))
      k += at >= 0 && at === w.length - 2 ? 2 : 1
    }
  }
  return k
}

/** A program's operands, past its options, as getopt reads them: a `value` letter takes the rest of its word, or
 *  the next word when it ends the word, and `valueLongs` without `=` take the next word. */
function operands(args: readonly string[], value: string, valueLongs: readonly string[]): string[] {
  const found: string[] = []
  let options = true
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!
    if (options && w === "--") options = false
    else if (options && w.startsWith("--") && w.length > 2) {
      if (!w.includes("=") && valueLongs.includes(w)) k++
    } else if (options && w.startsWith("-") && w.length > 1) {
      if ([...w.slice(1)].findIndex((c) => value.includes(c)) === w.length - 2) k++
    } else found.push(w)
  }
  return found
}

/** Whether `w` is a short option group holding one of `letters`, read up to the first letter that takes a value
 *  (`valueLetters`), which takes the rest of the word. */
function short(w: string, letters: string, valueLetters: string): boolean {
  if (!w.startsWith("-") || w.startsWith("--") || w.length < 2) return false
  for (const c of w.slice(1)) {
    if (letters.includes(c)) return true
    if (valueLetters.includes(c)) return false
  }
  return false
}

/** Whether `w` is one of `names` as a long option, abbreviations (which GNU and git accept) included. */
function long(w: string, ...names: string[]): boolean {
  const key = w.split("=")[0]!
  return key.startsWith("--") && key.length > 2 && names.some((name) => name.startsWith(key))
}

function base(prog: string): string {
  return prog.slice(prog.lastIndexOf("/") + 1)
}

// ---- Risks, git and ssh ----

function riskOf(part: SimpleCommand, prog: string, args: readonly string[], sets: readonly string[]): string | null {
  if (connects(part)) return NETWORK
  const name = base(prog)
  // An exported variable of the shell's keeps its export when assigned, so a bare assignment counts too.
  if ([prog, ...args, ...sets].some(namesSshCommand)) return LOCAL_SSH
  if ([prog, ...args, ...sets, ...part.writes, ...part.reads].some((w) => REAL_SSH_FOLDER.test(w))) return NAMES_REAL_SSH
  const own = programRisk(name, args, part) ?? FIXED_RISKS.get(name) ?? null
  if (own !== null) return own
  return part.writes.some((w) => w !== "/dev/null") ? WRITES : null
}

function programRisk(name: string, args: readonly string[], part: SimpleCommand): string | null {
  switch (name) {
    case "find":
      return args.includes("-delete") ? DELETES : (innerParts(part).map(classify).find((k) => k.risk)?.risk ?? null)
    case "sort":
      return args.some((w) => short(w, "o", "kotST") || long(w, "--output")) ? WRITES : null
    case "curl":
      return args.some((w) => short(w, "oO", "") || long(w, "--output", "--remote-name", "--remote-name-all"))
        ? WRITES
        : null
    case "sed":
      return args.some((w) => short(w, "i", "efl") || long(w, "--in-place")) ? EDITS : null
    case "perl":
      return args.slice(0, optionsEnd(args, "", [])).some((w) => short(w, "i", "eEMmIxdDCV")) ? EDITS : null
    case "scp":
      return args.some((w) => short(w, "S", "cDFiJloPSX")) ? LOCAL_SSH : COPIES
    case "rsync": {
      if (args.some((w) => short(w, "e", "e") || long(w, "--rsh"))) return LOCAL_SSH
      if (args.some((w) => w.startsWith("--delete") || w === "--remove-source-files")) return DELETES
      return args.some((w) => !w.startsWith("-") && /^([^/]*:|rsync:\/\/)/.test(w)) ? COPIES : null
    }
    case "ssh": {
      const { opts } = sshParse(args)
      if (opts.some(([c, v]) => c === "F" || (c === "o" && SSH_LOCAL_KEYS.has(optionKey(v))))) return LOCAL_SSH
      const controls = opts.some(
        ([c, v]) =>
          (c === "O" ? v !== "check" : SSH_CONTROL_LETTERS.includes(c)) ||
          (c === "o" && SSH_CONTROL_KEYS.has(optionKey(v))),
      )
      return controls ? CONTROLS_SSH : null
    }
    case "git":
      return gitRisk(args, part)
    default:
      return null
  }
}

function gitRisk(args: readonly string[], part: SimpleCommand): string | null {
  const git = gitArgs(args)
  const sshCommand = git.options.some(
    ([o, v]) =>
      (o === "-c" && optionKey(v).startsWith("core.sshcommand")) ||
      (o === "--config-env" && optionKey(v).startsWith("core.sshcommand")),
  )
  if (sshCommand) return LOCAL_SSH
  const rest = git.rest
  switch (git.sub) {
    case "clean":
    case "restore":
      return DELETES
    case "reset":
      return rest.includes("--hard") ? DELETES : null
    case "checkout":
      return rest.includes("--") || rest.includes(".") ? DELETES : null
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" ? DELETES : null
    case "branch":
      return rest.some((w) => short(w, "dD", "") || long(w, "--delete")) ? DELETES : null
    case "push":
      return pushOf(part)?.asks ?? PUSHES
    default:
      return null
  }
}

function gitReadOnly(args: readonly string[]): boolean {
  const git = gitArgs(args)
  if (git.globals.some((g) => g !== "-C" && g !== "--no-pager")) return false
  const rest = git.rest
  if (GIT_READS.has(git.sub)) return !rest.some((w) => long(w, "--output", "--ext-diff", "--textconv"))
  if (git.sub === "branch" || git.sub === "tag" || git.sub === "remote") return rest.every((w) => GIT_LISTING.has(w))
  return git.sub === "stash" && rest.length === 1 && rest[0] === "list"
}

/** git's global options (with their values), its subcommand, the words after it, and where they start. */
function gitArgs(args: readonly string[]) {
  const options: [string, string][] = []
  let k = 0
  while (k < args.length && args[k]!.startsWith("-")) {
    const w = args[k]!
    const key = w.split("=")[0]!
    const separate = GIT_VALUES.includes(w)
    options.push([key, separate ? (args[k + 1] ?? "") : w.slice(key.length + 1)])
    k += separate ? 2 : 1
  }
  return { options, globals: options.map(([o]) => o), sub: args[k] ?? "", rest: args.slice(k + 1), restAt: k + 1 }
}

/** Whether `word` names one of ssh's command variables (`SSH_VARIABLE`). */
function namesSshCommand(word: string): boolean {
  return SSH_VARIABLE.test(word)
}

/** An ssh `-o` value's key, lowercased: up to `=` or a blank. */
function optionKey(value: string | null): string {
  return (value ?? "").trim().split(/[=\s]/)[0]!.toLowerCase()
}

/** A `mosh` part's destination: its first word past its options ("" when it names none); null when the part isn't
 *  `mosh`. */
function moshHost(part: SimpleCommand): string | null {
  const [prog = "", ...args] = programOf(part)
  if (base(prog) !== "mosh") return null
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!
    if (w === "--") return args[k + 1] ?? ""
    if (!w.startsWith("-") || w === "-") return w
    if (MOSH_VALUES.has(w)) k++
  }
  return ""
}

/** ssh's options as its own getopt reads them (options may follow the destination too), the destination and
 *  the remote command's words. */
function sshParse(args: readonly string[]) {
  const opts: [string, string | null][] = []
  let k = 0
  let ended = false
  const options = () => {
    while (k < args.length) {
      const w = args[k]!
      if (w === "--") {
        k++
        ended = true
        return
      }
      if (!w.startsWith("-") || w === "-") return
      k++
      for (let j = 1; j < w.length; j++) {
        const c = w[j]!
        if (SSH_VALUE_LETTERS.includes(c)) {
          opts.push([c, j + 1 < w.length ? w.slice(j + 1) : (args[k++] ?? "")])
          break
        }
        opts.push([c, null])
      }
    }
  }
  options()
  let host = ""
  if (k < args.length) {
    host = args[k++]!
    if (!ended) options()
  }
  return { opts, host, command: k < args.length ? args.slice(k) : null }
}

function sshReadOnly(args: readonly string[]): boolean {
  const { opts, host } = sshParse(args)
  return (
    host !== "" &&
    opts.every(
      ([c, v]) =>
        (v === null && SSH_SAFE_FLAGS.includes(c)) ||
        (v !== null && SSH_SAFE_VALUES.includes(c)) ||
        // Asks a master whether it's up, and changes nothing.
        (c === "O" && v === "check") ||
        (c === "o" && SSH_SAFE_KEYS.has(optionKey(v))),
    )
  )
}

/** What an ssh part's remote command is, read on its own and named with its host; null for a login. */
function remoteKind(part: SimpleCommand): Kind | null {
  const remote = remoteOf(part)
  if (!remote) return null
  const { host, read } = remote
  if (read.unreadable) return { readOnly: false, runsCode: false, risk: `on ${host}: ${read.unreadable}` }
  const kinds = read.parts.map(classify)
  const risky = kinds.find((k) => k.risk !== null)
  return {
    readOnly: kinds.every((k) => k.readOnly),
    runsCode: kinds.some((k) => k.runsCode),
    risk: risky ? `on ${host}: ${risky.risk}` : null,
  }
}

// ---- Pushes and connections ----

/** A branch name a push may name plainly: no ref namespace, `HEAD`, glob or expansion. */
function plainBranch(branch: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(branch) && !/^[-/]/.test(branch) && !branch.endsWith("/") && !branch.endsWith(".lock") &&
    !branch.includes("..") && !branch.includes("//") && !/^(refs|heads|tags|remotes)\//i.test(branch) &&
    branch.toUpperCase() !== "HEAD"
  )
}

/** Whether a push's destination is, or git expands it to, the default branch: `main` or `master` in any case,
 *  with or without `heads/` or `refs/heads/`. */
function defaultBranch(dst: string): boolean {
  return ["main", "master"].includes(dst.replace(/^(refs\/)?heads\//i, "").toLowerCase())
}

/** Whether a part redirects to or from `/dev/tcp` or `/dev/udp`, which bash opens as a network connection. */
function connects(part: SimpleCommand): boolean {
  return [...part.reads, ...part.writes].some((target) => /^\/dev\/(tcp|udp)\//.test(target))
}

// ---- Credentials and paths ----

/** An ssh, scp or sftp command's words without the identity files it authenticates with. */
function withoutIdentity(words: readonly string[]): string[] {
  const out: string[] = []
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    if (w === "-i" || (w === "-o" && SSH_IDENTITY_KEYS.has(optionKey(words[k + 1] ?? "")))) k++
    else if (w.startsWith("-i") && w.length > 2) continue
    else if (!(w.startsWith("-o") && SSH_IDENTITY_KEYS.has(optionKey(w.slice(2))))) out.push(w)
  }
  return out
}

/** The first word through which a program may read a file the reader can't see: a content reader's operand or
 *  path option (`READER_OPTIONS`) given by a parameter, command or arithmetic expansion; a `<` file so named or a
 *  process substitution; an expanded here-string or here-document; or what `source` or `.` runs. */
function throughExpansion(part: SimpleCommand): string | null {
  const fed = part.reads.find((file) => file.includes("$") || file.startsWith("<(")) ??
    part.data.find((d) => d.substituted)?.text
  if (fed !== undefined) return fed
  return readOperand(part, (_, at) => part.substituted[at] === true)
}

/** The first relative path a part reads the contents of, as a file (a `<` file, a content reader's operand or path
 *  option, what `source` runs) or as a folder it reads recursively, or null. A path given by an expansion is
 *  `throughExpansion`'s. */
function relativeRead(part: SimpleCommand): string | null {
  const relative = (path: string) => path !== "" && path !== "-" && !/^[/~<]/.test(path) && !path.includes("$")
  const file = part.reads.find(relative)
  if (file !== undefined) return file
  const tree = recursivePaths(part).find(({ path, expanded }) => !expanded && relative(path))
  if (tree !== undefined) return tree.path
  return readOperand(part, (path) => relative(path))
}

/** The first word through which a content reader (`READER_OPTIONS`, `CONTENT_READERS`, `source`, `dd`) reads a
 *  file whose path `counts`: an operand or a path option's value, given with the index of the word that holds it. */
function readOperand(part: SimpleCommand, counts: (path: string, at: number) => boolean): string | null {
  const { start } = unwrap(part)
  const [prog = "", ...args] = part.words.slice(start)
  const name = base(prog)
  const sub = (k: number, path = args[k] ?? "") => counts(path, start + 1 + k)
  if (name === "source" || name === ".") return args.find((_, k) => sub(k)) ?? null
  if (name === "dd") return args.find((w, k) => w.startsWith("if=") && sub(k, w.slice(3))) ?? null
  const options = READER_OPTIONS[name] ?? (CONTENT_READERS.has(name) ? NO_OPTIONS : null)
  if (!options) return null
  const { value, longs, paths, pathLongs, given, givenLongs = [], onlyPaths } = options
  let pattern = given !== undefined && !args.some((w) => short(w, given, value) || long(w, ...givenLongs))
  let ended = false
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!
    if (!ended && w === "--") ended = true
    else if (!ended && w.startsWith("--") && w.length > 2) {
      const key = w.split("=")[0]!
      const reads = pathLongs.includes(key)
      if (w.includes("=")) {
        if (reads && sub(k, w.slice(key.length + 1))) return w
      } else if (longs.includes(key) || reads) {
        if (reads && sub(k + 1)) return args[k + 1] ?? null
        k++
      }
    } else if (!ended && w.startsWith("-") && w.length > 1) {
      const at = [...w.slice(1)].findIndex((c) => value.includes(c))
      if (at < 0) continue
      const reads = paths.includes(w[at + 1]!)
      if (at < w.length - 2) {
        if (reads && sub(k, w.slice(at + 2))) return w // the value is the rest of the word
      } else {
        if (reads && sub(k + 1)) return args[k + 1] ?? null
        k++
      }
    } else if (pattern) pattern = false
    else if (!onlyPaths && sub(k)) return w
  }
  return null
}
function isCredential(word: string, cwd?: string, marked: readonly string[] = []): boolean {
  return [word, ...joinedValues(word)].some((path) => credentialPath(path, cwd, marked))
}

/** The paths a word may carry joined to an option or a key: `--opt=PATH`, `-oPATH`, `key=PATH`, `@PATH`. */
function joinedValues(word: string): string[] {
  const values: string[] = []
  const keyed = /^(--?[A-Za-z0-9][\w-]*|[A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(word)
  if (keyed) values.push(keyed[2]!)
  if (/^-[A-Za-z]./.test(word) && !word.startsWith("--")) values.push(word.slice(2))
  if (word.startsWith("@")) values.push(word.slice(1))
  return values
}

/** Whether a path names a credential, in any case: macOS's default filesystem ignores case, and on Linux matching
 *  regardless of case only asks more. */
function credentialPath(word: string, cwd?: string, marked: readonly string[] = []): boolean {
  const literal = !word.includes("$")
  const name = word.slice(word.lastIndexOf("/") + 1).toLowerCase()
  if (literal && name.endsWith(".pub")) return false
  const path = lower(segments(word, cwd))
  // A glob, or an expansion written from `/` or a home, that starts at `/` or a home may reach any credential
  // folder; a relative `$X` alone, an argument like any other, doesn't.
  const open = path.findIndex((segment) => /[*?]/.test(segment))
  const globs = /[*?[]|\{[^}]*\}/.test(word.replace(/\$\{[^}]*\}/g, ""))
  const written = /^([/~]|\$HOME\b|\$\{HOME\})/.test(word)
  const start = path.slice(0, open)
  const top = start.length === 1 ? start[0] === "" || start[0] === "~" : start.length === 2 && start[0] === "" &&
    (start[1] === "home" || start[1] === "users")
  const rooted = open >= 0 && (globs || written) && top
  const mine = marked.map((m) => lower(segments(m)))
  const known = CREDENTIALS.flatMap(({ at }) => (at ? [at.toLowerCase().split("/")] : []))
  if (rooted && [...known, ...mine].some((folder) => couldMatch(path, [...folder, "**"], false))) return true
  if (mine.some((m) => couldMatch(path, [...m, "**"], true))) return true
  return CREDENTIALS.some(({ path: pattern, except }) => {
    if (pattern.startsWith("$")) return word.includes(pattern) || word.includes(`\${${pattern.slice(1)}`)
    if (literal && !/[*?[{]/.test(name) && except?.some((e) => overlap(name, e.toLowerCase()))) return false
    return couldMatch(path, pattern.toLowerCase().split("/"), true)
  })
}

function lower(segments: readonly string[]): string[] {
  return segments.map((s) => s.toLowerCase())
}
/** Whether a folder a program reads recursively is a credential folder (`at`, or one the host marks), is under
 *  one, or holds one: `~`, `/`, `/home` or a `..` path that climbs to them; or, when `expanded` (strict and given
 *  by an expansion), any. A relative path with no `cwd` counts only when it climbs. */
function holdsCredentials(word: string, cwd?: string, marked: readonly string[] = [], expanded = false): boolean {
  if (expanded) return true // its value can't be seen
  const path = lower(segments(word, cwd, false))
  if (path[0] !== "" && path[0] !== "~" && cwd === undefined) return path[0] === ".."
  const below = [...path, "**"]
  const folders = [...CREDENTIALS.flatMap(({ at }) => (at ? [at] : [])), ...HOMES].map((f) => f.toLowerCase().split("/"))
  return [...folders, ...marked.map((m) => lower(segments(m)))].some((f) => couldMatch(below, [...f, "**"], false))
}
/** The paths a part reads recursively, file contents and all, with whether an expansion gives each, or none: `grep -r`, `rg`, `diff -r`,
 *  `git diff --no-index`, `tar`, `zip`, `rsync`, `cp -r`, `scp -r`, and `find` running a command with `-exec`. */
function recursivePaths(part: SimpleCommand): readonly { path: string; expanded: boolean }[] {
  const { start } = unwrap(part)
  const given = part.words.filter((w, i) => i > start && part.substituted[i])
  return recursiveWords(part).map((path) => ({
    path, expanded: given.some((w) => path === w || path.startsWith(`${w}/`) || path.endsWith(`/${w}`)),
  }))
}

function recursiveWords(part: SimpleCommand): readonly string[] {
  const [prog = "", ...args] = programOf(part)
  const name = base(prog)
  // A search's first operand is its pattern, unless -e or -f gives it; with no path it reads the folder it is in.
  const searched = (value: string, valueLongs: readonly string[]) => {
    const found = operands(args, value, valueLongs)
    const given = args.some((w) => short(w, "ef", value) || long(w, "--regexp", "--file"))
    const paths = given ? found : found.slice(1)
    return paths.length > 0 ? paths : ["."]
  }
  switch (name) {
    case "grep":
    case "egrep":
    case "fgrep": {
      const recursive = args.some(
        (w, k) =>
          short(w, "rR", "efmABCdD") || long(w, "--recursive", "--dereference-recursive") || w === "-drecurse" ||
          w === "--directories=recurse" || ((w === "-d" || w === "--directories") && args[k + 1] === "recurse"),
      )
      return recursive ? searched("efmABCdD", GREP_VALUES) : []
    }
    case "rg":
    case "ag":
    case "ack":
      return searched("efgtTmAB", GREP_VALUES)
    case "diff":
      return args.some((w) => short(w, "r", DIFF_VALUES) || long(w, "--recursive")) ? operands(args, DIFF_VALUES, []) : []
    case "git": {
      const git = gitArgs(args)
      if (!(git.sub === "diff" || git.sub === "grep") || !git.rest.some((w) => long(w, "--no-index"))) return []
      const dir = git.options.find(([o]) => o === "-C")?.[1]
      const paths = operands(git.rest, "", [])
      const read = git.sub === "grep" ? (paths.length > 1 ? paths.slice(1) : ["."]) : paths
      return read.map((p) => (dir && !/^[/~$]/.test(p) ? `${dir}/${p}` : p))
    }
    case "tar":
    case "zip":
    case "rsync":
      return args.filter((w) => !w.startsWith("-"))
    case "cp":
    case "scp":
      const recursive = args.some((w) => short(w, "rRa", "") || long(w, "--recursive", "--archive"))
      return recursive ? operands(args, "tS", []) : []
    case "find": {
      if (innerParts(part).length === 0) return []
      let k = 0
      while (k < args.length && /^-([HLPD]|O\d*)$/.test(args[k]!)) k += args[k] === "-D" ? 2 : 1
      const starts = args.slice(k)
      const end = starts.findIndex((w) => /^[-(!]/.test(w))
      const paths = starts.slice(0, end < 0 ? starts.length : end)
      return paths.length > 0 ? paths : ["."]
    }
    default:
      return []
  }
}

/** A path's folders and name, from `cwd` when it is relative and `cwd` is known, with `.` and empty names dropped,
 *  `..` collapsed where it can be, a brace and (when `expand`) an expansion read as `*`, and a home (`~`, `$HOME`,
 *  `/home/u`) as `~`; a leading "" marks an absolute path. */
function segments(word: string, cwd?: string, expand = true): string[] {
  const homed = word.replace(/^(\$HOME|\$\{HOME\}|~[A-Za-z0-9._-]*)(?=\/|$)/, "~")
  const full = cwd !== undefined && !/^[/~]/.test(homed) ? `${cwd}/${homed}` : homed
  const out: string[] = full.startsWith("/") ? [""] : []
  const unexpanded = expand
    ? full.replace(/\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/g, "*")
    : full
  const globbed = unexpanded.replace(/\{[^}]*\}/g, "*")
  for (const part of globbed.split("/")) {
    if (part === "" || part === ".") continue
    const last = out.at(-1)
    if (part !== "..") out.push(part)
    else if (last === "") continue
    else if (last === "~") out.splice(0, out.length, "") // above a home: read as the root, which holds them all
    else if (last !== undefined && last !== ".." && !/[*?[]/.test(last)) out.pop()
    else out.push(part)
  }
  // Every user's home reads as `~`.
  const top = out[1]?.toLowerCase()
  if (out[0] === "" && (top === "home" || top === "users") && out.length > 2) out.splice(0, 3, "~")
  else if (out[0] === "" && top === "root") out.splice(0, 2, "~")
  return out
}

/** Whether a path glob's expansions could include a match of `pattern`, and when `named`, one in which some literal
 *  part of the path names a folder or file of the pattern: a bare `*` matches any name, so alone it names none.
 *  `**` in either is any folders. Row `i` holds, for each `j`, whether `path` from `i` and `pattern` from `j` can
 *  match at all (`any`) and with such a part (`named`); rows are filled from the end. */
function couldMatch(path: readonly string[], pattern: readonly string[], named: boolean): boolean {
  let any: boolean[] = []
  let naming: boolean[] = []
  for (let i = path.length; i >= 0; i--) {
    const rowAny: boolean[] = []
    const rowNamed: boolean[] = []
    const name = path[i]?.replace(/\[[^\]]*\]/g, "?")
    rowAny[pattern.length] = i === path.length || (name === "**" && any[pattern.length]!)
    rowNamed[pattern.length] = name === "**" && naming[pattern.length]!
    for (let j = pattern.length - 1; j >= 0; j--) {
      if (pattern[j] === "**") {
        rowAny[j] = rowAny[j + 1]! || (name !== undefined && any[j]!)
        rowNamed[j] = rowNamed[j + 1]! || (name !== undefined && naming[j]!)
      } else if (name === undefined) {
        rowAny[j] = rowNamed[j] = false
      } else if (name === "**") {
        rowAny[j] = any[j]! || rowAny[j + 1]!
        rowNamed[j] = naming[j]! || rowNamed[j + 1]!
      } else {
        const fits = any[j + 1]! && overlap(name, pattern[j]!)
        rowAny[j] = fits
        rowNamed[j] = fits && (naming[j + 1]! || overlap(name.replaceAll("*", ""), pattern[j]!))
      }
    }
    any = rowAny
    naming = rowNamed
  }
  return named ? naming[0]! : any[0]!
}

/** Whether two names with `*` and `?` can match one string, filled from the end as `couldMatch` is. */
function overlap(a: string, b: string): boolean {
  let next: boolean[] = []
  for (let i = a.length; i >= 0; i--) {
    const row: boolean[] = []
    row[b.length] = i === a.length || (a[i] === "*" && next[b.length]!)
    for (let j = b.length - 1; j >= 0; j--) {
      if (i === a.length) row[j] = b[j] === "*" && row[j + 1]!
      else if (a[i] === "*") row[j] = next[j]! || row[j + 1]!
      else if (b[j] === "*") row[j] = row[j + 1]! || next[j]!
      else row[j] = (a[i] === "?" || b[j] === "?" || a[i] === b[j]) && next[j + 1]!
    }
    next = row
  }
  return next[0]!
}

/** `p` resolved against `cwd`, with `.` and `..` collapsed (lexically: links aren't followed). */
function resolve(cwd: string, p: string): string {
  const out: string[] = []
  for (const seg of (p.startsWith("/") ? p : `${cwd}/${p}`).split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") out.pop()
    else out.push(seg)
  }
  return `/${out.join("/")}`
}

function inside(p: string, root: string, strict: boolean): boolean {
  if (p === root) return !strict
  return p.startsWith(root === "/" ? "/" : `${root}/`)
}
