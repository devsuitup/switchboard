# Sandbox (Linux)

With **Sandbox** on, Switchboard runs `claude` inside a
[bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) sandbox that
shows it the project directory and Claude's own state, and hides the rest of
the filesystem — the rest of `$HOME` in particular. What Claude and git would
later run outside the sandbox — everything in `~/.claude` and `.claude` but
the session's own state, MCP servers, a repository's config and hooks — is out
of the session's reach ([What the sandbox protects](#what-the-sandbox-protects)). It is a
**filesystem** boundary: the network and the environment are the host's.

The terminal header of a sandboxed session shows a **Sandbox** indicator, a
green dot and the word, among the indicators on the right. Its tooltip:
*Running in a bubblewrap sandbox: only this project directory and Claude's own
state are visible. What Claude and git run later outside the sandbox is
protected: in ~/.claude and .claude only session state (transcripts, todos,
credentials) is writable, git config and hooks are read-only, and changes to
~/.claude.json (MCP servers) are dropped. NOT isolated: network, environment,
the project's own files and build scripts, the project's CLAUDE.md and memory
files, the claude binary of the native installer.* The
badge is also shown when Switchboard reattaches to a running sandboxed session.

## Turning it on

Sandbox is off by default. It can be set at three levels, the most specific
winning:

- **Global Settings → Claude CLI Options → Sandbox**, for every new session;
- **Project Settings → Sandbox**, for one project;
- the **Sandbox** toggle of the New Session or Resume dialog, for one launch —
  see [Launching sessions](launching-sessions.md).

