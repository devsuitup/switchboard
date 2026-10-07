# Touched Files

**Touched** lists the files a session's file tools touched: what it created or
edited with Edit, Write, MultiEdit or NotebookEdit, including what its subagents
did. Unlike [Changes](changes-view.md), it does not need a git repository, so it
shows files outside any repository too. It is for a local session; a remote
session has no Touched list.

## What the list is, and is not

It is **not** the complete set of files the session changed. Files changed
through Bash commands (`sed`, a heredoc, a script) or any other tool are not
listed, and in a typical session those are most of them. The panel says so at the
top, and an empty list means "the file tools touched nothing", not "nothing
changed". [Changes](changes-view.md) is still the answer to what differs in a
working tree.

## Opening it

**Touched** in the terminal header, next to **Changes**, opens the panel; clicking
it again closes it. Each row shows the path, what Switchboard found on disk, the
tools used, how many times, and who made the calls: the session or a subagent.
The list is read when the panel opens and on **Refresh**; it does not update by
itself.

## What each row says about the disk

The transcript records what the session tried, not what happened, so every row is
checked against the disk when the list is built:

- **present**: the file is there. Click it to open it in the file viewer.
- **gone**: the file no longer exists, or never did (a refused write).
- **not a file**, **unreadable**: it is a directory, or it could not be read.
- **refused**: the path is in a protected location, such as a credential
  directory. It is listed but never opened.

A path that cannot be tied to a file is listed under **Not resolved to a file**
with the reason: a relative path whose session directory could not be verified,
a network path, or a path with unusable characters. It cannot be opened.

## Markdown files

A markdown file (`.md`, `.mdx`, `.markdown`) opens formatted. The toggle in the
editor's toolbar switches to the source and back; the choice is remembered for
the next markdown file Touched opens. The formatted view shows the editor's
text, unsaved edits included, and Save and Reload stay available. The diff
against HEAD is in the source view.

## Limits

- At most 500 files are listed; the summary counts the rest.
- A very large transcript is read only in part, and the summary says so.
- A row opens in the same file viewer as a [path link](terminal.md#clickable-paths); the list itself never writes.
