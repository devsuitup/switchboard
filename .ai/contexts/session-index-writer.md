# Session index writer — ADR 0004 slice 1b, step 1

Scope: one writable WAL connection in a Node worker; one main-side readonly
connection remains for the existing synchronous reads. Independent read workers,
removal of main's connection, durable receipts and outcome recovery belong to step 2.

## Ownership and startup

main.js acquires the single-instance lock before starting the writer. It awaits
writer.ready before requiring db.js, initializing settings consumers or opening
the window. An early quit is held until bootstrap completes. db.js opens
openSessionIndexStore({readonly:true}); attempted mutations throw SQLITE_READONLY.
The store prepares the same API for the two modes, but only the writer runs schema
creation, legacy-file relocation, numbered migrations, schema reconciliation,
bridge repair, maintenance and writable pragmas. Connection opening and busy_timeout
both use 100 ms. The writer sets WAL and synchronous=NORMAL.

session-index-writer.js owns the transport and main-side filesystem orchestration.
session-index-writer-client.js follows the house Worker factory/event pattern.
workers/session-index-writer.js opens the writable store inside its thread.
The worker path uses path.join(__dirname,'workers',...). package.json already ships
root *.js and workers/**/* and unpacks better-sqlite3 and node-pty through
the normal dependency packaging. No native rebuild is introduced.

The optional `onSessionsChanged(ids, change)` observer runs after the write ACK
and, for a cache computation, after the final continuation apply. Observer
exceptions are caught and logged through the facade's `log.warn` (console by
default); they neither reject committed commands nor trigger stale-write retries.
The observer catch also accepts `null` and `undefined` thrown values, logging
their string representation. Direct `upsertCachedSessions` commands and recorded
upsert effects capture indexed folders before submission using `getCachedFolder`
(folder only; `null` means absent), independently for each upsert occurrence,
without a per-plan folder overlay. Once any occurrence
differs from the indexed folder, its id remains in the invalidation set even if a
later occurrence restores the original folder.

This capture is not ordered against commands already queued in the writer. Current
upserts go through the serialized cache-computation path; direct folder moves use
deletes. A future direct upsert overlapping a queued folder change could capture a
stale previous folder and misclassify the notification. Supporting that path would
require writer-ordered capture (for example, previous folders returned in the ACK).

