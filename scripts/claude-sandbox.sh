#!/usr/bin/env bash
# claude-sandbox.sh — launch Claude Code inside a bubblewrap (bwrap) sandbox.
#
# Used by the "Sandbox" session option (Linux only). The sandboxed process
# sees:
#   read-only:   /usr, /etc (and the /run directory its resolver files link
#                into), the resolved claude binary's directory, the resolved
#                node interpreter's directory, $NVM_DIR, and the podman API
#                socket when one is live
#   read-write:  the project directory (cwd), Claude's own state
#                (~/.claude's entries, ~/.config/claude, ~/.cache/claude,
#                ~/.local/share/claude), and any extra directories passed via
#                $SWITCHBOARD_SANDBOX_BINDS (colon-separated — Switchboard
#                forwards "Additional Directories" and the project root here;
#                paths containing ':' or a newline cannot be transported and
#                are dropped on the app side)
#   protected:   what an unsandboxed claude or git would later run — every
#                entry of ~/.claude and of each bound directory's .claude
#                that is not listed session state, a private copy of
#                ~/.claude.json, each repository's config and hooks
#   network:     shared with the host — Claude needs the API, and the
#                Switchboard IDE bridge listens on localhost
#
# Everything else — the rest of $HOME in particular — does not exist inside
# the sandbox. This is a FILESYSTEM boundary only: environment variables are
# inherited (no --clearenv) and the network namespace is the host's.
# See docs/sandbox.md for the full isolation contract, and for what the
# protection above does not cover.
#
# Host side effects: none until the sandbox is known to be constructible. The
# bwrap pre-flight runs against what already exists, and only after it passes
# are missing directories created (a mount needs an existing mount point).
# A launch that bwrap refuses outright leaves $HOME untouched.
#
# Debugging: set SWITCHBOARD_SANDBOX_DEBUG=1 to print the resolved binary,
# every bind, and the full bwrap invocation before launch. From Switchboard,
# put `SWITCHBOARD_SANDBOX_DEBUG=1` in the session's Pre-launch Command.
#
# Usage: claude-sandbox.sh [claude args...]

set -u

DEBUG="${SWITCHBOARD_SANDBOX_DEBUG:-0}"
debug() { [ "$DEBUG" = "1" ] && echo "claude-sandbox: $*" >&2; return 0; }
fail() { echo "claude-sandbox: $*" >&2; exit 125; }

if ! command -v bwrap >/dev/null 2>&1; then
  fail "bwrap not found — install bubblewrap (e.g. apt install bubblewrap)"
fi

# type -P does a PATH search only, so a shell function, alias or builtin named
# "claude" cannot be mistaken for a path — `command -v` reports those as a bare
# word ("claude") or as "alias claude='...'", neither of which is executable.
# Switchboard launches us from `bash -l -i -c`, so the user's profile really is
# in play and wrappers around claude are common. Fall back to command -v so a
# genuinely odd setup still gets the old behaviour rather than a hard stop.
CLAUDE_BIN="$(type -P claude 2>/dev/null || true)"
[ -n "$CLAUDE_BIN" ] || CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [ -z "$CLAUDE_BIN" ]; then
  fail "claude not found in PATH ($PATH)"
fi

# readlink -f prints NOTHING and exits non-zero when a non-final component of
# the path is missing. Unvalidated, that empty string reached bwrap as the
# program to exec, and bwrap reported it as the useless
# "bwrap: execvp : No such file or directory" — an empty program name.
CLAUDE_REAL="$(readlink -f "$CLAUDE_BIN" 2>/dev/null || true)"
[ -n "$CLAUDE_REAL" ] || CLAUDE_REAL="$CLAUDE_BIN"
if [ ! -f "$CLAUDE_REAL" ] || [ ! -x "$CLAUDE_REAL" ]; then
  fail "resolved claude is not an executable file: '$CLAUDE_REAL' (resolved from '$CLAUDE_BIN'). If 'claude' is a shell function or alias wrapping the real binary, put that binary on PATH — the sandbox has to exec a file, not a shell construct."
fi
debug "claude: $CLAUDE_BIN -> $CLAUDE_REAL"
debug "bwrap: $(command -v bwrap) ($(bwrap --version 2>/dev/null || echo 'version unknown'))"

# Refuse to be someone's very first claude launch: the CLI's first run creates
# and initialises ~/.claude and ~/.claude.json, and doing that through a bind
# list we had to invent up front is how you get a half-seeded config. Run
# claude once unsandboxed, then turn the option on.
if [ ! -e "$HOME/.claude" ]; then
  fail "$HOME/.claude does not exist — run claude once outside the sandbox first, then enable Sandbox mode"
