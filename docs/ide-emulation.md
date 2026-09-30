# IDE Emulation

With IDE Emulation on, Switchboard presents itself to each Claude session as
its IDE. The files Claude opens and the edits it proposes then appear in a side
panel next to the terminal, instead of in an external editor.

![IDE Emulation](../build/screenshot-ide.png)

## Turning it on

IDE Emulation is **off by default**. Turn it on in **Global Settings →
Application → IDE Emulation** and save. It applies to sessions launched or
resumed afterwards; running sessions keep what they started with, and the
settings page says so when the value changes. It is a global setting only.

While a session is connected, its terminal header shows an **IDE Emulation**
label.

With it off, Switchboard does not register, and `claude` finds your own IDE
(VS Code, Cursor, …) the way it does outside Switchboard.

## How it works

For each Claude session it launches, Switchboard:

1. starts a WebSocket MCP server on `127.0.0.1`, on a free port;
2. writes `~/.claude/ide/<port>.lock` (mode 0600), naming Switchboard as the
   IDE, the session's directory as its workspace, and an authentication token;
3. starts `claude` with `--ide` and `CLAUDE_CODE_SSE_PORT=<port>`.

The CLI connects with the token and calls the IDE tools Switchboard implements:
`openFile`, `openDiff`, `close_tab`, `closeAllDiffTabs` and `getDiagnostics`.
The lock file is removed when the session stops, and lock files left by a
crashed instance are removed at startup.

Remote sessions and scheduled runs never get the bridge.

## Diff review

When Claude proposes an edit, the panel shows the diff, and Claude waits for
the answer:

- **Accept** applies the edit. If you changed the proposed text in the panel
  first, your version is what Claude receives.
- **Reject** refuses it.

Two views, switched by the button in the panel's toolbar; the choice is
remembered (`localStorage.filePanelDiffMode`):

- **Side-by-side** (the default): the current file on the left, read-only, the
  proposed version on the right, editable.
- **Inline**: one column with the changes marked, and accept/reject buttons on
  each change, so part of an edit can be kept.

## File viewer

Files Claude opens, files you open from a terminal link (see
[Terminal](terminal.md#clickable-paths)), and files opened with **Open in
panel** show in the same panel with syntax highlighting, whether or not IDE
Emulation is on. The panel refuses credential paths and files over 2 MB.

### Windows drive letters

A `file:///C:/a/b.js` URI parses to the path `/C:/a/b.js`. `fileUriToPath`
strips that leading slash, for left clicks and for the context menu alike, so
the file opens at `C:\a\b.js`. A UNC URI (`file://server/share/x`) still loses
its host, since only the URI's path is read.