An existing session whose folder changes reports its id without `upsertOnly`,
invalidating even an
available transcript memo (for example, a remote alias before its mirror exists).
Other upserts report deduplicated ids with `{ upsertOnly: true }`.
Direct `deleteCachedSession`
commands and recorded session-delete effects report deduplicated ids without an
upsert flag. A mixed batch reports deletions first, then upserts in a separate
call, so available sessions upserted in the same folder keep their memo. Changed
folder ids join the deletion invalidation call and are excluded from the upsert-only
call. Notification plans are published only after ACK and final continuation apply;
failed attempts discard their plans. Direct `deleteCachedFolder`,
`cleanupWorktree` and `dropRemoteFolder` commands, or a recorded `deleteCachedFolder`
effect, report `null` once for full invalidation instead of per-session calls.
Other commands/effects do not notify, including `touchCachedModified` and
`setCachedFileSize`. Computations (`refreshFolder`, `releaseLiveSession`,
`dropFolderRows`, `buildProjectsFromCache`, scanned-folder writes and Projects
worker effect application) notify only according to the effects they record.
Main forwards both arguments to Agents to invalidate transcript availability
after the indexed path is readable. Rejected commands do not notify; a rejected
multi-chunk command may already have committed earlier chunks, as described below.
See `bg-agents.md` and `test/session-index-writer-882.test.js` (#882).

Issue #740 adds nullable `session_cache.fileSize INTEGER` in writable schema
reconciliation. Existing rows and metadata remain intact; missing sizes are
filled by refresh. The size travels through cache upsert effects
and positional SQL binding, including scan-worker and subagent rows. Idle legacy
rows adopt an unknown size via `setCachedFileSize`, a one-column writer UPDATE
that preserves content and display recency. Both cache-effects and the Projects
query adapter record and locally apply this effect before writer admission. Main and
Projects workers retain their readonly connections.

## Wire contract and failure

Writer transaction BUSY diagnostics (#898) preserve the existing code-prefix
classification, four attempts and asynchronous 20/50/100 ms backoff. Each retry
increments `retries` for the submitted command name; the final failed attempt
increments `exhaustions` instead. Counts aggregate across chunks of that command
name (including `effects`), not individual nested effects. An unref'd 60-second
timer sends `{busyCounts:{command:{retries,exhaustions}}}` only for nonzero
intervals, then resets the counters. The transport client logs one `info` line
through the facade's logger (electron-log in main; console by default). Closing
the writer stops this timer before closing its store. Forced worker termination
also removes it; partial-minute counts are not flushed. There is no existing
writer activity-trace channel, so these counts appear in the application log
only, not the activity trace.

Main's readonly db.js facade wraps store read functions once. A thrown code
beginning with `SQLITE_BUSY` logs one `warn` line through electron-log, naming
the called store function, then rethrows the same error without a retry.
Settings mirror reads stay in memory; fresh settings reads use the wrapper.
Other readonly worker connections and connection bootstrap are unchanged.

Requests are {id,command,args}; replies are {id,result,settings} or
{id,error:{message,code},settings}. Bootstrap sends {ready,settings,searchFtsRecreated}.
An ACK follows the command's last transaction. Mutating replies carry a complete
settings snapshot which replaces main's initialized mirror, including deleted keys.
Read-only replies omit settings and preserve the mirror. _writer_revision advances
only when a transaction changes data. A registry list can initialize or normalize
the registry once; subsequent unchanged ticks do not advance the revision.

Up to 32 commands are in flight on the client. The worker keeps one background
command at the front and yields at each transaction boundary. Interactive commands
can run between units, with at most four interactive service turns before serving
pending background work. No filesystem I/O or await runs inside an ordinary
transaction. Cache computations retain their synchronous algorithms against
cache-effects.js: lazy reads of affected rows, local read-your-writes overlay,
then one acknowledged effects command. Worker admission checks its current revision
against that snapshot. A rejected main-cache computation may recompute at most
three times; stale Projects effects report WRITER_STALE for the readonly relay
to rebuild. Replies with no effects or retained live rows bypass the cache
computation queue, so a scan's outstanding folder ACK cannot delay first paint.
The Projects relay handles conflicts both before queue execution and at writer
admission: progress conflicts invalidate the job, and final conflicts use its
three-snapshot budget, then reject with PROJECTS_SNAPSHOT_CONFLICT and notify the renderer through the existing conflict recovery route.
Search publication reads the current name and cached summary on the writer.

An effects message is not one atomic transaction. Its admitted chunks remain
committed if an interactive command changes the revision between chunks.
WRITER_STALE rejects the remainder and its view; it does not roll back those
earlier chunks. The Projects relay rebuilds from a new SQLite snapshot rather
than replaying the old effect list. Source refresh upserts are repeatable, and
writer-owned name precedence preserves an intervening user rename. After three
conflicts no stale view is published; admitted chunks remain and the existing
conflict notification requests a fresh load. This is the bounded-chunk repair
contract, also used for already acknowledged folder progress in #718/#719.
`test/session-index-effects-retry-719b.test.js` exercises the shipped drain with
real disposable SQLite: partial commit, interleaved rename, stale remainder
refusal, then successful fresh-revision admission without undoing that rename.

BEGIN IMMEDIATE chunks target 32 SQLite changes and 65536 bound-input bytes.
Per-unit savepoints defer a unit to the next transaction when adding it would cross
the target; revision overhead is reserved. An indivisible oversized unit occupies
its own transaction and is accepted. Targets never reject a command. The clock is
injected in the store; the 10 ms target sums statement execution durations, excluding
queue time, BEGIN lock acquisition, JS preparation and commit. Exceeding it
reduces the next chunk's unit count. Transactions below 5 ms and within the row
and byte targets grow it by one, up to 32 units. Synchronous SQLite cannot be
preempted. A chunk buffers each consumed iterator unit so a BUSY rollback replays
the same units, including any savepoint-deferred unit, before advancing further.

Metrics retain the existing session_metrics table, its index and legacy SQL contract.
A per-session replacement is one atomic delete/insert transaction. Such a publication
is an indivisible unit; large replacements can exceed the change target. No view,
generation tables or durable staging schema is added. FTS bodies stage in a temporary
table, in
8192-character fragments, retaining the 32768-character body limit. A final
transaction replaces map/content/FTS from staged content; rename uses SQL SELECT
from stored content instead of binding the full body twice. Startup clears orphan
FTS staging. Folder commands retain the existing per-row/per-table publication,
not a new whole-folder snapshot protocol. A failed folder ACK keeps the initial
scan completeness marker unset so the next scan idempotently rebuilds the folder.

SQLITE_BUSY/extended BUSY retries use 20/50/100 ms asynchronous backoff, four attempts
total; other errors propagate. The 100 ms lock wait is excluded from the 10 ms SQL
execution target. Bootstrap and execution deadlines are 30 s. The worker sends a
started message on first execution, so time spent queued does not start the command
deadline. A command timeout reports its id and unknown outcome but keeps a responsive
worker alive; a late ACK still updates committed settings. Heartbeats distinguish
an unresponsive worker and permit termination. Crashes reject in-flight requests
with unknown outcomes; they are never replayed automatically. Only after awaited
termination may a replacement writer open, after 100/500/1000 ms backoff. At most
three restarts are admitted in a sliding 60-second window. A quiet window restores
the budget, including recovery from an open circuit on a later request.
Unsent requests remain queued for the replacement. A lost ACK can mean committed
work; the before/after-commit crash tests establish that distinction. Durable
receipts and status/replay recovery are deliberately not added in step 1.

## Read-then-write commands

| Command | Writer-owned current-state work |
| --- | --- |
| patchGlobal | Merge only supplied fields into current global |
| toggleStar / setStarred / setArchived / setName | Current metadata and per-field provenance in one transaction |
| renameSession | Name, current cached summary and FTS title in one transaction |
| rekeySessionMeta | Current predecessor/head values and per-field revision precedence |
| hideProject | Current visibility/kinds, deduplicated entry |
| unhideProject / revealAddedProject / clearArchivedEntry | Current visibility/archive state and offer retirement |
| retireArchivedEntries | Archive/hidden-project/offer snapshot check, exact archive-key retirement and current offer merge; filtering and schedule names stay on main |
| beginArchive / completeArchive | Current archive/offer merge, then guarded completion after schedule file effects; conflicts report partial effects |
| undoArchiveProjectFolders | Validate all archive timestamps, remove entries and restore consumed prior offers in one transaction; ACK only the exact `disabledByArchive` file lists for main to re-enable outside SQL |
| beginOffer / completeOffer / dismissReenableOffer | Current offer selection; completion compares the selected offer before changing it and reports conflicts explicitly |
| cleanupWorktree | Worker selects current matching rows, deletes in bounded units, then merges visibility/archive cleanup |
| dropRemoteFolder / completeRepairFolders | Bounded folder/cache/metrics/FTS deletion and current repair-list subtraction |
| scheduleRegistry(list/add/remove) | Bootstrap/normalization and current registry merge in one transaction |
| recordRemap / completeRemap | Merge folder remap, external atomic JSONL rewrite, explicit completion ACK |
| whatsNewStartup / patchGlobal(lastSeenVersion) | Current last-seen decision and field merge; changelog read outside SQL |
| effects | Revision-checked computed cache effects; each mutation runs in the worker |
| staged metrics / FTS publication | Current generation/head or name/summary resolved in the publication transaction |

Settings setSetting is an explicit replacement of the supplied key; patchGlobal is
the field-merge API. Main's own bounds and diagnostics toggles use field patches.
The repair completion command subtracts completed folders from current state.
Readonly Projects may compute effects in its overlay; only named writer commands
can persist them. Main reads remain readonly, including the existing search
fallback. No readonly reader can open a writable store through the guarded paths.

`get-projects` applies `archived-projects.applyAndPersistArchived` on main from
the acknowledged settings mirror. A local settings overlay captures the helper's
writes; project and session objects are shallow-copied before annotations so the
two views retain separate objects without cloning their full payloads. With no
retirement, the facade posts no writer command, including for the two builds in
`get-projects('both')`. Project rows never travel through the writer transport.

When reappearance clears archives, main sends the retired archive keys and the
mirror's `archivedProjects`, `global.hiddenProjects` and `scheduleReenableOffers`
snapshot in `retireArchivedEntries`. Inside the queued transaction the writer
compares those values with current settings, then retires exact existing keys
through `archived-projects.retireArchivedEntries` without parsing or re-encoding
them. Archive removal and offer creation commit together; unrelated entries
survive. Background cache/search transactions and unrelated global fields do not
conflict. A changed archive, visibility or offer snapshot returns `WRITER_STALE`
with current settings. Main recomputes from that acknowledgment, with at most
three admission attempts; on the third conflict it returns the computed project
list without persisting retirement. The next refresh can retry. This also covers
visibility and worktree archive changes, not just changes to selected keys.
Schedule names are still read on main after the write acknowledgment. Effect-free
reads use the acknowledged mirror without waiting for pending writes.

## Continuations and shutdown

Refresh and retained-live release await linked-source preparation before opening
the synchronous cache-effects recorder. A stale effects ACK recomputes preparation
from current rows. Collectors add deferrals even on failed attempts and remove
accounted paths only after successful ACK. One race retry per request occurs
outside recorder scopes; no async scan or await runs inside a recorder/transaction.
All resulting row, name, search and exact zero-folder-marker effects still use
the admitted writer path. A confirmed button or typed handoff shares one source
persistence sequence and captured exit pass. A forced shutdown timeout may
interrupt it; this is not an unconditional durability guarantee. The existing
bounded shutdown and admitted-work rules below remain in force.

Background re-key awaits metadata persistence before publishing the PTY/map/MCP/
activity identity. A pending command suppresses duplicate persistence. After ACK,
main checks the old map entry, source identity, target liveness, stop request and
background job proof again. Rejection or a changed proof keeps the old identity.
Synchronous non-background detection retains its existing behavior.

Both exit routes use boundedShutdown with one 1.5-second drain deadline after the unsaved
guard. Normal quit uses the idempotent shutdownForExit: beginShutdown closes external
writer admission immediately, retaining the AsyncLocalStorage scope for already accepted
workflows and the final cleanup writes. It stops
scheduler/watchers, kills the app's PTYs, awaits their exit cleanup, serializes the final watcher flush,
saves bounds, terminates/drains parser producers and pending metadata, flushes
activity, awaits reader-worker termination, drains complete accepted facade
workflows, closes main's reader, and awaits the writer's TRUNCATE checkpoint and
close ACK. A closed window retains its session ids and exit-drain promises until
shutdown can await and release them. PTY exit callbacks may release retained live rows
from their spawn-time async context after external admission closes; this exception
ends when closeDb starts or the writer is terminated. Other external writes stay refused.
After the
drain settles or expires, shutdown always requests writer, reader and parser worker
termination, rejecting unfinished writer callers with unknown outcomes and disabling
writer restarts. The task-records worker's disposal promise is retained as part of
the exit barrier. Repeated reader shutdown calls retain pending termination, and
writer/Projects/file-list termination failures remain failures for later callers.
Termination has an additional 250 ms grace period, never an unbounded await.
Only confirmation from every worker permits the idempotent exitOnce to call app.exit.
Otherwise the grace timer logs one line and calls process.kill(process.pid, 'SIGKILL').
This also terminates the current PID under Windows, as exercised by the Electron-as-Node
native SQLite regression. No watchdog process or RunAsNode fuse is needed for shutdown.
The main-thread timer remains runnable while worker.terminate is pending; entering
app.exit before the worker exits would instead block in Node's worker join.
The effective exit budget is 1.5 s drain + 250 ms worker grace, subject to OS scheduling.
A drain timeout logs an explicit exit line. Normal exit still checkpoints and closes
the writer before termination. A forced
exit can lose uncommitted transactions and commands without ACKs; chunks already
committed remain recoverable from WAL even without a TRUNCATE checkpoint. A missing
ACK has unknown outcome and is not evidence of rollback. synchronous=NORMAL retains
its existing power-loss limitation.
A close rejects new external admission while
AsyncLocalStorage preserves accepted workflows through nested completion commands.
For Linux installation and service-based relaunch, see [updater-relaunch.md](updater-relaunch.md).
Update installation drains watcher/bounds/metadata/activity and the accepted writer
commands without closing the database, stopping producers or killing PTYs. At the
same 1.5-second deadline it invokes the installer even if draining rejects or stalls.
The install flag bypasses another before-quit hold and resets on thrown or emitted
updater errors or an explicit false return, leaving a failed install usable. Only
when the installer actually reaches before-quit, the shared shutdownForExit holds
the quit and applies the same drain, worker stop, grace and single-exit barrier as
normal quit, bypassing the already accepted unsaved guard. This starts after
electron-updater/out/BaseUpdater.js has invoked install and its setImmediate emits
before-quit-for-update then calls app.quit on non-Linux. On Linux, successful
install(false, false) is followed by the relaunch helper, whose quit callback sets
the same flag and calls app.quit. No second install is invoked.
Idempotent cleanup stops schedulers, observers, MCP servers and SSH children and
closes the trace. Each disposer has isolated error handling; unrelated asynchronous
disposers add no hold, while the task-records worker must confirm exit.
Tests execute the installed BaseUpdater.quitAndInstall source with its installation
boundary substituted; no actual installer or windowed Electron is launched.
OS forced exits and unresponsive
renderer exit-flush bounds retain their existing limitations. Bootstrap failure
logs and displays a native error before exiting; second-instance ignores a destroyed
window.

## Qualification

Source tests and Electron-as-Node integration cover real SQLite readonly failure,
crash before commit, lost ACK after commit, lock exhaustion/release, queued close,
remap completion during close, atomic metric visibility, old-build reopening,
oversized archive/continuation values and complete FTS batches. Injected clocks cover
chunk adaptation, execution deadlines, heartbeats, restart windows and bounded exit.
Tests use temporary isolated data dirs. No live application process or packaged
build is used by these tests. The report in .work-files/codex-report-6166c.md records
the final executed file census and packaged qualification checklist.

## Projects ACK baseline (#719)

Effects replies carry committedRevision captured inside the last owned SQLite
transaction. The writer retains that token for Projects apply; other computation
return shapes remain unchanged. A revision discontinuity between effects chunks
refuses remaining effects with WRITER_STALE while preserving admitted batches.
Main compares the ACK with db.getSetting('_writer_revision', { fresh: true }),
which reads the persisted readonly store instead of the settings mirror. Ordinary
settings reads retain the acknowledged mirror. No-op applies retain the pre-await baseline.
Only post-ACK accepted final results advance projectsReconciledAt, including
accepted callerless reconciliation. Archive retirement and shutdown keep their
independent budgets and admission rules.
