# Grid Overview

The grid shows every session open in Switchboard as a card holding its live
terminal, so several sessions can be watched at once.

![Session Grid Overview](../build/screenshot-grid.png)

## Opening it

The **Session overview** button in the sidebar's filter row, or `Ctrl+Shift+G`
(`Cmd+Shift+G` on macOS; [rebindable](keyboard-shortcuts.md)). The same toggle
closes it. Whether the grid is on is remembered across restarts
(`localStorage.gridViewActive`).

The grid's header reads **Session Overview**, the number of sessions, and a
**Group by project** button: on (the default), cards are grouped under project
headings in sidebar order; off, they form one flat grid. The choice is
remembered (`localStorage.gridGroupByProject`).

## A card

- **Header**: the same activity glyph and label as the sidebar: an animated
  spinner during a head turn, a static spinner for background work, and
  attention or response-ready indicators. A busy head with running agents
  uses violet. The session's name turns blue while written output is unseen.
  Its project and a Stop session button while the process is alive follow the
  name. An open background or remote attach also has a separate neutral Detach
  button.
- **Body**: the session's terminal, live.
- **Running subagents**, beneath the header: `1 subagent running` or
  `N subagents running`, counting distinct active agent tasks. No line appears
  when the count is zero or unknown. Local and background sessions use the same
  task snapshots as the sidebar; remote sessions never show a count (see
  [Subagents](subagents.md#live-status)).
- **Footer**: `Open here` for a local PTY, `Attached here · keeps running in the
  background` for an attached background session, or `Attached here · runs on
  <alias>` for an attached remote session. Without a PTY here, a finished job
  reads `Job done`, `Job stopped` or `Job failed`; a live job reads `Running in
  background`, a live remote process `Running on <alias>`, and another live
  process `Running elsewhere`. After a Detach it reads `Detached` until new
  liveness or job evidence arrives. Known dead liveness reads `Not running`
  unless another exit was recorded (`Exited (code 1)`, `Killed (SIGTERM)`, or
  `Stopped`). A dormant card reads `Not reopened · restores on click` when no
  stronger evidence is available, otherwise `Liveness unknown` when nothing
  is known. The time of the last modification follows it.

## Using it

- Click a card's header or footer, or into its terminal, to focus that session:
  the sidebar highlights it and its notifications are cleared.
- Double-click a header to leave the grid and show that session alone.
- The stop button asks for confirmation, then ends the process.
- On a background or remote attach, Stop ends the session. Detach leaves it
  running without asking and offers Undo for about 10 seconds.
- The session-navigation shortcuts move between cards in two dimensions — see
  [Keyboard shortcuts](keyboard-shortcuts.md).
