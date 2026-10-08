# Session Browser

The left sidebar lists every Claude Code session Switchboard has indexed from
`~/.claude/projects`, grouped by project.

![Switchboard](../build/screenshot.png)

## Tabs and buttons

The sidebar's top row is also the window's title strip (see [Window](window.md)).
From left to right:

- **☰** — the application menu (Windows and Linux; on macOS the menu is in the
  system menu bar).
- **Sessions** — the session list described on this page.
- **Agent Files** and **Work Files** — see [Agent Files and Work Files](memory-workfiles.md).
- **Stats** — see [Stats](activity-stats.md).
- **Global settings** (gear) — see [Settings reference](settings.md).
- **Hide sidebar** — collapses the sidebar to a narrow column; the same button
  there brings it back.

Drag the sidebar's right edge to resize it. The width is remembered.

Below the tabs, on the Sessions tab, a row of buttons:

| Button (tooltip) | Effect |
|---|---|
| Show running only | Only sessions with a live process |
| Show pinned only | Only pinned sessions |
| Show today's sessions only | Only sessions modified today |
| Show archived sessions | Includes archived sessions in the list |
| Session overview | Toggles the [grid](grid-overview.md) |
| Re-sort sessions | Sorts the list again; between re-sorts, rows keep their place as they update |
| Add project | Opens the Add Project dialog |

"Running" and "pinned" exclude each other: turning one on turns the other off.
"Today" combines with either.

## Projects

Each project is a collapsible group headed by its last two path segments. A
project whose most recent session is older than **Session Max Age** starts
collapsed.

Buttons on a project header:

