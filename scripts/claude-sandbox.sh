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
#   protected:   what an unsandboxed claude or git would later run — the
#                settings, hooks, commands, agents, skills and plugins in
#                ~/.claude and in each bound directory's .claude, a private
#                copy of ~/.claude.json, each repository's config and hooks
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

# What each entry of a .claude directory gets is decided here; see
# docs/sandbox.md, "What the sandbox protects".
PROTECTED_CLAUDE_ENTRIES=(
  settings.json settings.local.json hooks commands agents skills plugins
  workflows routines launch.json scheduled_tasks.json daemon.json
  remote-settings.json remote-settings-consent.json remote-settings-helper-consent
  cowork_plugins
)
CLAUDE_STATE_ENTRIES=(projects todos shell-snapshots session-env statsig file-history sessions ide plans tasks)

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

# True when $1 is at or below one of the read-write state dirs.
under_rw_state() {
  local candidate="$1/" d
  for d in "$CLAUDE_DIR" "${RW_STATE_DIRS[@]}"; do
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

# Podman: only when installed and its API socket is live. Read-only is enough —
# connect(2) on a unix socket works across a read-only bind mount. Docker's
# socket is deliberately not bound; see docs/sandbox.md.
PODMAN_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman"
if command -v podman >/dev/null 2>&1 && [ -S "$PODMAN_DIR/podman.sock" ]; then
  RO_DIRS+=("$PODMAN_DIR")
  debug "podman socket live, binding $PODMAN_DIR read-only"
fi

# The host paths the sandbox can write, as bound: a path below one of them is
# reachable from inside the sandbox, read-write unless a later mount covers it.
WRITABLE_ROOTS=("$CLAUDE_DIR" "${RW_STATE_DIRS[@]}" "${RW_DIRS[@]}")

# Prints where the resolved host path $1 appears inside the sandbox, when it
# lies under a writable root; fails when the sandbox cannot see it that way.
sandbox_view() {
  local target="$1" root real
  for root in "${WRITABLE_ROOTS[@]}"; do
    real="$(readlink -f "$root" 2>/dev/null)" || continue
    [ -n "$real" ] || continue
    case "$target" in
      "$real") printf '%s' "$root"; return 0 ;;
      "$real"/*) printf '%s' "$root${target#"$real"}"; return 0 ;;
    esac
  done
  return 1
}

is_protected_entry() {
  local name="$1" path="$2" p
  for p in "${PROTECTED_CLAUDE_ENTRIES[@]}"; do
    [ "$name" = "$p" ] && return 0
  done
  if [ -f "$path" ]; then
    [ -x "$path" ] && return 0
    case "$name" in *.sh|*.bash|*.zsh|*.py|*.js|*.mjs|*.cjs|*.ts|*.rb|*.pl) return 0 ;; esac
  fi
  return 1
}

# Queues the target of symlink $1 for a read-only mount, when the sandbox could
# otherwise write it through another bind.
protect_link_target() {
  local target view
  target="$(readlink -f "$1" 2>/dev/null)" || return 0
  [ -n "$target" ] && [ -e "$target" ] || return 0
  if view="$(sandbox_view "$target")"; then
    PROTECT_ARGS+=(--ro-bind "$target" "$view")
    debug "ro-bind $view (target of $1)"
  else
    debug "link $1 -> $target is not visible in the sandbox"
  fi
}

# A .claude directory becomes a private tmpfs: every entry that exists is bound
# back, read-only when it configures what claude runs, and anything created at
# its top level is discarded with the sandbox.
bind_claude_dir() {
  local dir="$1" e name l
  BIND_ARGS+=(--tmpfs "$dir")
  debug "tmpfs $dir"
  local restore_glob
  restore_glob="$(shopt -p nullglob dotglob)"
  shopt -s nullglob dotglob
  for e in "$dir"/*; do
    name="${e##*/}"
    if [ -L "$e" ]; then
      BIND_ARGS+=(--symlink "$(readlink "$e")" "$e")
      debug "symlink $e"
      if is_protected_entry "$name" "$e"; then protect_link_target "$e"; fi
    elif is_protected_entry "$name" "$e"; then
      BIND_ARGS+=(--ro-bind "$e" "$e")
      debug "ro-bind $e"
      if [ -d "$e" ]; then
        for l in "$e"/*; do
          [ -L "$l" ] && protect_link_target "$l"
        done
      fi
    else
      BIND_ARGS+=(--bind "$e" "$e")
      debug "rw-bind $e"
    fi
  done
  eval "$restore_glob"
}

# Queues $1 for a read-only mount when the sandbox could otherwise write it.
# A missing path is created first when $2 is "dir"; a symbolic link in a
# writable place cannot be protected, so the launch is refused.
protect_path() {
  local p="$1" real view
  real="$(readlink -m "$(dirname "$p")")/$(basename "$p")"
  view="$(sandbox_view "$real")" || { debug "$p is not visible in the sandbox"; return 0; }
  if [ -L "$p" ]; then
    fail "refusing to launch: $p is a symbolic link. The sandbox protects it with a read-only mount, which cannot stop the link itself from being replaced. Replace the link with what it points to (for git hooks, set core.hooksPath to that directory instead), or turn Sandbox off for this session."
  fi
  if [ -e "$real" ]; then
    PROTECT_ARGS+=(--ro-bind "$real" "$view")
    debug "ro-bind $view"
  elif [ "${2:-}" = dir ]; then
    MISSING_DIRS+=("$real")
  fi
}

# What git runs on its own: the repository's config, its hooks directory and
# the one core.hooksPath names, and in a linked worktree the files that point
# git at the shared repository.
protect_git() {
  local d="$1" out git_dir common_dir hooks_dir
  if command -v git >/dev/null 2>&1 &&
     out="$(cd "$d" && env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
            git rev-parse --path-format=absolute --git-dir --git-common-dir --git-path hooks 2>/dev/null)"; then
    { IFS= read -r git_dir; IFS= read -r common_dir; IFS= read -r hooks_dir; } <<<"$out"
  elif [ -d "$d/.git" ]; then
    git_dir="$d/.git"; common_dir="$git_dir"; hooks_dir="$common_dir/hooks"
  else
    debug "$d/.git: git directory not resolved, only the .git file is protected"
    return 0
  fi
  protect_path "$common_dir/config"
  protect_path "$common_dir/config.worktree"
  protect_path "$common_dir/hooks" dir
  [ "$hooks_dir" = "$common_dir/hooks" ] || protect_path "$hooks_dir" dir
  if [ "$git_dir" != "$common_dir" ]; then
    protect_path "$git_dir/commondir"
    protect_path "$git_dir/config.worktree"
  fi
}

bind_project_dir() {
  local d="$1"
  BIND_ARGS+=(--bind "$d" "$d")
  debug "rw-bind $d"
  [ -d "$d" ] || return 0
  if [ -L "$d/.git" ]; then
    fail "refusing to launch: $d/.git is a symbolic link. The sandbox protects the repository's config and hooks with read-only mounts, which cannot stop the link itself from being replaced. Turn Sandbox off for this session."
  elif [ -d "$d/.git" ]; then
    BIND_ARGS+=(--bind "$d/.git" "$d/.git")
    debug "rw-bind $d/.git"
    GIT_WORKTREES+=("$d")
  elif [ -e "$d/.git" ]; then
    BIND_ARGS+=(--ro-bind "$d/.git" "$d/.git")
    debug "ro-bind $d/.git"
    GIT_WORKTREES+=("$d")
  fi
  if [ -L "$d/.claude" ]; then
    fail "refusing to launch: $d/.claude is a symbolic link. The sandbox protects it with read-only mounts, which cannot stop the link itself from being replaced. Replace the link with the directory it points to, or turn Sandbox off for this session."
  elif [ -d "$d/.claude" ]; then
    bind_claude_dir "$d/.claude"
  elif [ -e "$d/.claude" ]; then
    BIND_ARGS+=(--ro-bind "$d/.claude" "$d/.claude")
    debug "ro-bind $d/.claude"
  elif [ -w "$d" ]; then
    MISSING_DIRS+=("$d/.claude")
  fi
}

# Name resolution reads these; with systemd-resolved /etc/resolv.conf links
# into /run, which the sandbox does not otherwise see. The directory is bound,
# not the file, because the resolver replaces the file by a rename.
ETC_LINK_ARGS=()
for f in /etc/resolv.conf /etc/hosts /etc/nsswitch.conf /etc/host.conf /etc/gai.conf; do
  [ -L "$f" ] || continue
  _target="$(readlink -f "$f" 2>/dev/null || true)"
  [ -n "$_target" ] && [ -e "$_target" ] || continue
  case "$_target" in /etc/*|/usr/*) continue ;; esac
  _dir="$(dirname "$_target")"
  case "$HOME/" in "$_dir"/*) debug "not binding $_dir for $f: it contains \$HOME"; continue ;; esac
  case " ${ETC_LINK_ARGS[*]-} " in *" $_dir "*) continue ;; esac
  ETC_LINK_ARGS+=(--ro-bind "$_dir" "$_dir")
  debug "ro-bind $_dir (target of $f)"
done

# Shallowest first, so that a directory bound inside another one's .claude is
# mounted after that .claude's tmpfs instead of disappearing under it.
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

# Fills BWRAP_ARGS from what exists now, and MISSING_DIRS with what must be
# created before the real launch. Run once for the pre-flight, then again once
# the missing directories exist.
build_bwrap_args() {
  BIND_ARGS=()
  PROTECT_ARGS=()
  MISSING_DIRS=()
  GIT_WORKTREES=()
  local d name
  # Read-only binds go first so a read-write bind of a nested directory
  # (e.g. ~/.local/share/claude under a read-only parent) mounts over it.
  for d in ${RO_DIRS[@]+"${RO_DIRS[@]}"}; do
    if [ -e "$d" ]; then
      BIND_ARGS+=(--ro-bind "$d" "$d")
      debug "ro-bind $d"
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
      BIND_ARGS+=(--bind "$d" "$d")
      debug "rw-bind $d"
    else
      MISSING_DIRS+=("$d")
      debug "defer rw-bind $d (does not exist yet)"
    fi
  done
  for name in "${CLAUDE_STATE_ENTRIES[@]}"; do
    d="$CLAUDE_DIR/$name"
    [ -e "$d" ] || [ -L "$d" ] || MISSING_DIRS+=("$d")
  done
  bind_claude_dir "$CLAUDE_DIR"
  # fd 9 carries the private copy; see claude_json_source.
  BIND_ARGS+=(--file 9 "$CLAUDE_JSON")
  debug "private copy of $CLAUDE_JSON"
  for d in ${GIT_WORKTREES[@]+"${GIT_WORKTREES[@]}"}; do
    protect_git "$d"
  done

  BWRAP_ARGS=(
    --dev /dev
    --proc /proc
    --tmpfs /tmp
    --unshare-all
    --share-net
    --die-with-parent
    --dir /var
    --ro-bind /usr /usr
    --ro-bind /etc /etc
    ${ETC_LINK_ARGS[@]+"${ETC_LINK_ARGS[@]}"}
    --symlink usr/lib /lib
    --symlink usr/lib64 /lib64
    --symlink usr/bin /bin
    --symlink usr/sbin /sbin
    ${BIND_ARGS[@]+"${BIND_ARGS[@]}"}
    ${PROTECT_ARGS[@]+"${PROTECT_ARGS[@]}"}
    --chdir "$PWD"
    --setenv SHELL /bin/bash
  )
}

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
if [ "${#MISSING_DIRS[@]}" -gt 0 ]; then
  for d in "${MISSING_DIRS[@]}"; do
    mkdir -p "$d" || fail "could not create $d"
    debug "created $d"
  done
fi
build_bwrap_args
exec bwrap "${BWRAP_ARGS[@]}" "$CLAUDE_REAL" "$@" 9< <(claude_json_source)
