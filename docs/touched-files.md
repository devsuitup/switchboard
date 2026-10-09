# Touched Files

**Touched** lists the files a session's file tools touched: what it created or
edited with Edit, Write, MultiEdit or NotebookEdit, including what its subagents
did. Unlike [Changes](changes-view.md), it does not need a git repository, so it
shows files outside any repository too. Remote sessions use their mirrored
transcripts and check files on the host; their editor is read-only.

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

- **present**: the file is there. Click it to open it in the editor below the
  list, with its diff against HEAD when it has changed.
- **gone**: the file no longer exists, or never did (a refused write).
- **not a file**, **unreadable**: it is a directory, or it could not be read.
- **unknown**: the remote host could not be reached or its disk check did not
  return a usable answer. Refresh makes one new attempt.
- **refused**: the path is in a protected location, such as a credential
  directory. It is listed but never opened.

A path that cannot be tied to a file is listed under **Not resolved to a file**
with the reason: a relative path whose session directory could not be verified,
a network path, or a path with unusable characters. It cannot be opened.

## Files opened from elsewhere

A file you click in the terminal (a [path link](terminal.md#clickable-paths), a
`file://` link, **Open in panel**) and a file Claude opens through
[IDE Emulation](ide-emulation.md#file-viewer) open here too, in the same editor.
When the file tools did not touch it, it is listed at the top under **Opened,
not touched by the file tools**, marked **opened**. These rows are not counted
in "N files touched". They stay while the session's panel exists, through
Refresh and closing Touched, up to the 50 most recent.

- A `path:line` link opens the source at that line, a markdown file included.
- A file with unsaved edits in the editor is not replaced without asking when
  you click another file. A file Claude opens over unsaved edits is only listed;
  the editor keeps your text.
- While Claude waits on an answer to a proposed diff, a clicked file opens once
  the diff is answered or closed.
- Unsaved edits to a file that another view replaced are kept and come back
  when you open that file again, with a notice; quitting asks about them.
- A symbolic link opens read-only.
- The panel's checks apply to every file: credential paths, binary files, files
  that are not UTF-8 and files over 2 MB are refused, with the reason above the
  list.
- In a remote session, a present Touched row opens read-only. Terminal links
  remain unavailable; files outside the session's repository open as plain text.

## Markdown files

A markdown file (`.md`, `.mdx`, `.markdown`) opens formatted. The toggle in the
editor's toolbar switches to the source and back; the choice is remembered for
the next markdown file Touched opens. The formatted view shows the editor's
text, unsaved edits included, and Save and Reload stay available. The diff
against HEAD is in the source view.

## Limits

- At most 500 files are listed; the summary counts the rest.
- A very large transcript is read only in part, and the summary says so.
- A row opens in the same editor as a [path link](terminal.md#clickable-paths); the list itself never writes.
