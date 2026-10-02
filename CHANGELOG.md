# Changelog

What changes for you in each release of Switchboard. How to write an entry: [docs/changelog.md](docs/changelog.md).

## Unreleased

### Fixed
- Stopping a terminal twice in quick succession, or resizing it while it is being stopped, no longer closes the Windows pseudo console twice, which could kill the whole app with no error. (#405)
- A sandboxed session, or a sandboxed schedule, whose Additional Directories include a `.claude` or `.git` directory, or a path inside one, is now refused instead of binding it read-write over its read-only protection; add the project directory instead. A session started in a `.claude` or `.git` directory is refused too, except below `.claude/worktrees`, and Additional Directories naming your home directory or a parent of it are refused however the path is written. A relative `add-dirs` entry in a schedule is taken from the schedule's directory. (#385)
- A session that has exited no longer keeps a busy dot in the sidebar, and the status bar's running count drops as soon as the session ends instead of waiting for the next refresh. (#375)
- Quitting, closing the window or reloading while a file in the file panel has unsaved edits now asks first, in any session, kept-aside tabs included: Save writes them (a file that changed on disk is not overwritten), Discard drops them, Cancel stays. If Switchboard does not answer within a few seconds, it closes anyway. (#373)
- The IDE Emulation label in a session's terminal header now says whether the CLI is connected: it reads "IDE Emulation" only while it is, "IDE Emulation: waiting for CLI" when Switchboard is listening but the CLI has not connected, and "IDE Emulation: failed" when it could not start for that session, with the reason in its tooltip. A session whose IDE Emulation port was already taken no longer shows the label as if it worked. (#320)
- On Windows, the file panel no longer opens or saves a credential file (such as one under `.ssh`) through its 8.3 short name or a `\\?\` path. (#390)
### New
- A session's Changes panel also lists the changes in the worktrees its subagents are working in, under a header naming the agent and its branch. Those rows open as read-only diffs; a subagent that works in the session's own directory adds nothing. (#303)
- A live session on a remote host that is not open in a terminal has a Send a prompt… button on its row: type a text and it is written to the running session as a new prompt, without attaching. It needs `ncat` or an OpenBSD `nc` on the host, and is refused for a Windows host. The dialog says "Sent": the session's own status shows whether it picked the prompt up. (#219)
- A remote session that is not open in a tab and waits on a dialog on its host, such as a permission prompt or a question, shows the orange attention state, and its status line says what it waits for. It appears and clears with the next refresh of the host. (#394)

## v0.0.86 — 2026-10-01

### New
- A session that has a claude.ai bridge shows an Open on claude.ai button in its sidebar row, which opens that session on claude.ai; a session without one shows nothing. (#213)
- A schedule with `catch-up: true` in its front matter runs once, as soon as Switchboard starts or the machine wakes up, when it fell due while Switchboard was closed or the machine asleep, however many runs were missed in the last seven days. Without it, a missed run is still skipped. (#334)

### Changed
- Without `SWITCHBOARD_SSH_PATH`, the terminal attached to a remote session now runs the `ssh` found on your `PATH` before `/usr/bin/ssh` or the Windows system client, like every other remote operation. `SWITCHBOARD_SSH_PATH` must be an absolute path: a relative one is ignored, with a warning in the log. (#359)

### Fixed
- Hovering terminal output no longer freezes Switchboard when the session's working directory is on a slow network drive: the paths on the line are checked a few at a time without blocking the app. (#322)
- A sandboxed session can no longer leave behind something that runs outside the sandbox later: in `~/.claude` and in every `.claude` of the project, worktrees included, only the session's own state (its transcripts, todos, credentials) stays writable, each repository's config and hooks are read-only, other sessions' shell snapshots and session hooks are out of its reach, and its changes to `~/.claude.json`, where the MCP servers are, are dropped when it ends. A new `.git/commondir`, or a repository or worktree the session creates, still carries config and hooks git will follow. Change settings, permissions, plugins and MCP servers outside the sandbox; the Sandbox indicator's tooltip lists what stays writable. (#358)
- A schedule runs only in a project where Switchboard launched a session, or that you added with Add project; open a session once in a project whose schedules it never ran. Schedules you already have keep running. A sandboxed schedule is sandboxed by the nearest project setting above it, and one whose `add-dirs` include a directory under your home that is not such a project is skipped, with the reason in the main log. (#358)
- A project that gets its first schedule after this change does not run it until you have opened a session in that project or added it with Add project; a schedule is no longer picked up just because its file appears in a project Switchboard has never recorded. (#372)
- The podman socket is no longer bound into the sandbox by default: through it a session can mount any host path into a container. Put `SWITCHBOARD_SANDBOX_PODMAN=1` in the Pre-launch Command to bind it. (#358)
- A sandboxed session reaches the API when `/etc/resolv.conf` links into `/run`, as with systemd-resolved on Ubuntu. (#367)
- The "Finishing indexing before restoring N sessions" bar no longer stays up when a saved session is not in the index: once indexing is over the session is dropped from the restore and a notice names it. (#376)
- A filter or a search no longer files the subagents of a hidden session under "Orphan subagents". With the starred, running or today filter on, they are hidden with their session; a search hit inside a subagent shows it under its session. The group keeps only subagents whose session is gone. (#356)
- A session started from a Switchboard that was itself launched inside a Claude Code session is now a top-level session: it saves its transcript and no longer inherits the parent session's id, socket or IDE link. `CLAUDE_CONFIG_DIR`, `ANTHROPIC_*` and provider switches are kept. (#378)
- A file with unsaved edits in the panel is no longer discarded when the session opens another file, proposes an edit, or a link opens Changes. It is kept aside, named above the file shown, and comes back when the diff or Changes closes, with a notice if the file changed on disk. (#364)
- Saving a file in the panel before its editor has finished loading no longer empties the file on disk; Save stays disabled until the file is shown. (#369)
- `SWITCHBOARD_SSH_PATH` now applies to every connection to a remote host, not only the attached terminal: the pulls, the copy of transcripts, the watch connection, stop and the Changes view use it too. Transcripts are copied with the `scp` beside it, or with `SWITCHBOARD_SCP_PATH` when set. (#359)
- The New Session and Resume Session dialogs no longer grow taller than a short window: they stay below the title strip, the title and the Start or Resume and Cancel buttons stay visible, and the options in between scroll. (#377)

## v0.0.85 — 2026-09-30

### New
- After an update, a "What's new" dialog lists the changes of every version since the one you last ran. Help → What's new opens it again for the current version. (#363)
- An untracked file's line counts show in the Changes list without opening it, and count in the header total. A row that cannot be counted says why: binary, too large, not counted, or count on open for a remote session. (#350)

### Changed
- The session header's controls sit in one row with one look: Sandbox and IDE Emulation are plain indicators, Shell and Changes are icon buttons that show when they are on, and Stop comes last. (#348)
- Whether the session runs is a dot before its name, and its tooltip says how the process ended: stopped, killed, or exited with a code. (#348)
- The Changes panel and its editor use the app's own look: icon buttons, the dark surfaces of the sidebar, a badge for each file's state, and softer diff colours. (#351)

### Fixed
- Saving from the file panel, the Memory panel or the MCP diff tab no longer overwrites a file that changed on disk since you opened it. You are told, and asked before your edits replace it. (#355)
- When an open file changes on disk, the panel reloads it if you have no unsaved edits, and otherwise keeps them and offers Reload or Keep my edits. It keeps noticing changes after the file is replaced, deleted or recreated. (#355)
- Switching tabs or sessions no longer drops a file tab's unsaved edits. (#355)
- A save that fails says "Save failed" instead of failing silently, including one that finishes after you switched to another tab. (#355)
- Once an MCP diff has been accepted or rejected, its tab's Save button is disabled, and its tooltip says why. (#355)
- Undo no longer brings back an edit made in another file, or before the file was reloaded. (#355)
- The Changes panel works when a session's directory is below the repository root; tracked files' diffs came back empty there. (#350)
- A file with a merge conflict is badged `U` (Unmerged) in the Changes list, instead of Added or Deleted. (#351)
- A plain terminal no longer types its `claude` shim into the shell, so the line stays out of your shell history and off the screen. (#352)
- Archiving a session no longer moves its subagents into "Orphan subagents". (#354)

## v0.0.84 — 2026-09-29

### New
- The window draws its own title bar: the sidebar's top row holds a ☰ menu button, and the window controls sit in the top-right corner. The window gains the height the frame took, and every menu shortcut still works. (#338, #341)
- Ctrl+- and Ctrl+0 zoom on any keyboard layout, AZERTY included, and so do the numeric keypad's +, - and 0. (#338)

### Fixed
- A session running in another process, another Switchboard or a CLI in a terminal, is no longer resumed automatically on a reload or a restore. A notice names the process, and opening the session by hand asks first. (#337, #343)

## v0.0.83 — 2026-09-29

### New
- Switchboard can report to a local ActivityWatch server the session you are looking at and every session that runs, without any prompt or transcript content. It is off by default: turn it on in Settings → Activity Reporting. (#326)

### Fixed
- A right-click in a session's terminal no longer pastes the clipboard into Claude Code's prompt outside Native mode, and the terminal keeps its focus. (#330)
- On Windows, the activity trace no longer leaves a rotated file behind. (#328)

## v0.0.82 — 2026-09-22

### New
- A path or a filename in terminal output is a link that opens the file in the side panel, at the line for `path:line`. Only a file the panel can open is underlined. (#319)

### Fixed
- The settings panel shows the value a new session gets. IDE Emulation showed as on while sessions started with it off. (#317)

## v0.0.81 — 2026-09-18

### New
- Click a file in the Changes list to edit it in place, under the list, with the diff updated as you type: inline, side by side, or plain. A save onto a file that changed underneath you is refused, not merged. (#302)
- A shell under the Changes list runs in the session's own directory, worktree included. It is not a session: it never shows in the sidebar. (#300, #305)
- Untracked files are listed in Changes with a real diff and line counts. (#298)

### Changed
- The Changes panel always opens, and says "No changes" or that the directory is not a git repository, instead of showing git's own error. (#305, #310)

### Fixed
- An exited plain terminal reopens as a terminal, not as a Claude session with no transcript. (#305)
- The sidebar no longer overflows the window by the status bar's height, which could clip the top row of icons until a reload. (#306)

## v0.0.80 — 2026-09-17

### Changed
- A `schedule-*.md`, a `CLAUDE.md` or a memory note reached through a symlink is listed in the brain tab, and a linked schedule can be run from it. (#294)
- A project-root `CLAUDE.md`, `GEMINI.md` or `agents.md` that links to a file outside every open project and outside `~/.claude` is no longer listed. To list it again, move the link's target into a directory you have opened as a project. (#296)

### Fixed
- A FIFO, a socket or a device named `CLAUDE.md` in a project no longer freezes the app. (#296)
- A file reached through a symlink is checked against the credential denylist before it is read, so a linked key or `.env` no longer reaches the search index. (#294, #296)
- An unreadable file in a scanned directory no longer hides the files listed after it. (#296)
- An attached remote session's row shows the session's title. (#293)

---

Older versions: see [GitHub Releases](https://github.com/devsuitup/switchboard/releases).
