# Changelog

What changes for you in each release of Switchboard. How to write an entry: [docs/changelog.md](docs/changelog.md).

## Unreleased

### Fixed
- On Linux and Windows, `/clear` (or `/reset`, `/new`) in a session keeps the open terminal on its sidebar row, which now follows the new conversation, instead of listing that conversation as a separate session. The cleared conversation stays in the list as a past session, and a session quit after `/clear` before its first prompt comes back on restore as a new session in the same project. On macOS the new conversation is still listed apart. (#477)

## v0.0.92 — 2026-10-10

### Fixed
- The Agents view shows a finished job whose conversation is still running as one live session, keeps its job id and state, and keeps jobs open here out of External. Respawn and Delete check whether the conversation is still held; Stop checks this only for a known finished job and keeps an attached tab open if refused. Transcript checks its file when clicked and explains when it is missing or not indexed yet. (#522)
- Conversations sharing a web session now keep their own older messages when another conversation continues later. Continuations stay with the conversation they continue, and previously missing local and remote conversations return after upgrading without blocking the interface while their history is indexed. (#524)
- On Windows, writing to a terminal that is closing no longer raises an uncaught main-process exception, including when closing an attached agent tab. (#517)
- Restoring a conversation that continued under another id now opens its continuation and saves the new id, waits and retries when indexing finishes, and keeps live continuations available before their first transcript is saved. Unrelated damaged or oversized records no longer block restore; multiple or unresolved continuations, including when process status cannot be read, stay saved with a notice to open the old session and choose a continuation or explicitly reopen the original. (#518)
- On Windows, a session running in one of Switchboard's own tabs no longer shows as an External session in the Agents view, and opening it no longer reports it as running in another process. The Agents header now also counts the External sessions it lists. (#521)

## v0.0.91 — 2026-10-09

### New
- Remote sessions now have a Touched list and can open its files read-only, with their HEAD diff inside the session's repository. The list stays visible with unknown disk states when the host cannot be reached. Password databases and private keys on the host are refused. (#454)

### Changed
- Changes, a pending Diff, Touched and Shell move to a vertical bar on the right, with rebindable Ctrl/Cmd+Shift+E/D/T/S shortcuts; Refresh and Stop sit beside the session id. Switching tools keeps your edits and an unanswered Diff while the CLI is connected, forking keeps Changes open, the shell stays below every tool, and narrow windows keep the bar and session id visible while restoring your chosen widths when there is room. (#506)

## v0.0.90 — 2026-10-09

### New
- An Agents view lists the sessions the Claude daemon runs in the background (`claude --bg`) and the interactive sessions running outside Switchboard, grouped by state or by project and worktree. Open it from the people icon in the sidebar or with Ctrl+Shift+A (Cmd+Shift+A on macOS); attach to a live one by double click, stop, respawn or delete one, and start a new one with New agent. A background session that is running shows a `bg` badge in the sidebar and is attached instead of resumed. (#374)
- **Archive folder** on a project header opens a dialog that archives the folder's sessions and disables its enabled schedules, each optional, and hides the folder with its worktrees. The folder comes back, with its settings, when you add it again or a new session starts in it, and then offers to turn back on the schedules the archive disabled. (#473)
### Changed
- New scheduled task runs appear under a header named after their schedule, even with only one visible run. Schedules that use the same prompt stay separate; older runs keep their existing grouping. An old expansion choice is inherited only when it identifies one schedule across projects and hosts. (#489)
- Markdown files open formatted in Touched, with a toggle back to the source that is remembered. (#472)
- Clicking a file in the terminal, or a file Claude opens, shows it in Touched, at the top of the list as opened when the file tools did not touch it, with its diff against HEAD when it changed. A `path:line` link opens the source at that line, symbolic links open read-only, and files Claude opens get the panel's checks, which refuse credential paths, binary files and files over 2 MB. (#472)
- Sessions a program started through the Claude Agent SDK, such as headless runs or review agents, no longer fill the sidebar and grid. Turn off **Hide SDK-launched Sessions** in Global Settings to list them again. Sessions you have open, scheduled tasks and sessions you continued by typing in them stay listed, and the activity heatmap still counts the hidden ones. (#486)
### Fixed
- The New background agent dialog keeps fields inside their rows and aligns Project, Name and Agent. Permissions offer Accept Edits, Auto, Plan and Bypass, preselecting the project's mode when it is one of them and Accept Edits otherwise; additional directories use one path per line, preserving commas in paths. (#501)
- Automation triggers to a running background session now report `background session, not attached here` with its job id when no attach tab is open. Attach it from the Agents view to deliver the trigger through that tab. (#495)
- Opening a session while its scheduled task is running asks you to wait instead of starting a second process on the same transcript. Automatic restores skip it until the run finishes. (#484)
- A `/compact` trigger waits for compaction evidence before reporting confirmation, including when retained records follow it; a chain resumes once the session is ready, or stops without resuming if evidence misses its deadline. (#488)
- When the Claude CLI reports a session's id in a different letter case, the subagents that session started or finished during a turn now show up when the turn ends. (#487)
- A session that moves into a worktree while it runs stays in the sidebar, under its project, instead of disappearing while its terminal keeps running. A running session also stays listed when its transcript leaves its folder for any other reason. (#485)
- Worktree folders from another host, or whose repository is not listed, show in the sidebar instead of being nested under the wrong folder or not shown at all. The worktrees of a repository hidden with Hide Project stay hidden. (#473)
- Remote triggers refuse commands containing invisible format characters, default-ignorable characters or braille blanks, including joined emoji, emoji with variation selectors (such as hearts), soft hyphens and right-to-left marks. Fullwidth slash, exclamation and number-sign prefixes are refused too. (#440)

## v0.0.89 — 2026-10-04

### New
- Refresh a session's screen from the terminal header or its sidebar context menu. Returning to a solo tmux attachment refreshes it automatically; shared attachments redraw locally on demand without changing another client's window size. (#446)
- Back to list and Escape from a diff restore the Changes list with its scroll position and selection. (#444)
### Changed
- Touched keeps its file list above the editor with a resizable split, moves its explanation into an info dialog, and shares the Settings sort-control style. Settings selects gain the same hover and focus styles, and file and diff headers keep filenames visible when paths are shortened. (#467)
- File panels refuse to open or save paths inside `.git` (Windows short names included) and files that are not valid UTF-8, instead of rewriting their bytes, and no longer save through a symlink. This applies to files opened from terminal links too. (#450)
- Touched files open in the same editor as Changes, with a diff against HEAD when available and the same layout without a diff otherwise. Switching between Touched and Changes keeps each file's unsaved edits. (#450)
- Buttons and scrollbars throughout the app now match the dark theme, including file panel lists, file contents, and the Touched history controls. (#448)
- Touched opens on the last day's files, shows when each was last touched, and sorts by time or path. Show 10 more days extends the history, and reopening the tab reuses unchanged transcripts. (#444)
### Fixed
- Remote terminals recover normal resizing and refresh on return after other clients leave, and clear lingering connections after a restart within the same app profile. Separate dev and test instances keep each other's live terminals attached. (#452)

## v0.0.88 — 2026-10-03

### New
- Single triggers can send prompts to unattached remote sessions when the global `remoteTriggers` setting is enabled; it defaults to off and has no Settings control yet. (#437)
- A session's **Touched** tab, next to Changes in the terminal header, lists the files its file tools (Edit, Write, MultiEdit, NotebookEdit) touched, its subagents' included, with what is on disk now (present, gone, unreadable) and the tools and agents behind each. It works outside any git repository. It is not the complete set of files the session changed: files changed through Bash commands or scripts are not listed, and the tab says so. Local sessions only. (#309)
- With Debug mode on, the activity trace now records how hard each terminal is being drawn: once a second per session, how many writes reached it, how large they were and how often its glyph atlas was rebuilt, to tell a legitimately busy terminal from a runaway one. (#175)
- On a remote host with `tmux`, the project's `+` now starts a new Claude session there: pick or type a directory on the host, choose a permission mode, and Switchboard starts it in a tmux session and attaches to it. The directory must already exist on the host, `claude` must be on the PATH of an ssh command, and signing in is done on the host. (#218, #222)
- Each remote host in Settings has a **Check host** button: it reports whether the host is reachable, has `claude` (with its version), `tmux` and a `~/.claude`, and whether the account is logged in. For anything missing it shows the command to run on the host, with a copy button. It does not install, log in or write anything itself, and never copies or reads credentials. A login it cannot tell is shown as unknown, not as logged out. Linux hosts only. (#222)
### Changed
- A single trigger is no longer typed into a dialog such as a permission prompt or a question: with `wait: "none"` (write now, the default) it holds while the CLI shows a dialog, and with `wait: "idle"` until the CLI is at its prompt, up to its `timeout_ms`; then it fails `not sent` with a `reason` that says a dialog is open instead of being written into it. `wait: "none"` still writes at once while the CLI is busy. Without a readable CLI descriptor it is written as before. Input you type yourself in the terminal is never held back. (#379)
- Switchboard now checks once per host, at the first successful refresh and then every six hours (every 30 minutes while one is missing), whether `tmux` and `inotifywait` are installed. A host with `tmux` and no session running no longer shows attach as missing; a host without `tmux` no longer offers to attach to a session and opens its transcript, saying why in the tooltip; and the host's tooltip says when live updates are off because `inotifywait` is missing. On a remote host, the new-session button's tooltip now gives the reason, and Send a prompt… is disabled, with the reason, while no live session on the host reports a messaging socket. Stop is never disabled. (#218)
- A trigger that gave up waiting for a session now says, in its result file's `reason`, when the session was blocked on a dialog such as a permission prompt or a question: for a single trigger, a chain's first wait, and a chain step whose turn never finished. Without a dialog the result is as before. (#379)
### Fixed
- A trigger chain no longer stops after its first step while background agents are running: when the CLI keeps reporting itself busy but the session transcript shows the turn finished, with no new write for 3 seconds and no dialog open, the next step is sent, and the step's `ready_source` / `idle_source` in the result file says `transcript`. A step typed while the CLI reports busy, such as `/compact`, is confirmed once the transcript shows it and its turn finished (`confirm_source` says `transcript`), up to the step's deadline; past it, or after 30 seconds for a step other than `/compact` that never shows, the chain stops with `step not confirmed` and nothing more is typed. Give a chain that starts with `/compact` a `timeout_ms` of 600000. (#360)
- The Changes panel no longer shows `fatal: .git/index: index file open failed: Permission denied` now and then on Windows: a session's local changes are read one git call at a time instead of three at once. (#421)
- On Windows, closing or resizing a terminal at the moment its shell exits should no longer crash the whole app: a known cause is fixed in the terminal library. (#409)

## v0.0.87 — 2026-10-02

### New
- A remote host's project header now shows what the host supports: hover its status dot to see the highest capability reached (observe, liveness, inject, attach) and, for each one above it, why it is missing. (#218)
- A session's Changes panel also lists the changes in the worktrees its subagents are working in, under a header naming the agent and its branch. Those rows open as read-only diffs; a subagent that works in the session's own directory adds nothing. (#303)
- A live session on a remote host that is not open in a terminal has a Send a prompt… button on its row: type a text and it is written to the running session as a new prompt, without attaching. It needs `ncat` or an OpenBSD `nc` on the host, and is refused for a Windows host. The dialog says "Sent": the session's own status shows whether it picked the prompt up. (#219)
- A remote session that is not open in a tab and waits on a dialog on its host, such as a permission prompt or a question, shows the orange attention state, and its status line says what it waits for. It appears and clears with the next refresh of the host. (#394)
### Changed
- After three failed refreshes of a remote host in a row, a row that would have attached opens its transcript and says why in its tooltip, instead of failing when clicked. Stop is never disabled: it runs its own ssh. (#218)
### Fixed
- A step of a trigger chain, the first one included, is no longer typed while the CLI reads busy or waiting on a dialog: it waits for the CLI to be at its prompt, up to the step's deadline, then fails cleanly with a reason instead of being written; a step whose Enter did not start a turn is retried once, or stops the chain when that retry is withheld because the CLI is busy (for a local session, after waiting for the step to show in the transcript) or waiting on a dialog, or you have typed input pending, and is reported as "not confirmed submitted" instead of "sent". Without a readable CLI descriptor a step is still written as before, but no longer once its own deadline has passed. Single triggers are not covered. (#407, #360)
- After an upgrade, schedules keep running in a project that has settings of its own and in a git checkout that already holds a schedule; any other project, opened before the upgrade or not, runs no schedule until you open a session in it or add it. (#385)
- Stopping a terminal twice in quick succession, or resizing it while it is being stopped, no longer closes the Windows pseudo console twice, which could kill the whole app with no error. (#405)
- A sandboxed session, or a sandboxed schedule, whose Additional Directories include a `.claude` or `.git` directory, or a path inside one, is now refused instead of binding it read-write over its read-only protection; add the project directory instead. A session started in a `.claude` or `.git` directory is refused too, except below `.claude/worktrees`, and Additional Directories naming your home directory or a parent of it are refused however the path is written. A relative `add-dirs` entry in a schedule is taken from the schedule's directory. (#385)
- A session that has exited no longer keeps a busy dot in the sidebar, and the status bar's running count drops as soon as the session ends instead of waiting for the next refresh. (#375)
- Quitting, closing the window or reloading while a file in the file panel has unsaved edits now asks first, in any session, kept-aside tabs included: Save writes them (a file that changed on disk is not overwritten), Discard drops them, Cancel stays. If Switchboard does not answer within a few seconds, it closes anyway. (#373)
- The IDE Emulation label in a session's terminal header now says whether the CLI is connected: it reads "IDE Emulation" only while it is, "IDE Emulation: waiting for CLI" when Switchboard is listening but the CLI has not connected, and "IDE Emulation: failed" when it could not start for that session, with the reason in its tooltip. A session whose IDE Emulation port was already taken no longer shows the label as if it worked. (#320)
- On Windows, the file panel no longer opens or saves a credential file (such as one under `.ssh`) through its 8.3 short name or a `\\?\` path. (#390)

## v0.0.86 — 2026-10-01

### New
- A session that has a claude.ai bridge shows an Open on claude.ai button in its sidebar row, which opens that session on claude.ai; a session without one shows nothing. (#213)
- A schedule with `catch-up: true` in its front matter runs once, as soon as Switchboard starts or the machine wakes up, when it fell due while Switchboard was closed or the machine asleep, however many runs were missed in the last seven days. Without it, a missed run is still skipped. (#334)

### Changed
- Without `SWITCHBOARD_SSH_PATH`, the terminal attached to a remote session now runs the `ssh` found on your `PATH` before `/usr/bin/ssh` or the Windows system client, like every other remote operation. `SWITCHBOARD_SSH_PATH` must be an absolute path: a relative one is ignored, with a warning in the log. (#359)

### Fixed
- Hovering terminal output no longer freezes Switchboard when the session's working directory is on a slow network drive: the paths on the line are checked a few at a time without blocking the app. (#322)
- A sandboxed session can no longer leave behind something that runs outside the sandbox later: in `~/.claude` and in every `.claude` of the project, worktrees included, only the session's own state (its transcripts, todos, credentials) stays writable, each repository's config and hooks are read-only, other sessions' shell snapshots and session hooks are out of its reach, and its changes to `~/.claude.json`, where the MCP servers are, are dropped when it ends. A new `.git/commondir`, or a repository or worktree the session creates, still carries config and hooks git will follow. Change settings, permissions, plugins and MCP servers outside the sandbox; the Sandbox indicator's tooltip lists what stays writable. (#358)
- A schedule runs only in a project where Switchboard launched a session, or that you added with Add project; open a session once in a project whose schedules it never ran. Schedules you already have keep running if they are in a git checkout (or a project with settings of its own). A sandboxed schedule is sandboxed by the nearest project setting above it, and one whose `add-dirs` include a directory under your home that is not such a project is skipped, with the reason in the main log. (#358)
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
