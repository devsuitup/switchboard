# Launching Sessions

Every Claude session Switchboard runs is a `claude` process in a terminal
(a PTY) owned by the app. This page covers how one is started, resumed or
forked, and with which options.

## The "+" menu

The `+` on a project header offers three entries:

| Entry | What it does |
|---|---|
| **Claude** | Starts a new session at once, with the project's effective settings |
| **Claude (Configure...)** | Opens the New Session dialog, pre-filled with those settings |
| **Terminal** | Opens a plain shell in the project directory — see [Plain terminals](#plain-terminals) |

"Effective settings" are the project's own values where it overrides them, the
global values otherwise, and the built-in defaults where neither was ever saved
— see [Settings reference](settings.md).

A new session's row appears in the sidebar before `claude` has written its
transcript.

## New Session dialog

| Field | Passed to `claude` as |
|---|---|
| Permission Mode | `--permission-mode <mode>`, or nothing for **Default** |
| Dangerous Skip | `--dangerously-skip-permissions`, instead of a permission mode |
| Worktree, with an optional name | `--worktree [name]` — see [Worktree sessions](worktrees.md) |
| Chrome | `--chrome` |
| Sandbox (Linux only) | the session runs under bubblewrap — see [Sandbox](sandbox.md) |
| Pre-launch Command | written in front of the `claude` command |
| Additional Directories | one `--add-dir <dir>` per comma-separated entry |

**Start** (or Enter outside a text field) launches; **Cancel** or Esc closes the
dialog. The values apply to this launch only; they are not saved.

### Permission modes

| Button | Value | Description shown |
|---|---|---|
| Default | none (no flag) | Prompt for all actions |
| Auto | `auto` | Classifier allows routine work, stops for risky actions |
| Accept Edits | `acceptEdits` | Auto-accept file edits, prompt for others |
| Plan Mode | `plan` | Read-only exploration, no writes |
| Don't Ask | `dontAsk` | Auto-deny tools not explicitly allowed |
| Bypass | `bypassPermissions` | Auto-accept all tool calls |
| Dangerous Skip | `--dangerously-skip-permissions` | Skip all safety prompts |

A Switchboard on which Permission Mode was never saved launches with `auto`.
Saving **Default** stores an explicit "no mode", and sessions then launch with
no `--permission-mode` flag.

### Pre-launch Command

The command is prepended to the `claude` invocation, as in
`aws-vault exec profile -- claude …`. It may only contain letters, digits,
spaces and `- _ . / \ : =`; anything else refuses the launch with that message.
That covers a wrapper (`aws-vault exec profile --`), an environment assignment
(`env VAR=value`, or `VAR=value` alone) and an absolute binary path.

## How the command is built

- A new session gets `--session-id <uuid>`, so its row and its transcript share
  an id from the start.
- Opening an existing session runs `claude --resume <id>` in the directory
  recorded in its transcript. For a session started in a worktree, that is the
  worktree, not the repository.
- A session whose row exists but whose transcript was never written (a launch
  that failed at once) is started with `--session-id` and the same id, rather
  than resumed — and, like any start, gets `--worktree` when the effective
  settings have Worktree on.
- On bash, zsh, sh, dash and ksh the command starts with `cd <directory> &&`,
  so a shell profile that changes directory cannot move `claude` elsewhere.
- The command runs in the shell chosen by **Shell Profile**. **Auto** takes
  `$SHELL`; without it, `/bin/zsh`, `/bin/bash` or `/bin/sh` on macOS and
  Linux, and Git Bash, MSYS2 bash or `%COMSPEC%` on Windows. Bash and zsh are
  started with `-l -i -c`, fish and nushell with `-l -c`, so the profile's
  `PATH` and version managers apply.
- With [IDE emulation](ide-emulation.md) on, `--ide` is added.

## Resume dialog

**Resume with config** on a session row opens the Resume dialog: Permission
Mode, Chrome, Sandbox (Linux), Pre-launch Command and Additional Directories,
applied to this resume only. It has no Worktree option: a resumed session keeps
the directory it was started in.

## Fork

**Fork session** on a row starts a new session with
`claude --resume <id> --fork-session`, using the project's effective settings —
including Worktree, which adds `--worktree [name]`: the fork then runs in a new
worktree (see [Worktree sessions](worktrees.md)). The CLI copies the conversation into a new session id; the original is left
as it was. The new row appears at once and takes the new id when the CLI
writes the forked transcript.

## Plain terminals

**Terminal** in the `+` menu opens the login shell in the project directory, as
a row with a terminal badge. Inside it, `claude` is a shell function that prints
*To start a Claude session, use the + button in the sidebar.*: Claude sessions
are started from the sidebar, where Switchboard can track them.

Clicking a terminal row whose shell has exited starts a new shell in that same
row.

## Sessions live in another process

Resuming a session that another process is already running — another
Switchboard instance, or `claude` in an outside terminal — would start a second
CLI on the same session, and both would write its transcript. Switchboard reads
the CLI's own `~/.claude/sessions/<pid>.json` descriptors to detect this,
ignoring the processes it runs itself:

- A click on such a session asks first:
  *This session is already running in another process (pid N in &lt;directory&gt;).
  Resuming it here starts a second claude CLI on the same session, and both will
  write to its transcript. Resume it anyway?*
- An automatic resume skips such a session without asking: the
  [session restore](session-restore.md) at startup, which then names the
  sessions it did not reopen, and the reopening of the active session after a
  renderer reload.

The descriptor file is the CLI's, and undocumented. When it is missing or
unreadable, the check finds nothing and the resume goes ahead.

## Shell and environment

Sessions run with `TERM=xterm-256color`, `COLORTERM=truecolor` and
`TERM_PROGRAM=iTerm.app`; the last one makes Claude Code emit the OSC 9
notifications that drive the [attention indicator](notifications.md).