fi

CLAUDE_DIR="$HOME/.claude"
RW_STATE_DIRS=(
  "$HOME/.config/claude"
  "$HOME/.cache/claude"
  "$HOME/.local/share/claude"
)
CLAUDE_JSON="$HOME/.claude.json"

# The only entries of a .claude directory the sandbox can write; every other
# one is read-only. See docs/sandbox.md, "What the sandbox protects".
USER_STATE_ENTRIES=(
  todos statsig file-history sessions plans tasks cache paste-cache
  image-cache downloads feedback debug telemetry jobs usage-data agent-memory
  .credentials.json history.jsonl .last-cleanup .last-update-result.json
  mcp-needs-auth-cache.json policy-limits.json policy-limits.json.stamp.json
  stats-cache.json
)
# Files in these are sourced or restored by other, unsandboxed sessions: the
# sandbox gets an empty private directory in their place.
USER_PRIVATE_ENTRIES=(shell-snapshots session-env backups state)
PROJECT_STATE_ENTRIES=(worktrees agent-memory agent-memory-local)
# Created in ~/.claude before launch when missing, so that they are mounted
# from the host rather than left to the tmpfs.
USER_PRECREATED_DIRS=(projects todos statsig file-history sessions plans tasks ide)

# Project directory plus whatever Switchboard forwarded. These must already
# exist — creating a mistyped "Additional Directory" on the host would be worse
# than not binding it.
RW_DIRS=("$PWD")
if [ -n "${SWITCHBOARD_SANDBOX_BINDS:-}" ]; then
  # -d '' reads to NUL rather than newline, so a bind path containing a newline
  # is not silently truncated at the first one. read exits non-zero when it
  # never finds the delimiter; the array is populated regardless.
  EXTRA_BINDS=()
  IFS=':' read -r -d '' -a EXTRA_BINDS < <(printf '%s' "$SWITCHBOARD_SANDBOX_BINDS") || true
  for d in "${EXTRA_BINDS[@]}"; do
    [ -n "$d" ] && RW_DIRS+=("$d")
  done
fi

