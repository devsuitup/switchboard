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
| `panel-terminal-target.js` | Main-process cwd resolution, dependency-injected (same pattern as `git-changes-target.js`). |

## Main process

`open-terminal` treats `sessionOptions = {type: 'terminal', panelFor: <owner
session id>}` as a panel shell. The renderer does **not** hold the session's
absolute path and must not start to: `resolvePanelTerminalCwd(ownerId,
resolveGitChangesTarget)` resolves it in the main process, reusing the Changes
panel's resolver — so the shell and the Changes list can never disagree about
which directory a session is in. Everything downstream (shell profile, spawn,
`shellArgs(shell, undefined, extra)`) is the pre-existing plain-terminal path,
unchanged.

**Local sessions only.** `open-terminal`'s remote branch only ever *attaches* to
an existing tmux target; there is no path to spawn a new remote shell.
`resolvePanelTerminalCwd` refuses a `kind: 'remote'` target, the renderer shows
that refusal as the region's message, and no terminal is mounted. The message
text comes from the main process, so there is one wording, not two.

The spawned session carries `panelFor`, which keeps it out of
`get-active-terminals` (it has no sidebar row of its own to restore). It *is*
listed by `get-active-sessions`, which is what puts it in the renderer's
`activePtyIds` — see "LRU" below.

## The three lifted assumptions in terminal-manager.js

1. **Mount point.** `createTerminalEntry(session, opts)` appends to
   `opts.mount || terminalsEl` and adds `.panel-terminal` when `opts.panel`.
   With no options the behaviour is byte-for-byte what it was.
2. **`showSession` scoping.** It used to clear `.visible` from *every*
   `.terminal-container` in the document, which would blank a panel container on
   an unrelated session switch. The query is now
   `.terminal-container:not(.panel-terminal)`. Re-widening it turns
   `test/panel-terminal.test.js`'s showSession test red.
3. **Hidden-write exemption.** `isHiddenSingleViewSession()` returns true for
   any id that is not `activeSessionId` outside grid mode, and such a session
   gets zero `terminal.write()` calls (output accumulates for replay). A
   *mounted* panel terminal is visible next to another session's terminal, so it
   is exempt — `entry.panelMounted`, maintained by the mount/unmount pair, not
   `entry.panel`. The exemption is deliberately narrow:
   - the grid branch is evaluated first and is untouched;
   - an **unmounted** panel terminal (its owner is not the session the panel is
     showing) is hidden like anything else: it accumulates and replays through
     the existing `replayHiddenBuffer` on remount, so the accounting keeps one
     queue per session.

## Layout

`.terminal-container` is `position: absolute; inset: -5px 20px 0 0` inside
`#terminals` (`position: relative`); it does not flow. `#panel-terminal-region`
is therefore its own positioning context (`position: relative`, explicit pixel
height) and `.terminal-container.panel-terminal` overrides the inset to `0`.
The region and its handle live at the end of `#file-panel-content`, after the
viewer/diff/changes children, and are `display: none` until `.open`.

Height persists in `localStorage.panelTerminalHeight` (alongside
`filePanelWidth`), floor 80 px, ceiling "panel height minus 120 px" so the
content above can never be squeezed out.

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
| App quit | Killed by the main process with every other PTY (`before-quit`, and the window's `closed` handler). |

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

Remote sessions; grid mode (the panel is a single-session view and the region
follows it); more than one shell per session; tabs or splits inside the region;
any change to the main terminal's scrollback budget or WebGL handling.
