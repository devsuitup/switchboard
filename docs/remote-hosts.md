# Remote Hosts

Switchboard can observe the Claude sessions of other machines you reach over
SSH. Their transcripts are copied into a local mirror, and their sessions
appear in the sidebar, the search and the stats beside your own. A live remote
session running in tmux can be attached to in a terminal, and any live remote
session can be stopped.

## Declaring a host

**Global Settings → Remote Hosts → SSH hosts to observe → Add host**. Each row
has:

| Field | Meaning |
|---|---|
| Toggle | Whether the host is observed |
| ssh alias | A host name or `Host` alias that `ssh` resolves — typically from `~/.ssh/config` |
| label (optional) | A label stored with the host, defaulting to the alias; the sidebar shows the alias |
| Remove | Deletes the row |

An alias may only contain letters, digits, dot, dash and underscore (1 to 63
characters, starting with a letter or digit); a row that does not match is not
saved, and the page lists it. A duplicate alias keeps its first row.

**Refresh every** sets the minutes between full pulls: default 5, minimum 1.

Switchboard never stores or reads a key, a password or a port: it runs the
system `ssh` and `scp` with `BatchMode=yes`, so the host must be reachable
without a prompt (a key or an agent), and everything else — user, port, jump
hosts, `ControlMaster` — comes from your SSH configuration.

The settings are stored as `remoteHosts` and `remoteRefreshMs` in the global
settings. With no host declared, nothing runs: no timer, no ssh, no mirror.

### Which ssh and scp run

Every remote operation — the pulls, the watch connection, the probe before an
attach, the attached terminal, stop, and the Changes view — runs the same
`ssh`, the first of:

1. `SWITCHBOARD_SSH_PATH`, when it is set;
2. `ssh` from the `PATH` Switchboard was started with (`ssh.exe` on Windows),
   so a Homebrew OpenSSH on macOS or Git's ssh on Windows is found first;
3. `/usr/bin/ssh` on macOS and Linux, and on Windows `System32\OpenSSH\ssh.exe`
   or Git's `usr\bin\ssh.exe`, whichever exists first.

The pulls copy transcripts with `scp`, the first of:

1. `SWITCHBOARD_SCP_PATH`, when it is set;
2. the `scp` in the directory of `SWITCHBOARD_SSH_PATH` (`scp.exe` when that
   path ends in `.exe`), when that file exists;
3. `scp` from the `PATH`;
4. `/usr/bin/scp` on macOS and Linux, and on Windows
   `System32\OpenSSH\scp.exe` or Git's `usr\bin\scp.exe`, whichever exists
   first.

`scp` is always told to connect with the `ssh` chosen above (`scp -S`), so a
wrapper named by `SWITCHBOARD_SSH_PATH` also carries the copies. A wrapper with
no `scp` beside it leaves `scp` itself to steps 3 and 4; set
`SWITCHBOARD_SCP_PATH` when that is not the `scp` to run.

Both variables:

- must be absolute paths; a relative value is ignored, with a warning in the
  log, and the next step applies;
- must name an executable, not a script run through a shell: on Windows a
  `.cmd` or `.bat` file cannot be started (the log says so), so point at an
  `.exe`;
- are trimmed, and a blank value counts as unset;
- are read once per run of Switchboard: after changing them, restart it.

The search through the `PATH` and the system locations also runs once. An
`ssh` or `scp` it found that is later removed is searched for again at its
next use; one installed after nothing was found is seen after a restart.

### Check host

Each host row in Settings has a **Check host** button. It runs one read-only
`ssh` to the host and shows a checklist, one line per item with its status (ok,
missing or unknown), and for a missing or unknown item the command to run, with
a **Copy** button and where to run it:

| Item | What is read |
|---|---|
| ssh reachable | whether the connection (same `ssh`, `BatchMode=yes`) succeeded |
| claude CLI | whether `claude` is on the `PATH` of an ssh command, and its `--version` |
| tmux | whether `tmux` is installed; without it the host is observed but cannot launch or attach (optional) |
| `~/.claude` | whether the directory exists |
| account logged in | the exit status of `claude auth status` (0 logged in, 1 not) |

The check does not install, log in or write anything itself: the
commands it hands you are for you to run on the host (`ssh -t <alias>`).
Switchboard never copies or reads credentials. The login check does not open the
credentials file or test that it exists: it asks the CLI, throws away what the
CLI prints (which includes your email), and keeps only the exit status. When the
state cannot be told (an older CLI without `claude auth status`, no `~/.claude`
yet, `claude` missing, an unusual exit status) the line says *unknown — run
`claude` on the host once to log in*, never "not logged in".

Not verified: whether `claude auth status` itself refreshes or rewrites an
expired token, or makes network calls, when the CLI runs it on the host. The
check neither asks for nor sees any of that; it only receives the exit status.