# Binding $HOME — or any ancestor of it, up to / — would expose the exact thing
# this sandbox exists to hide, while still reporting success. No project
# directory is ever legitimately $HOME or above, so in practice this means the
# session was launched with the wrong working directory. Fail closed and say so:
# a sandbox that silently hands out the whole home directory is worse than none,
# because the user believes they are protected.
for d in ${RW_DIRS[@]+"${RW_DIRS[@]}"}; do
  _bad=""
  case "$d" in
    /) _bad="the filesystem root" ;;
  esac
  case "$HOME" in
    "$d") _bad="\$HOME itself" ;;
    "$d"/*) _bad="a parent of \$HOME" ;;
  esac
  if [ -n "$_bad" ]; then
    fail "refusing to bind '$d' — it is $_bad, so the sandbox would expose everything it is meant to hide. Expected a project directory; the session's working directory is '$PWD'."
  fi
done

# see docs/sandbox.md ("Additional directories")
for d in ${EXTRA_BINDS[@]+"${EXTRA_BINDS[@]}"}; do
  [ -n "$d" ] || continue
  for _form in "$(realpath -m -s -- "$d")" "$(readlink -m -- "$d")"; do
    case "/$_form/" in
      */.claude/*|*/.git/*)
        fail "refusing to bind '$d' — it is at or inside a .claude or .git directory, which the sandbox keeps read-only. Bind the project directory instead."
        ;;
    esac
  done
done

# True when $1 is at or below one of the read-write state dirs.
under_rw_state() {
  local candidate="$1/" d
  for d in "${RW_STATE_DIRS[@]}"; do
    case "$candidate" in "$d"/*) return 0 ;; esac
  done
  return 1
}

CLAUDE_BIN_DIR="$(dirname "$CLAUDE_REAL")"
RO_DIRS=()
# The native installer keeps versioned binaries under ~/.local/share/claude,
# which is bound read-write for claude's own updates — a read-only bind of the
# binary's directory would be overridden by it. Skip the bind rather than
# imply a guarantee we cannot keep (see docs/sandbox.md).
if under_rw_state "$CLAUDE_BIN_DIR"; then
  debug "claude binary dir $CLAUDE_BIN_DIR lives under Claude's state dirs — writable inside the sandbox"
else
  RO_DIRS+=("$CLAUDE_BIN_DIR")
fi
if [ -d "${NVM_DIR:-$HOME/.nvm}" ]; then
  RO_DIRS+=("${NVM_DIR:-$HOME/.nvm}")
fi

# The claude entrypoint is often a node script (#!/usr/bin/env node), so the
# node that will run it must exist inside the sandbox too. Version managers
# other than nvm (fnm, volta, asdf, n) keep node outside $NVM_DIR — bind the
# resolved interpreter's directory wherever it lives. Absent node is fine: the
# native installer ships a self-contained binary that needs no interpreter.
NODE_BIN="$(type -P node 2>/dev/null || true)"
if [ -n "$NODE_BIN" ]; then
  RO_DIRS+=("$(dirname "$(readlink -f "$NODE_BIN")")")
  debug "node: $NODE_BIN"
else
  debug "node not on PATH — skipping (fine unless claude is a node script)"
fi

# Don't assume the interpreter is node. claude may be installed via npm, bun,
# or a distro package, so read the shebang of whatever we actually resolved and
# bind that interpreter. A missing interpreter is the one case where the launch
# is doomed but the wrapper itself cannot tell — warn loudly instead of letting
# it surface as an opaque exec failure inside the sandbox.
if [ "$(head -c 2 "$CLAUDE_REAL" 2>/dev/null)" = '#!' ]; then
  IFS=' ' read -r _shebang_cmd _shebang_arg _ < <(head -n 1 "$CLAUDE_REAL" 2>/dev/null | sed 's/^#!//')
  if [ "$(basename "${_shebang_cmd:-}")" = 'env' ]; then
    _interp="${_shebang_arg:-}"
  else
    _interp="${_shebang_cmd:-}"
  fi
  if [ -n "$_interp" ]; then
    _interp_path="$(type -P "$_interp" 2>/dev/null || true)"
    case "$_interp" in /*) [ -n "$_interp_path" ] || _interp_path="$_interp" ;; esac
    if [ -n "$_interp_path" ] && [ -e "$_interp_path" ]; then
      RO_DIRS+=("$(dirname "$(readlink -f "$_interp_path")")")
      debug "claude is a script; interpreter $_interp -> $_interp_path"
    else
      echo "claude-sandbox: warning: claude is a script needing '$_interp', which is not on PATH — it will not exist inside the sandbox" >&2
    fi
  fi
fi

# Podman's API socket lets the session start a container with any host path
# mounted, so it is bound only on request; see docs/sandbox.md.
PODMAN_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman"
if [ "${SWITCHBOARD_SANDBOX_PODMAN:-0}" = "1" ]; then
  if command -v podman >/dev/null 2>&1 && [ -S "$PODMAN_DIR/podman.sock" ]; then
    RO_DIRS+=("$PODMAN_DIR")
    debug "podman socket live, binding $PODMAN_DIR read-only (SWITCHBOARD_SANDBOX_PODMAN=1)"
  else
    debug "SWITCHBOARD_SANDBOX_PODMAN=1 but no live podman socket at $PODMAN_DIR"
  fi
fi

# The sandbox shares the terminal's session (no --new-session: see
# docs/sandbox.md), so it relies on the kernel refusing TIOCSTI.
if [ -r /proc/sys/dev/tty/legacy_tiocsti ] && [ "$(cat /proc/sys/dev/tty/legacy_tiocsti 2>/dev/null)" = "1" ]; then
  echo "claude-sandbox: warning: dev.tty.legacy_tiocsti=1 — a sandboxed process can type into this terminal. Set it to 0 (sysctl dev.tty.legacy_tiocsti=0)." >&2
fi

# Transcripts go to ~/.claude/projects/<folder>, the folder being the CLI's
# encoding of the working directory. Only that folder is writable.
PROJECT_FOLDER="${SWITCHBOARD_SANDBOX_PROJECT_FOLDER:-}"
if [ -n "$PROJECT_FOLDER" ]; then
  case "$PROJECT_FOLDER" in
    *[!A-Za-z0-9-]*) fail "SWITCHBOARD_SANDBOX_PROJECT_FOLDER is not a project folder name: '$PROJECT_FOLDER'" ;;
  esac
else
  PROJECT_FOLDER="${PWD//[^a-zA-Z0-9]/-}"
  if [ "${#PROJECT_FOLDER}" -gt 200 ]; then
    fail "the working directory's path is too long to name its transcript folder here; launch the session from Switchboard, which passes the name"
  fi
fi

# The host paths the sandbox can write, as bound, and their resolved form.
WRITABLE_ROOTS=("$CLAUDE_DIR" "${RW_STATE_DIRS[@]}" "${RW_DIRS[@]}")
WRITABLE_REALS=()
for _r in "${WRITABLE_ROOTS[@]}"; do
  WRITABLE_REALS+=("$(readlink -f "$_r" 2>/dev/null || true)")
done

# Sets SV_VIEW to where the resolved host path $1 appears inside the sandbox,
# and SV_IDX to its writable root, when it lies under one; fails otherwise.
sandbox_view() {
  local target="$1" i real
  for i in "${!WRITABLE_ROOTS[@]}"; do
    real="${WRITABLE_REALS[i]}"
    [ -n "$real" ] || continue
    case "$target" in
      "$real") SV_VIEW="${WRITABLE_ROOTS[i]}"; SV_IDX=$i; return 0 ;;
      "$real"/*) SV_VIEW="${WRITABLE_ROOTS[i]}${target#"$real"}"; SV_IDX=$i; return 0 ;;
    esac
  done
  return 1
}

in_list() {
  local needle="$1" item
  shift
  for item in "$@"; do
    [ "$needle" = "$item" ] && return 0
  done
  return 1
}

# Every mount goes through here; they are emitted shallowest destination first.
mount_op() {
  M_OP+=("$1"); M_SRC+=("$2"); M_DEST+=("$3")
  MOUNTED["$3"]="$1"
  [ "$DEBUG" = "1" ] || return 0
  local from=""
  [ -n "$2" ] && [ "$2" != "$3" ] && from=" (from $2)"
  case "$1" in
    --bind) debug "rw-bind $3$from" ;;
    --ro-bind) debug "ro-bind $3$from" ;;
    *) debug "${1#--} ${2:+$2 }$3" ;;
  esac
}

# True when the nearest mount at or above sandbox path $1 is read-only.
inside_ro_area() {
  local p="$1"
  while [ -n "$p" ]; do
    if [ -n "${MOUNTED[$p]:-}" ]; then
      [ "${MOUNTED[$p]}" = --ro-bind ]
      return
    fi
    p="${p%/*}"
  done
  return 1
}

# Fails when resolving path $1 goes through a symbolic link that sits in a
# directory the sandbox can write: the session could re-point it.
check_chain() {
  local orig="$1" rest="$1" cur="" comp link hops=0
  case "$rest" in /*) ;; *) rest="$PWD/$rest" ;; esac
  while [ -n "$rest" ]; do
    comp="${rest%%/*}"
    if [ "$comp" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
    case "$comp" in
      ""|.) continue ;;
      ..) cur="${cur%/*}"; continue ;;
    esac
    if [ -L "$cur/$comp" ]; then
      hops=$((hops + 1))
      [ "$hops" -le 40 ] || return 0
      if sandbox_view "${cur:-/}" && ! inside_ro_area "$SV_VIEW/$comp"; then
        fail "refusing to launch: $cur/$comp is a symbolic link in a directory the sandbox can write, on the way to $orig, which it protects; the session could re-point it. Replace the link with what it points to (for git hooks, set core.hooksPath to that directory instead), or turn Sandbox off for this session."
      fi
      link="$(readlink "$cur/$comp")"
      case "$link" in /*) cur="" ;; esac
      rest="$link${rest:+/$rest}"
    else
      cur="$cur/$comp"
    fi
  done
}

# Mounts the resolved host path $1 read-only where the sandbox sees it, when
# it lies under a writable root, and remembers it for the pins below.
protect_resolved() {
  local real="$1"
  [ -n "${PROTECTED_SEEN[$real]:-}" ] && return 1
  PROTECTED_SEEN["$real"]=1
  sandbox_view "$real" || { debug "$real is not visible in the sandbox"; return 1; }
  mount_op --ro-bind "$real" "$SV_VIEW"
  PIN_VIEWS+=("$SV_VIEW"); PIN_IDX+=("$SV_IDX")
  return 0
}

# Link $1, resolved to $2: its target read-only, and every link below that
# target when it is a directory.
protect_resolved_link() {
  local link="$1" target="$2" text="${3-}"
  [ -n "$target" ] && [ -e "$target" ] || return 0
  [ -n "$text" ] || text="$(readlink "$link")"
  case "$text" in /*) ;; *) text="${link%/*}/$text" ;; esac
  check_chain "$text"
  if protect_resolved "$target" && [ -d "$target" ]; then
    protect_links_below "$target"
  fi
}

protect_link_target() {
  protect_resolved_link "$1" "$(realpath -m -- "$1" 2>/dev/null || true)"
}

# Every symbolic link at any depth below directory $1, resolved in one call.
protect_links_below() {
  local -a found=() links=() texts=() targets=()
  local i
  mapfile -d '' found < <(find "$1" -mindepth 1 -type l -printf '%p\0%l\0' 2>/dev/null)
  for ((i = 0; i + 1 < ${#found[@]}; i += 2)); do
    links+=("${found[i]}"); texts+=("${found[i+1]}")
  done
  [ "${#links[@]}" -gt 0 ] || return 0
  mapfile -d '' targets < <(realpath -z -m -- "${links[@]}" 2>/dev/null)
  if [ "${#targets[@]}" -ne "${#links[@]}" ]; then
    for i in "${!links[@]}"; do protect_link_target "${links[i]}"; done
    return 0
  fi
  for i in "${!links[@]}"; do
    protect_resolved_link "${links[i]}" "${targets[i]}" "${texts[i]}"
  done
}

# A symlinked state entry of ~/.claude is followed only to a target of the
# same kind and name, and never to $HOME or a parent of it.
bind_state_link_target() {
  local link="$1" name="${1##*/}" target
  target="$(readlink -f "$link" 2>/dev/null)" || return 0
  [ -n "$target" ] && [ -e "$target" ] || { debug "state link $link dangles"; return 0; }
  case "$HOME/" in
    "$target"/*) fail "refusing to launch: $link links to $target, which contains \$HOME, so binding it would expose everything the sandbox hides. Point the link at a directory of its own." ;;
  esac
  if [ "${target##*/}" != "$name" ] || { [ "$2" = dir ] && [ ! -d "$target" ]; } || { [ "$2" = file ] && [ ! -f "$target" ]; }; then
    fail "refusing to launch: $link links to $target. A symbolic link in ~/.claude is followed only to a $2 of the same name ($name), elsewhere; point it at one, or turn Sandbox off for this session."
  fi
  mount_op "${3:---bind}" "$target" "$target"
  STATE_LINK_TARGET="$target"
}

