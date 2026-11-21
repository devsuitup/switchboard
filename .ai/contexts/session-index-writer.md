# Session index writer — ADR 0004 slice 1b, step 1

Scope: one writable WAL connection in a Node worker; one main-side readonly
connection remains for the existing synchronous reads. Independent read workers,
removal of main's connection and general outcome recovery belong to step 2.
The dormant #474 A4b1 deletion substrate below provides operation-specific receipts.

Deletion completion/readback session notifications carry a second argument
`{operationId, expectedProjectEpoch, committedRevision}`. Receipts can be reread
after restart, so consumers can deduplicate the same operation/revision and
discard invalidations from an older project epoch. This is delivery identity,
not a durable acknowledgement or a once-across-restarts guarantee. See
[project-delete.md](project-delete.md) for the matching project/schedule ports.

## Consumed-request journal (#380 S1b1/S1b2)

Main passes the admitted writer facade as `sessionRequests` through
`createTriggerContext` to the watcher. Existing legacy and action requests now
claim their lowercase filename namespace before effects and journal terminal
bytes before publication. S1b3 adds typed session-status and permanent typed
open-session refusal consumption through the same admitted facade. It does not
claim a pending reservation before a read-only observation. Replay uses stored
bytes, timestamps and revision before age/caller/current-state checks. Each
candidate's command hash includes its exact bytes; a new candidate uses a new
token and cannot replace the first consumed result. No FULL authority is added.

Task head status reads use `task-records-client.readHeadForStatus(file,id,deadline)`
and the separate transcript worker, not the SQLite writer or get-task-snapshots
IPC. The request returns its head directly, expires/removes its pending waiter,
and ignores late replies. The worker reads only that transcript head, without
task ingestion, rekey, owner updates or task-snapshot broadcasts. Existing task
reader methods retain their notification behavior.
Status head computation also leaves the shared head cache and turn revision
unchanged, so a later snapshot or continued rekey cannot inherit a status read.

Writable reconciliation adds `session_requests` (one lowercase safe filename
stem per data directory) and `session_request_commands` (stem/actionToken
receipts). Neither table is cache data or references session/cache rows.
Deletion receipt maintenance, transcript removal, cache clear/rebuild and
processed-result removal must never expire these records. Existing deletion
tables, `projectDeletion`, `commitTransaction` and startup recovery are retained.
Both domains share `_writer_revision`; a journal result and its receipt are one
indivisible worker unit with one revision increment in `commitTransaction`.
The adaptive 32-row/65536-byte/10 ms policy and first oversized-unit exception
remain unchanged. There is no additional writable connection or FULL scope;
the existing WAL/NORMAL process-crash boundary does not promise power-loss
durability. Node22 fixture transactions do not qualify native crash ordering.

The command registry and admitted/drained typed facade expose:

| Port | Contract |
|---|---|
| `querySessionRequestOutcome({stemKey, suppliedHash?, rawHash?})` | Ordered worker read, without mutation/revision/settings ACK. Returns absent, owned, pending, completed or conflict. Read errors reject; cached readonly absence is never an outcome fence. |
| `recordConsumedSessionStatusRequest` | First-wins typed status bytes or typed open-session refusal; requires supplied hash. A later competing candidate cannot replace owner bytes, timestamps, physical publication stem or owner revision. |
| `claimSessionResultNamespace` | Minimal legacy/action filename tombstone, optionally adopting known pre-upgrade result bytes. An unknown supplied/raw identity remains owned and cannot grant an exact replay. This is not launch or retry authority. |
| `recordSessionResultPublication` | Complete an existing matching legacy/action claim once with saved result bytes. Mismatched identity/family cannot overwrite its pending or final state. Unknown identity cannot complete an uncertain effect with a new token. |
| `recordSessionRequestConflict` | Immutable conflict bytes keyed by owning stem and raw SHA256; repeated raw conflicts return the first bytes and timestamps. Requires an existing owner. |

