# Context: viewer-panel

## Message viewer search (#819)

The JSONL message viewer uses `public/message-search.js`, loaded before
`jsonl-viewer.js`; this is separate from CodeMirror file search. Opening a
session or subagent transcript focuses its message body unless a modal owns
focus. Ctrl+F (Cmd+F on macOS) belongs to that viewer only while focus is inside
it and the viewer is visible. The viewer consumes that event before global
shortcuts; terminal Find keeps its existing owner and binding.

The search bar has a labelled input, a live match counter, Previous/Next and
Close buttons. Enter and Shift+Enter wrap through literal, case-insensitive
matches; Escape closes and returns focus to the message body. Ranges can span
inline Markdown within an entry, but never cross entries. Navigating to a
collapsed tool result expands it. CSS Highlights leave the rendered Markdown,
links and handlers intact. An observer refreshes an open search after live
subagent content changes. Switching viewers or returning to the grid closes
search, disconnects the observer and removes highlights without moving focus.

Evidence: `test/message-search-819.test.js`; jsdom verifies behavior, not native
highlight painting or scroll geometry.

**Purpose**: Reusable CodeMirror-based file viewer with a configurable toolbar. Used by **3 callsites**: `memoryPanel` (Memory tab) and `workFilesPanel` (.work-files tab) in `public/app.js`, and the Activity trace viewer in `public/activity-trace-panel.js`. The file panel does not use it: a file opened there goes to the Touched editor (`.ai/contexts/touched-files.md`). Optionally read-only or savable. Watches the file on disk: reloads a clean buffer on an external change, and never replaces a dirty one without asking.


## File list workers

Issue #616 slice 2 routes `get-memories` and `get-work-files` through
`file-lists-worker-client.js` to `workers/file-lists-query.js`.
`file-lists.js` contains the previous synchronous listing algorithms, executed
only inside the worker. Main snapshots hidden projects and live project roots
without walking the filesystem; live roots participate only in Memory's version,
so session start/stop does not discard Work Files jobs. The worker adds the
roots derived from the on-disk project folders, then uses the unchanged `isAllowedMemoryPath` and
`scan-md-files` acceptance rules. Hidden-project filtering, Memory display
paths and ordering, Work Files worktree deduplication, recursive traversal,
the 200-file cap and total counts retain their previous behavior.

Each list has its own lazy worker and client. They are separate from the
Projects worker so a large Work Files traversal cannot queue ahead of a
Projects query or Memory listing. This adds at most two filesystem workers,
with no SQLite connection in either. Each client follows the Projects client
pattern: one in-flight scan, one coalesced pending scan, fixed 30-second deadlines
from caller registration, a five-minute dispatch ceiling, worker termination
after errors or unobserved timed-out work, and three bounded snapshot conflicts.
Unlike the Projects client's read-only fallback, an exhausted policy conflict
rejects the listing rather than publishing files from an obsolete allowlist or
hidden-project setting. Quit shuts down both clients. There is no main-thread
filesystem fallback. A rejected list load keeps the renderer's previous list and
shows a persistent error notice asking the user to reopen that tab to retry;
a successful reload clears the notice.

FTS preparation happens in the worker. Memory caches each file's acceptance
and first 32,768 characters by precise mtime, size and real path; empty files
are remembered too, and files no longer visited are evicted. `acceptMdFile`
and `scanMdFiles` accept an optional content reader after their normal guards.
That reader can return a string or `{content, nonempty}`: the latter retains
the acceptance of a file whose non-whitespace text starts beyond the FTS body
window, without retaining its entire body. The renderer payload contains no
bodies. Work Files keeps the previous text policy: title-only entries for
`.jsonl` and files over 64 KiB. Unchanged files produce no upserts. Changed,
added, removed, newly hidden and cap-displaced entries produce targeted deltas;
the title is part of the signature. Duplicate Memory paths share one FTS row.

Main remains the sole SQLite writer. On the first request per type it reads
existing indexed IDs so old rows absent from the current view can be removed.
Signatures live for the application lifetime; a restart refreshes all visible
files once in the background. A valid view is published before FTS applies;
the client yields with `setImmediate` before the first write. A published scan
releases its scan slot immediately, so the next request can scan and publish
while indexing is still running. Applies have a separate single slot per kind
and one coalesced pending delta, replaced by the latest published scan. Each
scan snapshots the signatures already acknowledged by SQLite. Main reconciles
deletions against those currently acknowledged IDs before applying the delta;
if an omitted body has become necessary since the scan, it requests a fresh
background scan while preserving the published view. This covers writes that
the preceding apply completed after the newer scan took its snapshot, as well
as changes in replaced pending applies. Cancelling or restarting a
worker invalidates an apply but retains its slot until it unwinds, preventing
overlapping writes across worker generations. Expiring an unpublished scan
terminates only that worker and leaves an already published apply valid.
Main applies at most `FILE_LIST_INDEX_MAX_ENTRIES`
(50) changes and `FILE_LIST_INDEX_MAX_BODY_BYTES` (128 KiB of UTF-8 bodies)
per `applySearchFileBatch` transaction and yields with `setImmediate` between
batches. An oversized body is clamped to the byte cap at a complete UTF-8
character without changing the worker payload, so later entries still apply.
Before every batch it checks the apply generation and the hidden/live-root/save version. Accepted
signatures advance only after a successful transaction; a conflict retries
from those accepted batches even without pending callers, and a failed write
  leaves its files dirty and logs the background failure without retracting the
  published view. Apply failures retry through a fresh background scan, sharing
  an already active scan when possible, within the same three-discard limit.
  They preserve unrelated active and queued scan callers. A published job's
  dispatch ceiling invalidates only that apply and retries its background work;
  the apply retains its slot until it unwinds. Retried scans get a fresh ceiling
  and become published only on their own reply. Caller timeouts do not cancel
  a published apply; shutdown still stops it. Save and delete hooks invalidate the
