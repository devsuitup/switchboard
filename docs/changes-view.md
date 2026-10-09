# Changes View

**Changes** shows a session's working tree as git sees it — the changed files,
their line counts and their diffs — in the right-hand side panel, and for a
local session it is an editor for those files. It works the same for local and
[remote](remote-hosts.md) sessions, and does not depend on
[IDE emulation](ide-emulation.md).

## Opening it

**Changes** on the right-hand tool bar (Ctrl+Shift+E, Cmd+Shift+E on macOS) opens the panel; clicking it again closes
it. Every session has the button. The panel shows one of:

- the list of changed files;
- **No changes**, when the working tree is clean;
- **This directory is not a git repository.**, when the session runs outside a
  repository. After a `git init` there, the files are listed from the next
  refresh;
- git's own message, when a repository exists but git will not open it (another
  owner, wrong permissions, an unsupported format). The message usually names
  the fix.

A remote session's directory that is not a repository shows git's message too:
telling the two cases apart needs a look at the directory, which Switchboard
can only take on its own machine.

A [path link](terminal.md#clickable-paths) opens the file in
[Touched](touched-files.md#files-opened-from-elsewhere), changed or not. Its
diff there is against HEAD: for a partially staged file it differs from the
Changes diff, which compares an unstaged file with the index.

## The list

- A header: `N files changed +A −B`, the branch, and how far it is ahead of or
  behind its upstream.
- One row per file: a state badge (`M` modified, `A` added, `D` deleted, `R`/`C`
  renamed/copied, `U` unmerged, `?` untracked — hover it for the word), the
  path, and its `+added −deleted` counts in green and red on the row's muted
  metadata — or a marker saying why it has none (see
  [Counts for new files](#counts-for-new-files)). The header and the rows
  form one card, like a project in the sidebar. A new directory is listed file by file.
- At most 500 rows, then `+N more files not shown`; the header still counts
  every file. Tracked changes come first, so what is cut is untracked files.
  When a working tree holds tens of thousands of untracked files, the untracked
  part is listed by directory instead, as `git status` does by default, and the
  panel says so.
- When a subagent of the session works in a worktree of its own, its changes
  are listed after the session's own, under a header with the agent's name and
  branch (at most 8 agents with changes, 100 rows each; the panel counts the agents it leaves out). Those rows open as read-only
  diffs. A subagent in the session's directory, one whose worktree is gone, and
  one with nothing changed add nothing. Local sessions only.
- **Refresh** reloads the list.

Clicking a row opens the file under the list, which stays visible with the row
highlighted. An untracked file opens as an all-additions diff; a binary file as
a one-line note. Drag the divider between list and file to share the space; the
position is remembered. Diffs are cut at 512 KB, with a note.

### Counts for new files

On a local session, an untracked file's row shows its `+added −0` as soon as
the list is shown, like a tracked file's, and the header total includes it.
The count is the number git's own diff of that file reports.

A row that has no count says why, in place of the numbers:

| Marker | Meaning |
|---|---|
| `binary` | A binary file, tracked or not — git gives it no line count. A `.gitattributes` `binary` or `-diff` setting, or a diff driver configured with `binary = true`, counts as binary, as it does for git. |
| `too large` | An untracked file over 1 MiB: too large to count. |
| `not counted` | Past the first 500 untracked files, past 8 MiB read in one refresh, or not reached within the refresh's one-second counting limit (a slow or network drive). Opening it counts it. |
| `count on open` | A remote session: untracked files are counted when you open them. |
| `directory` | The untracked listing is collapsed to directories (see above): the row stands for a whole directory. |
| `no count` | The file could not be read, or is a link to a directory. |

When some rows have no count, the header says how many it leaves out:
`12 files changed +340 −20 (2 files not counted)`.

Opening a row that has a marker fills in its count once the diff is fetched,
and the header total grows by the same amount. A refresh measures again, since
the file may have changed.

## Editing a file

On a local session the open file is an editor. The diff recomputes as you type.

The file's toolbar has four icon buttons, each named by its tooltip: **Close**
(the cross), the view mode, **Reload** (the counter-clockwise arrow) and
**Save** (the disk).

- **Save**, or `Ctrl+S` / `Cmd+S`, writes the file; the button is dimmed and
  inactive until something changed, and lit once there is something to save.
  The list refreshes after a save.
- The button next to **Close** cycles three views, remembered
  (`localStorage.changesDiffMode`); its icon shows the view you are in and its
  tooltip names the next: **Inline** (the default: one column, changes
  marked), **Plain** (the file alone) and **Side-by-side** (the version git
  compares against on the left, read-only; the working copy on the right).
- The left-hand side is what `git diff` compares against: the staged version for
  a row opened as staged, the last commit otherwise.
- The file stays read-only, and the panel says why, for: a remote session, a
  binary file, a file that is not UTF-8, a file mixing line endings, a symbolic
  link, a hard link, and a file over 2 MB.
- Line endings (CRLF stays CRLF) and a byte-order mark are preserved, so a save
  without edits leaves git nothing to report.

### When the session writes the same file

- An open file is watched. If the session changes it while you have no unsaved
  edits, the editor reloads it.
- With unsaved edits, your buffer is kept and the panel says the file changed on
  disk. **Reload** replaces your buffer with the file, after asking.
- Saving over a file that changed since you opened it is refused; reload first.
- Switching rows, **Close**, closing the tab and closing the panel ask before
  discarding unsaved edits.
- If the session opens a file or a diff of its own while you have unsaved edits,
  the panel switches to it without asking and keeps your edits: reopening
  **Changes** brings them back. A discard you confirmed is final.

## Refreshing

Changes does not poll. It reloads when it opens, on **Refresh**, and when the
session finishes a turn while the panel is open.

## Where the commands run

- **Local**: `git status` and `git diff` run in the session's real working
  directory — its [worktree](worktrees.md), if it has one.
- **Remote**: the same commands run over ssh on the host, in the directory
  recorded in the session's descriptor. No terminal needs to be attached.

## What it does not do

- No staging, committing or reverting. Inline mode has no per-change
  accept/reject buttons.
- No creating, deleting or renaming files, and no editing on a remote session.
- Nothing under `.git/`, and no symbolic links.

A shell in the same directory is one click away: **Shell** opens it under the
list — see [Terminal](terminal.md#panel-shell).