# ~/.claude transcripts: the whole directory read-only, the session's own
# folder read-write.
bind_projects_dir() {
  local e="$1" base="$1"
  if [ -L "$e" ]; then
    mount_op --symlink "$(readlink "$e")" "$e"
    bind_state_link_target "$e" dir --ro-bind
    base="$STATE_LINK_TARGET"
  else
    mount_op --ro-bind "$e" "$e"
  fi
  if [ -L "$base/$PROJECT_FOLDER" ]; then
    fail "refusing to launch: $base/$PROJECT_FOLDER, this session's transcript folder, is a symbolic link"
  elif [ -d "$base/$PROJECT_FOLDER" ]; then
    mount_op --bind "$base/$PROJECT_FOLDER" "$base/$PROJECT_FOLDER"
  else
    MISSING_DIRS+=("$base/$PROJECT_FOLDER")
  fi
}

# ~/.claude becomes a private tmpfs: every entry that exists is bound back,
# read-write when listed as state, empty and private when listed as private,
# read-only otherwise. Anything created at its top level is discarded.
bind_user_claude_dir() {
  local dir="$1" e name restore_glob kind
  mount_op --tmpfs "" "$dir"
  restore_glob="$(shopt -p nullglob dotglob)"
  shopt -s nullglob dotglob
  for e in "$dir"/*; do
    name="${e##*/}"
    if [ "$name" = projects ]; then
      bind_projects_dir "$e"
    elif in_list "$name" "${USER_PRIVATE_ENTRIES[@]}"; then
      mount_op --tmpfs "" "$e"
    elif [ -L "$e" ]; then
      mount_op --symlink "$(readlink "$e")" "$e"
      if in_list "$name" "${USER_STATE_ENTRIES[@]}"; then
        case "$name" in *.json|*.jsonl|.last-*) kind=file ;; *) kind=dir ;; esac
        bind_state_link_target "$e" "$kind"
      else
        protect_link_target "$e"
      fi
    elif in_list "$name" "${USER_STATE_ENTRIES[@]}"; then
      mount_op --bind "$e" "$e"
    else
      mount_op --ro-bind "$e" "$e"
      [ -d "$e" ] && protect_links_below "$e"
    fi
  done
  eval "$restore_glob"
}

