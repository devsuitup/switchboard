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

**Archive Project**, in Project Settings or on a worktree header, removes a
project from the sidebar without asking. A notice offers **Undo** for about
10 seconds. Its settings and cache are kept. Schedules are suspended without changing
their files. **Unarchive** in Settings → **Archived projects**, or **Add Project**
on the same local folder, restores it and resumes scheduling. Unlike **Archive
folder**, a new session does not restore it automatically. **Delete Project**
separately removes settings, cache, search entries and schedule registration;
its confirmation names these losses. It deletes no folder or transcript.

Sessions run in a git worktree are listed in their repository's project — see
[Worktree sessions](worktrees.md). A worktree folder is nested under its
repository only when that repository is listed for the same host; a worktree of
another host, or one whose repository is not listed, is shown as a project of
its own. The worktrees of a repository archived with **Archive Project** stay hidden
with it.

### Missing projects

A project whose directory no longer exists is shown with a warning icon and
starts collapsed. Its sessions cannot be opened (tooltip: *Project path no
longer exists — use "Change path" to fix*). **Change project path** on its
header picks the directory's new location and rewrites the `cwd` recorded in
every transcript of that project, subagent transcripts included, so the
sessions resume there — from Switchboard and from the `claude` CLI. Each file
is rewritten through a temporary copy and a rename. The rewrite is refused
while a non-panel terminal of that project is running. A notice explains this
before the folder picker or confirmation opens; stop those sessions first.
The panel shell does not block a path change.

## Session rows

A row shows, from left to right:

- the **pin**;
- the status icon — see [Status indicators](notifications.md);
- the session's name, then its age, message count, the first segment of its
  latest-modified part's id, and, while the `claude` CLI reports one, its status (`busy`, `idle`,
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

A compacted conversation or a proven linear continuation can have several transcripts on one row. A continuation stays together only when its cached links prove a single local path; branching, remote and cross-project conversations remain separate. `/clear` starts a new row. Clicking it
first shows the open tab of its latest-modified part, then another open part
from newest to oldest, then the original transcript's tab. If no part is open,
it resumes the latest-modified part, including the original transcript if it
was used again after compaction or continuation. Automatic restore instead follows a saved part to the terminal id.

On a merged conversation, **Fork session**, **Resume with config** and
**View messages** use that latest-modified part too. View messages shows
that part's transcript. The original part keeps the row identity; name, pin and archive follow the whole-conversation rule below.

Such a row also shows **N parts** next to the short id. Its tooltip explains:
"This conversation has N parts: compaction mirrors and continuations of one exchange".
Right-click the row and choose **Parts** to list every transcript, newest first,
by its own name and last-active date. Each part offers **View messages** and
**Copy id** (the full id). This also works for mirrored remote conversations.

A missing name appears as **Untitled conversation**; a missing date as
**last active unknown**. In the menu, arrow keys move between actions,
Right opens Parts, Left returns, and Escape dismisses the menu.
The session menu takes keyboard focus and returns it to the row after an action or Escape.

When Switchboard remembers a choice for a branched conversation, the row's
right-click menu also offers **Choose part to open…**. It opens the chooser
with your saved choice selected when it is still listed. **Open** changes the
choice; **Cancel** keeps it and opens nothing. The menu works while a part is
already open, too. Deleting the conversation removes its saved choice.

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

