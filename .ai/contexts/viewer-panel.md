# Context: viewer-panel

**Purpose**: Reusable CodeMirror-based file viewer with a configurable toolbar. Used by **2 callsites** in `public/app.js`: `memoryPanel` (Memory tab), `workFilesPanel` (.work-files tab). Optionally read-only or savable. Watches the file on disk: reloads a clean buffer on an external change, and never replaces a dirty one without asking.

## Key files

| File | LOC | Role |
|---|---|---|
| `public/viewer-panel.js` | ~415 | The `ViewerPanel` class. Owns CodeMirror state, toolbar wiring, file watch lifecycle, save/format/delete logic. |
| `public/viewer-toolbar.js` | ~265 | Pure factory `createViewerToolbar(opts)` — builds the toolbar DOM + returns API. No state of its own. |
| `viewer-file-watch.js` | ~140 | Main-side `createViewerWatchRegistry` / `watchFileForViewer` behind the `watch-file` IPC — "Watching the file". |
| `viewer-save-guard.js` | ~80 | Main-side `createPanelSaveHandlers`, the `save-memory` and `save-file-for-panel` handlers, and `refuseIfMoved` — "Saving over a file that moved". |

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
  onDelete: async (filePath) => result,         // shows Delete button (with window.confirm)
  onClose: () => void,    // shows Close button
});