Limits: the host must be saved first (the button checks the hosts in the saved
settings); a Linux host whose login shell is POSIX is required (the command is
not wrapped in `sh -c`), so a Windows host, or a host whose login shell is fish
or csh, is reported as not checked; only `tmux` is looked for. If the CLI is logged in only
through an environment variable set by an interactive profile, the check, which
runs in a non-interactive shell, reads "not logged in".

## Requirements on the host

- A Linux host (`/proc` is read for liveness, attach and stop), a POSIX shell
  and GNU `find`.
- The `claude` CLI writing its usual `~/.claude/projects/` transcripts and
  `~/.claude/sessions/<pid>.json` descriptors.
- For live updates: `inotifywait` (inotify-tools). Without it, only the periodic
  pull runs, and a warning is logged.
- For attach: `tmux` installed, and sessions started inside it.
- For the [Changes view](changes-view.md): `git`.

## What is copied

Each pull makes one ssh call that lists `~/.claude/projects` (transcripts and
subagent `.meta.json` files) and reads up to 200 session descriptors, each with
a liveness check of its pid. Only what changed is then fetched: a new file with
`scp`, a grown one by its new bytes only.

The mirror lives in the data directory, under `remote/<alias>/projects/`
(`~/.switchboard/remote/<alias>/` for an installed app). Limits per pull: 500
files and 256 MB — the rest waits for the next pull — and files over 64 MB are
skipped. A listing of more than 20,000 entries is refused. A file deleted on the
host is deleted from the mirror only after a pull with no failure.

Besides the periodic pull, one long-lived ssh connection per host runs
`inotifywait` on `~/.claude/projects` and `~/.claude/sessions`, and triggers a
pull at most every 15 seconds when something changes. It is restarted with a
growing delay when it fails.

## In the sidebar

