# Context: touched-files

**Purpose**: a per-session list of the files the session's *file tools* touched,
in the right-hand file panel, for local and remote sessions. It answers "who touched what"
where Changes cannot: outside any repository, in a directory with no git, when
sessions share a tree, and after a change was committed or reverted. Issue #309.
User-facing behavior: `docs/touched-files.md`. IPC and its guard row:
`.ai/contexts/ipc-bridge.md` ("Touched files").

## Key files

| File | Role |
|---|---|
| `session-touched-files.js` | Main-side module, no electron: `extractTouches(line)`, `resolveTouchedPath(raw, {cwd})`, `collectSessionTouchedFiles(opts)` (the walk, with every dependency injected) and `listSessionTouchedFiles(sessionId, deps)` (the IPC's target resolution). |
| `public/touched-files-view.js` | Renderer: the `'touched'` tab type, its container, rows (touched and opened), toggle and refresh, and `openTouchedPath`, the route every clicked file takes into the panel. Loaded after `file-panel.js`, which reaches it behind `typeof` (`initTouchedView`, `renderTouchedTab`, `hideTouchedView`, `openTouchedPath`). |
| `read-session-file.js` | `enumerateSessionFiles(folderPath)` lists the parent and subagent transcripts (both layouts); the module keeps the entries that belong to the session. |

## What "touched" means, and what it does not

A row exists when a transcript holds an assistant `tool_use` block named `Edit`,
`Write`, `MultiEdit` or `NotebookEdit` whose input has a non-empty string
`file_path` (`notebook_path` for `NotebookEdit`). Nothing else counts. This is a
**lower bound**: measured on one project, 522 of 2829 tool calls carried a path,
2182 were `Bash`, and in one session 385 `Bash` calls against 27 file-tool calls
made nearly every changed file invisible here. Parsing shell commands was
considered and rejected (redirections, pipes, `find -exec`, computed names: any
coverage figure would be a guess).

The info button next to the Touched files title opens `TOUCHED_COVERAGE_TEXT`
in `#touched-coverage` inside a modal, including while loading, on failure and
on an empty list. It uses the shared modal styles and existing dialog pattern;
Escape, the close button and an outside click dismiss it and restore focus to
the info button. A capturing Escape handler prevents list/editor navigation.
Tab stays on the modal close button. `test/dom-file-panel-touched.test.js` pins it. The empty state reads "No files touched by the file tools", never
"nothing changed". Changes stays the authority on the working tree.

The transcript records intent, not outcome: a refused `Write` is listed. Each
row is checked against the disk when the list is built (`state`): `present`,
`gone` (`ENOENT`/`ENOTDIR`), `not-file`, `unreadable` (any other error, or no
answer in 3 s), or `refused` (see below). The list is not live: it is built on open and on the refresh button, not on
every busy-to-idle edge. A build stats up to 500 paths; transcript reads use
the incremental, time-window cache described below.

## Trust: the paths are attacker-influenced

A sandboxed session writes its own transcripts, so every path here is data an
attacker may have chosen. Listing one is harmless; the guards are about what the
listing *does* with it.

- **`resolveTouchedPath`** accepts an absolute path, normalised, and refuses
  (the row goes to `unresolved`, with no `path` field at all): control
  characters, which means C0, DEL, C1, U+2028/2029 and every `\p{Cf}` (bidi
  overrides and isolates, LRM/RLM/ALM, zero-width, tag characters; one of them
  makes `report<U+202E>txt.exe` display reversed while opening the real file),
  over 4096 characters, a leading `~`, on Windows any leading
  double separator (UNC, `\\?\`, `\\.\`: a `stat` on a UNC path reaches the
  network), a rooted path with no drive and a drive-relative one.
- **A relative path** resolves only against a cwd passed through
  `verifiedTranscriptCwd` (`encode-project-path.js`, #419): the transcript's own
  `cwd` must encode back to the folder it sits in. The parent and each subagent
  are verified on their own transcript, so a subagent in a worktree (whose cwd
  encodes to another folder) leaves its relative paths `unresolved` with reason
  `relative-no-cwd`. The cwd of the Changes target is not used.
- **Before any `stat`**, every resolved path goes through `isSensitivePathAsync`
  (credential-directory denylist, 8.3 and `\\?\` handling, fail closed). A hit,
  or a check that throws, gives `state: 'refused'` and the path is never
  stat-ed. The row stays in the list so the user sees the session reached for
  it.
- **Listing is not opening.** Only a row with `openable === true` and
  `state === 'present'` has a click handler. It calls `readFileForPanel`
  with `{editor: true}`; the main handler retains its sensitive-path,
  regular-file, size and binary guards. An unsuccessful read leaves the list
  visible with the refusal. Gone, unreadable, refused and non-file rows keep
  their existing state and cannot be opened. The absolute path is one main
  returned in the list. An opened row (below) is a second kind of row: its
  click calls the same function, through the same guards.
- **The folder** comes from `getCachedFolder` and must be a plain name (no
  separator, not `.` or `..`) before it is joined to the projects directory; a
  `sub:` session id is refused. A remote folder key is split into its validated
  host alias and plain folder name before joining the mirror directory.
- **Rendering** is `textContent` throughout, an unresolved path shows its unsafe code points as visible escapes (`\u202E`, `\u{E0041}`), `.touched-file-path` is `unicode-bidi: isolate`; sources (subagent type from the
  `.meta.json` sidecar) are stripped of control characters and cut to 80.

## Bounds

- 500 distinct resolved rows and 500 unresolved; the overflow is a counter
  (`omitted`; duplicates of an overflowing path count again), not a kept set.
- A prefilter (`tool_use` plus a quoted tool name) keeps `JSON.parse` off every
  other line. A line that passes it is skipped past 4 MiB: a tool call carries
  at most a model output, a few hundred KB, so a larger one is not a tool call
  worth parsing. A line over 32 MiB without a newline is skipped as well. Both
  are counted in `coverage.skippedLines` and the summary says so.
- 256 MiB of transcript in total across the session's files, then
  `coverage.truncated`.
- **The disk check is bounded as a whole.** The sensitivity guard
  (`isSensitivePathAsync`: realpath and lstat) and the `stat` run under one
  3 s timeout per path, with 8 paths in flight. A timeout makes the row
  `unreadable`. A timed-out call still holds a libuv thread, so after 8
  timed-out checks no new call is issued and the remaining rows are
  `unreadable` without being checked: 500 planted paths on an offline mapped
  drive hold at most about 16 threads, not 500.

## Incremental time-window cache (#444)

The main-side singleton `mainTouchedCache` uses `touched-transcript-cache.js`.
Its LRU holds at most `TOUCHED_CACHE_SESSIONS` (32) sessions keyed by folder
and session ID. Each has at most 1024 transcript records, 1000 path/tool
summaries per transcript and 4000 summaries in total. Cached raw paths are
bounded to 4097 characters, preserving the invalid-path guard. Requests are
serialized so an append or extension cannot be counted twice by concurrent
opens. Local disk guards and stats still run on every request; cached transcript
content never caches permission to open a file.

A transcript record is keyed by path, size and mtime. It holds its verified
cwd, per-path/tool counts and latest timestamps, the beginning of the scanned
range and the last complete newline at its end. Unchanged files incur no
transcript read or parse. Growth validates a bounded prefix and an anchor
before the old complete end, then parses only the added complete lines. At the
per-transcript ceiling, a newer touch evicts the oldest retained summary;
older incoming touches are counted as omitted. This keeps an append and a
fresh backward scan equivalent beyond the ceiling.
Shrinking, same-size mtime changes, or a changed prefix/anchor discard the
record and rebuild the requested window. Enumeration drops deleted transcript
records, and the delete-session handler calls `dropSession`. A failed or
budget-exhausted read is discarded so a later request can retry.

The initial window is `TOUCHED_WINDOW_DAYS` (1), extended in
`TOUCHED_WINDOW_STEP_DAYS` (10) steps. Each transcript is scanned from its end
in 64 KiB chunks, on byte newline boundaries before UTF-8 decoding. An
final unterminated line is included when it is complete valid JSON. Its
touches are combined with a copy of the complete-line summaries, while the
cached end remains at the last newline. A later append therefore rereads the
tail without duplicating its counts; invalid partial JSON is ignored.
Scanning stops before
the first entry whose top-level timestamp precedes the window; that offset is
retained for the next extension. A never-loaded transcript whose mtime is
older than the window is skipped entirely. Timestamp-less entries have
unknown time and are retained within the range actually scanned. The backward
stop assumes top-level timestamps are in chronological order within each
transcript. With out-of-order timestamps, a recent entry before the first old
entry can be missed until the window is extended; the scan deliberately does
not search beyond that boundary. Each backward line is parsed once and its
object is shared by timestamp extraction and touch extraction.
The bounded cwd header lookup runs once on a new or invalidated
record, only after the mtime skip.

The response carries visible `files`, guarded `cachedFiles`, the requested
and loaded window starts, `hasOlder` for unread history and `olderFiles`.
`nextOlderTimestamp` is the newest skipped transcript mtime or older scan
boundary timestamp. When a ten-day extension would cover no known activity,
the renderer jumps directly to that timestamp (or the newest cached older
touch), rounding the age up to whole days. Exhausting the older history
removes the button.
The renderer extends locally with no IPC or parse when its cached range
covers the new window. An uncached extension needs an incremental IPC and
parse: prohibiting both would require reading all history on initial open,
contradicting the backward-window requirement. The exact hidden-file count
is available for cached history. While history is unread, the list says
“Older files not counted yet”; an exact distinct-file count cannot be derived
from unread bytes. No transcript-size estimate is presented as a count.

Every row shows its latest touch across parent and subagent transcripts.
`TOUCHED_RELATIVE_THRESHOLD_MS` is one day: younger entries show minutes or
hours ago; older ones use `toLocaleString` in local time. The formatter accepts
an injected clock. Present-file tooltips also show `diskMtime`; the existing
gone/unreadable/refused states and opening guards still apply.

The editor close button and Escape inside the editor restore the full-height
list without requesting transcripts again. The list stays visible above the
editor; row switching replaces the editor after the existing dirty prompt.
Selection, scroll, sort and time window survive closing, tab switches and
session switches. Scroll is saved before a session hides the shared list.
Escape bubbles after the editor's handlers and ignores prevented or composing
events, search/panel/tooltip targets, and inputs outside editor content.
Pending refresh results are stored on their original tab even while a file or
another session is visible, and are rendered when the tab returns, without
another IPC. List snapshots also survive another session using the shared
DOM. The panel shell remains outside this navigation.

`test/session-touched-cache.test.js` uses real disposable transcripts, read
counters, partial UTF-8 appends, rewrites, deletion, LRU and repeated window
extensions. Its large fixture is about 26.6 MB; the one-day read counter
includes chunk reads and validation probes. The measured full-read comparison
is recorded in the test diagnostic and `.work-files/pr-body.md`.

## Decisions that were open in the issue

- **Placement**: its own tab and tool-bar toggle (`Touched`, after the conditional `Diff`),
  not a section of the Changes list; the issue puts changing the Changes panel
  out of scope.
- **Remote sessions**: the list reads the local mirror with the same parser,
  cache, window and ordering. Disk inspection and opening use the remote
  transport, described below. Terminal links remain unavailable remotely
  (see "One route into Touched").
- **Ordering**: latest file-tool timestamp first, with a path tie-breaker;
  the toolbar can sort by path instead. Unknown timestamps are displayed
  explicitly and sort after dated entries.
- **Open**: a present row opens the shared Changes editor described below, and
  so does every file clicked anywhere else (see "One route into Touched").

## Not covered

- Files touched through `Bash`, MCP tools or any tool other than the four.
- Attribution between sessions sharing a directory, beyond the `sources` labels.
- A tool result that says the call failed (`is_error`) is not read.

## Remote sessions (#454)

`listSessionTouchedFiles` reads `<dataDir>/remote/<alias>/projects/<folder>`.
It uses the same incremental cache and transcript enumeration as local lists,
including subagents, and POSIX path rules even on a Windows client. Remote
paths must already be absolute, have no control characters and contain no
`..` segment; this is checked before normalization. Relative paths stay
unresolved even when the transcript records a cwd. Local filesystem guards
and stats never inspect a remote path.

`remote-touched-files.js` sends at most one batch per refresh for up to 500
accepted paths, through Changes' `defaultRunRemoteCommand`. Paths travel as
newline-delimited stdin (`input`), read with `IFS= read -r`; the quoted command
contains only the fixed script, so a long list cannot exceed the client's
command-line limit. Control characters, including newlines, are refused first.
The renderer requests `diskInfo: false` to display mirror rows immediately,
then requests their disk info. Remote inspection runs after the serialized
transcript-cache queue is released. Concurrent requests for the same session
and path set share one in-flight batch; completed batches are not cached.
Refresh and older-history requests made while either phase is pending queue
one follow-up refresh, using the latest requested window. Each mirror/disk pair
uses one window snapshot;
an older answer cannot reset a window expanded during inspection. The queued
refresh runs only if its list is still the session's current tab or return list.
Remote rows with unknown state show `checking` while `diskInfoPending` is set,
then their final state, including `unknown` after an unreachable host.
The batch uses a POSIX shell and GNU coreutils (`realpath`, `stat`, `tr`);
mtime is returned as epoch seconds and converted to milliseconds. Its stdout
is capped at 64 KiB and its timeout is 20 seconds. Results are positional,
so filenames cannot inject output records. Literal credential and .git paths
are refused before transport; canonical paths are checked on the host before
stat or read, and both operations use that resolved path. The remote denylist
also refuses `/etc/shadow`, `/etc/gshadow`, `/etc/ssh/ssh_host_*`, `*.pem`,
`*.key` and SSH key basenames `id_(rsa|dsa|ecdsa|ed25519)([._-].*)?`,
both literally and after host resolution. JS and shell derive those basenames
from the same list. Ordinary source names such as `id_generator.py` and files
inside an `id_utils` directory are allowed.
There is an accepted residual check-then-read race: a process with write access
as the same remote user can replace a directory with a symlink between
`realpath -e`, the canonical-path guard and `head`. Reading the resolved path
prevents changes to the original spelling from redirecting the read, but does
not bind the checked directory components to the later file open. This route
does not provide an atomic open of the checked inode; its protection assumes
those components are not being concurrently replaced by that user.
Missing and unreadable rows stay distinct. Unsupported GNU stat/realpath flags
leave every row unknown rather than claiming a file is unreadable. Transport failures,
timeouts and malformed or oversized answers leave the mirrored rows `unknown`,
with no mtime and no click handler. No batch retries or background polling run;
empty or entirely refused lists make no remote call.

Opening a remote row carries its session ID on `readFileForPanel`. Main
resolves it through `resolveGitChangesTarget`; an unknown target fails without
falling back to local IO. The read checks the canonical credential/metadata
guard, regular-file-ness and readability on the host, then reads at most
`REMOTE_TOUCHED_READ_MAX_BYTES + 1`. The named cap is 2 MiB: oversize files are
refused, rather than presenting an incomplete file as complete. The transport's
`rawStdout` option preserves bytes across UTF-8 chunk boundaries; working text
and HEAD both use the existing strict UTF-8 decoder and binary refusal.
The transport exposes stdout overflow explicitly; an oversized HEAD blob is
reported as too large, preserving the byte cap without blaming the connection.

The session's repository root comes from a quoted, literal-pathspec Git probe.
A file under that root gets its HEAD pair in the shared Changes editor;
an untracked file has an empty original side. A file outside that root, or
with a Git probe or HEAD read that fails outside the transport, opens as plain content.
All remote files are read-only, as in remote Changes; files outside a
repository have no remote edit route. A removed session cwd, absent Git or
dubious ownership does not discard a successful read. Probe code -1, SSH code
255 and timeouts still report the connection failure. The inline and side-by-side CodeMirror factories
accept `readOnly` so the HEAD diff remains visible without enabling edits.
Reload retains the remote target; local watchers are not armed and no remote
watcher is added. Missing or unreadable opens keep their refusal message.
Main rejects saves addressed to remote sessions regardless of renderer edit
flags. The guard is based on the resolved session target and keeps no set of
remote path strings. Saves without a remote session ID use the existing local
guards, so opening a remote file does not disable a local save with the same
path spelling.

Tests use disposable mirrors, injected transports, shipped IPC handlers and
the real CodeMirror factories. A local fake host executes the exact shell
scripts against disposable files, including hostile filenames and a credential
symlink. No real host, SSH client or Electron process is launched.

## If you change this, also check

- `test/session-touched-files.test.js` (extraction, resolution, walk, target resolution), `test/dom-file-panel-touched.test.js` (the route, opened rows and stashes included), `test/touched-files-wiring.test.js`, `test/dom-file-panel-goto-line.test.js`, `test/dom-file-panel-unsaved-guard.test.js`
- `public/header-controls.js` (`HEADER_TOGGLE_ICONS`, the icon) and `test/header-controls.test.js`
- the guard row in `.ai/contexts/ipc-bridge.md`

## Shared editor (#450)

`openTouchedEditor` in `public/file-panel.js` creates the same Changes tab
state and uses `renderChangesDiff`, `ensureChangesEditor`, the existing
`#changes-diff-view` toolbar and `#changes-diff-host`. It retains the Touched
list as `returnList` and mounts the shared splitter and editor beneath the
visible Touched list. The panel header remains Touched files, and Touched has
no Back control. Changes retains its existing Back behavior. Escape and the
editor close button close the file through the shared discard guard, without
fetching transcripts, status or file content again. Row switching uses that
guard before reading and checks for edits made during the pending read.
Selection, sort, window and DOM identity survive.

`renderPanelListLayout`, `currentPanelListLayout`, `applyChangesListHeight` and
the single `createSplitter` binding serve both lists. Changes keeps its stored
pixel height; Touched stores `touchedListRatio` with a named default of 0.4,
guarded localStorage access and the same minimum list/editor heights. The
resize observer reapplies the ratio on panel resizing. The editor takes the
remaining height, and closing it restores the list flex sizing. Sorting,
refresh and older-window controls remain usable while the editor is open.

`read-file-for-panel` with `{editor: true}` discovers the repository from the
file's own directory, including a file outside the session's repository.
`readTouchedChangesFile` in `git-changes-file.js` reuses `readChangesFile` with
`staged: true`, so the original is HEAD even when the index differs. An
untracked file has an empty original. Repository files keep the existing
containment and link checks. Only the Touched repository check resolves both
the file and repository root with fs.realpathSync.native before computing the
relative Git path, expanding 8.3 names and preserving HEAD content through
directory junctions and system temporary-directory aliases. Its containment
check ignores case on Windows and refuses sibling prefixes. The native paths
are comparison inputs only: repository discovery and shared read/write guards
retain the shared resolver's spelling. The shared path resolver and its other
callers keep their existing behavior. A missing repository file is refused
before deriving a Git operand, so mismatched temporary-directory spellings
cannot turn that refusal into plain editing. Changes fixtures canonicalize
temporary roots; Touched fixtures retain their spelling so aliases remain
exercised. The Windows short-path regression
derives the directory spelling, including existing parent aliases, and compares
it to the native long spelling before deciding whether to skip. Injected Windows
file/root resolution tests cover the mismatch on every platform.
A literal or natively resolved path containing a .git segment is refused before
probing, including ordinary read and plain-save IPCs. Both local IPC checks use
fs.realpathSync.native so Windows 8.3 metadata aliases are refused too.
Exit 128 permits a non-repository
fallback only when stderr says "not a git repository"; other Git probe errors
remain errors. A missing or timed-out Git process during discovery, repository reread or
blob read, or a diff read refused for
its filename or mixed line endings, uses the guarded file content
as both sides of the pair, with line endings folded. Binary files are refused
for both ordinary viewer and editor requests; a binary HEAD blob also remains
a refusal. Invalid UTF-8 is refused instead of decoded lossily, including in
non-repository files and HEAD blobs; it never enables an editable fallback.
Panel reads and every panel save use the existing strict UTF-8 decoder, so a
refused open followed by a save attempt preserves the original bytes.
The display size cap and unreadable/non-file refusals still apply.
A final file symlink opens plain content read-only in the shared host through
createReadOnlyViewer, with no Save control. Every panel save refuses that link,
including plain saves, and the repository helper refuses writes independently.
Sensitive-path, metadata, size and binary checks still apply before opening it.

A pair with identical sides, or `git: false`, uses `createEditableViewer`
inside that same host with no diff gutter; the mode toggle is hidden without
changing the stored Changes diff preference. Modified and untracked files use
that preference and the same merge factories as Changes.

`save-file-for-panel` accepts an optional `{git, version}` argument. A Git
file uses `writeTouchedChangesFile`, which rediscovers its repository and
reuses `writeChangesFile` and its byte-version check. Other files retain the
existing expected-content save guard. Saving after deletion returns
"File does not exist" without recreating the file. Refresh, Save and Reload reread this
absolute file, without fetching either list. Watching uses the existing
absolute-path `watch-file` registry and `file-changed` event; closing the
editor releases that watch. Dirty buffers and their return list survive
another tab taking the slot through the Touched stashes (see "Stashed edits").
Changes has its own single stash; each list restores only its own edits, and
restored Save controls are
updated after the editor mounts. The Changes tool-bar toggle is active only
for a Changes list/editor without a return list, and opens Changes when a
Touched editor is visible. The Touched tool-bar button is pressed for its list or an
editor carrying its returnList. Clicking it closes that tab through the Changes
discard confirmation instead of stashing and immediately reopening the editor.
Switching to the other list continues to stash unsaved edits. Session idle
refreshes only Changes; Touched uses
its watcher and explicit Reload/Save to reread content. Active Touched editors
retain the existing unsaved-file close prompt.

Tests load shipped renderer files in jsdom. `test/touched-editor-ipc.test.js`
evaluates the shipped IPC handlers over disposable files and a fixture Git
repository. The Touched journey in `e2e/changes.spec.js` checks the actual
merge editor, width and close navigation with a visible list; it requires a
separate live run.

## One route into Touched (#472)

Every file opened by a click outside the Touched list goes through
`openTouchedPath(sessionId, filePath, {line, origin})`: a terminal path link and
a `file://` link (`openFileInPanel`, see `.ai/contexts/terminal-path-links.md`),
the terminal menu's "Open in panel", and the CLI's IDE-emulation `openFile`
(`mcp-open-file`). There is no other file tab: the panel's tab types are
`changes`, `touched` and `diff`.

- **Origin.** `'link'` for the three terminal routes, `'mcp'` for `openFile`,
  `'row'` for a click on a row of the list. A link and a row are the user's
  click and may ask "This file has unsaved edits. Discard them?"; an `'mcp'`
  open never asks (`.ai/contexts/viewer-panel.md`, "Nothing a session
  triggers shows a modal").
- **Owner.** A link clicked in a panel shell opens in the panel of the session
  that owns the shell (`panelTerminalOwnerOf`), the session whose transcripts
  Touched reads.
- **Remote.** For `'link'`, the first step is `resolveTerminalPaths(sessionId,
  [filePath])`; an answer with `reason: 'remote'` ends the open with no read and
  no panel change. Any other answer, refused or not, continues, and the guarded
  read decides. Remoteness is decided main-side from the session's folder:
  `resolveGitChangesTarget` answers `kind: 'remote'` on a remote folder whose
  descriptor has no cwd and on any live session whose `kind` is set and is not
  `'local-pty'` (an attached remote session whose folder is not cached), and
  on the id of a remote-attach terminal that exited, which main keeps in
  `exitedRemoteSessionIds` until the renderer closes that terminal; and
  `resolveTerminalPathsCwd` tests `kind === 'remote'` before `ok`. The sidebar
  DOM is never consulted. `'mcp'` skips the check: remote sessions never get
  the bridge.
- **An unanswered MCP diff in the slot** keeps the slot: the open is stored in
  `tab.pendingTouchedOpen` on that diff (a later one replaces it) and replayed
  only when its own tab ends in the slot; another diff ending cannot consume
  it (see `.ai/contexts/viewer-panel.md`, "An open that arrives over a
  diff").
- **Touched not in the slot**: a fresh Touched list is opened
  (`openTouchedTab(id, {restoreStash: false})`), whatever the slot held; a dirty
  Changes buffer goes to `changesStash` as on any takeover. The Touched
  stashes stay where they are.
- **The file**: `openTouchedFile`. The same file already in the editor (compared
  with `filePathKey`) is not read again; a `line` sets `pendingLine` and
  switches a formatted markdown view to the source. A file with a stash entry
  is restored from it (below). Otherwise the read is `readFileForPanel(path,
  {editor: true})` for every origin, and a `line` opens the source at that line
  (`openTouchedEditor(..., {line})`).
- **`'mcp'` over a dirty editor**: the file is read and listed as opened, and
  the editor in the slot is left as it is; with a stash entry for the file, it
  is listed without a read and both buffers stay as they are.
- **A refused read** shows "Could not open the file: <reason>" for a link or an
  `openFile`, without the path, which did not pass `resolveTouchedPath` and may
  hold format characters. A row click keeps `<path>: <reason>`.
- **A git-changed file** opens here too, with its diff against HEAD
  (`readTouchedChangesFile`). The Changes list is not opened by a click; its
  tool-bar toggle is the way to it.
- **What the editor read refuses that a link check does not**: a path git
  refuses to open (exit 128 not saying "not a git repository"), and the
  Touched path rules of `resolveTouchedPath`. A symbolic link opens read-only.
- **`mcp-bridge.js`** sends `{filePath}` only and reads nothing, so the bytes
  of a file the panel refuses never cross IPC on this route.

## Opened rows (#472)

A file opened by a link or by `openFile` that the file tools did not touch is
listed above the touched rows, under a `.changes-subagent-header` "Opened, not
touched by the file tools": one `.touched-file-row.touched-opened.touched-openable`
per path, labelled `opened`, no time, no tools, its path by `textContent` in a
`.touched-file-path`.

- **Model**: `state.touchedOpened`, absolute paths newest first, on the session
  state (`getSessionState`), so it survives Refresh, closing and reopening
  Touched, session switches and `rekeyFilePanelState`. It is not persisted.
- **Bound**: `TOUCHED_OPENED_MAX` (50); opening a listed path again (by
  `filePathKey`) moves it to the top.
- **Added** only after the editor read answers `ok`; a refused read adds
  nothing. A row click adds nothing.
- **Deduplicated at render**: a path whose `filePathKey` equals that of any
  entry of `data.cachedFiles || data.files` is not drawn; the touched row
  stands for it. Row selection compares `filePathKey` on both sides, so on
  Windows a link spelt `c:/w\a.js` selects the touched row `C:\w\a.js`.
- **Drawn whatever the list's state**: loading, error (a plain terminal has no
  transcript) or empty. `touchedOpenedRevision` is part of the list signature.
- **Not counted**: the summary's "N files touched" never includes them.
- **Trust**: they never come from a transcript and never reach main as a list.

## Stashed edits (#472)

`state.touchedStashes` is a `Map` keyed by `filePathKey(absolutePath)`, oldest
first. Remote and read-only tabs are never stashed, even if their buffer becomes
dirty, so restoring or saving a stash cannot turn them into editable local files.
`stashChangesEdits` on a dirty Touched editor (a tab with a
`returnList`) adds the entry for its path, newest last: a stashed file is never
also in an editor, since opening it restores the entry and removes it. Each entry
is the stash object plus `type: 'touched-stash'` and `filePath`. An entry exists
only because the user typed into that file, so the map has no bound.

- **Restored** (with the `restoredEdits` notice, and the entry removed): when
  its file is opened again from a row or a link, returning to the list now in
  the slot (`restoreChangesEdits(..., {key, returnList, line})`; a `line` opens
  the source at that line); by the Touched
  toggle, the newest entry with its own list; and when the CLI ends a diff
  (`endCurrentTab(..., {restoreStash: true})`) with no open waiting.
- **Kept**: closing the panel, turning Touched or Changes off, and the panel's
  close on a diff restore nothing; the entries stay for the quit check, a later
  open of their file and the Touched toggle.
- **Quit check**: `collectUnsavedFileTabs` lists the current tab when it has an
  `absolutePath`, plus every entry of every session. An entry is dirty when
  `content !== savedContent`. Save writes it with
  `saveFileForPanel(filePath, content, savedContent, {git, version})` and
  removes it from its session on success; a refusal keeps it and the dialog
  says why.

## Markdown, formatted (#472)

A Touched editor on a markdown file (`isMarkdownPath` in
`public/viewer-toolbar.js`: extension `md`, `mdx` or `markdown`, any case)
opens formatted. `#changes-diff-format-btn` in the shared toolbar switches
between formatted and source and carries `aria-pressed`. It shows only for a
tab with `absolutePath`, which only Touched sets (`openTouchedEditor` and the
Touched stash restore), so a Changes list editor on a markdown file never has
it.

- **Preference**: one key, `localStorage.touchedMarkdownFormatted`. `'false'`
  means source; an absent key falls back to
  `DEFAULT_TOUCHED_MARKDOWN_FORMATTED` (formatted); a throwing storage reads as
  the default and the toggle still switches the open file. The toggle writes
  the key; nothing else does.
- **Per open**: `tab.formatted` is computed from the preference in
  `openTouchedEditor` and again in `restoreChangesEdits`. The stash does not
  carry it, so a restored file follows the preference as it is at restore time.
- **The buffer lives in source**: the editor is created and kept in
  `#changes-diff-host`, hidden while formatted. `#changes-diff-preview`
  renders `readChangesEditorContent(tab) ?? tab.current`, so unsaved edits are
  shown; toggling never destroys the editor; Save and Reload stay. Every
  `renderChangesDiff` re-renders the preview, after `loadCodeMirrorBundle`
  (it provides `window.marked`), so a watcher reload shows the new content.
  The preview element is shared by every tab and session: a render for a tab
  other than the last one rendered (`changesPreviewTab`) resets its
  `scrollTop` to 0, a re-render of the same tab keeps it.
- **Formatted wins over the diff**: the diff-mode button is hidden while
  formatted; toggling to source shows the stored `changesDiffMode` view.
- **Escape**: the preview has `tabindex="0"` and takes focus on the toggle to
  formatted, so a keydown on it reaches the panel's Escape handler through
  `closest('#changes-diff-view')`.
- **Layout**: `#changes-diff-preview` adds `min-height: 0` to
  `.markdown-preview`'s `flex: 1; overflow-y: auto`, so a long document
  scrolls inside the column-flex `#changes-diff-view`.
- **Sink**: the preview is written by `renderMarkdownPreview`, one of the
  sanitised markdown sinks listed in `.ai/contexts/viewer-panel.md`.

Tests: the `markdown:` tests in `test/dom-file-panel-touched.test.js` use the
real `marked` and `DOMPurify` builds; `window.marked` is set only by the
`loadCodeMirrorBundle` stub, as the bundle sets it in the app.

The tool entry point is the right-hand bar, using the shown terminal owner.
Changes and Touched park an unanswered Diff; its conditional button restores
the same editor. See [tool-bar.md](tool-bar.md).