- Runs of the same [schedule](automation.md#schedules) are grouped under its
  name, with a count and an **Archive all sessions in group** button. Grouping
  uses the recorded schedule identity (`scheduleSlug`). Other conversations
  each have their own row, even when their CLI slugs match.
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

A compacted or continued conversation matches when any of its parts matches, including its
latest part. A matching subagent stays nested under that conversation even
when it belongs to a later part.

Search starts at 3 characters, 350 ms after the last keystroke. Only the first
48 characters of a query are used. **Tt** restricts the search to titles. The
reindex button rereads every session for the index; pressing Enter in the field
does the same. The search runs in a worker thread, so a long query does not
freeze the window.

## Pin and archive

Name, pin and archive apply to the whole conversation, including compaction
mirrors, rolled continuation parts and a live background row. It stays listed while any part is
unarchived and is pinned when any part is pinned. Its name is the newest user
rename on any part, otherwise the original part's name. Rename, Pin, Unpin,
Archive and Unarchive update every part at once. Its subagents are hidden only
when the whole conversation is archived.

- **Pin**: click the pin at the left of a row. Pinned sessions sort before
  unpinned ones and are never hidden behind `+ N older`.
- **Archive**: the archive button on a row, or **Archive all sessions in
  group** on a slug group. When a running part would be stopped, one
  confirmation names what stops and where, including remote hosts. Cancel
  stops and archives nothing. With nothing running, Archive happens at once.
  A live background job, or a job state that cannot be checked, refuses the
  whole action before a dialog; stop the job from the Agents view first.
  A group skips and reports a session whose stop or archive then fails.
  Either way a notice offers **Undo** for about ten seconds, restoring only
  the rows this click archived. Stopped processes stay stopped. Archived
  sessions are also listed with the **Show archived sessions** filter.

### Archive a folder

**Archive folder** first checks for background jobs; a running job or an
unavailable job check refuses the action before any dialog. It then offers
these boxes when there are sessions or enabled schedules to configure, both
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

The session option names the running sessions and where they run, showing up
to five names followed by +N more. The dialog uses a danger button only when
processes could be stopped. A session that starts while you configure the
Archive requires another confirmation before it can be stopped. With no
sessions or schedules to configure, the folder archives immediately.

When Archive stopped processes, a notice offers **Undo** for about 10 seconds.
It names the worktrees archived with the folder and schedules turned off. Undo
brings back the folder and exactly the sessions this click archived, and turns
back on exactly the schedules it disabled; stopped processes stay stopped.
An empty folder archived without a dialog also offers Undo. An options dialog
with nothing running is configuration and has no Undo notice.

Accepting the options hides the folder and its nested worktrees from the sidebar, even
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

For a session attached to a [background agent](background-agents.md#attaching)
the button detaches without asking, and the session goes on running under the
Claude CLI's daemon; stop it from the Agents view. A notice offers **Undo** for
about 10 seconds to attach it again in the same working folder. Only the
terminal header's button says so (**Detach (the session keeps running)**); the
row and grid card buttons still read **Stop session**.

## Delete

The delete button **permanently removes every part of the conversation from disk**,
including the transcripts merged into a compacted conversation, their subagent
directories and index entries. There is no trash or Undo, and no per-part delete.
An allowed Delete always confirms. The dialog names the project, the number of parts for a
merged conversation, the number of files on disk and the number of subagent transcripts.
Subagent directories are excluded from the file count. A refused preview shows
its reason before any confirmation opens.
If any part's targets cannot be resolved, the whole delete is refused with a
reason, before any files or index entries are removed.

- Any live part, including the row's representative, refuses deletion before
  the preview or dialog. Stop it first; Delete never stops it for you.
  The preview also checks background jobs, processes outside this window and
  unreadable session state, reporting a refusal in a notice before asking.
- The backend checks
  the exact parts confirmed in the preview and refuses if the conversation
  changed while checking; use Delete again to review the updated conversation.
- Remote rows and their context menu offer no Delete action: their transcript
  is a mirrored copy that the next refresh would fetch again. A direct deletion
  request is still refused by the backend.
- A transcript that resolves outside `~/.claude/projects` (through a symbolic
  link, for instance) is refused and logged.
- A session that never started has no transcript; deleting it removes the row.

Members are deleted before the representative. If a file cannot be removed,
the conversation stays listed for retry, fully removed parts leave the indexes,
and the notice names the deleted and remaining parts. Use Delete again to finish.

Archive a session instead to keep its file.
