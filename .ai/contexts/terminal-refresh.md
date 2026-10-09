# Terminal screen refresh

Issue #446 adds **Refresh screen** immediately after the session id, beside Stop in `#terminal-header-session` and in
the sidebar session context menu. Both apply to open local and remote
terminals. The header disables the button when the selected process is not
running, with `aria-disabled` and a tooltip explaining why. The sidebar menu
disables its entry when no terminal is open or its entry is closed. Neither
control starts a process. A hidden open terminal is revealed for refresh.

## Solo and shared tmux attachments

The attach probe determines initial sizing at attach time. A solo attachment
has no other client and a valid local size. `remoteResizeAllowed` carries
that decision through the main session registry and the open, reattach and
remote-launch IPC results. `syncPtySizeAfterOpen` stores it on the entry
before selection. Missing capability information fails closed.

When a shared attachment becomes solo (#452), the adapter calls its handle's
`onResizeAllowed` subscriber after applying the solo options. Main updates the
current live session's `remoteResizeAllowed` and sends `remote-resize-allowed`
with its session id; preload exposes `onRemoteResizeAllowed`. The renderer's
`allowRemoteResize` enables the entry and schedules the existing debounced fit,
sending one fitted size even if dimensions have not changed. Its pending size
sync suppresses xterm's resize callback until that fit, avoiding duplicate IPC;
an already pending refresh sends the size through its usual refresh path.
Subsequent resizes and automatic refresh on return use solo behavior. Unknown,
closed, local or already solo entries ignore the event. A hidden entry keeps
its selection and synchronizes when revealed. Initial solo attachments and
unsuccessful or interrupted promotions emit no event; no downgrade is added.

Returning to a solo remote terminal requests one refresh. `showSession`
owns single-view selection, including sidebar opens and working-set restore;
`focusGridCard` owns grid selection. They compare the previous selection and
track first reveal, so restoring an entry refreshes even when its saved id
is already selected. Re-selecting the current entry adds no refresh.
Local terminals and shared attachments never request automatic refresh.

Explicit Refresh on a shared attachment performs only a local repaint of
the current xterm buffer: clear the WebGL texture atlas when available and
refresh rows `0` through `rows - 1`. It does not fit or resize the terminal,
send resize IPC, resize the ssh PTY or execute an ssh command. Ordinary
local geometry fitting also suppresses resize IPC for shared entries.
The attach adapter independently refuses **all** shared-client resizes,
regardless of refresh options. Shared ssh PTYs keep their attach-time size.
No tmux sizing option is changed by refresh.

## Fitting and coalescing

`requestTerminalRefresh` marks the entry and calls `scheduleTerminalFit` in
`public/terminal-manager.js`. Container ResizeObserver callbacks share this
entry timer at `CONTAINER_RESIZE_DEBOUNCE_MS` (80 ms). Quick returns and size
changes coalesce. Shared explicit refresh uses the timer for local repaint
only; local and solo refresh fit with `safeFit`, repaint and send the fitted
size even when it equals `lastPtySize`. Refresh never temporarily shrinks
xterm or adds a WebGL context (#353).

Destruction cancels the timer. When the timer finds a closed, disconnected
or hidden entry, it clears the refresh request before returning, so a later
unrelated geometry fit cannot revive a stale refresh.

## PTY protocol and restoration

For local and solo remote terminals, `preload.resizeTerminal` sends one
`terminal-resize` message with the fitted size and `{refresh: true}`.
`createTerminalResizeHandler` in `terminal-resize.js` accepts only integer,
positive sizes within the existing `pty-size.js` upper bounds (1000 columns,
500 rows). Oversized requests are rejected before any PTY call or timer.
One column remains valid for the existing refresh boundary case.
Only boolean `true` requests refresh; truthy strings, numbers and objects
behave as ordinary resizes.

A refresh sends the fitted size, nudges to one column less (one more at a
single column), and restores the fitted size after `PTY_REFRESH_DELAY_MS`
(50 ms). The pre-existing first-open nudge also stays within the upper bound.
Both phases run in main; losing a second renderer message cannot leave the
nudge in place. Restoration retries once on a thrown PTY operation. A newer
fit cancels pending restoration and becomes the final size, retrying once
when it supersedes a refresh. Timers check the session object and exit state
so an old callback cannot resize an exited or replacement PTY.

`resizePty` forwards the refresh option to the attach adapter, which still
enforces solo sizing. Solo refresh errors reach the guarded operation for
restoration retry; ordinary resize errors remain absorbed by the adapter.
An exited or permanently failing PTY cannot be restored, and no continuing
retry or idle timer is installed.

## Measurement and limits

The chosen remote mechanism is the solo resize nudge; shared Refresh is a
local repaint. The shipped renderer, handler and attach adapter are composed
with fake external discovery and PTY ports in `.work-files/r2-measure.cjs`.
Five quick requests yield one refresh IPC and the trace
`120x40 -> 119x40 -> 120x40` for solo. A shared fixture yields one local repaint,
zero refresh IPC and zero raw resize calls. A dropped solo restoration is
retried. `.work-files/r2-measure.log` records current timings and traces.
The earlier shared-resize measurements describe the superseded behavior.

A local ConPTY/plain-shell nudge produces two intended SIGWINCH size changes
50 ms apart; duplicate prompts and TUI reflow have not been measured. The
fake-port protocol trace does not establish signal delivery on Windows.
Live painting, actual SIGWINCH delivery through ssh/tmux and peer effects
remain unverified. `tmux refresh-client` was not benchmarked; its client TTY
would need resolution beyond the descriptor's pane/window target.

## Verification

- `test/terminal-refresh.test.js`: shipped selection, solo/shared return,
  shared local redraw without IPC/ssh/raw resize, sizing capability,
  coalescing, stale hidden/disconnected requests, button and sidebar action.
- `test/header-controls.test.js`: header disabled, accessible and tooltip
  state through stopped/running/stopped transitions.
- `test/terminal-refresh-pty.test.js`: restoration, retries, newer fits,
  allocation bounds, strict refresh flag, exit/replacement and attach policy.
- `test/terminal-refresh-ipc.test.js`: shipped main open/reattach/launch
  capability results and preload/main resize round trip.
- `e2e/terminal-refresh.spec.js`: existing isolated plain-shell button journey;
  written and syntax checked, not run because Electron is prohibited here.
