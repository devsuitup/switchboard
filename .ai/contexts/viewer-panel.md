# Context: viewer-panel

**Purpose**: Reusable CodeMirror-based file viewer with a configurable toolbar. Used by **2 callsites** in `public/app.js`: `memoryPanel` (Memory tab), `workFilesPanel` (.work-files tab). Optionally read-only or savable. Watches the file on disk: reloads a clean buffer on an external change, and never replaces a dirty one without asking.

## Key files

| File | LOC | Role |
|---|---|---|
| `public/viewer-panel.js` | ~415 | The `ViewerPanel` class. Owns CodeMirror state, toolbar wiring, file watch lifecycle, save/format/delete logic. |
| `public/viewer-toolbar.js` | ~265 | Pure factory `createViewerToolbar(opts)` — builds the toolbar DOM + returns API. No state of its own. |
| `viewer-file-watch.js` | ~140 | Main-side `createViewerWatchRegistry` / `watchFileForViewer` behind the `watch-file` IPC — "Watching the file". |
| `viewer-save-guard.js` | ~25 | Main-side `refuseIfMoved` used by `save-memory` and `save-file-for-panel` — "Saving over a file that moved". |

## Public surface

```js
// Construction
const panel = new ViewerPanel(container, {
  copyPath: bool,         // show copy-path button
  copyContent: bool,      // show copy-content button
  language: 'markdown' | 'auto',  // editor mode
  storageKey: string,     // localStorage key for preview-mode persistence
  format: bool,           // show JSON/JSONL prettify button (auto-hidden for non-json files)
  onSave: async (filePath, content, expected) => result,  // shows Save button; see "Saving over a file that moved"
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

## A dirty buffer is never replaced

The panel keeps `_diskContent`: the file's content as last read from disk (set by `open()`, by a successful save, and by every re-read). The buffer is **dirty** when the editor's document differs from it. Both sides are compared with line endings folded to `\n` (`asEditorText`, mirrored main-side in `viewer-save-guard.js`), because CodeMirror splits on `\r\n` and `\r` and hands its document back joined with `\n` — without that, every CRLF file would count as dirty from the moment it opens.

Every `file-changed` event re-reads the file; none is dropped, including one that arrives during or just after a save. What happens depends on the answer:

| On disk | Buffer | Result |
|---|---|---|
| Same as the save in flight (`_pendingSave`) | any | Our own write's echo: the baseline moves, nothing else. |
| Same as `_diskContent` | any | Nothing (a `touch`, a same-content write). A stale "gone" or "cannot be read" notice is cleared. |
| Same as the buffer | any | Baseline moves; notice cleared. |
| Changed | clean | Buffer replaced quietly (and the preview re-rendered). |
| Changed | dirty | Buffer untouched. The notice says the file changed on disk and offers **Reload** and **Keep my edits** — unless it already says a save was refused as stale, which it keeps, with its **Overwrite**. |
| Missing (`ENOENT`) | any | Buffer untouched. The notice says the file no longer exists, and that the edits are kept when there are any. |
| Unreadable | any | Buffer untouched. The notice says the file can no longer be read, with the reason. |

This is the Changes panel's rule ("A dirty buffer is never overwritten, and never lied to", `.ai/contexts/changes-view.md`) applied to the viewer: the same notice line under the header, the same `changes-error` colour, the same wording where the situation is the same, and **Reload** asks the same `window.confirm('This file has unsaved edits. Discard them?')` before discarding anything. **Keep my edits** only hides the notice; the baseline has already moved to the new disk content, so the buffer stays dirty, the next external change raises the notice again, and a save writes the kept edits over the change the notice named.

`read-file-for-panel` returns the error's `code` beside its message, which is how the renderer tells a deleted file (`ENOENT`) from any other refusal.

A re-read or a save that resolves after `open()` has moved to another file is dropped (the `_openGen` token), so an answer for the previous file never lands in the current buffer.

## Saving over a file that moved

A save sends the disk baseline with the content: `onSave(filePath, content, expected)`, where `expected` is `_diskContent`. Both handlers behind it, `save-memory` and `save-file-for-panel`, call `refuseIfMoved` (`viewer-save-guard.js`) right before writing: when the file on disk, with its line endings folded, is no longer `expected`, the write is refused with `reason: 'stale'`. This covers every write the panel has not re-read yet — one that landed between the last `file-changed` and the click, or while the debounce was still pending.

This is the Changes panel's version token (`git-changes-file.js`) with the baseline text as the token. The viewer's callers open it with content they read themselves (`readMemory`, `readFileForPanel`) and no token beside it; comparing against the text the panel actually holds as its baseline needs no second read that could race the first.

On a stale refusal the buffer is kept and the notice says "This file changed on disk since you opened it — your edits were not saved", with **Reload** (the same confirm as above) and **Overwrite**, which asks `window.confirm('Overwrite the file on disk with your edits?')` and saves with `expected: null` — the one save that skips the check. Any other refusal shows `Save failed: <reason>`. One save is in flight at a time (`_pendingSave`); a second request while it is pending is ignored.

The MCP diff tab's save in `file-panel.js` (`handleDiffSave`) sends no baseline and is not checked.

## Watching the file

`watch-file` watches the **directory** holding the file and reports every event that names the file, whatever its type. A watch on the file itself is armed on its inode, and an atomic replace — `git checkout`, `sed -i`, most editors' save — writes a temporary file and renames it over the target, leaving the watch on an inode nothing writes to any more; a delete ends it outright, so the file's recreation is never seen. The directory entry outlives both, so a rename over the file, a delete, a recreate, and every write after them keep reaching the panel with nothing to re-arm.

- The path is resolved with `fs.realpathSync.native`, so the watched name carries the on-disk case and a symlinked file is watched in the directory of its target, where its writes happen. A path that does not resolve is watched as given.
- A symlink is **also** watched in its own directory, under the link's name. GNU `sed -i` without `--follow-symlinks` and rename-over editors replace the link itself with a regular file; the target's directory never hears that, the link's does.
- Events for other files in the directory are dropped by name — compared case-insensitively on `win32` and `darwin` (`sameFileName`), exactly elsewhere. An event with no filename is reported, since the renderer re-reads and compares anyway.
- Events are debounced (300 ms) into one `file-changed`.
- An `error` from the watcher (its directory removed) is swallowed; the watch is then dead, which is the one case not recovered.

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
