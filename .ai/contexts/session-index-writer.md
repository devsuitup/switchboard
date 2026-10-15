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

## Wire contract and failure

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
three times; stale Projects effects reject for the readonly relay to rebuild.
Search publication reads the current name and cached summary on the writer.

BEGIN IMMEDIATE chunks target 32 SQLite changes and 65536 bound-input bytes.
Per-unit savepoints defer a unit to the next transaction when adding it would cross
the target; revision overhead is reserved. An indivisible oversized unit occupies
its own transaction and is accepted. Targets never reject a command. The clock is
injected in the store; the 10 ms target sums statement execution durations, excluding
queue time, BEGIN lock acquisition, JS preparation and commit. Exceeding it only
reduces the next chunk's unit count. Synchronous SQLite cannot be preempted.

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
| toggleStar / setArchived / setName | Current metadata and per-field provenance in one transaction |
| renameSession | Name, current cached summary and FTS title in one transaction |
| rekeySessionMeta | Current predecessor/head values and per-field revision precedence |
| hideProject | Current visibility/kinds, deduplicated entry |
| unhideProject / revealAddedProject / clearArchivedEntry | Current visibility/archive state and offer retirement |
| applyAndPersistArchived | Current hidden/archive/offer state and reappearance retirement; schedule names read outside SQL |
| beginArchive / completeArchive | Current archive/offer merge, then guarded completion after schedule file effects; conflicts report partial effects |
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

## Continuations and shutdown

Background re-key awaits metadata persistence before publishing the PTY/map/MCP/
activity identity. A pending command suppresses duplicate persistence. After ACK,
main checks the old map entry, source identity, target liveness, stop request and
background job proof again. Rejection or a changed proof keeps the old identity.
Synchronous non-background detection retains its existing behavior.

Both exit routes use boundedShutdown with one 1.5-second deadline after the unsaved
guard. Normal quit uses the idempotent shutdownForExit: it stops
scheduler/watchers, kills the app's PTYs, awaits their exit cleanup, serializes the final watcher flush,
saves bounds, terminates/drains parser producers and pending metadata, flushes
activity, awaits reader-worker termination, drains complete accepted facade
workflows, closes main's reader, and awaits the writer's TRUNCATE checkpoint and
close ACK. A closed window retains its session ids and exit-drain promises until
shutdown can await and release them. Success, rejection and deadline all end in
app.exit; subsequent quit events cannot get stuck behind a rejected promise.
A close rejects new external admission while
AsyncLocalStorage preserves accepted workflows through nested completion commands.
Update installation drains watcher/bounds/metadata/activity and the accepted writer
commands without closing the database, stopping producers or killing PTYs. At the
same 1.5-second deadline it calls quitAndInstall even if draining rejects or stalls.
The install flag bypasses another before-quit hold and resets on thrown or emitted
updater errors, leaving a failed install usable. OS forced exits and unresponsive
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
