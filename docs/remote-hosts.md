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

## Requirements on the host

- A Linux host (`/proc` is read for liveness, attach and stop), a POSIX shell
  and GNU `find`.
- The `claude` CLI writing its usual `~/.claude/projects/` transcripts and
  `~/.claude/sessions/<pid>.json` descriptors.
- For live updates: `inotifywait` (inotify-tools). Without it, only the periodic
  pull runs, and a warning is logged.
- For attach: sessions started inside tmux.
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
on each session. Their `+` is disabled (*Read-only mirror of &lt;alias&gt; — new
sessions must be started on that host*).

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
each one above it why it is missing (for example no live session names a tmux
pane). A tier that needs a live session reads as missing on an idle host. After
three failed refreshes in a row, a row that would attach opens its transcript,
with the reason in its tooltip; **Stop** is never disabled, it runs its own ssh.

A failing host is retried with a doubling delay, up to 30 minutes, and never
dropped; one success resets it. **Reconnect** on the header retries at once and
restarts the watch connection. The sidebar's global refresh retries every host.

A remote session shows the working spinner while its transcript is being
written, until 20 seconds of silence (3 seconds while a subagent is busy), and
never "response ready". A session that has a live descriptor but no transcript
yet (before its first prompt) is listed under its directory's name.

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

## Known limits

Session ids are not namespaced per host. Two hosts with a session of the same
id would share its pin, name and archive state.
