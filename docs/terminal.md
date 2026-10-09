# Terminal

Each session runs in an xterm.js terminal attached to the session's PTY. How a
session is started is on [Launching sessions](launching-sessions.md); the
shortcuts are all on [Keyboard shortcuts](keyboard-shortcuts.md).

## Header

On the left, the header above the terminal shows:

- a **status dot**, before the name: green with a glow while the process runs,
  grey otherwise. Its tooltip says the state in words: `Running`; `Stopped`
  after a Stop you asked for, or when no exit is known; `Killed (SIGKILL)` (or
  another signal) when a signal ended it without a Stop; `Exited (code N)` when
  it exited on its own;
- the session's name, the title the program sets on the terminal (or Claude's
  latest notification), the session id, and the shell profile's name when it is
  not **Auto**.

Immediately after the session id, **Refresh screen** redraws the terminal and
**Stop** stops its process (**Detach** leaves an attached background session
running). The Sandbox and IDE Emulation indicators follow them. The top-right
corner holds the window controls.

## Session tools

The vertical bar at the right edge holds **Changes**, **Diff** when a proposed
change exists, **Touched**, then **Shell**. It acts on the shown session, or
the focused card in the grid. With no open session its controls are disabled.

The rebindable defaults are Ctrl+Shift+E/D/T/S (Cmd on macOS). Tab enters the
bar once; Up/Down, Home/End move between its buttons. Changing from an
unanswered Diff to Changes or Touched keeps the Diff, including your edits;
its dot says Claude is waiting, and **Diff** returns to it.

The shell stays below the open tool. On narrow windows or at high zoom, the
terminal shrinks first, then the panel, then the sidebar, then the panel
further. Your chosen widths return when there is room.

When the process ends, the terminal prints a banner in the same words —
`session stopped`, `session killed (SIGKILL)`, `session exited (code 1)` — dim
for a Stop or an exit with code 0, yellow otherwise. The panel shell's banner
reads the same way (`shell exited (code 1)`).

## Right-click

**Global Settings → Terminal Right-Click** sets what the right mouse button
does:

| Option | Behaviour |
|---|---|
| **Context menu** (default) | Opens Switchboard's context menu, below |
| **Paste clipboard** | Pastes the clipboard at once |
| **Native (xterm)** | Leaves the click to xterm.js and to the program running in the terminal |
| **Do nothing** | Nothing |

In every mode but **Native (xterm)**, the right-button press is kept from the
program: a program that tracks the mouse — Claude Code's fullscreen view, for
one — never sees it. Left and middle clicks still reach the program in every
mode. The setting applies from the next right-click after **Save Settings**.

### Context menu

The first group depends on what is under the pointer:

- **A file link** — an OSC 8 `file://` hyperlink, a `file://` URL, or a
  [path link](#clickable-paths): **Open in panel**, **Open in system editor**
  (the operating system's default application), **Copy path**. **Open in
  panel** from the menu opens the file at its top, without the line number.
- **An `http://` or `https://` URL**: **Open in browser**, **Copy link**.

Then, always: **Copy** (only with a selection), **Paste**, **Select all**. Esc
or a click elsewhere closes the menu.

## Clickable paths

A filesystem path printed in a local session's terminal is a link. That covers
absolute and relative paths, `~/…`, Windows `C:\…` paths, bare file names
(`README.md`, `Makefile`), quoted paths containing spaces, and a trailing
`:line` or `:line:column`. Trailing punctuation is not part of the path. URLs
are left to the URL links.

A candidate becomes a link only after the main process has checked that it can
open it: resolved against the session's working directory, it must be an
existing regular file of at most 2 MB, with no NUL byte in its first 4 KB, and
outside the credential paths the side panel refuses (`~/.ssh/`, `~/.gnupg/`,
`~/.aws/credentials`, `.env` files, `.netrc`, `~/.kube/config`,
`~/.docker/config.json`, `~/.claude/.credentials.json`, `.git-credentials`,
`~/.config/gh/hosts.yml`, `~/.config/gcloud/`, `.npmrc`, `.pypirc`, `.pgpass`,
`.my.cnf`). Text that fails a check is not underlined. The answer for a path is
cached for 30 seconds.

A plain left click opens the file in [Touched](touched-files.md#files-opened-from-elsewhere),
in the side panel, scrolled to the line, with its diff against HEAD when it has
changed. A file the file tools did not touch is listed there as **opened**. OSC 8
file links, `file://` URLs and **Open in panel** open the same way, without a
line. `file:///C:/…` URIs resolve to the Windows drive path. A symbolic link
opens read-only.

Remote sessions have no path links, and their `file://` links and **Open in
panel** open nothing: their files are on another machine.

## Copy and paste

- **Copy**: select text and use **Copy** in the context menu, or `Ctrl+C` on
  Windows and Linux (with nothing selected, `Ctrl+C` is the usual interrupt).
  Copies go through the main process's clipboard, which works on Wayland.
- **Programs can set the clipboard** with OSC 52 (Claude Code copies this way).
  Read-back requests are not answered.
- **Paste**: `Ctrl+V` on Windows and Linux, `Cmd+V` on macOS, or `Shift+Insert`.
- **Images**: when the clipboard holds an image, the paste shortcut sends
  `Ctrl+V` to the program, and Claude Code reads the image from the system
  clipboard itself, as in a stand-alone terminal.
- **Middle click** is xterm.js's and the platform's own; on Linux it pastes the
  primary selection.

## Drag and drop

Dropping files from a file manager into the terminal types their absolute
paths at the cursor, shell-escaped and separated by spaces.

## Find

`Ctrl+F` (`Cmd+F` on macOS) opens a search bar over the terminal's scrollback,
pre-filled with the selection. Enter goes to the next match, Shift+Enter to the
previous one, Esc closes the bar. It searches what the terminal holds, not the
transcript; the sidebar's [search](session-browser.md#search) covers
transcripts.

## Multi-line input

`Shift+Enter` — and `Ctrl+Enter` on Windows and Linux — inserts a new line in
Claude's prompt instead of submitting it.

## Panel shell

**Shell** on the right-hand tool bar opens a shell in the right-hand panel, under
whatever the panel shows — the Changes list, a file, a diff. Both stay visible;
drag the handle between them to share the height, which is remembered. With
nothing open above it, the shell takes the whole panel.

The shell starts in the session's own working directory, worktree included —
the directory the Changes panel reads and a `claude --resume` runs in.

There is one shell per session. Switching to another session leaves it running,
and it is back, with what it printed meanwhile, when you return. **Shell** again
closes and stops it; it also stops when the session's terminal goes away
(relaunch, stop, quit). If the shell exits on its own, its output stays in the
panel with a note; toggle **Shell** off and on for a new one.

A panel shell is not a session: it is never listed in the sidebar, never counted
in "N running", never restored at startup, and never
[sandboxed](sandbox.md). Remote sessions have none — the panel says so.

## Theme

**Global Settings → Terminal Theme**: Switchboard (default), Ghostty, Tokyo
Night, Catppuccin Mocha, Dracula, Nord, Solarized Dark. It applies on save.
