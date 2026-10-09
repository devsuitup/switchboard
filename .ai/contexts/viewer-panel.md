# Context: viewer-panel

**Purpose**: Reusable CodeMirror-based file viewer with a configurable toolbar. Used by **3 callsites**: `memoryPanel` (Memory tab) and `workFilesPanel` (.work-files tab) in `public/app.js`, and the Activity trace viewer in `public/activity-trace-panel.js`. The file panel does not use it: a file opened there goes to the Touched editor (`.ai/contexts/touched-files.md`). Optionally read-only or savable. Watches the file on disk: reloads a clean buffer on an external change, and never replaces a dirty one without asking.

## Key files

| File | LOC | Role |
|---|---|---|
| `public/viewer-panel.js` | ~415 | The `ViewerPanel` class. Owns CodeMirror state, toolbar wiring, file watch lifecycle, save/format/delete logic. |
| `public/viewer-toolbar.js` | ~265 | Pure factory `createViewerToolbar(opts)` — builds the toolbar DOM + returns API. No state of its own. |
| `viewer-file-watch.js` | ~140 | Main-side `createViewerWatchRegistry` / `watchFileForViewer` behind the `watch-file` IPC — "Watching the file". |
| `viewer-save-guard.js` | ~100 | Main-side `createMainPanelSaves` (the handlers `main.js` registers for `save-memory` and `save-file-for-panel`, with the path checks from `ipc-path-validator.js`), the `createPanelSaveHandlers` it builds on, and `refuseIfMoved` — "Saving over a file that moved". |

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
- **Every markdown→`innerHTML` sink in this app must be `DOMPurify.sanitize(marked.parse(...))`, never `marked.parse(...)` alone.** `marked` doesn't filter URL schemes, so markdown syntax (`[x](javascript:...)`, `![x](javascript:...)`) survives into the DOM even when literal HTML is escaped first. Four sinks share this rule: `ViewerPanel._replaceContent` in `viewer-panel.js`, `toggleMarkdownPreview` and `renderMarkdownPreview` in `viewer-toolbar.js` (the second renders the Touched editor's formatted view, `.ai/contexts/touched-files.md`), and `jsonl-viewer.js`'s `renderJsonlText()` (transcript rendering, `public/jsonl-viewer.js`). `grep -n "marked.parse" public/*.js | grep -v "DOMPurify.sanitize(window.marked.parse"` prints only `jsonl-viewer.js`'s `marked.parse(escaped)`, sanitised two lines below. `renderJsonlText()` additionally guards for `window.DOMPurify` being absent (falls back to the plain-text `escapeHtml()` path rather than handing marked's raw HTML to `innerHTML`).

## Saving over a file that moved

**One rule, enforced by main: every save carries, as `expected`, the exact disk content the user agreed to replace, and main refuses anything else.** The renderer's job is to know what the user agreed to; main's compare is what keeps a write the user did not agree to from being replaced. No path in the viewer or the MCP diff tab sends a save without `expected`, and main refuses one that does.

### Main

`save-file-for-panel` and `save-memory` are the handlers `createMainPanelSaves` builds in `viewer-save-guard.js`. It takes the path checks (`isSensitivePath`, the memory allowlist) from `ipc-path-validator.js` itself; `main.js` hands it only its own state, `getKnownProjectPaths` and `invalidateFtsSignature`. `test/viewer-save-guard.test.js` builds the same handlers with `createMainPanelSaves`, so what it exercises is what main registers, and no binding in `main.js` can make the save path permissive. Each handler validates the path — `save-memory`: a `.md` file, resolved through the memory allowlist, written at the resolved path; both: the file exists — then `writeIfUnmoved`, which runs `refuseIfMoved`:

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

  **Reload** asks `window.confirm('This file has unsaved edits. Discard them?')` when the buffer is dirty, as the Changes panel does. `read-file-for-panel` returns the error's `code`, which is how the renderer tells `ENOENT` apart. A re-read that resolves after `open()` has moved to another file is dropped (`_openGen`).
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
| a clicked file (`'link'`) | `confirm('This file has unsaved edits. Discard them?')`; a no keeps the editor and reads nothing | replaced |
| `openFile` (`'mcp'`) | not replaced; the file is read and listed as opened | replaced, no question |
| either, the file already in the editor | kept as it is, not re-read; a line is revealed | the same |
| `openDiff` | the editor is stashed and comes back when the session closes the diff | replaced; closing the diff closes the panel |
| the panel's close button (the user's own click) | the same confirm; a no keeps the editor | closed |