Only an omitted family defaults to `session-status`; explicitly supplied
invalid families are refused, including null and other falsy values.

Outcomes carry `owner` for the original namespace and `conflict` separately
when applicable; `conflict:null` means no conflict envelope has been recorded.
Without supplied/raw identity an occupied stem is `owned`, even if it contains
terminal bytes. A matching identity reports `pending` or `completed`; a
different identity reports `conflict`. Case aliases share the lowercase key;
the original `actualStem` remains unchanged. Action publication stems must be
lowercase; legacy and typed stems preserve actual spelling. Non-UUID safe
legacy basenames remain valid. Validation checks the complete `<stem>.json`
basename on the host platform, so an empty stem or a space/dot before the
suffix does not become a new legacy restriction; NUL and path components are
refused.

An equal non-null raw hash also matches an owner with a supplied identity.
This lets byte-identical action requests replay across case spellings whose
filename validation yields different supplied identities. The original family,
publication spelling and result bytes still win; owner replays never create a
conflict receipt.

Mutating inputs carry actionToken and argsHash. Producers use the exported
`hashSessionRequestCommand(command, input)` in `session-index-commands.js`:
sorted exact command arguments, including result bytes, family, supplied/raw
identity, actual spelling and token, excluding argsHash itself. Buffer and
Uint8Array candidates hash identically across structured clone. The worker
verifies the hash before receipt lookup. Same command/token/args returns the
original receipt without writes; different arguments or command for that token
reject with `SESSION_REQUEST_TOKEN_CONFLICT`. A mismatched candidate digest
rejects with `SESSION_REQUEST_ARGS_HASH`. Distinct concurrent candidates use
distinct tokens; a losing candidate gets the first owner's record and a
receipt for its own command. Owner revision remains historical while that
new receipt has its own commit revision.

SQL stores result bytes as BLOBs. Receipt JSON base64-encodes bytes without
parsing or rebuilding public envelopes. Statements are lazy; write statements
are prepared only on writable connections. Readonly pre-migration opens do
not create tables: `sessionRequests.available()` is false and raw get/receipt/
conflict reads throw `SESSION_REQUEST_SCHEMA`. The authoritative command also rejects unavailable schema, rather
than treating it as absence.

Conflict recording rejects both the owner's own raw hash and a matching supplied
identity with `SESSION_REQUEST_INPUT`; an owner replay cannot poison subsequent
ordered queries with its own conflict receipt. The plain-Node fake-parentPort
worker fixture exercises all five commands and checks transaction rollback when
receipt insertion fails, including claim and consumed-result insertion.

Consumers must query exact replay before gathering current state; a consume
ACK is required before publication or input cleanup. A lost/rejected/late ACK
does not prove rollback. An explicit subsequent ordered query recovers any
committed bytes; a late ACK must not revive an abandoned publication attempt.
The generic transport is unchanged and does not replay unknown writes. All
five ports use normal admission, shutdown tracking and drain behavior.

This slice has no trigger caller, namespace lock, publisher, status gatherer or
new external endpoint. S1b2 owns universal existing-family guards/publication;
S1b3 owns typed status dispatch/evidence. A pending legacy/action claim never
permits re-executing an uncertain old effect; existing #1022 recovery remains
responsible for reconciling it.

## Dormant project deletion substrate (#474 A4b1)

Writable schema reconciliation adds `project_delete_fences`,
`project_delete_operations` and `project_delete_units`, with project/state and
terminal-retention indexes. A cascade trigger also removes units when foreign
keys are disabled. Existing stores upgrade additively; readonly opens do not
create these tables and can open an unmigrated database. Deletion statements
are prepared lazily on first use; header/fence/progress writes, unit results
and bounded receipt maintenance statements are prepared only by a writable
connection. Readonly connections can read deletion tables after migration.