particular path, including Memory aliases of
the resolved path, with Windows case and separator folding. Resolved Memory
targets remain associated with listed IDs when their signatures become dirty.
An inverse map of normalized literal and resolved path keys to listed IDs is
built when the manifest is accepted for indexing (and seeded from existing
SQLite IDs at the first snapshot). A save normalizes only its own path and
looks up all matching IDs, including shared targets, without scanning the index.
Successful deletions remove their IDs from this map; invalidation does not add
unwritten entries to the accepted signatures.
Unrelated Markdown saves leave the epochs alone: invalidations cover Claude
memory directories, project instruction files, known listed aliases, and
`.work-files/` for Work Files. Before a first snapshot there is no per-path set;
afterwards `FILE_LIST_MAX_INVALIDATED_PATHS` (256) bounds it, collapsing overflow
to whole-type invalidation until a successful apply. Saving an unlisted file
does not grow the accepted-signature map. Invalidating a whole type is still
supported. Structured clone and bounded SQLite/FTS writes remain on main; no live responsiveness or
stress measurement was performed for this slice.

Diagnostics records `ipc.get-memories` and `ipc.get-work-files` with `totalMs`
(time to a valid view, including queue, listing and pre-publication retries)
and `entries` (listed file descriptors, including duplicate Memory paths),
behind the existing mutable
`TRACE.on` guard. `test/activity-trace-probe-guards.test.js` inventories both.
`totalMs` excludes background index batches, including any previous job's apply.
Only scan work can queue a list request.
The new tests compare real-worker lists and initial FTS deltas to a frozen
pre-change synchronous fixture, verify unchanged-body read counts and per-file
changes, path guards, hidden projects and cap behavior, exercise client
deadlines/conflicts/errors/shutdown, execute main's guarded batch writer, and
verify row preservation, deletion and FTS integrity in an isolated real WAL DB
under Electron's Node mode. The normal CI test runner discovers these files.

## Key files

| File | LOC | Role |
|---|---|---|
| `public/viewer-panel.js` | ~660 | The `ViewerPanel` class. Owns CodeMirror state, toolbar wiring, file watch lifecycle, save/format/delete logic. |
| `public/viewer-toolbar.js` | ~710 | Pure factory `createViewerToolbar(opts)` — builds the toolbar DOM + returns API. No state of its own. Also holds the shared preview helpers: `renderMarkdownPreview` (frontmatter, Mermaid) and `setViewerPath`. |
| `viewer-file-watch.js` | ~140 | Main-side `createViewerWatchRegistry` / `watchFileForViewer` behind the `watch-file` IPC — "Watching the file". |
| `viewer-save-guard.js` | ~115 | Main-side `createMainPanelSaves` (the handlers `main.js` registers for `save-memory` and `save-file-for-panel`, with the path checks from `ipc-path-validator.js`), the `createPanelSaveHandlers` it builds on, and `refuseIfMoved` — "Saving over a file that moved". |

## Public surface

```js
// Construction
const panel = new ViewerPanel(container, {
  copyPath: bool,         // show copy-path button
  copyContent: bool,      // show copy-content button
  language: 'markdown' | 'auto',  // editor mode
  storageKey: string,     // localStorage key for preview-mode persistence
  format: bool,           // show JSON/JSONL prettify button (auto-hidden for non-json files)
  onSave: async (filePath, content, expected) => result,  // shows Save button; expected is required, see "Saving over a file that moved"
  onDelete: async (filePath) => result,         // shows Delete button (with appConfirm)
  onClose: () => void,    // shows Close button
});

// Lifecycle
panel.open(title, filePath, content);  // load a new file
panel.getContent();                    // current editor content
panel.destroy();                       // tear down (rare; usually open() replaces)
```

Used at `public/app.js:31-57` for the two panel instances, and at `public/activity-trace-panel.js:24`.

## Toolbar buttons (visibility rules)

| Button | Shown when |
|---|---|
| `previewBtn` | `opts.preview` AND filePath ends in `.md`/`.mdx` |
| `wrapBtn` | always (default on for markdown, off otherwise) |
| `gotoLineBtn` | always |
| `formatBtn` | `opts.format` AND filePath ends in `.json`/`.jsonl` |
| `deleteBtn` | `opts.onDelete` provided |
| `saveBtn` | `opts.onSave` provided |
| `closeBtn` | `opts.onClose` provided |
| `copyPathBtn` | `opts.copyPath` |
| `copyContentBtn` | `opts.copyContent` |

The toolbar factory builds all configured buttons up front; `open()` toggles visibility based on file extension.

## Invariants

- **`open()` is the entry point — not the constructor**. Constructor creates an empty editor; `open()` swaps in content. Calling `open()` again on the same instance reuses the CodeMirror state via `editorView.dispatch({changes})`.
- **File watch lifecycle**: each `open()` unwatches the previous path, then watches the new one. `destroy()` unwatches but is rarely called. **If you spawn a new ViewerPanel without destroying the old one, both will keep watchers alive.**
- **`format` is a renderer-only transform** — it modifies the editor's document, doesn't write to disk. Use `save` separately if you want to persist.
- **Clipboard uses `window.api.writeClipboard`** as of PR #18 (Wayland fix). Don't fall back to `navigator.clipboard.writeText` for new copy actions.
- **Every markdown→`innerHTML` sink must sanitize marked's output with DOMPurify.** `marked` doesn't filter URL schemes, so Markdown links and images can carry `javascript:` URLs. `renderMarkdownPreview` in `viewer-toolbar.js` owns file preview rendering: the viewer toggle, `ViewerPanel._replaceContent` and the Changes diff preview all call it. It sanitizes the escaped metadata header together with the parsed Markdown body. Transcript rendering in `jsonl-viewer.js` sanitizes independently; when DOMPurify is absent, it falls back to escaped plain text.

## Markdown frontmatter

`renderMarkdownPreview` recognizes frontmatter only when an exact `---` line
starts the file (optionally after a BOM), with an exact `---` or `...` closing
line. LF and CRLF are accepted. Incomplete blocks and delimiters elsewhere
retain ordinary Markdown rendering. The source document is never changed.

The dependency-free parser accepts plain keys, plain and quoted strings,
scalar inline/block lists, simple nested maps (up to 20 levels), comments,
and literal/folded block strings with default or strip chomping (folded blocks
with more-indented text fall back to raw YAML). Values stay
display text; no type construction, tags, anchors or aliases are evaluated.
Unsupported syntax, invalid indentation, duplicate keys and malformed quotes
fall back to the entire raw block in an escaped `<pre>` above the body.
A block that holds only comments and blank lines shows the same way, so text
between two `---` lines never disappears. Brackets and braces are refused only
inside inline lists; a plain value may contain them, and a block list may sit
at its key's own indent.