| Button (tooltip) | Effect |
|---|---|
| Create scheduled task | Opens a Claude session that writes a schedule file — see [Automation](automation.md#creating-a-schedule) |
| Project settings | Per-project overrides — see [Settings reference](settings.md#project-settings) |
| Archive folder | Opens a dialog that archives the folder's sessions and disables its schedules, each optional, and hides the folder — see [Archive a folder](#archive-a-folder) |
| New session (`+`) | The launch menu — see [Launching sessions](launching-sessions.md) |

A project on a [remote host](remote-hosts.md) carries a host status dot and a
**Reconnect** button instead, and its `+` is disabled.

**Add Project** takes a folder path (typed or picked with **Browse**). It creates
`~/.claude/projects/<encoded path>/` and, if that folder holds no transcript, a
one-line placeholder transcript whose `cwd` is the folder, so the project is
listed before any session has run in it.

**Hide Project**, in Project Settings, removes a project from the sidebar
without deleting any file. Adding the same folder again with **Add Project**
shows it again. Unlike **Archive folder**, it also drops the project's settings
and its schedule registration, and a new session in the folder does not show
it again.

Sessions run in a git worktree are listed in their repository's project — see
[Worktree sessions](worktrees.md). A worktree folder is nested under its
repository only when that repository is listed for the same host; a worktree of
another host, or one whose repository is not listed, is shown as a project of
its own. The worktrees of a repository hidden with **Hide Project** stay hidden
with it.

### Missing projects

A project whose directory no longer exists is shown with a warning icon and
starts collapsed. Its sessions cannot be opened (tooltip: *Project path no
longer exists — use "Change path" to fix*). **Change project path** on its
header picks the directory's new location and rewrites the `cwd` recorded in
every transcript of that project, subagent transcripts included, so the
sessions resume there — from Switchboard and from the `claude` CLI. Each file
is rewritten through a temporary copy and a rename. The rewrite is refused
while a session of that project is running.

## Session rows

A row shows, from left to right:

- the **pin**;
- the status icon — see [Status indicators](notifications.md);
- the session's name, then its age, message count, the first segment of its
  id, and, while the `claude` CLI reports one, its status (`busy`, `idle`,
  `waiting`) and how long ago it changed;
- a host badge for a remote session, a terminal badge for a plain terminal.

Hovering a row shows its buttons:

| Button (tooltip) | Effect |
|---|---|
| Stop session | Ends the session's process, after a confirmation |
| Archive / Unarchive | Hides the session from the normal list (stopping it first if it runs), or brings it back |
| Fork session | Starts a new session branched from this one — see [Launching sessions](launching-sessions.md#fork) |
| View messages | Opens the transcript in the read-only viewer |
| Delete session | Removes the transcript from disk, after a confirmation |
| Resume with config | Opens the Resume dialog — see [Launching sessions](launching-sessions.md#resume-dialog) |

Clicking a row opens the session in the terminal: it attaches to the running
process, or resumes the session with `claude --resume`. A subagent row opens its
transcript instead — see [Subagents](subagents.md).

### Names

The name shown is, in order of preference: a name given in Switchboard, the
title Claude Code generated for the session, or the session's summary.
Double-click a name to rename the session; the name is stored in Switchboard's
database, not in the transcript. A name set with Claude's `/rename` command is
picked up the next time the session is indexed.

### Order and limits

Within a project, running pinned sessions come first, then running sessions,
then pinned ones, then the rest by modification time.

Each project shows at most **Max Visible Sessions** (default 10) sessions
modified within **Session Max Age** (default 3 days); the others sit behind a
`+ N older` link. Running and pinned sessions are always shown. Both limits are
in [Global Settings](settings.md#application).

### Sessions started by a program

A session that a program started through the Claude Agent SDK — a headless
`claude -p` run, a review tool spawning one session per batch of files — is
left out of the list: its transcript carries no link to the session that
launched it, so it cannot be nested under it like a subagent. Turn off **Hide
SDK-launched Sessions** in [Global Settings](settings.md#application) to list
them. Their subagents are hidden with them, and a project holding only such
sessions is not listed. A session you have open, or left open when Switchboard
last closed, stays listed, and so does one you resumed and typed into.
Scheduled tasks are always listed. Hidden sessions still count in the activity
heatmap.

### Groups inside a project

- Sessions whose transcripts carry the same `slug` are grouped under one row,
  with a count and an **Archive all sessions in group** button. The runs of one
  [schedule](automation.md#schedules) share the schedule's slug.
- Subagents sit under their parent session — see [Subagents](subagents.md).
  Subagents whose parent cannot be found are listed in an **Orphan subagents**
  group at the bottom of the project, collapsed by default; those of an
  archived parent are hidden and shown with it instead.

## Search

The search field filters the current tab by content, through an FTS5 full-text
index held in Switchboard's database:

- on **Sessions**, session and subagent transcripts;
- on **Agent Files**, the listed memory and command files;
- on **Work Files**, the files under `.work-files/`.

Search starts at 3 characters, 350 ms after the last keystroke. Only the first
48 characters of a query are used. **Tt** restricts the search to titles. The
reindex button rereads every session for the index; pressing Enter in the field
does the same. The search runs in a worker thread, so a long query does not
freeze the window.

## Pin and archive

- **Pin**: click the pin at the left of a row. Pinned sessions sort before
  unpinned ones and are never hidden behind `+ N older`.
- **Archive**: the archive button on a row, or **Archive all sessions in
  group** on a slug group. Archiving a running session stops it first — on its
  host, for a remote session. The group button skips and reports any session
  that fails to stop, and leaves it unarchived. Archived sessions are listed
  with the **Show archived sessions** filter.

### Archive a folder

**Archive folder** on a project header opens a dialog with two boxes, both
ticked by default and remembered from one use to the next:

- **Archive the N sessions**: archives every top-level session of the folder and
  of its nested worktrees, whatever the search or filters show. Subagents are
  left alone. Running sessions are stopped first, on their host for a remote
  session. If any session fails to stop, the failure is shown on its row and
  nothing is archived, neither the sessions nor the folder; the sessions that
  did stop stay stopped.
- **Disable the M enabled schedules**: writes `enabled: false` into the
  folder's schedule files — see [Automation](automation.md#schedules).
  A schedule file reached through a symbolic link is left as it is, and the
  dialog names it.

Confirming hides the folder and its nested worktrees from the sidebar, even
with both boxes unticked. **Show archived sessions** shows it again, and search
still finds its sessions. The folder comes back, with its settings, when it is
added again with **Add Project**, or when a session it did not hold at archive
time appears in it: a new session, a fork, a new plain terminal, a run of a
schedule left enabled, or a new session in one of its worktrees. Resuming or
unarchiving one of its sessions does not bring it back. While Switchboard is
still indexing sessions, the folder cannot be archived.

When a folder whose schedules the archive disabled comes back, a notice at the
top of its group names them: **Turn back on** writes `enabled: true` into each
file that still reads `enabled: false`, and leaves a file you have re-enabled or
edited since as it is; a file it cannot change is named in the notice, which
stays until you dismiss it. **Dismiss** leaves the schedules disabled. Archiving
the folder again replaces the notice; the schedules it named that are still
disabled are offered again the next time the folder comes back. A folder with a
notice is not collapsed automatically.

## Stop

The stop button (on a row, in the terminal header, or on a grid card) ends the
session's process after a confirmation. For a session on a remote host the
dialog names the host, and the process on that host is ended — see
[Remote hosts](remote-hosts.md#stop-archive-delete).

## Delete

The delete button **permanently removes the session's transcript from disk**,
with every subagent transcript belonging to it and their index entries. There is
no trash. The confirmation dialog names the project, the number of files on
disk and the number of subagent transcripts.

- A running local session is stopped first. If it cannot be stopped, the delete
  is refused with the reason.
- A session on a remote host is never deleted: its transcript is a mirrored
  copy that the next refresh would fetch again.
- A transcript that resolves outside `~/.claude/projects` (through a symbolic
  link, for instance) is refused and logged.
- A session that never started has no transcript; deleting it removes the row.

Archive a session instead to keep its file.
