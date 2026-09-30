# Sandbox (Linux)

With **Sandbox** on, Switchboard runs `claude` inside a
[bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) sandbox that
shows it the project directory and Claude's own state, and hides the rest of
the filesystem — the rest of `$HOME` in particular. It is a **filesystem**
boundary: the network and the environment are the host's.

The terminal header of a sandboxed session shows **🔒 Sandbox**. Its tooltip:
*Running in a bubblewrap sandbox: only this project directory and Claude's own
state are visible. Network and environment are NOT isolated.* The badge is
also shown when Switchboard reattaches to a running sandboxed session.

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

1. finds `claude` on the `PATH` (a shell function or alias named `claude` is
   refused: the sandbox has to exec a file) and resolves symbolic links;
2. works out what to bind, listed below;
3. refuses to bind `/`, `$HOME` or any parent of `$HOME` — a session launched
   from the wrong directory would otherwise expose everything;
4. builds the sandbox once around `/bin/true` as a pre-flight, so a namespace or
   mount problem is reported as bwrap's own error before `claude` starts;
5. creates any of Claude's state directories that do not exist yet (only after
   the pre-flight has passed, so a refused launch leaves `$HOME` untouched) and
   execs `claude` inside the sandbox.

Every failure exits with status 125 and a `claude-sandbox:` message in the
terminal.

## What the session sees

| Path | Access |
|---|---|
| The session's working directory (the project, or its [worktree](worktrees.md)) | read-write |
| Each **Additional Directory** that exists | read-write |
| The repository root, when a worktree session is resumed | read-write |
| `~/.claude`, `~/.claude.json`, `~/.config/claude`, `~/.cache/claude`, `~/.local/share/claude` | read-write |
| `/usr`, `/etc` | read-only |
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
  every project's transcripts, memory files and settings, read-write. A
  sandboxed session can read all of them, and can change `~/.claude/settings.json`
  — hooks included — which unsandboxed sessions then run.
- **The project's own files.** The working directory is read-write, `.git/`
  included. A git hook written there runs, unsandboxed, the next time git runs
  in that repository outside the sandbox.
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