`src/main/projects/project-delete-progress.js` owns the dormant admission,
staging, effect transaction hook, status, fence and restart primitives.
`commitTransaction` is shared with the worker's existing transaction/BUSY
wrapper: the hook receives the exact next revision and writes progress before
the revision and COMMIT. Rollback undoes both effect and progress. No completed
array grows in a header; results live in ordinal unit rows.

Admission compares the integer `_writer_revision`, canonical host/path epoch
and durable snapshot digest before claiming an epoch and inserting the header.
An optional synchronous first-effect hook shares that transaction and records
the first unit result/cursor there. It requires a completely staged bounded
manifest; larger manifests stage before a later effect transaction. This is a
trusted backend seam, with no worker command for admission or effects. The
manifest hash binds the supplied manifest and ordered targets. Staging admits
at most 16 units per transaction and defers targets using the production
savepoint budget with progress/revision overhead reserved. Effects run one unit
per transaction, checking ownership, seal, hash, staging and revision inside
that transaction. The first indivisible oversized unit retains the existing
budget exception. An unexpected synchronous exception rolls back its chunk;
the caller must fence/reconcile the open receipt, rather than infer rollback
of earlier chunks. A recorded failed unit seals partial.

Worker bootstrap includes recovered operation/project identities in
`ready.recoveredProjectDeletions` and seals every unfinished header partial before `ready`, one
transaction per header, advances only its matching owned epoch and never
replays pending effects. There are at most 32 active headers. Maintenance
deletes at most 16 unit rows per transaction; terminal details are limited to
128 receipts and seven days after maintenance converges. Epoch high-water rows
survive receipt removal. Each admit/apply/fence/recover call performs at most
one purge transaction; large receipts leave excess terminal headers for later
calls. Snapshot reads retain no hard wall-time bound.

Only `getProjectDeletionState`, `readProjectDeletionScope` and
`fenceProjectDeletion` are forwarded by the typed facade. The two read ports
run consistent reads directly on the worker connection without revision or
settings-mirror publication. Fence is a service-boundary operation with the
existing BUSY retry policy and publishes a settings ACK only when it changed
the revision. It rereads durable state after sealing. Epoch checks reject an
old buffered/unsent unit when it eventually reaches the dormant effect seam;
there is no completion generator to cancel in this slice.

`absent` and `inProgress` give no terminal proof. Only a matching absent fence
can record `notStarted`. Missing/expired receipts after epoch advancement give
`unknown` with `noLateCommit:true`, without fabricated completed lists. Fresh
hidden/settings/metadata observations carry `readRevision`, distinct from
receipt `lastRevision`. A terminal receipt is immutable; an old fence cannot
clear a newer owner. Same-hash duplicate admission observes the receipt and
never replays effects; a notStarted tombstone rejects admission.

Scope readback supplies raw persisted rows, metadata/provenance, folder mappings,
settings-key presence and conservative cross-project ownership evidence. It is
not proof of runtime inventory, metadata-only orphan ownership or settings
erasure safety. A4b3 owns that validation and the shared identity/hash extraction.
No archive-workflow exclusion, metadata deletion engine, complete command,
main/IPC/UI caller or general producer cancellation is added here. See
[project-delete.md](project-delete.md) for the remaining slice boundaries.

The #820 column reconcile adds `runtime TEXT DEFAULT 'claude'` and `sessionFile TEXT`
on writable opens only, without setting `mustReindex` or deleting rows. Existing
named-column upserts are unchanged. See [cli-harnesses.md](cli-harnesses.md).