Name and title are emphasized, description is a lead, other fields form a
two-column definition list. Scalar lists are comma separated; validated nested
maps retain indented YAML. All header keys and values pass through `escapeHtml`
before the complete preview is sanitized. Frontmatter styles use the existing
surface, border, accent and muted text variables in both themes.

`test/viewer-frontmatter.test.js` evaluates the shipped renderer scripts with
filenames in `test/dom-setup.js`'s jsdom context and uses real marked/DOMPurify.
It checks rendering, detection boundaries, fallback, escaping and viewer
toggle/refresh paths while verifying the editor retains the complete source.

## Saving over a file that moved

**One rule, enforced by main: every save carries, as `expected`, the exact disk content the user agreed to replace, and main refuses anything else.** The renderer's job is to know what the user agreed to; main's compare is what keeps a write the user did not agree to from being replaced. No path in the viewer or the MCP diff tab sends a save without `expected`, and main refuses one that does.

### Main

`save-file-for-panel` and `save-memory` are the handlers `createMainPanelSaves` builds in `viewer-save-guard.js`. It takes the path checks (`isSensitivePath`, the memory allowlist) from `ipc-path-validator.js` itself; `main.js` hands it only its own state, `getKnownProjectPaths` and `invalidateFtsSignature`. `test/viewer-save-guard.test.js` builds the same handlers with `createMainPanelSaves`, so what it exercises is what main registers, and no binding in `main.js` can make the save path permissive. Each handler validates the path — `save-memory`: a `.md` file, resolved through the memory allowlist, written at the resolved path; both: the file exists — then `writeIfUnmoved`, which runs `refuseIfMoved`:

- `expected` not a string → refused, `reason: 'invalid-expected'`. There is no blind write.
- The file on disk, line endings folded to `\n`, differs from `expected` → refused, `reason: 'stale'`, with **`disk`: the text it compared**, folded the same way.
- Otherwise the content is written and the FTS signature invalidated.

A `save-file-for-panel` call that also passes a version token (`{version}`, the Touched editor's local file outside Git, #803) is checked on bytes instead: `versionOf` of the file on disk must equal the token, or the save is refused `stale` with the folded `disk`; the content is written with the file's sole line ending (`soleEol`, LF for a mixed file) and its UTF-8 BOM kept, and the answer carries the new `version`. A Git file goes through `writeTouchedChangesFile` instead; see `.ai/contexts/touched-files.md`. `ViewerPanel`'s own saves (`save-memory`) send no version and keep the `expected` compare above.

The compare and the write are not atomic: a write landing between the read and `writeFileSync` is still replaced, the same window the Changes panel's version token has.

### The agreed base

`ViewerPanel` keeps `_agreedBase`, sent as `expected`, and `_lastSeenDisk`, the disk as last read. Both are held with line endings folded (`asEditorText`), because CodeMirror splits on `\r\n` and `\r` and hands its document back joined with `\n`.

`_agreedBase` moves only when the user has nothing to lose or has agreed:

| Event | `_agreedBase` becomes |
|---|---|
| `open()` | the content opened |
| a re-read while the buffer is clean (then reloaded) | the new disk |
| a re-read that finds the disk equal to the buffer | the new disk |
| a save that succeeded | what was written |
| **Keep my edits** | `_lastSeenDisk`, the disk the notice described |
| **Reload** | the disk re-read |
| a confirm after a stale refusal | the `disk` main returned |

A re-read while the buffer is **dirty never moves it**; it only updates `_lastSeenDisk` and raises the notice. The buffer is clean when it equals `_agreedBase` or the disk last seen before this read.

### A stale refusal

Main returns the disk text it compared. The panel shows the "not saved" notice, then asks `appConfirm` ("This file changed on disk since you opened it. Overwrite it with your edits?") — worded like the diff tab's, because a refusal can be the first the user hears of the other write (nothing raised "changed on disk" before it):
- On yes, that text becomes `_agreedBase` and the save is retried with it. If the retry is refused too, the disk moved while the confirm was open: the panel asks again with the new text, and never writes without a compare.
- If the panel was switched to another file while the save or the confirm was pending (`_openGen`), nothing is retried and nothing is asked about the new file.
- On no, nothing is written and the notice says "This file changed on disk since you opened it — your edits were not saved", with **Reload** and **Overwrite**. **Overwrite** is a plain save that goes through the same check and confirm.

A plain save while the "changed on disk" notice is up is refused the same way, because the dirty re-read did not move the base, and asks the same confirm. **Keep my edits** is the agreement given ahead of time: the next save carries the disk the notice described and goes out without asking, and a further write nobody has read is still refused.

The MCP diff tab follows the same rule. Its base is the diff's `oldContent`, which `mcp-bridge.js` read from disk when the diff opened. It moves to what was written after each save, and to main's returned `disk` on a confirmed `appConfirm` ("This file changed on disk since the diff opened. Overwrite it with your edits?"); a refused retry asks again. Any other refusal, or a rejected IPC, is reported with `appAlert`, the same channel `ViewerPanel`'s Delete uses; a declined confirm is the end of it.

### What the rest is for

Everything below is presentation; none of it carries the rule.

- **Re-reads.** Every `file-changed` event re-reads the file, through `rereadFromDisk` — queued like any other re-read while the document is not in the editor yet (see "A document not yet in the editor").

  | On disk | Result |
  |---|---|
  | the save in flight (`_pendingSave`) | our own echo: nothing |
  | equal to the buffer | base moves, notice cleared |
  | equal to `_agreedBase` | a "gone", "cannot be read" or "changed" notice is cleared (a `touch`, an undone write, an identical recreate) |
  | changed, buffer clean | reloaded quietly |
  | changed, buffer dirty | buffer untouched; "This file changed on disk since you opened it…" with **Reload** and **Keep my edits** — unless the notice already says a save was not saved, which it keeps with its **Overwrite** |
  | missing (`ENOENT`) | buffer untouched; "This file no longer exists on disk", and that the edits are kept when there are any |
  | unreadable | buffer untouched; the reason |

  **Reload** asks `appConfirm` ("This file has unsaved edits. Discard them?") when the buffer is dirty, as the Changes panel does. `read-file-for-panel` returns the error's `code`, which is how the renderer tells `ENOENT` apart. A re-read that resolves after `open()` has moved to another file is dropped (`_openGen`).
- **Notice after a save.** A successful save clears the notice unless a re-read raised "changed on disk" while it was in flight (`_noticeSeq`); the base has moved to what was written, so the next save against that later write is refused and asks.
- **The queue.** One save is in flight at a time (`_pendingSave`). A save requested meanwhile is queued, and sent once the first returns ok, carrying the base that save left; if the session wrote in between, main refuses it and the panel asks. It is dropped if the first save fails. `open()` resets the pending save and the queue, so a save of the newly opened file goes out on its own, and the previous file's save touches neither when it resolves. The MCP diff tab queues a click during a save the same way (`tab.saving`), and drops it once the tab has lost its editor.
- **An answered diff.** Once a diff is answered (Accept or Reject, `tab.resolved`), the session writes the file itself and the base no longer describes the disk. Save is refused, and the shared diff Save button is disabled with a title saying why, until the session closes the tab. The button's state is set on each render of a diff tab, so a diff opened after an answered one has Save enabled again.
- **Other failures.** A save refused for any other reason, or whose IPC rejects, shows `Save failed: <reason>` in the notice.

## Snapshots and save tokens

`snapshot()` returns the buffer, `_agreedBase` and `_lastSeenDisk` of the file on screen, and `open(title, path, buffer, restore)` reopens a file from one. The only caller is `rereadFromDisk`, which reopens the panel from its own snapshot while the document is not yet in the editor.

Each showing of a file carries a token (`_token`): a fresh `open()` makes a new one, and a restore takes back the one in the snapshot, so the token names the showing, not the path. A save captures the token when it starts, and when it resolves:

- if the viewer holds that token, the result is applied directly: a success moves the base to what was written, a failure shows `Save failed: <reason>`;
- otherwise the outcome is recorded under its token (`_detachedSaves`, a `WeakMap`), and applied, once, when that snapshot is restored.

Keying by path would hand one showing's result to another on the same file, which would take the saving one's base while still showing the old content.

## An open aimed at the panel

**Nothing a session triggers shows a modal, and no route drops unsaved edits without the user saying so.** A session's file panel has one tab slot (`state.currentTab`). Three routes fill it without the user choosing it in the panel: the MCP `openFile` tool and a file clicked in the terminal, both through `openTouchedPath` (`.ai/contexts/touched-files.md`, "One route into Touched"), and the MCP `openDiff` tool (`openDiffTab`). A replacement goes through `destroyCurrentTab`, which stashes a dirty Changes buffer (`changesStash`) or a dirty Touched editor (`touchedStashes`, "Stashed edits" in the Touched context) instead of dropping it.

### Per route

| Route | Over a dirty Touched editor on another file | Over a clean one |
|---|---|---|
| a clicked file (`'link'`) | `appConfirm` ("This file has unsaved edits. Discard them?"); a no keeps the editor and reads nothing | replaced |
| `openFile` (`'mcp'`) | not replaced; the file is read and listed as opened | replaced, no question |
| either, the file already in the editor | kept as it is, not re-read; a line is revealed | the same |
| `openDiff` | the editor is stashed and comes back when the session closes the diff | replaced; closing the diff closes the panel |
| the panel's close button (the user's own click) | the same confirm; a no keeps the editor | closed |

