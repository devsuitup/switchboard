# Changes View

**Changes** is a read-only, git-status-sourced view of a session's working tree, shown in the same right-hand side panel as [IDE Emulation](ide-emulation.md)'s file/diff tabs. It exists because IDE-mode sessions never get the CLI's own `/diff` pane — Switchboard impersonates the IDE, and the IDE protocol never pushes "these files changed", only per-file diffs at permission time. A remote session shows `/diff` inside its terminal, but that view scrolls away with the session and isn't clickable from Switchboard. Changes gives both kinds the same panel.

## Opening it

Click the **Changes** button in the terminal header, next to the stop button. Click it again to close.

## What it shows

- A header line: `N files changed +A −B`, plus the current branch and how far it is ahead/behind its upstream.
- One row per changed file: a state letter (`M` modified, `A` added, `D` deleted, `R`/`C` renamed/copied, `?` untracked), its path, and its own `+added −deleted` line counts.
- Clicking a row opens a read-only diff for that file, including an untracked one — a brand-new file shows up as an all-additions diff. A binary file shows a one-line note instead of its bytes.
- A brand-new directory is listed file by file, not as a single folder row.
- A **Refresh** button for a manual pull.

### Counts for new files

Git reports line counts for tracked files only, so an untracked file's row
starts without any, and the header's `+A −B` does not include it yet. Click the
row once: its diff is fetched, the row gets its `+added −0`, and the header
total grows by the same amount. This is deliberate — counting every new file up
front would mean running one extra git command per untracked file on every
refresh (and one ssh round-trip each, for a remote session), which a repo with a
large untracked tree would feel. Refreshing resets them, since the files may
have changed since.

## What it doesn't do

- No staging, committing, or reverting from the UI — this is a viewer, not a git client.
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

Diffs are capped at 512 KB; a diff larger than that is truncated with a note at the bottom.