// Lifecycle
panel.open(title, filePath, content);  // load a new file
panel.getContent();                    // current editor content
panel.destroy();                       // tear down (rare; usually open() replaces)
```

Used at `public/app.js:31-55` for the two panel instances.

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
- **Every markdown→`innerHTML` sink in this app must be `DOMPurify.sanitize(marked.parse(...))`, never `marked.parse(...)` alone.** `marked` doesn't filter URL schemes, so markdown syntax (`[x](javascript:...)`, `![x](javascript:...)`) survives into the DOM even when literal HTML is escaped first. Three sinks share this rule: `viewer-panel.js:397`, `viewer-toolbar.js:47`, and `jsonl-viewer.js`'s `renderJsonlText()` (transcript rendering, `public/jsonl-viewer.js`). `renderJsonlText()` additionally guards for `window.DOMPurify` being absent (falls back to the plain-text `escapeHtml()` path rather than handing marked's raw HTML to `innerHTML`).

## Saving over a file that moved

**One rule, enforced by main: every save carries, as `expected`, the exact disk content the user agreed to replace, and main refuses anything else.** The renderer's job is to know what the user agreed to; main's compare is what keeps a write the user did not agree to from being replaced. No path in the viewer or the MCP diff tab sends a save without `expected`, and main refuses one that does.

### Main

`save-file-for-panel` and `save-memory` are `createPanelSaveHandlers` in `viewer-save-guard.js`, registered by `main.js` with its path policies injected (`isSensitivePath`, `resolveAllowedMemoryPath`, `invalidateFtsSignature`). `test/viewer-save-guard.test.js` lifts that policy object out of `main.js` and runs it against the real validator functions, so a policy swapped for a permissive stub fails there. Each handler validates the path — `save-memory`: a `.md` file, resolved through the memory allowlist, written at the resolved path; both: the file exists — then `writeIfUnmoved`, which runs `refuseIfMoved`:

- `expected` not a string → refused, `reason: 'invalid-expected'`. There is no blind write.
- The file on disk, line endings folded to `\n`, differs from `expected` → refused, `reason: 'stale'`, with **`disk`: the text it compared**, folded the same way.
- Otherwise the content is written and the FTS signature invalidated.

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

Main returns the disk text it compared. The panel shows the "not saved" notice, then asks `confirm('This file changed on disk since you opened it. Overwrite it with your edits?')` — worded like the diff tab's, because a refusal can be the first the user hears of the other write (nothing raised "changed on disk" before it):
- On yes, that text becomes `_agreedBase` and the save is retried with it. If the retry is refused too, the disk moved while the confirm was open: the panel asks again with the new text, and never writes without a compare.
- If the panel was switched to another file while the save or the confirm was pending (`_openGen`), nothing is retried and nothing is asked about the new file.
- On no, nothing is written and the notice says "This file changed on disk since you opened it — your edits were not saved", with **Reload** and **Overwrite**. **Overwrite** is a plain save that goes through the same check and confirm.

A plain save while the "changed on disk" notice is up is refused the same way, because the dirty re-read did not move the base, and asks the same confirm. **Keep my edits** is the agreement given ahead of time: the next save carries the disk the notice described and goes out without asking, and a further write nobody has read is still refused.

The MCP diff tab follows the same rule. Its base is the diff's `oldContent`, which `mcp-bridge.js` read from disk when the diff opened. It moves to what was written after each save, and to main's returned `disk` on a confirmed `confirm('This file changed on disk since the diff opened. Overwrite it with your edits?')`; a refused retry asks again. Any other refusal, or a rejected IPC, is reported with `window.alert`, the same channel `ViewerPanel`'s Delete uses; a declined confirm is the end of it.

### What the rest is for

Everything below is presentation; none of it carries the rule.

- **Re-reads.** Every `file-changed` event re-reads the file.

  | On disk | Result |
  |---|---|
  | the save in flight (`_pendingSave`) | our own echo: nothing |
  | equal to the buffer | base moves, notice cleared |
  | equal to `_agreedBase` | a "gone", "cannot be read" or "changed" notice is cleared (a `touch`, an undone write, an identical recreate) |
  | changed, buffer clean | reloaded quietly |
  | changed, buffer dirty | buffer untouched; "This file changed on disk since you opened it…" with **Reload** and **Keep my edits** — unless the notice already says a save was not saved, which it keeps with its **Overwrite** |
  | missing (`ENOENT`) | buffer untouched; "This file no longer exists on disk", and that the edits are kept when there are any |
  | unreadable | buffer untouched; the reason |

  **Reload** asks `window.confirm('This file has unsaved edits. Discard them?')` when the buffer is dirty, as the Changes panel does. `read-file-for-panel` returns the error's `code`, which is how the renderer tells `ENOENT` apart. A re-read that resolves after `open()` has moved to another file is dropped (`_openGen`).
- **Notice after a save.** A successful save clears the notice unless a re-read raised "changed on disk" while it was in flight (`_noticeSeq`); the base has moved to what was written, so the next save against that later write is refused and asks.
- **The queue.** One save is in flight at a time (`_pendingSave`). A save requested meanwhile is queued, and sent once the first returns ok, carrying the base that save left; if the session wrote in between, main refuses it and the panel asks. It is dropped if the first save fails. `open()` resets the pending save and the queue, so a save of the newly opened file goes out on its own, and the previous file's save touches neither when it resolves. The MCP diff tab queues a click during a save the same way (`tab.saving`), and drops it once the tab has lost its editor.
- **An answered diff.** Once a diff is answered (Accept or Reject, `tab.resolved`), the session writes the file itself and the base no longer describes the disk. Save is refused, and the shared diff Save button is disabled with a title saying why, until the session closes the tab. The button's state is set on each render of a diff tab, so a diff opened after an answered one has Save enabled again.
- **Other failures.** A save refused for any other reason, or whose IPC rejects, shows `Save failed: <reason>` in the notice.

## One viewer, several file tabs

`file-panel.js` has one `ViewerPanel` (`fpViewerPanel`) for the `'file'` tabs of every session, and `fpViewerOwner` records the tab it is showing. `showFileTabInViewer` is the only way a file tab reaches it:

- The owner being shown again is left as it is — not reopened — so a save in flight, the queue, the notice and the buffer are untouched by a re-render.
- Another file tab taking the viewer first stores the owner's `snapshot()` (buffer, `_agreedBase`, `_lastSeenDisk`) on that tab as `viewerState`.
- A tab with a `viewerState` for its path is reopened from it with `open(title, path, buffer, restore)`, then re-read at once, so a write made while it was away is treated like any other: a clean buffer reloads, a dirty one keeps its edits and says so. `tab.content`, the content first read when the tab opened, is used only for the tab's first showing.
- Destroying a file tab destroys the viewer only if that tab is its owner; a tab that never reached the viewer, or no longer holds it, has nothing in it to tear down.

A save of the previous owner still in flight when another tab takes the viewer resolves against a newer `_openGen` and is dropped from the panel's bookkeeping; its write has happened, so the snapshot's base is older than the disk and the next save of that tab is refused by main and asks, rather than written blind.

## Undo

Content the panel puts in the editor itself — the file `open()` shows, `_createEditor`'s initial fill, a quiet reload — goes through `_setDocument`, which marks the transaction `Transaction.addToHistory.of(false)` (`window.CMTransaction`, exported by `codemirror-setup.js`). Undo therefore steps only through the user's own edits: after a quiet reload, Ctrl+Z cannot bring back content the disk no longer holds, which the next save would otherwise write over the file. `test/viewer-panel-undo.test.js` drives this against the real CodeMirror.

## Watching the file

`watch-file` watches the **directory** holding the file and reports every event that names the file, whatever its type. A watch on the file itself is armed on its inode, and an atomic replace — `git checkout`, `sed -i`, most editors' save — writes a temporary file and renames it over the target, leaving the watch on an inode nothing writes to any more; a delete ends it outright, so the file's recreation is never seen. The directory entry outlives both, so a rename over the file, a delete, a recreate, and every write after them keep reaching the panel with nothing to re-arm.

- The path is resolved with `fs.realpathSync.native`, so the watched name carries the on-disk case and a symlinked file is watched in the directory of its target, where its writes happen. A path that does not resolve is watched as given.
- A symlink is **also** watched in its own directory, under the link's name. GNU `sed -i` without `--follow-symlinks` and rename-over editors replace the link itself with a regular file; the target's directory never hears that, the link's does.
- Events for other files in the directory are dropped by name — compared case-insensitively on `win32` and `darwin` (`sameFileName`), exactly elsewhere. An event with no filename is reported, since the renderer re-reads and compares anyway.
- Events are debounced (300 ms) into one `file-changed`.
- An `error` from the watcher (its directory removed) is swallowed; the watch is then dead, which is the one case not recovered.

The renderer records a watch (`_watchedPath`) only once `watch-file` answers `ok`, so a failed watch is never released by a later `unwatch-file` that would take another panel's reference. A watch acknowledged after the panel has moved to another file is released at once.

`createViewerWatchRegistry` holds one watch per resolved path and **counts references**: the Memory panel and a file tab showing the same file share it, and it is closed only by the last `unwatch-file`. `closeAll()` is what the window's `closed` handler calls (`closeAllFileWatchers`).

The Changes panel's registry (`git-changes-watch.js`) solves the same problem differently, by re-arming on the file after a `rename`. The two are not merged.

## Non-obvious behaviors

- **Markdown preview mode is persisted per-storageKey** in `localStorage`. Memory uses `'markdownPreviewMode'`; .work-files uses `'workFilesPreviewMode'`.
- **Line-wrap default depends on file type**: markdown wraps, code doesn't. Wrap state is NOT persisted — resets per file.
- **`format` for `.jsonl` is intentionally non-standard**: each line is pretty-printed and joined with `\n---\n`. This produces human-readable output but is no longer valid JSON. The button is for *viewing*, not for converting files to a different format.
- **Cmd/Ctrl+S keybinding**: CodeMirror dispatches a `cm-save` custom event which the ViewerPanel listens for. Chromium's "Save Page" default is blocked globally in `viewer-toolbar.js:256` (`keydown` listener with `preventDefault`).
- **The toolbar API exposes button refs directly** (`toolbar.saveBtn`, `toolbar.formatBtn`, …). The ViewerPanel reads `null` checks instead of asking the toolbar — slightly leaky encapsulation, but harmless.

## If you change this, also check

- `public/app.js` panel constructors (2 callsites) — adding a new opt may need wiring there
- `eslint.config.js` if you expose a new cross-file global (e.g. `flashButtonText`, `toggleMarkdownPreview` are already declared)
- `test/dom-work-files-view.test.js` — covers the panel render path for the .work-files tab
- `public/file-panel.js` — has its own `fpViewerPanel = new ViewerPanel(...)` for the file-diff side panel; might need same opt
- If you add a new file-type-aware button, mirror the `_isJsonish()` / `_isMarkdown()` pattern with an `_isXyz()` helper rather than inlining the extension check

## Changes mode (issue #251)

`public/file-panel.js`'s side panel gained a third tab type, `'changes'`,
alongside the pre-existing `'file'` and `'diff'` (MCP) types on the same
per-session `filePanelState`. Full design (why it skips `ViewerPanel`, the
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
lives on the tab instead of the component. One protection has no `ViewerPanel`
counterpart at all: an MCP-driven open replaces whatever tab is showing, so a
dirty Changes buffer is stashed on the session's panel state and restored when
the tab is reopened.

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
