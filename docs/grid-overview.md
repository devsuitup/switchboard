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

- **Header**: a status dot (green: running; grey: stopped; pulsing: Claude is
  working), the session's name, its project, and a stop button while the
  process is alive.
- **Body**: the session's terminal, live.
- **Running subagents**, beneath the header: `1 subagent running` or
  `N subagents running`, counting distinct active agent tasks. No line appears
  when the count is zero or unknown. Remote sessions have no count.
- **Footer**: Running or Stopped, and the time of the last modification.

## Using it

- Click a card's header or footer, or into its terminal, to focus that session:
  the sidebar highlights it and its notifications are cleared.
- Double-click a header to leave the grid and show that session alone.
- The stop button asks for confirmation, then ends the process.
- The session-navigation shortcuts move between cards in two dimensions — see
  [Keyboard shortcuts](keyboard-shortcuts.md).