A remote host's projects are listed like local ones, with the alias as a badge
on each session. Their `+` starts a new session on the host when it has
`tmux` (see [Launch a session](#launch-a-session)); without it the button is
disabled and its tooltip says the host needs tmux.

### Status

The project header carries a dot for the host's state, with a tooltip:

| Dot | Tooltip |
|---|---|
| green | *N live session(s)* |
| grey | *no live session* |
| amber | *not yet synced with this host* |
| red | *host unreachable: &lt;error&gt;*, when it was last confirmed, and when the next attempt is |
| amber, pulsing | a reconnect in progress |

Hovering the dot also lists the host's capability: the highest of observe,
liveness, inject, attach and launch that its last refresh could confirm, and for
each one above it why it is missing (for example no live session reports a
messaging socket). Liveness and inject need a live session to read, so they read
as missing on an idle host.

Once per host, at its first successful refresh and then every six hours (and on
**Reconnect**), one extra ssh asks whether `tmux` and `inotifywait` are
installed and nothing else; while one of them is missing it asks again every 30 minutes, so an install is noticed. A host with `tmux` and no session offers attach; a
host without it does not, even when a descriptor names a pane, and the dot says
so. A host without `inotifywait` says that only the periodic pull runs. When the
probe fails (timeout after 15 seconds, refused, unreadable answer), the host
stays as it was and the probe is tried again 30 minutes later: an unknown answer
is never shown as missing.

What the tier gates:

- **Attach.** A row attaches only when the host has `tmux` (as far as the probe
  knows) and the descriptor names a pane. Otherwise it opens its transcript, with
  the reason in its tooltip. After three failed refreshes in a row it also opens
  its transcript, whatever the probe said.
- **New session** is enabled when the host has `tmux` (probe answer, or a live
  session naming a tmux pane). Otherwise it is disabled and its tooltip gives the
  launch tier's reason: the host needs tmux.
- **Send a prompt…** is disabled, with the inject reason in its tooltip, while no
  live session on the host reports a messaging socket. A host whose refresh
  failed does not disable it: it runs its own ssh.
- **Stop** is never disabled, it runs its own ssh.

A failing host is retried with a doubling delay, up to 30 minutes, and never
dropped; one success resets it. **Reconnect** on the header retries at once and
restarts the watch connection. The sidebar's global refresh retries every host.

A remote session shows the working spinner while its transcript is being
written, until 20 seconds of silence (3 seconds while a subagent is busy), and
never "response ready". A session that has a live descriptor but no transcript
yet (before its first prompt) is listed under its directory's name.

A session that is not open in a tab and is waiting on a dialog on the host
(a permission prompt or a question) shows the orange attention state, and its
status line says what it waits for. The state comes from the session's
descriptor, so it appears with the next refresh (about 15 seconds with the host
watch, the pull interval without it) and clears the same way once the dialog is
answered. A session open in a tab keeps the terminal's own signals.

### Opening a session

- A **live session in tmux** — its descriptor names a tmux pane and its pid is a
  running `claude` — opens in a terminal attached to that tmux pane over
  `ssh -tt` (badge tooltip: *Live session on &lt;alias&gt; — click to attach*).
  Switchboard finds the tmux socket from the process's own `TMUX` variable.
  When no other client is attached, it hides tmux's status bar, turns the mouse
  on and follows the window's size; otherwise the size is fixed at attach time.
  Leaving the session ends the local ssh client only: the remote session keeps
  running, and opening it again reattaches.
- **Any other session** opens its transcript in the read-only viewer.

Remote sessions get no [IDE emulation](ide-emulation.md), no
[panel shell](terminal.md#panel-shell) and no
[path links](terminal.md#clickable-paths). The [Changes view](changes-view.md)
works, read-only, by running git over ssh in the session's directory.

## Stop, archive, delete

- **Stop** asks *Stop this session on &lt;alias&gt;?*, then ends the process on
  the host: after checking that the pid is still a `claude` process, it kills
  the session's tmux pane (or window), or sends `SIGTERM` and, 3 seconds later,
  `SIGKILL`.
- **Archive** stops a live session first, the same way.
- **Delete** is refused: the mirrored transcript is a copy that the next pull
  would fetch again.

## Send a prompt

[Remote triggers](automation.md#remote-trigger-targets) can use the same socket
adapter when the global `remoteTriggers` setting is enabled (default off, no
Settings control yet). They share the Send dialog's 30-second dedupe and the
per-host-session bucket of 30 prompts, refilling one every two seconds. Only
single commands to unattached sessions use the socket; attached terminals keep
their existing trigger behavior. Results say `assumed` on success and
`send unconfirmed` when a write may have happened. Remote idle waits read two
completed pulls passively; they never request a refresh.

A live session that is not attached in a terminal has a **Send a prompt…**
button next to Stop. It opens a small dialog; Send (or Ctrl+Enter) writes the
text to the running session as a new prompt. The dialog says *Sent*, never
*delivered*: nothing comes back on that channel, so Switchboard cannot know the
session read it. Read the result in the row's status, which the next refresh
picks up from the session's descriptor.

How it works: the session's descriptor names a messaging socket
(`messagingSocketPath`). Switchboard runs one `ssh` to the host, checks that the
pid is still a `claude` process and that the socket exists, then pipes a single
line of JSON into the socket with `ncat --send-only -U` or `nc -N -U`. The text
travels on ssh's standard input only, never on a command line.

- The host needs `ncat` or an OpenBSD `nc` that supports `-U` and closes on end
  of input. A BusyBox `nc` has no `-U`; the dialog then says nc was not found.
- The socket path is read from the descriptor on the host, never typed or sent
  by the interface, and must be an absolute `.sock` path of plain characters.
- A prompt is limited to 1 MiB once encoded. The same text sent to the same
  session twice within 30 seconds is refused here, because the session would
  drop it.
- A host running Windows is refused: its channel needs the session's key file,
  which Switchboard does not read.
- A session attached in a terminal is refused: type in the terminal.

## Launch a session

The `+` of a remote project opens a dialog: the directory (a list of the host's
known project paths, or any absolute path typed) and the permission mode, with
Dangerous Skip as locally. Start runs one `ssh` that checks the directory
exists (`test -d`), that `tmux` and `claude` are found, then starts
`claude --session-id <uuid>` in a new detached tmux session named
`switchboard-<first 8 of the uuid>`, in that directory. The uuid is generated
by Switchboard. Switchboard then attaches to the new pane the way it attaches to
any running session, so you land in it.

- Only tmux hosts can launch. There is no launch without a multiplexer. A failed
  last refresh does not disable it: it runs its own ssh.
- A directory that does not exist on the host refuses the launch, and the
  terminal tab says so.
- Authentication is done on the host, by you. Switchboard copies no credential;
  a CLI that is not logged in shows its own login prompt in the pane.
- `claude` must be on the `PATH` of a non-interactive ssh command. When it is
  only added by an interactive shell profile, the launch says it was not found.
- The directory may only contain letters, digits, space and `. _ + @ : , = / -`,
  must be absolute and must not contain a `..` segment. Anything else is refused
  before ssh runs.
- Only the permission mode maps to a CLI flag. The local dialog's worktree, Chrome,
  sandbox, pre-launch command and additional directories do not apply to a remote
  launch.
- Stop works as for any remote session: it kills the pane, never the tmux
  session. Closing the only pane of a session ends that session.
- Linux hosts only, as for attach.

## Known limits

Session ids are not namespaced per host. Two hosts with a session of the same
id would share its pin, name and archive state.
