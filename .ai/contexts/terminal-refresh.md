# Terminal screen refresh

Issue #446 adds **Refresh screen** beside Stop in the terminal header and in
the sidebar session context menu. Both apply to open local and remote
terminals. The menu leaves the control disabled when there is no open terminal;
it does not spawn a process. Refreshing a hidden open terminal reveals it so
that its container can be fitted. Read-only subagent rows have no menu.

Returning to an open remote terminal also requests a refresh. `showSession`
owns single-view selection (including sidebar opens and working-set restore).
`focusGridCard` owns grid selection, including clicks inside the terminal.
Both compare the previous selection and track the first reveal of the entry.
Restoring a new entry refreshes even when sessionStorage already names its id;
selecting the current terminal again does not request another refresh.
An open remote terminal is a tmux attach:
the main process refuses to open any other remote descriptor in a PTY.
Local selections do not refresh automatically.

## Fitting and coalescing

`requestTerminalRefresh` marks the entry and calls `scheduleTerminalFit` in
`public/terminal-manager.js`. Container ResizeObserver callbacks use the same
entry timer, at `CONTAINER_RESIZE_DEBOUNCE_MS` (80 ms). Quick returns and size
changes therefore share a single fit and refresh. The delayed operation fits
xterm with `safeFit`, repaints the glyph atlas and rows, and sends the fitted
size even when it equals `lastPtySize`. The refresh never temporarily shrinks
xterm or adds a WebGL context; its fit uses the existing geometry debounce
instead of resizing during another terminal's WebGL activation (#353).
Destruction cancels the entry timer. Disconnected, hidden and closed entries
are not fitted by the timer.

## PTY protocol and restoration

`preload.resizeTerminal(id, cols, rows, {refresh: true})` sends one
`terminal-resize` message carrying `refresh=true`. The registered main handler
uses `createTerminalResizeHandler` in `terminal-resize.js`, including for
ordinary fits and the pre-existing first-open nudge.

A refresh sends the fitted size, nudges the PTY to `cols - 1` (or `cols + 1`
at one column), and restores the fitted size after `PTY_REFRESH_DELAY_MS`
(50 ms). Both phases remain in the main process; losing a second renderer
message cannot leave the nudge in place. Restoration retries once if the PTY
operation throws. A newer fitted size cancels the pending nudge/restoration
and becomes the final size. A fitted resize that starts or supersedes a
refresh also retries once on a throw, so a lost newer fit cannot strand the
old nudge. Timers check the exact session object and exit state, so an old
callback cannot resize a replacement PTY under the same id.
An exited or permanently failing PTY cannot be restored; this is not a
successful redraw and no continuing retry or idle timer is installed.

`resizePty` forwards the refresh option to the tmux attach adapter. Ordinary
remote resizes retain the solo-client rule. Explicit refreshes, automatic
refreshes on return, and a fit that supersedes a pending refresh resize the
local ssh attach PTY even for a shared client, ending at the fitted size.
This is a deliberate exception to the fixed-at-attach sizing of shared
clients: the client receives the nudge, while the remote tmux window still
obeys its configured sizing policy and other clients' sizes. No tmux options
are changed by refresh. A refresh error is allowed to reach the guarded PTY
operation so restoration can retry; ordinary resize errors remain absorbed
by the adapter.

## Mechanism measurement and limits

The chosen mechanism is the resize nudge for local and remote terminals.
The shipped renderer, resize handler, and remote attach adapter were composed
with a fake external PTY and fake discovery response. Five quick requests
produced one refresh IPC and the raw resize trace `120x40 → 119x40 → 120x40`.
Solo and shared fixtures finished at 150.0 ms and 162.3 ms; a shared fixture
that dropped the first restoration finished at 169.0 ms after its retry.
These are measured protocol timings on Windows under load, not redraw timings
on a real host. The configured delay is 80 + 50 ms; scheduling adds latency.

The nudge needs no extra SSH command or client-target lookup. A
`tmux refresh-client` alternative would require resolving the attached client
TTY: the descriptor names a pane/window, not a client. That alternative was
not benchmarked. Live app painting, actual SIGWINCH delivery through ssh and
tmux, effects on peers sharing a tmux window, and the Playwright journey are
unverified in the sandbox.

## Verification

- `test/terminal-refresh.test.js`: shipped renderer selection, header markup
  and handler, sidebar context menu, coalescing and destruction.
- `test/terminal-refresh-pty.test.js`: size restoration, dropped restore,
  newer-fit and first-open races, one-column boundary, exit/replacement guards,
  and the actual attach adapter with solo/shared external fixtures.
- `test/terminal-refresh-ipc.test.js`: shipped preload and main IPC registration
  routed through the resize handler.
- `e2e/terminal-refresh.spec.js`: isolated plain shell runs a disposable Node
  resize probe; the visible header control must send one refresh, provoke an
  actual terminal size event and leave the probe at xterm's fitted size. This
  journey is written but was not run in the sandbox.
