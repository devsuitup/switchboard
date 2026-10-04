# Context: touched-files

**Purpose**: a per-session list of the files the session's *file tools* touched,
in the right-hand file panel, for a local session. It answers "who touched what"
where Changes cannot: outside any repository, in a directory with no git, when
sessions share a tree, and after a change was committed or reverted. Issue #309.
User-facing behavior: `docs/touched-files.md`. IPC and its guard row:
`.ai/contexts/ipc-bridge.md` ("Touched files").

## Key files

| File | Role |
|---|---|
| `session-touched-files.js` | Main-side module, no electron: `extractTouches(line)`, `resolveTouchedPath(raw, {cwd})`, `collectSessionTouchedFiles(opts)` (the walk, with every dependency injected) and `listSessionTouchedFiles(sessionId, deps)` (the IPC's target resolution). |
| `public/touched-files-view.js` | Renderer: the `'touched'` tab type, its container, rows, toggle and refresh. Loaded after `file-panel.js`, which reaches it behind `typeof` (`initTouchedView`, `renderTouchedTab`, `hideTouchedView`). |
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

So the tab says what it is where it is read: `#touched-coverage`, a static
string in the renderer (`TOUCHED_COVERAGE_TEXT`) that is in the DOM while the
list loads, when it fails and when it is empty. `test/dom-file-panel-touched.test.js`
pins it. The empty state reads "No files touched by the file tools", never
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
  returned in the list.
- **The folder** comes from `getCachedFolder` and must be a plain name (no
  separator, not `.` or `..`) before it is joined to the projects directory; a
  `sub:` session id and a remote folder are refused.
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
opens. The disk guard and stat still run on every request; cached transcript
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

The shared file-panel Back button and Escape inside the file viewer restore
the original list DOM, selection, scroll, sort and window without requesting
transcripts again. Scroll and selection are captured when a file opens,
before the list is hidden; a later session switch uses that saved position.
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

- **Placement**: its own tab and header toggle (`Touched`, after `Changes`),
  not a section of the Changes list; the issue puts changing the Changes panel
  out of scope.
- **Remote sessions**: the issue is silent; local only. The IPC answers
  `reason: 'remote'` and the tab shows the message. Remote transcripts are
  mirrored copies, but their paths name the host's disk, which cannot be stat-ed
  from here.
- **Ordering**: latest file-tool timestamp first, with a path tie-breaker;
  the toolbar can sort by path instead. Unknown timestamps are displayed
  explicitly and sort after dated entries.
- **Open**: a present row opens the shared Changes editor described below.

## Not covered

- Files touched through `Bash`, MCP tools or any tool other than the four.
- Attribution between sessions sharing a directory, beyond the `sources` labels.
- A tool result that says the call failed (`is_error`) is not read.

## If you change this, also check

- `test/session-touched-files.test.js` (extraction, resolution, walk, target resolution), `test/dom-file-panel-touched.test.js`, `test/touched-files-wiring.test.js`
- `public/header-controls.js` (`HEADER_CONTROLS`, the icon) and `test/header-controls.test.js`
- the guard row in `.ai/contexts/ipc-bridge.md`

## Shared editor (#450)

`openTouchedEditor` in `public/file-panel.js` creates the same Changes tab
state and uses `renderChangesDiff`, `ensureChangesEditor`, the existing
`#changes-diff-view` toolbar and `#changes-diff-host`. It retains the Touched
list as `returnList`, snapshots scroll before hiding it and hides the Changes
list and splitter. Back, Escape and the editor close button restore that
original list through the shared discard guard. They do not fetch transcripts,
status or file content again. Selection, sort, window and DOM identity survive.

`read-file-for-panel` with `{editor: true}` discovers the repository from the
file's own directory, including a file outside the session's repository.
`readTouchedChangesFile` in `git-changes-file.js` reuses `readChangesFile` with
`staged: true`, so the original is HEAD even when the index differs. An
untracked file has an empty original. Repository files keep the existing
containment and link checks. Both the file and repository root are resolved
on disk with fs.realpathSync.native before computing the relative Git path,
expanding 8.3 names and preserving HEAD content through directory junctions and
system temporary-directory aliases. Containment compares case-insensitively on
Windows. Changes fixtures canonicalize temporary roots; Touched fixtures retain
their spelling so aliases remain exercised. The Windows short-path regression
derives the directory spelling, including existing parent aliases, and compares
it to the native long spelling before deciding whether to skip. Injected Windows
file/root resolution tests cover the mismatch on every platform.
A literal or resolved path containing a .git segment is refused before probing,
including ordinary read and plain-save IPCs. Exit 128 permits a non-repository
fallback only when stderr says "not a git repository"; other Git probe errors
remain errors. A missing or timed-out Git process during discovery, repository reread or
blob read, or a diff read refused for
its filename, mixed line endings or encoding, uses the guarded file content
as both sides of the pair, with line endings folded. Binary files are refused
for both ordinary viewer and editor requests; a binary HEAD blob also remains
a refusal. The display size cap and unreadable/non-file refusals still apply.
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
existing expected-content save guard. Refresh, Save and Reload reread this
absolute file, without fetching either list. Watching uses the existing
absolute-path `watch-file` registry and `file-changed` event; closing the
editor releases that watch. Dirty buffers and their return list survive a
temporary file open through a dedicated Touched stash. Changes has its own
stash; each list restores only its own edits, and restored Save controls are
updated after the editor mounts. The Changes header toggle is active only
for a Changes list/editor without a return list, and opens Changes when a
Touched editor is visible. The Touched header is pressed for its list or an
editor carrying its returnList. Clicking it closes that tab through the Changes
discard confirmation instead of stashing and immediately reopening the editor.
Switching to the other list continues to stash unsaved edits. Session idle
refreshes only Changes; Touched uses
its watcher and explicit Reload/Save to reread content. Active Touched editors
retain the existing unsaved-file close prompt.

Tests load shipped renderer files in jsdom. `test/touched-editor-ipc.test.js`
evaluates the shipped IPC handlers over disposable files and a fixture Git
repository. The Touched journey in `e2e/changes.spec.js` checks the actual
merge editor, width and Back navigation; it requires a separate live run.
