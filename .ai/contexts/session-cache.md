# Context: session-cache

**Purpose**: index every Claude session JSONL on disk into a queryable SQLite cache so the sidebar renders without re-scanning `~/.claude/projects/` and so search is full-text. Watches the projects directory for changes and refreshes incrementally.

## Key files

| File | LOC | Role |
|---|---|---|
| `db.js` | ~895 | SQLite (better-sqlite3) schema + prepared statements. Owns `session_cache`, `session_meta`, `cache_meta`, `settings`, `search_fts` (FTS5 + trigram tokenizer). |
| `session-cache.js` | ~690 | Indexer + watcher. Reads `~/.claude/projects/<folder>/*.jsonl` (+ subagents subdir), populates rows, emits projects-changed events. |
| `read-session-file.js` | ~420 | Streaming JSONL reader. `readSessionFile()` (full) + `readSessionDisplayHeader()` (256 KB / 500 lines — cheap header for huge files). |
| `encode-project-path.js` | 28 | `/path/to/project` → `-path-to-project` folder name. Mirrors Claude CLI's encoding. |
| `derive-project-path.js` | ~155 | Inverse: read `cwd` field from JSONL, derive original projectPath. **Collapses worktrees back to parent repo** via `resolveWorktreePath`. |

## Public surface

From `db.js`:

- **Sessions**: `getAllCached`, `getCachedByFolder(folder)`, `getCachedByParent(parentSessionId)`, `getCachedSession(sessionId)`, `upsertCachedSessions(rows[])`, `deleteCachedSession`, `deleteCachedFolder`
- **Meta**: `getMeta`, `getAllMeta`, `setName`, `toggleStar`, `setArchived` (session-level user state)
- **Folder meta**: `getFolderMeta`, `setFolderMeta(folder, projectPath, indexMtimeMs)` — tracks index freshness
- **Search**: `searchByType(type, query, limit, titleOnly)`, `upsertSearchEntries`, `deleteSearchType/Session/Folder`
- **Stats**: `getDailyActivity()` — `GROUP BY substr(modified, 1, 10)`, returns `[{date, messageCount, sessionCount}]` (heatmap source)
- **Settings**: `getSetting`, `setSetting`, `deleteSetting`
- **Misc**: `touchCachedModified(sessionId)` — 1-column UPDATE, cheap

From `session-cache.js`:

- `init(ctx)` — wire main process → cache (mainWindow ref for IPC events)
- `refreshFolder(folder, opts)` — opts `{files: Set<string>}` for targeted refresh (watcher payload). Defaults to full folder walk.
- `populateCacheFromFilesystem()` / `populateCacheViaWorker()` — initial scan / re-scan. The worker (`workers/scan-projects.js`) streams one `{type:'folder', result, current, total}` message per on-disk folder (plus a final `{type:'done'}`) instead of buffering the whole tree, so each folder is written to the DB and pushed to the renderer as soon as it's read — a large history no longer leaves the sidebar empty for the entire scan.
- `buildProjectsFromCache(showArchived)` — produces the sidebar payload (sorted, grouped by project, missing flag computed here)
- `notifyRendererProjectsChanged()` — throttled (~1.5s leading-edge) push to renderer
- `sendIndexingProgress()` (internal) — emits the `indexing-progress` IPC event, gated on `coldStart` (captured once at the top of `populateCacheViaWorker()` via `!isInitialScanComplete()`) and throttled to ~4 events/s (the first event and every `done:true` always pass). Feeds the renderer's first-run banner; see `.ai/contexts/ipc-bridge.md`. A `done:true` payload carrying `error` keeps the banner visible with the failure message instead of hiding it.

From `derive-project-path.js`: `deriveProjectPath(folderPath)`, `resolveWorktreePath(cwd)`.

## Invariants

- **`modified` is always ISO8601 string** (`2026-05-22T20:59:33.000Z`). `substr(modified, 1, 10)` is the canonical "day" derivation. Don't switch to epoch ms without migrating.
- **`session_cache.folder` is the encoded form** (`-home-jean-baptiste-workspace`). Use `encodeProjectPath()` to derive it from an absolute path.
- **WAL mode is enabled on SQLite open** — multiple readers OK; serialise writes. Concurrent writers will fail with `SQLITE_BUSY`.
- **`refreshFolder` is idempotent** — calling it twice with the same `opts.files` is safe; the `filePathToDbId` inverted index makes lookups O(1).
- **Header-only refresh** (via `readSessionDisplayHeader`) merges with the cached row to preserve `textContent`, `aiTitle`, etc. Don't overwrite cached fields with `null` from a partial read.
- **FTS entries follow `{id, type, folder, title, body}`** shape. `type` is one of `'session'`, `'subagent'`, `'memory'`, `'work-file'`. Mixing types within one upsert is fine.
- **`get-projects` never awaits the cold-start scan.** `main.js`'s handler fires `populateCacheViaWorker()` without `await` when the cache is empty, returning whatever's cached right now (still non-empty for project *names* — `buildProjectsFromCache` lists on-disk directories synchronously even with zero indexed sessions). Progressive fill-in relies entirely on `notifyRendererProjectsChanged()` firing per folder. Don't reintroduce the `await` — it's what caused the multi-minute blocking "Loading…" on a large `~/.claude/projects/`.
- **"Cache has rows" does not mean "initial scan finished".** The worker streams one DB write per folder, so killing the app mid-first-scan leaves `session_cache` partially populated. The authoritative signal is the `initial_scan_complete` settings key: written by `session-cache.js` only on the worker's final successful `done` message, backfilled once by migration v8 for pre-marker installs (their populated caches could only come from completed batch-write scans), cleared whenever the schema-reconciliation pass wipes the cache. `get-projects` treats "rows present but marker absent" as an interrupted scan: it resumes the background worker (safe — each folder message is delete-then-insert, so re-scanned folders never duplicate) and must NOT run the synchronous `reconcileCacheFromFilesystem()` sweep, which would re-parse every missing folder on the main thread. While the marker is absent, `buildProjectsFromCache`'s empty-dir fallback also skips `deriveProjectPath()` (per-folder readdir + 256 KB read) in favor of a zero-I/O best-effort decode of the folder name (`decodeProjectFolderBestEffort`), never persisted to `cache_meta`.

## Non-obvious behaviors

- **`resolveWorktreePath` collapses `<repo>/.worktrees/<name>` → `<repo>`** when the parent dir exists. Consequence: many `~/.claude/projects/-home-...workspace-myproject--worktrees-X` folders derive to the same projectPath. Callers must dedupe (see `get-work-files` IPC for the pattern).
- **Two-table sidebar payload**: projects are aggregated, but each session row has its own `subagentType` field. A `null`/empty `subagentType` means it's a parent session; anything else (e.g. `'general-purpose'`, `'researcher'`) marks a subagent.
- **`fs.watch` debouncing**: the watcher batches per-folder events in a `pendingChanges = Map<folder, Set<filename> | true>` for ~200 ms before flushing to `refreshFolder`. A `true` value means "full walk needed" (rare path).
- **A session's title comes from its first *real* user turn, and a transcript without one is not indexed.** `classifyUserText()` in `read-session-file.js` sorts each user record into `prompt` / `command` / `skip`. `skip` is local-command bookkeeping (`<bash-input>`, `<bash-stdout>`, `<local-command-caveat>`, `<local-command-stdout>` — the CLI writes a command's own output back as a `user` record too); `command` is a bare slash-command record, recognised by a `<command-name>` tag next to a `<command-message>` or `<command-args>` one — the CLI writes both orders (`<command-name>` first for `/clear`, `<command-message>` first for `/auto-compact` and `/pre-compact`), so neither tag can be required to come first. The `skip` test is anchored to the start of the record: a real prompt that *quotes* `<local-command-stdout>` (a pasted transcript excerpt) is a turn, and skipping it can leave a session with no indexable prompt at all. This matters because **`/clear` opens a NEW jsonl and writes only that bookkeeping into it**; `/model`, by contrast, is written into the transcript that is already open, so it is a summary candidate only when it lands before any real prompt. Taking a `command` record as the summary therefore (a) titled every session started by `/clear` "`/clear clear </com…`" (the raw tags survive `cleanDisplayName`'s tag strip as a truncated fragment) and (b) indexed the bookkeeping-only transcript as a phantom sidebar session that the user never started. A `command` record is now a *fallback* title, used only when the transcript also holds an assistant turn (`/code-review high` → a real headless-command session); with no assistant turn both readers return `null` and nothing is indexed, matching how a brand-new session stays out of the sidebar until its first prompt. Rows written by the pre-fix parser cannot self-heal — the phantom ones sit on a file that never changes again, and the real ones keep the bad title because the header-only refresh path only overwrites a summary it can re-derive — so `db.js` migration **v9** purges rows whose summary starts with `<command-name>`, `<command-message>` or `<local-command-stdout>` — from `session_cache`, the three search tables and `session_metrics` (a phantom's file is never re-read, so its metrics would inflate the heatmap and the totals forever) — plus the `cache_meta` gate of their folders, which makes the next reconcile re-read exactly those files. The whole purge runs in one transaction: it cannot be resumed, since the relaunch that follows an interrupted run is already at db_version 9 and no longer matches the rows it dropped.
- **Stats `firstSessionDate`** is computed from `MIN(modified)`, not `MIN(created)`. Old sessions touched by recent reads keep their original `created` but their `modified` reflects the latest indexing — by design (the heatmap measures activity, not creation).