An open only ever touches the slot of the session it is aimed at (for a panel shell, the session that owns it).

### An open that arrives over a diff

An unanswered diff (`type 'diff'`, not `resolved`) is never replaced by an open: the CLI is waiting on its answer. The open is stored in `state.pendingTouchedOpen` (`{filePath, line, origin}`; a later one replaces it) and replayed when the diff ends:

- the session closes it (`closeDiffByDiffId`, `closeAllDiffs`);
- the user answers it with Accept or Reject while an open waits: the diff tab ends there;
- the panel's close button on the diff, which answers reject.

Each of these reads and clears `pendingTouchedOpen` before `destroyCurrentTab`, then calls `endCurrentTab(sessionId, state, {pending, restoreStash})` (`endDiffTab` for the first two, with `restoreStash: true`; the close button passes `{pending}` only). `endCurrentTab` hides the panel, then replays the pending open, or, with `restoreStash`, opens Touched on the newest stash; otherwise the panel stays hidden. A replay runs as origin `'mcp'`, so it never asks; the stored origin only decides whether the remote check runs. Changes and Touched, by click or shortcut, park an unanswered diff in `state.parkedDiff` and detach its merge editor without destroying it. The deferred open survives parking. The conditional Diff icon returns the same tab and editor, and the open replays when that returned diff ends. Closing a parked diff through the CLI clears it and its deferred open without disturbing the shown tool. A second `openDiff` remains outside this rule and retains the existing replacement behavior. See [tool-bar.md](tool-bar.md). With no open waiting, Accept and Reject keep the answered diff in the slot until the session closes it; the session's close of a diff that has already ended is a no-op.

### Unsaved edits on quit, reload and close

Nothing ends the window with unsaved file-panel edits without the user saying so. The scope is the Touched editor in the slot (a tab with an `absolutePath`) and every `touchedStashes` entry, in every session of `filePanelState`; the Memory and Work Files panels, MCP diff tabs and Changes buffers are not covered.

- **Main** (`unsaved-guard.js`, one guard, `attach(win)` per window, `beforeQuit(event, win)` for the app). `main.js`'s `before-quit` handler calls `beforeQuit` first: it prevents the quit, asks the renderer, and calls `app.quit()` again on a yes, so the cleanup that follows (PTYs killed, MCP servers, watchers) runs only once the quit is confirmed and a Cancel leaves the app intact. This covers every `app.quit()` caller (☰ Quit, the last window closing). `updater-install` asks first (`confirmQuit`), because electron-updater's `quitAndInstall()` starts the installer before it calls `app.quit()`: a Cancel must leave the installer unstarted, and a yes pre-approves the quit that follows. A Windows `query-session-end` or `session-end` approves the quit, so logoff and shutdown never wait on the dialog. A window close, a quit and an install share one question while it is open. The window's own `close` event is held the same way for a plain window close. The question is `unsaved-check` (`id`, `'quit'` or `'reload'`); the renderer's `unsaved-check-result` (`id`, `proceed`) approves it. A `will-prevent-unload` (the renderer's `beforeunload` veto, which a reload hits) asks with `'reload'`; on a yes the next unload is allowed once (`allowNextUnload`, answered with `preventDefault()`, which in Electron means "unload anyway") and `webContents.reload()` is called. Every close asks the renderer, even with nothing dirty; a main-side dirty flag would save that round trip and is not built.
- **Bounded.** The renderer acknowledges (`unsaved-check-ack`) as soon as it receives the check, before any dialog. The 2.5 s bound (`DEFAULT_TIMEOUT_MS`) covers only send to ack: no ack answers yes, so a hung renderer never keeps the app from quitting. After the ack the guard waits for the answer without a limit, so a slow user or a slow save loses nothing, and answers yes only if the renderer process is gone (`render-process-gone`, `destroyed`) or a send fails. A late answer is ignored.
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
- **Cmd/Ctrl+S keybinding**: CodeMirror dispatches a `cm-save` custom event which the ViewerPanel listens for. Chromium's "Save Page" default is blocked globally in `viewer-toolbar.js:256` (`keydown` listener with `preventDefault`).
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