An open only ever touches the slot of the session it is aimed at (for a panel shell, the session that owns it).

### An open that arrives over a diff

An unanswered diff (`type 'diff'`, not `resolved`) is never replaced by an open: the CLI is waiting on its answer. The open is stored in `tab.pendingTouchedOpen` on that diff (`{filePath, line, origin}`; a later one replaces it) and replayed when the diff ends:

- the session closes it (`closeDiffByDiffId`, `closeAllDiffs`);
- the user answers it with Accept or Reject while an open waits: the diff tab ends there;
- the panel's close button on the diff, which answers reject.

Each of these reads and clears `pendingTouchedOpen` before `destroyCurrentTab`, then calls `endCurrentTab(sessionId, state, {pending, restoreStash})` (`endDiffTab` for the first two, with `restoreStash: true`; the close button passes `{pending}` only). `endCurrentTab` hides the panel, then replays the pending open, or, with `restoreStash`, opens Touched on the newest stash; otherwise the panel stays hidden. A replay runs as origin `'mcp'`, so it never asks; the stored origin only decides whether the remote check runs. Changes and Touched, by click or shortcut, park an unanswered diff by `diffId` in `state.parkedDiffs` and detach its merge editor without destroying it. The deferred open survives parking on its own tab. Ending another diff cannot replay or clear it. The conditional Diff icon returns the oldest parked tab and its editor, including over an answered diff, and the open replays when its own tab ends in the slot. Closing a parked diff through the CLI clears only that diff and its deferred open without disturbing the shown tool or another diff. MCP off and process exit clear all parked diffs and their deferred opens without sending another response. A second `openDiff` remains outside this rule and retains the existing replacement behavior. See [tool-bar.md](tool-bar.md). With no open waiting, Accept and Reject keep the answered diff in the slot until the session closes it; the session's close of a diff that has already ended is a no-op.

### Unsaved edits on quit, reload and close

Nothing ends the window with unsaved file-panel edits without the user saying so. The scope is the Touched editor in the slot (a tab with an `absolutePath`) and every `touchedStashes` entry, in every session of `filePanelState`; the Memory and Work Files panels, MCP diff tabs and Changes buffers are not covered.

- **Main** (`unsaved-guard.js` and `session-exit.js`) binds each exit to a window, attempt id, version, action and PTY-generation snapshot. App-menu Quit/Exit, Restart and bare window close check unsaved edits first, then name threatened local sessions, plain terminals and panel shells in a separate Stop/Cancel dialog. Save/Discard does not grant Stop consent. Only after both choices does `flushStateForExit` run, bounded to 2000 ms. A failed Save never reaches the session question. With only attach/remote clients, the edits check still runs but the Stop question is omitted. Main supplies identities and types; renderer names are text-only. See [window-frame](window-frame.md), "Closing the window", for inventory and wording.

