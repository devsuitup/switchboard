# Context: panel-terminal

**Purpose**: a shell inside the right-hand file panel, below whatever the panel
is showing (Changes list, file viewer, MCP diff), running in the **session's own
resolved working directory** — the worktree, not the collapsed project root.
User-facing behavior: `docs/terminal.md` ("Panel shell") and
`docs/changes-view.md`. The panel itself: `.ai/contexts/viewer-panel.md` and
`.ai/contexts/changes-view.md`.

It is a property of the panel, not a fourth tab type: the region sits under
every tab type and survives tab switches. Alternatives considered and rejected
by the user: a fourth tab, a split under the main terminal, one global shell.

## Key files

| File | Role |
|---|---|
| `public/panel-terminal.js` | The region, its lifecycle, and the per-session shell state. |
| `public/splitter.js` | `createSplitter()` — the drag-handle mechanics. |
| `public/file-panel.js` | Three hooks only: build the region, sync it on session switch, keep the panel open for it. |
| `public/terminal-manager.js` | The three lifted assumptions below. |
| `public/grid-view.js` | The second `.visible` sweep, and the WebGL suspend a panel shell must sit out. |
| `public/app.js` | The shell's own exit, and the two places a live PTY is counted as a session. |
| `panel-terminal-target.js` | Main-process cwd resolution and `isPanelShellSession`, dependency-injected (same pattern as `git-changes-target.js`). |

## Main process

`open-terminal` treats `sessionOptions = {type: 'terminal', panelFor: <owner
session id>}` as a panel shell. The renderer never *supplies* a path — it has
none to supply: `resolvePanelTerminalCwd(ownerId, resolveGitChangesTarget)`
resolves it in the main process, reusing the Changes panel's resolver, so the
shell and the Changes list can never disagree about which directory a session
is in. (A refusal's message can still name a path, e.g. `project directory no
longer exists: …`; the renderer displays it, which is not the same as holding
one.) Everything downstream (shell profile, spawn, `shellArgs(shell, undefined,
extra)`) is the pre-existing plain-terminal path, unchanged.

**Local sessions only.** `open-terminal`'s remote branch only ever *attaches* to
an existing tmux target; there is no path to spawn a new remote shell.
`resolvePanelTerminalCwd` refuses a `kind: 'remote'` target and the renderer
shows that refusal in the region, with no terminal mounted. The message text
comes from the main process, so there is one wording, not two. What the refusal
has to do to be *visible* is in "The refusal" below.

The spawned session carries `panelFor`, which `isPanelShellSession(session)`
reads. It *is* listed by `get-active-sessions`, which is what puts it in the
renderer's `activePtyIds` — see "LRU" below — and it is deliberately excluded
everywhere a live PTY stands for a session the user can see or act on:

| Place | Why it must skip a panel shell |
|---|---|
| `get-active-terminals` (main) | It restores plain-terminal *rows*; a panel shell has none. |
| the missing-project remap guard (main) | It refuses a remap while sessions append to the transcripts being rewritten, and tells the user to stop them first. A shell appends to nothing and offers nothing to stop. |
| `scheduleActiveSessionsPoll` (renderer) | A non-empty `activePtyIds` pins the poll at 3 s. One open shell would cancel the 30 s idle back-off of the v0.0.33–41 perf campaign for the whole window. |
| `renderDefaultStatus` (renderer) | "N running" would count a session with a shell twice. |

The renderer side goes through `countSessionsWithoutPanelShells(ids)`, which
keys on the `panel:` id prefix rather than on a lookup, because `activePtyIds`
holds ids and nothing else.

## The three lifted assumptions in terminal-manager.js

1. **Mount point.** `createTerminalEntry(session, opts)` appends to
   `opts.mount || terminalsEl` and adds `.panel-terminal` when `opts.panel`.
   With no options the behaviour is byte-for-byte what it was.
2. **The `.visible` sweeps.** `showSession` used to clear `.visible` from
   *every* `.terminal-container` in the document, which would blank a panel
   container on an unrelated session switch. **That statement exists twice** —
   the other one is `layoutGridCards` in `grid-view.js`, and it is the one that
   bites hardest: leaving the grid with nothing to restore (`toggleGridView`
   only calls `showSession` when the focused id is still open) left the panel
   container stripped with `panelMounted` still true, i.e. exemption #3 applied
   to an invisible terminal — the exact failure it exists to prevent. Both are
   now `.terminal-container:not(.panel-terminal)`, and re-widening either turns
   a test red. `hideGridView`'s blanket `suspendTerminalWebgl` is the same root
   cause, and needs both halves: it **skips a mounted** panel shell, which
   nothing would ever remount and therefore nothing would restore; an
   **unmounted** one is suspended like any other invisible terminal and gets its
   context back in `mountPanelTerminal`, which is where `showSession`'s
   `restoreTerminalWebgl` call has its equivalent for a panel shell.
3. **Hidden-write exemption.** `isHiddenSingleViewSession()` returns true for
   any id that is not `activeSessionId` outside grid mode, and such a session
   gets zero `terminal.write()` calls (output accumulates for replay). A
   *mounted* panel terminal is visible next to another session's terminal, so it
   is exempt — `entry.panelMounted`, maintained by the mount/unmount pair, not
   `entry.panel`. The exemption is only ever as true as `panelMounted` is, which
   is why point 2 matters as much as this one:
   - the grid branch is evaluated first and is untouched;
   - an **unmounted** panel terminal (its owner is not the session the panel is
     showing) is hidden like anything else: it accumulates and replays through
     the existing `replayHiddenBuffer` on remount, so the accounting keeps one
     queue per session;
   - anything that can hide a mounted container without going through
     `unmountPanelTerminal` turns the exemption into a bug, not a no-op.

## Layout

`.terminal-container` is `position: absolute; inset: -5px 20px 0 0` inside
`#terminals` (`position: relative`); it does not flow. `#panel-terminal-region`
is therefore its own positioning context (`position: relative`, explicit pixel
height) and `.terminal-container.panel-terminal` overrides the inset to `0`.
The region and its handle live at the end of `#file-panel-content`, after the
viewer/diff/changes children, and are `display: none` until `.open`.

The region and its handle carry `margin-top: auto` so that with no tab open —
the state the `hidePanel` guard exists to support, where every flexible child
above is `display: none` — they sit at the bottom of the panel instead of
stacking at the top.

Height persists in `localStorage.panelTerminalHeight` (alongside
`filePanelWidth`), floor 80 px, ceiling `#file-panel-content`'s height minus
the 120 px the content above keeps and the handle's own 5 px (that height
includes both, so neither can be left out of the subtraction).

