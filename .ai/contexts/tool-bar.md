# Session tool bar

Issue #506, including the shell order fix from #503.

The session header contains the status, name, PTY title, id and shell badge,
then `#terminal-header-session`: Refresh, Stop/Detach, Sandbox and IDE Emulation.
Its remaining right side is the window drag area. Caption overlay padding is
unchanged. The info group uses `flex: 0 1 auto`, the header aligns from the
left, and the name limit is `30vw`, keeping Refresh beside the id. Both titles
can shrink to zero, and the PTY title yields first, keeping the fixed-width id
inside the info group rather than clipping it behind Refresh.

`public/tool-bar.js` declares the frozen `TOOL_BAR` and builds
`#tool-bar` as the last child of `#terminal-split`, after the file panel.
Changes, Diff, Touched and Shell share `createHeaderToggle`; the dual-mode
module exports that same function as `createToolToggle`. Header controls are
declared separately and refuse undeclared ids.

## Ownership and keyboard

`toolBarOwner()` requires a non-null panel owner, its open terminal, a shown
terminal area, and its card in grid mode. Every button and shortcut uses that
predicate. Missing owners disable every button and clear pressed states.
`switchPanel`, session destruction and grid layout/card removal synchronize
the bar. Session detection and forking activate the new id before registering
its terminal, then synchronize again after the re-key. A MutationObserver on the terminal area's style covers hiding and
returning from Agents, Stats, Settings, transcripts and file viewers.

One visible enabled button is a Tab stop. Up/Down wrap; Home/End select the
edges. When the focused Diff disappears, focus goes to Changes; when all
buttons disable, focus returns to the last owner's terminal if it still exists.

Rebindable defaults: Primary+Shift+E/D/T/S for Changes/Diff/Touched/Shell.
`setupTerminalKeyBindings` consumes these before xterm writes to the PTY and
sets `_handled`; `handleGlobalShortcut` ignores that same event. Keyup never
acts. Existing Agents, Grid and session navigation bindings take precedence.
An absent Diff or missing/hidden owner leaves the chord to the terminal.
Saving shortcuts refreshes tooltips.

## Diff parking

An unanswered Diff switched away by Changes or Touched becomes
`state.parkedDiffs`, a Map keyed by `diffId`. Its editor DOM is detached, its editor object and edited
text retained, and no MCP response sent. The conditional Diff icon carries
`data-badge="pending"` and an accessible waiting description.

Diff restores the oldest parked tab and editor, stashing the current tool's
edits by its existing rules. A second parked diff retains its own editor and
answer. Clicking Diff over an unanswered shown diff does nothing; over an
answered diff it returns the oldest parked proposal.
Answered diffs keep their existing lifecycle and disappear on a tool switch.
The panel close button over a tool leaves a parked diff alone; closing the
shown Diff rejects it. CLI close_tab/closeAllDiffTabs clear and destroy the
parked editor by id (all parked editors for closeAllDiffTabs), without closing
the shown tool or sending a second response. MCP off and process exit clear
all parked editors and their waiting badge without sending another answer.
A deferred file open belongs to `tab.pendingTouchedOpen`, survives parking,
and replays only when that tab ends in the slot. Ending another diff cannot
replay or clear it; closing its parked tab drops only that tab's deferred open.
A second MCP openDiff over an unanswered Diff remains outside this change.

Shell keeps its existing independent lifecycle. Its `data-badge` CSS hook
is reserved for #505; #506 never sets a shell badge.

## Layout and overflow

All tool containers precede the shell handle; the shell region is last.
With a tool open, the shell keeps its clamped stored height and bottom edge.
Shell-only fills the content area, hides the handle, and retains that height
for reopening a tool.

The non-shrinking bar is 34 CSS px: 26 px icons and 4 px padding each side.
It never wraps; a short bar scrolls vertically and stays below the header.
Overflow gives up width in this order: terminal to 200, panel to 280,
sidebar to 200, then panel below 280. Only layout shrinks: inline and stored
sidebar/panel widths stay intact and return when the window widens.
The main-area floors apply only while the terminal area is shown; Agents and
other viewers retain `min-width: 0`. Sidebar tabs share the available width
with 4 px horizontal padding, keeping the non-shrinking collapse button inside
the sidebar even at its 200 px floor.

The six `--tool-*` variables at the start of `public/style.css` centralize
the bar width, panel floor and derived offsets. For sidebar 340 and panel 450,
the breakpoints are approximately 1012, 842 and 702 CSS px, with 2 px box
rounding allowance. The 20 px terminal negative margin is included.

## Verification

`test/tool-bar.test.js`: D0, Da1-Da3, session group and factory, owner
transitions, shortcut dispatch and roving focus. Existing panel suites retain
the shell sizing and tool state regressions.
`e2e/tool-bar.spec.js`: E1-E8, including the 32-case overflow matrix and
width restoration. These Electron journeys run only in CI; local jsdom tests
do not prove rendered geometry or native Tab traversal.
