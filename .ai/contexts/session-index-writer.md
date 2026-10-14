# Session index write facade (ADR 0004, slice 1a)

Baseline: `5b1d638`, branch `refactor/616-write-facade`. The connection,
bootstrap, SQL, main-side reads, whole-folder replacements and Projects reloads
remain unchanged. `createSessionIndexWriter` owns the production backend
injection. Main imports only read functions from `db.js`, with the explicitly
deferred continuation-metadata exception below.

The API consists of named asynchronous commands with explicit arguments and
Promise results, declared in `session-index-writer.d.ts`. Commands execute their synchronous backend before returning
their Promise. There is no deferred command queue. A cache/archives command
runs the existing synchronous algorithm with the synchronous backend; wrapping
each individual injected SQL function in an async function would introduce
suspensions inside algorithms that currently read their own writes.

`initializeCache` configures the cache; it is not a mutation command. It alone
injects the real backend into the synchronous cache implementation, and also
injects the facade for asynchronous producers. The Projects worker still uses
an in-memory effect adapter and never opens a writable SQLite connection.
Tests may initialize cache with an isolated stub/fixture backend directly.

## Writer -> command -> production callers

| Backend writer / algorithm | Facade command | Caller / trigger |
| --- | --- | --- |
| `db.js` schema, numbered migrations, schema reconciliation, bridge UUID repair, migration VACUUM | Existing synchronous connection bootstrap, loaded first by the facade factory's default backend | Module startup; no async bootstrap/ownership cutover in 1a |
| `deleteSearchType` | `deleteSearchType(type)` | Main's legacy `plan` cleanup; readiness awaited before creating the window |
| `setSetting`, `deleteSetting` | `setSetting(key,value)`, `deleteSetting(key)` | General settings IPC, bridge-repair gates, diagnostics/reporting preferences |
| `setSetting('global')` field merges | `patchGlobal(fields)` | Debounced and final window-bounds persistence; preserves working set and other keys |
| `toggleStar`, `setArchived` | `toggleStar(id)`, `setArchived(id,value)` | Session action IPC; return values unchanged |
| `setName`, cache-summary read, `updateSearchTitle` | `renameSession(id,name)` | Rename IPC; returns `{name}`; FTS body unchanged |
| `deleteCachedSession` (including metrics), `deleteSearchSession` | Corresponding named commands | Explicit session deletion, including merged members; original separate error catches retained |
| `deleteCachedFolder`, `deleteSearchFolder`, `deleteSetting` | Corresponding named commands | Explicit project removal; filesystem and schedule actions retain their order |
| Folder cache/metrics/FTS deletion, bridge-repair setting patch | `dropRemoteFolder(folderKey)` | Remote host removal / vanished mirrored folders |
| Cache, metrics, names, FTS, folder metadata, repair-gate writes in full scan | `writeScannedFolder(result,unverifiedLocalFolder)` | Startup/manual/subset/repair worker message producers |
| Cache, metrics, names, FTS, folder metadata in partial scan | `writeScannedFolderPartial(result)` | Remote file-subset scans |
| `upsertCachedSessions`, `touchCachedModified`, `replaceSessionMetrics`, `setName(...,'transcript')`, `deleteCachedSession`, FTS writers, `setFolderMeta` | `refreshFolder(folder,opts)` | Watcher, add/unarchive/remap; existing header-only/body/metrics rules retained |
| Running-row retention and cache/metrics/optional FTS deletion | `dropFolderRows(folder,opts)`, `releaseLiveSession(id)` | Vanished folder and PTY exit; release refresh remains inside the command |
| Injected `upsertCachedSessions`, `deleteCachedSession`, `deleteCachedFolder`, `touchCachedModified`, `setFolderMeta`, `setName`, `replaceSessionMetrics`, `deleteSearchFolder`, `deleteSearchSession`, `upsertSearchEntries` | `applyProjectsWorkerEffects(result)` | Projects relay; ordered effects and retained rows, awaited before publishing / updating version |
| Folder metadata backfill while building empty projects | `buildProjectsFromCache(showArchived)`; archive command's synchronous backend build | Main archive planner/backend; readonly Projects worker records effects |
| `setCachedEntrypoints(pairs)` | `setCachedEntrypoints(pairs)` | Entry-point backfill's 200-row ticks |
| `setCachedCustomTitles(pairs)` with mtime guard | `setCachedCustomTitles(pairs)` | Title worker messages; completion waits for accepted batches |
| `setCachedContinuationIndex(id,index)` | `setCachedContinuationIndex(id,index)` | On-demand continuation scanner |
| `setInitialScanComplete` | `setInitialScanComplete()` | Successful population `done`, after folder commands finish |
| `applySearchFileBatch(type,deletes,entries)` | `applySearchFileBatch(type,deletes,entries)` | Memory and Work Files; original 50-entry/128 KiB framing and yields retained |
| Global hidden/archive-kind changes | `hideProject(entry,kind)`, `unhideProject(entry,alias,path)`, `revealAddedProject(path)` | Settings archive / remove / unarchive / add |
| Worktree row selection, session/metrics/search deletion, hidden-kind cleanup, archive retirement, folder deletion | `cleanupWorktree(path,log)` | After successful git worktree removal; original best-effort catches and count retained |
| Archive/offer/visibility reads and setting changes, cache refresh/build | `archiveProjectFolders(groups,opts,deps)` | Archive-project IPC; existing synchronous archive/schedule orchestration stays on main |
| Global visibility read, archive reappearance and offer creation | `applyAndPersistArchived(projects,showArchived)` | Projects reply assembly, default view before archived view |
| Archive retirement, offer merging | `clearArchivedEntry(alias,path)`; also internal to unhide/add/worktree commands | Add / unarchive / worktree cleanup |
| Offer read, schedule reenable result, offer patch/delete | `reenableOfferedSchedules(path,folderKey,deps)`, `dismissReenableOffer(path,folderKey,deps)` | Schedule-offer IPC; existing notify and failure payloads retained |
| `projectRemaps` read/merge/write followed by atomic JSONL replacements | `remapProjectTranscripts(args)` | Remap IPC; cache refresh follows acknowledgment |
| Schedule registry bootstrap/normalization, add/remove read/modify/write | `scheduleRegistry(seed).list/add/remove` | Scheduler project supplier, launch registration, project add/remove/unarchive and archive planning |
| `global.lastSeenVersion` read/modify/write | `createWhatsNew(options).startup/dismissed` | What's-new IPC; menu read remains synchronous |
| WAL TRUNCATE checkpoint and connection close | `closeDb()` | `will-quit`; backend still closes synchronously before the returned Promise settles |

