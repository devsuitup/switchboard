# Context: ipc-bridge

## UI notice log (#1196)

`logUiNotice(event)` sends `ui-notice-log` to the module-owned listener in
`src/main/app/ui-notice-log.js`. It accepts only the current window's main frame,
bounds and redacts the allowed fields, and writes rate-limited `[ui-notice]`
lines through electron-log. The 256 KiB hourly payload budget also covers
summaries; an exhausted hour emits one drop announcement and reports the count
on resumption. Action dismissal reasons use bounded, redacted `action:<label>`.
It returns no value or private emitter. See
[app-dialogs.md](app-dialogs.md#ui-notice-history-1196) for payloads and limits.

## Diagnostic log pruning (#1197)

The existing Diagnostics section and `activity-trace-panel.js` own the grouped
inventory and manual age cleanup, alongside the existing trace list/viewer.
`get-diagnostic-files(days)` and `prune-diagnostic-files(days, files)` delegate
to `src/main/shared/diagnostic-files.js`. Main supplies the active electron-log
transport's `getFile().path`, `TRACE_DIR` and `activityTrace.currentFile()`;
the renderer cannot select a directory. The allowlist is the transport's base
filename and its `.old` rotation, plus `activityTrace.TRACE_FILE_RE`.

The module canonicalizes paths (including Windows short TEMP spellings),
rejects linked files and diagnostic roots that are themselves links, permits
linked ancestors, and rechecks age, active paths and
the preview's size/mtime/device/inode before each synchronous unlink. It does
not recurse. Missing files are skipped; filesystem failures are returned per
file. Inventory errors are displayed without hiding readable groups.
`appConfirm` receives the eligible count and bytes; only its accepted snapshot
is submitted. `logRetentionDays` defaults to 14 in `SETTING_DEFAULTS`, is saved
with global Settings, and accepts whole days from 1 to 36500. Save resets an
invalid retention input to its last saved value without blocking other settings,
including when Diagnostics is hidden. Deletion paths are re-derived from the
canonical root plus the allowlisted basename. No startup job.

Age eligibility is strictly older than the retention cutoff (`mtimeMs < cutoff`);
an exact-boundary file is kept. The diagnostic tests use a whole-second clock
for both `utimesSync` and the injected current time so fractional-second storage
rounding cannot move the boundary fixture across the cutoff. Real-file tests
also pin eligibility and pruning one second on either side of the cutoff.

For the synchronous appearance bootstrap (`get-initial-theme`), shared default,
and live window/renderer updates, see [theme.md](theme.md).

## Archived projects manager (#863 slices 2–4, #1167, #1171)

`settings-panel.js` mounts `renderArchivedProjects` from `archived-manager.js`
after the shared renderer helpers, dialogs, notices and sidebar controller.
It reads `archivedProjects` through `getSetting` and passes a copy of folder records,
hidden entries/kinds, archive timestamps, cached projects and
the working remote-host list. Host edits update labels without saving. The manager
groups Local first, then configured hosts in order, then unknown aliases; it never
collapses a worktree entry into its repository. The filter, selections and folds
are local to the mounted list. Selection survives filtering and accepted snapshots;
only entries no longer archived are removed from the checked set.
Counts exclude deleted entries. Missing timestamps and unknown session counts
are omitted, never invented. Names use `shortProjectPath` (last two segments).

Unarchive uses the exact stored entry via `unarchiveProject` and/or `unarchiveFolder`, sequentially for a
bulk action. Successful entries leave the list, reload projects and get one B8
ten-second Undo notice for project archives and sessions. Folder-only restores use an informational
notice; mixed restores explain that Undo re-archives sessions and project archives and that folders
must be archived again through Archive folder. Undo calls `archiveProjectSettings(path, folderKey)` and
reads the new writer timestamp. After reopening Settings, Undo refreshes the
currently mounted manager; a pending action does not consume its Undo notice.
The notice stores its entry array and load generation. A later accepted project
reload invalidates it if any restored entry has been hidden or deleted again;
an older in-flight reload cannot invalidate a newer notice.
Failed entries remain, with `appAlert`; partial
bulk successes still have Undo. Row actions are locked during a request.

Delete builds `{projectPath, remoteAlias, folder, sessions}` from the exact entry;
`folder` is the host-qualified encoded path. Opening a row's overflow does no
deletion discovery and consumes no preview token. Clicking Delete calls the shared
confirmation flow, which flushes writes and uses the shared deadline and recovery
handling. Archived opts into preview reuse: the first request uses remembered
session/settings choices, and the dialog consumes that result once if its actual
answers still match. Changed answers require a fresh preview. Other callers keep
their existing flow. If a remembered choice is unavailable (shared settings), the
dialog unchecks it and obtains the matching plan; the refused initial plan has no
token. A refusal disables Delete and writes its reason into the row;
`aria-describedby` uses an entry-derived stable ID on both Delete and the row's
summary. Every refusal except the grouped-worktree hint, including thrown IPC
errors, explains how to reopen the menu and click Delete again unless the refusal
already explicitly says to reopen Delete. Stop, Check or Reload advice alone
keeps the menu retry sentence. Check for existing reopen advice after stripping
dialog-specific retry wording, so generic `SNAPSHOT_STALE`, `TOKEN_LIMIT` and
`UNAUTHORIZED` replies without an `error` field retain the menu retry sentence.
Reopening only
re-enables that explicit action, with no preview. Detached rows ignore refusal
updates. The shared flow's `onDialogOpen` callback clears the row's checking
message when the dialog opens.
The real inventory groups a local worktree only when its repository exists, so
orphaned entries can be deleted. Only the local worktree hints-conflict refusal
explains in user wording that the entry is grouped under its repository and
suggests deleting that repository. Ambiguous mappings do not get that advice.
Parsing uses the shared `parseFolderKey` and `isValidAlias` in
`public/utils.js`, re-exported by main's `remote-hosts.js`. An empty remote path
means `/`, matching the writer. Accepted entries call the existing
`confirmAndDeleteProjectFolder`, retaining preview tokens, options,
refusal handling and committed-result semantics. After cancellation or refusal,
the manager unlocks the controls before returning focus to an enabled Delete button
or, after refusal, the row's summary with its reason. After a re-render, focus
returns to the replacement row's summary, or to the Archived filter if that row
is gone. Pending refreshes finish before selecting this target. Passing `onUnavailable`
leaves fallback focus to that caller; sidebar and project-settings callers retain
their existing project-header/sidebar fallback. Unlocking keeps refused actions
disabled until the menu reopens. It never calls
Unarchive before Delete. The overflow also copies the full path through
`writeClipboard`. The folder restore IPC does not change launch code.

Native controls provide Tab navigation; Enter/Space folds host groups and Escape
clears the filter. ResizeObserver alone controls the 720px stacked layout and
480px search disclosure. New surfaces use existing dark chrome tokens.

Slice 4 adds top-level archived sessions from `cachedAllProjects`, grouped by
host-qualified project path, with twelve initially visible rows per group.
Select-all covers the entire filtered group, including its collapsed tail.
Session keys are separate from project entry keys. Names use `cleanDisplayName`;
attribute values also escape quotes. Transcript uses `showJsonlViewer` without
opening a terminal. Show in sidebar enables the archive filter, clears competing
filters and search, cancels the deferred search redraw, expands the target's
ancestors and focuses the row. The archive-filter footer uses `archivedCounts`
over the all-project snapshot and the union of hidden project entries and
`archivedProjects` folder keys, excluding deleted entries and counting combined
archives once, just like the page. `loadProjects` supplies folder records as the
fourth `hiddenSettings` value, so folder changes also invalidate the sidebar render
key. The footer uses singular session and project-or-folder labels for one item.
Project row attributes escape quotes as session rows do. Settings owns the
description above the manager, without adding a redundant section title.
Entirely empty archives show only the shared "Nothing is archived" explanation;
the per-group explanations remain for a missing group when another has items.

The shared bulk action runs project/folder entries first, then
`persistSessionArchive(session, 0)`. Its optional error callback collects failures
for one `appAlert` rather than producing separate sidebar error notices. One
success notice reverses successful projects and sessions only; session Undo uses
`persistSessionArchive(session, 1)`. Folder-only restore still has no Undo.

The accepted `loadProjects` snapshot calls `window.refreshArchivedManager`, which
does no manager archive read when the Settings viewer is closed or its Archived
page is hidden. A skipped refresh marks the manager dirty; selecting Archived
refreshes that mounted manager from `cachedAllProjects`, updating its rows and nav
count. Refresh consumes the dirty flag, so revisiting an unchanged page does not
read settings again. The sidebar snapshot still reads folder archives for its count.
`loadProjects` starts the global and folder-archive settings reads together, then
checks generation obsolescence before continuing to the terminal snapshot.
Refresh reads folder records and preserves filter, selection, group expansion,
working host labels and row-control focus. A version counter rejects stale reads;
refreshes during an action are deferred until the action and any error alert end.
`projects-changed` also schedules a reload when Archived is visible above another
sidebar tab. Closed settings retain the normal deferred reload behaviour.
Tests: `dom-archived-sessions.test.js`, plus the existing archived manager,
session/folder Undo, archive-all and row-action error suites.

Folder and project archives with the same exact entry share one row with both badges.
Folder dates accept the stored ISO timestamp; metadata includes the number of disabled
schedules. Deleted entries stay excluded. Combined restoration clears the project
archive first. The existing project writer also clears its folder record, so a following
`unarchiveFolder` returning `NOT_ARCHIVED` counts as success only after that project's
successful restore. A genuine folder failure retains a Folder-only row for retry;
a project failure prevents the folder call. Refresh reads both stores and retains the
filter and folded groups. Archived sessions remain outside this slice.

**Purpose**: The trust boundary between the Electron main process (Node, full filesystem) and the renderer (Chromium, sandboxed). The renderer can only call what `preload.js` exposes via `contextBridge`; everything else is denied.

This file is the **canonical inventory** of the IPC surface. When you add a new IPC, you change three places — main handler, preload bridge, renderer caller — and every IPC name should appear here.

## Project deletion callbacks (#474 A4c4/A4d)

`registerProjectDeleteIpc({ipcMain, service, getMainWindow, announce})` is an
internal factory called by project-delete-main after background IPC setup.
Preload exposes previewProjectDelete, deleteProject and projectDeleteState. It registers:

- `preview-project-delete({projectPath, folderKey?, options})`: five explicit
  boolean options, inspectable plan and token, or token:null on refusal.
- `delete-project({token, fingerprint})`: accepted main-owned operation ID and
  truthful completed/kept/failed/skipped/stopped lists; no extra options.
- `project-delete-state({operationId})`: only registry-authorized operation IDs,
  with committed/partial/unknown/notStarted state and receipt invalidation.
  Known views also include `{host, projectPath}` from their registry project;
  host is null for local or the remote alias, and projectPath is canonical.

`attach(win)` requires the current trusted main window with its app URL already
loaded, captures the actual webContents/mainFrame and URL, and revokes authority
on committed cross-document main-frame navigation (`did-navigate`), renderer exit,
destruction or window replacement. Results recheck authority after awaits.
Cancelled `did-start-navigation` events leave the current document authorized.
`did-finish-load` binds a replacement only at the captured trusted URL, then calls `announce` with
existing main-owned operations. Internal `rebind()` returns
`[{operationId,host,projectPath}]`
for main to announce after recovery. Old documents cannot read
those results and tokens cannot cross document/boot boundaries. Dispose removes
the exact callbacks and listeners without releasing main-owned operations.
`announce` is an injected main lifecycle callback, not renderer-supplied input.

Main's composition accepts an early `attach(win)` and defers the registration's
attach until the first did-finish-load. This avoids pinning the empty initial URL.
It starts recovery without awaiting before creating the window, gates all three
callbacks with retryable NOT_READY, and awaits a separate bounded recovery
barrier before scheduler/trigger startup. Writer bootstrap retries recovery;
shutdown unregisters listeners without dropping unresolved service ownership.

The `project-delete-recovery` notification carries `{operations:[{operationId,host,projectPath}]}`
and is exposed as `onProjectDeleteRecovery(callback)`;
`project-delete-schedules-changed` carries `{invalidation, operationId,
expectedProjectEpoch, committedRevision}` and remains internal. Project changes
use the existing throttled project notification. Both sinks
are behind a fresh committed-receipt/current-epoch check and main-owned per-sink
operation/epoch/revision deduplication. See project-delete.md for restart and
startup deadline limits. Legacy remove-project remains a separate contract.

Legacy `remove-project(projectPath, folderKey)` remains available under the
explicit preload name `removeProjectLegacy`; both new UI entries use token-shaped
`deleteProject({token,fingerprint})`. Service sequencing and recovery are documented in
[project-delete.md](project-delete.md). Main composition must await bounded
initial recovery before enabling these callbacks and retain #1090's background
worker-incarnation gate.

## Trigger renderer broker (#1022, slice C)

Source-extraction fixtures for `get-projects` load both the IPC registration
and `getProjectsSnapshot`, with the main-relative require, structured cloning
and conflict notification dependencies. This applies to the shared
`test/get-projects-handler.cjs`, the archive-writer child script and the
during-scan fixture. Each evaluates one contiguous slice from the snapshot helper
through the registration, with `lineOffset` measured at the helper start so
coverage retains the original `main.js` lines.
`test/get-projects-archive-extraction.test.js` verifies that source mapping for
all three fixtures and exercises the archive and scan extraction blocks under
plain Node, without starting their Electron/SQLite processes. It also executes
the remote-resize test's open/reattach/launch block with a main-relative require,
and statically checks the excluded background-continuation exit contexts for
`writer.releaseLiveSession`. The complete Electron integration tests remain
separate qualification; these probes do not replace their assertions.

Main instantiates `createTriggerRendererBridge`, binds it to each window and
supplies it to the watcher. The renderer registers `handleTriggerSessionAction`
before startup and announces readiness only after project load and restore
succeed. v1 open/new and stop are active; stop waits only for renderer readiness,
then uses the shared main-side stop backend and pinned PTY exit confirmation.

| Direction | Channel | Preload API / payload |
| --- | --- | --- |
| Renderer → main, invoke | `trigger-actions-ready` | `api.triggerActionsReady()`; returns `{documentEpoch}` for the current window/main frame, otherwise null |
| Main → renderer | `trigger-session-action` | `api.onTriggerSessionAction(cb)`; `{requestId, documentEpoch, mode, requestedSessionId, tabKey, generation, session, project, name, deadline}`; returns a function that removes only this callback |
| Renderer → main, send | `trigger-session-action-result` | `api.triggerSessionActionResult(ack)`; `{requestId, documentEpoch, mode, ok, requestedSessionId, tabKey, generation, reason?, error?}` |

The broker correlates the current main frame and document epoch as well as
the request/target tuple. Historical requested ID A may address a pinned tab B;
an ACK must retain both identities. Main-owned entry, PTY and generation checks
prevent a renderer ACK from authorizing a replacement. Resume/new ACKs require
main-recorded spawn evidence. Permits are private to main, single-use, bounded
by the action deadline and revoked on document/window loss. No external
protocol or injected JavaScript is used.

`openTerminal(id, projectPath, isNew, options, initialSize, triggerRequestId)`
accepts an optional private permit in its sixth argument. Five-argument callers
retain their argument shape. Main consumes it once, checks v1 raw liveness and
the exact transcript/cwd, then rechecks after awaited preparation and immediately
before spawn. Main serializes all opens by normalized ID, including ordinary
clicks. Close commitment revokes pending permits and every readiness object
through the existing exit guard and suspends the document: the bridge keeps the
main frame that completed its handshake. Rolling a committed update back
(`onRolledBack`) restores readiness for that same window, WebContents and main
frame only, with a new epoch, so readiness objects and permits issued before the
commitment stay invalid; navigation, renderer death, frame replacement and
destruction require the normal handshake. In-flight actions are cancelled by
their own capture of the exit guard (see trigger-watcher.md, "Action
cancellation"), not by the broker request, whose permit ends at the ACK. A
successful ACK is sent only after the entry is registered and working-set
persistence is scheduled.
The renderer uses the ordinary new/resume/reattach lifecycle with activation
disabled and returns a structured correlated ACK after registration/persistence.
See [trigger-watcher.md](trigger-watcher.md), “Renderer broker and open lifecycle”.

## Terminal backlog (#1037)

`terminal-backlog` is a one-way renderer-to-main diagnostic sent by
`api.reportTerminalBacklog({ gapMs, sessions, omitted })`. Each session has
`{ id, chunks, chars }`; the renderer includes at most 20 eight-character ids.
Counts combine visible queues and hidden accumulators. Main sends the no-payload
`terminal-backlog-request` event on powerMonitor `resume` and `unlock-screen`;
`api.onTerminalBacklogRequest(callback)` delivers it to the renderer, which
responds with `gapMs: 0`. The renderer also reports after returning from more
than 60 seconds hidden, using that hidden duration as `gapMs`. This is not a
measurement of a system freeze, and there is no polling interval.
Only the active window's main frame is accepted. `src/main/app/power-log.js`
validates nonnegative safe-integer counters and gap, truncates/sanitizes ids,
and emits one bounded `[power]` line with an ISO timestamp. There is no terminal
content, invoke return payload, file access or application action.

## Schedules (#792, slices A1, A2, B, C and D)

| IPC | Args | Returns | Preload |
| --- | --- | --- | --- |
| `create-schedule-file` | `projectPath, fields` | `{ ok: true, filePath }` or `{ ok: false, field, error }`; registered, unarchived project; runner validation and sandbox refusals; guarded commands directory and exclusive hard-link publication | `api.createScheduleFile(projectPath, fields)` |
| `set-schedule-enabled` | `filePath, enabled` (boolean) | `{ ok }` or `{ ok: false, error }`; exact current listing path, linked-file and front-matter guards; re-enable skips missed catch-up before writing | `api.setScheduleEnabled(filePath, enabled)` |
| `delete-schedule-file` | `filePath` | `{ ok }` or `{ ok: false, error }`; exact current listing path and disk-resolved link guard; removes the file and its catch-up/run-result records, preserving transcripts | `api.deleteScheduleFile(filePath)` |
| `list-schedules` | none | `{ now, catchUpActive, projects: [{ projectPath, shortName, archived, sandboxed, known, schedules: [{ filePath, file, name, slug, cron, cronText, enabled, catchUp, cli, prompt, linked, problems, nextRunMs, catchUpDueMs, runs: [{ sessionId, created, messageCount, replied, running, result }] }] }] }` | `api.listSchedules()` |

Main registers the handler and calls the Electron-free
`src/main/schedules/schedule-list.js` export `buildScheduleList(deps)`. The
renderer supplies no paths: projects come from the awaited local schedule
registry, cache folders from its listed and real paths. Archived and unknown
projects remain listed with explicit flags. This read creates no catch-up
state and changes no schedule or transcript. `now` is epoch milliseconds;
next/pending times are epoch milliseconds or `null`. Runs are deduplicated,
newest first, capped at 20 per schedule. `replied` is an assistant-record check
(`null` on an unreadable transcript); `running` reads this instance's scheduled
child map. `result` is the persisted v1 run record, `null` when none is recorded,
or `{ unreadable: true }` when the record cannot be read or validated. Records
contain `v, sessionId, file, name, slug, manual, dueMs, startedAt, endedAt,
outcome, exitCode, signal, failure, error`; timestamps are ISO strings, `dueMs`
is epoch milliseconds or null, and exit codes are integers or null. Outcomes
are `exited`, `signal`, `spawn-error` and `refused`. Listing reads only the
requested session IDs in this instance's `schedule-runs` directory and creates
nothing. A directory read error marks the requested results unreadable.

`run-schedule-now`, `read-memory`, `save-memory` and `schedule-run-exit` keep
their existing contracts. A2 adds the Schedules renderer and the guarded
enable operation; B adds deletion and C adds the creation form. See [schedule-runner.md](schedule-runner.md), "Schedule listing
backend", for field parsing, refusal rules, time-zone semantics and tests.

## Main-process error backstop (#896)

`src/main/app/main-error-handlers.js` installs `uncaughtException` and `unhandledRejection`
listeners in `main.js` before `app.whenReady()`. Both write `[main:<origin>]`
and a bounded stack to `electron-log`; non-Error rejection reasons use a safe
text representation. A throwing logger is contained, independently of notices.

Policy: keep running after logging, with no automatic quit. The exception
listener suppresses Electron's default exception dialog; a B8 error notice
replaces it. This is a reporting backstop, not recovery of the operation that
threw. Individual throw sites and worker-thread error handling are unchanged.

| Event | Payload | Bridge / consumer |
|---|---|---|
| `main-process-error` | `{id, kind: 'error', message, count}` | `api.onMainProcessError(callback)` in preload; `public/app-notices.js` groups errors into one persistent, dismissible B8 notice with an **Open log** action. |
| `open-main-log` | No arguments | `api.openMainLog()` returns `{ok, error?}`. Main chooses `log.transports.file.getFile().path`, requires an absolute, non-sensitive path (including the existing on-disk path guard), and opens it via `shell.openPath`. Renderer arguments cannot choose another file. OS opener errors are shown in one replaceable error notice; opening the log leaves the error group visible. |
| `main-error-notices-ready` | No arguments; one-way | `api.mainErrorNoticesReady()` is sent after `app-notices.js` installs its error listener. Only the active window's webContents may arm delivery and flush queued notices. |
| `main-error-notices-dismissed` | `ids: string[]`, at most five ids; one-way | `api.mainErrorNoticesDismissed(ids)` sends the member ids removed by the user. Only the active window's webContents may dismiss them; main rejects the entire payload unless it is an array of at most five strings. Known delivered ids are removed and unknown or evicted ids are ignored, so a concurrent delivery evicting one member cannot prevent dismissal of the others. Pending errors and occurrence counts are retained. |

Before the renderer signals that its listener is ready, or if its window/webContents is gone or
sending throws, notices are queued by normalized-message id (up to 100 distinct messages;
overflow drops the least recently encountered queued notice, never its log).
The `main-error-notices-ready` handshake flushes the queue, including on window
recreation/reload. Failed sends stay queued for the next handshake or recurrence.
Main retains the last successfully delivered notice for each of the five most
recently delivered ids, in renderer recency order. The first ready signal after
readiness resets replays that snapshot before flushing pending errors; repeated
ready signals only flush pending errors. Replay does not increment counts, write
logs or alter the trailing-update throttle. This recovers notices sent to the
outgoing page between reload start and commit. The snapshot is bounded separately
from the 100-id pending/count caches and cleared on disposal. User dismissal removes
only the reported member ids, so a later reload does not resurrect dismissed notices
or lose a different error delivered between the click and IPC receipt. New occurrences
and pending trailing updates can still show a fresh group after dismissal.
Committed main-frame document navigation (`did-navigate`) and `render-process-gone`
reset readiness until a new handshake. `did-navigate` only fires for new main-frame
documents and needs no argument inspection. `will-navigate` uses Electron's details
object rather than deprecated positional arguments.
Started or cancelled navigation, subframe loads and same-document navigation
do not disarm notices. `did-finish-load` does not control notice readiness.

Whitespace-normalized messages, including across the two origins, have a stable
SHA-256 id derived before display truncation. Every event is logged and updates
the occurrence count immediately. The first occurrence sends immediately, then
each id sends at most once per second with its latest count, including a trailing
delivery after a burst. The clock and timer functions are injectable in tests.
The 100 most recently encountered distinct ids retain cached counts (evicted counts
start again if encountered later unless a delivery is still queued). The bounded
pending queue retains its own dispatch state, so cache eviction cannot lose a
trailing count or reset its throttle. Repeated queued errors retain their latest count.
Display summaries are limited to 500 characters plus the origin label;
non-Error inspection disables custom inspectors/getters and limits depth,
array lengths and individual strings. Proxies are always summarized as
`[Proxy; inspection omitted]`, without inspection or message/name/stack access,
so none of their traps run. Arrays, ArrayBuffer views (including Buffers), and
boxed Strings with more than 1,000 elements, characters, or bytes (for DataView)
bypass key enumeration. Array length comes from its own data descriptor;
TypedArray length and DataView byteLength/buffer/byteOffset use intrinsic prototype
getters, and boxed String length comes from `String.prototype.valueOf.call(value)`.
Type checks use intrinsic brands, including across realms; constructors are not read.
Buffer labeling requires the Uint8Array brand and a direct `Buffer.prototype`
identity check; it never walks an intervening Proxy prototype.
Their preview inspects at most 20 elements/bytes or the first 2,000 String characters,
reports the type and real length, and says named properties were not inspected.
Arrays and typed arrays are sampled via own index descriptors, without slice/subarray
or species lookup. Only data values enter the sample; accessors become literal
`[Getter]`, `[Setter]`, or `[Getter/Setter]` strings. Copying accessor functions into
the sample is unsafe: Node 22's inspect array grouping can read index getters even
with `getters: false`. DataView samples use the intrinsic buffer and offset.
String samples slice the unboxed primitive, avoiding overridable coercion methods.
Smaller arrays/views and String objects retain inspect's preview when they have at most 1,000 own enumerable
non-index keys. Above that cap they use `[Object with more than 1000 named keys; inspection omitted]`.
Small arrays (length at most 1,000) still go through inspect, which can run an
own index getter in Node 22 despite `getters: false`.
String objects are recognized across realms with `util.types.isStringObject`.
Other non-Error values with more than 1,000 own enumerable keys are summarized as
`[Object with N keys; inspection omitted]`, without reading property values.
Key enumeration and inspection remain inside the hostile-value guard. Plain-object
key enumeration itself is unbounded in time
and allocation; the summary avoids serializing those property values but does not
bound enumeration. Small arrays/views and String objects enumerate numeric keys
before counting named keys; large indexed values skip that pre-check entirely.
Nested plain objects with around a million keys remain out of scope: inspect's
depth, maxArrayLength and maxStringLength options do not bound object width, and
truncating its result does not bound the work needed to produce it. Ordinary
message/name/stack getters likewise have no hard work budget.
Inspected output, message prefixes, and logged stacks are capped at 16,000 characters.
For messages of at most 16,000 characters, ids retain the full whitespace-normalized
message. Longer messages hash the normalized first 16,000 characters followed by
`\0length=<original UTF-16 length>`. Messages over 15,000 characters log the first
11,000 characters, `[truncated; length=N]` with the original UTF-16 message length,
and at most 4,000 stack characters (see below for which), keeping the total below
16,000.
For messages over 16,000 characters, a temporary `Error.prepareStackTrace` is
installed before reading the own stack descriptor. On Node 20 (V8 11), that
descriptor read formats a previously unread native stack into a data property
through the temporary formatter. On Node 22, the native own stack accessor must
match V8's shared getter, captured once at module load from a fresh Error, before
it is called directly. The formatter uses at most the first 20 call sites,
returning frames only (at most 4,000 characters). The log adds the
bounded message prefix and truncation marker once. The prior formatter descriptor
is restored in `finally`.
If `Error.prepareStackTrace` is non-configurable or `Error` is frozen, messages
over 16,000 characters log no stack, including explicit or already cached stacks,
rather than risk materializing an unbounded lazy stack on Node 20. Messages of
15,001–16,000 characters are unaffected by this restriction.
V8 caches those frames on a previously unread Error;
this is an accepted trade-off to avoid materializing the full oversized stack.
Restoring the accessor descriptor cannot reset V8's internal cached value, and
reconstructing an Error would lose its original call sites. A stack read before
reporting is already cached and remains unchanged. There is currently no app
reader of the reported Error's stack after this backstop.
Own stack data values, including explicit or previously cached stacks, retain
their contents. When the error's own message is over 15,000 characters, it must
start at an index from 0 to 1,000 of the stack (matched on its first 200
characters, then confirmed in full), whatever the error name or header. When
found there and only whitespace (at most 1,000 characters) separates it from
the next frame line, the 4,000-character cap starts at that frame line (a
message ending in a newline may share it with the first frame). The head is
kept only if the message's full 200-character probe does not start inside its
first frame line; otherwise it falls back to the tail. A blank or short first
message line matching only a frame suffix is not a repeat. Only those 200
characters are compared, not the whole message.
If those 200 characters repeat on a later line, the head is cut before that
line and joined within the 4,000-character budget to the end of the frames
following the repeated message (the same whitespace rule applies), dropping
any partial first tail line; without a valid following frame, only the prefix
is kept. This retains both throw sites when they fit, at the cost of
intervening frames. A stack that itself starts with a frame keeps its head.
Otherwise, including a long text that comes from the error name, the cap is
the last 4,000 characters, as before. When the frames exceed 4,000 characters,
the head keeps the throw site and may hold fewer frames than the tail would;
that is the trade-off #965 chose. The capping itself only slices a stack
string already read. A whitespace-only message reads `error.name` at every
length. Otherwise
custom stack and name getters never run for messages over 16,000 characters;
for 15,001–16,000 characters the stack is read through `error.stack`. Absent
stacks contribute no frames.
A native Error from another vm realm has a different stack getter on Node 22+
and therefore contributes no frames for messages over 16,000 characters.
The 15,990-character regression
cannot exercise the swap: it is below the strict >16,000 threshold, so it covers
ordinary stack reading and truncation; the 16,001-character case covers the swap.
Smaller messages retain the existing stack-prefix cap.
A Node 22.23.4 probe with a 50-million-character message measured about
50 MB of extra heap for `error.stack.slice(-4000)`, versus about 28 KB for
call-site formatting: slicing the tail alone does materialize that native stack.
This bounds normalization, hashing and logged text size; it does not guarantee
the backing storage size of V8 substring values, or avoid the cost of an already
cached, cross-realm or custom stack string. Message prefix slicing itself can
materialize a large V8 string.
Equal prefixes and lengths intentionally deduplicate
even when unseen suffixes differ; different original lengths remain distinct.
Inspected values with the same capped output can also share an id. Empty or
whitespace-only messages fall back to the error name or a type label before hashing.

The renderer uses B8 `members` to retain at most five distinct summaries inside
one `main-process-errors` notice, moving repeated ids to the newest position and
showing counts. While an id remains in the group, its displayed count is the
maximum of the previous and incoming count, so a main count-cache eviction cannot
reduce it. After more than 100 distinct ids cause count-cache eviction, the shown
count is a lower bound, not an exact lifetime total. Renderer eviction/dismissal
clears that display history.
Existing groups update visible text in place, preserving buttons and focus.
The empty, persistent `#app-notices` host retains `aria-live="polite"` before any
notice is inserted, preserving announcements of other B8 notices inserted with text
already in place and their existing `alert`/`status` roles. The main-error group has
`role="group"`, the accessible name “Application errors” and `aria-live="off"`,
so its visible counts and recency order remain readable without live announcements.
An offscreen announcement span before the buttons supplies its own live semantics
(`role="alert"`, `aria-atomic="true"`); it changes only when a new
id joins, using that id's message. Count-only updates and member reordering leave
live-region text untouched. A missing announcement span is recreated after a generic
notice rerender so the next new id is still announced. `public/style.css` clips the
announcement without hiding it from assistive technology. Other B8 notices retain
the persistent polite host and their existing roles.
Flush uses the same grouping, so 100 queued errors cannot create 100 alerts.
The notice says the log may hold details, since electron-log rotates it.
Trailing timers are unref'd, bounded by the 100 pending ids, and cancelled on
pending-queue eviction/disposal. Listeners can be disposed independently in plain
Node tests.

Known gap (#896): an error before any window has ever loaded stays queued only;
there is no native startup notification or forced window creation. Diagnostics
lists activity traces, not the main log; **Open log** on the error notice is the
main-log entry point.

## Key files

| File | LOC | Role |
|---|---|---|
| `preload.js` | ~270 | The `contextBridge.exposeInMainWorld('api', {...})` block. Every renderer-facing function. |
| `main.js` | ~4100 | The `ipcMain.handle('<name>', ...)` and `ipcMain.on('<name>', ...)` handlers, scattered throughout. |
| `src/main/schedules/schedule-ipc.js` | ~220 | **Also registers IPC handlers** (`get-schedule-creator-command`, `create-schedule-session`, `run-schedule-now`) — `init()` is called from `main.js`, but a `main.js`-only search for `ipcMain.handle` misses these three. Audit both files. |
| `src/main/bg-agents/bg-agents-ipc.js` | ~130 | **Also registers IPC handlers** (`get-bg-agents`, `check-bg-agent-verb`, `bg-agent-verb`, `dispatch-bg-agent`, `bg-agent-live-job`, `restore-background-job`) and sends `bg-agents-changed` — `init()` is called from `main.js`, so a `main.js`-only search for `ipcMain.handle` misses these six. Audit both files. |
| `unsaved-guard.js` | ~440 | **Also registers IPC handlers** for the exit flow (`exit-attempt-snapshot`, `exit-background`, `exit-background-cancel`, `unsaved-check-phase`, `unsaved-pong`, `unsaved-dialog`, `unsaved-ready`, `unsaved-check-ack`, `unsaved-check-result`, `unsaved-check-reason-done`) through the `ipcMain` it is handed by `createUnsavedGuard`. See window-frame.md. |

## Public surface (IPC inventory)

### Sessions (request/response)

The exit flow exposes `exit-background(checkId, detail, ids)` as
`exitBackground`, `exit-background-cancel(checkId, detail)` as
`exitBackgroundCancel`, and `exit-background-progress(attempt, event)` as
`onExitBackgroundProgress`. Main validates sender, check, attempt/version and
session eligibility. Cancel retains sender, check and current uncommitted user
attempt ownership checks but accepts earlier versions after an upgrade. The
batch never grants consent or stops processes.
`onExitAttemptInvalidated(attempt, outcome)` forwards optional `{ reask: true }`
or `{ external: true }` so the renderer can preserve marks during renewed
consent and avoid recovery during a system exit. See window-frame.md.

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `get-projects` | `(showArchived)` | `Project[]` | Sidebar payload. Reads from cache. |
| `get-active-sessions` | — | `{sessionId, busy}[]` | Currently open PTY sessions plus each one's live `_cliBusy` flag — see "Busy-state reconciliation" below. |
| `get-active-terminals` | — | `Terminal[]` | Active PTY identifiers |
| `open-terminal` | `(id, projectPath, isNew, sessionOptions)` | `{ok, error?, mcpState, mcpError?}` | Spawn or attach a PTY. |
| `send-session-to-background` | `(id)` | `{ok, oldSessionId?, sessionId?, jobId?, cwd?, respawned?, attached?, code?, error?}` | One local handoff, fresh continuation plus live bg descriptor proof; holds the original PTY exit. A session whose conversation is already held by its own stopped background job is not sent through `/bg`: it gets `/exit`, then that job is respawned (`respawned: true`; `bg-handoff.js`'s `respawnRoute`, #785). `bg-handoff-notice(id, message)` pushes the terminal confirmation notice. See bg-agents.md. |
| `session-live-elsewhere` | `(id)` | `{pid, cwd, startedAt} \| null` | Whether another process (another Switchboard, a CLI in a terminal) is running session `id`: a live pid in `~/.claude/sessions/` and no PTY for it in this instance. Called by `openSession` before a resume; see `.ai/contexts/cli-session-state.md` ("Live elsewhere"). |
| `sessions-live-elsewhere` | `(ids)` | `{[id]: {pid, cwd, startedAt}}` | The same check for a working-set restore batch, answered from one scan of `~/.claude/sessions/`; ids that are not live are absent, and at most 200 ids are looked up. Called once by `runRestore`; see `.ai/contexts/cli-session-state.md` ("Live elsewhere"). |
| `stop-session` | `(id)` | `{ok}` | Kill the PTY for `id`. Local only — a remote-attach session's PTY is the local ssh attach client, so this only detaches it; see `remote-stop-session` for the real remote "stop". |
| `remote-stop-session` | `({alias, sessionId})` | `{ok, method?, error?}` | The "stop" verb for a remote-ssh session (`.ai/contexts/session-state.md`, "Lifecycle decisions") — kills the process on the host at the narrowest matching tmux scope when the descriptor names a target (`kill-pane` when it names a pane, `kill-window` when it names only a window — never `kill-session`, siblings share the tmux session), confirms death with a `/proc` poll, and falls back to `kill -TERM` then `kill -KILL` if the tmux kill didn't stick or no tmux target was named; refuses with the pid-reuse message when the pid now belongs to a non-claude process. `method` is `'tmux-pane' \| 'tmux-window' \| 'pid-term' \| 'pid-kill'`. On success also drops the host's in-memory descriptor, forces a host refresh, and detaches the local attach PTY if one was open. Handler in `main.js`, adapter in `remote-stop.js` (reuses `remote-attach.js`'s pid-reuse probe, not a fork). |
| `set-star` | `(id, starred)` | `{ok}` | Set the desired pin state on every conversation part. |
| `rename-session` | `(id, name)` | `{ok}` | Set customTitle. |
| `archive-session` | `(id, archived)` | `{ok}` | Move to archive. |
| `delete-session-preview` | `(id)` | `{ok, error?, partIds?, parts?, transcripts?, subagents?}` | Awaits the full `deleteSessionGuard(id, partIds)` before resolving files. Refusals reach the renderer notice before any confirmation. |
| `delete-session` | `(id, partIds)` | `{ok, error?, removedPartIds?}` | Rechecks membership and the full guard against the confirmed parts before removal. Never stops a process. |
| `read-session-jsonl` | `(sessionId)` | `Entry[]` | Full transcript. |
| `read-subagent-jsonl` | `(parentSessionId, agentId)` | `Entry[]` | Subagent transcript. |
| `list-subagents` | `(parentSessionId)` | `Subagent[]` | All children of a parent. |
| `start-subagent-watch` | `(parentSessionId, agentId)` | `watchId` | Begin tailing. |
| `stop-subagent-watch` | `(watchId)` | `{ok}` | Tear down watch. |

### Projects + worktrees

| IPC | Args | Notes |
|---|---|---|
| `browse-folder` | — | Native folder picker |
| `add-project` | `(projectPath)` | Register a project (creates folder index) |
| `archive-project-settings` | `(projectPath, folderKey)` | Archive the project reversibly; preserve settings/cache/registration, suspend schedules through hidden-state filtering. Returns `{ ok: true, entry }`, where `entry` is the exact stored bare path or `alias::path` for `unarchiveProject(entry)`. Bridge: `archiveProjectSettings`. |
| `unarchive-project` | `(entry)` | Refuse entries marked `delete` before effects with `{ error, code: 'DELETED' }`; missing entries return `{ error, code: 'NOT_ARCHIVED' }`. Remove an archived or legacy hidden entry, refresh its folder and restore legacy local schedule registration. Bridge: `unarchiveProject`. |
| `unarchive-folder` | `(entry)` | Restore an exact folder archive through `writer.clearArchivedEntry`; missing entries return `{ error, code: NOT_ARCHIVED }`. Keep session archive flags and schedule files unchanged; preserve disabled schedules as a re-enable offer and notify once with `archive`. Bridge: `unarchiveFolder`. |
| `archive-project` | `(groups, opts)` | Archive folder groups and confirmed schedules; success includes `archivedAt` for the reverse path. Bridge: `archiveProject`. |
| `undo-archive-project` | `(groups, archivedAt)` | Refuse invalid groups or a stale timestamp before any effects; remove those folder archives, restore consumed offers and re-enable exactly their `disabledByArchive` files. Bridge: `undoArchiveProject`; folder Archive Undo passes the original groups and returned timestamp before restoring session archive flags. |
| `remove-project` | `(projectPath, folderKey)` | Legacy removal: drop settings, cache/search and schedule registration; no disk deletion. Bridge: `removeProjectLegacy`; neither current Delete entry point uses it. |
| `remap-project` | `(oldPath, newPath)` | **Atomic JSONL `cwd` rewrite**, refuses if active sessions exist. See PR #20. |
| `check-remap-project` | `(oldPath)` | Read-only `{ ok, error? }`; bridge `checkRemapProject`. Runs `remapProjectRefusal`, also used by the action: any non-exited, non-panel PTY with the same encoded folder refuses. The renderer checks before the folder picker and confirmation, and shows a notice on refusal or check failure. |
| `delete-worktree` | `(worktreePath, shown)` | `shown: { fingerprint, confirmLocked, confirmSubmodules }` from the successful preview. Rechecks path guards and Git state through `worktree-delete.js`; no force for clean status without submodules or a lock, one force for matching dirty status or explicitly confirmed submodules, two only for an explicitly confirmed matching lock. Submodule consent is required even with lock consent. Changed state / Git refusal returns `{ ok: false, refresh: true, status, error }`; renderer shows a persistent notice and asks again. Cleanup happens only after successful removal. Removal has a 120 s timeout; preview calls retain 15 s. |
| `check-delete-worktree` | `(worktreePath)` | Read-only `{ ok, error? }`; bridge `checkDeleteWorktree`. Shares `checkDeleteWorktree` with Delete and status: string input, recognized layout and disk-resolved known parent. The renderer awaits it before the dialog or status request; refusal or failure shows a notice. No git command or cleanup runs in the check. Segments are split on both slash and backslash on Windows, and slash alone on POSIX so literal backslashes in filenames remain valid. A path with a whole `.` or `..` segment anywhere is refused as an unrecognized layout before the parent lookup: the registration match normalises `..` on the text while Git and `lstat` resolve it on disk, so the two could name different folders (#855). |
| `worktree-status` | `(worktreePath)` | `{ ok, path, homeDir, branch, dirty, total, ignoredCount, submodules, locked, lockReason, fingerprint, sessions }`. Line-delimited `worktree list --porcelain` works on Git 2.24 and recent Git; C-quoted paths decode octal UTF-8 and escaped characters. NUL-delimited status explicitly uses `--untracked-files=all --ignore-submodules=none`; a separate `--ignored --untracked-files=normal` status counts collapsed ignored directories. Sessions include non-exited local PTYs and live sidebar descriptors whose cwd is in the worktree; remote records are excluded. Registration match (`registeredPath` in `worktree-delete.js`): when `lstat` shows the requested or registered path is not a link, the whole path is compared by `realpath`, so a Windows 8.3 short basename (`WORKTR~1`) matches its long registration; a link or a missing path falls back to the resolved parent plus the literal basename, so a link to a registered worktree is never taken for it. The status carries `registeredPath`, Git's own spelling, and `removeWorktree` passes that spelling to `git worktree remove` because Git 2.24 does not recognise an 8.3 spelling of its registration ("is not a working tree"). Session cwds: only cwds on the same drive as the worktree (literal or resolved; UNC counts as another drive) are resolved on disk, all in parallel, each bounded by `CWD_RESOLVE_MS` (1 s) with both literal and resolved cwd spellings compared against both literal and resolved worktree spellings; a timeout on either lookup retains literal membership. Known blind spot, accepted for the bound: a cwd on another drive is compared literally only, so a junction on drive D: pointing into a worktree on C: is not listed — one unreachable UNC cwd used to cost ~10 s on every status read (#855). `runningSessions` takes an optional `{ realpath, timeoutMs }` for tests. |

The sidebar deletion dialog displays the full path (`~` for home, absolute on
hover), branch, running session ids/cwds and ignored-entry warning. Confirmation
stays disabled until a successful preview; locks and submodules each require a
separate checkbox. Preview and removal failures use the persistent session-action notice.
Remote nested headers share the renderer path, so Delete refuses before any
local IPC and directs the user to git on the host. Project-folder Delete (#474)
still never offers deletion of the project's own directory. Agents Delete uses
`claude rm` without force; it does not call the worktree IPC or escalate refusals.

The SHA-256 fingerprint includes worktree metadata, a streamed hash of full index stage records,
dirty/untracked paths, both rename paths, file modes and streamed SHA-256 file
contents. Streaming bounds memory and detects same-size edits with restored
timestamps; symlinks hash their link targets and absent files have a missing
marker. Initialised dirty submodules recurse through the same status/index/content snapshot,
up to 16 levels. Index gitlinks identify submodules, including clean ones, so
the user can explicitly consent to the force Git requires. Gitlinks without a
`.git` entry are marked uninitialised and never run Git in the child directory,
where it would otherwise discover the parent repository. Untracked embedded
repositories or other unexpected dirty directories refuse with instructions to
review or move them, rather than recursively reading arbitrary directory trees.
Ignored paths/counts are compared, but ignored contents are intentionally not
hashed or expanded into status rows. Index stage output streams directly into SHA-256 with
bounded record parsing, bypassing the 16 MiB buffer used for other Git calls.
The whole snapshot, including nested submodules and index data, has a 512 MiB
hash budget; an over-budget refusal names the biggest files encountered.
Preview refuses above 100,000 dirty records and translates maxBuffer/timeout
errors into actionable refusals. An interrupted removal preserves killed/signal
metadata and warns that the folder may be partly deleted, without rereading a
potentially missing folder or claiming Git refused it.
If an ordinary Git removal failure is followed by a failed fresh preview,
the response preserves Git's original error and warns that registration may
already be gone and the folder partly deleted.

Directory scans use a root lstat and Dirents without traversing directory links,
once before the snapshot and exactly once again immediately before removal.
Nested submodule snapshots do not repeat the tree scan. Up to 32 directory reads
run in each batch, with a shared 200,000-directory cap and five-second budget
per scan; exceeding either refuses with an actionable message. The root and link
targets use the same native resolver (`fs.promises.realpath`). Windows refuses
every directory link, including inside-pointing junctions and directory symlinks;
POSIX permits inside-pointing links and refuses outside or unresolved targets.
These rules include ignored directories. A directory whose realpath is its own
absolute path is walked as an ordinary directory, including reparse placeholders;
the message names up to ten plus the total and instructs removal of the link
first (`rmdir <path>` for Windows junctions, never recursive deletion; POSIX
`rm <link>` without `-r`). File hashing resolves on disk with `resolveOnDisk`,
checks realpath containment and reads that returned path; file symlinks hash
only their link text after checking the resolved parent. This is a
fresh comparison before removal, not an atomic filesystem lock: edits after the
final scan remain possible, including newly created or retargeted directory links.
Every index gitlink is checked even when absent from dirty status: a nonempty
uninitialised submodule refuses preview/deletion before force can hide its files.

### Tabs (Memory / Stats)

| IPC | Returns |
|---|---|
| `get-memories` | `{global, projects}` |
| `read-memory` / `save-memory` | content / `{ok}` |
| `get-stats-from-db` | `buildStatsFromDb()`: `{dailyActivity, dailyModelTokens, modelUsage, totalMessages, totalSessions, totalToolCalls, totalTokens, firstSessionDate, lastComputedDate}` from `session_metrics` — heatmap source since PR #7 |
| `refresh-stats` | `{stats, usage}` — combined; calls `buildStatsFromDb` (using `getDailyMetrics`) + `fetchAndTransformUsage` |
| `get-usage` | rate-limits payload from Claude `/usage` |
| `get-codex-usage` | `{limits: [...]}` containing renderable Codex rows only, or `{}` when disabled or unavailable |

#### Opt-in Codex usage (#1139)

Settings → Sessions → CLI Agents has **Show Codex usage**, defaulting to false
in `SETTING_DEFAULTS`. Saving applies it immediately. Only the global setting
with the boolean value `true` authorizes a read or request; project settings and
renderer IPC arguments cannot enable it.

`src/main/usage/codex-usage.js` reads `CODEX_HOME/auth.json`, falling back to
`~/.codex/auth.json`, only after that check. It sends the OAuth access token and
optional account id only to `https://chatgpt.com/backend-api/wham/usage`.
Redirects are refused. No credentials, raw response, account metadata or error
messages cross IPC; failures return `{}` and are never logged. This endpoint is
undocumented and can change; unavailable usage simply disappears.

A shared in-flight request covers status bar and Stats callers. An AbortController
bounds the request and body read to ten seconds. Missing credentials, malformed
responses, HTTP failures and timeouts back off for 30, 60, 120, 240 then 300
seconds; HTTP 429 also honors Retry-After (seconds or HTTP date), capped at one
hour. Success resets backoff. A saved setting change cancels the request and
invalidates its generation; changing the toggle does not bypass backoff.
The Settings panel applies usage only when the toggle changes, including saves
deferred by project deletion. Disabling removes Codex rows without fetching
either provider; enabling refreshes only Codex. The status bar tracks Claude
and Codex requests separately so neither provider replaces the other's rows.
Disabling invalidates pending Codex renders and keeps status-bar polling from
fetching Codex while the saved main-process setting may still be on. Opening
Stats also honors that renderer state. A missing Codex toggle does not apply
an undefined value to the renderer. After a deferred enabling write succeeds,
`flushDeferredProjectDeletionWrites` calls `refreshCodexUsage` for both surfaces
using the current renderer state, so a newer turn-off cannot be undone. Another
deferral or a failed write does not trigger that refresh.
The shipped gauge starts empty. `replaceQuotaRows` owns one `.quota-group`
per CLI, ordered Claude then Codex, and retains that group's node across
refreshes. A group contains one CLI heading and its quota bars; no empty
placeholder can keep the gauge visible. `data-runtime` belongs to the group.
`applyUsageHarnesses` hides whole groups using `disabledHarnesses`, loaded on
the first quota refresh and applied immediately by Settings on Save. A live
setting change wins over an in-flight initial settings read. Row replacement
uses default visibility without committing it while that read is pending;
a rejected read remains uninitialized so the next refresh retries. Settings
only applies CLI visibility when the saved patch contains an array, preserving
hidden groups if harness discovery failed. This changes only
footer visibility, not usage fetching or Stats. `showCodexUsage` keeps its
existing behavior on both surfaces, including deferred saves.
Status bar polling remains every five minutes; Stats has its own refresh button.

Codex rows reuse `buildQuotaBar` and `buildUsageSection`; Claude keeps its own
rows and error handling. Reset text shares `formatResetTime` from `claude-auth.js`.
Model-specific status-bar labels include the limit name. Over-limit percentages
remain visible; bar widths clamp to 100%.
For the footer, Codex rows also carry `windowMinutes` (the API's
`limit_window_seconds` divided by 60 and rounded to the nearest minute) and `model`.
Existing API labels remain available for tooltips and Stats. Tooltips add the
CLI prefix only when the label does not already start with that name.
The shared renderer `quotaWindowLabel` also rounds incoming minutes, then
maps 10080 minutes to `Week`, 300 to `5h`, whole days longer than 24 hours to
`Nd`, whole hours to `Nh`, and other positive durations to `Nm`; absent or
invalid durations read `Usage`. Claude's legacy `session` and `weekly*` kinds
provide durations when no explicit duration is supplied. Primary/secondary
position never supplies a duration or creates a missing window. Claude model
gauges keep the model name; Codex model gauges show name and window.
The footer stays 22px tall with non-wrapping groups and tabular percentages
reserved to at least four characters. Its group headings use `--text-label`;
tracks and fill colors retain the existing shared palette tokens. jsdom checks
both resolved palettes, not browser layout or pixel output.
The adapted endpoint contract, duration labels and per-model filtering credit
**Ali Basiri**, `doctly/switchboard`, commits `ee656523` and `3ca3d19d`.
The fork adds explicit consent, quiet failure, timeout, backoff, redirect refusal
and stale-result protection instead of porting upstream's raw error payloads.

Tests use disposable auth files and stubbed fetch; they never contact the
endpoint. The IPC test evaluates only the relevant extracted registration and
save handler, without importing Electron. Live endpoint compatibility and the
Electron bridge remain integration/CI verification boundaries.

### Search

| IPC | Args | Returns |
|---|---|---|
| `search` | `(type, query, titleOnly)` | FTS5 result rows. `type ∈ {session, subagent, memory, work-file, null}` |
| `rebuild-cache` | — | Force a full re-index (heavy) |

### Settings

`openSettingsViewer(scope, projectPath, folderKey, { section })` accepts an optional
fourth argument in the renderer, read through `arguments[3]` to preserve the
three-parameter declaration checked by the existing folder-key source test.
It does not add IPC. A valid explicit section wins
over `localStorage`'s `settingsSection:global` or `settingsSection:project`; an unknown
explicit id falls back to the remembered page, then `general` or `launch` if that
is also unknown. Storage failures are ignored. Global
pages are `general`, `sessions`, `keyboard`, `automation`, `remote`, `integrations`,
`archived`, `advanced`; project pages are `launch`, `project`.

The panel reparents existing rows into named regions before wiring their handlers.
Hidden pages remain in the DOM, preserving every field id and the one Save path.
The settings filter (`#sv-filter`) reads only `.settings-label` and
`.settings-description` text within each settings row on input, using a trimmed,
case-insensitive substring. `data-settings-filter-exclude` marks dynamic descriptions
and values: CLI availability/lock messages, version/update status, ActivityWatch
destination/URL/status, remote-host entries/status, and trace paths/entries.
Marked elements and their descendants are skipped; marked content nested in a
description is removed from a clone, leaving the live DOM untouched. Controls,
including Use global default, select option labels, shortcut bindings and host
buttons, contribute no search text. It hides unmatched rows,
empty groups and disclosure prose, then stacks matching pages in one scrolling
area. It does not build an index, read ids or control values, re-render controls,
or enter the dirty snapshot. No-match navigation items are dimmed but remain
operable; selection changes the remembered page without leaving filter mode.
Tab from navigation enters a visible matching control, or Save when there are no
results. Escape in the filter clears it, consumes the key and keeps focus; clearing
restores the selected page and all its groups. Reopening starts with an empty filter.
Archived is excluded because it manages objects with its own filter and selection;
the settings filter never modifies that manager's DOM. Project identity and Danger
zone have no settings rows and are excluded too. The existing ResizeObserver remains
the only narrow-layout trigger; the filter stays above the horizontal nav strip.
DOM regressions and CSS contracts live in `test/dom-settings-nav.test.js`.
The Archived projects manager is documented above. This project shows the identity
from the same path-and-folder-key project lookup used by deletion, performed after
shell-profile loading finishes: name, full path, host label, folder key and cached
top-level non-terminal session counts (including archived sessions). Both counts
filter flat cache rows with `!s.parentSessionId && s.type !== 'terminal'`.
There is no shared predicate: the parent exclusion matches `renderDefaultStatus`
in `public/app.js` and the sidebar count in `public/sidebar.js`; the terminal
exclusion matches the background projection in `public/app.js`. The sidebar
additionally excludes archived rows for its active count. Host labels fall back
to the alias when `remoteHostLabel` is unavailable.
Without a cached project, supplied path/folder identity remains visible and counts
read Unavailable. Values use textContent. Archive Project and Delete Project move
into its Danger zone before wiring, retaining their ids, deletion busy keys and
handlers. Archive failures use the OK-only `appAlert` adapter from
`public/app-dialogs.js`. The footer contains only Cancel and Save Settings. Identity wraps in
the existing ResizeObserver-driven narrow layout; no layout mode is added.
The new shell adds no trigger controls or archive APIs.
The host-list and refresh defaults now live in `SETTING_DEFAULTS`.

Each page scrolls independently; navigation and the footer stay outside that
scroll. A viewer ResizeObserver selects the horizontal navigation below 720 px;
there is no layout preference. It disconnects on close or reopen. Navigation uses
roving tabindex, arrow keys in both layouts, Home/End and Tab into the selected page.
The active item scrolls into view when the narrow strip opens or changes selection.

The unsaved counter compares control values with their rendered `data-initial`
values, plus snapshots of the host list and shortcuts; live reporting/debug
switches are excluded. Save captures the submitted snapshot before awaiting any
IPC, so later edits remain dirty; rejected host rows remain dirty too. The
Save button is disabled during the request, so completions cannot overtake each
other; fields stay editable. The SDK filter and IDE notice compare against the
last applied values on repeated Saves, separately from the immutable `fieldValue`
bindings inspected by the defaults test. Save writes normalized numbers and
trimmed text back to controls whose values still match the submitted snapshot;
the saved baseline uses normalized values even when later edits are retained.
Project fields saved with Use global default use an explicitly defined global
value (including `null`), otherwise `SETTING_DEFAULTS[field]`, while preserving
edits made during Save. The display and baseline both map null text values to
empty strings, checkbox values to booleans, and legacy browser `managed` to `off`,
matching initial rendering. When no host is rejected, the host snapshot still
matches the pre-await submission, and normalization changed the submitted list,
Save replaces the editor rows and host baseline with a copy of the stored host
objects: trimmed aliases and labels, with empty-alias rows removed. The editor
does not share mutable objects with deferred persistence or app-wide labels.
An unchanged host list retains its DOM, including completed and pending Check
host results, across unrelated Saves. Rejected
rows and host edits made during Save remain visible and dirty.
Save refreshes those snapshots, uses the
existing `saved` class for 1.5 seconds and stays open. Cancel still discards
without a prompt.
Explanatory reporting/diagnostics prose uses native details/summary disclosure.
Rows left outside the explicit move lists retain their original group under
Advanced (global) or Launch (project). The reporting row keeps its bottom
corners and spacing before the disclosure.
See `test/dom-settings-nav.test.js` for the DOM contract.

| IPC | Notes |
|---|---|
| `get-setting` / `set-setting` / `delete-setting` | Generic key/value over `settings` table |
| `get-settings-by-prefix` | `(prefix)` accepts only the non-empty string `continuationChoice:` and returns an object of matching keys and values; other prefixes throw before reading settings. Bridge: `getSettingsByPrefix`. Used to load continuation choices before restore and reload. |
| `get-effective-settings` | `(projectPath)` — resolves global + project overrides |
| `get-harnesses` | `()` → `[{ id, label, available, enabled, isDefault }]` for every registered CLI adapter; `enabled` reflects `global.disabledHarnesses`. Bridge: `getHarnesses`. See cli-harnesses.md ("Picker, toggles and settings"). |
| `get-harness-models` | `(runtime)` → the adapter's model catalog (`[{ slug, label, efforts, defaultEffort, visible }]`, Codex reads `$CODEX_HOME/models_cache.json`), `[]` when it has none. Bridge: `getHarnessModels`. |
| `get-shell-profiles` | Configured shell list |
| `get-schedule-creator-command` / `create-schedule-session` / `run-schedule-now` | Schedule integration |

**One table of defaults.** `SETTING_DEFAULTS` lives in `public/setting-defaults.js`,
a dual-mode file: `main.js` requires it, `index.html` loads it as a classic
script, so both processes resolve a missing key to the same value.
`get-effective-settings` returns project value → global value → that table, and
`settings-panel.js`'s `fieldValue()` resolves in the same order — the panel
therefore displays what a session will get. No renderer file carries a default
of its own; `test/setting-defaults.test.js` fails if one appears.

An explicitly saved `null` (permission mode "Default", which omits
`--permission-mode`) is a value, not an absence: the merge overrides on
`!== undefined` only, so it is never promoted to the table's `'auto'`.

Browser compatibility: `browserMode` defaults to `off`. The shared
`normalizeBrowserSettings` returns a copy and normalizes each stored scope
before main or the panel merges it. An explicit valid mode wins over legacy
`chrome`; exact legacy true maps to `claude-in-chrome`, false to `off`, and
an absent browser choice stays absent so it inherits. Invalid modes, including
null, report a diagnostic and become explicit Off. Main warns once per stored
scope and invalid JSON value for the lifetime of the process, including across
changes back to a previously diagnosed value. Other settings retain
their existing null semantics. Saving either scope removes `chrome`; global
save retains unrelated keys, while project save keeps only overridden fields.
Use global removes the project browser override. Reads never write settings.

Global/project settings and New/Resume dialogs offer Browser: Off / Claude in
Chrome on every platform. Managed is recognized for forward compatibility but
is not offered or activated. A stored Managed choice displays Off in
these controls without rewriting storage on open; an explicit save/launch
uses the displayed choice. Settings affect subsequent launches. Fork, restore,
ordinary open and the interactive schedule creator use the shared default
resolver. There is no managed browser lifecycle, browser IPC or MCP handoff.

`receiveBetaVersions` is global-only in the panel and defaults to false in
the shared table. `set-setting('global', ...)` re-reads the saved row and
applies its channel to `autoUpdater.allowPrerelease` immediately. Startup
applies it before scheduling update checks and logs `stable` or `beta`.
Automatic downloads remain controlled separately by `autoUpdate`; manual
checks use the same channel. No downgrade is enabled because the SQLite cache
only migrates forward. Release promotion changes GitHub's pre-release flag
without changing the version or binary, so the installed version alone cannot
reliably identify a beta for the optional About indicator.

### File panel (IDE mode)

| IPC | Args |
|---|---|
| `read-file-for-panel` / `save-file-for-panel` | Arbitrary file IO inside the user's projects |
| `resolve-terminal-paths` | `(sessionId, texts[])` — may the panel open these paths? One call carries every unknown candidate on a hovered line, at most 64. Relative text resolves against the session's own cwd, main-side. Returns one `{ok: true, path}` or `{ok: false, reason}` per input; reads bytes, returns none. Backs the terminal link provider — see `.ai/contexts/terminal-path-links.md` |
| `watch-file` / `unwatch-file` | fs.watch wrapper, emits `file-changed` event. The registry is keyed by resolved path and is released either one path at a time by `unwatch-file`, or wholesale by `closeAllFileWatchers()` in the window-`closed` handler, alongside `changesWatchers.closeAll()` and the subagent watches. A closing window sends no `unwatch-file`, so that teardown is what bounds these descriptors to the window's lifetime; it swallows a `close()` that throws, since a handle whose file is already gone must not strand the rest of the teardown. |

### Changes panel (issue #251)

A git-status view in the same right-hand file panel, for local and remote
sessions alike; a local session's changed file is editable in place. Full
design (parser, runner, quoting, cwd resolution, refresh triggers, editing):
`.ai/contexts/changes-view.md`. User-facing: `docs/changes-view.md`.

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `git-changes-status` | `(sessionId)` | `{ok, kind, branch, files, totals, untrackedCollapsed} \| {ok:false, reason?, error}` | `git status --porcelain=v2 --branch -uall` + `git diff --numstat` + `git diff --cached --numstat`, merged by `git-changes.js`'s `mergeChanges()`. A `-uall` run too large for the transport falls back to git's default untracked mode and reports `untrackedCollapsed: true`. `kind` is `'local'` or `'remote'` — the renderer decides from it whether the panel is editable. A cwd with no work tree comes back `reason: 'not-a-repo'` — the panel's plain-language "not a git repository" line; every other failure carries a bounded message and no reason, including a repository git refuses to open. Telling the two apart is `git rev-parse --is-inside-work-tree` plus a filesystem walk, never a message match — see `.ai/contexts/changes-view.md` ("Not a repository"). |
| `git-changes-diff` | `(sessionId, filePath, staged, untracked)` | `{ok, content, truncated, added, deleted} \| {ok:false, error}` | `git diff [--cached] -- <filePath>`, or `git diff --no-index -- /dev/null <filePath>` when `untracked`; capped at 512 KB. `added`/`deleted` are filled for an untracked file only — see `.ai/contexts/changes-view.md` ("Untracked files"). |
| `git-changes-file` | `(sessionId, filePath, {staged})` | `{ok, original, current, version, binary, truncated} \| {ok:false, error, reason}` | The content pair behind the editable diff: `git cat-file blob :<path>` (or `HEAD:<path>` when `staged`) and the working-tree file, both LF-normalised and strictly UTF-8. `version` is an opaque token the renderer hands back on save. Local sessions only. `reason` is one of `invalid-path`, `repo`, `missing`, `outside`, `symlink`, `hardlink`, `git-dir`, `sensitive`, `not-a-file`, `binary`, `too-large`, `encoding`, `mixed-eol`, `git`, `remote`. |
| `git-changes-save` | `(sessionId, filePath, content, version)` | `{ok:true, version} \| {ok:false, error, reason}` | Writes the working-tree file the guard resolved, re-applying its line endings, and returns the token for the next save. Refused with `reason:'stale'` when the file changed since `version` was issued, and with `invalid-version` when no token is passed. Local sessions only; never creates a file. |
| `git-changes-watch` / `git-changes-unwatch` | `(sessionId, filePath)` | `{ok:true} \| {ok:false, error, reason}` | `fs.watch` on the path the same guard resolves, through `git-changes-watch.js`'s registry, keyed by session + repo-relative path. Emits `git-changes-file-changed(sessionId, filePath)` (debounced 300 ms) — the repo-relative path, never the resolved one. A `rename` event re-arms the watch, since an atomic replacement otherwise silences it. |

`filePath` is repo-relative in all four. No absolute path crosses this
boundary in either direction: the session's cwd is re-resolved main-side on
every call, and the absolute path built from it is used and discarded there.

### Background agents (see `.ai/contexts/bg-agents.md`)

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `get-bg-agents` | — | `{roster, daemonReachable}` | Arms the watchers on first call, re-subscribes the `bg-agents-changed` push on every call, then reconciles through `claude agents --json --all`. Handler in `bg-agents-ipc.js`. |
| `check-bg-agent-verb` | `(verb, id)` | `{ok, error?}` | Check only: `stop` \| `respawn` \| `rm`, id validated against `JOB_ID_RE`. Shares the execution guard; no CLI call or roster reconcile. Stop passes through unknown or hosted state. Bridge: `checkBgAgentVerb`; renderer Stop/Delete await it before confirmation and display refusals in the detail. Execution checks afresh after confirmation. |
| `bg-agent-verb` | `(verb, id)` | `{ok, error?}` | `stop` \| `respawn` \| `rm`; id validated against `JOB_ID_RE`; `respawn`/`rm` refused on a live (`working`/`blocked`) job. |
| `dispatch-bg-agent` | `(fields)` | `{ok, id?, error?}` | `claude --bg …` in `fields.cwd`. |
| `bg-agent-live-job` | `(sessionId)` | `{known, job} \| {known:false, reason}` | `liveJobCheck`; `stopBeforeArchive` refuses on a live job or an unknown answer. |
| `restore-background-job` | `(sessionId, {attachOnly?}?)` | `{action:'attach', sessionId, jobId} \| {action:'respawned-not-attached', jobId} \| {action:'refuse', reason, jobId?, recovery?, missing?}` | Scoped to saved `bg: true` working-set members; S1a classification, checked respawn for proven-dead workers, then a live bg descriptor within 15 s. Unknown refuses; stopped offers explicit Respawn. `missing: true` releases the saved background entry for a later ordinary guarded resume. `attachOnly` never respawns. Bridge: `restoreBackgroundJob`. |

`open-terminal` accepts `sessionOptions = {type: 'attach', jobId, cwd}` and runs `claude attach <jobId>`; `stop-session` on such a session detaches (`{ok, detached: true}`).

### Touched files (issue #309)

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `session-touched-files` | `(sessionId)` | `{ok, files, unresolved, omitted, coverage} \| {ok:false, reason?, error}` | The files the session's file tools touched, from its transcript and its subagents'. `files` rows are `{path, state, openable, tools, count, sources}` with `state` one of `present`, `gone`, `unreadable`, `refused`, `not-file`; `unresolved` rows carry the raw text and a reason, never a `path`. `reason` may be `no-transcript`; local and mirrored remote sessions are accepted and a `sub:` id is refused. Remote disk failures keep rows `unknown`, not `gone`. Full design: `.ai/contexts/touched-files.md`. |

This is the one handler whose *output* is a list of absolute paths taken from
attacker-influenced data. Listing is not opening: the renderer opens a row
through `read-file-for-panel` and its guards, never through this IPC. A remote
row supplies `{editor: true, sessionId}`; main resolves the remote Changes
target and uses `readRemoteTouchedFile`, with a 2 MiB byte cap, binary and
strict UTF-8 guards, canonical credential/metadata checks and read-only output.
An unknown remote target never falls back to local disk IO.

### Misc

| IPC | Notes |
|---|---|
| `open-external` | Opens https:// URLs in OS browser |
| `open-main-log` | No arguments; opens the main-selected, validated application log path and returns `{ok, error?}`. |
| `open-path` | Resolves a non-empty string path, applies the extension allowlist when `viewer` is set, then `isSensitivePath`, before `shell.openPath`. Returns the OS error string (empty on success), or `undefined` on refusal. |
| `show-item-in-folder` | Requires a string absolute path, resolves it, checks raw Git segments, native-realpath Git segments, `isSensitivePath`, then regular-file status, in that order, before `shell.showItemInFolder`. Returns `{ok:true}` or `{ok:false, reason}` including IO failures. |
| `clipboard-write-text` | Main-process clipboard write (Wayland fix, PR #18) |
| `get-app-version` | From package.json |
| `whats-new-startup` / `whats-new-dismissed` | The What's new dialog: the `CHANGELOG.md` sections to show on startup (or `null`), and recording the running version as `lastSeenVersion` when it closes. Help → What's new sends `show-whats-new` with the running version's section. See `docs/changelog.md` |
| `updater-check` / `updater-download` / `updater-install` | electron-updater |
| `read-clipboard` / `clipboard-has-image` | Main-process clipboard reads (text; whether an image is on it) |
| `toggle-full-screen` / `popup-app-menu` | The frameless window's strip and ☰ menu — see window-frame.md |
| `get-indexing-state` | `{finished}` — whether the first index pass is done; `indexing-finished` pushes the same news. See session-cache.md |
| `get-last-known-projects` | `{defaultProjects, allProjects, savedAt}` or `null` — the last accepted paired `get-projects` reply persisted by main, for the provisional sidebar at startup. See "Last known projects (#1125)" |
| `get-task-snapshots` | The task registry's snapshots for live sessions; pushes follow on `task-snapshot` / `task-rekey`. See session-state.md |
| `get-activity-trace-state` | Debug-mode state for Settings → Diagnostics; `activity-trace-state` pushes changes. See `docs/activity-trace.md` |
| `get-activity-reporting-state` / `set-activity-reporting-enabled` | ActivityWatch reporting — see activitywatch.md |
| `get-project-archive-plan` / `reenable-project-schedules` / `dismiss-schedule-reenable-offer` | Archive project planning and the schedule re-enable offer — see session-cache.md |
| `remote-hosts-apply` / `remote-hosts-refresh` / `remote-host-refresh` / `remote-host-enrol-check` / `remote-launch-session` / `remote-send-prompt` | Remote hosts — see session-cache.md and `docs/remote-hosts.md` |

### Send (fire-and-forget, renderer → main)

| IPC | Notes |
|---|---|
| `terminal-input` | Forward keypress to PTY |
| `terminal-resize` | Resize PTY columns/rows |
| `close-terminal` | Renderer signals tab closed |
| `mcp-diff-response` | Diff accept/reject from MCP IDE mode |
| `activity-trace` | Renderer probe → the trace file. Registered **only** when `SWITCHBOARD_ACTIVITY_TRACE` is set (see below) |
| `activity-focus` / `activity-titles` | Focused session and running-session titles for ActivityWatch — see activitywatch.md |
| `updater-close` | The updater window closed |
| `main-error-notices-ready` | No arguments; active renderer has installed the main-error listener. Arms delivery and flushes pending errors. |
| `main-error-notices-dismissed` | `ids: string[]` (at most five strings); only the active renderer may send it, after the user dismisses the group. A payload of the wrong type or length is rejected whole; otherwise main forgets the ids it still knows and ignores unknown or evicted ones, so concurrent deliveries of other ids survive. |
| `exit-background-cancel` / `unsaved-check-phase` / `unsaved-pong` / `unsaved-dialog` / `unsaved-ready` / `unsaved-check-ack` / `unsaved-check-result` / `unsaved-check-reason-done` | The exit flow's unsaved-edits handshake, handled in `unsaved-guard.js` — see window-frame.md |

### Events (main → renderer)

`terminal-data`, `session-detected`, `process-exited`, `remote-resize-allowed`, `terminal-notification` (`sessionId, message, kind` — `kind` is the session harness's `classifyNotification` verdict, see cli-harnesses.md), `cli-busy-state`, `session-forked`, `subagent-spawned`, `subagent-completed`, `subagent-watch-event`, `projects-changed`, `status-update`, `indexing-progress`, `file-changed`, `mcp-open-diff`, `mcp-open-file`, `mcp-close-all-diffs`, `mcp-close-tab`, `updater-event`, `main-process-error`, `show-whats-new`, `session-transcript-activity`, `bg-agents-changed`, `bg-handoff-notice`, `git-changes-file-changed`, `remote-activity`, `activity-trace-state`, `indexing-finished`, `task-snapshot`, `task-rekey`, `mcp-status`, `full-screen-changed`, `exit-background-progress`, `exit-attempt-invalidated`, `exit-flush`, `unsaved-check`, `unsaved-check-reason`, `unsaved-ping`

`onProjectsChanged(callback)` forwards the main-side `{ cause: string[] }`
payload. Schedules filters these causes before queuing a bounded debounce;
see [schedule-runner.md](schedule-runner.md), "Schedules tab". Other subscribers
may ignore the payload.

`remote-resize-allowed(sessionId)` is emitted once when a live remote attach
promotes from shared to solo. `preload.onRemoteResizeAllowed` forwards the id
to the renderer, which enables solo sizing and schedules a fitted resize.
Initial solo attaches and failed promotions emit no event; there is no reverse
notification. See `.ai/contexts/terminal-refresh.md`.

`session-transcript-activity` and `remote-activity` (see
`.ai/contexts/session-cache.md`, "Remote hosts — busy spinner")
each carry one of two payload shapes on the same channel — a subagent write is
never a second event (issue #247): `{ sessionId, at }` for a top-level
transcript, or `{ parentSessionId, agentId, at, kind: 'subagent' }` (plus
`alias` for `remote-activity`) when the write is a subagent leg attributed to
its parent. See `.ai/contexts/subagent-observability.md` ("Attribution across
sources") for the attribution and `.ai/contexts/session-state.md` for how each
adapter applies it.

- **`indexing-progress`**: `{coldStart, current, total, sessionsSoFar, done, error?}`. Fired only from `populateCacheViaWorker()` when the `initial_scan_complete` marker was absent at call time (a genuine first launch, a post-migration reset, or the resume of an interrupted first scan) — never on a routine warm-start rebuild. Throttled to ~4 events/s; the first event and the final `done:true` always pass. `done:true` with `error` means the scan failed and the renderer shows the failure in the banner instead of hiding it. Drives the renderer's dismissible first-run banner (`public/app.js`'s `updateIndexingBanner`); see `.ai/contexts/session-cache.md`.
- **`session-transcript-activity`**: `{sessionId, at}`. Fired from inside the raw `fs.watch(PROJECTS_DIR, ...)` callback in `startProjectsWatcher()` — deliberately **not** routed through the debounced `flushChanges()` / `notifyRendererProjectsChanged()` path that also lives there, so it reaches the renderer well before the 500ms debounce plus the cache refresh it triggers. Only fires for a top-level session transcript (`<folder>/<sessionId>.jsonl`, two path segments — a subagent leg is out of scope, see `.ai/contexts/session-state.md` ports table) whose sessionId has no live PTY in `activeSessions` (`sessionHasPty()`, main.js — the OSC busy/attention path already owns a PTY-backed row). Coalesced to at most one emission per second per session by `local-transcript-activity.js`'s `createLocalTranscriptTracker()`. Feeds `public/local-transcript-adapter.js` (`window.api.onSessionTranscriptActivity`) — the `local-transcript` adapter in `.ai/contexts/session-state.md`.

## Invariants

- **No `nodeIntegration` in renderer**. The renderer can only call what's in `window.api`. `contextIsolation: true` is mandatory in BrowserWindow options.
- **Every IPC must validate its arguments** at the main-side handler. The renderer is trusted-ish (single user, single window) but a compromised renderer should not be able to escape the user's working directories.
- **Path-touching IPCs (`read-file-for-panel`, `read-memory`, `run-schedule-now`, `delete-worktree`, etc.) MUST guard their paths, and the guard must resolve on disk, not just `path.resolve()`**. `path.resolve()` normalises `..` but does not follow symlinks — a path can look contained by every string check and still open a file somewhere else through a symlinked directory. The shared primitive is `resolveOnDisk()` in `resolve-path-on-disk.js` (realpath, or `null` when nothing exists there yet); it is called *inside* the guards, not duplicated at each call site:
  - `isSensitivePath` / `resolveAllowedMemoryPath` (+ its boolean form `isAllowedMemoryPath`) / `isKnownProjectRoot` (`ipc-path-validator.js`) — denylist, allowlist, and exact-match-against-known-projects, used by the memory, file-panel and worktree handlers. `resolveAllowedMemoryPath` returns the resolved path, not a boolean, and callers that go on to read/write MUST use that returned value for the operation — a caller that re-resolves its own literal path afterwards reopens a TOCTOU (checked path and used path can diverge if a symlinked ancestor is swapped in between). See `resolve-path-on-disk.js` for the documented gap when the target does not exist yet.
  - `resolveDeletionTargets` (`delete-session-target.js`) — session deletion, the first handler to need this and the source the primitive was extracted from.
  - `resolveRunNowTarget` (`run-schedule-now-target.js`) — `run-schedule-now`'s shape + allowlist check, run before any read or spawn. Four duties, and which path each one answers for matters: the **directory shape** (`.claude/commands` parents) is checked on the *requested* path, because what makes a file a schedule is the directory that lists it, and a versioned configuration is linked in there from a repo elsewhere on disk; the **filename** is checked on the requested path *and again on the disk-resolved target*, so the listing directory decides where a schedule may be linked from but never what it may point at; `isSensitivePath` refuses a resolved target in a credential location; and `isAllowedMemoryPath` runs on the disk-resolved file **and** on the disk-resolved project root the run is spawned in, which with a linked-in schedule is not derivable from the file. Dropping any one of the four is caught by `test/run-schedule-now-target.test.js`.
  A handler that reads *content* back to the renderer (file panel, memory) and a handler that only decides *whether to run a command* (`run-schedule-now`) both need a guard, and neither one is safe with `path.resolve()` alone.
- **Trust boundary is the contextBridge call**. Anything passed across must survive structured-clone serialization. No functions, no DOM nodes, no class instances — only plain JSON.
- **Async handlers return promises**. Renderer uses `await window.api.foo(...)`. Throws cross the boundary as rejected promises; return `{ok, error}` if you want graceful failure handling on the renderer side.
- **Never call a method on `session.pty` directly.** Go through `src/main/terminals/pty-ops.js` (`resizePty` / `killPty` / `writePty`, or the generic `withPty`). See "PTY operations race the exit" below.

### IPC path-guard inventory

Main applies the `open-path` extension allowlist only when the caller sends
`viewer`. It guards against a renderer bug, not a hostile renderer, which can
omit the flag. The terminal menu's unflagged call retains its existing behavior
(#1025 spec section 3).

Every handler that takes a renderer-supplied path or derives a spawn location from one, and what guards it as of this pass:

| IPC | Guard | Kind |
|---|---|---|
| `set-schedule-enabled` | `listScheduleFiles(await scheduleProjects().list())` exact path equality, boolean argument, unlinked file and readable front matter; skip missed catch-up before enabling | current registry listing + disk-resolved link guard |
| `delete-schedule-file` | `listScheduleFiles(await scheduleProjects().list())` exact path equality, then `scheduleFileUnlinked(projectRoot, filePath)` immediately before file operations; linked files return `linked file: edit it at its source` | current registry listing + disk-resolved link guard |
| `create-schedule-file` | `projectPath` must match the awaited schedule registry by `normalizeProjectPath`; reject archived projects; require `realpath(commandsDir) === join(realpath(projectPath), '.claude', 'commands')`; target filename comes only from a validated slug; publish by `linkSync` without overwriting | current registry + realpath directory guard + exclusive publication |
| `read-memory` / `save-memory` | `resolveAllowedMemoryPath` (read/write the returned path, not the caller's own re-resolved one) | disk-resolved allowlist |
| `get-memories` (the list, and the FTS bodies it indexes) | `acceptMdFile` (`scan-md-files.js`) applies `isSensitivePath` itself and the `isAllowedMemoryPath` predicate `get-memories` passes in; `scanMdFiles` is the directory-wide form of it, and the project-root `CLAUDE.md`/`GEMINI.md`/`agents.md` go through it by name | disk-resolved denylist + allowlist — a listed file is read twice more downstream, once by `read-memory` behind `resolveAllowedMemoryPath` and once by the FTS indexer behind nothing at all, so the guard belongs on the list. The denylist is not the caller's to choose: containment in an allowed project root says nothing about a cloned repo's own `.ssh`/`.env` |
| `open-main-log` | Main chooses electron-log's path; requires a string absolute path and `!isSensitivePath` before `shell.openPath`. | no renderer-supplied path; disk-resolved denylist |
| `open-path` | Non-empty string and `path.resolve`. With `opts.viewer`, refuse Windows colons after the drive prefix (ADS); require both the requested and native-realpath target extensions in the [viewer allowlist](viewer-panel.md#local-file-actions-1203), case insensitive; apply `isSensitivePath` to both paths and require `fs.statSync(real).isFile()`. Open the canonical target; any validation error refuses. Unflagged calls retain the sensitive-path guard and resolved-path opener. | caller-selected allowlist + disk-resolved denylist + regular-file and ADS checks |
| `show-item-in-folder` | String and `path.isAbsolute`, `path.resolve`, raw `hasGitSegment`, `hasGitSegment(fs.realpathSync.native(resolved))`, `isSensitivePath`, then `fs.statSync(resolved).isFile()`, before `shell.showItemInFolder`. IO failures return `{ok:false, reason}`. | shape + raw/canonical Git metadata refusal + disk-resolved denylist + regular-file check |
| `read-file-for-panel` / `save-file-for-panel` / `watch-file` | Local: `isSensitivePath`. Remote panel reads resolve the session target and guard the literal and canonical host path. Saves refuse a resolved remote target and any path already opened through the remote panel route, even without renderer options. | disk-resolved denylist + main-side remote write refusal |
| `resolve-terminal-paths` | `resolveTerminalPaths` / `resolveTerminalPathTarget` (`src/main/terminals/terminal-path-target.js`, async, 8 checks in flight): the session cwd for a relative path, existence, then `isSensitivePath` on the resolved path, then regular-file-ness, `PANEL_FILE_MAX_BYTES` and a NUL-byte sniff | disk-resolved denylist, strictly narrower than `read-file-for-panel` — its whole input is untrusted terminal output, and its answer decides whether a path is even offered as a link. Existence is tested before the denylist because most candidates on a line of prose are not files; a path that exists still passes the denylist before anything else is decided. A remote session is refused outright, and so is one whose working directory cannot be resolved — otherwise an unresolvable remote would fall back to stat-ing the local disk. A panel shell (`panelFor`) resolves through its owning session |
| `check-delete-worktree` / `delete-worktree` / `worktree-status` | Shared `checkDeleteWorktree`: `WORKTREE_PATH_RE` (shape) + `isKnownProjectRoot` (disk-resolved exact match) | shape + disk-resolved allowlist |
| `delete-session-preview` / `delete-session` | `deleteSessionGuard` then `resolveRowDeletionTargets` (`delete-session-target.js`) | full live/background/unknown-state guard + disk-resolved containment |
| `run-schedule-now` | `resolveRunNowTarget` (`run-schedule-now-target.js`), which composes directory shape (requested path) + filename shape (requested **and** resolved) + `isSensitivePath` + `isAllowedMemoryPath` on both the resolved file and the resolved project root | disk-resolved allowlist + denylist — **the only handler in the app that both reads a file and spawns a process from a renderer-supplied path; the file's content becomes a prompt sent to the model, so the resolved target is constrained, not just its location** |
| `read-activity-trace-file` / `delete-activity-trace-file` | `resolveTraceFilePath` (`activity-trace.js`) | ad hoc string (directory + basename pattern), **not disk-resolved** — narrower surface (one generated file family) lowers the stakes, not migrated |
| `add-project` / `remap-project` | none on the probe (`fs.statSync`/`fs.existsSync`/`fs.lstatSync`); the actual write is confined through `encodeProjectPath` | existence/type oracle only — inherent to the feature (both accept an arbitrary disk location by design), not cheaply fixable without breaking it |
| `open-terminal` (`preLaunchCmd`) | `validatePreLaunchCmd` (`src/main/terminals/pre-launch-cmd-guard.js`) | not a path guard — a character allowlist on a raw-shell-by-design string (the documented prefix's character set plus its analogues: `env VAR=val`, `doas`, an absolute binary path); a denylist here proved incomplete (process substitution `<(...)`/`>(...)` needed none of the blocked characters), so this is closed by construction instead of by enumeration. Known cost: bare `$VAR` expansion and quoted arguments, both previously accepted, are now refused. The real-bash test of the documented shape spawns `bash -l -c` without `-i`: it asserts that the validated prefix runs as an ordinary command line, which does not depend on interactive mode, and `-i` with no TTY is what prints "cannot set terminal process group" (job control) next to the intermittent status 2147483652; the intermittent status is handled in `test/spawn-retry.js` (#342) |
| `read-session-jsonl` / `read-subagent-jsonl` / `start-subagent-watch` / `create-schedule-session` | none directly — path is derived from a SQLite key or built via `encodeProjectPath`, not taken verbatim from the renderer | out of scope for a path guard; flag if a renderer-controlled string is ever found reaching the derivation unencoded |
| `git-changes-file` / `git-changes-watch` / `git-changes-unwatch` | `isSafeRevPathOperand` + `resolveTargetInsideRepo` (`git-changes-file.js`): the repo root and git directories come from `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir`, a symlink at the target is refused before anything follows it, and **every remaining check runs on the disk-resolved path** — containment in the root, no `.git` segment, nothing inside a git directory, `isSensitivePath`, regular file | shape + disk-resolved containment + denylist — the operand is `<rev>:<path>`, a *revision*, not a pathspec: `--literal-pathspecs` does not reach it and `--` cannot separate it, so it carries its own guard. See `.ai/contexts/changes-view.md` ("Editing a changed file") |
| `git-changes-save` | `isSafeRepoRelativePath` + the same `resolveTargetInsideRepo`, plus a version token that must still match the bytes on disk; the write runs on the path the guard returned, never on a re-derived one | shape + disk-resolved containment + denylist — **the only write handler in the app whose entire input is a relative path from the renderer**, so containment is the guard, not an afterthought; `save-file-for-panel` next to it has none (it takes an absolute path and checks only `isSensitivePath`) and is not the precedent to copy here |
| `session-touched-files` | Remote: validated alias and mirror folder, POSIX absolute paths without control characters or `..`, canonical credential/metadata guards on the host, one 64 KiB/20 s disk batch. Local: `isValidChangesSessionId` (no subagent shape), a plain-folder-name check on the cached folder, `resolveTouchedPath` (absolute, no UNC / `\?\` / device form, no control character; relative only against a `verifiedTranscriptCwd`), `isSensitivePathAsync` on every resolved path before its `stat` | shape + disk-resolved denylist — **stat-only**: a path that fails the denylist is listed `refused` and never stat-ed; nothing is read. The click goes to `read-file-for-panel` |
| `git-changes-diff` | `isSafeGitPath`, or `isSafeNoIndexPath` + containment when `untracked` (`git-changes-runner.js`) | a git pathspec relative to an arbitrary (possibly remote) cwd; see `.ai/contexts/changes-view.md` ("Quoting rule") for why this is a denylist, not an allowlist. The untracked variant is a real filesystem operand of `git diff --no-index`, which has no repository-boundary check of its own: on top of the syntactic guard it is resolved with `realpath`/`stat` against the resolved cwd (local) or checked against `git ls-files --others` (remote), git receives the guard's operand rather than the caller's, and the returned diff must name that same path in its `diff --git` line — see "Untracked files" in the same doc |

### Sensitive-path candidates

`isSensitivePath` and `isSensitivePathAsync` (`ipc-path-validator.js`) share one candidate builder, `sensitiveCandidates` / `sensitiveCandidatesAsync` (`resolve-path-on-disk.js`), and test the denylist against every spelling it returns:

- the literal path, and the same path with a Windows `\\?\` / `\\.\` prefix removed (`\\?\UNC\host\share` becomes `\\host\share`);
- the JS realpath **and** the native realpath. They diverge on Windows: the JS walker keeps 8.3 short names (`SSH~1` for `.ssh`) and throws `EISDIR` on a `\\?\` path through a junction, while `fs.realpath.native` expands the short name and resolves the junction. Either one alone misses a spelling the other catches, so both are tried and every result is matched;
- on win32, the same path with trailing dots and spaces removed from each segment (`.ssh.\id_rsa`, `.netrc `): Win32 normalisation drops them, so `shell.openPath` reaches the real file while the literal string matches nothing. Not applied to `\\?\` paths, which Win32 does not normalise (the `\\.\` device prefix is normalised, so those are trimmed);
- when nothing exists at the path yet (a file about to be saved), the first existing ancestor — found with one `lstat` per level going up, then resolved the two ways — with the missing tail re-attached, otherwise `SSH~1\new-key` would pass because there is nothing to resolve.

Fail closed: if **either** realpath fails for a reason other than `ENOENT`/`ENOTDIR` (`EACCES`, `EPERM`, `ELOOP`, ...), or an ancestor cannot be `lstat`ed, the path is treated as sensitive even when the other realpath succeeded: the one that failed may have been the one that sees the credential location. `resolveOnDisk` / `resolveOnDiskAsync` are unchanged and stay on the JS realpath (the allowlist and containment checks compare against it). The tests are in `test/sensitive-path-windows.test.js`; the 8.3 cases skip, with a stated reason, on a volume that generates no short names.

### Non-obvious behaviors

- **`preload.js` is the *single* surface the renderer sees**. If you add `ipcMain.handle('xyz', ...)` but forget to add `xyz: () => ipcRenderer.invoke('xyz')` in preload, the renderer can't call it. Symptom: `window.api.xyz is not a function`.
- **Webcontents `send` events vs `invoke`**: `invoke`/`handle` is request-response (returns a promise). `send`/`on` is fire-and-forget (no return). Pick based on whether the caller needs the result.
- **`webUtils.getPathForFile(file)`** is the only way to get the absolute path of a drag-and-dropped file in Electron 28+. Exposed at `window.api.getPathForFile`.
- **Updater events use a single `onUpdaterEvent(type, data)` callback** for all 5+ event types — different from the per-event onSubagentSpawned/Completed pattern. Inconsistency tax.

### PTY operations race the exit

`terminal-resize` accepts `(sessionId, cols, rows, refresh)`. The preload
`resizeTerminal` takes `{refresh: true}` as its optional fourth argument and
sends the boolean in a single message. The main resize handler owns the nudge
and final-size restoration; see [terminal-refresh](terminal-refresh.md).

`session.exited` is set from `ptyProcess.onExit`, which fires on a later tick
than the child's actual death. So `if (!session.exited) session.pty.resize(...)`
is a check-then-act: node-pty can still throw `Cannot resize a pty that has
already exited` between the test and the call. In a `ipcMain.on` handler that
throw is fire-and-forget — nothing awaits it, so it surfaces as an uncaught
exception in the main process and Electron pops the "A JavaScript error occurred
in the main process" dialog at the user.

The path that produced it: the user closes a session → the PTY exits → the
renderer re-lays out the remaining terminals and emits one `terminal-resize` per
tile, including for the session that just went away.

`src/main/terminals/pty-ops.js` is the single place a session PTY is touched. It keeps the liveness
check as a cheap fast path but wraps the call, the way `trigger-watcher.js`
already reasoned about its writes ("an exit between the liveness probe and the
write is bounded by the try/catch on the write"). Callers get a boolean instead
of an exception; the first-resize nudge uses it to skip its follow-up when the
PTY is already gone.

`spawnPty` registers `guardPtyInputErrors` immediately on both spawn paths for
every PTY (sessions, shells, SSH attach clients). Asynchronous Windows
`_agent.inSocket` errors are logged at warn, falling back to debug, and absorbed;
absent internals and failing access or logging never throw (#517).
`test/pty-input-errors-conpty.test.js` checks the real node-pty input socket in
a Windows child process, including immediate listener registration and EPIPE.

A kill is once-only. With `useConptyDll`, node-pty's `kill` ends in
`ConptyClosePseudoConsole(hpc)`, and the native handle is only dropped when the
shell's exit thread runs; a second kill before that finds the handle still
registered and closes an already-freed pseudo console, a heap corruption
(0xc0000374) that kills the whole main process with no JS error. So `killPty`
closes a given pty once (a `WeakSet` of killed ptys), and `resizePty` /
`writePty` return false on a killed pty. `test/pty-ops-conpty-kill.test.js`
proves it against the real node-pty in a child process (Windows only): with the
guard removed the child dies with 3221226356.

A synchronous `pty.kill()` failure removes that PTY from the issued-kill set.
This applies to plain close and the tracked Windows close callback. A later
`stopLocalSession` retries rather than treating the failed request as pending;
successful requests retain the once-only guard. The sidebar IPC still replies
`{ok:true}` for a normal open session even when the backend reports failure.

Both ConPTY suites use `test/pty-ops-conpty-stage.js` to copy node-pty into
TEMP. A reusable stage requires `.complete`, `node-pty/package.json` and every
file the source has under `lib/` and `prebuilds/<platform>-<arch>/` (the
ConPTY suites load `conpty.node`, `conpty_console_list.node` and
`conpty/conpty.dll` + `OpenConsole.exe` from there) (#749). Why a marker
outlived its module on the workstation is not known, so the check covers
every staged file rather than a guessed subset.
An incomplete stage is renamed aside before best-effort removal and atomic
publication of a fresh temporary copy. After relocation, the same completeness
check runs on the displaced directory: a complete stage published in the gap
before the rename is restored, or a complete winner already at the final path
is reused and the displaced copy removed (#935). Restore and publication
conflicts reuse only a complete winner; other failures propagate; a displaced
copy that vanished before its restore (ENOENT) leads to a fresh publication.
The sweep spares `.tmp-` and `.stale-` siblings younger than five minutes, so
it cannot delete another process's displaced stage mid-restore. This narrows
the race to the two renames, it does not close it: a child resolving node-pty
between them still fails, and a loaded `.node` does not stop a directory from
being moved aside on Windows.
`test/pty-ops-conpty-stage.test.js` covers missing components, untouched reuse,
relocation and publication races, including publication just before relocation
and a competing winner during restoration.

node-pty 1.2.0-beta.15 (#409) adds a mutex around the handle table
(microsoft/node-pty#922). In 1.1.0 the shell's exit thread erases the pty's
entry, and frees it, without a lock, while the main thread may be inside
`PtyKill` or `PtyResize` holding a pointer to that entry, or walking the table
while the erase shifts it. The beta takes `g_ptyHandlesMutex` on both sides.
It does not make a second kill safe: `PtyKill` still leaves the handle
registered with its `hpc`, and `WindowsTerminal.kill` has no once-only guard.
Measured 2026-10-03 with the child above against the beta: two raw
`term.kill()` still exit 3221226356, two `killPty` exit 0. The guard stays.

The race itself was measured with a scratch stress script, not kept in the
suite (each run takes about a minute, and a pass proves nothing). One child
process per run, so a crash is an exit status: 20 iterations, each starting 4
`cmd.exe /c exit` ptys plus one long-lived pty, then 300 ms of resize calls
straight into the binding while the short shells exit, and in kill mode one
agent-level kill per short pty at a random moment in the first 150 ms.
Results, 2026-10-03, `useConptyDll`, plain node 24:

| Mode | 1.1.0 | 1.2.0-beta.15 |
| --- | --- | --- |
| kill | 5 of 8 runs died, 0xc0000005 | 0 of 8 died |
| resize | 0 of 3 died | 0 of 3 died |

One beta kill run completed its 20 iterations and then never exited (killed
after 600 s); not explained. The crash is not deterministic: it needs the exit
thread's erase to land inside the few instructions between the main thread's
lookup and its last use of the entry, and reading or writing freed memory only
crashes when the allocator has already reused or unmapped it. A kill holds
the pointer across `ClosePseudoConsole`, which can wait for OpenConsole, and then
writes to the entry; a resize holds it for one `ResizePseudoConsole` call.

### Closing a local PTY on Windows (#897)

Windows tab cleanup uses a resident hidden PowerShell helper and one unnamed
native job per foreground local PTY (`src/main/terminals/`, ADR 0005).
At app ready, main configures the singleton once and starts it without awaiting
startup. `windowsJobHelper()` only retrieves it; configuring it again with
different function bindings throws instead of silently keeping the first ones.
Requests for the same job ID run through a per-ID FIFO. An observation retains
its pending reply while release, termination or reassignment waits behind it;
different IDs remain independent. Replies advance that ID's queue, and helper
failure settles both in-flight and waiting requests. The PowerShell wire format
and job IDs remain unchanged.
First and restored tabs never wait for compilation. Queued assignments wait for
`ready` (15 s startup deadline). Node reads the packaged `.ps1` with asar-aware
fs.readFileSync; build.files includes src/**/*, and no archive path goes to
PowerShell. The absolute System32 executable runs with -NoProfile,
-NonInteractive, -EncodedCommand, windowsHide and SilentlyContinue; Add-Type
compiles the P/Invoke C# once. No compilation occurs on the close path.
Closing a tab while its assignment is still queued cancels that assignment and
uses plain ConPTY close; hidden processes may remain. The helper warns once per
app session for this early-close case and remains available for later tabs.
This warning also covers a close before node-pty has submitted the root PID.
Release before readiness cancels the assignment silently.

Jobs set no limit flags (#1015): JOB_OBJECT_LIMIT_BREAKAWAY_OK (0x800),
JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK (0x1000) and JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
are all absent. Closing job handles, helper death, transport/protocol failure or
timeout therefore kills no members.
The job is set on every local Windows PTY (main.js, trackWindowsPty, assign): Git
bash, PowerShell, Claude and plain tabs alike, so everything below applies to
every Windows tab, not only Git bash.
With breakaway allowed, Git for Windows bash can launch Node outside the tab's
job; Node's detached children then also escape. A gated native measurement with
Git bash and Node 22 observed both launcher and detached child surviving explicit
termination with 0x800, and both ending with zero flags. Bash still launched
Node and its detached child successfully with zero flags. An explicit native
CREATE_BREAKAWAY_FROM_JOB request instead fails with ERROR_ACCESS_DENIED (5),
as measured separately; callers that require that flag cannot launch through
this job. The live comparison on 19–20 November 2026 confirmed this error from
inside a Git bash tab; since the job covers every local Windows PTY, the error-5
cost of an explicit CREATE_BREAKAWAY_FROM_JOB concerns every Windows tab. Detached Node children and `cmd /c start` PowerShell
processes survived tab close with 0x800 and ended with zero flags. Console-attached
children, Claude and classic Win32 charmap already ended on close with 0x800;
Store Notepad stayed outside the tab job and survived in both variants.
An already-running Claude daemon spawned background workers outside the tab job
in both variants. Starting that daemon from a tab was not measured; members of
the tab job still rely on the protected-member policy below.
Claude's srt-win sandboxed Bash tool under zero flags has NOT been measured.
Because the job is set on every Windows tab, that unmeasured risk concerns every
tab where Claude runs its sandboxed Bash tool, not only Git bash tabs. Codex's
Windows sandbox ran under zero flags, but that does not establish srt-win
compatibility. JB accepted shipping zero flags in the next beta on 20 November.
The Windows-only windows-job-bash regression exercises the shipped helper
through its spawn port and a real Git bash; it skips when Git for Windows is
unavailable. It does not exercise Electron or cover every MSYS tool.
Before its first `ready`, a failed singleton settles requests false and permits
up to three startup attempts per app session (#1140), each with the same 15 s
deadline. A later assignment (or explicit `start`) retries only after a monotonic
backoff of 1 s after the first failure and 2 s after the second. An unreferenced
timer also retries when that window expires while tracked live tabs are waiting
(#1156). Concurrent tabs share one attempt and its readiness promise.
Close, release and observation cannot restart a failed helper, even after the
backoff expires with no tracked tabs waiting. The fallback
warning is emitted once per app session, while retry attempts, their failures
and budget exhaustion are logged separately. Events from failed attempts are
ignored, including delayed ready, exit and stream errors.

Tracked tabs whose initial assignment fails during startup/backoff retain their
original PID and spawn timestamp. Registration and retry retention check the
same live, unchanged, unreleased PTY even while an evidence stop is waiting for
its initial assignment. If that stop returns `IDENTITY` without killing the PTY,
the tab remains eligible for recovery and a later evidence stop can use its job.
The temporary `closing` guard is checked when readiness dispatches the late
assignment, not when registering or retaining the waiting tab.
On readiness, each receives at most one late
assignment, only while its PTY is still live, unchanged, open and unreleased.
The helper removes the pending recovery before sending it; a failed late
assignment is never retried. Closing or releasing cancels pending recovery.
The late assignment promise updates the same PTY record as the initial one,
including evidence close and natural-exit observation. Plain ConPTY close stays
available while recovery is pending or has failed.
Children spawned before late assignment are not captured; only children spawned
after the root joins the job inherit membership and are ended on tab close.
Once a helper has been ready, its failure remains
terminal for this session: a new process cannot inherit its existing job
handles. This change only recovers startup failures, not lost jobs. Tests stub
the spawn port and clock, including timeout-then-success through trackWindowsPty,
permanent timeout/spawn failure, the retry cap and stale-attempt events.
`windows-job-recovery` combines the real PTY tracking and helper state machines
with a stubbed child process, independent monotonic/wall clocks and controlled
timers. It covers automatic and explicit recovery, lifetime guards, one late
attempt, job close, evidence close racing a startup failure, and backwards
wall-clock steps. The helper tests also check cleanup after backoff expiry with
no waiting tabs; removing the non-assignment failure guard fails those checks.
EOF/finally
only closes handles, with no membership scan or termination. Release also just
closes the handle; there is no limit flag to clear and no release-time flag API
failure. Explicit protected-aware terminate is the only job cleanup operation.

The protocol is assign <ptyId> <rootPid> <spawnTimeMs>,
terminate <ptyId> [pid:procStart,...], release <ptyId>. Replies are assigned,
terminated, released plus id, or error <id> <Win32 code>. The client buffers
split lines, rejects invalid identities, and drops exited/released queued roots.
Request replies have a 3 s deadline. Assignment opens the process, checks its
GetProcessTimes creation time against spawn time plus 100 ms, checks liveness
with WaitForSingleObject, and assigns through that same identity-pinning handle.
Descendants born after assignment join automatically; children already born can
escape. Removing that gap would require suspended native creation/assignment.

node-pty 1.2.0-beta.15 initially returns PID zero. trackWindowsPty subscribes to
ready_datapipe, records the connection time and assigns the real PID, with a
5.5 s unref'd bound. Exited, released and closing roots are not assigned. Main
does not register attach or remote PTYs. Normal root exit releases the job,
including when native exit is known before JS exit delivery. The exit listener
keeps a job whose explicit close has already started.

The legacy Tab close/Stop path marks the PTY killed, suppresses duplicate closes/writes/resizes,
calls pty.kill synchronously, then polls native _agent.exitCode every 25 ms until
exit (including zero) or 2000 ms. This cap is below Windows' five-second
CTRL_CLOSE allowance. No claim is made that non-root Claude/MCP processes receive
CTRL_CLOSE. The helper enumerates job members with QueryInformationJobObject,
growing the buffer on ERROR_MORE_DATA, then explicitly terminates unprotected
members. Opened GUI windows lose unsaved work. Enumeration/termination is a
snapshot: a later child can escape. API errors are returned per job and the
handle is closed without blindly killing unidentified members.
An exception inspecting or terminating one member skips that member and lets the
other members finish cleanup. Inspection failures seed protection before the
descendant walk, so children with a validated same-snapshot ancestry also survive.
The helper reports one member-failure warning per lifetime and returns
`ERROR_MEMBER_SKIPPED` (299, the Win32 partial-copy value) for caught member
cleanup exceptions. Protocol errors remain 87 (`ERROR_INVALID_PARAMETER`);
an already-recorded native error retains precedence. Strict retained termination
does not overwrite an existing error merely because protection is nonempty.
Legacy termination always removes/closes its job handle.

The JS consumer names the same 299 constant and labels its per-request warning
`(member skipped)` while preserving the false result. Stderr is split into lines
across chunks, retaining at most 1024 characters of an unfinished line and
discarding the remainder through its newline. Command-line and member-cleanup
warnings are each forwarded once per helper lifetime, even in the same chunk;
PID changes do not create a new warning kind. Other stderr diagnostics retain
one bounded warning per lifetime. An unfinished final line is flushed at EOF.

`windows-job-member-errors` keeps its three Node children and a child of the
first faulted member alive on redirected
stdin until the probe's cleanup. A finite child timer can expire before the
survivor observations on a delayed runner, independently of the helper. The
probe retains the stdin writers through `Finish` and the survivor checks;
normal cleanup kills only its owned PIDs, and probe death closes the pipes so
the children can exit on EOF. The assertions still require both failed members
alive with the descendant, the ordinary sibling dead, and exactly one warning.
Both legacy and retained termination are tested: the legacy job is released,
the retained job remains owned until explicit cleanup. A malformed protocol
request still returns 87; member inspection exceptions return 299.

The dormant A4c2a `terminateWithEvidence(id, { deadline })` JS port uses a
separate `terminate-retained` verb. The native helper keeps that assigned job
handle, skips unreadable members in strict mode, and returns failure when any
member is protected, unreadable, or cannot be terminated. The JS port awaits
the termination reply, then polls serialized `observe` requests every 25 ms.
Only a verified zero count produces `ended: true`; a nonempty job or a missing
assignment/termination/observation reply remains unknown. A `finally` requests
release after observation. The overall deadline (five seconds by default,
15 seconds maximum) also covers roster input and cleanup. Evidence expiry
returns unknown and queues release even after the observation budget expires;
it does not disable the shared helper or other PTYs. An in-flight request keeps
its own request timeout; only a genuine request timeout or protocol/process
failure disables the helper. Late replies remain serialized before release.
There is no new kill fallback. Legacy `terminate` still releases immediately.
In the 19–20 November live run under zero flags, the stop went through the legacy
path (`stop-session`, `killPty`, `record.jobs.terminate`, then
`TerminateMembers(..., strict=false)`). codex.exe could not be opened or
terminated (error 5), and the helper logged `terminate failed: 5` for the whole
stop although the other members had ended; this warning does not mean every
member survived. Legacy terminate only warns on an unreadable command line: it
neither skips the member nor protects its descendants, so `ProtectDescendants`
has no seed for it. Which mechanism ended the Codex subtree was not established.
This differs from strict retained termination, which skips unreadable members and
requires validated roster evidence. Do not infer that every process ends from the
zero limit flags alone.
Per-id protocol serialization is retained. Script encoding strips leading
indentation to stay below the Windows command-line length limit.

`closeWindowsPty(..., { evidence: true, deadline })` returns the termination
evidence promise after its existing native-exit grace; the default invocation
still returns undefined. `stopPtyWithEvidence` owns this optional path and
suppresses natural-exit release until the evidence/cleanup path completes.
An identity/assignment refusal before any kill retains the job and clears the
cached stop attempt so a later legacy close or evidence retry can use it.
The evidence grace poll timer is unreferenced, like the legacy timer.
Plain-Node tests drive shipped JS against a fake helper process with retained
membership; they detect release-before-observe. Native `evidence` and
`evidence-protected` cases in `windows-job-native` are CI gates, not local
evidence from the constrained A4c2a implementation run.

For each member it reads command line with NtQueryInformationProcess class 60
(Windows 8.1+), parent PID with ProcessBasicInformation and creation FILETIME
with GetProcessTimes. One named IsBackgroundAgent matcher uses
CommandLineToArgvW, freed with LocalFree. It accepts claude/claude.exe, or
node/node.exe running @anthropic-ai/claude-code/cli.js after Node options, including
`--max-old-space-size=…` and `-r`/`--require` preload pairs. The first
arguments after the executable/script must be daemon run, or --bg-pty-host as
the first argument. Prompt/commit text containing these words does not qualify.
Executable basenames use separator lookup rather than filesystem path validation,
so malformed argv[0] values such as `bad<name.exe` do not throw. The matcher was
checked against live daemon and worker command lines:
`...\claude-code\bin\claude.exe daemon run --origin transient --spawned-by "{...}"`
and `...\claude.exe --bg-pty-host \\.\pipe\cc-daemon-... 444 110 -- ...`.
The Node CLI-entry form also has synthetic native test coverage.

Main obtains the roster path from bg-agents.getDaemonRosterPath(), honoring its
configured path. Its asynchronous best-effort read supplies worker pid/procStart
pairs. The roster shape consumed by `bg-agents.workerSample` carries `proto`,
`updatedAt`, `supervisorPid` and worker `pid`/`procStart` pairs; neither that code
nor `cli-session-state` defines a supervisor creation timestamp. The supervisor
therefore relies on argv protection. `readWindowsDaemonPids` can also forward
`supervisorProcStart` if a future roster provides one; PID alone is never evidence.
The optional read is bounded at 50 ms; missing,
malformed and slow reads supply no seeds. procStart is a 17-19 digit decimal
Windows FILETIME string (100 ns since 1601), compared to native creation time
with the same <=100 tick tolerance as cli-session-state.procStartMatches and
bg-worker-liveness. Stale/reused PIDs do not protect a member. Matched members
and validated roster members seed transitive protection only through parents in
the same snapshot whose creation time is no later than the child's. Unreadable
command lines warn once per helper lifetime and need validated roster evidence.
Other members are opened with terminate/query access and checked with
IsProcessInJob on that handle immediately before TerminateProcess. No
TerminateJobObject is used.

A background agent whose launcher has already exited can lose its ancestry link
to the daemon. If it has no own marker or roster identity, closing the originating
tab ends it. This requires the daemon to have been cold-started from that tab;
surviving ancestry cannot be reconstructed from an absent parent. Under flags 0
this is no longer rare when a Git bash Claude tab cold-starts the daemon; how
often it happens is unmeasured.

Attach, detaching, backgrounding, backgrounded, hosted and non-local sessions use
plain close. Detach releases before Ctrl-Z/write or fallback kill. Confirmed
background handoff awaits release before scheduling its kill; continuation
rekeying also requests release.

Natural PTY exit never waits for job assignment or observation. An unsettled
assignment is released immediately; only an already assigned job is observed
in the background. Main records an ended-tree proof only while session identity,
PTY and generation still match, independently of its normal exit cleanup.
Each wire also records the latest generation under the tab and known real ID
in `activeSessions.statusGenerations`, surviving removal from `activeSessions`.
Status accepts a retained exit proof only when its generation matches that
latest wire, rechecked after asynchronous reads. A delayed observation from an
older session object cannot confirm death of a reopened ID, even after the new
PTY has exited and its active entry has been removed. Missing generation
ownership leaves liveness unknown.

App quit retains the existing 1500 ms shutdown drain and adds no await. It calls
the same synchronous pty.kill; the existing unref'd 25 ms native-exit poll can
issue best-effort protected termination if the root exits while that drain is
still active. There is no guarantee: its 2000 ms deadline exceeds the drain, and
Node/Electron's outer libuv job can kill the helper before EOF. Hidden descendants
of still-open tabs can therefore survive app exit, as before this PR. No new quit
cleanup path or stronger guarantee is claimed. Helper/parent death itself leaves
the assigned processes alive because no job is armed. Pure-Node native parent-exit
tests exercise this property; they are not an Electron exit measurement.

Resident PowerShell with P/Invoke may be flagged by EDR/AV or ended by the user.
After readiness there is no restart policy. No EDR product was tested.

Tests load shipped production code: pty-ops-jobs covers close ordering, grace
deadline, exclusions, detach and deferred assignment; windows-job-helper covers
protocol, roster identity transport, singleton configuration and failure paths;
windows-job-policy compiles the real PowerShell/C# for argv, FILETIME and ancestry
policy. pty-job-shutdown uses the real shutdown functions with controlled external
ports. windows-job-native uses real ConPTY/jobs, simultaneous tabs, explicit hidden
child cleanup, valid/stale roster identities, protected daemons, release, helper
death/EOF/timeout and parent exit. windows-job-latency runs the ten cold helper
startup/assignment/termination samples separately so profiling does not consume
the functional file's 120 s process budget. `windows-job-malformed` likewise
isolates the extra malformed-argv cleanup regression from that budget. Surviving fake processes
expire through their own fixture timers after the observation window. Processes
have absolute safety lifetimes and fixture cleanup only targets owned PIDs.
The native test runner owns each fixture's temporary directory and registers
cleanup in its after hook, including when the fixture exits before its finally
block. Both cleanup paths retry transient Windows removal failures.
`stop-process-tree.js` is used by runClaudeCommand for command-timeout cleanup.

### Cursor-position queries

The beta's bundled OpenConsole asks the terminal where its cursor is: a plain
DSR (`CSI 6n`). 1.1.0 sent none in the same runs. Measured 2026-10-03 on an
isolated pty under Electron 41 with `useConptyDll` (`cmd.exe`, then a raw-mode
node reader as the shell):

- With no resize, no query in 10 s.
- A resize within about the first 3 s of the pty brings one query about 3.3 to
  4 s after spawn. Unanswered, it is repeated about every 520 ms and dropped
  after 3 (`cmd.exe`) or 4 (node) queries. Answered, it is sent once. A resize
  at 4 s or later brought none, and a second resize no second series.
- OpenConsole keeps waiting after the last repeat: the first CPR that arrives
  later, even seconds later, is consumed. Every other CPR it receives, a reply
  it is not waiting for, is passed to the shell's application as typed input,
  verbatim (`ESC [ 24 ; 1 R` read by the child's stdin). 1.1.0 passes such a
  reply through the same way.

A visible session answers at once: xterm.js replies with a plain CPR
(`CSI row;col R`), which `src/main/terminals/composer-state.js` does not treat as a report (see
`.ai/contexts/trigger-watcher.md`, CPR), so the answer pushes the quiet clock
once.

A hidden single-view session cannot answer: its output goes to the hidden
accumulator, not to xterm. A session with no renderer attached cannot either.
Both replay paths drop DSR `CSI 6n`, private DECXCPR `CSI ?6n` and primary
device-attributes queries `CSI c` / `CSI 0c` instead of keeping them. They
share the matcher in `public/terminal-replay-queries.js`; see
[terminal-refresh.md](terminal-refresh.md), "Stale queries in hidden replay":

- `appendToHiddenAccumulator` / `replayHiddenBuffer` (`public/terminal-manager.js`)
  remove these queries from what they keep, including a query split across chunks
  and one left in the live write buffer when the session was hidden.
- `appendToOutputBuffer` (`src/main/terminals/output-buffer.js`), main's reattach buffer, removes them
  on the way in, a query split across several chunks included (the last
  four code units of the buffer are checked, across entries). That buffer also
  holds the queries a visible renderer already answered.

The filter is not specific to Windows or to OpenConsole: it runs on every
platform and removes these queries in a session's replay output, including one an
application asked itself (a shell's line editor measuring the cursor, for
example). Such an application gets its answer while its session is visible; a
query it sent while the session was hidden or detached goes unanswered, where
it used to be answered late, at reveal or reattach, with a stale position.

The removal is a single pass. Removing a query can join the bytes around it
into a new one (`ESC [ ESC [6n 6n` becomes `ESC [6n`); that one is kept, so
such input is replayed with one query. The earlier version repeated the pass
until no query was left: it removed bytes that are not a query (xterm.js shows
the trailing `6n` of that input as text) and was quadratic, and on a crafted
64 KB chunk the main-side version, which recursed, overflowed the stack.

Kept, each query would be answered by xterm.js at reveal or reattach: one reply
consumed by an OpenConsole still waiting, every other one typed into Claude or
the shell. Answering once at reveal instead was rejected: the reply would give
the cursor of a replay that happened after the output OpenConsole had already
moved on from, and nothing tells the renderer whether OpenConsole is still
waiting or a reply was already sent. Left unanswered, OpenConsole keeps its own
idea of the cursor, as it did on 1.1.0 where it never asked; the next query it
sends while the session is visible is answered live. Other terminal queries
in a replay (`CSI > c`, `CSI 10c`, `CSI > q`, OSC colour queries) and responses
(`CSI ?1;2c`, `CSI ?73;3R`) are not filtered.

Swallowed errors are not silent: `setPtyOpLogger(log)` in `main.js` routes them
to `log.debug` as `[pty] <op> skipped session=<id> reason=<message>`. Debug level
is deliberate — the file transport is at `info` in packaged builds, so a resize
storm against a dying PTY costs nothing in production, and the line is there in
dev when someone next has to diagnose this.

Not covered by `src/main/terminals/pty-ops.js`, on purpose: `trigger-watcher.js` writes (already
bounded by their callers' try/catch, plus a `process.kill(pid, 0)` liveness
probe) and the `clear` shim write in `open-terminal`, which happens before a
session object exists.

### Busy-state reconciliation

`cli-busy-state` is emitted **strictly on transitions** (`main.js` OSC 0 / OSC 9;4 handlers only send when `session._cliBusy` flips). A renderer that misses one — reload, mis-keyed id, a `session-forked` re-key — stays wrong forever, because no further event is coming. That is why `get-active-sessions` carries `busy`: `pollActiveSessions()` (3s while any PTY runs, 30s otherwise) hands the snapshot to `reconcileBusyState()` in `public/session-activity.js`, which realigns `sessionBusyState` and the sidebar classes.

> `session-detected` (tempId → realId) has a preload bridge and an `app.js` listener but **no emitter in main today** — `session-transitions.js` only sends `session-forked`. The `rekeyActivityState` call in `onSessionDetected` is therefore unreachable; it is kept so the handler stays correct if the channel comes back, not because it runs.

Three things make that safe:

- **The response-ready lock only blocks idle.** `setActivity(id, true)` always writes, and drops the session from `responseReadySessions` — a session that resumed generating has no unread answer left to announce. `setActivity(id, false)` on a response-ready session is still ignored, so an unread marker survives duplicate idle signals. Before that split, a session that finished a turn off-screen and restarted without a click (cron, trigger-watcher, resume) had *every* subsequent busy event swallowed.
- **`cli-busy` and `response-ready` are mutually exclusive.** `applyStateClasses()` (`public/session-activity-dom.js`) is the only writer of either class, and the exclusivity itself is the domain's own invariant (`public/session-state.js`'s `apply()`) — see `.ai/contexts/session-state.md` ("The local-pty adapter"). The state, not the cascade, is what decides.
- **A poll reply cannot overwrite a fresher event.** `setActivity` bumps a monotonic counter per session; the poll snapshots it via `currentActivitySeq()` *before* the IPC round-trip and `reconcileBusyState` skips any session that moved in between.

### The OSC 0 title is the primary busy channel

Two channels can raise `session._cliBusy`, and they are not interchangeable:

- **The OSC 0 title.** The CLI always sets it, so this is the channel that has
  to work. Classification lives in `classify-title-activity.js`.
- **OSC 9;4 progress.** Only emitted when the CLI's `terminalProgressBarEnabled`
  setting is on. It stays wired as a second opinion; it must never be the only
  one, because a user preference can switch it off and nothing would report it.

`classifyTitleActivity(title, { allowFallback })` looks at the first code point:

| First code point | Verdict | Rule name |
|---|---|---|
| `✳` U+2733 | idle | `idle-glyph` |
| U+2800–U+28FF (braille frames) | busy | `glyph` |
| U+25D0–U+25D3 (`◐◑◒◓`) | busy | `glyph` |
| any other non-ASCII, followed by a space and a non-empty title | busy | `fallback` |
| ASCII, or a bare non-ASCII word | no decision | `null` |

**The glyph list is coupling to a third party's private rendering choice, and it
has already broken once.** Until 2026-08-22 the busy test accepted braille only.
The CLI had moved to half-circle frames, so the title could *clear* the busy
state (`✳` still matched) but never *set* it, and the spinner survived only
because OSC 9;4 happened to be on. The activity trace
`~/.switchboard/activity-trace-20260822-181759.jsonl` is the evidence. Counted
over a fixed window — its first ten minutes, `wall` from `16:18:00Z` to
`16:28:00Z`, because the file keeps growing for as long as the variable stays
set and bare totals would not reproduce — it holds 628 `osc.title` entries: 312
starting U+25D0, 311 U+25D1, 3 `✳`, 2 bare `claude`, and no braille at all. 625
of them were logged `decision: "ignored:no-match"`. Both `busy.emit` lines with
`busy: true` in that window carry `via: "osc9.4"`. Not one busy transition came
from the title.

That is why the closed list has a net under it. The `fallback` rule assumes any
single non-ASCII code point used as a title prefix is a status indicator, which
is what a prefix in that position is for. Weighing the false positives:

- A word starting with an accent or a CJK character (`Éditeur de texte`) does not
  match — the rule needs the first code point to stand alone before a space.
- An emoji-prefixed title from a shell prompt or a task runner *would* match. The
  cost is bounded but real: only a `✳` title clears `_cliBusy`, so a wrong busy
  sticks until the CLI next reports idle — the next turn, for a Claude session.
  `main.js` passes `allowFallback: !session.isPlainTerminal`, so the generic rule
  never fires on a plain terminal in the first place.
- The alternative — a closed list with no net — fails silently and stays broken
  for as long as nobody notices the spinner missing. A stuck spinner is visible;
  a spinner that never lights is not.

**What that guard does not cover.** `allowFallback` gates the `fallback` rule
only; the `glyph` branch runs for every session. A plain terminal whose title
starts with a code point from the ranges above — braille, or one of `◐◑◒◓` — is
marked busy like any other, and since a plain terminal never emits `✳` nothing
on the title path clears it: the state survives until the PTY exits, at which
point `updateRunningIndicators()` in `public/app.js` drops `cli-busy` along with
`has-running-pty`. That is a decision, not an oversight — the ranges are narrow,
the *title* has to carry the glyph (a spinner printed to stdout is not a title),
and the braille half of the exposure predates this change. It is not free
either: U+25D0–U+25D3 is `circleHalves` from the `cli-spinners` package, which
other tools draw from, so widening the ranges widened this too.
`test/classify-title-activity.test.js` pins the behaviour, so whoever tightens
it later knows they are reversing a decision rather than fixing an omission.

To recheck after a CLI upgrade, run a session under `SWITCHBOARD_ACTIVITY_TRACE=1`
(see `docs/activity-trace.md`) and count where busy comes from:

```bash
grep '"cat":"osc.title"' ~/.switchboard/activity-trace-*.jsonl \
  | sed 's/.*"cp":"\([^ ]*\).*/\1/' | sort | uniq -c   # leading code points
grep '"cat":"busy.emit"' ~/.switchboard/activity-trace-*.jsonl \
  | grep '"busy":true' | sed 's/.*"via":"\([^"]*\)".*/\1/' | sort | uniq -c
```

Healthy output has busy emissions attributed to `osc0`, and the `rule` field on
`osc.title` lines reading `glyph` rather than `fallback`. `rule: "fallback"` on
every spinner frame means the CLI changed its glyphs again and the range table
should be extended; `ignored:no-match` on titles that clearly carry a prefix
means the fallback itself has regressed.

**The title says busy; it never says why.** While the CLI waits on background
agents it keeps animating the same spinner and never writes a `✳` title. Same
trace, session `6577a487`: busy at `16:18:51Z` via `osc9.4`, then ◐/◑ frames and
not one idle title for the rest of the ten-minute window — nine minutes in which
"generating" and "waiting for my agents" are the same signal. It does draw the
distinction in its own status line ("✻ Waiting for 1 background agent to
finish") and has a tri-state channel for it (OSC 21337, idle/busy/waiting), but
that channel is disabled in the shipped binary, so nothing reaches us. Switchboard therefore
does not claim the distinction: the sidebar tints the busy spinner violet when
subagents are live, which asserts only that both things are true at once — see
`docs/subagents.md`, "Live status".

### Activity trace: render-path counters

`render.stats` (renderer, `public/terminal-manager.js`) answers "is this
terminal's CPU legitimate": writes, batch size and glyph-atlas rebuilds per
session per second. It aggregates instead of tracing each write, because a
per-chunk line would itself be the load at 30 writes a second. The counters sit
in `renderStats`, created on the first event while `window.ATRACE` is true;
one `setTimeout` per window, armed by that first event, emits and clears them,
and drops them if the trace was switched off meanwhile. Nothing is armed while
the trace is off or the session is silent. `maxBatch*` is per write, not per
second; `atlasChanges` / `atlasCanvases` are the events that make
`loadTerminalWebgl` repaint every visible row. Test:
`test/terminal-render-stats.test.js`. It reports; it does not change the flush
cap or the WebGL policy.

### Activity trace: why the main process is the only writer

`activity-trace.js` + `public/activity-trace.js` + `public/activity-trace-panel.js`,
off by default. `SWITCHBOARD_ACTIVITY_TRACE` sets the state at startup; Settings
→ Diagnostics switches it at runtime and stores the choice. User-facing docs:
[docs/activity-trace.md](../../docs/activity-trace.md).

The indicators above are produced by two processes with two clocks, and the
bugs in them are **ordering** bugs — a front that was emitted but not received,
a poll reply that overwrote a fresher event, a fork that re-keyed halfway. Two
log files cannot be interleaved after the fact with any confidence, so the
trace has a single writer: the renderer sends probes fire-and-forget over
`activity-trace`, and main stamps the sequence number and both timestamps on
arrival. Renderer entries therefore carry their *arrival* time in main, which
is the correct trade — `seq` is the ordering, `t` is only for eyeballing gaps.

Why not `log.debug`: `main.js` sets the file transport to `info` when packaged,
so the existing OSC 0 debug lines never reach disk in a build the user runs —
which is exactly why the question "what code point does the CLI put in the
title" was unanswerable from a production log and had to be settled by reading
the CLI binary. The trace has its own file and its own level, so it is readable
from a packaged build, and it records the renderer half that `log` never saw.

Two constraints shaped the API:

- **The off path must allocate nothing.** The module exports its state as an
  object, `{ on }`, so probes are `if (TRACE.on) trace(...)` /
  `if (window.ATRACE) window.atrace(...)` — one property load, and the payload
  literal is never evaluated when the trace is off. An object rather than a
  boolean because the state is now switchable at runtime: a destructured
  `const { enabled: TRACE }` would freeze the flag at require time and pin
  every probe to the launch environment. The renderer probes go through
  `window.*` rather than bare globals so `session-activity.js` and
  `sidebar.js` stay loadable in the jsdom tests, which evaluate them without
  the trace file. This is the same discipline as
  [ADR 0002](../../docs/decisions/0002-discrete-steps-sidebar-animations.md):
  nothing that runs per render may do work.
- **The switch must not need a restart.** Restarting to arm a diagnostic
  destroys the state it was meant to observe, so `set-activity-trace-enabled`
  flips the module state, opens or flushes-and-closes the file, persists the
  choice into the `global` settings row, and pushes the new state to the
  renderer on `activity-trace-state`. The `activity-trace` handler is
  therefore registered unconditionally — a listener added on demand would not
  exist in the window that was created while the trace was off — and `trace()`
  drops the line itself while off.
- **The flag is parsed once.** `activity-trace.js` resolves
  `SWITCHBOARD_ACTIVITY_TRACE`; the preload is sandboxed and cannot require it,
  so main passes `--switchboard-activity-trace` via `additionalArguments` and
  the preload only checks `process.argv` for the *startup* value. Re-parsing
  the env var in the preload would let the two halves disagree silently — a
  trace file with no `src:"renderer"` lines and no error. The env var stays the
  startup path (it wins over the stored preference when set, in either
  direction) and nothing else reads it. Likewise the output directory is
  `path.dirname(DB_PATH)`, never a second derivation of the env var (`db.js`
  documents that anti-pattern where it exports `DB_PATH`).
- **The control channels are path-narrow.** `list-activity-trace-files`,
  `read-activity-trace-file` and `delete-activity-trace-file` accept only paths
  whose directory is the trace directory and whose basename matches the segment
  name pattern — an allowlist of exactly one directory, tighter than
  `isSensitivePath`, because the legitimate surface here is a single generated
  file family. Both the check (`resolveTraceFilePath`) and the capped read
  (`readTraceTail`) live in `activity-trace.js` rather than inline in the
  handler, for the same reason `fts-match.js` and `src/main/terminals/terminal-input.js` do:
  a handler body cannot be unit-tested without booting Electron, and these two
  carry the parts worth testing — a non-string path must answer `null` rather
  than throw (a rejected invoke leaves the button dead with no message), and a
  file that shrinks between the `stat` and the `read` must not come back as
  megabytes of NUL presented as trace content. Deleting the segment currently
  being written is refused rather than attempted; `currentFile` follows the
  stream, so switching debug mode off releases it immediately.
- **The probes must stay one line each.** The interesting sites live in files
  that other branches touch (`session-transitions.js`, `public/sidebar.js`),
  so every probe is a single inserted statement and all the logic —
  formatting, code-point rendering, the decision helpers that mirror the OSC
  branches — lives in the trace module where it is unit-tested.

Subagent probes follow the detector's own vocabulary rather than the IPC's: a
transcript first seen already stale produces `subagent.assumed-finished` and no
event at all, and if that assumption is later retracted inside the recheck
window the withheld spawn shows up as `subagent.rehabilitated`. Both are silent
in every other channel — see `.ai/contexts/subagent-observability.md` for the
mechanism they instrument. On the renderer side `recv.subagent-spawned` carries
`applied`, because a heartbeat for an agent the sidebar is not tracking is
dropped on purpose and that non-effect is the diagnostic.

`busyDecision` / `progressDecision` duplicate the conditions in `main.js` on
purpose: the trace also records the emissions themselves, so a divergence
between the predicted verdict and the `busy.emit` that follows shows up in the
file instead of being invisible.

`setActivity(sessionId, active, via)` — the third argument is trace-only
attribution (which caller asked for the write) and is inert when the trace is
off.

## Clean child environment

`scrubSessionEnv()` (`clean-env.js`) removes inherited Claude session markers from `process.env` in `main.js` before the reloader, updater and services start. This also covers children with no explicit `env`: SSH/scp and any ProxyCommand they launch, Git hooks, shell discovery and electron-updater's installer/elevation/relaunch paths. It changes only session markers; Electron's own process still needs its runtime variables. The standalone `scripts/postinstall.js` applies the same scrub before its build-tool shells, and `scripts/test-pr.js` scrubs a copy of its launch environment.

`cleanEnv()` calls the same helper on a copy to build `cleanPtyEnv`, the base for local Claude PTYs (new, resume, fork, sandbox, background attach), plain terminals, panel shells, scheduled runs and background CLI commands (dispatch, respawn and management). It additionally drops Electron internals (`ELECTRON_*`, `NODE_OPTIONS`, `GOOGLE_API_KEY*`, `ORIGINAL_XDG_CURRENT_DESKTOP`, `WT_SESSION`). When none of `LC_ALL`, `LC_CTYPE` or `LANG` is nonempty, it sets `LC_CTYPE=UTF-8` on macOS or `C.UTF-8` on Linux; Windows receives no default. An explicit locale, including `C`, wins.

The remote attach PTY and the systemd relaunch use `cleanEnv(env, { locale: false })`: SSH must not forward a synthesized macOS locale to Linux through `SendEnv LC_*`, and relaunch must not persist that default in the next application's environment. SSH/scp transports inherit `process.env`, which receives no synthesized locale. Git changes builds its own environment with `LC_ALL=C`, unchanged. Shell startup for plain terminals remains owned by `plainTerminalLaunch()`; the default locale is already present in its input environment.

The deny rule is exact membership in `SESSION_MARKERS`, compared case-insensitively to cover Windows environment aliases. There is no `CLAUDE_*` or `CLAUDE_CODE_*` prefix deny rule and no configuration allowlist: every name outside that set survives the session scrub. `cleanEnv()` does not mutate its input; the startup scrub deliberately removes only the inherited markers from the app's own environment.

| Stripped | Why |
|---|---|
| `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` | say "running inside a Claude Code session" and how it was started |
| `CLAUDE_CODE_SSE_PORT` | the parent's IDE link; Switchboard sets its own after cleaning when IDE Emulation is on |
| `CLAUDE_CODE_CHILD_SESSION` | makes the CLI save no transcript |
| `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` | identify the parent session |
| `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` | the parent's messaging channel |
| `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_SESSION_ATTENDED` | the parent's bridge session and attended state |
| `CLAUDE_CODE_EXECPATH` | the parent CLI's own executable path |
| `CLAUDE_JOB_DIR`, `AI_AGENT`, `CLAUDE_EFFORT` | the CLI derives the session's short id from `CLAUDE_JOB_DIR`; `AI_AGENT` marks a process as run by an agent; the CLI writes `CLAUDE_EFFORT` for hooks/Bash and never reads it |
| `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_REMOTE_SESSION_ID` | the launching cloud session's runtime context and transcript identity |
| `CLAUDE_ENV_FILE`, `CLAUDE_PROJECT_DIR` | the launching session's persisted shell environment and hook project context |
| `TRACEPARENT`, `TRACESTATE` | the launching session's trace context; with tracing enabled, the CLI sets `TRACEPARENT` on Bash children and a child Claude session would attach its telemetry spans to that trace |

Kept: `CLAUDE_CONFIG_DIR`, `ANTHROPIC_*` authentication/base URLs, `CLAUDE_CODE_USE_*`, `DISABLE_*`, proxy variables, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_EFFORT_LEVEL` (the documented user setting, distinct from `CLAUDE_EFFORT`), `CLAUDE_CODE_TASK_LIST_ID` (an explicitly shared task list) and every other non-denied configuration variable. The [official CLI environment reference](https://code.claude.com/docs/en/env-vars), checked for #670, documents the bridge/cloud IDs, child marker, job directory, PID and persisted environment file; private markers are also retained in the explicit deny set from the observed incident.

`GIT_EDITOR=true`, set by the CLI on its Bash children, is a session residue rather than a marker: a Switchboard launched from such a shell would hand it to every terminal, where `git commit` without `-m` then aborts on an empty message and `git rebase -i` skips the editor (#673). `scrubSessionEnv()` removes it only when the same environment carried at least one `SESSION_MARKERS` entry and the value is exactly `true` (`SESSION_RESIDUE`, key compared case-insensitively). `GIT_EDITOR=true` with no marker, or any other value beside a marker, is the user's own setting and survives. The gate is evaluated on the environment being scrubbed: at startup that is the launch environment, so by the time `cleanEnv(process.env)` runs the residue is already gone. `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP` is not a marker and is kept: the user sets it on purpose.

What Switchboard sets *after* cleaning stays: the plain terminal's `CLAUDECODE=1` (`open-terminal`, `isPlainTerminal` branch, present since the project's first commit, not tied to the `claude` shim) and `CLAUDE_CODE_SSE_PORT` of a session with IDE Emulation. A new marker the CLI starts setting is added to `SESSION_MARKERS`; `test/clean-pty-env.test.js` lists them one by one.

`test/child-session-env.test.js` sets markers in real `process.env`, evaluates the shipped main-process startup and launch handlers with the process/PTY boundary intercepted, and inspects each resulting child environment. A real Node child verifies implicit inheritance without launching Electron, Claude or an installer. The script launchers are exercised without starting their external tools. This tests the spawn boundary; it does not qualify CLI metadata writes or remote host startup files. A user shell profile that explicitly exports session markers again after startup is outside this inherited-environment fix.

## If you change this, also check

- **Three places per new IPC**: handler in `main.js`, bridge entry in `preload.js`, caller in `public/*.js` (and maybe `eslint.config.js` if you expose a new global).
- `eslint.config.js` `rendererCrossFileGlobals` — renderer functions exposed across `<script>` tags must be declared
- Any new event needs both an `ipcRenderer.on` in preload and an `mainWindow.webContents.send` in main
- If you change argument shapes, the renderer callers break silently (no type check) — search for callers before changing signatures

## How to add a new IPC

1. `main.js`: `ipcMain.handle('my-thing', (_event, arg1, arg2) => { /* validate, do, return */ })` — place near related handlers, not at random.
2. `preload.js`: `myThing: (arg1, arg2) => ipcRenderer.invoke('my-thing', arg1, arg2)` — add to the alphabetical-ish block.
3. Renderer: `const result = await window.api.myThing(...)`
4. Test: prefer a unit test for the main-side logic (extract to a pure function the handler calls); jsdom integration tests for renderer side.
5. Document here.

### Conversation continuations (#518B)

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `session-continuations` | `(sessionId)` | `{candidates:[{sessionId,modified}],unresolved,continued}` | Bounded traversal of the transcript continuation index; exposed as `api.getSessionContinuations`. Restore and manual resume share the renderer resolver. See cli-session-state.md, Conversation continuations. |

## Projects conflicts and projection diagnostics (#719)

During a populate (#1182), `isIndexingFinished()` stays false until the populate
promise settles, including warm starts with an inherited completeness marker,
and get-projects serves read-only builds. Which load reconciles after the
populate settles is described in session-cache.md, Projects query worker.

`session-cache` collects `scan` and `conflict` causes separately during a
populate and emits them at most once per ten seconds. On settlement it cancels
the pending timer and emits one final notification, including a failed scan
with no folder publications. Follow-up populates keep the notifications
coalesced until the shared work settles. Other structural causes retain the
existing 1.5-second throttle and activity retains its 30-second delay. Producer
shutdown clears the additional timer. The renderer's existing 900 ms debounce
is unchanged.

Caller deadlines, abandoned reconciles and shutdown: see session-cache.md,
Projects query worker. Tests cover request-time and dispatch-time gating,
twenty publications with conflicts, failed settlement, and deadlines in
`get-projects-worker-wiring`, `projects-worker-client` and `projects-changed`.

On terminal PROJECTS_SNAPSHOT_CONFLICT, every get-projects request returns only
{projectsError:{code:'PROJECTS_SNAPSHOT_CONFLICT',message:'Projects changed while loading; reload to retry.'}}.
Preload recognizes that exact envelope and reconstructs a coded Error. The
renderer keeps its previous lists and provisional paint, without committing a
generation, announcing trigger readiness or advancing restore. Main retains no
worker-result fallback cache and does not clone successful full results for one.
Disk snapshots and empty lists never replace an unavailable worker result.
An effect-free conflicted build is not an error (#1125): its own rows pass
through with `projectsStale: true` on paired replies (boolean replies stay plain
arrays). Neither path immediately notifies the renderer. Both share a coalesced
five-second retry in main, re-armed on stale or unavailable replies. Non-conflict
retry errors back off through 5 seconds, 30 seconds and a two-minute cap, with
one log per step; a successful snapshot resets the backoff. A successful retry
emits a reconcile notification. Main selects one dispatch for snapshot
races; the generic client defaults to three. Main logs the differing live
component for conflicts and the job options for caller timeouts
(session-cache.md, "Projects query worker"). Ordinary errors still
reject; boolean arrays and the paired defaultProjects/allProjects
reply retain their successful shapes, with compact provenance on the paired
reply. Its `projection.facts` map shares deciding inputs by opaque `scope|root`
across both views (#742). Rows carry no `projectionFacts`; main's assembly and
the renderer observer resolve representatives through the envelope's proof member
sets. Subagents and terminals have no facts. Paired activity-trace byte counts
include the envelope. Rejected worker payloads never reach assembly, and rejected
conflicts never reassemble or persist prior lists.

session-projection-changed is a narrow preload send. Main requires its own
window's webContents and main frame, validates allowlisted typed fields and logs
newline-free JSON as data at info level. It carries opaque scope/root identity,
accepted build/generation/roster revisions and deciding inputs. It accepts no
raw prompts, names, CLI strings, paths, sockets, keys or liveVersion. Lists are
capped at 128 with complete counts/truncation flags; oversized legitimate records
compact before transport and remain below 64 KiB after main's timestamp. Invalid
records or transport failures cannot break publication.

## Last known projects (#1125)

On a cold start with about a thousand sessions the first accepted load can
take a minute or more, and the user saw an empty, then frozen, sidebar. The
renderer now paints the sidebar at once from the payload the previous run
last showed, marked provisional, and the first accepted `loadProjects` replaces
it; the real load runs in parallel from the first millisecond and is never
delayed by the paint.

Main side, `src/main/projects/last-known-projects.js` owns the file
`last-known-projects.json` under `app.getPath('userData')` — the same place as
`remote-attach-profile-id`, under `SWITCHBOARD_DATA_DIR` in dev and test, never
the user DB schema. `getProjectsSnapshot('both')` calls `remember` with the
assembled `defaultProjects` and `allProjects` of every accepted reply (not a
stale delivery, not a boolean reply, never the `projection`); the store
coalesces writes two seconds apart, serializes off the IPC path, refuses a
payload above 8 MiB while keeping the previous file and logging that limit only
once per store lifetime (#1183), and writes `tmp` then `rename` so a crash
leaves either the old file or the new one. The record carries a format
version and the app version; `load` returns `null` and removes the file on a
parse error, a foreign format, another app version (row shapes change between
releases), or a row without `projectPath`/`sessionId` — a missing file is
`null` without a warning. At quit, `shutdownForExit` starts `flush()` alongside
the PTY exit drains within the existing shared 1500 ms shutdown budget (#1136).
It awaits the snapshot writes only after metadata drains and `closeDb`, so a
slow snapshot cannot consume the database writes' budget. A second `flush()`
starts just before `closeDb` to capture a `remember()` received during the drain.
On Windows shutdown, restart or logoff, Electron does not emit `before-quit`:
`query-session-end` / `session-end` use the unsaved guard's `externalFlush`,
bound through `flushForLogoff` to `drainForUpdate`. That non-destructive path
also flushes last known projects alongside the other writes within its 1500 ms budget.
This cancels the pending debounce and awaits the atomic write of the latest
remembered reply, including any already-running write. With no pending work it
does not touch the file. Write failures are logged by the store; an unexpected
flush rejection or throw is logged by shutdown without skipping the remaining
cleanup. A stalled write cannot extend the drain budget, so a forced timeout
can still lose the latest snapshot. `get-last-known-projects` returns `load()`.

Format 2 stores one `projects` list. Each project's `defaultOrder` and optional
`defaultRows` indices reconstruct the default view with its original order,
archives and hidden-project filtering, scoped by host and project path. The
common session fields (`projectPath`, `cwd`, `sourceFolder`, `runtime`,
`canLaunch`) are stored once per project when identical. Each session is a
tuple of ID, summary, modified time, message count and optional display fields.
`PROJECT_FIELDS` and `SESSION_FIELDS` explicitly retain the sidebar's headers,
titles, archive/pin state, CLI/remote/background badges, schedule/subagent/workflow
grouping, conversation IDs, status and visibility paths. Full prompts, created
timestamps, transcript conversation-part details and projection diagnostics are
not needed for this inert paint and are omitted. Names and AI titles stay
separate because subagent labels use a different fallback order from root rows.
The sources are `paintLastKnownProjects`/`dedup`/`refreshSidebar` in `public/app.js`,
`renderProjects`/`buildSessionItem`/`buildSubagentItem` in `public/sidebar.js`,
and visibility checks in `public/worktree-nesting.js`. On load the store rebuilds
the existing paired IPC shape; the renderer does not know about the disk format.
Older disk formats are discarded by the existing version guard.

Project fields include `reenableOffer`, preserving the schedule notice, failed
re-enables and the header's no-auto-collapse behavior in the provisional paint.
If a default project (including its remote-host scope) or row has no match in
`allProjects`, compaction rejects the payload and the store keeps the previous
file, as it does for serialization failures.

The synthetic 20-project, 1,500-session-per-project fixture measures 57,054,142
bytes in the former paired shape and 7,849,001 bytes in format 2, below 8,388,608.
`test/app-last-known-projects.test.js` also compares the actual sidebar HTML
before and after a real disk round trip for local, archived, scheduled, remote
and subagent rows with re-enable notices, alongside the provisional paint and
handover tests.

Renderer side, `paintLastKnownProjects` (app.js) runs from
`loadStartupProjects` without being awaited. It gives up when the reply is not
two arrays, when a real load has already committed, or when either cache is
already filled; otherwise it fills `cachedProjects`/`cachedAllProjects`, runs
`dedup`, sets the `Refreshing…` status only while the latest load is pending,
and calls `refreshSidebar`. A late snapshot preserves the load failure status
between retries and after the retry budget is exhausted; starting a retry
sets the progress status through `loadProjects`. The
provisional state is the class `projects-provisional` on `#sidebar-content`,
nowhere else: `loadProjects` removes it when a load commits, and its failure
branch shows "Could not load projects" while it is present even though the
caches are not empty.

Provisional rows are inert, not routed. A capture-phase listener on
`#sidebar-content` swallows `click`, `auxclick`, `dblclick`, `contextmenu` and
Enter/Space `keydown` while the class is present; the rows and headers render
at 0.7 opacity with a progress cursor. The alternative — letting a click run
through `openSessionNow`'s guards — was rejected: those guards assume rows from
an accepted snapshot, so a row deleted or archived since the last run would
still spawn `claude --resume` against a missing transcript or open a popover
on a project that no longer exists, and the wait is a few seconds. Restore,
trigger readiness and the background-agent paths never see provisional rows:
they run only after `loadStartupProjects` has an accepted load, as before.

Tests: `test/last-known-projects.test.js` (store),
`test/last-known-projects-quit.test.js` (quit before debounce, no-op, failure and
shared deadline, database ordering and a reply during the drain),
`test/session-exit-main.test.js` (Windows logoff persistence and flush failures),
`test/app-last-known-projects.test.js`
(paint, inertness, replacement, the race where the real load lands first, the
all-failed startup, including a disk snapshot arriving after all five attempts
have failed) and the remembered-reply case in
`test/get-projects-worker-wiring.test.js`.

Schedules reuse `run-schedule-now`, `read-memory`, `save-memory` and
`schedule-run-exit` unchanged. Slice B adds deletion through the Electron-free
`src/main/schedules/schedule-delete-file.js` helper; creation remains a later slice.
