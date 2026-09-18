# Changes View

**Changes** is a git-status-sourced view of a session's working tree — and, for a local session, an editor for the files in it — shown in the same right-hand side panel as [IDE Emulation](ide-emulation.md)'s file/diff tabs. It exists because IDE-mode sessions never get the CLI's own `/diff` pane — Switchboard impersonates the IDE, and the IDE protocol never pushes "these files changed", only per-file diffs at permission time. A remote session shows `/diff` inside its terminal, but that view scrolls away with the session and isn't clickable from Switchboard. Changes gives both kinds the same panel.

## Opening it

Click the **Changes** button in the terminal header, next to the stop button. Click it again to close.

The button is only there for a session whose working directory is inside a git
repository. A session started somewhere that is not one — a scratch directory, a
notes folder — has no Changes button at all. Run `git init` there and the button
appears the next time the panel follows that session; delete the repository and
it goes away again, closing the view if it was open.

A repository git *refuses to open* is a different case and keeps its button. If
git will not read the repository — it is owned by another user, its permissions
are wrong, or its format is one this git does not support — Changes shows you
git's own message, which usually names the fix. The button disappears only when
there is genuinely no repository there.

A file link in the terminal opens here too, when it points at one of this session's changed files: the panel opens on that row, ready to edit against its diff. A link to a file the session has not touched, or to one outside its repository, opens in the plain viewer as before.

## What it shows

- A header line: `N files changed +A −B`, plus the current branch and how far it is ahead/behind its upstream.
- One row per changed file: a state letter (`M` modified, `A` added, `D` deleted, `R`/`C` renamed/copied, `?` untracked), its path, and its own `+added −deleted` line counts.
- Clicking a row opens that file below the list, which stays on screen — the current row is highlighted, and clicking another row swaps the file without going back anywhere. An untracked file opens too, as an all-additions diff. A binary file shows a one-line note instead of its bytes.
- Drag the divider between the list and the file to give either one more room; the position is remembered.
- A brand-new directory is listed file by file, not as a single folder row.
- A **Refresh** button for a manual pull.

### Very large working trees

The list shows at most 500 rows, then a `+N more files not shown` line; the
header keeps counting every changed file. Changed tracked files come first, so
what the cap drops is untracked files.

A working tree with tens of thousands of untracked files — an unignored
`node_modules`, a vendored or build directory — can be more than the panel can
fetch file by file, especially over ssh. Changes then falls back to listing
untracked entries by directory, the way `git status` does by default, and says
so under the header. Your tracked changes are unaffected.

### Counts for new files

Git reports line counts for tracked files only, so an untracked file's row
starts without any, and the header's `+A −B` does not include it yet. Click the
row once: its diff is fetched, the row gets its `+added −0`, and the header
total grows by the same amount. This is deliberate — counting every new file up
front would mean running one extra git command per untracked file on every
refresh (and one ssh round-trip each, for a remote session), which a repo with a
large untracked tree would feel. A refresh resets them, since the file may have
changed since — with one exception: **saving the file you are editing keeps its
counts**, because the save is itself the measurement. The Refresh button, and a
refresh triggered by the session finishing a turn, reset them as before.

## Editing a file

On a local session, the open file is a live editor, not a picture of a diff. Type on the right-hand side and the diff recomputes as you go.

- **Save** with the Save button or `Ctrl/Cmd+S`. The button is inactive until you change something. The file list refreshes on save, so the row's counts follow what you wrote.
- The button next to **Close** cycles three views: **Inline** (one column, changes marked in place — the default, because the panel is a narrow column and side-by-side halves it), **Plain** (just the file, no diff decoration) and **Side-by-side** (the committed or staged version on the left, read-only; your working copy on the right). The choice is remembered.
- The left-hand side is what `git diff` compares against: the staged version for a row you opened staged, the last commit otherwise. What you see marked as changed is what git would report.
- These stay read-only, and the panel says which case it is: a remote session, a binary file, a file that is not UTF-8 text, a file that mixes line endings (no editor can keep them line by line), a symbolic link, a hard link (two names for the same bytes, and only one of them is in this repository), and a file over 2 MB.

### When the session writes the same file

The session you are watching writes these files, so the panel assumes it is not the only writer.

- While the file is open it is watched. If the session writes it and **your buffer has no unsaved edits**, the editor reloads to what is now on disk.
- If you **do** have unsaved edits, your buffer is left exactly as it is and the panel says the file changed on disk. **Reload** replaces it with the version on disk — it asks first, because that discards what you typed.
- A save of a file that changed since you opened it is **refused**, not merged and not forced: the panel tells you to reload first, and the session's work stays on disk. Saving again after a reload writes normally.
- Switching to another row, **Close** (which closes the file and keeps the list), closing the tab and closing the panel all ask before discarding unsaved edits.
- Whatever line ending the file uses is preserved — CRLF stays CRLF — so a save with no edits leaves git with nothing to report. A byte-order mark is kept too.
- If the session opens a file or a diff of its own while you have unsaved edits, the panel switches away without asking, but your edits are kept: reopening **Changes** brings them back and says why. Answering yes to a discard prompt is the opposite instruction, and it is honoured — nothing comes back afterwards.

## A shell under the list

**Shell** in the terminal header opens a shell in the same panel, below the
Changes list, in the same directory the list is read from — so you can run a
`git add`, a test, or anything else against exactly the tree you are looking
at, then hit **Refresh**. Both stay visible; a horizontal handle between them
sets how much room each gets. With no list or file open above it, the shell
takes the whole panel and the handle is gone; whatever height you dragged to
comes back the moment you open something above it again. Local sessions only —
see [Terminal](terminal.md) for the lifecycle and the remote limitation.

## What it doesn't do

- No staging, committing, or reverting from the UI — you can type in it, but it is not a git client. Inline mode deliberately has no per-change accept/reject buttons.
- No creating, deleting or renaming files, and no editing on a remote session.
- Nothing under `.git/`, and no symbolic links.
- It doesn't replace the CLI's `/diff` pane in a non-IDE session; the two coexist.
- IDE mode itself is not available for remote sessions (that's a separate, larger feature — an `ssh -R` tunnel plus a lock file on the host); Changes does not depend on it and works today for both local and remote sessions.

## How it refreshes

Changes does not poll. It reloads:

- The moment you open it.
- When you click Refresh.
- The moment the session goes idle (finishes a turn) while the tab is open — for a remote session this costs one ssh round-trip, typically well under a second.

## Local vs. remote

The same parser and the same panel render both. Only the command runner differs:

- **Local**: `git status`/`git diff` run directly against the session's real working directory (its worktree, if it has one — the same directory a `claude --resume` targets).
- **Remote**: the same commands run over the existing ssh connection to the host, against the directory recorded in that session's descriptor. No attach, no tmux — this works even for a session you've never opened a terminal tab for.

A remote working directory that is not a git repository keeps its button and
shows git's message when you click, rather than hiding the button the way a
local one does. Telling "there is no repository here" apart from "git will not
open this repository" needs to look at the directory itself, which Switchboard
can only do on this machine.

Diffs are capped at 512 KB; a diff larger than that is truncated with a note at the bottom.