Scanned-folder arguments retain the existing `{folder,projectPath,sessions,
indexMtimeMs}` payload, optional `partial`/`toDelete`, and unverified-folder
handling. Search entries retain `{id,type,folder,title,body}`; effect commands
retain `{effects:[{name,args}],keptLiveRows}`. No transport, receipt, schema or
title-precedence protocol is introduced in this slice.

## Read-then-write boundaries

* Rename stores the name, reads the current cached summary and patches FTS
  inside one synchronous command body. Clearing the name and missing rows keep
  their existing semantics.
* Worktree cleanup selects current rows and performs all best-effort stages in
  one command after filesystem removal. It reads current `global`, changes only
  the matching hidden entries/kinds, retires archive state into current offers,
  then clears the encoded folder. Original errors remain swallowed/logged at
  the same stages; successful session removals retain their original count.
* Archive application, clear, offer dismissal and reenabling each run their
  existing visibility/archive/offer reads and writes without an `await` inside
  the command. Archive creation also retains the original before/after schedule
  writes and failure results. Filesystem actions are synchronous as before.
* Hide/unhide/add, schedule registry, remap, What's-new and window field patches
  read current settings inside their command rather than accepting stale whole
  settings snapshots across awaits.

Here atomic means the existing uninterrupted main-thread read/write sequence:
there is no suspension between those operations. No new rollback transaction
is added: doing so would change existing partial-error behavior, particularly
worktree cleanup and archive schedule failures. In 1b the durable portions must
become writer transactions, with filesystem/schedule effects outside them and
explicit completion commands. The injected runtime dependencies of the archive
commands are temporary main-backend configuration, not a worker wire format.

## Writer deliberately left direct

`main.js`'s `rekeyMetadata` callback still calls `db.rekeySessionMeta` for a
proven **background** continuation. `session-transitions.js` synchronously
proves ownership, calls this callback, and rekeys the PTY/maps/MCP/activity before
publishing. It is also entered by its own recheck timers, background roster
callbacks and exit-hold path. Simply making the callback async either ignores
its rejection or lets live rekey publication overtake persistence; awaiting it
requires changing the synchronous proof/lifecycle protocol. The brief permits
leaving a writer direct when routing requires a behavior change. This boundary
is deferred explicitly, rather than adding an unawaited facade call. The guard
allows exactly this one inline call and rejects additional raw imports/calls.

## Ordering and validation

Population/subset/title workers serialize message writes and drain them before
resolving their completion. Projects effects are awaited and incoming replies
are serialized while an apply is pending. File-list manifests advance after
their FTS acknowledgment. Scheduler project suppliers and explicit schedule
launch IPC accept the new Promise boundary. Full Projects reloads remain.

Characterization evidence and the complete final per-file test census are in
`.work-files/codex-report-6165.md`. This is an internal refactor: use the
`no-changelog` PR label. No worker cutover, incremental indexing, display delta,
renderer-store or typing-latency acceptance is claimed.