- **Handshake.** `unsaved-check` carries `(id, reason, detail)`; detail has action, attempt, version, external and snapshot. Stronger user intent upgrades the version and requires a new Stop choice. `unsaved-check-reason` also carries detail and its own completion token. A detail-less reload answer arriving after an exit upgrade is stale: main re-sends `unsaved-check` with the current detail. The renderer handles that check through the normal edits, Stop/Cancel and bounded-flush sequence. A late reason notification alone starts no choice or flush; its completion timer cannot approve the pending check. ACK, result and reason completion accept only the requesting webContents; results must match attempt/version. Repeated gestures join one modal. Revalidation rejects added, replaced or re-keyed generations before commit; departed targets may disappear. Committed attempts gate interactive PTY admission and pending completions.

- **Invalidation.** `exit-attempt-invalidated` settles old choices, clears unload approval and pending continuations, releases `exitingApp` and its timer, and resumes suppressed working-set persistence immediately. A later exit asks again. Reload alone keeps the existing edits and one-unload flow. `will-prevent-unload` still asks for reload; every exit checks the renderer even when the inventory is empty.

- **External exits.** Untagged before-quit skips only the Stop question and retains edits checking, renderer flush, no-ACK/hung escapes and bounded shutdown. Windows query-session-end/session-end instead invalidate user attempts, send exit-flush and start a coalesced, bounded, non-destructive main drain without waiting for an ACK. The query expires after 60 seconds; user Quit, X and Restart never inherit that approval. On macOS Dock Quit/logout are untagged and can stop sessions without a Stop question when there are no unsaved edits; JB accepted this residual on 2026-10-21. The app-menu Cmd+Q path is tagged and asks. Force termination bypasses this flow.

- **Bounded.** The renderer acknowledges (`unsaved-check-ack`) as soon as it receives the check, before any dialog. The 2.5 s bound (`DEFAULT_TIMEOUT_MS`) covers only send to ack, and only for `'quit'` and `'reload'`: no ack answers yes, so a hung renderer never keeps the app from quitting. A `'close'` check has no such bound: a busy page shows the close question once it is free, and a hung one is ended when Electron reports it unresponsive or the user closes it again (see [window-frame](window-frame.md), "A window that stops answering"). After an unanswered quit or update install the window is closed the usual way (`app.quit()`), so a page that is only slow closes as before, without the question, once it runs its `beforeunload`. A hung page never runs it, and that close would never finish: the guard destroys such a window when Electron reports it `unresponsive`, or when it is closed again, the guard's own `close()` or `app.quit()` aside. Electron reports a page `unresponsive` about 5 s after a close it has not completed, and cannot tell a hung page from a busy one: a page still busy about 5 s after that close, about 7.5 s after the quit counting the 2.5 s bound, is destroyed, and its pending work is lost (the debounced working-set save among it); a page that recovers before then closes normally. A page reported unresponsive earlier, and neither `responsive` nor acknowledging a check since, is destroyed once the quit closes the window (its `close` event), so a quit still held by another `before-quit` handler (the ActivityWatch flush) is not cut short. A check the page acknowledged never destroys the window, however long the user takes. After the ack the guard waits for the answer without a limit, so a slow user or a slow save loses nothing, and answers yes only if the renderer process is gone (`render-process-gone`, `destroyed`), a send fails, or a repeated close finds the page not answering (window-frame, "A window that stops answering"). The bounds pause while the page shows a native dialog ("A native dialog pauses the bounds" there). A late answer is ignored.
- **Renderer** (`file-panel.js`). `askAboutUnsavedEdits()` lists the dirty tabs (`collectUnsavedFileTabs`) in the `#unsaved-edits-dialog` dialog, built on the add-project dialog's classes (already in the frameless no-drag list). Save writes every dirty entry: the editor in the slot through `handleChangesSave`, a stashed one through `saveFileForPanel(filePath, content, savedContent, {git, version})`, removed from its session once written. A save that fails (including a disk that moved) keeps the dialog open with the reason, and nothing is answered. Discard answers yes. Cancel and Escape answer no. A second request while the dialog is open gets the same dialog's answer.
- **`beforeunload`.** The renderer vetoes an unload while an entry is dirty, unless `unloadApproved`, set for 10 s after the user answered yes. That is what stops a reload from the keyboard or devtools from slipping past, and what keeps the veto from asking a second time after an approved close.
- **Closing a session** does not drop its file panel: `destroySession` leaves `filePanelState` alone, so the tab and the stashes, dirty or not, are still there when the session is opened again, and the quit check still sees them. Deleting a session leaves its state in memory too, so its edits are asked about at quit rather than lost.

### A document not yet in the editor

`open()` puts its document in the editor only once the CodeMirror bundle has loaded. Until then the panel holds it as `_pendingContent`, and that is the buffer: `_isDirty` and `snapshot()` read it, so a snapshot taken before its editor exists keeps the edits.

- A re-read asked for while the load is in flight (`rereadFromDisk`, from the file watch) is queued (`_rereadQueued`) and runs once the document is in the editor. A new `open()` clears the queue. Reopening instead would call `open()` again, which clears the notice: a save failure just applied from a restored snapshot's record would vanish.
- Save does nothing, and the Save button is disabled, until the document is in the editor: the user has typed nothing yet, and `getContent()` would read the empty editor, which main would accept over a file still equal to `expected`. Copy copies `_pendingContent`. Format, wrap and go-to-line return while there is no editor.
- If the bundle fails to load, the open is no longer in flight but the document is still not in the editor. The next re-read opens the panel again from its own snapshot (buffer, bases, token), and the load is retried: `loadCodeMirrorBundle` forgets a failed load.

### Paths