# A project's .claude is read-only as a whole, so that a write to anything not
# listed fails instead of landing in a tmpfs; the listed state is bound back
# read-write. A state entry that is a symbolic link is left as it is: it
# resolves only to what the sandbox can already see. ~/.claude cannot work this
# way: the CLI saves its top-level state files through a temporary file
# created next to them.
bind_project_claude_dir() {
  local dir="$1" e name restore_glob
  inside_ro_area "$dir" && return 0
  mount_op --ro-bind "$dir" "$dir"
  restore_glob="$(shopt -p nullglob dotglob)"
  shopt -s nullglob dotglob
  for e in "$dir"/*; do
    name="${e##*/}"
    if in_list "$name" "${PROJECT_STATE_ENTRIES[@]}"; then
      if [ -L "$e" ]; then
        debug "state link $e left as is"
      else
        mount_op --bind "$e" "$e"
      fi
    elif [ -L "$e" ]; then
      protect_link_target "$e"
    elif [ -d "$e" ]; then
      protect_links_below "$e"
    fi
  done
  eval "$restore_glob"
}

# Queues $1 for a read-only mount when the sandbox could otherwise write it,
# after checking the way to it. A missing path is created first when $2 is
# "dir".
protect_path() {
  local p="$1" real
  check_chain "$p"
  real="$(readlink -m -- "$p")"
  if [ -e "$real" ]; then
    protect_resolved "$real" || true
  elif [ "${2:-}" = dir ] && sandbox_view "$real"; then
    MISSING_DIRS+=("$real")
  fi
}

