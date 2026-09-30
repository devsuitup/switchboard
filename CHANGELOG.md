# Changelog

What changes for you in each release of Switchboard. How to write an entry: [docs/changelog.md](docs/changelog.md).

## Unreleased

### New
- A schedule with `catch-up: true` in its front matter runs once, as soon as Switchboard starts or the machine wakes up, when it fell due while Switchboard was closed or the machine asleep, however many runs were missed in the last seven days. Without it, a missed run is still skipped. (#334)
### Fixed
- A sandboxed session can no longer leave behind something that runs outside the sandbox later: in `~/.claude` and in the project's `.claude` only the session's own state (transcripts, todos, credentials) stays writable, the repository's git config and hooks are read-only, and its changes to `~/.claude.json`, where the MCP servers are, are dropped when it ends. Change settings, permissions, plugins and MCP servers outside the sandbox; the Sandbox indicator's tooltip lists what stays writable. (#358)
- A sandboxed session reaches the API when `/etc/resolv.conf` links into `/run`, as with systemd-resolved on Ubuntu. (#367)

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