- **`main.js`'s `ctx.db` is a hand-built allow-list, not a spread of `db.js`.** `main.js` (~line 323) passes `sessionCache.init({ ..., db: { deleteCachedFolder, getCachedByFolder, upsertCachedSessions, ... } })` as an explicit object literal — it does **not** do `db: require('./db')`. If you add a new function to `db.js` and call it from `session-cache.js` via `ctx.db.<name>`, but forget to add it to both this literal *and* the `require('./db')` destructure at the top of `main.js`, `ctx.db.<name>` is `undefined`. The resulting `TypeError` is thrown inside `populateCacheViaWorker`'s `worker.on('message')` handler, which has no `try/catch` — it lands on stderr (not `electron-log`) and silently aborts the cold-start indexing write loop. Symptom: the log shows `Indexing N projects…` but never `Indexed N sessions across …`, and the affected table stays empty. Guarded by `test/main-ctx-db-wiring.test.js` (static source-grep asserting the allow-list ⊇ every `ctx.db.*` dereference in `session-cache.js`) — run it whenever you touch this boundary, but also update the allow-list by hand since the test only catches *missing* entries, not the intent.

- **`search` IPC is routed through a dedicated worker thread, with a bounded query.** Historically `ipcMain.handle('search', ...)` ran the `better-sqlite3` FTS5 `MATCH` query synchronously on the Electron main process — a long pasted string (e.g. a GitLab MR URL) became a ~58-trigram phrase intersect that pinned the main thread for up to ~60 s and froze the whole app (witnessed 2026-06-22). Two guards now exist: (1) `searchByType()` in `db.js` truncates the query to `FTS_QUERY_MAX_CHARS` (48) before building the MATCH expression; (2) the `search` IPC goes through `searchViaWorker` (`search-worker-client.js` + `workers/search-query.js`) so even a slow query can't block IPC dispatch. The client falls back to the synchronous main-thread `searchByType` only when the worker isn't ready (first-launch race, or circuit-breaker open after repeated worker failures) — the length cap makes that fallback safe. Protocol logic (correlation IDs, drain, backoff, restart storm guard) is unit-tested in `test/search-worker-protocol.test.js`; the cap in `test/db-search-query-bound.test.js`.