# What git runs on its own: the repository's config, its hooks directory and
# the one core.hooksPath names, and, for every linked worktree, the files that
# point git at the shared repository.
protect_git() {
  local d="$1" out git_dir common_dir hooks_dir w
  if ! command -v git >/dev/null 2>&1; then
    debug "git is not installed; $d/.git gets no further protection (git cannot run in the sandbox either)"
    return 0
  fi
  out="$(cd "$d" && env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
         git rev-parse --path-format=absolute --git-dir --git-common-dir --git-path hooks 2>/dev/null)" ||
    fail "refusing to launch: git cannot read the repository at $d, so the sandbox cannot tell which of its paths to protect. Check it with 'git -C $d rev-parse --git-dir'."
  if [ "$(printf '%s\n' "$out" | wc -l)" -ne 3 ]; then
    fail "refusing to launch: a git path of $d contains a newline (the repository, its git directory or core.hooksPath), so the sandbox cannot tell which paths to protect."
  fi
  { IFS= read -r git_dir; IFS= read -r common_dir; IFS= read -r hooks_dir; } <<<"$out"
  [ -n "${GIT_DONE[$d]:-}" ] && return 0
  GIT_DONE["$d"]=1
  protect_path "$common_dir/config"
  protect_path "$common_dir/config.worktree"
  protect_path "$common_dir/hooks" dir
  if [ "$hooks_dir" != "$common_dir/hooks" ]; then
    # git reports the hooks path resolved; the configured one is what a link
    # on the way could re-point.
    local configured
    configured="$(cd "$d" && env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE git config --get core.hooksPath 2>/dev/null || true)"
    case "$configured" in
      "") ;;
      /*) check_chain "$configured" ;;
      *) check_chain "$d/$configured" ;;
    esac
    protect_path "$hooks_dir" dir
  fi
  if [ -d "$common_dir/worktrees" ]; then
    for w in "$common_dir"/worktrees/*/; do
      [ -d "$w" ] || continue
      w="${w%/}"
      protect_path "$w/commondir"
      protect_path "$w/gitdir"
      protect_path "$w/config.worktree"
    done
  fi
}

# The .git and .claude of a directory, bound or found below one.
protect_repo_root() {
  local d="$1"
  if [ -L "$d/.git" ]; then
    fail "refusing to launch: $d/.git is a symbolic link. The sandbox protects the repository's config and hooks with read-only mounts, which cannot stop the link itself from being replaced. Turn Sandbox off for this session."
  elif [ -d "$d/.git" ]; then
    GIT_WORKTREES+=("$d")
  elif [ -e "$d/.git" ]; then
    mount_op --ro-bind "$d/.git" "$d/.git"
    GIT_WORKTREES+=("$d")
  fi
  protect_claude_dir "$d/.claude"
}

protect_claude_dir() {
  local c="$1"
  if [ -L "$c" ]; then
    fail "refusing to launch: $c is a symbolic link. The sandbox protects it with read-only mounts, which cannot stop the link itself from being replaced. Replace the link with the directory it points to, or turn Sandbox off for this session."
  elif [ -d "$c" ]; then
    bind_project_claude_dir "$c"
  elif [ -e "$c" ]; then
    mount_op --ro-bind "$c" "$c"
  elif [ -w "$(dirname "$c")" ]; then
    MISSING_DIRS+=("$c")
  fi
}

bind_project_dir() {
  local d="$1" n
  mount_op --bind "$d" "$d"
  [ -d "$d" ] || return 0
  protect_repo_root "$d"
  # Every .claude and repository below, worktrees included; see
  # docs/sandbox.md, "Git".
  while IFS= read -r -d '' n; do
    inside_ro_area "$n" && continue
    case "${n##*/}" in
      .claude) protect_claude_dir "$n" ;;
      .git) protect_repo_root "$(dirname "$n")" ;;
    esac
  done < <(find "$d" -xdev -mindepth 2 \( -name node_modules -prune \) -o \
             \( -name .git -print0 -prune \) -o \( -name .claude -type d -print0 \) -o \
             \( -name .claude -type l -print0 \) 2>/dev/null)
}

