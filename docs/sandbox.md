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
protected: in ~/.claude and every .claude only session state (transcripts,
todos, credentials) is writable, each repository's config and hooks directory
are read-only (tracked hook scripts such as husky's .husky/pre-commit are
project files and stay writable), and changes to ~/.claude.json (MCP servers) are dropped. NOT
isolated: network, environment, the project's own files and build scripts, the
project's CLAUDE.md and memory files, a new .git/commondir or repository or
worktree the session creates (git follows their config and hooks), the claude
binary of the native installer.* The
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
4. refuses, with the reason (see [below](#what-the-sandbox-protects)):
   a `.claude` or `.git` that is a symbolic link, in a bound directory or
   below one; a protected path reached through a symbolic link that sits in a
   writable directory; a repository `git rev-parse` cannot read, or whose git
   paths contain a newline; a state entry of `~/.claude` linked to anything
   but a directory or file of its own name, or to `$HOME` or a parent of it;
5. builds the sandbox once around `/bin/true` as a pre-flight, so a namespace or
   mount problem is reported as bwrap's own error before `claude` starts;
6. creates, only after the pre-flight has passed so that a refused launch
   leaves `$HOME` untouched, the directories the mounts need: Claude's state
   directories that do not exist yet, the session's transcript folder, an
   empty `.claude` in a bound directory or repository that has none, and a
   repository's hooks directory when it is missing;
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
| `~/.claude` | its state read-write, its configuration read-only, `projects` read-only except the session's own folder — see [What the sandbox protects](#what-the-sandbox-protects) |
| `~/.claude.json` | a private copy, dropped when the session ends |
| `~/.config/claude`, `~/.cache/claude`, `~/.local/share/claude` | read-write |
| `/usr`, `/etc` | read-only |
| What `/etc/resolv.conf`, `/etc/hosts`, `/etc/nsswitch.conf`, `/etc/host.conf` or `/etc/gai.conf` links to, when outside `/etc` and `/usr`: the directory under `/run` (with systemd-resolved, `/run/systemd/resolve`), since the resolver replaces the file by a rename; the file itself elsewhere | read-only |
| `/bin`, `/sbin`, `/lib`, `/lib64` | symbolic links into `/usr` |
| The directory of the resolved `claude` binary | read-only, unless it lies under one of Claude's state directories (see below) |
| The directory of the `node` on the `PATH`, and of the interpreter named in `claude`'s `#!` line | read-only |
| `$NVM_DIR` (default `~/.nvm`), when it exists | read-only |
| `$XDG_RUNTIME_DIR/podman`, only with `SWITCHBOARD_SANDBOX_PODMAN=1` and when `podman` is installed and its API socket is live | read-only |
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

`~/.claude` is a private tmpfs, and each entry that exists at launch is
mounted back onto it. A project's `.claude` is mounted read-only as a whole,
with its listed state mounted back read-write on top.

Only the state the CLI writes during a session is read-write; every other
entry is read-only, whatever it is — settings, hooks, commands, agents,
skills, plugins, `keybindings.json`, `CLAUDE.md`, `rules`, `output-styles`, a
status-line script with no extension, a directory a future CLI version adds.

| Entry | Inside the sandbox |
|---|---|
| In `~/.claude`: `todos`, `statsig`, `file-history`, `sessions`, `plans`, `tasks`, `cache`, `paste-cache`, `image-cache`, `downloads`, `feedback`, `debug`, `telemetry`, `jobs`, `usage-data`, `agent-memory`, `.credentials.json`, `history.jsonl`, `.last-cleanup`, `.last-update-result.json`, `mcp-needs-auth-cache.json`, `policy-limits.json`, `policy-limits.json.stamp.json`, `stats-cache.json` | read-write |
| In `~/.claude`: `projects` | read-only, except the session's own transcript folder, `projects/<the working directory, every character but letters and digits replaced by ->`, which is read-write; see [Schedules](#schedules) |
| In `~/.claude`: `shell-snapshots`, `session-env`, `backups`, `state` | an empty private tmpfs. Other sessions source the shell snapshots and session hooks kept there before each Bash command, and the CLI offers the backups there as what to copy back over a broken `~/.claude.json`; the session gets its own |
| In a project's `.claude`: `worktrees`, `agent-memory`, `agent-memory-local` | read-write |
| Any other file or directory | read-only |
| A symbolic link to one of the read-write entries of `~/.claude` (`todos` kept on another disk, say) | recreated as the same link on the tmpfs, and its target bound read-write at its own path so the link resolves — only when the target is a directory (a file, for `*.json`, `*.jsonl` and `.last-*`) of the same name, and neither `$HOME` nor a parent of it. Any other target is refused |
| A symbolic link to one of the read-write entries of a project's `.claude` | left as it is and not followed: a repository can carry such a link, so it resolves only to what the sandbox sees anyway |
| Any other symbolic link | kept as the same link (in `~/.claude`, recreated on the tmpfs). When its target lies in a directory the sandbox can write (the project, say), the target is mounted read-only too; a target the sandbox cannot see stays invisible |
| A symbolic link at any depth inside a read-only directory, or inside a linked directory mounted read-only (`skills/<name>/…` linked from elsewhere, say) | its target is mounted read-only when the sandbox could otherwise write it, and the links below that target are followed in turn |

`ide` is read-only: it holds the lock files that tell a later session which
local port is its IDE. Switchboard writes them from outside the sandbox when
IDE Emulation is on, and the sandboxed session reads them.

A new entry fails in a project's `.claude` with *Read-only file system*, while
in `~/.claude` — whose top level must stay writable, because the CLI saves
`.credentials.json` and its other state files through a temporary file created
next to them — it is accepted and dropped with the tmpfs when the session ends
(a new `settings.local.json`, a new `hooks` directory, a replaced link). So
that the session's own state is not lost that way, `projects` and the
session's folder in it, `todos`, `statsig`, `file-history`, `sessions`,
`plans`, `tasks` and `ide` are created in `~/.claude` before launch when
missing, and a bound directory or repository without a `.claude` gets an empty
one (skipped when its directory is not writable). Links
inside a project's `worktrees` and agent memory are project content and are
not followed.

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

For each bound directory, and for every `.git` and `.claude` found below it at
any depth — worktrees under `.claude/worktrees` or `.work-files/worktrees`,
nested repositories, submodules — `node_modules` excepted:

- a `.git` directory is mounted onto itself, so it cannot be renamed and
  replaced by another directory; a `.git` file (a linked worktree, a
  submodule) is read-only, so it cannot be pointed at another repository;
- the repository's `config` is read-only, and so is `config.worktree` when it
  exists: `git config core.hooksPath …` or `core.fsmonitor …` fails;
- the hooks directory is read-only, and so is the directory `core.hooksPath`
  names when it lies in a writable directory (husky's `.husky/_`, say). A
  missing one is created first, because a mount needs a mount point;
- for every linked worktree of the repository, `.git/worktrees/<name>/commondir`,
  `gitdir` and `config.worktree` are read-only;
- the `.claude` next to it gets the treatment of a project's `.claude` above,
  and is created empty when missing.

The paths come from `git rev-parse --git-dir --git-common-dir --git-path hooks`
run in the directory before launch; a repository it cannot read is refused
rather than guessed at.

The search below a bound directory does not enter `node_modules`, and does not
cross into another filesystem (`find -xdev`): a `.git` or `.claude` inside a
`node_modules`, or on a mount or a bind inside the project, is not protected.

### The way to a protected path

A read-only mount protects one path, not the directories leading to it. Every
directory between a writable root and a protected path is therefore mounted
onto itself: with `core.hooksPath=tools/hooks`, `mv tools tools-x; mkdir -p
tools/hooks` fails with *Device or resource busy*. A symbolic link on the way,
in a directory the sandbox can write — `core.hooksPath=linked/hooks` with
`linked -> tools`, or a link in a skill's target path — could be re-pointed
instead, so the launch is refused; point `core.hooksPath` at a hooks directory
instead of linking `.git/hooks` to it.

The paths, and the Additional Directories (below), are resolved when the
wrapper builds the sandbox and mounted when bwrap starts it; a second sandboxed
session on the same project that swaps a
directory in between is not detected.

### Additional directories

An Additional Directory, or a schedule's `add-dirs` entry, is bound
read-write, so one at or inside a `.claude` or `.git` directory is refused: the
wrapper stops with status 125 and names it, and a sandboxed schedule with such
an entry is skipped with the reason in the main log. The path is judged both as
spelled (`..` and a trailing slash resolved) and by its real path, so a link
to a `.claude`, or a `.claude` that is itself a link, does not get through. Add
the project directory instead: its `.claude` and `.git` are then protected as
above. The session's working directory is held to the same rule, with one exception:
a directory below `.claude/worktrees` is allowed, because Claude Code's
worktrees live there (a `.claude` or `.git` further down is still refused). A
path the wrapper cannot resolve is refused. The same check refuses `$HOME` and
its parents however they are spelled (`$HOME/`, `$HOME/.`, a link to it).
A relative `add-dirs` entry of a schedule is taken from the schedule's
directory.

### Schedules

The [scheduler](automation.md#schedules) runs the schedules of the projects in
its registry, the `scheduleProjects` setting in Switchboard's database, and of
no other directory. Switchboard adds a project there when it launches a Claude
session in it or when you add it (**Add project**), and removes it when you
remove the project. Nothing a session writes — a transcript, the `cwd` it
records, the folder name derived from it — adds one. The registry is seeded
once, when Switchboard first starts with it and before any session can run,
with two kinds of project: those that carry a per-project setting of their own
(a `project:` entry in the settings table, for a directory that exists on this
machine), and those that already hold a schedule, are a git checkout (a `.git`
directory or file) and have a transcript folder named after their path. A
transcript folder alone registers nothing, and neither does a schedule in a
directory that is not a git repository. A folder planted before the upgrade
that holds a `.git` and a schedule is still registered, once, at that first
read: under v0.0.85 a sandboxed session could write both `~/.claude/projects`
and its project directory, and nothing in the seed can tell such a folder from
a real repository. The maintainer accepted this residual on 2026-10-02. After
the upgrade `~/.claude/projects` is read-only to a sandboxed session except its
own folder, so nothing new can be planted. Any other project enters the registry the normal way, when a session is launched in
it from the app or when you add it.

A project path is never read from a transcript on trust. The sidebar project,
the directory a resumed or forked session starts in and the folder the sandbox
binds as its own transcript folder all come from a transcript's `cwd` only when
that `cwd`, with every character but letters and digits replaced by `-`, is the
name of the folder holding the transcript. A transcript forged in the session's
own folder with a `cwd` below the project therefore moves none of them, and
registers nothing. Moving a project with the remap dialog is the one case where a transcript's `cwd` differs from its folder name; Switchboard records the new path itself and accepts that one. Paths of 200 characters or more are shortened and hashed in
that name, so two of them can share a folder name; this is not closed.

A sandboxed session can still create a `.claude` below a bound directory
after launch: the mount plan is fixed when the sandbox starts, and a new
directory is not in it. The registry is what keeps a
`.claude/commands/schedule-*.md` planted there from running: it runs only if
that directory is itself a registered project. `claude` started there by hand,
outside the sandbox, would still load such a `.claude` (see
[What is not isolated](#what-is-not-isolated)).

A run is sandboxed according to the `project:` setting of its directory or,
failing that, of the nearest directory above it that has one, then the global
setting. With the sandbox on, a schedule's `add-dirs` under `$HOME` must be a
registered project or lie inside one; otherwise the run is skipped and the
reason logged, because binding them read-write would hand an unattended run
whatever they hold.

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
  or worktree the session creates — `git init`, `git worktree add`, a nested
  `.git` — and a `.claude` it creates in a subdirectory that is not a
  repository have settings, config and hooks of their own, which `claude` or
  git run there outside the sandbox (a shell prompt that shows the git status
  included) executes. Submodules' repositories under `.git/modules` are not
  protected.
- **The terminal.** The sandbox shares the terminal's session: with bwrap's
  `--new-session` the process leaves the terminal's foreground process group
  and no longer receives `SIGWINCH`, so the CLI would not redraw on a resize
  (measured with bwrap 0.11.1). A process sharing the session could type into
  the terminal with the `TIOCSTI` ioctl where the kernel still allows it; Linux
  6.2 and later refuse it unless `dev.tty.legacy_tiocsti=1`, and the wrapper
  warns when that is set.
- **Podman, when enabled.** With `SWITCHBOARD_SANDBOX_PODMAN=1` in the
  Pre-launch Command, the rootless podman API socket is bound, and through it
  the session can start a container with any host path mounted
  (`podman run -v $HOME:/h …`): enabling it gives up the filesystem boundary.
- **Session status.** `~/.claude/sessions` is read-write, and a sandboxed CLI
  records its PID as seen inside its PID namespace, so Switchboard's check of
  whether a session is live elsewhere can be misled for a sandboxed session.
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
  MCP server (dropped at the end). Do these outside the sandbox. That includes
  accepting the Bypass Permissions disclaimer, which the CLI records as
  `skipDangerousModePermissionPrompt` in `~/.claude/settings.json`; a
  `permissions.disableBypassPermissionsMode` in managed settings turns bypass
  off in and out of the sandbox alike. The same goes
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
  `$XDG_RUNTIME_DIR/docker.sock` is bound. Podman's socket is bound only with
  `SWITCHBOARD_SANDBOX_PODMAN=1`, see above.
- Every protected path in a writable directory is one more mount: a
  `~/.claude/skills` with 2000 links into the project took 17 s to launch
  (bwrap mounting them twice, pre-flight included), 3 s when the targets are
  outside what the sandbox sees.
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