- **A manual `/compact` leaves a second transcript ("mirror") for the same session; it is merged on `bridgeSessionId`, not on file order, and NEITHER file is discarded (issue #197).** The CLI writes a `{"type":"bridge-session","bridgeSessionId":"cse_..."}` bookkeeping record into a transcript once bridging is established; both the pre-compaction file and the mirror it continues into carry the SAME `bridgeSessionId`. Measured on a real pair (16 MB parent + 3.1 MB mirror, same folder): **neither size nor first-event date tells them apart** — the mirror is *smaller* (it starts fresh at the compaction point) and *looks newer* (its first event is the compaction timestamp, later than the parent's). The parent's very last line is a `{"type":"continued-in","continuedInSessionId":"<mirror>"}` marker, after which the parent file goes quiet; the mirror keeps receiving new lines afterward — **the CLI keeps writing to the mirror, not the parent, once compaction happens.** `continued-in` is NOT a safe merge signal by itself: the same parent file carried a *second* `continued-in` record earlier, pointing at a transcript with a completely different `bridgeSessionId` (a genuinely independent session) — only a `bridgeSessionId` match is trustworthy.
  - **First cut of this fix kept the earliest file and dropped the mirror outright — wrong, caught in review before merge.** Given the CLI keeps writing to the mirror, discarding it forever would make every post-compaction message invisible to the cache: a session that compacts and keeps working loses all *later* activity, which is a worse failure mode than the double-count it replaces (double-count is a visible cost anomaly; silent loss of live activity is not visible at all, and this machine compacts routinely — nominal case, not an edge case). The design below is a real union instead.
  - **The mirror duplicates its predecessor's tail verbatim — same timestamps — then continues with genuinely new content.** This is the fact that makes an exact, cheap union possible: the overlap is bounded exactly by the predecessor's `modified` (its last real-message timestamp, already computed and stored). Anything in the mirror at or before that timestamp is the recopied duplicate; anything after is new.
  - **Detection is full-read-only.** `readSessionFile()` extracts `bridgeSessionId` from the first `bridge-session` record it sees; `readSessionDisplayHeader()` (the incremental/header-only refresh path, capped at 256 KB / 500 lines) never attempts it, because the record is not reliably near the head of the file — on the real mirror fixture it sat at byte ~3.08 MB of a 3.08 MB file, past the cap. A `readSessionFile()` full read still happens once per file, the first time it's seen (the "NEW file" branch of `refreshFolder`), so the value is captured and then persisted in `session_cache.bridgeSessionId`, carried forward unchanged by every later header-only merge.
  - **Every member of a bridgeSessionId group keeps its own `session_cache` row** (own `fileMtime`, own incremental refresh — completely unchanged machinery, so a frozen 16 MB parent is never re-read just because its mirror changed). `mergeBridgeGroups(existingRows, freshRows, reread)` in `read-session-file.js` (shared with `workers/scan-projects.js`) groups top-level sessions (never subagents — `parentSessionId` set is always excluded) by `bridgeSessionId`, sorts by `created` ascending, and marks every member except the earliest with `session_cache.mergedIntoSessionId = <earliest member's sessionId>`. Each non-winner's own `messageCount`/`textContent`/`session_metrics` are recomputed via `reread(sessionId, cutoff)` — a second call to `readSessionFile()` with `opts.dedupeSinceTimestamp` set to its immediate predecessor's `modified` — so its contribution excludes exactly the recopied overlap and nothing else.
  - **A cached row is never, on its own, proof that its contribution is already deduplicated — the discovery-order bug caught in review before merge.** `mergeBridgeGroups` decides whether to call `reread()` by comparing a member's *recorded* `mergedIntoSessionId` against the role (winner, or child of a specific winner) just computed for it this pass — **not** by whether the member came from `freshRows` or `existingRows`. An earlier draft skipped `reread` for any already-cached row and merely patched its `mergedIntoSessionId` (a "touch"). That is provably wrong whenever the cached row was never derived against a cutoff in the first place: **reachable mechanically** through `refreshFolder`'s targeted path — a watcher flush can name only the mirror as dirty (its sibling not yet in `cachedSessions` at all, e.g. a project folder the cold-start scan hasn't reached yet), so `mergeBridgeGroups` sees a group of exactly one member and applies no cutoff; the mirror's row is written with its full, undeduplicated `messageCount`. A *later* pass that discovers the parent for the first time must then re-derive that already-cached mirror, or the double-count this fix exists to close survives unchanged, just reached from the other file. Fixed by keying the reread decision on `mergedIntoSessionId !== computedRole` for every member, fresh or not — proven red beforehand by `test/read-session-file-bridge-session.test.js`'s "already cached WITHOUT a cutoff" cases and `test/session-cache-bridge-dedup.test.js`'s two-pass (`mirror` then `parent`) reproduction. The same reasoning runs in reverse for the winner: if a group's earliest file is deleted (a real path — session deletion), its former child is promoted to winner on the very next pass, but its stored contribution is still cutoff-filtered against a predecessor that no longer exists and now under-counts — so the winner itself is re-read in full (`cutoff = null`) whenever its recorded `mergedIntoSessionId` is non-null, checked even for a group that has shrunk to one member. The only case that is genuinely free of a re-read is a member whose recorded `mergedIntoSessionId` already equals its just-computed role: that row's stored contribution was necessarily derived against this exact cutoff on some prior pass, so a frozen parent stays untouched on every routine call once the group has settled.
  - **`mergedIntoSessionId` rows are excluded from sidebar/session-count listings, but count fully in token/message aggregates.** `buildProjectsFromCache()` skips any row with `mergedIntoSessionId` set and rolls its `messageCount` and `modified` up onto the row it merged into (so the sidebar shows one entry, with a `modified` that reflects the mirror's live activity, not the frozen parent's). `db.js`'s `getTotalCounts().totalSessions` excludes them the same way (`AND mergedIntoSessionId IS NULL`). `session_metrics`-based aggregates (`getDailyMetrics`, `getDailyModelTokens`, `getModelUsage`, and `getTotalCounts`'s message/token/tool-call sums) need **no** such exclusion: parent and mirror insert under distinct `sessionId`s with non-overlapping timestamp ranges (the cutoff guarantees this), so a plain `SUM(...) GROUP BY date` already adds them correctly. `getDailyActivity()` (the older, `session_cache`-based heatmap source) also self-corrects on `messageCount` for the same reason, but its `sessionCount` column will count a merged mirror as one more "session" on the day it's active — a pre-existing, disclosed approximation (that function already explicitly aggregates "ALL rows, parents and subagents alike"), not something this fix newly breaks.
  - **Residual gaps, named rather than hidden**: (1) the transcript viewer (`read-session-jsonl`) still resolves a sessionId to exactly one physical file, so opening the *merged* (winner) session shows only its own pre-compaction content — post-compaction content is visible only by separately finding the mirror's own row/search hit, not through a stitched view. (2) FTS search body for the winner is built from its own `textContent` only (pre-compaction text); the mirror keeps its own, separate search entry (its post-compaction `textContent`), so post-compaction text is findable but surfaces as a second, unlabelled-in-the-sidebar search hit rather than under the visible session's own entry. Both are scoped follow-ups, not silently-accepted data loss — nothing here drops tokens, messages, or the ability to eventually find the content, only the "one unified view" polish.
  - **Winner tie-break is `created`, then `sessionId` string order, and can be picked "wrong" in a narrow case**: if a session is short enough that the mirror's recopied context window covers its *entire* history, the mirror's own unfiltered `created` can tie the true parent's. The sessionId string tie-break is then arbitrary. This does not affect correctness of totals (the group still partitions all activity with no double-count either way) — only which of the two sessionIds ends up as the visible "primary" one. Not fixed here; flagged for whoever hits it.
  - **Open question #1 (absence)**: a transcript with no `bridgeSessionId` is never grouped with anything — `mergeBridgeGroups` only builds a group when the field is a non-empty string, so old-format transcripts and any layout that never emits the field simply keep their own row, exactly like today.
  - **Open question #2 (which file keeps being written)**: established by measurement above — the mirror, not the parent. That is exactly why the mirror is never discarded: dropping it would silently erase every message written after the compaction, for as long as the session keeps being used. The union design keeps both files' rows, forever, each independently refreshed.
  - **Open question #3 (existing databases)**: repaired on the next index pass, not left alone. `bridgeSessionId` and `mergedIntoSessionId` are added purely via the schema-reconciliation block (not a numbered migration — deliberately, to avoid coupling `migrations.length` to unrelated migration-ordering tests; see `db-schema-reconcile.test.js`'s "foreign higher-version" precedent for why reconciliation is the version-independent mechanism). Their absence sets `mustReindex = true`, which wipes `session_cache` + `cache_meta` + the `initial_scan_complete` marker, forcing every folder through the now-merging indexer on the next scan — the same repair path already used when `fileMtime` (v7) or the fork subagent columns (v4) were introduced.

- **Working-set restore retries until indexing is done, not once.** `populateCacheViaWorker` streams `sessionMap` one folder at a time on a cold start, so a saved working-set id can be missing for many ticks before it's genuinely indexed. `createRestorePlanner()` (`public/restore-plan.js`) is ticked from every `projects-changed` handler and from `updateIndexingBanner` on `payload.done`; it keeps returning `'wait'` until every saved id is indexed or indexing is over (then the rest is presumed deleted), restoring incrementally in `auto` mode and asking once (`askOnce: true`) in `ask` mode instead of re-prompting per tick. See `test/session-restore-cold-cache.test.js`.

## Remote SSH hosts (issue #201)

A declared SSH host's `~/.claude/projects` is mirrored into
`<dataDir>/remote/<alias>/projects/` and indexed as a **second projects root**.
Observation only: a remote session is read, searched and counted, never resumed
or deleted from here.

- **The local path is unchanged when no host is declared.** `remote-index.js`
  `start()` returns false before touching anything if `enabledHosts()` is empty:
  no `setInterval`, no ssh, no mirror directory. `session-cache.js`'s
  `remoteRoots` map stays empty, so `resolveFolderDir()` is `path.join(PROJECTS_DIR, folder)`
  and `buildProjectsFromCache`'s root list has exactly one entry — the same
  `readdirSync` it always did. Proven by `test/remote-index.test.js` (a transport
  and a `sync` that throw on any call) and `test/remote-indexing-e2e.test.js`.

- **Folder keys are `<alias>::<folder>`.** `encodeProjectPath` emits only
  `[a-zA-Z0-9-]` (`encode-project-path.js:5`), so `::` cannot occur in a local
  key and a remote key can never collide with one. `parseFolderKey`
  (`remote-hosts.js`) refuses a prefix that is not a valid alias, so a local
  folder whose name happens to contain `::` still reads as local. Local rows keep
  their current unprefixed form — nothing migrates.

- **The primary key is NOT namespaced, and that risk is accepted here in
  writing.** `session_meta.sessionId` and `session_cache.sessionId` stay global
  PKs (`db.js:51`, `db.js:60`). Two hosts whose CLIs generate the same session id
  would overwrite each other's star, title and archive state, and one host's row
  would shadow the other's in the sidebar. The ids are CLI-generated UUIDv4 and no
  collision exists in the measured data (255 transcripts on the probed host, 2026-09-07).
  Migrating the PK to `(host, sessionId)` touches every table, every IPC payload
  and every renderer id — it is not worth doing before a second host exists.
  **If you ever see two sessions fighting over a star or a title, this is why.**

- **The mirror is pulled on a timer, floored at 60 s, as the reconciliation
  path — it never goes away.** `fs.watch` cannot cross SSH
  (inotify/FSEvents/ReadDirectoryChangesW are kernel-local), and the local
  watcher at `main.js` `startProjectsWatcher()` is deliberately not pointed at the
  mirror — it would fire on our own `scp` writes, not on remote activity.
  Issue #240 adds a push channel alongside it (below) so a live host is not
  stale for up to 5 minutes; the pull remains the ground truth and the only
  path for a host with no push channel (see below).

### Remote hosts — watch channel (issue #240)

`remote-watch.js` keeps one long-lived `ssh -tt … inotifywait` child per
declared alias and calls `remoteIndexer.refreshHostNow(alias)` (the periodic
cycle's per-host entry point) on a coalesced "this host changed" signal —
never on every line, and never in place of the periodic pull. Full rationale,
the exact remote command, and the mutation proofs are in
`.work-files/switchboard/remote-watch-report.md`.

- **One `ssh` inventory, then only the deltas.** `remote-transport.js` runs
  `find .claude/projects -type f -name '*.jsonl' -printf '%T@	%s	%P
'` over
  a single ssh call and compares `(size, mtimeMs)` against
  `<dataDir>/remote/<alias>/inventory.json`. `rsync` is not used because it is
  absent on this Windows machine (measured); `ssh2` is not used because it would
  drag an optional native addon into the `electron-builder` pipeline. First pull
  moves the whole tree (249 MB on the probed host) as one `scp` per file at
  concurrency 4 — slow once, near-free afterwards.

- **Every child process is bounded and reaped.** Each `ssh`/`scp` gets a timeout
  that `SIGKILL`s it, every child is registered in a live set, and
  `remoteIndexer.stop()` (wired to `before-quit`) kills whatever is left. On
  Windows a child outlives the death of its launcher — on 2026-09-06 an unbounded
  load left 24 orphans at 100% CPU on this machine.
  **That kill timer must never be `unref()`'d.** It was, in the first cut: a
  process whose only pending handle is an unref'd timer exits before it fires,
  so the child is never killed and the promise never settles. This is invisible
  from inside `node:test` (the runner holds the loop open) and surfaced only on
  CI, as five `cancelledByParent` tests alongside `# fail 0`. Pinned from
  outside by `test/remote-transport-eventloop.test.js`, which runs the case in a
  child node process with nothing else pending. The repeating *interval* in
  `remote-index.js` is unref'd on purpose — a poll must not hold the app open —
  but a one-shot safety timeout never is.

- **A failing host degrades quietly and leaves the mirror alone.**
  `syncMirror` throws before mutating anything if the inventory call fails; a
  partial fetch skips the deletion pass *and* keeps the vanished files in the
  manifest, so the deletion is still owed on the next healthy run rather than
  silently forgotten. `remote-index.js` catches per host, so one dead host does
  not stop its peers or the local scan.

- **A host that keeps failing backs off per host, exponentially, capped at
  30 min — it is never disabled (issue #215).** Field incident 2026-09-07/08:
  a `transport disposed` cause (fixed separately) reran the plain fixed-cadence
  loop every 300.0 s for ~19 h (226 identical `refresh failed` warnings) because
  nothing slowed a permanently broken host down. `refreshNow()` now tracks
  `{ failures, lastError, nextAttemptAt }` per alias; on failure the delay is
  `min(intervalMs * 2^(failures-1), 30 min)` — base equals the host's own
  configured cadence, so an isolated blip costs nothing extra, and the 30 min
  ceiling was chosen so an operator never has to restart the app to get a
  recovered host picked back up. A host past `nextAttemptAt` is skipped for
  that cycle only: no ssh call, no log line, and its peers still run on
  schedule — the loop `continue`s per host, it never returns early. One
  success resets `failures`/`nextAttemptAt` to nominal immediately (issue
  requirement: fast recovery, not a cool-down after the outage ends).
  **Decision: slow down, never disable.** Disabling would need to flip the
  same `enabled` flag the Settings UI owns, which is out of this issue's scope
  and would turn a transient network problem into a silent, permanent loss of
  mirroring that nothing in the sidebar currently surfaces — the capped
  exponential delay already bounds the cost of a dead host to one attempt per
  30 min, which is cheap enough to just keep trying. Logging is throttled to
  the first failure and each change of tier (`onHostFailure` in
  `remote-index.js`), not every attempt, so the same field incident would have
  produced roughly 5 lines instead of 226. Per-host state is readable via
  `getRemoteHostState(alias)` (mirrors `getRemoteSessions(alias)`); the sidebar
  reads its `nextAttemptAt` for the host dot's error tooltip (below). Proven in
  `test/remote-index.test.js` with an injected `now()` clock — no real timers,
  no `setTimeout` waits.

- **A manual refresh means "I know the host is back": it ignores the backoff
  instead of waiting it out (issue #252).** Field incident 2026-09-10 17:41: a
  single transient ssh timeout put a host in backoff, and because
  `refreshHostNow`/`refreshNow` honoured `nextAttemptAt` unconditionally, the
  sidebar refresh button and a per-host reconnect action were both powerless
  for the whole ≥300 s window even though the tmux sessions were alive.
  `refreshHostNow(alias, { force: true })` and `refreshNow({ force: true })`
  now reset `failures`/`nextAttemptAt` to nominal (`lastError` is left alone —
  it only clears on an actual success, or gets overwritten by a fresh failure)
  and run the transport immediately regardless of `nextAttemptAt`. The
  automatic callers — the periodic timer's `refreshNow()` and the watch
  channel's `onRemoteWatchEvent` → `refreshHostNow(alias)` in `main.js` — call
  both functions with no options, so `force` defaults to `false` and the
  backoff keeps applying exactly as before. IPC `remote-hosts-refresh` (all
  enabled hosts) and `remote-host-refresh` (one alias, `main.js`) both force;
  after the refresh, both also restart that alias's watch channel
  (`remoteWatcher.stop` then the same `start(alias, onRemoteWatchEvent,
  onRemoteWatchActivity)` `syncRemoteWatchers()` uses, factored into
  `startWatcherForHost`/`restartWatcherForAlias` so the callback wiring is
  never duplicated) — this also clears a channel stuck on the
  `SWITCHBOARD-NO-INOTIFYWAIT` marker, since `remoteWatcher.start()` resets
  `unwatchable`. Proven in `test/remote-index.test.js`: `force` bypassing the
  backoff and clearing it on success, and the automatic (non-forced) path
  still honouring it, both on an injected clock.

- **The mirror is indexed off the main thread.** `workers/scan-projects.js` takes
  `folderPrefix` and a `folders` subset in `workerData`, and
  `sessionCache.scanFoldersViaWorker` writes each folder result through the same
  delete-then-insert path as the cold-start scan. Parsing 249 MB on the main
  thread would freeze the UI; `refreshFolder` is deliberately not the remote path.

- **Every child's handlers are bound to that child, not to the alias state**
  (audit finding F1, 2026-09-11). `restartWatcherForAlias`'s synchronous
  `stop()` then `start()` — and `syncRemoteWatchers` doing the same on a host
  toggle — kills child A and immediately spawns child B into the same state;
  A's `'close'` (and any late stdout `'data'`) arrives afterwards, on ssh's own
  schedule, not kill()'s. `close`/`data` handlers close over the specific
  `child` they were attached to and check `s.child === child` before touching
  state, so a superseded child's late events are dropped instead of nulling
  B out from under `stop()`/`stopAll()` and spawning an unkillable third
  child. Proven in `test/remote-watch.test.js` with a fake child whose `kill()`
  does not itself emit `'close'` (a real ssh process doesn't either) — a test
  drives the late close explicitly via `child.emitClose()`, after the
  replacement child already exists.

- **The ssh child gets a connect timeout and keepalive, and a quick failure is
  logged with its stderr tail** (audit finding F4). `buildSshArgs` adds `-o
  ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=3` (before
  the alias, after `-tt`/`BatchMode`) so a half-open TCP session (laptop sleep,
  NAT) is detected and reaped instead of leaving `isRunning()` reporting a
  channel that receives nothing, forever. The last ≤200 bytes of stderr are
  kept per child and logged once per backoff-tier change on a quick failure
  (`< HEALTHY_MS`), same throttle as `onHostFailure` above — never on every
  attempt, never for a healthy long run that just happened to exit.

- **A pending coalesce cooldown cannot fire after `stop()`** (audit finding
  F11, minor). `killChild` only ever cleared `restartTimer`; a coalesce
  cooldown timer (and its `pending` flag) from `emitCoalesced` is now also
  cleared and reset inside `stop()`, so a queued trailing event from before
  the stop can never reach `s.onEvent` afterwards.

### Remote hosts — busy spinner (issue #242)

Remote transcript-write activity feeds the same `setActivity(sessionId, active, via)`
dispatcher in `session-activity.js` that local PTY output uses — `remote-activity-ui.js`
calls `setActivity(sessionId, true, 'remote-watch')` on each `remote-activity` IPC event
and arms a 20 s decay timer (one per session, reset on each event) that calls
`setActivity(sessionId, false, 'remote-decay')` when it fires, and `seedRemoteActivity(session)`
(called from `renderProjects`, before any row is built) applies the same call from
`session.remoteActiveAt` on first paint so a row rendered inside the decay window starts
busy without waiting for the next event; the visual is the shared `.cli-busy` braille
spinner, not a separate indicator.

The decay call passes `setActivity(sessionId, false, 'remote-decay', { armReady: false })`,
not the bare two-argument form local PTY callers use. 20 s of transcript silence means
"stopped writing", not "the response is ready" — a remote adapter has no PTY to ask
whether a turn actually ended, so a long tool call or a parent delegating to subagents
(its own transcript silent while children write theirs) would otherwise light every
unviewed remote row as `.response-ready` on a plain inference. `armReady: false` clears
`.cli-busy` and `sessionBusyState` through the normal path but skips adding the session to
`responseReadySessions`, so a remote row falls idle without ever claiming "Claude finished,
you haven't looked." Separately, `app.js`'s `updateRunningIndicators` PTY-set purge skips
rows carrying `dataset.remoteAlias` (F7) — a remote row's busy state is owned by this decay
timer, not by local PTY presence, so it must not be cleared just because some unrelated
local PTY started or stopped.

### Remote hosts file-level rescan (issue #216, first half)

**The unit of rescan used to be the folder, not the file.** `syncMirror`
already tracks per-file size/mtime to decide what to `scp` (`remote-mirror.js`),
but `remote-index.js`'s `refreshHost()` reduced that down to a `Set` of folder
names via `topFolderOf()` before handing it to `scanFoldersViaWorker`, and
`workers/scan-projects.js`'s `readFolderFromFilesystem` then re-read and
re-parsed EVERY `.jsonl` in that folder — measured 08/09/2026: a folder with
108 MB across 144 files got fully re-read because one line was appended to
one of them. This is fixed additively; the local path (cold-start scan,
`populateCacheViaWorker`, and the fs.watch-driven `refreshFolder`) is
untouched.

- **`syncMirror` now also returns `changedFilesByFolder`** (`Map<folder,
  Set<relPathWithinFolder>>`), built from the exact same `fetched` list and
  deletion-reconciliation loop that already built `changedFolders` — same
  data, not collapsed.
- **`refreshHost()` builds `fileSubsets`** (`Map<folder, Set<relFile>>`) from
  it, but ONLY for a folder already present in `listIndexedFolderKeys()`. A
  folder scanned for the first time (present on the mirror but not yet
  indexed — the "mirror on disk but absent from the cache" case just above)
  always gets the full walk: there is no baseline to restrict against.
- **`scanFoldersViaWorker({..., fileSubsets})` is purely additive.** Omitting
  `fileSubsets` reproduces the prior behavior byte-for-byte (proven by
  `test/scan-projects-worker.test.js`, unmodified, and by
  `test/remote-indexing-e2e.test.js`, unmodified). When given, it splits
  `folders` into `fullFolders` (scanned exactly as before) and `targets`
  (`{folder, files, existingRows}`, `existingRows` pulled from
  `getCachedByFolder` before the worker is spawned — the worker itself has no
  DB access). `workers/scan-projects.js`'s new
  `readFolderFileSubsetFromFilesystem` reads only the named files and returns
  `{ ..., partial: true, toDelete }`.
- **The `mergeBridgeGroups` pitfall — this is the one that would regress
  silently (PR #198 duplicate-sidebar-entry class of bug).** A file-subset
  scan's `freshRows` contains only the changed file(s), so without more,
  `mergeBridgeGroups([], freshRows, reread)` would see a bridge group of one
  and never mark a changed compaction mirror as merged into its still-cached
  parent. Fixed by threading real `existingRows` (the folder's cached rows,
  fetched by `scanFoldersViaWorker` before spawning the worker) into
  `mergeBridgeGroups` on the partial path instead of `[]` — exactly the
  parameter the function already exists to take (`refreshFolder`'s local
  targeted-refresh path does the same with `cachedSessions`). The full-folder
  path (`readFolderFromFilesystem`) still calls `mergeBridgeGroups([], ...)`
  unchanged, because a full read already has every group member in
  `freshRows`.
- **`writeScannedFolderPartial` (session-cache.js), not `writeScannedFolder`,
  handles a `partial: true` result.** `writeScannedFolder`'s
  delete-then-insert-the-whole-folder would wipe every other cached session
  in that folder that the restricted scan never touched. The partial path
  upserts only the returned `sessions` and deletes only the returned
  `toDelete` ids (files gone from the mirror, or a merge member whose
  re-derivation found nothing surviving the cutoff).
- Proven by `test/remote-scan-file-granularity.test.js`, each property pinned
  by an injected-then-reverted mutation: forcing `fullFolders` to ignore
  `fileSubsets` reddens the single-file property; defaulting `subsets` when
  `fileSubsets` is absent reddens the full-folder-by-default property;
  dropping `existingRows` back to `[]` on the partial path reddens only the
  merge-equivalence property.
- **Out of scope, deliberately**: incremental parsing by byte offset within a
  changed file (issue #216's second half) — a changed file discovered this
  way is still read in full by `readSessionFile`.

- **A remote project is never "missing".** `buildProjectsFromCache` sets
  `missing: false` for any aliased row. Probing the local filesystem for
  `/srv/supervision` would flag every remote project missing and offer it to the
  missing-project remap UI, which rewrites transcripts for a path this machine
  never owned. Sidebar grouping is keyed on `alias + projectPath`, not
  `projectPath` alone, so two hosts holding the same absolute path stay two groups.

- **Switchboard never stores, reads or displays an SSH credential.** A host row
  is an alias and a label. Resolution (user, port, key, agent, proxy) stays in the
  user's `~/.ssh/config`, which is already on the sensitive-path denylist
  (`ipc-path-validator.js:38`, `main.js:732`) and stays there. The alias is passed
  as its own argv element, never concatenated into a shell string; a remote
  relative path is validated by `isSafeRelPath` before it is joined onto a local
  directory or handed to `scp` (OpenSSH 9 runs scp over SFTP, where quoting would
  become part of the name — the validation is the guard, not quoting).

- **Session descriptors ride the SAME ssh call as the inventory (issue #211)
  — never a second connection.** The CLI writes one descriptor file per live
  session to `~/.claude/sessions/<pid>.json` on the remote host, alongside
  unrelated `*.key` secret files (mode 600) in the same directory.
  `remote-transport.js`'s `LIST_COMMAND` (`remote-transport.js:25-29`) is a
  single shell command: the existing `find .claude/projects`
  inventory, then a `printf` of a marker line, then a bounded pull of
  `.claude/sessions`. `listFiles(alias)` still spawns exactly one `ssh` — the
  test "listFiles spawns one bounded ssh…" in `test/remote-transport.test.js`
  asserts both `find .claude/projects` and `find .claude/sessions` appear
  inside that single command string.
  - **The two halves fail independently, in opposite directions — neither
    direction should be mistaken for the other.** The inventory `find` is
    followed by `|| exit $?`: if it fails (missing `.claude/projects`, an
    unmounted home, a permission change, a BusyBox `find` with no `-printf`),
    the whole command aborts immediately with that `find`'s own exit status —
    `listFiles` still throws and `syncMirror` still refuses to touch the local
    mirror, exactly as before issue #211 introduced the sessions pull. The
    sessions half's own failure (a missing or unreadable `.claude/sessions`)
    is independently swallowed (`2>/dev/null`, and the final pipeline's exit
    status is the trailing `while` loop's, not `find`'s) and degrades to zero
    descriptors without affecting the inventory half. Before this fix, the `;`
    between the two stages let the sessions half's `while` loop mask a failed
    inventory `find` — an unreachable/misconfigured host's inventory failure
    was silently read as "nothing remote exists", which `syncMirror` then
    read as license to delete every locally mirrored file for that host.
  - **The marker (`SESSIONS_MARKER = '\u0001SWITCHBOARD-SESSIONS\u0001'`)
    cannot collide with real descriptor content, by construction.** It is
    wrapped in a raw SOH control byte (0x01) on each side — written in source
    with an explicit `\u0001` escape, not a raw byte, so the constant stays
    legible in a diff — sent to the shell as `\001` inside a `printf` format
    string. Valid JSON text can never contain a raw, unescaped control byte —
    the JSON spec requires control characters inside a string to be escaped
    (per RFC 8259 section 7) rather than appear as a raw byte — so no
    legitimate descriptor line can ever contain the two raw 0x01 bytes that
    frame the marker. `splitListOutput(stdout)` (`remote-transport.js`) only
    accepts a marker occurrence preceded by a newline (or at byte offset 0 —
    the legitimate case when the inventory `find` found zero files) and
    followed by a newline, consuming that trailing newline into the boundary;
    a marker substring that doesn't sit on its own line, or an absent marker
    (an unexpected truncation), both degrade to treating the whole stdout as
    the inventory block and return `sessionsBlock: ''` rather than throwing —
    `parseInventory` keeps working exactly as before on the degraded input.
  - **The command assumes a POSIX-sh-compatible remote login shell.** `;`,
    `||`, pipes, `2>/dev/null` and `while … do … done` are `sh`/`bash`/`dash`/
    `ksh` syntax, not portable to `fish` (different loop syntax, no `do`/`done`)
    or `csh`/`tcsh` (different control-flow syntax entirely) — a host whose
    login shell is one of those would get a syntax error from `ssh`, whereas
    the pre-#211 command (a single `find` invocation with no shell operators
    at all) was portable to any shell. No such host is declared today; this is
    a known, undemonstrated limitation, not something this change attempts to
    fix.
  - **`-name '[0-9]*.json'` is the only thing standing between this feature and
    reading a `.key` secret file** — it structurally cannot match any `*.key`
    filename regardless of the digit-prefix part, because the extension itself
    is wrong. This is a property of the glob, not an added exclude-filter.
    Pinned by two tests in `test/remote-transport.test.js`: an exact-string pin
    of `LIST_COMMAND` (so widening the glob, or swapping the `find`+`head -c`
    pipeline for a bare `cat *`, changes the string and fails immediately), and
    a belt-and-suspenders `!LIST_COMMAND.includes('.key')` check that survives
    unrelated wording changes.
  - **Byte and count caps are enforced remotely, in the shell command itself**
    (defense in depth, not just in JS): `head -c 8192 "$f"` bounds each
    descriptor, `head -n 200` bounds the count. Worst case the sessions payload
    adds ≈ 200 × 8193 ≈ 1.64 MiB to a cycle, comfortably under the existing
    8 MiB `MAX_LIST_BYTES` combined-output cap on its own — so this addition
    cannot by itself push a cycle over that cap. A projects inventory already
    near 8 MiB could still combine with this to overflow, but that is the
    pre-existing risk of an oversized inventory, not a new failure mode.
    `LC_ALL=C sort` orders the descriptor files deterministically (byte order,
    not locale-dependent) — cosmetic, but keeps test/log output stable.
  - **A missing or unreadable `~/.claude/sessions` degrades to zero
    descriptors instead of failing the whole cycle.** The sessions half is a
    pipeline ending in `while IFS= read -r f; do …; done`, whose exit status is
    the *loop's* status (0, even on empty input) — not the `find`'s. `find`'s
    own stderr is swallowed by `2>/dev/null`, so a missing directory produces
    empty stdout and exit 0. The two `find` stages are joined by `;`, not
    `&&`, and deliberately carry no `set -e`/`pipefail` — a failure in the
    sessions half must never fail the inventory half it rides alongside.
  - **`parseSessions(block)` preserves every field verbatim** — the schema
    belongs to the CLI, not to Switchboard — validating only `pid` (positive
    integer) and `sessionId` (non-empty string) before accepting a line.
    Malformed lines (a `head -c`-truncated descriptor produces incomplete
    JSON) are dropped with a **fixed, generic warning string only** — never the
    raw line, the parsed object, or any field value — because descriptor
    content must never be logged. `listFiles`'s return contract changed from a
    plain array to `{ files, sessions }`; every stub of `transport.listFiles`
    across `remote-mirror.test.js`, `remote-index.test.js` and
    `remote-indexing-e2e.test.js` was updated to match in the same change.
  - **A descriptor's pid is checked for liveness on the host itself (F9,
    audit-fable-2026-09-11)** — until this fix `parseSessions` kept every
    descriptor unconditionally, so a killed remote CLI's file (deleted only on
    a clean exit, same as the local one — see `.ai/contexts/cli-session-state.md`)
    surfaced as permanently live, and `sidebar.js`'s host-dot `liveCount`
    counted it. `LIST_COMMAND`'s per-file loop now emits one more line after
    each descriptor: `printf '\002ALIVE:%s\n' "$( [ -d "/proc/$pid" ] && echo
    1 || echo 0 )"`, `$pid` taken from the filename via `basename "$f" .json`
    — no second ssh round trip. `parseSessions` matches that exact
    `ALIVE:0`/`ALIVE:1` line immediately following a descriptor,
    consumes it either way (so it can never itself be mis-parsed as a bogus
    descriptor), drops the descriptor on `ALIVE:0`, and counts the drops in
    its returned `dropped` field; `listFiles` logs `dropped N dead session
    descriptor(s)` when non-zero. **Backward compatible by construction, not
    by a version check**: a descriptor with no marker line following it (an
    older host script, or simply the last line of the block) is kept exactly
    as before — the absence of the marker is the compatibility signal, there
    is no protocol version field.
  - **`remote-index.js` keeps the latest descriptors per alias, keyed and
    pruned exactly like folder keys.** `createRemoteIndexer()`'s private
    `remoteSessions` map is set from `result.sessions` inside `refreshHost()`
    and read back through `getRemoteSessions(alias)` (defaults to `[]` for an
    alias never refreshed). `pruneUnknownAliases()` deletes its entries for any
    alias no longer declared, the same pass that prunes folder keys, so the map
    cannot grow unboundedly across host-list edits. Attach now exists off this
    data (issue #221, below); capacity tiers and a liveness badge in the UI
    (#218, #212) still don't.
    **Corrected 2026-09-10 (issue #252): only a SUCCESSFUL cycle replaces this
    map.** `refreshHost()`'s failure path used to also do `remoteSessions.set(alias,
    [])`, so one transient ssh timeout wiped every live descriptor and
    `annotateRemoteAttachable` (`main.js`) then found none — every remote
    session read as non-attachable for the whole backoff window even though
    the tmux sessions were alive (field incident 2026-09-10 17:41). The wipe is
    removed from both `refreshNow()`'s and `refreshHostNow()`'s catch blocks;
    `getRemoteSessions(alias)` on a failed cycle now returns the previous
    `sessions` list unchanged, the previous `at`, and the fresh `error` from
    `hostBackoff` — the host dot already renders `error` as "unreachable", so
    the UI signal is unchanged, only the underlying data survives. Attach
    itself is the honest failure mode for a genuinely dead host: it tries the
    stale descriptor and the ssh call inside it fails. A host that is
    disabled or removed is still pruned by `pruneUnknownAliases()`, unaffected
    by this change. Proven by `test/remote-index.test.js` ("getRemoteSessions
    keeps the last known descriptors, not wiped, after a cycle where sync()
    throws").
  - **Remote hosts — meta.json sidecars (issue #244).** A subagent's agent
    type lives in a sidecar `agent-<id>.meta.json` next to its transcript,
    read by `readSubagentMeta()` (`read-session-file.js`). `LIST_COMMAND`'s
    projects `find` matches `*.jsonl` **or** `*.meta.json`, and
    `isSafeMirrorRelPath` (`remote-hosts.js`) — not `isSafeRelPath` — gates
    both in `parseInventory` and in `remote-mirror.js`'s inventory filter and
    fetch queue, so the sidecar rides the same `scp` path as its transcript
    and lands in the same mirrored directory (no path-layout code needed:
    `fetchOne` already preserves the full relative path). `isSafeRelPath`
    itself is untouched on purpose — `remote-watch.js` still imports it
    directly, so a `.meta.json` write on the host is never classified as
    project activity; the sidecar only ever arrives on the next inventory
    refresh. Inside `syncMirror`, transcripts are sorted ahead of sidecars
    before the per-cycle budget (`MAX_CYCLE_FILES`/`MAX_CYCLE_BYTES`, #238) is
    applied, so a flood of tiny sidecars can never push a transcript out of a
    full cycle. A sidecar that arrives (or leaves) on its own — the transcript
    itself unchanged — is reported to the indexer under its **transcript's**
    rel path, not its own, because `readSubagentMeta()` in the transcript's
    row is what actually needs re-deriving.

## Remote hosts — tmux attach (issue #221)

`open-terminal` no longer refuses every remote session outright. When
`isRemoteFolder(cachedFolder)` is true, it now looks up that session's own
descriptor via `remoteIndexer.getRemoteSessions(alias)` and asks
`remote-attach.js`'s adapter whether it can attach. Only if the descriptor
carries no usable multiplexer field does it still return `REMOTE_READ_ONLY`.
Launching a new remote session (#222) and injection over the messaging socket
(#219) are untouched — this is attach-to-an-already-running-CLI only.

- **The adapter is indexed on the descriptor's own field, never on host
  detection.** `remote-attach.js`'s `createTmuxAttachAdapter().supports(descriptor)`
  and `.attach(alias, descriptor)` both key off `descriptor.tmux` — a host
  whose CLI never writes that field (no multiplexer, or a different one) is
  refused before any ssh call, not probed. **The word "tmux" is confined to
  this one file by construction** — `main.js` never inspects `descriptor.tmux`
  itself, it only calls `supports()`/`attach()`. A second adapter for a
  different multiplexer would slot in beside this one without `main.js`
  changing at all.

- **Sizing rule, measured on tmux 3.6 against a window never pinned to a
  size (`window-size latest`):** `cols = window_width`, `rows = window_height
  + status_lines`, where `status_lines` is 1 when the `status` option is
  `on`, 0 when `off`, and the rendered count otherwise (tmux allows a
  multi-line status bar). Attaching at the bare height instead measurably
  leaves the window one row short **after the client detaches**, not just
  while attached — a client that sized itself to the true height (200x51 on
  a 200x50 usable pane) left the window at 200x50 once it left; the naive
  200x50 client left it at 200x49. `parseProbeOutput()` in `remote-attach.js`
  applies the correction; `test/remote-attach.test.js` proves it by mutation
  (dropping `+ statusLines` reddens 3 of 11 tests).
  - `attach -f ignore-size` was tried and rejected: measured to resize the
    window anyway.
  - `resize-window` was tried and rejected: it sets `window-size manual` on
    the window, silently, on a session this app does not own.

- **The probe and the attach are two separate ssh calls, deliberately not
  combined with the mirror's own inventory ssh.** The probe
  (`buildProbeCommand`) runs `tmux -L <socket> display-message -p -t <target>
  '#{window_width}x#{window_height}'`, then a `PROBE_SEP` control-byte separator, then `tmux
  -L <socket> show-options -A -t <socket> status` — one non-interactive ssh
  round trip, parsed by `parseProbeOutput`. The attach itself
  (`buildAttachCommand`) is `tmux -L <socket> attach -t <target>`, run over a
  **second**, interactive `ssh -tt <alias> …` that becomes the actual PTY —
  it cannot be the same call as the probe because the probe must complete and
  return a size before the interactive PTY is even spawned.

- **The `tmux` field's own shape is treated as the socket name too.** The CLI
  writes e.g. `"main:@0.%0"` — a `session:window.pane` target string. This
  adapter reads the part before `:` (`"main"`) as both the tmux socket
  (`-L main`) and the session to query status on, on the assumption the CLI
  always names its socket after its session. **This is an assumption, not
  something measured against the CLI's own socket-naming code** — if a
  future CLI version uses a socket name that differs from the session name,
  `show-options -A -t <socket>` would query the wrong (or a nonexistent)
  session and this adapter would need a real socket field instead of
  deriving one.

- **`TMUX_FIELD_RE` is the injection guard, not shell quoting.** Same posture
  as `remote-hosts.js`'s `isSafeRelPath`: the descriptor field is matched
  against `^([A-Za-z0-9._-]{1,64}):(@?\d{1,10}(?:\.%?\d{1,10})?)$` before it
  ever reaches a command string, so a field forged to include a semicolon or
  backtick is refused outright (`parseTmuxField` returns `null`) rather than
  escaped. Descriptor content besides `pid`/`sessionId` is otherwise
  untyped — see "Session descriptors ride the same ssh call…" above.

- **Detach sends Ctrl-B d before ending the local ssh client — it does not
  just kill the connection.** `ptyProcess.kill()` on the returned wrapper
  writes `DETACH_KEYS` (`\x02d`, tmux's default prefix + detach) to the
  attach PTY, waits `DETACH_GRACE_MS` (150 ms) for tmux to process it, then
  kills the local `ssh -tt` client. Killing immediately, without the
  keystroke, races tmux's own cleanup and risks the same window-corruption
  failure mode the sizing rule fixes on the other end. No new IPC or
  `main.js` call site was added for this — `stop-session` already calls
  `killPty(session, sessionId)` → `session.pty.kill()` through the existing
  `pty-ops.js` seam, so the clean detach is just what that seam now reaches.

- **`main.js`'s onData/onExit wiring (OSC parsing, busy detection, output
  buffering, `activeSessions` cleanup) is shared between local spawn and
  remote attach.** Extracted into `wireSessionPty(session, sessionId,
  ptyProcess)`, called once from the local-spawn tail and once from the new
  remote-attach branch — the same code path, not a parallel copy that can
  drift. A remote session's `ptyProcess` (from `remote-attach.js`) exposes
  the same `write/resize/kill/onData/onExit/pid` shape node-pty does, so
  `pty-ops.js` (`writePty`/`resizePty`/`killPty`) and this wiring need no
  remote-awareness of their own — the existing `terminal-resize` IPC reaches
  a remote session's PTY through the exact same `resizePty(session, cols,
  rows, sessionId)` call as a local one.

- **Solo vs shared (issue #221 follow-up): resize follows the local window
  only when no other tmux client is already attached.** The probe
  (`buildProbeCommand`) now appends a third `PROBE_SEP`-delimited segment,
  `tmux -S "$sock" list-clients -t <target> | wc -l` — still the one
  non-interactive ssh round trip, no second connection. `attach(alias,
  descriptor, localSize)` takes the caller's locally-measured `{cols, rows}`
  (`main.js`'s `open-terminal` handler passes the same `normalizePtySize
  (initialSize)` result a local spawn uses) and treats the session as
  **solo** only when the probed client count is exactly `0` *and* a valid
  `localSize` was supplied. Solo: the PTY opens at `localSize`, and the
  returned `ptyProcess.resize(cols, rows)` forwards to the underlying ssh
  PTY — a live terminal like any local one. Not solo (one or more other
  clients attached, or the client count could not be parsed — fail closed
  the same as "attached"): the PTY opens at the sizing-rule's remote
  `cols/rows` as before, and `resize()` stays a no-op, logging which of the
  two reasons applied. Rewrapping a screen someone else is actively looking
  at is the failure this refuses; an unparseable count is treated the same
  as "someone's there" rather than guessed.

- **Solo attach parity, issue #253.** A solo attach now makes the remote
  tmux session look and behave like a local terminal instead of a plain
  multiplexer view: `buildAttachCommand(socket, target, { solo, pre })`
  prefixes the attach with three session-scoped (never `-g`, never `-w`)
  `tmux ... \; ...` sets — `status off`, `mouse on`, `window-size latest` —
  when `solo` is true, and emits the unchanged pre-#253 command when it
  isn't (shared attach never touches another client's view). The probe
  (`buildProbeCommand`) now also reads `mouse` and `window-size` alongside
  `status`, and `parseProbeOutput` returns their raw pre-attach values as
  `pre: { status, mouse, windowSize }` (`null` when an option is absent
  from the probe output) in addition to the existing `cols`/`rows`.
  `tmux show-options -A` marks an option inherited from a higher scope
  with a trailing `*` on the option name (e.g. `status* on`, measured on
  tmux 3.6) — `pre.<opt>` is `null` for both "absent" and "inherited
  (starred)", since both mean no session override exists and restore
  must `set -u`; it is non-null only for an actual session-scoped
  override (unstarred), restored via `set -t`. The star never affects
  the sizing rule — a starred `status* off`/`on`/`<n>` sizes
  `statusLines` exactly like its unstarred form. On
  detach, when the attach was solo, the adapter fires a best-effort,
  fire-and-forget `buildRestoreCommand(socket, target, pre)` ssh call that
  sets each option back to its probed value (`set -t <target> <name>
  <value>`) or, when the probed value was `null`, unsets the session
  override (`set -u -t <target> <name>`) so the host's own global option
  applies again. The restore call's failure is only logged — it never
  throws out of `detach()` and never blocks the local ssh client from being
  killed. No shared-attach restore is ever sent, because a shared attach
  never applied the options in the first place.

- **This is the first thing to populate the session-handle seam from issue
  #220** (see `.ai/contexts/trigger-watcher.md`, "Session handle"): a
  remote-attach entry sets `host: alias`, `kind: 'remote-attach'`, and
  `handle: attachResult.ptyProcess` — the same wrapper object also stored as
  `session.pty`. That works without a second object because the wrapper
  already exposes `write`/`isAlive` alongside the pty-duck-type methods
  (`resize`/`kill`/`onData`/`onExit`/`pid`) `pty-ops.js` and `wireSessionPty`
  need; `getPtyForSession` takes it as `session.handle` given, unmodified,
  exactly the branch #220 left unexercised. Proven in
  `test/remote-attach.test.js` ("pilots the fake remote pty through write()
  and kill()") with a bare fake pty, no real node-pty involved.

- **Corrected 2026-09-08 (issue #221) — the socket is discovered from the
  process's own `TMUX` environment variable, not derived from the
  descriptor's `tmux` field.** The assumption logged above ("the CLI always
  names its socket after its session") was wrong: the descriptor's
  `session:window.pane` string is a **target**, never a socket name, and the
  real sockets on the host (`/tmp/tmux-0/orchestration`,
  `/tmp/tmux-0/orchestration-harness`) don't match the session name at all —
  the first click on a remote session failed with `error connecting to
  /tmp/tmux-0/main`. `buildProbeCommand(pid, target)` now reads
  `/proc/<pid>/environ` on the remote host (`tr '\0' '\n'`, since the file is
  NUL-separated), extracts `TMUX=<socket>,<server-pid>,<index>`, and takes the
  part before the first comma — all inside the **same** non-interactive ssh
  call the size probe already made (the OpenSSH client on Windows has no
  `ControlMaster`, so a second call is a second full connection, not a free
  one). The discovered socket rides back to the caller as a prefix segment on
  the probe's stdout (`parseDiscoveryProbeOutput`) so the later interactive
  `attach -S <socket>` uses the same value, quoted, never re-derived. A pid
  with no readable `TMUX` (dead process, unreadable `/proc`) degrades to a
  refusal naming the reason — never a guessed socket. `descriptor.pid` was
  already validated as a positive integer upstream (`parseSessions`, above);
  `isValidPid`/`isSafeSocketPath` in `remote-attach.js` re-check it anyway
  because this file builds shell command strings from it.
- **`supports()` grew a `pid` requirement in the same change** — a
  descriptor with a `tmux` field but no usable `pid` can never discover a
  socket, so routing it to an attach attempt (`main.js`'s
  `annotateRemoteAttachable`) would only ever produce an error terminal. Every
  descriptor `parseSessions` accepts already carries a valid `pid`, so this is
  a no-op on real data; it only changes routing for a hand-built or malformed
  descriptor.

- **Pid-reuse guard (F6, audit-fable-2026-09-11).** Descriptors now survive a
  failed refresh cycle for up to the backoff window (#255, above) — long
  enough for the CLI to die and the OS to hand its pid to an unrelated
  process on the same host. Before this fix, `buildProbeCommand` read
  *whatever* process now holds that pid's `TMUX` environment variable and, if
  it was solo, reconfigured and attached to whatever tmux session that
  process happened to be in — no check that it was still the session the
  descriptor named. `buildProbeCommand` now appends one more
  `PROBE_SEP`-delimited segment: `tr '\0' ' ' < /proc/<pid>/cmdline | grep -qi
  claude && echo 1 || echo 0` (`buildProcCmdlineCheck`), read back by
  `parseDiscoveryProbeOutput` as `cmdlineHasClaude` (`true`/`false`, or `null`
  for a probe predating this segment). `attach()` runs this check only when
  `descriptor.procStart != null`; on a `false` result it returns `{ ok:
  false, error: 'pid <n> no longer belongs to this session (process start
  differs)' }` before any `spawnPty` call — no attach, no `set`. A descriptor
  with no `procStart` keeps today's unverified behavior.
  **Not what the finding asked for, and why:** the audit wanted
  `descriptor.procStart` compared against `/proc/<pid>/stat`'s starttime
  (field 22, clock ticks since boot). The one measured `procStart` sample
  this repo has (`.ai/contexts/cli-session-state.md`) is
  `"134319945380279381"`, captured on a **Windows** CLI — 18 digits, the
  right order of magnitude for a Windows `FILETIME` (100 ns since 1601), not
  for Linux clock ticks since boot (which would need centuries of uptime to
  reach 18 digits at 100 Hz). Whether the CLI's own remote/Linux code path
  produces something on the *same* scale as `/proc/<pid>/stat` field 22 is
  unverified — ssh access to a real host to check was out of scope for this
  fix (`no ssh to any host` was a hard constraint). Comparing two values on
  possibly-incompatible scales risks shipping a check that either always
  refuses (units never line up) or silently never refuses (units happen to
  overlap by coincidence) — worse than the cmdline check in both directions.
  The `cmdline`-contains-`claude` check is strictly weaker than an exact
  start-time match (it would not catch a *second* claude CLI reusing the
  pid), but it does catch the audited scenario — pid reused by an unrelated
  process in another tmux server — without depending on that unverified
  format match. `descriptor.procStart != null` is still the gate, matching
  the interface the finding asked for.

- **`ConnectTimeout=5` on the probe and restore-on-detach ssh calls (F10,
  audit-fable-2026-09-11).** `defaultRunRemoteCommand`'s ssh spawn had a kill
  timer (`DEFAULT_PROBE_TIMEOUT_MS`, 15 s) but no `ConnectTimeout` — a
  half-open connection (portable asleep, NAT gone stale) took the full 15 s
  to fail instead of failing fast at the TCP handshake. `buildRemoteCommandArgs
  (alias, command)` now builds the argv (`-o BatchMode=yes -o
  ConnectTimeout=5 -n <alias> <command>`), exported so the argv shape is
  tested directly without spawning ssh. **Known, accepted gap: if the app
  crashes mid-session, `before-quit`'s `detach()` never runs, so a solo
  attach's restore-on-detach ssh call (`status off`/`mouse on`/…) never
  fires** — the remote tmux session is left with the solo-attach options set
  until something else attaches and detaches cleanly. `ConnectTimeout` bounds
  how long a *reachable-but-slow* restore takes; it does nothing for a
  restore that never gets scheduled at all.

### `stop()` cancels, `dispose()` ends -- they are not the same thing

`createSshTransport().dispose()` is **terminal**: it sets a flag every later
`run()` checks, so once disposed the transport answers
`ssh inventory failed (exit -1): transport disposed` forever. It exists for
application shutdown.

The indexer's `stop()` must therefore **not** call it. `stop()` cancels what is
in flight (`cancelInFlight()`) and clears the timer; `dispose()` on the indexer
is the shutdown path and is the only caller of the transport's `dispose()`.

Why this is not a detail: `restart()` is `stop()` then `start()`, and
`restart()` is exactly what the `remote-hosts-apply` IPC calls when a host is
saved in Settings. With `stop()` disposing, declaring a host at runtime killed
the transport in the same breath, and the feature could only ever have worked
for a host already declared at launch -- that is, never on first use. Measured
in the field on 2026-09-07 (v0.0.68): the mirror directory was created and
stayed empty, one warn line in `main.log` and no user-visible error.

The tests that hold this: "restart() after adding a host keeps the transport
usable" and "dispose() is terminal", in `test/remote-index.test.js`.

## If you change this, also check

- `remote-hosts.test.js` — covers folder-key parsing, alias validation and the `isSafeRelPath` guard
- `remote-mirror.test.js` — covers the inventory diff, the no-op second pull, deletions, and both failure modes, against a fake transport
- `remote-transport.test.js` — covers the ssh/scp argv, inventory parsing, the timeout kill and `dispose()`, with `spawn` injected; also covers `LIST_COMMAND`'s exact text (issue #211's `.key`-exclusion and single-ssh-call pins), `splitListOutput()` and `parseSessions()`
- `remote-transport-shell.test.js` — runs `LIST_COMMAND` through a real `sh -c`, not a fake stdout fixture: a missing `.claude/projects` must exit non-zero, a missing `.claude/sessions` must still exit 0 with the marker present, a `.key` file plus a directory named like a descriptor must both be excluded from what reaches stdout, and (F9) the ALIVE marker reflects real `/proc` liveness for both a live pid (the shell's own `$$`, so it reads as alive on any host) and a dead one
- `remote-index.test.js` — covers "no host declared: no timer, no ssh call", the 60 s floor, per-host failure isolation and alias pruning, and that `getRemoteSessions()` is cleared (not left stale) after a cycle whose `sync()` throws
- `remote-indexing-e2e.test.js` — covers the `<alias>::` prefix reaching session rows, the search entries, the metrics and the sidebar
- `dom-sidebar-remote-session.test.js` — covers the remote badge and the read-only click routing
- `derive-project-path.test.js` — covers the worktree-collapse + cwd extraction paths
- `db-daily-activity.test.js` — covers heatmap aggregation
- `read-session-file.test.js` — covers header parsing
- `read-session-file-slash-command.test.js` — covers the `/clear` bookkeeping transcript and slash-command titles
- `db-purge-command-summaries.test.js` — covers migration v9's surgical purge
- `main-ctx-db-wiring.test.js` — covers the `ctx.db` allow-list ⊇ session-cache.js usage invariant above
- `read-session-file-bridge-session.test.js` — covers `bridgeSessionId`/cutoff extraction and `mergeBridgeGroups()`'s grouping/re-derivation/re-parenting rules
- `db-bridge-session-migration.test.js` — covers the schema-reconciliation path that adds `bridgeSessionId`/`mergedIntoSessionId`, forces a re-index, and `getTotalCounts()`'s exclusion
- `session-cache-bridge-dedup.test.js` — covers the compaction-mirror union merge through `refreshFolder()`, `readFolderFromFilesystem()` and `buildProjectsFromCache()`'s rollup, using the real fixture's shape
- `db-session-metrics.test.js` — covers the `getTotalCounts` pure-JS mirror's `mergedIntoSessionId` exclusion (kept in sync with the real SQL by the SQL-level test above)
- IPC consumers of cached payloads: `get-projects`, `get-active-sessions`, `search`, `get-stats-from-db`, `get-work-files`, `list-subagents`, `read-session-jsonl`
- Renderer: `public/sidebar.js` (consumes `buildProjectsFromCache` output), `public/stats-view.js` (consumes `getDailyActivity`)
- If you add a new `session_cache` column, update the SELECT in `getCachedByFolder` — it's `SELECT *` so additions land automatically, but the renderer needs to know about them.

## Schema reference

```
session_cache(sessionId PK, folder, projectPath, summary, firstPrompt,
              created, modified, messageCount, slug, aiTitle,
              parentSessionId, agentId, subagentType, description,
              fileMtime, bridgeSessionId, mergedIntoSessionId)
session_meta(sessionId PK, customTitle, starred, archived)
cache_meta(folder PK, projectPath, indexMtimeMs)
search_fts USING fts5(id, type, folder, title, body, tokenize='trigram')
search_map(id PK, type, folder)   -- backref for FTS delete
settings(key PK, value JSON)
```