Main resolves the `openFile` path (`path.resolve` in `mcp-bridge.js`), so `/repo/./a.md` reaches the renderer as `/repo/a.md`. The renderer compares paths with `filePathKey`: on `win32`, separators folded to `/` and case folded; elsewhere, exactly. macOS is not folded: APFS can be case-sensitive, where `A.md` and `a.md` are two files, and stashing one under the other's key would show the wrong buffer. A relative path is resolved against main's working directory, not the session's; the CLI sends absolute paths.

### The `ok` answer

`openFile` without a non-empty string `filePath` is answered with a JSON-RPC error (`-32602`) and opens nothing. Otherwise it answers `ok` as soon as main has sent the path to the renderer, before the renderer acts, whatever the renderer then does with it: the panel's guards may refuse the file, an editor with unsaved edits leaves it listed only, an unanswered diff defers it. `mcp-bridge.js` reads nothing; the only read is the panel's guarded one.

## Undo

Undo steps only through the user's own edits to the file on screen. The two editors a `ViewerPanel` builds (`createPlanEditor`, `createEditableViewer`) hold `history()` in a compartment (`view._historyCompartment`). Whenever the panel puts content in the editor itself — `open()` of another file, `_createEditor`'s initial fill, a restored snapshot, a quiet reload, **Reload** — `_setDocument` replaces the document and then calls `cmResetHistory`. That helper, exported by `codemirror-setup.js`, reconfigures the compartment to nothing and back: removing the extension drops its state, and adding it back starts an empty history. Reconfiguring to `history()` in a single step would keep the old state, because the history field is the same.

Keeping those replacements out of the history is not enough. The user's earlier entries are mapped through a whole-document replace and stay undoable: a deletion made in one file would be re-inserted into the next file the panel opens, or into the content a quiet reload brought, and the next save — whose `expected` is the disk — would write it. One viewer opens file after file, so the text could land in another file. A restored snapshot starts with an empty history for the same reason; the history is not part of the snapshot. `test/viewer-panel-undo.test.js` drives both cases, with deletions, against the real CodeMirror.

## Watching the file

`watch-file` watches the **directory** holding the file and reports every event that names the file, whatever its type. A watch on the file itself is armed on its inode, and an atomic replace — `git checkout`, `sed -i`, most editors' save — writes a temporary file and renames it over the target, leaving the watch on an inode nothing writes to any more; a delete ends it outright, so the file's recreation is never seen. The directory entry outlives both, so a rename over the file, a delete, a recreate, and every write after them keep reaching the panel with nothing to re-arm.

- The path is resolved with `fs.realpathSync.native`, so the watched name carries the on-disk case and a symlinked file is watched in the directory of its target, where its writes happen. A path that does not resolve is watched as given.
- A symlink is **also** watched in its own directory, under the link's name. GNU `sed -i` without `--follow-symlinks` and rename-over editors replace the link itself with a regular file; the target's directory never hears that, the link's does.
- Events for other files in the directory are dropped by name — compared case-insensitively on `win32` and `darwin` (`sameFileName`), exactly elsewhere. An event with no filename is reported, since the renderer re-reads and compares anyway.
- Events are debounced (300 ms) into one `file-changed`.
- An `error` from the watcher (its directory removed) is swallowed; the watch is then dead, which is the one case not recovered.

The renderer records a watch (`_watchedPath`) only once `watch-file` answers `ok`, so a failed watch is never released by a later `unwatch-file` that would take another panel's reference. A watch acknowledged after the panel has moved to another file is released at once.

`createViewerWatchRegistry` holds one watch per resolved path and **counts references**: the Memory panel and a Touched editor showing the same file share it, and it is closed only by the last `unwatch-file`. `closeAll()` is what the window's `closed` handler calls (`closeAllFileWatchers`).

The Changes panel's registry (`git-changes-watch.js`) solves the same problem differently, by re-arming on the file after a `rename`. The two are not merged.

## Non-obvious behaviors

- **Markdown preview mode is persisted per-storageKey** in `localStorage`. Memory uses `'markdownPreviewMode'`; .work-files uses `'workFilesPreviewMode'`.
- **Line-wrap default depends on file type**: markdown wraps, code doesn't. Wrap state is NOT persisted — resets per file.
- **`format` for `.jsonl` is intentionally non-standard**: each line is pretty-printed and joined with `\n---\n`. This produces human-readable output but is no longer valid JSON. The button is for *viewing*, not for converting files to a different format.
- **Cmd/Ctrl+S keybinding**: CodeMirror dispatches a `cm-save` custom event which the ViewerPanel listens for. Chromium's "Save Page" default is blocked globally in `viewer-toolbar.js:699` (`keydown` listener with `preventDefault`).
- **The editor's surface is the app's, not the CodeMirror theme's**: `public/style.css` puts `.viewer-panel-editor .cm-editor`, its gutters and its active-line gutter on `--surface-sunken`, with a `--hairline` rule after the gutter. The same rule covers the file panel's editor hosts, so the Memory viewer, the Work Files viewer, the MCP diff and the Changes and Touched editors share one surface. See `.ai/contexts/changes-view.md` ("Look and feel").
- **The toolbar API exposes button refs directly** (`toolbar.saveBtn`, `toolbar.formatBtn`, …). The ViewerPanel reads `null` checks instead of asking the toolbar — slightly leaky encapsulation, but harmless.

## If you change this, also check

- `public/app.js` and `public/activity-trace-panel.js` panel constructors (3 callsites) — adding a new opt may need wiring there
- `eslint.config.js` if you expose a new cross-file global (e.g. `flashButtonText`, `toggleMarkdownPreview` are already declared)
- `test/dom-work-files-view.test.js` — covers the panel render path for the .work-files tab
- If you add a new file-type-aware button, mirror the `_isJsonish()` / `_isMarkdown()` pattern with an `_isXyz()` helper rather than inlining the extension check

## Changes mode (issue #251)

`public/file-panel.js`'s side panel has three tab types on the same
per-session `filePanelState`: `'changes'`, `'touched'` and the MCP `'diff'`. Full design (why it skips `ViewerPanel`, the
entry point, the no-polling refresh trigger, editing): `.ai/contexts/changes-view.md`.
User-facing behavior: `docs/changes-view.md`.