# Name resolution reads these; with systemd-resolved /etc/resolv.conf links
# into /run, which the sandbox does not otherwise see. Under /run the directory
# is bound, because the resolver replaces the file by a rename; elsewhere only
# the file.
ETC_LINKS=()
for f in /etc/resolv.conf /etc/hosts /etc/nsswitch.conf /etc/host.conf /etc/gai.conf; do
  [ -L "$f" ] || continue
  _target="$(readlink -f "$f" 2>/dev/null || true)"
  [ -n "$_target" ] && [ -e "$_target" ] || continue
  case "$_target" in
    /etc/*|/usr/*) continue ;;
    /run/*/*) _src="$(dirname "$_target")" ;;
    *) _src="$_target" ;;
  esac
  case "$HOME/" in "$_src"/*) debug "not binding $_src for $f: it contains \$HOME"; continue ;; esac
  in_list "$_src" ${ETC_LINKS[@]+"${ETC_LINKS[@]}"} && continue
  ETC_LINKS+=("$_src")
  debug "resolver: $_src (target of $f)"
done

# Shallowest first, so that a directory bound inside another one's .claude is
# processed after that .claude.
RW_DIRS_BY_DEPTH=()
for d in "${RW_DIRS[@]}"; do
  i=${#RW_DIRS_BY_DEPTH[@]}
  RW_DIRS_BY_DEPTH+=("$d")
  while [ "$i" -gt 0 ] && [ "${#RW_DIRS_BY_DEPTH[i-1]}" -gt "${#d}" ]; do
    RW_DIRS_BY_DEPTH[i]="${RW_DIRS_BY_DEPTH[i-1]}"
    i=$((i - 1))
  done
  RW_DIRS_BY_DEPTH[i]="$d"
done

# Every directory between a writable root and a protected path is mounted onto
# itself, so it cannot be renamed and replaced by one the session controls.
pin_protected_paths() {
  local k view idx root real comp host
  for k in ${PIN_VIEWS[@]+"${!PIN_VIEWS[@]}"}; do
    view="${PIN_VIEWS[k]}"; idx="${PIN_IDX[k]}"
    root="${WRITABLE_ROOTS[idx]}"; real="${WRITABLE_REALS[idx]}"
    comp="$root"
    local rest="${view#"$root"}"
    rest="${rest#/}"
    while [ "${rest%/*}" != "$rest" ]; do
      comp="$comp/${rest%%/*}"
      rest="${rest#*/}"
      [ -n "${MOUNTED[$comp]:-}" ] && continue
      inside_ro_area "$comp" && continue
      host="$real${comp#"$root"}"
      mount_op --bind "$host" "$comp"
    done
  done
}