`hideProject(entry, kind, scope?)` persists optional `{ alias }`
records in `global.hiddenProjectScopes` through the existing writer command.
For `kind: 'archive'`, that same atomic patch records `Date.now()` in the additive
`global.hiddenProjectArchivedAt[entry]` map. The archive IPC already uses this
command, so no separate renderer write or patch race is introduced. Unhide,
re-add and worktree cleanup remove the matching timestamp. Both `hideProject`
with kind Delete and the deletion engine's finalization remove it too. The writer
omits `hiddenProjectArchivedAt` when the map becomes empty, preserving the old
global-record shape; timestamps for unrelated entries remain intact. Legacy entries
without a timestamp stay undated; re-archiving (including Undo of Unarchive)
records a new date. No stored entry or worktree key is regrouped.
Archive retirement compares scopes in both the facade snapshot and writer-side
stale check. Unhide and re-add clear the matching entry and its scope. Local
worktree cleanup deletes cached rows for the path on every host and removes the
stored path mark and its scope. Legacy callers
without a scope keep the prior global-record shape. Matching is shared with the
renderer through `public/worktree-nesting.js`; see session-cache.md, Project
Archive and Delete.

Before any caller supplies a scope, the scoped deletion flow must resolve the
existing `hideProject` scope-overwrite behaviour: a later scoped call can replace
a prior scope for the same entry.
An existing unscoped mark must retain its every-host meaning.

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
through the facade's logger (electron-log in main; console by default). The
injected `onBusyCounts(counts)` callback passes through the facade to the client;
main emits `session-index-writer.busy` with null session id and payload `{ counts }`
when `TRACE.on` is enabled. Closing the writer stops this timer and
flushes any nonempty partial-minute counts before `db.closeDb()` and its
checkpoint. The flush resets the counters; idle closes are silent. Forced
worker termination cannot flush counts that have not reached the client.

