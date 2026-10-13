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

The fit corrects stale xterm columns before requesting the PTY nudge (#603).
While Refresh is pending, xterm's resize callback leaves size synchronization
to the refresh branch: a changed fit sends one refresh IPC instead of an
ordinary resize followed by a refresh. `safeFit` returns the content-box-clamped
proposal for tracing, or `null` if it used FitAddon's fallback. The trace takes
`prevPty` before fitting, since ordinary xterm resize callbacks can otherwise
overwrite it. Shared explicit Refresh still performs only a local repaint.

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
(300 ms). This is a conservative initial hold, six times the unsuccessful
50 ms round trip, allowing several CLI/libuv size-check opportunities while
keeping the temporary width change below half a second. It is not a measured
minimum or proof of ConPTY delivery. The pre-existing first-open nudge uses
its own `PTY_FIRST_RESIZE_DELAY_MS` (50 ms before the nudge and 50 ms before
restoration); its startup timing is unchanged because #603 concerns explicit
Refresh. The first-open nudge also stays within the upper bound.
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

The handler's optional third argument, `onResize(sessionId, phase, cols, rows,
ok)`, observes every PTY operation attempt, including failed attempts and
retries, with phases `fit`, `nudge` and `restore`. Main forwards it as
`pty.resize` only under `if (TRACE.on)`. Renderer probes are similarly guarded
by `window.ATRACE`; disabled probes construct no trace payload and send no IPC.

## WebGL contexts across tab switches

Issue #526: every reveal of a hidden tab blocked the renderer for 8-10 s,
whatever the replay volume. The old `showSession` disposed the previous
tab's WebGL addon and created the revealed tab's addon on its still
`display:none` container, so each switch paid for a context disposal and a
creation.

Each addon holds a GL context and Chromium allows about 16 per process, so
the addon is kept only for the `WEBGL_WARM_CAP` (3) most recently shown
terminals (`webglWarmOrder` in `terminal-manager.js`). The list holds entry
objects, not session ids, so `onSessionDetected` and `onSessionForked`
re-keying cannot detach a terminal from it. `showSession` touches the revealed
entry and disposes the addon of whichever falls off the end; a switch among the
warm terminals creates and disposes nothing. `suspendTerminalWebgl` (grid
off-screen cards, leaving the grid) and `destroySession` remove the entry. The
other per-session maps that are not re-keyed (issue #529) are not touched here. The LRU of live xterms
(`TERMINAL_LRU_CAP`) is unchanged and still destroys the terminal, addon
included.

A terminal is created without an addon. One that has none when revealed (never
shown, evicted from the warm list, suspended by the grid, or after a context
loss) gets a reveal generation in `webglWanted`. The addon is loaded in the
reveal's animation frame, after `.visible` is added and `safeFit` has run,
never on a `display:none` element. The load is skipped when a newer reveal,
`suspendTerminalWebgl`, grid mode or destruction has superseded that generation,
or when the entry is no longer the one registered in `openSessions` or is
detached. `destroySession` also cancels the entry's pending frames. A terminal
whose process exited is not special-cased: it is a retained terminal like any
other. Grid cards keep their addon through the intersection observer, which
loads it immediately. `onContextLoss` is unchanged: it
disposes the addon and leaves the DOM renderer, and the next reveal recreates it.

`forceRepaint` still clears the texture atlas on every reveal of a kept-alive
addon: an atlas survives `display:none` and reparenting and shows ghosted glyphs
(#103). It skips the clear only for an addon created in that same frame, after
the fit: its renderer and render model are new, and addon-webgl's
`CharAtlasCache` only shares an atlas whose font size, dpr and theme match.
That the painted result is correct was not inspected. A hidden terminal with a live addon is not written to (output is
accumulated, see the hidden-buffer replay) and its fit timer returns on a zero
height, so keeping the context costs memory only.

Budget: the warm cap is not a global context cap. Live contexts are the warm
terminals (at most 3), plus a mounted panel shell (it owns an addon, see
`panel-terminal.md`), plus the visible grid cards; hiding a grid disposes every
non-panel addon first. A terminal that is created but never shown holds no
context, so a restore of many sessions no longer takes one each. The soft
`TERMINAL_LRU_CAP` bounds the number of terminals but not contexts. The measurement behind disposing
on hide (#115: four streaming sessions with one visible cost the renderer about
44 % of a core and the GPU about 50 %) concerned terminals that were being
written to; a hidden terminal is not written to, so a warm hidden addon
adds memory, not draw work. That reasoning is not re-measured live.

The reveal is timed by the `reveal.timing` trace event
(`docs/activity-trace.md`). Whether context creation was the stall, and the
effect of the fix on a live app, are not measured by the jsdom tests: the next
live reveal trace is the evidence.

## Measurement and limits

The chosen remote mechanism is the solo resize nudge; shared Refresh is a
local repaint. The shipped renderer, handler and attach adapter are composed
with fake external discovery and PTY ports in `.work-files/r2-measure.cjs`.
Five quick requests yield one refresh IPC and the trace
`120x40 -> 119x40 -> 120x40` for solo. A shared fixture yields one local repaint,
zero refresh IPC and zero raw resize calls. A dropped solo restoration is
retried. `.work-files/r2-measure.log` records current timings and traces.
The earlier shared-resize measurements describe the superseded behavior.

A local ConPTY/plain-shell Refresh requests two size changes 300 ms apart;
duplicate prompts and TUI reflow have not been measured. The
fake-port protocol trace does not establish signal delivery on Windows.
Live painting, actual SIGWINCH delivery through ssh/tmux and peer effects
remain unverified. `tmux refresh-client` was not benchmarked; its client TTY
would need resolution beyond the descriptor's pane/window target.

## Issue #603: live confirmation

The maintainer's 14 October diagnosis recorded no write over 316 characters
after Refresh, while real file-panel geometry changes caused 8.8–13 KB
repaints and dragging the splitter repaired the screen. The 50 ms hold being
missed by ConPTY/libuv remains plausible; the earlier trace did not record
requests or resize operations and could not exclude missing IPC.

With Debug mode armed in a build containing this change, press Refresh once
on a garbled visible tab and note the session and time. Look for:

1. `refresh.request` with `hidden:false`.
2. `refresh.fit` with actual `cols`/`rows`, the pre-fit `prevPty`, the
   `proposed` fit and `clientW`; mismatched old columns must be corrected.
3. `pty.resize` phases `fit` at W, `nudge` at W−1 and `restore` at W, with
   `ok:true` and about 300 ms between nudge and restore (at least the hold;
   event-loop load may delay it). A one-column terminal nudges to two.
4. `render.stats` showing a full repaint burst, comparable to the measured
   8.8–13 KB (`maxBatchChars`/`writeChars`), and an actually repaired screen.

No request points to the control path; a request without a fit points to the
renderer fit/visibility path; a fit without PTY records points to IPC/main.
Successful resize records without repaint mean the CLI still did not observe
the nudge. `ok:true` records a guarded operation's success, not signal delivery.
These observations require a live Windows app; the tests do not establish them.

## Stale queries in hidden replay

`removeCursorPositionQueries` removes DSR cursor position (`ESC[6n`), private
DECXCPR (`ESC[?6n`) and primary device attributes (`ESC[c` / `ESC[0c`) in one
pass. The CLI was observed polling DECXCPR and DA1; replaying them made xterm
send `ESC[?73;3R` and `ESC[?1;2c` roughly 60 seconds late. Hidden accumulation
also removes each query completed across chunk boundaries, including one-byte
chunks, and the reveal filter covers pending live-buffer drains.

Live output keeps queries so the current requester can receive a timely reply.
Responses, cursor movement, status requests and other escape sequences remain
unchanged; no additional polled query was established by this diagnosis.
Removal is non-recursive: bytes that form a new query only after another query
is removed are left alone in that pass, preserving the existing replay rule.

## Verification

- `test/terminal-webgl-warm.test.js`: warm cap, no recreate across switches,
  load after `.visible`, context loss, atlas clear rule, `reveal.timing`.
- `test/terminal-refresh.test.js`: shipped selection, solo/shared return,
  shared local redraw without IPC/ssh/raw resize, sizing capability,
  coalescing, stale hidden/disconnected requests, button and sidebar action.
- `test/header-controls.test.js`: header disabled, accessible and tooltip
  state through stopped/running/stopped transitions.
- `test/terminal-refresh-pty.test.js`: restoration, retries, newer fits,
  allocation bounds, strict refresh flag, exit/replacement and attach policy;
  injected-clock 300 ms hold, unchanged first-open timing and resize hooks.
- `test/terminal-refresh-ipc.test.js`: shipped main open/reattach/launch
  capability results and preload/main resize round trip.
- `test/terminal-hidden-suspend.test.js`: shipped query filter, split DECXCPR
  and DA1 queries, live-buffer drain and preservation of live queries.
- `test/activity-trace-probe-guards.test.js`: permanent guarded `pty.resize`.
- `test/main-wiring-source-check.test.js`: guarded handler registry wiring,
  allowing the optional resize trace hook.
- `e2e/terminal-refresh.spec.js`: existing isolated plain-shell button journey;
  written and syntax checked, not run because Electron is prohibited here.