It takes effect when a session is launched or resumed; a running session keeps
the mode it was started in. Scheduled runs follow the global and project
setting too — see [Automation](automation.md#schedules).

Only Claude sessions are sandboxed. Plain terminals from the `+` menu and the
panel shell are not.

## Prerequisites

- `bwrap` on the `PATH` (`apt install bubblewrap`, `dnf install bubblewrap`,
  `pacman -S bubblewrap`). The wrapper script itself ships inside the app.
- Unprivileged user namespaces. **Ubuntu 23.10 and later, 24.04 LTS included,
  block them by default** (`kernel.apparmor_restrict_unprivileged_userns=1`,
  and the distribution's `bubblewrap` package has no AppArmor profile), so every
  unprivileged `bwrap` fails with `bwrap: setting up uid map: Permission denied`.
  Nothing is launched, and the wrapper prints the check and the two fixes:
  - relax the restriction:
    `echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf && sudo sysctl --system`
  - or keep it and give `bwrap` an AppArmor profile containing `userns,`.
- `~/.claude` must exist: run `claude` once outside the sandbox first. The
  wrapper refuses to launch otherwise, so that the CLI's first-run setup is not
  done through the sandbox's bind list.

## How a launch works

Switchboard builds the usual `claude …` arguments and runs
`bash <app>/scripts/claude-sandbox.sh claude …` instead of `claude …`. The
Pre-launch Command, when set, stays in front of the whole line, so it runs
**outside** the sandbox and its environment is inherited inside.

The script (`scripts/claude-sandbox.sh`):

1. looks `claude` up on the `PATH` only (`type -P`) and resolves symbolic
   links. A shell function or alias named `claude` — a wrapper in your profile,
   say — is therefore **bypassed**: the sandbox execs the binary it finds on the
   `PATH`, without the wrapper's arguments or environment. The launch is refused
   only when no executable `claude` file is found at all;
2. works out what to bind, listed below;
3. refuses to bind `/`, `$HOME` or any parent of `$HOME` — a session launched
   from the wrong directory would otherwise expose everything;
4. refuses a bound directory whose `.claude` or `.git` is a symbolic link, a
   repository whose hooks directory, `config` or `commondir` is one, a
   repository whose git paths contain a newline, and a state entry of
   `~/.claude` linked to `$HOME` or a parent of it (see
   [below](#what-the-sandbox-protects));
5. builds the sandbox once around `/bin/true` as a pre-flight, so a namespace or
   mount problem is reported as bwrap's own error before `claude` starts;
6. creates, only after the pre-flight has passed so that a refused launch
   leaves `$HOME` untouched, the directories the mounts need: Claude's state
   directories that do not exist yet, an empty `.claude` in a bound directory
   that has none, and a repository's hooks directory when it is missing;
7. execs `claude` inside the sandbox.

Every failure exits with status 125 and a `claude-sandbox:` message in the
terminal.

## What the session sees

| Path | Access |
|---|---|
| The session's working directory (the project, or its [worktree](worktrees.md)) | read-write |
| Each **Additional Directory** that exists | read-write |
| The repository root, when a worktree session is resumed | read-write |
| In each of the above: `.claude`, `.git/config`, `.git/hooks` | see [What the sandbox protects](#what-the-sandbox-protects) |
| `~/.claude` | its state read-write, its configuration read-only — see [What the sandbox protects](#what-the-sandbox-protects) |
| `~/.claude.json` | a private copy, dropped when the session ends |
| `~/.config/claude`, `~/.cache/claude`, `~/.local/share/claude` | read-write |
| `/usr`, `/etc` | read-only |
| The directory `/etc/resolv.conf`, `/etc/hosts`, `/etc/nsswitch.conf`, `/etc/host.conf` or `/etc/gai.conf` links into, when outside `/etc` and `/usr` (with systemd-resolved, `/run/systemd/resolve`) | read-only |
| `/bin`, `/sbin`, `/lib`, `/lib64` | symbolic links into `/usr` |
| The directory of the resolved `claude` binary | read-only, unless it lies under one of Claude's state directories (see below) |
| The directory of the `node` on the `PATH`, and of the interpreter named in `claude`'s `#!` line | read-only |
| `$NVM_DIR` (default `~/.nvm`), when it exists | read-only |
| `$XDG_RUNTIME_DIR/podman`, when `podman` is installed and its API socket is live | read-only |
| `/dev` | a minimal device tree |
| `/proc` | the sandbox's own processes |
| `/tmp` | an empty private tmpfs |
| `/var` | an empty directory |

Nothing else exists inside. In `$HOME` that includes `~/.ssh`, `~/.gnupg`,
`~/.gitconfig`, `~/.aws`, shell history, and every other project.

Beyond the filesystem, the sandbox gets its own PID, IPC, UTS, cgroup and user
namespaces: host processes are invisible to it and cannot be signalled from it.
It dies with its parent. `SHELL` is set to `/bin/bash`.

## What the sandbox protects

A sandboxed session must not be able to leave behind something that an
unsandboxed process runs later: the next `claude` started outside the sandbox,
a [scheduled run](automation.md#schedules) with the sandbox off, or `git` in
the same repository. Inside the sandbox, these are read-only or discarded.

### `~/.claude` and each bound directory's `.claude`

The directory itself is a private tmpfs, and each entry that exists at launch
is mounted back onto it:

Only the state the CLI writes during a session is read-write; every other
entry is read-only, whatever it is — settings, hooks, commands, agents,
skills, plugins, `keybindings.json`, `CLAUDE.md`, `rules`, `output-styles`, a
status-line script with no extension, a directory a future CLI version adds.

| Entry | Inside the sandbox |
|---|---|
| In `~/.claude`: `projects`, `todos`, `shell-snapshots`, `session-env`, `statsig`, `file-history`, `sessions`, `plans`, `tasks`, `backups`, `cache`, `paste-cache`, `image-cache`, `downloads`, `feedback`, `debug`, `telemetry`, `state`, `jobs`, `usage-data`, `agent-memory`, `.credentials.json`, `history.jsonl`, `.last-cleanup`, `.last-update-result.json`, `mcp-needs-auth-cache.json`, `policy-limits.json`, `policy-limits.json.stamp.json`, `stats-cache.json` | read-write |
| In a project's `.claude`: `worktrees`, `agent-memory`, `agent-memory-local` | read-write |
| Any other file or directory | read-only |
| A symbolic link to one of the read-write entries (`projects` kept on another disk, say) | recreated as the same link on the tmpfs, and its target bound read-write at its own path so the link resolves. A target that is `$HOME` or contains it is refused |
| Any other symbolic link | recreated as the same link on the tmpfs. When its target lies in a directory the sandbox can write (the project, say), the target is mounted read-only too; a target the sandbox cannot see stays invisible |
| A symbolic link at any depth inside a read-only directory, or inside a linked directory mounted read-only (`skills/<name>/…` linked from elsewhere, say) | its target is mounted read-only when the sandbox could otherwise write it, and the links below that target are followed in turn |

`ide` is read-only: it holds the lock files that tell a later session which
local port is its IDE. Switchboard writes them from outside the sandbox when
IDE Emulation is on, and the sandboxed session reads them.

Anything the session creates directly in the directory — a new
`settings.local.json`, a new `hooks` directory, a replaced link — lives in the
tmpfs and is gone when the session ends. So that the session's own state is not
lost that way, `projects`, `todos`, `shell-snapshots`, `session-env`,
`statsig`, `file-history`, `sessions`, `plans`, `tasks` and `ide` are created
in `~/.claude` before launch when missing, and a bound directory without a
`.claude` gets an empty one (skipped when the directory is not writable).

A read-only file is a mount point: writing it fails with *Read-only file
system*, and replacing it by a rename — how the CLI saves its files — fails
with *Device or resource busy*. A read-write file bound onto the tmpfs is a
mount point too, so the rename fails there as well; the CLI then falls back to
writing the file in place (it does so on `EBUSY`, `EXDEV`, `EPERM` and
`EEXIST`), which succeeds.

A `.claude` that is itself a symbolic link is refused: the link lives in a
writable directory, and the session could replace it with a directory of its
own.

### `~/.claude.json`

This file holds the MCP server definitions, and the CLI rewrites it throughout
a session. The sandbox gets a copy of it (`{}` when there is none) in its own
root tmpfs, and the host file is never written: whatever the session changes there
is dropped when it ends — an MCP server added with `claude mcp add`, a folder
marked as trusted, onboarding and tip counters.

### Git

For each bound directory with a `.git`:

- `.git` is mounted onto itself, so it cannot be renamed and replaced by
  another directory; a `.git` file (a linked worktree) is read-only;
- the repository's `config` is read-only, and so is `config.worktree` when it
  exists: `git config core.hooksPath …` or `core.fsmonitor …` fails;
- the hooks directory is read-only, and so is the directory `core.hooksPath`
  names when it lies in a writable directory (husky's `.husky/_`, say). A
  missing one is created first, because a mount needs a mount point;
- in a linked worktree, whose repository is visible when its root is bound, the
  worktree's `commondir` and `config.worktree` are read-only too.

The paths come from `git rev-parse --git-dir --git-common-dir --git-path hooks`
run in the directory before launch. A symbolic link at one of them is refused
for the same reason as a linked `.claude`; point `core.hooksPath` at a hooks
directory instead of linking `.git/hooks` to it.

## What is not isolated

- **The environment.** Every variable of Switchboard's process and of the
  Pre-launch Command is inherited — tokens, `AWS_*`, `SSH_AUTH_SOCK` and the
  rest. A socket path in a variable is only usable if the socket's directory is
  bound, but the variable's value is readable.
- **The network.** The sandbox shares the host's network namespace
  (`--share-net`): the internet, the LAN and every service listening on
  localhost are reachable, as are abstract Unix sockets, which belong to the
  network namespace. Claude needs the API, and the [IDE bridge](ide-emulation.md)
  listens on localhost.
- **Claude's state, across projects.** `~/.claude` holds the credentials and
  every project's transcripts and memory files. A sandboxed session can read
  all of them, and write the transcripts and memory files.
- **Instructions.** The project's `CLAUDE.md` files, memory files under
  `~/.claude/projects/*/memory`, and agent memory (`agent-memory`,
  `agent-memory-local`) stay writable. They are read by later sessions as
  instructions, not run.
- **The project's own files.** The working directory is read-write: whatever
  runs them later outside the sandbox runs what the session wrote — build
  scripts, `package.json` scripts, direnv's `.envrc`, editor tasks, and the
  tracked hook scripts a hooks directory calls (husky's `.husky/_` is
  read-only, the `.husky/pre-commit` it runs is not). A script that a hook or
  the status line runs from the project is writable the same way. A project's
  `.mcp.json` is writable; the CLI asks before using a server defined there,
  unless a settings file approves it (`enableAllProjectMcpServers`,
  `enabledMcpjsonServers`), and those files are read-only in the sandbox.
- **Git, beyond the config and hooks above.** A new file git would read in a
  `.git` directory is not prevented: a `.git/commondir` redirects git to
  another repository directory, with its own config and hooks. A repository
  the session creates — `git init`, a nested `.git` — has config and hooks of
  its own, which git run there outside the sandbox (a shell prompt that shows
  the git status included) executes. Submodules' repositories under
  `.git/modules` are not protected.
- **The `claude` binary, with the native installer.** That installer keeps the
  versioned binary under `~/.local/share/claude`, which is read-write for the
  CLI's own updates, so the binary's directory is writable inside the sandbox;
  the wrapper then skips the read-only bind rather than claim one. With npm or
  nvm installs the binary's directory is read-only.
- **`/etc`** is readable, like on the host.

## Limits

- `git commit` has no identity unless the repository sets `user.name` and
  `user.email` locally: `~/.gitconfig` is not visible. `git push` over SSH has
  no keys and no agent socket.
- Nothing that writes Claude's configuration persists from a sandboxed
  session: changing a setting, answering "always allow" to a permission
  prompt (both fail to save), installing or updating a plugin, or adding an
  MCP server (dropped at the end). Do these outside the sandbox. The same goes
  for a first login: a `~/.claude/.credentials.json` created inside the
  sandbox is dropped with it, while an existing one is refreshed in place.
- Nothing can write the repository's config: `git config` and
  `git remote add` fail, `git push -u` records no upstream, and husky's
  install step cannot set up its hooks.
- Anything else written into an existing entry of `~/.claude` that is not on
  the read-write list fails: the state a hook or status line keeps there, or
  a directory a newer CLI writes to.
- A symbolic link in `~/.claude` whose target is in no bound directory — a
  `settings.json` or `agents` kept in a dotfiles repository, say — dangles
  inside the sandbox, so the session runs without it.
- Docker is unreachable: neither `/var/run/docker.sock` nor a rootless
  `$XDG_RUNTIME_DIR/docker.sock` is bound. Only podman's socket is.
- Claude Code's own Bash-tool sandbox also needs user namespaces. If the Bash
  tool fails only under Sandbox, turn one of the two layers off.
- An Additional Directory is forwarded to the script in the colon-separated
  `SWITCHBOARD_SANDBOX_BINDS` variable. A path containing `:` or a newline
  cannot be forwarded; it is skipped with a warning in the main log. A path
  that does not exist is skipped with a message in the terminal, never created.
- `claude` launched as a script needs its interpreter on the `PATH`; the script
  warns when it is not.

## Other platforms

On macOS and Windows the Sandbox toggles are hidden. A stored `sandbox: true` —
from a settings database copied from a Linux machine, for instance — is treated
differently by the two launch paths:

- **Interactive sessions** run unsandboxed: the renderer only asks for the
  sandbox on Linux, so the setting is ignored.
- **Scheduled runs** are skipped, with *sandbox is enabled but requires Linux
  (bubblewrap)* in the main log: an unattended run is not downgraded to no
  isolation.

## Debugging

Put `SWITCHBOARD_SANDBOX_DEBUG=1` in the session's Pre-launch Command. The
script then prints the resolved `claude`, the `bwrap` version, every bind it
adds or skips, and the full `bwrap` command line, before launching.