Main's readonly db.js facade wraps store read functions once. A thrown code
beginning with `SQLITE_BUSY` logs one `warn` line naming the called store function
and the first frame outside db.js of the wrapper's own stack (the caller of the read, not the store frame that threw), then rethrows the same error without a
retry.
The logger defaults to console; db.js never imports electron-log. The writer
facade injects its logger once the readonly backend is ready through
`setReadLogger(log)` (electron-log in main).
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
pending background work. The consumed-request journal commands
(`querySessionRequestOutcome`, `claimSessionResultNamespace`,
`recordSessionResultPublication`, `recordConsumedSessionStatusRequest`,
`recordSessionRequestConflict`) form a third lane, selected right after the
control commands and before any other interactive or background command; a
journal selection neither increments nor resets the interactive burst counter
(#1073). The lane cannot starve indexing indefinitely: the trigger watcher keeps
at most eight triggers in flight, each issuing three or four journal commands
separated by delivery work. The facade times each journal command from
`send()` to its ACK and logs one `warn` line,
`[session-index-writer] journal command <name> waited <n> ms`, when the wait
reaches 200 ms (`journalWaitWarnMs`); a shorter wait logs nothing, so an
absent line after a trigger means "under 200 ms", and an empty log with no
trigger dropped means "not measured". No filesystem I/O or await runs inside
an ordinary transaction. Cache computations retain their synchronous algorithms against
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
preempted. The worker also caps each chunk by wall time: it sums the
`performance.now()` time of every `chunkUnit` call and stops admitting units
once 10 ms (`chunkWallTimeMs`) have been spent, in addition to the unit-count
target (#1073). The first unit of a chunk always runs, so an oversized unit
still occupies its own transaction; nothing is appended behind it. This caps
the time a command arriving mid-chunk waits to one chunk of about 10 ms plus
one unit; the store's statement-time adaptation is unchanged.
`test/session-index-writer-chunk-wall-time.test.js` drives the shipped worker
with `test/fixtures/writer-slow-units.cjs` (15 ms per unit): 32 slow rows
commit as 32 transactions, and a journal query posted behind them is answered
in under 200 ms and before queued `setSetting` commands. A chunk buffers each
consumed iterator unit so a BUSY rollback replays the same units before
advancing further. Units the chunk consumed but did not commit, because a
savepoint deferred one or because the retry closed on the wall-time cap
earlier than the failed attempt, stay on the message as `pending` and are
served ahead of the iterator by the next chunk, so each unit is committed
exactly once, in order. `test/session-index-writer-busy-short-retry.test.js`
drives the shipped worker with `test/fixtures/writer-busy-short-retry.cjs`,
which injects SQLITE_BUSY after the third unit and a 15 ms jump after the
first replayed one: all five rows commit, in iterator order.

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

Without an epoch proof, retirement retains its two-argument transport shape.
Archive keys remain exact storage keys: the remote-root key `host::` decodes to
`/` only for workflow and writer identity guards, never for persistence. Remote
POSIX and host-qualified Windows paths retain the archive identity adapter.
Dismissal validates empty or non-string paths before the writer identity guard,
returning the legacy error without changing offers or notifying the renderer.

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

Archive workflow admission and cancellation now share one client-scoped gate
across withCache facades; see [project-delete.md](project-delete.md),
"Archive workflow exclusion (A4b2)". Ordinary workflows share keys; only deletion
reservations exclude new work and wait for all admitted leases. List reads
tolerate blocked identities and skip epoch IPC when the reader's cheap
`projectDeletion.hasFences()` query finds no fence. Actual retirement retains
writer admission guards, including epoch-zero checks on the fast path. Failed
cancellation reconciles only after confirmed old-worker termination; failure
and circuit-stop cleanup retire client workflow seals after removing requests.
`readProjectArchiveEpochs` and workflow
fence/retirement controls are read/control turns without a revision increment
or settings publication. Archive mutations retain the ordinary single
commitTransaction revision increment. Deletion receipt purge uses a bounded
maintenance transaction outside that data revision, avoiding self-staling
owned deletion chunks. The #380 session-request tables, commands and receipt
revision behavior coexist unchanged with these APIs.

Source tests and Electron-as-Node integration cover real SQLite readonly failure,
crash before commit, lost ACK after commit, lock exhaustion/release, queued close,
remap completion during close, atomic metric visibility, old-build reopening,
oversized archive/continuation values and complete FTS batches. Injected clocks cover
chunk adaptation, execution deadlines, heartbeats, restart windows and bounded exit.
Tests use temporary isolated data dirs. No live application process or packaged
build is used by these tests. The report in .work-files/codex-report-6166c.md records
the final executed file census and packaged qualification checklist.

## Project deletion completion (A4b4)

A4b4 adds dedicated completeProjectDeletion dispatch beside deletion scope/status
and terminal fence controls; see [project-delete.md](project-delete.md),
"Complete command and recovery integration (A4b4)". Each deletion iterator turn
owns its progress transaction rather than passing through generic effects.
Tiny completions may commit once; staged/effect prefixes remain observable and
revision/epoch/ownership fenced. Final logical removal and receipt sealing are
atomic, subject to the documented indivisible oversized-setting exception.
Producer epoch bindings are captured on message receipt and rechecked across
all selected cache/FTS/metadata units, including search-staging publication.
Receipt of either completion or fence synchronously registers that message in
a pending-history set, before binding or starting its first transaction. While
any such message remains, incoming producers force an epoch binding even when
durable deletion history is still absent. This covers producers received during
the first transaction's SQLITE_BUSY backoff, including tiny one-transaction
completions. Each message leaves the set after a successful turn makes history
visible, or on completion, error or workflow cancellation. Multiple queued
deletions therefore cannot clear one another's protection. The existing forced
binding of already queued producers at deletion start still covers earlier
receipts. With neither pending deletion nor durable history, producers retain
their constant-time early exit without ownership queries or path resolution.
The facade holds archive exclusion through unknown outcomes and only releases
after terminal/no-late-commit proof. No main/IPC/UI caller is connected yet.

Archive retirement exhausting three snapshot conflicts returns the computed
project list without persisting the stale decision, as before A4b4. Reserved
identities remain excluded by the workflow lease. At exhaustion, the reader's
current durable fences additionally exclude blocked identities; a failed fence
read conservatively keeps that entry archived. This read changes rendering only
and never authorizes a write. A later clean refresh can retire eligible entries.
Successful retirement still filters rendering by the writer's returned keys.

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

## Bounded deletion reads and generation observation (#474 A4c1)

`readProjectDeletionSnapshot({section,cursor,limit,maxBytes,expectedRevision})`
and `listProjectDeletionOperations` are worker-ordered keyset reads. Sections are
sessions, folders, metadata, fields, settings, fences and operations. Pages have
`{revision,rows,bytes,nextCursor}`; the default limit is 256 (hard 1000), default
page byte cap 1 MiB (hard 8 MiB). Invalid requests or a single oversized row refuse DISCOVERY_LIMIT;
a page stops before the first row that would exceed its conservative byte bound
and returns the last included key as nextCursor;
a changed expected revision refuses SNAPSHOT_STALE. The store checks a conservative
JSON-escaping byte bound before constructing/fetching JSON payloads. Provenance
pages seek rowid under the unchanged revision, avoiding a whole-table sort.
SQL stays inside session-index-store; the snapshot module validates the page
contract and revision. `readProjectDeletionRevision()`
returns the numeric fence without writes. Read routes bypass transaction/mutation
routing and never advance the revision. Successful reads omit a settings ACK;
the existing drain error path attaches current settings to refused reads. No schema change
or access to the #380 request journal tables is involved.

The client invokes `onBootstrap` once per ready worker generation, after settings
delivery and before dispatch. Observer exceptions cannot break transport. The
client logs the first bootstrap observer exception through its existing log port
once per client lifetime, including facade observer failures; a throwing logger
also cannot interrupt transport. A
replacement generation updates the facade's detached `getRecoveryBootstrap()`
snapshot and optional observer even though `ready` remains a one-shot promise.
Old-worker messages cannot replace current recovery evidence. Bootstrap contains
the interrupted operations sealed by startup; bounded receipt enumeration also
finds retained committed operations whose original reply was lost. Observation
does not replay work or release unresolved archive reservations.

The post-commit history probe is auxiliary: a failed probe retains the pending
history guard and preserves the committed ACK/settings bookkeeping. The original
transaction error path is unchanged. The full worker is tested with a real guarded
SQLite fixture and the real client/facade; generation replacement uses a fake
worker in `test/session-index-writer-recovery.test.js`, without Electron.
# Full-content publication (#1144 A1)

The writable store reconciles nullable `session_cache.fullReadStamp` and
`cache_meta.fullIndexVersion/fullIndexConfig/fullIndexPending` columns through
idempotent ALTERs. Adding these columns does not set `mustReindex`, delete cache
or metadata, or clear initial completeness. Readonly snapshots and metadata
overlays retain the fields. FTS absence or recreation durably clears folder
version/config before writer readiness; reopening before population cannot
recover an obsolete seal from an ephemeral bootstrap flag.

A producer computes its effects first and ACKs `beginFullIndex` only for full
row replacements (including an empty full-folder scan). A no-op watcher refresh
keeps its single folder-meta effects request; a pending-repair early exit sends
nothing. The begin receipt advances the body snapshot revision.
Its first replacement effect invalidates the old folder seal even if begin
failed or its outcome is unknown. A scan's folder drop removes session rows
while retaining the metadata row and pending token; project deletion still
deletes the complete metadata row. Ordinary setFolderMeta preserves the fields.
The drop remains a `deleteCachedFolder` effect, including through worker chunking,
so observers still receive the broad `null` invalidation. Deleted-file counters
include dropped rows absent from the replacement, even when begin failed or a
subset only deletes files. Certificate SQL statements are prepared once per store.
Ordinary overlay folder deletion reads no full-index metadata; only a drop with
`preserveFullIndex` consults the previous pending token.

Begin remains after effect computation: full-read candidates, affected folders
and the no-op/repair early exits are only known from the computed effects.
Moving it earlier would either invalidate those no-op paths or require a second
discovery pass. Its expected-revision fence and the existing bounded stale retry
remain necessary; no new optimistic pre-compute begin is introduced in A1.

Affected rows lose certificates before materialized replacement. Candidates
are withheld from upserts, then published by one separately ACKed direct
`certifyFullReads(folder, token, rows)` command per nonempty folder after all
body, metrics and staged FTS work. Each certificate compares the folder token
and materialized row witness. The worker iterates one row per unit through the
existing adaptive 32-row/65536-byte/10 ms transaction budgets and background
scheduling, returning one settings snapshot after the whole command. Rejection
is accumulated across committed chunks, never overwritten by a later successful
row; rollback retries recompute only the uncommitted chunk result. All chunks
retain the project-deletion producer fence. `sealFullIndex` compares the token
and captured canonical configuration (sorted remaps, deduplicated/sorted
disabled harness IDs, resolved source roots). A full scan records the content
version; a partial operation restores only an existing full baseline.

Begin/effect failure leaves conservative state. Legacy producers still submit
their existing write on begin failure; A2 startup rejects that publication and
replans from a fresh snapshot. Certificate rejection or failure skips that folder's seal;
transport failure is logged as an unknown outcome and never rejects an already
committed body. A seal with unknown outcome is logged, never retried or
compensated: it either leaves pending state or committed a valid seal over
fully ACKed effects. A newer folder token supersedes older work. Certification
does not use global writer revision as its freshness fence. Projects replies
retain their independent revision-continuity check and return the final owned
ACK only for a continuous sequence; otherwise they retain the body ACK so the
reader can detect intervening work. This check does not reject certification.
Batch receipts carry the first before-revision, final committed revision and
continuity across chunks. An unrelated write between chunks breaks Projects
receipt continuity without refusing token/witness-valid certificates.

The commands bracket producer operations at the facade. They do not alter
the generic chunk scheduler, producer-unit packing, transaction budgets or
admission. The payload deadlines below apply to every `effects` command,
including refresh, project-worker and remote producers (#1135). Certificate commands participate in existing
project-deletion ownership fencing. Repair invalidates its folder seal before
scanning and joins startup population; its marker clears only after successful
sealed publication.

Parser/merge/metric/search output changes must bump
`SESSION_CONTENT_INDEX_VERSION` and add an immutable golden digest entry; see
[session-cache.md](session-cache.md), "Full-content observations".

A2 startup checks the captured row/folder/configuration inventory and source
observations before queueing. Subset witnesses cover only upserted/deleted rows
and their metadata, plus the folder's project path, content version/configuration
and pending token. The watcher mtime watermark is not a content fence. Full-folder
replacement still witnesses the entire folder. Rows are sorted by session ID
on both readonly and writable connections. The facade checks the same inventory
when computation starts; begin and each effect transaction check the same row
scope, retaining the resulting witness for the next chunk. Unrelated row header
refreshes and writer commits do not invalidate startup. Other effect producers retain their
existing revision guard. `WRITER_STALE` returns to population for up to two fresh
folder selections, without replaying stale parsed rows. Deletion-only subsets use the
pending/seal protocol. A deferred ordinary row publishes the bytes read without
a certificate when its current row still equals the selected inventory row (or
the row is new). A newer watcher replacement and existing deferred bridge groups
remain untouched. Converting a full result to a subset retains deletion of
inventory rows absent from the full read, excluding deferred IDs.
Deferred publication leaves the folder pending and unsealed while population completes successfully.
Watcher publication of a marked repair also leaves it unsealed. Deferred
generations clear after ACK only for the accepted paths, even when neighboring
paths remain deferred. Name derivation also runs for non-deferred rows after
that ACK; neither operation certifies a deferred source or seals its folder.

`deriveCachedName` checks the expected body stamp and metadata witness, applies
existing transcript-name rules and repairs only a changed search title. After
that command ACK, `certifyNameDerivation` checks the post-effect witness again.
A concurrent user rename rejects certification. Collision suppression records
no completed witness, so removal of a collision descriptor is retried even
when the body is unchanged. Both commands keep session deletion fences.

Startup uses `deriveCachedNames` to batch a folder's candidates in one request.
Each row derives and certifies in one worker unit; the existing adaptive chunk
budgets still apply. The batch binds all session deletion owners on admission,
and every unit checks its own binding before writing. The single-row facade
retains its separate ACK protocol for existing callers.

The obsolete single-row worker `certifyFullRead` command is removed; certificate
units invoke the store method directly inside `certifyFullReads`. The real
worker facade test uses 80 certificates and an intervening setting write to
prove `continuous:false` returns the body ACK.

## Large-folder deadlines and interrupted publication (#1135)

The transport scales the started-command deadline for every `effects` command,
full-read certification and batched name derivation. The multiplier is the larger
of one, the estimated payload's 32 KiB blocks, and its 32 work-row blocks.
Bulk session, search, entrypoint and title effects count their immediate rows;
other effects count once. Certification and name derivation count their candidates.
Nested metrics are not counted again as work rows in both session upserts and
metric replacement; their payload size still contributes to the byte estimate.
A single iterative walk estimates bytes from string/key lengths (two bytes per
UTF-16 code unit), structural delimiters and fixed-size scalar allowances,
without serializing a copy. A WeakSet visits shared/cyclic objects once; BigInt
uses the scalar allowance. An unreadable payload falls back to the maximum.
Each block receives the existing 30-second allowance, capped by
`MAX_WORK_COMMAND_TIMEOUT_MS` at ten minutes, matching the subset scan ceiling.
Small/control commands, bootstrap, heartbeat and admission retain
their existing budgets. This bounds a command by the work carried in its
payload without changing the worker's transaction packing, yields, fences
or scheduling. The work-row count also covers many small rows; estimated bytes
cover large text/metrics/witness payloads. This is a finite
work allowance, not a guarantee under arbitrary CPU starvation.

After a startup folder's body ACK, the facade retains its existing pending
token, configuration and proposed per-row certificates for a retry in this
writer lifetime. It does not treat this memory as committed progress: on
retry, it rereads the durable pending token and each row certificate/witness,
and compares them with the newly scanned source candidate and configuration.
Only matching, durably certified rows bypass replacement. A full retry uses
the existing partial writer to preserve those rows, deletes vanished inventory
rows, and still seals as a full scan only after the remaining writes and
certificates. Multiple failed retries retain the preserved candidates.
A superseded token, changed configuration/source/row or absent certificate
requires republication. An unknown body outcome has no new certified progress
and cannot authorize skipping its rows. No receipt table or parallel durable
progress mechanism is introduced. After process restart the provenance hint
is gone and A2 conservatively performs full validation again.

The scan coordinator still allows only three delayed retries (30 s, 120 s,
600 s), then retains its error with the retry time at Infinity until an
explicit forced scan or a later startup. Unknown certificate outcomes leave
the folder pending/unsealed and initial completion false on a cold failure.
Seal remains last; an unknown seal outcome is logged without compensation.
A2's successfully published deferred sources still count as complete for
population while their folder remains pending.

The regression uses real disposable SQLite, the production scan worker,
facade and writer, with a virtual slow transport to exercise command expiry.
The interrupted certificate test commits a prefix of single-row chunks,
then loses the next outcome and verifies that retry preserves certified rows.
Retry regressions also remove a transcript, edit a durable title without
clearing its certificate, and change only source ctime while retaining identical
parsed row witnesses. Each compares the resulting index with a separate full
rebuild; the source-only case isolates the source-stamp reuse guard.