# Fills BWRAP_ARGS from what exists now, and MISSING_DIRS with what must be
# created before the real launch. Run once for the pre-flight, then again once
# the missing directories exist.
build_bwrap_args() {
  M_OP=(); M_SRC=(); M_DEST=()
  MOUNTED=(); PROTECTED_SEEN=(); GIT_DONE=()
  PIN_VIEWS=(); PIN_IDX=()
  MISSING_DIRS=()
  GIT_WORKTREES=()
  local d name i
  mount_op --dev "" /dev
  mount_op --proc "" /proc
  mount_op --tmpfs "" /tmp
  mount_op --dir "" /var
  mount_op --ro-bind /usr /usr
  mount_op --ro-bind /etc /etc
  for d in ${ETC_LINKS[@]+"${ETC_LINKS[@]}"}; do mount_op --ro-bind "$d" "$d"; done
  mount_op --symlink usr/lib /lib
  mount_op --symlink usr/lib64 /lib64
  mount_op --symlink usr/bin /bin
  mount_op --symlink usr/sbin /sbin
  for d in ${RO_DIRS[@]+"${RO_DIRS[@]}"}; do
    if [ -e "$d" ]; then
      mount_op --ro-bind "$d" "$d"
    else
      debug "skip ro-bind $d (does not exist)"
    fi
  done
  for d in "${RW_DIRS_BY_DEPTH[@]}"; do
    if [ -e "$d" ]; then
      bind_project_dir "$d"
    elif [ "$REPORT_MISSING" = 1 ]; then
      echo "claude-sandbox: skipping bind — does not exist: $d" >&2
    fi
  done
  # Missing state paths are created after the pre-flight, not now — a launch
  # bwrap is going to refuse must not leave anything behind in $HOME.
  for d in "${RW_STATE_DIRS[@]}"; do
    if [ -e "$d" ]; then
      mount_op --bind "$d" "$d"
    else
      MISSING_DIRS+=("$d")
    fi
  done
  for name in "${USER_PRECREATED_DIRS[@]}"; do
    d="$CLAUDE_DIR/$name"
    [ -e "$d" ] || [ -L "$d" ] || MISSING_DIRS+=("$d")
  done
  bind_user_claude_dir "$CLAUDE_DIR"
  # fd 9 carries the private copy; see claude_json_source.
  mount_op --file 9 "$CLAUDE_JSON"
  for d in ${GIT_WORKTREES[@]+"${GIT_WORKTREES[@]}"}; do
    protect_git "$d"
  done
  pin_protected_paths

  BWRAP_ARGS=(--unshare-all --share-net --die-with-parent)
  local order
  while read -r _depth i; do
    case "${M_OP[i]}" in
      --tmpfs|--dev|--proc|--dir) BWRAP_ARGS+=("${M_OP[i]}" "${M_DEST[i]}") ;;
      *) BWRAP_ARGS+=("${M_OP[i]}" "${M_SRC[i]}" "${M_DEST[i]}") ;;
    esac
  done < <(for i in "${!M_DEST[@]}"; do
             order="${M_DEST[i]//[!\/]/}"
             printf '%d %d\n' "${#order}" "$i"
           done | sort -n -k1,1 -k2,2)
  BWRAP_ARGS+=(--chdir "$PWD" --setenv SHELL /bin/bash)
}

declare -A MOUNTED PROTECTED_SEEN GIT_DONE

# The copy of ~/.claude.json the sandbox starts from. An empty object, not an
# empty file, when there is none: claude parses this path as JSON.
claude_json_source() {
  if [ -f "$CLAUDE_JSON" ]; then cat "$CLAUDE_JSON"; else echo '{}'; fi
}

REPORT_MISSING=1
build_bwrap_args
REPORT_MISSING=0
debug "full command: bwrap ${BWRAP_ARGS[*]} $CLAUDE_REAL $*"

# Pre-flight: build the exact sandbox once around /bin/true so mount/namespace
# problems surface as bwrap's own error message instead of a claude crash.
if ! PREFLIGHT_ERR="$(bwrap "${BWRAP_ARGS[@]}" /bin/true 2>&1 9< <(claude_json_source))"; then
  echo "claude-sandbox: bwrap failed to set up the sandbox:" >&2
  echo "  ${PREFLIGHT_ERR:-'(no error output)'}" >&2
  # Ubuntu 23.10+ (24.04 LTS included) ships
  # kernel.apparmor_restrict_unprivileged_userns=1, and the distro bubblewrap
  # package carries no AppArmor profile of its own — so every unprivileged
  # bwrap fails here, with nothing about the message pointing at the cause.
  case "$PREFLIGHT_ERR" in
    *"setting up uid map"*|*"namespace"*|*"Operation not permitted"*)
      echo "  this usually means unprivileged user namespaces are restricted (Ubuntu 23.10+ default)." >&2
      echo "  check:  sysctl kernel.apparmor_restrict_unprivileged_userns" >&2
      echo "  fix it either by relaxing the restriction:" >&2
      echo "    echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf && sudo sysctl --system" >&2
      echo "  or by granting bwrap an AppArmor profile with 'userns,' (keeps the restriction on for everything else)." >&2
      ;;
  esac
  echo "  re-run with SWITCHBOARD_SANDBOX_DEBUG=1 (Pre-launch Command in Switchboard) to see every bind" >&2
  exit 125
fi
debug "pre-flight OK, launching claude"

# The sandbox is constructible — now it is safe to materialise the directories
# bwrap needs as bind sources or mount points. Anything created here, claude
# would have created on its own outside the sandbox.
# A created directory can reveal another one to create (a new projects
# directory, then the session's transcript folder in it).
for _pass in 1 2 3; do
  [ "${#MISSING_DIRS[@]}" -gt 0 ] || break
  for d in "${MISSING_DIRS[@]}"; do
    mkdir -p "$d" || fail "could not create $d"
    debug "created $d"
  done
  build_bwrap_args
done
[ "${#MISSING_DIRS[@]}" -eq 0 ] || fail "could not prepare the mount points: ${MISSING_DIRS[*]}"
exec bwrap "${BWRAP_ARGS[@]}" "$CLAUDE_REAL" "$@" 9< <(claude_json_source)