A local session's selected file is edited in one of the same CodeMirror views
this component builds its own editors from — `createMergeViewer` (default),
`createUnifiedMergeViewer` or `createEditableViewer`, picked by a three-way
mode button and persisted under `localStorage.changesDiffMode` (the MCP diff
tab's `filePanelDiffMode` is a separate key with a separate meaning). Three
things about that editor are not `ViewerPanel`'s:

- **The tab owns the instance, not the panel.** It lives on `tab.editorView`
  the way the MCP `'diff'` tab's does, keyed by path + staged + mode, and a
  re-render reuses it instead of rebuilding — the Changes tab re-renders on
  every busy→idle edge, which would otherwise land on the user's cursor.
  `destroyCurrentTab()` and `closeChangesDiff()` are what end its life.
- **Reading the buffer back is asymmetric.** A side-by-side `MergeView` is read
  from `view.b.state.doc`, the inline and plain views from `view.state.doc` —
  the same asymmetry `handleDiffAction` already navigates for the MCP tab.
- **The save is an IPC by session, not by path**: `gitChangesSave(sessionId,
  repoRelativePath, content, version)`, not `saveFileForPanel`. The renderer
  never holds an absolute path for a Changes row, and the version token is what
  stops it overwriting a file the session has written in the meantime.

`ViewerPanel`'s own protections have Changes-panel equivalents rather than
reuses, for the same reason: watching goes through `git-changes-watch` instead
of `watch-file` (session-keyed, no absolute path), and the in-flight save flag
lives on the tab instead of the component. An MCP-driven open replaces whatever
tab is showing, so a dirty Changes buffer is stashed on the session's panel
state (`changesStash`) and restored when the tab is reopened; a dirty Touched
editor is stashed the same way, in `touchedStashes` (see "An open aimed at the
panel").

`Cmd/Ctrl+S` arrives as the same `cm-save` DOM event the bundle dispatches, and
the listener sits on `#changes-diff-view`, which is where `ViewerPanel` puts
its own (on its container).

The merge-view CSS in `public/style.css` is written for two hosts in one rule
list — `#file-panel-body` (MCP tab) and `#changes-diff-host` (Changes tab).
A new host means a new selector in those groups, not a copied block.

`createMergeViewer`'s `b` side and `createUnifiedMergeViewer` carry the editing
extensions a writing surface needs — `history()` (Ctrl/Cmd+Z), `defaultKeymap`,
`indentWithTab`, `indentOnInput`, `drawSelection` — and `cmSaveKeymap`, which is
what turns Ctrl/Cmd+S into the `cm-save` event the panels listen for. A
read-only viewer gets `cmSaveDomHandler` instead; an editable one must not have
both, or one keystroke raises two saves. `createUnifiedMergeViewer` takes
`{mergeControls}`: the MCP diff tab keeps the per-chunk Accept/Reject buttons,
the Changes panel turns them off. `test/codemirror-merge-editing.test.js`
drives all of this against the real CodeMirror under jsdom — a stub that
dispatches `cm-save` itself proves nothing about the keymap.

All three factories take an `onChange` callback, and `docChangeListener` in
`public/codemirror-setup.js` delivers it from a CodeMirror `updateListener` on
`docChanged` rather than from a DOM `input` listener on the editor: it fires
for typing, paste, undo/redo and programmatic dispatches alike, where a DOM
`input` event reports only the first two. A Save button whose enabled state is
computed from that callback is therefore still right after an undo.

## Gotchas

- **CodeMirror state holds DOM references** — calling `destroy()` then immediately `open()` on the SAME container works because `_createEditor` rebuilds it, but if you reorder this, the editor can dangle.
- **`format` swallows parse errors**: an invalid `.json` file shows a `!` flash on the button instead of an error message. By design (no toast system in this codebase yet).
- **`onDelete` doesn't refresh the list automatically** — the workFilesPanel wires a manual `removeWorkFileFromCache(filePath)` call in its `onDelete` handler. If you wire `onDelete` to another panel, add the equivalent refresh.

## Shared controls and header paths (#467)

Keep the select, button, icon button, info button and modal styles together in
`public/style.css`. `control-select` shares the unchanged `settings-select`
look; the Settings alias remains supported. `control-btn` aliases the panel
button style, and `icon-btn` and `info-btn` compose compact controls.
`modal-overlay` and `modal-dialog` share the existing What's new dialog rules.

`setViewerPath` in `public/viewer-toolbar.js` builds every file/diff header
path: ViewerPanel (Memory, Work Files, Activity trace), Changes/Touched editors
and the MCP diff header. It keeps the complete path in `title` and two text
spans: the head shrinks first with ellipsis, and an oversized filename tail
can also shrink with its own ellipsis. A separator-ending path displays its
last non-empty segment as the tail; `title` retains the original path. CSS
follows available width without measuring text or injecting path markup.
jsdom checks structure and hover paths; visual width behavior needs a live run.


## Mermaid diagrams (#663)

All file previews use the same marked + DOMPurify pass in `renderMarkdownPreview`
(viewer-toolbar.js), including frontmatter, ViewerPanel toggle/external refresh and
the Touched/Changes shared editor. Only fenced code tokens with the exact info
string `mermaid` are upgraded; other fences and raw HTML code blocks stay ordinary
Markdown. The returned promise tracks optional diagrams; the sanitized document
shows immediately. Source/editor content is never rewritten.

`loadMermaidBundle` injects one local script into a shared off-screen iframe,
shares concurrent loads and retries failures by removing the failed frame.
The frame uses the host viewport dimensions and has its own document and Mermaid
realm. A WeakMap associates the loaded library with that document; scratch
containers attach there, and sanitized SVG crosses back to the host preview.
`public/mermaid-setup.js` bundles pinned Mermaid into the generated,
ignored `public/mermaid-bundle.js`. Start/build/release, CI and test-pr build it
alongside CodeMirror; packaging includes it in app.asar through `public/**/*`.
Mermaid is a build dependency, like CodeMirror: its bundled code ships, while the
large upstream source/dependency tree is excluded from production packaging.
Test-pr skips Mermaid for older PRs without the bundle script.

A global serial queue keeps Mermaid configuration and temporary DOM exclusive,
including overlapping previews and previews scheduled from a running render.
Each scratch takes the preview's current `clientWidth` in pixels when its queued
render starts, only if that width is positive. A render started at width zero
leaves the scratch width unset and is not cached. Becoming visible keeps that
fallback-width diagram until the next visible preview refresh re-renders it at
the measured width, then caches it. Gantt measures its SVG parent's `offsetWidth`,
so the scratch must not inherit the renderer iframe's initial viewport width
after the panel narrows.
Timeline and journey lay out their content bounds; XY charts use their configured
chart width. Those intrinsic widths keep the existing horizontal scrolling behavior.
`renderScopedMarkdownDiagram` installs a scratch-only `document.getElementById`
on the scratch's owner document for the entire awaited render. It compares exact IDs among scratch descendants,
without consulting the original page lookup or interpolating IDs into selectors.
Thus sequence `addDetails` cannot read private page JSON, regardless of Mermaid's
source preprocessing. Duplicate IDs on the page cannot shadow renderer IDs.
The exact `document.querySelector('body')` selection also returns the scratch:
Mermaid's mindmap/cose and architecture renderers append a `cy` layout container
through D3 body selections, and that container must remain accessible to the
scoped lookup. Other selectors retain their normal behavior. Both methods' own
property descriptors (or inherited status) are restored in `finally`, on success,
synchronous throw or asynchronous rejection. The production guard affects only
the renderer frame; host lookups and application callbacks such as notifications
retain normal DOM access throughout asynchronous Mermaid work.
Cytoscape can add `__________cytoscape_stylesheet` under `head`; the scoped lookup
deliberately hides any page copy. The guard snapshots existing copies and removes
only newly inserted copies in `finally`, preserving preexisting page nodes.
Each render initializes strict mode, disables HTML labels and automatic scanning,
and locks every default config key against document frontmatter/directives.
Source containing HTML-style tag openers, numeric/angle entities (`&#…` or
`&lt;`), `img:`/`icon:` properties, `@import`, `url(` or `image-set(` is refused
before temporary DOM attaches. A cheap `details` pre-check checks a union of source
forms: the raw source; the raw source with directives removed; and the source
with `/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/` frontmatter stripped before
removing directives. Directive removal uses Mermaid 12.1.0's `directiveRegex`
from `chunk-VPRB5NB3.mjs`, preserving Unicode line separators as Mermaid does.
A fourth form normalizes CR/CRLF to LF, strips frontmatter with
`/^([^\S\n]*)---[^\S\n]*\n[\s\S]*?\n\1---[^\S\n]*(?:\n|$)/`, then removes
directives. It covers trailing fence whitespace, matching indentation and BOM
indentation: otherwise an unterminated directive in that metadata could hide
directive-split keywords in the body from all three earlier forms.
A case-insensitive `/sequenceDiagram/i` match in any form and a
case-insensitive `\bdetails[ \t]+[^\n:;]+[:;]` match in any form refuse the source.
The colon is not required: semicolons in participant names are refused too.
The predicates may be satisfied by different forms, without modelling statement
boundaries; participant names with spaces are covered. This deliberately also refuses
sequence labels such as “See details X:” and non-sequence diagrams mentioning
“sequenceDiagram” and containing “details X:”.
The tag-opener check
ignores paired `<<…>>` annotations containing no angle brackets, newline or
`=`; this accepts `<<value-object>>` and `<<Service Provider>>` while keeping
`<<img src=x>>` subject to the HTML check. Entity and resource checks inspect
the original source, including annotations. Ordinary “See details below” text,
backslashes in paths and bare comparison `<` are allowed; CSS escapes are
rejected in the output pass. Unsupported
HTML/resource features show source plus a short error, like invalid syntax. This
deliberate subset prevents pre-sanitization loads. No bindFunctions callback runs.

Mermaid 12.1.0's sequence `addDetails` reads `document.getElementById(text.text)`
and parses that page element's HTML as JSON properties/links. The DOM guard returns
null for page elements, which Mermaid handles in its own try/catch; the source
pattern is only an early refusal and is not the security boundary. `addLinks` and `addALink` parse the supplied
text directly without a DOM lookup; `link`/`links` remain allowed. Other bundled
`getElementById` calls use internal element maps, generated render/marker IDs,
the fixed layout container `cy`, or generated popup code. The popup callback
is never bound and SVG event handlers are sanitized away. Real Mermaid 12.1.0
jsdom tests compare raw SVG byte for byte with and without the guard for the
eight existing diagram fixtures, colored markers and architecture. Both sides
use the production Mermaid bundle built in memory, with the unguarded baseline
calling `mermaid.render` directly. The test-only
SVG/canvas geometry, clock, random IDs and hand-drawn seed are deterministic;
these checks establish output equivalence rather than browser layout accuracy.

DOMPurify SVG + SVG-filter profiles sanitize output before insertion. A second
pass removes image/foreignObject/animation elements, non-fragment hrefs, resource
attributes and CSS containing imports, external URLs or escapes. Local markers
and safe generated styles survive. All IDs and their CSS/marker/ARIA/link references
are namespaced per render. Temporary containers are removed in finally. WeakMap
state and generation checks discard late results when content changes.
Each preview retains sanitized diagram clones only for its current source, theme
and fence index. Refresh builds the new document off-DOM and inserts unchanged
diagrams synchronously, without source flashes or another bundle/render call.
Changed source, palette or index invalidates the entry; removed diagrams are
evicted on the next preview. Both synchronous document replacement and async
diagram replacement preserve the preview scroll offsets.

The app currently has a fixed dark palette without a global light/dark selector.
Diagrams derive their palette from `--surface-sunken`, or explicit html/body
`data-theme=light|dark`. One observer watches root/body theme/class/style changes
and re-renders connected previews when the effective palette changes. SVG viewBox
width becomes intrinsic width; wide diagrams scroll inside their wrapper. The
main.js renderer CSP is unchanged: self scripts, self/data images, self fonts,
inline styles permitted, no eval permission.

`test/viewer-mermaid.test.js` loads shipped code with real marked and DOMPurify,
stubbing only the lazy Mermaid module edge. It covers strict config, laziness,
frontmatter, raw-HTML lookalikes, errors, hostile SVG, ID/reference isolation,
async replacement, cleanup, theme changes, scrolling CSS and build wiring.