The ceiling applies at every point the height is *used* — the drag,
`showPanelTerminalRegion` (every mount) and a window `resize` — because a
height chosen on a maximised window would otherwise collapse the content above
it on a short one. It applies **to the display only**:
`panelTerminalDesiredHeight` holds what the user asked for and no clamp ever
writes to it, so a transient shrink (resize, a round trip while the panel
happens to be short, devtools opening) gives the height back when the space
returns. Clamping the value already on the element instead would ratchet the
region down to its 80 px floor, one shrink at a time, with no way back but
another drag. The only writer of the desired height is a finished drag, which
records what the drag actually reached rather than where the pointer went.

`refitOpenTerminals()` refits only the active session in single view, and the
per-entry `ResizeObserver` covers geometry changes at an 80 ms debounce. The
splitter's own commit calls `safeFit()` on the panel terminal directly, the way
`setupPanelResizeHandle()` already calls `refitActiveTerminal()`.

## Lifecycle — one shell per session

The panel session id is **`panel:<owner session id>`**, stable per session
rather than a fresh UUID. That is what makes `open-terminal`'s existing reattach
branch do the right thing: a shell whose renderer entry is gone (a reload) is
reattached, never respawned.

| Event | The shell |
|---|---|
| Session switch | Kept running. The container is unmounted (`.visible` off, `panelMounted` false), output accumulates, and replays in one write on return. |
| Panel shell closed (the Shell button) | Stopped. `close-terminal` only *detaches* the renderer, so `stopSession` is called explicitly — otherwise the PTY would outlive its only UI. |
| Session's terminal destroyed (relaunch, stop, LRU eviction) | Stopped with it, from `destroySession`. |
| The shell exits on its own | The region keeps it, with a banner naming the exit code and the Shell toggle. Toggling Shell off and on spawns a new one. |
| App quit | Killed by the main process with every other PTY (`before-quit`, and the window's `closed` handler). |

`app.js`'s `onProcessExited` routes a panel shell to `notePanelTerminalExit`
**before** its two existing branches: the plain-terminal branch keys on a
`sessionMap` row, which a panel shell deliberately never has, so it would
otherwise take the Claude-session path and print "re-click this session in the
sidebar" at a row that does not exist.

`destroyPanelTerminalFor` therefore accepts **either** id shape. Called with an
owner id it stops that session's shell; called with the shell's own id — which
is what `destroySession` passes when the LRU evicts the exited entry — it finds
the owner by scanning the (at most a handful of) states and clears it, so the
map, the Shell button and the region can never be left pointing at a terminal
that no longer exists.

**Spawn races.** `openPanelTerminal` awaits `open-terminal`, and everything that
can happen during that await is handled: a close is detected after the await
(`panelTerminals.get(owner) !== state`) and stops the PTY the awaited call has
by then created, rather than trusting the `stopSession` the close already fired
against an id the main process did not know yet; a re-open is not started while
`panelSpawnsInFlight` holds the owner, because a second `open-terminal` for the
same stable id lands on main's *reattach* branch and would resurrect the shell
the close is killing — it is remembered in `panelReopenAfterSpawn` and run once
the close has settled, so a click inside that one-IPC window is honoured
instead of vanishing.

**The ordering rule: clear, then register.** `destroySession` calls
`destroyPanelTerminalFor`, which resolves the shell's own id back to its owner
and deletes that owner's state. So any code that tears a shell down and then
wants a state to exist must register it *afterwards*. Both places obey it:
`openPanelTerminal` clears a leftover terminal before `panelTerminals.set`, and
`showPanelTerminalRefusal` destroys the terminal before registering the error
state. Doing either the other way round deletes the state that was just
written, and `resyncPanel` then closes the panel around it.

## The refusal

A refusal is a state in `panelTerminals` with `error` set and no terminal. It
is what makes the panel open (`panelTerminalIsOpen` is what `hidePanel`
consults), which is the only way the message is on screen at all: without it
the panel is `width: 0`, `overflow: hidden`, and a message painted into the
region is perfectly invisible. Tests for it assert the panel is `.open` with a
non-zero width, not that a node inside it has `display: block`.

It is deliberately **transient**: `unmountPanelTerminal` deletes an error state
instead of unmounting it, so the refusal describes the click that produced it
and not a standing condition. Leaving the session clears it; one click on Shell
dismisses it; it never pins the panel open for a session the user has moved
on from.

**LRU.** `lruEvictOne()` skips ids in `activePtyIds` and any entry that is not
`closed`, so a live panel shell is doubly protected: its PTY is listed by
`get-active-sessions` (which is where `activePtyIds` comes from) and its entry
is not closed. Verified by test, with the entry forced to `closed: true` so that
only the `activePtyIds` guard stands.

## The third splitter

There were two hand-rolled splitters with no shared component (the sidebar
handle in `app.js`, `setupPanelResizeHandle()` in `file-panel.js`). This is the
third, so the abstraction was extracted: `createSplitter(handle, {axis, getSize,
onDrag, onCommit})` in `public/splitter.js`. It owns the parts that were
duplicated verbatim — the `dragging` class, the body cursor/`user-select`
freeze, the document-level move/up listeners and their removal — and leaves the
sign convention, clamping and persistence to the caller, because that is where
the three genuinely differ (absolute `clientX` vs. a delta; `localStorage` vs.
an async settings IPC).

The two existing splitters are **not** migrated in this change. Extracting the
helper on the third occurrence is the point; rewriting two working, differently
persisted splitters is a separate, independently reviewable refactor with no
behaviour change to show for it — and `file-panel.js` is concurrently edited on
another branch, where a rewritten `setupPanelResizeHandle()` would be a rebase
conflict bought for nothing. They are the helper's next callers.

## Not in scope

Remote sessions; more than one shell per session; tabs or splits inside the
region; any change to the main terminal's scrollback budget or WebGL handling.

Grid mode is not a feature of the region either — the panel is a single-session
view and the region follows it — but "out of scope" does not mean "unaffected":
the grid's own `.visible` and WebGL sweeps run over `openSessions`, which
contains the panel shell, so both had to learn about it (see assumption 2).
